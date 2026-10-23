// "This week" on Home: starts, interviews, cliffs, anniversaries, offer expiries, leave dates, holidays
// and compliance deadlines, by day for the next 7 days, plus a short Coming up list. Pure: the date and
// the viewer are parameters. Who's out comes from the time off feature's WhosOutStrip, not from here.
// Scoping follows src/domain/access.ts: cliffs (share counts), compliance deadlines and leave types are
// Admin only; Hiring managers see interviews they are on or for jobs they manage, and their reports'
// leave dates without a type.
import { isInReportingLine } from '@/domain/access'
import { complianceCalendar } from '@/domain/compliance'
import { upcomingCliffs } from '@/domain/equity'
import { candidateName, pacificDateOf, stageById, zoneLabel } from '@/domain/hiring'
import { fullName, isEmployedOn } from '@/domain/people'
import type { DB, ID, Viewer } from '@/domain/types'
import { addDays, fmtDay, type ISODate, type ISODateTime, isWeekday } from '@/lib/dates'
import { links } from '@/app/router'

export type WeekEventKind = 'start' | 'interview' | 'anniversary' | 'cliff' | 'offer' | 'leave' | 'deadline' | 'holiday'

export type WeekEvent = {
  date: ISODate
  kind: WeekEventKind
  text: string
  href?: string
  /** Clock for interviews: '10:30 AM PT', plus the candidate's own time when they are elsewhere ('10:30 AM PT (1:30 PM ET)'). */
  time?: string
  /** Full timestamp, for ordering events within a day. */
  at?: ISODateTime
  /** Share count to show inside <Private> after the text (cliffs). */
  shares?: number
  /** Legal deadline (deadline events). */
  statutory?: boolean
  personId?: ID
}

export type WeekView = {
  days: Array<{ date: ISODate; events: WeekEvent[] }>
  comingUp: WeekEvent[]
}

export const WEEK_SPAN_DAYS = 7
export const COMING_UP_DAYS = 45
export const COMING_UP_MAX = 8

/** '10:30 AM PT' for an interview start. */
export function pacificTime(iso: ISODateTime): string {
  try {
    const t = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
    return `${t} PT`
  } catch {
    return ''
  }
}

/**
 * '10:30 AM PT (1:30 PM ET)': Pacific and the candidate's zone side by side (docs/SPEC.md, Delight). The
 * candidate's time is left off when they are on Pacific time or their zone is unknown; their weekday is
 * added when it is a different day there.
 */
export function dualTime(iso: ISODateTime, candidateTz?: string | null): string {
  const pt = pacificTime(iso)
  if (!candidateTz || !pt) return pt
  try {
    const label = zoneLabel(candidateTz, iso)
    if (label === 'PT') return pt
    const at = new Date(iso)
    const clock = new Intl.DateTimeFormat('en-US', { timeZone: candidateTz, hour: 'numeric', minute: '2-digit' }).format(at)
    const ymd = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
    const sameDay = ymd(candidateTz) === ymd('America/Los_Angeles')
    const weekday = sameDay ? '' : `${new Intl.DateTimeFormat('en-US', { timeZone: candidateTz, weekday: 'short' }).format(at)} `
    return `${pt} (${weekday}${clock} ${label})`
  } catch {
    return pt
  }
}

function years(from: ISODate, on: ISODate): number {
  return Number(on.slice(0, 4)) - Number(from.slice(0, 4))
}

const LEAVE_WORDS: Record<string, string> = { cfra: 'CFRA', pdl: 'pregnancy disability', bonding: 'bonding', military: 'military', other: '' }

/** Every event between from and to (inclusive) the viewer may see. */
export function weekEvents(db: DB, viewer: Viewer, from: ISODate, to: ISODate, opts: { scope?: 'admin' | 'manager' | 'personal' } = {}): WeekEvent[] {
  const scope = opts.scope ?? (viewer.role === 'admin' ? 'admin' : viewer.role === 'manager' ? 'manager' : 'personal')
  const me = viewer.personId
  const out: WeekEvent[] = []
  const inRange = (d: ISODate) => d >= from && d <= to

  // Starts (public: the directory shows start dates).
  for (const p of db.people) {
    if (!inRange(p.startDate)) continue
    out.push({ date: p.startDate, kind: 'start', text: `${fullName(p)} starts (#${p.hireNumber}, ${p.title})`, href: links.person(p.id), personId: p.id })
  }

  // Work anniversaries (they replace birthdays).
  for (const p of db.people) {
    if (p.endDate && p.endDate < from) continue
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (d.slice(5) !== p.startDate.slice(5)) continue
      const n = years(p.startDate, d)
      if (n < 1 || !isEmployedOn(p, d)) continue
      out.push({ date: d, kind: 'anniversary', text: `${fullName(p)}: ${n} ${n === 1 ? 'year' : 'years'} at ${db.company.name}`, href: links.person(p.id), personId: p.id })
    }
  }

  // Interviews: Admin sees all; others see the ones they are on, plus (managers) their jobs'.
  for (const i of db.interviews) {
    if (i.status !== 'scheduled') continue
    const day = pacificDateOf(i.startsAt)
    if (!inRange(day)) continue
    const app = db.applications.find((a) => a.id === i.applicationId)
    const job = app ? db.jobs.find((j) => j.id === app.jobId) : undefined
    const cand = app ? db.candidates.find((c) => c.id === app.candidateId) : undefined
    const onIt = !!me && i.interviewerIds.includes(me)
    const managesJob = scope === 'manager' && !!job && job.hiringManagerId === me
    if (scope !== 'admin' && !onIt && !managesJob) continue
    const stage = job && app ? stageById(job, app.stageId)?.name : undefined
    const what = (stage ?? i.name).toLowerCase()
    out.push({
      date: day,
      kind: 'interview',
      text: `${app ? candidateName(db, app.candidateId) : 'Candidate'} ${what}${job ? ` (${job.title})` : ''}${onIt && scope !== 'admin' ? ', you are on the panel' : ''}`,
      time: dualTime(i.startsAt, cand?.timezone),
      at: i.startsAt,
      href: app ? links.candidate(app.candidateId) : undefined,
    })
  }

  // Offer expiries (Admin, or the job's hiring manager).
  for (const o of db.offers) {
    if (o.status !== 'sent' || !inRange(o.expiresOn)) continue
    const job = db.jobs.find((j) => j.id === o.jobId)
    if (scope === 'personal' || (scope === 'manager' && job?.hiringManagerId !== me)) continue
    out.push({ date: o.expiresOn, kind: 'offer', text: `${candidateName(db, o.candidateId)}'s offer expires`, href: links.candidate(o.candidateId) })
  }

  // Leave starts and expected returns: type for Admin only; managers see their reporting line.
  for (const l of db.leaveCases) {
    if (l.endedOn) continue
    const p = db.people.find((x) => x.id === l.personId)
    if (!p) continue
    const visible = scope === 'admin' || (scope === 'manager' && isInReportingLine(viewer, db, p.id)) || p.id === me
    if (!visible) continue
    const kind = scope === 'admin' ? LEAVE_WORDS[l.kind] ?? '' : ''
    if (inRange(l.startDate)) out.push({ date: l.startDate, kind: 'leave', text: `${fullName(p)}'s ${kind ? `${kind} ` : ''}leave starts`, href: links.person(p.id), personId: p.id })
    if (l.expectedReturn && !l.returnedOn && inRange(l.expectedReturn)) {
      out.push({ date: l.expectedReturn, kind: 'leave', text: `${fullName(p)} is back from leave`, href: links.person(p.id), personId: p.id })
    }
  }

  // Cliffs (share counts are Admin only).
  if (scope === 'admin') {
    for (const c of upcomingCliffs(db, from, to)) {
      const p = db.people.find((x) => x.id === c.personId)
      const name = p ? fullName(p) : (db.contractors.find((x) => x.id === c.personId)?.name ?? 'Someone')
      out.push({
        date: c.date,
        kind: 'cliff',
        text: `${name} hits the 1-year cliff${c.awaitingBoard ? ' (grant awaiting board consent)' : ''}:`,
        shares: c.shares,
        href: p ? links.person(p.id, 'equity') : links.comp('equity'),
        personId: c.personId,
      })
    }
    // Compliance deadlines.
    for (const item of complianceCalendar(db, from, to)) {
      if (item.done) continue
      // An agency filing due on a weekend or holiday (the DE 1) names the business day to file by.
      const text = item.fileBy ? `${item.title}, file by ${fmtDay(item.fileBy)}` : item.title
      out.push({ date: item.date, kind: 'deadline', text, statutory: item.statutory, href: links.compliance('calendar'), personId: item.personId })
    }
  }

  // Company holidays.
  for (const h of db.holidays) {
    if (!inRange(h.date)) continue
    out.push({ date: h.date, kind: 'holiday', text: `Holiday: ${h.name}` })
  }

  const order: Record<WeekEventKind, number> = { holiday: 0, start: 1, leave: 2, interview: 3, offer: 4, deadline: 5, cliff: 6, anniversary: 7 }
  return out.sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || (a.at ?? '').localeCompare(b.at ?? '') || a.text.localeCompare(b.text))
}

/** The next 7 days by day (weekends only when something happens) and a short Coming up list. */
export function thisWeek(db: DB, viewer: Viewer, date: ISODate, opts: { scope?: 'admin' | 'manager' | 'personal' } = {}): WeekView {
  const end = addDays(date, WEEK_SPAN_DAYS - 1)
  const events = weekEvents(db, viewer, date, end, opts)
  const days: WeekView['days'] = []
  for (let d = date; d <= end; d = addDays(d, 1)) {
    const list = events.filter((e) => e.date === d)
    if (list.length || isWeekday(d)) days.push({ date: d, events: list })
  }
  // Coming up: the milestones worth seeing early, not every interview or anniversary.
  const later = weekEvents(db, viewer, addDays(end, 1), addDays(date, COMING_UP_DAYS), opts).filter(
    (e) => e.kind === 'start' || e.kind === 'leave' || e.kind === 'cliff' || e.kind === 'holiday' || (e.kind === 'deadline' && (e.statutory || /SOC 2|409A|1099/.test(e.text))),
  )
  return { days, comingUp: later.slice(0, COMING_UP_MAX) }
}
