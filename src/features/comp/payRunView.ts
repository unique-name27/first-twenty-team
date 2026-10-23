// Pure helpers that shape pay run prep (src/domain/payrun) for Comp and plan > Pay runs (tested in payRunView.test.ts):
// which period the page opens on, the status word per period, time off and estimate wording, what changed, the list
// of things to check, who marked a run submitted, and the printable regular paydays notice (Labor Code 207,
// docs/LAW.md w-payday-notice).
import { fullName } from '@/domain/people'
import {
  hasPaidPeople,
  nextPayPeriod,
  nextPayRunDue,
  type PayPeriod,
  type PayRunFlag,
  type PayRunPrep,
  type PayRunRow,
  type PayRunTotals,
  payCalendar,
  paydayWords,
  payRunStatus,
  periodChanges,
  periodContaining,
  periodLabel,
  periodsAround,
  periodStarting,
  runForPeriod,
  type TimeOffBuckets,
} from '@/domain/payrun'
import type { DB, PayRunRecord } from '@/domain/types'
import { addDays, fmtDate, fmtDay, type ISODate } from '@/lib/dates'
import { escapeHTML } from '@/lib/files'
import { hoursNum, plural } from '@/lib/format'

/** Periods the picker lists before and after the one containing today. */
export const PERIODS_BACK = 6
export const PERIODS_AHEAD = 6

/**
 * The period the page shows: the one starting on the route's date when the schedule has it, else the next payroll to
 * run (nextPayRunDue: the earliest payday today or later not marked submitted, with someone paid on it), else the next
 * payday, else the period containing today.
 */
export function selectedPeriod(db: DB, segment: string | undefined, date: ISODate): PayPeriod {
  const fromRoute = segment && /^\d{4}-\d{2}-\d{2}$/.test(segment) ? periodStarting(db, segment) : undefined
  return fromRoute ?? nextPayRunDue(db, date) ?? nextPayPeriod(db, date) ?? periodContaining(db, date)
}

/**
 * The periods the picker offers: PERIODS_BACK before today's, today's and PERIODS_AHEAD after, plus the shown one.
 * A company that started paying people recently starts the list at its first paid period (or today's, when nobody is
 * paid yet), not at periods before anyone was on payroll.
 */
export function periodChoices(db: Pick<DB, 'company' | 'holidays' | 'people' | 'comp'>, date: ISODate, shown?: PayPeriod): PayPeriod[] {
  const around = periodsAround(db, date, PERIODS_BACK, PERIODS_AHEAD)
  const todayAt = Math.max(0, around.findIndex((p) => p.start <= date && p.end >= date))
  const firstPaid = around.findIndex((p) => hasPaidPeople(db, p))
  const list = around.slice(firstPaid >= 0 ? Math.min(firstPaid, todayAt) : todayAt)
  if (shown && !list.some((p) => p.start === shown.start)) return [...list, shown].sort((a, b) => a.start.localeCompare(b.start))
  return list
}

/** The periods just before and after one, for Previous and Next. */
export function neighborPeriods(db: Pick<DB, 'company' | 'holidays'>, period: PayPeriod): { prev?: PayPeriod; next?: PayPeriod } {
  const prev = payCalendar(db, addDays(period.start, -1), addDays(period.start, -1))[0]
  const next = payCalendar(db, addDays(period.end, 1), addDays(period.end, 1))[0]
  return { ...(prev ? { prev } : {}), ...(next ? { next } : {}) }
}

export type StatusWord = { label: string; tone: 'good' | 'warn' | 'neutral' | 'outline' | 'accent' }

/**
 * 'Submitted', 'No payroll' (nobody on it is paid: a new company's periods before the first pay), 'Run by Tue, Oct
 * 13', 'Cutoff passed', 'Not marked' or 'Upcoming' (more than two weeks out).
 */
export function periodStatusWord(db: Pick<DB, 'company' | 'people' | 'comp'>, period: PayPeriod, date: ISODate): StatusWord {
  const status = payRunStatus(runForPeriod(db.company.payRuns, period), period, date)
  if (status === 'submitted') return { label: 'Submitted', tone: 'good' }
  if (!hasPaidPeople(db, period)) return { label: 'No payroll', tone: 'neutral' }
  if (status === 'not_marked') return { label: 'Not marked', tone: 'outline' }
  if (period.cutoff < date) return { label: 'Cutoff passed', tone: 'warn' }
  if (period.cutoff > addDays(date, 14)) return { label: 'Upcoming', tone: 'outline' }
  return { label: `Run by ${fmtDay(period.cutoff)}`, tone: 'accent' }
}

/**
 * The status for the pay calendar table, where the Run by column (or, on a phone, the line under the payday) already
 * shows the cutoff: 'Due soon' instead of 'Run by Tue, Oct 13', so four columns fit at 375px in every look.
 */
export function periodStatusShort(db: Pick<DB, 'company' | 'people' | 'comp'>, period: PayPeriod, date: ISODate): StatusWord {
  const word = periodStatusWord(db, period, date)
  return word.tone === 'accent' ? { label: 'Due soon', tone: 'accent' } : word
}

/** 'Submitted Tue, Oct 13 by Jasmine Torres' (or without a name when none was recorded); '' when not submitted. */
export function submittedText(db: Pick<DB, 'people'>, record: PayRunRecord | undefined): string {
  if (!record?.submittedOn) return ''
  const by = record.submittedById ? db.people.find((p) => p.id === record.submittedById) : undefined
  return `Submitted ${fmtDay(record.submittedOn)}${by ? ` by ${fullName(by)}` : ''}`
}

/** 'PTO 16 hours, sick 8 hours, other 8 hours'; '' with none. Hours to one decimal. */
export function timeOffText(t: TimeOffBuckets): string {
  const parts: string[] = []
  const add = (label: string, h: number) => {
    if (h > 0) parts.push(`${label} ${hoursNum(h)} ${h === 1 ? 'hour' : 'hours'}`)
  }
  add('PTO', t.pto)
  add('sick', t.sick)
  add('other', t.other)
  add('unpaid', t.unpaid)
  return parts.join(', ')
}

/**
 * The short line under an estimate: why the salary part is not the regular check, or where hourly pay comes from.
 * A sign-on bonus and a vacation payout get lines of their own, with the amount, on the page.
 */
export function estimateNote(r: PayRunRow): string {
  if (r.paidOffCycle) return 'Final pay issued off-cycle'
  if (r.salaryEstimate === null) return 'Hours from your time tracking'
  if (r.weekdaysOnPayroll > 0 && r.flags.some((f) => f.kind === 'leave_all_period')) return 'On leave all period'
  const parts: string[] = []
  if (r.weekdaysOnPayroll < r.weekdays) parts.push(`${r.weekdaysOnPayroll} of ${r.weekdays} weekdays`)
  if (r.flags.some((f) => f.kind === 'leave_partial')) parts.push('part on leave')
  if (r.payChanges.length) parts.push('split at the pay change')
  if (r.unpaidDaysDeducted > 0) parts.push(`less ${r.unpaidDaysDeducted} unpaid ${r.unpaidDaysDeducted === 1 ? 'day' : 'days'}`)
  else if (r.deduction > 0) parts.push('less unpaid hours')
  return parts.length ? parts.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'Regular check'
}

/**
 * The notes for the page: the export's notes without the estimate disclaimer (the page says it once, above) and
 * without 'Hours from your time tracking' (the estimate column says it).
 */
export function rowNotes(r: PayRunRow): string[] {
  return r.notes.filter((n) => !n.startsWith('Estimate only') && n !== 'Hours from your time tracking')
}

export type ChangeLine = { key: 'newHires' | 'leaving' | 'payChanges' | 'bonuses' | 'timeOff' | 'leaves'; label: string; text: string }

/**
 * What changed in the period, one line per kind with names and dates ('Lucas Ferreira, Mon, Oct 19'). Kinds with
 * nobody are left out. Leave lines carry dates only, never the kind of leave.
 */
export function changeLines(prep: PayRunPrep): ChangeLine[] {
  const c = periodChanges(prep)
  const out: ChangeLine[] = []
  const list = (rows: PayRunRow[], f: (r: PayRunRow) => string) => rows.map(f).join('; ')
  if (c.newHires.length) out.push({ key: 'newHires', label: 'Starting', text: list(c.newHires, (r) => `${r.name}, ${fmtDay(r.startInPeriod)}`) })
  if (c.leaving.length) out.push({ key: 'leaving', label: 'Last days', text: list(c.leaving, (r) => `${r.name}, ${fmtDay(r.endInPeriod)}`) })
  if (c.payChanges.length) {
    out.push({ key: 'payChanges', label: 'Pay changes', text: list(c.payChanges, (r) => `${r.name}, ${r.payChanges.map((p) => fmtDay(p.effectiveOn)).join(' and ')}`) })
  }
  if (c.bonuses.length) out.push({ key: 'bonuses', label: 'Sign-on bonuses', text: list(c.bonuses, (r) => r.name) })
  if (c.timeOff.length) out.push({ key: 'timeOff', label: 'Time off', text: list(c.timeOff, (r) => `${r.name} (${timeOffText(r.timeOff)})`) })
  if (c.leaves.length) out.push({ key: 'leaves', label: 'On leave', text: list(c.leaves, (r) => `${r.name}, ${periodLabel({ start: r.leave?.from ?? '', end: r.leave?.to ?? '' })}`) })
  return out
}

/** One amount in the footer under Everyone on this payroll: what it is, and whose for amounts outside the total. */
export type FooterAmount = { amount: number; what: string; name?: string }

/**
 * The footer's parts. `included` are inside the estimated gross ('including $10,000.00 in sign-on bonuses'), so the
 * word 'including' is only ever said of amounts in the sum. `outside` are hourly people's bonuses and payouts, which
 * are not in it: 'plus $667.50 of vacation payout for Luis Ortega (hourly)'. `hourlyNote` says where hours come from.
 */
export function grossFooter(totals: PayRunTotals): { included: FooterAmount[]; outside: FooterAmount[]; hourlyNote: string } {
  const included: FooterAmount[] = []
  if (totals.bonus > 0) included.push({ amount: totals.bonus, what: 'in sign-on bonuses' })
  if (totals.vacationPayout > 0) included.push({ amount: totals.vacationPayout, what: 'of vacation payout' })
  if (totals.otherPayout > 0) included.push({ amount: totals.otherPayout, what: 'of other payouts at exit' })
  const outside: FooterAmount[] = []
  for (const o of totals.outside) {
    if (o.bonus > 0) outside.push({ amount: o.bonus, what: 'sign-on bonus', name: o.name })
    if (o.vacationPayout > 0) outside.push({ amount: o.vacationPayout, what: 'of vacation payout', name: o.name })
    if (o.otherPayout > 0) outside.push({ amount: o.otherPayout, what: 'of other payouts at exit', name: o.name })
  }
  const hourlyNote = totals.hourly > 0 ? `${plural(totals.hourly, 'person', 'people')} paid hourly: the hours come from your time tracking.` : ''
  return { included, outside, hourlyNote }
}

export type CheckItem = { personId: string; name: string; flag: PayRunFlag }

const TONE_ORDER: Record<PayRunFlag['tone'], number> = { bad: 0, warn: 1, info: 2 }

/** Every flag in the period with whose it is, deadlines first, then reminders, then notes. */
export function checkList(prep: PayRunPrep): CheckItem[] {
  return prep.rows
    .flatMap((r) => r.flags.map((flag) => ({ personId: r.personId, name: r.name, flag })))
    .sort((a, b) => TONE_ORDER[a.flag.tone] - TONE_ORDER[b.flag.tone] || a.name.localeCompare(b.name))
}

/** The word a flag's badge says (state is shown in form, not color alone). */
export function flagWord(tone: PayRunFlag['tone']): string {
  return tone === 'bad' ? 'Deadline' : tone === 'warn' ? 'Check' : 'Note'
}

/** The next `count` paydays from `date`, for the pay calendar and the regular paydays notice. */
export function upcomingPaydays(db: Pick<DB, 'company' | 'holidays'>, date: ISODate, count = 12): PayPeriod[] {
  return payCalendar(db, date, addDays(date, 31 * Math.ceil(count / 2) + 31))
    .filter((p) => p.payday >= date)
    .slice(0, count)
}

/**
 * The regular paydays notice to post where employees can see it (Labor Code 207): the paydays in words, the next
 * paydays, and blanks for the time and place of payment, which the app does not know. Plain text for Copy.
 */
export function paydayNoticeText(db: Pick<DB, 'company' | 'holidays'>, date: ISODate): string {
  const c = db.company
  const lines = [
    `Regular paydays: ${c.legalName || c.name}`,
    '',
    `Wages are paid ${paydayWords(c)}.`,
    '',
    'Next paydays:',
    ...upcomingPaydays(db, date).map((p) => `- ${fmtDay(p.payday)}, ${p.payday.slice(0, 4)}: pay for ${periodLabel(p)}`),
    '',
    'Time of payment: ______________________',
    'Place or method of payment: ______________________',
    '',
    `Posted ${fmtDate(date)} (California Labor Code 207).`,
  ]
  return lines.join('\n')
}

/** The same notice as print-ready HTML (printHTML from src/lib/files.ts). */
export function paydayNoticeHTML(db: Pick<DB, 'company' | 'holidays'>, date: ISODate): string {
  const c = db.company
  const rows = upcomingPaydays(db, date)
    .map((p) => `<tr><td>${escapeHTML(fmtDay(p.payday))}, ${p.payday.slice(0, 4)}</td><td>${escapeHTML(periodLabel(p))}</td></tr>`)
    .join('')
  return [
    `<h1>Regular paydays</h1>`,
    `<p><strong>${escapeHTML(c.legalName || c.name)}</strong></p>`,
    `<p>Wages are paid ${escapeHTML(paydayWords(c))}.</p>`,
    `<h2>Next paydays</h2>`,
    `<table><thead><tr><th>Payday</th><th>Pay for work on</th></tr></thead><tbody>${rows}</tbody></table>`,
    `<p>Time of payment: ______________________</p>`,
    `<p>Place or method of payment: ______________________</p>`,
    `<p class="muted">Posted ${escapeHTML(fmtDate(date))}. California Labor Code 207 requires every employer to keep its regular paydays and the time and place of payment posted.</p>`,
  ].join('\n')
}
