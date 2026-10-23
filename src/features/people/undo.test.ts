import { describe, expect, it } from 'vitest'
import type { Activity, DB } from '@/domain/types'
import type { HistoryEntry } from '@/store/db'
import { applyChanges } from '@/sync/apply'
import { makeDB } from '@/sync/testing/kit'
import { latestChangeOf } from './undo'

const row = (id: string): Activity => ({ id, at: '2026-10-10T17:00:00.000Z', entityType: 'person', entityId: 'p-1', kind: 'person_updated', text: id })
const withRows = (db: DB, ...rows: Activity[]): DB => ({ ...db, activity: [...db.activity, ...rows] })

describe('latestChangeOf', () => {
  it('names the activity rows the newest change wrote', () => {
    const before = withRows(makeDB(), row('a-1'))
    const after = withRows(before, row('u-1'))
    const past: HistoryEntry[] = [{ db: before, label: 'Edit', id: 7, at: 0 }]
    const latest = latestChangeOf(past, after)
    expect(latest).toMatchObject({ entryId: 7, label: 'Edit' })
    expect([...latest!.activityIds]).toEqual(['u-1'])
  })

  it('is null with nothing to undo', () => {
    expect(latestChangeOf([], makeDB())).toBeNull()
  })

  // The sync engine applies pulled rows to the store and to every Undo snapshot; both append them at the
  // end, so the snapshot grows by one row and an index cut would land on the other device's row.
  it('never attaches to a row another device wrote that arrived in a pull', () => {
    const before = withRows(makeDB(), row('a-1'))
    const after = withRows(before, row('u-1'))
    const pulled = [{ collection: 'activity', id: 'r-1', op: 'upsert' as const, data: row('r-1') }]
    const past: HistoryEntry[] = [{ db: applyChanges(before, pulled), label: 'Edit', id: 7, at: 0 }]
    const latest = latestChangeOf(past, applyChanges(after, pulled))
    expect([...latest!.activityIds]).toEqual(['u-1'])
  })
})
