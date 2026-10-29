// The simulator panel's numbers: a row of tiles for the simulated day, and headcount over the run as a step
// chart (employees, and employees plus people starting), with the situations marked on it.
import { useMemo, useSyncExternalStore } from 'react'
import { fmtDate } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { Money, Panel, Sparkline, Stat, StepChart } from '@/ui'
import { useSim } from './client'
import { fmtSimDay, headcountSeries, namesFrom, situationSummary } from './helpers'

/** True on a phone-width window (under 640px). */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {}
      const q = window.matchMedia('(max-width: 639px)')
      q.addEventListener('change', cb)
      return () => q.removeEventListener('change', cb)
    },
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(max-width: 639px)').matches,
    () => false,
  )
}

/** The last 90 days of one number, for a sparkline. */
function recent(points: ReadonlyArray<Record<string, unknown>>, key: string): number[] {
  return points.slice(-90).map((p) => p[key] as number)
}

export function Tiles() {
  const m = useSim((s) => s.metrics)
  const points = useSim((s) => s.points)
  if (!m) return null
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Stat label="Employees" value={m.headcount} sub={m.incoming ? `+${m.incoming} starting` : 'None starting'} />
      <Stat label="Open roles" value={m.openRoles} sub={m.heldRoles ? `${m.heldRoles} on hold` : plural(m.offersOut, 'offer') + ' out'} />
      <Stat label="In the pipeline" value={m.pipeline} sub={<Sparkline values={recent(points, 'pipeline')} ariaLabel={`Applications in the pipeline over the last ${Math.min(90, points.length)} days`} />} />
      <Stat label="Started / left" value={`${m.startsToDate} / ${m.departuresToDate}`} sub="Since the run began" />
      <Stat label="On leave" value={m.onLeave} />
      <Stat
        label="Monthly payroll"
        value={<Money value={m.monthlyPayroll} short />}
        sub={<Sparkline values={recent(points, 'monthlyPayroll')} ariaLabel={`Monthly payroll over the last ${Math.min(90, points.length)} days, now ${money(m.monthlyPayroll)}`} />}
      />
    </div>
  )
}

export function HeadcountChart() {
  const start = useSim((s) => s.startMetrics)
  const points = useSim((s) => s.points)
  const from = useSim((s) => s.from)
  const until = useSim((s) => s.run?.until)
  const date = useSim((s) => s.date)
  const m = useSim((s) => s.metrics)
  const situations = useSim((s) => s.situations)
  const roster = useSim((s) => s.roster)
  const departments = useSim((s) => s.departments)
  const narrow = useNarrow()
  const series = useMemo(() => headcountSeries(start, points), [start, points])
  const markers = useMemo(() => {
    const names = namesFrom(roster, departments)
    return situations.filter((s) => s.kind !== 'pace').map((s) => ({ date: s.on, label: situationSummary(s, names) }))
  }, [situations, roster, departments])
  if (!from || !until || !date || !m) return null
  return (
    <Panel title="Headcount over time" subtitle="Solid: employees. Dashed: with people starting.">
      <StepChart
        ariaLabel={`Headcount from ${fmtDate(from)} to ${fmtSimDay(date)}: ${plural(m.headcount, 'employee')}, ${m.incoming} starting.`}
        series={[
          { key: 'employees', label: 'Employees', points: series.employees, style: 'solid' },
          { key: 'starting', label: 'With people starting', points: series.withStarting, style: 'dashed', color: 'var(--ink-3)' },
        ]}
        from={from}
        to={until}
        todayDate={date}
        height={narrow ? 180 : 240}
        markers={markers}
        references={[
          { value: 5, label: '5' },
          { value: 15, label: '15' },
          { value: 20, label: '20' },
        ]}
      />
    </Panel>
  )
}
