// The verified legal facts the assistant may quote (its law_facts tool): the 2026 constants in
// src/data/law.ts with the source each was checked against, and the rules of the compliance engine
// (src/domain/compliance/rules.ts) that the research pass verified, each with its official citation. The
// assistant explains rules from these, never from memory alone, and links only these sources.
import { BENEFIT_LIMITS_2026, CA_SICK_LEAVE, DEFAULT_LAW, FINAL_PAY, LAW_LAST_REVIEWED, LAW_SOURCES, LOCAL_MIN_WAGES, PAYROLL_TAX_2026 } from '../../../src/data/law'
import { JURISDICTION_LABELS, RULES } from '../../../src/domain/compliance'

export type LawFact = {
  id: string
  /** Federal, California, San Jose, a Bay Area city. */
  where: string
  title: string
  text: string
  source: { label: string; url: string }
  /** Extra words a question may use for it. */
  keywords: string
}

const usd = (n: number, digits = 0) => `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
const pctOf = (f: number) => `${(f * 100).toFixed(f * 100 < 1 ? 2 : 1).replace(/\.0$/, '')}%`

/** The constants of src/data/law.ts as facts, each with the source it was verified against. */
function constantFacts(): LawFact[] {
  const s = LAW_SOURCES
  const year = DEFAULT_LAW.year
  const facts: LawFact[] = [
    {
      id: 'ca-min-wage',
      where: 'California',
      title: `California minimum wage (${year})`,
      text: `${usd(DEFAULT_LAW.caMinWageHourly, 2)} an hour for all employers, from January 1, ${year}.`,
      source: s.caMinWage,
      keywords: 'minimum wage hourly pay floor',
    },
    {
      id: 'sj-min-wage',
      where: 'San Jose',
      title: `San Jose minimum wage (${year})`,
      text: `${usd(DEFAULT_LAW.sanJoseMinWageHourly, 2)} an hour in the City of San Jose for calendar ${year}.`,
      source: s.sanJoseMinWage,
      keywords: 'minimum wage hourly local city ordinance',
    },
    {
      id: 'ca-exempt-salary',
      where: 'California',
      title: `Exempt salary minimum (${year})`,
      text: `Executive, administrative and professional exemptions need a salary of at least ${usd(DEFAULT_LAW.exemptSalaryMin)} a year (2 x the state minimum wage x 2,080 hours).`,
      source: s.exemptSalary,
      keywords: 'exempt salary threshold overtime flsa white collar',
    },
    {
      id: 'ca-computer-pro',
      where: 'California',
      title: `Computer software employee exemption (${year})`,
      text: `At least ${usd(DEFAULT_LAW.computerProHourly, 2)} an hour, ${usd(DEFAULT_LAW.computerProMonthly, 2)} a month or ${usd(DEFAULT_LAW.computerProAnnual, 2)} a year (Labor Code 515.5).`,
      source: s.computerPro,
      keywords: 'exempt software engineer computer professional overtime',
    },
    {
      id: 'ca-sick-leave',
      where: 'California',
      title: 'California paid sick leave',
      text:
        `Employees earn at least 1 hour per 30 hours worked (or get ${CA_SICK_LEAVE.minUsageHours} hours or ${CA_SICK_LEAVE.minUsageDays} days up front). ` +
        `Employers may cap use at ${CA_SICK_LEAVE.minUsageHours} hours or ${CA_SICK_LEAVE.minUsageDays} days a year and accrual at ${CA_SICK_LEAVE.accrualCapHours} hours or ${CA_SICK_LEAVE.accrualCapDays} days; ` +
        `use may wait until day ${CA_SICK_LEAVE.waitingDays} of employment. Unused sick leave is not paid out at separation, ` +
        `and it comes back on a rehire within ${CA_SICK_LEAVE.reinstateIfRehiredWithinMonths} months.`,
      source: s.paidSickLeave,
      keywords: 'sick leave psl accrual labor code 246 sb 616 time off',
    },
    {
      id: 'ca-final-pay',
      where: 'California',
      title: 'Final pay deadlines',
      text: `Fired or laid off: ${FINAL_PAY.involuntary} Quit with notice: ${FINAL_PAY.voluntaryWithNotice} Quit without notice: ${FINAL_PAY.voluntaryWithoutNotice} Late final pay can cost a day's wages per day, up to ${FINAL_PAY.waitingTimePenaltyMaxDays} days.`,
      source: s.finalPay,
      keywords: 'final paycheck termination quit resign waiting time penalty vacation payout labor code 201 202 203',
    },
    {
      id: 'ca-waiting-time',
      where: 'California',
      title: 'Waiting time penalty',
      text: `Final pay paid late can owe the employee up to ${FINAL_PAY.waitingTimePenaltyMaxDays} days of wages (Labor Code 203).`,
      source: s.waitingTime,
      keywords: 'final pay late penalty labor code 203',
    },
    {
      id: 'fica',
      where: 'Federal',
      title: `Employer Social Security and Medicare (${year})`,
      text: `Social Security ${pctOf(PAYROLL_TAX_2026.socialSecurityRate)} on wages up to ${usd(PAYROLL_TAX_2026.socialSecurityWageBase)}; Medicare ${pctOf(PAYROLL_TAX_2026.medicareRate)} on all wages.`,
      source: s.fica,
      keywords: 'payroll tax fica social security medicare employer cost',
    },
    {
      id: 'futa',
      where: 'Federal',
      title: `FUTA for California employers (${year})`,
      text: `FUTA applies to the first ${usd(PAYROLL_TAX_2026.futaWageBase)} of each employee's wages. California's credit reduction makes it about ${pctOf(PAYROLL_TAX_2026.futaEffectiveRate)} if the add-on waiver is granted, up to ${pctOf(PAYROLL_TAX_2026.futaEffectiveRateNoWaiver)} if not (final after November 10, ${year}).`,
      source: s.futaCredit,
      keywords: 'futa unemployment federal payroll tax credit reduction',
    },
    {
      id: 'ca-ui-ett-sdi',
      where: 'California',
      title: `California UI, ETT and SDI (${year})`,
      text: `New employers pay UI at ${pctOf(PAYROLL_TAX_2026.caUiRate)} and ETT at ${pctOf(PAYROLL_TAX_2026.caEttRate)} on the first ${usd(PAYROLL_TAX_2026.caUiWageBase)} of wages. SDI (${pctOf(PAYROLL_TAX_2026.caSdiEmployeeRate)}, no wage cap) is withheld from employees, not an employer cost.`,
      source: s.eddRates,
      keywords: 'edd unemployment insurance ett sdi state disability payroll tax',
    },
    {
      id: 'k401-limits',
      where: 'Federal',
      title: `401(k) limits (${year})`,
      text: `Employees may defer up to ${usd(BENEFIT_LIMITS_2026.k401Deferral)}; catch-up ${usd(BENEFIT_LIMITS_2026.k401CatchUp50)} at 50 and over, ${usd(BENEFIT_LIMITS_2026.k401CatchUp60to63)} at ages 60 to 63.`,
      source: s.k401,
      keywords: '401k retirement deferral catch-up benefits',
    },
    {
      id: 'hsa-limits',
      where: 'Federal',
      title: `HSA limits (${year})`,
      text: `${usd(BENEFIT_LIMITS_2026.hsaSelf)} for self-only coverage, ${usd(BENEFIT_LIMITS_2026.hsaFamily)} for family coverage.`,
      source: s.hsa,
      keywords: 'hsa health savings account benefits',
    },
  ]
  const out = [...facts]
  for (const w of LOCAL_MIN_WAGES) {
    const next = w.next ? ` It rises to ${usd(w.next.hourly, 2)} on ${w.next.effective}.` : ''
    out.push({
      id: `min-wage-${w.city.toLowerCase().replace(/[^a-z]+/g, '-')}`,
      where: w.city,
      title: `${w.city} minimum wage`,
      text: `${usd(w.hourly, 2)} an hour from ${w.effective}.${next}`,
      source: w.city === 'San Jose' ? s.sanJoseMinWage : w.city === 'San Francisco' ? s.sfMinWage : s.bayAreaWages,
      keywords: 'minimum wage hourly local city bay area',
    })
  }
  // Topics the app links to without a figure of its own: the official page is the fact.
  const pages: Array<[string, string, string, keyof typeof s]> = [
    ['ca-overtime', 'California overtime', 'overtime daily weekly double time non-exempt hours', 'overtime'],
    ['ca-meal-periods', 'California meal periods', 'meal break lunch period', 'mealPeriods'],
    ['ca-rest-periods', 'California rest periods', 'rest break', 'restPeriods'],
    ['ca-vacation', 'California vacation', 'vacation pto accrual cap use it or lose it payout', 'vacation'],
    ['ca-paydays', 'California paydays (Labor Code 204)', 'payday pay schedule semi-monthly', 'lc204'],
    ['ca-wage-statements', 'California wage statements (Labor Code 226)', 'pay stub wage statement itemized', 'lc226'],
    ['ca-2810-5', 'Labor Code 2810.5 notice to employee', 'wage notice new hire wtpa 2810.5', 'wtpa'],
    ['calsavers', 'CalSavers retirement program', 'calsavers retirement mandate 401k', 'calsavers'],
    ['sf-sick-leave', 'San Francisco paid sick leave', 'san francisco sick leave local', 'sfSickLeave'],
  ]
  for (const [id, title, keywords, key] of pages) {
    out.push({ id, where: title.startsWith('San Francisco') ? 'San Francisco' : 'California', title, text: `Official guidance: ${s[key].label}.`, source: s[key], keywords })
  }
  return out
}

/** The verified rules of the compliance engine as facts (what to do, when it applies, the official citation). */
function ruleFacts(): LawFact[] {
  return RULES.filter((r) => r.verification === 'verified').map((r) => ({
    id: `rule-${r.id}`,
    where: JURISDICTION_LABELS[r.jurisdiction],
    title: r.title,
    text: `${r.summary} When it applies: ${r.countMethod}`,
    source: { label: r.citation.label, url: r.citation.url },
    keywords: `${r.id.replace(/-/g, ' ')} ${r.category} ${r.trigger.kind === 'headcount' ? `${r.trigger.n} employees headcount threshold` : ''}`,
  }))
}

let cache: LawFact[] | null = null
export function lawFacts(): LawFact[] {
  cache ??= [...constantFacts(), ...ruleFacts()].filter((f) => /^https:\/\//.test(f.source.url))
  return cache
}

export const LAW_FACTS_REVIEWED = LAW_LAST_REVIEWED

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'at', 'do', 'for', 'how', 'i', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'what', 'when', 'who', 'we', 'our', 'does', 'rule', 'rules', 'law', 'laws'])

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .split(' ')
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))

/** The facts that match a topic best (every word counts; title and keyword hits count double), at most `limit`. */
export function matchLawFacts(topic: string, limit = 12): LawFact[] {
  const terms = [...new Set(words(topic))]
  if (terms.length === 0) return []
  const scored = lawFacts()
    .map((f) => {
      const strong = new Set(words(`${f.title} ${f.keywords} ${f.where}`))
      const weak = new Set(words(f.text))
      let score = 0
      for (const t of terms) {
        if (strong.has(t)) score += 2
        else if (weak.has(t)) score += 1
        else if (t.length >= 4 && [...strong].some((w) => w.startsWith(t) || t.startsWith(w))) score += 1
      }
      return { f, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.f.id.localeCompare(b.f.id))
  return scored.slice(0, limit).map((x) => x.f)
}
