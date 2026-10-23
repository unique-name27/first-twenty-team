// Checklist mutations for Immer drafts: mark a task done, not applicable or open again, and keep
// the checklist's completedOn in step. Each change logs plain-language activity. Harassment
// prevention and security awareness tasks also record the completion in the training tracker, and
// policy acknowledgement tasks record the acknowledgement, so the two never disagree. The reverse
// helpers (closeTrainingTasks, closeAckTasks) close the matching open task when the training or
// acknowledgement is recorded somewhere else.
import type { Draft } from 'immer'
import { election83bDueOn } from '@/domain/checklists/generate'
import { HARASSMENT_TASK_KINDS, TASK_IDS } from '@/domain/checklists/templates'
import { fullName } from '@/domain/people'
import type { Checklist, ChecklistTask, DB, ID, TrainingKind } from '@/domain/types'
import { fmtDate, type ISODate } from '@/lib/dates'
import { newId } from '@/lib/id'
import { currentActorId, logActivity } from '@/store/draft'

/**
 * Onboarding tasks that stand for a policy acknowledgement, and the policy each one records. The signed
 * PIIA is the confidential information and invention assignment agreement, so it is tracked once.
 */
export const ACK_TASK_POLICY: Record<string, ID> = { 'on-ack-handbook': 'pl-handbook', 'on-ack-security': 'pl-aup', 'on-piia': 'pl-confidentiality' }
const SECURITY_TRAINING_TASK = 'on-security-training'

/** The training tracker kind a checklist task completes, if any. */
export function trainingKindForTask(task: Pick<ChecklistTask, 'templateTaskId'>): TrainingKind | undefined {
  const id = task.templateTaskId
  if (!id) return undefined
  return HARASSMENT_TASK_KINDS[id] ?? (id === SECURITY_TRAINING_TASK ? 'security_awareness' : undefined)
}

export type TaskStatusInput = {
  date: ISODate
  byId?: ID | null
  /** Where the proof lives (PEO, Drive). Never a file. */
  evidenceLink?: string
  note?: string
}

/** Sets checklist.completedOn when nothing is open, clears it otherwise. */
export function syncCompletedOn(checklist: Draft<Checklist>, date: ISODate): void {
  const finished = checklist.tasks.length > 0 && checklist.tasks.every((t) => t.status !== 'open')
  if (finished && !checklist.completedOn) checklist.completedOn = date
  if (!finished) delete checklist.completedOn
}

/**
 * Who takes the training a harassment task stands for: the checklist's person, or for the change
 * checklist's supervisor task, the new supervisor it is assigned to.
 */
function traineeFor(checklist: Pick<Checklist, 'personId'>, task: Pick<ChecklistTask, 'templateTaskId' | 'assigneeId'>): ID | null {
  if (task.templateTaskId === TASK_IDS.supervisorTraining) return task.assigneeId ?? null
  return checklist.personId
}

/** Mirrors a training task's done or reopened state into db.trainings. */
function syncTraining(
  draft: Draft<DB>,
  checklist: Draft<Checklist>,
  task: Draft<ChecklistTask>,
  status: ChecklistTask['status'],
  previousDoneOn: ISODate | undefined,
  date: ISODate,
): void {
  const kind = trainingKindForTask(task)
  const traineeId = kind ? traineeFor(checklist, task) : null
  if (!kind || !traineeId) return
  const rows = draft.trainings.filter((t) => t.personId === traineeId && t.kind === kind)
  if (status === 'done') {
    if (rows.some((t) => t.completedOn === date)) return
    const pending = rows.filter((t) => !t.completedOn).sort((a, b) => a.dueOn.localeCompare(b.dueOn))[0]
    if (pending) pending.completedOn = date
    else draft.trainings.push({ id: newId('trn'), personId: traineeId, kind, dueOn: task.dueOn, completedOn: date })
    return
  }
  if (status === 'open' && previousDoneOn) {
    // Undo only the completion this task recorded (same date, no certificate attached since).
    const row = rows.find((t) => t.completedOn === previousDoneOn && !t.certificateLink)
    if (row) delete row.completedOn
  }
}

/** Sets a task's status. Returns false when the checklist or task does not exist. */
export function setTaskStatus(
  draft: Draft<DB>,
  checklistId: ID,
  taskId: ID,
  status: ChecklistTask['status'],
  input: TaskStatusInput,
): boolean {
  const checklist = draft.checklists.find((c) => c.id === checklistId)
  const task = checklist?.tasks.find((t) => t.id === taskId)
  if (!checklist || !task) return false
  const previousDoneOn = task.status === 'done' ? task.doneOn : undefined
  task.status = status
  if (status === 'done') {
    task.doneOn = input.date
    if (input.byId) task.doneById = input.byId
  } else {
    delete task.doneOn
    delete task.doneById
  }
  if (input.evidenceLink !== undefined) task.evidenceLink = input.evidenceLink || undefined
  if (input.note !== undefined) task.note = input.note || undefined
  syncCompletedOn(checklist, input.date)
  syncTraining(draft, checklist, task, status, previousDoneOn, input.date)
  if (status === 'done') syncAck(draft, checklist, task, input.date)

  const person = draft.people.find((p) => p.id === checklist.personId)
  const who = person ? ` for ${fullName(person)}` : ''
  const verb = status === 'done' ? 'Marked done' : status === 'not_applicable' ? 'Marked not applicable' : 'Reopened'
  logActivity(draft, {
    entityType: 'checklist',
    entityId: checklist.id,
    relatedId: checklist.personId,
    kind: status === 'done' ? 'task_done' : status === 'not_applicable' ? 'task_not_applicable' : 'task_reopened',
    // Leave task titles can hint at the type of leave, which stays private.
    text: checklist.kind === 'leave' ? `Updated the leave checklist${who}` : `${verb}: ${task.title}${who}`,
  })
  return true
}

/** Records the policy acknowledgement an acknowledgement task stands for, when it is not on file yet. */
function syncAck(draft: Draft<DB>, checklist: Draft<Checklist>, task: Draft<ChecklistTask>, date: ISODate): void {
  const policy = draft.policies.find((p) => p.id === ACK_TASK_POLICY[task.templateTaskId ?? ''])
  const norm = (v: string) => v.trim().toLowerCase().replace(/^v/, '').replace(/(\.0+)+$/, '')
  if (!policy || draft.acks.some((a) => a.personId === checklist.personId && a.policyId === policy.id && norm(a.version) === norm(policy.version))) return
  // One acknowledgement per person, policy and version, so the id can say which (and the sample stays deterministic).
  const id = `ack-${checklist.personId}-${policy.id}-${policy.version}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  draft.acks.push({ id: draft.acks.some((a) => a.id === id) ? newId('ack') : id, policyId: policy.id, version: policy.version, personId: checklist.personId, acknowledgedOn: date })
}

/**
 * Closes a person's open checklist tasks for a training kind once the completion is recorded in the
 * training tracker (Compliance, a profile's training panel). Returns how many tasks it closed.
 */
export function closeTrainingTasks(draft: Draft<DB>, personId: ID, kind: TrainingKind, date: ISODate): number {
  let n = 0
  for (const checklist of draft.checklists) {
    for (const task of checklist.tasks) {
      if (task.status !== 'open' || trainingKindForTask(task) !== kind || traineeFor(checklist, task) !== personId) continue
      setTaskStatus(draft, checklist.id, task.id, 'done', { date, byId: currentActorId(draft as DB) })
      n++
    }
  }
  return n
}

/** Closes a person's open acknowledgement task for a policy once the acknowledgement is on file. */
export function closeAckTasks(draft: Draft<DB>, personId: ID, policyId: ID, date: ISODate): number {
  let n = 0
  for (const checklist of draft.checklists) {
    if (checklist.personId !== personId) continue
    for (const task of checklist.tasks) {
      if (task.status !== 'open' || ACK_TASK_POLICY[task.templateTaskId ?? ''] !== policyId) continue
      setTaskStatus(draft, checklist.id, task.id, 'done', { date, byId: currentActorId(draft as DB) })
      n++
    }
  }
  return n
}

/**
 * Once an early exercise is recorded (grant.election83bDueOn), gives the person's open 83(b) tasks
 * their real deadline and makes them statutory. Call it after recording the exercise. Returns how
 * many tasks changed.
 */
export function sync83bDeadline(draft: Draft<DB>, personId: ID): number {
  const due = election83bDueOn(draft as DB, personId)
  if (!due) return 0
  let changed = 0
  for (const checklist of draft.checklists) {
    if (checklist.personId !== personId) continue
    for (const task of checklist.tasks) {
      if (task.templateTaskId !== TASK_IDS.election83b || task.status !== 'open') continue
      if (task.dueOn === due && task.statutory) continue
      task.dueOn = due
      task.statutory = true
      task.dueRuleText = '30 days after early exercise'
      changed += 1
    }
  }
  if (changed > 0) {
    const person = draft.people.find((p) => p.id === personId)
    logActivity(draft, {
      entityType: 'person',
      entityId: personId,
      kind: 'task_rescheduled',
      text: `Set the 83(b) filing deadline${person ? ` for ${fullName(person)}` : ''} to ${fmtDate(due)}`,
    })
  }
  return changed
}
