// California final pay (Labor Code 201-203) and what is paid out at separation (227.3, 246).
// Facts: docs/LAW.md w-final-pay-termination, w-final-pay-resignation, w-waiting-time-penalty,
// w-vacation-payout, w-psl-separation. Not legal advice.
import { format } from 'date-fns'
import type { ID, Person, SeparationType, TimeOffKind, TimeOffPolicy } from '@/domain/types'
import { addDays, daysBetween, type ISODate, parseDate } from '@/lib/dates'

const PAYDAYS_FAQ = 'https://www.dir.ca.gov/dlse/faq_paydays.htm'

export type FinalPayRule = 'immediate' | 'last_day' | 'within_72_hours'

export type FinalPayDeadline = {
  dueOn: ISODate
  rule: FinalPayRule
  /** One line for the offboarding wizard, e.g. 'Final paycheck due on the last day, Fri Oct 30'. */
  text: string
  /** Why, in one plain sentence with the code section. */
  detail: string
  citation: { label: string; url: string }
}

function day(d: ISODate): string {
  return format(parseDate(d), 'EEE MMM d')
}

/** True when the resignation notice came at least 72 hours (3 calendar days) before the last day. */
export function gave72HoursNotice(noticeGivenOn: ISODate, lastDay: ISODate): boolean {
  return daysBetween(noticeGivenOn, lastDay) >= 3
}

/**
 * When final wages are due. Discharge, layoff and the end of a fixed-term job: immediately, at the
 * termination meeting (Labor Code 201). Resignation with 72+ hours' notice: the last day (202).
 * Resignation without it: within 72 hours, counted here as last day + 3 calendar days (202).
 * A 'resigned_notice' whose notice date is under 72 hours before the last day uses the 72-hour rule.
 */
export function finalPayDeadline(type: SeparationType, lastDay: ISODate, noticeGivenOn?: ISODate): FinalPayDeadline {
  if (type === 'terminated' || type === 'laid_off' || type === 'contract_ended') {
    return {
      dueOn: lastDay,
      rule: 'immediate',
      text:
        type === 'contract_ended'
          ? `Final paycheck due on the last day, ${day(lastDay)}`
          : `Final paycheck due at the termination meeting, ${day(lastDay)}`,
      detail:
        type === 'contract_ended'
          ? 'The end of a fixed-term job counts as a discharge, so all final wages, including accrued vacation, are due on the last day (Labor Code 201).'
          : 'A discharged or laid-off employee is owed all final wages, including accrued vacation, immediately (Labor Code 201).',
      citation: { label: 'Labor Code 201', url: PAYDAYS_FAQ },
    }
  }
  const shortNotice = type === 'resigned_notice' && !!noticeGivenOn && !gave72HoursNotice(noticeGivenOn, lastDay)
  if (type === 'resigned_notice' && !shortNotice) {
    return {
      dueOn: lastDay,
      rule: 'last_day',
      text: `Final paycheck due on the last day, ${day(lastDay)}`,
      detail: "They gave at least 72 hours' notice, so all final wages, including accrued vacation, are due on their last day (Labor Code 202).",
      citation: { label: 'Labor Code 202', url: PAYDAYS_FAQ },
    }
  }
  const dueOn = addDays(lastDay, 3)
  return {
    dueOn,
    rule: 'within_72_hours',
    text: `Final paycheck due within 72 hours, by ${day(dueOn)}`,
    detail: shortNotice
      ? 'Notice came less than 72 hours before the last day, so final wages are due within 72 hours of quitting (Labor Code 202).'
      : "They quit without at least 72 hours' notice, so final wages are due within 72 hours; they may ask for the check to be mailed (Labor Code 202).",
    citation: { label: 'Labor Code 202', url: PAYDAYS_FAQ },
  }
}

/** The waiting-time penalty warning shown next to the final pay deadline. */
export function waitingTimePenaltyNote(): string {
  return 'Paying late can cost a waiting time penalty: a day of pay for each calendar day late, up to 30 days (Labor Code 203).'
}

/** Rough daily rate for the penalty: salary over 260 workdays, or hourly rate times a typical day. */
export function dailyRateFor(pay: { payType: 'salary' | 'hourly'; salary?: number; hourlyRate?: number }, hoursPerWeek = 40): number {
  if (pay.payType === 'hourly') return Math.round((pay.hourlyRate ?? 0) * (hoursPerWeek / 5) * 100) / 100
  return Math.round(((pay.salary ?? 0) / 260) * 100) / 100
}

/** Penalty exposure if final pay is late: calendar days late (capped at 30) times the daily rate. */
export function waitingTimeExposure(input: { dailyRate: number; dueOn: ISODate; asOf: ISODate; paidOn?: ISODate }): {
  daysLate: number
  amount: number
} {
  const end = input.paidOn ?? input.asOf
  const daysLate = Math.min(30, Math.max(0, daysBetween(input.dueOn, end)))
  return { daysLate, amount: Math.round(daysLate * input.dailyRate) }
}

export type PayoutRule = {
  policyId: ID
  name: string
  kind: TimeOffKind
  paidOut: boolean
  text: string
}

/** Does the policy cover this person (its appliesTo: everyone, full-time staff, exempt or non-exempt)? */
export function policyCovers(policy: Pick<TimeOffPolicy, 'appliesTo'>, person: Pick<Person, 'flsa' | 'employmentType'>): boolean {
  switch (policy.appliesTo) {
    case 'full_time':
      return person.employmentType === 'full_time'
    case 'non_exempt':
      return person.flsa === 'non_exempt'
    case 'exempt':
      return person.flsa === 'exempt'
    default:
      return true
  }
}

function isFlexible(p: TimeOffPolicy): boolean {
  return p.kind === 'flexible_vacation' || (p.kind === 'vacation' && p.method === 'flexible')
}

/**
 * What each balance-type policy pays at separation. Accrued vacation is always paid (Labor Code
 * 227.3), flexible vacation pays nothing if it is truly unlimited (a cap or a yearly allowance makes
 * it vacation that must be paid), and separate sick leave is not paid unless the policy says so
 * (Labor Code 246). Leave types without balances are left out. Pass the person to keep only the
 * policies that cover them.
 */
export function payoutRules(policies: TimeOffPolicy[], person?: Pick<Person, 'flsa' | 'employmentType'>): PayoutRule[] {
  const out: PayoutRule[] = []
  for (const p of policies) {
    if (person && !policyCovers(p, person)) continue
    if (isFlexible(p) && (p.capHours != null || p.annualHours != null)) {
      out.push({
        policyId: p.id,
        name: p.name,
        kind: p.kind,
        paidOut: true,
        text: `${p.name}: it has a cap or a yearly allowance, so it is not truly unlimited. Treat unused hours as vacation and pay them at the final rate (Labor Code 227.3).`,
      })
    } else if (isFlexible(p)) {
      out.push({
        policyId: p.id,
        name: p.name,
        kind: p.kind,
        paidOut: false,
        text: `${p.name}: nothing to pay out, as long as it is truly unlimited. A cap or an accrual makes it vacation that must be paid.`,
      })
    } else if (p.kind === 'vacation') {
      out.push({
        policyId: p.id,
        name: p.name,
        kind: p.kind,
        paidOut: true,
        text: p.paidOutOnExit
          ? `${p.name}: accrued, unused hours are paid at the final rate of pay (Labor Code 227.3).`
          : `${p.name}: accrued, unused hours are paid at the final rate of pay. The policy says otherwise, but California requires it (Labor Code 227.3).`,
      })
    } else if (p.kind === 'sick') {
      out.push({
        policyId: p.id,
        name: p.name,
        kind: p.kind,
        paidOut: p.paidOutOnExit,
        text: p.paidOutOnExit
          ? `${p.name}: your policy pays it out, so include it in final pay.`
          : `${p.name}: never paid out (Labor Code 246). Restore the balance if they are rehired within 12 months.`,
      })
    }
  }
  return out
}

/** Does final pay include a vacation payout for this person? One answer for the wizard and the checklist. */
export function vacationPaidAtExit(policies: TimeOffPolicy[], person: Pick<Person, 'flsa' | 'employmentType'>): boolean {
  return payoutRules(policies, person).some((r) => r.paidOut && (r.kind === 'vacation' || r.kind === 'flexible_vacation'))
}
