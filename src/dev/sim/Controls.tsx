// The simulator panel's control bar and timeline: play and pause, steps, speeds, the date, back a month, and
// a timeline from the run's start to its end with the monthly points it can go back to, the situations and
// the freezes. A native range input under the timeline scrubs by keyboard: earlier days go back, later days
// play there as fast as the simulator goes.
import { useEffect, useRef, useState } from 'react'
import { addDays, addMonths, daysBetween, fmtShort, type ISODate } from '@/lib/dates'
import { Button, cx, Kbd, Segmented } from '@/ui'
import { simulator, useSim } from './client'
import { fmtSimDay, freezeWindows, namesFrom, situationSummary, timelineAt } from './helpers'
import { SPEED_ORDER, SPEEDS, type Speed } from './protocol'

/** The day a month before `date`, never before the run's start. */
export function monthBack(date: ISODate, from: ISODate): ISODate {
  const back = addMonths(date, -1)
  return back < from ? from : back
}

export function Controls({ locked, onEditSituation }: { locked: boolean; onEditSituation: (id: string) => void }) {
  const phase = useSim((s) => s.phase)
  const playing = useSim((s) => s.playing)
  const speed = useSim((s) => s.speed)
  const date = useSim((s) => s.date)
  const from = useSim((s) => s.from)
  const until = useSim((s) => s.run?.until ?? null)
  const working = useSim((s) => s.working)
  const catchingUp = useSim((s) => s.catchingUp)
  const stopped = useSim((s) => !!s.error?.stopped)
  const ready = phase === 'ready' && !!date && !!from && !!until
  // Going back is the way on after a stop; everything else waits for a run that goes.
  const off = !ready || locked
  const goOff = off || stopped || working
  const atEnd = ready && date >= until
  return (
    <div className="ft-sim-controls sticky top-[calc(3.5rem+env(safe-area-inset-top,0px))] z-20 -mx-4 border-b border-line bg-paper px-4 py-2.5 sm:-mx-6 sm:px-6 lg:top-0 lg:-mx-0 lg:rounded-xl lg:border lg:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          icon={playing ? 'pause' : 'play'}
          onClick={simulator.toggle}
          disabled={goOff || (atEnd && !playing)}
          aria-keyshortcuts="k"
          title={atEnd ? 'The run is at its end. Start over with a later end date to go further.' : undefined}
        >
          {playing ? 'Pause' : 'Play'}
          <span aria-hidden className="hidden sm:inline-flex">
            <Kbd>K</Kbd>
          </span>
        </Button>
        <Button size="sm" onClick={() => simulator.step(1)} disabled={goOff || playing || atEnd} aria-keyshortcuts="." title="Step a day (.)">
          +1 day
        </Button>
        <Button size="sm" onClick={() => simulator.step(7)} disabled={goOff || playing || atEnd} aria-keyshortcuts="w" title="Step a week (W)">
          +1 week
        </Button>
        {/* A phone keeps one row of buttons: the month step waits for a wider window (M still works). */}
        <span className="hidden sm:contents">
          <Button size="sm" onClick={() => simulator.step(30)} disabled={goOff || playing || atEnd} aria-keyshortcuts="m" title="Step a month (M)">
            +1 month
          </Button>
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon="rotate-ccw"
          onClick={() => date && from && simulator.rewind(monthBack(date, from))}
          disabled={off || working || !date || date === from}
          aria-keyshortcuts="["
          aria-label="Back a month"
        >
          <span className="sm:hidden">Back</span>
          <span className="hidden sm:inline">Back a month</span>
        </Button>
        <Segmented<Speed>
          label="Speed"
          size="sm"
          value={speed}
          onChange={simulator.setSpeed}
          disabled={off}
          options={SPEED_ORDER.map((v) => ({
            value: v,
            label: (
              <>
                <span className="sm:hidden">{SPEEDS[v].short}</span>
                <span className="hidden sm:inline">{SPEEDS[v].label}</span>
              </>
            ),
          }))}
        />
        <p className="ml-auto min-w-0 text-right">
          <span className="num block text-[15px] font-bold text-ink">{date ? fmtSimDay(date) : 'Not started'}</span>
          <span className="block text-[12px] text-ink-3">
            {catchingUp ? `Living the days again to ${fmtShort(catchingUp)}` : working ? 'Working...' : ready ? `Day ${daysBetween(from, date)} of ${daysBetween(from, until)}` : 'Pick a start below'}
          </span>
        </p>
      </div>
      {ready && <Timeline from={from} until={until} date={date} disabled={locked || working} onEditSituation={onEditSituation} />}
    </div>
  )
}

function Timeline({ from, until, date, disabled, onEditSituation }: { from: ISODate; until: ISODate; date: ISODate; disabled: boolean; onEditSituation: (id: string) => void }) {
  const keyframes = useSim((s) => s.keyframes)
  const situations = useSim((s) => s.situations)
  const roster = useSim((s) => s.roster)
  const departments = useSim((s) => s.departments)
  const total = Math.max(1, daysBetween(from, until))
  const lived = daysBetween(from, date)
  // While a scrub is being chosen it shows; once it settles the simulator goes there.
  const [scrub, setScrub] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  const at = (d: ISODate) => `${timelineAt(d, from, until) * 100}%`
  const names = namesFrom(roster, departments)
  const shown = scrub ?? lived
  const settle = (value: number) => {
    setScrub(value)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setScrub(null)
      // The date now, not when the drag happened: a playing run has moved on since (the worker checks again).
      const now = useSim.getState().date ?? date
      const target = addDays(from, value)
      if (target < now) simulator.rewind(target)
      else if (target > now) simulator.playTo(target)
    }, 450)
  }
  return (
    <div className="mt-2">
      <div className="relative h-7">
        <div className="absolute inset-x-0 top-[18px] h-1.5 rounded-full bg-surface-3" />
        {freezeWindows(situations).map((w) => (
          <div
            key={w.id}
            className="absolute top-[15px] h-3 rounded-sm border border-warn bg-warn-soft"
            style={{ left: at(w.from), width: `calc(${at(w.to)} - ${at(w.from)})` }}
            title={`No hiring from ${fmtSimDay(w.from)} to ${fmtSimDay(w.to)}`}
          />
        ))}
        <div className="absolute top-[18px] left-0 h-1.5 rounded-full bg-accent" style={{ width: at(date) }} />
        {keyframes.map((k) => (
          // Mouse and touch only: the range input below does the same by keyboard.
          <button
            key={k}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onClick={() => simulator.rewind(k)}
            className="absolute top-[12px] h-4 w-2 -translate-x-1/2 cursor-pointer rounded-sm border-0 bg-transparent p-0 disabled:cursor-not-allowed"
            style={{ left: at(k) }}
            title={`Go back to ${fmtSimDay(k)}`}
            aria-label={`Go back to ${fmtSimDay(k)}`}
          >
            <span className="mx-auto block h-4 w-px bg-ink-3" />
          </button>
        ))}
        {situations.map((s) => (
          <button
            key={s.id}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onClick={() => s.kind !== 'pace' && onEditSituation(s.id)}
            className={cx('absolute top-0 h-3 w-3 -translate-x-1/2 rotate-45 cursor-pointer rounded-[2px] border-0 p-0 disabled:cursor-not-allowed', s.kind === 'pace' ? 'bg-ink-3' : 'bg-accent')}
            style={{ left: at(s.on) }}
            title={`${fmtSimDay(s.on)}: ${situationSummary(s, names)}`}
            aria-label={`${fmtSimDay(s.on)}: ${situationSummary(s, names)}`}
          />
        ))}
        <div className="absolute top-[10px] h-5 w-0.5 -translate-x-1/2 bg-ink" style={{ left: at(date) }} />
      </div>
      <label className="sr-only" htmlFor="sim-scrubber">
        Simulated date
      </label>
      <input
        id="sim-scrubber"
        type="range"
        min={0}
        max={total}
        step={1}
        value={shown}
        disabled={disabled}
        aria-valuetext={fmtSimDay(addDays(from, shown))}
        onChange={(e) => settle(Number(e.target.value))}
        className="block h-8 w-full cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed"
      />
      <div className="flex justify-between text-[12px] text-ink-3">
        <span className="num">{fmtShort(from)}, {from.slice(0, 4)}</span>
        {scrub !== null && <span className="num font-semibold text-ink">Go to {fmtSimDay(addDays(from, scrub))}</span>}
        <span className="num">{fmtShort(until)}, {until.slice(0, 4)}</span>
      </div>
    </div>
  )
}
