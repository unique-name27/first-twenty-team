// Background checks and the Fair Chance Act (Gov Code 12952; LAW.md a-fca-5, b-ca-fair-chance).
//
// Hard stop 2 of 2 (docs/SPEC.md): criminal history cannot be recorded, and a background check
// cannot start, before a conditional offer exists (application.conditionalOfferOn, set when the
// offer is accepted). The app applies the 5+ employee standard at every company size.
// Results are stored as Clear or Consider only, never the report. Consider opens the Fair Chance
// steps: individualized assessment, preliminary notice with the report and rights, at least 5
// business days to respond (5 more if the candidate disputes the report in writing), final notice,
// decision. Credit checks are off by default and need a Labor Code 1024.5 basis.
// Pure functions; the matching mutations live in backgroundChecks.ts.
import type { Application, BackgroundCheck, Job } from '@/domain/types'
import { addBusinessDays, addDays, type ISODate } from '@/lib/dates'
import { type Citation, type HolidayInput, holidayDates } from './util'

function fairChanceCitation(): Citation {
  return { label: 'Gov Code 12952', url: 'https://calcivilrights.ca.gov/wp-content/uploads/sites/32/2025/07/Fair-Chance-Act-Factsheet_English.pdf' }
}

/** A background check starts only after the offer is accepted (conditional offer date recorded). */
export function canStartBackgroundCheck(app: Pick<Application, 'conditionalOfferOn'> | null | undefined): boolean {
  return !!app?.conditionalOfferOn
}

/** Hard stop 2: criminal history can be recorded only after a conditional offer. */
export function canRecordCriminalHistory(app: Pick<Application, 'conditionalOfferOn'> | null | undefined): boolean {
  return !!app?.conditionalOfferOn
}

/** Why the background check or criminal-history fields are locked, or null when they are open. */
export function criminalHistoryLockReason(app: Pick<Application, 'conditionalOfferOn'> | null | undefined): string | null {
  if (canRecordCriminalHistory(app)) return null
  return 'Locked until the candidate accepts a conditional offer. California bars asking about or checking criminal history before then (Fair Chance Act, Gov Code 12952).'
}

/**
 * When the candidate is treated as having received the preliminary notice: the day it went out, or
 * 5 calendar days after mailing for a notice mailed within California without confirmed receipt
 * (2 CCR 11017.1(c)(2)(E); LAW.md b-ca-fair-chance).
 */
export function preliminaryNoticeReceivedOn(bg: Pick<BackgroundCheck, 'fairChance'>): ISODate | undefined {
  const fc = bg.fairChance
  if (!fc?.preliminaryNoticeOn) return undefined
  return fc.preliminaryNoticeMethod === 'mail' ? addDays(fc.preliminaryNoticeOn, 5) : fc.preliminaryNoticeOn
}

/**
 * Response deadline: 5 business days after the preliminary notice is received, 10 when the candidate
 * disputes (Gov Code 12952(c)(4) adds 5 more business days).
 */
export function responseDueOn(bg: Pick<BackgroundCheck, 'fairChance'>, holidays: HolidayInput = []): ISODate | undefined {
  const fc = bg.fairChance
  const received = preliminaryNoticeReceivedOn(bg)
  if (!fc || !received) return undefined
  return addBusinessDays(received, fc.disputed ? 10 : 5, holidayDates(holidays))
}

/**
 * Order checks for recording a preliminary notice: the individualized assessment must come first
 * (Gov Code 12952(c)(1)), and the notice cannot predate the report. Warnings only, never a block.
 */
export function preliminaryNoticeWarnings(bg: Pick<BackgroundCheck, 'fairChance' | 'completedOn'>): string[] {
  const fc = bg.fairChance
  if (!fc?.preliminaryNoticeOn) return []
  const out: string[] = []
  if (!fc.assessmentOn) out.push('Record the individualized assessment. The law requires it before the preliminary notice.')
  else if (fc.preliminaryNoticeOn < fc.assessmentOn) out.push('The preliminary notice is dated before the individualized assessment. The assessment has to come first.')
  if (bg.completedOn && fc.preliminaryNoticeOn < bg.completedOn) out.push('The preliminary notice is dated before the background check result came back. Check the dates.')
  return out
}

/** The final notice can go out only after the response window closes. */
export function earliestFinalNoticeOn(bg: Pick<BackgroundCheck, 'fairChance'>, holidays: HolidayInput = []): ISODate | undefined {
  const due = responseDueOn(bg, holidays)
  return due ? addBusinessDays(due, 1, holidayDates(holidays)) : undefined
}

export type FairChanceStepKey = 'assessment' | 'preliminary_notice' | 'response_window' | 'final_notice' | 'decision'

export type FairChanceStep = {
  key: FairChanceStepKey
  title: string
  why: string
  done: boolean
  doneOn?: ISODate
  /** Target or legal due date. */
  dueOn?: ISODate
  /** Not allowed before this date (the final notice waits for the response window). */
  notBefore?: ISODate
  /** True when the date is a legal minimum, not just a suggested target. */
  statutory: boolean
  citation: Citation
}

/**
 * Ordered Fair Chance steps with computed dates. Empty unless the result is Consider. Assessment and
 * preliminary notice carry suggested targets (2 business days each); the response window is the
 * legal minimum; the final notice cannot go out before the window closes.
 */
export function fairChanceSteps(bg: BackgroundCheck | null | undefined, holidays: HolidayInput = []): FairChanceStep[] {
  if (!bg || bg.result !== 'consider') return []
  const h = holidayDates(holidays)
  const fc = bg.fairChance ?? {}
  const cite = fairChanceCitation()
  const assessmentDue = bg.completedOn ? addBusinessDays(bg.completedOn, 2, h) : undefined
  const noticeDue = fc.assessmentOn ? addBusinessDays(fc.assessmentOn, 2, h) : assessmentDue ? addBusinessDays(assessmentDue, 2, h) : undefined
  const respDue = responseDueOn(bg, h)
  const finalNotBefore = earliestFinalNoticeOn(bg, h)
  const steps: FairChanceStep[] = [
    {
      key: 'assessment',
      title: 'Individualized assessment',
      why: 'Weigh the nature and gravity of the offense, the time since it happened, and the duties of this job. Convictions older than 7 years cannot be considered. Write a short note; never store the report.',
      done: !!fc.assessmentOn,
      ...(fc.assessmentOn ? { doneOn: fc.assessmentOn } : {}),
      ...(assessmentDue ? { dueOn: assessmentDue } : {}),
      statutory: false,
      citation: cite,
    },
    {
      key: 'preliminary_notice',
      title: 'Preliminary notice with the report and rights',
      why: 'If you are leaning toward rescinding, send written notice naming the convictions, a copy of the report, and the right to respond with evidence of rehabilitation or that the report is wrong. Include the FCRA summary of rights.',
      done: !!fc.preliminaryNoticeOn,
      ...(fc.preliminaryNoticeOn ? { doneOn: fc.preliminaryNoticeOn } : {}),
      ...(noticeDue ? { dueOn: noticeDue } : {}),
      statutory: false,
      citation: cite,
    },
    {
      key: 'response_window',
      title: fc.disputed ? 'Response window (disputed: 10 business days)' : 'Response window (5 business days)',
      why: 'Wait at least 5 business days for a response. If the candidate disputes the report in writing within that time and is getting evidence, wait 5 more business days. A notice mailed without confirmed receipt counts as received 5 calendar days after mailing, so the window starts then. Consider anything they send before deciding.',
      done: !!fc.finalNoticeOn || (!!fc.decision && fc.decision === 'proceed'),
      ...(respDue ? { dueOn: respDue } : {}),
      statutory: true,
      citation: cite,
    },
    {
      key: 'final_notice',
      title: 'Final notice',
      why: 'If you still decide to rescind, send a written final notice that names the convictions, explains any way to challenge the decision, and states the right to file a complaint with the Civil Rights Department.',
      done: !!fc.finalNoticeOn,
      ...(fc.finalNoticeOn ? { doneOn: fc.finalNoticeOn } : {}),
      ...(finalNotBefore ? { notBefore: finalNotBefore, dueOn: finalNotBefore } : {}),
      statutory: true,
      citation: cite,
    },
    {
      key: 'decision',
      title: 'Decision',
      why: 'Confirm the offer or rescind it, and log the reason.',
      done: !!fc.decision,
      statutory: false,
      citation: cite,
    },
  ]
  return steps
}

// ---- Credit checks --------------------------------------------------------------------------

export type CreditCheckBasis = { id: string; label: string; detail?: string }

/**
 * Labor Code 1024.5(a) positions where a consumer credit report may be used, plus the 1024.5(b)
 * exception for GLBA-regulated financial institutions (LAW.md b-ca-lc1024-5-credit).
 */
export const CREDIT_CHECK_BASES: CreditCheckBasis[] = [
  { id: 'managerial', label: 'Managerial position', detail: 'Executive-exempt managers under Wage Order 4, not every manager title.' },
  {
    id: 'signatory_money',
    label: 'Signs on company accounts or moves money',
    detail: "Named signatory on the employer's bank or credit card account, authorized to transfer money, or authorized to enter financial contracts for the employer.",
  },
  {
    id: 'account_and_identity_access',
    label: 'Regular access to account numbers with SSN and date of birth',
    detail: "Regular access to bank or credit card account information, plus the Social Security number and date of birth, of any one person (not routine retail transactions).",
  },
  {
    id: 'trade_secrets',
    label: 'Access to confidential information or trade secrets',
    detail: 'Access to confidential or proprietary information, including trade secrets as defined in the statute (general proprietary information shared widely does not count).',
  },
  { id: 'cash_10k', label: 'Regular access to $10,000 or more in cash' },
  { id: 'required_by_law', label: 'Information required by law', detail: 'The information in the report is required by law to be disclosed or obtained.' },
  { id: 'law_enforcement', label: 'Sworn peace officer or law enforcement position' },
  { id: 'doj', label: 'Position with the California Department of Justice' },
  {
    id: 'glba',
    label: 'GLBA-regulated financial institution',
    detail: 'The employer is subject to the Gramm-Leach-Bliley Act and under compliance oversight by a state or federal regulator (Labor Code 1024.5(b)).',
  },
]

export function creditCheckBasisLabel(id: string | null | undefined): string {
  return CREDIT_CHECK_BASES.find((b) => b.id === id)?.label ?? ''
}

/** Credit checks need a listed basis; without one they stay off. */
export function creditCheckAllowed(job: Pick<Job, 'creditCheckBasis'>): boolean {
  return !!job.creditCheckBasis && CREDIT_CHECK_BASES.some((b) => b.id === job.creditCheckBasis)
}

export type CreditCheckNoticeTask = {
  title: string
  why: string
  citation: Citation
  basis: string
  /** Civil Code 1785.20.5 is not verified in docs/LAW.md (b-ca-lc1024-5-credit checker note). */
  needsReview: true
  /** Show next to the citation chip. */
  reviewNote: string
}

/**
 * The written notice owed to each candidate before their credit report is ordered (Civil Code
 * 1785.20.5): that a credit report will be used, the Labor Code 1024.5 basis, and the source of the
 * report, with a box to check for a free copy. Created per candidate when the background check
 * starts on a job with a credit check basis (backgroundChecks.ts startBackgroundCheck).
 */
export function creditCheckNoticeTask(job: Pick<Job, 'title' | 'creditCheckBasis'>, candidateName?: string): CreditCheckNoticeTask {
  const basis = creditCheckBasisLabel(job.creditCheckBasis) || 'a Labor Code 1024.5 basis'
  return {
    title: candidateName
      ? `Send ${candidateName} the written credit check notice before ordering a credit report (${job.title})`
      : `Send the written credit check notice before ordering a report (${job.title})`,
    why: `Before requesting a consumer credit report, give the candidate written notice that a credit report will be used, the specific Labor Code 1024.5 basis (${basis}), and the source of the report, with a box they can check to get a free copy.`,
    citation: { label: 'Civil Code 1785.20.5', url: 'https://california.public.law/codes/civil_code_section_1785.20.5' },
    basis,
    needsReview: true,
    reviewNote: 'Not verified here; confirm with counsel.',
  }
}
