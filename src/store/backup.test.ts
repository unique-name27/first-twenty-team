// The backup file is the same from every place that offers it: named after the company, stamped first,
// and never an Undo step (r2-40: the Home inbox's Download backup took Ctrl Z from the last real edit).
import { afterEach, describe, expect, it } from 'vitest'
import type { DB } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { backupFileName, companyStem, downloadBackupFile, markExported } from './backup'
import { useDB } from './db'

afterEach(() => setClockOverride(null))

describe('backup file names', () => {
  it('start with the company name, or first-twenty when there is none', () => {
    expect(backupFileName('Ledgerlark, Inc.', '2026-10-09')).toBe('ledgerlark-inc-backup-2026-10-09.json')
    expect(backupFileName('', '2026-10-09')).toBe('first-twenty-backup-2026-10-09.json')
    expect(companyStem('  Acme & Sons  ')).toBe('acme-sons')
  })
})

describe('stamping a backup', () => {
  it('adds no Undo step and stamps every snapshot, so Ctrl Z still undoes the last real edit', () => {
    setClockOverride('2026-10-11')
    useDB.getState().mutate('Renamed the company', (d) => {
      d.company.name = 'Backup Test Co'
    })
    const depth = useDB.getState().past.length
    const at = markExported()
    expect(useDB.getState().past.length).toBe(depth)
    expect(useDB.getState().db.meta.lastExportedOn).toBe(at)
    expect(useDB.getState().past.every((p) => p.db.meta.lastExportedOn === at)).toBe(true)
    expect(useDB.getState().undo()).toBe('Renamed the company')
    expect(useDB.getState().db.meta.lastExportedOn).toBe(at)
  })

  it('stamps before it builds the file, so the backup records its own time', () => {
    setClockOverride('2026-10-11')
    // No browser here: the download is refused, and the JSON comes back for the Copy fallback.
    const { ok, json } = downloadBackupFile()
    expect(ok).toBe(false)
    const saved = JSON.parse(json) as DB
    expect(saved.meta.lastExportedOn).toBe(useDB.getState().db.meta.lastExportedOn)
    expect(saved.meta.lastExportedOn?.startsWith('2026-10-1')).toBe(true)
  })
})
