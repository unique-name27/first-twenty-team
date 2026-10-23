// Headcount vs plan on Home: the one-line summary, the step chart series, markers for funding rounds
// and threshold crossings, and the crossing story lines. Pure: the date is a parameter.
import { activeAdvisorsOn, activeContractorsOn, milestoneHistory } from '@/domain/compliance'
import { employedOn, incomingOn } from '@/domain/people'
import { headcountProjection, planSummary } from '@/domain/plan'
import type { DB } from '@/domain/types'
import { addDays, fmtDate, type ISODate } from '@/lib/dates'
import { plural } from '@/lib/format'

export type GrowthView = {
  summary: string
  actual: Array<{ date: ISODate; value: number }>
  plan: Array<{ date: ISODate; value: number }>
  from: ISODate
  to: ISODate
  markers: Array<{ date: ISODate; label: string }>
  /** Plain story lines for crossings and rounds, oldest first (the chart's text alternative). */
  story: Array<{ date: ISODate; text: string }>
  current: number
  hasPlan: boolean
}

/** '14 employees, 2 starting, 2 contractors, 2 advisors. Plan: 19 by Dec 31, 20 by Mar 31, 22 by Jun 30, 2027.' */
export function headcountSummary(db: DB, date: ISODate): string {
  const parts = [plural(employedOn(db, date).length, 'employee')]
  const starting = incomingOn(db, date).length
  if (starting) parts.push(`${starting} starting`)
  const contractors = activeContractorsOn(db, date).length
  if (contractors) parts.push(plural(contractors, 'contractor'))
  const advisors = activeAdvisorsOn(db, date).length
  if (advisors) parts.push(plural(advisors, 'advisor'))
  const plan = db.plan.length ? planSummary(db, date) : ''
  return `${parts.join(', ')}.${plan && !plan.startsWith('No headcount plan') ? ` ${plan}.` : ''}`
}

export function growthView(db: DB, date: ISODate): GrowthView {
  const proj = headcountProjection(db, date)
  const actual = proj.actual.map((p) => ({ date: p.date, value: p.value }))
  const plan = proj.plan.map((p) => ({ date: p.date, value: p.value }))
  const founded = [db.company.foundedOn, ...db.people.map((p) => p.startDate)].filter(Boolean).sort()[0] ?? date
  const from = founded < date ? founded : addDays(date, -30)
  const lastPlan = plan.length ? plan[plan.length - 1].date : date
  const minEnd = addDays(date, 120)
  const to = addDays(lastPlan > minEnd ? lastPlan : minEnd, 14)
  const rounds = db.company.fundingRounds
    .filter((r) => r.closedOn <= date)
    .map((r) => ({ date: r.closedOn, text: `${r.name} round closed on ${fmtDate(r.closedOn)}.` }))
  const crossings = milestoneHistory(db, date).map((m) => ({ date: m.date, text: m.text }))
  const story = [...rounds, ...crossings].sort((a, b) => a.date.localeCompare(b.date))
  return {
    summary: headcountSummary(db, date),
    actual,
    plan,
    from,
    to,
    markers: story.map((s) => ({ date: s.date, label: s.text.replace(/\.$/, '') })),
    story,
    current: proj.current,
    hasPlan: plan.length > 1,
  }
}
