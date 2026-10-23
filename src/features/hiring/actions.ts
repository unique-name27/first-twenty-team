// Store wrappers for the hiring pages: every change goes through mutate(label, recipe) and shows a
// toast that names the change with an Undo button. Domain helpers do the work (src/domain/hiring).
import type { Draft } from 'immer'
import {
  advanceApplication,
  advanceNeedsHire,
  applicationLabel,
  markNotified,
  moveApplication,
  nextStage,
  quickLog,
  type QuickLogKind,
  snoozeApplication,
  stageById,
} from '@/domain/hiring'
import type { DB, ID } from '@/domain/types'
import { addDays, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { toast } from '@/ui'

/** Undo the change only when it is still the newest one, so an old toast never undoes something else. */
export function undoLabeled(label: string): void {
  const { past, undo } = useDB.getState()
  const top = past[past.length - 1]
  if (!top) return
  if (top.label !== label) {
    toast({ text: 'A newer change came after this one. Press Ctrl+Z to undo step by step.', tone: 'neutral' })
    return
  }
  undo()
  toast({ text: `Undid: ${label}`, tone: 'neutral' })
}

/**
 * Runs a change through the store. The recipe may return false to say nothing happened. Returns true
 * when the workspace changed; shows an Undo toast unless `quiet`.
 */
export function commit(label: string, recipe: (draft: Draft<DB>) => boolean | void, opts: { quiet?: boolean } = {}): boolean {
  const before = useDB.getState().db
  useDB.getState().mutate(label, (draft) => {
    recipe(draft)
  })
  const changed = useDB.getState().db !== before
  if (changed && !opts.quiet) toast({ text: label, action: { label: 'Undo', onClick: () => undoLabeled(label) } })
  return changed
}

function names(appId: ID): { name: string; job?: DB['jobs'][number] } {
  const db = useDB.getState().db
  const app = db.applications.find((a) => a.id === appId)
  const job = app ? db.jobs.find((j) => j.id === app.jobId) : undefined
  return { name: applicationLabel(db, appId), ...(job ? { job } : {}) }
}

export type AdvanceOutcome = 'moved' | 'needs_hire' | 'none'

/**
 * Advance one stage. From Offer the next stage is Hired, which belongs to the Hire flow: the caller opens
 * the offer on the profile (links.candidateOffer), where focus lands on its next action.
 */
export function advance(appId: ID, actorId: ID | null): AdvanceOutcome {
  const db = useDB.getState().db
  const app = db.applications.find((a) => a.id === appId)
  const job = app && db.jobs.find((j) => j.id === app.jobId)
  if (!app || !job || app.status !== 'active') return 'none'
  if (advanceNeedsHire(job, app.stageId)) {
    const n = names(appId).name
    toast({ text: app.conditionalOfferOn ? `Hire ${n} from the accepted offer.` : `Finish ${n}'s offer. Hire comes after they accept.`, tone: 'neutral' })
    return 'needs_hire'
  }
  const next = nextStage(job, app.stageId)
  if (!next) return 'none'
  const ok = commit(`Moved ${names(appId).name} to ${next.name}`, (d) => advanceApplication(d, appId, { date: today(), actorId }))
  return ok ? 'moved' : 'none'
}

/** Move to any stage (the 'Move to…' picker and the stage stepper). Reopens closed applications. */
export function moveTo(appId: ID, stageId: string, actorId: ID | null): AdvanceOutcome {
  const db = useDB.getState().db
  const app = db.applications.find((a) => a.id === appId)
  const job = app && db.jobs.find((j) => j.id === app.jobId)
  const stage = job && stageById(job, stageId)
  if (!app || !job || !stage) return 'none'
  if (stage.kind === 'hired') {
    toast({ text: `Hire ${names(appId).name} from the accepted offer.`, tone: 'neutral' })
    return 'needs_hire'
  }
  const reopen = app.status === 'rejected' || app.status === 'withdrawn'
  const label = reopen ? `Reopened ${names(appId).name} in ${stage.name}` : `Moved ${names(appId).name} to ${stage.name}`
  return commit(label, (d) => moveApplication(d, appId, stageId, { date: today(), actorId })) ? 'moved' : 'none'
}

/** Snooze 3 days (S): the candidate stays quiet in the inbox until then. */
export function snooze3(appId: ID): boolean {
  const until = addDays(today(), 3)
  return commit(`Snoozed ${names(appId).name} for 3 days`, (d) => snoozeApplication(d, appId, until))
}

export function logContact(appId: ID, kind: QuickLogKind): boolean {
  const n = names(appId).name
  const label = kind === 'emailed' ? `Logged an email to ${n}` : kind === 'called' ? `Logged a call with ${n}` : `Logged a voicemail for ${n}`
  return commit(label, (d) => quickLog(d, appId, kind, { date: today() }))
}

export function notify(appId: ID, opts: { quiet?: boolean } = {}): boolean {
  return commit(`Marked ${names(appId).name} notified`, (d) => markNotified(d, appId, { date: today() }), opts)
}
