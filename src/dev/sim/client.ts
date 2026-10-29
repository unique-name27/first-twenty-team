// The simulator panel's side of the worker (docs/DEV.md, "The simulator panel"): one worker for the page, made
// on first use, and a Zustand store the panel reads. Nothing here belongs to a component, so React StrictMode
// mounting the panel twice never makes a second worker. The panel pauses the worker when it unmounts, so it
// never plays in the background.
import { create } from 'zustand'
import type { DB } from '@/domain/types'
import type { ISODate } from '@/lib/dates'
import type { RunStart } from '@/sim/play'
import type { PaceChanges, SituationInput } from '@/sim/situations'
import { INITIAL_PANEL, type PanelState, reduce } from './panelState'
import type { FromWorker, Speed, ToWorker } from './protocol'

export const useSim = create<PanelState>(() => INITIAL_PANEL)

let worker: Worker | null = null
/** The start of a run on its way to the worker; it becomes the panel's start once the worker is ready. */
let pendingStart: RunStart | null = null
let snapshotSeq = 0
const waiting = new Map<number, { resolve: (s: Snapshot) => void; reject: (e: Error) => void }>()

export type Snapshot = { db: DB; date: ISODate; companyName: string }

function receive(m: FromWorker): void {
  if (m.type === 'snapshot') {
    const w = waiting.get(m.id)
    waiting.delete(m.id)
    w?.resolve({ db: m.db, date: m.date, companyName: m.companyName })
    return
  }
  useSim.setState((s) => reduce(s, m))
  if (m.type === 'ready') useSim.setState({ start: pendingStart })
}

function ensureWorker(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<FromWorker>) => receive(e.data)
  w.onerror = (e: ErrorEvent) => {
    e.preventDefault()
    const message = `The simulator's worker failed: ${e.message || 'it could not load'}. Reload the page to try again.`
    for (const [, p] of waiting) p.reject(new Error(message))
    waiting.clear()
    worker?.terminate()
    worker = null
    useSim.setState((s) => reduce(s, { type: 'error', message, stopped: true, day: s.date, traceTail: [] }))
  }
  worker = w
  return w
}

function send(m: ToWorker): void {
  ensureWorker().postMessage(m)
}

const ready = () => useSim.getState().phase === 'ready'

export const simulator = {
  /** A new run from a run file (JSON the worker checks); the start is kept for saving and bug reports. */
  start(run: { start: RunStart } & Record<string, unknown>): void {
    pendingStart = run.start
    useSim.setState({ phase: 'starting', error: null })
    send({ type: 'start', run })
  },
  /** Plays at the chosen speed; stopAt pauses on that day. */
  play(stopAt?: ISODate): void {
    if (ready()) send({ type: 'play', speed: useSim.getState().speed, ...(stopAt ? { stopAt } : {}) })
  },
  /** Pauses (the worker ignores it when not playing, so a play still on its way is caught too). */
  pause(): void {
    if (worker) send({ type: 'pause' })
  },
  toggle(): void {
    if (useSim.getState().playing) simulator.pause()
    else simulator.play()
  },
  setSpeed(speed: Speed): void {
    useSim.setState({ speed })
    if (useSim.getState().playing) send({ type: 'play', speed })
  },
  step(days: number): void {
    if (!ready()) return
    useSim.setState({ working: true })
    send({ type: 'step', days })
  },
  /** Plays as fast as it goes to a later day, then pauses there (the timeline's scrubber). */
  playTo(to: ISODate): void {
    if (ready()) send({ type: 'play', speed: 'max', stopAt: to })
  },
  setPace(changes: PaceChanges): void {
    if (ready()) send({ type: 'setPace', changes })
  },
  setSituations(situations: SituationInput[]): void {
    if (!ready()) return
    useSim.setState({ working: true })
    send({ type: 'setSituations', situations })
  },
  rewind(to: ISODate): void {
    if (!ready()) return
    useSim.setState({ working: true })
    send({ type: 'rewind', to })
  },
  /** The whole simulated workspace now (Open in the app, Download company). */
  snapshot(): Promise<Snapshot> {
    if (!ready()) return Promise.reject(new Error('Start a run first.'))
    snapshotSeq += 1
    const id = snapshotSeq
    return new Promise<Snapshot>((resolve, reject) => {
      waiting.set(id, { resolve, reject })
      send({ type: 'snapshot', id })
      setTimeout(() => {
        if (!waiting.delete(id)) return
        reject(new Error('The simulator did not answer. Pause it and try again.'))
      }, 20_000)
    })
  },
  clearError(): void {
    useSim.setState({ error: null })
  },
}
