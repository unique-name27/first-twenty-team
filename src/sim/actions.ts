// The simulator's actions (docs/DEV.md, "Generated companies"): each wraps exactly the domain function a
// screen calls when someone does that thing in the app, with the arguments that screen passes. An action's
// args are what the person picks on the screen (zod checks them); its run does what the screen's save does
// with them. The screens themselves are named next to each action.
//
// applyAction applies one action the way the store's mutate does (Immer produce on the DB), inside the run
// that generateCompany or advance holds open (src/lib/runContext.ts): the pretend date is the action's day,
// and the run acts as the action's person, in their Viewing-as mode, at its time of day. A refusal (a domain
// function that returns false, null or { ok: false }) throws and leaves the DB as it was: a simulated company
// never carries a step the app would have refused. Every applied action adds one line to the trace.
//
// Test and tooling code only: the app never imports src/sim (src/sim/guard.test.ts).
import { type Draft, enablePatches, original, type Patch, produceWithPatches } from 'immer'
import { z } from 'zod'
import { DEFAULT_ROLE_TEMPLATES } from '@/data/starterRoleTemplates'
import { setTaskStatus } from '@/domain/checklists/actions'
import { applyDueHandoffs, leaverRoles, recordHandoffs } from '@/domain/handoff'
import {
  addCandidate,
  approveOffer,
  archiveCandidate,
  closeOutMessage,
  closeOutRemaining,
  createJob,
  createOffer,
  effectiveBand,
  expireOffers,
  jobFromTemplate,
  markAccepted,
  markDeclined,
  markNotified,
  markPosted,
  markSent,
  moveApplication,
  offerDefaults,
  rejectApplication,
  roleTemplates,
  scheduleInterview,
  setJobStatus,
  submitForApproval,
  submitScorecard,
  withdrawApplication,
} from '@/domain/hiring'
import {
  applyScheduledChanges,
  changeJobOrPay,
  hireFromOffer,
  markDesignationSent,
  offboardPerson,
  openJobFromPlan,
  reassignReportsAtExit,
  startLeave,
} from '@/domain/lifecycle'
import { applyInboxOp, type InboxOp } from '@/domain/inbox'
import { markPayRunSubmitted } from '@/domain/payrun/records'
import { founder } from '@/domain/people'
import { approveAsUnpaid, approveRequest, createRequest, policiesFor, serviceWait, workdays } from '@/domain/timeoff'
import type { Band, DB, Department, Handoff, ID, Job, Level, Location, Offer, Role } from '@/domain/types'
import { guessTimezone } from '@/features/hiring/logic'
import { prepareBackfillSlot } from '@/features/people/helpers'
import { markReturned } from '@/features/timeoff/logic'
import { addDays, type ISODate, nowISO, quarterOf, setClockOverride } from '@/lib/dates'
import { newId } from '@/lib/id'
import { activeRun, updateRun } from '@/lib/runContext'
import { logActivity } from '@/store/draft'
import { RECORD_COLLECTIONS } from '@/sync/collections'

// The trace's created ids come from Immer's patches (exact, and cheap however big the DB grows).
enablePatches()

/** When and as whom an action happens. */
export type ActionContext = {
  /** The pretend date (setClockOverride). */
  day: ISODate
  /** The time of day in California, 'HH:MM' (24-hour): nowISO inside the action. */
  time: string
  /** The person doing it (activity rows, approvals, who marked a task done). null records no one. */
  actorId: ID | null
  /** Their Viewing-as mode: an offer drafted as anything but admin needs Admin's approval. */
  viewingAs: Role
}

/** One applied action, as one line of the trace (JSON lines). */
export type TraceLine = {
  day: ISODate
  time: string
  actor: ID | null
  viewingAs: Role
  action: ActionName
  args: unknown
  /** Ids of the records the action added, in the order it added them. Activity rows are left out (nearly every action writes one). */
  created: ID[]
}

/** What applyAction works on: the DB so far and the trace of every action applied to it. */
export type SimState = { db: DB; trace: TraceLine[] }

type ActionSpec<N extends string, S extends z.ZodType, R> = {
  name: N
  args: S
  run: (draft: Draft<DB>, args: z.output<S>, ctx: ActionContext) => R
  /** True when changing nothing is fine (opening the app on a day nothing is due); otherwise it is a refusal. */
  quiet?: boolean
}

function action<const N extends string, S extends z.ZodType, R>(spec: ActionSpec<N, S, R>): ActionSpec<N, S, R> {
  return spec
}

// ---- Refusals ---------------------------------------------------------------------------------

/**
 * The app said no: a rule refused the step, or it changed nothing. The DB stays as it was. `reason` is the
 * app's own words. Anything else applyAction throws (args that do not fit, a TypeError inside a domain
 * function) is a bug in the simulator or the app.
 */
export class ActionRefused extends Error {
  constructor(
    message: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ActionRefused'
  }
}

/** A domain function's { ok: false, reason } as a thrown refusal. */
function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error((result as { reason?: string }).reason ?? 'Refused.')
  return result as Extract<T, { ok: true }>
}

/** A domain function's false, null or undefined as a thrown refusal. */
function must<T>(value: T, refusal: string): Exclude<T, false | null | undefined> {
  if (value === false || value === null || value === undefined) throw new Error(refusal)
  return value as Exclude<T, false | null | undefined>
}

/**
 * The DB as it was when the action started, for reads a screen makes from the store before it saves
 * (jobFromTemplate, offerDefaults). Read before the action changes anything, it is the same data.
 */
function before(draft: Draft<DB>): DB {
  return (original(draft) ?? draft) as DB
}

// ---- Arguments ----------------------------------------------------------------------------------

const id = z.string().min(1)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const money = z.number().nonnegative()
const flsa = z.enum(['exempt', 'non_exempt'])
const workMode = z.enum(['onsite', 'hybrid', 'remote'])
const employmentType = z.enum(['full_time', 'part_time', 'intern'])
const exemptionBasis = z.enum(['executive', 'administrative', 'professional', 'computer_professional', 'outside_sales'])
const outcomeReason = z.enum(['not_a_fit_level', 'skills_gap', 'chose_other_offer', 'comp', 'location', 'timing', 'no_response', 'withdrew', 'position_filled', 'other'])
const rating = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])

// ---- The actions ----------------------------------------------------------------------------------

/** Settings > Org, Add or Edit a department (OrgTab.tsx). */
const saveDepartment = action({
  name: 'saveDepartment',
  args: z.strictObject({ id, name: z.string().min(1), headId: id.nullable().optional() }),
  run(d, a) {
    const name = a.name.trim()
    if (d.departments.some((x) => x.id !== a.id && x.name.toLowerCase() === name.toLowerCase())) throw new Error('A department with that name already exists.')
    const row: Department = { id: a.id, name, headId: a.headId || null }
    const i = d.departments.findIndex((x) => x.id === a.id)
    if (i >= 0) d.departments[i] = row
    else d.departments.push(row)
    return a.id
  },
})

/** Settings > Org, Add or Edit a location (OrgTab.tsx). */
const saveLocation = action({
  name: 'saveLocation',
  args: z.strictObject({
    id,
    name: z.string().min(1),
    kind: z.enum(['hq', 'remote']),
    city: z.string().optional(),
    state: z.string().regex(/^[A-Za-z]{2}$/),
    minWageHourly: z.number().positive(),
    minWageNote: z.string().optional(),
    publicAccess: z.boolean().optional(),
    typicalMaxOnSite: z.number().nonnegative().optional(),
  }),
  run(d, a) {
    const row: Location = { id: a.id, name: a.name.trim(), kind: a.kind, state: a.state.trim().toUpperCase(), minWageHourly: a.minWageHourly }
    if (a.city?.trim()) row.city = a.city.trim()
    if (a.minWageNote?.trim()) row.minWageNote = a.minWageNote.trim()
    if (a.kind === 'hq') {
      row.publicAccess = !!a.publicAccess
      if (a.typicalMaxOnSite != null) row.typicalMaxOnSite = Math.max(0, Math.round(a.typicalMaxOnSite))
    }
    const i = d.locations.findIndex((x) => x.id === a.id)
    if (i >= 0) d.locations[i] = row
    else d.locations.push(row)
    return a.id
  },
})

/** Settings > Org, Add or Edit a level (OrgTab.tsx). */
const saveLevel = action({
  name: 'saveLevel',
  args: z.strictObject({ id, code: z.string().min(1), name: z.string().min(1), track: z.enum(['ic', 'manager', 'executive']), order: z.number().int().min(1).max(9), description: z.string().optional() }),
  run(d, a) {
    if (d.levels.some((x) => x.id !== a.id && x.code.toLowerCase() === a.code.trim().toLowerCase())) throw new Error('Another level already uses that code.')
    const row: Level = { id: a.id, code: a.code.trim(), name: a.name.trim(), track: a.track, order: a.order }
    if (a.description?.trim()) row.description = a.description.trim()
    const i = d.levels.findIndex((x) => x.id === a.id)
    if (i >= 0) d.levels[i] = row
    else d.levels.push(row)
    return a.id
  },
})

/** Comp and plan > Bands, Save band (BandsTab.tsx). Percentages are fractions here (0.002 = 0.2%). */
const saveBand = action({
  name: 'saveBand',
  args: z.strictObject({
    familyId: id,
    levelId: id,
    min: money,
    mid: money,
    max: money,
    equityMinPct: z.number().nonnegative(),
    equityMaxPct: z.number().nonnegative(),
    variablePct: z.number().positive().optional(),
    flsaDefault: flsa,
  }),
  run(d, a) {
    const family = must(d.families.find((f) => f.id === a.familyId), `No job family ${a.familyId}.`)
    const level = must(d.levels.find((l) => l.id === a.levelId), `No level ${a.levelId}.`)
    if (!(a.min <= a.mid && a.mid <= a.max)) throw new Error('The minimum, midpoint and maximum must go up in that order.')
    const band = d.bands.find((b) => b.familyId === a.familyId && b.levelId === a.levelId)
    const next: Band = {
      id: band?.id ?? `b-${family.id.replace(/^f-/, '')}-${level.id.replace(/^lv-/, '')}`,
      familyId: family.id,
      levelId: level.id,
      min: a.min,
      mid: a.mid,
      max: a.max,
      equityMinPct: a.equityMinPct,
      equityMaxPct: a.equityMaxPct,
      flsaDefault: a.flsaDefault,
    }
    if (a.variablePct) next.variablePct = a.variablePct
    const label = `${band ? 'Changed' : 'Added'} the ${family.name} ${level.code} band`
    const changed: string[] = []
    if (band) {
      if (band.min !== next.min || band.mid !== next.mid || band.max !== next.max) changed.push('pay range')
      if (band.equityMinPct !== next.equityMinPct || band.equityMaxPct !== next.equityMaxPct) changed.push('equity guideline')
      if ((band.variablePct ?? 0) !== (next.variablePct ?? 0)) changed.push('variable target')
      if ((band.flsaDefault ?? 'exempt') !== a.flsaDefault) changed.push('FLSA default')
      if (!changed.length) throw new Error('The band already reads that way.')
    }
    const i = d.bands.findIndex((b) => b.id === next.id || (b.familyId === next.familyId && b.levelId === next.levelId))
    if (i >= 0) d.bands[i] = next
    else d.bands.push(next)
    logActivity(d, { entityType: 'settings', entityId: next.id, kind: 'band_changed', text: changed.length ? `${label} (${changed.join(', ')})` : label })
    return next.id
  },
})

/** Comp and plan, Change job or pay (ChangeJobSheet.tsx). */
const changeJob = action({
  name: 'changeJobOrPay',
  args: z.strictObject({
    personId: id,
    change: z.strictObject({
      effectiveOn: date,
      reason: z.enum(['promotion', 'merit', 'market', 'title_only', 'manager_change', 'transfer', 'correction']),
      title: z.string().optional(),
      levelId: id.optional(),
      managerId: id.nullable().optional(),
      departmentId: id.optional(),
      salary: money.optional(),
      hourlyRate: money.optional(),
      variablePct: z.number().optional(),
      flsa: flsa.optional(),
      exemptionBasis: exemptionBasis.optional(),
      exceptionReason: z.string().optional(),
      approvedById: id.optional(),
      note: z.string().optional(),
    }),
  }),
  run(d, a, ctx) {
    return changeJobOrPay(d, a.personId, a.change, { date: ctx.day, actorId: ctx.actorId })
  },
})

/** Comp and plan > Plan, Add a line (PlanTab.tsx): a role the company means to hire, and when. */
const planLine = action({
  name: 'addPlanLine',
  args: z.strictObject({
    title: z.string().min(1),
    departmentId: id,
    familyId: id,
    levelId: id,
    targetStart: date,
    budgetBase: money.optional(),
    rationale: z.string().optional(),
  }),
  run(d, a) {
    const title = a.title.trim()
    const label = `Added ${title} to the headcount plan`
    const planId = newId('ps')
    d.plan.push({
      id: planId,
      status: 'planned',
      jobId: null,
      personId: null,
      title,
      departmentId: a.departmentId,
      familyId: a.familyId,
      levelId: a.levelId,
      targetStart: a.targetStart,
      quarter: quarterOf(a.targetStart),
      ...(a.budgetBase != null ? { budgetBase: a.budgetBase } : {}),
      isBackfill: false,
      backfillForPersonId: null,
      ...(a.rationale?.trim() ? { rationale: a.rationale.trim() } : {}),
    })
    logActivity(d, { entityType: 'plan', entityId: planId, kind: 'plan_added', text: label })
    return planId
  },
})

/**
 * Hiring, New job (NewJobSheet.tsx): the role template prefills the job (jobFromTemplate), the person
 * changes what the sheet lets them change, and Create saves a draft with the hiring manager on the panel
 * and running each interview step until interviewers are picked in Edit. The sheet has no FLSA field: the
 * job takes its band's FLSA default (Comp and plan > Bands), as jobFromTemplate sets it.
 */
const newJob = action({
  name: 'createJob',
  args: z.strictObject({
    templateId: id.optional(),
    hiringManagerId: id,
    title: z.string().min(1).optional(),
    familyId: id.optional(),
    levelId: id.optional(),
    departmentId: id.optional(),
    workMode: workMode.optional(),
    locationIds: z.array(id).min(1).optional(),
    employmentType: employmentType.optional(),
    /** The posted range; under $1,000 it is an hourly range. */
    payMin: money.nullable().optional(),
    payMax: money.nullable().optional(),
    backgroundCheck: z.boolean().optional(),
    planSlotId: id.optional(),
  }),
  run(d, a, ctx) {
    const db = before(d)
    const templates = roleTemplates(db).length ? roleTemplates(db) : DEFAULT_ROLE_TEMPLATES
    const template = a.templateId ? must(templates.find((t) => t.id === a.templateId), `No role template ${a.templateId}.`) : undefined
    const slot = a.planSlotId ? must(db.plan.find((s) => s.id === a.planSlotId), `No plan line ${a.planSlotId}.`) : undefined
    let job: Job = jobFromTemplate(db, template, {
      date: ctx.day,
      hiringManagerId: a.hiringManagerId,
      ...(slot
        ? {
            title: slot.title,
            familyId: slot.familyId,
            levelId: slot.levelId,
            departmentId: slot.departmentId,
            planSlotId: slot.id,
            targetStart: slot.targetStart,
            ...(slot.isBackfill ? { isBackfill: true, backfillForPersonId: slot.backfillForPersonId ?? null } : {}),
          }
        : {}),
    })
    // The sheet's family and level pickers move the posted range to the band (and the team to the family's).
    if ((a.familyId && a.familyId !== job.familyId) || (a.levelId && a.levelId !== job.levelId)) {
      const familyId = a.familyId ?? job.familyId
      const levelId = a.levelId ?? job.levelId
      const band = effectiveBand(db, familyId, levelId)
      job = { ...job, familyId, levelId, payMin: band?.min ?? job.payMin, payMax: band?.max ?? job.payMax, ...(band ? { equityMinPct: band.equityMinPct, equityMaxPct: band.equityMaxPct } : {}) }
    }
    if (a.title) job.title = a.title.trim()
    if (a.departmentId) job.departmentId = a.departmentId
    if (a.workMode) job.workMode = a.workMode
    if (a.locationIds) job.locationIds = [...a.locationIds]
    if (a.employmentType) job.employmentType = a.employmentType
    if (a.payMin !== undefined) job.payMin = a.payMin
    if (a.payMax !== undefined) job.payMax = a.payMax
    if (a.backgroundCheck !== undefined) job.backgroundCheck = a.backgroundCheck
    if (!job.title.trim()) throw new Error('Add a title.')
    if (!d.people.some((p) => p.id === job.hiringManagerId)) throw new Error('Pick a hiring manager.')
    if (job.payMin != null && job.payMax != null && job.payMin > job.payMax) throw new Error('The pay range minimum is above the maximum.')
    const final: Job = {
      ...job,
      panelIds: job.panelIds.includes(job.hiringManagerId) ? job.panelIds : [job.hiringManagerId, ...job.panelIds],
      interviewPlan: job.interviewPlan.map((s) => (s.interviewerIds.length ? s : { ...s, interviewerIds: [job.hiringManagerId] })),
    }
    createJob(d, final)
    if (slot) {
      const s = d.plan.find((x) => x.id === slot.id)
      if (s) {
        s.jobId = final.id
        if (s.status === 'planned') s.status = 'open'
      }
    }
    return final.id
  },
})

/** A job's page or the posting sheet, Mark posted (JobPage.tsx, PostingSheet.tsx). */
const postJob = action({
  name: 'markPosted',
  args: z.strictObject({ jobId: id }),
  run(d, a, ctx) {
    ok(markPosted(d, a.jobId, { date: ctx.day }))
  },
})

/**
 * A job's status menu (JobPage.tsx): Pause (on hold), Mark filled, Close without hiring or Reopen as draft.
 * Resume posting is Mark posted (markPosted).
 */
const jobStatus = action({
  name: 'setJobStatus',
  args: z.strictObject({ jobId: id, status: z.enum(['draft', 'on_hold', 'filled', 'closed']) }),
  run(d, a, ctx) {
    must(setJobStatus(d, a.jobId, a.status, { date: ctx.day }), `The job ${a.jobId} is missing or already ${a.status.replace('_', ' ')}.`)
  },
})

/** Hiring, Quick add (QuickAddSheet.tsx): the time zone is guessed from the location, as the sheet does. */
const quickAdd = action({
  name: 'addCandidate',
  args: z.strictObject({
    candidate: z.strictObject({
      firstName: z.string().min(1),
      lastName: z.string(),
      email: z.email(),
      phone: z.string().optional(),
      linkedin: z.string().optional(),
      github: z.string().optional(),
      location: z.string().optional(),
      currentTitle: z.string().optional(),
      currentCompany: z.string().optional(),
      source: z.enum(['inbound', 'referral', 'outbound', 'agency']),
      /** The agency's name: the sheet asks for it, and keeps it, only when the source is an agency. */
      sourceDetail: z.string().optional(),
      referrerId: id.optional(),
      desiredPay: money.optional(),
      desiredPayUnit: z.enum(['year', 'hour']).optional(),
      sponsorship: z.enum(['yes', 'no', 'unknown']).optional(),
    }).refine((c) => c.source === 'agency' || c.sourceDetail === undefined, { path: ['sourceDetail'], message: 'Quick add keeps a source detail (the agency) for an agency only.' }),
    jobId: id.optional(),
  }),
  run(d, a, ctx) {
    const job = a.jobId ? must(d.jobs.find((j) => j.id === a.jobId), `No job ${a.jobId}.`) : undefined
    if (a.candidate.source === 'referral' && !a.candidate.referrerId) throw new Error('Pick who referred them.')
    const { sourceDetail, ...candidate } = a.candidate
    const agency = sourceDetail?.trim()
    const timezone = guessTimezone(candidate.location)
    return addCandidate(d, { ...candidate, ...(agency ? { sourceDetail: agency } : {}), ...(timezone ? { timezone } : {}) }, { date: ctx.day, ...(job ? { jobId: job.id, ownerId: job.hiringManagerId } : {}) })
  },
})

/** The pipeline's Move to and stage stepper (src/features/hiring/actions.ts moveTo). */
const moveTo = action({
  name: 'moveApplication',
  args: z.strictObject({ applicationId: id, toStageId: z.string().min(1) }),
  run(d, a, ctx) {
    must(moveApplication(d, a.applicationId, a.toStageId, { date: ctx.day, actorId: ctx.actorId }), `Could not move ${a.applicationId} to ${a.toStageId}.`)
  },
})

/** The schedule sheet, Schedule (ScheduleSheet.tsx): its args are the sheet's ScheduleInput. */
const schedule = action({
  name: 'scheduleInterview',
  args: z.strictObject({
    applicationId: id,
    stepId: id.optional(),
    stageId: z.string().min(1),
    name: z.string().min(1),
    startsAt: z.iso.datetime(),
    durationMin: z.number().int().positive(),
    interviewerIds: z.array(id).min(1),
    format: z.enum(['video', 'onsite', 'phone']),
    videoLink: z.string().optional(),
    attributes: z.array(z.string()),
  }),
  run(d, a, ctx) {
    return scheduleInterview(d, a, { date: ctx.day })
  },
})

/** The scorecard sheet, Submit (an interviewer's own, or an admin entering it for them with enteredById). */
const scorecard = action({
  name: 'submitScorecard',
  args: z.strictObject({ scorecardId: id, ratings: z.record(z.string(), rating), overall: rating.optional(), notes: z.string().optional(), enteredById: id.optional() }),
  run(d, a) {
    const { scorecardId, ...input } = a
    must(submitScorecard(d, scorecardId, input, nowISO()), `Could not submit scorecard ${scorecardId}.`)
  },
})

/**
 * The reject flow (RejectFlow.tsx): a reason chip closes the application, then Copy note or Mark told
 * records that the candidate was told (markNotified), when `notified`. withdraw for a candidate who pulled out.
 */
const reject = action({
  name: 'rejectApplication',
  args: z.strictObject({ applicationId: id, reason: outcomeReason, note: z.string().optional(), notified: z.boolean().optional(), withdraw: z.boolean().optional() }),
  run(d, a, ctx) {
    const opts = { date: ctx.day, nowISO: nowISO(), ...(a.note?.trim() ? { note: a.note.trim() } : {}) }
    const closed = a.withdraw ? withdrawApplication(d, a.applicationId, a.reason, opts) : rejectApplication(d, a.applicationId, a.reason, opts)
    must(closed, `Could not close ${a.applicationId}.`)
    if (a.notified) markNotified(d, a.applicationId, { date: ctx.day })
  },
})

/** A filled job's Close out the rest (CloseOutSheet.tsx): closes, marks told, and archives who has nothing else open. */
const closeOut = action({
  name: 'closeOutRemaining',
  args: z.strictObject({ jobId: id, notified: z.boolean() }),
  run(d, a, ctx) {
    const msg = must(closeOutMessage(before(d), a.jobId), `No job ${a.jobId}.`)
    const closed = closeOutRemaining(d, a.jobId, { date: ctx.day, notified: a.notified })
    let told = 0
    if (a.notified) for (const appId of msg.applicationIds) if (markNotified(d, appId, { date: ctx.day })) told += 1
    for (const appId of msg.applicationIds) {
      const app = d.applications.find((x) => x.id === appId)
      if (!app) continue
      if (!d.applications.some((x) => x.candidateId === app.candidateId && x.status === 'active')) archiveCandidate(d, app.candidateId, { date: ctx.day })
    }
    must(closed + told > 0, 'Nobody is left to close out.')
    return closed
  },
})

/**
 * The offer builder, Save offer (OfferBuilder.tsx): the defaults for the application (offerDefaults) with the
 * person's edits, drafted by them in their Viewing-as mode.
 */
const draftOffer = action({
  name: 'createOffer',
  args: z.strictObject({
    applicationId: id,
    edits: z
      .strictObject({
        payType: z.enum(['salary', 'hourly']).optional(),
        salary: money.optional(),
        hourlyRate: money.optional(),
        hoursPerWeek: z.number().positive().optional(),
        equityShares: z.number().int().nonnegative().optional(),
        startDate: date.optional(),
        expiresOn: date.optional(),
        signOnBonus: money.optional(),
        exceptionReason: z.string().optional(),
      })
      .optional(),
  }),
  run(d, a, ctx) {
    const defaults = offerDefaults(before(d), a.applicationId, ctx.day)
    if (!defaults.applicationId) throw new Error(`No application ${a.applicationId}.`)
    const full: Omit<Offer, 'id'> = {
      ...(defaults as Omit<Offer, 'id'>),
      ...a.edits,
      ...(ctx.actorId ? { draftedById: ctx.actorId } : {}),
      draftedByRole: ctx.viewingAs,
      status: 'draft',
      createdOn: ctx.day,
      approvals: [],
    }
    return ok(createOffer(d, full)).id
  },
})

/** The offer card, Submit for approval. */
const submitOffer = action({
  name: 'submitForApproval',
  args: z.strictObject({ offerId: id }),
  run(d, a, ctx) {
    ok(submitForApproval(d, a.offerId, { date: ctx.day }))
  },
})

/** The offer card or Offers tab, Approve: approved by the person acting, now. */
const approve = action({
  name: 'approveOffer',
  args: z.strictObject({ offerId: id }),
  run(d, a, ctx) {
    const approverId = must(ctx.actorId, 'Pick who you are under Viewing as first.')
    ok(approveOffer(d, a.offerId, { approverId, at: nowISO() }))
  },
})

/** The offer card, Mark sent. */
const send = action({
  name: 'markSent',
  args: z.strictObject({ offerId: id }),
  run(d, a, ctx) {
    ok(markSent(d, a.offerId, { date: ctx.day }))
  },
})

/** The offer card, Accepted. */
const accept = action({
  name: 'markAccepted',
  args: z.strictObject({ offerId: id }),
  run(d, a, ctx) {
    ok(markAccepted(d, a.offerId, { date: ctx.day }))
  },
})

/** The hire flow, Hire (HireFlow.tsx): the person, starting pay, grant, onboarding and documents. */
const hire = action({
  name: 'hireFromOffer',
  args: z.strictObject({ offerId: id }),
  run(d, a, ctx) {
    return hireFromOffer(d, a.offerId, { date: ctx.day, actorId: ctx.actorId })
  },
})

/** A checklist task's Done (or Not applicable) button (src/features/people/parts.tsx). */
const task = action({
  name: 'setTaskStatus',
  args: z.strictObject({ checklistId: id, taskId: id, status: z.enum(['done', 'not_applicable']) }),
  run(d, a, ctx) {
    must(setTaskStatus(d, a.checklistId, a.taskId, a.status, { date: ctx.day, byId: ctx.actorId }), `No task ${a.taskId} on ${a.checklistId}.`)
  },
})

/** Time off, a leave case's Mark the notice sent (every path that marks it calls markDesignationSent). */
const designation = action({
  name: 'markDesignationSent',
  args: z.strictObject({ leaveId: id }),
  run(d, a, ctx) {
    must(markDesignationSent(d, a.leaveId, { date: ctx.day, byId: ctx.actorId }), `Could not mark the notice sent for ${a.leaveId}.`)
  },
})

/** Comp and plan > Pay runs, Mark submitted. */
const payRun = action({
  name: 'markPayRunSubmitted',
  args: z.strictObject({ start: date, end: date, payday: date }),
  run(d, a, ctx) {
    return ok(markPayRunSubmitted(d, a, { date: ctx.day, actorId: ctx.actorId }))
  },
})

/** Time off, Start a leave case (StartLeaveSheet.tsx), opened by Admin. */
const leave = action({
  name: 'startLeave',
  args: z.strictObject({
    personId: id,
    kind: z.enum(['cfra', 'pdl', 'bonding', 'military', 'other']),
    requestedOn: date,
    startDate: date,
    expectedReturn: date,
    note: z.string().optional(),
  }),
  run(d, a, ctx) {
    if (a.expectedReturn < a.startDate) throw new Error('The expected return is before the leave starts.')
    return startLeave(d, a, { date: ctx.day, actorId: ctx.actorId })
  },
})

/**
 * A person's Offboard wizard, Confirm (OffboardSheet.tsx): the separation, then the leaver's reports and the
 * roles they hold (leaverRoles: live jobs, next steps, interviews after the last day, contractors, teams) to
 * their manager (else the founder), as the wizard defaults. The hand-offs land on the last day.
 */
const offboard = action({
  name: 'offboardPerson',
  args: z.strictObject({
    personId: id,
    type: z.enum(['resigned_notice', 'resigned_no_notice', 'terminated', 'laid_off', 'contract_ended']),
    reason: z.string().min(1),
    lastDay: date,
    noticeGivenOn: date.optional(),
    rehireEligible: z.boolean(),
  }),
  run(d, a, ctx) {
    const { personId, ...sep } = a
    const db = before(d)
    const person = must(d.people.find((p) => p.id === personId), `No person ${personId}.`)
    const defaultManager = person.managerId && person.managerId !== personId ? person.managerId : (founder(db)?.id ?? '')
    // What the wizard lists before Confirm: roles that run past the last day (or past today, once it has come).
    const roles = leaverRoles(db, personId, a.lastDay <= ctx.day ? addDays(ctx.day, -1) : a.lastDay)
    const result = offboardPerson(d, personId, sep, { date: ctx.day, actorId: ctx.actorId })
    reassignReportsAtExit(d, personId, a.lastDay, () => defaultManager, { date: ctx.day, actorId: ctx.actorId, approvedById: ctx.actorId, checklistId: result.checklistId })
    const handoffs: Handoff[] = roles.map((r) => ({ kind: r.kind, id: r.id, toId: defaultManager })).filter((h) => !!h.toId && h.toId !== personId)
    if (handoffs.length) recordHandoffs(d, personId, handoffs, { date: ctx.day, actorId: ctx.actorId, checklistId: result.checklistId })
    return result.checklistId
  },
})

/**
 * Comp and plan > Plan, Open job (PlanTab.tsx), or a planned row on Hiring (HiringPage.tsx): a draft job from
 * the plan line, its interviewers left for Edit details.
 */
const jobFromPlan = action({
  name: 'openJobFromPlan',
  args: z.strictObject({ planSlotId: id, hiringManagerId: id }),
  run(d, a, ctx) {
    must(d.plan.find((s) => s.id === a.planSlotId), `No plan line ${a.planSlotId}.`)
    return openJobFromPlan(d, a.planSlotId, { date: ctx.day, hiringManagerId: a.hiringManagerId, actorId: ctx.actorId })
  },
})

/**
 * The Offboard wizard's Backfill? button (OffboardSheet.tsx): the plan line readied for the leaver's role
 * (prepareBackfillSlot), then a draft job from it, with their manager (else the founder) hiring.
 */
const backfill = action({
  name: 'openBackfill',
  args: z.strictObject({ personId: id }),
  run(d, a, ctx) {
    const db = before(d)
    const person = must(db.people.find((p) => p.id === a.personId), `No person ${a.personId}.`)
    const lastDay = must(person.separation?.lastDay, `${a.personId} has no last day yet.`)
    const hm = person.managerId && person.managerId !== person.id ? person.managerId : (founder(db)?.id ?? person.id)
    const slotId = prepareBackfillSlot(d as DB, person.id, lastDay, ctx.day)
    return openJobFromPlan(d, slotId, { date: ctx.day, hiringManagerId: hm, actorId: ctx.actorId })
  },
})

/**
 * A job's Edit details, Save (JobEditSheet.tsx), with only the interview panel and some steps' interviewers
 * changed: what a job opened from the plan needs before its first interview.
 */
const editJob = action({
  name: 'editJob',
  args: z.strictObject({ jobId: id, panelIds: z.array(id).optional(), interviewers: z.record(z.string(), z.array(id).min(1)).optional() }),
  run(d, a) {
    const job = must(d.jobs.find((j) => j.id === a.jobId), `No job ${a.jobId}.`)
    const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((v, i) => v === y[i])
    let changed = false
    if (a.panelIds && !same(job.panelIds, a.panelIds)) {
      job.panelIds = [...a.panelIds]
      changed = true
    }
    for (const [stepId, ids] of Object.entries(a.interviewers ?? {})) {
      const step = must(
        job.interviewPlan.find((s) => s.id === stepId),
        `No interview step ${stepId} on ${job.title}.`,
      )
      if (same(step.interviewerIds, ids)) continue
      step.interviewerIds = [...ids]
      changed = true
    }
    if (!changed) throw new Error('No changes to save.')
    logActivity(d, { entityType: 'job', entityId: job.id, kind: 'job_updated', text: `Edited the ${job.title} job` })
  },
})

/** The offer card, Declined (OfferDialogs.tsx DeclineModal): the reason chip, and the application closes. */
const decline = action({
  name: 'markDeclined',
  args: z.strictObject({ offerId: id, reason: outcomeReason }),
  run(d, a, ctx) {
    ok(markDeclined(d, a.offerId, a.reason, { date: ctx.day, outcomeReason: a.reason }))
  },
})

/**
 * Time off, Request time off or Record time off, then Send or Save (RequestTimeOffSheet.tsx): for oneself, or
 * by Admin for anyone. Sick leave before its service wait needs Admin's choice (waive the wait or record it
 * unpaid). Admin's own picks are approved on save unless approveNow is false, as the sheet's switch starts.
 */
const requestTimeOff = action({
  name: 'requestTimeOff',
  args: z.strictObject({
    personId: id,
    policyId: id,
    startDate: date,
    endDate: date,
    partial: z.enum(['am', 'pm']).optional(),
    note: z.string().optional(),
    approveNow: z.boolean().optional(),
    earlyChoice: z.enum(['waive', 'unpaid']).optional(),
  }),
  run(d, a, ctx) {
    const db = before(d)
    const person = must(db.people.find((p) => p.id === a.personId), `No person ${a.personId}.`)
    const policy = must(
      policiesFor(db, person, ctx.day).find((p) => p.id === a.policyId),
      `${a.policyId} is not a time off type ${person.firstName} can use.`,
    )
    const isAdmin = ctx.viewingAs === 'admin'
    if (!isAdmin && ctx.actorId !== person.id) throw new Error('Only Admin records time off for someone else.')
    if (a.endDate < a.startDate || workdays(a.startDate, a.endDate, db.holidays) === 0) throw new Error('Pick dates with at least one workday.')
    const early = !!policy.autoApprove && !!serviceWait(db, { personId: person.id, policyId: policy.id, startDate: a.startDate })
    if (early && isAdmin && !a.earlyChoice) throw new Error('Pick how to record it.')
    const auto = !!policy.autoApprove && !early
    const willApprove = !auto && !early && isAdmin && (a.approveNow ?? true)
    const input = {
      personId: person.id,
      policyId: policy.id,
      startDate: a.startDate,
      endDate: a.endDate,
      ...(a.partial ? { partial: a.partial } : {}),
      ...(a.note?.trim() ? { note: a.note.trim() } : {}),
    }
    const by = ctx.actorId ? { approverId: ctx.actorId } : {}
    const req = createRequest(d, input, { date: ctx.day, beforeWait: isAdmin && a.earlyChoice === 'waive' ? 'waive' : 'hold' })
    if (early && isAdmin && a.earlyChoice === 'unpaid') approveAsUnpaid(d, req.id, { date: ctx.day, ...by })
    if (willApprove && req.status === 'pending') approveRequest(d, req.id, { date: ctx.day, ...by })
    return req.id
  },
})

/** A pending request's Approve, by its manager or Admin (src/features/timeoff/actions.ts approveTimeOff). */
const approveTimeOff = action({
  name: 'approveTimeOff',
  args: z.strictObject({ requestId: id }),
  run(d, a, ctx) {
    must(
      approveRequest(d, a.requestId, { date: ctx.day, ...(ctx.actorId ? { approverId: ctx.actorId } : {}) }),
      `Request ${a.requestId} is not waiting for a decision.`,
    )
  },
})

/** Time off, a leave case's Mark returned (src/features/timeoff/actions.ts). */
const returned = action({
  name: 'markReturned',
  args: z.strictObject({ leaveId: id }),
  run(d, a, ctx) {
    must(markReturned(d, a.leaveId, { date: ctx.day, byId: ctx.actorId }), `Leave case ${a.leaveId} is missing or already ended.`)
  },
})

/**
 * The inbox ops an admin clears from Home with one button (src/features/home/Inbox.tsx), as data. Ops that
 * need judgment or words (extend an offer, decline a job request, a rule that does not apply, a backup
 * downloaded) are left out.
 */
const inboxOpArgs = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('task_status'), checklistId: id, taskId: id, status: z.literal('done') }),
  z.strictObject({ type: z.literal('approve_offer'), offerId: id }),
  z.strictObject({ type: z.literal('approve_timeoff'), requestId: id }),
  z.strictObject({ type: z.literal('approve_timeoff_unpaid'), requestId: id }),
  z.strictObject({ type: z.literal('leave_notice_sent'), leaveCaseId: id }),
  z.strictObject({ type: z.literal('rule_action_done'), ruleId: z.string().min(1), actionId: z.string().min(1) }),
  z.strictObject({ type: z.literal('training_done'), personId: id, kind: z.string().min(1) }),
  z.strictObject({ type: z.literal('recurring_done'), recurringId: id }),
  z.strictObject({ type: z.literal('access_review_done'), quarter: z.string().min(1) }),
  z.strictObject({ type: z.literal('annual_done'), ruleId: z.string().min(1), year: z.number().int() }),
  z.strictObject({ type: z.literal('acknowledge'), policyId: id, personId: id }),
  z.strictObject({ type: z.literal('add_holidays'), year: z.number().int() }),
  z.strictObject({ type: z.literal('payrun_submitted'), periodStart: date }),
])

/** The inbox op types the simulator applies (an admin's one-button clears). */
export const INBOX_OP_TYPES: ReadonlySet<string> = new Set(inboxOpArgs.options.map((o) => o.shape.type.value))

/** Home, an inbox row's button: the op it carries, applied as the person acting (applyInboxOp). */
const inbox = action({
  name: 'inboxOp',
  args: z.strictObject({ op: inboxOpArgs }),
  run(d, a, ctx) {
    ok(applyInboxOp(d, a.op as InboxOp, { date: ctx.day, actorId: ctx.actorId }))
  },
})

/**
 * Opening the app: the changes it makes on its own when a workspace loads, in the order applyLoadChanges
 * (src/store/db.ts) makes them. Changing nothing is fine.
 */
const openApp = action({
  name: 'openApp',
  args: z.strictObject({}),
  quiet: true,
  run(d, _a, ctx) {
    applyScheduledChanges(d, ctx.day)
    applyDueHandoffs(d, ctx.day)
    expireOffers(d, ctx.day)
  },
})

const LIST = [
  saveDepartment,
  saveLocation,
  saveLevel,
  saveBand,
  changeJob,
  planLine,
  newJob,
  postJob,
  jobStatus,
  quickAdd,
  moveTo,
  schedule,
  scorecard,
  reject,
  closeOut,
  draftOffer,
  submitOffer,
  approve,
  send,
  accept,
  hire,
  task,
  designation,
  payRun,
  leave,
  offboard,
  jobFromPlan,
  backfill,
  editJob,
  decline,
  requestTimeOff,
  approveTimeOff,
  returned,
  inbox,
  openApp,
] as const

type AnyAction = (typeof LIST)[number]
export type ActionName = AnyAction['name']
type ActionOf<N extends ActionName> = Extract<AnyAction, { name: N }>
/** What an action takes, as zod reads it in. */
export type ArgsOf<N extends ActionName> = z.input<ActionOf<N>['args']>
/** What an action's run returns (the id it created, when it creates one). */
export type ResultOf<N extends ActionName> = ReturnType<ActionOf<N>['run']>

/** Every action, by name. */
export const ACTIONS = Object.fromEntries(LIST.map((a) => [a.name, a])) as { [N in ActionName]: ActionOf<N> }

// ---- Applying ---------------------------------------------------------------------------------------

const TRACED = new Set<string>(RECORD_COLLECTIONS.filter((c) => c !== 'activity'))

/** Ids of the records the patches added to a record collection (activity left out), in order. */
function createdIds(patches: Patch[], prev: DB): ID[] {
  const out: ID[] = []
  const seen = new Set<ID>()
  let prevIds: Map<string, Set<ID>> | null = null
  const existedBefore = (collection: string, recordId: ID) => {
    prevIds ??= new Map()
    let ids = prevIds.get(collection)
    if (!ids) {
      ids = new Set(((prev as unknown as Record<string, Array<{ id: ID }>>)[collection] ?? []).map((r) => r.id))
      prevIds.set(collection, ids)
    }
    return ids.has(recordId)
  }
  const add = (collection: string, value: unknown) => {
    const recordId = (value as { id?: unknown } | null)?.id
    if (typeof recordId !== 'string' || seen.has(recordId) || existedBefore(collection, recordId)) return
    seen.add(recordId)
    out.push(recordId)
  }
  for (const p of patches) {
    const collection = String(p.path[0])
    if (!TRACED.has(collection) || p.op === 'remove') continue
    // A record added or put in place at an index, or a whole list written anew (draft.x = draft.x.filter(...)).
    if (p.path.length === 2 && typeof p.path[1] === 'number') add(collection, p.value)
    else if (p.path.length === 1 && Array.isArray(p.value)) for (const r of p.value) add(collection, r)
  }
  return out
}

/**
 * Applies one action to the simulation: checks its args, sets the pretend date and the run's actor, mode
 * and time of day, runs it in one Immer produce and records the trace line. Returns what the action
 * returns. Throws when no run is on, on args zod refuses, on a crash inside the action, and on a refusal
 * (an ActionRefused); the DB stays as it was in every case.
 */
export function applyAction<N extends ActionName>(sim: SimState, name: N, args: ArgsOf<N>, ctx: ActionContext): ResultOf<N> {
  const spec = ACTIONS[name] as unknown as ActionSpec<N, z.ZodType, ResultOf<N>>
  if (!spec) throw new Error(`No simulator action named ${name}.`)
  if (!activeRun()) throw new Error('Simulator actions run inside a run (withRunContext), so ids and timestamps are reproducible.')
  const parsed = spec.args.safeParse(args)
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`).join('; ')
    throw new Error(`${name} on ${ctx.day}: the args do not fit (${where}).`)
  }
  setClockOverride(ctx.day)
  updateRun({ actorId: ctx.actorId, viewingAs: ctx.viewingAs, timeOfDay: ctx.time })
  let result: ResultOf<N> | undefined
  let next: DB
  let patches: Patch[]
  try {
    ;[next, patches] = produceWithPatches(sim.db, (d) => {
      result = spec.run(d, parsed.data, ctx)
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // The app refuses with a plain Error; a TypeError, RangeError and the like is a crash in the code it ran.
    if (!(e instanceof Error) || e.constructor !== Error) throw new Error(`${name} on ${ctx.day} ${ctx.time} failed: ${e instanceof Error ? `${e.name}: ` : ''}${message}`, { cause: e })
    throw new ActionRefused(`${name} on ${ctx.day} ${ctx.time} was refused: ${message}`, message, { cause: e })
  }
  if (next === sim.db) {
    if (spec.quiet) return result as ResultOf<N>
    const message = `${name} on ${ctx.day} ${ctx.time} changed nothing.`
    throw new ActionRefused(message, message)
  }
  sim.trace.push({ day: ctx.day, time: ctx.time, actor: ctx.actorId, viewingAs: ctx.viewingAs, action: name, args: parsed.data, created: createdIds(patches, sim.db) })
  sim.db = next
  return result as ResultOf<N>
}

/** The trace as JSON lines: one action per line, in the order they were applied. */
export function traceToJsonLines(trace: readonly TraceLine[]): string {
  return trace.map((line) => JSON.stringify(line)).join('\n') + (trace.length ? '\n' : '')
}
