// Comp panels reused by person profiles, Me and Home (owned by the comp feature). Each checks
// canSeePerson: admins see everything; a person sees their own pay, band and equity; managers see
// their reports' job history and pay band only, never individual pay or equity.
import { useMemo, useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canSeePerson } from '@/domain/access'
import { cancellationPending, capTableIsPlaceholder, cliffDate, fullyVestedDate, grantsFor, grantSummary, pctOfFullyDiluted, scheduleText, vestedHeld, vestingStop } from '@/domain/equity'
import { bandFor, bandLabel, compaRatio, compHistoryByLastDay, fullTimeEquivalentBase, peopleCostSummary } from '@/domain/pay'
import { canCancelChange, cancelScheduledChange, compReasonLabel } from '@/domain/lifecycle'
import { fullName, personNameById } from '@/domain/people'
import type { CompRecord, EquityGrant, ID } from '@/domain/types'
import { daysBetween, fmtDate, fmtDay, fmtShort, today } from '@/lib/dates'
import { money, money2, num, pct } from '@/lib/format'
import { useDB } from '@/store/db'
import { Badge, Button, Callout, CitationChip, DataTable, EmptyState, focusPageStart, Money, Panel, Private, toast, type Column } from '@/ui'
import { ChangeJobSheet } from './ChangeJobSheet'
import { changeParts, cliffCountdown, combinedVesting, overtimeStatusText, REASON_LABEL, variableLabel, vestingMilestones } from './helpers'
import { BandTrack, MoneyText, VestingChart } from './shared'

export { ChangeJobSheet } from './ChangeJobSheet'

const SOURCES = {
  payScale: {
    label: 'Labor Code 432.3',
    url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=432.3',
  },
  iso: { label: 'IRC 422 (ISOs)', url: 'https://www.law.cornell.edu/uscode/text/26/422' },
}

function Small({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ft-ministat min-w-0">
      <div className="ft-ministat__label text-[12.5px] font-semibold text-ink-3">{label}</div>
      <div className="ft-ministat__value num mt-0.5 text-[16px] font-bold text-ink">{children}</div>
    </div>
  )
}

function payText(rec: Pick<CompRecord, 'payType' | 'salary' | 'hourlyRate'>): string {
  return rec.payType === 'hourly' ? `${money2(rec.hourlyRate ?? 0)} an hour` : money(rec.salary ?? 0)
}

// ---------------------------------------------------------------------------------------------
// Job and pay
// ---------------------------------------------------------------------------------------------

/**
 * Effective-dated job and pay history, band position, Change job or pay button (admins). Pass
 * hideAction when the page header already offers Change job or pay, so the screen has one button for it.
 */
export function PersonJobPayPanel({ personId, hideAction }: { personId: ID; hideAction?: boolean }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const date = today()
  const [changing, setChanging] = useState(false)
  const person = db.people.find((p) => p.id === personId)
  if (!person) return <EmptyState compact title="No job record" body="This person is not an employee, so there is no job and pay history." />
  const seeJob = canSeePerson(viewer, db, personId, 'job')
  const seeBand = canSeePerson(viewer, db, personId, 'band')
  const seePay = canSeePerson(viewer, db, personId, 'pay')
  const self = viewer.personId === personId
  if (!seeJob && !seeBand) {
    return (
      <Callout tone="neutral" title="Job and pay are private">
        Admins, {person.firstName} and {person.firstName}'s managers can see this.
      </Callout>
    )
  }
  // Rows dated after the last day never take effect: they stay out of the history, the schedule and the current job.
  const { history, afterLastDay, lastDay } = compHistoryByLastDay(db, person)
  const upToDate = history.filter((r) => r.effectiveOn <= date)
  const cur = upToDate[upToDate.length - 1] ?? history[0]
  const band = bandFor(db, person.familyId, cur?.levelId ?? person.levelId)
  const level = db.levels.find((l) => l.id === (cur?.levelId ?? person.levelId))
  const family = db.families.find((f) => f.id === person.familyId)
  const fte = cur ? fullTimeEquivalentBase(cur, person.hoursPerWeek) : null
  const scheduled = history.filter((r) => r.effectiveOn > date)
  const rows = [...history].reverse()
  const isAdmin = viewer.role === 'admin'

  // The button goes away with the row it cancels: focus moves to another scheduled row's button or the
  // panel's Change job or pay button, never to the page body.
  const cancelChange = (r: CompRecord, trigger: HTMLElement | null) => {
    const check = canCancelChange(db, r.id)
    if (!check.ok) {
      toast({ text: check.reason, tone: 'bad' })
      return
    }
    const label = `Cancelled the ${compReasonLabel(r.reason)} scheduled for ${fmtDate(r.effectiveOn)}`
    useDB.getState().mutate(label, (d) => {
      cancelScheduledChange(d, r.id, { date, actorId: viewer.personId })
    })
    toast({ text: label, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
    let frames = 0
    const settle = () => {
      // Wait for the re-render that removes the button; if it stays, focus stays on it.
      if (trigger?.isConnected) {
        if (frames++ < 10) requestAnimationFrame(settle)
        return
      }
      const active = document.activeElement
      if (active && active !== document.body && active.isConnected) return
      const next = document.querySelector<HTMLElement>('[data-cancel-change], [data-change-job]')
      if (next) next.focus()
      else focusPageStart()
    }
    requestAnimationFrame(settle)
  }

  const columns: Array<Column<CompRecord>> = [
    {
      key: 'date',
      header: 'Effective',
      sort: (r) => r.effectiveOn,
      cell: (r) => (
        <span className="whitespace-nowrap">
          {fmtDate(r.effectiveOn)}
          {r.effectiveOn > date && (
            <Badge tone="accent" className="ml-2">
              Scheduled
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'title', header: 'Title', cell: (r) => r.title },
    { key: 'level', header: 'Level', cell: (r) => db.levels.find((l) => l.id === r.levelId)?.code ?? '' },
    { key: 'manager', header: 'Manager', hideBelow: 'md', cell: (r) => (r.managerId ? personNameById(db, r.managerId) : 'None') },
  ]
  if (seePay) {
    columns.push(
      { key: 'pay', header: 'Base', align: 'right', cell: (r) => <Private>{payText(r)}</Private> },
      { key: 'var', header: 'Variable', align: 'right', hideBelow: 'sm', cell: (r) => (r.variablePct ? <Private>{pct(r.variablePct)}</Private> : <span className="text-ink-3">None</span>) },
    )
  }
  columns.push(
    { key: 'reason', header: 'Reason', cell: (r) => REASON_LABEL[r.reason] },
    { key: 'approver', header: 'Approved by', hideBelow: 'lg', cell: (r) => (r.approvedById ? personNameById(db, r.approvedById) : <span className="text-ink-3">Not recorded</span>) },
  )
  if (seePay) {
    columns.push({ key: 'exception', header: 'Exception', hideBelow: 'md', cell: (r) => r.exceptionReason ?? <span className="text-ink-3">None</span> })
  }

  return (
    <Panel
      title="Job and pay"
      icon="briefcase"
      subtitle={self ? 'Your job and pay history' : `${fullName(person)}'s job${seePay ? ' and pay' : ''} history`}
      actions={
        isAdmin && !hideAction ? (
          <Button icon="edit" data-change-job onClick={() => setChanging(true)}>
            Change job or pay
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-x-6 gap-y-3.5 sm:grid-cols-3">
          <Small label="Title">{cur?.title ?? person.title}</Small>
          <Small label="Level">{level ? `${level.code} ${level.name}` : 'Not set'}</Small>
          <Small label="Family">{family?.name ?? 'Not set'}</Small>
          <Small label="Manager">{person.managerId ? personNameById(db, person.managerId) : 'None'}</Small>
          <Small label="Overtime status">
            {overtimeStatusText(cur?.flsa ?? person.flsa, (cur?.flsa ?? person.flsa) === 'exempt' ? (cur?.exemptionBasis ?? person.exemptionBasis) : undefined)}
          </Small>
          <Small label="Hours">{person.hoursPerWeek >= 40 ? 'Full time' : `${person.hoursPerWeek} hours a week`}</Small>
          {seePay && cur && (
            <>
              <Small label={cur.payType === 'hourly' ? 'Hourly rate' : 'Base salary'}>
                <Private>{payText(cur)}</Private>
              </Small>
              <Small label="Variable at target">
                <Private>{variableLabel(cur.variablePct)}</Private>
              </Small>
            </>
          )}
        </div>

        {scheduled.length > 0 && (
          <Callout tone="accent" title={scheduled.length === 1 ? `Change scheduled for ${fmtDay(scheduled[0].effectiveOn)}` : `${scheduled.length} changes scheduled`}>
            <ul className="flex flex-col gap-1.5">
              {scheduled.map((r) => {
                const parts = changeParts(db, r, history[history.indexOf(r) - 1]).filter((p) => seePay || (p.kind !== 'pay' && p.kind !== 'variable'))
                return (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span>
                      {scheduled.length > 1 && <span className="font-semibold">{fmtDay(r.effectiveOn)}: </span>}
                      {REASON_LABEL[r.reason]}
                      {parts.length > 0 && ': '}
                      {parts.map((p, i) => (
                        <span key={p.kind}>
                          {i > 0 && ', '}
                          {p.kind === 'pay' || p.kind === 'variable' ? <Private>{p.text}</Private> : p.text}
                        </span>
                      ))}
                      .
                    </span>
                    {isAdmin && canCancelChange(db, r.id).ok && (
                      <Button size="sm" variant="secondary" icon="x" data-cancel-change onClick={(e) => cancelChange(r, e.currentTarget)}>
                        Cancel scheduled change
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
            <p className="mt-1">
              {scheduled.length === 1 ? 'It takes effect on that date.' : 'Each takes effect on its date.'}
              {isAdmin && scheduled.length > 1 && ' To cancel an earlier one, cancel the later ones first.'}
            </p>
          </Callout>
        )}

        {seeJob && lastDay && afterLastDay.length > 0 && (
          <Callout tone="neutral" title={`Will not take effect: last day is ${fmtShort(lastDay)}`}>
            <ul className="flex flex-col gap-0.5">
              {afterLastDay.map((r) => (
                <li key={r.id}>
                  {REASON_LABEL[r.reason]}: {r.title}
                  {seePay && (
                    <>
                      {', '}
                      <Private>{payText(r)}</Private>
                    </>
                  )}
                  , scheduled for {fmtDay(r.effectiveOn)}.
                </li>
              ))}
            </ul>
            <p className="mt-1">{afterLastDay.length === 1 ? 'It is' : 'They are'} left out of the job and pay history below.</p>
          </Callout>
        )}

        {seeBand && (
          <div className="rounded-xl border border-line bg-surface-2/50 p-4">
            {band ? (
              <>
                <p className="text-[14px] text-ink">
                  <span className="font-semibold">Pay band for {level?.code ?? 'this level'}{family ? `, ${family.name}` : ''}:</span>{' '}
                  <Private>
                    {money(band.min)} to {money(band.max)}
                  </Private>
                  <span className="text-ink-3">
                    {' '}
                    (midpoint <Private>{money(band.mid)}</Private>)
                  </span>
                </p>
                {seePay && fte != null && (
                  <div className="mt-3 max-w-md">
                    <BandTrack band={band} base={fte} />
                    <p className="mt-1 text-[13.5px] text-ink-2">
                      {bandLabel(fte, band)}, compa-ratio <Private>{compaRatio(fte, band).toFixed(2)}</Private>
                      {person.hoursPerWeek < 40 && ' (pay restated at full time)'}
                    </p>
                  </div>
                )}
                {!seePay && <p className="mt-1 text-[13px] text-ink-3">Individual pay is visible only to admins and {person.firstName}.</p>}
              </>
            ) : (
              <p className="text-[14px] text-ink-3">No pay band is set for this level yet.</p>
            )}
            {self && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
                <span>You can ask for the pay scale for your position at any time.</span>
                <CitationChip label={SOURCES.payScale.label} url={SOURCES.payScale.url} />
                <span className="text-ink-3">Not legal advice.</span>
              </div>
            )}
          </div>
        )}

        {seeJob && (
          <div>
            <h3 className="mb-2 text-[14px] font-bold text-ink">History</h3>
            <div className="rounded-xl border border-line">
              <DataTable
                rows={rows}
                columns={columns}
                rowKey={(r) => r.id}
                dense
                caption="Job and pay history, newest first"
                empty={<EmptyState compact title="No history yet" />}
              />
            </div>
            <p className="mt-2 text-[12.5px] text-ink-3">This is the job title and wage rate history California asks employers to keep.</p>
          </div>
        )}
      </div>
      {isAdmin && !hideAction && <ChangeJobSheet personId={personId} open={changing} onClose={() => setChanging(false)} />}
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// Equity
// ---------------------------------------------------------------------------------------------

function grantStatus(g: EquityGrant, ended: boolean): { label: string; tone: 'good' | 'warn' | 'neutral' | 'outline' | 'accent' } {
  if (g.status === 'promised') return { label: 'Awaiting board consent', tone: 'warn' }
  if (g.status === 'reserved') return { label: 'Reserved by offer', tone: 'neutral' }
  if (g.status === 'cancelled') return { label: 'Cancelled', tone: 'outline' }
  if (ended) return { label: 'Ended', tone: 'outline' }
  return { label: g.boardApprovedOn ? `Granted ${fmtDate(g.boardApprovedOn)}` : 'Granted', tone: 'good' }
}

/** Grants, vesting chart, next vest, cliff countdown, exercise window. */
export function PersonEquityPanel({ personId }: { personId: ID }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const date = today()
  const [table, setTable] = useState(false)
  const person = db.people.find((p) => p.id === personId)
  const contractor = db.contractors.find((c) => c.id === personId)
  const name = person ? fullName(person) : (contractor?.name ?? 'This person')
  const first = person ? person.preferredName || person.firstName : name.split(' ')[0]
  const summary = useMemo(() => grantSummary(db, personId, date), [db, personId, date])
  // A leaver's line goes flat at the last day, even before the cancellation is recorded.
  const points = useMemo(() => combinedVesting(summary.grants, (g) => vestingStop(db, g)), [db, summary.grants])

  if (!canSeePerson(viewer, db, personId, 'equity')) {
    return (
      <Callout tone="neutral" title="Equity is private">
        Only admins and {first} can see grants and vesting.
      </Callout>
    )
  }
  const self = viewer.personId === personId
  if (!summary.grants.length) {
    const returned = grantsFor(db, personId).filter((g) => g.status === 'cancelled')
    const returnedShares = returned.reduce((t, g) => t + (g.cancelledShares ?? g.shares), 0)
    // Offboarding dates the cancellation on the last day, so before then the options have not gone back yet.
    const pendingBack = returned.some((g) => cancellationPending(g, date))
    return (
      <Panel title="Equity" icon="key">
        <EmptyState
          compact
          icon="key"
          title={summary.reserved ? `${num(summary.reserved)} options reserved in an offer` : returned.length ? 'No options kept' : 'No equity grants'}
          body={
            summary.reserved ? (
              'They become a grant for board consent when the offer is accepted.'
            ) : returned.length ? (
              <>
                <Private>{num(returnedShares)}</Private> options {pendingBack ? 'go' : 'went'} back to the pool
                {returned[0].cancelledOn ? ` on ${fmtDate(returned[0].cancelledOn)}` : ''}, before any {pendingBack ? 'vest' : 'vested'}.
              </>
            ) : (
              'Grants show here once the board approves them or an accepted offer queues one.'
            )
          }
        />
      </Panel>
    )
  }
  const grants = summary.grants
  const start = grants.map((g) => g.vestingStart).sort()[0]
  // Anyone with a last day (a separation in progress counts) is leaving: vesting, the chart and the table stop there.
  const exit = summary.exit
  const lastDay = exit?.lastDay ?? person?.endDate ?? contractor?.endOn ?? null
  const left = !!lastDay && lastDay < date
  const leaving = !!exit && !left
  const scheduleEnd = summary.fullyVestedOn ?? grants.map((g) => fullyVestedDate(g)).sort().reverse()[0]
  const end = exit && exit.lastDay > start ? exit.lastDay : scheduleEnd
  const cliffGrant = summary.cliff ? grants.find((g) => g.cliffMonths > 0 && cliffDate(g) === summary.cliff?.date) : undefined
  const statusTone =
    summary.status === 'awaiting_board' || summary.status === 'leaving'
      ? 'warn'
      : summary.status === 'ended'
        ? 'outline'
        : summary.status === 'fully_vested'
          ? 'good'
          : 'accent'
  const statusLabel: Record<typeof summary.status, string> = {
    none: 'No grants',
    reserved: 'Reserved',
    awaiting_board: 'Awaiting board consent',
    pre_cliff: 'Before the cliff',
    vesting: 'Vesting',
    fully_vested: 'Fully vested',
    leaving: 'Leaving',
    ended: 'Ended',
  }
  const exerciseBy = exit?.exerciseBy ?? person?.separation?.exerciseDeadline
  const exerciseDays = exerciseBy && lastDay ? daysBetween(lastDay, exerciseBy) : 90
  const earlyEx = grants.find((g) => g.earlyExercise && g.election83bDueOn)

  const columns: Array<Column<EquityGrant>> = [
    { key: 'type', header: 'Type', cell: (g) => (g.type === 'RSA' ? 'Restricted stock' : g.type) },
    {
      key: 'shares',
      header: 'Options',
      align: 'right',
      sort: (g) => g.shares,
      cell: (g) => {
        // What goes back to the pool at the last day: recorded as cancelled, or not yet vested by then.
        const back = exit ? g.shares - vestedHeld(db, g, exit.lastDay) : 0
        return (
          <Private>
            {num(g.shares)}
            {back > 0 && (
              <span className="block text-[11.5px] text-ink-3">
                {num(back)} {left ? 'returned' : 'return'} {fmtShort(exit?.lastDay)}
              </span>
            )}
          </Private>
        )
      },
    },
    {
      key: 'strike',
      header: 'Strike',
      align: 'right',
      cell: (g) => (
        <Private>
          {g.strikePrice ? money2(g.strikePrice) : 'Set at grant'}
          {g.status === 'promised' && g.strikePrice ? <span className="block text-[11.5px] text-ink-3">estimate, set at grant</span> : null}
        </Private>
      ),
    },
    { key: 'pct', header: '% fully diluted', align: 'right', hideBelow: 'sm', cell: (g) => <Private>{pct(pctOfFullyDiluted(db, g.shares), 3)}</Private> },
    { key: 'start', header: 'Vest start', sort: (g) => g.vestingStart, cell: (g) => fmtDate(g.vestingStart) },
    { key: 'schedule', header: 'Schedule', hideBelow: 'md', cell: (g) => scheduleText(g) },
    { key: 'vested', header: 'Vested today', align: 'right', cell: (g) => <Private>{num(vestedHeld(db, g, date))}</Private> },
    {
      key: 'status',
      header: 'Status',
      cell: (g) => {
        const s = grantStatus(g, left)
        return <Badge tone={s.tone}>{s.label}</Badge>
      },
    },
  ]

  return (
    <Panel title="Equity" icon="key" subtitle={self ? 'Your stock options' : `${name}'s stock options`}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone}>{statusLabel[summary.status]}</Badge>
          {summary.status !== 'awaiting_board' && (
            <span className="text-[14px] text-ink-2">
              <Private>{summary.text}</Private>
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-3.5 sm:grid-cols-4">
          {exit ? (
            <>
              <Small label={left ? 'Kept after leaving' : 'Kept at the last day'}>
                <Private>{num(exit.vestedAtExit)}</Private>
              </Small>
              <Small label="Vested today">
                <Private>{num(summary.vested)}</Private>
              </Small>
              <Small label={left ? 'Went back to the pool' : 'Go back to the pool'}>
                <Private>{num(exit.returnsToPool)}</Private>
              </Small>
              <Small label="Of fully diluted">
                <Private>{pct(pctOfFullyDiluted(db, exit.vestedAtExit), 3)}</Private>
              </Small>
            </>
          ) : (
            <>
              <Small label="Total options">
                <Private>{num(summary.totalShares)}</Private>
              </Small>
              <Small label="Vested today">
                <Private>{num(summary.vested)}</Private>
              </Small>
              <Small label="Unvested">
                <Private>{num(summary.unvested)}</Private>
              </Small>
              <Small label="Of fully diluted">
                <Private>{pct(summary.pctFullyDiluted, 3)}</Private>
              </Small>
            </>
          )}
        </div>
        {/* The same caveat the offer and Comp and plan > Equity give while the cap table is Start fresh's example. */}
        {capTableIsPlaceholder(db) && <p className="-mt-2 text-[13px] text-ink-3">The percent of fully diluted is an estimate from the placeholder cap table.</p>}

        {leaving && exit && (
          <Callout tone="warn" icon="clock" title={`Vesting stops ${fmtDay(exit.lastDay)}, the last day`}>
            <Private>{num(exit.vestedAtExit)}</Private> options {exit.lastDay === date ? 'have vested' : 'will have vested by then'};{' '}
            {exit.returnsToPool > 0 ? (
              <>
                the other <Private>{num(exit.returnsToPool)}</Private> go back to the pool {exit.lastDay === date ? 'today' : 'that day'}.
              </>
            ) : (
              'nothing goes back to the pool.'
            )}
            {exit.exerciseBy && ` Vested options can be exercised until ${fmtDate(exit.exerciseBy)}.`}
          </Callout>
        )}

        {!left && summary.cliff && !summary.cliff.passed && cliffGrant && (
          <Callout tone="accent" icon="clock" title={cliffCountdown(summary.cliff.date, cliffGrant.vestingMonths, date)}>
            <Private>{num(summary.cliff.shares)}</Private> options vest at the cliff. Nothing vests before it.
          </Callout>
        )}
        {!left && summary.nextVest && (summary.cliff?.passed || !summary.cliff) && (
          <p className="text-[14px] text-ink-2">
            Next vest {fmtDay(summary.nextVest.date)}: <Private>{num(summary.nextVest.shares)}</Private> options.
            {summary.fullyVestedOn && ` Fully vested ${fmtDate(summary.fullyVestedOn)}.`}
          </p>
        )}
        {summary.awaitingBoard > 0 && (
          <Callout tone="warn" title="Grant awaiting board consent">
            <Private>{num(summary.awaitingBoard)}</Private> options wait for the next board consent. Vesting still counts from the vesting
            start date, and the board sets the strike at the 409A price on the day it approves.
          </Callout>
        )}

        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[14px] font-bold text-ink">Vesting</h3>
            <Button size="sm" variant="ghost" icon={table ? 'chart' : 'layers'} onClick={() => setTable((t) => !t)} aria-pressed={table}>
              {table ? 'Show chart' : 'Show as table'}
            </Button>
          </div>
          {table ? (
            <div className="rounded-xl border border-line">
              <DataTable
                rows={vestingMilestones(points, start, exit?.lastDay)}
                rowKey={(r) => r.date}
                dense
                caption="Vested options at each anniversary"
                columns={[
                  { key: 'd', header: 'Date', cell: (r) => fmtDate(r.date) },
                  { key: 'v', header: 'Vested by then', align: 'right', cell: (r) => <Private>{num(r.vested)}</Private> },
                  { key: 'p', header: 'Share of total', align: 'right', cell: (r) => <Private>{pct(summary.totalShares ? r.vested / summary.totalShares : 0)}</Private> },
                ]}
              />
            </div>
          ) : (
            <VestingChart points={points} total={summary.totalShares} start={start} end={end} today={date} cliff={summary.cliff?.date} />
          )}
        </div>

        <div className="rounded-xl border border-line">
          <DataTable rows={grants} columns={columns} rowKey={(g) => g.id} dense caption="Equity grants" />
        </div>

        <div className="rounded-xl bg-surface-2 px-4 py-3 text-[14px] text-ink-2">
          <p className="font-semibold text-ink">Exercise window</p>
          {(left || leaving) && lastDay ? (
            <p className="mt-1">
              {exerciseBy
                ? `Vested options can be exercised until ${fmtDate(exerciseBy)}, ${exerciseDays} days after the last day (${fmtDate(lastDay)}).`
                : exit && exit.vestedAtExit === 0
                  ? `Nothing vested by the last day (${fmtDate(lastDay)}), so there is nothing to exercise.`
                  : `Vested options can be exercised for 90 days after the last day (${fmtDate(lastDay)}).`}{' '}
              {left
                ? 'Unvested options went back to the pool.'
                : 'Unvested options go back to the pool on the last day. To keep ISO tax treatment, exercise within 3 months of leaving.'}
            </p>
          ) : (
            <p className="mt-1">
              Options are a right to buy shares at the strike price. After leaving, vested options can be exercised for 90 days; unvested
              options go back to the pool. To keep ISO tax treatment, exercise within 3 months of leaving.
            </p>
          )}
          {earlyEx?.election83bDueOn && (
            <p className="mt-1">83(b) election due {fmtDate(earlyEx.election83bDueOn)} (30 days after the early exercise, no extensions).</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
            <CitationChip label={SOURCES.iso.label} url={SOURCES.iso.url} />
            <span>Not legal or tax advice. The cap table tool is the source of truth.</span>
          </div>
        </div>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// Home: people cost
// ---------------------------------------------------------------------------------------------

/** Admin-only people cost line for Home: run-rate now, with incoming/offers, at plan, runway. */
export function PeopleCostCard() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const date = today()
  const s = useMemo(() => peopleCostSummary(db, date), [db, date])
  if (viewer.role !== 'admin') return null
  return (
    <Panel
      title="People cost"
      icon="coins"
      actions={
        <a href={links.comp('cost')} className="inline-flex min-h-10 items-center gap-1 text-[14px] font-semibold text-accent hover:underline">
          Cost and runway
        </a>
      }
    >
      <p className="text-[15px] leading-relaxed text-ink">
        <MoneyText text={s.text} />
      </p>
      <div className="mt-3 grid grid-cols-3 gap-3 border-t border-line pt-3">
        <Small label="Now">
          <Money value={s.now.monthly} short suffix="/mo" />
        </Small>
        <Small label="With hires and offers">
          <Money value={s.withOffers.monthly} short suffix="/mo" />
        </Small>
        <Small label="At plan">
          <Money value={s.atPlan.monthly} short suffix="/mo" />
        </Small>
      </div>
    </Panel>
  )
}
