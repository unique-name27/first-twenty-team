// The shared integrity checker: the Ledgerlark sample passes, and every kind of planted problem is found
// with its code and record ids (src/domain/integrityKit.ts plants them).
// The store loads first so every seed and domain module finishes loading before the sample is built.
import '@/store/db'
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import type { DB } from '@/domain/types'
import {
  CUSTOM_CHECKS,
  DATE_RULES,
  describeProblem,
  integrityFailures,
  integrityProblems,
  LINK_RULES,
  LIST_RULES,
  REFERENCE_RULES,
  UNIQUE_RULES,
} from './integrity'
import { PLANTS, plantAll, planted } from './integrityKit'

const sample: DB = buildSampleDB()
const lines = (db: DB) => integrityProblems(db).map(describeProblem).sort()

describe('integrityProblems', () => {
  it('finds nothing wrong with the sample', () => {
    expect(lines(sample)).toEqual([])
  })

  for (const plant of PLANTS) {
    it(`finds ${plant.name}`, () => {
      const { db, expected } = planted(sample, plant)
      expect(lines(db)).toEqual(expected)
    })
  }

  it('finds every planted problem at once, and nothing else', () => {
    const { db, expected } = plantAll(sample)
    expect(lines(db)).toEqual(expected)
  })

  it('finds a duplicate id, which only the browser can hold (the server refuses one)', () => {
    const db = produce(sample, (d) => {
      d.holidays.push({ ...d.holidays[0] })
    })
    expect(lines(db)).toEqual([`duplicate_id holidays ${sample.holidays[0].id} id -`])
  })

  it('reports a required list item that is empty, and ignores an optional field left empty', () => {
    const db = produce(sample, (d) => {
      d.jobs[0].panelIds.push('')
      d.people[1].fromContractorId = ''
    })
    expect(lines(db)).toEqual([`broken_reference jobs ${sample.jobs[0].id} panelIds[] -`])
  })

  it('reads records that are not the shape the types say without throwing', () => {
    const db = produce(sample, (d) => {
      const job = d.jobs[0] as unknown as Record<string, unknown>
      job.stages = 'not a list'
      job.interviewPlan = [null, 7, { stageId: 3 }]
      const app = d.applications[0] as unknown as Record<string, unknown>
      app.history = { not: 'a list' }
    })
    expect(() => integrityProblems(db)).not.toThrow()
  })

  it('sorts its answer and gives each problem a severity', () => {
    const { db } = plantAll(sample)
    const problems = integrityProblems(db)
    expect(problems.map(describeProblem)).toEqual(problems.map(describeProblem).sort())
    const severity = Object.fromEntries(problems.map((p) => [p.code, p.severity]))
    expect(severity).toMatchObject({
      broken_reference: 'failure',
      hire_missing_person: 'failure',
      hire_missing_comp: 'failure',
      hire_missing_offer: 'note',
      hire_missing_checklist: 'note',
      manager_leaving: 'note',
      unknown_step: 'note',
      not_on_panel: 'note',
    })
    expect(integrityFailures(db).every((p) => p.severity === 'failure')).toBe(true)
    // History may outlive a record, so activity references are notes.
    expect(problems.find((p) => p.collection === 'activity')?.severity).toBe('note')
  })

  it('names each rule once', () => {
    const keys = [
      ...REFERENCE_RULES.map((r) => `ref ${r.from} ${r.path} ${r.when?.in.join(',') ?? ''}`),
      ...LIST_RULES.map((r) => `list ${r.from} ${r.path}`),
      ...LINK_RULES.map((r) => `link ${r.from} ${r.via} ${r.theirs}`),
      ...DATE_RULES.map((r) => `date ${r.from} ${r.first} ${r.then}`),
      ...UNIQUE_RULES.map((r) => `unique ${r.from} ${r.path}`),
      ...CUSTOM_CHECKS,
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })
})
