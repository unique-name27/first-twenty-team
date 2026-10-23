// Backups: the whole workspace as one JSON file, the same from Settings (Data and Server) and from the
// Home inbox. The backup time is stamped first, without an Undo step, so the file records it too and
// Ctrl Z stays with the last real edit.
import { produce } from 'immer'
import type { DB } from '@/domain/types'
import { type ISODate, nowISO, today } from '@/lib/dates'
import { downloadFile } from '@/lib/files'
import { getDB, useDB } from './db'

/** A company name as the start of a file name: 'Ledgerlark, Inc.' -> 'ledgerlark-inc' ('first-twenty' when blank). */
export function companyStem(companyName: string): string {
  const stem = companyName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return stem || 'first-twenty'
}

/** Backup file name: 'ledgerlark-backup-2026-10-09.json'. */
export function backupFileName(companyName: string, date: ISODate): string {
  return `${companyStem(companyName)}-backup-${date}.json`
}

/**
 * Records the backup time without adding an Undo step: the timestamp is stamped on the current
 * workspace and on every snapshot in the undo history, so Undo never rolls the backup age back
 * and never undoes the backup instead of the change the person meant.
 */
export function markExported(): string {
  const at = nowISO()
  const stamp = (db: DB) =>
    produce(db, (d) => {
      d.meta.lastExportedOn = at
    })
  useDB.setState((s) => ({ db: stamp(s.db), past: s.past.map((p) => ({ ...p, db: stamp(p.db) })) }))
  return at
}

/** The workspace as backup JSON (Import in Settings, Data reads it). */
export function backupJSON(): string {
  return JSON.stringify(getDB(), null, 2)
}

/**
 * Stamps the backup time, then downloads the workspace as <company>-backup-<date>.json. Returns the JSON
 * too: when the browser blocked the download (ok false), the caller offers it to copy instead.
 */
export function downloadBackupFile(): { ok: boolean; json: string } {
  markExported()
  const json = backupJSON()
  const ok = downloadFile(backupFileName(getDB().company.name, today()), json, 'application/json;charset=utf-8')
  return { ok, json }
}
