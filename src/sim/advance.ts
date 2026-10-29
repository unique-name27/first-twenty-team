// The time machine (docs/DEV.md, "The time machine"). advance moves a workspace forward day by day, from the
// company's current date (the clock override) to a later date, the way the company would live those days in
// the app: one stepTo of a Simulation (src/sim/simulation.ts), which runs the machine in src/sim/machine.ts
// (what the people do each day is described there).
//
// The whole advance is one run (src/lib/runContext.ts) that avoids the ids the workspace already holds, and
// every random choice comes from one generator seeded with the seed and the starting date, so the same
// workspace, date, seed and policy give byte-identical JSON. Test and tooling code only (src/sim/guard.test.ts).
import type { DB } from '@/domain/types'
import { getClockOverride, type ISODate, isUsableDate, setClockOverride } from '@/lib/dates'
import { money, num } from '@/lib/format'
import type { TraceLine } from './actions'
import type { AdvancePolicy, AdvanceReport, PolicyInput } from './machine'
import { Simulation } from './simulation'

export { type AdvancePolicy, type AdvanceReport, POLICIES, type PolicyInput, type PolicyName, resolvePolicy } from './machine'

export type AdvanceOptions = {
  /** The last day to live through (inclusive). The company's date (the clock override) ends on it. */
  to: ISODate
  /** Same workspace, date, seed and policy: the same result. */
  seed: number | string
  /** Default normal. */
  policy?: PolicyInput
}

export type AdvanceResult = {
  from: ISODate
  to: ISODate
  seed: number | string
  policy: AdvancePolicy & { name: string }
  db: DB
  /** Every action applied, in order (traceToJsonLines writes it as JSON lines). */
  trace: TraceLine[]
  report: AdvanceReport
  /** A short plain-text account of the days: no ids and no timestamps. */
  summary: string
}

/**
 * Lives through the days after the company's current date (the clock override) up to `to`, and leaves the
 * clock on `to`. Refuses with no clock override (a simulation never follows the real clock) and a `to` before
 * the current date. Days past 2026 run on the rules the app has (the 2026 law tables); holidays roll over each
 * December. Throws when an action the people take is refused (a bug in the simulator or the app); the clock
 * is then left as it was.
 */
export function advance(db: DB, options: AdvanceOptions): AdvanceResult {
  const from = getClockOverride()
  if (!from) throw new Error("Set the company's date with setClockOverride first: advance starts from it and never follows the real clock.")
  const { to, seed } = options
  if (!isUsableDate(to)) throw new Error(`The date to advance to is a date written YYYY-MM-DD, not '${to}'.`)
  if (to < from) throw new Error(`Time only moves forward: the company's date is ${from}, so it cannot advance to ${to}.`)
  const sim = new Simulation(db, { from, seed, policy: options.policy, keyframes: 'none', story: false, metrics: false })
  try {
    sim.stepTo(to)
  } catch (e) {
    setClockOverride(from)
    throw e
  }
  setClockOverride(to)
  const report = sim.report()
  return { from, to, seed, policy: sim.policy, db: sim.db, trace: [...sim.trace], report, summary: advanceSummary(sim.db, report, { from, to, seed, policy: sim.policy.name }) }
}

// ---------------------------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------------------------

/** "balance 2, overlap 1", or "none". */
function countsText(m: Record<string, number>): string {
  const rows = Object.entries(m)
  return rows.length ? rows.map(([k, n]) => `${k.replace(/_/g, ' ')} ${num(n)}`).join(', ') : 'none'
}

/**
 * The days in a few plain lines: no ids and no timestamps, so it changes only when the story does.
 * `compliance: false` says the rules were not evaluated (a simulation with reportCompliance off).
 */
export function advanceSummary(end: DB, r: AdvanceReport, info: { from: ISODate; to: ISODate; seed: number | string; policy: string; compliance?: boolean }): string {
  const lines: string[] = []
  const h = r.hiring
  lines.push(
    `Advanced ${end.company.name} from ${info.from} to ${info.to}: ${num(r.days)} days, ${num(r.businessDays)} business days, ${info.policy} policy, seed ${info.seed}. ${num(r.actions)} actions.`,
  )
  lines.push(
    `Headcount: ${num(r.headcount.from)} employed on ${info.from}, ${num(r.headcount.to)} on ${info.to}; ${num(r.headcount.starts)} started, ${num(r.headcount.separations)} resigned, ${num(r.headcount.incoming)} starting later.`,
  )
  lines.push(
    `Time off: ${num(r.timeOff.vacation)} vacation requests and ${num(r.timeOff.sick)} sick days sent, ${num(r.timeOff.approved)} approved the next business day; kept back after a warning: ${countsText(r.timeOff.heldBack)}.`,
  )
  lines.push(
    `Hiring: ${num(h.planned)} roles planned, ${num(h.opened)} jobs opened (${num(h.backfills)} backfills, ${num(h.postingsHeld)} held from posting); ${num(h.candidates)} candidates, ${num(h.interviews)} interviews, ${num(h.scorecards)} scorecards; ${num(h.rejected)} rejected, ${num(h.withdrew)} withdrew.`,
  )
  lines.push(
    `Offers: ${num(h.offersDrafted)} drafted, ${num(h.offersSent)} sent, ${num(h.accepted)} accepted, ${num(h.declined)} declined, ${num(h.expired)} expired; held by a send blocker: ${countsText(h.offersHeld)}. Hires: ${num(h.hires)}.`,
  )
  lines.push(`Raises: ${num(r.raises.given)} on work anniversaries, ${num(r.raises.heldOutsideBand)} held outside the band. Leaves: ${num(r.leaves.started)} started, ${num(r.leaves.returned)} returned.`)
  const runs = r.payRuns
  const gross = runs.reduce((t, x) => t + x.estimatedGross, 0)
  lines.push(
    runs.length
      ? `Pay runs: ${num(runs.length)} submitted, periods ${runs[0].start} to ${runs[runs.length - 1].end} (${num(runs.filter((x) => x.late).length)} after the cutoff); estimated gross ${money(gross)}.`
      : 'Pay runs: none due.',
  )
  lines.push(`Inbox: ${num(r.inbox.sweeps)} weekly sweeps cleared ${num(Object.values(r.inbox.cleared).reduce((t, n) => t + n, 0))} items (${countsText(r.inbox.cleared)}). Tasks done by their owners: ${num(r.tasksDone)}.`)
  lines.push(`Holidays added: ${r.holidaysAdded.length ? r.holidaysAdded.join(', ') : 'none'}.`)
  lines.push(
    info.compliance === false
      ? 'Compliance: not evaluated in this run.'
      : `Compliance: ${num(r.compliance.checks)} weekly checks; began to apply: ${r.compliance.began.length ? r.compliance.began.map((b) => `${b.title} (${b.on})`).join('; ') : 'none'}; ${num(r.compliance.openActions)} open actions at the last check.`,
  )
  return lines.join('\n') + '\n'
}
