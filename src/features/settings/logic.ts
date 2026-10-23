// Pure helpers for Settings: backup parsing and import preview, storage usage, the solo-founder
// start, labels for checklist conditions and "Data we don't keep". No store imports here, so the
// helpers stay testable in node (see logic.test.ts).
import { blankDB } from '@/data/blank'
import { LOCAL_MIN_WAGES } from '@/data/law'
import { compOrFirst } from '@/domain/pay'
import { payrollProviderName } from '@/domain/payrun/calendar'
import { employedOn, fullName, incomingOn, isEmployedOn } from '@/domain/people'
import type { Company, DB, ID, LawSettings, Person, TaskCondition, TimeOffPolicy } from '@/domain/types'
import { fmtDate, type ISODate, today } from '@/lib/dates'
import { money } from '@/lib/format'

// ---------------------------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------------------------

export const SCHEMA_VERSION = 1

export type BackupParse = { ok: true; db: DB } | { ok: false; reason: string }

/** Collections every backup must carry as arrays (older saves may lack newer ones; migrate fills those). */
const REQUIRED_ARRAYS = ['people', 'jobs', 'candidates', 'applications'] as const

/** Validates pasted or picked backup text. Returns the parsed workspace or a plain reason it cannot be used. */
export function parseBackup(text: string): BackupParse {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, reason: 'Paste a backup or pick a file first.' }
  let data: unknown
  try {
    data = JSON.parse(trimmed)
  } catch {
    return {
      ok: false,
      reason: 'This is not valid JSON. Check that you copied the whole backup, from the first { to the last }.',
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'This file is not a First Twenty backup. A backup is one JSON object.' }
  }
  const obj = data as Record<string, unknown>
  const v = obj.schemaVersion
  if (v === undefined) return { ok: false, reason: 'This file has no schemaVersion, so it is not a First Twenty backup.' }
  if (typeof v !== 'number') return { ok: false, reason: 'The schemaVersion in this file is not a number.' }
  if (v > SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `This backup uses schema version ${v}, which is newer than this app (version ${SCHEMA_VERSION}). Open it in a newer copy of First Twenty.`,
    }
  }
  if (v !== SCHEMA_VERSION) return { ok: false, reason: `Schema version ${v} is not one this app can read.` }
  const company = obj.company as Record<string, unknown> | undefined
  if (!company || typeof company !== 'object' || typeof company.name !== 'string') {
    return { ok: false, reason: 'The backup has no company record, so it cannot be loaded.' }
  }
  for (const key of REQUIRED_ARRAYS) {
    if (!Array.isArray(obj[key])) return { ok: false, reason: `The backup is missing its ${key} list.` }
  }
  for (const [key, val] of Object.entries(obj)) {
    if (COLLECTION_LABELS[key] && val !== undefined && !Array.isArray(val)) {
      return { ok: false, reason: `The ${COLLECTION_LABELS[key].toLowerCase()} in this backup are not a list.` }
    }
  }
  if (!obj.settings || typeof obj.settings !== 'object') return { ok: false, reason: 'The backup has no settings record.' }
  return { ok: true, db: data as DB }
}

/** Collections shown in the import preview, in reading order. */
export const COLLECTION_LABELS: Record<string, string> = {
  people: 'People',
  contractors: 'Contractors and advisors',
  comp: 'Job and pay history rows',
  grants: 'Equity grants',
  jobs: 'Jobs',
  candidates: 'Candidates',
  applications: 'Applications',
  interviews: 'Interviews',
  scorecards: 'Scorecards',
  offers: 'Offers',
  referrals: 'Referrals',
  plan: 'Headcount plan lines',
  checklists: 'Checklists',
  documents: 'Document records',
  timeOffRequests: 'Time off requests',
  timeOffAdjustments: 'Time off adjustments',
  leaveCases: 'Leave cases',
  trainings: 'Trainings',
  acks: 'Policy acknowledgements',
  recordsRequests: 'Records requests',
  recurring: 'Recurring compliance items',
  departments: 'Departments',
  locations: 'Locations',
  levels: 'Levels',
  families: 'Job families',
  bands: 'Pay bands',
  timeOffPolicies: 'Time off policies',
  holidays: 'Holidays',
  policies: 'Policies',
  emailTemplates: 'Email templates',
  checklistTemplates: 'Checklist templates',
  activity: 'Activity log rows',
}

/**
 * The single documents in plain lower-case words, for the storage meter (the import preview compares
 * them under SECTION_LABELS instead).
 */
export const STORAGE_DOC_LABELS: Record<string, string> = {
  meta: 'workspace details',
  company: 'company details and funding',
  settings: 'hiring settings and rules',
  equity: 'option pool and 409A history',
  complianceStatus: 'compliance progress',
  inboxState: 'inbox snoozes',
}

/**
 * What a part of the workspace holds, in plain lower-case words ("time off policies", "pay bands"), for
 * the storage meter: the import preview's collection names, or the document's. Never a raw key for any
 * part the app knows (logic.test.ts checks every collection and document).
 */
export function storageLabel(key: string): string {
  const record = COLLECTION_LABELS[key]
  if (record) return record.charAt(0).toLowerCase() + record.slice(1)
  return STORAGE_DOC_LABELS[key] ?? key
}

/** Single records compared as a whole. */
const SECTION_LABELS: Record<string, string> = {
  company: 'Company and funding',
  settings: 'Hiring defaults, rules and rates',
  equity: 'Option pool and 409A history',
  complianceStatus: 'Compliance progress',
  inboxState: 'Inbox snoozes',
}

export type DiffRow = {
  key: string
  label: string
  current: number
  incoming: number
  added: number
  removed: number
  changed: number
}

export type DBDiff = {
  rows: DiffRow[]
  /** Single records that differ (company, settings, ...). */
  sections: Array<{ key: string; label: string }>
  companyFrom: string
  companyTo: string
  /** Records added + removed + changed, plus changed sections. */
  totalChanges: number
  identical: boolean
}

function byId(list: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!Array.isArray(list)) return out
  list.forEach((r, i) => {
    const id = r && typeof r === 'object' && 'id' in r ? String((r as { id: unknown }).id) : `#${i}`
    out.set(id, JSON.stringify(r))
  })
  return out
}

/** What replacing `current` with `incoming` would change, per collection. Backup timestamps are ignored. */
export function diffDB(current: DB, incoming: DB): DBDiff {
  const cur = current as unknown as Record<string, unknown>
  const inc = incoming as unknown as Record<string, unknown>
  const rows: DiffRow[] = Object.entries(COLLECTION_LABELS).map(([key, label]) => {
    const a = byId(cur[key])
    const b = byId(inc[key])
    let added = 0
    let removed = 0
    let changed = 0
    for (const [id, json] of b) {
      const prev = a.get(id)
      if (prev === undefined) added++
      else if (prev !== json) changed++
    }
    for (const id of a.keys()) if (!b.has(id)) removed++
    return { key, label, current: a.size, incoming: b.size, added, removed, changed }
  })
  const sections = Object.entries(SECTION_LABELS)
    .filter(([key]) => JSON.stringify(cur[key] ?? null) !== JSON.stringify(inc[key] ?? null))
    .map(([key, label]) => ({ key, label }))
  const totalChanges = rows.reduce((n, r) => n + r.added + r.removed + r.changed, 0) + sections.length
  return {
    rows,
    sections,
    companyFrom: current.company?.name ?? '',
    companyTo: incoming.company?.name ?? '',
    totalChanges,
    identical: totalChanges === 0,
  }
}

/** A company name as the start of a file name (the backup file's name lives in @/store/backup, with the backup). */
function companyStem(companyName: string): string {
  const stem = companyName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return stem || 'first-twenty'
}

/** Graduation pack file name: 'ledgerlark-people-2026-10-09.csv'. */
export function packFileName(companyName: string, pack: string, date: ISODate): string {
  return `${companyStem(companyName)}-${pack}-${date}.csv`
}

// ---------------------------------------------------------------------------------------------
// Storage meter
// ---------------------------------------------------------------------------------------------

/** Browsers give each site about 5 million characters of localStorage. */
export const STORAGE_QUOTA = 5_000_000
export const STORAGE_WARN_AT = 0.7

export function fmtBytes(n: number): string {
  if (n < 1000) return `${n} bytes`
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')} MB`
}

export type StorageUsage = { used: number; quota: number; fraction: number; tone: 'good' | 'warn' | 'bad'; text: string }

/** Share of the browser's storage the workspace uses; warns from 70%, alarms from 90%. */
export function storageUsage(used: number, quota = STORAGE_QUOTA): StorageUsage {
  const fraction = quota > 0 ? Math.min(1, used / quota) : 0
  const tone = fraction >= 0.9 ? 'bad' : fraction >= STORAGE_WARN_AT ? 'warn' : 'good'
  const pctText = fraction > 0 && fraction < 0.01 ? 'under 1%' : `${Math.round(fraction * 100)}%`
  return { used, quota, fraction, tone, text: `${fmtBytes(used)} of about ${fmtBytes(quota)} (${pctText})` }
}

// ---------------------------------------------------------------------------------------------
// Free text in settings (sync limit)
// ---------------------------------------------------------------------------------------------

/**
 * The longest text a long settings box accepts (maxLength): an email template's message, a time off
 * policy's description. Each record syncs as at most 256 KB (docs/SYNC.md), and the box lives inside one
 * record, so it stays far below that (the same cap as a hiring note).
 */
export const TEXT_MAX_CHARS = 20_000

/** The longest text a short settings box accepts: a level's meaning, a checklist task's why. */
export const SHORT_TEXT_MAX_CHARS = 2_000

/** "1,850 of 2,000 characters" once text is within a tenth of `max`, else null (for the field's hint). */
export function charCountText(text: string | undefined, max: number): string | null {
  const n = text?.length ?? 0
  return n >= max * 0.9 ? `${n.toLocaleString('en-US')} of ${max.toLocaleString('en-US')} characters` : null
}

/** A field hint with the character count appended once the text gets near `max`. */
export function hintWithCount(hint: string, text: string | undefined, max: number): string {
  const count = charCountText(text, max)
  return count ? `${hint} ${count}.` : hint
}

// ---------------------------------------------------------------------------------------------
// Start fresh as a solo founder
// ---------------------------------------------------------------------------------------------

/** HQ city chips with a downtown ZIP each (San Jose first: the default). */
export const HQ_CITIES: Array<{ city: string; zip: string }> = [
  { city: 'San Jose', zip: '95113' },
  { city: 'San Francisco', zip: '94105' },
  { city: 'Oakland', zip: '94612' },
  { city: 'Palo Alto', zip: '94301' },
  { city: 'Mountain View', zip: '94041' },
  { city: 'Sunnyvale', zip: '94086' },
  { city: 'Santa Clara', zip: '95050' },
]

export const FOUNDER_TITLES = ['Founder and CEO', 'Co-founder and CEO', 'Founder and CTO', 'Founder']

/** Local minimum wage in effect on a date for a city in LOCAL_MIN_WAGES (case-insensitive), if any. */
export function localMinWage(city: string | undefined, on: ISODate = today()): number | undefined {
  if (!city) return undefined
  const row = LOCAL_MIN_WAGES.find((r) => r.city.toLowerCase() === city.trim().toLowerCase())
  if (!row) return undefined
  if (row.next && on >= row.next.effective) return row.next.hourly
  return on >= row.effective ? row.hourly : undefined
}

export type FreshInput = {
  companyName: string
  /** Company website as typed ('example.com' or a full address); optional. */
  website?: string
  hqStreet?: string
  hqCity: string
  hqState: string
  hqZip: string
  firstName: string
  lastName: string
  title: string
  /** The founder's own work email. Optional: left blank, it stays empty until they add it (never guessed). */
  workEmail?: string
  startDate: ISODate
}

/** Why a work email does not look right, or null. Blank is fine: it can be added later on the profile. */
export function workEmailProblem(value: string | undefined): string | null {
  const v = value?.trim()
  if (!v) return null
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'Enter an email like name@example.com, or leave it blank.'
}

/** A website as typed ('example.com', 'https://example.com/') as a full web address, or '' when blank. */
export function normalizeWebsite(value: string | undefined): string {
  const v = value?.trim() ?? ''
  if (!v) return ''
  return /^https?:\/\//i.test(v) ? v : `https://${v}`
}

/** 'sam@example.com' from a first name and the website's domain, for a one-tap suggestion; null without both. */
export function suggestedWorkEmail(firstName: string, website: string | undefined): string | null {
  const url = normalizeWebsite(website)
  const host = url && !urlProblem(url) ? hostLabel(url) : null
  const local = firstName.trim().toLowerCase().replace(/[^a-z0-9.-]/g, '')
  return host && local ? `${local}@${host}` : null
}

/** A one-person workspace from the three setup screens. */
export function buildFreshDB(input: FreshInput): DB {
  const name = input.companyName.trim()
  const db = blankDB({
    companyName: name,
    founderFirstName: input.firstName.trim(),
    founderLastName: input.lastName.trim(),
    founderTitle: input.title.trim() || 'Founder and CEO',
    // Always a string, so blankDB never guesses an address from the company name.
    founderEmail: input.workEmail?.trim() ?? '',
    foundedOn: input.startDate,
    hqCity: input.hqCity.trim() || 'San Jose',
    hqState: (input.hqState.trim() || 'CA').toUpperCase(),
    hqZip: input.hqZip.trim() || '95113',
  })
  const website = normalizeWebsite(input.website)
  if (website && !urlProblem(website)) db.company.website = website
  if (input.hqStreet?.trim()) db.company.hq.street = input.hqStreet.trim()
  // blankDB knows San Jose's rate; other cities with their own minimum wage get theirs here.
  const hq = db.locations.find((l) => l.kind === 'hq')
  const local = localMinWage(db.company.hq.city, input.startDate)
  if (hq && local && db.company.hq.state === 'CA') {
    hq.minWageHourly = local
    hq.minWageNote = `City of ${db.company.hq.city} minimum wage`
  }
  return db
}

// ---------------------------------------------------------------------------------------------
// Checklist template labels
// ---------------------------------------------------------------------------------------------

const SEPARATION_LABELS: Record<string, string> = {
  resigned_notice: 'resigned with notice',
  resigned_no_notice: 'resigned without notice',
  terminated: 'terminated',
  laid_off: 'laid off',
  contract_ended: 'contract ended',
}

const LEAVE_LABELS: Record<string, string> = {
  cfra: 'CFRA',
  pdl: 'PDL',
  bonding: 'bonding',
  military: 'military',
  other: 'other leave',
}

/** Plain-language conditions for a template task; empty means it always applies. */
export function describeCondition(c: TaskCondition | undefined): string[] {
  if (!c) return []
  const out: string[] = []
  if (c.minHeadcount != null) out.push(`${c.minHeadcount}+ employees`)
  if (c.belowHeadcount != null) out.push(`Under ${c.belowHeadcount} employees`)
  if (c.minWorkforce != null) out.push(`${c.minWorkforce}+ employees and contractors`)
  if (c.supervisor === true) out.push('Supervisors')
  if (c.supervisor === false) out.push('Not a supervisor')
  if (c.flsa === 'non_exempt') out.push('Non-exempt')
  if (c.flsa === 'exempt') out.push('Exempt')
  if (c.remote === true) out.push('Remote')
  if (c.remote === false) out.push('Not remote')
  if (c.outsideCA === true) out.push('Works outside California')
  if (c.outsideCA === false) out.push('Works in California')
  if (c.hasEquity === true) out.push('Has equity')
  if (c.hasEquity === false) out.push('No equity')
  if (c.earlyExercise === true) out.push('Early exercise')
  if (c.backgroundCheck === true) out.push('Background check required')
  if (c.backgroundCheck === false) out.push('No background check')
  if (c.employmentType) out.push(c.employmentType.replace('_', ' ').replace(/^./, (s) => s.toUpperCase()))
  if (c.employmentTypes?.length) out.push(c.employmentTypes.map((t) => t.replace('_', ' ')).join(' or ').replace(/^./, (s) => s.toUpperCase()))
  if (c.separationTypes?.length) {
    const s = c.separationTypes.map((t) => SEPARATION_LABELS[t] ?? t).join(', ')
    out.push(`Exit: ${s}`)
  }
  if (c.leaveKinds?.length) out.push(`Leave: ${c.leaveKinds.map((k) => LEAVE_LABELS[k] ?? k).join(', ')}`)
  return out
}

export const CUSTOM_TASK_PREFIX = 'custom-'

export function isCustomTask(id: string): boolean {
  return id.startsWith(CUSTOM_TASK_PREFIX)
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Masks all but the last two digits: '123-4567-8' -> '•••-•••7-8'. Letters and punctuation stay. */
export function maskDigits(value: string | undefined, keep = 2): string {
  if (!value) return ''
  const total = (value.match(/\d/g) ?? []).length
  let seen = 0
  return value.replace(/\d/g, (d) => {
    seen++
    return seen > total - keep ? d : '•'
  })
}

/** Why a link-out URL is not usable, or null when it is fine (empty is fine: not set). */
export function urlProblem(value: string | undefined): string | null {
  const v = value?.trim()
  if (!v) return null
  if (!/^https?:\/\//i.test(v)) return 'Start the link with https://'
  try {
    const u = new URL(v)
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return 'This link has no domain, like example.com.'
    return null
  } catch {
    return 'This is not a complete web address.'
  }
}

/**
 * What is wrong with a link as it will be saved, or null: one typed without https:// ('secure.justworks.com')
 * is saved with it (normalizeWebsite), as Start fresh saves the website.
 */
export function linkProblem(value: string | undefined): string | null {
  return urlProblem(normalizeWebsite(value))
}

// The payroll or PEO provider's name ('' while there is none); it lives with pay run prep, which names it most.
export { payrollProviderName }

/** 'example.com' from a URL, for naming vendors in plain text. */
export function hostLabel(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** Moves an item up (-1) or down (+1) in a list; returns a new list. */
export function moveItem<T>(list: T[], index: number, dir: -1 | 1): T[] {
  const to = index + dir
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list
  const out = [...list]
  const [item] = out.splice(index, 1)
  out.splice(to, 0, item)
  return out
}

/** CA exempt salary floor: 2 x the state minimum wage x 2,080 hours, rounded to the dollar. */
export function exemptFloorFrom(minWageHourly: number): number {
  return Math.round(minWageHourly * 2 * 2080)
}

/** Review date for one Rules and rates value (its own date, else the whole set's). */
export function reviewedDate(law: LawSettings, key: string): ISODate {
  return law.reviewedOn?.[key] ?? law.lastReviewedOn
}

export type UsageKind = 'department' | 'location' | 'level' | 'family'

/** What still points at a department, location, level or job family (blocks removal while > 0). */
export function usageOf(db: DB, kind: UsageKind, id: string): { count: number; text: string } {
  const parts: string[] = []
  let count = 0
  const add = (n: number, one: string, many: string) => {
    if (n <= 0) return
    count += n
    parts.push(`${n} ${n === 1 ? one : many}`)
  }
  const active = db.people.filter((p) => !p.endDate || p.endDate >= today())
  if (kind === 'department') {
    add(active.filter((p) => p.departmentId === id).length, 'person', 'people')
    add(db.jobs.filter((j) => j.departmentId === id && j.status !== 'closed' && j.status !== 'filled').length, 'open job', 'open jobs')
    add(db.contractors.filter((k) => k.departmentId === id && (!k.endOn || k.endOn >= today())).length, 'contractor', 'contractors')
    add(db.plan.filter((s) => s.departmentId === id && s.status !== 'cut' && s.status !== 'filled').length, 'plan line', 'plan lines')
  } else if (kind === 'location') {
    add(active.filter((p) => p.locationId === id).length, 'person', 'people')
    add(db.jobs.filter((j) => j.locationIds.includes(id) && j.status !== 'closed' && j.status !== 'filled').length, 'open job', 'open jobs')
  } else if (kind === 'level') {
    add(active.filter((p) => p.levelId === id).length, 'person', 'people')
    add(db.jobs.filter((j) => j.levelId === id && j.status !== 'closed' && j.status !== 'filled').length, 'open job', 'open jobs')
    add(db.bands.filter((b) => b.levelId === id).length, 'pay band', 'pay bands')
    add(db.plan.filter((s) => s.levelId === id && s.status !== 'cut' && s.status !== 'filled').length, 'plan line', 'plan lines')
  } else {
    add(active.filter((p) => p.familyId === id).length, 'person', 'people')
    add(db.jobs.filter((j) => j.familyId === id && j.status !== 'closed' && j.status !== 'filled').length, 'open job', 'open jobs')
    add(db.bands.filter((b) => b.familyId === id).length, 'pay band', 'pay bands')
    add(db.settings.roleTemplates.filter((t) => t.familyId === id).length, 'role template', 'role templates')
  }
  return { count, text: parts.join(', ') }
}

// ---------------------------------------------------------------------------------------------
// California paid sick leave policy checks (docs/LAW.md a-psl-1, w-psl-caps)
// ---------------------------------------------------------------------------------------------

/** Longest normal workday (hours per week / 5) among people employed on the date, limited to the
 * policy's work states when it has them; 8 when nobody qualifies. "5 days" of sick leave uses it. */
export function longestWorkday(people: ReadonlyArray<Person>, date: ISODate, states?: ReadonlyArray<string>, fallbackState = 'CA'): number {
  const want = states?.map((s) => s.toUpperCase())
  let most = 0
  for (const p of people) {
    if (!isEmployedOn(p, date)) continue
    if (want?.length && !want.includes((p.homeState || fallbackState).toUpperCase())) continue
    const perDay = (p.hoursPerWeek > 0 ? p.hoursPerWeek : 40) / 5
    if (perDay > most) most = perDay
  }
  return most > 0 ? Math.round(most * 100) / 100 : 8
}

/** The California floors for a sick leave policy, in hours, for a workday of `workdayHours`. */
export function sickLeaveMinimums(workdayHours = 8): { yearly: number; cap: number; accrualYearly: number; maxWaitDays: number } {
  const wd = workdayHours > 0 ? workdayHours : 8
  const r = (n: number) => Math.round(n * 100) / 100
  return {
    // 40 hours or 5 days a year, whichever is more (front-loaded grant and the lowest allowed use limit).
    yearly: r(Math.max(40, 5 * wd)),
    // An accrual cap may not be lower than 80 hours or 10 days.
    cap: r(Math.max(80, 10 * wd)),
    // 1 hour for every 30 worked, over a full year of 5 workdays a week.
    accrualYearly: r((wd * 5 * 52) / 30),
    maxWaitDays: 90,
  }
}

export type SickPolicyInput = Pick<TimeOffPolicy, 'kind' | 'method'> & {
  annualHours?: number | null
  capHours?: number | null
  usageCapHours?: number | null
  usableAfterDays?: number | null
}

const hrs = (n: number) => `${Math.round(n * 100) / 100} hours`

/**
 * Why a sick leave policy falls short of California law, or null when it is fine (other kinds always
 * pass). Blank limits are fine: no use limit and no cap are both allowed.
 */
export function sickPolicyProblem(p: SickPolicyInput, workdayHours = 8): string | null {
  if (p.kind !== 'sick') return null
  const min = sickLeaveMinimums(workdayHours)
  const days = workdayHours > 8 ? ` The longest workday here is ${hrs(workdayHours)}, so 5 days is ${hrs(5 * workdayHours)}.` : ''
  const set = (v: number | null | undefined) => v != null && v > 0
  if ((p.usableAfterDays ?? 0) > min.maxWaitDays) return 'California lets you delay sick leave use by up to 90 days, not more.'
  if (p.method === 'frontload' && (p.annualHours ?? 0) < min.yearly) {
    return `Grant at least ${hrs(min.yearly)} a year. California requires 40 hours or 5 days of sick leave a year, whichever is more.${days}`
  }
  if (p.method === 'accrual' && (p.annualHours ?? 0) < min.accrualYearly - 0.005) {
    return `Earn at least ${hrs(min.accrualYearly)} a year. California requires at least 1 hour of sick leave for every 30 hours worked.`
  }
  if (set(p.usageCapHours) && (p.usageCapHours ?? 0) < min.yearly) {
    return `Set the yearly use limit to at least ${hrs(min.yearly)}, or leave it blank. California does not allow a limit below 40 hours or 5 days a year, whichever is more.${days}`
  }
  if (p.method === 'accrual' && set(p.capHours) && (p.capHours ?? 0) < min.cap) {
    return `Set the balance cap to at least ${hrs(min.cap)}, or leave it blank. California does not allow a cap below 80 hours or 10 days, whichever is more.${workdayHours > 8 ? ` The longest workday here is ${hrs(workdayHours)}.` : ''}`
  }
  if (p.method === 'frontload' && set(p.capHours)) {
    const floor = Math.max(min.yearly, p.annualHours ?? 0)
    if ((p.capHours ?? 0) < floor) return `Set the balance cap to at least ${hrs(floor)}, or leave it blank. A cap below the yearly grant takes away sick leave people are owed.`
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Data we don't keep
// ---------------------------------------------------------------------------------------------

export type NotKeptRow = { item: string; instead: string; systemOfRecord: string }

/** The sensitive data the app never stores, what it keeps instead, and who holds the real record. */
export function dataWeDontKeep(db: Pick<DB, 'company'>): NotKeptRow[] {
  const c = db.company
  const peo = payrollProviderName(c) || 'your payroll or PEO provider'
  const kind = c.payrollProvider?.kind === 'Payroll' ? 'payroll provider' : 'PEO'
  const payroll = peo.toLowerCase().startsWith('your') ? peo : `${peo} (${kind})`
  const bg = hostLabel(c.linkOuts.backgroundCheck)
  const bgVendor = bg ? `Your background check vendor (${bg})` : 'Your background check vendor'
  const benefits = hostLabel(c.linkOuts.benefits)
  const carrier = benefits ? `${payroll} or the benefits carrier (${benefits})` : `${payroll} or the benefits carrier`
  return [
    { item: 'Social Security numbers', instead: 'Nothing. Payroll needs them; this app does not.', systemOfRecord: payroll },
    { item: 'Dates of birth', instead: 'Work anniversaries from start dates. Releases default to 21 and 7 days so age is never needed.', systemOfRecord: carrier },
    { item: 'Bank and direct deposit details', instead: 'Nothing.', systemOfRecord: payroll },
    { item: 'Home street addresses', instead: 'City and state only, for state registration and local rules.', systemOfRecord: payroll },
    { item: 'ID scans', instead: 'I-9 status and dates.', systemOfRecord: `${payroll} (I-9 and E-Verify)` },
    { item: 'I-9 forms', instead: 'Section 1 and 2 dates and the retain-until date.', systemOfRecord: `${payroll} (I-9 and E-Verify)` },
    { item: 'Background check reports', instead: 'Clear or Consider, the date and the Fair Chance step dates.', systemOfRecord: bgVendor },
    { item: 'Medical details', instead: 'Leave type and dates; non-admins see only "Leave, back <date>".', systemOfRecord: `${carrier}; EDD for SDI and PFL claims` },
    {
      item: 'Protected characteristics',
      instead: 'Nothing: no gender, race, ethnicity, age, disability, veteran status, religion, marital status or pronouns.',
      systemOfRecord: 'Not collected. EEO-1 reporting starts at 100 employees and runs through your PEO.',
    },
  ]
}

// ---------------------------------------------------------------------------------------------
// Group health plan (Settings > Company)
// ---------------------------------------------------------------------------------------------

/** 'yes' with a start date, 'no' when the company offers none (null), 'unknown' while not recorded (undefined). */
export type HealthPlanChoice = 'yes' | 'no' | 'unknown'

export function healthPlanChoice(on: Company['groupHealthPlanStartedOn']): HealthPlanChoice {
  return on ? 'yes' : on === null ? 'no' : 'unknown'
}

/** Why the health plan form cannot be saved yet, or null. */
export function healthPlanProblem(choice: HealthPlanChoice, startedOn: string, date: ISODate = today()): string | null {
  if (choice !== 'yes') return null
  if (!startedOn) return 'Pick the date the group health plan started, or choose Not recorded.'
  if (startedOn > date) return 'The start date is in the future. Record the plan once coverage begins.'
  return null
}

/** Writes the choice: a date, null for no plan (COBRA rules do not apply), or removes the field. */
export function setHealthPlan(company: Pick<Company, 'groupHealthPlanStartedOn'>, choice: HealthPlanChoice, startedOn: string): void {
  if (choice === 'yes' && startedOn) company.groupHealthPlanStartedOn = startedOn
  else if (choice === 'no') company.groupHealthPlanStartedOn = null
  else delete company.groupHealthPlanStartedOn
}

// ---------------------------------------------------------------------------------------------
// Exempt recheck (Settings > Rules and rates, Yearly review)
// ---------------------------------------------------------------------------------------------

export type ExemptRecheck = {
  /** Exempt people (employed or starting) with a salary on file, the ones the floor check covers. */
  withSalary: Array<{ personId: ID; name: string }>
  /** Exempt people with no job and pay record yet: nothing to check until one is added. */
  noSalary: Array<{ personId: ID; name: string; founder: boolean }>
}

/** Who the exempt salary check covers on the date, as exemptFlags sees it (employed and incoming, the record in force). */
export function exemptRecheck(db: DB, date: ISODate): ExemptRecheck {
  const out: ExemptRecheck = { withSalary: [], noSalary: [] }
  for (const p of [...employedOn(db, date), ...incomingOn(db, date)]) {
    const rec = compOrFirst(db, p.id, date)
    if ((rec?.flsa ?? p.flsa) !== 'exempt') continue
    if (rec) out.withSalary.push({ personId: p.id, name: fullName(p) })
    else out.noSalary.push({ personId: p.id, name: fullName(p), founder: !!p.isFounder })
  }
  return out
}

/** The all-clear sentence when no exempt salary is flagged: one person by name, several by count, or none on file. */
export function exemptRecheckText(r: ExemptRecheck, floor: number): string {
  const rule = `the ${money(floor)} floor and the computer professional minimum where it applies`
  if (!r.withSalary.length) return 'No exempt salaries on file yet.'
  if (r.withSalary.length === 1) return `${r.withSalary[0].name}'s salary clears ${rule}.`
  return `All ${r.withSalary.length} exempt salaries clear ${rule}.`
}

// ---------------------------------------------------------------------------------------------
// Edit forms that stay current while another computer saves (Settings panels and sheets)
// ---------------------------------------------------------------------------------------------

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

function keysOf<T extends object>(...objs: T[]): Array<keyof T> {
  return [...new Set(objs.flatMap((o) => Object.keys(o)))] as Array<keyof T>
}

/** Fields whose value differs between two snapshots of a form (what the user changed since it opened). */
export function changedKeys<T extends object>(from: T, to: T): Array<keyof T> {
  return keysOf(from, to).filter((k) => !same(from[k], to[k]))
}

export type EditMerge<T> = { opened: T; draft: T; conflicts: Array<keyof T> }

/**
 * Brings an open edit form up to date with the stored value (`current`) when another computer saved while
 * it was open. Fields the user has not touched take the stored value. A field the user changed that was
 * also changed elsewhere is a conflict, unless both sides now hold the same value. Returns the same
 * `opened` and `draft` objects when nothing moved, so it is cheap to run on every render.
 */
export function mergeIncoming<T extends object>(opened: T, draft: T, current: T): EditMerge<T> {
  let o = opened
  let d = draft
  const conflicts: Array<keyof T> = []
  for (const k of keysOf(opened, draft, current)) {
    if (same(opened[k], current[k])) continue
    if (same(draft[k], opened[k])) {
      // Untouched here: show what was saved there.
      o = o === opened ? { ...opened } : o
      d = d === draft ? { ...draft } : d
      o[k] = current[k]
      d[k] = current[k]
    } else if (same(draft[k], current[k])) {
      // Both made the same change: nothing left to save for it.
      o = o === opened ? { ...opened } : o
      o[k] = current[k]
    } else conflicts.push(k)
  }
  return { opened: o, draft: d, conflicts }
}

/** Longest stored text a conflict notice quotes whole; longer text is cut short with '...'. */
const QUOTE_MAX = 60

/**
 * A stored value as the conflict notice says it after "is now": '"Close in a day"' (text, cut short when
 * long), 'Oct 1, 2026' (a date), '1,200,000' (a number), 'blank'. Null when it is nothing short to say (a
 * list, a record, a yes or no): the notice then only names the field.
 */
export function conflictValueText(value: unknown): string | null {
  if (value === null || value === undefined) return 'blank'
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString('en-US') : null
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!v) return 'blank'
  if (/^\d{4}-\d{2}-\d{2}$/.test(v) && fmtDate(v)) return fmtDate(v)
  if (v.length <= QUOTE_MAX) return `"${v}"`
  // Cut at a word break when there is one in the second half.
  const cut = v.slice(0, QUOTE_MAX - 3)
  const space = cut.lastIndexOf(' ')
  return `"${(space > QUOTE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}..."`
}

/**
 * Settles conflicting fields: 'theirs' takes the stored values into the form; 'mine' keeps the form's values
 * and counts them as changes against the stored ones, so Save writes them over what was saved there.
 */
export function resolveConflicts<T extends object>(
  m: Pick<EditMerge<T>, 'opened' | 'draft'>,
  current: T,
  keys: Array<keyof T>,
  choice: 'theirs' | 'mine',
): { opened: T; draft: T } {
  const opened = { ...m.opened }
  const draft = { ...m.draft }
  for (const k of keys) {
    opened[k] = current[k]
    if (choice === 'theirs') draft[k] = current[k]
  }
  return { opened, draft }
}
