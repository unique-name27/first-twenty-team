// Hand-offs at an exit. Besides direct reports (moved through changeJobOrPay), a leaver can hold
// roles that keep work moving: hiring manager of a live job, owner of candidate next steps,
// interviewer on interviews after they leave, the person a contractor works with, and department
// head. The offboarding wizard lists them (leaverRoles), records who takes each one over
// (recordHandoffs) and the moves land on the last day (applyDueHandoffs, run on every load with
// the scheduled job changes) or at once when the admin chooses to hand off now.
//
// Like lifecycle.ts this module may run while the store is still loading, so it keeps no
// module-level state and guards its one store call (logActivity).
import type { Draft } from 'immer'
import { setTaskStatus, syncCompletedOn } from '@/domain/checklists/actions'
import { pacificDateOf } from '@/domain/hiring/util'
import { fullName } from '@/domain/people'
import type { ChecklistTask, DB, Handoff, ID } from '@/domain/types'
import { addDays, fmtDay, fmtShort, type ISODate, nowISO } from '@/lib/dates'
import { newId } from '@/lib/id'
import { logActivity } from '@/store/draft'

export type HandoffKind = Handoff['kind']

/** The offboarding checklist task that tracks the hand-off (added by recordHandoffs). */
export const HANDOFF_TASK_ID = 'off-handoff-roles'

export type LeaverRole = {
  kind: HandoffKind
  /** Job, application, interview, contractor or department id. */
  id: ID
  /** 'Hiring manager for Solutions engineer, open', 'Next step for Maya Lin, Solutions engineer: Send take-home, due Oct 14' */
  text: string
}

export const HANDOFF_KIND_ORDER: HandoffKind[] = ['job', 'next_step', 'interview', 'contractor', 'department']

/** Group headings in the wizard and the checklist note. */
export function handoffKindLabel(kind: HandoffKind, n: number): string {
  switch (kind) {
    case 'job':
      return n === 1 ? 'hiring manager for 1 job' : `hiring manager for ${n} jobs`
    case 'next_step':
      return n === 1 ? 'the next step on 1 candidate' : `next steps on ${n} candidates`
    case 'interview':
      return n === 1 ? '1 upcoming interview' : `${n} upcoming interviews`
    case 'contractor':
      return n === 1 ? '1 contractor or advisor they work with' : `${n} contractors and advisors they work with`
    case 'department':
      return n === 1 ? 'head of 1 team' : `head of ${n} teams`
  }
}

const JOB_STATUS_WORD = { draft: 'draft', open: 'open', on_hold: 'on hold', filled: 'filled', closed: 'closed' } as const

/**
 * Every role the person holds that needs a new owner when they leave. Interviews (and contracts)
 * count only when they run past `after`: the last day, or yesterday when handing off now.
 */
export function leaverRoles(db: DB, personId: ID, after: ISODate): LeaverRole[] {
  const out: LeaverRole[] = []
  for (const j of db.jobs) {
    if (j.hiringManagerId !== personId || (j.status !== 'draft' && j.status !== 'open' && j.status !== 'on_hold')) continue
    out.push({ kind: 'job', id: j.id, text: `Hiring manager for ${j.title}, ${JOB_STATUS_WORD[j.status]}` })
  }
  for (const a of db.applications) {
    if (a.status !== 'active' || a.nextStep?.ownerId !== personId) continue
    const c = db.candidates.find((x) => x.id === a.candidateId)
    const job = db.jobs.find((x) => x.id === a.jobId)
    const who = c ? `${c.firstName} ${c.lastName}` : 'a candidate'
    out.push({
      kind: 'next_step',
      id: a.id,
      text: `Next step for ${who}${job ? `, ${job.title}` : ''}: ${a.nextStep.text}, due ${fmtShort(a.nextStep.dueOn)}`,
    })
  }
  for (const i of db.interviews) {
    if (i.status !== 'scheduled' || !i.interviewerIds.includes(personId)) continue
    const on = pacificDateOf(i.startsAt)
    if (on <= after) continue
    const app = db.applications.find((x) => x.id === i.applicationId)
    if (app && app.status !== 'active') continue
    const c = app ? db.candidates.find((x) => x.id === app.candidateId) : undefined
    out.push({ kind: 'interview', id: i.id, text: `${i.name}${c ? ` with ${c.firstName} ${c.lastName}` : ''}, ${fmtShort(on)}` })
  }
  for (const k of db.contractors) {
    if (k.managerId !== personId || (k.endOn && k.endOn <= after)) continue
    out.push({ kind: 'contractor', id: k.id, text: `Works with ${k.entityName || k.name} (${k.kind})` })
  }
  for (const d of db.departments) {
    if (d.headId !== personId) continue
    out.push({ kind: 'department', id: d.id, text: `Head of ${d.name}` })
  }
  return out
}

/** Short plain summary: 'hiring manager for 1 job, next steps on 5 candidates and head of 1 team'. */
export function handoffSummary(roles: Array<Pick<LeaverRole, 'kind'>>): string {
  const parts = HANDOFF_KIND_ORDER.map((k) => ({ k, n: roles.filter((r) => r.kind === k).length }))
    .filter((x) => x.n > 0)
    .map((x) => handoffKindLabel(x.k, x.n))
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

function log(draft: Draft<DB>, a: Parameters<typeof logActivity>[1], actorId?: ID | null): void {
  try {
    logActivity(draft, a)
  } catch {
    draft.activity.push({ id: newId('act'), at: nowISO(), actorId: actorId ?? null, ...a })
    return
  }
  if (actorId !== undefined) draft.activity[draft.activity.length - 1].actorId = actorId
}

/**
 * Moves the leaver's roles. Explicit hand-offs win; a role picked up since the wizard ran goes to
 * whoever took that kind of role. Only records that still point at the leaver change, so anything
 * reassigned by hand in the meantime stays put. The leaver also leaves the interview panel of every
 * live job (the new hiring manager takes their seat on jobs they managed). Returns how many moved.
 */
export function applyHandoffs(
  draft: Draft<DB>,
  personId: ID,
  handoffs: Handoff[],
  opts: { date: ISODate; actorId?: ID | null; /** Interviews after this date move (default: the date). */ after?: ISODate },
): number {
  const db = draft as DB
  const leaver = draft.people.find((p) => p.id === personId)
  const byId = new Map(handoffs.map((h) => [`${h.kind}:${h.id}`, h.toId]))
  const byKind = new Map<HandoffKind, ID>()
  for (const h of handoffs) if (!byKind.has(h.kind) && h.toId) byKind.set(h.kind, h.toId)
  const target = (kind: HandoffKind, id: ID): ID | undefined => {
    const to = byId.get(`${kind}:${id}`) ?? byKind.get(kind)
    return to && to !== personId && draft.people.some((p) => p.id === to) ? to : undefined
  }
  const moved: Array<{ kind: HandoffKind; toId: ID }> = []
  for (const role of leaverRoles(db, personId, opts.after ?? opts.date)) {
    const to = target(role.kind, role.id)
    if (!to) continue
    if (role.kind === 'job') {
      const j = draft.jobs.find((x) => x.id === role.id)
      if (!j) continue
      j.hiringManagerId = to
      if (j.panelIds.includes(personId) && !j.panelIds.includes(to)) j.panelIds = j.panelIds.map((x) => (x === personId ? to : x))
    } else if (role.kind === 'next_step') {
      const a = draft.applications.find((x) => x.id === role.id)
      if (!a?.nextStep) continue
      a.nextStep.ownerId = to
    } else if (role.kind === 'interview') {
      const i = draft.interviews.find((x) => x.id === role.id)
      if (!i) continue
      i.interviewerIds = i.interviewerIds.includes(to) ? i.interviewerIds.filter((x) => x !== personId) : i.interviewerIds.map((x) => (x === personId ? to : x))
    } else if (role.kind === 'contractor') {
      const k = draft.contractors.find((x) => x.id === role.id)
      if (!k) continue
      k.managerId = to
    } else {
      const d = draft.departments.find((x) => x.id === role.id)
      if (!d) continue
      d.headId = to
    }
    moved.push({ kind: role.kind, toId: to })
  }
  for (const j of draft.jobs) {
    if ((j.status === 'draft' || j.status === 'open' || j.status === 'on_hold') && j.panelIds.includes(personId)) {
      j.panelIds = j.panelIds.filter((x) => x !== personId)
    }
  }
  const name = leaver ? fullName(leaver) : 'the leaver'
  for (const toId of [...new Set(moved.map((m) => m.toId))]) {
    const to = draft.people.find((p) => p.id === toId)
    log(
      draft,
      {
        entityType: 'person',
        entityId: personId,
        relatedId: toId,
        kind: 'roles_handed_off',
        text: `Handed off ${name}'s roles to ${to ? fullName(to) : 'a teammate'}: ${handoffSummary(moved.filter((m) => m.toId === toId))}`,
      },
      opts.actorId,
    )
  }
  if (leaver?.separation) leaver.separation.handoffsAppliedOn = opts.date
  const cl = draft.checklists.find((c) => c.personId === personId && c.kind === 'offboarding' && c.tasks.some((t) => t.templateTaskId === HANDOFF_TASK_ID))
  const task = cl?.tasks.find((t) => t.templateTaskId === HANDOFF_TASK_ID)
  if (cl && task && task.status === 'open') {
    setTaskStatus(draft, cl.id, task.id, 'done', { date: opts.date, byId: opts.actorId, note: task.note ? `${task.note} Moved ${fmtDay(opts.date)}.` : undefined })
  }
  return moved.length
}

/**
 * Saves the wizard's hand-off choices on the separation, adds the checklist task (due on the last
 * day) and applies the moves at once when `now` is set or the last day has arrived.
 */
export function recordHandoffs(
  draft: Draft<DB>,
  personId: ID,
  handoffs: Handoff[],
  opts: { date: ISODate; actorId?: ID | null; now?: boolean; checklistId?: ID },
): number {
  const person = draft.people.find((p) => p.id === personId)
  const sep = person?.separation
  if (!person || !sep || handoffs.length === 0) return 0
  sep.handoffs = handoffs.map((h) => ({ ...h }))
  delete sep.handoffsAppliedOn
  const cl = opts.checklistId
    ? draft.checklists.find((c) => c.id === opts.checklistId)
    : draft.checklists.find((c) => c.personId === personId && c.kind === 'offboarding' && c.anchorDate === sep.lastDay)
  const applyNow = !!opts.now || sep.lastDay <= opts.date
  if (cl && !cl.tasks.some((t) => t.templateTaskId === HANDOFF_TASK_ID)) {
    const groups = new Map<ID, Handoff[]>()
    for (const h of handoffs) groups.set(h.toId, [...(groups.get(h.toId) ?? []), h])
    const lines = [...groups.entries()].map(([toId, hs]) => {
      const to = draft.people.find((p) => p.id === toId)
      return `${to ? fullName(to) : 'A teammate'} takes ${handoffSummary(hs)}`
    })
    const task: ChecklistTask = {
      id: newId('t'),
      templateTaskId: HANDOFF_TASK_ID,
      title: 'Hiring and team roles handed off',
      why: 'Open jobs, candidate next steps, interviews, contractors and teams need an owner who is still here after the last day.',
      ownerRole: 'admin',
      dueOn: sep.lastDay,
      dueRuleText: applyNow ? 'Handed off when offboarding started' : 'Moves automatically on the last day',
      status: 'open',
      category: 'culture',
      statutory: false,
      note: `${lines.join('. ')}.`,
    }
    cl.tasks.push(task)
    syncCompletedOn(cl, opts.date)
  }
  if (applyNow) return applyHandoffs(draft, personId, handoffs, { date: opts.date, actorId: opts.actorId, after: addDays(opts.date, -1) })
  return 0
}

/** Applies saved hand-offs whose last day has arrived. Safe to run on every load. Returns how many people. */
export function applyDueHandoffs(draft: Draft<DB>, date: ISODate, actorId?: ID | null): number {
  let n = 0
  for (const p of draft.people) {
    const sep = p.separation
    if (!sep?.handoffs?.length || sep.handoffsAppliedOn || sep.lastDay > date) continue
    applyHandoffs(draft, p.id, sep.handoffs as Handoff[], { date, actorId, after: sep.lastDay < date ? addDays(date, -1) : sep.lastDay })
    n += 1
  }
  return n
}
