// Job posting text, the pay-range hard stop at 15 employees, the job post linter and the
// salary-history lint. Pure functions only.
//
// Hard stop 1 of 2 (docs/SPEC.md): once employees plus accepted offers reach 15, a job cannot be
// marked posted without a pay range (Labor Code 432.3, as amended by SB 1162 and SB 642; LAW.md
// a-paytrans-15, b-ca-pay-scale-15). Everything else here is a warning with a why and a citation.
import { headcountOn, incomingOn } from '@/domain/people'
import type { DB, ID, Job } from '@/domain/types'
import { type ISODate } from '@/lib/dates'
import { money, pct } from '@/lib/format'
import { type Citation, vestingText } from './util'

export function payTransparencyThreshold(): number {
  return 15
}

/**
 * Employees today, people already hired who start later, and accepted offers not yet hired. An
 * accepted offer counts only while its application is still active (a candidate who backed out no
 * longer counts). An offer whose application is missing still counts, to err toward the hard stop.
 */
export function postingHeadcount(db: DB, date: ISODate): { employed: number; incoming: number; acceptedOffers: number; total: number } {
  const employed = headcountOn(db, date)
  const incoming = incomingOn(db, date).length
  const hiredApps = new Set(db.people.map((p) => p.fromApplicationId).filter(Boolean))
  const appStatus = new Map(db.applications.map((a) => [a.id, a.status]))
  const acceptedOffers = db.offers.filter((o) => {
    if (o.status !== 'accepted' || o.personId || hiredApps.has(o.applicationId)) return false
    const status = appStatus.get(o.applicationId)
    return status === undefined || status === 'active'
  }).length
  return { employed, incoming, acceptedOffers, total: employed + incoming + acceptedOffers }
}

/**
 * Hard stop: at 15+ (employees today plus incoming hires and accepted offers) a job cannot be posted
 * without a pay range. Returns the reason, or null when posting is allowed.
 */
export function postingBlockReason(db: DB, jobId: ID, date: ISODate): string | null {
  const job = db.jobs.find((j) => j.id === jobId)
  if (!job) return null
  if (job.payMin != null && job.payMax != null) return null
  if (postingHeadcount(db, date).total < payTransparencyThreshold()) return null
  return 'At 15 employees, California requires a pay range on every job post (Labor Code 432.3).'
}

function workModeText(job: Job): string {
  switch (job.workMode) {
    case 'remote':
      return 'remote'
    case 'onsite':
      return 'on site'
    default:
      return 'hybrid'
  }
}

function employmentText(job: Job): string {
  switch (job.employmentType) {
    case 'part_time':
      return 'Part time'
    case 'intern':
      return 'Internship'
    default:
      return 'Full time'
  }
}

function locationText(db: DB, job: Job): string {
  const locs = job.locationIds.map((id) => db.locations.find((l) => l.id === id)).filter((l) => !!l)
  const names = locs.map((l) => (l.kind === 'hq' && l.city ? `${l.city}, ${l.state}` : l.name))
  return names.length ? names.join(' or ') : `${db.company.hq.city}, ${db.company.hq.state}`
}

/** The good-faith pay scale line printed in the posting (never a link or QR code). */
export function payRangeLine(job: Pick<Job, 'payMin' | 'payMax' | 'flsa' | 'employmentType'>): string | null {
  if (job.payMin == null || job.payMax == null) return null
  const hourly = job.payMax < 1000
  const fmt = (n: number) => (hourly ? `$${n.toFixed(2)}` : money(n))
  const basis = hourly ? 'an hour' : 'base salary'
  return `Pay range: ${fmt(job.payMin)} to ${fmt(job.payMax)} ${basis}. This is a good-faith estimate of what we expect to pay.`
}

/**
 * True when the company has a group health plan in place on the date (Settings > Company). The runway
 * cost assumption (costModel.benefitsPerHeadMonthly) says nothing about what the company offers, so a
 * posting promises health coverage only from the recorded plan start.
 */
export function offersHealthPlanOn(db: Pick<DB, 'company'>, date: ISODate): boolean {
  const on = db.company.groupHealthPlanStartedOn
  return typeof on === 'string' && on !== '' && on <= date
}

/** Not recorded yet (undefined), as opposed to recorded as no plan (null): the posting asks for it. */
export function healthPlanUnrecorded(db: Pick<DB, 'company'>): boolean {
  return db.company.groupHealthPlanStartedOn === undefined
}

function benefitsLine(db: DB, year: number, asOf: ISODate): string {
  const vacation = db.timeOffPolicies.find((p) => p.kind === 'vacation' || p.kind === 'flexible_vacation')
  const vac =
    vacation?.kind === 'flexible_vacation' || vacation?.method === 'flexible'
      ? 'flexible vacation'
      : vacation?.annualHours
        ? `${Math.round(vacation.annualHours / 8)} days of vacation a year`
        : 'paid vacation'
  const holidays = db.holidays.filter((h) => h.date.startsWith(String(year))).length
  const parts = [vac, 'California paid sick leave']
  if (offersHealthPlanOn(db, asOf)) parts.unshift('medical, dental and vision coverage')
  if (holidays > 0) parts.push(`${holidays} paid company holidays`)
  return `Benefits: ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.`
}

function sponsorshipLine(job: Job): string {
  switch (job.sponsorship) {
    case 'yes':
      return 'We sponsor work visas for this role.'
    case 'no':
      return 'We are not able to sponsor work visas for this role.'
    default:
      return 'Visa sponsorship for this role is considered case by case.'
  }
}

export function fairChanceStatement(companyName: string): string {
  return `${companyName} will consider qualified applicants with arrest and conviction records in a manner consistent with the California Fair Chance Act. We ask about criminal history only after a conditional offer.`
}

export function eeoStatement(companyName: string): string {
  return `${companyName} is an equal opportunity employer. We make hiring decisions without regard to race, color, religion, sex, gender identity or expression, sexual orientation, national origin, ancestry, age, disability, medical condition, genetic information, marital status, military or veteran status, or any other characteristic protected by law.`
}

/**
 * Copy-ready posting: title, location and work mode, about the company, the description, the pay
 * range, equity and benefits, the no-salary-history line, Fair Chance and EEO statements and the
 * sponsorship stance.
 */
export function postingText(db: DB, jobId: ID, date?: ISODate): string {
  const job = db.jobs.find((j) => j.id === jobId)
  if (!job) return ''
  const name = db.company.name
  const asOf = (date ?? job.openedOn ?? job.postedOn ?? db.meta.createdOn).slice(0, 10)
  const year = Number(asOf.slice(0, 4))
  const band = db.bands.find((b) => b.familyId === job.familyId && b.levelId === job.levelId)
  const lines: string[] = []
  lines.push(job.title)
  lines.push(`${locationText(db, job)} (${workModeText(job)}) | ${employmentText(job)}`)
  lines.push('')
  if (db.company.tagline.trim()) {
    lines.push(`About ${name}`)
    lines.push(db.company.tagline.trim())
    lines.push('')
  }
  if (job.description.trim()) {
    lines.push(job.description.trim())
    lines.push('')
  }
  lines.push('Pay and benefits')
  lines.push(payRangeLine(job) ?? 'Pay range: available on request.')
  if (band?.variablePct) {
    lines.push(
      band.variablePct >= 1
        ? `Plus variable pay (commission) targeted at ${pct(band.variablePct)} of base under a written plan.`
        : `Plus variable pay targeted at ${pct(band.variablePct)} of base.`,
    )
  }
  const eqMin = job.equityMinPct ?? band?.equityMinPct
  const eqMax = job.equityMaxPct ?? band?.equityMaxPct
  if (eqMin && eqMax) {
    lines.push(
      `Equity: stock options of ${pct(eqMin)} to ${pct(eqMax)} of fully diluted shares, ${vestingText(db.settings.defaultVestingMonths, db.settings.defaultCliffMonths)}.`,
    )
  }
  lines.push(benefitsLine(db, year, asOf))
  lines.push('We never ask about salary history.')
  lines.push('')
  lines.push(sponsorshipLine(job))
  if (job.backgroundCheck) lines.push('Offers depend on a background check, which runs only after a conditional offer.')
  lines.push('')
  lines.push(fairChanceStatement(name))
  lines.push('')
  lines.push(eeoStatement(name))
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

// ---- Linting --------------------------------------------------------------------------------

export type LintWarning = {
  code: 'missing_range' | 'missing_fair_chance' | 'criminal_history' | 'age_coded' | 'jargon' | 'salary_history' | 'cannabis'
  message: string
  match?: string
  citation?: Citation
  /** Part of the message rests on a rule not verified in docs/LAW.md; show this next to the citation. */
  reviewNote?: string
}

function lintRules(): Array<{ code: LintWarning['code']; re: RegExp; message: (m: string) => string; citation?: Citation }> {
  return [
    {
      code: 'criminal_history',
      re: /\b(no felons?|no felony|clean (criminal )?record|clean background|no criminal (history|record|background)|never been convicted|no convictions?)\b/i,
      message: (m) => `"${m}" screens out people with records before an offer. Remove it; criminal history is considered only after a conditional offer.`,
      citation: { label: 'Gov Code 12952', url: 'https://calcivilrights.ca.gov/fair-chance-act/' },
    },
    {
      code: 'age_coded',
      // 'young company' or 'young team' describes us, not the candidate, so it is left alone.
      re: /\b(digital natives?|young(?!\s+(?:company|companies|team|teams|startup|startups|business|product))|youthful|recent grad(uate)?s?|new grads? only|energetic|high[- ]energy|fresh grad(uate)?s?)\b/i,
      message: (m) => `"${m}" reads as age-coded. Describe the skills and the work instead.`,
      citation: { label: 'Gov Code 12940', url: 'https://calcivilrights.ca.gov/employment/' },
    },
    {
      code: 'jargon',
      re: /\b(rock ?stars?|ninjas?|gurus?|unicorns?)\b/i,
      message: (m) => `"${m}" puts many good candidates off. Say what the person will do.`,
    },
    {
      code: 'cannabis',
      // 'weed out' is an idiom, not a drug question.
      re: /\b(cannabis|marijuana|weed(?!\s+out)|thc)\b/i,
      message: (m) => `Mentions "${m}". California bars asking about past cannabis use (Government Code 12954, SB 700).`,
      citation: { label: 'Gov Code 12954 (SB 700)', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=GOV&sectionNum=12954.' },
    },
  ]
}

/**
 * Job post linter. Lints the given posting text (or the job description): missing pay range, missing
 * Fair Chance statement (only when full posting text is passed, since postingText adds it), 'no
 * felons' language, age-coded words, 'rockstar' or 'ninja', cannabis questions and salary history.
 */
export function postingLint(job: Pick<Job, 'payMin' | 'payMax' | 'description'> & Partial<Pick<Job, 'workMode'>>, text?: string): LintWarning[] {
  const body = text ?? job.description ?? ''
  const out: LintWarning[] = []
  if (job.payMin == null || job.payMax == null) {
    const remote = job.workMode === 'remote'
    out.push({
      code: 'missing_range',
      message: `Add a pay range. Applicants can ask for it at any size, and California requires it on every job post once you have 15 employees (Labor Code 432.3).${remote ? ' Remote roles a Colorado resident could fill need a range at any size.' : ''}`,
      citation: { label: 'Labor Code 432.3', url: 'https://www.dir.ca.gov/dlse/california_equal_pay_act.htm' },
      ...(remote ? { reviewNote: 'The Colorado rule is not verified here; confirm with counsel.' } : {}),
    })
  }
  if (text != null && !/fair chance|arrest and conviction|conviction records|criminal history only after/i.test(body)) {
    out.push({
      code: 'missing_fair_chance',
      message: 'Add a Fair Chance statement. It is best practice statewide and required in Los Angeles and San Francisco.',
      citation: { label: 'Gov Code 12952', url: 'https://calcivilrights.ca.gov/fair-chance-act/' },
    })
  }
  for (const rule of lintRules()) {
    const re = new RegExp(rule.re.source, 'gi')
    const seen = new Set<string>()
    for (const m of body.matchAll(re)) {
      const word = m[0]
      if (seen.has(word.toLowerCase())) continue
      seen.add(word.toLowerCase())
      out.push({ code: rule.code, message: rule.message(word), match: word, ...(rule.citation ? { citation: rule.citation } : {}) })
    }
  }
  const salary = salaryHistoryMatch(body)
  if (salary) {
    out.push({ code: 'salary_history', message: salaryHistoryMessage(), match: salary, citation: { label: 'Labor Code 432.3', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=432.3.&lawCode=LAB' } })
  }
  return out
}

function salaryHistoryMessage(): string {
  return 'Heads up: California bans asking about pay history. Ask about desired pay instead.'
}

function salaryHistoryPatterns(): RegExp[] {
  const who = '(you|they|she|he|her|him|them)'
  return [
    /\b(current|present|existing) (salary|pay|comp|compensation|base|wage|wages)\b/i,
    /\b(previous|prior|past|last|former) (salary|pay|comp|compensation|base|wage|wages)\b/i,
    /\bold (salary|pay|comp|compensation|wage|wages)\b/i,
    /\b(salary|pay|comp|compensation|wage) history\b/i,
    new RegExp(`\\bwhat (do|did|does) ${who} (make|earn)\\b`, 'i'),
    new RegExp(`\\bwhat (are|is|was|were) ${who} (making|earning|paid)\\b`, 'i'),
    new RegExp(`\\bhow much (do|did|does) ${who} (make|earn)\\b`, 'i'),
    new RegExp(`\\bhow much (are|is|was|were) ${who} (making|earning|paid)\\b`, 'i'),
    /\bmaking now\b/i,
    /\bcurrently (making|earning|earns|makes|paid)\b/i,
    // 'She makes 180k now', 'earning $210,000', 'made 150K last year': an amount someone is paid.
    /\b(makes|earns|making|earning|made|earned) (about |around |roughly |over |under |nearly )?(\$\s?\d[\d,.]*\s?(k|m)?\b|\d[\d,.]*\s?(k|m)\b|\d{2,3},\d{3}\b)/i,
  ]
}

/** 'We never ask about salary history' and similar statements are not questions about pay. */
function isNegated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 40), index)
  return /\b(never|not|don't|do not|won't|will not|no longer)\s+(ask|asks|asked|asking|request|requests|requested|consider|considers|use|uses|rely on)(\s+(about|for|on))?(\s+(your|their|a|any|an applicant's|a candidate's))?\s*$/i.test(before) || /\bno questions about\s*$/i.test(before)
}

function salaryHistoryMatch(text: string): string | null {
  let best: { index: number; text: string } | null = null
  for (const pattern of salaryHistoryPatterns()) {
    const re = new RegExp(pattern.source, 'gi')
    for (const m of text.matchAll(re)) {
      const index = m.index ?? 0
      if (isNegated(text, index)) continue
      if (!best || index < best.index) best = { index, text: m[0] }
      break
    }
  }
  return best ? best.text : null
}

/**
 * Words that record or ask about criminal history in a free-text note. 'Record' alone is left out so
 * 'track record' never trips it; 'probation' does not match 'probationary period'.
 */
function criminalHistoryPattern(): RegExp {
  return /\b(felon|felons|felony|felonies|convicted|conviction|convictions|arrest|arrests|arrested|criminal (record|records|history|background|charge|charges|past)|rap sheet|DUIs?|DWIs?|jail|prison|probation|parole|misdemeanou?rs?|mugshot)\b/i
}

/** The phrase that reads as criminal history in a note or message, or null. Negated mentions ('never ask about arrests') pass. */
export function criminalHistoryMatch(text: string): string | null {
  const re = new RegExp(criminalHistoryPattern().source, 'gi')
  for (const m of text.matchAll(re)) {
    if (!isNegated(text, m.index ?? 0)) return m[0]
  }
  return null
}

/**
 * Gentle lint for candidate notes, summaries, scorecards and referral text: criminal history is
 * considered only after a conditional offer (Fair Chance Act, Gov Code 12952), and even then the app
 * keeps status and dates only, never the details.
 */
export function criminalHistoryLint(text: string, opts: { conditionalOfferOn?: string | null } = {}): string | null {
  const m = criminalHistoryMatch(text)
  if (!m) return null
  return opts.conditionalOfferOn
    ? `"${m}" looks like criminal history. Keep the background check to its status and dates here; details stay with the screening provider (Fair Chance Act, Gov Code 12952).`
    : `"${m}" looks like criminal history. California bars considering it before a conditional offer, so leave it out of notes (Fair Chance Act, Gov Code 12952).`
}

/**
 * Gentle lint for candidate notes and messages: asking about current or past pay (Labor Code 432.3),
 * then criminal history (Gov Code 12952). Returns the first warning, or null.
 */
export function salaryHistoryLint(text: string, opts: { conditionalOfferOn?: string | null } = {}): string | null {
  if (salaryHistoryMatch(text)) return salaryHistoryMessage()
  return criminalHistoryLint(text, opts)
}

