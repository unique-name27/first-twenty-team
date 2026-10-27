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
    const code = autoUpdate
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/git[^\n]*\bpull\b/)
    expect(autoUpdate).toContain('merge-base --is-ancestor "$TARGET" refs/remotes/origin/main')
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
 *                                section: rc=, out: lines, call: lines (curl, deploy.sh, sleep, ...)
 * The stub deploy.sh in the repo logs its arguments, the lock and previous-commit variables and the
 * commit checked out, and fails with FAKE_DEPLOY=fail.
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
if [ "\${FAKE_DEPLOY:-ok}" != ok ]; then echo "(stub) the build failed"; exit 1; fi
echo "(stub) deployed"
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
  sed -n 's/^\\(deployed_sha\\|failed\\)=/state: &/p' "$dir/state/state" 2>/dev/null || true
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

newcase l-fail "$C1"
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

  it('live: skips a release by anyone but the owner, a draft and a prerelease, without asking for more', () => {
    expect(outOf(get('l-author-1'))).toContain('published by team-member-1, and only unique-name27')
    expect(curls('l-author-1')).toEqual(['curl releases/latest'])
    expect(callsOf(get('l-author-2'))).toEqual(['curl releases/latest if-none-match="r-v2"'])
    expect(outOf(get('l-author-2'))).toContain('published by team-member-1')
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

  it('live: reports a failed deploy and how to pause before rolling back', () => {
    const s = get('l-fail')
    expect(s).toContain('rc=1')
    expect(s).toContain(`state: failed=${sha.C2}:1`)
    expect(outOf(s)).toMatch(/To stop the retries and roll back: sudo touch \S+autodeploy\.paused/)
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
  const fns = ['run', 'info', 'warn', 'die', 'render_caddy_site', 'caddy_admin_setting', 'caddy_with_admin', 'caddy_admin_on_tcp', 'caddy_reload', 'setup_caddy']
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
for c in caddy visudo useradd install systemctl chown chmod curl; do
  printf '#!/usr/bin/env bash\\necho "%s $*" >> "$CALLS"\\n' "$c" > "$work/bin/$c"
done
# The caddy user's folder, for the admin socket.
printf '#!/usr/bin/env bash\\n[ "$1 $2" = "-c %%U" ] && { echo caddy; exit 0; }\\nexec /usr/bin/stat "$@"\\n' > "$work/bin/stat"
chmod +x "$work"/bin/*
# The live Caddyfile as an older setup-ec2.sh wrote it: global options without the admin line, no import.
mkdir -p "$work/caddyhome"
printf '{\\n\\tservers {\\n\\t\\tprotocols h1 h2\\n\\t}\\n}\\n\\nhr.example.test {\\n\\treverse_proxy 127.0.0.1:8787\\n}\\n' > "$work/Caddyfile"
cp "$work/Caddyfile" "$work/Caddyfile.before"
# The live checkout: a real repo with one commit and the private repo's SSH origin.
mkdir -p "$work/live"
"$REAL_GIT" -C "$work/live" -c init.defaultBranch=main init -q
echo '{"name":"first-twenty"}' > "$work/live/package.json"
"$REAL_GIT" -C "$work/live" -c core.autocrlf=false add package.json
"$REAL_GIT" -C "$work/live" -c user.name=Test -c user.email=test@example.test commit -q -m live
"$REAL_GIT" -C "$work/live" remote add origin git@github.com:example/first-twenty-private.git
LIVE_HEAD=$("$REAL_GIT" -C "$work/live" rev-parse HEAD)
printf 'local all postgres peer\\n' > "$work/pg_hba.conf"
cp "$work/pg_hba.conf" "$work/pg_hba.before"
plan() { # plan <name> [options]
  local name=$1 rc=0
  shift
  : > "$work/calls"
  env CALLS="$work/calls" FAKE_HBA="$work/pg_hba.conf" FT_LIVE_DIR="$work/live" PATH="$work/bin:$PATH" \\
    FT_CADDY_MAIN="$work/Caddyfile" FT_CADDY_ADMIN_DIR="$work/caddyhome" \\
    bash "$DEPLOY/setup-auto-deploy.sh" --dry-run --deploy-user ubuntu "$@" > "$work/out" 2>&1 || rc=$?
  echo "--- $name"
  echo "rc=$rc"
  echo "live-head=$LIVE_HEAD"
  echo "live-origin=$("$REAL_GIT" -C "$work/live" remote get-url origin)"
  echo "live-remotes=$("$REAL_GIT" -C "$work/live" remote | tr '\\n' ' ')"
  cmp -s "$work/pg_hba.conf" "$work/pg_hba.before" && echo "hba=unchanged"
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
      'would generate two passwords, set them on first_twenty_staging and first_twenty_staging_owner, and write them only into /etc/first-twenty-staging/env',
      'host    first_twenty_staging  first_twenty_staging,first_twenty_staging_owner  127.0.0.1/32  scram-sha-256',
      'local   all  first_twenty_staging,first_twenty_staging_owner  reject',
      'host    all  first_twenty_staging,first_twenty_staging_owner  ::/0          reject',
      'would write /etc/first-twenty-staging/env (mode 0600, root:root)',
      'would run as first-twenty-staging: git clone --quiet https://github.com/unique-name27/first-twenty-team.git /opt/first-twenty-staging',
      'would write /etc/systemd/system/first-twenty-staging.service (mode 0644, root:root)',
      'would write /etc/systemd/system/first-twenty-staging-migrate.service (mode 0644, root:root)',
      'would write /etc/systemd/system/first-twenty-autoupdate-staging.service (mode 0644, root:root)',
      'would write /etc/systemd/system/first-twenty-autoupdate-staging.timer (mode 0644, root:root)',
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
      'origin is git@github.com:example/first-twenty-private.git today',
      'remote add previous-origin git@github.com:example/first-twenty-private.git',
      'remote set-url origin https://github.com/unique-name27/first-twenty-team.git',
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
  })

  it('changes nothing: only reads, and never shows a password', () => {
    const s = get('both')
    expect(s).toContain('hba=unchanged')
    expect(s).toContain('caddyfile=unchanged')
    expect(s).toContain('live-origin=git@github.com:example/first-twenty-private.git')
    expect(s).toContain('live-remotes=origin \n')
    const calls = callsOf(s)
    // Nothing that changes the instance ran.
    expect(calls.filter((c) => /^(caddy|visudo|useradd|install|systemctl|chown|chmod|curl) /.test(c))).toEqual([])
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

  it('docs/TEAM.md and CONTRIBUTING.md point at the installer, releases and the staging site', () => {
    const team = read('docs/TEAM.md')
    expect(team).toContain('setup-auto-deploy.sh')
    expect(team).not.toContain('first_twenty_team_deploy')
    const contributing = read('CONTRIBUTING.md')
    expect(contributing).toContain('https://staging-77-112-161-54.sslip.io')
    expect(contributing).toMatch(/publish(es|ing)? a GitHub release/i)
  })
})
