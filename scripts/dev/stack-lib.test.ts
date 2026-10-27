import { describe, expect, it } from 'vitest'
import {
  apiEnv,
  apiPortFromEnv,
  appOrigin,
  codespaceAllowedHosts,
  codespaceOrigin,
  devDirName,
  MAX_OFFSET,
  parseArgs,
  stackPorts,
} from './stack-lib.mjs'

const CODESPACE = { CODESPACES: 'true', CODESPACE_NAME: 'demo-abc', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' }

describe('parseArgs', () => {
  it('defaults to the sample company on the standard ports', () => {
    expect(parseArgs([])).toEqual({ fresh: false, offset: 0, seed: true, help: false })
  })

  it('reads every flag, with --offset as two words or one', () => {
    expect(parseArgs(['--fresh', '--offset', '10', '--no-seed'])).toEqual({ fresh: true, offset: 10, seed: false, help: false })
    expect(parseArgs(['--offset=20']).offset).toBe(20)
    expect(parseArgs(['-h']).help).toBe(true)
  })

  it('refuses unknown flags and offsets that are not small whole numbers', () => {
    expect(() => parseArgs(['--fersh'])).toThrow('Unknown option "--fersh"')
    expect(() => parseArgs(['--offset'])).toThrow('--offset needs a whole number')
    expect(() => parseArgs(['--offset', '-5'])).toThrow('--offset needs a whole number')
    expect(() => parseArgs(['--offset', '1.5'])).toThrow('--offset needs a whole number')
    expect(() => parseArgs(['--offset', String(MAX_OFFSET + 1)])).toThrow(`at most ${MAX_OFFSET}`)
  })
})

describe('ports and data folders', () => {
  it('moves both ports by the offset', () => {
    expect(stackPorts(0)).toEqual({ app: 8826, api: 8787 })
    expect(stackPorts(10)).toEqual({ app: 8836, api: 8797 })
  })

  it('gives each offset its own data folder (PGlite allows one process per folder)', () => {
    expect(devDirName(0)).toBe('.data/dev')
    expect(devDirName(10)).toBe('.data/dev-10')
  })

  it('points the Vite proxy at the stack API port, else 8787', () => {
    expect(apiPortFromEnv({})).toBe(8787)
    expect(apiPortFromEnv({ FIRST_TWENTY_API_PORT: '8797' })).toBe(8797)
    expect(apiPortFromEnv({ FIRST_TWENTY_API_PORT: 'nope' })).toBe(8787)
    expect(apiPortFromEnv({ FIRST_TWENTY_API_PORT: '70000' })).toBe(8787)
  })
})

describe('GitHub Codespaces addresses', () => {
  it('builds the forwarded https address of a port', () => {
    expect(codespaceOrigin(CODESPACE, 8826)).toBe('https://demo-abc-8826.app.github.dev')
    expect(appOrigin(CODESPACE, 8836)).toBe('https://demo-abc-8836.app.github.dev')
  })

  it('uses 127.0.0.1 outside a codespace or when a setting is missing', () => {
    expect(codespaceOrigin({}, 8826)).toBeNull()
    expect(codespaceOrigin({ ...CODESPACE, CODESPACES: 'false' }, 8826)).toBeNull()
    expect(codespaceOrigin({ ...CODESPACE, CODESPACE_NAME: '' }, 8826)).toBeNull()
    expect(codespaceOrigin({ ...CODESPACE, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'not a domain' }, 8826)).toBeNull()
    expect(appOrigin({}, 8826)).toBe('http://127.0.0.1:8826')
  })

  it('lets Vite accept the forwarding domain only inside a codespace', () => {
    expect(codespaceAllowedHosts(CODESPACE)).toEqual(['.app.github.dev'])
    expect(codespaceAllowedHosts({ GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' })).toEqual([])
    expect(codespaceAllowedHosts({})).toEqual([])
  })
})

describe('apiEnv', () => {
  const stack = { apiPort: 8787, appPort: 8826, devDir: '.data/dev' }

  it('runs the API in development on the stack database, open to sign-ups, with the scripted assistant', () => {
    const env = apiEnv({ PATH: '/bin' }, stack)
    expect(env).toMatchObject({
      PATH: '/bin',
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: '8787',
      DATABASE_URL: 'pglite:.data/dev/pg',
      PUBLIC_ORIGIN: 'http://127.0.0.1:8826',
      SERVE_APP: 'false',
      SIGNUP_MODE: 'open',
      ASSISTANT_FAKE: '1',
      LOG_LEVEL: 'warn',
    })
  })

  it('sets PUBLIC_ORIGIN to the codespace address, so cookies are Secure there', () => {
    expect(apiEnv(CODESPACE, { ...stack, appPort: 8836 }).PUBLIC_ORIGIN).toBe('https://demo-abc-8836.app.github.dev')
  })

  it('wins over settings that would point elsewhere, and drops the ones it must not pass on', () => {
    const env = apiEnv(
      { NODE_ENV: 'production', DATABASE_URL: 'postgres://x', ALLOWED_ORIGIN: 'http://evil.test', ANTHROPIC_API_KEY: 'k', LOG_LEVEL: 'debug' },
      { apiPort: 8797, appPort: 8836, devDir: '.data/dev-10' },
    )
    expect(env.NODE_ENV).toBe('development')
    expect(env.DATABASE_URL).toBe('pglite:.data/dev-10/pg')
    expect(env.PORT).toBe('8797')
    expect(env).not.toHaveProperty('ALLOWED_ORIGIN')
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(env.LOG_LEVEL).toBe('debug')
  })
})
