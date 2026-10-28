// Checks the automatic deploy kit: auto-update.sh (the pull-based updater), setup-auto-deploy.sh (its
// installer), deploy.sh --instance staging, and the staging units and Caddy site. The shell scripts run
// with bash against stub commands, as in deploy-kit.test.ts; git runs for real against a local repo that
// stands in for GitHub, and a stub curl answers the GitHub API from fixture files.
//
// `npm test` runs it (vite.config.ts includes server/deploy/**/*.test.ts). On its own, with one worker:
//   npm test -- server/deploy/auto-update.test.ts --maxWorkers=1
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { WORKSPACE_BODY_LIMIT } from '../src/app'
import { loadConfig, parseDotEnv } from '../src/config'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8')
const slash = (p: string) => p.replace(/\\/g, '/')

const autoUpdate = read('server/deploy/auto-update.sh')
const setup = read('server/deploy/setup-auto-deploy.sh')
const deploy = read('server/deploy/deploy.sh')
const liveUnit = read('server/deploy/first-twenty.service')
const stagingUnit = read('server/deploy/first-twenty-staging.service')
const migrateUnit = read('server/deploy/first-twenty-staging-migrate.service')
const updaterStaging = read('server/deploy/first-twenty-autoupdate-staging.service')
const updaterLive = read('server/deploy/first-twenty-autoupdate-live.service')
const caddyfile = read('server/deploy/Caddyfile')
const stagingCaddy = read('server/deploy/staging.caddy')
const serverDoc = read('docs/SERVER.md')

/** The KEY=value lines of a systemd unit, in order. */
const directives = (unit: string) =>
  unit
    .split('\n')
    .filter((l) => /^[A-Z][A-Za-z]+=/.test(l))
    .map((l) => l.trim())
const values = (unit: string, key: string) => directives(unit).filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1))

function findBash(): string | null {
  const candidates = [
    process.env.FT_TEST_BASH,
    ...(process.platform === 'win32' ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe'] : []),
    'bash',
  ].filter((c): c is string => Boolean(c))
  for (const candidate of candidates) {
    const r = spawnSync(candidate, ['-c', 'command -v tar >/dev/null && command -v grep >/dev/null && command -v sed >/dev/null && echo ok'], {
      encoding: 'utf8',
      timeout: 20_000,
    })
    if (r.status === 0 && r.stdout.trim() === 'ok') return candidate
  }
  return null
}

const BASH = findBash()
const hasGit = BASH !== null && spawnSync(BASH, ['-c', 'command -v git'], { encoding: 'utf8' }).status === 0
/** Forks are slow in Git Bash; one block of runs gets minutes, not seconds. */
const LONG_MS = 300_000

type BashResult = { status: number | null; stdout: string; stderr: string }

/**
 * Runs a bash script. It goes through a file, not bash -c: Git for Windows' bash.exe cuts a command line
 * off at 8191 characters, and the longer scripts here pass that.
 */
function bash(body: string, env: Record<string, string> = {}): BashResult {
  const dir = mkdtempSync(path.join(tmpdir(), 'ft-auto-update-'))
  try {
    const file = path.join(dir, 'script.sh')
    writeFileSync(file, body)
    const r = spawnSync(BASH!, [slash(file)], {
      encoding: 'utf8',
      timeout: LONG_MS,
      env: { ...process.env, DEPLOY: slash(here), REPO: slash(root), FT_NODE: slash(process.execPath), ...env },
    })
    if (r.error) throw r.error
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The text of shell function `name` from a script: `name() { ... }` on one line or up to a closing `}`. */
function shellFunction(text: string, name: string): string {
  const oneLine = new RegExp(`^${name}\\(\\) \\{.*\\}$`, 'm').exec(text)
  if (oneLine) return oneLine[0]
  const block = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm').exec(text)
  if (!block) throw new Error(`function ${name} not found`)
  return block[0]
}

/** Splits output into sections that start with "--- <name>" lines. */
function sections(out: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const part of out.split(/^--- /m).slice(1)) {
    const nl = part.indexOf('\n')
    result[part.slice(0, nl)] = part.slice(nl + 1)
  }
  return result
}
const linesOf = (section: string, prefix: string) =>
  section
    .split('\n')
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.slice(prefix.length))
const callsOf = (section: string) => linesOf(section, 'call: ')
const outOf = (section: string) => linesOf(section, 'out: ').join('\n')

const prelude = `set -euo pipefail
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
`

// ---------------------------------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------------------------------

describe('the automatic deploy scripts (static checks)', () => {
  const scripts = { 'auto-update.sh': autoUpdate, 'setup-auto-deploy.sh': setup }

  it('are strict bash with LF line endings', () => {
    for (const [name, text] of Object.entries(scripts)) {
      expect(text.startsWith('#!/usr/bin/env bash\n'), name).toBe(true)
      expect(text, name).toContain('\nset -euo pipefail\n')
      expect(text.includes('\r'), name).toBe(false)
    }
  })

  it('never check sudo with sudo -v and never pipe into grep -q', () => {
    for (const [name, text] of Object.entries(scripts)) {
      const code = text
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n')
      expect(code, name).not.toMatch(/\bsudo\s+(-n\s+)?-v\b/)
      for (const line of code.split('\n')) {
        for (const m of line.matchAll(/\|\s*grep((?:\s+-[A-Za-z]+)+)/g)) {
          if (!/q/.test(m[1])) continue
          expect(/\b(printf|echo)\b[^|]*$/.test(line.slice(0, m.index)), `${name}: ${line.trim()}`).toBe(true)
        }
      }
    }
  })

  it('talk to GitHub over HTTPS without a token, and send the stored ETag', () => {
    expect(autoUpdate).toContain('REPO=${FT_REPO:-unique-name27/first-twenty-team}')
    expect(autoUpdate).toContain('GIT_URL=${FT_GIT_URL:-https://github.com/$REPO.git}')
    expect(autoUpdate).toContain('API=${FT_GITHUB_API:-https://api.github.com}')
    expect(autoUpdate).toContain(`--proto '=https'`)
    expect(autoUpdate).toContain('If-None-Match: $etag')
    expect(autoUpdate).not.toMatch(/Authorization|GITHUB_TOKEN|GH_TOKEN/)
    // Each answer is read by node from a file; nothing from GitHub is evaluated by the shell.
    expect(autoUpdate).not.toMatch(/\beval\b|\bsource\b|^\s*\. /m)
    expect(autoUpdate).toContain(`gh_get head "/repos/$REPO/commits/main" 'application/vnd.github.sha'`)
    expect(autoUpdate).toContain('/check-runs?check_name=$CHECK_NAME&filter=latest')
    expect(autoUpdate).toContain('"/repos/$REPO/releases/latest"')
  })

  it('check out the exact commit detached and never git pull', () => {
    expect(autoUpdate).toContain('checkout --quiet --detach "$TARGET"')
    // (The ways back it logs name deploy.sh --no-pull, which is no git pull.)
    const code = autoUpdate
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
      .replace(/ --no-pull\b/g, '')
    expect(code).not.toMatch(/git[^\n]*\bpull\b/)
    expect(autoUpdate).toContain('merge-base --is-ancestor "$TARGET" refs/remotes/origin/main')
  })

  it('agree on the report deploy.sh writes for the updater, and put the folder back only until the restart', () => {
    for (const line of [
      'report phase before-restart',
      'report phase restarted',
      'report phase finished',
      'report dump "$BACKUP_FILE"',
      'report migrated 1',
      'report applied "$applied"',
      'report restored 1',
      'report restore_dump "$dump"',
    ]) {
      expect(deploy, line).toContain(line)
    }
    for (const key of ['phase', 'restored', 'dump', 'migrated', 'applied', 'restore_dump']) {
      expect(autoUpdate, key).toContain(`sed -n 's/^${key}=//p' "$REPORT"`)
    }
    expect(autoUpdate).toContain('FT_DEPLOY_REPORT="$REPORT"')
    expect(autoUpdate).toContain('FT_PRIOR_BACKUP="$PRIOR"')
    // A stop (systemctl stop, Ctrl-C, a dropped SSH session) goes through put_back with a status that says so.
    const armed = deploy.indexOf("trap put_back EXIT\n# A stop (systemctl stop, Ctrl-C, a dropped SSH session)")
    expect(armed).toBeGreaterThan(0)
    expect(deploy.slice(armed)).toMatch(/^trap put_back EXIT\n(?:#.*\n)+trap 'exit 143' TERM\ntrap 'exit 130' INT\ntrap 'exit 129' HUP\n/)
    // The copy stops counting as the build the server runs (.pending), then everything is disarmed, before the restart.
    const disarmed = deploy.indexOf('\nrm -f "$PREV_DIR/.pending"\n')
    const restart = deploy.indexOf('step "Restarting $SERVICE"')
    expect(disarmed).toBeGreaterThan(armed)
    expect(deploy.slice(disarmed, restart)).toBe('\nrm -f "$PREV_DIR/.pending"\ntrap - EXIT TERM INT HUP\nreport phase restarted\n')
    // put_back never trusts a status of 0: the trap is armed only while the deploy is unfinished.
    expect(shellFunction(deploy, 'put_back')).toContain('[ "$rc" -ne 0 ] || rc=1\n')
    expect(shellFunction(deploy, 'put_back')).not.toContain('|| exit 0')
    // The copy of the old build sits in the code folder, so git must ignore it.
    expect(read('.gitignore').split('\n')).toContain('.deploy-prev/')
  })

  it('tell a running oneshot unit by its ActiveState, since systemctl is-active never sees one', () => {
    const code = autoUpdate
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
    expect(code).not.toContain('is-active')
    expect(code).toContain('systemctl show -p ActiveState --value "$OTHER_UNIT"')
    expect(code).toMatch(/activating \| active \| reloading \| deactivating\) return 0/)
  })
})

describe('the staging units', () => {
  // The hardening of first-twenty.service that the staging units repeat line for line.
  const hardening = [
    'NoNewPrivileges',
    'ProtectSystem',
    'ProtectHome',
    'PrivateTmp',
    'PrivateDevices',
    'ProtectKernelTunables',
    'ProtectKernelModules',
    'ProtectKernelLogs',
    'ProtectControlGroups',
    'ProtectClock',
    'ProtectHostname',
    'ProtectProc',
    'ProcSubset',
    'RestrictSUIDSGID',
    'RestrictRealtime',
    'RestrictNamespaces',
    'LockPersonality',
    'RemoveIPC',
    'CapabilityBoundingSet',
    'AmbientCapabilities',
    'SystemCallArchitectures',
    'SystemCallFilter',
    'SystemCallErrorNumber',
    'RestrictAddressFamilies',
    'IPAddressDeny',
    'UMask',
  ]

  it('run the staging server with the same hardening as live, as its own user, folder and settings', () => {
    for (const key of [...hardening, 'LimitNOFILE', 'Restart', 'RestartSec', 'StartLimitIntervalSec', 'UnsetEnvironment', 'ExecStart', 'Environment', 'StateDirectoryMode']) {
      expect(values(stagingUnit, key), key).toEqual(values(liveUnit, key))
    }
    expect(values(stagingUnit, 'User')).toEqual(['first-twenty-staging'])
    expect(values(stagingUnit, 'Group')).toEqual(['first-twenty-staging'])
    expect(values(stagingUnit, 'WorkingDirectory')).toEqual(['/opt/first-twenty-staging'])
    expect(values(stagingUnit, 'EnvironmentFile')).toEqual(['/etc/first-twenty-staging/env'])
    expect(values(stagingUnit, 'StateDirectory')).toEqual(['first-twenty-staging'])
    // Loopback only: no DNS stub and no Claude API (the assistant is off on staging).
    expect(values(stagingUnit, 'IPAddressAllow')).toEqual(['127.0.0.1/32 ::1/128'])
    // Under memory pressure, staging goes first.
    expect(Number(values(stagingUnit, 'OOMScoreAdjust')[0])).toBeGreaterThan(0)
    expect(values(stagingUnit, 'MemoryMax')).toHaveLength(1)
  })

  it('skip the staging server until it is built, and back off when it keeps crashing, without a start limit', () => {
    const unitSection = stagingUnit.slice(stagingUnit.indexOf('[Unit]'), stagingUnit.indexOf('[Service]'))
    expect(values(unitSection, 'ConditionPathExists')).toEqual(['/opt/first-twenty-staging/dist-server/server.mjs'])
    expect(values(stagingUnit, 'ConditionPathExists')).toEqual(['/opt/first-twenty-staging/dist-server/server.mjs'])
    // From RestartSec=5 up to every 10 minutes in 6 steps (systemd 254 and later; Ubuntu 24.04 has 255).
    expect(values(stagingUnit, 'RestartSteps')).toEqual(['6'])
    expect(values(stagingUnit, 'RestartMaxDelaySec')).toEqual(['10min'])
    // A start limit would make deploy.sh's sudo systemctl restart fail once it was reached.
    expect(values(stagingUnit, 'StartLimitBurst')).toEqual([])
    expect(values(stagingUnit, 'StartLimitIntervalSec')).toEqual(['0'])
    // setup-auto-deploy.sh installs the file as it is.
    expect(setup).toContain('put_if_changed "$UNIT_DIR/first-twenty-staging.service" 0644 root:root <"$SCRIPT_DIR/first-twenty-staging.service"')
  })

  it('give a stopped run time to put the folder back before systemd kills it', () => {
    for (const unit of [updaterStaging, updaterLive]) expect(values(unit, 'TimeoutStopSec')).toEqual(['5min'])
  })

  it('protect the live server and Postgres from the staging build instead of capping the build', () => {
    for (const key of ['MemoryHigh', 'MemoryMax', 'MemorySwapMax']) expect(values(updaterStaging, key), key).toEqual([])
    expect(updaterStaging).toContain('IOWeight= is kept for disks that honor it, but has no effect')
    expect(updaterStaging).not.toContain('less CPU, I/O and memory priority')
    // deploy.sh compares the unit file alone, so a drop-in next to it never counts as a difference.
    expect(deploy).toContain('sudo cmp -s "$SCRIPT_DIR/$UNIT_FILE" "/etc/systemd/system/$SERVICE.service"')
  })

  it('migrate as the staging owner with the same hardening, without putting the password on a command line', () => {
    for (const key of hardening) expect(values(migrateUnit, key), key).toEqual(values(liveUnit, key))
    expect(values(migrateUnit, 'IPAddressAllow')).toEqual(['127.0.0.1/32 ::1/128'])
    expect(values(migrateUnit, 'Type')).toEqual(['oneshot'])
    expect(values(migrateUnit, 'User')).toEqual(['first-twenty-staging'])
    expect(values(migrateUnit, 'WorkingDirectory')).toEqual(['/opt/first-twenty-staging'])
    expect(values(migrateUnit, 'EnvironmentFile')).toEqual(['/etc/first-twenty-staging/env'])
    expect(values(migrateUnit, 'UnsetEnvironment')).toEqual([])
    // $$ is a literal $ for sh: systemd must not expand the connection into the command line.
    expect(values(migrateUnit, 'ExecStart')).toEqual([`/bin/sh -c 'DATABASE_URL="$$MIGRATION_DATABASE_URL" exec /usr/bin/node dist-server/migrate.mjs'`])
    expect(migrateUnit).not.toMatch(/\$\{MIGRATION_DATABASE_URL\}/)
  })

  it('run the staging updater as the staging user, with no option that would stop its two sudo commands', () => {
    expect(values(updaterStaging, 'User')).toEqual(['first-twenty-staging'])
    expect(values(updaterStaging, 'ExecStart')).toEqual(['/usr/local/bin/first-twenty-autoupdate staging'])
    expect(values(updaterStaging, 'Type')).toEqual(['oneshot'])
    expect(values(updaterStaging, 'PrivateTmp')).toEqual(['true'])
    // Each of these sets no_new_privs (systemd.exec), and sudo refuses to run under it.
    const impliesNoNewPrivileges = [
      'NoNewPrivileges',
      'SystemCallFilter',
      'SystemCallArchitectures',
      'RestrictAddressFamilies',
      'RestrictNamespaces',
      'PrivateDevices',
      'ProtectKernelTunables',
      'ProtectKernelModules',
      'ProtectKernelLogs',
      'ProtectClock',
      'MemoryDenyWriteExecute',
      'RestrictRealtime',
      'RestrictSUIDSGID',
      'DynamicUser',
      'LockPersonality',
      'CapabilityBoundingSet',
    ]
    for (const unit of [updaterStaging, updaterLive]) {
      for (const key of impliesNoNewPrivileges) expect(values(unit, key), key).toEqual([])
    }
    // The port and address deploy.sh checks are the staging server's.
    expect(values(updaterStaging, 'Environment')).toContain('FT_PORT=8788')
    expect(values(updaterStaging, 'Environment')).toContain('FT_PUBLIC_ORIGIN=https://staging.example.com')
  })

  it('run the live updater as the deploy login with the shared /tmp, so it takes the same deploy lock as a deploy by hand', () => {
    expect(values(updaterLive, 'User')).toEqual(['ubuntu'])
    expect(values(updaterLive, 'ExecStart')).toEqual(['/usr/local/bin/first-twenty-autoupdate live'])
    expect(values(updaterLive, 'PrivateTmp')).toEqual([])
    expect(values(updaterLive, 'Environment')).toContain('FT_RELEASE_AUTHOR=unique-name27')
    expect(autoUpdate).toContain('DEPLOY_LOCK="${TMPDIR:-/tmp}/first-twenty-deploy.lock"')
    expect(deploy).toContain('LOCK_FILE="${TMPDIR:-/tmp}/first-twenty-deploy.lock"')
  })

  it("share staging's deploy lock between the updater (private /tmp) and a staging deploy by hand", () => {
    // The updater's state folder is /var/lib/first-twenty-staging/autoupdate, so both name the same file.
    expect(autoUpdate).toContain('STATE_DIR=${FT_STATE_DIR:-/var/lib/first-twenty-staging/autoupdate}')
    expect(autoUpdate).toContain('DEPLOY_LOCK="$(dirname "$STATE_DIR")/deploy.lock"')
    expect(deploy).toContain('LOCK_FILE=${FT_STAGING_LOCK:-/var/lib/first-twenty-staging/deploy.lock}')
    expect(setup).toContain('STAGING_HOME=/var/lib/first-twenty-staging\n')
  })

  it('keep the staging build away from the EC2 metadata service and its instance role', () => {
    expect(values(updaterStaging, 'IPAddressDeny')).toEqual(['169.254.0.0/16 fd00:ec2::/32'])
    expect(values(updaterStaging, 'IPAddressAllow')).toEqual([])
    // The staging server and its migrations allow loopback only, so the metadata service is out of reach there too.
    for (const unit of [stagingUnit, migrateUnit]) expect(values(unit, 'IPAddressDeny')).toEqual(['any'])
  })

  it('tick every 5 minutes with a small random delay', () => {
    for (const name of ['first-twenty-autoupdate-staging.timer', 'first-twenty-autoupdate-live.timer']) {
      const timer = read(`server/deploy/${name}`)
      expect(values(timer, 'OnCalendar'), name).toEqual(['*:0/5'])
      expect(Number(values(timer, 'RandomizedDelaySec')[0]), name).toBeGreaterThan(0)
      expect(Number(values(timer, 'RandomizedDelaySec')[0]), name).toBeLessThanOrEqual(120)
      expect(values(timer, 'WantedBy'), name).toEqual(['timers.target'])
    }
  })
})

describe('the staging Caddy site', () => {
  it('proxies the staging domain to the staging port like the live app, and asks not to be indexed', () => {
    expect(stagingCaddy).toMatch(/^http:\/\/staging\.example\.com \{\n\tredir https:\/\/\{host\}\{uri\} permanent\n\}$/m)
    expect(stagingCaddy).toMatch(/^staging\.example\.com \{$/m)
    expect(stagingCaddy).toMatch(/^\treverse_proxy 127\.0\.0\.1:8788 \{\n\t\theader_up -X-Real-IP\n\t\}$/m)
    expect(stagingCaddy).toMatch(/^\theader \{\n\t\tStrict-Transport-Security "max-age=31536000"\n\t\tdefer\n\t\}$/m)
    expect(stagingCaddy).toMatch(/^\theader X-Robots-Tag "noindex, nofollow"$/m)
    expect(stagingCaddy).toContain('request>uri regexp "(?i)/invites/[^/?#]+" "/invites/[redacted]"')
    expect(stagingCaddy).toContain('output file /var/log/caddy/first-twenty-staging-access.log')
    const size = /max_size (\d+)MB/.exec(stagingCaddy)
    expect(Number(size![1]) * 1000 * 1000).toBeGreaterThan(WORKSPACE_BODY_LIMIT)
    // No global options: Caddy accepts them only at the top of the main Caddyfile.
    expect(stagingCaddy).not.toMatch(/^\{$/m)
    const code = stagingCaddy
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
    expect((code.match(/\{/g) ?? []).length).toBe((code.match(/\}/g) ?? []).length)
  })

  it('is imported by the live Caddyfile template, before the careers template that must stay last', () => {
    const at = caddyfile.indexOf('\nimport /etc/caddy/first-twenty.d/*.caddy\n')
    expect(at).toBeGreaterThan(caddyfile.indexOf('\nhr.example.com {\n'))
    expect(at).toBeLessThan(caddyfile.indexOf('# BEGIN careers site'))
    expect(caddyfile.trimEnd().endsWith('# END careers site')).toBe(true)
    expect(setup).toContain('CADDY_DIR=/etc/caddy/first-twenty.d')
    expect(setup).toContain('IMPORT_LINE="import $CADDY_DIR/*.caddy"')
  })

  it('agrees with the staging port everywhere', () => {
    expect(deploy).toMatch(/staging\)\n(?:\s+.*\n)*?\s+DEFAULT_PORT=8788\n/)
    expect(setup).toContain('STAGING_PORT=8788\n')
    expect(stagingCaddy).toContain('reverse_proxy 127.0.0.1:8788')
  })
})

// ---------------------------------------------------------------------------------------------------
// setup-auto-deploy.sh: the pieces it writes
// ---------------------------------------------------------------------------------------------------

describe.skipIf(!BASH)('setup-auto-deploy.sh, what it writes', { timeout: LONG_MS }, () => {
  it('makes the staging database with postgres-setup.sql, staging names everywhere and no password prompts', () => {
    const r = bash(`${prelude}
${shellFunction(setup, 'staging_sql')}
SCRIPT_DIR="$DEPLOY" STAGING_ROLE=first_twenty_staging STAGING_OWNER=first_twenty_staging_owner
staging_sql
`)
    expect(r.stderr).toBe('')
    const sql = r.stdout
    const live = read('server/deploy/postgres-setup.sql')
    const code = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n')
    expect(code).not.toMatch(/\bfirst_twenty\b|\bfirst_twenty_owner\b/)
    expect(code).not.toContain('\\password')
    expect(code).not.toMatch(/^\\if :(role|owner)_is_new$/m)
    for (const statement of [
      "SELECT 'CREATE DATABASE first_twenty_staging WITH OWNER postgres ENCODING ''UTF8'' TEMPLATE template0'",
      'REVOKE ALL ON DATABASE first_twenty_staging FROM PUBLIC;',
      'GRANT CONNECT ON DATABASE first_twenty_staging TO first_twenty_staging, first_twenty_staging_owner;',
      '\\connect first_twenty_staging',
      'ALTER ROLE first_twenty_staging WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 20;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE first_twenty_staging_owner IN SCHEMA public',
      'REVOKE CREATE ON SCHEMA public FROM first_twenty_staging;',
    ]) {
      expect(sql, statement).toContain(statement)
    }
    // Everything else is postgres-setup.sql line for line: the same statements, in the same order.
    const statements = (text: string) =>
      text
        .split('\n')
        .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('--') && !l.trimStart().startsWith('\\'))
        .map((l) => l.replace(/first_twenty_owner/g, 'OWNER').replace(/first_twenty_staging_owner/g, 'OWNER').replace(/first_twenty_staging/g, 'APP').replace(/first_twenty/g, 'APP'))
    expect(statements(sql)).toEqual(statements(live))
  })

  it('writes a staging settings file the server accepts in production: port 8788, open sign-up, no assistant, no careers', () => {
    const r = bash(`${prelude}
${shellFunction(setup, 'staging_env')}
STAGING_PORT=8788 STAGING_ROLE=first_twenty_staging STAGING_OWNER=first_twenty_staging_owner STAGING_DB=first_twenty_staging
STAGING_DOMAIN=staging-3-14-15-92.sslip.io
staging_env 0123abcd 4567ef89
`)
    expect(r.stderr).toBe('')
    for (const line of r.stdout.split('\n').filter((l) => /^[A-Z_]+=/.test(l))) expect(line, line).not.toMatch(/\s#/)
    const env = parseDotEnv(r.stdout)
    expect(new URL(env.DATABASE_URL).username).toBe('first_twenty_staging')
    expect(new URL(env.MIGRATION_DATABASE_URL).username).toBe('first_twenty_staging_owner')
    expect(new URL(env.DATABASE_URL).pathname).toBe('/first_twenty_staging')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CAREERS_HOSTS).toBeUndefined()
    const warnings: string[] = []
    const config = loadConfig({ ...env, NODE_ENV: 'production', APP_FILE: 'package.json' }, { dotenv: false, rootDir: root, warn: (m) => warnings.push(m) })
    expect(warnings).toEqual([])
    expect(config.port).toBe(8788)
    expect(config.host).toBe('127.0.0.1')
    expect(config.publicOrigin).toBe('https://staging-3-14-15-92.sslip.io')
    expect(config.secureCookies).toBe(true)
    expect(config.signupMode).toBe('open')
    expect(config.migrateOnStart).toBe(false)
    expect(config.assistant.enabled).toBe(false)
    expect(config.careersHosts).toEqual([])
    expect(config.demoMaxWorkspaces).toBeLessThan(500)
    expect(config.demoMaxTotalBytes).toBeLessThan(2048 * 1024 * 1024)
  })

  it('allows the staging user exactly the two commands deploy.sh runs with sudo', () => {
    const r = bash(`${prelude}
${shellFunction(setup, 'sudoers_rule')}
STAGING_USER=first-twenty-staging SYSTEMCTL=/usr/bin/systemctl
sudoers_rule
`)
    expect(r.stderr).toBe('')
    const rules = r.stdout.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))
    expect(rules).toEqual([
      'first-twenty-staging ALL=(root) NOPASSWD: /usr/bin/systemctl start first-twenty-staging-migrate.service, /usr/bin/systemctl restart first-twenty-staging.service',
    ])
    // deploy.sh uses exactly those arguments (sudo matches them word for word).
    expect(deploy).toContain('MIGRATE_SERVICE=first-twenty-staging-migrate.service')
    expect(deploy).toContain('sudo -n systemctl start "$MIGRATE_SERVICE"')
    expect(deploy).toContain('sudo -n systemctl restart "$SERVICE.service"')
    expect(setup).toContain('visudo -cqf "$rule"')
  })

  it('limits the staging roles to their own database in pg_hba.conf, matching only those roles', () => {
    const r = bash(`${prelude}
${shellFunction(setup, 'hba_block')}
STAGING_DB=first_twenty_staging STAGING_ROLE=first_twenty_staging STAGING_OWNER=first_twenty_staging_owner
hba_block
`)
    expect(r.stderr).toBe('')
    const rules = r.stdout
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.startsWith('#'))
      .map((l) => l.trim().split(/\s+/))
    expect(rules).toEqual([
      ['host', 'first_twenty_staging', 'first_twenty_staging,first_twenty_staging_owner', '127.0.0.1/32', 'scram-sha-256'],
      ['host', 'first_twenty_staging', 'first_twenty_staging,first_twenty_staging_owner', '::1/128', 'scram-sha-256'],
      // Code on staging can read these roles' passwords: every other way in is closed.
      ['local', 'all', 'first_twenty_staging,first_twenty_staging_owner', 'reject'],
      ['host', 'all', 'first_twenty_staging,first_twenty_staging_owner', '0.0.0.0/0', 'reject'],
      ['host', 'all', 'first_twenty_staging,first_twenty_staging_owner', '::/0', 'reject'],
    ])
  })

  it('puts the staging lines at the top of pg_hba.conf once, and replaces an older version of them', () => {
    const r = bash(`${prelude}
${['hba_block', 'hba_with_block'].map((n) => shellFunction(setup, n)).join('\n')}
STAGING_DB=first_twenty_staging STAGING_ROLE=first_twenty_staging STAGING_OWNER=first_twenty_staging_owner
printf '# ubuntu header\\nlocal all postgres peer\\nhost all all 127.0.0.1/32 scram-sha-256\\n' > "$work/fresh"
echo "--- fresh"; hba_with_block "$work/fresh"
hba_with_block "$work/fresh" > "$work/once"
echo "--- again"; hba_with_block "$work/once" | cmp -s - "$work/once" && echo same
printf '# BEGIN first-twenty-staging (old)\\nhost all first_twenty_staging 127.0.0.1/32 reject\\n# END first-twenty-staging\\nlocal all postgres peer\\n' > "$work/old"
echo "--- old"; hba_with_block "$work/old"
`)
    expect(r.stderr).toBe('')
    const out = sections(r.stdout)
    const fresh = out.fresh.split('\n')
    expect(fresh[0]).toMatch(/^# BEGIN first-twenty-staging/)
    expect(fresh.indexOf('# END first-twenty-staging')).toBeLessThan(fresh.indexOf('local all postgres peer'))
    expect(fresh).toContain('host all all 127.0.0.1/32 scram-sha-256')
    expect(out.again.trim()).toBe('same')
    const old = out.old.split('\n')
    expect(old.filter((l) => l.startsWith('# BEGIN first-twenty-staging'))).toHaveLength(1)
    expect(old).not.toContain('# BEGIN first-twenty-staging (old)')
    expect(old.some((l) => /^local\s+all\s+first_twenty_staging,first_twenty_staging_owner\s+reject$/.test(l))).toBe(true)
    expect(old[old.length - 2]).toBe('local all postgres peer')
  })

  it('leaves pg_hba.conf untouched unless its staging markers are one block, and finds the Postgres unit from its path', () => {
    const fns = ['info', 'warn', 'die', 'hba_block', 'hba_markers_ok', 'hba_outside', 'hba_with_block', 'staging_hba'].map((n) => shellFunction(setup, n)).join('\n')
    const r = bash(`${prelude}
${fns}
STAGING_DB=first_twenty_staging STAGING_ROLE=first_twenty_staging STAGING_OWNER=first_twenty_staging_owner STAMP=20261027-000000 DRY_RUN=false
mkdir -p "$work/etc/postgresql/16/main"
HBA="$work/etc/postgresql/16/main/pg_hba.conf"
pg_value() { echo "pg_value $1" >> "$work/calls"; case "$1" in 'SHOW hba_file') echo "$HBA" ;; *pg_hba_file_rules*) echo 0 ;; *) echo t ;; esac; }
base='local all postgres peer\\nlocal all all peer\\nhost all all 127.0.0.1/32 scram-sha-256\\n'
hba_case() { # hba_case <name> <content for printf>
  printf "$2" > "$HBA"; cp "$HBA" "$work/before"; : > "$work/calls"
  local rc=0
  (staging_hba; echo "unit=$PG_UNIT") > "$work/out" 2>&1 || rc=$?
  echo "--- $1"; echo "rc=$rc"
  sed 's/^/out: /' "$work/out"; sed 's/^/call: /' "$work/calls"
  cmp -s "$HBA" "$work/before" && echo "hba=unchanged"
  ls "$work/etc/postgresql/16/main" | sed -n 's/^\\(pg_hba\\.conf\\.bak-.*\\)$/file: \\1/p'
  rm -f "$work/etc/postgresql/16/main/"pg_hba.conf.bak-*
}
hba_case fresh "$base"
hba_case old-block "# BEGIN first-twenty-staging (old)\\nhost all first_twenty_staging 127.0.0.1/32 reject\\n# END first-twenty-staging\\n$base"
hba_case begin-only "# BEGIN first-twenty-staging (setup-auto-deploy.sh)\\nhost x\\n$base"
hba_case end-only "$base# END first-twenty-staging\\n"
hba_case end-first "local all postgres peer\\n# END first-twenty-staging\\n# BEGIN first-twenty-staging\\nhost x\\nlocal all all peer\\n"
hba_case two-blocks "# BEGIN first-twenty-staging\\n# END first-twenty-staging\\n# BEGIN first-twenty-staging\\n# END first-twenty-staging\\n$base"
printf 'a\\n# BEGIN first-twenty-staging\\nx\\n# END first-twenty-staging\\nb\\n' > "$work/closed"
printf 'a\\n# BEGIN first-twenty-staging\\nx\\nb\\n' > "$work/open"
echo "--- outside-closed"; hba_outside "$work/closed"
echo "--- outside-open"; hba_outside "$work/open"
HBA="$work/pg_hba.conf"; printf "$base" > "$HBA"
echo "--- elsewhere"; (staging_hba; echo "unit=[$PG_UNIT]") 2>&1
`)
    expect(r.stderr).toBe('')
    const out = sections(r.stdout)
    for (const name of ['fresh', 'old-block']) {
      expect(out[name], name).toContain('rc=0')
      expect(out[name], name).toContain('file: pg_hba.conf.bak-20261027-000000')
      expect(out[name], name).toContain('unit=postgresql@16-main.service')
      expect(callsOf(out[name]), name).toContain('pg_value SELECT pg_reload_conf()')
    }
    for (const name of ['begin-only', 'end-only', 'end-first', 'two-blocks']) {
      const s = out[name]
      expect(s, name).toContain('rc=1')
      expect(s, name).toContain('hba=unchanged')
      expect(s, name).not.toContain('file: pg_hba.conf.bak-')
      expect(outOf(s), name).toContain('marker lines that are not one BEGIN line followed by one END line')
      expect(callsOf(s), name).toEqual(['pg_value SHOW hba_file'])
    }
    // What setup must leave alone: everything but a closed block. An open BEGIN line counts as ordinary.
    expect(out['outside-closed']).toBe('a\nb\n')
    expect(out['outside-open']).toBe('a\n# BEGIN first-twenty-staging\nx\nb\n')
    // A pg_hba.conf outside /etc/postgresql/<version>/<cluster> names no unit.
    expect(out.elsewhere).toContain('unit=[]')
  })

  it('sets new staging passwords and writes them to the settings file together, then restarts a running staging server', () => {
    const fns = ['info', 'warn', 'die', 'run', 'put', 'new_password', 'set_staging_passwords', 'staging_env', 'staging_settings'].map((n) => shellFunction(setup, n)).join('\n')
    const r = bash(`${prelude}
${fns}
mkdir -p "$work/bin"
printf '#!/usr/bin/env bash\\n[ "$1" = -u ] && shift 2\\n[ "$1" = -- ] && shift\\nexec "$@"\\n' > "$work/bin/runuser"
# psql records the passwords it was sent; systemctl records the one in the settings file at that moment.
cat > "$work/bin/psql" <<'EOF'
#!/usr/bin/env bash
echo "psql $*" >> "$CALLS"
sed -n "s/^ALTER ROLE \\([a-z_]*\\) PASSWORD '\\([0-9a-f]*\\)';$/\\1 \\2/p" >> "$SET"
EOF
# Like systemd 255: try-restart (or restart) of a unit that is not installed fails with "not found" (exit 5);
# show answers LoadState. $UNITF stands for the installed unit file.
cat > "$work/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
if [ "$1 $2 $3 $4" = "show -p LoadState --value" ]; then
  if [ -f "$UNITF" ]; then echo loaded; else echo not-found; fi
  exit 0
fi
case "$1" in
  try-restart | restart) [ -f "$UNITF" ] || { echo "Failed to $1 $2: Unit $2 not found." >&2; exit 5; } ;;
esac
echo "systemctl $* env-password=$(sed -n 's#^DATABASE_URL=postgres://[^:]*:\\([^@]*\\)@.*#\\1#p' "$ENVF" 2>/dev/null)" >> "$CALLS"
EOF
printf '#!/usr/bin/env bash\\nexit 0\\n' > "$work/bin/chown"
chmod +x "$work"/bin/*
export PATH="$work/bin:$PATH" CALLS="$work/calls" SET="$work/set" ENVF="$work/env" UNITF="$work/first-twenty-staging.service"
DRY_RUN=false STAMP=20261027-000000 STAGING_ENV="$work/env" STAGING_PORT=8788 STAGING_DOMAIN=staging.test.example
STAGING_DB=first_twenty_staging STAGING_ROLE=first_twenty_staging STAGING_OWNER=first_twenty_staging_owner
# The first run on an instance without staging: no settings file, no roles, and the unit not installed yet
# (it comes later in setup). set -e stops this script if anything in it fails.
: > "$work/calls"; : > "$work/set"
echo "--- fresh-box"; staging_settings 'f|f|f|t'
echo "--- fresh-box-calls"; cat "$work/calls"
rm -f "$work/env" "$work"/env.bak-*
: > "$UNITF"
: > "$work/calls"; : > "$work/set"
echo "--- new"; staging_settings 'f|f|f'
echo "--- calls"; cat "$work/calls"
echo "--- set"; cat "$work/set"
echo "--- env-password"; sed -n 's#^DATABASE_URL=postgres://[^:]*:\\([^@]*\\)@.*#\\1#p' "$work/env"
: > "$work/calls"
echo "--- kept"; staging_settings 't|t|t|t'
echo "--- kept-calls"; cat "$work/calls"
# The file is there, but a role has no password (made on a run that stopped before setting one).
: > "$work/calls"
echo "--- no-password"; staging_settings 't|t|t|f'
echo "--- no-password-calls"; cat "$work/calls"
`)
    expect(r.stderr).toBe('')
    const out = sections(r.stdout)
    // Before its unit is installed, nothing is restarted, and setup goes on.
    expect(out['fresh-box']).toContain('Set new generated passwords on both roles.')
    expect(out['fresh-box']).not.toContain('Restarted first-twenty-staging')
    expect(out['fresh-box-calls']).toBeDefined()
    expect(out['fresh-box-calls']).not.toContain('try-restart')
    expect(out.new).toContain('Set new generated passwords on both roles.')
    expect(out.new).toContain('Restarted first-twenty-staging, if it was running, so it uses the new passwords.')
    const calls = out.calls.trim().split('\n')
    const pw = /^first_twenty_staging ([0-9a-f]{64})$/m.exec(out.set)?.[1]
    expect(pw).toBeDefined()
    expect(out['env-password'].trim()).toBe(pw)
    // The passwords go to Postgres first; the restart comes after the file holds them.
    expect(calls[0]).toBe('psql -X -q -v ON_ERROR_STOP=1 -d postgres')
    expect(calls[calls.length - 1]).toBe(`systemctl try-restart first-twenty-staging.service env-password=${pw}`)
    // With the file and both roles in place, nothing changes and nothing restarts.
    expect(out.kept).toContain('Kept the passwords')
    expect(out['kept-calls'].trim()).toBe('')
    expect(out['no-password']).toContain('Set new generated passwords on both roles.')
    expect(out['no-password']).toContain('so the old settings file (now ')
    expect(out['no-password-calls']).toContain('systemctl try-restart first-twenty-staging.service')
    // The pg_hba.conf lines go in before any password is set.
    const body = shellFunction(setup, 'setup_staging')
    expect(body.indexOf('  staging_hba\n')).toBeGreaterThan(0)
    expect(body.indexOf('  staging_hba\n')).toBeLessThan(body.indexOf('  staging_settings "$objects"\n'))
  })

  it('reserves memory for the live server and Postgres with drop-ins, once, and warns about an older live kit', () => {
    const fns = ['info', 'warn', 'run', 'put', 'put_if_changed', 'memory_dropin', 'staging_memory', 'live_kit_warning'].map((n) => shellFunction(setup, n)).join('\n')
    const r = bash(`${prelude}
${fns}
mkdir -p "$work/bin" "$work/units" "$work/units2" "$work/units3"
printf '#!/usr/bin/env bash\\nexit 0\\n' > "$work/bin/chown"
# systemctl show -p Slice answers FAKE_SLICE (nothing by default, as when systemd cannot say).
printf '#!/usr/bin/env bash\\n[ "$1 $2 $3 $4" = "show -p Slice --value" ] && { printf "%%s" "\${FAKE_SLICE:-}"; exit 0; }\\nexit 1\\n' > "$work/bin/systemctl"
chmod +x "$work"/bin/*
export PATH="$work/bin:$PATH"
DRY_RUN=false UNIT_DIR="$work/units" PG_UNIT=postgresql@16-main.service
echo "--- first"; staging_memory 2>&1
echo "--- again"; staging_memory 2>&1
for f in first-twenty.service.d/memory.conf postgresql@16-main.service.d/memory.conf system-postgresql.slice.d/memory.conf system.slice.d/memory.conf; do
  echo "--- $f"; cat "$work/units/$f"
done
# What systemd reports wins over its naming rule.
echo "--- custom"; UNIT_DIR="$work/units3" FAKE_SLICE=system-pg16.slice staging_memory 2>&1
echo "--- custom-files"; (cd "$work/units3" && ls -d *.d)
UNIT_DIR="$work/units2" PG_UNIT=
echo "--- no-pg"; staging_memory 2>&1
echo "--- no-pg-slice"; cat "$work/units2/system.slice.d/memory.conf"
mkdir -p "$work/old/server/deploy" "$work/new/server/deploy"
printf '{\\n\\tservers {\\n\\t}\\n}\\n' > "$work/old/server/deploy/Caddyfile"
printf '{\\n\\tadmin unix//var/lib/caddy/admin.sock\\n}\\n' > "$work/new/server/deploy/Caddyfile"
echo "--- old-kit"; LIVE_DIR="$work/old" live_kit_warning 2>&1
echo "--- new-kit"; LIVE_DIR="$work/new" live_kit_warning 2>&1
echo "--- no-kit"; LIVE_DIR="$work/none" live_kit_warning 2>&1
`)
    expect(r.stderr).toBe('')
    const out = sections(r.stdout)
    expect(out.first.match(/Wrote /g)).toHaveLength(4)
    expect(out.again.match(/is up to date\./g)).toHaveLength(4)
    expect(out.again).not.toContain('Wrote ')
    const conf = (name: string) => directives(out[name])
    expect(out['first-twenty.service.d/memory.conf']).toMatch(/^\[Service\]$/m)
    expect(conf('first-twenty.service.d/memory.conf')).toEqual(['MemoryLow=150M'])
    expect(conf('postgresql@16-main.service.d/memory.conf')).toEqual(['MemoryLow=200M'])
    // The cluster's unit runs in its template's slice under system.slice, which needs the reserve as well.
    expect(out['system-postgresql.slice.d/memory.conf']).toMatch(/^\[Slice\]$/m)
    expect(conf('system-postgresql.slice.d/memory.conf')).toEqual(['MemoryLow=200M'])
    expect(out['system.slice.d/memory.conf']).toMatch(/^\[Slice\]$/m)
    // A child's protection counts only up to its parent's: the slice gets exactly the sum.
    expect(conf('system.slice.d/memory.conf')).toEqual(['MemoryLow=350M'])
    expect(out['custom-files'].trim().split('\n').sort()).toEqual(['first-twenty.service.d', 'postgresql@16-main.service.d', 'system-pg16.slice.d', 'system.slice.d'])
    expect(out['no-pg']).toContain('only the live server gets a memory reserve')
    expect(directives(out['no-pg-slice'])).toEqual(['MemoryLow=150M'])
    expect(out['old-kit']).toContain('run setup-ec2.sh only from a fresh clone of main')
    expect(out['old-kit']).toMatch(/never from \S+\/old:/)
    expect(out['new-kit'].trim()).toBe('')
    expect(out['no-kit'].trim()).toBe('')
  })

  it.skipIf(!hasGit)('moves the live checkout off its old branch without changing a file, so no git switch brings the old code back', () => {
    const fns = ['info', 'warn', 'die', 'step', 'run', 'as_user', 'run_as', 'put', 'put_if_changed', 'render_live_unit', 'setup_live'].map((n) => shellFunction(setup, n)).join('\n')
    const r = bash(`${prelude}
${fns}
REAL_GIT=$(command -v git)
g() { "$REAL_GIT" -c user.name=Test -c user.email=test@example.test -c init.defaultBranch=main -c core.autocrlf=false "$@"; }
mkdir -p "$work/bin" "$work/units"
printf '#!/usr/bin/env bash\\n[ "$1" = -u ] && shift 2\\n[ "$1" = -- ] && shift\\nexec "$@"\\n' > "$work/bin/runuser"
for c in systemctl install chown; do printf '#!/usr/bin/env bash\\necho "%s $*" >> "$CALLS"\\n' "$c" > "$work/bin/$c"; done
printf '#!/usr/bin/env bash\\necho "updater $*" >> "$CALLS"\\n' > "$work/bin/updater"
chmod +x "$work"/bin/*
export PATH="$work/bin:$PATH" CALLS="$work/calls"
# The private repo, and the live checkout cloned from it: main tracks origin/main.
g init -q "$work/private"
echo '{"name":"first-twenty"}' > "$work/private/package.json"
g -C "$work/private" add -A; g -C "$work/private" commit -qm private
g clone -q "$work/private" "$work/live"
g -C "$work/live" config core.autocrlf false
# The private repo moves on after the clone, so the clone's origin/main is ahead of what runs.
echo newer > "$work/private/newer.txt"
g -C "$work/private" add -A; g -C "$work/private" commit -qm newer
g -C "$work/live" fetch -q origin
echo "--- before"
echo "head=$(g -C "$work/live" rev-parse HEAD) branch=$(g -C "$work/live" symbolic-ref -q --short HEAD) upstream=$(g -C "$work/live" config --get branch.main.merge)"
echo "remote-refs=$(g -C "$work/live" for-each-ref --format='%(refname)' refs/remotes/origin | tr '\\n' ' ')"
DRY_RUN=false STAMP=20261027-000000 LIVE_DIR="$work/live" LIVE_STATE="$work/state" UNIT_DIR="$work/units" UPDATER="$work/bin/updater"
GIT_URL=https://github.com/unique-name27/first-twenty-team.git REPO=unique-name27/first-twenty-team DEFAULT_REPO=$REPO
DEPLOY_USER=ubuntu DEPLOY_GROUP=ubuntu RELEASE_AUTHOR=unique-name27 SCRIPT_DIR="$DEPLOY"
: > "$work/calls"
echo "--- first"; setup_live 2>&1
echo "--- after"
echo "head=$(g -C "$work/live" rev-parse HEAD) branch=[$(g -C "$work/live" symbolic-ref -q --short HEAD || true)]"
echo "branches=$(g -C "$work/live" for-each-ref --format='%(refname:short)' refs/heads | tr '\\n' ' ')"
echo "upstream=[$(g -C "$work/live" config --get branch.previous-origin-main.merge || true)]"
echo "origin=$(g -C "$work/live" remote get-url origin) previous=$(g -C "$work/live" remote get-url previous-origin)"
echo "status=[$(g -C "$work/live" status --porcelain)]"
echo "remote-refs=[$(g -C "$work/live" for-each-ref --format='%(refname)' refs/remotes | tr '\\n' ' ')]"
# The hint an older deploy.sh prints on a detached HEAD: git switch main must not bring back the old code.
rc=0; g -C "$work/live" switch -q main >/dev/null 2>&1 || rc=$?; echo "switch-main=$rc"
echo "--- again"; setup_live 2>&1
echo "--- after-again"
echo "branches=$(g -C "$work/live" for-each-ref --format='%(refname:short)' refs/heads | tr '\\n' ' ')"
# An earlier setup switched origin but left HEAD on main and the old origin/main in place: a run now
# finishes the job.
g clone -q "$work/private" "$work/live2"
g -C "$work/live2" config core.autocrlf false
g -C "$work/live2" remote set-url origin https://github.com/unique-name27/first-twenty-team.git
echo "--- half-done"; LIVE_DIR="$work/live2" setup_live 2>&1
echo "--- half-done-after"
echo "branch=[$(g -C "$work/live2" symbolic-ref -q --short HEAD || true)]"
echo "branches=$(g -C "$work/live2" for-each-ref --format='%(refname:short)' refs/heads | tr '\\n' ' ')"
echo "remote-refs=[$(g -C "$work/live2" for-each-ref --format='%(refname)' refs/remotes | tr '\\n' ' ')]"
`)
    expect(r.stderr).toBe('')
    const out = sections(r.stdout)
    const before = /^head=([0-9a-f]{40}) branch=main upstream=refs\/heads\/main$/m.exec(out.before)
    expect(before, out.before).not.toBeNull()
    expect(out.before).toContain('refs/remotes/origin/main')
    expect(out.first).toContain('The old address is kept as the remote "previous-origin"')
    expect(out.first).toContain('the old branch main is kept as previous-origin-main, with no upstream')
    expect(out.first).toContain("Removed the old repo's origin/main")
    // Same commit, no branch, nothing changed in the working tree.
    expect(out.after).toContain(`head=${before![1]} branch=[]`)
    expect(out.after).toContain('branches=previous-origin-main \n')
    expect(out.after).toContain('upstream=[]')
    expect(out.after).toContain(`origin=https://github.com/unique-name27/first-twenty-team.git previous=`)
    expect(out.after).toContain('status=[]')
    // No remote-tracking ref names the old repo's commits, so git switch main has nothing to start from.
    expect(out.after).toContain('remote-refs=[]')
    expect(out.after).not.toContain('switch-main=0')
    // A second run finds origin switched already and changes nothing.
    expect(out.again).toContain('origin is already https://github.com/unique-name27/first-twenty-team.git')
    expect(out.again).not.toContain('Removed the old repo')
    expect(out['after-again']).toContain('branches=previous-origin-main \n')
    // Origin already switched by an earlier setup, HEAD still on main: this run detaches it and drops the old refs.
    expect(out['half-done']).toContain('origin is already https://github.com/unique-name27/first-twenty-team.git')
    expect(out['half-done']).toContain('the old branch main is kept as previous-origin-main, with no upstream')
    expect(out['half-done-after']).toContain('branch=[]')
    expect(out['half-done-after']).toContain('branches=previous-origin-main \n')
    expect(out['half-done-after']).toContain('remote-refs=[]')
  })

  it('renders the units and the Caddy site for the staging domain, the deploy login and the release author', () => {
    const r = bash(`${prelude}
${['render_staging_unit', 'render_live_unit', 'render_caddy_site'].map((n) => shellFunction(setup, n)).join('\n')}
SCRIPT_DIR="$DEPLOY" DEFAULT_REPO=unique-name27/first-twenty-team REPO=unique-name27/first-twenty-team
STAGING_DOMAIN=staging-3-14-15-92.sslip.io DEPLOY_USER=ec2-user DEPLOY_GROUP=ec2-user RELEASE_AUTHOR=product-owner
echo "--- staging"; render_staging_unit
echo "--- live"; render_live_unit
echo "--- caddy"; render_caddy_site
echo "--- fork"; REPO=someone/first-twenty render_live_unit
`)
    expect(r.stderr).toBe('')
    const out = sections(r.stdout)
    expect(values(out.staging, 'Environment')).toContain('FT_PUBLIC_ORIGIN=https://staging-3-14-15-92.sslip.io')
    expect(values(out.staging, 'Environment').join(' ')).not.toContain('FT_REPO')
    expect(values(out.live, 'User')).toEqual(['ec2-user'])
    expect(values(out.live, 'Group')).toEqual(['ec2-user'])
    expect(values(out.live, 'Environment')).toContain('FT_RELEASE_AUTHOR=product-owner')
    expect(values(out.fork, 'Environment')).toContain('FT_REPO=someone/first-twenty')
    expect(out.caddy).toMatch(/^http:\/\/staging-3-14-15-92\.sslip\.io \{$/m)
    expect(out.caddy).toMatch(/^staging-3-14-15-92\.sslip\.io \{$/m)
    expect(out.caddy).not.toContain('staging.example.com {')
  })

  it('never writes a password anywhere but the settings file, and never on a command line', () => {
    // The passwords go to psql on standard input and into the settings file through put (standard input).
    expect(shellFunction(setup, 'set_staging_passwords')).toMatch(/psql -X -q -v ON_ERROR_STOP=1 -d postgres\) >\/dev\/null <<SQL\n/)
    expect(shellFunction(setup, 'set_staging_passwords')).toContain("SET log_statement = 'none';")
    expect(setup).toContain('staging_env "${app_pw:-}" "${owner_pw:-}" | put "$STAGING_ENV" 0600 root:root')
    expect(setup).not.toMatch(/echo[^\n]*\$(app_pw|owner_pw)/)
    expect(setup).not.toMatch(/info[^\n]*\$(app_pw|owner_pw)/)
  })
})

// ---------------------------------------------------------------------------------------------------
// auto-update.sh: decisions, run against a local repo and a stub GitHub API
// ---------------------------------------------------------------------------------------------------

/**
 * A repo standing in for GitHub ($work/origin: main with C1 then C2, tags v1 and v2, and an unreviewed
 * commit CSIDE on a side branch with tag v-side), stub commands, and helpers:
 *   newcase <case> <commit>      a clone checked out at <commit>, with its own state, pause folder,
 *                                GitHub fixtures and call log
 *   fx <case> <path> <status> <etag> <body>   what the stub API answers for /repos/<repo>/<path>
 *   au <label> <case> <channel> "<VAR=value ...>" [args]   one run of auto-update.sh, printed as a
 *                                section: rc=, out: lines, call: lines (curl, deploy.sh, sleep, ...),
 *                                state: lines, and head= (the commit checked out after) with AU_HEAD=1
 * The stub deploy.sh in the repo logs its arguments, the lock and previous-commit variables and the
 * commit checked out (and FT_PRIOR_BACKUP when set), and writes the report deploy.sh writes
 * (FT_DEPLOY_REPORT). FAKE_DEPLOY decides how it ends: ok; fail (leaves the new commit checked out, as a
 * deploy.sh that was killed would); restored (fails before the restart and puts the previous commit back,
 * as deploy.sh does); after-restart (fails after the restart); finished-fail (fails after the new server
 * reported healthy); silent (fails without writing anything, as a deploy.sh from before the report does).
 * FAKE_DUMP is the dump it reports, FAKE_MIGRATED=1 says migrations were applied, FAKE_APPLIED names the
 * ones a failure before the restart applied, and FAKE_RESTORE is the dump its way back names.
 */
const autoUpdateHarness = `
REAL_GIT=$(command -v git)
mkdir -p "$work/bin" "$work/cases"
g() { "$REAL_GIT" -c user.name=Test -c user.email=test@example.test -c init.defaultBranch=main -c core.autocrlf=false -c advice.detachedHead=false "$@"; }
g init -q "$work/origin"
mkdir -p "$work/origin/server/deploy"
cat > "$work/origin/server/deploy/deploy.sh" <<'EOF'
#!/usr/bin/env bash
echo "deploy.sh $* lock=\${FT_DEPLOY_LOCK_HELD:-} previous=\${FT_PREVIOUS_COMMIT:-} head=$(git rev-parse HEAD)" >> "$CALLS"
echo "during: $(grep '^failed=' "$FT_STATE_DIR/state" || echo 'failed=')" >> "$CALLS"
[ -z "\${FT_PRIOR_BACKUP:-}" ] || echo "prior: $FT_PRIOR_BACKUP" >> "$CALLS"
[ "\${FAKE_DEPLOY:-ok}" != silent ] || { echo "(stub) an older deploy.sh failed"; exit 1; }
echo "phase=before-restart" >> "$FT_DEPLOY_REPORT"
[ -z "\${FAKE_DUMP:-}" ] || echo "dump=$FAKE_DUMP" >> "$FT_DEPLOY_REPORT"
[ -z "\${FAKE_MIGRATED:-}" ] || echo "migrated=1" >> "$FT_DEPLOY_REPORT"
case "\${FAKE_DEPLOY:-ok}" in
  ok) printf 'phase=restarted\\nphase=finished\\n' >> "$FT_DEPLOY_REPORT"; echo "(stub) deployed" ;;
  fail) echo "(stub) the build failed"; exit 1 ;;
  restored)
    git -c advice.detachedHead=false checkout --quiet --detach "$FT_PREVIOUS_COMMIT"
    [ -z "\${FAKE_APPLIED:-}" ] || echo "applied=$FAKE_APPLIED" >> "$FT_DEPLOY_REPORT"
    echo "restored=1" >> "$FT_DEPLOY_REPORT"
    echo "(stub) the build failed; put back"
    exit 1
    ;;
  after-restart)
    echo "phase=restarted" >> "$FT_DEPLOY_REPORT"
    [ -z "\${FAKE_RESTORE:-}" ] || echo "restore_dump=$FAKE_RESTORE" >> "$FT_DEPLOY_REPORT"
    echo "(stub) not healthy"
    exit 1
    ;;
  finished-fail) printf 'phase=restarted\\nphase=finished\\n' >> "$FT_DEPLOY_REPORT"; echo "(stub) healthy, then the clean-up failed"; exit 1 ;;
esac
EOF
cp "$DEPLOY/auto-update.sh" "$work/origin/server/deploy/auto-update.sh"
g -C "$work/origin" add -A
g -C "$work/origin" commit -qm one
C1=$(g -C "$work/origin" rev-parse HEAD)
g -C "$work/origin" tag v1
echo two > "$work/origin/two.txt"
g -C "$work/origin" add -A
g -C "$work/origin" commit -qm two
C2=$(g -C "$work/origin" rev-parse HEAD)
g -C "$work/origin" tag v2
g -C "$work/origin" checkout -q -b side
echo side > "$work/origin/side.txt"
g -C "$work/origin" add -A
g -C "$work/origin" commit -qm side
CSIDE=$(g -C "$work/origin" rev-parse HEAD)
g -C "$work/origin" tag v-side
g -C "$work/origin" checkout -q main
echo "--- shas"
echo "C1=$C1"; echo "C2=$C2"; echo "CSIDE=$CSIDE"

cat > "$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
hdr=; out=; url=; inm=
while [ $# -gt 0 ]; do
  case "$1" in
    -D) hdr=$2; shift ;;
    -o) out=$2; shift ;;
    -w | --max-time | --proto) shift ;;
    -H) case "$2" in If-None-Match:*) inm=\${2#If-None-Match: } ;; esac; shift ;;
    https://* | http://*) url=$1 ;;
  esac
  shift
done
# Caddy's admin API: closed (as after setup) unless FAKE_CADDY_ADMIN=open.
case "$url" in
  http://127.0.0.1:2019/* | 'http://[::1]:2019/'*)
    echo "caddy-admin-check $url" >> "$CALLS"
    [ "\${FAKE_CADDY_ADMIN:-}" = open ] && exit 0
    echo "curl: (7) Failed to connect" >&2
    exit 7
    ;;
esac
path=\${url#https://api.github.com/repos/unique-name27/first-twenty-team/}
echo "curl $path\${inm:+ if-none-match=$inm}" >> "$CALLS"
if [ -n "\${FAKE_GH_DOWN:-}" ]; then echo "curl: (6) Could not resolve host: api.github.com" >&2; printf 000; exit 6; fi
dir="$FAKE_GH/$(printf '%s' "$path" | tr '/?&=' '____')"
status=404; etag=; body='{"message":"Not Found"}'
if [ -d "$dir" ]; then
  status=$(cat "$dir/status"); etag=$(cat "$dir/etag"); body=$(cat "$dir/body")
  if [ -n "$inm" ] && [ "$inm" = "$etag" ]; then status=304; body=; fi
fi
{
  printf 'HTTP/2 %s\\r\\n' "$status"
  [ -z "$etag" ] || printf 'ETag: %s\\r\\n' "$etag"
  printf 'X-RateLimit-Remaining: 55\\r\\nX-RateLimit-Reset: 1900000000\\r\\n\\r\\n'
} > "$hdr"
printf '%s' "$body" > "$out"
printf '%s' "$status"
EOF
cat > "$work/bin/flock" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  *' 8') [ "\${FAKE_LOCK:-}" = held ] && exit 1 ;;
  *' 9') [ "\${FAKE_DEPLOY_LOCK:-}" = held ] && exit 1 ;;
esac
exit 0
EOF
# A oneshot unit that is running reports "activating" (never "active"), and systemctl is-active fails for it.
cat > "$work/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
[ "$1" != is-active ] || { echo "systemctl is-active must not be used for oneshot units" >&2; exit 3; }
if [ "$1 $2 $3 $4" = "show -p ActiveState --value" ]; then
  if [ "$5" = "\${FAKE_ACTIVE:-}" ]; then
    n=$(cat "$FAKE_ACTIVE_COUNT" 2>/dev/null || echo 0)
    if [ "$n" -lt "\${FAKE_ACTIVE_POLLS:-1000}" ]; then echo $((n + 1)) > "$FAKE_ACTIVE_COUNT"; echo activating; exit 0; fi
  fi
  echo inactive
  exit 0
fi
echo "systemctl $*" >> "$CALLS"
EOF
printf '#!/usr/bin/env bash\\necho "sleep $*" >> "$CALLS"\\n' > "$work/bin/sleep"
# sudo for a pause folder the login cannot enter: FAKE_SUDO=none (no sudo), FAKE_PAUSED=yes (the file is
# there), otherwise it runs the command, which finds no file.
cat > "$work/bin/sudo" <<'EOF'
#!/usr/bin/env bash
echo "sudo $*" >> "$CALLS"
[ "\${FAKE_SUDO:-ok}" = ok ] || { echo "sudo: a password is required" >&2; exit 1; }
[ "$1" = -n ] && shift
[ "\${FAKE_PAUSED:-}" != yes ] || { echo yes; exit 0; }
exec "$@"
EOF
chmod +x "$work"/bin/*

newcase() { # newcase <case> <commit>
  local dir="$work/cases/$1"
  mkdir -p "$dir/gh" "$dir/state" "$dir/etc"
  g clone -q "$work/origin" "$dir/app"
  g -C "$dir/app" checkout -q --detach "$2"
}
fx() { # fx <case> <path> <status> <etag> <body>
  local dir
  dir="$work/cases/$1/gh/$(printf '%s' "$2" | tr '/?&=' '____')"
  mkdir -p "$dir"
  printf '%s' "$3" > "$dir/status"; printf '%s' "$4" > "$dir/etag"; printf '%s' "$5" > "$dir/body"
}
checks() { # checks <case> <sha> <status> <conclusion json> [app]
  fx "$1" "commits/$2/check-runs?check_name=verify&filter=latest" 200 "\\"c-$3\\"" \\
    "$(printf '{"total_count":2,"check_runs":[{"id":41,"name":"verify","head_sha":"%s","status":"completed","conclusion":"failure","app":{"slug":"%s"}},{"id":42,"name":"verify","head_sha":"%s","status":"%s","conclusion":%s,"app":{"slug":"%s"}}]}' "$2" "\${5:-github-actions}" "$2" "$3" "$4" "\${5:-github-actions}")"
}
release() { # release <case> <tag> <author> <draft> <prerelease> [etag] [published_at] [id]
  fx "$1" releases/latest 200 "\${6:-\\"r-$2\\"}" "$(printf '{"id":%s,"tag_name":"%s","draft":%s,"prerelease":%s,"author":{"login":"%s"},"published_at":"%s","body":"notes = here"}' "\${8:-7}" "$2" "$4" "$5" "$3" "\${7:-2099-01-01T00:00:00Z}")"
}
deployed() { printf 'deployed_sha=%s\\n' "$2" > "$work/cases/$1/state/state"; }
au() { # au <label> <case> <channel> "<VAR=value ...>" [args]
  local label=$1 dir="$work/cases/$2" channel=$3 vars=$4 rc=0
  shift 4
  : > "$dir/calls"
  env FT_APP_DIR="$dir/app" FT_STATE_DIR="$dir/state" FT_PAUSE_FILE="$dir/etc/autodeploy.paused" FT_GIT_URL="$work/origin" \\
    FAKE_GH="$dir/gh" CALLS="$dir/calls" FAKE_ACTIVE_COUNT="$dir/active-count" TMPDIR="$dir" PATH="$work/bin:$PATH" $vars \\
    bash "$DEPLOY/auto-update.sh" "$channel" "$@" > "$dir/out" 2>&1 || rc=$?
  echo "--- $label"
  echo "rc=$rc"
  sed 's/^/out: /' "$dir/out"
  sed 's/^/call: /' "$dir/calls"
  sed -n 's/^\\(deployed_sha\\|failed\\|predump\\|skip_sha\\|skip_failed\\)=/state: &/p' "$dir/state/state" 2>/dev/null || true
  [ -z "\${AU_HEAD:-}" ] || echo "head=$(g -C "$dir/app" rev-parse HEAD)"
}
`

describe.skipIf(!BASH || !hasGit)('auto-update.sh decisions', () => {
  let runs: Record<string, string> = {}
  const sha: Record<string, string> = {}
  beforeAll(() => {
    const r = bash(`${prelude}${autoUpdateHarness}
# --- staging
newcase s-deploy "$C1"; deployed s-deploy "$C1"
fx s-deploy commits/main 200 '"h2"' "$C2"; checks s-deploy "$C2" completed '"success"'
au s-deploy-1 s-deploy staging ''
au s-deploy-2 s-deploy staging ''

newcase s-first "$C2"
fx s-first commits/main 200 '"h2"' "$C2"; checks s-first "$C2" completed '"success"'
au s-first s-first staging ''

newcase s-pending "$C1"; deployed s-pending "$C1"
fx s-pending commits/main 200 '"h2"' "$C2"; checks s-pending "$C2" in_progress null
au s-pending s-pending staging ''

newcase s-failure "$C1"; deployed s-failure "$C1"
fx s-failure commits/main 200 '"h2"' "$C2"; checks s-failure "$C2" completed '"failure"'
au s-failure-1 s-failure staging ''
au s-failure-2 s-failure staging ''

newcase s-other-app "$C1"; deployed s-other-app "$C1"
fx s-other-app commits/main 200 '"h2"' "$C2"; checks s-other-app "$C2" completed '"success"' someone-elses-app
au s-other-app s-other-app staging ''

newcase s-paused "$C1"; deployed s-paused "$C1"
fx s-paused commits/main 200 '"h2"' "$C2"; checks s-paused "$C2" completed '"success"'
: > "$work/cases/s-paused/etc/autodeploy.paused"
au s-paused s-paused staging ''

newcase s-locked "$C1"; deployed s-locked "$C1"
fx s-locked commits/main 200 '"h2"' "$C2"; checks s-locked "$C2" completed '"success"'
au s-locked s-locked staging 'FAKE_LOCK=held'

newcase s-live-busy "$C1"; deployed s-live-busy "$C1"
fx s-live-busy commits/main 200 '"h2"' "$C2"; checks s-live-busy "$C2" completed '"success"'
au s-live-busy s-live-busy staging 'FAKE_ACTIVE=first-twenty-autoupdate-live.service'

newcase s-rate "$C1"; deployed s-rate "$C1"
echo "rate_reset=$(($(date +%s) + 3600))" >> "$work/cases/s-rate/state/state"
fx s-rate commits/main 200 '"h2"' "$C2"
au s-rate s-rate staging ''

newcase s-down "$C1"; deployed s-down "$C1"
au s-down s-down staging 'FAKE_GH_DOWN=1'

newcase s-checkout "$C1"; deployed s-checkout "$C1"
fx s-checkout commits/main 200 '"h2"' "$C2"; checks s-checkout "$C2" completed '"success"'
echo untracked > "$work/cases/s-checkout/app/two.txt"
au s-checkout s-checkout staging ''

newcase s-caddy-open "$C1"; deployed s-caddy-open "$C1"
fx s-caddy-open commits/main 200 '"h2"' "$C2"; checks s-caddy-open "$C2" completed '"success"'
au s-caddy-open s-caddy-open staging 'FAKE_CADDY_ADMIN=open'

# --- live
newcase l-deploy "$C1"
release l-deploy v2 unique-name27 false false; fx l-deploy commits/v2 200 '"t2"' "$C2"; checks l-deploy "$C2" completed '"success"'
au l-deploy-1 l-deploy live ''
au l-deploy-2 l-deploy live ''

newcase l-author "$C1"
release l-author v2 team-member-1 false false; fx l-author commits/v2 200 '"t2"' "$C2"; checks l-author "$C2" completed '"success"'
au l-author-1 l-author live ''
au l-author-2 l-author live ''

newcase l-draft "$C1"
release l-draft v2 unique-name27 true false; fx l-draft commits/v2 200 '"t2"' "$C2"; checks l-draft "$C2" completed '"success"'
au l-draft l-draft live ''

newcase l-prerelease "$C1"
release l-prerelease v2 unique-name27 false true; fx l-prerelease commits/v2 200 '"t2"' "$C2"; checks l-prerelease "$C2" completed '"success"'
au l-prerelease l-prerelease live ''

newcase l-pending "$C1"
release l-pending v2 unique-name27 false false; fx l-pending commits/v2 200 '"t2"' "$C2"; checks l-pending "$C2" queued null
au l-pending l-pending live ''

newcase l-off-main "$C1"
release l-off-main v-side unique-name27 false false; fx l-off-main commits/v-side 200 '"ts"' "$CSIDE"; checks l-off-main "$CSIDE" completed '"success"'
au l-off-main-1 l-off-main live ''
au l-off-main-2 l-off-main live ''

newcase l-older "$C2"; deployed l-older "$C2"
release l-older v1 unique-name27 false false; fx l-older commits/v1 200 '"t1"' "$C1"; checks l-older "$C1" completed '"success"'
au l-older l-older live ''

newcase l-none "$C1"
au l-none l-none live ''

newcase l-record "$C2"
au l-record l-record live '' --record-deployed

newcase l-wait "$C1"
release l-wait v2 unique-name27 false false; fx l-wait commits/v2 200 '"t2"' "$C2"; checks l-wait "$C2" completed '"success"'
au l-wait l-wait live 'FAKE_ACTIVE=first-twenty-autoupdate-staging.service FAKE_ACTIVE_POLLS=2'

newcase l-by-hand "$C1"
release l-by-hand v2 unique-name27 false false; fx l-by-hand commits/v2 200 '"t2"' "$C2"; checks l-by-hand "$C2" completed '"success"'
au l-by-hand l-by-hand live 'FAKE_DEPLOY_LOCK=held'

# deploy.sh was killed before it could put the folder back (FAKE_DEPLOY=fail leaves the new commit checked out).
newcase l-fail "$C1"; deployed l-fail "$C1"
release l-fail v2 unique-name27 false false; fx l-fail commits/v2 200 '"t2"' "$C2"; checks l-fail "$C2" completed '"success"'
au l-fail l-fail live 'FAKE_DEPLOY=fail'

newcase l-caddy-open "$C1"
release l-caddy-open v2 unique-name27 false false; fx l-caddy-open commits/v2 200 '"t2"' "$C2"; checks l-caddy-open "$C2" completed '"success"'
au l-caddy-open l-caddy-open live 'FAKE_CADDY_ADMIN=open'

# A release published in 2001 whose tag now points at a commit made today: the tag was moved. A new release
# (another id) of the same commit, published after it, goes out.
newcase l-moved "$C1"
release l-moved v2 unique-name27 false false '"r-old"' 2001-01-01T00:00:00Z 7
fx l-moved commits/v2 200 '"t2"' "$C2"; checks l-moved "$C2" completed '"success"'
au l-moved-1 l-moved live ''
au l-moved-2 l-moved live ''
release l-moved v2 unique-name27 false false '"r-new"' 2099-01-01T00:00:00Z 8
au l-moved-3 l-moved live ''

newcase l-no-date "$C1"
fx l-no-date releases/latest 200 '"r-nd"' '{"id":9,"tag_name":"v2","draft":false,"prerelease":false,"author":{"login":"unique-name27"}}'
fx l-no-date commits/v2 200 '"t2"' "$C2"; checks l-no-date "$C2" completed '"success"'
au l-no-date l-no-date live ''

# --- a commit that keeps failing: three tries, then nothing until a newer commit is on main
newcase s-three "$C1"; deployed s-three "$C1"
fx s-three commits/main 200 '"h2"' "$C2"; checks s-three "$C2" completed '"success"'
for n in 1 2 3 4; do au "s-three-$n" s-three staging 'FAKE_DEPLOY=fail'; done
echo three > "$work/origin/three.txt"
g -C "$work/origin" add -A
g -C "$work/origin" commit -qm three
C3=$(g -C "$work/origin" rev-parse HEAD)
echo "--- shas3"
echo "C3=$C3"
fx s-three commits/main 200 '"h3"' "$C3"; checks s-three "$C3" completed '"success"'
au s-three-5 s-three staging 'FAKE_DEPLOY=fail'
`)
    expect(r.stderr).toBe('')
    runs = sections(r.stdout)
    for (const part of ['shas', 'shas3']) {
      for (const line of (runs[part] ?? '').split('\n')) {
        const m = /^(\w+)=([0-9a-f]{40})$/.exec(line)
        if (m) sha[m[1]] = m[2]
      }
    }
    expect(Object.keys(sha).sort()).toEqual(['C1', 'C2', 'C3', 'CSIDE'])
  }, LONG_MS)

  const get = (name: string) => {
    const s = runs[name]
    expect(s, name).toBeDefined()
    return s
  }
  const deploys = (name: string) => callsOf(get(name)).filter((c) => c.startsWith('deploy.sh '))
  const curls = (name: string) => callsOf(get(name)).filter((c) => c.startsWith('curl '))

  it('staging: deploys a new commit on main once its verify check passed, holding the deploy lock, as the staging instance', () => {
    const s = get('s-deploy-1')
    expect(s).toContain('rc=0')
    expect(curls('s-deploy-1')).toEqual(['curl commits/main', `curl commits/${sha.C2}/check-runs?check_name=verify&filter=latest`])
    expect(deploys('s-deploy-1')).toEqual([`deploy.sh --instance staging --no-pull lock=1 previous=${sha.C1} head=${sha.C2}`])
    // The try is on record while deploy.sh runs (a run that systemd stops still counts), and cleared after.
    expect(callsOf(s)).toContain(`during: failed=${sha.C2}:1`)
    expect(s).toContain('state: failed=\n')
    expect(s).toContain(`state: deployed_sha=${sha.C2}`)
    expect(outOf(s)).toContain(`deployed main at ${sha.C2.slice(0, 7)}`)
  })

  it('counts a checkout that git refuses as a failed try, and leaves the code as it was', () => {
    const s = get('s-checkout')
    expect(s).toContain('rc=1')
    expect(deploys('s-checkout')).toEqual([])
    expect(outOf(s)).toContain(`git could not check out ${sha.C2.slice(0, 7)}`)
    expect(s).toContain(`state: failed=${sha.C2}:1`)
  })

  it("staging: deploys nothing while Caddy's admin API answers on 127.0.0.1:2019; live does not depend on it", () => {
    const s = get('s-caddy-open')
    expect(s).toContain('rc=1')
    expect(deploys('s-caddy-open')).toEqual([])
    expect(callsOf(s)).toContain('caddy-admin-check http://127.0.0.1:2019/config/')
    expect(outOf(s)).toContain("Caddy's admin API answers on 127.0.0.1:2019")
    expect(outOf(s)).toContain('setup-auto-deploy.sh --staging-only')
    // Not a failed try: nothing ran.
    expect(s).not.toMatch(/state: failed=\S/)
    // With the admin API closed, staging asks once per deploy and goes ahead.
    expect(callsOf(get('s-deploy-1'))).toContain('caddy-admin-check http://127.0.0.1:2019/config/')
    expect(deploys('l-caddy-open')).toHaveLength(1)
    expect(callsOf(get('l-caddy-open')).filter((c) => c.startsWith('caddy-admin-check'))).toEqual([])
  })

  it('staging: an unchanged answer (304) costs one request and nothing else', () => {
    const s = get('s-deploy-2')
    expect(s).toContain('rc=0')
    expect(callsOf(s)).toEqual(['curl commits/main if-none-match="h2"'])
    expect(outOf(s)).toContain('already deployed; nothing to do')
  })

  it('staging: builds a fresh clone on the first run, since nothing is deployed yet', () => {
    const s = get('s-first')
    expect(s).toContain('rc=0')
    expect(deploys('s-first')).toEqual([`deploy.sh --instance staging --no-pull lock=1 previous=${sha.C2} head=${sha.C2}`])
  })

  it('staging: waits while verify is still running, and skips a commit whose verify failed', () => {
    expect(deploys('s-pending')).toEqual([])
    expect(outOf(get('s-pending'))).toContain('has not finished (in_progress)')
    expect(get('s-pending')).toContain('rc=0')
    expect(deploys('s-failure-1')).toEqual([])
    expect(outOf(get('s-failure-1'))).toContain('its verify check did not pass (failure)')
    // A known failure is not asked about again for a while: one request, for main.
    expect(curls('s-failure-2')).toEqual(['curl commits/main if-none-match="h2"'])
    expect(outOf(get('s-failure-2'))).toContain('did not pass (failure)')
  })

  it('staging: counts only a verify check that GitHub Actions reported', () => {
    expect(deploys('s-other-app')).toEqual([])
    expect(outOf(get('s-other-app'))).toContain('has not finished (not-started)')
  })

  it('stops before asking GitHub anything when paused, when another run holds the lock, or until the hourly limit resets', () => {
    for (const name of ['s-paused', 's-locked', 's-rate']) {
      expect(get(name), name).toContain('rc=0')
      expect(callsOf(get(name)), name).toEqual([])
    }
    expect(outOf(get('s-paused'))).toMatch(/paused \(.*autodeploy\.paused exists\)/)
    expect(outOf(get('s-locked'))).toContain('another run is still going')
    expect(outOf(get('s-rate'))).toContain('hourly limit')
  })

  it('staging: leaves the build to the live channel while it runs, and shrugs off GitHub being unreachable', () => {
    expect(deploys('s-live-busy')).toEqual([])
    expect(outOf(get('s-live-busy'))).toContain('the live channel is running')
    expect(get('s-down')).toContain('rc=0')
    expect(outOf(get('s-down'))).toContain('could not reach GitHub')
  })

  it('stops retrying a failing commit after 3 tries, and tries again when a newer commit appears', () => {
    for (const n of [1, 2, 3]) {
      const name = `s-three-${n}`
      expect(get(name), name).toContain('rc=1')
      expect(deploys(name), name).toHaveLength(1)
      expect(outOf(get(name)), name).toContain(`try ${n} of 3`)
    }
    expect(get('s-three-3')).toContain(`state: failed=${sha.C2}:3`)
    const fourth = get('s-three-4')
    expect(fourth).toContain('rc=0')
    expect(deploys('s-three-4')).toEqual([])
    expect(callsOf(fourth)).toEqual(['curl commits/main if-none-match="h2"'])
    expect(outOf(fourth)).toContain('failed to deploy 3 times')
    expect(deploys('s-three-5')).toEqual([`deploy.sh --instance staging --no-pull lock=1 previous=${sha.C1} head=${sha.C3}`])
    expect(outOf(get('s-three-5'))).toContain('try 1 of 3')
  })

  it("live: deploys the owner's newest release at its exact commit, detached, with the commit to go back to", () => {
    const s = get('l-deploy-1')
    expect(s).toContain('rc=0')
    expect(curls('l-deploy-1')).toEqual(['curl releases/latest', 'curl commits/v2', `curl commits/${sha.C2}/check-runs?check_name=verify&filter=latest`])
    expect(deploys('l-deploy-1')).toEqual([`deploy.sh --no-pull lock=1 previous=${sha.C1} head=${sha.C2}`])
    expect(s).toContain(`state: deployed_sha=${sha.C2}`)
    expect(callsOf(get('l-deploy-2'))).toEqual(['curl releases/latest if-none-match="r-v2"'])
    expect(outOf(get('l-deploy-2'))).toContain('already deployed')
  })

  it('live: skips a release created by anyone but the owner, a draft and a prerelease, without asking for more', () => {
    // GitHub's author of a release is whoever created it, which publishing a draft does not change.
    expect(outOf(get('l-author-1'))).toContain('created by team-member-1, and only releases unique-name27 created go live')
    expect(curls('l-author-1')).toEqual(['curl releases/latest'])
    expect(callsOf(get('l-author-2'))).toEqual(['curl releases/latest if-none-match="r-v2"'])
    expect(outOf(get('l-author-2'))).toContain('created by team-member-1')
    for (const name of ['l-draft', 'l-prerelease']) {
      expect(outOf(get(name)), name).toContain('it is a draft or a prerelease')
      expect(deploys(name), name).toEqual([])
      expect(curls(name), name).toEqual(['curl releases/latest'])
    }
    expect(deploys('l-author-1')).toEqual([])
  })

  it('live: waits for verify, and never deploys a commit that is not on main or is older than the deployed one', () => {
    expect(deploys('l-pending')).toEqual([])
    expect(outOf(get('l-pending'))).toContain('has not finished (queued)')
    expect(deploys('l-off-main-1')).toEqual([])
    expect(outOf(get('l-off-main-1'))).toContain('its commit is not on main')
    // Remembered: the next run needs one request and no fetch.
    expect(callsOf(get('l-off-main-2'))).toEqual(['curl releases/latest if-none-match="r-v-side"'])
    expect(outOf(get('l-off-main-2'))).toContain('its commit is not on main')
    expect(deploys('l-older')).toEqual([])
    expect(outOf(get('l-older'))).toContain(`the deployed commit ${sha.C2.slice(0, 7)} already contains it`)
  })

  it('live: never deploys a tag that points at a commit made after the release was published, until a new release', () => {
    expect(deploys('l-moved-1')).toEqual([])
    expect(get('l-moved-1')).toContain('rc=0')
    expect(outOf(get('l-moved-1'))).toContain('its commit was made after the release was published, so the tag was moved')
    // Remembered for this release: one request, no fetch.
    expect(callsOf(get('l-moved-2'))).toEqual(['curl releases/latest if-none-match="r-old"'])
    expect(outOf(get('l-moved-2'))).toContain('the tag was moved')
    // A newer release of the same commit deploys it.
    expect(deploys('l-moved-3')).toEqual([`deploy.sh --no-pull lock=1 previous=${sha.C1} head=${sha.C2}`])
    // A release without a publication time is not trusted.
    expect(deploys('l-no-date')).toEqual([])
    expect(outOf(get('l-no-date'))).toContain('GitHub gave no publication time for it')
  })

  it('live: says when there is no release yet, and records the checked-out commit on request', () => {
    expect(get('l-none')).toContain('rc=0')
    expect(outOf(get('l-none'))).toContain('no release has been published')
    const rec = get('l-record')
    expect(rec).toContain('rc=0')
    expect(callsOf(rec)).toEqual([])
    expect(rec).toContain(`state: deployed_sha=${sha.C2}`)
  })

  it('live: waits for a staging build to finish, and for a deploy started by hand, before building', () => {
    const calls = callsOf(get('l-wait'))
    expect(calls.filter((c) => c === 'sleep 15')).toHaveLength(2)
    expect(calls.indexOf('sleep 15')).toBeLessThan(calls.findIndex((c) => c.startsWith('deploy.sh ')))
    expect(deploys('l-wait')).toHaveLength(1)
    expect(deploys('l-by-hand')).toEqual([])
    expect(get('l-by-hand')).toContain('rc=0')
    expect(outOf(get('l-by-hand'))).toContain('a deploy started by hand is running')
  })

  it('live: reports a failed deploy that deploy.sh could not put back, and how to pause and put it back', () => {
    const s = get('l-fail')
    expect(s).toContain('rc=1')
    expect(s).toContain(`state: failed=${sha.C2}:1`)
    const out = outOf(s)
    expect(out).toContain(`is now ${sha.C2.slice(0, 7)} and may be half built, while the server still runs ${sha.C1.slice(0, 7)}`)
    expect(out).toMatch(/To stop the retries and roll back: sudo touch \S+autodeploy\.paused, then: cd \S+ && git checkout --detach [0-9a-f]{7} && bash server\/deploy\/deploy\.sh --no-pull/)
    expect(out).toContain(`git checkout --detach ${sha.C1.slice(0, 7)} && bash server/deploy/deploy.sh --no-pull`)
  })
})

describe.skipIf(!BASH || !hasGit)('auto-update.sh after a failed deploy', () => {
  let runs: Record<string, string> = {}
  const sha: Record<string, string> = {}
  beforeAll(() => {
    // A spawn of its own: each deploying run takes seconds in Git Bash, and one spawn gets LONG_MS.
    const r = bash(`${prelude}${autoUpdateHarness}
AU_HEAD=1
# deploy.sh was killed before it could put the folder back: retried, then given up with the unit failed.
newcase l-killed "$C1"; deployed l-killed "$C1"
release l-killed v2 unique-name27 false false; fx l-killed commits/v2 200 '"t2"' "$C2"; checks l-killed "$C2" completed '"success"'
au l-killed-1 l-killed live 'FAKE_DEPLOY=fail FT_MAX_TRIES=2'
au l-killed-2 l-killed live 'FAKE_DEPLOY=fail FT_MAX_TRIES=2'
au l-killed-3 l-killed live 'FAKE_DEPLOY=fail FT_MAX_TRIES=2'

# Failures before the restart that deploy.sh put back, the first after a backup and a migration that was
# applied: retried with that dump, then given up. A success forgets the dump.
DUMP1=/var/backups/first-twenty/first-twenty-20261027-120000Z.dump
DUMP2=/var/backups/first-twenty/first-twenty-20261027-123000Z.dump
newcase l-back "$C1"; deployed l-back "$C1"
release l-back v2 unique-name27 false false; fx l-back commits/v2 200 '"t2"' "$C2"; checks l-back "$C2" completed '"success"'
au l-back-1 l-back live "FAKE_DEPLOY=restored FAKE_DUMP=$DUMP1 FAKE_APPLIED=002_next.sql FT_MAX_TRIES=2"
au l-back-2 l-back live "FAKE_DEPLOY=restored FAKE_DUMP=$DUMP2 FT_MAX_TRIES=2"
au l-back-3 l-back live 'FT_MAX_TRIES=2'
newcase l-back-ok "$C1"; deployed l-back-ok "$C1"
release l-back-ok v2 unique-name27 false false; fx l-back-ok commits/v2 200 '"t2"' "$C2"; checks l-back-ok "$C2" completed '"success"'
au l-back-ok-1 l-back-ok live "FAKE_DEPLOY=restored FAKE_DUMP=$DUMP1 FAKE_APPLIED=002_next.sql"
au l-back-ok-2 l-back-ok live ''

# A failure after the restart: never retried on live, the way back logged on every run (paused too); staging
# retries.
newcase l-restart "$C1"; deployed l-restart "$C1"
release l-restart v2 unique-name27 false false; fx l-restart commits/v2 200 '"t2"' "$C2"; checks l-restart "$C2" completed '"success"'
au l-restart-1 l-restart live "FAKE_DEPLOY=after-restart FAKE_DUMP=$DUMP1"
au l-restart-2 l-restart live ''
: > "$work/cases/l-restart/etc/autodeploy.paused"
au l-restart-3 l-restart live ''
newcase s-restart "$C1"; deployed s-restart "$C1"
fx s-restart commits/main 200 '"h2"' "$C2"; checks s-restart "$C2" completed '"success"'
au s-restart-1 s-restart staging 'FAKE_DEPLOY=after-restart'
au s-restart-2 s-restart staging 'FAKE_DEPLOY=after-restart'

# A run stopped in the middle of a deploy (TimeoutStartSec, out of memory) leaves its report behind: the
# next run still counts what it says, after the restart (not tried again) or before it (its dump).
newcase l-stopped "$C1"; deployed l-stopped "$C1"
release l-stopped v2 unique-name27 false false; fx l-stopped commits/v2 200 '"t2"' "$C2"; checks l-stopped "$C2" completed '"success"'
echo "failed=$C2:1" >> "$work/cases/l-stopped/state/state"
printf 'target=%s\\nphase=before-restart\\ndump=%s\\nphase=restarted\\n' "$C2" "$DUMP1" > "$work/cases/l-stopped/state/deploy-report"
au l-stopped l-stopped live ''
newcase l-stopped-early "$C1"; deployed l-stopped-early "$C1"
release l-stopped-early v2 unique-name27 false false; fx l-stopped-early commits/v2 200 '"t2"' "$C2"; checks l-stopped-early "$C2" completed '"success"'
printf 'target=%s\\nphase=before-restart\\ndump=%s\\n' "$C2" "$DUMP1" > "$work/cases/l-stopped-early/state/deploy-report"
au l-stopped-early l-stopped-early live 'FAKE_DEPLOY=restored'

# A pause folder the deploy login cannot enter (as /etc/first-twenty): one sudo call per run.
newcase l-sudo "$C1"; deployed l-sudo "$C1"
au l-sudo-yes l-sudo live "FT_PAUSE_FILE=$work/cases/l-sudo/closed/autodeploy.paused FAKE_PAUSED=yes"
au l-sudo-no l-sudo live "FT_PAUSE_FILE=$work/cases/l-sudo/closed/autodeploy.paused"
au l-sudo-none l-sudo live "FT_PAUSE_FILE=$work/cases/l-sudo/closed/autodeploy.paused FAKE_SUDO=none"
`)
    expect(r.stderr).toBe('')
    runs = sections(r.stdout)
    for (const line of (runs.shas ?? '').split('\n')) {
      const m = /^(\w+)=([0-9a-f]{40})$/.exec(line)
      if (m) sha[m[1]] = m[2]
    }
    expect(Object.keys(sha).sort()).toEqual(['C1', 'C2', 'CSIDE'])
  }, LONG_MS)

  const get = (name: string) => {
    const s = runs[name]
    expect(s, name).toBeDefined()
    return s
  }
  const deploys = (name: string) => callsOf(get(name)).filter((c) => c.startsWith('deploy.sh '))
  const curls = (name: string) => callsOf(get(name)).filter((c) => c.startsWith('curl '))

  it('live: once it gives up, keeps the unit failed and says where the code stands and the way back', () => {
    expect(outOf(get('l-killed-1'))).toContain('try 1 of 2')
    expect(outOf(get('l-killed-2'))).toContain('try 2 of 2')
    expect(outOf(get('l-killed-2'))).toContain('giving up on it')
    const s = get('l-killed-3')
    // Exit 1, so first-twenty-autoupdate-live stays failed while the newest release is a failed one.
    expect(s).toContain('rc=1')
    expect(deploys('l-killed-3')).toEqual([])
    const out = outOf(s)
    expect(out).toContain('failed to deploy 2 times; not trying again until a newer release is published')
    expect(out).toContain(`is at ${sha.C2.slice(0, 7)} and may be half built, while the server runs ${sha.C1.slice(0, 7)}`)
    expect(out).toContain(`git checkout --detach ${sha.C1.slice(0, 7)} && bash server/deploy/deploy.sh --no-pull`)
    // --record-deployed only after a rebuild by hand: run on the half-built code, it would record that.
    expect(out).toContain('After rebuilding a commit by hand (git checkout --detach <commit> && bash server/deploy/deploy.sh --no-pull), record it with: first-twenty-autoupdate live --record-deployed')
    // Code that deploy.sh put back needs no warning. (Staging still gives up with rc=0: s-three-4 above.)
    expect(get('l-back-3')).toContain('rc=1')
    expect(outOf(get('l-back-3'))).toContain('failed to deploy 2 times')
    expect(outOf(get('l-back-3'))).not.toContain('may be half built')
    expect(deploys('l-back-3')).toEqual([])
  })

  it('live: after a failure before the restart that deploy.sh put back, retries with the dump from before the first try', () => {
    const dump1 = '/var/backups/first-twenty/first-twenty-20261027-120000Z.dump'
    const first = get('l-back-1')
    expect(first).toContain('rc=1')
    expect(first).toContain(`head=${sha.C1}`)
    const out = outOf(first)
    expect(out).toContain(`Nothing was restarted, and deploy.sh put `)
    expect(out).toContain(`back at ${sha.C1.slice(0, 7)}, the version the server still runs`)
    expect(out).toContain('trying again next run')
    expect(out).not.toContain('may be half built')
    expect(first).toContain(`state: predump=${sha.C2}:${dump1}`)
    expect(callsOf(first).filter((c) => c.startsWith('prior: '))).toEqual([])
    // The second try gets the first try's dump, and the state keeps that one, not its own.
    const second = get('l-back-2')
    expect(callsOf(second)).toContain(`prior: ${dump1}`)
    expect(second).toContain(`state: predump=${sha.C2}:${dump1}`)
    // A deploy that succeeds forgets it.
    expect(get('l-back-ok-1')).toContain(`state: predump=${sha.C2}:${dump1}`)
    expect(callsOf(get('l-back-ok-2'))).toContain(`prior: ${dump1}`)
    expect(get('l-back-ok-2')).toContain('rc=0')
    expect(get('l-back-ok-2')).not.toContain('state: predump=')
  })

  it('live: never retries a deploy that failed after its restart, and logs the way back with the dump on every run', () => {
    const dump1 = '/var/backups/first-twenty/first-twenty-20261027-120000Z.dump'
    const first = get('l-restart-1')
    expect(first).toContain('rc=1')
    expect(deploys('l-restart-1')).toHaveLength(1)
    const why = `its deploy failed after the new server was started, so it is not tried again. Roll back to the previous commit ${sha.C1.slice(0, 7)} as in docs/SERVER.md "Roll back", restoring ${dump1} (the dump taken before its migrations)`
    expect(outOf(first)).toContain('failed after the restart (try 1 of 3')
    expect(outOf(first)).toContain(why)
    expect(first).toContain(`state: skip_sha=${sha.C2}@7`)
    expect(first).toContain(`state: skip_failed=${sha.C2}@7`)
    // The next run deploys nothing, repeats the way back as its last line, and keeps the unit failed.
    const second = get('l-restart-2')
    expect(second).toContain('rc=1')
    expect(deploys('l-restart-2')).toEqual([])
    expect(callsOf(second)).toEqual(['curl releases/latest if-none-match="r-v2"'])
    const lines = outOf(second).split('\n')
    expect(lines[lines.length - 1]).toContain(why)
    // Paused for the rollback: nothing is asked, and the way back stays the last line.
    const paused = get('l-restart-3')
    expect(paused).toContain('rc=0')
    expect(callsOf(paused)).toEqual([])
    const pausedLines = outOf(paused).split('\n')
    expect(pausedLines[0]).toMatch(/paused \(\S+autodeploy\.paused exists\)/)
    expect(pausedLines[pausedLines.length - 1]).toContain(`release v2 (${sha.C2.slice(0, 7)}) is not deployed: ${why}`)
    // Paused with nothing failed, only the pause line.
    expect(outOf(get('l-sudo-yes')).split('\n')).toHaveLength(1)
    // Staging (demo data) still retries after a failure after its restart.
    expect(deploys('s-restart-2')).toHaveLength(1)
    expect(outOf(get('s-restart-2'))).toContain('try 2 of 3')
    expect(outOf(get('s-restart-1'))).not.toContain('may be half built')
    expect(get('s-restart-1')).not.toContain('state: skip_sha=')
  })

  it('live: counts what a run stopped in the middle of a deploy left in its report', () => {
    const dump1 = '/var/backups/first-twenty/first-twenty-20261027-120000Z.dump'
    // Stopped after the restart: not tried again, the way back with the dump logged instead.
    const after = get('l-stopped')
    expect(after).toContain('rc=1')
    expect(deploys('l-stopped')).toEqual([])
    expect(outOf(after)).toContain(
      `its deploy was stopped after the new server was started, so it is not tried again. Roll back to the previous commit ${sha.C1.slice(0, 7)} as in docs/SERVER.md "Roll back", restoring ${dump1}`,
    )
    expect(after).toContain(`state: skip_sha=${sha.C2}@7`)
    // Stopped before the restart: tried again, with the dump it took.
    expect(callsOf(get('l-stopped-early'))).toContain(`prior: ${dump1}`)
    expect(get('l-stopped-early')).toContain(`state: predump=${sha.C2}:${dump1}`)
    expect(outOf(get('l-stopped-early'))).toContain('try 1 of 3')
  })

  it('asks sudo once per run whether a pause file it cannot see exists, and deploys nothing when it cannot ask', () => {
    for (const name of ['l-sudo-yes', 'l-sudo-no', 'l-sudo-none']) {
      const sudo = callsOf(get(name)).filter((c) => c.startsWith('sudo '))
      expect(sudo, name).toHaveLength(1)
      expect(sudo[0], name).toMatch(/^sudo -n sh -c test -e "\$1" && echo yes \|\| echo no sh \S+\/closed\/autodeploy\.paused$/)
    }
    expect(get('l-sudo-yes')).toContain('rc=0')
    expect(outOf(get('l-sudo-yes'))).toMatch(/paused \(\S+autodeploy\.paused exists\)/)
    expect(curls('l-sudo-yes')).toEqual([])
    expect(get('l-sudo-no')).toContain('rc=0')
    expect(curls('l-sudo-no')).toEqual(['curl releases/latest'])
    expect(get('l-sudo-none')).toContain('rc=1')
    expect(outOf(get('l-sudo-none'))).toContain('cannot tell whether')
    expect(curls('l-sudo-none')).toEqual([])
    // A pause folder it can read needs no sudo at all.
    expect(callsOf(get('l-back-1')).filter((c) => c.startsWith('sudo '))).toEqual([])
  })
})

describe.skipIf(!BASH || !hasGit)('auto-update.sh and what deploy.sh reported', () => {
  let runs: Record<string, string> = {}
  const sha: Record<string, string> = {}
  const dump1 = '/var/backups/first-twenty/first-twenty-20261027-120000Z.dump'
  const dump2 = '/var/backups/first-twenty/first-twenty-20261027-123000Z.dump'
  beforeAll(() => {
    // A spawn of its own, like the block above.
    const r = bash(`${prelude}${autoUpdateHarness}
DUMP1=${dump1}
DUMP2=${dump2}
# Try 1 took a dump, then its migration failed with nothing applied, and the folder was put back: its dump
# is not the one to restore. Try 2 migrates, restarts and is not healthy: its own dump is.
newcase l-noapply "$C1"; deployed l-noapply "$C1"
release l-noapply v2 unique-name27 false false; fx l-noapply commits/v2 200 '"t2"' "$C2"; checks l-noapply "$C2" completed '"success"'
au l-noapply-1 l-noapply live "FAKE_DEPLOY=restored FAKE_DUMP=$DUMP1"
au l-noapply-2 l-noapply live "FAKE_DEPLOY=after-restart FAKE_DUMP=$DUMP2 FAKE_MIGRATED=1"

# An earlier try's dump is on record, but deploy.sh's way back names this try's own dump: the log follows it.
newcase l-own "$C1"; deployed l-own "$C1"
release l-own v2 unique-name27 false false; fx l-own commits/v2 200 '"t2"' "$C2"; checks l-own "$C2" completed '"success"'
echo "predump=$C2:$DUMP1" >> "$work/cases/l-own/state/state"
au l-own l-own live "FAKE_DEPLOY=after-restart FAKE_DUMP=$DUMP2 FAKE_MIGRATED=1 FAKE_RESTORE=$DUMP2"

# A deploy.sh that says nothing (a commit from before the report): not retried on live; staging retries.
newcase l-silent "$C1"; deployed l-silent "$C1"
release l-silent v2 unique-name27 false false; fx l-silent commits/v2 200 '"t2"' "$C2"; checks l-silent "$C2" completed '"success"'
au l-silent-1 l-silent live 'FAKE_DEPLOY=silent'
au l-silent-2 l-silent live ''
newcase s-silent "$C1"; deployed s-silent "$C1"
fx s-silent commits/main 200 '"h2"' "$C2"; checks s-silent "$C2" completed '"success"'
au s-silent s-silent staging 'FAKE_DEPLOY=silent'

# Healthy, then deploy.sh failed in the clean-up: deployed.
newcase l-fin "$C1"; deployed l-fin "$C1"
release l-fin v2 unique-name27 false false; fx l-fin commits/v2 200 '"t2"' "$C2"; checks l-fin "$C2" completed '"success"'
au l-fin l-fin live 'FAKE_DEPLOY=finished-fail'

# Runs stopped in the middle (TimeoutStartSec, systemctl stop) left their reports: after the new server
# reported healthy (deployed), and before deploy.sh said anything (not retried on live).
newcase l-left-fin "$C1"; deployed l-left-fin "$C1"
release l-left-fin v2 unique-name27 false false; fx l-left-fin commits/v2 200 '"t2"' "$C2"; checks l-left-fin "$C2" completed '"success"'
echo "failed=$C2:1" >> "$work/cases/l-left-fin/state/state"
printf 'target=%s\\nphase=before-restart\\nphase=restarted\\nphase=finished\\n' "$C2" > "$work/cases/l-left-fin/state/deploy-report"
au l-left-fin l-left-fin live ''
newcase l-left-none "$C1"; deployed l-left-none "$C1"
release l-left-none v2 unique-name27 false false; fx l-left-none commits/v2 200 '"t2"' "$C2"; checks l-left-none "$C2" completed '"success"'
printf 'target=%s\\n' "$C2" > "$work/cases/l-left-none/state/deploy-report"
au l-left-none l-left-none live ''
`)
    expect(r.stderr).toBe('')
    runs = sections(r.stdout)
    for (const line of (runs.shas ?? '').split('\n')) {
      const m = /^(\w+)=([0-9a-f]{40})$/.exec(line)
      if (m) sha[m[1]] = m[2]
    }
    expect(Object.keys(sha).sort()).toEqual(['C1', 'C2', 'CSIDE'])
  }, LONG_MS)

  const get = (name: string) => {
    const s = runs[name]
    expect(s, name).toBeDefined()
    return s
  }
  const deploys = (name: string) => callsOf(get(name)).filter((c) => c.startsWith('deploy.sh '))

  it('live: keeps the dump of a try only when that try applied migrations, or may have', () => {
    const first = get('l-noapply-1')
    expect(first).toContain('rc=1')
    expect(first).not.toContain('state: predump=')
    const second = get('l-noapply-2')
    expect(callsOf(second).filter((c) => c.startsWith('prior: '))).toEqual([])
    expect(outOf(second)).toContain(`restoring ${dump2} (the dump taken before its migrations)`)
    expect(outOf(second)).not.toContain(dump1)
    // deploy.sh's choice of dump wins over the one on record.
    expect(callsOf(get('l-own'))).toContain(`prior: ${dump1}`)
    expect(outOf(get('l-own'))).toContain(`restoring ${dump2} (the dump taken before its migrations)`)
  })

  it('live: does not retry a deploy whose deploy.sh did not say how far it got, and says to check the server', () => {
    const first = get('l-silent-1')
    expect(first).toContain('rc=1')
    expect(deploys('l-silent-1')).toHaveLength(1)
    const out = outOf(first)
    expect(out).toContain('deploy.sh did not say how far its deploy got')
    expect(out).toContain('sudo systemctl status first-twenty')
    expect(out).toContain(`roll back to ${sha.C1.slice(0, 7)}`)
    expect(out).not.toContain('may be half built')
    expect(out).not.toContain('trying again')
    expect(first).toContain(`state: skip_failed=${sha.C2}@7`)
    const second = get('l-silent-2')
    expect(second).toContain('rc=1')
    expect(deploys('l-silent-2')).toEqual([])
    expect(outOf(second)).toContain('deploy.sh did not say how far its deploy got')
    // Staging (demo data) still tries again.
    expect(outOf(get('s-silent'))).toContain('trying again next run')
    // A run stopped before deploy.sh said anything counts the same.
    expect(get('l-left-none')).toContain('rc=1')
    expect(deploys('l-left-none')).toEqual([])
    expect(outOf(get('l-left-none'))).toContain('deploy.sh did not say how far its deploy got')
  })

  it('counts a deploy as done once the new server reported healthy, even when the run ended badly after that', () => {
    const fin = get('l-fin')
    expect(fin).toContain('rc=0')
    expect(fin).toContain(`state: deployed_sha=${sha.C2}`)
    expect(fin).not.toContain('state: skip_sha=')
    expect(outOf(fin)).toContain('after the new server of release v2')
    expect(outOf(fin)).toContain('counts as deployed')
    const left = get('l-left-fin')
    expect(left).toContain('rc=0')
    expect(deploys('l-left-fin')).toEqual([])
    expect(left).toContain(`state: deployed_sha=${sha.C2}`)
    expect(left).toContain('state: failed=\n')
    expect(outOf(left)).toContain('stopped after the new server reported healthy; recorded it as deployed')
  })
})

// ---------------------------------------------------------------------------------------------------
// deploy.sh --instance staging
// ---------------------------------------------------------------------------------------------------

/**
 * A scratch install for deploy.sh, as in deploy-kit.test.ts but for both instances: stub systemctl,
 * sudo (it logs every call, answers sudo -l from FAKE_SUDO_RULE and runs the rest), npm, curl and
 * journalctl. `run <name> "<VAR=value ...>" [deploy.sh options]` runs one deploy and prints its section.
 */
const deployStubs = `
app="$work/app"
mkdir -p "$app/server/deploy" "$app/dist-server" "$work/bin" "$work/runs"
cp "$DEPLOY/deploy.sh" "$DEPLOY/first-twenty.service" "$DEPLOY/first-twenty-staging.service" "$app/server/deploy/"
printf '#!/usr/bin/env bash\\nexec "$@"\\n' > "$app/server/deploy/with-env.sh"
echo '{"name":"first-twenty"}' > "$app/package.json"
: > "$app/dist-server/server.mjs"
: > "$app/first-twenty.html"
cat > "$work/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$CALLS"
case "$*" in
  'show -p LoadState --value '*) echo loaded ;;
  'show -p WorkingDirectory --value '*) echo "$FAKE_WORKDIR" ;;
  'start first-twenty-staging-migrate.service') [ "\${FAKE_MIGRATE:-ok}" = ok ] || exit 1 ;;
esac
exit 0
EOF
cat > "$work/bin/sudo" <<'EOF'
#!/usr/bin/env bash
echo "sudo $*" >> "$CALLS"
[ "$1" = -n ] && shift
if [ "$1" = -l ]; then [ "\${FAKE_SUDO_RULE:-ok}" = ok ]; exit; fi
exec "$@"
EOF
cat > "$work/bin/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $*" >> "$CALLS"
[ "$*" != 'run server:migrate -- --status' ] || echo 'Pending (0): none'
exit 0
EOF
cat > "$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do url=$a; done
echo "curl $url" >> "$CALLS"
[ "\${FAKE_HEALTH:-ok}" = fail ] && exit 7
echo '{"ok":true,"db":"up","version":"0.1.0"}'
EOF
cat > "$work/bin/id" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = -u ]; then echo 1000; exit 0; fi
exec /usr/bin/id "$@"
EOF
printf '#!/usr/bin/env bash\\necho "(recent server logs)"\\n' > "$work/bin/journalctl"
# flock fails with FAKE_FLOCK=held, as when another deploy holds the lock.
printf '#!/usr/bin/env bash\\n[ "\${FAKE_FLOCK:-}" != held ]\\n' > "$work/bin/flock"
for c in sleep cmp; do printf '#!/usr/bin/env bash\\nexit 0\\n' > "$work/bin/$c"; done
chmod +x "$work"/bin/* "$app/server/deploy/with-env.sh"
run() { # run <name> "<VAR=value ...>" [deploy.sh options]
  local name=$1 vars=$2 dir="$work/runs/$1" rc=0
  shift 2
  mkdir -p "$dir"
  : > "$dir/calls"
  printf 'PORT=8787\\n' > "$dir/env"
  env FAKE_WORKDIR="$app" CALLS="$dir/calls" PATH="$work/bin:$PATH" FIRST_TWENTY_ENV="$dir/env" TMPDIR="$dir" FT_STAGING_LOCK="$dir/staging.lock" \\
    HEALTH_WAIT_SECONDS=2 $vars bash "$app/server/deploy/deploy.sh" "$@" > "$dir/out" 2>&1 || rc=$?
  echo "--- $name"
  echo "rc=$rc"
  sed 's/^/out: /' "$dir/out"
  sed 's/^/call: /' "$dir/calls"
}
`

describe.skipIf(!BASH)('deploy.sh --instance staging', () => {
  let runs: Record<string, string> = {}
  beforeAll(() => {
    const r = bash(`${prelude}${deployStubs}
run staging 'FT_PUBLIC_ORIGIN=https://staging.test.example' --instance staging --no-pull
run staging-no-rule 'FAKE_SUDO_RULE=missing' --instance staging --no-pull
run staging-migrate-fails 'FAKE_MIGRATE=fail' --instance staging --no-pull
run staging-unhealthy 'FAKE_HEALTH=fail FT_PREVIOUS_COMMIT=0123456789abcdef0123456789abcdef01234567' --instance=staging --no-pull
run staging-port 'FT_PORT=9999' --instance staging --no-pull
run live-locked-by-caller 'FAKE_FLOCK=held FT_DEPLOY_LOCK_HELD=1 FAKE_HEALTH=fail FT_PREVIOUS_COMMIT=89abcdef0123456789abcdef0123456789abcdef' --no-pull
run live-locked 'FAKE_FLOCK=held' --no-pull
run bad-instance '' --instance demo
`)
    expect(r.stderr).toBe('')
    runs = sections(r.stdout)
  }, LONG_MS)

  const get = (name: string) => {
    const s = runs[name]
    expect(s, name).toBeDefined()
    return s
  }

  it('builds without install scripts, migrates and restarts through the two allowed sudo commands, and checks port 8788', () => {
    const s = get('staging')
    expect(s).toContain('rc=0')
    const calls = callsOf(s)
    const order = [
      'sudo -n -l systemctl restart first-twenty-staging.service',
      'npm ci --ignore-scripts --no-audit --no-fund',
      'npm run build:all',
      'sudo -n systemctl start first-twenty-staging-migrate.service',
      'sudo -n systemctl restart first-twenty-staging.service',
      'curl http://127.0.0.1:8788/api/health',
      'curl https://staging.test.example/api/health',
    ].map((c) => {
      const at = calls.indexOf(c)
      expect(at, c).toBeGreaterThan(-1)
      return at
    })
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // Only the two allowed commands (and the check that they are allowed) go through sudo.
    expect(calls.filter((c) => c.startsWith('sudo '))).toEqual([
      'sudo -n -l systemctl restart first-twenty-staging.service',
      'sudo -n systemctl start first-twenty-staging-migrate.service',
      'sudo -n systemctl restart first-twenty-staging.service',
    ])
    // The live service, the backup, with-env.sh and the settings file are never touched.
    expect(calls.filter((c) => /first-twenty-backup|server:migrate|restart first-twenty$/.test(c))).toEqual([])
    expect(calls).toContain('systemctl show -p WorkingDirectory --value first-twenty-staging')
    const out = outOf(s)
    expect(out).toContain('Deploying First Twenty staging in')
    expect(out).toContain('Reachable through Caddy at https://staging.test.example/api/health')
    expect(out).toContain('Deploy finished.')
  })

  it('stops before building when the sudo rule is missing, and before restarting when migrations fail', () => {
    const noRule = get('staging-no-rule')
    expect(noRule).toContain('rc=1')
    expect(callsOf(noRule).filter((c) => c.startsWith('npm '))).toEqual([])
    expect(outOf(noRule)).toContain('setup-auto-deploy.sh --staging-only')
    const migrate = get('staging-migrate-fails')
    expect(migrate).toContain('rc=1')
    expect(callsOf(migrate)).not.toContain('sudo -n systemctl restart first-twenty-staging.service')
    expect(outOf(migrate)).toContain('journalctl -u first-twenty-staging-migrate')
  })

  it('points at the staging log and the previous commit when the new server is unhealthy, without sudo journalctl', () => {
    const s = get('staging-unhealthy')
    expect(s).toContain('rc=1')
    expect(callsOf(s).filter((c) => c.startsWith('sudo journalctl'))).toEqual([])
    const out = outOf(s)
    expect(out).toContain('sudo journalctl -u first-twenty-staging -n 40')
    expect(out).toContain('git checkout --detach 0123456789ab && bash server/deploy/deploy.sh --instance staging --no-pull')
    expect(out).toContain('autodeploy.paused')
    expect(callsOf(get('staging-port'))).toContain('curl http://127.0.0.1:9999/api/health')
  })

  it('live: skips its own lock when the updater holds it, and rolls back to the commit the updater names', () => {
    const s = get('live-locked-by-caller')
    expect(s).toContain('rc=1')
    const calls = callsOf(s)
    expect(calls).toContain('sudo true')
    expect(calls).toContain('npm ci --no-audit --no-fund')
    expect(calls).toContain('systemctl restart first-twenty')
    expect(outOf(s)).toContain('git checkout 89abcdef0123 && bash server/deploy/deploy.sh --no-pull')
    expect(outOf(s)).not.toContain('Another deploy is already running')
    // Without FT_DEPLOY_LOCK_HELD, a held lock stops the deploy before anything runs.
    expect(get('live-locked')).toContain('rc=1')
    expect(outOf(get('live-locked'))).toContain('Another deploy is already running')
    expect(callsOf(get('live-locked')).filter((c) => /^(npm|sudo|curl) /.test(c))).toEqual([])
    expect(outOf(get('bad-instance'))).toContain('--instance must be live or staging')
    expect(get('bad-instance')).toContain('rc=1')
  })
})

// ---------------------------------------------------------------------------------------------------
// deploy.sh in a git checkout: putting the folder back, the way back, hints, waiting for the other channel
// ---------------------------------------------------------------------------------------------------

/**
 * A git checkout for deploy.sh with three commits: OLD (migration 001), NEW (adds 002) and NEWER (adds a
 * README only). Its build files (node_modules, dist-server, dist-single, first-twenty.html) say "old-...".
 * The stub npm behaves like the real commands where it matters here: npm ci removes everything in
 * node_modules before it installs (FAKE_CI=fail stops it halfway), the build empties dist-server and
 * dist-single and writes first-twenty.html in place, as copyFileSync does (FAKE_BUILD=fail stops it before
 * the server bundle; FAKE_BUILD=term sends deploy.sh SIGTERM, as systemctl stop does, and dies of it too),
 * and server:migrate applies 002 (FAKE_MIGRATE=fail fails after that; FAKE_PENDING=0 has nothing pending,
 * FAKE_PENDING=unknown prints no Pending line). The stub systemctl writes a dump for the backup service
 * and answers ActiveState "activating" for FAKE_ACTIVE, FAKE_ACTIVE_POLLS times.
 * `run <name> <commit> "<VAR=value ...>" [deploy.sh options]` deploys a fresh copy of the checkout at
 * <commit> and prints its section, with the report (report: lines), HEAD and the build files after the
 * run. With PREP=<function> set, that function gets the copy's folder first.
 */
const gitDeployHarness = `
REAL_GIT=$(command -v git)
mkdir -p "$work/bin" "$work/runs"
tpl="$work/template"
g() { "$REAL_GIT" -C "$1" -c advice.detachedHead=false "\${@:2}"; }
mkdir -p "$tpl/server/deploy" "$tpl/server/sql"
cp "$DEPLOY/deploy.sh" "$DEPLOY/first-twenty.service" "$tpl/server/deploy/"
printf '#!/usr/bin/env bash\\nexec "$@"\\n' > "$tpl/server/deploy/with-env.sh"
echo '{"name":"first-twenty"}' > "$tpl/package.json"
printf 'node_modules/\\ndist-server/\\ndist-single/\\nfirst-twenty.html\\n.deploy-prev/\\n' > "$tpl/.gitignore"
echo 'SELECT 1;' > "$tpl/server/sql/001_init.sql"
"$REAL_GIT" init -q "$tpl"
g "$tpl" config core.autocrlf false
g "$tpl" config user.name Test
g "$tpl" config user.email test@example.test
g "$tpl" add -A; g "$tpl" commit -qm old; OLD=$(g "$tpl" rev-parse HEAD)
echo 'SELECT 2;' > "$tpl/server/sql/002_next.sql"; g "$tpl" add -A; g "$tpl" commit -qm new; NEW=$(g "$tpl" rev-parse HEAD)
echo readme > "$tpl/README.md"; g "$tpl" add -A; g "$tpl" commit -qm newer; NEWER=$(g "$tpl" rev-parse HEAD)
g "$tpl" remote add origin "$work/nowhere"
mkdir -p "$tpl/node_modules/fastify" "$tpl/dist-server" "$tpl/dist-single"
echo old-module > "$tpl/node_modules/fastify/index.js"
echo old-bundle > "$tpl/dist-server/server.mjs"
echo old-single > "$tpl/dist-single/index.html"
echo old-app > "$tpl/first-twenty.html"
: > "$work/autodeploy-state"
echo "--- shas"
echo "OLD=$OLD"; echo "NEW=$NEW"; echo "NEWER=$NEWER"

cat > "$work/bin/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $*" >> "$CALLS"
case "$*" in
  'ci '*)
    rm -rf node_modules/*
    mkdir -p node_modules/partial
    [ "\${FAKE_CI:-ok}" = ok ] || { echo 'npm error network ECONNRESET' >&2; exit 1; }
    rm -rf node_modules/partial
    mkdir -p node_modules/fastify
    echo new-module > node_modules/fastify/index.js
    ;;
  'run build:all')
    rm -rf dist-server/* dist-single/*
    mkdir -p dist-server dist-single
    echo new-single > dist-single/index.html
    echo new-app > first-twenty.html
    if [ "\${FAKE_BUILD:-ok}" = term ]; then kill -TERM "$PPID"; command -p sleep 1; exit 143; fi
    [ "\${FAKE_BUILD:-ok}" = ok ] || { echo 'error during build' >&2; exit 1; }
    echo new-bundle > dist-server/server.mjs
    ;;
  'run server:migrate -- --status')
    echo 'Applied (1): 001_init.sql'
    case "\${FAKE_PENDING:-1}" in
      0) echo 'Pending (0): none' ;;
      unknown) ;;
      *) echo 'Pending (1): 002_next.sql' ;;
    esac
    ;;
  'run server:migrate')
    [ "\${FAKE_PENDING:-1}" = 0 ] || echo 'Applied 002_next.sql'
    [ "\${FAKE_MIGRATE:-ok}" = ok ] || { echo 'Migration failed: check constraint violated' >&2; exit 1; }
    ;;
esac
exit 0
EOF
cat > "$work/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$CALLS"
case "$*" in
  'show -p LoadState --value '*) echo loaded ;;
  'show -p WorkingDirectory --value '*) echo "$FAKE_WORKDIR" ;;
  'show -p ActiveState --value '*)
    if [ "$5" = "\${FAKE_ACTIVE:-}" ]; then
      n=$(cat "$FAKE_ACTIVE_COUNT" 2>/dev/null || echo 0)
      if [ "$n" -lt "\${FAKE_ACTIVE_POLLS:-1000}" ]; then echo $((n + 1)) > "$FAKE_ACTIVE_COUNT"; echo activating; exit 0; fi
    fi
    echo inactive
    ;;
  'start first-twenty-backup') : > "$FAKE_BACKUP_DIR/first-twenty-20261027-120000Z.dump" ;;
esac
exit 0
EOF
cat > "$work/bin/sudo" <<'EOF'
#!/usr/bin/env bash
echo "sudo $*" >> "$CALLS"
[ "$1" = -n ] && shift
[ "$1" = -l ] && exit 0
exec "$@"
EOF
cat > "$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
[ "\${FAKE_HEALTH:-ok}" = fail ] && exit 7
echo '{"ok":true,"db":"up","version":"0.1.0"}'
EOF
cat > "$work/bin/id" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = -u ]; then echo 1000; exit 0; fi
exec /usr/bin/id "$@"
EOF
printf '#!/usr/bin/env bash\\necho "sleep $*" >> "$CALLS"\\n' > "$work/bin/sleep"
printf '#!/usr/bin/env bash\\necho "(recent server logs)"\\n' > "$work/bin/journalctl"
for c in flock cmp; do printf '#!/usr/bin/env bash\\nexit 0\\n' > "$work/bin/$c"; done
chmod +x "$work"/bin/* "$tpl/server/deploy/with-env.sh"

run() { # run <name> <commit> "<VAR=value ...>" [deploy.sh options]
  local name=$1 commit=$2 vars=$3 dir="$work/runs/$1" app="$work/runs/$1/app" rc=0 f
  shift 3
  mkdir -p "$dir/backups"
  cp -R "$tpl" "$app"
  g "$app" checkout -q --detach "$commit"
  [ -z "\${PREP:-}" ] || "$PREP" "$app"
  printf 'PORT=8787\\nBACKUP_DIR=%s\\n' "$dir/backups" > "$dir/env"
  : > "$dir/calls"
  (cd "$app" && env FAKE_WORKDIR="$app" CALLS="$dir/calls" FAKE_BACKUP_DIR="$dir/backups" FAKE_ACTIVE_COUNT="$dir/active-count" \\
    PATH="$work/bin:$PATH" FIRST_TWENTY_ENV="$dir/env" TMPDIR="$dir" HEALTH_WAIT_SECONDS=1 FT_DEPLOY_REPORT="$dir/report" \\
    $vars bash server/deploy/deploy.sh "$@") > "$dir/out" 2>&1 || rc=$?
  echo "--- $name"
  echo "rc=$rc"
  sed 's/^/out: /' "$dir/out"
  sed 's/^/call: /' "$dir/calls"
  sed 's/^/report: /' "$dir/report" 2>/dev/null || true
  echo "head=$(g "$app" rev-parse HEAD)"
  for f in node_modules/fastify/index.js dist-server/server.mjs dist-single/index.html first-twenty.html; do
    echo "file: $f=$(cat "$app/$f" 2>/dev/null || echo missing)"
  done
  [ ! -e "$app/node_modules/partial" ] || echo "partial=left"
  [ ! -e "$app/.deploy-prev" ] || echo "prev=left"
}
`

describe.skipIf(!BASH || !hasGit)('deploy.sh in a git checkout', () => {
  let runs: Record<string, string> = {}
  const sha: Record<string, string> = {}
  beforeAll(() => {
    const r = bash(`${prelude}${gitDeployHarness}
U="FT_DEPLOY_LOCK_HELD=1 FT_PREVIOUS_COMMIT=$OLD"
run a-ci "$NEW" "$U FAKE_CI=fail" --no-pull
run a-build "$NEW" "$U FAKE_BUILD=fail" --no-pull
run a-migrate "$NEW" "$U FAKE_MIGRATE=fail" --no-pull
run a-ok "$NEW" "$U" --no-pull
run b-added "$NEW" "$U FAKE_PENDING=0 FAKE_HEALTH=fail" --no-pull
run b-prior "$NEW" "$U FAKE_PENDING=0 FAKE_HEALTH=fail FT_PRIOR_BACKUP=/var/backups/first-twenty/first-twenty-20261020-010000Z.dump" --no-pull
run b-none "$NEWER" "FT_DEPLOY_LOCK_HELD=1 FT_PREVIOUS_COMMIT=$NEW FAKE_PENDING=0 FAKE_HEALTH=fail" --no-pull
run d-auto "$NEWER" "FT_DEPLOY_LOCK_HELD=1 FT_PREVIOUS_COMMIT=$NEW FAKE_PENDING=0 FAKE_HEALTH=fail FT_AUTODEPLOY_STATE=$work/autodeploy-state" --no-pull
run d-pull "$NEWER" "FT_AUTODEPLOY_STATE=$work/autodeploy-state"
run k-wait "$NEWER" "FAKE_ACTIVE=first-twenty-autoupdate-staging.service FAKE_ACTIVE_POLLS=2 FAKE_PENDING=0" --no-pull
run k-limit "$NEWER" "FAKE_ACTIVE=first-twenty-autoupdate-staging.service FT_OTHER_WAIT_SECONDS=15 FAKE_PENDING=0" --no-pull
${['manual_deploy_steps'].map((n) => shellFunction(deploy, n)).join('\n')}
echo "--- staging-steps"
INSTANCE=staging PAUSE_FILE=/etc/first-twenty-staging/autodeploy.paused manual_deploy_steps abc1234; echo
`)
    expect(r.stderr).toBe('')
    runs = sections(r.stdout)
    for (const line of (runs.shas ?? '').split('\n')) {
      const m = /^(\w+)=([0-9a-f]{40})$/.exec(line)
      if (m) sha[m[1]] = m[2]
    }
    expect(Object.keys(sha).sort()).toEqual(['NEW', 'NEWER', 'OLD'])
  }, LONG_MS)

  const get = (name: string) => {
    const s = runs[name]
    expect(s, name).toBeDefined()
    return s
  }
  const reportOf = (name: string) => linesOf(get(name), 'report: ')
  const oldBuild = ['node_modules/fastify/index.js=old-module', 'dist-server/server.mjs=old-bundle', 'dist-single/index.html=old-single', 'first-twenty.html=old-app']

  it('puts the build and the previous commit back when npm ci, the build or a migration fails before the restart', () => {
    for (const name of ['a-ci', 'a-build', 'a-migrate']) {
      const s = get(name)
      expect(s, name).toContain('rc=1')
      // Nothing was restarted, and the folder is as the running server left it.
      expect(callsOf(s).filter((c) => /restart/.test(c)), name).toEqual([])
      expect(s, name).toContain(`head=${sha.OLD}`)
      for (const file of oldBuild) expect(s, `${name}: ${file}`).toContain(`file: ${file}\n`)
      expect(s, name).not.toContain('partial=left')
      expect(s, name).not.toContain('prev=left')
      expect(reportOf(name), name).toContain('phase=before-restart')
      expect(reportOf(name), name).toContain('restored=1')
      expect(reportOf(name), name).not.toContain('phase=restarted')
      expect(outOf(s), name).toContain('Nothing was restarted: the server still runs the version it already loaded, and ')
      expect(outOf(s), name).toContain(`is back at ${sha.OLD.slice(0, 12)} with the build it had.`)
    }
    expect(outOf(get('a-ci'))).not.toContain('Migrations applied')
    // A failed migration: the ones applied before it stay, named with the backup from just before them.
    const migrate = get('a-migrate')
    expect(outOf(migrate)).toMatch(/Migrations applied in this run stay applied: 002_next\.sql\. The backup from just before them is \S+\/first-twenty-20261027-120000Z\.dump \(docs\/SERVER\.md, "Restore a backup"\)\./)
    expect(reportOf('a-migrate').filter((l) => l.startsWith('dump='))).toHaveLength(1)
    expect(reportOf('a-migrate').find((l) => l.startsWith('dump='))).toMatch(/\/first-twenty-20261027-120000Z\.dump$/)
    // The updater learns which migrations stayed applied, so it keeps that dump for the next try.
    expect(reportOf('a-migrate')).toContain('applied=002_next.sql')
    expect(reportOf('a-ci').filter((l) => l.startsWith('applied='))).toEqual([])
  })

  it('keeps the new build, and removes the copy of the old one, after a deploy that finished', () => {
    const s = get('a-ok')
    expect(s).toContain('rc=0')
    expect(s).toContain(`head=${sha.NEW}`)
    for (const file of ['node_modules/fastify/index.js=new-module', 'dist-server/server.mjs=new-bundle', 'first-twenty.html=new-app']) {
      expect(s, file).toContain(`file: ${file}\n`)
    }
    expect(s).not.toContain('prev=left')
    expect(reportOf('a-ok')).toEqual(['phase=before-restart', expect.stringMatching(/^dump=\S+\.dump$/), 'migrated=1', 'phase=restarted', 'phase=finished'])
    expect(outOf(s)).toContain('Deploy finished.')
  })

  it('never says the database needs no restore when the commit adds migrations that the previous one lacks', () => {
    const added = outOf(get('b-added'))
    expect(get('b-added')).toContain('rc=1')
    expect(added).not.toContain('needs no restore')
    expect(added).toContain(`This commit adds migrations that ${sha.OLD.slice(0, 12)} does not have (002_next.sql)`)
    expect(added).toContain("sudo journalctl -u first-twenty-autoupdate-live --since -7d | grep 'Backed up to'")
    expect(added).toContain('sudo install -m 600 -o postgres -g postgres <the dump taken before the first try> /var/tmp/ft-restore.dump')
    // After the restart nothing is put back: the new code runs, and the old build waits for the next deploy.
    expect(get('b-added')).toContain(`head=${sha.NEW}`)
    expect(get('b-added')).toContain('prev=left')
    expect(reportOf('b-added')).toEqual(['phase=before-restart', 'phase=restarted'])
    // With the dump from an earlier try, the restore names it, in the documented order.
    const prior = outOf(get('b-prior'))
    expect(prior).not.toContain('needs no restore')
    expect(prior).toContain('sudo install -m 600 -o postgres -g postgres /var/backups/first-twenty/first-twenty-20261020-010000Z.dump /var/tmp/ft-restore.dump')
    const order = ['systemctl stop first-twenty', `git checkout ${sha.OLD.slice(0, 12)}`, 'postgres-setup.sql', '--role=first_twenty_owner', 'with-env.sh npm run server:after-restore', 'systemctl start first-twenty'].map((needle) => {
      const at = prior.indexOf(needle, prior.indexOf('ERROR:'))
      expect(at, needle).toBeGreaterThan(-1)
      return at
    })
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // A commit that adds no migration file still needs no restore.
    const none = outOf(get('b-none'))
    expect(none).toContain('No migrations ran in this deploy, so the database needs no restore.')
    expect(none).toContain(`git checkout ${sha.NEW.slice(0, 12)} && bash server/deploy/deploy.sh --no-pull`)
  })

  it('gives the steps for a deploy by hand, never git switch, where first-twenty-autoupdate deploys the folder', () => {
    const auto = outOf(get('d-auto'))
    expect(auto).toContain(
      `To go back: sudo touch /etc/first-twenty/autodeploy.paused, then: git checkout --detach ${sha.NEW.slice(0, 12)} && bash server/deploy/deploy.sh --no-pull && first-twenty-autoupdate live --record-deployed`,
    )
    expect(auto).not.toContain('git switch')
    // A plain deploy (git pull) on the detached checkout stops before building, with the same steps.
    const pull = get('d-pull')
    expect(pull).toContain('rc=1')
    expect(outOf(pull)).toContain('This folder is deployed automatically from GitHub')
    expect(outOf(pull)).toContain(
      'git fetch origin, then sudo touch /etc/first-twenty/autodeploy.paused, then: git checkout --detach <commit> && bash server/deploy/deploy.sh --no-pull && first-twenty-autoupdate live --record-deployed',
    )
    expect(outOf(pull)).not.toContain('git switch')
    expect(callsOf(pull).filter((c) => c.startsWith('npm '))).toEqual([])
    expect(pull).toContain(`head=${sha.NEWER}`)
    expect(runs['staging-steps'].trim()).toBe(
      'sudo touch /etc/first-twenty-staging/autodeploy.paused, then as the first-twenty-staging user: git checkout --detach abc1234 && bash server/deploy/deploy.sh --instance staging --no-pull && first-twenty-autoupdate staging --record-deployed',
    )
    // Without automatic deploys, the way back still ends with git switch.
    expect(outOf(get('b-none'))).toContain('git switch main')
  })

  it('started by hand, waits while the other channel builds, and builds anyway after the limit', () => {
    const wait = get('k-wait')
    expect(wait).toContain('rc=0')
    const calls = callsOf(wait)
    expect(calls.filter((c) => c === 'sleep 15')).toHaveLength(2)
    expect(calls.lastIndexOf('sleep 15')).toBeLessThan(calls.findIndex((c) => c.startsWith('npm ci')))
    expect(outOf(wait)).toContain('Waiting for first-twenty-autoupdate-staging to finish first (one build at a time)')
    const limit = get('k-limit')
    expect(limit).toContain('rc=0')
    expect(callsOf(limit).filter((c) => c === 'sleep 15')).toHaveLength(1)
    expect(outOf(limit)).toContain('WARNING: first-twenty-autoupdate-staging is still running after 15 seconds; building anyway.')
    // Run by the updater (FT_DEPLOY_LOCK_HELD=1), it never asks: the updater already waited.
    expect(callsOf(get('a-ok')).filter((c) => c.includes('ActiveState'))).toEqual([])
  })
})

describe.skipIf(!BASH || !hasGit)('deploy.sh stopped halfway, a copy left behind, and the dump it names', () => {
  let runs: Record<string, string> = {}
  const sha: Record<string, string> = {}
  const prior = '/var/backups/first-twenty/first-twenty-20261020-010000Z.dump'
  beforeAll(() => {
    // A spawn of its own: each run takes seconds in Git Bash, and one spawn gets LONG_MS.
    const r = bash(`${prelude}${gitDeployHarness}
U="FT_DEPLOY_LOCK_HELD=1 FT_PREVIOUS_COMMIT=$OLD"
# A deploy killed during npm ci: the build the server runs in .deploy-prev with .pending, half a build in
# place, HEAD at the new commit.
leftover() {
  mkdir "$1/.deploy-prev"
  mv "$1/node_modules" "$1/dist-server" "$1/dist-single" "$1/.deploy-prev/"
  cp -p "$1/first-twenty.html" "$1/.deploy-prev/"
  printf 'commit=%s\\nkept=node_modules\\nkept=dist-server\\nkept=dist-single\\nkept=first-twenty.html\\n' "\${OLD:0:12}" > "$1/.deploy-prev/.pending"
  mkdir -p "$1/node_modules/partial" "$1/dist-server"
  echo half-app > "$1/first-twenty.html"
}
# The same, after a put-back that stopped halfway: dist-server is back in place, gone from the copy.
halfway() {
  leftover "$1"
  rm -rf "$1/dist-server"
  mv "$1/.deploy-prev/dist-server" "$1/dist-server"
}
# A copy left after a restart (no .pending): out of date.
stale() {
  mkdir -p "$1/.deploy-prev/node_modules/fastify"
  echo stale-module > "$1/.deploy-prev/node_modules/fastify/index.js"
}
# Stopped (SIGTERM) while the build runs: the step before it left $? at 0.
run t-term "$NEW" "$U FAKE_BUILD=term" --no-pull
PREP=leftover run p-left "$NEW" "$U FAKE_CI=fail" --no-pull
PREP=leftover run p-left-ok "$NEW" "$U" --no-pull
PREP=halfway run p-halfway "$NEW" "$U" --no-pull
PREP=stale run p-stale "$NEW" "$U FAKE_CI=fail" --no-pull
# A rollback by hand with --no-pull: the build in place came from an earlier deploy, not from this commit.
run m-hand "$NEWER" "FT_DEPLOY_LOCK_HELD=1 FAKE_CI=fail" --no-pull
# An earlier try's dump, and this run's own: as many migrations pending as the commit adds, so this run's
# dump is the one to restore; with the count unknown, the earlier one.
run b-prior-own "$NEW" "$U FAKE_HEALTH=fail FT_PRIOR_BACKUP=${prior}" --no-pull
run b-prior-unknown "$NEW" "$U FAKE_PENDING=unknown FAKE_HEALTH=fail FT_PRIOR_BACKUP=${prior}" --no-pull
${['earlier_try_migrated'].map((n) => shellFunction(deploy, n)).join('\n')}
echo "--- earlier"
for c in 'true|1|002_next.sql' 'true|1|002_next.sql 003_more.sql' 'true|0|002_next.sql' 'true||002_next.sql' 'false|1|002_next.sql' 'true|1|README.md'; do
  IFS='|' read -r ok PENDING added <<<"$c"
  if earlier_try_migrated "$ok" "$added"; then echo "$c=yes"; else echo "$c=no"; fi
done
`)
    expect(r.stderr).toBe('')
    runs = sections(r.stdout)
    for (const line of (runs.shas ?? '').split('\n')) {
      const m = /^(\w+)=([0-9a-f]{40})$/.exec(line)
      if (m) sha[m[1]] = m[2]
    }
    expect(Object.keys(sha).sort()).toEqual(['NEW', 'NEWER', 'OLD'])
  }, LONG_MS)

  const get = (name: string) => {
    const s = runs[name]
    expect(s, name).toBeDefined()
    return s
  }
  const reportOf = (name: string) => linesOf(get(name), 'report: ')
  const oldBuild = ['node_modules/fastify/index.js=old-module', 'dist-server/server.mjs=old-bundle', 'dist-single/index.html=old-single', 'first-twenty.html=old-app']

  it('puts the build and the commit back when it is stopped while a step runs', () => {
    const s = get('t-term')
    // 143: ended by SIGTERM, after the build step it interrupted had ended.
    expect(s).toContain('rc=143')
    expect(callsOf(s).filter((c) => /restart/.test(c))).toEqual([])
    expect(s).toContain(`head=${sha.OLD}`)
    for (const file of oldBuild) expect(s, file).toContain(`file: ${file}\n`)
    expect(s).not.toContain('prev=left')
    expect(reportOf('t-term')).toEqual(['phase=before-restart', 'restored=1'])
    expect(outOf(s)).toContain(`is back at ${sha.OLD.slice(0, 12)} with the build it had.`)
  })

  it('keeps the build a killed deploy left in .deploy-prev, and puts it back when it fails too', () => {
    const s = get('p-left')
    expect(s).toContain('rc=1')
    expect(outOf(s)).toContain('Kept the build the server runs, which a deploy that stopped before its restart left in')
    expect(s).toContain(`head=${sha.OLD}`)
    for (const file of oldBuild) expect(s, file).toContain(`file: ${file}\n`)
    expect(s).not.toContain('partial=left')
    expect(s).not.toContain('prev=left')
    expect(reportOf('p-left')).toContain('restored=1')
    // A deploy that finishes builds over the half-made tree and removes the copy.
    const ok = get('p-left-ok')
    expect(ok).toContain('rc=0')
    expect(ok).toContain('file: dist-server/server.mjs=new-bundle\n')
    expect(ok).not.toContain('prev=left')
    // A copy without .pending was left after a restart: replaced by a fresh copy of the build in place.
    const stale = get('p-stale')
    expect(stale).toContain('rc=1')
    expect(outOf(stale)).toContain('Kept the current build in')
    for (const file of oldBuild) expect(stale, file).toContain(`file: ${file}\n`)
  })

  it('changes nothing when part of the copy a killed deploy left is gone, and says how to put it back', () => {
    const s = get('p-halfway')
    expect(s).toContain('rc=1')
    expect(callsOf(s).filter((c) => c.startsWith('npm '))).toEqual([])
    const out = outOf(s)
    expect(out).toContain('part of it (dist-server) is not there any more, so nothing was changed')
    expect(out).toContain(`check out ${sha.OLD.slice(0, 12)}`)
    // What is in place stays: dist-server put back by hand, the rest still in the copy.
    expect(s).toContain('file: dist-server/server.mjs=old-bundle\n')
    expect(s).toContain('file: first-twenty.html=half-app\n')
    expect(s).toContain('prev=left')
    expect(reportOf('p-halfway')).not.toContain('restored=1')
  })

  it('does not say a rollback by hand is back at a commit its build did not come from', () => {
    const out = outOf(get('m-hand'))
    expect(get('m-hand')).toContain('rc=1')
    expect(out).toContain(`It came from an earlier deploy and may not be built from the code checked out now (${sha.NEWER.slice(0, 7)})`)
    expect(out).not.toContain('with the build it had')
    expect(get('m-hand')).toContain('file: node_modules/fastify/index.js=old-module\n')
  })

  it("names this run's dump unless an earlier try applied some of the commit's migrations", () => {
    const own = get('b-prior-own')
    expect(own).toContain('rc=1')
    const ownOut = outOf(own)
    expect(ownOut).toMatch(/sudo install -m 600 -o postgres -g postgres \S+\/first-twenty-20261027-120000Z\.dump \/var\/tmp\/ft-restore\.dump/)
    expect(ownOut).toContain(`An earlier try of this commit took ${prior}, but none of its migrations were applied before this run`)
    expect(reportOf('b-prior-own').find((l) => l.startsWith('restore_dump='))).toMatch(/\/first-twenty-20261027-120000Z\.dump$/)
    const unknown = outOf(get('b-prior-unknown'))
    expect(unknown).toContain(`sudo install -m 600 -o postgres -g postgres ${prior} /var/tmp/ft-restore.dump`)
    expect(unknown).toContain(`(${prior} was taken before an earlier try of this commit ran its migrations, so it is the dump to restore.)`)
    expect(reportOf('b-prior-unknown')).toContain(`restore_dump=${prior}`)
    expect(runs.earlier.trim().split('\n')).toEqual([
      'true|1|002_next.sql=no',
      'true|1|002_next.sql 003_more.sql=yes',
      'true|0|002_next.sql=yes',
      'true||002_next.sql=yes',
      'false|1|002_next.sql=yes',
      'true|1|README.md=no',
    ])
  })
})

// ---------------------------------------------------------------------------------------------------
// setup-auto-deploy.sh: Caddy's admin API and the staging site
// ---------------------------------------------------------------------------------------------------

/**
 * setup_caddy run for real against a scratch /etc/caddy, with stub caddy, systemctl, curl, runuser,
 * install and stat. "$work/<case>/admin-open" stands for Caddy's admin API listening on 127.0.0.1:2019:
 * while it exists, systemctl reload fails (the new Caddyfile names the socket, where nothing listens yet)
 * and caddy reload --address localhost:2019 closes it, unless FAKE_RELOAD=fail or FAKE_STAYS_OPEN=1.
 */
const caddyHarness = `
mkdir -p "$work/bin"
cat > "$work/bin/caddy" <<'EOF'
#!/usr/bin/env bash
echo "caddy $*" >> "$CALLS"
case "$1" in
  version) echo "v\${FAKE_CADDY_VERSION:-2.11.4} h1:test=" ;;
  validate) exit "\${FAKE_VALIDATE:-0}" ;;
  reload)
    [ "\${FAKE_RELOAD:-ok}" = ok ] || exit 1
    [ -n "\${FAKE_STAYS_OPEN:-}" ] || rm -f "$CASE/admin-open"
    ;;
esac
exit 0
EOF
cat > "$work/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$CALLS"
if [ "$*" = 'reload caddy' ] && [ -f "$CASE/admin-open" ]; then echo "Job for caddy.service failed" >&2; exit 1; fi
exit 0
EOF
cat > "$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
[ -f "$CASE/admin-open" ]
EOF
cat > "$work/bin/runuser" <<'EOF'
#!/usr/bin/env bash
[ "$1" = -u ] && shift 2
[ "$1" = -- ] && shift
exec "$@"
EOF
printf '#!/usr/bin/env bash\\necho "install $*" >> "$CALLS"\\n' > "$work/bin/install"
printf '#!/usr/bin/env bash\\n[ "$1 $2" = "-c %%U" ] && { echo caddy; exit 0; }\\nexec /usr/bin/stat "$@"\\n' > "$work/bin/stat"
chmod +x "$work"/bin/*
cat > "$work/plain.caddyfile" <<'EOF'
# Managed by First Twenty setup-ec2.sh. Re-running the script rewrites this file.
{
	servers {
		protocols h1 h2
	}
}

hr.example.test {
	reverse_proxy 127.0.0.1:8787
}
EOF
printf 'hr.example.test {\\n\\treverse_proxy 127.0.0.1:8787\\n}\\n' > "$work/no-global.caddyfile"
printf '{\\n\\tadmin localhost:2019\\n}\\n\\nhr.example.test {\\n\\treverse_proxy 127.0.0.1:8787\\n}\\n' > "$work/own-admin.caddyfile"
# sc <case> <Caddyfile> <admin open: yes|no> "<VAR=value ...>": one run of setup_caddy, printed as a section.
sc() {
  local name=$1 dir="$work/$1" rc=0
  if [ ! -d "$dir" ]; then
    mkdir -p "$dir/etc/first-twenty.d" "$dir/caddyhome"
    cp "$work/$2" "$dir/etc/Caddyfile"
    cp "$work/$2" "$dir/before"
  fi
  if [ "$3" = yes ]; then : > "$dir/admin-open"; else rm -f "$dir/admin-open"; fi
  : > "$dir/calls"
  (
    export CALLS="$dir/calls" CASE="$dir" PATH="$work/bin:$PATH"
    for v in $4; do export "$v"; done
    DRY_RUN=false SCRIPT_DIR="$DEPLOY" STAGING_DOMAIN=staging.test.example STAGING_PORT=8788
    CADDY_MAIN="$dir/etc/Caddyfile" CADDY_DIR="$dir/etc/first-twenty.d" CADDY_SITE="$dir/etc/first-twenty.d/staging.caddy"
    CADDY_LOG="$dir/staging-access.log" IMPORT_LINE="import $dir/etc/first-twenty.d/*.caddy"
    CADDY_ADMIN_SOCKET=/var/lib/caddy/admin.sock CADDY_ADMIN_DIR="$dir/caddyhome" ADMIN_LINE="admin unix//var/lib/caddy/admin.sock"
    STAMP=\${STAMP:-20261027-000000}
    setup_caddy
  ) > "$dir/out" 2>&1 || rc=$?
  echo "--- $name\${LABEL:+-$LABEL}"
  echo "rc=$rc"
  sed 's/^/out: /' "$dir/out"
  sed 's/^/call: /' "$dir/calls"
  sed 's/^/main: /' "$dir/etc/Caddyfile"
  cmp -s "$dir/etc/Caddyfile" "$dir/before" && echo "main=unchanged"
  [ -f "$dir/etc/first-twenty.d/staging.caddy" ] && echo "site=written"
  ls -a "$dir/etc" | sed -n 's/^\\(Caddyfile\\.bak-.*\\|\\.first-twenty.*\\)$/file: \\1/p'
}
`

describe.skipIf(!BASH)("setup-auto-deploy.sh and Caddy's admin API", { timeout: LONG_MS }, () => {
  const fns = ['run', 'info', 'warn', 'die', 'render_caddy_site', 'caddy_admin_setting', 'caddy_with_admin', 'caddy_version_ok', 'caddy_admin_on_tcp', 'caddy_reload', 'setup_caddy']
    .map((n) => shellFunction(setup, n))
    .join('\n')

  it('finds the admin line only in the global options block, and adds it there (or a block for it)', () => {
    const r = bash(`${prelude}
${['caddy_admin_setting', 'caddy_with_admin'].map((n) => shellFunction(setup, n)).join('\n')}
ADMIN_LINE="admin unix//var/lib/caddy/admin.sock"
printf '# comment\\n\\n{\\n\\tservers {\\n\\t}\\n}\\nsite.test {\\n\\tadmin nonsense\\n}\\n' > "$work/a"
printf 'site.test {\\n\\trespond ok\\n}\\n' > "$work/b"
printf '{\\n\\temail ops@example.test\\n\\tadmin localhost:2019 {\\n\\t\\torigins localhost\\n\\t}\\n}\\n' > "$work/c"
echo "--- template"; caddy_admin_setting "$DEPLOY/Caddyfile"
echo "--- a-setting"; caddy_admin_setting "$work/a"
echo "--- a"; caddy_with_admin "$work/a"
echo "--- b"; caddy_with_admin "$work/b"
echo "--- c-setting"; caddy_admin_setting "$work/c"
`)
    expect(r.stderr).toBe('')
    const out = sections(r.stdout)
    // server/deploy/Caddyfile and setup-auto-deploy.sh write the same line.
    expect(out.template.trim()).toBe('admin unix//var/lib/caddy/admin.sock')
    expect(setup).toContain('CADDY_ADMIN_SOCKET=/var/lib/caddy/admin.sock\n')
    expect(setup).toContain('ADMIN_LINE="admin unix/$CADDY_ADMIN_SOCKET"')
    // An admin directive inside a site is not the global one.
    expect(out['a-setting'].trim()).toBe('')
    expect(out.a).toBe('# comment\n\n{\n\tadmin unix//var/lib/caddy/admin.sock\n\tservers {\n\t}\n}\nsite.test {\n\tadmin nonsense\n}\n')
    expect(out.b).toBe('{\n\tadmin unix//var/lib/caddy/admin.sock\n}\n\nsite.test {\n\trespond ok\n}\n')
    expect(out['c-setting'].trim()).toBe('admin localhost:2019 {')
  })

  let runs: Record<string, string> = {}
  beforeAll(() => {
    if (!BASH) return
    const r = bash(`${prelude}${caddyHarness}
${fns}
sc first plain.caddyfile yes ''
LABEL=again STAMP=20261027-000100 sc first plain.caddyfile no ''
sc reload-fails plain.caddyfile yes 'FAKE_RELOAD=fail'
sc stays-open plain.caddyfile yes 'FAKE_STAYS_OPEN=1'
sc invalid plain.caddyfile yes 'FAKE_VALIDATE=1'
sc own-admin own-admin.caddyfile yes ''
sc no-global no-global.caddyfile yes ''
sc old-caddy plain.caddyfile yes 'FAKE_CADDY_VERSION=2.6.2'
`)
    expect(r.stderr).toBe('')
    runs = sections(r.stdout)
  }, LONG_MS)

  const get = (name: string) => {
    const s = runs[name]
    expect(s, name).toBeDefined()
    return s
  }
  const mainOf = (s: string) => linesOf(s, 'main: ').join('\n')

  it('moves the admin API to its socket and adds the import, then reloads through localhost:2019 the first time', () => {
    const s = get('first')
    expect(s).toContain('rc=0')
    const main = mainOf(s)
    expect(main).toMatch(/^\{\n\tadmin unix\/\/var\/lib\/caddy\/admin\.sock\n\tservers \{$/m)
    expect(main.trimEnd().endsWith('/etc/first-twenty.d/*.caddy')).toBe(true)
    expect(s).toContain('site=written')
    expect(s).toContain('file: Caddyfile.bak-20261027-000000')
    expect(s).not.toContain('file: .first-twenty')
    const calls = callsOf(s)
    const validate = calls.findIndex((c) => c.startsWith('caddy validate --adapter caddyfile --config '))
    const reload = calls.indexOf('systemctl reload caddy')
    const viaTcp = calls.findIndex((c) => /^caddy reload --config \S+\/etc\/Caddyfile --adapter caddyfile --address localhost:2019$/.test(c))
    expect(validate).toBeGreaterThan(-1)
    expect(reload).toBeGreaterThan(validate)
    expect(viaTcp).toBeGreaterThan(reload)
    const out = outOf(s)
    expect(out).toContain("Moved Caddy's admin API to /var/lib/caddy/admin.sock")
    expect(out).toContain('its admin API is on /var/lib/caddy/admin.sock only')
  })

  it('changes nothing on a second run, and reloads the usual way', () => {
    const s = get('first-again')
    expect(s).toContain('rc=0')
    expect(outOf(s)).toContain('staging.caddy is up to date')
    expect(callsOf(s).filter((c) => c.startsWith('caddy reload'))).toEqual([])
    expect(callsOf(s)).toContain('systemctl reload caddy')
    expect(s).not.toContain('file: Caddyfile.bak-20261027-000100')
  })

  it('puts every file back when Caddy does not take the new configuration or it does not validate', () => {
    for (const name of ['reload-fails', 'invalid']) {
      const s = get(name)
      expect(s, name).toContain('rc=1')
      expect(s, name).toContain('main=unchanged')
      expect(s, name).not.toContain('site=written')
      expect(s, name).not.toContain('file: .first-twenty')
    }
    expect(outOf(get('reload-fails'))).toContain('the files were put back')
    expect(outOf(get('invalid'))).toContain('did not validate')
    expect(callsOf(get('invalid')).filter((c) => /reload/.test(c))).toEqual([])
  })

  it('stops before staging starts while the admin API still answers on 127.0.0.1:2019, or the Caddyfile sets another address', () => {
    expect(get('stays-open')).toContain('rc=1')
    expect(outOf(get('stays-open'))).toContain('still answers on 127.0.0.1:2019')
    const own = get('own-admin')
    expect(own).toContain('rc=1')
    expect(own).toContain('main=unchanged')
    expect(own).not.toContain('site=written')
    expect(outOf(own)).toContain('sets Caddy\'s admin API itself ("admin localhost:2019")')
    // A Caddyfile without global options gets a block for the admin line at the top.
    const noGlobal = get('no-global')
    expect(noGlobal).toContain('rc=0')
    expect(mainOf(noGlobal).startsWith('{\n\tadmin unix//var/lib/caddy/admin.sock\n}\n\nhr.example.test {')).toBe(true)
    // Caddy before 2.7 cannot be reloaded through the socket: nothing is changed.
    const old = get('old-caddy')
    expect(old).toContain('rc=1')
    expect(old).toContain('main=unchanged')
    expect(old).not.toContain('site=written')
    expect(outOf(old)).toContain('older than 2.7')
  })

  it('setup-ec2.sh leaves the admin line out for a Caddy older than 2.7, and reloads through localhost:2019 once', () => {
    const ec2 = read('server/deploy/setup-ec2.sh')
    expect(ec2).toContain(`[ "$(printf '%s\\n' 2.7.0 "$CADDY_NOW" | sort -V | head -n 1)" != 2.7.0 ]`)
    expect(ec2).toContain(`sed -i '/^[[:space:]]*admin unix\\/\\//d' "$NEW"`)
    expect(ec2).toContain('caddy reload --config "$CADDYFILE" --adapter caddyfile --address localhost:2019')
  })
})

// ---------------------------------------------------------------------------------------------------
// setup-auto-deploy.sh --dry-run
// ---------------------------------------------------------------------------------------------------

/**
 * Stubs for a dry run as root: id answers 0 and knows postgres, caddy and ubuntu but not the staging user;
 * psql answers the catalog query and SHOW hba_file; runuser runs the command as is; git logs and runs the
 * real git (so the live checkout's origin and HEAD come from a real repo). Every other command that could
 * change the instance only logs, so the test can check that none of them ran.
 */
const setupStubs = `
REAL_GIT=$(command -v git)
mkdir -p "$work/bin"
cat > "$work/bin/id" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  -u) echo 0 ;;
  '-u postgres') echo 26 ;;
  '-u caddy') echo 27 ;;
  '-u ubuntu') echo 1000 ;;
  '-gn ubuntu') echo ubuntu ;;
  -un) echo root ;;
  *) exit 1 ;;
esac
EOF
cat > "$work/bin/psql" <<'EOF'
#!/usr/bin/env bash
echo "psql $*" >> "$CALLS"
case "$*" in
  *'SHOW hba_file'*) echo "$FAKE_HBA" ;;
  *'SELECT EXISTS'*) echo 'f|f|f' ;;
  *) cat > /dev/null ;;
esac
EOF
cat > "$work/bin/runuser" <<'EOF'
#!/usr/bin/env bash
[ "$1" = -u ] && shift 2
[ "$1" = -- ] && shift
exec "$@"
EOF
cat > "$work/bin/git" <<EOF
#!/usr/bin/env bash
echo "git \\$*" >> "\\$CALLS"
exec "$REAL_GIT" "\\$@"
EOF
for c in caddy visudo useradd install chown chmod curl; do
  printf '#!/usr/bin/env bash\\necho "%s $*" >> "$CALLS"\\n' "$c" > "$work/bin/$c"
done
# As on an instance without staging: first-twenty-staging.service is not installed, and systemd does not
# name a slice (setup then uses the one systemd's naming rule gives).
cat > "$work/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$CALLS"
[ "$*" != 'show -p LoadState --value first-twenty-staging.service' ] || echo not-found
exit 0
EOF
# The caddy user's folder, for the admin socket.
printf '#!/usr/bin/env bash\\n[ "$1 $2" = "-c %%U" ] && { echo caddy; exit 0; }\\nexec /usr/bin/stat "$@"\\n' > "$work/bin/stat"
chmod +x "$work"/bin/*
# The live Caddyfile as an older setup-ec2.sh wrote it: global options without the admin line, no import.
mkdir -p "$work/caddyhome"
printf '{\\n\\tservers {\\n\\t\\tprotocols h1 h2\\n\\t}\\n}\\n\\nhr.example.test {\\n\\treverse_proxy 127.0.0.1:8787\\n}\\n' > "$work/Caddyfile"
cp "$work/Caddyfile" "$work/Caddyfile.before"
# The live checkout: a real repo with one commit and the private repo's SSH origin, holding the older
# kit (a Caddyfile template without the admin line).
mkdir -p "$work/live/server/deploy"
"$REAL_GIT" -C "$work/live" -c init.defaultBranch=main init -q
echo '{"name":"first-twenty"}' > "$work/live/package.json"
printf 'hr.example.com {\\n\\treverse_proxy 127.0.0.1:8787\\n}\\n' > "$work/live/server/deploy/Caddyfile"
"$REAL_GIT" -C "$work/live" -c core.autocrlf=false add package.json server/deploy/Caddyfile
"$REAL_GIT" -C "$work/live" -c user.name=Test -c user.email=test@example.test commit -q -m live
"$REAL_GIT" -C "$work/live" remote add origin git@github.com:example/first-twenty-private.git
LIVE_HEAD=$("$REAL_GIT" -C "$work/live" rev-parse HEAD)
# Where Ubuntu keeps it, so setup can tell the cluster's unit (postgresql@16-main.service).
mkdir -p "$work/etc/postgresql/16/main"
printf 'local all postgres peer\\n' > "$work/etc/postgresql/16/main/pg_hba.conf"
cp "$work/etc/postgresql/16/main/pg_hba.conf" "$work/pg_hba.before"
plan() { # plan <name> [options]
  local name=$1 rc=0
  shift
  : > "$work/calls"
  env CALLS="$work/calls" FAKE_HBA="$work/etc/postgresql/16/main/pg_hba.conf" FT_LIVE_DIR="$work/live" PATH="$work/bin:$PATH" \\
    FT_CADDY_MAIN="$work/Caddyfile" FT_CADDY_ADMIN_DIR="$work/caddyhome" \\
    bash "$DEPLOY/setup-auto-deploy.sh" --dry-run --deploy-user ubuntu "$@" > "$work/out" 2>&1 || rc=$?
  echo "--- $name"
  echo "rc=$rc"
  echo "live-head=$LIVE_HEAD"
  echo "live-origin=$("$REAL_GIT" -C "$work/live" remote get-url origin)"
  echo "live-remotes=$("$REAL_GIT" -C "$work/live" remote | tr '\\n' ' ')"
  echo "live-branch=$("$REAL_GIT" -C "$work/live" symbolic-ref -q --short HEAD)"
  cmp -s "$work/etc/postgresql/16/main/pg_hba.conf" "$work/pg_hba.before" && echo "hba=unchanged"
  cmp -s "$work/Caddyfile" "$work/Caddyfile.before" && echo "caddyfile=unchanged"
  sed 's/^/out: /' "$work/out"
  sed 's/^/call: /' "$work/calls"
}
`

describe.skipIf(!BASH || !hasGit)('setup-auto-deploy.sh --dry-run', () => {
  let runs: Record<string, string> = {}
  beforeAll(() => {
    const r = bash(`${prelude}${setupStubs}
plan both
plan staging-only --staging-only
plan live-only --live-only --staging-domain Staging.Example.Org
plan not-root-domain --staging-domain 'not a domain'
echo '{"name":"copied over"}' > "$work/live/package.json"
plan dirty --live-only
`)
    expect(r.stderr).toBe('')
    runs = sections(r.stdout)
  }, LONG_MS)

  const get = (name: string) => {
    const s = runs[name]
    expect(s, name).toBeDefined()
    return s
  }

  it('prints the whole plan for staging and live', () => {
    const s = get('both')
    expect(s).toContain('rc=0')
    const out = outOf(s)
    const head = /^live-head=([0-9a-f]{40})$/m.exec(s)![1]
    const plan = [
      'Dry run: nothing is changed',
      'would write /usr/local/bin/first-twenty-autoupdate (mode 0755, root:root)',
      'would run: useradd --system --user-group --home-dir /var/lib/first-twenty-staging --no-create-home',
      'would run: install -d -m 0750 -o first-twenty-staging -g first-twenty-staging /var/lib/first-twenty-staging /var/lib/first-twenty-staging/autoupdate /opt/first-twenty-staging',
      'would run: install -d -m 0755 -o root -g root /etc/first-twenty-staging',
      'would run: postgres-setup.sql with the staging names, as the postgres user',
      // The pg_hba.conf lines go in before any password is set.
      'host    first_twenty_staging  first_twenty_staging,first_twenty_staging_owner  127.0.0.1/32  scram-sha-256',
      'local   all  first_twenty_staging,first_twenty_staging_owner  reject',
      'host    all  first_twenty_staging,first_twenty_staging_owner  ::/0          reject',
      'would generate two passwords, set them on first_twenty_staging and first_twenty_staging_owner, and write them only into /etc/first-twenty-staging/env',
      'would write /etc/first-twenty-staging/env (mode 0600, root:root)',
      'would run as first-twenty-staging: git clone --quiet https://github.com/unique-name27/first-twenty-team.git /opt/first-twenty-staging',
      'would write /etc/systemd/system/first-twenty-staging.service (mode 0644, root:root)',
      'would write /etc/systemd/system/first-twenty-staging-migrate.service (mode 0644, root:root)',
      'would write /etc/systemd/system/first-twenty-autoupdate-staging.service (mode 0644, root:root)',
      'would write /etc/systemd/system/first-twenty-autoupdate-staging.timer (mode 0644, root:root)',
      'would run: install -d -m 0755 /etc/systemd/system/first-twenty.service.d /etc/systemd/system/system.slice.d',
      'would write /etc/systemd/system/first-twenty.service.d/memory.conf (mode 0644, root:root)',
      'would write /etc/systemd/system/postgresql@16-main.service.d/memory.conf (mode 0644, root:root)',
      'would run: install -d -m 0755 /etc/systemd/system/system-postgresql.slice.d',
      'would write /etc/systemd/system/system-postgresql.slice.d/memory.conf (mode 0644, root:root)',
      'would write /etc/systemd/system/system.slice.d/memory.conf (mode 0644, root:root)',
      'would run: systemctl daemon-reload',
      'would run: systemctl enable --quiet first-twenty-staging.service',
      'would write /etc/sudoers.d/first-twenty-staging (mode 0440, checked with visudo first):',
      'first-twenty-staging ALL=(root) NOPASSWD:',
      'would write /etc/caddy/first-twenty.d/staging.caddy for staging-77-112-161-54.sslip.io (proxy to 127.0.0.1:8788)',
      'Caddyfile.bak-',
      'add to its global options block: admin unix//var/lib/caddy/admin.sock',
      'add: import /etc/caddy/first-twenty.d/*.caddy',
      'would check the result with caddy validate, then reload Caddy (with --address localhost:2019 the first time) and check that nothing answers on 127.0.0.1:2019',
      'would run: systemctl enable --now --quiet first-twenty-autoupdate-staging.timer',
      'would run: systemctl start --no-block first-twenty-autoupdate-staging.service',
      // The live checkout still holds the older kit (no admin line in its Caddyfile template).
      'run setup-ec2.sh only from a fresh clone of main',
      'origin is git@github.com:example/first-twenty-private.git today',
      'remote add previous-origin git@github.com:example/first-twenty-private.git',
      'remote set-url origin https://github.com/unique-name27/first-twenty-team.git',
      'checkout --quiet --detach',
      'branch -m main previous-origin-main',
      `would record ${head.slice(0, 7)} (checked out in`,
      'would write /etc/systemd/system/first-twenty-autoupdate-live.service (mode 0644, root:root)',
      'would run: systemctl enable --now --quiet first-twenty-autoupdate-live.timer',
      'Dry run finished: nothing was changed.',
    ].map((line) => {
      const at = out.indexOf(line)
      expect(at, line).toBeGreaterThan(-1)
      return at
    })
    expect([...plan].sort((a, b) => a - b)).toEqual(plan)
    // first-twenty-staging.service is not installed yet, so there is nothing to restart for new passwords.
    expect(out).not.toContain('try-restart')
    expect(callsOf(s)).toContain('systemctl show -p LoadState --value first-twenty-staging.service')
  })

  it('changes nothing: only reads, and never shows a password', () => {
    const s = get('both')
    expect(s).toContain('hba=unchanged')
    expect(s).toContain('caddyfile=unchanged')
    expect(s).toContain('live-origin=git@github.com:example/first-twenty-private.git')
    expect(s).toContain('live-remotes=origin \n')
    expect(s).toContain('live-branch=main\n')
    const calls = callsOf(s)
    // Nothing that changes the instance ran.
    // (caddy version and systemctl show only read.)
    expect(calls.filter((c) => /^(caddy|visudo|useradd|install|systemctl|chown|chmod|curl) /.test(c) && c !== 'caddy version' && !c.startsWith('systemctl show '))).toEqual([])
    expect(calls.filter((c) => /^git .*\b(clone|set-url|remote add|fetch|checkout)\b/.test(c))).toEqual([])
    // psql only read the catalog and the pg_hba.conf location.
    const psql = calls.filter((c) => c.startsWith('psql '))
    expect(psql.length).toBeGreaterThan(0)
    for (const c of psql) expect(c, c).toMatch(/-XAtqc (SELECT EXISTS|SHOW hba_file)/)
    expect(outOf(s)).not.toMatch(/postgres:\/\/[^:\s]+:[^@\s]+@/)
  })

  it('sets up only what it is asked to', () => {
    const staging = outOf(get('staging-only'))
    expect(get('staging-only')).toContain('rc=0')
    expect(staging).toContain('Staging: the first-twenty-staging system user')
    expect(staging).not.toContain('Live:')
    expect(staging).not.toContain('first-twenty-autoupdate-live')
    const live = outOf(get('live-only'))
    expect(get('live-only')).toContain('rc=0')
    expect(live).toContain('Live: ')
    expect(live).not.toContain('Staging:')
    expect(live).not.toContain('first-twenty-staging.service')
    expect(live).toContain('would write /usr/local/bin/first-twenty-autoupdate')
    expect(live).not.toContain('memory.conf')
    // The warning about the older kit in the live checkout comes with the staging setup only.
    expect(staging).toContain('run setup-ec2.sh only from a fresh clone of main')
    expect(live).not.toContain('run setup-ec2.sh only from a fresh clone of main')
    expect(staging).not.toContain('changes to tracked files')
    expect(get('not-root-domain')).toContain('rc=1')
    expect(outOf(get('not-root-domain'))).toContain('does not look like a host name for --staging-domain')
  })
  it('warns about changed files in the live checkout, which the live channel will not check out over', () => {
    const s = get('dirty')
    expect(s).toContain('rc=0')
    const out = outOf(s)
    expect(out).toContain('has changes to tracked files that are not committed')
    expect(out).toMatch(/git -C \S+live checkout -- \./)
    expect(outOf(get('both'))).not.toContain('changes to tracked files')
    expect(callsOf(s).filter((c) => /^git .*\b(clone|set-url|remote add|fetch|checkout)\b/.test(c))).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------
// The guides
// ---------------------------------------------------------------------------------------------------

describe('the guides', () => {
  /** The text under heading `start`, up to the next heading at the same level or above (code blocks skipped). */
  const section = (doc: string, start: string) => {
    const lines = doc.split('\n')
    const from = lines.indexOf(start)
    expect(from, start).toBeGreaterThan(-1)
    const level = start.indexOf(' ')
    let fenced = false
    let to = lines.length
    for (let i = from + 1; i < lines.length; i++) {
      if (lines[i].startsWith('```')) fenced = !fenced
      else if (!fenced && new RegExp(`^#{1,${level}} `).test(lines[i])) {
        to = i
        break
      }
    }
    return lines.slice(from + 1, to).join('\n')
  }

  it('docs/SERVER.md explains automatic deploys: staging, releases, the pause switch, logs and the way back', () => {
    const auto = section(serverDoc, '## Automatic deploys from GitHub')
    for (const text of [
      'setup-auto-deploy.sh --dry-run',
      'https://staging-77-112-161-54.sslip.io',
      'verify',
      'Draft a new release',
      'Publish release',
      'unique-name27',
      'sudo touch /etc/first-twenty/autodeploy.paused',
      'sudo touch /etc/first-twenty-staging/autodeploy.paused',
      'journalctl -u first-twenty-autoupdate-live',
      'journalctl -u first-twenty-autoupdate-staging',
      'first-twenty-autoupdate live --record-deployed',
      '60 requests an hour',
      '--ignore-scripts',
      'Restore a backup',
    ]) {
      expect(auto, text).toContain(text)
    }
  })

  it('docs/SERVER.md says what a failed deploy leaves, how to stop a run in progress, and who must create a release', () => {
    const auto = section(serverDoc, '## Automatic deploys from GitHub')
    for (const text of [
      'puts the build and the commit back',
      'is not tried again',
      'the live unit stays failed',
      'sudo touch /etc/first-twenty/autodeploy.paused /etc/first-twenty-staging/autodeploy.paused',
      'sudo systemctl stop first-twenty-autoupdate-live first-twenty-autoupdate-staging',
      'a draft someone else created never deploys',
      'systemctl show -p MemoryPeak first-twenty-autoupdate-staging',
      'only from a fresh clone of `main`',
      'previous-origin-main',
    ]) {
      expect(auto, text).toContain(text)
    }
    expect(auto).not.toContain('published by `unique-name27` (a release by anyone else')
  })

  it('docs/TEAM.md and CONTRIBUTING.md point at the installer, releases and the staging site', () => {
    const team = read('docs/TEAM.md')
    expect(team).toContain('setup-auto-deploy.sh')
    expect(team).not.toContain('first_twenty_team_deploy')
    const contributing = read('CONTRIBUTING.md')
    expect(contributing).toContain('https://staging-77-112-161-54.sslip.io')
    expect(contributing).toMatch(/publish(es|ing)? a GitHub release/i)
  })
})
