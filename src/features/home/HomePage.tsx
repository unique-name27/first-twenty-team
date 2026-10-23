// Home: tonight's HR work and where the company stands, on one screen (docs/SPEC.md, Home dashboard).
// Admin: Tonight header, inbox, next threshold, headcount vs plan, this week, hiring pulse, checklists
// in flight and people cost. Hiring manager: their inbox, their week (interviews they are on), their
// jobs' pulse and their team's who's out; no cost, compliance or threshold card. Headcount 1 (the
// founder, even with a first hire who has not started yet): the First hire kit replaces the cost,
// onboarding and hiring blocks. Employees land on Me (the App routes them there); this page shows a
// pointer if reached anyway.
//
// The two columns respond to the page's own width (a container query), not the viewport: the Display
// menu's text size zooms the page, so at 150% a 1280px window lays out like an 853px one.
import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import type { PageProps } from '@/app/routes'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { isInReportingLine } from '@/domain/access'
import { firstHireKitShown, inboxItems, isSoloWorkspace, tonightHeadline, tonightSummary } from '@/domain/inbox'
import type { ID, Viewer } from '@/domain/types'
import { PeopleCostCard } from '@/features/comp'
import { NextThresholdCard } from '@/features/compliance'
import { HiringPulse } from '@/features/hiring/interviews'
import { ChecklistsInFlight } from '@/features/people'
import { WhosOutStrip } from '@/features/timeoff'
import { addDays, type ISODate, today } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { cx, EmptyState, Icon, PageHeader, Panel } from '@/ui'
import { InboxView } from './Inbox'
import { FirstHireKitPanel, GrowthPanel, ThisWeekPanel } from './panels'

/** One block in the two-column layout; `order` sets its place in the single column. */
function Slot({ order, children }: { order: number; children: ReactNode }) {
  const o = ['order-1', 'order-2', 'order-3', 'order-4', 'order-5', 'order-6', 'order-7', 'order-8'][order - 1]
  return <div className={cx('min-w-0', o, '@[900px]:order-none')}>{children}</div>
}

/**
 * Two columns (main and side) once the page area is 900px wide, so the inbox keeps 500px or more; one
 * column, in spec order, below that. Measured on the page itself, so text zoom and the rail both count.
 */
function Columns({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <div className="@container">
      <div className="ft-split ft-split--home flex flex-col gap-5 @[900px]:grid @[900px]:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] @[900px]:items-start">
        <div className="contents @[900px]:flex @[900px]:min-w-0 @[900px]:flex-col @[900px]:gap-5">{main}</div>
        <div className="ft-split__side contents @[900px]:flex @[900px]:min-w-0 @[900px]:flex-col @[900px]:gap-5">{side}</div>
      </div>
    </div>
  )
}

function useHomeData(viewer: Viewer) {
  const db = useDB((s) => s.db)
  const date = today()
  const items = useMemo(() => inboxItems(db, viewer, date), [db, viewer, date])
  const solo = useMemo(() => isSoloWorkspace(db, date), [db, date])
  const kit = useMemo(() => firstHireKitShown(db, date), [db, date])
  const openJobs = useMemo(() => db.jobs.filter((j) => j.status === 'open').length, [db])
  return { db, date, items, solo, kit, openJobs }
}

function TonightSubtitle({ items, solo }: { items: ReturnType<typeof inboxItems>; solo: boolean }) {
  if (solo) return <>It's just you. Here's what California expects from employer #1.</>
  const legal = items.filter((i) => i.statutory && i.group === 'overdue').length
  const yours = items.filter((i) => i.waitingOn === 'you' && i.group !== 'coming_up').length
  if (legal) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-1.5">
        <Icon name="alert" size={16} className="text-bad" />
        <span className="font-semibold text-bad">{legal === 1 ? '1 legal deadline is overdue.' : `${legal} legal deadlines are overdue.`}</span>
        <span>Start with the red rows. {plural(yours, 'item')} waiting on you.</span>
      </span>
    )
  }
  return <>{yours ? `${plural(yours, 'item')} waiting on you. Most take one tap right here.` : 'Nothing is overdue. Nice work.'}</>
}

/** HiringPulse renders bare rows; Home gives it a panel (scoped by canSeePipeline inside). */
function PulsePanel({ manager }: { manager?: boolean }) {
  return (
    <Panel
      title={manager ? 'Your jobs' : 'Hiring pulse'}
      subtitle="Open jobs, funnels and offers out"
      icon="briefcase"
      actions={
        <a href={links.hiring()} className="inline-flex h-11 items-center gap-1 rounded-lg px-3 text-[14px] font-semibold text-accent hover:bg-accent-soft">
          Open hiring
          <Icon name="arrow-right" size={16} />
        </a>
      }
    >
      <HiringPulse />
    </Panel>
  )
}

function InboxPanel({ items, date, viewer }: { items: ReturnType<typeof inboxItems>; date: ISODate; viewer: Viewer }) {
  return (
    <Panel title="Inbox" subtitle="Computed from your data. Act inline; every change can be undone." icon="inbox" id="inbox">
      <InboxView items={items} date={date} viewer={viewer} />
    </Panel>
  )
}

function AdminHome({ viewer }: { viewer: Viewer }) {
  const { db, date, items, solo, kit, openJobs } = useHomeData(viewer)
  const summary = tonightSummary(items)
  const noJobsYet = db.jobs.length === 0
  // Headcount 1 with a first hire on the way: the kit stays, and their pre-start checklist shows too.
  const incoming = kit && !solo
  return (
    <>
      <PageHeader
        eyebrow="Tonight"
        title={tonightHeadline(date, summary)}
        subtitle={<TonightSubtitle items={items} solo={solo} />}
        actions={
          solo && noJobsYet ? (
            <a
              href={links.newJob()}
              className="ft-btn ft-btn--primary ft-btn--lg inline-flex h-12 items-center gap-2 rounded-xl bg-accent px-5 text-[15.5px] font-semibold text-accent-ink shadow-sm hover:bg-accent-hover"
            >
              <Icon name="briefcase" size={18} className="ft-btn__icon" />
              Open your first job
            </a>
          ) : undefined
        }
      />
      {kit ? (
        <Columns
          main={
            <>
              <Slot order={1}>
                <FirstHireKitPanel showOpenJob={noJobsYet} />
              </Slot>
              <Slot order={2}>
                <InboxPanel items={items} date={date} viewer={viewer} />
              </Slot>
              <Slot order={4}>
                <GrowthPanel solo />
              </Slot>
            </>
          }
          side={
            <>
              <Slot order={3}>
                <NextThresholdCard />
              </Slot>
              {incoming && (
                <Slot order={5}>
                  <ChecklistsInFlight />
                </Slot>
              )}
              {openJobs > 0 && (
                <Slot order={6}>
                  <PulsePanel />
                </Slot>
              )}
              <Slot order={7}>
                <ThisWeekPanel viewer={viewer} />
              </Slot>
            </>
          }
        />
      ) : (
        <Columns
          main={
            <>
              <Slot order={1}>
                <InboxPanel items={items} date={date} viewer={viewer} />
              </Slot>
              <Slot order={3}>
                <GrowthPanel />
              </Slot>
              <Slot order={4}>
                <ThisWeekPanel viewer={viewer} />
              </Slot>
            </>
          }
          side={
            <>
              <Slot order={2}>
                <NextThresholdCard />
              </Slot>
              <Slot order={5}>
                <PulsePanel />
              </Slot>
              <Slot order={6}>
                <ChecklistsInFlight />
              </Slot>
              <Slot order={7}>
                <PeopleCostCard />
              </Slot>
            </>
          }
        />
      )}
    </>
  )
}

/** The manager's reporting line plus themselves, or null when they manage nobody (then everyone shows). */
function useTeamIds(viewer: Viewer): ID[] | null {
  const db = useDB((s) => s.db)
  return useMemo(() => {
    const me = viewer.personId
    if (!me) return null
    const line = db.people.filter((p) => p.id !== me && isInReportingLine(viewer, db, p.id)).map((p) => p.id)
    return line.length ? [me, ...line] : null
  }, [db, viewer])
}

/** Team who's out for the next two weeks, with a toggle to see everyone (types stay hidden either way). */
function TeamWhosOutPanel({ viewer, date }: { viewer: Viewer; date: ISODate }) {
  const team = useTeamIds(viewer)
  const [everyone, setEveryone] = useState(false)
  const scoped = !!team && !everyone
  return (
    <Panel
      title={scoped ? "Your team's who's out" : "Who's out"}
      subtitle="The next two weeks"
      icon="plane"
      actions={
        team ? (
          <button
            type="button"
            aria-pressed={everyone}
            onClick={() => setEveryone((v) => !v)}
            className="inline-flex h-11 items-center rounded-lg px-3 text-[14px] font-semibold text-accent hover:bg-accent-soft"
          >
            {everyone ? 'Show my team' : 'Show everyone'}
          </button>
        ) : undefined
      }
    >
      <WhosOutStrip from={date} to={addDays(date, 13)} personIds={scoped ? team : undefined} />
    </Panel>
  )
}

function ManagerHome({ viewer }: { viewer: Viewer }) {
  const { date, items } = useHomeData(viewer)
  const summary = tonightSummary(items)
  const first = viewer.person?.preferredName || viewer.person?.firstName
  return (
    <>
      <PageHeader
        eyebrow={first ? `Tonight for ${first}` : 'Tonight'}
        title={tonightHeadline(date, summary)}
        subtitle={<TonightSubtitle items={items} solo={false} />}
      />
      <Columns
        main={
          <>
            <Slot order={1}>
              <InboxPanel items={items} date={date} viewer={viewer} />
            </Slot>
            <Slot order={2}>
              {/* Who's out has its own team panel, so the week lists interviews and dates only. */}
              <ThisWeekPanel viewer={viewer} title="Your week" showWhosOut={false} />
            </Slot>
          </>
        }
        side={
          <>
            <Slot order={3}>
              <PulsePanel manager />
            </Slot>
            <Slot order={4}>
              <TeamWhosOutPanel viewer={viewer} date={date} />
            </Slot>
          </>
        }
      />
    </>
  )
}

export function HomePage(_: PageProps) {
  const viewer = useViewer()
  if (viewer.role === 'employee') {
    return (
      <EmptyState
        icon="user"
        title="Your home is Me"
        body="In Employee view, Me shows your tasks, time off, pay band and equity."
        action={
          <a href={links.me()} className="font-bold text-accent underline">
            Go to Me
          </a>
        }
      />
    )
  }
  return viewer.role === 'manager' ? <ManagerHome viewer={viewer} /> : <AdminHome viewer={viewer} />
}
