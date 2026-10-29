// Where a run starts: this company as it is now, a generated scenario with its seed (and as-of date), or the
// sample; then the run's own seed, the pace preset and the day it runs until (a year by default, three at most).
import { useState } from 'react'
import { type ISODate, today } from '@/lib/dates'
import type { RunStart } from '@/sim/play'
import { SCENARIO_NAMES, SCENARIOS, type ScenarioName } from '@/sim/scenarios'
import { getDB, useDB } from '@/store/db'
import { Button, DateInput, Field, FormGrid, NumberInput, Segmented, Select } from '@/ui'
import { simulator, useSim } from './client'
import { fmtSimDay, untilLimits } from './helpers'

type StartKind = 'company' | 'scenario' | 'sample'
type Preset = 'quiet' | 'normal' | 'busy'

/** The scenarios a browser can hold (stress is for the server), less the sample (its own choice). */
const PICKABLE = SCENARIO_NAMES.filter((n) => SCENARIOS[n].target === 'browser' && n !== 'ledgerlark')

export function StartPicker({ sandboxOpen, onStarted }: { sandboxOpen: boolean; onStarted: () => void }) {
  const phase = useSim((s) => s.phase)
  const companyName = useDB((s) => s.db.company.name)
  const [kind, setKind] = useState<StartKind>(sandboxOpen ? 'scenario' : 'company')
  const [scenario, setScenario] = useState<ScenarioName>('full-20')
  const [seed, setSeed] = useState<number | null>(SCENARIOS['full-20'].seed)
  const [asOf, setAsOf] = useState('')
  const [runSeed, setRunSeed] = useState<number | null>(1)
  const [preset, setPreset] = useState<Preset>('normal')
  const [until, setUntil] = useState('')
  const [tried, setTried] = useState(false)
  const from: ISODate = kind === 'company' ? today() : kind === 'sample' ? SCENARIOS.ledgerlark.asOf : asOf || SCENARIOS[scenario].asOf
  const limits = untilLimits(from)
  const end = until || limits.byDefault
  const problems: Record<string, string> = {}
  if (kind === 'company' && sandboxOpen) problems.kind = 'The simulated company is open in the app: go back to your company first.'
  if (kind === 'scenario' && (seed === null || !Number.isSafeInteger(seed) || seed < 0)) problems.seed = 'Enter a whole number, 0 or more.'
  if (runSeed === null || !Number.isSafeInteger(runSeed) || runSeed < 0) problems.runSeed = 'Enter a whole number, 0 or more.'
  if (end <= from) problems.until = `Pick a day after the start (${fmtSimDay(from)}).`
  else if (end > limits.latest) problems.until = `Pick a day on or before ${fmtSimDay(limits.latest)} (about three years).`
  const show = (f: string) => (tried ? problems[f] : undefined)
  const start = () => {
    setTried(true)
    if (Object.keys(problems).length > 0) return
    const begin: RunStart =
      kind === 'company'
        ? { kind: 'workspace', date: from, db: getDB() as unknown as Record<string, unknown> }
        : kind === 'sample'
          ? { kind: 'sample' }
          : { kind: 'scenario', scenario, seed: seed as number, ...(asOf ? { asOf } : {}) }
    simulator.start({ version: 1, start: begin, seed: runSeed as number, pace: { preset }, situations: [], until: end })
    onStarted()
  }
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        start()
      }}
    >
      <div className="flex flex-col gap-1.5">
        <span aria-hidden className="ft-field__label text-[13.5px] font-semibold text-ink-2">
          Start from
        </span>
        <Segmented<StartKind>
          label="Start from"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'company', label: 'This company, now' },
            { value: 'scenario', label: 'A scenario' },
            { value: 'sample', label: 'The sample' },
          ]}
        />
        {show('kind') && <p className="ft-field__error text-[12.5px] font-semibold text-bad">{problems.kind}</p>}
        <p className="text-[13px] text-ink-3">
          {kind === 'company'
            ? `${companyName} as this browser has it, on ${fmtSimDay(from)}. The simulation works on a copy: your company is not touched.`
            : kind === 'sample'
              ? `The sample company, on its own date (${fmtSimDay(from)}).`
              : SCENARIOS[scenario].description}
        </p>
      </div>
      {kind === 'scenario' && (
        <FormGrid>
          <Field label="Scenario">
            {(id) => (
              <Select<ScenarioName>
                id={id}
                value={scenario}
                options={PICKABLE.map((n) => ({ value: n, label: n }))}
                onChange={(v) => {
                  setScenario(v)
                  setSeed(SCENARIOS[v].seed)
                }}
              />
            )}
          </Field>
          <Field label="Scenario seed" hint="The same seed builds the same company." error={show('seed')}>
            {(id, describedBy) => <NumberInput id={id} aria-describedby={describedBy} min={0} step={1} sensitive={false} value={seed} onChange={setSeed} />}
          </Field>
          <Field label="As of" hint={`Left empty: the scenario's own date, ${fmtSimDay(SCENARIOS[scenario].asOf)}.`}>
            {(id, describedBy) => <DateInput id={id} aria-describedby={describedBy} value={asOf} onChange={setAsOf} />}
          </Field>
        </FormGrid>
      )}
      <FormGrid>
        <Field label="Run seed" hint="The same start, seed, pace and situations play the same run." error={show('runSeed')}>
          {(id, describedBy) => <NumberInput id={id} aria-describedby={describedBy} min={0} step={1} sensitive={false} value={runSeed} onChange={setRunSeed} />}
        </Field>
        <Field label="Pace">
          {(id) => (
            <Select<Preset>
              id={id}
              value={preset}
              onChange={setPreset}
              options={[
                { value: 'quiet', label: 'Quiet' },
                { value: 'normal', label: 'Normal' },
                { value: 'busy', label: 'Busy' },
              ]}
            />
          )}
        </Field>
        <Field label="Run until" hint={`Left empty: a year on, ${fmtSimDay(limits.byDefault)}.`} error={show('until')}>
          {(id, describedBy) => <DateInput id={id} aria-describedby={describedBy} value={until} min={from} max={limits.latest} onChange={setUntil} />}
        </Field>
      </FormGrid>
      <div>
        <Button type="submit" variant="primary" icon="play" disabled={phase === 'starting'}>
          {phase === 'starting' ? 'Starting...' : 'Start the run'}
        </Button>
      </div>
    </form>
  )
}
