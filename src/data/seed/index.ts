// The Ledgerlark sample (fictional), anchored to Friday 2026-10-09. See docs/SAMPLE.md.
// Order matters: company and org first, then people (with comp, checklists, trainings), equity,
// time off and leave, contractors and advisors, compliance state, hiring, which hires the two incoming
// people through the real Hire flow (src/domain/lifecycle.ts), and last the pay run situations (./payroll).
import { produce } from 'immer'
import { blankDB } from '@/data/blank'
import type { DB } from '@/domain/types'
import { getClockOverride, setClockOverride } from '@/lib/dates'
import { applyCompany } from './company'
import { applyCompliance } from './compliance'
import { applyContractors } from './contractors'
import { applyEquity } from './equity'
import { applyHiring } from './hiring'
import { applyPayroll } from './payroll'
import { applyPeople } from './people'
import { applyTimeoff } from './timeoff'

export const SAMPLE_ANCHOR = '2026-10-09'

export function buildSampleDB(): DB {
  // Build at the anchor date so activity timestamps and generated tasks match the story; the store
  // then shifts the whole sample to today.
  const previous = getClockOverride()
  setClockOverride(SAMPLE_ANCHOR)
  try {
    return build()
  } finally {
    setClockOverride(previous)
  }
}

function build(): DB {
  const base = blankDB({
    companyName: 'Ledgerlark',
    founderFirstName: 'Maya',
    founderLastName: 'Raman',
    founderTitle: 'Founder and CEO',
    foundedOn: '2025-02-03',
  })
  const db = produce(base, (d) => {
    applyCompany(d)
    applyPeople(d)
    applyEquity(d)
    applyTimeoff(d)
    applyContractors(d)
    applyCompliance(d)
    applyHiring(d)
    applyPayroll(d)
    d.meta = { createdOn: SAMPLE_ANCHOR, sample: true, sampleAnchor: SAMPLE_ANCHOR }
  })
  return db
}
