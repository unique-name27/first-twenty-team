// Home blocks owned by this feature: Headcount vs plan, This week, First hire kit.
import { useMemo, useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import type { Viewer } from '@/domain/types'
import { WhosOutStrip } from '@/features/timeoff'
import { fullName } from '@/domain/people'
import { fmtDate, fmtDay, type ISODate, today } from '@/lib/dates'
import { num } from '@/lib/format'
import { useDB } from '@/store/db'
import { Badge, CitationChip, cx, Icon, type IconName, Meter, Panel, Private, StepChart, toast } from '@/ui'
import { dayText } from '@/domain/inbox'
import { firstHireKit, firstHireStarting, kitProgress, setKitItemDone } from './firstHireKit'
import { growthView } from './growth'
import { thisWeek, type WeekEvent, type WeekEventKind } from './thisWeek'

// ---------------------------------------------------------------------------------------------
// Headcount vs plan
// ---------------------------------------------------------------------------------------------

export function GrowthPanel({ solo }: { solo?: boolean }) {
  const db = useDB((s) => s.db)
  const date = today()
  const g = useMemo(() => growthView(db, date), [db, date])
  const [showStory, setShowStory] = useState(false)
  const series = [
    { key: 'actual', label: 'Employees (actual)', points: g.actual, style: 'solid' as const },
    ...(g.hasPlan ? [{ key: 'plan', label: 'Plan', points: g.plan, style: 'dashed' as const }] : []),
  ]
  return (
    <Panel
      title="Headcount vs plan"
      subtitle={g.summary}
      icon="trend"
      actions={
        <a href={links.comp('plan')} className="inline-flex h-11 items-center gap-1 rounded-lg px-3 text-[14px] font-semibold text-accent hover:bg-accent-soft">
          Open plan
          <Icon name="arrow-right" size={16} />
        </a>
      }
    >
      <StepChart
        series={series}
        from={g.from}
        to={g.to}
        height={230}
        todayDate={date}
        references={solo ? [{ value: 5, label: '5' }] : [{ value: 5, label: '5' }, { value: 15, label: '15' }, { value: 20, label: '20' }]}
        markers={g.markers}
        valueLabel="employees"
        ariaLabel={`W-2 headcount since ${fmtDate(g.from)}: ${g.current} today. ${g.summary}`}
      />
      {solo && !g.hasPlan && (
        <p className="mt-2 text-[13.5px] text-ink-3">
          It's just you for now. Add plan lines in{' '}
          <a href={links.comp('plan')} className="-my-2.5 inline-flex min-h-10 items-center font-semibold text-accent underline underline-offset-2">
            Comp and plan
          </a>{' '}
          to see the dotted plan line.
        </p>
      )}
      {g.story.length > 0 && (
        <div className="mt-3 border-t border-line pt-2">
          <button
            type="button"
            aria-expanded={showStory}
            onClick={() => setShowStory((v) => !v)}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg text-[14px] font-semibold text-ink-2 hover:text-ink"
          >
            <Icon name={showStory ? 'chevron-up' : 'chevron-down'} size={16} />
            {showStory ? 'Hide the story so far' : `The story so far (${g.story.length})`}
          </button>
          {showStory && (
            <ol className="mt-1 flex flex-col gap-1.5">
              {g.story.map((s) => (
                <li key={`${s.date}-${s.text}`} className="flex items-start gap-2 text-[14px] text-ink-2">
                  <span aria-hidden className="mt-[7px] h-2 w-2 shrink-0 rounded-full border-2 border-ink-3" />
                  {s.text}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// This week
// ---------------------------------------------------------------------------------------------

const EVENT_ICON: Record<WeekEventKind, IconName> = {
  start: 'user-plus',
  interview: 'message',
  anniversary: 'star',
  cliff: 'gift',
  offer: 'send',
  leave: 'plane',
  deadline: 'flag',
  holiday: 'sun',
}

function EventRow({ e }: { e: WeekEvent }) {
  const body = (
    <>
      <Icon name={EVENT_ICON[e.kind]} size={16} className={cx('mt-0.5 shrink-0', e.statutory ? 'text-bad' : 'text-ink-3')} />
      <span className="min-w-0 flex-1">
        {e.time && <span className="num mr-1.5 font-semibold text-ink">{e.time}</span>}
        <span className="text-ink">{e.text}</span>
        {e.shares != null && (
          <>
            {' '}
            <Private className="font-semibold text-ink">{num(e.shares)} options vest</Private>
          </>
        )}
        {e.statutory && (
          <Badge tone="neutral" className="ml-1.5 align-middle" icon="scale">
            Legal deadline
          </Badge>
        )}
      </span>
    </>
  )
  return (
    <li>
      {e.href ? (
        <a href={e.href} className="-mx-2 flex min-h-11 items-start gap-2.5 rounded-lg px-2 py-2 text-[14px] hover:bg-surface-2">
          {body}
        </a>
      ) : (
        <div className="flex min-h-11 items-start gap-2.5 py-2 text-[14px]">{body}</div>
      )}
    </li>
  )
}

function dayLabel(d: ISODate, date: ISODate): string {
  if (d === date) return `Today, ${dayText(d)}`
  return dayText(d)
}

export function ThisWeekPanel({ viewer, title = 'This week', showWhosOut = true }: { viewer: Viewer; title?: string; showWhosOut?: boolean }) {
  const db = useDB((s) => s.db)
  const date = today()
  const view = useMemo(() => thisWeek(db, viewer, date), [db, viewer, date])
  const end = view.days.length ? view.days[view.days.length - 1].date : date
  const busy = view.days.filter((d) => d.events.length)
  return (
    <Panel title={title} subtitle={`${dayText(date)} to ${dayText(end)}`} icon="calendar">
      {showWhosOut && (
        <div className="mb-3">
          <h3 className="eyebrow mb-1">Who's out</h3>
          <WhosOutStrip from={date} to={end} />
        </div>
      )}
      {busy.length === 0 ? (
        <p className="py-2 text-[14px] text-ink-3">No starts, interviews or deadlines in the next 7 days.</p>
      ) : (
        <div className="flex flex-col divide-y divide-line">
          {view.days.map((d) =>
            d.events.length === 0 ? null : (
              <section key={d.date} aria-label={dayLabel(d.date, date)} className="grid gap-x-4 py-2 sm:grid-cols-[120px_minmax(0,1fr)]">
                <h3 className={cx('pt-2 text-[13.5px] font-bold', d.date === date ? 'text-accent' : 'text-ink-2')}>{dayLabel(d.date, date)}</h3>
                <ul>
                  {d.events.map((e, i) => (
                    <EventRow key={`${e.kind}-${i}`} e={e} />
                  ))}
                </ul>
              </section>
            ),
          )}
        </div>
      )}
      {view.comingUp.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <h3 className="eyebrow">Coming up</h3>
          <ul className="mt-1">
            {view.comingUp.map((e, i) => (
              <EventRow key={`up-${e.kind}-${i}`} e={{ ...e, text: `${dayText(e.date)}: ${e.text}` }} />
            ))}
          </ul>
        </div>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// First hire kit (headcount 1, including a first hire who has not started yet)
// ---------------------------------------------------------------------------------------------

/** The kit while headcount is 1. `showOpenJob` adds the Open your first job button (no job yet). */
export function FirstHireKitPanel({ showOpenJob = true }: { showOpenJob?: boolean }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const date = today()
  const items = useMemo(() => firstHireKit(db, date), [db, date])
  const starting = useMemo(() => firstHireStarting(db, date), [db, date])
  const progress = kitProgress(items)
  const admin = viewer.role === 'admin'
  const toggle = (key: string, done: boolean) => {
    const item = items.find((i) => i.key === key)
    if (!item) return
    const text = done ? `Marked done: ${item.title}` : `Reopened: ${item.title}`
    useDB.getState().mutate(text, (d) => setKitItemDone(d, item, done, date))
    toast({ text, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
  }
  return (
    <Panel
      title="First hire kit"
      subtitle={
        starting
          ? `${fullName(starting)} starts ${fmtDay(starting.startDate)}. Workers' comp, payroll and your templates need to be in place before then.`
          : 'What California expects from employer #1, before and around your first hire.'
      }
      icon="clipboard-check"
      actions={
        <span className="num text-[14px] font-semibold text-ink-2">
          {progress.done} of {progress.total} done
        </span>
      }
    >
      <Meter value={progress.done} max={progress.total} tone={progress.done === progress.total ? 'good' : 'accent'} label="First hire kit progress" />
      <ul className="mt-3 flex flex-col divide-y divide-line">
        {items.map((item) => {
          const id = `kit-${item.key}`
          return (
            <li key={item.key} className="flex items-start gap-1.5 py-3">
              {/* A 44px hit area around the checkbox; the title is a second label for the same box. */}
              <label htmlFor={id} className="-mt-2.5 -ml-3 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-surface-2">
                <input
                  id={id}
                  type="checkbox"
                  checked={item.done}
                  disabled={!admin || !!item.onFile}
                  onChange={(e) => toggle(item.key, e.target.checked)}
                  className="h-5 w-5 cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed"
                  aria-describedby={`${id}-why`}
                />
              </label>
              <div className="min-w-0 flex-1">
                <label htmlFor={id} className={cx('block cursor-pointer text-[15px] font-semibold', item.done ? 'text-ink-2' : 'text-ink')}>
                  {item.title}
                </label>
                <p id={`${id}-why`} className="mt-0.5 text-[13.5px] text-ink-3">
                  {item.why}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {item.neededBy && (
                    <Badge tone="warn" icon="clock">
                      {item.neededBy}
                    </Badge>
                  )}
                  {item.due && (
                    <Badge tone={item.due.estimated ? 'neutral' : 'warn'} icon="clock">
                      {item.due.text}
                    </Badge>
                  )}
                  {item.done && (
                    <Badge tone="good" icon="check">
                      {item.onFile ?? (item.doneOn ? `Done ${fmtDate(item.doneOn)}` : 'Done')}
                    </Badge>
                  )}
                  <CitationChip label={item.link.label} url={item.link.url} />
                  {item.go && !item.done && admin && (
                    <a href={item.go.href} className="inline-flex min-h-10 items-center rounded-full px-2.5 text-[12.5px] font-semibold text-accent hover:bg-accent-soft">
                      {item.go.label}
                    </a>
                  )}
                  {item.due?.estimated && (
                    <a href={links.settings('company')} className="inline-flex min-h-10 items-center rounded-full px-2.5 text-[12.5px] font-semibold text-accent hover:bg-accent-soft">
                      Add the first payroll date
                    </a>
                  )}
                  {item.key === 'kit-payroll' && !item.done && (
                    <a href={links.settings('links')} className="inline-flex min-h-10 items-center rounded-full px-2.5 text-[12.5px] font-semibold text-accent hover:bg-accent-soft">
                      Save the link in Settings
                    </a>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <p className="text-[12.5px] text-ink-3">Not legal advice; confirm with counsel or your PEO.</p>
        {showOpenJob && (
          <a
            href={links.newJob()}
            className="ft-btn ft-btn--primary ft-btn--lg inline-flex h-12 items-center gap-2 rounded-xl bg-accent px-5 text-[15.5px] font-semibold text-accent-ink shadow-sm hover:bg-accent-hover"
          >
            <Icon name="briefcase" size={18} className="ft-btn__icon" />
            Open your first job
          </a>
        )}
      </div>
    </Panel>
  )
}
