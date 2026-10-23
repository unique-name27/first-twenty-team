// Counting primitives for the compliance engine. Every count is computed from effective-dated data
// (start dates, last days, contract dates) for a given date, and explained in a plain sentence
// ('How we counted'). Pure functions: the date is always a parameter, never the clock.
import { founder, fullName, isEmployedOn } from '@/domain/people'
import type { Contractor, DB, ID, Location, Offer, Person } from '@/domain/types'
import { addDays, addMonths, daysBetween, fmtDate, type ISODate, isWeekday, nextQuarter, quarterEnd, quarterOf, quarterStart } from '@/lib/dates'
import { listJoin, plural } from '@/lib/format'
import { CCPA_REVENUE_THRESHOLD, type ComplianceEvent, type CountMethod } from './rules'

export type CountOptions = {
  /** Threshold for methods that count against one (weeks_20, cobra_prior_year). */
  n?: number
  /** cobra_prior_year: use the preceding calendar quarter when there were no employees last year (Cal-COBRA). */
  priorQuarterFallback?: boolean
}

export type CountResult = {
  count: number
  /** Plain sentence(s): what was counted and what was left out. */
  howCounted: string
  /** People and contractors behind the number (for drill-down). */
  personIds: ID[]
  contractorIds: ID[]
  /** site: the workplace is open to the public, which removes the SB 553 small-site exemption. */
  publicAccess?: boolean
  /** site: the count came from Settings (typical peak on site) rather than from assignments. */
  fromSettings?: boolean
  /** site: onsite and hybrid employees assigned to the workplace. */
  assigned?: number
  /** site: the typical peak on site from Settings, when set. */
  setting?: number
  /** site: the Settings peak is below the threshold while that many onsite or hybrid staff are assigned. */
  staleSetting?: boolean
  /** weeks_20: qualifying weeks this calendar year (so far) and last calendar year. */
  weeks?: { n: number; thisYear: number; lastYear: number }
}

const yearOf = (d: ISODate): number => Number(d.slice(0, 4))
const sameCity = (a: string | undefined, b: string): boolean => !!a && a.trim().toLowerCase() === b.trim().toLowerCase()

export function employeesOn(db: DB, date: ISODate): Person[] {
  return db.people.filter((p) => isEmployedOn(p, date))
}

/** Contractors (not advisors) whose contract covers the date. */
export function activeContractorsOn(db: DB, date: ISODate): Contractor[] {
  return db.contractors.filter((c) => c.kind === 'contractor' && c.startOn <= date && (!c.endOn || c.endOn >= date))
}

/** Advisors whose agreement covers the date (not counted by default; see w2_plus_contractors). */
export function activeAdvisorsOn(db: DB, date: ISODate): Contractor[] {
  return db.contractors.filter((c) => c.kind === 'advisor' && c.startOn <= date && (!c.endOn || c.endOn >= date))
}

/** Everyone with a California tie on the date: a CA home state, or an HQ in California. */
export function hasCaliforniaPresence(db: DB, date: ISODate): boolean {
  if (db.company.hq.state === 'CA') return true
  return employeesOn(db, date).some((p) => p.homeState === 'CA')
}

/** True when the company has a workplace in the city, or someone working there. */
export function hasPresenceInCity(db: DB, city: string): boolean {
  if (sameCity(db.company.hq.city, city)) return true
  if (db.locations.some((l) => sameCity(l.city, city))) return true
  return db.people.some((p) => sameCity(p.homeCity, city))
}

function onLeaveOn(db: DB, personId: ID, date: ISODate): boolean {
  return db.leaveCases.some(
    (l) => l.personId === personId && l.startDate <= date && (l.returnedOn ? l.returnedOn > date : !l.expectedReturn || l.expectedReturn > date),
  )
}

/** Full-time equivalent for the COBRA count: part-time staff count as weekly hours divided by 40. */
function fte(p: Person): number {
  if (p.employmentType === 'full_time') return 1
  return Math.min(1, Math.max(0, (p.hoursPerWeek || 40) / 40))
}

function stateList(people: Person[]): string {
  const byState = new Map<string, number>()
  for (const p of people) byState.set(p.homeState, (byState.get(p.homeState) ?? 0) + 1)
  const names: Record<string, string> = { CA: 'California', TX: 'Texas', CO: 'Colorado', NY: 'New York', WA: 'Washington', OR: 'Oregon' }
  return [...byState.entries()]
    .sort((a, b) => (a[0] === 'CA' ? -1 : b[0] === 'CA' ? 1 : b[1] - a[1]))
    .map(([s, n]) => `${n} in ${names[s] ?? s}`)
    .join(', ')
}

/** Who was left out of a W-2 count on the date, as a phrase ('2 advisors, 1 former employee'). */
function excludedPhrase(db: DB, date: ISODate, includeContractors: boolean): string {
  const parts: string[] = []
  if (!includeContractors) {
    const k = activeContractorsOn(db, date).length
    if (k) parts.push(plural(k, 'contractor'))
  } else {
    const ended = db.contractors.filter((c) => c.kind === 'contractor' && (c.startOn > date || (c.endOn && c.endOn < date))).length
    if (ended) parts.push(`${plural(ended, 'contractor')} not under contract that day`)
  }
  const advisors = db.contractors.filter((c) => c.kind === 'advisor').length
  if (advisors) parts.push(plural(advisors, 'advisor'))
  const former = db.people.filter((p) => p.endDate && p.endDate < date).length
  if (former) parts.push(plural(former, 'former employee'))
  const notStarted = db.people.filter((p) => p.startDate > date).length
  if (notStarted) parts.push(`${plural(notStarted, 'person', 'people')} who had not started yet`)
  return parts.length ? ` Not counted: ${listJoin(parts)}.` : ''
}

// ---------------------------------------------------------------------------------------------
// 20-week federal test
// ---------------------------------------------------------------------------------------------

/** Mondays of the calendar weeks that belong to a year (weeks whose Monday falls in the year). */
function mondaysOf(year: number): ISODate[] {
  let d = `${year}-01-01`
  while (!isMonday(d)) d = addDays(d, 1)
  const out: ISODate[] = []
  while (yearOf(d) === year) {
    out.push(d)
    d = addDays(d, 7)
  }
  return out
}

function isMonday(d: ISODate): boolean {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(y, m - 1, day).getDay() === 1
}

/**
 * Fridays of the weeks in `year` in which W-2 headcount was at least n on each Monday to Friday.
 * With `through`, only weeks that ended (Friday) on or before it.
 */
export function qualifyingWeeks(db: DB, n: number, year: number, through?: ISODate): ISODate[] {
  const out: ISODate[] = []
  for (const monday of mondaysOf(year)) {
    const friday = addDays(monday, 4)
    if (through && friday > through) break
    let ok = true
    for (let i = 0; i < 5 && ok; i++) {
      const day = addDays(monday, i)
      if (db.people.filter((p) => isEmployedOn(p, day)).length < n) ok = false
    }
    if (ok) out.push(friday)
  }
  return out
}

/** Calendar weeks in `year` with headcount >= n every weekday (simplified payroll method). */
export function weeksAtOrAbove(db: DB, n: number, year: number, through?: ISODate): number {
  return qualifyingWeeks(db, n, year, through).length
}

/**
 * Projected date the 20th qualifying week completes, this calendar year or next, assuming the people
 * in `db` (including future starts) stay. Weeks do not carry over between calendar years.
 */
export function estimateTwentyWeeks(db: DB, n: number, date: ISODate): ISODate | undefined {
  const y = yearOf(date)
  for (const year of [y, y + 1]) {
    const weeks = qualifyingWeeks(db, n, year)
    if (weeks.length >= 20) return weeks[19]
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// Prior-year business-day test (COBRA, Cal-COBRA)
// ---------------------------------------------------------------------------------------------

export type CobraLevel = {
  /** The headcount met or beaten on more than half of typical business days (part-timers as fractions). */
  level: number
  businessDays: number
  basis: 'year' | 'quarter'
  periodLabel: string
}

export function cobraLevel(db: DB, date: ISODate, opts: CountOptions = {}): CobraLevel {
  const prior = yearOf(date) - 1
  let from = `${prior}-01-01`
  let to = `${prior}-12-31`
  let basis: CobraLevel['basis'] = 'year'
  let periodLabel = String(prior)
  if (opts.priorQuarterFallback && !db.people.some((p) => p.startDate <= to && (!p.endDate || p.endDate >= from))) {
    const q = nextQuarter(quarterOf(date), -1)
    from = quarterStart(q)
    to = quarterEnd(q)
    basis = 'quarter'
    periodLabel = q.replace(/^(\d{4})-(Q\d)$/, '$2 $1')
  }
  const holidays = new Set(db.holidays.map((h) => h.date))
  const values: number[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!isWeekday(d) || holidays.has(d)) continue
    let v = 0
    for (const p of db.people) if (isEmployedOn(p, d)) v += fte(p)
    values.push(v)
  }
  if (!values.length) return { level: 0, businessDays: 0, basis, periodLabel }
  values.sort((a, b) => b - a)
  const level = Math.round(values[Math.floor(values.length / 2)] * 100) / 100
  return { level, businessDays: values.length, basis, periodLabel }
}

// ---------------------------------------------------------------------------------------------
// Site and location counts
// ---------------------------------------------------------------------------------------------

/** SB 553: the small-site exemption ends at 10 people on site at once. */
export const SITE_THRESHOLD = 10

export type SiteCount = {
  location?: Location
  /** People counted on site at once: the Settings peak, never below the onsite-only staff assigned there. */
  count: number
  /** Employees assigned to the site who are not fully remote (onsite or hybrid). */
  assigned: number
  /** Employees assigned to the site who work onsite only, so they are certainly there at once. */
  onsiteOnly: number
  /** The typical peak on site from Settings, when set. */
  setting?: number
  fromSettings: boolean
  publicAccess: boolean
  /** The Settings peak is below n while n or more onsite or hybrid staff are assigned there. */
  staleSetting: boolean
}

/**
 * Peak people on site at once, per workplace (HQ locations). Remote staff are excluded. A Settings peak is
 * used when set, floored by onsite-only staff (they are all there at once); without one, everyone assigned
 * onsite or hybrid counts. A Settings peak below n while n or more onsite or hybrid staff are assigned is
 * flagged as stale rather than trusted silently.
 */
export function siteCounts(db: DB, date: ISODate, n = SITE_THRESHOLD): SiteCount[] {
  const emps = employeesOn(db, date)
  return db.locations
    .filter((l) => l.kind === 'hq')
    .map((l) => {
      const here = emps.filter((p) => p.locationId === l.id && p.workMode !== 'remote')
      const assigned = here.length
      const onsiteOnly = here.filter((p) => p.workMode === 'onsite').length
      const fromSettings = typeof l.typicalMaxOnSite === 'number'
      const setting = fromSettings ? Math.max(0, l.typicalMaxOnSite as number) : undefined
      const count = setting !== undefined ? Math.max(setting, onsiteOnly) : assigned
      return {
        location: l,
        count,
        assigned,
        onsiteOnly,
        setting,
        fromSettings,
        publicAccess: !!l.publicAccess && (assigned > 0 || (setting ?? 0) > 0),
        staleSetting: setting !== undefined && count < n && assigned >= n,
      }
    })
}

/** The workplace that decides the site rule: one that meets it first, then the largest, then a stale setting. */
function busiestSite(db: DB, date: ISODate, n = SITE_THRESHOLD): SiteCount {
  const sites = siteCounts(db, date, n)
  if (!sites.length) return { count: 0, assigned: 0, onsiteOnly: 0, fromSettings: false, publicAccess: false, staleSetting: false }
  const meets = (s: SiteCount) => Number(s.count >= n || s.publicAccess)
  return [...sites].sort(
    (a, b) =>
      meets(b) - meets(a) ||
      b.count - a.count ||
      Number(b.staleSetting) - Number(a.staleSetting) ||
      Number(b.publicAccess) - Number(a.publicAccess),
  )[0]
}

function worksAtLocation(db: DB, date: ISODate): Map<ID, Person[]> {
  const map = new Map<ID, Person[]>()
  for (const p of employeesOn(db, date)) {
    if (p.workMode === 'remote') continue
    const list = map.get(p.locationId) ?? []
    list.push(p)
    map.set(p.locationId, list)
  }
  return map
}

function worksInCity(db: DB, p: Person, city: string): boolean {
  const loc = db.locations.find((l) => l.id === p.locationId)
  if (loc && sameCity(loc.city, city) && p.workMode !== 'remote') return true
  return sameCity(p.homeCity, city) && p.workMode !== 'onsite'
}

// ---------------------------------------------------------------------------------------------
// The counter
// ---------------------------------------------------------------------------------------------

/** The bare number for a method on a date (fast path used when scanning many dates). */
export function rawCount(db: DB, method: CountMethod, date: ISODate, opts: CountOptions = {}): number {
  switch (method) {
    case 'w2_one_in_ca':
      return employeesOn(db, date).length
    case 'w2_plus_contractors':
      return employeesOn(db, date).length + activeContractorsOn(db, date).length
    case 'weeks_20': {
      const n = opts.n ?? 15
      const y = yearOf(date)
      return Math.max(weeksAtOrAbove(db, n, y, date), weeksAtOrAbove(db, n, y - 1))
    }
    case 'cobra_prior_year':
      return cobraLevel(db, date, opts).level
    case 'site':
      return busiestSite(db, date).count
    case 'w2_at_location': {
      let max = 0
      for (const list of worksAtLocation(db, date).values()) max = Math.max(max, list.length)
      return max
    }
    case 'in_san_jose':
      return employeesOn(db, date).filter((p) => worksInCity(db, p, 'San Jose')).length
  }
}

/** Count for a method on a date, with a plain explanation of what was counted and left out. */
export function countFor(db: DB, method: CountMethod, date: ISODate, opts: CountOptions = {}): CountResult {
  const emps = employeesOn(db, date)
  const on = fmtDate(date)
  switch (method) {
    case 'w2_one_in_ca': {
      const leave = emps.filter((p) => onLeaveOn(db, p.id, date)).length
      const pt = emps.filter((p) => p.employmentType !== 'full_time').length
      const detail = [emps.length ? stateList(emps) : '', pt ? `${pt} part-time or intern` : '', leave ? `${leave} on leave` : '']
        .filter(Boolean)
        .join('; ')
      const ca = emps.some((p) => p.homeState === 'CA') || db.company.hq.state === 'CA'
      return {
        count: emps.length,
        howCounted:
          `${plural(emps.length, 'W-2 employee')} on ${on}, counted in every state with part-time staff, interns and people on leave included${detail ? ` (${detail})` : ''}.` +
          excludedPhrase(db, date, false) +
          (ca ? '' : ' No one works in California, so California rules based on this count do not apply.'),
        personIds: emps.map((p) => p.id),
        contractorIds: [],
      }
    }
    case 'w2_plus_contractors': {
      const ks = activeContractorsOn(db, date)
      const names = ks.map((c) => c.entityName || c.name)
      const count = emps.length + ks.length
      const advisors = activeAdvisorsOn(db, date).length
      const n = opts.n ?? 5
      // Leaving advisors out is a judgment call (Gov. Code 12950.1 counts people serving under contract): say when it matters.
      const advisorNote =
        advisors && count < n && count + advisors >= n
          ? ` Counting the ${plural(advisors, 'active advisor')} would make ${count + advisors}, which reaches ${n}: if they give regular services under contract, confirm with counsel and override the count.`
          : ''
      return {
        count,
        howCounted:
          `${count} on ${on}: ${plural(emps.length, 'W-2 employee')} in any state plus ${plural(ks.length, 'active contractor')}${names.length ? ` (${listJoin(names)})` : ''}. Each contract counts as one person; advisors are not counted.` +
          excludedPhrase(db, date, true) +
          advisorNote,
        personIds: emps.map((p) => p.id),
        contractorIds: ks.map((c) => c.id),
      }
    }
    case 'weeks_20': {
      const n = opts.n ?? 15
      const y = yearOf(date)
      const thisYear = weeksAtOrAbove(db, n, y, date)
      const lastYear = weeksAtOrAbove(db, n, y - 1)
      return {
        count: Math.max(thisYear, lastYear),
        howCounted: `${n} or more employees on every weekday in ${thisYear} of 20 calendar weeks so far in ${y} (${lastYear} in ${y - 1}). A week counts when payroll headcount was ${n} or more each Monday to Friday; part-time staff count for the whole week, and contractors and former employees do not count. Weeks do not carry over from one calendar year to the next. Once week 20 is reached, coverage reaches back to Jan 1 of that year and lasts through the next year. You have ${plural(emps.length, 'employee')} today.`,
        personIds: emps.map((p) => p.id),
        contractorIds: [],
        weeks: { n, thisYear, lastYear },
      }
    }
    case 'cobra_prior_year': {
      const c = cobraLevel(db, date, opts)
      const name = db.company.name || 'The company'
      const lead =
        c.basis === 'quarter'
          ? `${name} had no employees in ${yearOf(date) - 1}, so the preceding quarter (${c.periodLabel}) is used. `
          : ''
      return {
        count: c.level,
        howCounted: `${lead}In ${c.periodLabel}, ${name} had at least ${trimNum(c.level)} employees on more than half of its ${c.businessDays} typical business days (weekdays that were not company holidays). Part-time staff count as weekly hours divided by 40; contractors do not count.`,
        personIds: emps.map((p) => p.id),
        contractorIds: [],
      }
    }
    case 'site': {
      const n = opts.n ?? SITE_THRESHOLD
      const s = busiestSite(db, date, n)
      if (!s.location) {
        return {
          count: 0,
          howCounted: 'No office or other workplace is set up, so no one is counted on site. Staff working remotely from a place they choose are not counted.',
          personIds: [],
          contractorIds: [],
          publicAccess: false,
          fromSettings: false,
          assigned: 0,
          staleSetting: false,
        }
      }
      const where = s.location.name
      const isAre = (k: number) => (k === 1 ? 'is' : 'are')
      let lead: string
      if (s.setting === undefined) {
        lead = `${plural(s.count, 'employee')} assigned to ${where} on an onsite or hybrid basis (set the typical peak on site in Settings for a closer count).`
      } else if (s.onsiteOnly > s.setting) {
        lead = `${plural(s.onsiteOnly, 'employee')} ${isAre(s.onsiteOnly)} assigned to ${where} onsite only, so at least ${s.onsiteOnly} ${isAre(s.onsiteOnly)} there at once; your Settings peak (${s.setting}) is lower. ${plural(s.assigned, 'employee')} ${isAre(s.assigned)} assigned there on an onsite or hybrid basis.`
      } else {
        lead = `${plural(s.count, 'person', 'people')} at ${where} at once on a typical busy day (from Settings). ${plural(s.assigned, 'employee')} ${isAre(s.assigned)} assigned there on an onsite or hybrid basis.`
      }
      if (s.staleSetting) {
        lead += ` Your Settings peak (${s.setting}) is below the ${s.assigned} people assigned to the office on an onsite or hybrid basis; update it in Settings.`
      }
      const remote = emps.filter((p) => p.workMode === 'remote').length
      const pub = s.location.publicAccess
        ? s.publicAccess
          ? ' The workplace is open to the public, so the small-site exemption does not apply.'
          : ' The workplace is marked open to the public, but no one works there yet.'
        : ' The workplace is not open to the public.'
      return {
        count: s.count,
        howCounted: `${lead}${remote ? ` ${plural(remote, 'remote employee')} ${isAre(remote)} not counted.` : ' Remote staff are not counted.'}${pub}`,
        personIds: emps.filter((p) => p.locationId === s.location?.id && p.workMode !== 'remote').map((p) => p.id),
        contractorIds: [],
        publicAccess: s.publicAccess,
        fromSettings: s.fromSettings,
        assigned: s.assigned,
        setting: s.setting,
        staleSetting: s.staleSetting,
      }
    }
    case 'w2_at_location': {
      const map = worksAtLocation(db, date)
      let best: { id: ID; list: Person[] } | null = null
      for (const [id, list] of map) if (!best || list.length > best.list.length) best = { id, list }
      const parts = [...map.entries()].map(([id, list]) => `${list.length} at ${db.locations.find((l) => l.id === id)?.name ?? 'an unnamed location'}`)
      const remote = emps.filter((p) => p.workMode === 'remote').length
      return {
        count: best?.list.length ?? 0,
        howCounted: `${parts.length ? `${listJoin(parts)} (onsite or hybrid)` : 'No one works at a company location'} on ${on}. The largest location counts.${remote ? ` ${plural(remote, 'remote employee')} ${remote === 1 ? 'is' : 'are'} not counted at any location.` : ''}`,
        personIds: best?.list.map((p) => p.id) ?? [],
        contractorIds: [],
      }
    }
    case 'in_san_jose': {
      const inCity = emps.filter((p) => worksInCity(db, p, 'San Jose'))
      return {
        count: inCity.length,
        howCounted: `${plural(inCity.length, 'employee')} ${inCity.length === 1 ? 'works' : 'work'} within San Jose city limits on ${on} (at a San Jose site, or remote from San Jose). ${plural(emps.length - inCity.length, 'employee')} working elsewhere ${emps.length - inCity.length === 1 ? 'is' : 'are'} not counted.`,
        personIds: inCity.map((p) => p.id),
        contractorIds: [],
      }
    }
  }
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

// ---------------------------------------------------------------------------------------------
// Change points and first crossings
// ---------------------------------------------------------------------------------------------

/** Dates on which a count can change: starts, the day after last days, contract starts and ends. */
export function changePoints(db: DB): ISODate[] {
  const s = new Set<ISODate>()
  for (const p of db.people) {
    s.add(p.startDate)
    if (p.endDate) s.add(addDays(p.endDate, 1))
  }
  for (const c of db.contractors) {
    if (c.kind !== 'contractor') continue
    s.add(c.startOn)
    if (c.endOn) s.add(addDays(c.endOn, 1))
  }
  return [...s].sort()
}

/**
 * First change point (after `after`, on or before `through`) where the count reaches n. Works for
 * methods that change only on start and end dates. A Settings peak on site has no history, so when the
 * setting alone reaches n there is no first date; below n, only onsite-only staff can lift the count.
 */
export function firstDateAtOrAbove(
  db: DB,
  method: Exclude<CountMethod, 'weeks_20' | 'cobra_prior_year'>,
  n: number,
  range: { after?: ISODate; through?: ISODate } = {},
): ISODate | undefined {
  if (method === 'site' && db.locations.some((l) => l.kind === 'hq' && typeof l.typicalMaxOnSite === 'number' && l.typicalMaxOnSite >= n)) {
    return undefined
  }
  for (const d of changePoints(db)) {
    if (range.after && d <= range.after) continue
    if (range.through && d > range.through) break
    if (rawCount(db, method, d) >= n) return d
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// Projections: incoming hires and outstanding offers as people
// ---------------------------------------------------------------------------------------------

export type Phantom = { person: Person; offer: Offer; kind: 'incoming' | 'if_accepted' }

/**
 * Offers that are not yet people: accepted offers not converted by Hire (solid, 'incoming') and
 * sent or approved offers still open on the date (hollow, 'if accepted'; an offer past its expiry
 * cannot be accepted). Latest version per application; future starts only.
 */
export function offerPhantoms(db: DB, date: ISODate): Phantom[] {
  const latest = new Map<ID, Offer>()
  for (const o of db.offers) {
    const prev = latest.get(o.applicationId)
    if (!prev || o.version > prev.version) latest.set(o.applicationId, o)
  }
  const out: Phantom[] = []
  for (const o of latest.values()) {
    if (o.startDate <= date) continue
    let kind: Phantom['kind'] | null = null
    if (o.status === 'accepted' && !o.personId && !db.people.some((p) => p.fromApplicationId === o.applicationId)) kind = 'incoming'
    else if ((o.status === 'sent' || o.status === 'approved') && (!o.expiresOn || o.expiresOn >= date)) kind = 'if_accepted'
    if (!kind) continue
    out.push({ person: personFromOffer(db, o), offer: o, kind })
  }
  return out.sort((a, b) => a.person.startDate.localeCompare(b.person.startDate))
}

function personFromOffer(db: DB, o: Offer): Person {
  const cand = db.candidates.find((c) => c.id === o.candidateId)
  const loc = db.locations.find((l) => l.id === o.locationId)
  return {
    id: `offer:${o.id}`,
    firstName: cand?.firstName ?? 'Candidate',
    lastName: cand?.lastName ?? '',
    workEmail: cand?.email ?? '',
    title: o.title,
    departmentId: o.departmentId,
    familyId: o.familyId,
    levelId: o.levelId,
    managerId: o.managerId,
    locationId: o.locationId,
    workMode: o.workMode,
    homeCity: loc?.city,
    homeState: loc?.state ?? db.company.hq.state,
    employmentType: o.employmentType,
    hoursPerWeek: o.hoursPerWeek ?? (o.employmentType === 'full_time' ? 40 : 20),
    flsa: o.flsa,
    exemptionBasis: o.exemptionBasis,
    startDate: o.startDate,
    hireNumber: 0,
    emergencyContacts: [],
    fromCandidateId: o.candidateId,
    fromApplicationId: o.applicationId,
  }
}

/** The db with offers added as future people: accepted ones always, sent and approved ones when asked. */
export function projectionDB(db: DB, date: ISODate, includeOutstanding: boolean): DB {
  const extra = offerPhantoms(db, date)
    .filter((ph) => includeOutstanding || ph.kind === 'incoming')
    .map((ph) => ph.person)
  return extra.length ? { ...db, people: [...db.people, ...extra] } : db
}

// ---------------------------------------------------------------------------------------------
// First-time events
// ---------------------------------------------------------------------------------------------

function ownerIds(db: DB): Set<ID> {
  const ids = new Set(db.people.filter((p) => p.isFounder).map((p) => p.id))
  if (!ids.size) {
    const f = founder(db)
    if (f) ids.add(f.id)
  }
  return ids
}

/** Earliest date anyone reported to this person (comp history first, then the current manager field). */
export function supervisorSince(db: DB, managerId: ID): ISODate | undefined {
  const mgr = db.people.find((p) => p.id === managerId)
  let best: ISODate | undefined
  for (const p of db.people) {
    if (p.id === managerId) continue
    const recs = db.comp
      .filter((r) => r.personId === p.id && r.managerId !== undefined)
      .sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))
    let d: ISODate | undefined
    const hit = recs.find((r) => r.managerId === managerId)
    if (hit) d = hit.effectiveOn > p.startDate ? hit.effectiveOn : p.startDate
    else if (p.managerId === managerId) {
      // The change is not in the history: it happened after the last recorded job change (or at hire).
      const last = recs[recs.length - 1]
      d = last && last.effectiveOn > p.startDate ? last.effectiveOn : p.startDate
    }
    if (!d) continue
    if (mgr && mgr.startDate > d) d = mgr.startDate
    if (!best || d < best) best = d
  }
  return best
}

export type EventHit = {
  date: ISODate
  text: string
  personId?: ID
  contractorId?: ID
  /** The date is an estimate from other data (no first payroll date in Settings), not a recorded fact. */
  estimated?: boolean
}

const paid = (r: { payType: 'salary' | 'hourly'; salary?: number; hourlyRate?: number }): boolean =>
  (r.payType === 'hourly' ? (r.hourlyRate ?? 0) : (r.salary ?? 0)) > 0

/**
 * When a person's W-2 wages start, for the first payroll estimate. An owner counts only from a pay record
 * above $0 (a founder often works unpaid at first, and DE 1 is owed only once wages are paid); anyone else
 * from their start date, since an employee is paid at least minimum wage whatever the pay field says.
 */
function wagesFrom(db: DB, p: Person, owners: Set<ID>): ISODate | undefined {
  if (!owners.has(p.id)) return p.startDate
  const first = db.comp
    .filter((r) => r.personId === p.id && paid(r))
    .map((r) => r.effectiveOn)
    .sort()[0]
  if (!first) return undefined
  return first > p.startDate ? first : p.startDate
}

/**
 * Employees on a date who are owed the yearly employee notices (the SB 294 rights notice, the survivors of
 * violence leave notice): everyone employed then except an owner with no pay recorded by that date, the same
 * exclusion as the first payroll estimate. A solo founder working unpaid has no one to send them to.
 */
export function paidEmployeesOn(db: DB, date: ISODate): Person[] {
  const owners = ownerIds(db)
  return employeesOn(db, date).filter((p) => {
    if (!owners.has(p.id)) return true
    const from = wagesFrom(db, p, owners)
    return !!from && from <= date
  })
}

/**
 * The first day someone paidEmployeesOn counts was employed (on or before `through`): when the yearly employee
 * notices start to apply. A solo founder working unpaid since founding has none until a first hire, or until
 * their own pay record starts. undefined while there has been no one.
 */
export function firstPaidEmployeeOn(db: DB, through?: ISODate): ISODate | undefined {
  const owners = ownerIds(db)
  const starts = db.people.map((p) => wagesFrom(db, p, owners)).filter((d): d is ISODate => !!d && (!through || d <= through))
  return [...new Set(starts)].sort().find((d) => paidEmployeesOn(db, d).length > 0)
}

function earliest<T>(items: T[], dateOf: (t: T) => ISODate | undefined): { item: T; date: ISODate } | undefined {
  let best: { item: T; date: ISODate } | undefined
  for (const item of items) {
    const d = dateOf(item)
    if (d && (!best || d < best.date)) best = { item, date: d }
  }
  return best
}

/** When a first-time event happened (or is scheduled to), with a plain description. */
export function eventHit(db: DB, event: ComplianceEvent, date: ISODate): EventHit | undefined {
  switch (event) {
    case 'first_payroll': {
      const recorded = db.company.firstPayrollOn
      if (recorded) return { date: recorded, text: `First payroll on ${fmtDate(recorded)} (from Settings).` }
      const owners = ownerIds(db)
      const e = earliest(db.people, (p) => wagesFrom(db, p, owners))
      if (!e) return undefined
      const unpaidOwners = db.people.some((p) => owners.has(p.id) && !wagesFrom(db, p, owners) && p.startDate < e.date)
      return {
        date: e.date,
        text: `Estimated from the first paid W-2 start on record: ${fullName(e.item)} on ${fmtDate(e.date)}.${unpaidOwners ? ' Owners with no pay recorded are left out.' : ''} Add the first payroll date in Settings for an exact date.`,
        personId: e.item.id,
        estimated: true,
      }
    }
    case 'first_non_owner_employee': {
      const owners = ownerIds(db)
      const e = earliest(
        db.people.filter((p) => !owners.has(p.id)),
        (p) => p.startDate,
      )
      return e && { date: e.date, text: `First employee who is not an owner: ${fullName(e.item)}, starting ${fmtDate(e.date)}.`, personId: e.item.id }
    }
    case 'first_contractor': {
      const e = earliest(
        db.contractors.filter((c) => c.kind === 'contractor'),
        (c) => c.startOn,
      )
      return e && { date: e.date, text: `First contractor: ${e.item.entityName || e.item.name}, from ${fmtDate(e.date)}.`, contractorId: e.item.id }
    }
    case 'first_option_grant': {
      if (db.equity.firstIssuanceOn) return { date: db.equity.firstIssuanceOn, text: `First option issuance on ${fmtDate(db.equity.firstIssuanceOn)}.` }
      const e = earliest(
        db.grants.filter((g) => g.boardApprovedOn),
        (g) => g.boardApprovedOn,
      )
      return e && { date: e.date, text: `First board-approved grant on ${fmtDate(e.date)}.` }
    }
    case 'first_out_of_state_employee': {
      const home = db.company.hq.state || 'CA'
      const e = earliest(
        db.people.filter((p) => p.homeState && p.homeState !== home),
        (p) => p.startDate,
      )
      return (
        e && {
          date: e.date,
          text: `First employee outside ${home === 'CA' ? 'California' : home}: ${fullName(e.item)} (${e.item.homeState}), from ${fmtDate(e.date)}.`,
          personId: e.item.id,
        }
      )
    }
    case 'first_remote_employee': {
      const e = earliest(
        db.people.filter((p) => p.workMode === 'remote'),
        (p) => p.startDate,
      )
      return e && { date: e.date, text: `First remote employee: ${fullName(e.item)} (${e.item.homeState}), from ${fmtDate(e.date)}.`, personId: e.item.id }
    }
    case 'first_group_health_plan': {
      const on = db.company.groupHealthPlanStartedOn
      return on ? { date: on, text: `Group health plan started ${fmtDate(on)}.` } : undefined
    }
    case 'first_non_founder_manager': {
      const owners = ownerIds(db)
      const managerIds = new Set<ID>()
      for (const p of db.people) if (p.managerId) managerIds.add(p.managerId)
      for (const r of db.comp) if (r.managerId) managerIds.add(r.managerId)
      const e = earliest(
        [...managerIds].filter((id) => !owners.has(id) && db.people.some((p) => p.id === id)),
        (id) => supervisorSince(db, id),
      )
      if (!e) return undefined
      const m = db.people.find((p) => p.id === e.item) as Person
      return { date: e.date, text: `First manager other than a founder: ${fullName(m)}, from ${fmtDate(e.date)}.`, personId: m.id }
    }
    case 'first_non_exempt_hire': {
      const fromComp = new Map<ID, ISODate>()
      for (const r of db.comp) {
        if (r.flsa !== 'non_exempt') continue
        const prev = fromComp.get(r.personId)
        if (!prev || r.effectiveOn < prev) fromComp.set(r.personId, r.effectiveOn)
      }
      const e = earliest(db.people, (p) => {
        const c = fromComp.get(p.id)
        if (c) return c > p.startDate ? c : p.startDate
        return p.flsa === 'non_exempt' ? p.startDate : undefined
      })
      return e && { date: e.date, text: `First non-exempt employee: ${fullName(e.item)}, from ${fmtDate(e.date)}.`, personId: e.item.id }
    }
    case 'first_visa_sponsorship': {
      const needs = new Set(db.candidates.filter((c) => c.sponsorship === 'yes').map((c) => c.id))
      const fromOffers = earliest(
        db.offers.filter((o) => o.status === 'accepted' && needs.has(o.candidateId)),
        (o) => o.decidedOn ?? o.startDate,
      )
      const fromPeople = earliest(
        db.people.filter((p) => p.fromCandidateId && needs.has(p.fromCandidateId)),
        (p) => p.startDate,
      )
      const pick = [fromOffers?.date, fromPeople?.date].filter((d): d is ISODate => !!d).sort()[0]
      if (!pick) return undefined
      return { date: pick, text: `First hire who needs visa sponsorship, on ${fmtDate(pick)}.` }
    }
    case 'first_separation': {
      const e = earliest(
        db.people.filter((p) => p.endDate),
        (p) => p.separation?.lastDay ?? p.endDate ?? undefined,
      )
      return e && { date: e.date, text: `First departure: ${fullName(e.item)}, last day ${fmtDate(e.date)}.`, personId: e.item.id }
    }
    case 'ccpa_revenue': {
      const rev = db.company.annualRevenue
      if (rev === undefined || rev < CCPA_REVENUE_THRESHOLD) return undefined
      return { date, text: `Trailing revenue in Settings is at or above the CCPA threshold of $${CCPA_REVENUE_THRESHOLD.toLocaleString('en-US')}.` }
    }
    case 'credit_check': {
      const e = earliest(
        db.jobs.filter((j) => j.creditCheckBasis && j.creditCheckBasis.trim()),
        (j) => j.openedOn ?? j.postedOn ?? date,
      )
      return e && { date: e.date, text: `Credit checks turned on for ${e.item.title} (basis: ${e.item.creditCheckBasis}).` }
    }
  }
}

/** Plain explanation for an event rule that has not happened. */
export function eventNotYetText(event: ComplianceEvent, db: DB): string {
  switch (event) {
    case 'first_payroll':
      return db.people.length ? 'No one is paid yet: owners count once pay is recorded, or add the first payroll date in Settings.' : 'No one is on payroll yet.'
    case 'first_non_owner_employee':
      return 'Only owners are on payroll so far.'
    case 'first_contractor':
      return 'No contractors yet.'
    case 'first_option_grant':
      return 'No option has been granted yet.'
    case 'first_out_of_state_employee':
      return 'Everyone works in California.'
    case 'first_remote_employee':
      return 'No one works remotely yet.'
    case 'first_group_health_plan':
      return db.company.groupHealthPlanStartedOn === null
        ? 'No group health plan is offered.'
        : 'Add the date your group health plan started in Settings, Company.'
    case 'first_non_founder_manager':
      return 'Only founders have direct reports so far.'
    case 'first_non_exempt_hire':
      return 'Everyone is exempt so far.'
    case 'first_visa_sponsorship':
      return 'No accepted offer needs visa sponsorship.'
    case 'first_separation':
      return 'No one has left yet.'
    case 'ccpa_revenue':
      return db.company.annualRevenue === undefined
        ? 'Add trailing revenue in Settings to check the CCPA revenue test.'
        : `Trailing revenue is below the CCPA threshold of $${CCPA_REVENUE_THRESHOLD.toLocaleString('en-US')}.`
    case 'credit_check':
      return 'No job uses credit checks.'
  }
}

// ---------------------------------------------------------------------------------------------
// Contractor payment estimates (1099-NEC and DE 542 thresholds)
// ---------------------------------------------------------------------------------------------

/** Calendar months covered by [s, e], counting partial months by their share of days (Jan 1 to Dec 31 = 12). */
function monthsCovered(s: ISODate, e: ISODate): number {
  let total = 0
  let monthStart = `${s.slice(0, 7)}-01`
  while (monthStart <= e) {
    const next = addMonths(monthStart, 1)
    const monthEnd = addDays(next, -1)
    const a = s > monthStart ? s : monthStart
    const b = e < monthEnd ? e : monthEnd
    total += (daysBetween(a, b) + 1) / (daysBetween(monthStart, monthEnd) + 1)
    monthStart = next
  }
  return total
}

/** Estimated payments to a contractor in a calendar year, from rate and contract dates. */
export function estimatePaidInYear(c: Contractor, year: number): number {
  const ys = `${year}-01-01`
  const ye = `${year}-12-31`
  const s = c.startOn > ys ? c.startOn : ys
  const e = c.endOn && c.endOn < ye ? c.endOn : ye
  if (s > e) return 0
  const days = daysBetween(s, e) + 1
  switch (c.rateUnit) {
    case 'month':
      return Math.round(c.rate * monthsCovered(s, e))
    case 'hour':
      return Math.round(c.rate * (c.hoursPerWeek ?? 0) * (days / 7))
    case 'project': {
      if (!c.endOn) return c.startOn >= ys && c.startOn <= ye ? c.rate : 0
      const total = daysBetween(c.startOn, c.endOn) + 1
      return Math.round(c.rate * (days / Math.max(1, total)))
    }
  }
}

/** 1099-NEC threshold for payments made in a year ($600 through 2025; Settings value from 2026). */
export function form1099ThresholdFor(db: DB, paymentYear: number): number {
  return paymentYear <= 2025 ? 600 : db.settings.law.form1099Threshold
}

/** Contractors (not corporations) estimated to have been paid at or above the 1099-NEC threshold in a year. */
export function contractors1099(db: DB, paymentYear: number): Array<{ contractor: Contractor; estimate: number }> {
  const threshold = form1099ThresholdFor(db, paymentYear)
  return db.contractors
    .filter((c) => c.entityType !== 'corporation')
    .map((contractor) => ({ contractor, estimate: estimatePaidInYear(contractor, paymentYear) }))
    .filter((x) => x.estimate >= threshold)
}
