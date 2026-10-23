import { describe, expect, expectTypeOf, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { buildSampleDB } from '@/data/seed'
import type { CollectionKey, DB } from '@/domain/types'
import {
  DOC_COLLECTION,
  DOC_KEYS,
  type DocKey,
  isDocKey,
  isRecordCollection,
  RECORD_COLLECTIONS,
  type RecordCollection,
  tableName,
} from './collections'

describe('collections', () => {
  it('covers every key of the DB type (compile-time check)', () => {
    expectTypeOf<Exclude<CollectionKey, RecordCollection>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<keyof DB, RecordCollection | DocKey | 'schemaVersion'>>().toEqualTypeOf<never>()
    expectTypeOf<Extract<RecordCollection, DocKey>>().toEqualTypeOf<never>()
  })

  it('matches a real workspace: arrays are record collections, objects are documents', () => {
    for (const db of [blankDB({ companyName: 'Acme', founderFirstName: 'Ada', founderLastName: 'Lovelace' }), buildSampleDB()]) {
      const src = db as unknown as Record<string, unknown>
      const keys = Object.keys(src).filter((k) => k !== 'schemaVersion').sort()
      expect([...RECORD_COLLECTIONS, ...DOC_KEYS].sort()).toEqual(keys)
      for (const c of RECORD_COLLECTIONS) {
        expect(Array.isArray(src[c]), c).toBe(true)
        for (const r of src[c] as Array<{ id?: unknown }>) expect(typeof r.id, `${c} record id`).toBe('string')
      }
      for (const k of DOC_KEYS) {
        expect(typeof src[k], k).toBe('object')
        expect(Array.isArray(src[k]), k).toBe(false)
      }
    }
  })

  it('has no duplicates', () => {
    expect(new Set(RECORD_COLLECTIONS).size).toBe(RECORD_COLLECTIONS.length)
    expect(new Set(DOC_KEYS).size).toBe(DOC_KEYS.length)
  })

  it('maps collections to safe, unique snake_case table names', () => {
    expect(tableName('timeOffRequests')).toBe('time_off_requests')
    expect(tableName('people')).toBe('people')
    expect(tableName('emailTemplates')).toBe('email_templates')
    const names = RECORD_COLLECTIONS.map(tableName)
    for (const n of names) expect(n).toMatch(/^[a-z][a-z_]*$/)
    expect(new Set(names).size).toBe(names.length)
    expect(names).not.toContain('workspace_docs')
    expect(names).not.toContain('change_log')
  })

  it('guards names coming from the network', () => {
    expect(isRecordCollection('people')).toBe(true)
    expect(isRecordCollection('$doc')).toBe(false)
    expect(isRecordCollection('constructor')).toBe(false)
    expect(isRecordCollection('People')).toBe(false)
    expect(isDocKey('meta')).toBe(true)
    expect(isDocKey('people')).toBe(false)
    expect(isDocKey('__proto__')).toBe(false)
    expect(DOC_COLLECTION).toBe('$doc')
  })
})
