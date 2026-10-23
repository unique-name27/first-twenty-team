// Pure helpers for the People feature: directory rows and filters, the org tree, the First twenty
// wall, checklist phases and self-explaining due dates, the AB5 check, contractor paperwork flags and
// who may see or act on which checklist task. No React here, so everything is unit tested.
import { canSeePerson, isInReportingLine } from '@/domain/access'
import {
  checklistProgress,
  type ChecklistProgress,
  dueDate,
  dueRuleText,
  findTemplate,
  holidayDates,
  mootAfterExit,
  taskDueOn,
  taskFileBy,
} from '@/domain/checklists/generate'
import { TASK_IDS } from '@/domain/checklists/templates'
import { estimatePaidInYear, form1099ThresholdFor, nextBusinessDay } from '@/domain/compliance'
import { exerciseDeadline, vestedShares } from '@/domain/equity'
import { currentJob } from '@/domain/lifecycle'
import { planSlotStatus, slotJob, slotPerson } from '@/domain/pay'
import {
  departmentName,
  employedOn,
  employmentState,
  founder,
  fullName,
  incomingOn,
  locationName,
  onLeave,
} from '@/domain/people'
import type {
  Ab5Exemption,
  Checklist,
  ChecklistKind,
  ChecklistTask,
  Contractor,
  DB,
  DueRule,
  ID,
  Job,
  LeaveCase,
  Person,
  PlanSlot,
  Viewer,
} from '@/domain/types'
import { addDays, addMonths, daysBetween, type ISODate, parseDate, quarterOf, today } from '@/lib/dates'
import { listJoin } from '@/lib/format'
import { newId } from '@/lib/id'
import { MAX_RECORD_BYTES } from '@/sync/protocol'
import { format } from 'date-fns'

// ---------------------------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------------------------

/** "Mon Oct 19", with the year when it is not this year: "Mon Apr 19, 2027". */
export function dayLabel(d: ISODate): string {
  return format(parseDate(d), d.slice(0, 4) === today().slice(0, 4) ? 'EEE MMM d' : 'EEE MMM d, yyyy')
}

/** "starts today", "starts tomorrow", "starts in 10 days", "started 3 days ago" */
export function startsInText(start: ISODate, date: ISODate): string {
  const n = daysBetween(date, start)
  if (n === 0) return 'starts today'
  if (n === 1) return 'starts tomorrow'
  if (n > 1) return `starts in ${n} days`
  return n === -1 ? 'started yesterday' : `started ${-n} days ago`
}

/** The next work anniversary on or after the date (at least the first one). */
export function nextAnniversary(start: ISODate, date: ISODate): { date: ISODate; years: number } {
  const s = parseDate(start)
  const d = parseDate(date)
  let years = Math.max(1, d.getFullYear() - s.getFullYear())
  if (addMonths(start, 12 * years) < date) years += 1
  return { date: addMonths(start, 12 * years), years }
}

/** The next Monday after the date (never the date itself). */
export function nextMonday(from: ISODate): ISODate {
  const add = (8 - parseDate(from).getDay()) % 7 || 7
  return addDays(from, add)
}

/** The Friday of the date's week (the date itself on a Friday), plus whole weeks. */
export function nextFriday(from: ISODate, weeks = 0): ISODate {
  const add = (5 - parseDate(from).getDay() + 7) % 7
  return addDays(from, add + weeks * 7)
}

/** Vested options left at the last day, shares returned to the pool, and the earliest exercise deadline. */
export function equityAtExit(db: Pick<DB, 'grants'>, personId: ID, lastDay: ISODate): { vested: number; returned: number; deadline?: ISODate } {
  let vested = 0
  let returned = 0
  let deadline: ISODate | undefined
  for (const g of db.grants) {
    if (g.personId !== personId || g.status === 'cancelled') continue
    if (g.status === 'approved') {
      const v = vestedShares(g, lastDay)
      const left = Math.max(0, v - (g.exercisedShares ?? 0))
      vested += left
      returned += g.shares - v
      if (left > 0) {
        const d = exerciseDeadline(g, lastDay)
        if (!deadline || d < deadline) deadline = d
      }
    } else returned += g.shares
  }
  return deadline ? { vested, returned, deadline } : { vested, returned }
}

// ---------------------------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------------------------

export type DirStatus = 'active' | 'starting' | 'on_leave' | 'alumni'
export type WorkerKind = 'employee' | 'contractor' | 'advisor'

export const DIR_STATUS_LABEL: Record<DirStatus, string> = {
  active: 'Active',
  starting: 'Starting soon',
  on_leave: 'On leave',
  alumni: 'Alumni',
}

export const WORKER_KIND_LABEL: Record<WorkerKind, string> = {
  employee: 'Employees',
  contractor: 'Contractors',
  advisor: 'Advisors',
}

export type DirectoryRow = {
  id: ID
  kind: WorkerKind
  name: string
  /** Employee number in hire order (employees only). */
  number?: number
  title: string
  team: string
  departmentId: ID
  managerId: ID | null
  managerName: string
  location: string
  /** Location id for employees, 'state:XX' for contractors and advisors. */
  locationKey: string
  startDate: ISODate
  endDate?: ISODate | null
  status: DirStatus
  person?: Person
  contractor?: Contractor
  leave?: LeaveCase
}

export function personDirStatus(db: DB, p: Person, date: ISODate): DirStatus {
  const s = employmentState(p, date, db)
  return s === 'incoming' ? 'starting' : s === 'former' ? 'alumni' : s === 'on_leave' ? 'on_leave' : 'active'
}

export function contractorDirStatus(c: Contractor, date: ISODate): DirStatus {
  if (c.startOn > date) return 'starting'
  if (c.endOn && c.endOn < date) return 'alumni'
  return 'active'
}

/** "San Jose HQ" or "Remote (Texas), Austin, TX" style: the office plus where remote people work from. */
export function personLocation(db: DB, p: Person): string {
  const loc = locationName(db, p.locationId)
  if (p.workMode !== 'remote') return loc
  const where = [p.homeCity, p.homeState].filter(Boolean).join(', ')
  return where ? `Remote, ${where}` : loc || 'Remote'
}

export function directoryRows(db: DB, date: ISODate): DirectoryRow[] {
  const name = (id: ID | null | undefined) => {
    const m = id ? db.people.find((p) => p.id === id) : undefined
    return m ? fullName(m) : ''
  }
  const people: DirectoryRow[] = [...db.people]
    .sort((a, b) => a.hireNumber - b.hireNumber)
    .map((p) => {
      const leave = onLeave(db, p.id, date)
      const row: DirectoryRow = {
        id: p.id,
        kind: 'employee',
        name: fullName(p),
        number: p.hireNumber,
        title: p.title,
        team: departmentName(db, p.departmentId),
        departmentId: p.departmentId,
        managerId: p.managerId,
        managerName: name(p.managerId),
        location: personLocation(db, p),
        locationKey: p.locationId,
        startDate: p.startDate,
        endDate: p.endDate ?? null,
        status: personDirStatus(db, p, date),
        person: p,
      }
      if (leave) row.leave = leave
      return row
    })
  const others: DirectoryRow[] = [...db.contractors]
    .sort((a, b) => (a.entityName || a.name).localeCompare(b.entityName || b.name))
    .map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.entityName ? `${c.entityName}` : c.name,
      title: c.kind === 'advisor' ? 'Advisor' : c.scope.split(/[.:]/)[0].slice(0, 60),
      team: departmentName(db, c.departmentId),
      departmentId: c.departmentId,
      managerId: c.managerId,
      managerName: name(c.managerId),
      location: `Remote, ${c.state}`,
      locationKey: `state:${c.state}`,
      startDate: c.startOn,
      endDate: c.endOn ?? null,
      status: contractorDirStatus(c, date),
      contractor: c,
    }))
  return [...people, ...others]
}

export type DirectoryFilter = {
  statuses: DirStatus[]
  kinds: WorkerKind[]
  departmentId: ID | ''
  location: string | ''
  query: string
}

export function filterDirectory(rows: DirectoryRow[], f: DirectoryFilter): DirectoryRow[] {
  const q = f.query.trim().toLowerCase()
  return rows.filter((r) => {
    if (f.statuses.length && !f.statuses.includes(r.status)) return false
    if (f.kinds.length && !f.kinds.includes(r.kind)) return false
    if (f.departmentId && r.departmentId !== f.departmentId) return false
    if (f.location && r.locationKey !== f.location) return false
    if (q) {
      const hay = [r.name, r.title, r.team, r.managerName, r.location, r.number != null ? `#${r.number}` : '', r.contractor?.name ?? '']
        .join(' ')
        .toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

// ---------------------------------------------------------------------------------------------
// Org chart
// ---------------------------------------------------------------------------------------------

export type OrgNode = {
  /** Person id, contractor id, or 'plan:<slotId>'. */
  id: string
  kind: 'person' | 'contractor' | 'advisor' | 'planned'
  person?: Person
  contractor?: Contractor
  slot?: PlanSlot
  slotStatus?: PlanSlot['status']
  children: OrgNode[]
}

/**
 * The reporting tree from managerId: current and incoming employees, optionally contractors and
 * advisors under their manager, and optionally open plan lines (planned, open or at offer) as
 * placeholders under the job's hiring manager, else the department head, else the founder.
 */
export function buildOrgTree(db: DB, date: ISODate, opts: { planned: boolean; contractors: boolean }): OrgNode[] {
  const people = [...employedOn(db, date), ...incomingOn(db, date)].sort((a, b) => a.hireNumber - b.hireNumber)
  const nodes = new Map<string, OrgNode>()
  for (const p of people) nodes.set(p.id, { id: p.id, kind: 'person', person: p, children: [] })
  const roots: OrgNode[] = []
  for (const p of people) {
    const node = nodes.get(p.id) as OrgNode
    const parent = p.managerId && p.managerId !== p.id ? nodes.get(p.managerId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const top = (founder(db) && nodes.get(founder(db)?.id ?? '')) || roots[0]
  if (opts.contractors) {
    for (const c of db.contractors) {
      if (contractorDirStatus(c, date) === 'alumni') continue
      const node: OrgNode = { id: c.id, kind: c.kind, contractor: c, children: [] }
      const parent = nodes.get(c.managerId) ?? top
      if (parent) parent.children.push(node)
      else roots.push(node)
    }
  }
  if (opts.planned) {
    const slots = db.plan
      .map((s) => ({ s, status: planSlotStatus(db, s) }))
      .filter((x) => x.status === 'planned' || x.status === 'open' || x.status === 'offer')
      .sort((a, b) => a.s.targetStart.localeCompare(b.s.targetStart))
    for (const { s, status } of slots) {
      const job = slotJob(db, s)
      const head = db.departments.find((d) => d.id === s.departmentId)?.headId
      const parent = (job && nodes.get(job.hiringManagerId)) || (head && nodes.get(head)) || top
      const node: OrgNode = { id: `plan:${s.id}`, kind: 'planned', slot: s, slotStatus: status, children: [] }
      if (parent) parent.children.push(node)
      else roots.push(node)
    }
  }
  const order = (n: OrgNode) => (n.kind === 'person' ? 0 : n.kind === 'contractor' ? 1 : n.kind === 'advisor' ? 2 : 3)
  const sortRec = (list: OrgNode[]) => {
    list.sort((a, b) => order(a) - order(b) || (a.person?.hireNumber ?? 0) - (b.person?.hireNumber ?? 0))
    for (const n of list) sortRec(n.children)
  }
  sortRec(roots)
  return roots
}

/** Depth-first list of nodes that are visible given the expanded set (roots always visible). */
export function visibleOrgNodes(roots: OrgNode[], expanded: Set<string>): Array<{ node: OrgNode; level: number; parentId: string | null }> {
  const out: Array<{ node: OrgNode; level: number; parentId: string | null }> = []
  const walk = (list: OrgNode[], level: number, parentId: string | null) => {
    for (const n of list) {
      out.push({ node: n, level, parentId })
      if (n.children.length && expanded.has(n.id)) walk(n.children, level + 1, n.id)
    }
  }
  walk(roots, 1, null)
  return out
}

export function allOrgIds(roots: OrgNode[]): string[] {
  const out: string[] = []
  const walk = (list: OrgNode[]) => {
    for (const n of list) {
      if (n.children.length) out.push(n.id)
      walk(n.children)
    }
  }
  walk(roots)
  return out
}

// ---------------------------------------------------------------------------------------------
// First twenty wall
// ---------------------------------------------------------------------------------------------

export type Seat = {
  /** Seat number, 1-based, in hire order. */
  n: number
  kind: 'filled' | 'incoming' | 'alumni' | 'planned' | 'empty'
  person?: Person
  slot?: PlanSlot
  slotStatus?: PlanSlot['status']
}

/** Seats in hire order: employees (alumni stay as outlined seats), then plan lines, then empty seats to `min`. */
export function wallSeats(db: DB, date: ISODate, min = 20): Seat[] {
  const seats: Seat[] = []
  const people = [...db.people].sort((a, b) => a.hireNumber - b.hireNumber)
  for (const p of people) {
    const st = employmentState(p, date)
    seats.push({ n: seats.length + 1, kind: st === 'former' ? 'alumni' : st === 'incoming' ? 'incoming' : 'filled', person: p })
  }
  const open = db.plan
    .map((s) => ({ s, status: planSlotStatus(db, s) }))
    .filter((x) => x.status === 'planned' || x.status === 'open' || x.status === 'offer')
    .sort((a, b) => a.s.targetStart.localeCompare(b.s.targetStart) || a.s.quarter.localeCompare(b.s.quarter))
  for (const { s, status } of open) seats.push({ n: seats.length + 1, kind: 'planned', slot: s, slotStatus: status })
  while (seats.length < min) seats.push({ n: seats.length + 1, kind: 'empty' })
  return seats
}

// ---------------------------------------------------------------------------------------------
// Checklists: labels, phases and due dates that explain themselves
// ---------------------------------------------------------------------------------------------

export const CHECKLIST_KIND_LABEL: Record<ChecklistKind, string> = {
  onboarding: 'Onboarding',
  offboarding: 'Offboarding',
  new_state: 'New state setup',
  leave: 'Leave',
  change: 'Job or pay change',
}

export const OWNER_LABEL: Record<ChecklistTask['ownerRole'], string> = {
  admin: 'Admin',
  manager: 'Manager',
  employee: 'Employee',
  it: 'IT',
}

/**
 * Who a task is with, in words. An assigned admin task belongs to that person while Admin tracks it (supervisor
 * training: "Owner: Aisha Bello (Admin tracks it)", so it never reads as if they were an admin). A manager task
 * with no assignee belongs to whoever manages the person now (taskOwnerId in the inbox does the same).
 */
export function taskOwnerText(db: DB, checklist: Pick<Checklist, 'personId'>, task: Pick<ChecklistTask, 'ownerRole' | 'assigneeId'>): string {
  const assignee = task.assigneeId ? db.people.find((p) => p.id === task.assigneeId) : undefined
  if (assignee && task.ownerRole === 'admin') return `Owner: ${fullName(assignee)} (Admin tracks it)`
  // Nobody holds an IT role in a small company: an unassigned IT task is Admin's (isMyTask, the inbox).
  if (!assignee && task.ownerRole === 'it') return 'Owner: IT (Admin)'
  const managerId = !task.assigneeId && task.ownerRole === 'manager' ? db.people.find((p) => p.id === checklist.personId)?.managerId : undefined
  const owner = assignee ?? (managerId ? db.people.find((p) => p.id === managerId) : undefined)
  return `Owner: ${OWNER_LABEL[task.ownerRole]}${owner ? `, ${fullName(owner)}` : ''}`
}

export type Phase = { key: string; label: string; order: number }

/** Which phase a task belongs to: by day offset from the checklist's anchor, with labels per kind. */
export function phaseOf(kind: ChecklistKind, dueOn: ISODate, anchor: ISODate): Phase {
  const d = daysBetween(anchor, dueOn)
  if (kind === 'offboarding') {
    if (d < 0) return { key: 'before', label: 'Before the last day', order: 0 }
    if (d === 0) return { key: 'last', label: 'On the last day', order: 1 }
    if (d <= 3) return { key: '72h', label: 'Within 72 hours', order: 2 }
    if (d <= 31) return { key: '30d', label: 'Within 30 days', order: 3 }
    return { key: 'later', label: 'Later', order: 4 }
  }
  if (kind === 'leave') {
    if (d < 0) return { key: 'before', label: 'Before the leave', order: 0 }
    if (d === 0) return { key: 'start', label: 'When the leave starts', order: 1 }
    return { key: 'after', label: 'During and after the leave', order: 2 }
  }
  if (kind === 'change') {
    if (d <= 0) return { key: 'before', label: 'Before it takes effect', order: 0 }
    return { key: 'after', label: 'After it takes effect', order: 1 }
  }
  if (d < 0) return { key: 'before', label: 'Before day 1', order: 0 }
  if (d === 0) return { key: 'day1', label: 'Day 1', order: 1 }
  if (d <= 7) return { key: 'week1', label: 'Week 1', order: 2 }
  if (d <= 35) return { key: 'month1', label: 'Month 1', order: 3 }
  return { key: 'later', label: 'Later', order: 4 }
}

export function groupByPhase(checklist: Pick<Checklist, 'kind' | 'anchorDate'>, tasks: ChecklistTask[]): Array<Phase & { tasks: ChecklistTask[] }> {
  const groups = new Map<string, Phase & { tasks: ChecklistTask[] }>()
  for (const t of tasks) {
    const ph = phaseOf(checklist.kind, t.dueOn, checklist.anchorDate)
    const g = groups.get(ph.key) ?? { ...ph, tasks: [] }
    g.tasks.push(t)
    groups.set(ph.key, g)
  }
  const list = [...groups.values()].sort((a, b) => a.order - b.order)
  for (const g of list) g.tasks.sort((a, b) => a.dueOn.localeCompare(b.dueOn) || Number(b.statutory) - Number(a.statutory))
  return list
}

/** The date a due rule counts from on this checklist. */
export function anchorDateFor(db: DB, checklist: Checklist, anchor: DueRule['anchor']): ISODate {
  const person = db.people.find((p) => p.id === checklist.personId)
  switch (anchor) {
    case 'start':
      return checklist.kind === 'onboarding' || checklist.kind === 'new_state' ? checklist.anchorDate : (person?.startDate ?? checklist.anchorDate)
    case 'last_day':
      return checklist.kind === 'offboarding' ? checklist.anchorDate : (person?.endDate ?? checklist.anchorDate)
    case 'leave_start':
      return checklist.anchorDate
    case 'created': {
      if (checklist.kind === 'leave') {
        const lc = db.leaveCases.find((l) => l.personId === checklist.personId && l.startDate === checklist.anchorDate)
        if (lc) return lc.requestedOn
      }
      return checklist.createdOn
    }
    case 'offer_accepted': {
      const offer = db.offers.find((o) => o.personId === checklist.personId && o.status === 'accepted')
      return offer?.decidedOn ?? checklist.createdOn
    }
  }
}

function unitWord(rule: DueRule): string {
  const n = Math.abs(rule.offset)
  if (rule.unit === 'business_days') return n === 1 ? 'business day' : 'business days'
  if (rule.unit === 'months') return n === 1 ? 'month' : 'months'
  return n === 1 ? 'day' : 'days'
}

/**
 * Plain explanation of where a due date comes from: '3 business days after Mon Oct 19',
 * 'on the last day, Fri Aug 28', '5 business days after the request on Tue Oct 6', and for a company
 * target that fell on a weekend or holiday '90 days after Mon Nov 2, moved to the next business day'.
 * Falls back to the task's own rule text when the lifecycle set a computed deadline (final pay, return date).
 */
export function dueExplanation(db: DB, checklist: Checklist, task: ChecklistTask): string {
  // The sign-on bonus task is added at hire, outside the template: paid with the first paycheck, due on the start date.
  if (task.templateTaskId === TASK_IDS.signOnBonus) {
    const start = anchorDateFor(db, checklist, 'start')
    return task.dueOn === start ? `on the start date, ${dayLabel(start)}` : (task.dueRuleText ?? '')
  }
  const template = findTemplate(db, checklist.templateId)
  const tt = template?.tasks.find((t) => t.id === task.templateTaskId)
  const fallback = task.dueRuleText ?? ''
  if (!tt) return fallback
  const rule = tt.due
  const anchor = anchorDateFor(db, checklist, rule.anchor)
  const holidays = holidayDates(db)
  const computed = taskDueOn({ due: rule, statutory: task.statutory }, anchor, holidays)
  const defaultText = dueRuleText(rule, checklist.kind)
  if (computed !== task.dueOn || (task.dueRuleText && task.dueRuleText !== defaultText)) return fallback
  const d = dayLabel(anchor)
  const dir = rule.offset > 0 ? 'after' : 'before'
  const n = Math.abs(rule.offset)
  const created = checklist.kind === 'change' ? 'the change was recorded' : 'the request'
  if (rule.offset === 0) {
    switch (rule.anchor) {
      case 'start':
        return `on the start date, ${d}`
      case 'last_day':
        return `on the last day, ${d}`
      case 'leave_start':
        return `when the leave starts, ${d}`
      case 'created':
        return checklist.kind === 'change' ? `on the day it was recorded, ${d}` : `on the day of the request, ${d}`
      case 'offer_accepted':
        return `on acceptance, ${d}`
    }
  }
  const amount = `${n} ${unitWord(rule)} ${dir}`
  // taskDueOn moves a company target off a weekend or holiday (a legal deadline keeps its date): say so, or
  // '90 days after Mon Nov 2' would explain a date 91 days later.
  const moved = !task.statutory && dueDate(rule, anchor, holidays) !== computed ? ', moved to the next business day' : ''
  switch (rule.anchor) {
    case 'start':
      return `${amount} ${d}${moved}`
    case 'last_day':
      return `${amount} the last day, ${d}${moved}`
    case 'leave_start':
      return `${amount} the leave starts on ${d}${moved}`
    case 'created':
      return `${amount} ${created} on ${d}${moved}`
    case 'offer_accepted':
      return `${amount} acceptance on ${d}${moved}`
  }
}

/**
 * 'Due Thu Oct 22', or for an agency filing due on a weekend 'Due Sun Nov 8, file by Fri Nov 6'
 * (taskFileBy: never for final pay or other last-day tasks), plus the explanation.
 */
export function dueLine(db: DB, checklist: Checklist, task: ChecklistTask): { label: string; explain: string; full: string } {
  const by = taskFileBy(task, checklist, holidayDates(db))
  const label = by ? `Due ${dayLabel(task.dueOn)}, file by ${dayLabel(by)}` : `Due ${dayLabel(task.dueOn)}`
  const explain = dueExplanation(db, checklist, task)
  return { label, explain, full: explain ? `${task.title} ${label.toLowerCase()} (${explain})` : `${task.title} ${label.toLowerCase()}` }
}

const SHORT_TASK: Record<string, string> = {
  'on-piia': 'PIIA',
  'on-background-check': 'background check',
  'on-payroll-invite': 'payroll invite',
  'on-laptop': 'laptop',
  'on-accounts': 'accounts',
  'on-welcome': 'welcome email',
  'on-new-state': 'new-state setup',
  'on-i9-section1': 'I-9 section 1',
  'on-w4-de4': 'W-4 and DE 4',
  'on-w4-state': 'W-4',
  'on-sign-on-bonus': 'sign-on bonus',
  'on-i9-section2': 'I-9 section 2',
  'on-de34': 'DE 34',
  'on-state-new-hire-report': 'new hire report',
  'on-notice-aca': 'ACA notice',
  'on-security-training': 'security training',
  'on-production-access': 'production access',
  'on-checkin-30': '30-day check-in',
  'on-checkin-90': '90-day check-in',
  'on-harassment-training': 'harassment training',
  'on-harassment-training-supervisor': 'harassment training',
  'on-harassment-training-short-term': 'harassment training',
  'on-emergency-contacts': 'emergency contacts',
  'on-ack-handbook': 'handbook acknowledgement',
  'on-ack-security': 'security policy acknowledgement',
  'on-equity-board': 'board consent',
  'off-equipment': 'laptop return',
  'off-access': 'access revoked',
  'off-cobra': 'COBRA',
  'off-final-pay-termination': 'final pay',
  'off-final-pay-contract-end': 'final pay',
  'off-final-pay-notice': 'final pay',
  'off-final-pay-72h': 'final pay',
  'off-vacation-payout': 'vacation payout',
  'off-exit-note': 'exit note',
  'off-separation-notices': 'separation notices',
  'off-separation-notices-optional': 'DE 2320',
  'off-hipp': 'HIPP notice',
  'off-reassign-reports': 'reports reassigned',
  'lv-designation': 'designation notice',
  'lv-return': 'return-to-work check',
  'lv-coverage': 'coverage plan',
  'ch-payroll': 'payroll update',
  'ch-wage-notice': 'wage change notice',
}

/** Short name for a task in one-line summaries: 'DE 34', 'laptop return'. */
export function shortTaskLabel(task: Pick<ChecklistTask, 'templateTaskId' | 'title'>): string {
  const s = task.templateTaskId ? SHORT_TASK[task.templateTaskId] : undefined
  if (s) return s
  return task.title.charAt(0).toLowerCase() + task.title.slice(1)
}

export type InFlightSummary = {
  done: number
  total: number
  /** 'pre-start 3 of 7, starts in 10 days', '12 of 14, DE 34 overdue', '9 of 10, laptop return open' */
  text: string
  statutoryOverdue: boolean
  dayOneReady: boolean
  incoming: boolean
}

/** One-line status for Home's checklists in flight. */
export function inFlightSummary(checklist: Checklist, tasks: ChecklistTask[], startDate: ISODate | undefined, date: ISODate): InFlightSummary {
  const counted = tasks.filter((t) => t.status !== 'not_applicable')
  const done = counted.filter((t) => t.status === 'done').length
  const open = counted.filter((t) => t.status === 'open').sort((a, b) => a.dueOn.localeCompare(b.dueOn))
  const overdue = open.filter((t) => t.dueOn < date).sort((a, b) => Number(b.statutory) - Number(a.statutory) || a.dueOn.localeCompare(b.dueOn))
  const incoming = checklist.kind === 'onboarding' && checklist.anchorDate > date
  const pre = counted.filter((t) => t.dueOn < checklist.anchorDate)
  const preDone = pre.filter((t) => t.status === 'done').length
  const dayOneReady = (checklist.kind === 'onboarding' || checklist.kind === 'new_state') && pre.length > 0 && preDone === pre.length
  const parts: string[] = []
  if (incoming) parts.push(`pre-start ${preDone} of ${pre.length}`)
  else parts.push(`${done} of ${counted.length}`)
  if (incoming && startDate) parts.push(startsInText(startDate, date))
  const statutory = overdue.filter((t) => t.statutory)
  if (statutory.length) {
    const more = overdue.length - 1
    parts.push(`${shortTaskLabel(statutory[0])} overdue${more > 0 ? `, ${more} more overdue` : ''}`)
  } else if (!incoming && open.length > 0 && open.length <= 2) {
    parts.push(`${open.map(shortTaskLabel).join(' and ')} open`)
  } else if (overdue.length) {
    parts.push(`${shortTaskLabel(overdue[0])} overdue${overdue.length > 1 ? `, ${overdue.length - 1} more overdue` : ''}`)
  } else if (!incoming && open[0]) {
    parts.push(`next: ${shortTaskLabel(open[0])} ${dayLabel(open[0].dueOn)}`)
  }
  return { done, total: counted.length, text: parts.join(', '), statutoryOverdue: statutory.length > 0, dayOneReady, incoming }
}

// ---------------------------------------------------------------------------------------------
// Who can see and act on checklist tasks
// ---------------------------------------------------------------------------------------------

export function canSeeChecklist(v: Viewer, db: DB, checklist: Pick<Checklist, 'personId'>): boolean {
  return canSeePerson(v, db, checklist.personId, 'checklists')
}

/**
 * Tasks the viewer may see on a checklist. Leave checklists stay private: a manager sees only the
 * manager-owned tasks (coverage plan, return to work), never the notices that hint at the type.
 */
export function visibleTasks(v: Viewer, db: DB, checklist: Checklist): ChecklistTask[] {
  if (!canSeeChecklist(v, db, checklist)) return []
  if (checklist.kind === 'leave' && v.role !== 'admin' && v.personId !== checklist.personId) {
    return checklist.tasks.filter((t) => t.ownerRole === 'manager')
  }
  return checklist.tasks
}

/**
 * The tasks a viewer sees on a checklist (open tasks made moot by an exit left out) and the progress
 * over just those tasks, so a manager's view of a leave checklist counts only what they can see.
 */
export function checklistStats(v: Viewer, db: DB, checklist: Checklist, date: ISODate): { tasks: ChecklistTask[]; progress: ChecklistProgress } {
  const person = db.people.find((p) => p.id === checklist.personId)
  const tasks = visibleTasks(v, db, checklist).filter((t) => !(t.status === 'open' && mootAfterExit(checklist, t, person)))
  return { tasks, progress: checklistProgress({ ...checklist, tasks }, date) }
}

/** Admin acts on anything; managers on manager tasks for their reporting line; employees on their own tasks. */
export function canActOnTask(v: Viewer, db: DB, checklist: Checklist, task: ChecklistTask): boolean {
  if (v.role === 'admin') return true
  if (!v.personId) return false
  if (task.assigneeId && task.assigneeId === v.personId) return true
  if (v.role === 'manager' && task.ownerRole === 'manager') {
    return !task.assigneeId && isInReportingLine(v, db, checklist.personId)
  }
  if (task.ownerRole === 'employee' && checklist.personId === v.personId && !task.assigneeId) return true
  return false
}

/**
 * Tasks the viewer owns (the checklist's Mine filter), which is narrower than what they may act on:
 * an assigned person owns their task; Admin owns admin tasks and unassigned IT tasks (as in the inbox); the
 * person's own manager owns manager tasks; the person owns their own new-hire tasks.
 */
export function isMyTask(v: Viewer, db: DB, checklist: Checklist, task: ChecklistTask): boolean {
  if (task.assigneeId) return !!v.personId && task.assigneeId === v.personId
  switch (task.ownerRole) {
    // An IT task nobody is assigned is Admin's, as the inbox routes it (taskOwnerId): a small company has no IT
    // role, and leaving it out made Mine miss work only Admin can do.
    case 'admin':
    case 'it':
      return v.role === 'admin'
    case 'manager': {
      const person = db.people.find((p) => p.id === checklist.personId)
      return !!v.personId && person?.managerId === v.personId
    }
    case 'employee':
      return !!v.personId && checklist.personId === v.personId
    default:
      return false
  }
}

// ---------------------------------------------------------------------------------------------
// AB5 (California ABC test, Labor Code 2775) and contractor paperwork
// ---------------------------------------------------------------------------------------------

export type Ab5Outcome = 'likely_ok' | 'review' | 'likely_employee' | 'incomplete'

export const AB5_LABEL: Record<Ab5Outcome, string> = {
  likely_ok: 'Likely OK',
  review: 'Review',
  likely_employee: 'Likely employee',
  incomplete: 'Check not finished',
}

export const AB5_EXEMPTION_LABEL: Record<Ab5Exemption, string> = {
  b2b: 'Business-to-business',
  professional_services: 'Professional services',
  none: 'None',
}

export const AB5_PRONGS = {
  a: {
    title: 'A. Free from our control',
    question: 'Do they decide how, when and where the work gets done?',
    example: 'Yes: they set their own hours and methods. No: we set their schedule, tools or step-by-step process.',
    pass: 'A passes: they control how, when and where the work is done.',
    fail: 'A fails: we direct how, when or where the work is done.',
  },
  b: {
    title: 'B. Outside our usual business',
    question: 'Is the work outside what the company normally sells or does?',
    example: 'Yes: a lawyer, a brand designer or a fractional CFO. No: building or reviewing the close agents we sell.',
    pass: 'B passes: the work is outside our usual course of business.',
    fail: 'B fails: the work is part of our core product or service.',
  },
  c: {
    title: 'C. Their own independent business',
    question: 'Do they run an established business doing this work for others?',
    example: 'Yes: their own firm, other clients, a website or business license. No: we are their only client.',
    pass: 'C passes: they run an independent business of the same kind.',
    fail: 'C fails: no independent business of their own doing this work.',
  },
} as const

export const AB5_CITATION = { label: 'Labor Code 2775 (ABC test)', url: 'https://www.labor.ca.gov/employmentstatus/abctest/' }

export type Ab5Result = { outcome: Ab5Outcome; reasons: string[]; askCounsel: boolean }

/**
 * Plain-language AB5 result. Without an exemption the ABC test needs all three prongs, so any failed
 * prong reads 'likely employee'. A claimed exemption (business-to-business, professional services)
 * means the older Borello test may decide instead, so failed prongs read 'review' with an
 * ask-counsel prompt. Not legal advice.
 */
export function ab5Result(ab5: Pick<Contractor['ab5'], 'exemption' | 'a' | 'b' | 'c'>): Ab5Result {
  const prongs = (['a', 'b', 'c'] as const).map((k) => ({ k, v: ab5[k] }))
  const reasons: string[] = []
  if (ab5.exemption === 'b2b') {
    reasons.push('Business-to-business exemption claimed: it only holds if every condition in Labor Code 2776 is met (their own business location, other clients, a written contract, their own rates).')
  } else if (ab5.exemption === 'professional_services') {
    reasons.push('Professional services exemption claimed (Labor Code 2778): confirm they set their own hours, have their own business location and use their own judgment.')
  }
  if (prongs.some((p) => p.v == null)) {
    return { outcome: 'incomplete', reasons: [...reasons, 'Answer A, B and C to see the result.'], askCounsel: false }
  }
  for (const p of prongs) {
    reasons.push(p.v ? AB5_PRONGS[p.k].pass : AB5_PRONGS[p.k].fail)
  }
  const failed = prongs.filter((p) => !p.v)
  if (failed.length === 0) return { outcome: 'likely_ok', reasons, askCounsel: false }
  if (ab5.exemption !== 'none') {
    reasons.push('With an exemption, the older Borello test may decide instead of ABC. Ask counsel before relying on it.')
    return { outcome: 'review', reasons, askCounsel: true }
  }
  reasons.push(
    failed.length === 1
      ? 'California presumes an employee unless all three prongs pass.'
      : `${failed.length} prongs fail, and California presumes an employee unless all three pass.`,
  )
  return { outcome: 'likely_employee', reasons, askCounsel: true }
}

export const DE542_CITATION = { label: 'EDD DE 542', url: 'https://edd.ca.gov/en/payroll_taxes/independent_contractor_reporting/' }
export const FORM_1099_CITATION = { label: 'IRS 1099-NEC', url: 'https://www.irs.gov/instructions/i1099mec' }

export type De542Status =
  | { state: 'not_needed'; text: string }
  | { state: 'filed'; filedOn: ISODate; text: string }
  | { state: 'due'; dueOn: ISODate; overdue: boolean; text: string }

/**
 * EDD DE 542: individual contractors (not LLCs or corporations) paid or contracted for $600 or more
 * in a year, reported within 20 days of the contract or first payment (counted from the start date).
 */
export function de542Status(db: DB, c: Contractor, date: ISODate): De542Status {
  if (c.kind === 'advisor' && c.rate === 0) return { state: 'not_needed', text: 'Not needed: paid in options only' }
  if (c.entityType !== 'individual') return { state: 'not_needed', text: `Not needed: ${c.entityType === 'llc' ? 'an LLC' : 'a corporation'}` }
  if (c.de542FiledOn) return { state: 'filed', filedOn: c.de542FiledOn, text: 'Filed' }
  const year = Number(c.startOn.slice(0, 4))
  const threshold = db.settings.law.de542Threshold
  if (estimatePaidInYear(c, year) < threshold && estimatePaidInYear(c, Number(date.slice(0, 4))) < threshold) {
    return { state: 'not_needed', text: `Not needed yet: under $${threshold} this year` }
  }
  const dueOn = addDays(c.startOn, 20)
  return { state: 'due', dueOn, overdue: dueOn < date, text: dueOn < date ? 'Overdue' : 'Due' }
}

export type Form1099Flag = { needed: boolean; year: number; estimate: number; threshold: number; dueOn: ISODate }

/** 1099-NEC for payments this calendar year: estimated pay at or above the threshold, not a corporation. */
export function form1099Flag(db: DB, c: Contractor, date: ISODate): Form1099Flag {
  const year = Number(date.slice(0, 4))
  const estimate = c.entityType === 'corporation' ? 0 : estimatePaidInYear(c, year)
  const threshold = form1099ThresholdFor(db, year)
  return { needed: estimate >= threshold, year, estimate, threshold, dueOn: nextBusinessDay(`${year + 1}-01-31`) }
}

export type EndReminder = { kind: 'none' | 'soon' | 'ended' | 'future' | 'not_started'; days?: number; text: string }

export function endReminder(c: Pick<Contractor, 'startOn' | 'endOn'>, date: ISODate): EndReminder {
  if (c.startOn > date) return { kind: 'not_started', text: `Starts ${dayLabel(c.startOn)}` }
  if (!c.endOn) return { kind: 'none', text: 'No end date' }
  const days = daysBetween(date, c.endOn)
  if (days < 0) return { kind: 'ended', days, text: `Ended ${dayLabel(c.endOn)}` }
  if (days <= 30) return { kind: 'soon', days, text: days === 0 ? 'Ends today' : `Ends in ${days} ${days === 1 ? 'day' : 'days'}` }
  return { kind: 'future', days, text: `Ends ${dayLabel(c.endOn)}` }
}

export function rateLabel(c: Pick<Contractor, 'rate' | 'rateUnit' | 'kind'>): string {
  if (c.kind === 'advisor' && c.rate === 0) return 'Options only'
  const amount = `$${c.rate.toLocaleString('en-US')}`
  return c.rateUnit === 'hour' ? `${amount} an hour` : c.rateUnit === 'month' ? `${amount} a month` : `${amount} for the project`
}

/** Splits 'Marisol Vega' into first and last name for the Convert to employee prefill. */
export function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: '', last: '' }
  if (parts.length === 1) return { first: parts[0], last: '' }
  const cleaned = parts[0].replace(/\.$/, '').toLowerCase() === 'dr' ? parts.slice(1) : parts
  return { first: cleaned[0] ?? '', last: cleaned.slice(1).join(' ') }
}

const SCOPE_VERB_TITLE: Record<string, string> = {
  advises: 'advisor',
  analyzes: 'analyst',
  audits: 'auditor',
  builds: 'builder',
  consults: 'consultant',
  coordinates: 'coordinator',
  designs: 'designer',
  develops: 'developer',
  edits: 'editor',
  engineers: 'engineer',
  handles: 'specialist',
  labels: 'labeler',
  leads: 'lead',
  maintains: 'maintainer',
  manages: 'manager',
  operates: 'operator',
  plans: 'planner',
  prepares: 'preparer',
  recruits: 'recruiter',
  reviews: 'reviewer',
  tests: 'tester',
  trains: 'trainer',
  writes: 'writer',
}

function singular(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y')
  if (/[^s]s$/i.test(word)) return word.slice(0, -1)
  return word
}

/**
 * A job title guess from a contractor's scope, for the Convert to employee prefill (always editable):
 * 'Fractional CFO: monthly close review' -> 'Fractional CFO'; 'Reviews close-agent outputs and labels
 * data' -> 'Close-agent output reviewer'; otherwise the first clause.
 */
export function titleFromScope(scope: string): string {
  const s = scope.trim().replace(/\s+/g, ' ')
  if (!s) return ''
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1)
  const colon = s.indexOf(':')
  if (colon > 0 && colon <= 40) return cap(s.slice(0, colon).trim())
  const clause = s.split(/,|;|\.(?:\s|$)| and | for | to | with /)[0].trim()
  const words = clause.split(' ')
  const noun = SCOPE_VERB_TITLE[words[0].toLowerCase()]
  if (noun && words.length >= 2) {
    const object = words.slice(1)
    object[object.length - 1] = singular(object[object.length - 1])
    const title = `${cap(object.join(' '))} ${noun}`
    if (title.length <= 60) return title
  }
  return cap(clause.length <= 60 ? clause : `${clause.slice(0, 57).trimEnd()}...`)
}

/** The employee a contractor was converted to, when that record still exists. */
export function convertedPerson(db: Pick<DB, 'people'>, c: Pick<Contractor, 'convertedToPersonId'>): Person | undefined {
  return c.convertedToPersonId ? db.people.find((p) => p.id === c.convertedToPersonId) : undefined
}

// ---------------------------------------------------------------------------------------------
// Field limits (sync takes at most MAX_RECORD_BYTES per record)
// ---------------------------------------------------------------------------------------------

/** The longest one-line field the People forms take (names, a reason, a task note); pasted text is cut there. */
export const LINE_MAX_CHARS = 300

/** The longest link (evidence, document links). */
export const LINK_MAX_CHARS = 2_000

/** The longest scope of work a contractor or advisor takes (maxLength). It is meant to be a line or two. */
export const SCOPE_MAX_CHARS = 2_000

/** '1,850 of 2,000 characters' once a scope gets near the limit, else null. */
export function scopeCountText(scope: string): string | null {
  return scope.length >= SCOPE_MAX_CHARS * 0.9 ? `${scope.length.toLocaleString('en-US')} of ${SCOPE_MAX_CHARS.toLocaleString('en-US')} characters` : null
}

/** True when a contractor record is over what the server takes for one record, so it can never sync. */
export function contractorTooLarge(c: Contractor): boolean {
  return new TextEncoder().encode(JSON.stringify(c)).length > MAX_RECORD_BYTES
}

/**
 * Why a contractor cannot be saved for its size: a scope over SCOPE_MAX_CHARS, or a record too large to sync.
 * Pass `scopeChanged: false` when the scope was not edited, so an older long one does not block other edits
 * (the record check still applies).
 */
export function contractorSizeError(c: Contractor, opts: { scopeChanged?: boolean } = {}): string | undefined {
  if (opts.scopeChanged !== false && c.scope.length > SCOPE_MAX_CHARS) {
    return `A scope of work can be up to ${SCOPE_MAX_CHARS.toLocaleString('en-US')} characters. Shorten this one.`
  }
  if (contractorTooLarge(c)) return 'This contractor is too large to sync. Shorten the scope of work.'
  return undefined
}

/** A scope as a one-line summary for a page subtitle or a hint: the first line, cut to `max` characters. */
export function scopeSummary(scope: string, max = 160): string {
  const line = scope.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ')
  return line.length <= max ? line : `${line.slice(0, max - 3).trimEnd()}...`
}

// ---------------------------------------------------------------------------------------------
// Backfill job (the 'Backfill?' step after an exit)
// ---------------------------------------------------------------------------------------------

/** A backfill's target start: the Monday after the leaver's last week, plus six weeks to hire. */
export function backfillTargetStart(lastDay: ISODate): ISODate {
  return addDays(nextFriday(lastDay), 3 + 42)
}

export type BackfillPlan =
  /** A backfill line for this leaver already has a live (draft, open or on hold) job. */
  | { kind: 'live'; slot: PlanSlot; jobId: ID }
  /** A backfill line for this leaver exists without a live job: reopen it (a stale start moves to targetStart). */
  | { kind: 'reopen'; slot: PlanSlot; targetStart: ISODate }
  /** Add a new backfill line. The line the leaver filled stays filled, so their history and the budget variance keep it. */
  | { kind: 'add'; filled?: PlanSlot; targetStart: ISODate }

/**
 * Which plan line a backfill for this leaver uses. Never the line they filled: they still hold it until
 * the last day, and its quarter and target start belong to their own hire (reopening it made the new job
 * look late on day one). A backfill line made earlier is reused; its start moves out when it falls on or
 * before the last day (or today).
 */
export function backfillPlanFor(db: DB, personId: ID, lastDay: ISODate, date: ISODate): BackfillPlan {
  const fresh = backfillTargetStart(lastDay)
  const line = db.plan.find((s) => {
    if (s.backfillForPersonId !== personId) return false
    const st = planSlotStatus(db, s)
    return st !== 'filled' && st !== 'cut'
  })
  if (line) {
    const job = slotJob(db, line)
    if (job && (job.status === 'draft' || job.status === 'open' || job.status === 'on_hold')) return { kind: 'live', slot: line, jobId: job.id }
    const floor = lastDay > date ? lastDay : date
    return { kind: 'reopen', slot: line, targetStart: line.targetStart <= floor ? fresh : line.targetStart }
  }
  const filled = db.plan.find((s) => slotPerson(db, s)?.id === personId)
  return { kind: 'add', ...(filled ? { filled } : {}), targetStart: fresh }
}

/**
 * Readies the plan line for a backfill job (run inside a mutate recipe, then openJobFromPlan on the id):
 * re-dates a reused backfill line, or adds one from the leaver's current title, level and pay.
 */
export function prepareBackfillSlot(d: DB, personId: ID, lastDay: ISODate, date: ISODate): ID {
  const plan = backfillPlanFor(d, personId, lastDay, date)
  if (plan.kind === 'live') return plan.slot.id
  if (plan.kind === 'reopen') {
    const s = plan.slot
    if (s.targetStart !== plan.targetStart) {
      s.targetStart = plan.targetStart
      s.quarter = quarterOf(plan.targetStart)
    }
    return s.id
  }
  const person = d.people.find((p) => p.id === personId)
  if (!person) throw new Error(`No person with id ${personId}`)
  const rec = currentJob(d, personId, lastDay)
  const s: PlanSlot = {
    id: newId('ps'),
    quarter: quarterOf(plan.targetStart),
    title: person.title,
    departmentId: person.departmentId,
    familyId: person.familyId,
    levelId: person.levelId,
    targetStart: plan.targetStart,
    status: 'planned',
    isBackfill: true,
    backfillForPersonId: personId,
    jobId: null,
    personId: null,
    rationale: `Backfill for ${fullName(person)}`,
  }
  const base = rec?.salary ?? plan.filled?.budgetBase
  if (base) s.budgetBase = base
  d.plan.push(s)
  return s.id
}

export type BackfillJobSummary = { title: string; carried: string; next: string }

/**
 * What openJobFromPlan put on the backfill job and what is left before posting it, so the wizard's
 * confirmation names exactly that: a band fills the pay range, the role template (or the leaver's own
 * job) fills the stages, the interview plan without interviewers and the description outline.
 */
export function backfillJobSummary(job: Pick<Job, 'status' | 'payMin' | 'payMax' | 'stages' | 'interviewPlan' | 'description'>): BackfillJobSummary {
  const range = job.payMin != null && job.payMax != null
  const steps = job.interviewPlan.length
  const described = !!job.description.trim()
  const carried = ['title', 'level']
  if (range) carried.push('pay range from the band')
  if (job.stages.length) carried.push(`${job.stages.length} ${job.stages.length === 1 ? 'stage' : 'stages'}`)
  if (steps) carried.push(`a ${steps}-step interview plan`)
  if (described) carried.push('the description outline')
  const todo: string[] = []
  if (!range) todo.push('add the pay range')
  todo.push(steps ? 'pick the interviewers' : 'plan the interviews')
  if (!described) todo.push('write the description')
  const sentence = listJoin(carried)
  return {
    title: job.status === 'draft' ? 'Backfill job opened as a draft' : 'The backfill job is already live',
    carried: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)} carried over.`,
    next: `${listJoin(todo)}, then post it.`,
  }
}

// ---------------------------------------------------------------------------------------------
// Severance release (optional at an exit)
// ---------------------------------------------------------------------------------------------

export type ReleaseTerms = {
  /** Days to consider the agreement before signing (they may sign sooner). */
  considerDays: number
  considerUnit: 'business days' | 'days'
  /** Days to revoke after signing (0 = none). */
  revokeDays: number
  /** The federal ADEA applies (20+ employees for 20 weeks): everyone gets the OWBPA periods, so age is never needed. */
  adea: boolean
  group: boolean
}

/**
 * Review periods for a separation release. California (Gov Code 12964.5, SB 331) requires at least
 * 5 business days to consult an attorney. Once the ADEA applies, the OWBPA periods (21 days to
 * consider and 7 to revoke, 45 and 7 for a group program) go to everyone, so age is never recorded.
 */
export function releaseTerms(adea: boolean, group: boolean): ReleaseTerms {
  if (!adea) return { considerDays: 5, considerUnit: 'business days', revokeDays: 0, adea, group }
  return { considerDays: group ? 45 : 21, considerUnit: 'days', revokeDays: 7, adea, group }
}

/** Plain-text draft release for counsel to review: the review periods and the required statements, no amounts. */
export function releaseText(input: { company: string; name: string; lastDay: ISODate; terms: ReleaseTerms }): string {
  const { terms } = input
  const lines = [
    'Separation agreement and general release (draft for counsel to review)',
    '',
    `Company: ${input.company}`,
    `Employee: ${input.name}`,
    `Last day of employment: ${format(parseDate(input.lastDay), 'MMMM d, yyyy')}`,
    'Severance offered: [amount, payment timing and any benefits continuation]',
    '',
    `1. Time to consider. You have ${terms.considerDays} ${terms.considerUnit} from the day you receive this agreement to consider it. You may sign sooner if you choose.`,
    '2. Right to consult an attorney. You have the right to consult an attorney about this agreement, and we advise you to do so before signing.',
    '3. Unlawful acts in the workplace. Nothing in this agreement prevents you from discussing or disclosing information about unlawful acts in the workplace, such as harassment or discrimination or any other conduct that you have reason to believe is unlawful.',
    '4. Wages are not conditioned on this agreement. Your final pay, any accrued vacation owed and your vested options are yours whether or not you sign.',
  ]
  if (terms.adea) {
    lines.push(
      `5. Revocation. After you sign, you have ${terms.revokeDays} days to revoke this agreement in writing. It takes effect on the day after that period ends if you have not revoked it.`,
      '6. Age discrimination claims. This agreement includes a knowing and voluntary waiver of claims under the federal Age Discrimination in Employment Act. It does not waive claims that arise after you sign.',
    )
    if (terms.group) {
      lines.push(
        '7. Group program. Attach the written disclosure counsel prepares for a group program (the decisional unit, eligibility factors and time limits, and the job titles and ages of those selected and not selected). Prepare it outside this app.',
      )
    }
  }
  lines.push('', 'Employee signature and date: ______________________', 'Company signature and date: ______________________', '', 'Draft from First Twenty. Not legal advice; have counsel review before sending.')
  return lines.join('\n')
}
