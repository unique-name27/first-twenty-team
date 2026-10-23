// One-tap actions with Undo toasts. Each change goes through mutate(label) so the label names the change.
import { fullName } from '@/domain/people'
import { approveAsUnpaid, approveRequest, cancelRequest, declineRequest, isConfidentialKind, serviceWait, timeOffICS } from '@/domain/timeoff'
import type { DB, TimeOffRequest, Viewer } from '@/domain/types'
import { today } from '@/lib/dates'
import { copyText, downloadFile, slug } from '@/lib/files'
import { useDB } from '@/store/db'
import { toast } from '@/ui'
import { markDesignationSent, markReturned, rangeText } from './logic'

function undoToast(text: string) {
  toast({ text, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
}

function phrase(db: DB, req: TimeOffRequest): string {
  const policy = db.timeOffPolicies.find((p) => p.id === req.policyId)
  if (!policy || isConfidentialKind(policy.kind)) return 'time off'
  return policy.name.charAt(0).toLowerCase() + policy.name.slice(1)
}

/** "recorded as Tomas Herrera (preview)" for approvals made outside Admin view, so the record stays honest. */
function previewSuffix(viewer: Viewer): string {
  if (viewer.role === 'admin' || !viewer.person) return ''
  return ` (recorded as ${fullName(viewer.person)}, preview)`
}

function nameOf(db: DB, req: TimeOffRequest): string {
  const p = db.people.find((x) => x.id === req.personId)
  return p ? fullName(p) : 'Someone'
}

/** Sick leave that waits only because it falls before the policy's service wait (Admin decides). */
export function earlyWait(db: DB, req: TimeOffRequest) {
  const policy = db.timeOffPolicies.find((p) => p.id === req.policyId)
  return req.status === 'pending' && policy?.autoApprove ? serviceWait(db, req) : null
}

export function approveTimeOff(req: TimeOffRequest, viewer: Viewer): void {
  const db = useDB.getState().db
  const wait = earlyWait(db, req)
  const label = `Approved ${nameOf(db, req)}'s ${phrase(db, req)}, ${rangeText(req.startDate, req.endDate)}${wait ? `, with the ${wait.days}-day wait waived` : ''}${previewSuffix(viewer)}`
  useDB.getState().mutate(label, (d) => {
    approveRequest(d, req.id, { date: today(), ...(viewer.personId ? { approverId: viewer.personId } : {}) })
  })
  undoToast(label)
}

/** Records sick leave that falls before the service wait as unpaid leave instead (approveAsUnpaid). */
export function recordUnpaidTimeOff(req: TimeOffRequest, viewer: Viewer): void {
  const db = useDB.getState().db
  const label = `Recorded ${nameOf(db, req)}'s time off as unpaid, ${rangeText(req.startDate, req.endDate)}${previewSuffix(viewer)}`
  useDB.getState().mutate(label, (d) => {
    approveAsUnpaid(d, req.id, { date: today(), ...(viewer.personId ? { approverId: viewer.personId } : {}) })
  })
  undoToast(label)
}

export function declineTimeOff(req: TimeOffRequest, viewer: Viewer): void {
  const db = useDB.getState().db
  const label = `Declined ${nameOf(db, req)}'s ${phrase(db, req)}, ${rangeText(req.startDate, req.endDate)}${previewSuffix(viewer)}`
  useDB.getState().mutate(label, (d) => {
    declineRequest(d, req.id, { date: today(), ...(viewer.personId ? { approverId: viewer.personId } : {}) })
  })
  undoToast(label)
}

export function cancelTimeOff(req: TimeOffRequest, viewer: Viewer): void {
  const db = useDB.getState().db
  const self = viewer.personId === req.personId
  const label = `Cancelled ${self ? 'your' : `${nameOf(db, req)}'s`} ${phrase(db, req)}, ${rangeText(req.startDate, req.endDate)}`
  useDB.getState().mutate(label, (d) => {
    cancelRequest(d, req.id, { date: today(), ...(viewer.personId ? { approverId: viewer.personId } : {}) })
  })
  undoToast(label)
}

export function markNoticeSent(leaveId: string, personName: string, viewer: Viewer): void {
  const label = `Marked the leave notice sent to ${personName}`
  useDB.getState().mutate(label, (d) => {
    markDesignationSent(d, leaveId, { date: today(), byId: viewer.personId })
  })
  undoToast(label)
}

export function markBack(leaveId: string, personName: string, viewer: Viewer): void {
  const label = `Recorded ${personName} back from leave today`
  useDB.getState().mutate(label, (d) => {
    markReturned(d, leaveId, { date: today(), byId: viewer.personId })
  })
  undoToast(label)
}

/** Downloads the request's .ics; the title says only "out", so it is safe on a shared calendar. */
export function downloadRequestICS(req: TimeOffRequest): void {
  const db = useDB.getState().db
  const ics = timeOffICS(db, req.id)
  const ok = downloadFile(`${slug(`time off ${nameOf(db, req)} ${req.startDate}`)}.ics`, ics, 'text/calendar;charset=utf-8')
  toast(ok ? { text: 'Calendar file downloaded' } : { text: 'Download blocked here. Use Copy dates instead.', tone: 'bad' })
}

export async function copyRequestDates(req: TimeOffRequest): Promise<void> {
  const db = useDB.getState().db
  const ok = await copyText(`${nameOf(db, req)}: out ${rangeText(req.startDate, req.endDate)}`)
  toast(ok ? { text: 'Dates copied' } : { text: 'Copy blocked here. Select the dates and copy them by hand.', tone: 'bad' })
}
