// Retention is computed, not remembered.
// - Applicant records, selection criteria and ADS data: 4 years from the decision (Gov. Code 12946,
//   2 CCR 11013(c) as amended Oct 1, 2025). Delete becomes Archive until then.
// - Form I-9: the later of 3 years after the start date or 1 year after employment ends (USCIS M-274 10.0).
// - Personnel files: 4 years after the employment action for FEHA employers (5 or more employees; Gov. Code
//   12946 and 2 CCR 11013(c) as amended Oct 1, 2025). Labor Code 1198.5(c)(1)'s 3 years after termination is
//   only the floor below 5 employees. This app keeps 4 years by default.
// - Job title and wage rate history: employment plus 3 years (Labor Code 432.3), and it sits in the personnel
//   file here, so it follows the personnel file date when that is later.
// - Payroll records and wage statements: at least 3 years (Labor Code 226, 1174(d)).
import { fullName } from '@/domain/people'
import type { Candidate, DB, ID, Person } from '@/domain/types'
import { addMonths, type ISODate } from '@/lib/dates'
import { rawCount } from './counting'

export const APPLICANT_RETENTION_YEARS = 4
/** Labor Code 1198.5(c)(1): personnel files 3 years after termination (the floor for employers below 5). */
export const PERSONNEL_RETENTION_YEARS = 3
/** Gov. Code 12946 and 2 CCR 11013(c): FEHA employers (5+) keep personnel records 4 years after the employment action. */
export const FEHA_PERSONNEL_RETENTION_YEARS = 4

/** Applicant records: 4 years after the hiring decision. */
export function applicantRetainUntil(decisionDate: ISODate): ISODate {
  return addMonths(decisionDate, APPLICANT_RETENTION_YEARS * 12)
}

/** Form I-9: later of start + 3 years or end + 1 year. null while the person is still employed. */
export function i9RetainUntil(startDate: ISODate, endDate?: ISODate | null): ISODate | null {
  if (!endDate) return null
  const a = addMonths(startDate, 36)
  const b = addMonths(endDate, 12)
  return a > b ? a : b
}

/** Labor Code 1198.5 floor: 3 years after the employment ends (employers below 5). Also payroll and wage history. */
export function personnelRetainUntil(endDate: ISODate): ISODate {
  return addMonths(endDate, PERSONNEL_RETENTION_YEARS * 12)
}

/** FEHA employers (5+): 4 years after the employment action, here the end of employment (Gov. Code 12946). */
export function personnelRetainUntilFeha(endDate: ISODate): ISODate {
  return addMonths(endDate, FEHA_PERSONNEL_RETENTION_YEARS * 12)
}

/** True when the company had 5 or more employees on the date (FEHA coverage, counted in every state). */
export function isFehaEmployerOn(db: DB, date: ISODate): boolean {
  return rawCount(db, 'w2_one_in_ca', date) >= 5
}

export type PersonRetention = {
  /** null while employed (keep for the whole employment). */
  i9: ISODate | null
  personnelFile: ISODate | null
  wageHistory: ISODate | null
  payroll: ISODate | null
}

/**
 * Retain-until dates for one person's records. Personnel files follow the FEHA 4-year rule unless
 * `fehaEmployer: false` is passed (fewer than 5 employees at the exit; see isFehaEmployerOn), when the
 * Labor Code 1198.5 floor of 3 years applies. Defaulting to 4 years is the conservative choice.
 */
export function personRetention(p: Person, opts: { fehaEmployer?: boolean } = {}): PersonRetention {
  const end = p.separation?.lastDay ?? p.endDate ?? null
  if (!end) return { i9: i9RetainUntil(p.startDate, end), personnelFile: null, wageHistory: null, payroll: null }
  const personnelFile = opts.fehaEmployer === false ? personnelRetainUntil(end) : personnelRetainUntilFeha(end)
  const floor = personnelRetainUntil(end)
  return {
    i9: i9RetainUntil(p.startDate, end),
    personnelFile,
    wageHistory: personnelFile > floor ? personnelFile : floor,
    payroll: floor,
  }
}

/**
 * The date a candidate's record may be anonymized: 4 years after the latest decision on any of their
 * applications (or after the record was created if they never applied). The later of that and any
 * stored retainUntil. null while an application or offer is still open, or once they were hired
 * (their record then follows personnel retention).
 */
export function candidateRetainUntil(db: DB, c: Candidate): ISODate | null {
  if (db.people.some((p) => p.fromCandidateId === c.id)) return null
  const apps = db.applications.filter((a) => a.candidateId === c.id)
  if (apps.some((a) => a.status === 'active' || a.status === 'hired')) return null
  const openOffer = db.offers.some(
    (o) => o.candidateId === c.id && (o.status === 'draft' || o.status === 'awaiting_approval' || o.status === 'approved' || o.status === 'sent'),
  )
  if (openOffer) return null
  const decisions = apps.map((a) => a.closedOn ?? a.stageEnteredOn ?? a.appliedOn).filter(Boolean).sort()
  const decision = decisions[decisions.length - 1] ?? c.createdOn
  const computed = applicantRetainUntil(decision)
  return c.retainUntil && c.retainUntil > computed ? c.retainUntil : computed
}

export type AnonymizeItem = {
  candidateId: ID
  name: string
  retainUntil: ISODate
  lastDecisionOn?: ISODate
  reason: string
}

/** Candidates past their retention date who can be anonymized (one tap each). */
export function anonymizeQueue(db: DB, date: ISODate): AnonymizeItem[] {
  const out: AnonymizeItem[] = []
  for (const c of db.candidates) {
    if (c.anonymizedOn) continue
    const until = candidateRetainUntil(db, c)
    if (!until || until >= date) continue
    const decisions = db.applications
      .filter((a) => a.candidateId === c.id)
      .map((a) => a.closedOn)
      .filter((d): d is ISODate => !!d)
      .sort()
    out.push({
      candidateId: c.id,
      name: fullName(c),
      retainUntil: until,
      lastDecisionOn: decisions[decisions.length - 1],
      reason: 'Past the 4-year applicant record retention period (Gov. Code 12946).',
    })
  }
  return out.sort((a, b) => a.retainUntil.localeCompare(b.retainUntil))
}
