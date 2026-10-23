// Month calendar of who is out. A keyboard grid (arrows move a day or a week, Home and End go to the
// week's ends, Page Up and Page Down change month); the focused day's list shows below the grid.
// Weekends and company holidays are shaded and labeled. Non-permitted viewers see only "Out".
import { useEffect, useMemo, useRef, useState } from 'react'
import { useViewer } from '@/app/useViewer'
import { fullName } from '@/domain/people'
import { type OutEntry, whoIsOut } from '@/domain/timeoff'
import { addDays, fmtDay, fmtMonth, type ISODate, isWeekday, parseDate, today } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { Badge, Button, cx, Dot, Icon, IconButton } from '@/ui'
import { entryView, monthEnd, monthStart, monthWeeks, outByDay, shiftMonth, shortRange, weekMonday } from './logic'
import { PersonName } from './parts'

const WEEKDAYS = [
  { short: 'Mon', long: 'Monday' },
  { short: 'Tue', long: 'Tuesday' },
  { short: 'Wed', long: 'Wednesday' },
  { short: 'Thu', long: 'Thursday' },
  { short: 'Fri', long: 'Friday' },
  { short: 'Sat', long: 'Saturday' },
  { short: 'Sun', long: 'Sunday' },
]

type Shown = OutEntry & { text: string; pending: boolean; detail: boolean; key: string }

function longDay(d: ISODate): string {
  return parseDate(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

export function TimeOffCalendar() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const t = today()
  const [active, setActive] = useState<ISODate>(t)
  const [month, setMonth] = useState<ISODate>(monthStart(t))
  const cells = useRef(new Map<ISODate, HTMLTableCellElement>())
  const moveFocus = useRef(false)

  const weeks = useMemo(() => monthWeeks(month), [month])
  const from = weeks[0][0]
  const to = weeks[weeks.length - 1][6]

  const shown = useMemo<Shown[]>(() => {
    return whoIsOut(db, from, to)
      .map((e, i) => ({ e, v: entryView(db, viewer, e), i }))
      .filter(({ v }) => v.visible)
      .map(({ e, v, i }) => ({ ...e, text: v.text, pending: v.pending, detail: v.detail, key: `${e.requestId ?? e.leaveCaseId ?? 'x'}-${i}` }))
  }, [db, viewer, from, to])

  const byDay = useMemo(() => outByDay(shown, from, to, db.holidays) as Map<ISODate, Shown[]>, [shown, from, to, db.holidays])
  const holidayOn = useMemo(() => new Map(db.holidays.map((h) => [h.date, h.name])), [db.holidays])

  useEffect(() => {
    if (!moveFocus.current) return
    moveFocus.current = false
    cells.current.get(active)?.focus()
  }, [active, month])

  const go = (d: ISODate, focus: boolean) => {
    moveFocus.current = focus
    setActive(d)
    if (monthStart(d) !== month) setMonth(monthStart(d))
  }

  const onKey = (e: React.KeyboardEvent) => {
    const map: Record<string, () => ISODate> = {
      ArrowLeft: () => addDays(active, -1),
      ArrowRight: () => addDays(active, 1),
      ArrowUp: () => addDays(active, -7),
      ArrowDown: () => addDays(active, 7),
      Home: () => weekMonday(active),
      End: () => addDays(weekMonday(active), 6),
      PageUp: () => shiftMonth(active, -1),
      PageDown: () => shiftMonth(active, 1),
    }
    const f = map[e.key]
    if (!f) return
    e.preventDefault()
    go(f(), true)
  }

  const activeList = byDay.get(active) ?? []
  const activeHoliday = holidayOn.get(active)
  const monthEntries = shown
    .filter((e) => e.from <= monthEnd(month) && e.to >= month)
    .sort((a, b) => a.from.localeCompare(b.from))

  const personOf = (id: string) => db.people.find((p) => p.id === id)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-[18px] font-bold text-ink" aria-live="polite">
          {parseDate(month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
        </h3>
        <div className="flex items-center gap-1">
          <IconButton icon="chevron-left" label="Previous month" variant="secondary" onClick={() => go(shiftMonth(month, -1), false)} />
          <Button variant="secondary" onClick={() => go(t, false)} disabled={month === monthStart(t) && active === t}>
            Today
          </Button>
          <IconButton icon="chevron-right" label="Next month" variant="secondary" onClick={() => go(shiftMonth(month, 1), false)} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-3">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-3 rounded-sm bg-surface-3" /> Weekend
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-3 rounded-sm bg-accent-soft" /> Company holiday
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-3 rounded-sm border border-dashed border-warn" /> Pending
        </span>
        <span className="hidden sm:inline">Arrow keys move between days; Page Up and Page Down change month.</span>
      </div>

      <table role="grid" aria-label={`Who is out, ${fmtMonth(month)}`} className="w-full table-fixed border-collapse" onKeyDown={onKey}>
        <thead>
          <tr>
            {WEEKDAYS.map((w) => (
              // Weekends keep full-strength muted ink (contrast); the day cells below carry the weekend shading.
              <th key={w.short} scope="col" abbr={w.long} className="pb-1.5 text-center text-[12px] font-bold text-ink-3">
                <span aria-hidden>{w.short.slice(0, 1)}</span>
                <span className="sr-only">{w.long}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((d) => {
                const inMonth = d.slice(0, 7) === month.slice(0, 7)
                const weekend = !isWeekday(d)
                const holiday = holidayOn.get(d)
                const list = byDay.get(d) ?? []
                const isActive = d === active
                const isToday = d === t
                const names = list.map((e) => {
                  const p = personOf(e.personId)
                  return p ? `${fullName(p)} (${e.text}${e.pending ? ', pending' : ''})` : e.text
                })
                const aria = [
                  longDay(d),
                  isToday ? 'today' : '',
                  weekend ? 'weekend' : '',
                  holiday ? `company holiday: ${holiday}` : '',
                  list.length ? `${plural(list.length, 'person', 'people')} out: ${names.join(', ')}` : weekend || holiday ? '' : 'nobody out',
                ]
                  .filter(Boolean)
                  .join('. ')
                return (
                  <td
                    key={d}
                    ref={(el) => {
                      if (el) cells.current.set(d, el)
                      else cells.current.delete(d)
                    }}
                    role="gridcell"
                    tabIndex={isActive ? 0 : -1}
                    aria-selected={isActive}
                    aria-label={aria}
                    onClick={() => go(d, true)}
                    className={cx(
                      'h-14 cursor-pointer border border-line p-1 align-top sm:h-24 sm:p-1.5',
                      weekend ? 'bg-surface-3/60' : holiday ? 'bg-accent-soft' : 'bg-surface',
                      !inMonth && 'opacity-55',
                      isActive && 'outline-2 -outline-offset-2 outline-accent',
                    )}
                  >
                    <div className="flex flex-col items-start gap-0.5">
                      <span
                        aria-hidden
                        className={cx(
                          'num inline-flex h-6 min-w-6 items-center justify-center rounded-full text-[12.5px] font-bold',
                          isToday ? 'bg-accent text-accent-ink' : 'text-ink-2',
                        )}
                      >
                        {Number(d.slice(8, 10))}
                      </span>
                      {list.length > 0 && (
                        <span
                          aria-hidden
                          className={cx(
                            'num inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[11px] font-bold sm:hidden',
                            list.some((e) => e.pending) ? 'border border-dashed border-warn text-ink-2' : 'bg-good-soft text-good',
                          )}
                        >
                          {list.length}
                        </span>
                      )}
                    </div>
                    {holiday && (
                      <div aria-hidden className="mt-0.5 hidden truncate text-[11px] font-semibold text-accent-soft-ink sm:block" title={holiday}>
                        {holiday}
                      </div>
                    )}
                    {holiday && <Dot tone="accent" className="mt-1 sm:hidden" />}
                    {list.length > 0 && (
                      <ul aria-hidden className="mt-0.5 hidden flex-col gap-0.5 sm:flex">
                        {list.slice(0, 3).map((e) => {
                          const p = personOf(e.personId)
                          return (
                            <li
                              key={e.key}
                              title={`${p ? fullName(p) : ''}: ${e.text}${e.pending ? ' (pending)' : ''}`}
                              className={cx(
                                'truncate rounded px-1 text-[11.5px] leading-[18px] font-semibold',
                                e.pending ? 'border border-dashed border-warn text-ink-2' : e.kind === 'leave' ? 'bg-surface-3 text-ink' : 'bg-good-soft text-ink',
                              )}
                            >
                              {p ? (p.preferredName || p.firstName) : 'Someone'}
                            </li>
                          )
                        })}
                        {list.length > 3 && <li className="px-1 text-[11px] text-ink-3">+{list.length - 3} more</li>}
                      </ul>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <section aria-label={`Out on ${fmtDay(active)}`} className="rounded-xl border border-line bg-surface-2/60 px-4 py-3">
        <h4 className="font-display text-[15px] font-bold text-ink">{fmtDay(active)}</h4>
        {!isWeekday(active) ? (
          <p className="mt-1 text-[14px] text-ink-3">Weekend.</p>
        ) : activeHoliday ? (
          <p className="mt-1 text-[14px] text-ink-2">Company holiday: {activeHoliday}. Everyone is off.</p>
        ) : activeList.length === 0 ? (
          <p className="mt-1 text-[14px] text-ink-3">Nobody is out.</p>
        ) : (
          <ul className="mt-1 flex flex-col">
            {activeList.map((e) => {
              const p = personOf(e.personId)
              if (!p) return null
              return (
                <li key={e.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line py-1 last:border-b-0">
                  <PersonName person={p} sub={`${e.text}${e.detail ? ` · ${shortRange(e.from, e.to)}` : ''}`} />
                  {e.pending && <Badge tone="warn" icon="clock">Pending</Badge>}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {monthEntries.length > 0 && (
        <details className="group rounded-xl border border-line px-4 py-2">
          <summary className="flex min-h-10 w-fit cursor-pointer items-center gap-1.5 text-[14px] font-semibold text-ink-2">
            <Icon name="chevron-right" size={16} className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
            Everyone out in {parseDate(month).toLocaleDateString('en-US', { month: 'long' })} ({monthEntries.length})
          </summary>
          <ul className="flex flex-col pb-1">
            {monthEntries.map((e) => {
              const p = personOf(e.personId)
              if (!p) return null
              return (
                <li key={e.key} className="flex flex-wrap items-center justify-between gap-x-3 border-b border-line py-1 last:border-b-0">
                  <PersonName person={p} sub={e.detail || e.kind !== 'leave' ? `${e.text} · ${shortRange(e.from, e.to)}` : e.text} />
                  {e.pending && <Badge tone="warn" icon="clock">Pending</Badge>}
                </li>
              )
            })}
          </ul>
        </details>
      )}
    </div>
  )
}
