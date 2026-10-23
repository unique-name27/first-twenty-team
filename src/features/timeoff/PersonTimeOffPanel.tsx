// A person's time off: balances (vacation and California sick leave separately), the as-needed types the
// company's size makes available, upcoming and past requests, and a leave case summary.
// Used by the profile Time off tab and by Me.
import { useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canApproveTimeOff, canSeePerson } from '@/domain/access'
import { firstName, fullName, headcountOn } from '@/domain/people'
import { type BalanceRow, balances, hoursPerDayFor, isConfidentialKind, vacationPayout } from '@/domain/timeoff'
import type { ID, LeaveCase, Person, TimeOffRequest, Viewer } from '@/domain/types'
import { fmtDate, fmtDay, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Badge, Button, Callout, EmptyState, Icon, IconButton, Menu, Money, Panel, SectionLabel } from '@/ui'
import { approveTimeOff, cancelTimeOff, copyRequestDates, declineTimeOff, downloadRequestICS, earlyWait, recordUnpaidTimeOff } from './actions'
import { designationState, hoursWithDays, leavePhase, leaveText, rangeText } from './logic'
import { LEAVE_LINKS, LegalNote, NoticeBadge, StatusBadge } from './parts'
import { RequestTimeOffSheet } from './RequestTimeOffSheet'

/** hideRequest: the host page already shows its own Request time off button (Me does, in its header). */
export function PersonTimeOffPanel({ personId, hideRequest = false }: { personId: ID; hideRequest?: boolean }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [requesting, setRequesting] = useState(false)
  const t = today()
  const person = db.people.find((p) => p.id === personId)
  if (!person) return <EmptyState icon="user" title="Person not found" compact />

  const self = viewer.personId === personId
  const canSee = canSeePerson(viewer, db, personId, 'timeoff')
  const canRequest = self || viewer.role === 'admin'
  const leaves = db.leaveCases.filter((l) => l.personId === personId).sort((a, b) => b.startDate.localeCompare(a.startDate))

  if (!canSee) return <PrivateTimeOff person={person} />

  // An alumnus's balances stay as they were on the last day: nothing is earned or used after it.
  const isFormer = !!person.endDate && person.endDate < t
  const asOf = isFormer && person.endDate ? person.endDate : t
  const rows = balances(db, personId, asOf)
  const tracked = rows.filter((r) => r.display !== 'per_event')
  const asNeeded = rows.filter((r) => r.display === 'per_event')
  const hpd = hoursPerDayFor(person)
  const requests = db.timeOffRequests.filter((r) => r.personId === personId)
  const upcoming = requests
    .filter((r) => (r.status === 'pending' || r.status === 'approved') && r.endDate >= t)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
  const past = requests.filter((r) => !upcoming.includes(r)).sort((a, b) => b.startDate.localeCompare(a.startDate))
  const openLeave = leaves.filter((l) => {
    const ph = leavePhase(l, t)
    return ph === 'upcoming' || ph === 'on_leave'
  })
  const sick = rows.find((r) => r.policy.kind === 'sick')

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={self ? 'My time off' : 'Time off'}
        icon="calendar"
        subtitle={
          isFormer
            ? `${firstName(person)} worked ${person.hoursPerWeek} hours a week. Balances as of the last day, ${fmtDate(asOf)}.`
            : `${self ? 'You work' : `${firstName(person)} works`} ${person.hoursPerWeek} hours a week, so a day off is ${hpd} hours.`
        }
        actions={
          canRequest && !isFormer && !hideRequest ? (
            <Button variant="primary" size="lg" icon="plus" onClick={() => setRequesting(true)}>
              {self ? 'Request time off' : `Record time off for ${firstName(person)}`}
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-4">
          {openLeave.map((l) => (
            <LeaveSummary key={l.id} leave={l} person={person} viewer={viewer} />
          ))}

          {tracked.length === 0 ? (
            <p className="text-[14px] text-ink-3">No tracked balances apply to {firstName(person)}.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {tracked.map((r) => (
                <BalanceCard key={r.policy.id} row={r} hpd={hpd} person={person} showPayout={viewer.role === 'admin'} ended={isFormer} />
              ))}
            </div>
          )}
          {!sick && person.homeState !== 'CA' && (
            <p className="text-[13px] text-ink-3">
              California sick leave covers people working in California. {firstName(person)} works from {person.homeState}; follow that state&apos;s sick leave rules through your PEO.
            </p>
          )}

          {asNeeded.length > 0 && (
            <div className="flex flex-col gap-2">
              <SectionLabel>Also available when needed</SectionLabel>
              <ul className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                {asNeeded.map((r) => (
                  <li key={r.policy.id} className="flex flex-col border-b border-line py-2 last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0">
                    <span className="flex flex-wrap items-center gap-2 font-semibold text-ink">
                      {r.policy.name}
                      {r.usableFrom && <Badge tone="neutral">From {fmtDate(r.usableFrom)}</Badge>}
                    </span>
                    <span className="text-[13px] text-ink-3">{asNeededNote(r)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-[12.5px] text-ink-3">
                Shown for a company of {headcountOn(db, t)}: bereavement and reproductive loss leave start at 5 employees, organ and bone marrow donor leave at 15. Jury duty and voting time apply at any size.
              </p>
              <LegalNote label="Gov Code 12945.6 and 12945.7" url="https://calcivilrights.ca.gov/family-medical-pregnancy-leave/" />
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Requests" icon="clock" padded={false}>
        <RequestList title="Coming up" rows={upcoming} viewer={viewer} empty={`No upcoming time off${self ? '' : ` for ${firstName(person)}`}.`} />
        <PastList rows={past} viewer={viewer} />
      </Panel>

      {leaves.filter((l) => !openLeave.includes(l)).length > 0 && (
        <Panel title="Past leave" icon="shield">
          <ul className="flex flex-col">
            {leaves
              .filter((l) => !openLeave.includes(l))
              .map((l) => (
                <li key={l.id} className="border-b border-line py-2 text-[14px] text-ink-2 last:border-b-0">
                  {leaveText(l, { type: canSeePerson(viewer, db, personId, 'leave'), line: true })}, from {fmtDay(l.startDate)}
                </li>
              ))}
          </ul>
        </Panel>
      )}

      <RequestTimeOffSheet open={requesting} onClose={() => setRequesting(false)} personId={personId} />
    </div>
  )
}

function asNeededNote(r: BalanceRow): string {
  const used = r.used + r.scheduled
  return used > 0 ? `${r.note} ${hoursWithDays(used)} used or planned this year.` : r.note
}

/**
 * One balance. `ended`: the person has left, so the card shows the balance at the last day. The payout line
 * follows the last day too: paid out at exit for an alumnus, at the last day for someone offboarding, and
 * 'if they left today' for everyone else.
 */
function BalanceCard({ row, hpd, person, showPayout, ended }: { row: BalanceRow; hpd: number; person: Person; showPayout: boolean; ended: boolean }) {
  const db = useDB((s) => s.db)
  const t = today()
  const flexible = row.display === 'flexible'
  const lastDay = person.endDate ?? undefined
  const payout = showPayout && row.policy.paidOutOnExit && row.policy.method === 'accrual' ? vacationPayout(db, person.id, lastDay ?? t) : null
  const payoutRow = payout?.rows.find((r) => r.policyId === row.policy.id)
  const before = row.startsOn
  const amount = before ? before.hours : (row.available ?? 0)
  const unit = before
    ? `hours on ${fmtDate(before.date)}${row.usableFrom && row.usableFrom > before.date ? `, usable from ${fmtDate(row.usableFrom)}` : ''}`
    : ended
      ? 'hours at the last day'
      : row.usableFrom
        ? `hours, usable from ${fmtDate(row.usableFrom)}`
        : 'hours available'
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2/50 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-display text-[15px] font-bold text-ink">{row.policy.name}</span>
        <span className="flex flex-wrap gap-1">
          {row.capReached && (
            <Badge tone="warn" icon="alert">
              At cap
            </Badge>
          )}
          {row.policy.autoApprove && !row.usableFrom && !ended && <Badge tone="outline">No approval needed</Badge>}
        </span>
      </div>
      {flexible ? (
        <p className="num font-display text-[26px] leading-none font-bold text-ink">Flexible</p>
      ) : (
        // Before the service wait ends the hours are granted but not yet usable, so they are not "available".
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="num font-display text-[28px] leading-none font-bold text-ink">{fmt(amount)}</span>
          <span className="text-[14px] font-semibold text-ink-2">{unit}</span>
          <span className="num text-[13px] text-ink-3">({daysText(amount / hpd)})</span>
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-4">
        {row.earned != null && !before && <Fact label={row.policy.method === 'frontload' ? 'Granted' : 'Earned'} value={row.earned} />}
        <Fact label="Used" value={row.used} />
        <Fact label="Scheduled" value={row.scheduled} />
        <Fact label="Pending" value={row.pending} />
      </dl>
      <p className="text-[12.5px] text-ink-3">{row.note}</p>
      {row.policy.kind === 'sick' && <LegalNote label={LEAVE_LINKS.sick.label} url={LEAVE_LINKS.sick.url} extra="Never paid out at exit; restored if rehired within 12 months." />}
      {payoutRow && payout && (
        <p className="text-[12.5px] text-ink-2">
          {ended ? (
            <>
              Paid out at exit, {fmtDate(payout.asOf)}: {fmt(payoutRow.hours)} hours, <Money value={Math.round(payoutRow.amount)} /> at the final rate.
            </>
          ) : lastDay ? (
            <>
              At the last day, {fmtDate(payout.asOf)}: {fmt(payoutRow.hours)} hours paid out, <Money value={Math.round(payoutRow.amount)} /> (counts what is earned through
              that day, less time off taken by then).
            </>
          ) : (
            <>
              If {firstName(person)} left today: {fmt(payoutRow.hours)} hours paid out, <Money value={Math.round(payoutRow.amount)} /> (counts this pay period so far, since vacation is
              earned as it is worked).
            </>
          )}{' '}
          Unused vacation is paid with the final paycheck (
          <a href={LEAVE_LINKS.payout.url} target="_blank" rel="noreferrer noopener" className="font-semibold text-accent underline">
            {LEAVE_LINKS.payout.label}
          </a>
          ).
        </p>
      )}
    </div>
  )
}

function fmt(n: number): string {
  return String(Math.round(n * 10) / 10)
}

function daysText(d: number): string {
  const n = Math.round(d * 10) / 10
  return `${n} ${n === 1 ? 'day' : 'days'}`
}

function Fact({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-ink-3">{label}</dt>
      <dd className="num font-semibold text-ink">{fmt(value)} h</dd>
    </div>
  )
}

function LeaveSummary({ leave, person, viewer }: { leave: LeaveCase; person: Person; viewer: Viewer }) {
  const db = useDB((s) => s.db)
  const t = today()
  const type = canSeePerson(viewer, db, person.id, 'leave')
  const phase = leavePhase(leave, t)
  const notice = designationState(leave, t)
  return (
    <Callout tone="accent" icon="shield" title={leaveText(leave, { type, line: true })}>
      <p>
        {phase === 'upcoming' ? 'Starts' : 'Started'} {fmtDay(leave.startDate)}
        {leave.expectedReturn ? `, expected back ${fmtDay(leave.expectedReturn)}` : ''}.
      </p>
      {viewer.role !== 'admin' && viewer.personId === person.id && leave.designationNoticeDueOn && !leave.designationNoticeSentOn && (
        <p className="mt-1 text-[13px]">Admin sends a response and designation notice by {fmtDay(leave.designationNoticeDueOn)}.</p>
      )}
      {viewer.role === 'admin' && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <span className="text-[13px]">Designation notice:</span>
          <NoticeBadge notice={notice} />
          {/* A link on its own: a 40px target in every look (its padding is taken back, so the row keeps its height). */}
          <a href={links.people('timeoff')} className="-my-2.5 inline-flex min-h-10 items-center text-[13px] font-semibold text-accent underline">
            Manage in Time off
          </a>
        </div>
      )}
      {type && (
        <p className="mt-1 text-[13px]">
          Pay during leave comes from state disability or paid family leave.{' '}
          <a href={LEAVE_LINKS.edd.url} target="_blank" rel="noreferrer noopener" className="font-semibold text-accent underline">
            Apply with EDD
          </a>
          .
        </p>
      )}
    </Callout>
  )
}

/**
 * Approve, Decline and Cancel change a row's status, so its buttons go away (or the row moves to Past).
 * Put keyboard focus on the same request's More actions button, wherever it now sits.
 */
function act(reqId: ID, run: () => void) {
  run()
  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(`[data-request-row="${reqId}"]`)
    if (row && row.contains(document.activeElement)) return
    row?.querySelector<HTMLElement>('[data-row-more]')?.focus()
  })
}

function RequestRow({ req, viewer }: { req: TimeOffRequest; viewer: Viewer }) {
  const db = useDB((s) => s.db)
  const t = today()
  const policy = db.timeOffPolicies.find((p) => p.id === req.policyId)
  const person = db.people.find((p) => p.id === req.personId)
  const self = viewer.personId === req.personId
  const typeName = policy ? (isConfidentialKind(policy.kind) && viewer.role !== 'admin' && !self ? 'Time off' : policy.name) : 'Time off'
  const canCancel = (self || viewer.role === 'admin') && (req.status === 'pending' || (req.status === 'approved' && req.startDate > t))
  // Sick leave waits only when it falls before the service wait: Admin waives it or records it as unpaid.
  const wait = earlyWait(db, req)
  const canDecide = req.status === 'pending' && (!policy?.autoApprove || !!wait) && canApproveTimeOff(viewer, db, req)
  const approver = req.approverId ? db.people.find((p) => p.id === req.approverId) : undefined
  const hpd = person ? hoursPerDayFor(person) : 8
  return (
    <li data-request-row={req.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">
          {typeName}
          <StatusBadge status={req.status} />
        </p>
        <p className="text-[13.5px] text-ink-2">
          {rangeText(req.startDate, req.endDate)}
          {req.partial ? ` (half day ${req.partial === 'am' ? 'morning' : 'afternoon'})` : ''} · {hoursWithDays(req.hours, hpd)}
        </p>
        <p className="text-[12.5px] text-ink-3">
          Requested {fmtDate(req.requestedOn)}
          {req.status === 'approved' && policy?.autoApprove && req.decisionNote === 'Approved automatically'
            ? '; approved automatically'
            : req.decidedOn && req.status !== 'pending'
              ? `; ${req.status} ${fmtDate(req.decidedOn)}${approver ? ` by ${fullName(approver)}` : ''}`
              : wait
                ? `; waits for Admin (before sick leave is usable on ${fmtDate(wait.usableFrom)})`
                : ''}
        </p>
        {/* Why a decision went the way it did: a waived wait, unpaid days, an exit that cancelled it. */}
        {req.decisionNote && req.decisionNote !== 'Approved automatically' && (self || viewer.role === 'admin') && (
          <p className="text-[12.5px] text-ink-3">{req.decisionNote.replace(/\.?$/, '.')}</p>
        )}
        {req.note && (self || viewer.role === 'admin' || canDecide) && <p className="mt-0.5 text-[13px] text-ink-2">&ldquo;{req.note}&rdquo;</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canDecide && wait && (
          <>
            <Button variant="primary" icon="check" onClick={() => act(req.id, () => approveTimeOff(req, viewer))}>
              Waive the wait
            </Button>
            <Button variant="secondary" onClick={() => act(req.id, () => recordUnpaidTimeOff(req, viewer))}>
              Record as unpaid
            </Button>
          </>
        )}
        {canDecide && !wait && (
          <>
            <Button variant="primary" icon="check" onClick={() => act(req.id, () => approveTimeOff(req, viewer))}>
              Approve
            </Button>
            <Button variant="secondary" onClick={() => act(req.id, () => declineTimeOff(req, viewer))}>
              Decline
            </Button>
          </>
        )}
        <Menu
          label={`Actions for ${rangeText(req.startDate, req.endDate)}`}
          trigger={(p) => <IconButton icon="more" label={`More actions for ${rangeText(req.startDate, req.endDate)}`} variant="ghost" data-row-more {...p} />}
          items={[
            ...(req.status === 'approved' || req.status === 'pending'
              ? [
                  { label: 'Download calendar file (.ics)', icon: 'download' as const, onSelect: () => downloadRequestICS(req) },
                  { label: 'Copy dates', icon: 'copy' as const, onSelect: () => void copyRequestDates(req) },
                ]
              : [{ label: 'Copy dates', icon: 'copy' as const, onSelect: () => void copyRequestDates(req) }]),
            ...(canCancel ? [{ divider: true as const }, { label: req.status === 'pending' ? 'Cancel request' : 'Cancel time off', icon: 'x' as const, danger: true, onSelect: () => act(req.id, () => cancelTimeOff(req, viewer)) }] : []),
          ]}
        />
      </div>
    </li>
  )
}

function RequestList({ title, rows, viewer, empty }: { title: string; rows: TimeOffRequest[]; viewer: Viewer; empty: string }) {
  return (
    <div>
      <div className="px-5 pt-3 pb-1">
        <SectionLabel>{title}</SectionLabel>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 pb-3 text-[14px] text-ink-3">{empty}</p>
      ) : (
        <ul>
          {rows.map((r) => (
            <RequestRow key={r.id} req={r} viewer={viewer} />
          ))}
        </ul>
      )}
    </div>
  )
}

function PastList({ rows, viewer }: { rows: TimeOffRequest[]; viewer: Viewer }) {
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, 5)
  return (
    <div className="border-t border-line">
      <RequestList title="Past" rows={shown} viewer={viewer} empty="Nothing yet." />
      {rows.length > 5 && (
        <div className="px-5 pb-3">
          <Button variant="ghost" icon={all ? 'chevron-up' : 'chevron-down'} onClick={() => setAll((a) => !a)}>
            {all ? 'Show fewer' : `Show all ${rows.length}`}
          </Button>
        </div>
      )}
    </div>
  )
}

/** For viewers outside the person's line: only approved days out, shown as "Out". */
function PrivateTimeOff({ person }: { person: Person }) {
  const db = useDB((s) => s.db)
  const t = today()
  const out = db.timeOffRequests
    .filter((r) => r.personId === person.id && r.status === 'approved' && r.endDate >= t)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .slice(0, 5)
  const leave = db.leaveCases.find((l) => l.personId === person.id && (leavePhase(l, t) === 'on_leave' || leavePhase(l, t) === 'upcoming'))
  return (
    <Panel title="Time off" icon="lock">
      <p className="text-[14px] text-ink-2">
        Time off details are private to {firstName(person)}, their manager and Admin. Here is only when they are out.
      </p>
      {out.length === 0 && !leave ? (
        <p className="mt-2 flex items-center gap-2 text-[14px] text-ink-3">
          <Icon name="calendar-check" size={16} />
          No upcoming days out.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col">
          {leave && <li className="border-b border-line py-2 text-[14px] text-ink last:border-b-0">Out from {fmtDay(leave.startDate)}</li>}
          {out.map((r) => (
            <li key={r.id} className="border-b border-line py-2 text-[14px] text-ink last:border-b-0">
              Out {rangeText(r.startDate, r.endDate)}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
