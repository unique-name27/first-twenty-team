// How a candidate's source reads: careers page applicants stand out from every other inbound candidate.
import { describe, expect, it } from 'vitest'
import { applicationRecords, CAREERS_SOURCE_DETAIL } from '@/careers/application'
import { buildSampleDB } from '@/data/seed'
import { CAREERS_SITE_DETAIL, isCareersSiteCandidate, sourceLabel } from './sources'

describe('candidate sources', () => {
  it('show a careers page applicant as Inbound: Careers site, even where other details are left out', () => {
    const careers = { source: 'inbound' as const, sourceDetail: CAREERS_SITE_DETAIL }
    expect(sourceLabel(careers)).toBe('Inbound: Careers site')
    expect(sourceLabel(careers, true)).toBe('Inbound: Careers site')
    expect(isCareersSiteCandidate(careers)).toBe(true)
    // Other details show only where asked for.
    expect(sourceLabel({ source: 'agency', sourceDetail: 'Talentlane' })).toBe('Agency')
    expect(sourceLabel({ source: 'agency', sourceDetail: 'Talentlane' }, true)).toBe('Agency: Talentlane')
    expect(sourceLabel({ source: 'inbound' })).toBe('Inbound')
    expect(isCareersSiteCandidate({ source: 'referral', sourceDetail: CAREERS_SITE_DETAIL })).toBe(false)
  })

  it('match what the careers page writes on the candidates it adds', () => {
    expect(CAREERS_SOURCE_DETAIL).toBe(CAREERS_SITE_DETAIL)
    const db = buildSampleDB()
    const { candidate } = applicationRecords({
      db,
      job: db.jobs[0],
      input: { firstName: 'Rosa', lastName: 'Alvarez', email: 'rosa@example.com', answer: 'A sentence or two about the role.' },
      question: 'Why?',
      date: '2026-10-10',
      at: '2026-10-10T17:00:00.000Z',
    })
    expect(isCareersSiteCandidate(candidate)).toBe(true)
    expect(sourceLabel(candidate)).toBe('Inbound: Careers site')
  })
})
