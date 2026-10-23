// People > Time off: summary, who's-out calendar, requests to approve, balances, leave cases (Admin) and
// holidays. Every block follows the Viewing-as rules in src/domain/access.ts.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canApproveTimeOff, canSeePerson, canSeeTimeOffDetail } from '@/domain/access'
import { TASK_IDS } from '@/domain/checklists/templates'
import { leaveEligibility } from '@/domain/lifecycle'
import { employedOn, firstName, fullName, reportingLine } from '@/domain/people'
import { type BalanceRow, balances, hoursPerDayFor, isConfidentialKind, pendingApprovals, whoIsOut } from '@/domain/timeoff'
import type { DB, LeaveCase, Person, TimeOffRequest, Viewer } from '@/domain/types'
import { fmtDate, fmtDay, fmtRelative, fmtShort, isWeekday, today } from '@/lib/dates'
import { copyText, downloadFile, toCSV } from '@/lib/files'
import { hoursWithDays, listJoin, plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { Badge, Button, type Column, DataTable, DescriptionList, EmptyState, Icon, Panel, Segmented, toast } from '@/ui'
import { approveTimeOff, cancelTimeOff, declineTimeOff, earlyWait, markBack, markNoticeSent, recordUnpaidTimeOff } from './actions'
import {
  approvalGroups,
  designationState,
  entryView,
  holidaysForYear,
  holidaysICS,
  holidaysText,
  LEAVE_KIND_LABEL,
  leavePhase,
  leaveText,
  rangeText,
  shortRange,
} from './logic'
import { LEAVE_LINKS, LegalNote, NoticeBadge, PersonName, StatusBadge } from './parts'
import { RequestTimeOffSheet } from './RequestTimeOffSheet'
import { StartLeaveSheet } from './StartLeaveSheet'
import { TimeOffCalendar } from './TimeOffCalendar'

/** People > Time off tab: who's out calendar, requests to approve, balances, leave cases, holidays. */
export function TimeOffTab() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [requestFor, setRequestFor] = useState<{ personId: string; pick: boolean } | null>(null)
  const [startingLeave, setStartingLeave] = useState(false)
  const isAdmin = viewer.role === 'admin'

  return (
    <div className="flex flex-col gap-5">
      <Summary
        db={db}
        viewer={viewer}
        onRequest={() => viewer.personId && setRequestFor({ personId: viewer.personId, pick: false })}
        onRecord={() => viewer.personId && setRequestFor({ personId: viewer.personId, pick: true })}
        onStartLeave={() => setStartingLeave(true)}
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Panel title="Who's out" icon="calendar" className="xl:col-span-2" subtitle={viewer.role === 'employee' ? 'Shows only "Out" for other people.' : undefined}>
          <TimeOffCalendar />
        </Panel>
        <RequestsPanel db={db} viewer={viewer} />
      </div>

      <BalancesPanel db={db} viewer={viewer} />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        {isAdmin ? (
          <LeaveCasesPanel db={db} viewer={viewer} onStart={() => setStartingLeave(true)} />
        ) : viewer.role === 'manager' ? (
          <OnLeavePanel db={db} viewer={viewer} />
        ) : null}
        <HolidaysPanel db={db} wide={viewer.role === 'employee'} />
      </div>

      {requestFor && <RequestTimeOffSheet open onClose={() => setRequestFor(null)} personId={requestFor.personId} allowPersonPick={requestFor.pick} />}
      <StartLeaveSheet open={startingLeave} onClose={() => setStartingLeave(false)} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------------------------

function Summary({ db, viewer, onRequest, onRecord, onStartLeave }: { db: DB; viewer: Viewer; onRequest: () => void; onRecord: () => void; onStartLeave: () => void }) {
  const t = today()
  const isAdmin = viewer.role === 'admin'
  const outToday = whoIsOut(db, t, t).filter((e) => e.status !== 'pending' && entryView(db, viewer, e).visible)
  const names = [...new Set(outToday.map((e) => e.personId))].map((id) => db.people.find((p) => p.id === id)).filter((p): p is Person => !!p)
  // Only what waits on the viewer: another manager's approvals are theirs (Admin sees them under the requests).
  const waiting = approvalGroups(db, viewer, pendingApprovals(db).filter((r) => canApproveTimeOff(viewer, db, r)), t)[0].requests
  const nextHoliday = [...db.holidays].filter((h) => h.date >= t).sort((a, b) => a.date.localeCompare(b.date))[0]
  const noticesDue = isAdmin ? db.leaveCases.filter((l) => !l.designationNoticeSentOn && l.designationNoticeDueOn) : []
  const isWeekend = !isWeekday(t)
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-surface px-5 py-4 shadow-card">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:flex lg:flex-wrap">
        <Fact
          label="Out today"
          value={isWeekend ? 'Weekend' : names.length === 0 ? 'Nobody' : listJoin(names.map((p) => firstName(p)))}
        />
        {viewer.role !== 'employee' && (
          <Fact label="Waiting for you" value={waiting.length === 0 ? 'Nothing to approve' : plural(waiting.length, 'request')} tone={waiting.length ? 'warn' : undefined} />
        )}
        {isAdmin && (
          <Fact
            label="Leave notices"
            value={
              noticesDue.length === 0
                ? 'All sent'
                : noticesDue.length === 1
                  ? `${firstName(db.people.find((p) => p.id === noticesDue[0].personId) ?? { firstName: 'One' })}'s due ${fmtDay(noticesDue[0].designationNoticeDueOn)}`
                  : `${noticesDue.length} due, first ${fmtDay(noticesDue.map((l) => l.designationNoticeDueOn as string).sort()[0])}`
            }
            tone={noticesDue.some((l) => (l.designationNoticeDueOn as string) < t) ? 'bad' : noticesDue.length ? 'warn' : undefined}
          />
        )}
        {nextHoliday && <Fact label="Next holiday" value={`${nextHoliday.name}, ${fmtDay(nextHoliday.date)}`} />}
      </dl>
      <div className="flex flex-wrap gap-2">
        {viewer.personId && (
          <Button variant="primary" size="lg" icon="plus" onClick={onRequest}>
            Request time off
          </Button>
        )}
        {isAdmin && (
          <>
            <Button variant="secondary" size="lg" icon="user" onClick={onRecord}>
              Record for someone
            </Button>
            <Button variant="secondary" size="lg" icon="shield" onClick={onStartLeave}>
              Start a leave case
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'bad' }) {
  return (
    <div className="ft-ministat min-w-0">
      <dt className="ft-ministat__label text-[12.5px] font-semibold text-ink-3">{label}</dt>
      <dd className={`ft-ministat__value text-[15px] font-bold ${tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-ink'}`}>{value}</dd>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

function typeFor(db: DB, viewer: Viewer, req: TimeOffRequest): string {
  const policy = db.timeOffPolicies.find((p) => p.id === req.policyId)
  if (!policy) return 'Time off'
  if (isConfidentialKind(policy.kind) && viewer.role !== 'admin' && viewer.personId !== req.personId) return 'Time off'
  return policy.name
}

function RequestsPanel({ db, viewer }: { db: DB; viewer: Viewer }) {
  // Grouped by who approves, as the inbox routes them; one flat list keeps the focus handling below simple.
  const groups = approvalGroups(db, viewer, pendingApprovals(db).filter((r) => canApproveTimeOff(viewer, db, r)), today())
  const waiting = groups.flatMap((g) => g.requests)
  const mine = db.timeOffRequests.filter((r) => r.personId === viewer.personId && r.status === 'pending' && !waiting.includes(r))
  const auto = new Set(db.timeOffPolicies.filter((p) => p.autoApprove).map((p) => p.id))
  const recent = db.timeOffRequests
    .filter((r) => r.status !== 'pending' && r.decidedOn && !auto.has(r.policyId) && canSeeTimeOffDetail(viewer, db, r))
    .sort((a, b) => (b.decidedOn as string).localeCompare(a.decidedOn as string) || b.startDate.localeCompare(a.startDate))
    .slice(0, 5)
  const approver = viewer.role !== 'employee'

  // Approve, Decline and Cancel remove their row. Keep keyboard focus in the list: the next row's button
  // (the row that took its place), else the previous row's, else the section heading.
  const waitingRef = useRef<HTMLElement>(null)
  const mineRef = useRef<HTMLElement>(null)
  const recentRef = useRef<HTMLHeadingElement>(null)
  const pendingFocus = useRef<{ list: 'waiting' | 'mine'; index: number } | null>(null)
  const keys = `${waiting.map((r) => r.id).join('|')}/${mine.map((r) => r.id).join('|')}`
  useEffect(() => {
    const want = pendingFocus.current
    if (!want) return
    pendingFocus.current = null
    const section = want.list === 'waiting' ? waitingRef.current : mineRef.current
    const buttons = Array.from(section?.querySelectorAll<HTMLElement>('[data-row-primary]') ?? [])
    const target = buttons[Math.min(want.index, buttons.length - 1)] ?? section?.querySelector<HTMLElement>('h3') ?? recentRef.current
    target?.focus()
  }, [keys])
  const decide = (list: 'waiting' | 'mine', index: number, run: () => void) => {
    pendingFocus.current = { list, index }
    run()
  }

  return (
    <Panel title="Requests" icon="inbox" padded={false} subtitle={approver ? 'Approve or decline in one tap. Undo is in the toast.' : undefined}>
      {approver && (
        <section ref={waitingRef} aria-label="Requests to approve" className="border-b border-line">
          {groups.map((g, gi) => {
            if (gi > 0 && g.requests.length === 0) return null
            const offset = groups.slice(0, gi).reduce((n, x) => n + x.requests.length, 0)
            // A fragment, not a wrapper: each group's heading and rows stay direct children of the section,
            // so the looks that run a section's lists flush with its label still reach them.
            return (
              <Fragment key={g.key}>
                <h3 tabIndex={-1} className="px-5 pt-3 text-[13px] font-bold text-ink-3 outline-none">
                  {g.label} ({g.requests.length})
                </h3>
                {g.requests.length === 0 ? (
                  <p className="flex items-center gap-2 px-5 pt-1 pb-4 text-[14px] text-ink-3">
                    <Icon name="check" size={16} className="text-good" />
                    {waiting.length === 0 ? 'Nothing to approve.' : 'Nothing waits on you.'}
                  </p>
                ) : (
                  <ul>
                    {g.requests.map((r, i) => (
                      <PendingRow key={r.id} req={r} db={db} viewer={viewer} forManager={g.manager} onDecide={(run) => decide('waiting', offset + i, run)} />
                    ))}
                  </ul>
                )}
              </Fragment>
            )
          })}
        </section>
      )}
      {mine.length > 0 && (
        <section ref={mineRef} aria-label="Your requests" className="border-b border-line">
          <h3 className="px-5 pt-3 text-[13px] font-bold text-ink-3">Your requests waiting</h3>
          <ul>
            {mine.map((r, i) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                <div className="min-w-0">
                  <p className="font-semibold text-ink">{typeFor(db, viewer, r)}</p>
                  <p className="text-[13.5px] text-ink-2">{rangeText(r.startDate, r.endDate)}</p>
                </div>
                <Button
                  variant="secondary"
                  icon="x"
                  data-row-primary
                  onClick={() => decide('mine', i, () => cancelTimeOff(r, viewer))}
                  aria-label={`Cancel request, ${typeFor(db, viewer, r)}, ${rangeText(r.startDate, r.endDate)}`}
                >
                  Cancel request
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Recent decisions">
        <h3 ref={recentRef} tabIndex={-1} className="px-5 pt-3 text-[13px] font-bold text-ink-3 outline-none">
          {approver ? 'Recent decisions' : 'Your recent decisions'}
        </h3>
        {recent.length === 0 ? (
          <p className="px-5 pt-1 pb-4 text-[14px] text-ink-3">No decisions yet.</p>
        ) : (
          <ul className="pb-2">
            {recent.map((r) => {
              const p = db.people.find((x) => x.id === r.personId)
              const by = r.approverId ? db.people.find((x) => x.id === r.approverId) : undefined
              if (!p) return null
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-1.5">
                  <PersonName person={p} size={26} sub={`${typeFor(db, viewer, r)} · ${shortRange(r.startDate, r.endDate)}${by ? ` · by ${firstName(by)}` : ''}`} />
                  <StatusBadge status={r.status} />
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </Panel>
  )
}

function PendingRow({
  req,
  db,
  viewer,
  forManager,
  onDecide,
}: {
  req: TimeOffRequest
  db: DB
  viewer: Viewer
  /** The manager this request waits on, when Admin acts for them. */
  forManager?: Person
  onDecide: (run: () => void) => void
}) {
  const p = db.people.find((x) => x.id === req.personId)
  if (!p) return null
  const wait = earlyWait(db, req)
  const forWhom = forManager ? ` for ${firstName(forManager)}` : ''
  // Who else is out then (approved only), so the approver sees coverage at a glance.
  const others = whoIsOut(db, req.startDate, req.endDate)
    .filter((e) => e.personId !== req.personId && e.status !== 'pending' && entryView(db, viewer, e).visible)
    .map((e) => db.people.find((x) => x.id === e.personId))
    .filter((x): x is Person => !!x)
  const uniq = [...new Map(others.map((o) => [o.id, o])).values()]
  return (
    <li className="flex flex-col gap-2 border-t border-line px-5 py-3 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PersonName person={p} sub={`${typeFor(db, viewer, req)} · ${hoursWithDays(req.hours, hoursPerDayFor(p))}`} />
        <span className="pt-2 text-[12.5px] text-ink-3">Asked {fmtRelative(req.requestedOn)}</span>
      </div>
      <p className="text-[14px] font-semibold text-ink">{rangeText(req.startDate, req.endDate)}</p>
      {req.note && <p className="text-[13.5px] text-ink-2">&ldquo;{req.note}&rdquo;</p>}
      <p className="text-[12.5px] text-ink-3">{uniq.length ? `Also out then: ${listJoin(uniq.map((o) => fullName(o)))}` : 'Nobody else you can see is out then.'}</p>
      {forManager && <p className="text-[12.5px] text-ink-3">{firstName(forManager)} approves this. You can act for them as Admin.</p>}
      {wait ? (
        <>
          <p className="text-[13px] text-ink-2">
            Starts before sick leave is usable ({fmtDate(wait.usableFrom)}, the {wait.days}-day wait). Waive the wait to pay it as sick leave, or record it as
            unpaid leave.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="lg"
              icon="check"
              data-row-primary
              onClick={() => onDecide(() => approveTimeOff(req, viewer))}
              aria-label={`Waive the wait for ${fullName(p)}, ${rangeText(req.startDate, req.endDate)}`}
            >
              Waive the wait
            </Button>
            <Button
              variant="secondary"
              size="lg"
              onClick={() => onDecide(() => recordUnpaidTimeOff(req, viewer))}
              aria-label={`Record as unpaid for ${fullName(p)}, ${rangeText(req.startDate, req.endDate)}`}
            >
              Record as unpaid
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="lg"
            icon="check"
            data-row-primary
            onClick={() => onDecide(() => approveTimeOff(req, viewer))}
            aria-label={`Approve${forWhom} ${fullName(p)}, ${rangeText(req.startDate, req.endDate)}`}
          >
            Approve{forWhom}
          </Button>
          <Button
            variant="secondary"
            size="lg"
            onClick={() => onDecide(() => declineTimeOff(req, viewer))}
            aria-label={`Decline${forWhom} ${fullName(p)}, ${rangeText(req.startDate, req.endDate)}`}
          >
            Decline{forWhom}
          </Button>
        </div>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------------------------

type BalanceLine = { person: Person; vacation?: BalanceRow; sick?: BalanceRow }

function h(n: number | null | undefined): string {
  return n == null ? '' : String(Math.round(n * 10) / 10)
}

/** A balance the one way (hoursWithDays), wrapping only between the hours and the days in a narrow column. */
function BalanceHours({ hours, person }: { hours: number | null; person: Person }) {
  if (hours == null) return null
  const [h, days] = hoursWithDays(hours, hoursPerDayFor(person)).split(' (')
  return (
    <span className="num font-bold">
      <span className="whitespace-nowrap">{h}</span>
      {days && <> <span className="whitespace-nowrap">({days}</span></>}
    </span>
  )
}

function BalancesPanel({ db, viewer }: { db: DB; viewer: Viewer }) {
  const t = today()
  const people = useMemo(() => {
    if (viewer.role === 'admin') return employedOn(db, t).sort((a, b) => a.hireNumber - b.hireNumber)
    if (viewer.role === 'manager' && viewer.personId) return reportingLine(db, viewer.personId, t).filter((p) => p.startDate <= t && canSeePerson(viewer, db, p.id, 'timeoff'))
    return viewer.person && viewer.person.startDate <= t ? [viewer.person] : []
  }, [db, viewer, t])
  const lines: BalanceLine[] = useMemo(
    () =>
      people.map((person) => {
        const rows = balances(db, person.id, t)
        return {
          person,
          vacation: rows.find((r) => r.policy.kind === 'vacation' || r.policy.kind === 'flexible_vacation'),
          sick: rows.find((r) => r.policy.kind === 'sick'),
        }
      }),
    [db, people, t],
  )

  const columns: Array<Column<BalanceLine>> = [
    {
      key: 'person',
      header: 'Person',
      cell: (l) => (
        <a href={links.person(l.person.id, 'timeoff')} className="font-semibold whitespace-nowrap text-ink hover:text-accent">
          {fullName(l.person)}
        </a>
      ),
      sort: (l) => fullName(l.person),
    },
    {
      key: 'vac',
      header: 'Vacation available',
      align: 'right',
      cell: (l) =>
        !l.vacation ? '' : l.vacation.display === 'flexible' ? 'Flexible' : (
          <BalanceHours hours={l.vacation.available} person={l.person} />
        ),
      sort: (l) => l.vacation?.available ?? -1,
    },
    { key: 'vac-earned', header: 'Earned', align: 'right', hideBelow: 'md', cell: (l) => <span className="num">{h(l.vacation?.earned)}</span>, sort: (l) => l.vacation?.earned ?? -1 },
    { key: 'vac-used', header: 'Used', align: 'right', hideBelow: 'md', cell: (l) => <span className="num">{h(l.vacation?.used)}</span>, sort: (l) => l.vacation?.used ?? -1 },
    {
      key: 'vac-sched',
      header: 'Scheduled',
      align: 'right',
      hideBelow: 'md',
      cell: (l) => <span className="num">{h(l.vacation?.scheduled)}</span>,
      sort: (l) => l.vacation?.scheduled ?? -1,
    },
    {
      key: 'vac-pending',
      header: 'Pending',
      align: 'right',
      hideBelow: 'md',
      cell: (l) => <span className={l.vacation?.pending ? 'num font-semibold text-warn' : 'num text-ink-3'}>{h(l.vacation?.pending)}</span>,
      sort: (l) => l.vacation?.pending ?? -1,
    },
    {
      key: 'sick',
      header: 'CA sick available',
      align: 'right',
      cell: (l) =>
        l.sick ? (
          <span className="flex flex-col items-end">
            <BalanceHours hours={l.sick.available} person={l.person} />
            {l.sick.usableFrom && <span className="text-[12px] whitespace-nowrap text-ink-3">usable from {fmtShort(l.sick.usableFrom)}</span>}
          </span>
        ) : (
          <span className="text-ink-3">Not CA</span>
        ),
      sort: (l) => l.sick?.available ?? -1,
    },
    { key: 'sick-granted', header: 'Sick granted', align: 'right', hideBelow: 'lg', cell: (l) => <span className="num">{h(l.sick?.earned)}</span>, sort: (l) => l.sick?.earned ?? -1 },
    { key: 'sick-used', header: 'Sick used', align: 'right', hideBelow: 'md', cell: (l) => <span className="num">{h(l.sick?.used)}</span>, sort: (l) => l.sick?.used ?? -1 },
    { key: 'sick-sched', header: 'Sick scheduled', align: 'right', hideBelow: 'lg', cell: (l) => <span className="num">{h(l.sick?.scheduled)}</span>, sort: (l) => l.sick?.scheduled ?? -1 },
    {
      key: 'notes',
      header: 'Notes',
      hideBelow: 'sm',
      cell: (l) => (
        <span className="flex flex-wrap gap-1">
          {l.vacation?.capReached && (
            <Badge tone="warn" icon="alert" title={l.vacation.note}>
              Vacation at cap
            </Badge>
          )}
          {l.sick?.usableFrom && <Badge tone="neutral">Sick usable {fmtDate(l.sick.usableFrom)}</Badge>}
          {!l.sick && <Badge tone="outline">Works from {l.person.homeState}</Badge>}
        </span>
      ),
    },
  ]

  const vacPolicy = db.timeOffPolicies.find((p) => p.kind === 'vacation' || p.kind === 'flexible_vacation')
  const exportCSV = () =>
    toCSV(lines, [
      { header: 'Person', value: (l) => fullName(l.person) },
      { header: 'Vacation earned (h)', value: (l) => l.vacation?.earned ?? '' },
      { header: 'Vacation used (h)', value: (l) => l.vacation?.used ?? '' },
      { header: 'Vacation scheduled (h)', value: (l) => l.vacation?.scheduled ?? '' },
      { header: 'Vacation available (h)', value: (l) => l.vacation?.available ?? '' },
      { header: 'Sick granted (h)', value: (l) => l.sick?.earned ?? '' },
      { header: 'Sick used (h)', value: (l) => l.sick?.used ?? '' },
      { header: 'Sick available (h)', value: (l) => l.sick?.available ?? '' },
    ])

  const title = viewer.role === 'admin' ? 'Balances' : viewer.role === 'manager' ? 'Balances for your team' : 'Your balances'
  return (
    <Panel
      title={title}
      icon="clock"
      padded={false}
      subtitle={`Hours as of ${fmtDay(t)}. Vacation and California sick leave are tracked separately.`}
      actions={
        viewer.role === 'admin' && lines.length > 0 ? (
          <>
            <Button
              variant="secondary"
              icon="download"
              onClick={() => {
                const ok = downloadFile(`time-off-balances-${t}.csv`, exportCSV(), 'text/csv;charset=utf-8')
                toast(ok ? { text: 'Balances downloaded' } : { text: 'Download blocked here. Use Copy CSV instead.', tone: 'bad' })
              }}
            >
              Download CSV
            </Button>
            <Button
              variant="ghost"
              icon="copy"
              onClick={async () => {
                const ok = await copyText(exportCSV())
                toast(ok ? { text: 'Balances copied as CSV' } : { text: 'Copy blocked here', tone: 'bad' })
              }}
            >
              Copy CSV
            </Button>
          </>
        ) : undefined
      }
    >
      <DataTable
        rows={lines}
        columns={columns}
        rowKey={(l) => l.person.id}
        dense
        caption={title}
        empty={<EmptyState compact icon="users" title="No balances to show" body={viewer.role === 'manager' ? 'Your reports will show here once they start.' : 'Balances appear once someone has started.'} />}
      />
      {vacPolicy && (
        <div className="border-t border-line px-5 py-3 text-[12.5px] text-ink-3">
          <p>{vacPolicy.description}</p>
          <p className="mt-1">Sick leave: 40 hours each January 1 and at hire, usable from day 90, approved automatically, never paid out.</p>
        </div>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// Leave cases (Admin)
// ---------------------------------------------------------------------------------------------

function LeaveCasesPanel({ db, viewer, onStart }: { db: DB; viewer: Viewer; onStart: () => void }) {
  const t = today()
  const cases = [...db.leaveCases].sort((a, b) => {
    const order = (l: LeaveCase) => (['upcoming', 'on_leave'].includes(leavePhase(l, t)) ? 0 : 1)
    return order(a) - order(b) || a.startDate.localeCompare(b.startDate)
  })
  return (
    <Panel
      title="Leave cases"
      icon="shield"
      className="xl:col-span-2"
      subtitle="CFRA, pregnancy disability and baby bonding. Others see only Out or Leave, back with a date."
      actions={
        <Button variant="secondary" icon="plus" onClick={onStart}>
          Start a leave case
        </Button>
      }
    >
      {cases.length === 0 ? (
        <EmptyState
          compact
          icon="shield"
          title="No leave cases"
          body="When someone asks for CFRA, pregnancy disability or bonding leave, start a case so the 5-business-day notice is not missed."
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {cases.map((l) => (
            <LeaveCaseCard key={l.id} leave={l} db={db} viewer={viewer} />
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-col gap-1.5 border-t border-line pt-3">
        <LegalNote label={LEAVE_LINKS.cfra.label} url={LEAVE_LINKS.cfra.url} extra="CFRA needs more than 12 months of service and 1,250 hours in the last 12 months; pregnancy disability leave has no service minimum." />
        <p className="text-[12.5px] text-ink-3">No medical details are stored. The employee applies to EDD directly for disability or paid family leave pay.</p>
      </div>
    </Panel>
  )
}

function LeaveCaseCard({ leave, db, viewer }: { leave: LeaveCase; db: DB; viewer: Viewer }) {
  const t = today()
  const person = db.people.find((p) => p.id === leave.personId)
  if (!person) return null
  const phase = leavePhase(leave, t)
  const notice = designationState(leave, t)
  const elig = leaveEligibility(db, person.id, leave.kind, leave.startDate)
  const checklist = db.checklists.find((c) => c.personId === person.id && c.kind === 'leave' && c.anchorDate === leave.startDate) ?? db.checklists.find((c) => c.personId === person.id && c.kind === 'leave')
  const rtw = checklist?.tasks.find((x) => x.templateTaskId === TASK_IDS.returnToWork)
  const open = phase === 'upcoming' || phase === 'on_leave'
  const phaseBadge =
    phase === 'upcoming' ? (
      <Badge tone="accent">Starts {fmtDay(leave.startDate)}</Badge>
    ) : phase === 'on_leave' ? (
      <Badge tone="warn">On leave</Badge>
    ) : phase === 'returned' ? (
      <Badge tone="good" icon="check">
        Back {fmtDate(leave.returnedOn)}
      </Badge>
    ) : (
      <Badge tone="outline">Ended {fmtDate(leave.endedOn)}</Badge>
    )
  const failing = elig.reasons.filter((r) => /needs|apply at 5/i.test(r))
  return (
    <li className="rounded-xl border border-line px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <PersonName person={person} />
          <Badge tone="neutral">{LEAVE_KIND_LABEL[leave.kind]}</Badge>
          {phaseBadge}
        </div>
      </div>
      <div className="mt-2">
        <DescriptionList
          columns={3}
          items={[
            { label: 'Requested', value: fmtDay(leave.requestedOn) },
            { label: 'First day of leave', value: fmtDay(leave.startDate) },
            { label: 'Expected back', value: leave.expectedReturn ? fmtDay(leave.expectedReturn) : 'Not set' },
            {
              label: 'Eligibility hint',
              value: (
                <span className="flex flex-col gap-0.5">
                  <Badge tone={elig.eligible ? 'good' : 'warn'} icon={elig.eligible ? 'check' : 'alert'} className="self-start">
                    {elig.eligible ? 'Likely eligible' : 'Check eligibility'}
                  </Badge>
                  <span className="text-[12.5px] text-ink-3">{(failing.length ? failing : elig.reasons.slice(1)).join(' ')}</span>
                </span>
              ),
            },
            {
              label: 'Response and designation notice',
              value: (
                <span className="flex flex-col items-start gap-1.5">
                  <NoticeBadge notice={notice} />
                  {notice.state !== 'sent' && notice.state !== 'none' && (
                    <Button variant="primary" icon="check" onClick={() => markNoticeSent(leave.id, fullName(person), viewer)}>
                      Mark sent
                    </Button>
                  )}
                  <span className="text-[12px] text-ink-3">5 business days after the request</span>
                </span>
              ),
            },
            {
              label: 'Return to work',
              value: (
                <span className="flex flex-col items-start gap-1.5">
                  <span className="text-[14px]">
                    {leave.returnedOn
                      ? `Back ${fmtDay(leave.returnedOn)}`
                      : rtw
                        ? `Check due ${fmtDay(rtw.dueOn)}${rtw.status === 'done' ? ' (done)' : ''}`
                        : 'Check after the leave'}
                  </span>
                  {phase === 'on_leave' && (
                    <Button variant="secondary" icon="user" onClick={() => markBack(leave.id, fullName(person), viewer)}>
                      Back today
                    </Button>
                  )}
                </span>
              ),
            },
          ]}
        />
      </div>
      {open && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2 text-[13.5px]">
          {checklist && (
            <a href={links.checklist(checklist.id)} className="inline-flex min-h-10 items-center gap-1.5 font-semibold text-accent underline">
              <Icon name="clipboard-check" size={15} />
              Leave checklist ({checklist.tasks.filter((x) => x.status !== 'open').length} of {checklist.tasks.length} done)
            </a>
          )}
          <a href={LEAVE_LINKS.edd.url} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-10 items-center gap-1.5 font-semibold text-accent underline">
            <Icon name="external" size={15} />
            EDD: disability and paid family leave
          </a>
          {leave.note && <span className="text-ink-3">Note: {leave.note}</span>}
        </div>
      )}
    </li>
  )
}

/** Managers: their line's leave as "Leave, back <date>", with no type. */
function OnLeavePanel({ db, viewer }: { db: DB; viewer: Viewer }) {
  const t = today()
  const rows = db.leaveCases
    .filter((l) => ['upcoming', 'on_leave'].includes(leavePhase(l, t)))
    .filter((l) => canSeePerson(viewer, db, l.personId, 'timeoff'))
  return (
    <Panel title="On leave" icon="shield" className="xl:col-span-2" subtitle="Leave types stay private; Admin manages the case.">
      {rows.length === 0 ? (
        <p className="text-[14px] text-ink-3">Nobody on your team is on leave or has leave coming up.</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((l) => {
            const p = db.people.find((x) => x.id === l.personId)
            if (!p) return null
            const type = canSeePerson(viewer, db, l.personId, 'leave')
            return (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-1.5 last:border-b-0">
                <PersonName person={p} sub={leaveText(l, { type, line: true })} />
                <span className="text-[13px] text-ink-3">{leavePhase(l, t) === 'upcoming' ? `From ${fmtDay(l.startDate)}` : 'Out now'}</span>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------------------------

function HolidaysPanel({ db, wide }: { db: DB; wide?: boolean }) {
  const t = today()
  const thisYear = Number(t.slice(0, 4))
  const years = [thisYear, thisYear + 1].filter((y) => holidaysForYear(db.holidays, y).length > 0)
  const [year, setYear] = useState(years[0] ?? thisYear)
  const list = holidaysForYear(db.holidays, year)
  // The next holiday overall, so a later year's first holiday is not marked Next.
  const next = [...db.holidays].filter((x) => x.date >= t).sort((a, b) => a.date.localeCompare(b.date))[0]
  const name = db.company.name
  const workdaysOff = list.length
  return (
    <Panel
      title="Holidays"
      icon="star"
      className={wide ? 'xl:col-span-3' : undefined}
      subtitle={`${plural(workdaysOff, 'company holiday')} in ${year}. Time off requests skip them.`}
      actions={
        years.length > 1 ? (
          <Segmented label="Year" size="sm" value={String(year)} onChange={(v) => setYear(Number(v))} options={years.map((y) => ({ value: String(y), label: String(y) }))} />
        ) : undefined
      }
    >
      {list.length === 0 ? (
        <p className="text-[14px] text-ink-3">No holidays set for {year}. Admin can add them in Settings.</p>
      ) : (
        <ul className="flex flex-col">
          {list.map((x) => {
            const past = x.date < t
            return (
              <li key={x.id} className={`flex items-center justify-between gap-3 border-b border-line py-1.5 last:border-b-0 ${past ? 'text-ink-3' : 'text-ink'}`}>
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold">{x.name}</span>
                  <span className="num block text-[12.5px] text-ink-3">{fmtDay(x.date)}</span>
                </span>
                {x.id === next?.id ? <Badge tone="accent">Next</Badge> : past ? <span className="text-[12px]">Past</span> : null}
              </li>
            )
          })}
        </ul>
      )}
      {list.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon="download"
            onClick={() => {
              const ok = downloadFile(`${name.toLowerCase()}-holidays-${year}.ics`, holidaysICS(db.holidays, name, year), 'text/calendar;charset=utf-8')
              toast(ok ? { text: `${year} holidays downloaded` } : { text: 'Download blocked here. Use Copy list instead.', tone: 'bad' })
            }}
          >
            Download .ics
          </Button>
          <Button
            variant="ghost"
            icon="copy"
            onClick={async () => {
              const ok = await copyText(holidaysText(db.holidays, name, year))
              toast(ok ? { text: `${year} holidays copied` } : { text: 'Copy blocked here', tone: 'bad' })
            }}
          >
            Copy list
          </Button>
        </div>
      )}
    </Panel>
  )
}
