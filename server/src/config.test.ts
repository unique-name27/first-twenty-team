import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, loadDotEnv, parseDotEnv } from './config'
import { ConfigError } from './errors'

const root = mkdtempSync(path.join(tmpdir(), 'ft-config-'))
const load = (env: Record<string, string | undefined>) => loadConfig(env, { dotenv: false, rootDir: root, warn: () => {} })

describe('parseDotEnv', () => {
  it('reads KEY=value lines with comments, export and quotes', () => {
    const text = [
      '# comment',
      'PORT=9000',
      'export HOST=0.0.0.0',
      'DATABASE_URL="postgres://first_twenty:CHANGE_ME@127.0.0.1:5432/first_twenty"',
      "SINGLE='a # not a comment'",
      'INLINE=value # trailing comment',
      'ESCAPED="line\\nnext"',
      'EMPTY=',
      'not a line',
    ].join('\r\n')
    expect(parseDotEnv(text)).toEqual({
      PORT: '9000',
      HOST: '0.0.0.0',
      DATABASE_URL: 'postgres://first_twenty:CHANGE_ME@127.0.0.1:5432/first_twenty',
      SINGLE: 'a # not a comment',
      INLINE: 'value',
      ESCAPED: 'line\nnext',
      EMPTY: '',
    })
  })

  it('never overrides variables that are already set', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ft-env-'))
    writeFileSync(path.join(dir, '.env'), 'PORT=9000\nHOST=0.0.0.0\n')
    const env: Record<string, string | undefined> = { PORT: '8000' }
    expect(loadDotEnv(path.join(dir, '.env'), env)).toEqual(['HOST'])
    expect(env).toEqual({ PORT: '8000', HOST: '0.0.0.0' })
  })
})

describe('loadConfig', () => {
  it('uses development defaults: PGlite in .data/pg, 127.0.0.1:8787, migrate on start', () => {
    const c = load({})
    expect(c.nodeEnv).toBe('development')
    expect(c.port).toBe(8787)
    expect(c.host).toBe('127.0.0.1')
    expect(c.pgliteDir).toBe(path.resolve(root, '.data/pg'))
    expect(c.migrateOnStart).toBe(true)
    expect(c.sessionIdleHours).toBe(12)
    expect(c.sessionMaxDays).toBe(7)
    expect(c.secureCookies).toBe(false)
    expect(c.appFile).toBe(path.join(root, 'first-twenty.html'))
    expect(c.trustProxy).toBe('loopback')
  })

  it('fails fast in production without DATABASE_URL', () => {
    expect(() => load({ NODE_ENV: 'production' })).toThrow(ConfigError)
    expect(() => load({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL is not set/)
  })

  it('refuses the CHANGE_ME placeholder in production', () => {
    expect(() => load({ NODE_ENV: 'production', DATABASE_URL: 'postgres://first_twenty:CHANGE_ME@127.0.0.1:5432/first_twenty' })).toThrow(
      /CHANGE_ME placeholder/,
    )
  })

  it('refuses PGlite and ALLOWED_ORIGIN in production', () => {
    expect(() => load({ NODE_ENV: 'production', DATABASE_URL: 'pglite:./x' })).toThrow(/development and tests only/)
    expect(() =>
      load({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:placeholder@127.0.0.1/db', ALLOWED_ORIGIN: 'http://localhost:8826' }),
    ).toThrow(/development only/)
  })

  it('reads production settings', () => {
    const c = load({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://first_twenty:placeholder@127.0.0.1:5432/first_twenty',
      PUBLIC_ORIGIN: 'https://hr.example.com/',
      PORT: '9001',
      SESSION_IDLE_HOURS: '8',
      PGSSLMODE: 'disable',
    })
    expect(c.pgliteDir).toBeNull()
    expect(c.publicOrigin).toBe('https://hr.example.com')
    expect(c.secureCookies).toBe(true)
    expect(c.port).toBe(9001)
    expect(c.sessionIdleHours).toBe(8)
    expect(c.migrateOnStart).toBe(false)
    expect(c.pgSslMode).toBe('disable')
  })

  it('warns, but starts, in production while PUBLIC_ORIGIN is not https (the SSH-tunnel phase)', () => {
    const warnings: string[] = []
    const env = { NODE_ENV: 'production', DATABASE_URL: 'postgres://first_twenty:placeholder@127.0.0.1:5432/first_twenty' }
    const c = loadConfig({ ...env, PUBLIC_ORIGIN: 'http://localhost:8787' }, { dotenv: false, rootDir: root, warn: (m) => warnings.push(m) })
    expect(c.secureCookies).toBe(false)
    loadConfig(env, { dotenv: false, rootDir: root, warn: (m) => warnings.push(m) })
    expect(warnings).toEqual([
      expect.stringMatching(/^PUBLIC_ORIGIN is not https, so only requests that arrive through Caddy over https get Secure cookies and HSTS/),
      expect.stringMatching(/^PUBLIC_ORIGIN is not set, so only requests that arrive through Caddy over https/),
    ])
  })

  it('rejects malformed values with a clear message', () => {
    expect(() => load({ PORT: 'eighty' })).toThrow(/PORT must be a whole number/)
    expect(() => load({ DATABASE_URL: 'mysql://x' })).toThrow(/postgres:\/\//)
    expect(() => load({ PUBLIC_ORIGIN: 'hr.example.com' })).toThrow(/PUBLIC_ORIGIN/)
    expect(() => load({ SERVE_APP: 'true', APP_FILE: 'missing.html' })).toThrow(/does not exist/)
    expect(() => load({ PGSSLMODE: 'sometimes' })).toThrow(/PGSSLMODE/)
  })

  it('accepts pglite:memory', () => {
    expect(load({ DATABASE_URL: 'pglite:memory' }).pgliteDir).toBe('memory')
  })
})

describe('loadConfig: public demo and careers settings', () => {
  const production = { NODE_ENV: 'production', DATABASE_URL: 'postgres://first_twenty:placeholder@127.0.0.1:5432/first_twenty' }

  it('defaults to closed sign-up, 500 demo companies, a 30-day expiry and no careers hosts', () => {
    const c = load({})
    expect(c.signupMode).toBe('closed')
    expect(c.demoMaxWorkspaces).toBe(500)
    expect(c.demoExpireDays).toBe(30)
    expect(c.careersHosts).toEqual([])
    expect(c.careersOrigin).toBeUndefined()
  })

  it('reads SIGNUP_MODE, DEMO_MAX_WORKSPACES and DEMO_EXPIRE_DAYS (0: never)', () => {
    const c = load({ SIGNUP_MODE: ' Open ', DEMO_MAX_WORKSPACES: '40', DEMO_EXPIRE_DAYS: '0' })
    expect(c.signupMode).toBe('open')
    expect(c.demoMaxWorkspaces).toBe(40)
    expect(c.demoExpireDays).toBe(0)
    expect(() => load({ SIGNUP_MODE: 'yes' })).toThrow(/SIGNUP_MODE must be closed or open/)
    expect(() => load({ DEMO_MAX_WORKSPACES: '0' })).toThrow(/DEMO_MAX_WORKSPACES must be a whole number between 1/)
    expect(() => load({ DEMO_EXPIRE_DAYS: '-1' })).toThrow(/DEMO_EXPIRE_DAYS must be a whole number between 0/)
    expect(() => load({ DEMO_EXPIRE_DAYS: '1.5' })).toThrow(/DEMO_EXPIRE_DAYS/)
  })

  it('reads DEMO_MAX_TOTAL_MB, what the demo companies may hold together (2,048 MB by default)', () => {
    expect(load({}).demoMaxTotalBytes).toBe(2048 * 1024 * 1024)
    expect(load({ DEMO_MAX_TOTAL_MB: '512' }).demoMaxTotalBytes).toBe(512 * 1024 * 1024)
    expect(() => load({ DEMO_MAX_TOTAL_MB: '0' })).toThrow(/DEMO_MAX_TOTAL_MB must be a whole number between 1/)
    expect(() => load({ DEMO_MAX_TOTAL_MB: 'lots' })).toThrow(/DEMO_MAX_TOTAL_MB/)
  })

  it('warns when sign-up is open on a production server whose PUBLIC_ORIGIN is not https', () => {
    const warnings: string[] = []
    loadConfig({ ...production, PUBLIC_ORIGIN: 'http://localhost:8787', SIGNUP_MODE: 'open' }, { dotenv: false, rootDir: root, warn: (m) => warnings.push(m) })
    expect(warnings).toContainEqual(expect.stringMatching(/^SIGNUP_MODE=open on a server whose PUBLIC_ORIGIN is not https/))
    const quiet: string[] = []
    loadConfig({ ...production, PUBLIC_ORIGIN: 'https://hr.example.com', SIGNUP_MODE: 'open' }, { dotenv: false, rootDir: root, warn: (m) => quiet.push(m) })
    expect(quiet).toEqual([])
  })

  it('reads CAREERS_HOSTS as lowercase host names without repeats, and builds CAREERS_ORIGIN from the first', () => {
    const c = load({
      PUBLIC_ORIGIN: 'https://hr-77-112-161-54.sslip.io',
      CAREERS_HOSTS: ' Careers-77-112-161-54.sslip.io, jobs-77-112-161-54.sslip.io,,careers-77-112-161-54.sslip.io ',
    })
    expect(c.careersHosts).toEqual(['careers-77-112-161-54.sslip.io', 'jobs-77-112-161-54.sslip.io'])
    expect(c.careersOrigin).toBe('https://careers-77-112-161-54.sslip.io')
    // Development: the app's scheme and port.
    expect(load({ PUBLIC_ORIGIN: 'http://localhost:8787', CAREERS_HOSTS: 'careers.localhost' }).careersOrigin).toBe('http://careers.localhost:8787')
    expect(load({ CAREERS_HOSTS: 'careers.example.com' }).careersOrigin).toBe('https://careers.example.com')
  })

  it('takes CAREERS_ORIGIN when it names one of the careers hosts', () => {
    const c = load({ CAREERS_HOSTS: 'careers.example.com,jobs.example.com', CAREERS_ORIGIN: 'https://jobs.example.com/' })
    expect(c.careersOrigin).toBe('https://jobs.example.com')
    expect(() => load({ CAREERS_HOSTS: 'careers.example.com', CAREERS_ORIGIN: 'https://evil.example.net' })).toThrow(/CAREERS_ORIGIN must be on one of CAREERS_HOSTS/)
    expect(() => load({ CAREERS_HOSTS: 'careers.example.com', CAREERS_ORIGIN: 'careers.example.com' })).toThrow(/CAREERS_ORIGIN/)
  })

  it('turns careers off, with a warning, when CAREERS_ORIGIN is set without CAREERS_HOSTS', () => {
    const warnings: string[] = []
    const c = loadConfig({ CAREERS_ORIGIN: 'https://careers.example.com' }, { dotenv: false, rootDir: root, warn: (m) => warnings.push(m) })
    expect(c.careersOrigin).toBeUndefined()
    expect(warnings).toEqual([expect.stringMatching(/CAREERS_HOSTS is empty/)])
  })

  it("refuses careers hosts that are not host names, or that are the app's own host", () => {
    for (const bad of ['https://careers.example.com', 'careers.example.com:8443', 'careers example.com', 'careers.example.com/x', '-careers.example.com']) {
      expect(() => load({ CAREERS_HOSTS: bad }), bad).toThrow(/CAREERS_HOSTS must list host names/)
    }
    expect(() => load({ PUBLIC_ORIGIN: 'https://hr.example.com', CAREERS_HOSTS: 'careers.example.com,HR.example.com' })).toThrow(
      /CAREERS_HOSTS lists hr\.example\.com, the app's own host/,
    )
  })
})

describe('loadConfig: the assistant', () => {
  const PROD = { NODE_ENV: 'production', DATABASE_URL: 'postgres://first_twenty:placeholder@127.0.0.1:5432/first_twenty', PUBLIC_ORIGIN: 'https://hr.example.com' }

  it('is off without ANTHROPIC_API_KEY, with the documented defaults', () => {
    expect(load({}).assistant).toEqual({ enabled: false, model: 'claude-opus-5-5', effort: 'low', maxTokens: 8000, perWorkspaceDaily: 40, globalDaily: 600, fake: false })
    expect(load({ ANTHROPIC_API_KEY: '   ' }).assistant.enabled).toBe(false)
  })

  it('is on with a key, and reads the model, effort, token limit and daily limits', () => {
    const c = load({
      ...PROD,
      ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key',
      ASSISTANT_MODEL: 'claude-sonnet-5-5',
      ASSISTANT_EFFORT: 'High',
      ASSISTANT_MAX_TOKENS: '16000',
      ASSISTANT_DAILY_PER_WORKSPACE: '10',
      ASSISTANT_DAILY_GLOBAL: '100',
    })
    expect(c.assistant).toEqual({ enabled: true, model: 'claude-sonnet-5-5', effort: 'high', maxTokens: 16000, perWorkspaceDaily: 10, globalDaily: 100, fake: false })
  })

  it('never keeps the key in the config, so nothing that logs or sends the config can carry it', () => {
    const c = load({ ...PROD, ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key' })
    expect(JSON.stringify(c)).not.toContain('sk-ant-test-not-a-real-key')
  })

  it('runs the fake model in development, and refuses it in production', () => {
    expect(load({ ASSISTANT_FAKE: '1' }).assistant).toMatchObject({ enabled: true, fake: true })
    expect(() => load({ ...PROD, ASSISTANT_FAKE: '1' })).toThrow(/ASSISTANT_FAKE is for development and tests only/)
    expect(load({ ...PROD, ASSISTANT_FAKE: '0' }).assistant.fake).toBe(false)
  })

  it('rejects malformed values with a clear message, never echoing the key', () => {
    expect(() => load({ ASSISTANT_EFFORT: 'extreme' })).toThrow(/ASSISTANT_EFFORT must be one of low, medium, high, xhigh, max/)
    expect(() => load({ ASSISTANT_MODEL: 'claude opus' })).toThrow(/ASSISTANT_MODEL must be a model id/)
    expect(() => load({ ASSISTANT_MAX_TOKENS: '0' })).toThrow(/ASSISTANT_MAX_TOKENS/)
    expect(() => load({ ASSISTANT_MAX_TOKENS: '200000' })).toThrow(/ASSISTANT_MAX_TOKENS/)
    expect(() => load({ ASSISTANT_DAILY_PER_WORKSPACE: 'lots' })).toThrow(/ASSISTANT_DAILY_PER_WORKSPACE/)
    expect(() => load({ ASSISTANT_DAILY_GLOBAL: '-5' })).toThrow(/ASSISTANT_DAILY_GLOBAL/)
    let message = ''
    try {
      load({ ANTHROPIC_API_KEY: 'sk-ant-secret part' })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/ANTHROPIC_API_KEY has a space/)
    expect(message).not.toContain('sk-ant-secret')
  })
})

describe('loadConfig: development tools', () => {
  const PROD = { NODE_ENV: 'production', DATABASE_URL: 'postgres://first_twenty:placeholder@127.0.0.1:5432/first_twenty', PUBLIC_ORIGIN: 'https://hr.example.com' }

  it('are off unless DEV_TOOLS is on, which only npm run stack sets', () => {
    expect(load({}).devTools).toBe(false)
    expect(load({ DEV_TOOLS: '0' }).devTools).toBe(false)
    expect(load({ DEV_TOOLS: '1' }).devTools).toBe(true)
    expect(load({ NODE_ENV: 'test', DEV_TOOLS: 'true' }).devTools).toBe(true)
  })

  it('stop a production server from starting', () => {
    expect(() => load({ ...PROD, DEV_TOOLS: '1' })).toThrow(ConfigError)
    expect(() => load({ ...PROD, DEV_TOOLS: 'yes' })).toThrow(/DEV_TOOLS is for development only/)
    expect(load({ ...PROD, DEV_TOOLS: '0' }).devTools).toBe(false)
    expect(load(PROD).devTools).toBe(false)
  })
})
