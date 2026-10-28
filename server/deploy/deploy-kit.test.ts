// Checks that the EC2 deploy kit (server/deploy/**, .env.example, docs/SERVER.md) agrees with the server
// it deploys: settings names and values, the port Caddy proxies to, body limits, file paths shared
// between the scripts, and the behavior of the shell scripts themselves, run with bash against stub
// commands. postgres-setup.sql itself runs in PGlite in postgres-setup.test.ts: kept apart so PGlite
// never shares a worker with this file's Git Bash spawns.
//
// `npm test` runs it (vite.config.ts includes server/deploy/**/*.test.ts) and `npm run typecheck` checks
// it (server/tsconfig.json includes deploy). On its own: npx vitest run server/deploy
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { redactPath, REQUEST_TIMEOUT_MS, WORKSPACE_BODY_LIMIT } from '../src/app'
import { DEFAULT_APPLY_LIMITS } from '../src/careers/limits'
import { APPLY_BODY_LIMIT, CAREERS_CACHE_BYTES } from '../src/careers/routes'
import { LOAD_BUDGET, MAX_LISTED_JOBS } from '../src/careers/data'
import { loadConfig, parseDotEnv } from '../src/config'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8')
/** Forward slashes, which both Windows (Git Bash) and Linux bash accept in file arguments. */
const slash = (p: string) => p.replace(/\\/g, '/')

const envExample = read('.env.example')
const unit = read('server/deploy/first-twenty.service')
const caddyfile = read('server/deploy/Caddyfile')
const setupSql = read('server/deploy/postgres-setup.sql')
const serverDoc = read('docs/SERVER.md')
const scripts = ['setup-ec2.sh', 'deploy.sh', 'backup.sh', 'with-env.sh', 'set-anthropic-key.sh'].map((f) => ({
  name: f,
  text: read(`server/deploy/${f}`),
}))
const script = (name: string) => scripts.find((s) => s.name === name)!.text

describe('.env.example', () => {
  it('names every variable the server config reads', () => {
    const configSource = read('server/src/config.ts')
    const names = new Set<string>()
    for (const m of configSource.matchAll(/env\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1])
    for (const m of configSource.matchAll(/env, '([A-Z][A-Z0-9_]*)'/g)) names.add(m[1])
    names.delete('NODE_ENV') // set by the systemd unit and with-env.sh, not by the settings file
    expect(names.size).toBeGreaterThan(5)
    const missing = [...names].filter((n) => !new RegExp(`^(# )?${n}=`, 'm').test(envExample))
    expect(missing).toEqual([])
  })

  it('is a valid production config once DATABASE_URL is filled in', () => {
    const parsed = parseDotEnv(envExample)
    const env: Record<string, string | undefined> = {
      ...parsed,
      DATABASE_URL: parsed.DATABASE_URL.replace('CHANGE_ME', 'filled-in'),
      NODE_ENV: 'production',
      APP_FILE: 'package.json', // any file that exists; the real one is built on the server
    }
    const warnings: string[] = []
    const config = loadConfig(env, { dotenv: false, rootDir: root, warn: (m) => warnings.push(m) })
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(8787)
    expect(config.databaseUrl).toBe('postgres://first_twenty:filled-in@127.0.0.1:5432/first_twenty')
    expect(config.pgSslMode).toBe('disable')
    expect(config.secureCookies).toBe(true)
    expect(config.serveApp).toBe(true)
    expect(config.migrateOnStart).toBe(false)
    expect(config.allowedOrigin).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('keeps comments on their own lines (systemd does not strip trailing comments)', () => {
    const valueLines = envExample.split('\n').filter((l) => /^[A-Z_]+=/.test(l))
    expect(valueLines.length).toBeGreaterThan(5)
    for (const line of valueLines) expect(line, line).not.toMatch(/\s#/)
  })

  it('is refused by the server until the placeholder password is replaced', () => {
    const env = { ...parseDotEnv(envExample), NODE_ENV: 'production', APP_FILE: 'package.json' }
    expect(() => loadConfig(env, { dotenv: false, rootDir: root, warn: () => {} })).toThrow(/CHANGE_ME/)
  })

  it('holds placeholders only', () => {
    const passwords = [...envExample.matchAll(/postgres(?:ql)?:\/\/[^:\s]+:([^@\s]+)@/g)].map((m) => m[1])
    expect(passwords.length).toBeGreaterThanOrEqual(3) // the comment, DATABASE_URL, MIGRATION_DATABASE_URL
    for (const p of passwords) expect(p).toBe('CHANGE_ME')
  })

  it('gives the server the read-and-write role and migrations the owner role', () => {
    const env = parseDotEnv(envExample)
    expect(new URL(env.DATABASE_URL).username).toBe('first_twenty')
    expect(new URL(env.MIGRATION_DATABASE_URL).username).toBe('first_twenty_owner')
    expect(new URL(env.MIGRATION_DATABASE_URL).pathname).toBe(new URL(env.DATABASE_URL).pathname)
    // The owner role cannot change tables while the server runs them, and the server role cannot migrate.
    expect(env.MIGRATE_ON_START).toBe('false')
  })
})

describe('systemd unit and Caddy', () => {
  it('runs the built server as the service user with the settings file', () => {
    expect(unit).toMatch(/^User=firsttwenty$/m)
    expect(unit).toMatch(/^WorkingDirectory=\/opt\/first-twenty$/m)
    expect(unit).toMatch(/^EnvironmentFile=\/etc\/first-twenty\/env$/m)
    expect(unit).toMatch(/^Environment=NODE_ENV=production$/m)
    expect(unit).toMatch(/^ExecStart=\/usr\/bin\/node dist-server\/server\.mjs$/m)
    expect(unit).toMatch(/^Restart=on-failure$/m)
    for (const key of ['NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=true', 'PrivateTmp=true']) {
      expect(unit).toContain(`\n${key}\n`)
    }
    // Node's JIT needs writable executable memory.
    expect(unit).not.toMatch(/^MemoryDenyWriteExecute=true/m)
  })

  it('never hands the schema owner connection to the running server', () => {
    expect(unit).toMatch(/^UnsetEnvironment=MIGRATION_DATABASE_URL$/m)
  })

  it('limits the network to 127.0.0.1 and ::1 and hides other processes', () => {
    for (const key of ['IPAddressDeny=any', 'IPAddressAllow=127.0.0.1/32 ::1/128', 'ProtectProc=invisible', 'ProcSubset=pid']) {
      expect(unit).toContain(`\n${key}\n`)
    }
    // "localhost" means all of 127.0.0.0/8; only the DNS stub is opened from it, below.
    expect(unit).not.toMatch(/^IPAddressAllow=localhost/m)
    // A remote database must be added to the allow list; the unit says how.
    expect(unit).toMatch(/^#\s+IPAddressAllow=\d+\.\d+\.\d+\.\d+/m)
    expect(serverDoc).toContain('IPAddressAllow=')
  })

  it("opens exactly the assistant's way out: the DNS stub and Anthropic's published API ranges, with where they come from", () => {
    // Anthropic's inbound API addresses, https://platform.claude.com/docs/en/api/ip-addresses (checked 2026-10-11).
    const anthropic = ['160.79.104.0/23', '2607:6bc0::/48']
    const allow = [...unit.matchAll(/^IPAddressAllow=(.*)$/gm)].map((m) => m[1])
    expect(allow).toEqual(['127.0.0.1/32 ::1/128', `127.0.0.53/32 ${anthropic.join(' ')}`])
    // Nothing wider: no "any", no default route, no other loopback addresses.
    for (const line of allow) expect(line).not.toMatch(/\bany\b|0\.0\.0\.0\/0|::\/0|127\.0\.0\.0\/8|localhost/)
    // The comment says where the ranges come from and when they were checked.
    expect(unit).toContain('https://platform.claude.com/docs/en/api/ip-addresses (checked 2026-10-11')
    // The guide says the same, and says to re-run setup to apply the unit.
    const section = serverDoc.slice(serverDoc.indexOf('## Lark, the assistant'))
    expect(section.length).toBeGreaterThan(1000)
    for (const range of [...anthropic, '127.0.0.53']) expect(section).toContain(range)
    expect(section).toContain('setup-ec2.sh')
  })

  it('keeps restarting however often it fails, so a crash someone can repeat never leaves it stopped', () => {
    expect(unit).toMatch(/^Restart=on-failure$/m)
    expect(unit).toMatch(/^RestartSec=\d+$/m)
    expect(unit).toMatch(/^StartLimitIntervalSec=0$/m)
    expect(unit).not.toMatch(/^StartLimitBurst=/m)
  })

  it('filters system calls: the service set first, then minus privileged and resource calls', () => {
    const allow = unit.indexOf('\nSystemCallFilter=@system-service\n')
    const deny = unit.indexOf('\nSystemCallFilter=~@privileged @resources\n')
    expect(allow).toBeGreaterThan(0)
    expect(deny).toBeGreaterThan(allow) // the first SystemCallFilter line decides allow-list mode
    // With @resources blocked, Node must not need setrlimit to raise its file limit.
    expect(unit).toMatch(/^LimitNOFILE=\d+$/m)
  })

  it('proxies to the HOST and PORT in .env.example', () => {
    const env = parseDotEnv(envExample)
    expect(caddyfile).toMatch(new RegExp(`^\\s*reverse_proxy ${env.HOST.replace(/\./g, '\\.')}:${env.PORT}\\b`, 'm'))
  })

  it('accepts a full workspace upload', () => {
    const m = /max_size (\d+)MB/.exec(caddyfile)
    expect(m).not.toBeNull()
    expect(Number(m![1]) * 1000 * 1000).toBeGreaterThan(WORKSPACE_BODY_LIMIT)
  })

  it('has the placeholders setup-ec2.sh fills in', () => {
    expect(caddyfile).toMatch(/^hr\.example\.com \{$/m)
    expect(caddyfile).toMatch(/^http:\/\/hr\.example\.com \{$/m)
    expect(caddyfile).toMatch(/^\s*# tls you@example\.com$/m)
  })

  /** The Caddyfile without comments and blank lines. */
  const caddyCode = () =>
    caddyfile
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
      .join('\n')

  it('starts with global options that time out slow clients and leave out HTTP/3', () => {
    const code = caddyCode()
    expect(code.startsWith('{\n')).toBe(true)
    const global = code.slice(0, code.indexOf('\n}\n') + 2)
    expect(global).toMatch(/^\s*read_header \d+s$/m)
    expect(global).toMatch(/^\s*idle \d+m$/m)
    expect(global).toMatch(/^\s*protocols h1 h2$/m)
    // A write timeout would cut off slow downloads of the app and the workspace.
    expect(global).not.toMatch(/^\s*write /m)
    // Caddy and the server give a slow upload the same time.
    const body = /^\s*read_body (\d+)m$/m.exec(global)
    expect(body).not.toBeNull()
    expect(Number(body![1]) * 60_000).toBe(REQUEST_TIMEOUT_MS)
  })

  it('redirects plain http in a site of its own, so the timeouts cover port 80 too', () => {
    const block = /^http:\/\/hr\.example\.com \{\n([\s\S]*?)^\}$/m.exec(caddyCode())
    expect(block).not.toBeNull()
    expect(block![1].trim()).toBe('redir https://{host}{uri} permanent')
  })

  it('sends HSTS itself, replacing the server copy, and no "?" defaults that Caddy 2.6 would never apply', () => {
    const code = caddyCode()
    expect(code).toMatch(/^\theader \{\n\t\tStrict-Transport-Security "max-age=31536000"\n\t\tdefer\n\t\}$/m)
    expect(code).toMatch(/^\theader -Server$/m)
    expect(code).not.toMatch(/^\s*\?/m)
  })

  it('keeps invite tokens out of the access log, which records every request path', () => {
    const code = caddyCode()
    const start = code.indexOf('\nhr.example.com {\n')
    const app = code.slice(start, code.indexOf('\n}\n', start) + 3)
    expect(app).toContain('\t\tformat filter {\n\t\t\twrap json\n\t\t\tfields {\n\t\t\t\trequest>uri regexp "(?i)/invites/[^/?#]+" "/invites/[redacted]"\n\t\t\t}\n\t\t}\n')
    expect(app).not.toMatch(/^\t\tformat json$/m)
    // The pattern (Go's regexp syntax; (?i) is the i flag here) cuts the token out of every spelling the
    // server routes, as redactPath does for the server's own log.
    const re = /\/invites\/[^/?#]+/i
    for (const uri of [`/api/invites/${'T'.repeat(43)}`, `/%61pi/invites/${'T'.repeat(43)}?x=1`, `/api/INVITES/${'T'.repeat(43)}`]) {
      const cut = uri.replace(re, '/invites/[redacted]')
      expect(cut, uri).not.toContain('T'.repeat(43))
      expect(cut.toLowerCase(), uri).toBe(redactPath(uri).toLowerCase())
    }
  })

  it('has a careers site template that proxies like the app, takes small bodies only and drops cookies', () => {
    const m = /^# BEGIN careers site\n([\s\S]*?)^# END careers site$/m.exec(caddyfile)
    expect(m).not.toBeNull()
    const block = m![1]
    // The template is the last thing in the file, so setup can append one copy per careers domain there.
    expect(caddyfile.trimEnd().endsWith('# END careers site')).toBe(true)
    expect(block).toMatch(/^http:\/\/careers\.example\.com \{\n\tredir https:\/\/\{host\}\{uri\} permanent\n\}$/m)
    expect(block).toMatch(/^careers\.example\.com \{$/m)
    expect(block).toMatch(/^\t# tls you@example\.com$/m)
    const env = parseDotEnv(envExample)
    expect(block).toMatch(new RegExp(`^\\treverse_proxy ${env.HOST.replace(/\./g, '\\.')}:${env.PORT} \\{\\n\\t\\theader_up -X-Real-IP\\n\\t\\}$`, 'm'))
    expect(block).toMatch(/^\theader \{\n\t\tStrict-Transport-Security "max-age=31536000"\n\t\tdefer\n\t\}$/m)
    expect(block).toMatch(/^\theader -Set-Cookie$/m)
    // Room for the largest application the server takes, and nothing like a workspace upload.
    const size = /^\t\tmax_size (\d+)KB$/m.exec(block)
    expect(size).not.toBeNull()
    expect(Number(size![1]) * 1000).toBeGreaterThan(APPLY_BODY_LIMIT)
    expect(Number(size![1]) * 1000).toBeLessThan(WORKSPACE_BODY_LIMIT / 100)
    // Each host's HSTS covers that host alone: the careers hosts and the app never pin each other.
    expect(caddyCode()).not.toMatch(/includeSubDomains/i)
    // The template's own placeholders appear only inside it.
    expect(caddyfile.replace(m![0], '')).not.toMatch(/^(http:\/\/)?careers\.example\.com \{$/m)
  })
})

describe('shell scripts (static checks)', () => {
  it('are strict bash with LF line endings', () => {
    for (const { name, text } of scripts) {
      expect(text.startsWith('#!/usr/bin/env bash\n'), name).toBe(true)
      expect(text, name).toContain('\nset -euo pipefail\n')
      expect(text.includes('\r'), name).toBe(false)
    }
  })

  it('agree on paths', () => {
    const setup = script('setup-ec2.sh')
    expect(setup).toContain('APP_DIR=/opt/first-twenty\n')
    expect(setup).toContain('ENV_FILE=$ENV_DIR/env\n')
    expect(setup).toContain('ENV_DIR=/etc/first-twenty\n')
    expect(setup).toContain('APP_USER=firsttwenty\n')
    for (const name of ['with-env.sh', 'backup.sh']) {
      expect(script(name), name).toContain('/etc/first-twenty/env')
    }
  })

  it('call npm scripts that exist, and so does docs/SERVER.md', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    const used = new Set<string>()
    for (const text of [...scripts.map((s) => s.text), serverDoc]) {
      for (const m of text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) used.add(m[1])
    }
    expect(used).toContain('build:all')
    expect(used).toContain('server:migrate')
    expect(used).toContain('server:after-restore')
    expect([...used].filter((s) => !(s in pkg.scripts))).toEqual([])
  })

  it('never check sudo with sudo -v (Ubuntu EC2 logins have a NOPASSWD rule next to the sudo group rule, and -v asks for a password then)', () => {
    for (const { name, text } of scripts) {
      const code = text
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n')
      expect(code, name).not.toMatch(/\bsudo\s+(-n\s+)?-v\b/)
    }
  })

  it('never pipe a command into grep -q (under pipefail the early exit kills the writer with SIGPIPE)', () => {
    const offenders: string[] = []
    for (const { name, text } of scripts) {
      text.split('\n').forEach((line, i) => {
        if (line.trimStart().startsWith('#')) return
        for (const m of line.matchAll(/\|\s*grep((?:\s+-[A-Za-z]+)+)/g)) {
          if (!/q/.test(m[1])) continue
          // printf/echo of a short value writes everything at once, before grep can exit: harmless.
          if (/\b(printf|echo)\b[^|]*$/.test(line.slice(0, m.index))) continue
          offenders.push(`${name}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('check placeholders in the active settings lines only, not in the whole file', () => {
    // .env.example has CHANGE_ME in a comment, so a whole-file grep always matched.
    for (const { name, text } of scripts) {
      expect(text, name).not.toMatch(/grep -q 'CHANGE_ME' "\$ENV_FILE"/)
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// Running the scripts: bash with stub commands (Git Bash on Windows).
// ---------------------------------------------------------------------------------------------------

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
/**
 * Time for a test or hook that runs bash. Forks are slow in Git Bash, and slower still while other
 * processes fork, so the 20 s default is not enough headroom for a block of runs.
 */
const BASH_TEST_MS = 120_000
const hasGit = BASH !== null && spawnSync(BASH, ['-c', 'command -v git'], { encoding: 'utf8' }).status === 0

type BashResult = { status: number | null; stdout: string; stderr: string }

function bash(body: string, env: Record<string, string> = {}): BashResult {
  const r = spawnSync(BASH!, ['-c', body], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DEPLOY: slash(here), REPO: slash(root), ...env },
  })
  if (r.error) throw r.error
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** The text of shell function `name` from a script: `name() { ... }` on one line or up to a closing `}`. */
function shellFunction(text: string, name: string): string {
  const oneLine = new RegExp(`^${name}\\(\\) \\{.*\\}$`, 'm').exec(text)
  if (oneLine) return oneLine[0]
  const block = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm').exec(text)
  if (!block) throw new Error(`function ${name} not found`)
  return block[0]
}

/** A strict-mode prelude with a scratch folder ($work) removed on exit. */
const prelude = `set -euo pipefail
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
`

describe.skipIf(!BASH)('deploy.sh', { timeout: BASH_TEST_MS }, () => {
  const deploy = script('deploy.sh')

  it('accepts a real git archive and a large one, and tells unreadable from incomplete archives', () => {
    const r = bash(`${prelude}
${shellFunction(deploy, 'archive_has_package_json')}
if ${hasGit ? 'git -C "$REPO" rev-parse -q --verify HEAD >/dev/null 2>&1' : 'false'}; then
  git -C "$REPO" archive --format=tar.gz -o "$work/real.tgz" HEAD
  archive_has_package_json "$work/real.tgz" && echo "real=ok"
else
  echo "real=skipped"
fi
# package.json first, then a listing far larger than a pipe buffer: the case that broke tar | grep -q.
mkdir -p "$work/src/many"
: > "$work/src/package.json"
long=$(printf 'x%.0s' $(seq 1 100))
for i in $(seq 1 900); do : > "$work/src/many/$long-$i"; done
tar -czf "$work/big.tgz" -C "$work/src" package.json many
for run in 1 2 3; do archive_has_package_json "$work/big.tgz" && echo "big=ok"; done
# The pipeline deploy.sh used before: under pipefail it fails although package.json is there.
old=0
for run in 1 2 3; do (tar -tzf "$work/big.tgz" | grep -Eq '^(\\./)?package\\.json$') || old=$((old + 1)); done
echo "old-pipeline-failures=$old"
tar -czf "$work/none.tgz" -C "$work/src" many
rc=0; archive_has_package_json "$work/none.tgz" || rc=$?; echo "none=$rc"
printf 'not a gzip file' > "$work/bad.tgz"
rc=0; archive_has_package_json "$work/bad.tgz" || rc=$?; echo "bad=$rc"
`)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^real=(ok|skipped)$/m)
    if (hasGit && existsSync(path.join(root, '.git'))) expect(r.stdout).toMatch(/^real=ok$/m)
    expect(r.stdout.match(/^big=ok$/gm)).toHaveLength(3)
    // A listing far larger than a pipe buffer makes the old tar | grep -q pipeline die of SIGPIPE.
    expect(Number(/^old-pipeline-failures=(\d)$/m.exec(r.stdout)?.[1])).toBeGreaterThan(0)
    expect(r.stdout).toMatch(/^none=1$/m)
    expect(r.stdout).toMatch(/^bad=2$/m)
  })

  it('uses the archive check for --archive instead of a tar | grep pipeline', () => {
    expect(deploy).toMatch(/archive_has_package_json "\$ARCHIVE" \|\| rc=\$\?/)
    expect(deploy).not.toMatch(/tar -tzf[^\n]*\|\s*grep/)
  })

  it.skipIf(!hasGit)('explains a detached HEAD after a rollback instead of failing at git pull', () => {
    const r = bash(`${prelude}
${shellFunction(deploy, 'detached_head_hint')}
g() { git -c user.name=Test -c user.email=test@example.test -c init.defaultBranch=trunk -c advice.detachedHead=false "$@"; }
g init -q "$work/origin"
cd "$work/origin"
echo one > file && g add file && g commit -qm one
echo two > file && g commit -qam two
g clone -q "$work/origin" "$work/app"
cd "$work/app"
echo "on-branch=[$(detached_head_hint)]"
g checkout -q HEAD~1
echo "detached=[$(detached_head_hint)]"
rc=0; g pull --ff-only >/dev/null 2>&1 || rc=$?; echo "pull-on-detached=$rc"
`)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^on-branch=\[\]$/m)
    const detached = /^detached=\[(.*)\]$/m.exec(r.stdout)?.[1] ?? ''
    expect(detached).toContain('rolled-back commit')
    expect(detached).toContain('git switch trunk') // the clone's default branch, from origin/HEAD
    expect(detached).toContain('--no-pull')
    expect(r.stdout).not.toMatch(/^pull-on-detached=0$/m) // why the hint is needed
    // deploy.sh stops with the hint before git pull.
    expect(deploy.indexOf('HINT=$(detached_head_hint)')).toBeGreaterThan(0)
    expect(deploy.indexOf('HINT=$(detached_head_hint)')).toBeLessThan(deploy.indexOf('git pull --ff-only'))
  })
})

describe.skipIf(!BASH)('shell scripts (bash -n)', { timeout: BASH_TEST_MS }, () => {
  it('all parse', () => {
    for (const { name } of scripts) {
      const r = bash(`bash -n "$DEPLOY/${name}"`)
      expect(r.stderr, name).toBe('')
      expect(r.status, name).toBe(0)
    }
  })
})

/**
 * A scratch install for running all of deploy.sh: a copy of the script in $app/server/deploy (so its
 * APP_DIR is $app), a stand-in with-env.sh that runs its command as is (with-env.sh has its own tests),
 * and stub commands that log every call to $CALLS. The FAKE_* variables decide what each stub does.
 * `run <name> "<VAR=value ...>" [deploy.sh options]` starts one deploy in the background, in its own
 * folder (settings file, backups, call log), from a copy of the code in $RUN_APP: deploy.sh keeps the
 * previous build in its code folder (.deploy-prev) and puts it back on a failure, so parallel runs must not
 * share one. `report` waits for them all and prints, per run, its exit code, its output (out: lines) and
 * the commands it ran (call: lines). Forks are slow in Git Bash, so the runs go in parallel.
 */
const deployStubs = `
app="$work/app"
RUN_APP=$app
mkdir -p "$app/server/deploy" "$app/dist-server" "$work/bin" "$work/runs"
cp "$DEPLOY/deploy.sh" "$DEPLOY/first-twenty.service" "$app/server/deploy/"
printf '#!/usr/bin/env bash\\nexec "$@"\\n' > "$app/server/deploy/with-env.sh"
echo '{"name":"first-twenty"}' > "$app/package.json"
: > "$app/dist-server/server.mjs"
: > "$app/first-twenty.html"
cat > "$work/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$CALLS"
case "$*" in
  'show -p LoadState --value first-twenty') echo "$FAKE_LOAD" ;;
  'show -p WorkingDirectory --value first-twenty') echo "$FAKE_WORKDIR" ;;
  'start first-twenty-backup')
    if [ "$FAKE_BACKUP" = fail ]; then echo 'Job for first-twenty-backup.service failed.' >&2; exit 1; fi
    # backup.sh wrote and checked the local dump, then the copy to S3 failed (it exits 1).
    if [ "$FAKE_BACKUP" = s3fail ]; then
      : > "$FAKE_BACKUP_DIR/first-twenty-20261010-170000Z.dump"
      echo 'Job for first-twenty-backup.service failed.' >&2; exit 1
    fi
    if [ "$FAKE_BACKUP" != nofile ]; then : > "$FAKE_BACKUP_DIR/first-twenty-20261010-170000Z.dump"; fi
    ;;
esac
exit 0
EOF
cat > "$work/bin/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $*" >> "$CALLS"
case "$*" in
  'run server:migrate -- --status')
    if [ "$FAKE_STATUS" = fail ]; then echo 'Migration failed: connect ECONNREFUSED 127.0.0.1:5432' >&2; exit 1; fi
    printf '\\n> first-twenty@0.1.0 server:migrate\\n> node server/src/cli/run.mjs migrate --status\\n\\n'
    echo 'Applied (2): 001_init.sql, 002_history_and_seq_versions.sql'
    if [ "$FAKE_PENDING" = 0 ]; then echo 'Pending (0): none'; else echo 'Pending (1): 003_next.sql'; fi
    ;;
  'run server:migrate')
    if [ "$FAKE_MIGRATE" = fail ]; then echo 'Migration failed: syntax error at or near "TABEL"' >&2; exit 1; fi
    echo 'Applied 003_next.sql'
    ;;
esac
exit 0
EOF
cat > "$work/bin/sudo" <<'EOF'
#!/usr/bin/env bash
[ "$1" = -v ] && exit 0
exec "$@"
EOF
cat > "$work/bin/id" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = -u ]; then echo 1000; exit 0; fi
exec /usr/bin/id "$@"
EOF
cat > "$work/bin/curl" <<'EOF'
#!/usr/bin/env bash
[ "$FAKE_HEALTH" = fail ] && exit 7
echo '{"ok":true,"db":"up","version":"0.1.0"}'
EOF
printf '#!/usr/bin/env bash\\necho "(recent server logs)"\\n' > "$work/bin/journalctl"
for c in flock sleep cmp; do printf '#!/usr/bin/env bash\\nexit 0\\n' > "$work/bin/$c"; done
chmod +x "$work"/bin/* "$app/server/deploy/with-env.sh"
run() { # run <name> "<VAR=value ...>" [deploy.sh options]
  local name=$1 vars=$2 dir="$work/runs/$1"
  shift 2
  mkdir -p "$dir/backups"
  # Last night's dump, and an unfinished one that must never be picked.
  : > "$dir/backups/first-twenty-20261010-031500Z.dump"
  : > "$dir/backups/.first-twenty-20261010-170001Z.dump.partial"
  printf 'PORT=8787\\nBACKUP_DIR=%s\\n' "$dir/backups" > "$dir/env"
  [ -z "\${RUN_ORIGIN:-}" ] || printf 'PUBLIC_ORIGIN=%s\\n' "$RUN_ORIGIN" >> "$dir/env"
  : > "$dir/calls"
  (
    rc=0
    cp -R "$RUN_APP" "$dir/app"
    env FAKE_LOAD=loaded FAKE_WORKDIR="$dir/app" FAKE_BACKUP=ok FAKE_PENDING=1 FAKE_STATUS=ok FAKE_MIGRATE=ok FAKE_HEALTH=ok $vars \\
      CALLS="$dir/calls" FAKE_BACKUP_DIR="$dir/backups" PATH="$work/bin:$PATH" FIRST_TWENTY_ENV="$dir/env" \\
      TMPDIR="$dir" HEALTH_WAIT_SECONDS=2 bash "$dir/app/server/deploy/deploy.sh" --no-pull "$@" > "$dir/out" 2>&1 || rc=$?
    echo "$rc" > "$dir/rc"
  ) &
}
report() {
  wait
  for dir in "$work"/runs/*/; do
    echo "--- $(basename "$dir")"
    echo "rc=$(cat "$dir/rc")"
    sed 's/^/out: /' "$dir/out"
    sed 's/^/call: /' "$dir/calls"
  done
}
`

/** The call: lines of one run, in order, without the prefix. */
const callsOf = (section: string) =>
  section
    .split('\n')
    .filter((l) => l.startsWith('call: '))
    .map((l) => l.slice('call: '.length))
/** The out: lines of one run, joined back together. */
const outOf = (section: string) =>
  section
    .split('\n')
    .filter((l) => l.startsWith('out: '))
    .map((l) => l.slice('out: '.length))
    .join('\n')

/** The restore commands of docs/SERVER.md, "Restore a backup", in the order they must run. */
const RESTORE_ORDER = [
  'systemctl stop first-twenty',
  'postgres-setup.sql',
  '--role=first_twenty_owner',
  'with-env.sh npm run server:migrate',
  'with-env.sh npm run server:after-restore',
  'systemctl start first-twenty',
]

describe.skipIf(!BASH)('deploy.sh, run with stub commands', () => {
  let runs: Record<string, string> = {}
  beforeAll(() => {
    const r = bash(`${prelude}${deployStubs}
run ok-no-pending 'FAKE_PENDING=0'
run ok-pending ''
run backup-fails 'FAKE_BACKUP=fail'
run backup-no-file 'FAKE_BACKUP=nofile'
run backup-s3-fails 'FAKE_BACKUP=s3fail'
run status-fails 'FAKE_STATUS=fail'
run migrate-fails 'FAKE_MIGRATE=fail'
run health-fails-pending 'FAKE_HEALTH=fail'
run health-fails-no-pending 'FAKE_PENDING=0 FAKE_HEALTH=fail'
run skip-backup '' --skip-backup
run other-folder 'FAKE_WORKDIR=/opt/first-twenty'
run not-installed 'FAKE_LOAD=not-found FAKE_WORKDIR='
RUN_ORIGIN=https://hr.test.example run origin-https 'FAKE_PENDING=0'
RUN_ORIGIN=http://localhost:8787 run origin-tunnel 'FAKE_PENDING=0'
RUN_ORIGIN=https://hr.example.com run origin-placeholder 'FAKE_PENDING=0'
if command -v git >/dev/null 2>&1; then
  cp -R "$app" "$work/gitapp"
  g() { git -C "$work/gitapp" -c core.autocrlf=false -c core.safecrlf=false -c init.defaultBranch=trunk -c user.name=Test -c user.email=test@example.test "$@"; }
  g init -q
  g add -A
  g commit -qm release
  RUN_APP="$work/gitapp" run health-fails-git 'FAKE_HEALTH=fail'
fi
report
`)
    runs = sections(r.stdout)
    expect(r.stderr).toBe('')
  }, 2 * BASH_TEST_MS)

  const get = (name: string) => {
    const s = runs[name]
    expect(s, name).toBeDefined()
    return s
  }
  const migrated = (calls: string[]) => calls.includes('npm run server:migrate')

  it('migrates without a backup when nothing is pending', () => {
    const s = get('ok-no-pending')
    expect(s).toContain('rc=0')
    const calls = callsOf(s)
    expect(calls).toContain('npm run server:migrate -- --status')
    expect(calls).not.toContain('systemctl start first-twenty-backup')
    expect(outOf(s)).toContain('Deploy finished.')
  })

  it('takes a backup with the backup service before applying pending migrations, and names the dump', () => {
    const s = get('ok-pending')
    expect(s).toContain('rc=0')
    const calls = callsOf(s)
    const order = [
      'npm run build:all',
      'npm run server:migrate -- --status',
      'systemctl start first-twenty-backup',
      'npm run server:migrate',
      'systemctl restart first-twenty',
    ].map((c) => {
      const at = calls.indexOf(c)
      expect(at, c).toBeGreaterThan(-1)
      return at
    })
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(outOf(s)).toMatch(/backups\/first-twenty-20261010-170000Z\.dump/)
    expect(outOf(s)).not.toContain('20261010-170001Z') // the unfinished one
  })

  it('stops before migrating when the backup fails, and says how to see why', () => {
    const s = get('backup-fails')
    expect(s).toContain('rc=1')
    const calls = callsOf(s)
    expect(calls).toContain('systemctl start first-twenty-backup')
    expect(migrated(calls)).toBe(false)
    expect(calls).not.toContain('systemctl restart first-twenty')
    expect(outOf(s)).toContain('journalctl -u first-twenty-backup')
    expect(outOf(s)).toMatch(/nothing was migrated/i)
  })

  it('goes on with the checked local dump when only a later step of the backup failed (the S3 copy), and says so', () => {
    const s = get('backup-s3-fails')
    expect(s).toContain('rc=0')
    const calls = callsOf(s)
    const at = (c: string) => calls.indexOf(c)
    expect(at('systemctl start first-twenty-backup')).toBeGreaterThan(-1)
    expect(at('npm run server:migrate')).toBeGreaterThan(at('systemctl start first-twenty-backup'))
    const out = outOf(s)
    expect(out).toMatch(/WARNING: .*backups\/first-twenty-20261010-170000Z\.dump/)
    expect(out).toMatch(/S3/)
    expect(out).toContain('journalctl -u first-twenty-backup')
    expect(out).toContain('Deploy finished.')
  })

  it('stops when the backup service finishes but no new dump appears', () => {
    const s = get('backup-no-file')
    expect(s).toContain('rc=1')
    expect(migrated(callsOf(s))).toBe(false)
    expect(outOf(s)).toMatch(/no new dump/i)
  })

  it('stops when the migration status cannot be read', () => {
    const s = get('status-fails')
    expect(s).toContain('rc=1')
    const calls = callsOf(s)
    expect(migrated(calls)).toBe(false)
    expect(calls).not.toContain('systemctl start first-twenty-backup')
    expect(calls).not.toContain('systemctl restart first-twenty')
  })

  it('names the fresh backup when a migration fails', () => {
    const s = get('migrate-fails')
    expect(s).toContain('rc=1')
    expect(callsOf(s)).not.toContain('systemctl restart first-twenty')
    expect(outOf(s)).toMatch(/backups\/first-twenty-20261010-170000Z\.dump/)
  })

  it('prints the restore steps with the fresh dump when the new server is unhealthy after a migration', () => {
    const out = outOf(get('health-fails-pending'))
    expect(get('health-fails-pending')).toContain('rc=1')
    const hint = out.slice(out.indexOf('ERROR:'))
    expect(hint).toMatch(/install -m 600 -o postgres -g postgres \S*backups\/first-twenty-20261010-170000Z\.dump/)
    const order = RESTORE_ORDER.map((needle) => {
      const at = hint.indexOf(needle)
      expect(at, needle).toBeGreaterThan(-1)
      return at
    })
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('says the database needs no restore when no migration ran', () => {
    const s = get('health-fails-no-pending')
    expect(s).toContain('rc=1')
    expect(outOf(s)).toContain('the database needs no restore')
    expect(outOf(s)).not.toContain('pg_restore')
  })

  it.skipIf(!hasGit)('puts the commit to go back to in the rollback steps', () => {
    const out = outOf(get('health-fails-git'))
    const hint = out.slice(out.indexOf('ERROR:'))
    expect(hint).toMatch(/git checkout [0-9a-f]{7,}/)
    expect(hint).toContain('git switch trunk')
    expect(hint).toContain('pg_restore')
  })

  it('migrates without a fresh backup only when asked to, with a warning', () => {
    const s = get('skip-backup')
    expect(s).toContain('rc=0')
    const calls = callsOf(s)
    expect(calls).not.toContain('systemctl start first-twenty-backup')
    expect(migrated(calls)).toBe(true)
    expect(outOf(s)).toMatch(/WARNING: .*--skip-backup/)
  })

  it("refuses to run outside the service's code folder, before building or migrating", () => {
    const s = get('other-folder')
    expect(s).toContain('rc=1')
    expect(outOf(s)).toContain('cd /opt/first-twenty')
    expect(callsOf(s).filter((c) => c.startsWith('npm '))).toEqual([])
  })

  it('checks Caddy only for an https PUBLIC_ORIGIN, and warns about any other', () => {
    const https = outOf(get('origin-https'))
    expect(https).toContain('Reachable through Caddy at https://hr.test.example/api/health')
    expect(https).not.toContain('PUBLIC_ORIGIN')
    const tunnel = outOf(get('origin-tunnel'))
    expect(tunnel).toMatch(/WARNING: PUBLIC_ORIGIN is http:\/\/localhost:8787, not https:\/\/your-domain/)
    expect(tunnel).not.toContain('Reachable through Caddy')
    expect(outOf(get('origin-placeholder'))).toMatch(/WARNING: PUBLIC_ORIGIN is still the placeholder/)
    expect(outOf(get('ok-no-pending'))).toMatch(/WARNING: PUBLIC_ORIGIN is not set/)
    for (const name of ['origin-https', 'origin-tunnel', 'origin-placeholder']) expect(get(name), name).toContain('rc=0')
  })

  it('skips the folder check with a note when the service is not installed yet', () => {
    const s = get('not-installed')
    expect(s).toContain('rc=0')
    expect(outOf(s)).toMatch(/not installed yet/)
    expect(outOf(s)).toContain('Deploy finished.')
  })
})

/** Stub commands for with-env.sh: id and sudo that emulate root through sudo, runuser, and npm. */
const withEnvStubs = `
mkdir -p "$work/bin" "$work/caller"
cat > "$work/bin/id" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "-u" ]; then
  if [ "$FAKE_ROOT" = 1 ]; then echo 0; else echo 1000; fi
  exit 0
fi
exec /usr/bin/id "$@"
EOF
# sudo: drops the caller's environment like env_reset, applies VAR=value arguments, and sets PATH like
# secure_path (no /usr/local/bin, none of the caller's folders).
cat > "$work/bin/sudo" <<'EOF'
#!/usr/bin/env bash
unset NODE_ENV DATABASE_URL MIGRATION_DATABASE_URL FIRST_TWENTY_ENV FT_CALLER_PATH
while [ $# -gt 0 ] && [ "$1" != "\${1#*=}" ] && [ "\${1%%=*}" = "$(printf '%s' "\${1%%=*}" | tr -cd 'A-Za-z0-9_')" ]; do
  export "$1"; shift
done
export FAKE_ROOT=1 SUDO_USER=alice PATH="$STUB_BIN:/usr/bin:/bin"
exec "$@"
EOF
cat > "$work/bin/runuser" <<'EOF'
#!/usr/bin/env bash
[ "$1" = "-u" ] && shift 2
[ "$1" = "--" ] && shift
exec "$@"
EOF
# npm lives only in the caller's PATH, like /usr/local/bin/npm on Amazon Linux.
cat > "$work/caller/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm-args=$*"
echo "DATABASE_URL=$DATABASE_URL"
echo "MIGRATION_DATABASE_URL=\${MIGRATION_DATABASE_URL-<unset>}"
echo "NODE_ENV=$NODE_ENV"
EOF
chmod +x "$work"/bin/* "$work"/caller/*
export STUB_BIN="$work/bin"
RT='postgres://first_twenty:runtime-test-value@127.0.0.1:5432/first_twenty'
OWNER='postgres://first_twenty_owner:owner-test-value@127.0.0.1:5432/first_twenty'
# filled.env: both filled in; the comment near the top still says CHANGE_ME, as in every real copy.
sed -e "s#^DATABASE_URL=.*#DATABASE_URL=$RT#" -e "s#^MIGRATION_DATABASE_URL=.*#MIGRATION_DATABASE_URL=$OWNER#" "$REPO/.env.example" > "$work/filled.env"
# half.env: the server's password filled in, the owner's not yet.
sed -e "s#^DATABASE_URL=.*#DATABASE_URL=$RT#" "$REPO/.env.example" > "$work/half.env"
# old.env: an install from before the two roles (no MIGRATION_DATABASE_URL line).
grep -v '^MIGRATION_DATABASE_URL=' "$work/filled.env" > "$work/old.env"
run() { # run <env file> <npm args...>
  local file=$1; shift
  echo "--- $file $*"
  rc=0
  FIRST_TWENTY_ENV="$work/$file" PATH="$work/bin:$work/caller:$PATH" bash "$DEPLOY/with-env.sh" npm "$@" 2>"$work/err" || rc=$?
  echo "rc=$rc"
  sed 's/^/err: /' "$work/err"
}
`

/** Splits `run` output into sections keyed by the npm arguments. */
function sections(out: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const part of out.split(/^--- /m).slice(1)) {
    const nl = part.indexOf('\n')
    result[part.slice(0, nl)] = part.slice(nl + 1)
  }
  return result
}

describe.skipIf(!BASH)('with-env.sh', () => {
  let runs: Record<string, string> = {}
  /** One bash run for every case, before them (not inside the first test, under its timeout). */
  beforeAll(() => {
    runs = sections(
      bash(`${prelude}${withEnvStubs}
cp "$REPO/.env.example" "$work/example.env"
run filled.env run server:migrate
run filled.env run server:migrate -- --status
run filled.env run server:after-restore
run filled.env run server:create-admin -- --email you@example.test
run half.env run server:create-admin -- --email you@example.test
run half.env run server:migrate
run old.env run server:migrate
run example.env run server:create-admin -- --email you@example.test
`).stdout,
    )
  }, BASH_TEST_MS)
  /** Each section is keyed "<env file> <npm args>". */
  const result = () => runs

  it('runs migrations and after-restore as the schema owner, through sudo, with the caller PATH', () => {
    for (const key of ['filled.env run server:migrate', 'filled.env run server:migrate -- --status', 'filled.env run server:after-restore']) {
      const s = result()[key]
      expect(s, key).toBeDefined()
      expect(s, key).toContain('rc=0')
      // npm was found although it is only on the caller's PATH, not on sudo's secure_path.
      expect(s, key).toContain(`npm-args=${key.slice('filled.env '.length)}`)
      expect(s, key).toContain('DATABASE_URL=postgres://first_twenty_owner:owner-test-value@')
      expect(s, key).toContain('MIGRATION_DATABASE_URL=<unset>')
      expect(s, key).toContain('NODE_ENV=production')
      expect(s, key).toMatch(/err: Running server:(migrate|after-restore) as the schema owner/)
      expect(s, key).not.toContain('WARNING')
    }
  })

  it("gives every other command the server's role and hides the owner connection from it", () => {
    const s = result()['filled.env run server:create-admin -- --email you@example.test']
    expect(s).toContain('rc=0')
    expect(s).toContain('npm-args=run server:create-admin -- --email you@example.test')
    expect(s).toContain('DATABASE_URL=postgres://first_twenty:runtime-test-value@')
    expect(s).toContain('MIGRATION_DATABASE_URL=<unset>')
    expect(s).not.toContain('err:')
  })

  it('ignores the CHANGE_ME in a comment and in settings the command does not use', () => {
    // half.env: DATABASE_URL filled in; the comment and MIGRATION_DATABASE_URL still say CHANGE_ME.
    const s = result()['half.env run server:create-admin -- --email you@example.test']
    expect(s).toContain('rc=0')
    expect(s).toContain('DATABASE_URL=postgres://first_twenty:runtime-test-value@')
    expect(s).not.toContain('WARNING')
  })

  it('warns when DATABASE_URL itself is still the placeholder', () => {
    const s = result()['example.env run server:create-admin -- --email you@example.test']
    expect(s).toContain('rc=0')
    expect(s).toContain('err: WARNING: DATABASE_URL')
  })

  it('stops a migration whose owner password is still CHANGE_ME, before running anything', () => {
    const s = result()['half.env run server:migrate']
    expect(s).toContain('rc=1')
    expect(s).toContain('err: ERROR: MIGRATION_DATABASE_URL')
    expect(s).not.toContain('npm-args=')
  })

  it('still migrates an install from before the two roles, as the server role, with a note', () => {
    const s = result()['old.env run server:migrate']
    expect(s).toContain('rc=0')
    expect(s).toContain('DATABASE_URL=postgres://first_twenty:runtime-test-value@')
    expect(s).toContain('err: NOTE: MIGRATION_DATABASE_URL is not set')
  })
})

describe.skipIf(!BASH)('setup-ec2.sh', { timeout: BASH_TEST_MS }, () => {
  it('looks for CHANGE_ME only on the active line of the setting it asks about', () => {
    const r = bash(`${prelude}
${shellFunction(script('setup-ec2.sh'), 'env_has_placeholder')}
check() { if env_has_placeholder "$1" "$2"; then echo "$1 $(basename "$2")=yes"; else echo "$1 $(basename "$2")=no"; fi; }
cp "$REPO/.env.example" "$work/example.env"
sed -e 's#^DATABASE_URL=.*#DATABASE_URL=postgres://first_twenty:filled@127.0.0.1:5432/first_twenty#' "$work/example.env" > "$work/half.env"
sed -e 's#^MIGRATION_DATABASE_URL=.*#MIGRATION_DATABASE_URL=postgres://first_twenty_owner:filled@127.0.0.1:5432/first_twenty#' "$work/half.env" > "$work/filled.env"
printf '  export DATABASE_URL="postgres://first_twenty:CHANGE_ME@127.0.0.1/first_twenty"\\n' > "$work/exported.env"
for f in example half filled exported; do
  check DATABASE_URL "$work/$f.env"
  check MIGRATION_DATABASE_URL "$work/$f.env"
done
grep -c CHANGE_ME "$work/filled.env" | sed 's/^/filled-mentions=/'
`)
    expect(r.stderr).toBe('')
    expect(r.stdout).toContain('DATABASE_URL example.env=yes')
    expect(r.stdout).toContain('MIGRATION_DATABASE_URL example.env=yes')
    expect(r.stdout).toContain('DATABASE_URL half.env=no')
    expect(r.stdout).toContain('MIGRATION_DATABASE_URL half.env=yes')
    expect(r.stdout).toContain('DATABASE_URL filled.env=no')
    expect(r.stdout).toContain('MIGRATION_DATABASE_URL filled.env=no')
    expect(r.stdout).toContain('DATABASE_URL exported.env=yes')
    expect(r.stdout).toMatch(/^filled-mentions=[1-9]/m) // the comment still mentions it, and that is fine
  })

  it('starts the service based on DATABASE_URL alone', () => {
    const setup = script('setup-ec2.sh')
    expect(setup).toContain('elif env_has_placeholder DATABASE_URL "$ENV_FILE"; then')
  })

  it('says how to set PUBLIC_ORIGIN when a settings file it kept has another one, and never rewrites the file', () => {
    const setup = script('setup-ec2.sh')
    const r = bash(`${prelude}
${['env_setting', 'public_origin_fix'].map((name) => shellFunction(setup, name)).join('\n')}
DOMAIN=hr-3-14-15-92.sslip.io SERVICE=first-twenty
check() { printf '%s\\n' "$2" > "$work/$1.env"; cp "$work/$1.env" "$work/$1.before"; echo "$1=[$(public_origin_fix "$work/$1.env")]"; cmp -s "$work/$1.env" "$work/$1.before" && echo "$1 unchanged"; }
check same 'PUBLIC_ORIGIN=https://hr-3-14-15-92.sslip.io'
check slash-caps 'PUBLIC_ORIGIN=https://HR-3-14-15-92.sslip.io/'
check quoted 'PUBLIC_ORIGIN="https://hr-3-14-15-92.sslip.io"'
check tunnel "$(printf 'PUBLIC_ORIGIN=https://hr-3-14-15-92.sslip.io\\nPUBLIC_ORIGIN=http://localhost:8787')"
check old-ip 'PUBLIC_ORIGIN=https://hr-2-71-82-81.sslip.io'
check commented '# PUBLIC_ORIGIN=https://hr-3-14-15-92.sslip.io'
# The printed command does what it says (GNU sed, as on the instance).
printf 'PORT=8787\\nPUBLIC_ORIGIN=http://localhost:8787\\n' > "$work/apply.env"
cmd=$(public_origin_fix "$work/apply.env")
cmd=\${cmd% && sudo systemctl restart first-twenty}
eval "\${cmd#sudo }"
echo "applied=[$(public_origin_fix "$work/apply.env")] $(grep -c . "$work/apply.env") lines"
`)
    expect(r.stderr).toBe('')
    for (const name of ['same', 'slash-caps', 'quoted']) expect(r.stdout, name).toContain(`${name}=[]`)
    // The last active line wins, as when systemd reads the file.
    expect(r.stdout).toMatch(/^tunnel=\[sudo sed -i -E 's#.*#PUBLIC_ORIGIN=https:\/\/hr-3-14-15-92\.sslip\.io#' \S+tunnel\.env && sudo systemctl restart first-twenty\]$/m)
    expect(r.stdout).toMatch(/^old-ip=\[sudo sed /m)
    expect(r.stdout).toMatch(/^commented=\[echo 'PUBLIC_ORIGIN=https:\/\/hr-3-14-15-92\.sslip\.io' \| sudo tee -a \S+commented\.env/m)
    for (const name of ['same', 'tunnel', 'old-ip', 'commented']) expect(r.stdout, name).toContain(`${name} unchanged`)
    expect(r.stdout).toContain('applied=[] 2 lines')
    // Setup warns in step 7 and repeats it in the next steps.
    expect(setup).toContain('ORIGIN_FIX=$(public_origin_fix "$ENV_FILE")')
    const next = bash(`${prelude}
${shellFunction(setup, 'next_steps')}
APP_DIR=/opt/first-twenty ENV_FILE=/etc/first-twenty/env DEPLOY_USER=ubuntu SERVICE=first-twenty DOMAIN=hr.example.com DB_STATE='t|t|t'
echo "--- none"; ORIGIN_FIX= next_steps
echo "--- fix"; ORIGIN_FIX='sudo sed -i -E example' next_steps
`)
    const out = sections(next.stdout)
    expect(out.none).not.toContain('PUBLIC_ORIGIN')
    expect(out.fix).toContain('PUBLIC_ORIGIN in /etc/first-twenty/env is not https://hr.example.com yet')
    expect(out.fix).toContain('sudo sed -i -E example')
  })

  it('renders both site blocks for the domain, and leaves the global options out of a file another Caddyfile imports', () => {
    const setup = script('setup-ec2.sh')
    const r = bash(`${prelude}
${shellFunction(setup, 'render_caddyfile')}
MARKER='# Managed by First Twenty setup-ec2.sh. Re-running the script rewrites this file.'
DOMAIN=hr-3-14-15-92.sslip.io
echo "--- main"; ACME_EMAIL= render_caddyfile "$DEPLOY/Caddyfile"
echo "--- imported"; ACME_EMAIL=ops@example.test render_caddyfile "$DEPLOY/Caddyfile" site-only
`)
    expect(r.stderr).toBe('')
    const out = sections(r.stdout)
    expect(out.main.startsWith('# Managed by First Twenty setup-ec2.sh.')).toBe(true)
    for (const s of [out.main, out.imported]) {
      expect(s).toMatch(/^http:\/\/hr-3-14-15-92\.sslip\.io \{$/m)
      expect(s).toMatch(/^hr-3-14-15-92\.sslip\.io \{$/m)
      expect(s).not.toContain('hr.example.com {')
    }
    expect(out.main).toMatch(/^\{\n\tservers \{$/m)
    expect(out.main).toContain('read_header')
    expect(out.main).toMatch(/^\s*# tls you@example\.com$/m)
    expect(out.imported).not.toMatch(/^\{$/m)
    expect(out.imported).not.toContain('read_header')
    expect(out.imported).toMatch(/^\ttls ops@example\.test$/m)
    // Setup picks the file before rendering, and warns about the timeouts when it is not the main one.
    expect(setup.indexOf('TARGET=/etc/caddy/first-twenty.caddy')).toBeLessThan(setup.indexOf('render_caddyfile "$CADDY_SRC" site-only'))
    expect(setup).toContain('Caddy reads global options only from the top of $CADDYFILE')
    // Without careers domains, no careers site and no template.
    for (const s of [out.main, out.imported]) {
      expect(s).not.toMatch(/^(http:\/\/)?careers\.example\.com \{$/m)
      expect(s).not.toMatch(/^# (BEGIN|END) careers site$/m)
      expect(s).not.toContain('max_size 64KB')
    }
  })

  it('renders one careers site per careers domain, after the app, with the tls line in every site', () => {
    const setup = script('setup-ec2.sh')
    const r = bash(`${prelude}
${shellFunction(setup, 'render_caddyfile')}
MARKER='# Managed by First Twenty setup-ec2.sh. Re-running the script rewrites this file.'
DOMAIN=hr-3-14-15-92.sslip.io
CAREERS_DOMAINS='careers-3-14-15-92.sslip.io jobs-3-14-15-92.sslip.io'
echo "--- main"; ACME_EMAIL=ops@example.test render_caddyfile "$DEPLOY/Caddyfile"
echo "--- imported"; ACME_EMAIL= render_caddyfile "$DEPLOY/Caddyfile" site-only
`)
    expect(r.stderr).toBe('')
    const out = sections(r.stdout)
    for (const s of [out.main, out.imported]) {
      expect(s).not.toContain('example.com {')
      expect(s).not.toMatch(/^# (BEGIN|END) careers site$/m)
      for (const host of ['careers-3-14-15-92.sslip.io', 'jobs-3-14-15-92.sslip.io']) {
        const esc = host.replace(/\./g, '\\.')
        expect(s.match(new RegExp(`^http://${esc} \\{\\n\\tredir https://\\{host\\}\\{uri\\} permanent\\n\\}$`, 'gm'))?.length, host).toBe(1)
        expect(s.match(new RegExp(`^${esc} \\{$`, 'gm'))?.length, host).toBe(1)
      }
      // Both careers sites come after the app's, each proxied with the app's headers and its own small limit.
      expect(s.indexOf('hr-3-14-15-92.sslip.io {')).toBeLessThan(s.indexOf('careers-3-14-15-92.sslip.io {'))
      expect(s.indexOf('careers-3-14-15-92.sslip.io {')).toBeLessThan(s.indexOf('jobs-3-14-15-92.sslip.io {'))
      expect(s.match(/^\treverse_proxy 127\.0\.0\.1:8787 \{$/gm)?.length).toBe(3)
      expect(s.match(/^\theader -Set-Cookie$/gm)?.length).toBe(2)
      expect(s.match(/^\t\tmax_size 64KB$/gm)?.length).toBe(2)
      expect(s.match(/^\t\tmax_size 12MB$/gm)?.length).toBe(1)
      // Every brace opened is closed, and no HSTS covers other hosts (comments aside).
      const code = s
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('#'))
        .join('\n')
      expect(code).not.toMatch(/includeSubDomains/i)
      expect((code.match(/\{/g) ?? []).length).toBe((code.match(/\}/g) ?? []).length)
    }
    expect(out.main.match(/^\ttls ops@example\.test$/gm)?.length).toBe(3)
    expect(out.imported).not.toMatch(/^\ttls /m)
    expect(out.imported).not.toContain('read_header')
  })

  it('takes --careers-domain more than once, normalized and once each, and never the app domain', () => {
    const setup = script('setup-ec2.sh')
    const r = bash(`${prelude}
die() { echo "die: $*"; exit 1; }
${['normalize_domain', 'is_domain', 'add_careers_domain'].map((name) => shellFunction(setup, name)).join('\n')}
CAREERS_DOMAINS=''
add_careers_domain 'Careers-3-14-15-92.sslip.io'
add_careers_domain 'https://jobs-3-14-15-92.sslip.io/'
add_careers_domain 'careers-3-14-15-92.sslip.io'
echo "list=[$CAREERS_DOMAINS]"
for bad in 'not a host' 'careers' 'careers.example.com:8443' '-x.example.com'; do (add_careers_domain "$bad") || true; done
`)
    expect(r.stderr).toBe('')
    expect(r.stdout).toContain('list=[careers-3-14-15-92.sslip.io jobs-3-14-15-92.sslip.io]')
    expect(r.stdout.match(/^die: .* does not look like a host name for --careers-domain/gm)?.length).toBe(4)
    expect(setup).toContain('--careers-domain) need_value "$1" "${2:-}"; add_careers_domain "$2"; shift 2 ;;')
    expect(setup).toContain('--careers-domain=*) add_careers_domain "${1#*=}"; shift ;;')
    expect(setup).toContain('--careers-domain $d is the app\'s own domain.')
    // Each careers domain gets the DNS check the app's domain gets.
    expect(setup).toContain('for name in "$DOMAIN" $CAREERS_DOMAINS; do')
  })

  it('turns CAREERS_HOSTS on in a new settings file, and says how to set it in one it kept', () => {
    const setup = script('setup-ec2.sh')
    const r = bash(`${prelude}
${['env_setting', 'careers_from_settings', 'host_set', 'set_careers_hosts', 'careers_hosts_fix'].map((name) => shellFunction(setup, name)).join('\n')}
SERVICE=first-twenty
CAREERS_DOMAINS='careers-3-14-15-92.sslip.io jobs-3-14-15-92.sslip.io'
cp "$REPO/.env.example" "$work/new.env"
set_careers_hosts "$work/new.env"
grep -c '^CAREERS_HOSTS=' "$work/new.env" | sed 's/^/active=/'
grep -c 'CAREERS_HOSTS=' "$work/new.env" | sed 's/^/all=/'
printf 'PORT=8787\\n' > "$work/none.env"; set_careers_hosts "$work/none.env"; echo "appended=[$(env_setting CAREERS_HOSTS "$work/none.env")]"
check() { printf '%s\\n' "$2" > "$work/$1.env"; cp "$work/$1.env" "$work/$1.before"; echo "$1=[$(careers_hosts_fix "$work/$1.env")]"; cmp -s "$work/$1.env" "$work/$1.before" && echo "$1 unchanged"; }
check same 'CAREERS_HOSTS=careers-3-14-15-92.sslip.io,jobs-3-14-15-92.sslip.io'
check reordered 'CAREERS_HOSTS="JOBS-3-14-15-92.sslip.io, careers-3-14-15-92.sslip.io"'
check other 'CAREERS_HOSTS=careers-2-71-82-81.sslip.io'
check commented '# CAREERS_HOSTS=careers.example.com'
echo "read=[$(careers_from_settings "$work/reordered.env")]"
CAREERS_DOMAINS='' check off 'CAREERS_HOSTS=careers.example.com'
# The printed command does what it says (GNU sed, as on the instance).
printf 'PORT=8787\\nCAREERS_HOSTS=old.example.com\\n' > "$work/apply.env"
cmd=$(careers_hosts_fix "$work/apply.env")
cmd=\${cmd% && sudo systemctl restart first-twenty}
eval "\${cmd#sudo }"
echo "applied=[$(careers_hosts_fix "$work/apply.env")] $(env_setting CAREERS_HOSTS "$work/apply.env")"
`)
    expect(r.stderr).toBe('')
    expect(r.stdout).toContain('active=1')
    expect(r.stdout).toContain('all=1')
    expect(r.stdout).toContain('appended=[careers-3-14-15-92.sslip.io,jobs-3-14-15-92.sslip.io]')
    const env = parseDotEnv(bash(`${prelude}
${['set_careers_hosts'].map((name) => shellFunction(setup, name)).join('\n')}
CAREERS_DOMAINS='careers-3-14-15-92.sslip.io jobs-3-14-15-92.sslip.io'
cp "$REPO/.env.example" "$work/e.env"; set_careers_hosts "$work/e.env"; cat "$work/e.env"
`).stdout)
    expect(env.CAREERS_HOSTS).toBe('careers-3-14-15-92.sslip.io,jobs-3-14-15-92.sslip.io')
    for (const name of ['same', 'reordered']) expect(r.stdout, name).toContain(`${name}=[]`)
    expect(r.stdout).toContain('off=[]')
    expect(r.stdout).toMatch(/^other=\[sudo sed -i -E 's#.*#CAREERS_HOSTS=careers-3-14-15-92\.sslip\.io,jobs-3-14-15-92\.sslip\.io#' \S+other\.env && sudo systemctl restart first-twenty\]$/m)
    expect(r.stdout).toMatch(/^commented=\[echo 'CAREERS_HOSTS=careers-3-14-15-92\.sslip\.io,jobs-3-14-15-92\.sslip\.io' \| sudo tee -a \S+commented\.env/m)
    for (const name of ['same', 'reordered', 'other', 'commented']) expect(r.stdout, name).toContain(`${name} unchanged`)
    expect(r.stdout).toContain('read=[jobs-3-14-15-92.sslip.io careers-3-14-15-92.sslip.io]')
    expect(r.stdout).toContain('applied=[] careers-3-14-15-92.sslip.io,jobs-3-14-15-92.sslip.io')
    // A re-run without --careers-domain keeps the sites CAREERS_HOSTS names, decided before Caddy is configured.
    expect(setup.indexOf('for d in $(careers_from_settings "$ENV_FILE"); do')).toBeGreaterThan(0)
    expect(setup.indexOf('for d in $(careers_from_settings "$ENV_FILE"); do')).toBeLessThan(setup.indexOf('render_caddyfile "$CADDY_SRC"'))
    expect(setup).toContain('CAREERS_FIX=$(careers_hosts_fix "$ENV_FILE")')
  })

  it('names the careers address in the next steps, and how to fix CAREERS_HOSTS when setup could not', () => {
    const setup = script('setup-ec2.sh')
    const next = bash(`${prelude}
${shellFunction(setup, 'next_steps')}
APP_DIR=/opt/first-twenty ENV_FILE=/etc/first-twenty/env DEPLOY_USER=ubuntu SERVICE=first-twenty DOMAIN=hr.example.com DB_STATE='t|t|t' ORIGIN_FIX=
echo "--- none"; next_steps
echo "--- careers"; CAREERS_DOMAINS='careers.example.com jobs.example.com' next_steps
echo "--- fix"; CAREERS_DOMAINS='careers.example.com' CAREERS_FIX='sudo sed -i -E careers-example' next_steps
`)
    expect(next.stderr).toBe('')
    const out = sections(next.stdout)
    expect(out.none).not.toMatch(/careers/i)
    expect(out.careers).toContain('https://careers.example.com/<its slug>/')
    expect(out.careers).toContain('curl -I https://careers.example.com/')
    expect(out.careers).not.toContain('CAREERS_HOSTS')
    expect(out.fix).toContain('CAREERS_HOSTS in /etc/first-twenty/env does not name careers.example.com yet')
    expect(out.fix).toContain('sudo sed -i -E careers-example')
  })

  it('lets unattended-upgrades install Node.js from NodeSource and reboot after the backup, and writes that only once', () => {
    const setup = script('setup-ec2.sh')
    const r = bash(`${prelude}
${shellFunction(setup, 'unattended_upgrades_conf')}
unattended_upgrades_conf
`)
    expect(r.stderr).toBe('')
    expect(r.stdout).toMatch(/^Unattended-Upgrade::Origins-Pattern \{\n\t"site=deb\.nodesource\.com";\n\};$/m)
    expect(r.stdout).toContain('Unattended-Upgrade::Automatic-Reboot "true";')
    // After the nightly backup at 03:15.
    expect(r.stdout).toContain('Unattended-Upgrade::Automatic-Reboot-Time "04:30";')
    expect(read('server/deploy/first-twenty-backup.timer')).toMatch(/OnCalendar=\*-\*-\* 03:15/)
    expect(setup).toContain('UNATTENDED_CONF=/etc/apt/apt.conf.d/51first-twenty')
    expect(setup).toMatch(/if \[ -f "\$UNATTENDED_CONF" \]; then\n\s+info "Kept the existing/)
    expect(setup).toContain('apt_install unattended-upgrades')
  })
})

describe.skipIf(!BASH)('setup-ec2.sh swap file', () => {
  const setup = script('setup-ec2.sh')
  const functions = () =>
    [
      'step',
      'info',
      'warn',
      'die',
      'low_memory',
      'choose_swap',
      'swap_bytes',
      'human_size',
      'free_bytes',
      'swap_fits',
      'has_swap_signature',
      'remove_partial_swapfile',
      'make_swapfile',
      'ensure_fstab',
      'setup_swap',
    ]
      .map((name) => shellFunction(setup, name))
      .join('\n')

  let runs: Record<string, string> = {}
  beforeAll(() => {
    // Stubs for the disk and swap tools; the swap file and fstab live in the scratch folder.
    // mkswap writes SWAPSPACE2 into the file, the signature blkid looks for.
    const r = bash(`${prelude}${functions()}
mkdir -p "$work/bin" "$work/root"
export CALLS="$work/calls"
SWAPFILE="$work/root/swapfile"
FSTAB="$work/fstab"
SWAP_MARGIN_BYTES=$((1024 * 1024 * 1024))
GIB=$((1024 * 1024 * 1024))
: > "$FSTAB"
stub() { printf '#!/usr/bin/env bash\\n%s\\n' "$2" > "$work/bin/$1"; }
stub df 'echo "    Avail"; echo "$FAKE_AVAIL"'
stub fallocate 'echo "fallocate $*" >> "$CALLS"; [ "$FAKE_FALLOCATE" = fail ] && exit 1; printf data > "$3"'
stub dd 'echo "dd $*" >> "$CALLS"; for a in "$@"; do case "$a" in of=*) out=$(printf %s "$a" | cut -c4-) ;; esac; done; printf zeros > "$out"; if [ "$FAKE_DD" = fail ]; then echo "dd: error writing: No space left on device" >&2; exit 1; fi'
stub mkswap 'echo "mkswap $*" >> "$CALLS"; [ "$FAKE_MKSWAP" = fail ] && exit 1; printf SWAPSPACE2 >> "$1"'
stub blkid 'for f in "$@"; do :; done; if grep SWAPSPACE2 "$f" >/dev/null 2>&1; then echo swap; else exit 2; fi'
stub file 'echo data'
stub swapon 'if [ "$1" = --show=NAME ]; then [ -z "$FAKE_ACTIVE" ] || echo "$FAKE_ACTIVE"; exit 0; fi; echo "swapon $*" >> "$CALLS"; [ "$FAKE_SWAPON" = fail ] && exit 1; exit 0'
stub swapoff 'echo "swapoff $*" >> "$CALLS"; exit 0'
chmod +x "$work"/bin/*
export PATH="$work/bin:$PATH"
swap_case() { # swap_case <name> <SWAP_SIZE> <SWAP_AUTO> "<VAR=value ...>"
  local name=$1 size=$2 auto=$3 vars=$4
  echo "--- $name"
  : > "$CALLS"
  set +e
  (
    set -e
    export FAKE_AVAIL=$((17 * GIB)) FAKE_ACTIVE= FAKE_FALLOCATE=ok FAKE_DD=ok FAKE_MKSWAP=ok FAKE_SWAPON=ok $vars
    SWAP_SIZE=$size
    SWAP_AUTO=$auto
    setup_swap
  ) > "$work/out" 2>&1
  rc=$?
  set -e
  echo "rc=$rc"
  if [ -e "$SWAPFILE" ]; then echo "swapfile=present"; else echo "swapfile=absent"; fi
  echo "fstab-lines=$(grep -c . "$FSTAB" || true)"
  sed 's/^/out: /' "$work/out"
  sed 's/^/call: /' "$CALLS"
}
swap_case explicit-no-room 2G false "FAKE_AVAIL=$((5 * GIB / 2))"
swap_case auto-no-room 2G true "FAKE_AVAIL=$((5 * GIB / 2))"
swap_case dd-fails 2G false 'FAKE_FALLOCATE=fail FAKE_DD=fail'
swap_case mkswap-fails 2G false 'FAKE_MKSWAP=fail'
swap_case swapon-fails 2G false 'FAKE_SWAPON=fail'
swap_case fresh 2G false ''
swap_case rerun-active 2G false "FAKE_ACTIVE=$SWAPFILE"
rm -f "$SWAPFILE"; : > "$FSTAB"
printf zeros > "$SWAPFILE"
swap_case leftover-unsigned 2G false ''
rm -f "$SWAPFILE"; : > "$FSTAB"
printf SWAPSPACE2 > "$SWAPFILE"
swap_case leftover-signed 2G false ''
rm -f "$SWAPFILE"; : > "$FSTAB"
printf zeros > "$SWAPFILE"
swap_case leftover-no-room 2G false "FAKE_AVAIL=$GIB"
rm -f "$SWAPFILE"; : > "$FSTAB"
swap_case other-swap-active 2G true 'FAKE_ACTIVE=/dev/nvme0n1p3'
echo "--- choose"
for args in '949000 false ""' '3900000 false ""' '949000 true ""' '949000 false 1G'; do
  eval "set -- $args"
  MEM_KB=$1 NO_SWAP=$2 SWAP_SIZE=$3 SWAP_AUTO=false
  choose_swap
  echo "mem=$1 no-swap=$2 given=[$3] -> size=[$SWAP_SIZE] auto=$SWAP_AUTO"
done
`)
    runs = sections(r.stdout)
    expect(r.stderr).toBe('')
  }, BASH_TEST_MS)

  const get = (name: string) => {
    const s = runs[name]
    expect(s, name).toBeDefined()
    return s
  }
  const calls = (name: string) => callsOf(get(name))

  it('defaults to a 2G swap file under 2 GB of memory, unless --swap or --no-swap says otherwise', () => {
    const s = get('choose')
    expect(s).toContain('mem=949000 no-swap=false given=[] -> size=[2G] auto=true')
    expect(s).toContain('mem=3900000 no-swap=false given=[] -> size=[] auto=false')
    expect(s).toContain('mem=949000 no-swap=true given=[] -> size=[] auto=false')
    expect(s).toContain('mem=949000 no-swap=false given=[1G] -> size=[1G] auto=false')
  })

  it('refuses an asked-for swap file that would leave less than 1 GB free, before writing anything', () => {
    const s = get('explicit-no-room')
    expect(s).toContain('rc=1')
    expect(s).toContain('swapfile=absent')
    expect(outOf(s)).toMatch(/ERROR: .*not enough free disk space/i)
    expect(outOf(s)).toContain('2.5 GB free')
    expect(calls('explicit-no-room')).toEqual([])
  })

  it('skips the automatic swap file with a warning when the disk is short', () => {
    const s = get('auto-no-room')
    expect(s).toContain('rc=0')
    expect(s).toContain('swapfile=absent')
    expect(s).toContain('fstab-lines=0')
    expect(outOf(s)).toMatch(/WARNING: Skipped the swap file/)
    expect(calls('auto-no-room')).toEqual([])
  })

  it('removes the unfinished swap file when any step fails', () => {
    for (const name of ['dd-fails', 'mkswap-fails', 'swapon-fails']) {
      const s = get(name)
      expect(s, name).not.toContain('rc=0')
      expect(s, name).toContain('swapfile=absent')
      expect(s, name).toContain('fstab-lines=0')
    }
    expect(calls('dd-fails').some((c) => c.startsWith('dd '))).toBe(true)
  })

  it('makes, turns on and registers a swap file once, and leaves it alone on a re-run', () => {
    const s = get('fresh')
    expect(s).toContain('rc=0')
    expect(s).toContain('swapfile=present')
    expect(s).toContain('fstab-lines=1')
    expect(calls('fresh').map((c) => c.split(' ')[0])).toEqual(['fallocate', 'mkswap', 'swapon'])
    const again = get('rerun-active')
    expect(again).toContain('rc=0')
    expect(again).toContain('fstab-lines=1')
    expect(calls('rerun-active')).toEqual([])
  })

  it('remakes a leftover file that never became swap instead of trying to turn it on', () => {
    const s = get('leftover-unsigned')
    expect(s).toContain('rc=0')
    expect(s).toContain('swapfile=present')
    expect(calls('leftover-unsigned').map((c) => c.split(' ')[0])).toEqual(['fallocate', 'mkswap', 'swapon'])
  })

  it('turns on a leftover file that is already swap', () => {
    const s = get('leftover-signed')
    expect(s).toContain('rc=0')
    expect(s).toContain('fstab-lines=1')
    expect(calls('leftover-signed').map((c) => c.split(' ')[0])).toEqual(['swapon'])
  })

  it('does not count a leftover file as free space it could reuse', () => {
    const s = get('leftover-no-room')
    expect(s).toContain('rc=1')
    expect(s).toContain('swapfile=absent')
    expect(calls('leftover-no-room')).toEqual([])
  })

  it('adds no fstab line for a swap file it did not make', () => {
    const s = get('other-swap-active')
    expect(s).toContain('rc=0')
    expect(s).toContain('fstab-lines=0')
    expect(calls('other-swap-active')).toEqual([])
  })
})

describe.skipIf(!BASH)('setup-ec2.sh Caddy on Ubuntu', () => {
  const setup = script('setup-ec2.sh')
  const functions = () =>
    ['step', 'info', 'warn', 'die', 'fetch', 'apt_update', 'apt_install', 'caddy_version', 'install_caddy_release', 'install_caddy_apt']
      .map((name) => shellFunction(setup, name))
      .join('\n')

  let runs: Record<string, string> = {}
  beforeAll(() => {
    // Stubs for curl, gpg, apt and dpkg. Once the repository list exists, apt-get update fails with
    // FAKE_REPO=402 (what Cloudsmith answered in October 2026) and the install fails with
    // FAKE_REPO=install-fails. The GitHub release downloads fail with FAKE_GH=fail; FAKE_SUMS=bad gives a
    // checksum file with the wrong SHA-512 and FAKE_SUMS=missing one without the package's line. Ubuntu's
    // own package is there unless FAKE_CANDIDATE says (none). sha512sum is the real one.
    const r = bash(`${prelude}${functions()}
mkdir -p "$work/bin"
export CALLS="$work/calls"
CADDY_LIST="$work/caddy-stable.list"
CADDY_KEYRING="$work/caddy.gpg"
CADDY_VERSION=2.11.4
OS_VERSION=24.04
export CADDY_LIST
stub() { printf '#!/usr/bin/env bash\\n%s\\n' "$2" > "$work/bin/$1"; }
stub curl 'out=; url=; while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; https://*) url=$1 ;; esac; shift; done
echo "curl $url" >> "$CALLS"
case "$url" in
  https://github.com/*)
    [ "$FAKE_GH" = fail ] && exit 22
    case "$url" in
      *.deb) printf DEBDATA > "$out" ;;
      *checksums.txt)
        sum=$(printf DEBDATA | sha512sum | cut -d" " -f1)
        [ "$FAKE_SUMS" = bad ] && sum=$(printf OTHER | sha512sum | cut -d" " -f1)
        name=$(basename "$url" | sed "s/_checksums.txt$/_linux_amd64.deb/")
        [ "$FAKE_SUMS" = missing ] && name=caddy_other_linux_amd64.deb
        printf "%s  %s\\n%s  caddy_x_linux_arm64.deb\\n" "$sum" "$name" "$sum" > "$out" ;;
    esac ;;
  *)
    [ "$FAKE_CURL" = fail ] && exit 22
    if [ -n "$out" ]; then echo "deb repo" > "$out"; else echo KEY; fi ;;
esac'
stub gpg 'out=; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done; cat > "$out"'
stub apt-get 'echo "apt-get $*" >> "$CALLS"; if [ -f "$CADDY_LIST" ]; then case "$*:$FAKE_REPO" in *update*:402) echo "E: The repository is not signed." >&2; exit 100 ;; *install*:install-fails) exit 100 ;; esac; fi; exit 0'
stub apt-cache 'echo "caddy:"; echo "  Installed: (none)"; echo "  Candidate: $FAKE_CANDIDATE"'
stub dpkg 'if [ "$1" = --print-architecture ]; then echo amd64; exit 0; fi; for a in "$@"; do last=$a; done; echo "dpkg $1 $2 $(basename "$last") $(cat "$last")" >> "$CALLS"; [ "$FAKE_DPKG" = fail ] && exit 1; exit 0'
chmod +x "$work"/bin/*
export PATH="$work/bin:$PATH"
caddy_case() { # caddy_case <name> "<VAR=value ...>"
  echo "--- $1"
  : > "$CALLS"
  rm -f "$CADDY_LIST" "$CADDY_KEYRING"
  set +e
  (
    set -e
    export FAKE_REPO=ok FAKE_CURL=ok FAKE_GH=ok FAKE_SUMS=ok FAKE_DPKG=ok FAKE_CANDIDATE=2.6.2-6ubuntu0.24.04.3 $2
    APT_UPDATED=false
    install_caddy_apt
  ) > "$work/out" 2>&1
  rc=$?
  set -e
  echo "rc=$rc"
  if [ -e "$CADDY_LIST" ]; then echo "list=present"; else echo "list=absent"; fi
  if [ -e "$CADDY_KEYRING" ]; then echo "keyring=present"; else echo "keyring=absent"; fi
  sed 's/^/out: /' "$work/out"
  sed 's/^/call: /' "$CALLS"
}
caddy_case repo-ok ''
caddy_case repo-402 'FAKE_REPO=402'
caddy_case repo-install-fails 'FAKE_REPO=install-fails'
caddy_case key-download-fails 'FAKE_CURL=fail'
caddy_case release-bad-checksum 'FAKE_REPO=402 FAKE_SUMS=bad'
caddy_case release-not-in-checksums 'FAKE_REPO=402 FAKE_SUMS=missing'
caddy_case release-download-fails 'FAKE_REPO=402 FAKE_GH=fail'
caddy_case release-dpkg-fails 'FAKE_REPO=402 FAKE_DPKG=fail'
caddy_case nothing-works 'FAKE_REPO=402 FAKE_GH=fail FAKE_CANDIDATE=(none)'
echo "--- version"
stub caddy 'echo "v2.6.2 h1:abc="'
chmod +x "$work/bin/caddy"
echo "have=[$(caddy_version)]"
rm "$work/bin/caddy"
PATH="$work/bin:/usr/bin:/bin" bash -c "$(declare -f caddy_version); command -v caddy >/dev/null 2>&1 && echo has-system-caddy || echo none=[\\$(caddy_version)]"
`)
    runs = sections(r.stdout)
    expect(r.stderr).toBe('')
  }, BASH_TEST_MS)

  const get = (name: string) => {
    const s = runs[name]
    expect(s, name).toBeDefined()
    return s
  }
  const calls = (name: string) => callsOf(get(name))
  const aptInstalls = (name: string) => calls(name).filter((c) => /^apt-get install /.test(c))
  const dpkgInstalls = (name: string) => calls(name).filter((c) => c.startsWith('dpkg -i'))
  const github = (name: string) => calls(name).filter((c) => c.startsWith('curl https://github.com/'))

  it("installs from Caddy's own repository when it works, and keeps it", () => {
    const s = get('repo-ok')
    expect(s).toContain('rc=0')
    expect(s).toContain('list=present')
    expect(s).not.toContain('WARNING')
    expect(calls('repo-ok').filter((c) => c.startsWith('apt-get update'))).toHaveLength(1)
    expect(aptInstalls('repo-ok')).toHaveLength(1)
    expect(aptInstalls('repo-ok')[0]).toMatch(/ caddy$/)
    expect(github('repo-ok')).toHaveLength(0)
    expect(dpkgInstalls('repo-ok')).toHaveLength(0)
  })

  it('falls back to the checksum-checked release package and removes a repository it cannot use', () => {
    for (const name of ['repo-402', 'repo-install-fails', 'key-download-fails']) {
      const s = get(name)
      expect(s, name).toContain('rc=0')
      expect(s, name).toContain('list=absent')
      expect(s, name).toContain('keyring=absent')
      expect(s, name).toContain('Installed Caddy 2.11.4 from its GitHub release (SHA-512 checked).')
      expect(github(name), name).toEqual([
        'curl https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_linux_amd64.deb',
        'curl https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_checksums.txt',
      ])
      // The downloaded bytes are what dpkg installs, keeping an existing Caddyfile.
      expect(dpkgInstalls(name), name).toEqual(['dpkg -i --force-confold caddy_2.11.4_linux_amd64.deb DEBDATA'])
      // apt-get update ran without the repository before the release was tried.
      expect(calls(name).at(-4), name).toMatch(/^apt-get update/)
    }
    expect(aptInstalls('repo-402')).toHaveLength(0)
    expect(aptInstalls('repo-install-fails')).toHaveLength(1) // the attempt from the repository
    expect(aptInstalls('key-download-fails')).toHaveLength(0)
  })

  it("never installs a release package that fails its checksum, and falls back to Ubuntu's caddy", () => {
    for (const name of ['release-bad-checksum', 'release-not-in-checksums', 'release-download-fails', 'release-dpkg-fails']) {
      const s = get(name)
      expect(s, name).toContain('rc=0')
      expect(s, name).toContain('list=absent')
      expect(s, name).toContain("Installing Ubuntu's caddy package.")
      expect(calls(name).at(-1), name).toMatch(/^apt-get install .* caddy$/)
    }
    expect(dpkgInstalls('release-bad-checksum')).toHaveLength(0)
    expect(get('release-bad-checksum')).toContain('does not match the SHA-512')
    expect(dpkgInstalls('release-not-in-checksums')).toHaveLength(0)
    expect(dpkgInstalls('release-download-fails')).toHaveLength(0)
    expect(dpkgInstalls('release-dpkg-fails')).toHaveLength(1)
  })

  it('stops with the manual install link when nothing can install Caddy', () => {
    const s = get('nothing-works')
    expect(s).toContain('rc=1')
    expect(s).toContain('list=absent')
    expect(s).toContain('has no caddy package either')
    expect(s).toContain('https://caddyserver.com/docs/install')
    expect(aptInstalls('nothing-works')).toHaveLength(0)
    expect(dpkgInstalls('nothing-works')).toHaveLength(0)
  })

  it('reads the installed Caddy version, and replaces one older than CADDY_VERSION on Ubuntu', () => {
    const v = get('version')
    expect(v).toContain('have=[2.6.2]')
    expect(v).toMatch(/none=\[\]|has-system-caddy/)
    expect(setup).toMatch(/^CADDY_VERSION=\$\{CADDY_VERSION:-2\.11\.4\}$/m)
    expect(setup).toContain('dpkg --compare-versions "$CADDY_HAVE" lt "$CADDY_VERSION"')
  })

  it('makes systemd restart Caddy after a crash, before it enables and starts it', () => {
    const dropin = shellFunction(setup, 'caddy_dropin')
    expect(dropin).toMatch(/^\[Unit\]\nStartLimitIntervalSec=0$/m)
    expect(dropin).toMatch(/^\[Service\]\nRestart=on-failure\nRestartSec=5$/m)
    const written = setup.indexOf('caddy_dropin >"$CADDY_DROPIN"')
    expect(written).toBeGreaterThan(0)
    expect(written).toBeLessThan(setup.indexOf('systemctl enable --quiet caddy'))
    expect(setup).toMatch(/CADDY_DROPIN=\/etc\/systemd\/system\/caddy\.service\.d\/10-first-twenty\.conf/)
  })
})

describe.skipIf(!BASH)('setup-ec2.sh and an existing database', { timeout: BASH_TEST_MS }, () => {
  const setup = script('setup-ec2.sh')

  it('never creates, changes or drops a database or role', () => {
    expect(setup).not.toMatch(/\b(CREATE|ALTER|DROP)\s+(ROLE|USER|DATABASE)\b/i)
    expect(setup).not.toMatch(/\b(createdb|createuser|dropdb|dropuser|pg_restore)\b/)
    expect(setup).not.toContain('\\password')
    // Every psql it runs (outside the text it prints) only reads.
    const lines = setup.split('\n')
    let inHeredoc: string | null = null
    const runs: string[] = []
    for (const line of lines) {
      if (inHeredoc) {
        if (line === inHeredoc) inHeredoc = null
        continue
      }
      const start = /<<-?'?([A-Z_]+)'?/.exec(line)
      if (start) inHeredoc = start[1]
      const code = line.trim()
      if (code.startsWith('#') || /^(info|warn|die|echo|printf) /.test(code)) continue
      if (/\bpsql\b/.test(code) && !/command -v psql/.test(code)) runs.push(code)
    }
    expect(runs.length).toBeGreaterThan(0)
    for (const run of runs) expect(run, run).toMatch(/psql -XAtq[a-z]* "?'?(SHOW|SELECT) /)
  })

  it('reads which of the first_twenty database and roles exist, as postgres, read-only', () => {
    const r = bash(`${prelude}
${shellFunction(setup, 'first_twenty_objects')}
mkdir -p "$work/bin"
export LOG="$work/psql-args"
stub() { printf '#!/usr/bin/env bash\\n%s\\n' "$2" > "$work/bin/$1"; }
stub psql 'printf "%s\\n" "$*" >> "$LOG"; [ -n "$FAKE_PSQL" ] || exit 2; echo "$FAKE_PSQL"'
stub runuser 'echo "runuser $1 $2" >> "$LOG"; [ "$1" = -u ] && shift 2; [ "$1" = -- ] && shift; exec "$@"'
stub id 'if [ "$1" = -u ] && [ "$2" = postgres ]; then echo 26; exit 0; fi; exec /usr/bin/id "$@"'
chmod +x "$work"/bin/*
export PATH="$work/bin:$PATH"
echo "all=[$(FAKE_PSQL='t|t|t' first_twenty_objects)]"
echo "none=[$(FAKE_PSQL='f|f|f' first_twenty_objects)]"
echo "unknown=[$(FAKE_PSQL= first_twenty_objects)]"
sed 's/^/log: /' "$LOG"
`)
    expect(r.stderr).toBe('')
    expect(r.stdout).toContain('all=[t|t|t]')
    expect(r.stdout).toContain('none=[f|f|f]')
    expect(r.stdout).toContain('unknown=[]')
    expect(r.stdout).toContain('log: runuser -u postgres')
    const queries = r.stdout.split('\n').filter((l) => l.startsWith('log: ') && !l.startsWith('log: runuser'))
    expect(queries.length).toBe(3)
    for (const q of queries) {
      expect(q).toMatch(/SELECT /)
      expect(q).not.toMatch(/\b(CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE)\b/i)
    }
  })

  it('stops --install-postgres when the OS package is older than Postgres 15, and warns about an older one already there', () => {
    const r = bash(`${prelude}
${shellFunction(setup, 'apt_postgres_major')}
mkdir -p "$work/bin"
stub() { printf '#!/usr/bin/env bash\\n%s\\n' "$2" > "$work/bin/$1"; }
stub apt-cache 'echo "postgresql:"; echo "  Installed: (none)"; echo "  Candidate: $FAKE_CANDIDATE"; echo "  Version table:"'
chmod +x "$work"/bin/*
export PATH="$work/bin:$PATH"
echo "jammy=[$(FAKE_CANDIDATE='14+238' apt_postgres_major)]"
echo "noble=[$(FAKE_CANDIDATE='16+257build1' apt_postgres_major)]"
echo "none=[$(FAKE_CANDIDATE='(none)' apt_postgres_major)]"
stub apt-cache 'exit 100'
echo "broken=[$(apt_postgres_major)]"
`)
    expect(r.stderr).toBe('')
    for (const line of ['jammy=[14]', 'noble=[16]', 'none=[]', 'broken=[]']) expect(r.stdout).toContain(line)
    expect(setup).toMatch(/^MIN_PG_MAJOR=15$/m)
    // The check comes before the install, and an existing older Postgres gets a warning (setup never changes it).
    const install = /PG_CANDIDATE=\$\(apt_postgres_major\)[\s\S]*?apt_install postgresql/.exec(setup)?.[0]
    expect(install).toMatch(/-lt "\$MIN_PG_MAJOR" \]; then\n\s+die /)
    expect(setup).toMatch(/PG_HERE=\$\(local_server_major\)\n\s+if \[ -n "\$PG_HERE" \] && \[ "\$PG_HERE" -lt "\$MIN_PG_MAJOR" \]; then\n\s+warn /)
  })

  it('tells you to skip creating the roles when they already exist', () => {
    const r = bash(`${prelude}
${shellFunction(setup, 'next_steps')}
APP_DIR=/opt/first-twenty ENV_FILE=/etc/first-twenty/env DEPLOY_USER=ubuntu SERVICE=first-twenty DOMAIN=hr.example.com
echo "--- exists"; DB_STATE='t|t|t' next_steps
echo "--- missing"; DB_STATE='f|f|f' next_steps
echo "--- unknown"; DB_STATE= next_steps
`)
    expect(r.status).toBe(0)
    const out = sections(r.stdout)
    expect(out.exists).toContain('already exist')
    expect(out.exists).toContain('If your database and roles already exist')
    expect(out.exists).not.toContain('postgres-setup.sql')
    expect(out.missing).toContain('postgres-setup.sql')
    expect(out.unknown).toContain('postgres-setup.sql')
    for (const s of Object.values(out)) expect(s).toContain('bash server/deploy/deploy.sh')
  })
})

describe.skipIf(!BASH)('backup.sh', { timeout: BASH_TEST_MS }, () => {
  const backup = (body: string) =>
    bash(`${prelude}
mkdir -p "$work/bin"
printf '%s\\n' 'DATABASE_URL=postgres://first_twenty:runtime-test-value@127.0.0.1:5432/first_twenty' \\
  'MIGRATION_DATABASE_URL=postgres://first_twenty_owner:owner-test-value@127.0.0.1:5432/first_twenty' > "$work/env"
unset DATABASE_URL MIGRATION_DATABASE_URL PG_DUMP PG_RESTORE
export FIRST_TWENTY_ENV="$work/env" FIRST_TWENTY_DIR="$work/no-app" BACKUP_DIR="$work/backups"
stub() { printf '#!/usr/bin/env bash\\n%s\\n' "$2" > "$work/bin/$1"; chmod +x "$work/bin/$1"; }
${body}
`)

  it('names the client package for the server version when pg_dump is missing', () => {
    const r = backup(`stub psql 'echo 170004'
rc=0; PATH="$work/bin:$PATH" PG_DUMP="$work/missing/pg_dump" bash "$DEPLOY/backup.sh" || rc=$?; echo "rc=$rc"`)
    expect(r.stdout).toContain('rc=1')
    expect(r.stderr).toContain('pg_dump is not installed')
    expect(r.stderr).toContain('Postgres 17')
    expect(r.stderr).toContain('sudo dnf install postgresql17')
    expect(r.stderr).toContain('postgresql-client-17')
    expect(r.stderr).not.toContain('postgresql16')
  })

  it('refuses a pg_dump older than the server before trying, with the right package', () => {
    const r = backup(`stub psql 'echo 170002'
stub pg_dump 'echo "pg_dump (PostgreSQL) 16.4"'
stub pg_restore 'exit 0'
rc=0; PATH="$work/bin:$PATH" bash "$DEPLOY/backup.sh" || rc=$?; echo "rc=$rc"`)
    expect(r.stdout).toContain('rc=1')
    expect(r.stderr).toContain('pg_dump 16 is older than the database server')
    expect(r.stderr).toContain('sudo dnf install postgresql17')
  })

  it('gives a general hint when the server version cannot be found out', () => {
    const r = backup(`stub psql 'exit 2'
rc=0; PATH="$work/bin:$PATH" PG_DUMP="$work/missing/pg_dump" bash "$DEPLOY/backup.sh" || rc=$?; echo "rc=$rc"`)
    expect(r.stdout).toContain('rc=1')
    expect(r.stderr).toContain('pg_dump is not installed')
    expect(r.stderr).toContain('postgresql<version>')
  })

  it('dumps with the schema owner when MIGRATION_DATABASE_URL is filled in', () => {
    // install and flock are stubbed so this also runs where the scratch folder refuses chmod (Windows).
    const r = backup(`stub psql 'echo 170002'
stub pg_dump 'if [ "$1" = --version ]; then echo "pg_dump (PostgreSQL) 17.2"; exit 0; fi; echo "dump-as=$PGUSER password-set=\${PGPASSWORD:+yes}" >&2; exit 9'
stub pg_restore 'exit 0'
stub install 'for last; do :; done; mkdir -p "$last"'
stub flock 'exit 0'
rc=0; PATH="$work/bin:$PATH" bash "$DEPLOY/backup.sh" || rc=$?; echo "rc=$rc"`)
    expect(r.stdout).toContain('rc=9') // reached pg_dump, which the stub fails on purpose
    if (/Passing MIGRATION_DATABASE_URL to pg_dump as is/.test(r.stdout + r.stderr)) return // no node: libpq reads the URL
    expect(r.stderr).toContain('dump-as=first_twenty_owner password-set=yes')
    expect(r.stdout).toMatch(/Backing up database first_twenty as first_twenty_owner/)
  })

  it('falls back to DATABASE_URL while the owner password is still CHANGE_ME', () => {
    const r = backup(`stub psql 'echo 170002'
stub pg_dump 'if [ "$1" = --version ]; then echo "pg_dump (PostgreSQL) 17.2"; exit 0; fi; echo "dump-as=$PGUSER" >&2; exit 9'
stub pg_restore 'exit 0'
stub install 'for last; do :; done; mkdir -p "$last"'
stub flock 'exit 0'
sed -i 's#owner-test-value#CHANGE_ME#' "$work/env"
rc=0; PATH="$work/bin:$PATH" bash "$DEPLOY/backup.sh" || rc=$?; echo "rc=$rc"`)
    expect(r.stdout).toContain('rc=9')
    expect(r.stdout).toContain('MIGRATION_DATABASE_URL still has CHANGE_ME')
    if (/as is/.test(r.stdout)) return
    expect(r.stderr).toContain('dump-as=first_twenty')
    expect(r.stderr).not.toContain('dump-as=first_twenty_owner')
  })
})

describe('docs/SERVER.md', () => {
  const restore = serverDoc.slice(serverDoc.indexOf('### Restore a backup'), serverDoc.indexOf('## Develop locally'))

  it('restores as the owner, then migrates and starts a new sync history before starting the server', () => {
    const order = [
      'systemctl stop first-twenty',
      'postgres-setup.sql',
      '--role=first_twenty_owner',
      'with-env.sh npm run server:migrate',
      'with-env.sh npm run server:after-restore',
      'systemctl start first-twenty',
    ].map((needle) => {
      const at = restore.indexOf(needle)
      expect(at, needle).toBeGreaterThan(-1)
      return at
    })
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The old wording promised a resync without the step that makes it happen.
    expect(restore).not.toMatch(/notice that the\s+server went back in time/)
  })

  it('gives a Docker recipe that hands psql a terminal for the password prompts', () => {
    expect(serverDoc).toContain('docker exec -it <container> psql -U postgres -v ON_ERROR_STOP=1 -f /tmp/postgres-setup.sql')
    expect(serverDoc).not.toMatch(/docker exec -i <container> psql -U postgres < [^\n]*postgres-setup\.sql/)
    expect(setupSql).not.toMatch(/docker exec -i <container> psql -U postgres < [^\n]*postgres-setup\.sql/)
  })

  it('documents the way back from a rollback', () => {
    expect(serverDoc).toMatch(/git switch main/)
  })

  /** The text under heading `start`, up to the next heading at the same level or above (code blocks skipped). */
  const section = (start: string) => {
    const lines = serverDoc.split('\n')
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

  it('says deploy.sh backs up before migrating, and rolls back with the dump it names', () => {
    const updating = section('## Updating')
    expect(updating).toContain('first-twenty-backup')
    expect(updating).toContain('--skip-backup')
    expect(updating).toContain('[Restore a backup](#restore-a-backup)')
    // The old text asked for a backup that nothing had taken.
    expect(updating).not.toMatch(/restore the\s+backup from before the update as well/)
  })

  it("says deploy.sh runs only in the service's code folder", () => {
    expect(section('## Updating')).toMatch(/refuses to run from any other folder/)
    expect(section('## Step 2: copy the code and run the setup script')).toContain('rm -rf ~/first-twenty')
  })

  it('restores from S3 without giving the instance read access to the bucket', () => {
    expect(section('### Keep a copy off the instance')).toContain('s3:PutObject')
    const restoreSection = section('### Restore a backup')
    expect(restoreSection).not.toMatch(/sudo aws s3 cp s3:/)
    expect(restoreSection).toContain('aws s3 cp s3://your-bucket-name/first-twenty/<file>.dump .')
    expect(restoreSection).toMatch(/scp -i your-key\.pem <file>\.dump [\w-]+@hr\.example\.com:~/)
    expect(restoreSection).toContain('s3:GetObject')
    expect(restoreSection).toContain('s3:ListBucket')
  })

  it('has a short path for a database and roles that already exist, with on-instance password rotation', () => {
    const existing = section('### If your database and roles already exist')
    expect(existing).toMatch(/skip step 1/i)
    expect(existing).toContain("sudo -u postgres psql -c '\\password first_twenty'")
    expect(existing).toContain("sudo -u postgres psql -c '\\password first_twenty_owner'")
    expect(existing).toContain('/etc/first-twenty/env')
    expect(existing).toContain('openssl rand')
    expect(existing).toContain('with-env.sh npm run server:migrate -- --status')
    expect(serverDoc).toContain('(#if-your-database-and-roles-already-exist)')
  })

  it('has a patching routine: what updates on its own, the monthly steps, npm audit and the Node.js 22 end of life', () => {
    const patched = section('## Keep it patched')
    for (const needle of ['51first-twenty', '04:30', 'sudo apt-get update && sudo apt-get upgrade', '/var/run/reboot-required', 'npm audit --omit=dev', '2027-04-30', 'NODE_MAJOR']) {
      expect(patched, needle).toContain(needle)
    }
    expect(script('setup-ec2.sh')).toContain('NODE_MAJOR=${NODE_MAJOR:-22}')
  })

  it('says how to get out of a lockout from many addresses, and how to avoid one', () => {
    const locked = section('### Sign-in says rate_limited everywhere')
    expect(locked).toContain('bash server/deploy/with-env.sh npm run server:create-admin -- --email')
    expect(locked).toMatch(/Restarting the server does not help/)
    expect(locked).toMatch(/trusted-device cookie/)
    expect(section('## Step 4: build, create the tables and your admin login')).toMatch(/login email that is published nowhere/)
    expect(script('setup-ec2.sh')).toContain('pick one that is published nowhere')
  })

  it('keeps both roles out of every other database with pg_hba.conf reject lines', () => {
    const reject = /^\s*(--\s+)?host\s+all\s+first_twenty,first_twenty_owner\s+(127\.0\.0\.1\/32|::1\/128)\s+reject$/gm
    expect(section('## Step 1: create the database roles').match(reject)).toHaveLength(2)
    expect(setupSql.match(reject)).toHaveLength(2)
    // Below the lines that let them into their own database (the first matching line wins).
    expect(setupSql.indexOf('scram-sha-256\n--   host    all')).toBeGreaterThan(0)
  })

  it('says what an sslip.io name shares with strangers, and to use only the Elastic IP name', () => {
    const sslip = section('### A free sslip.io name instead')
    expect(sslip).toContain('Public Suffix List')
    expect(sslip).toContain('__Host-')
    expect(sslip).toMatch(/clear(ing)? the site data for `sslip\.io`/i)
    expect(sslip).toContain('Elastic IP')
    expect(section('### Security group')).not.toContain('::/0 and')
  })

  it('documents the automatic 2G swap file, its disk check and --no-swap', () => {
    const step2 = section('## Step 2: copy the code and run the setup script')
    expect(step2).toContain('--no-swap')
    expect(step2).toMatch(/2 GB swap file/)
    expect(step2).toMatch(/1 GB/)
    expect(section('### The build runs out of memory')).toContain('--swap')
  })

  it('documents careers pages: DNS, --careers-domain, the settings, what the host answers and the limits', () => {
    const careers = section('## Careers pages')
    for (const text of ['--careers-domain', 'CAREERS_HOSTS', 'CAREERS_ORIGIN', 'curl -I https://careers.example.com/', 'answer 404', 'includeSubDomains', 'no file upload']) {
      expect(careers, text).toContain(text)
    }
    // The limits it states are the server's.
    expect(careers).toContain(`${DEFAULT_APPLY_LIMITS.postsPerAddress} form posts and ${DEFAULT_APPLY_LIMITS.perAddress} applications per address`)
    expect(careers).toContain(`${DEFAULT_APPLY_LIMITS.perWorkspace} applications per company`)
    expect(careers).toContain(`${APPLY_BODY_LIMIT / 1024} KB at most`)
    expect(careers).toContain(`${CAREERS_CACHE_BYTES / (1024 * 1024)} MB of pages`)
    expect(careers).toContain(`${MAX_LISTED_JOBS} open roles`)
    expect(careers).toContain(`${LOAD_BUDGET.jobs / (1024 * 1024)} MB of job records`)
    expect(section('## Step 2: copy the code and run the setup script')).toContain('--careers-domain')
  })
})
