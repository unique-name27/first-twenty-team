// Me > Summary: the Employee home. Tasks first, then time off, equity and what is coming up.
import { useMemo } from 'react'
import { links, navigate } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { InboxView } from '@/features/home'
import type { DB, Person, Role } from '@/domain/types'
import { addDays, daysBetween, fmtDate, nowISO, today } from '@/lib/dates'
import { num, plural } from '@/lib/format'
import { Badge, Button, EmptyState, Meter, Panel, Private, SectionLabel, TextLink } from '@/ui'
import { LineItem } from './bits'
import { SummaryExportButtons } from './SummaryExport'
import {
  availabilityText,
  type BalanceLine,
  daysAwayText,
  dayText,
  type EquityHeadline,
  equityHeadline,
  isDueSoon,
  myTaskItems,
  nextAnniversary,
  nextStarter,
  nextTimeOff,
  rangeText,
  SOON_DAYS,
  startingThisMonth,
  teammatesOut,
  upcomingHolidays,
  vacationAndSick,
} from './summary'

/** Rows of the to-do list shown on the summary; the rest wait on the Tasks tab. */
const SUMMARY_ROWS = 5

export function SummaryTab({ db, person, role }: { db: DB; person: Person; role: Role }) {
  const viewer = useViewer()
  const date = today()
  // The same list as Me > Tasks and the Tasks tab count, so the two never disagree.
  const items = useMemo(() => myTaskItems(db, person.id, date, nowISO()), [db, person.id, date])
  const now = items.filter((i) => isDueSoon(i, date))
  const later = items.length - now.length
  const { vacation, sick } = useMemo(() => vacationAndSick(db, person.id, date), [db, person.id, date])
  const next = useMemo(() => nextTimeOff(db, person.id, date), [db, person.id, date])
  const equity = useMemo(() => equityHeadline(db, person.id, date), [db, person.id, date])

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
        <Panel
          title="Your tasks"
          icon="clipboard-check"
          subtitle={
            now.length
              ? `${now.length} ${now.length === 1 ? 'thing needs' : 'things need'} you`
              : later
                ? `Nothing due in the next ${SOON_DAYS} days`
                : 'Nothing needs you right now'
          }
          actions={<TextLink href={links.me('tasks')}>See all tasks</TextLink>}
        >
          {now.length > 0 ? (
            <InboxView items={now.slice(0, SUMMARY_ROWS)} date={date} viewer={viewer} compact showFilter={false} />
          ) : later ? (
            <EmptyState
              compact
              icon="calendar-check"
              title={`Nothing due in the next ${SOON_DAYS} days`}
              body={
                <>
                  {plural(later, 'task')} coming up later. See {later === 1 ? 'it' : 'them'} on the <TextLink href={links.me('tasks')}>Tasks</TextLink> tab.
                </>
              }
            />
          ) : (
            <EmptyState compact icon="check" title="You're all caught up" body="New tasks show up here when something needs you." />
          )}
          {now.length > SUMMARY_ROWS && (
            <p className="mt-2 text-[13.5px] text-ink-3">
              And {now.length - SUMMARY_ROWS} more on the <TextLink href={links.me('tasks')}>Tasks</TextLink> tab.
            </p>
          )}
          {role !== 'employee' && (
            <p className="mt-3 text-[13.5px] text-ink-3">
              Your own tasks, including checklist items assigned to you. Other {role === 'admin' ? 'company' : 'team'} work is in the inbox on{' '}
              <TextLink href={links.home()}>Home</TextLink>.
            </p>
          )}
        </Panel>

        <Panel
          title="Time off"
          icon="calendar"
          actions={
            <Button variant="primary" icon="calendar" onClick={() => navigate('me', 'timeoff', 'request')}>
              Request time off
            </Button>
          }
        >
          {!vacation && !sick ? (
            <p className="text-[14.5px] text-ink-2">No time off policies apply to you yet. Your admin sets them up in Settings.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {vacation && <BalanceTile line={vacation} />}
              {sick && <BalanceTile line={sick} />}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[14.5px]">
            <span className="font-semibold text-ink-2">Next time off:</span>
            {next ? (
              <>
                <span className="text-ink">{rangeText(next.from, next.to, date)}</span>
                {next.status === 'approved' && (
                  <Badge tone="good" icon="check">
                    Approved
                  </Badge>
                )}
                {next.status === 'pending' && (
                  <Badge tone="warn" icon="clock">
                    Waiting for approval
                  </Badge>
                )}
                {next.status === 'leave' && <Badge tone="neutral">Leave</Badge>}
              </>
            ) : (
              <span className="text-ink-3">Nothing booked yet</span>
            )}
          </div>
        </Panel>
      </div>

      <div className="grid min-w-0 content-start gap-4 md:grid-cols-2 xl:grid-cols-1">
        <EquityCard person={person} headline={equity} />
        <ComingUp db={db} person={person} />
      </div>
      <div className="flex flex-wrap gap-2 sm:hidden">
        <SummaryExportButtons db={db} person={person} />
      </div>
    </div>
  )
}

function BalanceTile({ line }: { line: BalanceLine }) {
  return (
    <div className="ft-ministat ft-ministat--tile min-w-0 rounded-xl bg-surface-2 px-4 py-3">
      <div className="ft-ministat__label text-[13px] font-semibold text-ink-3">{line.name}</div>
      {/* Proportional figures: a lone big number reads better without tabular spacing around the decimal point. */}
      <div className="ft-ministat__value mt-0.5 font-display text-[24px] leading-tight font-bold text-ink">{line.value}</div>
      <div className="mt-0.5 text-[13px] text-ink-3">
        {line.hours == null ? line.note : `${availabilityText(line)}${line.note ? `. ${line.note}` : ''}`}
      </div>
    </div>
  )
}

function EquityCard({ person, headline }: { person: Person; headline: EquityHeadline | null }) {
  const date = today()
  if (!headline) {
    return (
      <Panel title="Equity" icon="coins">
        <p className="text-[14.5px] text-ink-2">
          {person.isFounder
            ? 'Your founder shares sit outside the option pool. The cap table tool is the record.'
            : 'No option grant on record for you.'}
        </p>
      </Panel>
    )
  }
  const h = headline
  const cliffProgress =
    h.cliffOn && h.vestingStart && h.cliffDays != null
      ? Math.max(0, Math.min(1, daysBetween(h.vestingStart, date) / Math.max(1, daysBetween(h.vestingStart, h.cliffOn))))
      : null
  return (
    <Panel title="Equity" icon="coins" actions={<TextLink href={links.me('equity')}>See vesting</TextLink>}>
      <p className="font-display text-[22px] leading-tight font-bold text-ink">{h.title}</p>
      <div className="mt-2 space-y-1.5 text-[14px] text-ink-2">
        {h.status === 'awaiting_board' && (
          <p>
            <Private>{num(h.totalShares)}</Private> options. The board approves new grants at its next consent. Vesting still counts from{' '}
            {h.vestingStart ? fmtDate(h.vestingStart) : 'your start date'}.
          </p>
        )}
        {h.status === 'reserved' && <p>Your offer reserves these options until you accept and the board approves them.</p>}
        {h.cliffOn && h.cliffShares != null && h.status !== 'reserved' && (
          <p>
            <Private>{num(h.cliffShares)}</Private> options vest at your cliff on {dayText(h.cliffOn, date)}
            {h.status === 'awaiting_board' && h.cliffDays != null ? ` (${daysAwayText(date, h.cliffOn)})` : ''}. Then a little more every month.
          </p>
        )}
        {(h.status === 'vesting' || h.status === 'fully_vested') && (
          <p>
            <Private>{num(h.vested)}</Private> of <Private>{num(h.totalShares)}</Private> options vested
            {h.nextVest && h.status === 'vesting' && !h.cliffOn ? (
              <>
                . Next <Private>{num(h.nextVest.shares)}</Private> on {dayText(h.nextVest.date, date)}.
              </>
            ) : (
              '.'
            )}
          </p>
        )}
      </div>
      {cliffProgress != null && cliffProgress > 0 && (
        <div className="mt-3">
          <Meter value={Math.round(cliffProgress * 100)} max={100} label="Progress to your 1-year cliff" />
          <p className="mt-1 text-[12.5px] text-ink-3">{Math.round(cliffProgress * 100)}% of the way to your cliff</p>
        </div>
      )}
    </Panel>
  )
}

function ComingUp({ db, person }: { db: DB; person: Person }) {
  const date = today()
  const holidays = useMemo(() => upcomingHolidays(db, date, 3), [db, date])
  const out = useMemo(() => teammatesOut(db, person.id, date, addDays(date, 6)), [db, person.id, date])
  const starting = useMemo(() => startingThisMonth(db, person.id, date), [db, person.id, date])
  const nextNew = starting.length ? undefined : nextStarter(db, person.id, date)
  const anniversary = nextAnniversary(person.startDate, date)
  const showAnniversary = anniversary && daysBetween(date, anniversary.date) <= 60
  return (
    <Panel title="Coming up" icon="calendar-check">
      {showAnniversary && anniversary && (
        <p className="mb-3 rounded-xl bg-accent-soft px-3.5 py-2.5 text-[14px] text-ink">

          Your {anniversary.years === 1 ? 'first' : ordinal(anniversary.years)} work anniversary is {dayText(anniversary.date, date)}.
        </p>
      )}
      <SectionLabel>Holidays</SectionLabel>
      {holidays.length ? (
        <ul className="divide-y divide-line">
          {holidays.map((h) => (
            <LineItem key={h.id} label={h.name} value={dayText(h.date, date)} />
          ))}
        </ul>
      ) : (
        <p className="py-2.5 text-[14px] text-ink-3">No more holidays loaded yet.</p>
      )}

      <SectionLabel className="mt-3">Out this week</SectionLabel>
      {out.length ? (
        <ul className="divide-y divide-line">
          {out.map((o) => (
            <LineItem
              key={o.personId}
              label={
                <a href={links.person(o.personId)} className="-my-2.5 inline-flex min-h-10 items-center font-semibold text-ink hover:text-accent">
                  {o.name}
                </a>
              }
              value={`Out ${o.from <= date ? `until ${dayText(o.to, date)}` : rangeText(o.from, o.to, date)}`}
            />
          ))}
        </ul>
      ) : (
        <p className="py-2.5 text-[14px] text-ink-3">Everyone is in this week.</p>
      )}

      <SectionLabel className="mt-3">Starting this month</SectionLabel>
      {starting.length ? (
        <ul className="divide-y divide-line">
          {starting.map((p) => (
            <LineItem
              key={p.id}
              label={
                <a href={links.person(p.id)} className="-my-2.5 inline-flex min-h-10 items-center font-semibold text-ink hover:text-accent">
                  {p.preferredName || p.firstName} {p.lastName}
                </a>
              }
              sub={p.title}
              value={p.startDate >= date ? `Starts ${dayText(p.startDate, date)}` : `Joined ${dayText(p.startDate, date)}`}
            />
          ))}
        </ul>
      ) : (
        <p className="py-2.5 text-[14px] text-ink-3">
          No one new this month.
          {nextNew && (
            <>
              {' '}
              Next:{' '}
              <a href={links.person(nextNew.id)} className="-my-2.5 inline-flex min-h-10 items-center font-semibold text-ink hover:text-accent">
                {nextNew.preferredName || nextNew.firstName} {nextNew.lastName}
              </a>{' '}
              on {dayText(nextNew.startDate, date)}.
            </>
          )}
        </p>
      )}
    </Panel>
  )
}

function ordinal(n: number): string {
  const words = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
  return words[n] ?? `${n}th`
}
