// A generated company in a few plain lines (src/sim/summaries/<scenario>.txt holds each scenario's, and a
// test compares them): headcount, departments, hires by month, open roles, the pipeline, pay runs and
// the records it holds. No ids and no timestamps, so a summary changes only when the company does.
import { jobStages } from '@/domain/hiring'
import { departmentName, employedOn, formerOn, founder, fullName, incomingOn } from '@/domain/people'
import type { DB } from '@/domain/types'
import type { ISODate } from '@/lib/dates'
import { num } from '@/lib/format'
import { RECORD_COLLECTIONS } from '@/sync/collections'
import type { Scenario } from './scenarios'

/** "Engineering 4, Executive 1": counts by key, largest first, then by name. */
function counts(keys: string[]): string {
  const m = new Map<string, number>()
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1)
  const rows = [...m].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
  return rows.length ? rows.map(([k, n]) => `${k} ${num(n)}`).join(', ') : 'none'
}

/** Counts by key in the order the keys first appear (months, stages). */
function inOrder(keys: string[], order: string[]): string {
  const m = new Map<string, number>()
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1)
  const rows = order.filter((k) => m.has(k)).map((k) => `${k} ${num(m.get(k) as number)}`)
  return rows.length ? rows.join(', ') : 'none'
}

export function summarize(db: DB, info: { scenario: Scenario; seed: number; asOf: ISODate; actions: number }): string {
  const { scenario, seed, asOf } = info
  const lines: string[] = []
  lines.push(`Scenario ${scenario.name}: ${scenario.description}`)
  lines.push(`Seed ${seed}, as of ${asOf}. ${info.actions ? `${num(info.actions)} actions.` : scenario.kind === 'sample' ? 'No actions: buildSampleDB built it.' : 'No actions.'}`)
  const f = founder(db)
  lines.push(`Company: ${db.company.name}, founded ${db.company.foundedOn}${f ? `; ${fullName(f)}, ${f.title}` : ''}.`)

  const employed = employedOn(db, asOf)
  const incoming = incomingOn(db, asOf)
  const former = formerOn(db, asOf)
  lines.push(`Headcount on ${asOf}: ${num(employed.length)} employed, ${num(incoming.length)} starting later, ${num(former.length)} former.`)
  lines.push(`Departments: ${counts(employed.map((p) => departmentName(db, p.departmentId)))}.`)
  const hourly = employed.filter((p) => p.flsa === 'non_exempt')
  const partTime = employed.filter((p) => p.employmentType === 'part_time')
  lines.push(`Non-exempt: ${num(hourly.length)}. Part time: ${num(partTime.length)}. Managers: ${num(new Set(employed.map((p) => p.managerId).filter(Boolean)).size)}.`)

  const hires = db.people.filter((p) => !p.isFounder).sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.hireNumber - b.hireNumber))
  const months = [...new Set(hires.map((p) => p.startDate.slice(0, 7)))]
  lines.push(`Starts by month: ${inOrder(hires.map((p) => p.startDate.slice(0, 7)), months)}.`)
  const leavers = db.people.filter((p) => p.separation)
  lines.push(`Separations: ${leavers.length ? leavers.map((p) => `${p.separation?.type} on ${p.separation?.lastDay}`).join('; ') : 'none'}.`)
  const leaves = db.leaveCases.filter((l) => !l.returnedOn && !l.endedOn)
  lines.push(`Open leave cases: ${leaves.length ? leaves.map((l) => `${l.kind} from ${l.startDate}`).join('; ') : 'none'}.`)

  const open = db.jobs.filter((j) => j.status === 'open')
  lines.push(`Jobs: ${counts(db.jobs.map((j) => j.status))}.`)
  for (const j of open) {
    const active = db.applications.filter((a) => a.jobId === j.id && a.status === 'active')
    const stages = jobStages(j)
    const byStage = inOrder(
      active.map((a) => stages.find((s) => s.id === a.stageId)?.name ?? a.stageId),
      stages.map((s) => s.name),
    )
    lines.push(`Open role: ${j.title} (${num(active.length)} active: ${byStage}).`)
  }
  lines.push(`Candidates: ${num(db.candidates.length)}. Applications: ${counts(db.applications.map((a) => a.status))}.`)
  lines.push(`Interviews: ${counts(db.interviews.map((i) => i.status))}. Scorecards: ${num(db.scorecards.filter((s) => s.submittedAt).length)} submitted, ${num(db.scorecards.filter((s) => !s.submittedAt).length)} owed.`)
  lines.push(`Offers: ${counts(db.offers.map((o) => o.status))}. Grants: ${counts(db.grants.map((g) => g.status))}.`)

  const runs = (db.company.payRuns ?? []).filter((r) => r.submittedOn).sort((a, b) => (a.periodStart < b.periodStart ? -1 : 1))
  lines.push(
    runs.length
      ? `Pay runs submitted: ${num(runs.length)}, periods ${runs[0].periodStart} to ${runs[runs.length - 1].periodEnd}; first payroll ${db.company.firstPayrollOn ?? 'not recorded'}.`
      : 'Pay runs submitted: none.',
  )
  const openTasks = db.checklists.flatMap((c) => c.tasks).filter((t) => t.status === 'open')
  lines.push(`Checklists: ${num(db.checklists.length)} (${counts(db.checklists.map((c) => c.kind))}); open tasks ${num(openTasks.length)}, due by ${asOf}: ${num(openTasks.filter((t) => t.dueOn <= asOf).length)}.`)
  const records = RECORD_COLLECTIONS.reduce((n, c) => n + (db[c] as unknown[]).length, 0)
  lines.push(`Records: ${num(records)}, activity rows ${num(db.activity.length)}.`)
  return lines.join('\n') + '\n'
}
