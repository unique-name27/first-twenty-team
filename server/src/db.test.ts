// The pg (production) adapter, checked against a fake driver: no Postgres runs on this machine.
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  log: [] as string[],
  released: [] as unknown[],
  failOn: null as string | null,
  ended: false,
}))

vi.mock('pg', () => {
  class FakeClient {
    async query(text: string, params?: unknown[]) {
      state.log.push(params ? `${text} ${JSON.stringify(params)}` : text)
      if (state.failOn && text.includes(state.failOn)) throw new Error(`boom: ${text}`)
      return { rows: [{ ok: 1 }], rowCount: 1 }
    }
    release(err?: unknown) {
      state.released.push(err ?? false)
    }
  }
  class Pool extends FakeClient {
    constructor(config: Record<string, unknown>) {
      super()
      state.config = config
    }
    on() {
      return this
    }
    async connect() {
      return new FakeClient()
    }
    async end() {
      state.ended = true
    }
  }
  return { default: { Pool } }
})

const { openPg } = await import('./db')

afterEach(() => {
  state.log = []
  state.released = []
  state.failOn = null
})

describe('pg adapter', () => {
  it('passes the connection string, timeouts and TLS mode to the pool', async () => {
    await openPg({ databaseUrl: 'postgres://u:CHANGE_ME@127.0.0.1:5432/db', pgSslMode: undefined })
    expect(state.config).toMatchObject({ connectionString: 'postgres://u:CHANGE_ME@127.0.0.1:5432/db', ssl: undefined, statement_timeout: 30_000 })
    await openPg({ databaseUrl: 'postgres://x', pgSslMode: 'require' })
    expect(state.config?.ssl).toEqual({ rejectUnauthorized: true })
    await openPg({ databaseUrl: 'postgres://x', pgSslMode: 'no-verify' })
    expect(state.config?.ssl).toEqual({ rejectUnauthorized: false })
    await openPg({ databaseUrl: 'postgres://x', pgSslMode: 'disable' })
    expect(state.config?.ssl).toBe(false)
  })

  it('wraps a transaction in BEGIN and COMMIT on one client, with the isolation level', async () => {
    const db = await openPg({ databaseUrl: 'postgres://x', pgSslMode: undefined })
    const out = await db.tx(async (q) => (await q.query('SELECT $1::int AS ok', [1])).rows[0], { isolation: 'repeatable read', readOnly: true })
    expect(out).toEqual({ ok: 1 })
    expect(state.log).toEqual(['BEGIN', 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', 'SELECT $1::int AS ok [1]', 'COMMIT'])
    expect(state.released).toEqual([false])
    await db.close()
    expect(state.ended).toBe(true)
  })

  it('rolls back and releases the client when the work throws', async () => {
    const db = await openPg({ databaseUrl: 'postgres://x', pgSslMode: undefined })
    state.failOn = 'INSERT bad'
    await expect(db.tx(async (q) => q.query('INSERT bad'))).rejects.toThrow('boom')
    expect(state.log.at(-1)).toBe('ROLLBACK')
    expect(state.log).not.toContain('COMMIT')
    expect(state.released).toEqual([false])
  })

  it('destroys the client when even ROLLBACK fails', async () => {
    const db = await openPg({ databaseUrl: 'postgres://x', pgSslMode: undefined })
    state.failOn = 'ROLLBACK'
    await expect(
      db.tx(async () => {
        throw new Error('work failed')
      }),
    ).rejects.toThrow('work failed')
    expect(state.released).toEqual([true])
  })
})
