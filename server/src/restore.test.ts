// Restoring a backup (docs/SERVER.md, "Restore a backup") with a real PGlite data-directory dump: a
// browser that synced after the backup must neither skip the restored server's new changes nor
// overwrite them, once `npm run server:after-restore` (afterRestore) has run.
import { PGlite } from '@electric-sql/pglite'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import type { DB } from '@/domain/types'
import { type Db, fromPGlite } from './db'
import { migrate } from './migrate'
import { afterRestore, RESTORE_SEQ_JUMP } from './repo'
import { createAdmin, CSRF, login, makeApp } from './test/helpers'

type PGliteArg = Parameters<typeof fromPGlite>[0]

const opened: Array<{ app?: FastifyInstance; pg: PGlite }> = []
afterEach(async () => {
  for (const { app, pg } of opened.splice(0)) {
    await app?.close()
    if (!pg.closed) await pg.close()
  }
})

async function open(pg: PGlite): Promise<{ db: Db; app: FastifyInstance }> {
  const db = fromPGlite(pg as unknown as PGliteArg)
  await migrate(db)
  const app = await makeApp(db)
  opened.push({ app, pg })
  return { db, app }
}

const workspace = (): DB => {
  const db = blankDB({ companyName: 'Restoreco', founderFirstName: 'Ada', founderLastName: 'Byte', foundedOn: '2026-01-05' })
  return { ...db, people: [...db.people, { ...db.people[0], id: 'p-1', firstName: 'Pat', title: 'v1', workEmail: 'pat@example.test' }] }
}

describe('restore from backup', () => {
  it('makes browsers from the lost history resync, and their stale edits conflict instead of overwriting', async () => {
    const pg1 = await PGlite.create()
    const one = await open(pg1)
    await createAdmin(one.db)
    const h1 = { ...CSRF, cookie: await login(one.app) }
    const up = await one.app.inject({ method: 'PUT', url: '/api/workspace', headers: h1, payload: { db: workspace() } })
    expect(up.statusCode).toBe(200)
    const historyBefore = up.json().historyId as string
    const person = (title: string, extra: Record<string, unknown> = {}) => ({ ...workspace().people[1], title, ...extra })
    const push = (app: FastifyInstance, headers: Record<string, string>, changes: unknown[], historyId?: string) =>
      app.inject({ method: 'POST', url: '/api/changes', headers, payload: historyId ? { changes, historyId } : { changes } })

    // Browser A edits p-1, then the nightly backup runs.
    const a2 = (await push(one.app, h1, [{ collection: 'people', id: 'p-1', op: 'upsert', data: person('v2'), baseVersion: up.json().versions['people:p-1'] }])).json()
    const v2 = a2.applied[0].version as number
    const backup = await pg1.dumpDataDir('none')

    // After the backup, A edits p-1 again and adds a record; then the server is restored from the backup.
    const a3 = (await push(one.app, h1, [{ collection: 'people', id: 'p-1', op: 'upsert', data: person('A after backup'), baseVersion: v2 }])).json()
    const a4 = (await push(one.app, h1, [{ collection: 'people', id: 'p-after-backup', op: 'upsert', data: person('new', { id: 'p-after-backup' }), baseVersion: null }])).json()
    const v3 = a3.applied[0].version as number
    const vNew = a4.applied[0].version as number
    const seenSeq = a4.seq as number

    const pg2 = await PGlite.create({ loadDataDir: backup })
    const db2 = fromPGlite(pg2 as unknown as PGliteArg)
    // The backup holds the trusted device A's sign-in made; it may have been forgotten since.
    expect((await db2.query('SELECT 1 FROM trusted_devices')).rows).toHaveLength(1)
    const restored = await afterRestore(db2)
    expect((await db2.query('SELECT 1 FROM trusted_devices')).rows).toEqual([])
    // The sequence moves a billion past the last seq in the backup (a data-directory copy may have logged a
    // few ahead), far past anything a browser saw since.
    expect(restored.seq).toBeGreaterThanOrEqual(a2.seq + RESTORE_SEQ_JUMP)
    expect(restored.seq).toBeGreaterThan(seenSeq)
    expect(restored.historyId).not.toBe(historyBefore)
    expect(restored.sessionsEnded).toBe(1)
    const two = await open(pg2)

    // Sessions from the backup no longer work.
    expect((await two.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: h1.cookie } })).statusCode).toBe(401)
    const h2 = { ...CSRF, cookie: await login(two.app) }

    // Browser B works on the restored copy: three edits to p-1.
    let version = v2
    for (const title of ['B1', 'B2', 'B3']) {
      const res = (await push(two.app, h2, [{ collection: 'people', id: 'p-1', op: 'upsert', data: person(title), baseVersion: version }])).json()
      expect(res.applied).toHaveLength(1)
      version = res.applied[0].version
      expect(version).toBeGreaterThan(restored.seq)
    }

    // Browser A comes back. Its pulls are told to resync, with or without its old history id.
    expect((await two.app.inject({ method: 'GET', url: `/api/changes?since=${seenSeq}`, headers: h2 })).json()).toEqual({ resync: true })
    const withHistory = await two.app.inject({ method: 'GET', url: `/api/changes?since=${seenSeq}&history=${historyBefore}`, headers: h2 })
    expect(withHistory.json()).toEqual({ resync: true })

    // A push carrying the old history id is refused before anything applies.
    const refused = await push(two.app, h2, [{ collection: 'people', id: 'p-1', op: 'upsert', data: person('A offline edit'), baseVersion: v3 }], historyBefore)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toBe('resync')

    // Without a history id (an older browser), its stale versions still cannot match: the server wins.
    const stale = await push(two.app, h2, [
      { collection: 'people', id: 'p-1', op: 'upsert', data: person('A offline edit', { workPhone: '555-0100' }), baseVersion: v3 },
      { collection: 'people', id: 'p-after-backup', op: 'upsert', data: person('edited', { id: 'p-after-backup' }), baseVersion: vNew },
    ])
    expect(stale.json().applied).toEqual([])
    expect(stale.json().conflicts).toEqual([
      expect.objectContaining({ id: 'p-1', serverVersion: version, serverData: expect.objectContaining({ title: 'B3' }) }),
      { collection: 'people', id: 'p-after-backup', serverVersion: null, serverData: null },
    ])
    const snap = (await two.app.inject({ method: 'GET', url: '/api/workspace', headers: h2 })).json()
    expect(snap.db.people.find((p: { id: string }) => p.id === 'p-1').title).toBe('B3')
    expect(snap.historyId).toBe(restored.historyId)
    expect(snap.seq).toBe(version)
  })
})
