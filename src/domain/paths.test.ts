import { describe, expect, it } from 'vitest'
import { asDate, textOf, valueAt, valuesAt } from './paths'

describe('valuesAt', () => {
  const job = {
    id: 'j-1',
    requisition: { requestedById: 'p-1' },
    panelIds: ['p-1', 'p-2'],
    interviewPlan: [{ interviewerIds: ['p-3'] }, { interviewerIds: ['p-4', 'p-5'] }, { interviewerIds: 'not a list' }, null],
  }

  it('reads plain, nested and list paths', () => {
    expect(valuesAt(job, 'id')).toEqual(['j-1'])
    expect(valueAt(job, 'requisition.requestedById')).toBe('p-1')
    expect(valuesAt(job, 'panelIds[]')).toEqual(['p-1', 'p-2'])
    expect(valuesAt(job, 'interviewPlan[].interviewerIds[]')).toEqual(['p-3', 'p-4', 'p-5'])
  })

  it('gives one undefined for a missing field and no items for a list that is not one, as Postgres does', () => {
    expect(valuesAt(job, 'missing')).toEqual([undefined])
    expect(valuesAt(job, 'missing.deeper')).toEqual([undefined])
    expect(valuesAt(job, 'missing[]')).toEqual([])
    expect(valuesAt({ panelIds: { a: 1 } }, 'panelIds[]')).toEqual([])
    expect(valuesAt('text', 'id')).toEqual([undefined])
  })
})

describe('textOf', () => {
  it('gives the text ->> would give, and null for empty values', () => {
    expect(textOf('p-1')).toBe('p-1')
    expect(textOf(7)).toBe('7')
    expect(textOf(true)).toBe('true')
    expect(textOf('')).toBeNull()
    expect(textOf(null)).toBeNull()
    expect(textOf(undefined)).toBeNull()
  })
})

describe('asDate', () => {
  it('accepts real days only', () => {
    expect(asDate('2026-10-09')).toBe('2026-10-09')
    expect(asDate('2028-02-29')).toBe('2028-02-29')
    expect(asDate('2000-02-29')).toBe('2000-02-29')
    for (const bad of ['2026-02-29', '1900-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-00', '0000-01-01', '2026-1-9', '2026-10-09T00:00:00Z', ' 2026-10-09', '', 'junk', null, 20261009]) {
      expect(asDate(bad), String(bad)).toBeNull()
    }
  })
})
