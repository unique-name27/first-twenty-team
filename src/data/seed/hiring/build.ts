// Builds the Ledgerlark hiring sample (docs/SAMPLE.md) on an Immer draft: plan slots, historical
// filled jobs with each hire's application, interviews and accepted offer, the open jobs with their
// pipelines, Daniel Reyes's offer waiting for approval, and the two incoming hires (Lucas Ferreira,
// Mei Tanaka) run through the real offer and Hire flow (src/domain/lifecycle.ts hireFromOffer).
//
// Deterministic: a seeded PRNG picks names, dates inside fixed windows and ratings; every id is
// hand-built; activity rows written by domain helpers get stable ids and story timestamps.
// Module rule: function declarations only (no module-level runtime constants), because the seed can
// run while the store module is still loading (see src/domain/lifecycle.ts).
import { current, type Draft, isDraft } from 'immer'
import { setTaskStatus } from '@/domain/checklists/actions'
import { startBackgroundCheck, recordBackgroundResult } from '@/domain/hiring/backgroundChecks'
import { approveOffer, createOffer, defaultExemptionBasis, markAccepted, markSent, submitForApproval } from '@/domain/hiring/offers'
import { formatDual } from '@/domain/hiring/scheduling'
import { overallSuggestion } from '@/domain/hiring/scorecards'
import { addHoursISO, addMinutesISO, businessDaysBetween, lowerFirst, outcomeReasonLabel, pacificDateOf, pacificToUTC } from '@/domain/hiring/util'
import { hireFromOffer } from '@/domain/lifecycle'
import type {
  Activity,
  Application,
  Attribute,
  Candidate,
  DB,
  EntityType,
  ID,
  Interview,
  InterviewStep,
  Job,
  JobStage,
  Offer,
  Person,
  Rating,
  Scorecard,
  SourceKind,
} from '@/domain/types'
import { addBusinessDays, addDays, addMonths, type ISODate, type ISODateTime } from '@/lib/dates'
import {
  type ActiveSpec,
  type Bias,
  type ClosedMix,
  type DeptKey,
  historicalHires,
  type HireSpec,
  type InterviewSpec,
  type JobSpec,
  type LocKey,
  openJobSpecs,
  openPipelines,
  type OtherSpec,
  type Pipeline,
  planSpecs,
  rosterDates,
  type StageKey,
} from './catalog'
import {
  bayAreaPlaces,
  firstNames,
  inboundBoards,
  lastNames,
  otherCaliforniaPlaces,
  outboundChannels,
  outOfStatePlaces,
  profile,
  type ProfileKey,
  reservedNames,
  scoreNotes,
} from './pools'
import { makeRng, type Rng } from './rng'

/** The day the sample is authored against (Friday). Nothing closed or submitted is dated after it. */
export function hiringAnchor(): ISODate {
  return '2026-10-09'
}

type Ctx = {
  d: Draft<DB>
  rng: Rng
  holidays: ISODate[]
  usedNames: Set<string>
  usedIds: Set<string>
  ivSeq: Map<ID, number>
  actSeq: { n: number }
  /** Activity rows written by this builder (index into d.activity where they start). */
  actStart: number
  profiles: Map<ID, ProfileKey>
  /** Busy time ranges (epoch ms) per interviewer id and candidate id, so generated interviews never double-book. */
  booked: Map<ID, Array<[number, number]>>
  /** How often each first and last name has been used, to keep the pool varied. */
  nameCounts: Map<string, number>
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function plain<T>(v: T): T {
  return structuredClone(isDraft(v) ? current(v) : v)
}

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function bd(ctx: Ctx, date: ISODate, n: number): ISODate {
  return addBusinessDays(date, n, ctx.holidays)
}

function bdBetween(ctx: Ctx, from: ISODate, to: ISODate): number {
  return businessDaysBetween(from, to, ctx.holidays)
}

function isBusinessDay(ctx: Ctx, d: ISODate): boolean {
  return bd(ctx, bd(ctx, d, -1), 1) === d
}

/** The date when it is a business day, else the next one. */
function onBusinessDay(ctx: Ctx, d: ISODate): ISODate {
  return isBusinessDay(ctx, d) ? d : bd(ctx, d, 1)
}

function minDate(a: ISODate, b: ISODate): ISODate {
  return a < b ? a : b
}

function maxDate(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b
}

function addYears(d: ISODate, n: number): ISODate {
  return addMonths(d, 12 * n)
}

function person(ctx: Ctx, id: ID): Draft<Person> | undefined {
  return ctx.d.people.find((p) => p.id === id)
}

/** Employed on the date per the roster (people seeded later, like Lucas, only from their start). */
function employed(ctx: Ctx, id: ID, date: ISODate): boolean {
  const r = rosterDates()[id]
  if (r) return r.start <= date && (!r.end || r.end >= date)
  const p = person(ctx, id)
  return !!p && p.startDate <= date && (!p.endDate || p.endDate >= date)
}

function deptFor(ctx: Ctx, key: DeptKey): ID {
  const names: Record<DeptKey, string[]> = {
    exec: ['executive'],
    eng: ['engineering'],
    ai: ['applied ai'],
    product: ['product and design', 'product'],
    gtm: ['go to market'],
    acct: ['accounting'],
    ops: ['operations', 'finance and operations', 'people and operations'],
  }
  for (const n of names[key]) {
    const dep = ctx.d.departments.find((x) => x.name.trim().toLowerCase() === n)
    if (dep) return dep.id
  }
  const heads: Record<DeptKey, ID> = { exec: 'p-founder', eng: 'p-tomas', ai: 'p-priya', product: 'p-sofia', gtm: 'p-caleb', acct: 'p-elena', ops: 'p-jasmine' }
  const head = person(ctx, heads[key])
  if (head) return head.departmentId
  const fallback: Record<DeptKey, ID> = { exec: 'd-exec', eng: 'd-eng', ai: 'd-eng', product: 'd-product', gtm: 'd-gtm', acct: 'd-ops', ops: 'd-ops' }
  return fallback[key]
}

function locFor(ctx: Ctx, key: LocKey): ID {
  const locs = ctx.d.locations
  const hq = locs.find((l) => l.kind === 'hq') ?? locs[0]
  const remoteCA = locs.find((l) => l.kind === 'remote' && l.state === 'CA')
  if (key === 'hq') return hq?.id ?? 'loc-hq'
  if (key === 'remote-ca') return remoteCA?.id ?? hq?.id ?? 'loc-hq'
  return locs.find((l) => l.state === 'TX')?.id ?? remoteCA?.id ?? hq?.id ?? 'loc-hq'
}

/** Runs a domain mutation and gives the activity rows it wrote stable ids, a story time and an actor. */
function logged<T>(ctx: Ctx, at: ISODateTime, actorId: ID | null, fn: () => T): T {
  const before = ctx.d.activity.length
  const out = fn()
  const base = new Date(at).getTime()
  for (let i = before; i < ctx.d.activity.length; i++) {
    const row = ctx.d.activity[i]
    row.id = nextActId(ctx)
    row.at = new Date(base + (i - before) * 1000).toISOString()
    row.actorId = actorId
    row.viewingAs = actorId === 'p-founder' || actorId === 'p-jasmine' ? 'admin' : 'manager'
  }
  return out
}

function nextActId(ctx: Ctx): ID {
  ctx.actSeq.n += 1
  return `act-h-${String(ctx.actSeq.n).padStart(3, '0')}`
}

function addActivity(
  ctx: Ctx,
  row: { at: ISODateTime; actorId: ID; entityType: EntityType; entityId: ID; relatedId?: ID; kind: string; text: string },
): void {
  const a: Activity = {
    id: nextActId(ctx),
    at: row.at,
    actorId: row.actorId,
    viewingAs: row.actorId === 'p-founder' || row.actorId === 'p-jasmine' ? 'admin' : 'manager',
    entityType: row.entityType,
    entityId: row.entityId,
    kind: row.kind,
    text: row.text,
    ...(row.relatedId ? { relatedId: row.relatedId } : {}),
  }
  ctx.d.activity.push(a)
}

function fullName(c: { firstName: string; lastName: string }): string {
  return `${c.firstName} ${c.lastName}`
}

function personName(ctx: Ctx, id: ID): string {
  const p = person(ctx, id)
  if (p) return `${p.preferredName || p.firstName} ${p.lastName}`
  const names: Record<ID, string> = {
    'p-founder': 'Maya Raman',
    'p-tomas': 'Tomas Herrera',
    'p-priya': 'Priya Nair',
    'p-elena': 'Elena Vasquez',
    'p-kofi': 'Kofi Boateng',
    'p-caleb': 'Caleb Washington',
    'p-hannah': 'Hannah Kim',
    'p-nikhil': 'Nikhil Rao',
    'p-sofia': 'Sofia Rossi',
    'p-ravi': 'Ravi Subramanian',
    'p-jasmine': 'Jasmine Torres',
    'p-chris': 'Chris Nakamura',
    'p-aisha': 'Aisha Bello',
  }
  return names[id] ?? 'A teammate'
}

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

function findAttribute(ctx: Ctx, name: string, full: boolean): Attribute {
  for (const t of ctx.d.settings.roleTemplates) {
    for (const s of t.interviewPlan) {
      const a = s.attributes.find((x) => x.name === name)
      if (a) {
        const p = plain(a)
        return full ? p : { name: p.name }
      }
    }
  }
  return { name }
}

function buildStages(ctx: Ctx, spec: JobSpec): JobStage[] {
  const tmpl = spec.roleTemplateId ? ctx.d.settings.roleTemplates.find((t) => t.id === spec.roleTemplateId) : undefined
  const base = plain(tmpl?.stages?.length ? tmpl.stages : ctx.d.settings.defaultStages)
  return base
    .filter((s) => !(spec.skipTechnical && s.kind === 'technical'))
    .map((s) => (s.kind === 'technical' && spec.technicalName ? { ...s, name: spec.technicalName } : s))
}

function buildPlan(ctx: Ctx, spec: JobSpec, full: boolean): InterviewStep[] {
  if (spec.plan) {
    return spec.plan.map((s, i) => ({
      id: `${spec.id}-s${i + 1}`,
      stageId: s.stageId,
      name: s.name,
      durationMin: s.durationMin,
      interviewerIds: [...s.interviewerIds],
      attributes: s.attrs.map((n) => findAttribute(ctx, n, full)),
    }))
  }
  const tmpl = spec.roleTemplateId ? ctx.d.settings.roleTemplates.find((t) => t.id === spec.roleTemplateId) : undefined
  const steps = plain(tmpl?.interviewPlan ?? [])
  return steps
    .map((s, i) => ({ s, i }))
    .filter(({ i }) => !spec.keepSteps || spec.keepSteps.includes(i))
    .map(({ s, i }, n) => ({
      id: `${spec.id}-s${n + 1}`,
      stageId: s.stageId,
      name: s.name,
      durationMin: s.durationMin,
      interviewerIds: [...(spec.stepPanels?.[i] ?? [spec.hmId])],
      attributes: s.attributes.map((a) => (full ? a : { name: a.name })),
    }))
}

function addJob(ctx: Ctx, spec: JobSpec, opts: { status: Job['status']; closedOn?: ISODate; departmentId?: ID }): Job {
  // Filled jobs keep attribute names only (their scorecards are in); open jobs keep anchors and questions.
  const full = spec.status !== 'filled'
  const tmpl = spec.roleTemplateId ? ctx.d.settings.roleTemplates.find((t) => t.id === spec.roleTemplateId) : undefined
  const job: Job = {
    id: spec.id,
    title: spec.title,
    departmentId: opts.departmentId ?? deptFor(ctx, spec.dept),
    familyId: spec.familyId,
    levelId: spec.levelId,
    hiringManagerId: spec.hmId,
    panelIds: [...spec.panelIds],
    locationIds: [...new Set(spec.locs.map((k) => locFor(ctx, k)))],
    workMode: spec.workMode,
    employmentType: spec.employmentType ?? 'full_time',
    flsa: spec.flsa ?? 'exempt',
    payMin: spec.payMin,
    payMax: spec.payMax,
    status: opts.status,
    openedOn: spec.openedOn,
    stages: buildStages(ctx, spec),
    interviewPlan: buildPlan(ctx, spec, full),
    description: spec.description ?? (tmpl ? String(tmpl.jdOutline) : ''),
    sponsorship: spec.sponsorship,
    backgroundCheck: spec.backgroundCheck,
    creditCheckBasis: null,
    priority: spec.priority,
    ...(spec.equityMinPct != null ? { equityMinPct: spec.equityMinPct } : {}),
    ...(spec.equityMaxPct != null ? { equityMaxPct: spec.equityMaxPct } : {}),
    ...(spec.postedOn ? { postedOn: spec.postedOn } : {}),
    ...(opts.closedOn ? { closedOn: opts.closedOn } : {}),
    ...(spec.targetStart ? { targetStart: spec.targetStart } : {}),
    ...(spec.planSlotId ? { planSlotId: spec.planSlotId } : {}),
    ...(spec.roleTemplateId ? { roleTemplateId: spec.roleTemplateId } : {}),
    ...(spec.isBackfill ? { isBackfill: true, backfillForPersonId: spec.backfillForPersonId ?? null } : {}),
    ...(spec.referralBonus != null ? { referralBonus: spec.referralBonus } : {}),
  }
  ctx.d.jobs.push(job)
  ctx.profiles.set(job.id, spec.profile)
  return job
}

function getJob(ctx: Ctx, id: ID): Draft<Job> {
  const j = ctx.d.jobs.find((x) => x.id === id)
  if (!j) throw new Error(`Seed: no job ${id}`)
  return j
}

function stepIndexFor(job: Pick<Job, 'interviewPlan'>, stageId: string): number {
  return job.interviewPlan.findIndex((s) => s.stageId === stageId)
}

function hasStage(job: Pick<Job, 'stages'>, stageId: string): boolean {
  return job.stages.some((s) => s.id === stageId)
}

// ---------------------------------------------------------------------------------------------
// Candidates and applications
// ---------------------------------------------------------------------------------------------

type CandInput = {
  id?: ID
  first?: string
  last?: string
  source: SourceKind
  sourceDetail?: string
  referrerId?: ID
  place?: [string, string]
  currentTitle?: string
  currentCompany?: string
  summary?: string
  desiredPay?: number
  sponsorship?: Candidate['sponsorship']
  tags?: string[]
  phone?: string
  portfolio?: boolean
  createdOn: ISODate
  profile: ProfileKey
  /** Pay range used to suggest a desired pay when none is given. */
  range?: [number, number] | null
  /** 'bay' (default), 'ca' or 'out' for generated places. */
  where?: 'bay' | 'ca' | 'out'
}

function newName(ctx: Ctx): [string, string] {
  const firsts = firstNames()
  const lasts = lastNames()
  const reserved = new Set(reservedNames())
  for (let i = 0; i < 500; i++) {
    const f = ctx.rng.pick(firsts)
    const l = ctx.rng.pick(lasts)
    const full = `${f} ${l}`
    if (reserved.has(full) || ctx.usedNames.has(full)) continue
    if ((ctx.nameCounts.get(`l:${l}`) ?? 0) >= 2 || (ctx.nameCounts.get(`f:${f}`) ?? 0) >= 3) continue
    return [f, l]
  }
  throw new Error('Seed: ran out of candidate names')
}

function uniqueId(ctx: Ctx, base: string): string {
  let id = base
  for (let i = 2; ctx.usedIds.has(id); i++) id = `${base}-${i}`
  ctx.usedIds.add(id)
  return id
}

function phoneFor(ctx: Ctx, place: string): string {
  const area = /San Francisco|Oakland|Berkeley|Hayward|Fremont|Pleasanton|Walnut Creek/.test(place)
    ? ctx.rng.pick(['415', '510'])
    : /Palo Alto|Mountain View|Redwood City|San Mateo|Menlo Park/.test(place)
      ? '650'
      : /, CA/.test(place)
        ? '408'
        : ctx.rng.pick(['206', '512', '303', '212', '617', '312'])
  return `(${area}) 555-01${String(ctx.rng.int(0, 99)).padStart(2, '0')}`
}

function placeFor(ctx: Ctx, where: 'bay' | 'ca' | 'out'): [string, string] {
  if (where === 'out') return ctx.rng.pick(outOfStatePlaces())
  if (where === 'ca') return ctx.rng.pick(otherCaliforniaPlaces())
  return ctx.rng.pick(bayAreaPlaces())
}

function addCandidate(ctx: Ctx, input: CandInput): Draft<Candidate> {
  const [first, last] = input.first && input.last ? [input.first, input.last] : newName(ctx)
  ctx.usedNames.add(`${first} ${last}`)
  ctx.nameCounts.set(`f:${first}`, (ctx.nameCounts.get(`f:${first}`) ?? 0) + 1)
  ctx.nameCounts.set(`l:${last}`, (ctx.nameCounts.get(`l:${last}`) ?? 0) + 1)
  const id = input.id ?? uniqueId(ctx, `c-${slug(`${first} ${last}`)}`)
  if (input.id) ctx.usedIds.add(input.id)
  const prof = profile(input.profile)
  const place = input.place ?? placeFor(ctx, input.where ?? 'bay')
  const s = slug(`${first} ${last}`)
  const links: Candidate['links'] = { linkedin: `https://www.linkedin.com/in/${s}-${ctx.rng.int(10, 99)}` }
  if (prof.github && ctx.rng.chance(0.7)) links.github = `https://github.com/${slug(first)}${slug(last).slice(0, 4)}`
  if (prof.portfolio || input.portfolio) links.portfolio = `https://www.example.com/portfolio/${s}`
  const range = input.range
  const desired =
    input.desiredPay ??
    (range ? Math.round((range[0] + ctx.rng.next() * (range[1] * 1.08 - range[0])) / 5000) * 5000 : undefined)
  const cand: Candidate = {
    id,
    firstName: first,
    lastName: last,
    email: `${slug(first).replace(/-/g, '')}.${slug(last).replace(/-/g, '')}@${ctx.rng.pick(['example.com', 'example.net', 'example.org'])}`,
    links,
    location: place[0],
    timezone: place[1],
    currentTitle: input.currentTitle ?? ctx.rng.pick(prof.titles),
    currentCompany: input.currentCompany ?? ctx.rng.pick(prof.companies),
    source: input.source,
    sponsorship:
      input.sponsorship ??
      ctx.rng.weighted<Candidate['sponsorship']>([
        ['no', 0.82],
        ['unknown', 0.11],
        ['yes', 0.07],
      ]),
    tags: [...(input.tags ?? [])],
    summary: input.summary ?? ctx.rng.pick(prof.summaries),
    createdOn: input.createdOn,
    retainUntil: addYears(input.createdOn, 4),
    ...(input.sourceDetail ? { sourceDetail: input.sourceDetail } : {}),
    ...(input.referrerId ? { referrerId: input.referrerId } : {}),
    ...(desired != null ? { desiredPay: desired } : {}),
  }
  const phone = input.phone ?? (ctx.rng.chance(0.55) ? phoneFor(ctx, place[0]) : undefined)
  if (phone) cand.phone = phone
  ctx.d.candidates.push(cand)
  return ctx.d.candidates[ctx.d.candidates.length - 1]
}

function getCandidate(ctx: Ctx, id: ID): Draft<Candidate> {
  const c = ctx.d.candidates.find((x) => x.id === id)
  if (!c) throw new Error(`Seed: no candidate ${id}`)
  return c
}

/** Keeps applicant records 4 years after the latest decision (Gov Code 12946). */
function retain(ctx: Ctx, candidateId: ID, decidedOn: ISODate): void {
  const c = getCandidate(ctx, candidateId)
  const until = addYears(decidedOn, 4)
  if (!c.retainUntil || c.retainUntil < until) c.retainUntil = until
}

function addApp(
  ctx: Ctx,
  input: {
    id?: ID
    candidateId: ID
    job: Pick<Job, 'id' | 'stages'>
    appliedOn: ISODate
    moves: Array<[string, ISODate, ID?]>
    status: Application['status']
  },
): Draft<Application> {
  const first = input.job.stages[0]?.id ?? 'new'
  const history: Application['history'] = [{ stageId: first, at: input.appliedOn }]
  for (const [stageId, at, byId] of input.moves) history.push(byId ? { stageId, at, byId } : { stageId, at })
  const last = history[history.length - 1]
  const base = input.id ?? `a-${input.candidateId.replace(/^c-/, '')}`
  const id = uniqueId(ctx, base)
  const app: Application = {
    id,
    candidateId: input.candidateId,
    jobId: input.job.id,
    stageId: last.stageId,
    status: input.status,
    appliedOn: input.appliedOn,
    stageEnteredOn: last.at,
    history,
  }
  ctx.d.applications.push(app)
  return ctx.d.applications[ctx.d.applications.length - 1]
}

function closeApp(ctx: Ctx, app: Draft<Application>, status: 'rejected' | 'withdrawn', reason: Application['outcomeReason'], closedOn: ISODate, note?: string): void {
  app.status = status
  if (reason) app.outcomeReason = reason
  if (note) app.outcomeNote = note
  app.closedOn = closedOn
  app.notifiedOn = closedOn
  app.lastContactOn = closedOn
  delete app.nextStep
  retain(ctx, app.candidateId, closedOn)
}

// ---------------------------------------------------------------------------------------------
// Interviews and scorecards
// ---------------------------------------------------------------------------------------------

function rating(ctx: Ctx, bias: Bias): Rating {
  switch (bias) {
    case 'hire':
      return ctx.rng.weighted<Rating>([
        [4, 0.5],
        [3, 0.45],
        [2, 0.05],
      ])
    case 'strong':
      return ctx.rng.weighted<Rating>([
        [4, 0.3],
        [3, 0.55],
        [2, 0.15],
      ])
    case 'mixed':
      return ctx.rng.weighted<Rating>([
        [3, 0.45],
        [2, 0.45],
        [1, 0.1],
      ])
    case 'weak':
      return ctx.rng.weighted<Rating>([
        [3, 0.15],
        [2, 0.55],
        [1, 0.3],
      ])
  }
}

function overallFor(bias: Bias, ratings: Record<string, Rating>): Rating {
  const s = overallSuggestion(ratings) ?? 2
  if (bias === 'hire') return s >= 4 ? 4 : 3
  if (bias === 'strong') return s >= 3 ? s : 3
  if (bias === 'weak') return s <= 2 ? s : 2
  return s
}

function shortId(personId: ID): string {
  return personId.replace(/^p-/, '')
}

type Slot = { date: ISODate; hour: number; minute: number }

function slotRange(slot: Slot, durationMin: number): [number, number] {
  const start = Date.parse(pacificToUTC(slot.date, slot.hour, slot.minute))
  return [start, start + durationMin * 60_000]
}

function isBooked(ctx: Ctx, keys: ID[], [start, end]: [number, number]): boolean {
  return keys.some((k) => (ctx.booked.get(k) ?? []).some(([s, e]) => start < e && s < end))
}

function book(ctx: Ctx, keys: ID[], range: [number, number]): void {
  for (const k of keys) ctx.booked.set(k, [...(ctx.booked.get(k) ?? []), range])
}

/** The wanted slot when nobody involved is busy, else the next free business-hours slot (same day first). */
function freeSlot(ctx: Ctx, keys: ID[], want: Slot, durationMin: number): Slot {
  const hours: Array<[number, number]> = [[want.hour, want.minute], [9, 0], [10, 0], [11, 0], [13, 0], [14, 0], [15, 0], [16, 0]]
  let date = want.date
  for (let day = 0; day < 6; day++) {
    for (const [hour, minute] of hours) {
      if (hour * 60 + minute + durationMin > 18 * 60 + 30) continue
      const slot = { date, hour, minute }
      if (!isBooked(ctx, keys, slotRange(slot, durationMin))) return slot
    }
    date = bd(ctx, date, 1)
  }
  return want
}

/** The panel for a step on a date: the given interviewers who work here then, else the hiring manager. */
function panelFor(ctx: Ctx, job: Pick<Job, 'hiringManagerId'>, ids: ID[], date: ISODate): ID[] {
  const panel = ids.filter((p) => employed(ctx, p, date))
  return panel.length ? panel : [employed(ctx, job.hiringManagerId, date) ? job.hiringManagerId : 'p-founder']
}

/** Most interviewers submit the same afternoon or the next morning; a few run a day or two late. */
function submittedAt(ctx: Ctx, date: ISODate, endMin: number): ISODateTime {
  const r = ctx.rng.next()
  let day = date
  let minutes: number
  if (r < 0.5 && endMin + 30 <= 18 * 60) minutes = Math.min(18 * 60 + 30, endMin + ctx.rng.int(20, 150))
  else if (r < 0.92) {
    day = bd(ctx, date, 1)
    minutes = ctx.rng.int(8 * 60 + 30, 12 * 60)
  } else {
    day = bd(ctx, date, 2)
    minutes = ctx.rng.int(9 * 60, 16 * 60)
  }
  const iso = pacificToUTC(day, Math.floor(minutes / 60), minutes % 60)
  if (iso <= scorecardCap()) return iso
  const sameDay = Math.min(endMin + 25, 21 * 60)
  return pacificToUTC(date, Math.floor(sameDay / 60), sameDay % 60)
}

/** Nothing is submitted after 11:00 AM Pacific on the anchor day. */
function scorecardCap(): ISODateTime {
  return '2026-10-09T18:00:00.000Z'
}

/**
 * Adds an interview and one scorecard per interviewer. Generated interviews move to a free slot when
 * an interviewer or the candidate is already booked; `fixed` ones (hand-placed story interviews) keep
 * their time and were booked up front.
 */
function addInterview(ctx: Ctx, app: Pick<Application, 'id' | 'jobId' | 'candidateId'>, spec: InterviewSpec, opts: { fixed?: boolean } = {}): Interview {
  const job = getJob(ctx, app.jobId)
  const step = job.interviewPlan[spec.step]
  if (!step) throw new Error(`Seed: job ${job.id} has no interview step ${spec.step}`)
  const n = (ctx.ivSeq.get(app.id) ?? 0) + 1
  ctx.ivSeq.set(app.id, n)
  const suffix = app.id.replace(/^a-/, '')
  let panel = panelFor(ctx, job, spec.interviewers ?? step.interviewerIds, spec.date)
  let slot: Slot = { date: spec.date, hour: spec.hour, minute: spec.minute ?? 0 }
  if (!opts.fixed) {
    slot = freeSlot(ctx, [...panel, app.candidateId], slot, step.durationMin)
    if (slot.date !== spec.date) panel = panelFor(ctx, job, spec.interviewers ?? step.interviewerIds, slot.date)
    book(ctx, [...panel, app.candidateId], slotRange(slot, step.durationMin))
  }
  const startsAt = pacificToUTC(slot.date, slot.hour, slot.minute)
  const prof = ctx.profiles.get(job.id) ?? 'eng'
  const format: Interview['format'] = step.stageId === 'onsite' ? (job.workMode === 'remote' ? 'video' : 'onsite') : prof === 'coord' ? 'phone' : 'video'
  const iv: Interview = {
    id: `i-${suffix}-${n}`,
    applicationId: app.id,
    stepId: step.id,
    stageId: step.stageId,
    name: step.name,
    startsAt,
    durationMin: step.durationMin,
    interviewerIds: panel,
    format,
    status: spec.status,
    attributes: step.attributes.map((a) => a.name),
    ...(spec.icsIssuedOn ? { icsIssuedOn: spec.icsIssuedOn } : {}),
  }
  ctx.d.interviews.push(iv)
  const ends = addMinutesISO(startsAt, step.durationMin)
  const dueAt = addHoursISO(ends, ctx.d.settings.scorecardDueHours || 24)
  for (const pid of panel) {
    const sc: Scorecard = { id: `s-${suffix}-${n}-${shortId(pid)}`, interviewId: iv.id, applicationId: app.id, interviewerId: pid, dueAt, ratings: {} }
    if (spec.scorecards === 'submitted') {
      const ratings: Record<string, Rating> = {}
      for (const a of iv.attributes) ratings[a] = rating(ctx, spec.bias)
      sc.ratings = ratings
      sc.overall = overallFor(spec.bias, ratings)
      sc.submittedAt = submittedAt(ctx, slot.date, slot.hour * 60 + slot.minute + step.durationMin)
      if (ctx.rng.chance(0.65)) sc.notes = ctx.rng.pick(scoreNotes(prof, sc.overall >= 3))
    }
    ctx.d.scorecards.push(sc)
  }
  return iv
}

/** Books the hand-placed interviews of the open pipelines first, so generated history never collides with them. */
function bookStoryInterviews(ctx: Ctx): void {
  const jobs = new Map(openJobSpecs().map((j) => [j.id, j]))
  for (const p of openPipelines()) {
    const spec = jobs.get(p.jobId)
    p.active.forEach((a, i) => {
      for (const iv of a.interviews ?? []) {
        const step = spec?.plan?.[iv.step]
        if (!spec || !step) continue
        const panel = panelFor(ctx, { hiringManagerId: spec.hmId }, iv.interviewers ?? step.interviewerIds, iv.date)
        book(ctx, [...panel, `story-${p.jobId}-${i}`], slotRange({ date: iv.date, hour: iv.hour, minute: iv.minute ?? 0 }, step.durationMin))
      }
    })
  }
}

// ---------------------------------------------------------------------------------------------
// Timelines
// ---------------------------------------------------------------------------------------------

type Timeline = {
  applied: ISODate
  intro: ISODate
  introAt: ISODate
  technical?: ISODate
  technicalAt?: ISODate
  onsite: ISODate
  onsiteAt: ISODate
  offer: ISODate
}

/** Stage dates spread over [applied, offerOn] at fixed fractions, each a business day after the last. */
function spread(ctx: Ctx, job: Pick<Job, 'stages'>, applied: ISODate, offerOn: ISODate): Timeline {
  const span = Math.max(8, bdBetween(ctx, applied, offerOn))
  let prev = applied
  const at = (f: number): ISODate => {
    let d = bd(ctx, applied, Math.max(1, Math.round(span * f)))
    if (d <= prev) d = bd(ctx, prev, 1)
    prev = d
    return d
  }
  const tech = hasStage(job, 'technical')
  const intro = at(0.16)
  const introAt = at(0.28)
  const technical = tech ? at(0.4) : undefined
  const technicalAt = tech ? at(0.55) : undefined
  const onsite = at(0.68)
  const onsiteAt = at(0.86)
  let offer = offerOn
  if (offer <= prev) offer = bd(ctx, prev, 1)
  return { applied, intro, introAt, onsite, onsiteAt, offer, ...(technical ? { technical, technicalAt } : {}) }
}

function movesUpTo(job: Pick<Job, 'stages'>, tl: Timeline, reached: StageKey, byId: ID): Array<[string, ISODate, ID]> {
  const out: Array<[string, ISODate, ID]> = []
  const order: StageKey[] = ['intro', 'technical', 'onsite', 'offer']
  const idx = order.indexOf(reached)
  if (idx < 0) return out
  const dates: Record<string, ISODate | undefined> = { intro: tl.intro, technical: tl.technical, onsite: tl.onsite, offer: tl.offer }
  for (const k of order.slice(0, idx + 1)) {
    const at = dates[k]
    if (at && hasStage(job, k)) out.push([k, at, byId])
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Historical filled jobs
// ---------------------------------------------------------------------------------------------

type HireBuild = { spec: HireSpec; job: Draft<Job>; app: Draft<Application>; tl: Timeline; sentOn: ISODate; offerCreated: ISODate }

function addHistorical(ctx: Ctx, h: HireSpec): HireBuild {
  const existing = person(ctx, h.personId)
  const job = addJob(ctx, h.job, {
    status: h.viaHireFlow ? 'open' : 'filled',
    ...(h.viaHireFlow ? {} : { closedOn: h.accepted }),
    ...(existing && !h.viaHireFlow ? { departmentId: existing.departmentId } : {}),
  })
  const jobDraft = getJob(ctx, job.id)
  // Offer dates: created a few business days before acceptance and after any declined offer.
  const declined = h.others.find((o) => o.offer)?.offer
  let offerCreated = bd(ctx, h.accepted, -4)
  if (declined && offerCreated <= declined.decidedOn) offerCreated = bd(ctx, declined.decidedOn, 1)
  let sentOn = bd(ctx, offerCreated, 1)
  if (sentOn >= h.accepted) sentOn = bd(ctx, h.accepted, -1)
  if (offerCreated >= sentOn) offerCreated = bd(ctx, sentOn, -1)
  const tl = spread(ctx, jobDraft, h.applied, offerCreated)

  const cand = addCandidate(ctx, {
    id: `c-hire-${h.key}`,
    first: h.first,
    last: h.last,
    source: h.cand.source,
    ...(h.cand.sourceDetail ? { sourceDetail: h.cand.sourceDetail } : {}),
    ...(h.cand.referrerId ? { referrerId: h.cand.referrerId } : {}),
    place: h.cand.place,
    currentTitle: h.cand.currentTitle,
    currentCompany: h.cand.currentCompany,
    summary: h.cand.summary,
    ...(h.cand.desiredPay != null ? { desiredPay: h.cand.desiredPay } : {}),
    sponsorship: h.cand.sponsorship ?? 'no',
    tags: h.cand.tags ?? [],
    ...(h.cand.phone ? { phone: h.cand.phone } : {}),
    ...(h.cand.portfolio ? { portfolio: true } : {}),
    createdOn: h.applied,
    profile: h.job.profile,
  })
  const moves = movesUpTo(jobDraft, tl, 'offer', h.job.hmId)
  const app = addApp(ctx, { id: `a-hire-${h.key}`, candidateId: cand.id, job: jobDraft, appliedOn: h.applied, moves, status: h.viaHireFlow ? 'active' : 'hired' })
  addHireInterviews(ctx, jobDraft, app, tl, 'hire')
  if (!h.viaHireFlow) {
    app.history.push({ stageId: 'hired', at: h.accepted, byId: h.offer.draftedById })
    app.stageId = 'hired'
    app.stageEnteredOn = h.accepted
    app.conditionalOfferOn = h.accepted
    app.closedOn = h.accepted
    app.lastContactOn = h.accepted
    retain(ctx, cand.id, h.accepted)
  }

  for (const o of h.others) addOther(ctx, h, jobDraft, tl, o)

  if (!h.viaHireFlow) {
    ctx.d.offers.push(historicalOffer(ctx, h, jobDraft, app, offerCreated, sentOn))
    const p = person(ctx, h.personId)
    if (p) {
      p.fromCandidateId = cand.id
      p.fromApplicationId = app.id
    }
  }
  return { spec: h, job: jobDraft, app, tl, sentOn, offerCreated }
}

/** Intro, technical and onsite interviews along a timeline, all completed with scorecards in. */
function addHireInterviews(ctx: Ctx, job: Draft<Job>, app: Pick<Application, 'id' | 'jobId' | 'candidateId'>, tl: Timeline, bias: Bias): void {
  const plan = job.interviewPlan
  plan.forEach((step, i) => {
    const date = step.stageId === 'intro' ? tl.introAt : step.stageId === 'technical' ? tl.technicalAt : step.stageId === 'onsite' ? tl.onsiteAt : undefined
    if (!date) return
    const onsiteIndex = plan.slice(0, i).filter((s) => s.stageId === 'onsite').length
    const hour = step.stageId === 'onsite' ? [10, 13, 15][onsiteIndex] ?? 15 : step.stageId === 'technical' ? 13 : 10
    addInterview(ctx, app, { step: i, date, hour, status: 'completed', scorecards: 'submitted', bias })
  })
}

function addOther(ctx: Ctx, h: HireSpec, job: Draft<Job>, hireTl: Timeline, o: OtherSpec): void {
  const prof = h.job.profile
  const opened = job.openedOn ?? h.applied
  let applied = bd(ctx, h.applied, ctx.rng.int(-5, 6))
  if (applied <= opened) applied = bd(ctx, opened, ctx.rng.int(1, 3))
  let offerOn: ISODate
  if (o.offer) {
    offerOn = bd(ctx, o.offer.sentOn, -1)
    if (applied >= bd(ctx, offerOn, -10)) applied = maxDate(bd(ctx, opened, 1), bd(ctx, offerOn, -18))
  } else if (o.reason === 'position_filled') {
    offerOn = hireTl.offer
  } else {
    offerOn = bd(ctx, applied, Math.max(10, bdBetween(ctx, h.applied, hireTl.offer)))
  }
  const tl = spread(ctx, job, applied, offerOn)
  const reached: StageKey = o.reached === 'technical' && !hasStage(job, 'technical') ? 'intro' : o.reached
  const moves = movesUpTo(job, tl, reached, h.job.hmId)
  const keepWarm = !!o.keepWarm
  const cand = addCandidate(ctx, {
    ...(o.name ? { first: o.name[0], last: o.name[1] } : {}),
    source:
      o.source ??
      (o.reached === 'new' || o.reason === 'location'
        ? 'inbound'
        : ctx.rng.weighted<SourceKind>([
            ['inbound', 0.7],
            ['outbound', 0.22],
            ['referral', 0.08],
          ])),
    sourceDetail: o.sourceDetail ?? ctx.rng.pick(inboundBoards(prof)),
    ...(o.referrerId ? { referrerId: o.referrerId } : {}),
    ...(o.place ? { place: o.place } : {}),
    ...(o.currentTitle ? { currentTitle: o.currentTitle } : {}),
    ...(o.currentCompany ? { currentCompany: o.currentCompany } : {}),
    ...(o.summary ? { summary: o.summary } : {}),
    sponsorship: o.sponsorship ?? (o.reason === 'location' ? 'unknown' : 'no'),
    tags: keepWarm ? ['keep warm', 'silver medalist'] : [],
    createdOn: applied,
    profile: prof,
    range: h.job.payMin != null && h.job.payMax != null && h.job.payMax > 1000 ? [h.job.payMin, h.job.payMax] : null,
    where: o.reason === 'location' ? 'out' : 'bay',
  })
  // Sources named 'Careers page' etc. only make sense for inbound candidates.
  if (cand.source === 'outbound' && !o.sourceDetail) cand.sourceDetail = ctx.rng.pick(outboundChannels())
  if (cand.source === 'referral' && !cand.referrerId) {
    const referrers = h.job.panelIds.filter((p) => employed(ctx, p, applied) && p !== 'p-founder')
    if (referrers.length) {
      cand.referrerId = ctx.rng.pick(referrers)
      cand.sourceDetail = 'Employee referral'
    } else {
      cand.source = 'inbound'
    }
  }
  const app = addApp(ctx, { candidateId: cand.id, job, appliedOn: applied, moves, status: 'active' })
  // The furthest stage's interview (enough for the record without storing every round).
  let lastEvent = moves.length ? moves[moves.length - 1][1] : applied
  const stageForInterview = reached === 'offer' ? 'onsite' : reached
  if (stageForInterview !== 'new') {
    const idx = stepIndexFor(job, stageForInterview)
    const date = stageForInterview === 'intro' ? tl.introAt : stageForInterview === 'technical' ? tl.technicalAt : tl.onsiteAt
    if (idx >= 0 && date) {
      const bias: Bias = keepWarm || o.offer ? 'strong' : o.status === 'rejected' ? (o.reason === 'skills_gap' ? 'weak' : 'mixed') : 'strong'
      const iv = addInterview(ctx, app, { step: idx, date, hour: stageForInterview === 'onsite' ? 10 : 14, status: 'completed', scorecards: 'submitted', bias })
      const held = pacificDateOf(iv.startsAt)
      if (held > lastEvent) lastEvent = held
    }
  }
  let closedOn: ISODate
  if (o.offer) {
    closedOn = o.offer.decidedOn
    ctx.d.offers.push(declinedOffer(ctx, h, job, app, o))
  } else if (o.reason === 'position_filled') {
    closedOn = bd(ctx, h.accepted, 1)
  } else {
    closedOn = bd(ctx, lastEvent, ctx.rng.int(1, 3))
  }
  closedOn = minDate(closedOn, bd(ctx, hiringAnchor(), -1))
  if (closedOn <= lastEvent) closedOn = bd(ctx, lastEvent, 1)
  closeApp(ctx, app, o.status, o.reason, closedOn, o.note)
}

function offerBase(ctx: Ctx, h: HireSpec, job: Draft<Job>): Pick<Offer, 'levelId' | 'familyId' | 'departmentId' | 'locationId' | 'workMode' | 'employmentType' | 'flsa' | 'contingencies'> & { exemptionBasis?: Offer['exemptionBasis'] } {
  const p = person(ctx, h.personId)
  const flsa = p?.flsa ?? job.flsa
  const exemptionBasis = flsa === 'exempt' ? (p?.exemptionBasis ?? defaultExemptionBasis(job.familyId, job.levelId)) : undefined
  return {
    levelId: job.levelId,
    familyId: job.familyId,
    departmentId: p?.departmentId ?? job.departmentId,
    locationId: p?.locationId ?? (job.workMode === 'remote' && h.cand.place[0].endsWith(', TX') ? locFor(ctx, 'remote-tx') : (job.locationIds[0] ?? locFor(ctx, 'hq'))),
    workMode: p?.workMode ?? job.workMode,
    employmentType: p?.employmentType ?? job.employmentType,
    flsa,
    contingencies: job.backgroundCheck ? ['background_check', 'i9', 'piia'] : ['i9', 'piia'],
    ...(exemptionBasis ? { exemptionBasis } : {}),
  }
}

function historicalOffer(ctx: Ctx, h: HireSpec, job: Draft<Job>, app: Pick<Application, 'id' | 'candidateId'>, createdOn: ISODate, sentOn: ISODate): Offer {
  const base = offerBase(ctx, h, job)
  const o = h.offer
  const offer: Offer = {
    id: `o-hire-${h.key}`,
    applicationId: app.id,
    candidateId: app.candidateId,
    jobId: job.id,
    version: 1,
    title: o.title,
    managerId: o.managerId,
    ...base,
    hoursPerWeek: o.hoursPerWeek ?? (base.employmentType === 'full_time' ? 40 : 20),
    payType: o.hourlyRate != null ? 'hourly' : 'salary',
    equityType: 'ISO',
    equityShares: o.equity,
    vestingMonths: 48,
    cliffMonths: 12,
    startDate: h.start,
    expiresOn: bd(ctx, sentOn, 5),
    status: 'accepted',
    createdOn,
    draftedById: o.draftedById,
    draftedByRole: o.draftedByRole,
    approvals: o.approverId ? [{ approverId: o.approverId, decision: 'approved', at: pacificToUTC(createdOn, 11, 30) }] : [],
    sentOn,
    decidedOn: h.accepted,
    personId: h.personId,
  }
  if (o.salary != null) offer.salary = o.salary
  if (o.hourlyRate != null) offer.hourlyRate = o.hourlyRate
  if (o.variablePct != null) offer.variablePct = o.variablePct
  if (job.backgroundCheck) {
    // The people seed holds the cleared date (status and date only); a drawn date stands in without one.
    // The draw always happens so the generated sample does not shift when a person record changes.
    const drawn = bd(ctx, h.accepted, ctx.rng.int(3, 6))
    const check = person(ctx, h.personId)?.backgroundCheck
    const completedOn = check?.status === 'clear' && check.completedOn ? check.completedOn : drawn
    offer.backgroundCheck = { status: 'complete', result: 'clear', consentSentOn: h.accepted, completedOn }
  }
  return offer
}

function declinedOffer(ctx: Ctx, h: HireSpec, job: Draft<Job>, app: Pick<Application, 'id' | 'candidateId'>, o: OtherSpec): Offer {
  const dec = o.offer
  if (!dec) throw new Error('Seed: declinedOffer needs offer details')
  const base = offerBase(ctx, h, job)
  const createdOn = bd(ctx, dec.sentOn, -1)
  const byAdmin = h.offer.draftedByRole === 'admin'
  return {
    id: `o-${app.candidateId.replace(/^c-/, '')}`,
    applicationId: app.id,
    candidateId: app.candidateId,
    jobId: job.id,
    version: 1,
    title: h.offer.title,
    managerId: h.offer.managerId,
    ...base,
    locationId: job.locationIds[0] ?? base.locationId,
    workMode: job.workMode,
    hoursPerWeek: 40,
    payType: 'salary',
    salary: dec.salary,
    equityType: 'ISO',
    equityShares: dec.equity,
    vestingMonths: 48,
    cliffMonths: 12,
    startDate: onBusinessDay(ctx, addDays(dec.decidedOn, 28)),
    expiresOn: bd(ctx, dec.sentOn, 5),
    status: 'declined',
    createdOn,
    draftedById: h.offer.draftedById,
    draftedByRole: h.offer.draftedByRole,
    approvals: byAdmin ? [] : [{ approverId: 'p-founder', decision: 'approved', at: pacificToUTC(createdOn, 11, 0) }],
    sentOn: dec.sentOn,
    decidedOn: dec.decidedOn,
    declineReason: dec.declineReason,
    competingNote: dec.competingNote,
  }
}

/** Funnel counts beyond the applications kept on record (docs/BENCHMARKS.md c-funnel-*, c-applications-per-hire). */
function setArchivedFunnel(ctx: Ctx, h: HireSpec, job: Draft<Job>): void {
  const apps = ctx.d.applications.filter((a) => a.jobId === job.id)
  const order = job.stages.map((s) => s.id)
  const furthest = (a: Pick<Application, 'history' | 'stageId'>) => Math.max(...[a.stageId, ...a.history.map((x) => x.stageId)].map((s) => order.indexOf(s)))
  const reached = (stageId: string) => {
    const i = order.indexOf(stageId)
    return i < 0 ? 0 : apps.filter((a) => furthest(a) >= i || (h.viaHireFlow && a.id === `a-hire-${h.key}`)).length
  }
  const tech = hasStage(job, 'technical')
  job.archivedFunnel = {
    applied: Math.max(0, h.funnel.applied - apps.length),
    intro: Math.max(0, h.funnel.intro - reached('intro')),
    technical: tech ? Math.max(0, h.funnel.technical - reached('technical')) : 0,
    onsite: Math.max(0, h.funnel.onsite - reached('onsite')),
    offers: Math.max(0, h.funnel.offers - reached('offer')),
    accepted: 0,
  }
}

// ---------------------------------------------------------------------------------------------
// Open pipelines
// ---------------------------------------------------------------------------------------------

function addActive(ctx: Ctx, job: Draft<Job>, s: ActiveSpec): Draft<Application> {
  const prof = ctx.profiles.get(job.id) ?? 'eng'
  let candId: ID
  if (s.candidateId) {
    candId = s.candidateId
  } else {
    const source = s.source ?? 'inbound'
    const cand = addCandidate(ctx, {
      ...(s.name ? { first: s.name[0], last: s.name[1] } : {}),
      source,
      ...(s.sourceDetail ? { sourceDetail: s.sourceDetail } : {}),
      ...(s.referrerId ? { referrerId: s.referrerId } : {}),
      ...(s.place ? { place: s.place } : {}),
      ...(s.currentTitle ? { currentTitle: s.currentTitle } : {}),
      ...(s.currentCompany ? { currentCompany: s.currentCompany } : {}),
      ...(s.summary ? { summary: s.summary } : {}),
      ...(s.desiredPay != null ? { desiredPay: s.desiredPay } : {}),
      ...(s.sponsorship ? { sponsorship: s.sponsorship } : {}),
      tags: s.tags ?? [],
      createdOn: s.applied,
      profile: prof,
      range: job.payMin != null && job.payMax != null ? [job.payMin, job.payMax] : null,
      where: ctx.rng.chance(0.9) ? 'bay' : 'ca',
    })
    candId = cand.id
  }
  const app = addApp(ctx, { candidateId: candId, job, appliedOn: s.applied, moves: s.moves ?? [], status: 'active' })
  let lastTouch = app.stageEnteredOn
  for (const iv of s.interviews ?? []) {
    addInterview(ctx, app, iv, { fixed: true })
    if (iv.status === 'completed' && iv.date > lastTouch) lastTouch = iv.date
    if (iv.status === 'scheduled' && iv.icsIssuedOn && iv.icsIssuedOn > lastTouch) lastTouch = iv.icsIssuedOn
  }
  app.nextStep = { ...s.next }
  app.lastContactOn = s.lastContactOn ?? lastTouch
  if (s.snoozedUntil) app.snoozedUntil = s.snoozedUntil
  return app
}

/** Business days a closed application needs from applying to its close, by the furthest stage reached. */
function closedSpan(reached: StageKey): number {
  return { new: 3, intro: 8, technical: 14, onsite: 19, offer: 22 }[reached]
}

function addClosed(ctx: Ctx, job: Draft<Job>, p: Pipeline, mix: ClosedMix): void {
  const prof = ctx.profiles.get(job.id) ?? 'eng'
  const anchor = hiringAnchor()
  const onHold = job.status === 'on_hold'
  const lastClose = onHold ? '2026-09-22' : bd(ctx, anchor, -1)
  for (let k = 0; k < mix.count; k++) {
    const opened = job.openedOn ?? bd(ctx, anchor, -30)
    const window = bdBetween(ctx, opened, lastClose) - closedSpan(mix.reached)
    const applied = bd(ctx, opened, Math.max(1, ctx.rng.int(1, Math.max(1, window))))
    const source: SourceKind =
      mix.reached === 'new' && mix.reason === 'no_response'
        ? 'outbound'
        : mix.reason === 'location'
          ? 'inbound'
          : ctx.rng.weighted<SourceKind>([
            ['inbound', 0.7],
            ['outbound', 0.16],
            ['referral', 0.08],
            ['agency', 0.06],
          ])
    const referrers = p.referrers.filter((r) => employed(ctx, r, applied))
    const referrerId = source === 'referral' && referrers.length ? ctx.rng.pick(referrers) : undefined
    const cand = addCandidate(ctx, {
      source: source === 'referral' && !referrerId ? 'inbound' : source,
      sourceDetail:
        source === 'outbound' ? ctx.rng.pick(outboundChannels()) : source === 'agency' ? 'Bright Path Talent' : referrerId ? 'Employee referral' : ctx.rng.pick(inboundBoards(prof)),
      ...(referrerId ? { referrerId } : {}),
      createdOn: applied,
      profile: prof,
      range: job.payMin != null && job.payMax != null ? [job.payMin, job.payMax] : null,
      where: mix.reason === 'location' ? 'out' : ctx.rng.chance(0.9) ? 'bay' : 'ca',
      tags: mix.keepWarm ? ['keep warm'] : [],
      ...(mix.reason === 'location' ? { sponsorship: ctx.rng.pick<Candidate['sponsorship']>(['no', 'unknown']) } : {}),
    })
    // Stage dates with short, random gaps.
    const moves: Array<[string, ISODate, ID]> = []
    let cur = applied
    let lastEvent = applied
    const order: StageKey[] = ['intro', 'technical', 'onsite']
    const upto = order.indexOf(mix.reached)
    const interviewAt: Record<string, ISODate> = {}
    for (const st of order.slice(0, upto + 1)) {
      if (!hasStage(job, st)) continue
      cur = bd(ctx, cur, ctx.rng.int(1, 3))
      moves.push([st, cur, job.hiringManagerId])
      cur = bd(ctx, cur, ctx.rng.int(1, 3))
      interviewAt[st] = cur
      lastEvent = cur
    }
    const app = addApp(ctx, { candidateId: cand.id, job, appliedOn: applied, moves, status: 'active' })
    if (mix.reached !== 'new') {
      const st = mix.reached
      const idx = stepIndexFor(job, st)
      const date = interviewAt[st]
      if (idx >= 0 && date && date < anchor) {
        const bias: Bias = mix.keepWarm ? 'strong' : mix.status === 'rejected' ? (mix.reason === 'skills_gap' ? 'weak' : 'mixed') : 'strong'
        const step = job.interviewPlan[idx]
        const interviewers = st === 'intro' ? [ctx.rng.pick(panelFor(ctx, job, step.interviewerIds, date))] : undefined
        const iv = addInterview(ctx, app, { step: idx, date, hour: ctx.rng.pick([9, 10, 11, 13, 14, 15]), status: 'completed', scorecards: 'submitted', bias, ...(interviewers ? { interviewers } : {}) })
        const held = pacificDateOf(iv.startsAt)
        if (held > lastEvent) lastEvent = held
      }
    }
    let closedOn = bd(ctx, lastEvent, ctx.rng.int(1, 3))
    if (onHold) closedOn = '2026-09-22'
    if (closedOn > lastClose) closedOn = lastClose
    if (closedOn <= lastEvent) closedOn = minDate(bd(ctx, lastEvent, 1), bd(ctx, anchor, -1))
    closeApp(ctx, app, mix.status, mix.reason, closedOn, mix.note)
  }
}

// ---------------------------------------------------------------------------------------------
// The incoming hires and Daniel's offer, through the real offer and Hire flows
// ---------------------------------------------------------------------------------------------

function hireFlowOffer(ctx: Ctx, b: HireBuild): Omit<Offer, 'id'> & { id: ID } {
  const h = b.spec
  const base = offerBase(ctx, h, b.job)
  return {
    id: `o-hire-${h.key}`,
    applicationId: b.app.id,
    candidateId: b.app.candidateId,
    jobId: b.job.id,
    version: 1,
    title: h.offer.title,
    managerId: h.offer.managerId,
    ...base,
    hoursPerWeek: 40,
    payType: 'salary',
    salary: h.offer.salary ?? 0,
    ...(h.offer.signOnBonus ? { signOnBonus: h.offer.signOnBonus } : {}),
    equityType: 'ISO',
    equityShares: h.offer.equity,
    vestingMonths: 48,
    cliffMonths: 12,
    startDate: h.start,
    expiresOn: bd(ctx, b.sentOn, 5),
    status: 'draft',
    createdOn: b.offerCreated,
    draftedById: h.offer.draftedById,
    draftedByRole: h.offer.draftedByRole,
    approvals: [],
  }
}

/** Gives records a domain helper just created stable, readable ids. */
function stabilizeNewIds(ctx: Ctx, before: Record<string, Set<ID>>, key: string): void {
  const d = ctx.d
  const rename = <T extends { id: ID }>(rows: T[], seen: Set<ID>, make: (row: T) => ID) => {
    const taken = new Set(rows.map((r) => r.id))
    for (const row of rows) {
      if (seen.has(row.id)) continue
      const base = make(row)
      let id = base
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
      taken.delete(row.id)
      taken.add(id)
      row.id = id
    }
  }
  rename(d.grants, before.grants, () => `g-${key}`)
  rename(d.comp, before.comp, (r) => `cr-${key}-${r.reason}`)
  rename(d.documents, before.documents, (r) => `doc-${key}-${r.type.replace(/_/g, '-')}`)
  rename(d.referrals, before.referrals, () => `ref-hire-${key}`)
  for (const ck of d.checklists) {
    if (before.checklists.has(ck.id)) continue
    const id = `ck-${key}-${ck.kind.replace(/_/g, '-')}`
    const suffix = id.slice(3)
    ck.id = id
    for (const t of ck.tasks) if (t.templateTaskId) t.id = `t-${suffix}-${t.templateTaskId}`
  }
}

function idSnapshot(ctx: Ctx): Record<string, Set<ID>> {
  const d = ctx.d
  return {
    grants: new Set(d.grants.map((x) => x.id)),
    comp: new Set(d.comp.map((x) => x.id)),
    documents: new Set(d.documents.map((x) => x.id)),
    referrals: new Set(d.referrals.map((x) => x.id)),
    checklists: new Set(d.checklists.map((x) => x.id)),
  }
}

function runHireFlow(ctx: Ctx, b: HireBuild, opts: { approvedAt: ISODateTime; bgStart: ISODate; hireOn: ISODate; bgClearOn?: ISODate }): ID {
  const d = ctx.d
  const h = b.spec
  const before = idSnapshot(ctx)
  const offer = hireFlowOffer(ctx, b)
  const draftedBy = h.offer.draftedById
  const createdAt = pacificToUTC(b.offerCreated, 15, 10)
  logged(ctx, createdAt, draftedBy, () => createOffer(d, offer))
  logged(ctx, addMinutesISO(createdAt, 12), draftedBy, () => submitForApproval(d, offer.id, { date: b.offerCreated }))
  logged(ctx, opts.approvedAt, 'p-founder', () => approveOffer(d, offer.id, { approverId: 'p-founder', at: opts.approvedAt }))
  const sent = logged(ctx, pacificToUTC(b.sentOn, 11, 0), draftedBy, () => markSent(d, offer.id, { date: b.sentOn, force: true }))
  if (!sent.ok) throw new Error(`Seed: could not send ${offer.id}: ${sent.reason}`)
  const accepted = logged(ctx, pacificToUTC(h.accepted, 14, 20), draftedBy, () => markAccepted(d, offer.id, { date: h.accepted }))
  if (!accepted.ok) throw new Error(`Seed: could not accept ${offer.id}: ${accepted.reason}`)
  logged(ctx, pacificToUTC(opts.bgStart, 16, 45), 'p-jasmine', () => startBackgroundCheck(d, offer.id, { date: opts.bgStart }))

  const existing = person(ctx, h.personId)
  if (existing) {
    // The people seed already holds this person: link the records instead of hiring twice.
    const o = d.offers.find((x) => x.id === offer.id)
    if (o) o.personId = existing.id
    existing.fromCandidateId = b.app.candidateId
    existing.fromApplicationId = b.app.id
    b.app.status = 'hired'
    b.app.history.push({ stageId: 'hired', at: opts.hireOn, byId: 'p-jasmine' })
    b.app.stageId = 'hired'
    b.app.stageEnteredOn = opts.hireOn
    b.app.closedOn = opts.hireOn
    delete b.app.nextStep
    b.job.status = 'filled'
    b.job.closedOn = opts.hireOn
    return existing.id
  }
  const personId = logged(ctx, pacificToUTC(opts.hireOn, 10, 5), 'p-jasmine', () => hireFromOffer(d, offer.id, { date: opts.hireOn, actorId: 'p-jasmine' }))
  stabilizeNewIds(ctx, before, h.key)
  // The promised grant waits for the next board consent with Aisha's (docs/SAMPLE.md).
  for (const g of d.grants) if (g.fromOfferId === offer.id && g.status === 'promised') g.note = 'Promised in the accepted offer. Waiting for the next board consent.'
  if (opts.bgClearOn) {
    const clearOn = opts.bgClearOn
    logged(ctx, pacificToUTC(clearOn, 9, 40), 'p-jasmine', () => recordBackgroundResult(d, offer.id, 'clear', { date: clearOn }))
    const p = person(ctx, personId)
    if (p) p.backgroundCheck = { status: 'clear', completedOn: clearOn }
  }
  retain(ctx, b.app.candidateId, opts.hireOn)
  return personId
}

function markTask(ctx: Ctx, personId: ID, templateTaskId: string, doneOn: ISODate, hour: number): void {
  const ck = ctx.d.checklists.find((c) => c.personId === personId && c.kind === 'onboarding')
  const task = ck?.tasks.find((t) => t.templateTaskId === templateTaskId)
  if (!ck || !task) return
  logged(ctx, pacificToUTC(doneOn, hour, 15), 'p-jasmine', () => setTaskStatus(ctx.d, ck.id, task.id, 'done', { date: doneOn, byId: 'p-jasmine' }))
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export function buildHiring(d: Draft<DB>): void {
  const ctx: Ctx = {
    d,
    rng: makeRng(20261009),
    holidays: d.holidays.map((h) => h.date),
    usedNames: new Set(d.candidates.map((c) => `${c.firstName} ${c.lastName}`)),
    usedIds: new Set([...d.candidates.map((c) => c.id), ...d.applications.map((a) => a.id)]),
    ivSeq: new Map(),
    actSeq: { n: 0 },
    actStart: d.activity.length,
    profiles: new Map(),
    booked: new Map(),
    nameCounts: new Map(),
  }
  bookStoryInterviews(ctx)

  // Plan to 20
  for (const s of planSpecs()) {
    d.plan.push({
      id: s.id,
      quarter: s.quarter,
      title: s.title,
      departmentId: deptFor(ctx, s.dept),
      familyId: s.familyId,
      levelId: s.levelId,
      targetStart: s.targetStart,
      status: s.status,
      jobId: s.jobId,
      personId: s.personId ?? null,
      rationale: s.rationale,
      ...(s.budgetBase != null ? { budgetBase: s.budgetBase } : {}),
      ...(s.isBackfill ? { isBackfill: true, backfillForPersonId: s.backfillForPersonId ?? null } : {}),
    })
  }

  // Historical filled jobs (hires 2-15) and the searches for the two incoming hires.
  const builds: HireBuild[] = []
  for (const h of historicalHires()) {
    const b = addHistorical(ctx, h)
    setArchivedFunnel(ctx, h, b.job)
    builds.push(b)
  }

  // Open jobs and their pipelines.
  for (const spec of openJobSpecs()) addJob(ctx, spec, { status: spec.status })
  const pipelineApps = new Map<ID, Draft<Application>[]>()
  for (const p of openPipelines()) {
    const job = getJob(ctx, p.jobId)
    const list: Draft<Application>[] = []
    for (const s of p.active) list.push(addActive(ctx, job, s))
    for (const m of p.closed) addClosed(ctx, job, p, m)
    pipelineApps.set(p.jobId, list)
  }

  // Referral records: one per referred candidate (the app records them when the candidate is added).
  for (const c of d.candidates) {
    if (c.source !== 'referral' || !c.referrerId || d.referrals.some((r) => r.candidateId === c.id)) continue
    const app = d.applications.find((a) => a.candidateId === c.id)
    const job = app ? d.jobs.find((j) => j.id === app.jobId) : undefined
    d.referrals.push({ id: `ref-${c.id.replace(/^c-/, '')}`, candidateId: c.id, referrerId: c.referrerId, bonusAmount: job?.referralBonus ?? d.settings.referralBonusDefault })
  }
  const hannahRef = d.referrals.find((r) => r.candidateId === 'c-hire-hannah')
  if (hannahRef) {
    hannahRef.bonusAmount = 5_000
    hannahRef.payableOn = '2026-06-14'
    hannahRef.paidOn = '2026-06-14'
  }
  const aishaRef = d.referrals.find((r) => r.candidateId === 'c-hire-aisha')
  if (aishaRef) aishaRef.payableOn = addDays('2026-09-08', d.settings.referralBonusPayableDays || 90)

  // Lucas Ferreira: accepted Sep 30, hire recorded Oct 1, background check clear Oct 6.
  const lucas = builds.find((b) => b.spec.key === 'lucas')
  if (lucas) {
    const id = runHireFlow(ctx, lucas, { approvedAt: pacificToUTC(lucas.sentOn, 9, 40), bgStart: lucas.spec.accepted, hireOn: '2026-10-01', bgClearOn: '2026-10-06' })
    // The Hire flow put the promised grant in the board consent queue, so that task is done the same day.
    markTask(ctx, id, 'on-equity-board', '2026-10-01', 10)
    markTask(ctx, id, 'on-piia', '2026-10-02', 11)
    markTask(ctx, id, 'on-payroll-invite', '2026-10-05', 10)
    markTask(ctx, id, 'on-background-check', '2026-10-06', 9)
    d.documents.push({ id: 'doc-lucas-piia', personId: id, type: 'piia', name: 'Confidential information and invention assignment agreement', status: 'signed', date: '2026-10-02' })
  }
  // Mei Tanaka: accepted Oct 7, hire recorded Oct 8, background check in progress.
  const mei = builds.find((b) => b.spec.key === 'mei')
  if (mei) {
    const id = runHireFlow(ctx, mei, { approvedAt: pacificToUTC(mei.sentOn, 9, 25), bgStart: mei.spec.accepted, hireOn: '2026-10-08' })
    markTask(ctx, id, 'on-equity-board', '2026-10-08', 10)
    const o = d.offers.find((x) => x.id === 'o-hire-mei')
    if (o?.backgroundCheck) o.backgroundCheck.status = 'in_progress'
    const p = person(ctx, id)
    if (p && !p.notes) {
      p.notes =
        'H-1B transfer: Mei is already in the U.S. in valid H-1B status, so the September 2025 $100,000 payment does not apply. She can start on Nov 2 once the transfer petition is filed (H-1B portability).'
    }
  }

  // Daniel Reyes: offer drafted by Priya on Oct 8, waiting for Maya's approval (not sent, so no grant).
  const daniel = d.applications.find((a) => a.candidateId === 'c-daniel-reyes' && a.jobId === 'j-staff-ml')
  const staffMl = d.jobs.find((j) => j.id === 'j-staff-ml')
  if (daniel && staffMl) {
    const at = '2026-10-08T22:15:00.000Z'
    logged(ctx, at, 'p-priya', () =>
      createOffer(d, {
        id: 'o-daniel-reyes',
        applicationId: daniel.id,
        candidateId: daniel.candidateId,
        jobId: staffMl.id,
        version: 1,
        title: staffMl.title,
        levelId: staffMl.levelId,
        familyId: staffMl.familyId,
        departmentId: staffMl.departmentId,
        managerId: 'p-priya',
        locationId: staffMl.locationIds[0] ?? locFor(ctx, 'hq'),
        workMode: 'hybrid',
        employmentType: 'full_time',
        hoursPerWeek: 40,
        flsa: 'exempt',
        exemptionBasis: 'computer_professional',
        payType: 'salary',
        salary: 262_000,
        equityType: 'ISO',
        equityShares: 50_000,
        vestingMonths: 48,
        cliffMonths: 12,
        startDate: '2026-11-16',
        expiresOn: bd(ctx, '2026-10-08', 5),
        contingencies: ['background_check', 'i9', 'piia'],
        status: 'draft',
        createdOn: '2026-10-08',
        draftedById: 'p-priya',
        draftedByRole: 'manager',
        approvals: [],
      }),
    )
    logged(ctx, '2026-10-08T22:21:00.000Z', 'p-priya', () => submitForApproval(d, 'o-daniel-reyes', { date: '2026-10-08' }))
  }

  addStoryActivity(ctx, pipelineApps)

  // Keep this builder's activity rows in time order (rows written by earlier seed steps stay put).
  const mine = d.activity.slice(ctx.actStart).map((a) => plain(a))
  mine.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  d.activity.splice(ctx.actStart)
  d.activity.push(...mine)
}

/** A handful of plain-language rows for this week's notable moves (the domain flows log the rest). */
function addStoryActivity(ctx: Ctx, pipelineApps: Map<ID, Draft<Application>[]>): void {
  const d = ctx.d
  const appFor = (candidateId: ID, jobId: ID) => d.applications.find((a) => a.candidateId === candidateId && a.jobId === jobId)
  const nameOf = (candidateId: ID) => {
    const c = d.candidates.find((x) => x.id === candidateId)
    return c ? fullName(c) : 'Candidate'
  }
  const move = (candidateId: ID, jobId: ID, stage: string, at: ISODateTime, actorId: ID) => {
    const app = appFor(candidateId, jobId)
    if (!app) return
    addActivity(ctx, { at, actorId, entityType: 'application', entityId: app.id, relatedId: candidateId, kind: 'stage_moved', text: `Moved ${nameOf(candidateId)} to ${stage}` })
  }
  move('c-grace-okafor', 'j-fullstack', 'Intro call', '2026-10-05T17:10:00.000Z', 'p-tomas')
  move('c-isabel-moreno', 'j-fullstack', 'Onsite', '2026-10-06T16:40:00.000Z', 'p-tomas')
  move('c-ananya-krishnan', 'j-staff-ml', 'Onsite', '2026-10-07T16:30:00.000Z', 'p-priya')
  move('c-ritika-sharma', 'j-staff-ml', 'Intro call', '2026-10-07T17:05:00.000Z', 'p-priya')
  move('c-jonah-feldman', 'j-staff-ml', 'Onsite', '2026-10-08T15:20:00.000Z', 'p-priya')
  move('c-daniel-reyes', 'j-staff-ml', 'Offer', '2026-10-08T16:05:00.000Z', 'p-priya')

  // Interviews scheduled for next week.
  for (const iv of d.interviews) {
    if (iv.status !== 'scheduled' || !iv.icsIssuedOn) continue
    const app = d.applications.find((a) => a.id === iv.applicationId)
    if (!app) continue
    const cand = d.candidates.find((c) => c.id === app.candidateId)
    addActivity(ctx, {
      at: pacificToUTC(iv.icsIssuedOn, 14, 30),
      actorId: 'p-jasmine',
      entityType: 'application',
      entityId: app.id,
      relatedId: app.candidateId,
      kind: 'interview_scheduled',
      text: `Scheduled ${lowerFirst(iv.name)} with ${nameOf(app.candidateId)} for ${formatDual(iv.startsAt, cand?.timezone)}`,
    })
  }

  // Scorecards submitted this week.
  for (const sc of d.scorecards) {
    if (!sc.submittedAt || sc.submittedAt < '2026-10-05T07:00:00.000Z') continue
    const app = d.applications.find((a) => a.id === sc.applicationId)
    if (!app || app.status !== 'active') continue
    addActivity(ctx, {
      at: sc.submittedAt,
      actorId: sc.interviewerId,
      entityType: 'application',
      entityId: app.id,
      relatedId: app.candidateId,
      kind: 'scorecard_submitted',
      text: `${personName(ctx, sc.interviewerId)} submitted a scorecard for ${nameOf(app.candidateId)}`,
    })
  }

  // Rejections and close-outs sent this week on the open jobs (the latest few).
  const closedThisWeek = d.applications
    .filter((a) => pipelineApps.has(a.jobId) && (a.status === 'rejected' || a.status === 'withdrawn') && (a.closedOn ?? '') >= '2026-10-05')
    .sort((a, b) => (b.closedOn ?? '').localeCompare(a.closedOn ?? '') || a.id.localeCompare(b.id))
    .slice(0, 5)
  for (const a of closedThisWeek) {
    const job = d.jobs.find((j) => j.id === a.jobId)
    const reason = outcomeReasonLabel(a.outcomeReason).toLowerCase()
    const text =
      a.status === 'rejected'
        ? `Rejected ${nameOf(a.candidateId)} (${reason}) and sent a note`
        : `${nameOf(a.candidateId)} withdrew${a.outcomeReason === 'withdrew' ? '' : ` (${reason})`}`
    addActivity(ctx, {
      at: pacificToUTC(a.closedOn ?? hiringAnchor(), 16, 10),
      actorId: job?.hiringManagerId ?? 'p-jasmine',
      entityType: 'application',
      entityId: a.id,
      relatedId: a.candidateId,
      kind: a.status,
      text,
    })
  }
}
