// The pace the simulated people act at, changed while the simulation plays or while it is paused: hiring pace,
// attrition, time off and offer acceptance. A change applies from the next simulated day and is kept in the
// run as a pace situation, so a saved run plays the same again. Moves made while dragging settle into one.
import { useEffect, useRef, useState } from 'react'
import type { Pace, PaceChanges } from '@/sim/situations'
import { Panel } from '@/ui'
import { simulator, useSim } from './client'

type Knob = { key: keyof Pace; label: string; min: number; max: number; step: number; show: (v: number) => string; hint: string }

const KNOBS: Knob[] = [
  { key: 'hiringPace', label: 'Hiring pace', min: 0, max: 3, step: 0.1, show: (v) => `${v.toFixed(1)}x`, hint: 'Candidates a week on each job, and roles kept open.' },
  { key: 'attritionPerYear', label: 'Attrition', min: 0, max: 0.4, step: 0.01, show: (v) => `${Math.round(v * 100)}% a year`, hint: 'The chance a person resigns within a year.' },
  { key: 'timeOff', label: 'Time off', min: 0, max: 3, step: 0.1, show: (v) => `${v.toFixed(1)}x`, hint: 'Vacation requests and sick days.' },
  { key: 'offerAcceptRate', label: 'Offer acceptance', min: 0, max: 1, step: 0.05, show: (v) => `${Math.round(v * 100)}%`, hint: 'Of the rest, 60% decline and the others never answer.' },
]

export function PacePanel({ locked }: { locked: boolean }) {
  const pace = useSim((s) => s.pace)
  const ready = useSim((s) => s.phase === 'ready')
  const stopped = useSim((s) => !!s.error?.stopped)
  const error = useSim((s) => s.error)
  // What the sliders show until the worker answers with the new pace (or refuses it); its pace otherwise.
  const [moving, setMoving] = useState<Partial<Pace>>({})
  const pendingChanges = useRef<PaceChanges>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  useEffect(() => setMoving({}), [pace, error])
  if (!pace) return null
  const off = !ready || locked || stopped
  const move = (key: keyof Pace, raw: number) => {
    const value = Number(raw.toFixed(2))
    setMoving((m) => ({ ...m, [key]: value }))
    pendingChanges.current = { ...pendingChanges.current, [key]: value }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const changes = pendingChanges.current
      pendingChanges.current = {}
      simulator.setPace(changes)
    }, 400)
  }
  return (
    <Panel title="Pace" subtitle="Changes apply from the next simulated day, playing or paused, and are kept in the run.">
      <div className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
        {KNOBS.map((k) => {
          const value = moving[k.key] ?? pace[k.key]
          const id = `sim-pace-${k.key}`
          return (
            <div key={k.key} className="min-w-0">
              <div className="flex items-baseline justify-between gap-3">
                <label htmlFor={id} className="ft-field__label text-[13.5px] font-semibold text-ink-2">
                  {k.label}
                </label>
                <output htmlFor={id} className="num text-[14px] font-semibold text-ink">
                  {k.show(value)}
                </output>
              </div>
              <input
                id={id}
                type="range"
                min={k.min}
                max={k.max}
                step={k.step}
                value={Math.min(k.max, value)}
                disabled={off}
                aria-valuetext={k.show(value)}
                aria-describedby={`${id}-hint`}
                onChange={(e) => move(k.key, Number(e.target.value))}
                className="block h-8 w-full cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed"
              />
              <p id={`${id}-hint`} className="text-[12.5px] text-ink-3">
                {k.hint}
              </p>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}
