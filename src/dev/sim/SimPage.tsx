// The simulator panel (docs/DEV.md, "The simulator panel"), a development page at #sim inside the app's Shell:
// pick a start, then play the company forward at 1 day, 1 week or 1 month a second or as fast as it goes,
// with situations, pace changes, a timeline to go back on, the numbers, a headcount chart and a feed. Open in
// the app shows the simulated company on the real screens without saving or syncing it (sandbox.ts).
//
// Development only: register.ts puts it in the development page slot, and main.tsx loads that only behind
// import.meta.env.DEV, so no build has it.
import { useEffect, useState } from 'react'
import { useShortcut } from '@/app/shortcuts'
import { Button, Callout, PageHeader, Panel, toast } from '@/ui'
import { copyText } from '@/lib/files'
import { sandbox } from './appSandbox'
import { simulator, useSim } from './client'
import { Controls, monthBack } from './Controls'
import { Feed } from './Feed'
import { bugReport, fmtSimDay } from './helpers'
import { PacePanel } from './PacePanel'
import { SPEED_ORDER } from './protocol'
import { Footer } from './RunFiles'
import { Situations } from './Situations'
import { StartPicker } from './StartPicker'
import { HeadcountChart, Tiles } from './Tiles'

/** The panel root's marker: CI looks for it in the one-file build, where it must never be. */
export const PANEL_MARKER = 'ft-dev-simulator'

export function SimPage() {
  const phase = useSim((s) => s.phase)
  const label = useSim((s) => s.label)
  const until = useSim((s) => s.run?.until ?? null)
  const announce = useSim((s) => s.announce)
  const sandboxOpen = sandbox.view((s) => s.open)
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const ready = phase === 'ready'
  // Leaving the page pauses the simulation: it never plays where nobody watches.
  useEffect(() => () => simulator.pause(), [])
  useSimShortcuts(ready && !sandboxOpen)
  return (
    <div data-ft-dev={PANEL_MARKER} className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Development build only"
        title="Simulator (dev)"
        subtitle="Play a company forward in fast time, set up situations, and open the result in the app. Nothing here is saved or synced unless you keep it."
      />
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <ErrorCallout />
      {sandboxOpen && <SandboxCallout />}
      {!ready || picking ? (
        <Panel title="Start a run" actions={ready ? <Button size="sm" variant="ghost" onClick={() => setPicking(false)}>Keep the current run</Button> : undefined}>
          <StartPicker sandboxOpen={sandboxOpen} onStarted={() => setPicking(false)} />
        </Panel>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-ink-2">
          <span className="min-w-0">
            <span className="font-semibold text-ink">Running:</span> {label}
            {until ? `, until ${fmtSimDay(until)}` : ''}.
          </span>
          <Button size="sm" variant="ghost" icon="rotate-ccw" onClick={() => setPicking(true)}>
            Start over
          </Button>
        </div>
      )}
      <Controls locked={sandboxOpen} onEditSituation={setEditing} />
      {ready && (
        <>
          <Tiles />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <div className="min-w-0 lg:col-span-3">
              <HeadcountChart />
            </div>
            <div className="min-w-0 lg:col-span-2">
              <Feed />
            </div>
          </div>
          <Situations locked={sandboxOpen} editing={editing} onEdit={setEditing} />
          <PacePanel locked={sandboxOpen} />
        </>
      )}
      <Footer locked={sandboxOpen} />
    </div>
  )
}

/** k play or pause, . a day, w a week, m a month, 1 to 4 the speed, [ back a month (listed in the ? sheet). */
function useSimShortcuts(on: boolean) {
  const opts = (description: string) => ({ description, group: 'Simulator', enabled: on })
  const go = () => on && !useSim.getState().playing && !useSim.getState().working && !useSim.getState().error?.stopped
  useShortcut('k', () => !useSim.getState().error?.stopped && simulator.toggle(), opts('Play or pause'))
  useShortcut('.', () => go() && simulator.step(1), opts('Step a day'))
  useShortcut('w', () => go() && simulator.step(7), opts('Step a week'))
  useShortcut('m', () => go() && simulator.step(30), opts('Step a month'))
  useShortcut('[', () => {
    const s = useSim.getState()
    if (s.date && s.from && s.date !== s.from && !s.working) simulator.rewind(monthBack(s.date, s.from))
  }, opts('Back a month'))
  useShortcut('1', () => simulator.setSpeed(SPEED_ORDER[0]), opts('Speed: 1 day a second'))
  useShortcut('2', () => simulator.setSpeed(SPEED_ORDER[1]), opts('Speed: 1 week a second'))
  useShortcut('3', () => simulator.setSpeed(SPEED_ORDER[2]), opts('Speed: 1 month a second'))
  useShortcut('4', () => simulator.setSpeed(SPEED_ORDER[3]), opts('Speed: as fast as it goes'))
}

function ErrorCallout() {
  const error = useSim((s) => s.error)
  if (!error) return null
  const copy = async () => {
    const s = useSim.getState()
    if (!s.start || !s.run) return
    const ok = await copyText(bugReport({ start: s.start, run: s.run, situations: s.situations, label: s.label, date: s.date, error: s.error }))
    toast(ok ? { text: 'Bug report copied.' } : { text: 'Copy was blocked by the browser.', tone: 'bad' })
  }
  return (
    <Callout
      tone={error.stopped ? 'bad' : 'warn'}
      title={error.stopped ? `The simulation stopped${error.day ? ` on ${fmtSimDay(error.day)}` : ''}` : 'That did not go through'}
      action={
        <span className="flex flex-wrap gap-2">
          {error.stopped && (
            <Button size="sm" onClick={copy}>
              Copy bug report
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={simulator.clearError}>
            Dismiss
          </Button>
        </span>
      }
    >
      <p className="break-words">{error.message}</p>
      {error.stopped && <p className="mt-1">Go back to an earlier day on the timeline (or Back a month) to go on. A stop is a bug in the simulator or the app: please file it with the bug report.</p>}
    </Callout>
  )
}

function SandboxCallout() {
  const name = sandbox.view((s) => s.companyName)
  const edited = sandbox.edited()
  return (
    <Callout
      tone="accent"
      title={`${name} is open in the app`}
      action={
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            sandbox.back()
            simulator.play()
          }}
        >
          Back to my company and continue
        </Button>
      }
    >
      The simulation waits while it is open. {edited ? 'Changes you made to it in the app are dropped: the simulation goes on from where it paused.' : 'Go back to your company to play, step or change situations.'}
    </Callout>
  )
}
