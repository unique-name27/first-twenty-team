import { beforeAll, describe, expect, it } from 'vitest'
import type { Activity, DB } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { deepEqual } from './diff'
import { canonicalJSON, fingerprint } from './fingerprint'
import { isWorkspaceSwap, LOAD_TIME_ACTIVITY_PREFIX, stabilizeLoadTimeIds } from './loadTime'
import { makeDB } from './testing/kit'

beforeAll(() => setClockOverride('2026-10-10'))

describe('fingerprint', () => {
  it('matches values that deepEqual, whatever the key order (Postgres JSONB reorders keys)', () => {
    const sent = { id: 'p-1', title: 'Engineer', tags: ['a', 'b'], nested: { z: 1, a: [1, { y: 2, x: 1 }] }, gone: undefined }
    const fromJsonb = { nested: { a: [1, { x: 1, y: 2 }], z: 1 }, title: 'Engineer', id: 'p-1', tags: ['a', 'b'] }
    expect(deepEqual(sent, fromJsonb)).toBe(true)
    expect(fingerprint(sent)).toBe(fingerprint(fromJsonb))
    expect(canonicalJSON(sent)).toBe(canonicalJSON(JSON.parse(JSON.stringify(fromJsonb))))
  })

  it('tells different values apart', () => {
    const base = { id: 'p-1', title: 'Engineer' }
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, title: 'Engineer ' }))
    expect(fingerprint(['a', 'b'])).not.toBe(fingerprint(['b', 'a']))
    expect(fingerprint({ a: null })).not.toBe(fingerprint({}))
    expect(fingerprint(1)).not.toBe(fingerprint('1'))
  })
})

function row(id: string, over: Partial<Activity> = {}): Activity {
  return { id, at: '2026-10-10T17:00:00.000Z', entityType: 'person', entityId: 'p-1', kind: 'job_change_effective', text: "Ada Lovelace's promotion took effect", ...over }
}

describe('stabilizeLoadTimeIds', () => {
  it('gives rows added on load the same id on every device, keeping everything else', () => {
    const before = makeDB()
    before.activity = [row('act-old0000001', { kind: 'note', text: 'Older' })]
    const onA: DB = { ...before, activity: [...before.activity, row('act-1a2b3c4d5e', { at: '2026-10-10T08:00:00.000Z' })] }
    const onB: DB = { ...before, activity: [...before.activity, row('act-9f8e7d6c5b', { at: '2026-10-11T09:30:00.000Z', actorId: 'p-other' })] }
    const a = stabilizeLoadTimeIds(before, onA)
    const b = stabilizeLoadTimeIds(before, onB)
    expect(a.activity[0]).toBe(before.activity[0])
    expect(a.activity[1].id.startsWith(LOAD_TIME_ACTIVITY_PREFIX)).toBe(true)
    expect(a.activity[1].id).toBe(b.activity[1].id)
    expect(a.activity[1]).toMatchObject({ at: '2026-10-10T08:00:00.000Z', text: onA.activity[1].text })
    expect(a.people).toBe(onA.people)
  })

  it('returns the same DB when nothing new has a random id', () => {
    const before = makeDB()
    expect(stabilizeLoadTimeIds(before, before)).toBe(before)
    const deterministic: DB = { ...before, activity: [row('act-eff-c-1')] }
    expect(stabilizeLoadTimeIds(before, deterministic)).toBe(deterministic)
  })

  it('never reuses an id already in the workspace', () => {
    const before = makeDB()
    const first = stabilizeLoadTimeIds(before, { ...before, activity: [row('act-aaaaaaaaaa')] })
    // The same event text again later (a second promotion with the same wording).
    const again = stabilizeLoadTimeIds(first, { ...first, activity: [...first.activity, row('act-bbbbbbbbbb')] })
    expect(again.activity[1].id).toBe(`${first.activity[0].id}-2`)
  })
})

describe('isWorkspaceSwap', () => {
  it('spots Import, Start fresh and the sample, not edits', () => {
    const w = makeDB()
    expect(isWorkspaceSwap(w, w)).toBe(false)
    expect(isWorkspaceSwap(w, { ...w, company: { ...w.company, name: 'Renamed' } })).toBe(false)
    expect(isWorkspaceSwap(w, { ...w, meta: { ...w.meta, createdOn: '2026-10-10' } })).toBe(true)
    expect(isWorkspaceSwap(w, makeDB({ sample: true }))).toBe(true)
  })

  it('compares workspace identities when there are any, so same-day workspaces differ', () => {
    const withId = (id: string | undefined, company = 'Acme') => {
      const db = makeDB({ company })
      if (id) (db.meta as { workspaceId?: string }).workspaceId = id
      return db
    }
    expect(isWorkspaceSwap(withId(undefined, 'Acme'), withId(undefined, 'Gamma'))).toBe(false)
    expect(isWorkspaceSwap(withId('ws-a'), withId('ws-b'))).toBe(true)
    expect(isWorkspaceSwap(withId(undefined), withId('ws-b'))).toBe(true)
    expect(isWorkspaceSwap(withId('ws-a'), withId(undefined))).toBe(true)
    const same = withId('ws-a')
    expect(isWorkspaceSwap(same, { ...withId('ws-a', 'Renamed'), meta: { ...same.meta, createdOn: '2020-01-01' } })).toBe(false)
  })
})
