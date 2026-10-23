// People helpers shared by every module. Headcount = W-2 employees (full time, part time and
// interns) employed on a date. Contractors never count. Each compliance rule can apply its own
// counting rule on top of this (see src/domain/compliance).
import type { DB, ID, Person, Role } from '@/domain/types'
import { format } from 'date-fns'
import { addDays, daysBetween, type ISODate, parseDate, today } from '@/lib/dates'

export function fullName(p: { firstName: string; lastName: string; preferredName?: string }): string {
  return `${p.preferredName || p.firstName} ${p.lastName}`
}

export function firstName(p: { firstName: string; preferredName?: string }): string {
  return p.preferredName || p.firstName
}

export function getPerson(db: DB, id: ID | null | undefined): Person | undefined {
  if (!id) return undefined
  return db.people.find((p) => p.id === id)
}

export function personNameById(db: DB, id: ID | null | undefined, fallback = 'Unknown'): string {
  const p = getPerson(db, id)
  return p ? fullName(p) : fallback
}

/** Employed on the date: started on/before it and has not passed their last day. */
export function isEmployedOn(p: Person, date: ISODate): boolean {
  if (p.startDate > date) return false
  if (p.endDate && p.endDate < date) return false
  return true
}

export type EmploymentState = 'incoming' | 'active' | 'on_leave' | 'former'

/** Pass `db` to detect people on a protected leave (leave cases). */
export function employmentState(p: Person, date: ISODate = today(), db?: DB): EmploymentState {
  if (p.startDate > date) return 'incoming'
  if (p.endDate && p.endDate < date) return 'former'
  if (db && onLeave(db, p.id, date)) return 'on_leave'
  return 'active'
}

export function onLeave(db: DB, personId: ID, date: ISODate = today()) {
  return db.leaveCases.find(
    (l) => l.personId === personId && l.startDate <= date && !l.returnedOn && (!l.expectedReturn || l.expectedReturn > date),
  )
}

/** People employed on the date (active or on leave). */
export function employedOn(db: DB, date: ISODate = today()): Person[] {
  return db.people.filter((p) => isEmployedOn(p, date))
}

export function headcountOn(db: DB, date: ISODate = today()): number {
  return employedOn(db, date).length
}

/** Accepted offers converted to people whose start date is after the date. */
export function incomingOn(db: DB, date: ISODate = today()): Person[] {
  return db.people.filter((p) => p.startDate > date && !p.endDate).sort((a, b) => a.startDate.localeCompare(b.startDate))
}

export function formerOn(db: DB, date: ISODate = today()): Person[] {
  return db.people.filter((p) => p.endDate && p.endDate < date)
}

/** Headcount change points (start dates and the day after last days) from founding to `to`. */
export function headcountSeries(db: DB, to: ISODate = today()): Array<{ date: ISODate; value: number }> {
  const events = new Set<ISODate>()
  for (const p of db.people) {
    if (p.startDate <= to) events.add(p.startDate)
    if (p.endDate && addDays(p.endDate, 1) <= to) events.add(addDays(p.endDate, 1))
  }
  const dates = [...events].sort()
  return dates.map((date) => ({ date, value: headcountOn(db, date) }))
}

export function directReports(db: DB, managerId: ID, date: ISODate = today()): Person[] {
  return db.people.filter((p) => p.managerId === managerId && (isEmployedOn(p, date) || p.startDate > date))
}

export function isPeopleManager(db: DB, id: ID, date: ISODate = today()): boolean {
  return directReports(db, id, date).length > 0
}

/** All people in a manager's reporting line (reports, their reports, ...). */
export function reportingLine(db: DB, managerId: ID, date: ISODate = today()): Person[] {
  const out: Person[] = []
  const queue = [managerId]
  const seen = new Set<ID>()
  while (queue.length) {
    const id = queue.shift() as ID
    if (seen.has(id)) continue
    seen.add(id)
    for (const r of directReports(db, id, date)) {
      out.push(r)
      queue.push(r.id)
    }
  }
  return out
}

export function founder(db: DB): Person | undefined {
  return db.people.find((p) => p.isFounder) ?? [...db.people].sort((a, b) => a.hireNumber - b.hireNumber)[0]
}

/**
 * The person a Viewing-as mode acts as. A saved person wins; otherwise Admin is the founder, Hiring
 * manager the first people manager, and Employee the newest individual contributor (the person most
 * likely to need self-service). Used by useViewer and as the actor on activity rows.
 */
export function viewerPerson(db: DB, role: Role, personId: ID | null | undefined): Person | undefined {
  const saved = getPerson(db, personId)
  if (saved) return saved
  if (role === 'admin') return founder(db)
  if (role === 'manager') return employedOn(db).find((p) => !p.isFounder && isPeopleManager(db, p.id)) ?? founder(db)
  const ics = employedOn(db).filter((p) => !p.isFounder && !isPeopleManager(db, p.id))
  return [...ics].sort((a, b) => b.startDate.localeCompare(a.startDate))[0] ?? founder(db)
}

export function departmentName(db: DB, id: ID | null | undefined): string {
  return db.departments.find((d) => d.id === id)?.name ?? ''
}

export function locationName(db: DB, id: ID | null | undefined): string {
  return db.locations.find((l) => l.id === id)?.name ?? ''
}

export function levelLabel(db: DB, id: ID | null | undefined): string {
  const l = db.levels.find((x) => x.id === id)
  return l ? `${l.code} ${l.name}` : ''
}

export function familyName(db: DB, id: ID | null | undefined): string {
  return db.families.find((f) => f.id === id)?.name ?? ''
}

/**
 * The person's earlier stint at the company when this record is a rehire: the explicit
 * rehireOfPersonId, else the most recent former record that ended before this start date with the same
 * personal email, or the same first and last name with no conflicting personal email.
 */
export function priorStint(db: Pick<DB, 'people'>, person: Pick<Person, 'id' | 'firstName' | 'lastName' | 'personalEmail' | 'startDate'> & { rehireOfPersonId?: ID }): Person | undefined {
  if (person.rehireOfPersonId) return db.people.find((p) => p.id === person.rehireOfPersonId)
  const email = person.personalEmail?.trim().toLowerCase()
  const name = `${person.firstName} ${person.lastName}`.trim().toLowerCase()
  return db.people
    .filter((p) => {
      if (p.id === person.id || !p.endDate || p.endDate >= person.startDate) return false
      const theirs = p.personalEmail?.trim().toLowerCase()
      if (email && theirs) return email === theirs
      return `${p.firstName} ${p.lastName}`.trim().toLowerCase() === name
    })
    .sort((a, b) => (b.endDate as string).localeCompare(a.endDate as string))[0]
}

/** Whole days someone was away between a last day and a new start date (Aug 28 to Oct 12 is 44 days away). */
export function daysAway(lastDay: ISODate, startDate: ISODate): number {
  return Math.max(0, daysBetween(lastDay, startDate) - 1)
}

/**
 * The first-day welcome email for a new hire from the 'welcome' template (Settings > Hiring > Email
 * templates), filled with the start date, time, place and manager. Null without a template.
 */
export function welcomeEmail(
  db: DB,
  personId: ID,
  opts: { senderId?: ID | null; startTime?: string } = {},
): { to: string; subject: string; body: string } | null {
  const person = db.people.find((p) => p.id === personId)
  const template = db.emailTemplates.find((t) => t.kind === 'welcome')
  if (!person || !template) return null
  const manager = person.managerId ? db.people.find((p) => p.id === person.managerId) : undefined
  const sender = (opts.senderId ? db.people.find((p) => p.id === opts.senderId) : undefined) ?? manager ?? founder(db)
  const loc = db.locations.find((l) => l.id === person.locationId)
  const hq = db.company.hq
  const where =
    person.workMode === 'remote'
      ? 'From home: a video link for the first meeting is on its way'
      : loc?.kind === 'hq'
        ? `${loc.name}${hq.street ? `, ${hq.street}, ${hq.city}` : `, ${hq.city}`}`
        : (loc?.name ?? hq.city)
  const fields: Record<string, string> = {
    firstName: person.preferredName || person.firstName,
    jobTitle: person.title,
    companyName: db.company.name,
    startDate: format(parseDate(person.startDate), 'EEEE, MMMM d'),
    startTime: opts.startTime ?? (person.workMode === 'remote' ? '9:30 AM Pacific' : '9:30 AM'),
    location: where,
    managerName: manager ? fullName(manager) : 'Your manager',
    senderName: sender ? fullName(sender) : db.company.name,
  }
  const fill = (s: string) => s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => fields[k] ?? '')
  return { to: person.personalEmail ?? person.workEmail, subject: fill(template.subject), body: fill(template.body) }
}

/** Employees whose home state differs from every company location state (multi-state payroll). */
export function outOfStatePeople(db: DB, date: ISODate = today()): Person[] {
  return employedOn(db, date).filter((p) => p.homeState !== 'CA')
}
