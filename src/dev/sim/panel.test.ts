// The simulator panel rendered to markup (as src/features/assistant/markdown.test.ts renders), before a run
// and with one loaded: the marker CI looks for, the controls, the numbers, the feed newest first, the
// situation list, and a label on every input.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { parseSituations } from '@/sim/situations'
import { sandbox } from './appSandbox'
import { INITIAL_PANEL, type PanelState, reduce } from './panelState'
import type { FromWorker, PausedState } from './protocol'
import { SandboxBanner } from './SandboxBanner'
import { SimPage } from './SimPage'

const point = (date: string, headcount: number) => ({
  date,
  headcount,
  incoming: 2,
  openRoles: 3,
  heldRoles: 1,
  pipeline: 41,
  offersOut: 1,
  startsToDate: 6,
  departuresToDate: 2,
  onLeave: 1,
  monthlyPayroll: 312_400,
})
const paused = (date: string): PausedState => ({
  date,
  metrics: point(date, 22),
  roster: [
    { id: 'p-founder', name: 'Avery Stone', title: 'Founder and CEO', departmentId: 'd-exec', founder: true },
    { id: 'p-2', name: 'Maya Chen', title: 'Account executive', departmentId: 'd-sales', founder: false },
  ],
  departments: [{ id: 'd-eng', name: 'Engineering' }],
  keyframes: ['2026-10-01', '2026-11-01'],
  situations: parseSituations([{ id: 'push', on: '2026-11-02', kind: 'hiringPush', roles: 2, departmentId: 'd-eng' }]),
  pace: { hiringPace: 1, attritionPerYear: 0.12, timeOff: 1, offerAcceptRate: 0.8 },
  size: 2_400_000,
  integrity: 0,
})
const loaded: FromWorker[] = [
  { type: 'ready', label: 'full-20, seed 2020, as of 2026-10-01: Tidebeam', companyName: 'Tidebeam', from: '2026-10-01', run: { version: 1, seed: 1, pace: { preset: 'normal' }, situations: [], until: '2027-10-01' }, ...paused('2026-10-01') },
  {
    type: 'tick',
    date: '2026-11-10',
    playing: false,
    metrics: point('2026-11-10', 22),
    points: [point('2026-11-09', 21), point('2026-11-10', 22)],
    events: [
      { day: '2026-11-09', kind: 'offer_sent', importance: 2, area: 'hiring', text: 'Offer sent to Leo Park.' },
      { day: '2026-11-10', kind: 'started', importance: 1, area: 'people', text: 'Maya Chen started as Account executive.' },
    ],
    notes: [],
  },
  { type: 'paused', reason: 'asked', ...paused('2026-11-10') },
]

/**
 * Server rendering reads a Zustand store's first state (getInitialState), which is the INITIAL_PANEL object
 * itself: a test writes the state it wants into that object, and puts it back after.
 */
const pristine = { ...INITIAL_PANEL }
function show(state: PanelState): void {
  Object.assign(INITIAL_PANEL, state)
}
afterEach(() => {
  Object.assign(INITIAL_PANEL, pristine)
})

const render = () => renderToStaticMarkup(createElement(SimPage, { route: { view: 'sim', segments: ['sim'], raw: 'sim' } }))

/** Every input's id has a label pointing at it, or the input names itself. */
function unlabeledInputs(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0]
    if (/aria-label="[^"]+"/.test(tag) || /type="hidden"/.test(tag)) continue
    const id = /\bid="([^"]+)"/.exec(tag)?.[1]
    if (!id || !html.includes(`for="${id}"`)) out.push(tag)
  }
  return out
}

describe('the simulator panel', () => {
  it('starts with the start picker, under the marker the build check looks for', () => {
    const html = render()
    expect(html).toContain('data-ft-dev="ft-dev-simulator"')
    expect(html).toContain('Simulator (dev)')
    expect(html).toContain('Start a run')
    expect(html).toContain('This company, now')
    expect(html).toContain('Run until')
    expect(html).not.toContain('What happened')
    expect(unlabeledInputs(html)).toEqual([])
  })

  it('shows a loaded run: controls, timeline, numbers, the feed newest first, situations and pace', () => {
    show(loaded.reduce(reduce, { ...INITIAL_PANEL, phase: 'starting' }))
    const html = render()
    expect(html).toContain('Running:</span> full-20, seed 2020, as of 2026-10-01: Tidebeam, until Fri, Oct 1, 2027.')
    expect(html).toContain('Tue, Nov 10, 2026')
    expect(html).toContain('Day 40 of 365')
    expect(html).toMatch(/role="radiogroup" aria-label="Speed"/)
    expect(html).toContain('aria-valuetext="Tue, Nov 10, 2026"')
    expect(html).toContain('aria-keyshortcuts="k"')
    expect(html).toContain('+2 starting')
    expect(html).toContain('1 on hold')
    // Headlines first: the start, not the offer (a detail).
    expect(html).toContain('Maya Chen started as Account executive.')
    expect(html).not.toContain('Offer sent to Leo Park.')
    expect(html).toContain('Hiring push: 2 roles in Engineering')
    expect(html).toContain('Hiring pace')
    expect(html).toContain('Size 2.4 MB of about 5.0 MB a browser keeps. Integrity: no problems.')
    expect(unlabeledInputs(html)).toEqual([])
  })

  it('shows a stop with the way on, and a refusal without it', () => {
    show(reduce(loaded.reduce(reduce, { ...INITIAL_PANEL, phase: 'starting' }), { type: 'error', message: 'Refused.', stopped: true, day: '2026-11-10', traceTail: [] }))
    expect(render()).toContain('The simulation stopped on Tue, Nov 10, 2026')
    show(reduce(loaded.reduce(reduce, { ...INITIAL_PANEL, phase: 'starting' }), { type: 'error', message: 'The situations do not fit.', stopped: false, day: null, traceTail: [] }))
    const html = render()
    expect(html).toContain('That did not go through')
    expect(html).not.toContain('Go back to an earlier day')
  })

  it("keeps the timeline's situation markers from opening the editor while the simulated company is open in the app", () => {
    show(loaded.reduce(reduce, { ...INITIAL_PANEL, phase: 'starting' }))
    const marker = (html: string) => /<button[^>]*aria-label="Mon, Nov 2, 2026: Hiring push[^"]*"[^>]*>/.exec(html)?.[0] ?? ''
    expect(marker(render())).toMatch(/^<button/)
    expect(marker(render())).not.toContain('disabled=""')
    // Server rendering reads the sandbox view's first state too.
    const view = sandbox.view.getInitialState()
    const was = { ...view }
    Object.assign(view, { open: true, date: '2026-11-10', companyName: 'Tidebeam', originalName: 'Ledgerlark' })
    try {
      expect(marker(render())).toContain('disabled=""')
    } finally {
      Object.assign(view, was)
    }
  })

  it('says where it is going while a change of situations lives the days again', () => {
    show({ ...loaded.reduce(reduce, { ...INITIAL_PANEL, phase: 'starting' }), date: '2026-10-01', catchingUp: '2026-11-10' })
    const html = render()
    expect(html).toContain('Living the days again to Nov 10')
    expect(html).not.toContain('Day 0 of 365')
  })

  it('shows no banner while no simulated company is open', () => {
    expect(renderToStaticMarkup(createElement(SandboxBanner))).toBe('')
  })
})
