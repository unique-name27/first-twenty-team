// SOC 2 people-evidence pack for an audit period. SOC 2 is an attestation framework, not a law:
// these are company controls auditors sample (screening under CC1.4, awareness training under CC2.2,
// access removal and review). Five controls, each with a row per person (or per quarter), the
// evidence found, and the gap when something is missing. Rows not due yet are 'pending', not gaps.
// The onboarding control also carries a sub-check: staff on board when a policy version took effect
// acknowledge that exact version within 30 days (re-acknowledgements).
import { fullName, isEmployedOn } from '@/domain/people'
import type { DB, ID, Person, Policy } from '@/domain/types'
import { addDays, addMonths, daysBetween, fmtDate, fmtQuarter, type ISODate, nextQuarter, quarterEnd, quarterOf } from '@/lib/dates'
import { toCSV } from '@/lib/files'
import { listJoin } from '@/lib/format'
import { SOC2_ACCESS_REVIEW_ID } from './rules'

export type Soc2ControlId = 'background-check' | 'onboarding-training-acks' | 'annual-security-training' | 'access-revoked' | 'access-review'

export type Soc2Row = {
  personId?: ID
  /** Person name, or the quarter for the access review control. */
  label: string
  ok: boolean
  /** Not due yet as of the evaluation date (not a gap). */
  pending?: boolean
  evidence: string
  gap?: string
  dueOn?: ISODate
  link?: string
}

/** A second row set inside a control, with its own population (policy re-acknowledgements by active staff). */
export type Soc2SubCheck = {
  id: 'policy-reacknowledgement'
  title: string
  description: string
  population: 'active'
  rows: Soc2Row[]
  gaps: number
}

export type Soc2Control = {
  id: Soc2ControlId
  title: string
  description: string
  population: 'hires' | 'active' | 'exits' | 'quarters'
  rows: Soc2Row[]
  /** Extra row sets checked under this control. */
  subChecks?: Soc2SubCheck[]
  /** Gaps in rows and sub-checks. */
  gaps: number
}

export type Soc2Evidence = {
  from: ISODate
  to: ISODate
  /** The date gaps are judged against (defaults to the end of the period). */
  asOf: ISODate
  populations: { hires: Person[]; exits: Person[]; active: Person[] }
  controls: Soc2Control[]
}

export const SOC2_CONTROLS: Record<Soc2ControlId, { title: string; description: string }> = {
  'background-check': {
    title: 'Background check cleared before start',
    description: 'Each hire in the period had a cleared background check (run after a conditional offer) before the first day.',
  },
  'onboarding-training-acks': {
    title: 'Security training and policy acknowledgements within 30 days',
    description: 'Each hire completed security awareness training and acknowledged every policy that needs an acknowledgement within 30 days of starting.',
  },
  'annual-security-training': {
    title: 'Annual security training',
    description: 'Everyone on staff completed security awareness training in the last 12 months.',
  },
  'access-revoked': {
    title: 'Access revoked within 24 hours of the last day',
    description: "Each person who left had system access revoked by the day after their last day (offboarding task tagged 'access-revoked').",
  },
  'access-review': {
    title: 'Quarterly access review',
    description: 'A user access review was completed for each quarter in the period.',
  },
}

const gapCount = (rows: Soc2Row[]) => rows.filter((r) => !r.ok && !r.pending).length

function control(id: Soc2ControlId, population: Soc2Control['population'], rows: Soc2Row[], subChecks?: Soc2SubCheck[]): Soc2Control {
  const gaps = gapCount(rows) + (subChecks ?? []).reduce((sum, c) => sum + c.gaps, 0)
  return { id, ...SOC2_CONTROLS[id], population, rows, ...(subChecks ? { subChecks } : {}), gaps }
}

/** '2', '2.0', 'v2.0' and '2.00' are the same version. */
function sameVersion(a: string, b: string): boolean {
  const norm = (v: string) => v.trim().toLowerCase().replace(/^v/, '').replace(/(\.0+)+$/, '')
  return norm(a) === norm(b)
}

const withVersion = (pol: Policy) => `${pol.title} ${pol.version}`

function backgroundRow(db: DB, p: Person, asOf: ISODate): Soc2Row {
  const base = { personId: p.id, label: fullName(p) }
  const bc = p.backgroundCheck
  if (bc?.status === 'not_required') return { ...base, ok: true, evidence: 'Marked not required for this role.' }
  const offer =
    db.offers.find((o) => o.personId === p.id && o.status === 'accepted') ??
    (p.fromApplicationId ? db.offers.find((o) => o.applicationId === p.fromApplicationId && o.status === 'accepted') : undefined)
  const obc = offer?.backgroundCheck
  let clearedOn: ISODate | undefined
  let how = 'Cleared'
  if (bc?.status === 'clear' && bc.completedOn) clearedOn = bc.completedOn
  else if (obc?.status === 'complete' && obc.result === 'clear' && obc.completedOn) clearedOn = obc.completedOn
  else if (obc?.result === 'consider' && obc.fairChance?.decision === 'proceed') {
    clearedOn = obc.fairChance.finalNoticeOn ?? obc.completedOn
    how = 'Reviewed under the Fair Chance Act and confirmed'
  }
  if (clearedOn && clearedOn <= p.startDate) {
    return { ...base, ok: true, evidence: `${how} ${fmtDate(clearedOn)}, before the ${fmtDate(p.startDate)} start.` }
  }
  if (clearedOn) {
    return { ...base, ok: false, evidence: `${how} ${fmtDate(clearedOn)}.`, gap: `Cleared after the ${fmtDate(p.startDate)} start date.`, dueOn: p.startDate }
  }
  if (p.startDate > asOf) {
    return { ...base, ok: false, pending: true, evidence: `Not cleared yet; starts ${fmtDate(p.startDate)}.`, dueOn: p.startDate }
  }
  return { ...base, ok: false, evidence: 'No cleared check on record.', gap: 'No cleared background check before the start date.', dueOn: p.startDate }
}

/**
 * The hire acknowledged, within 30 days of starting, the version of each policy in effect when they started.
 * A version that took effect after the start date is checked by the re-acknowledgement sub-check instead,
 * so an earlier-version acknowledgement satisfies this row.
 */
function onboardingRow(db: DB, p: Person, asOf: ISODate): Soc2Row {
  const base = { personId: p.id, label: fullName(p) }
  const deadline = addDays(p.startDate, 30)
  const training = db.trainings
    .filter((t) => t.personId === p.id && t.kind === 'security_awareness' && t.completedOn && t.completedOn <= deadline)
    .sort((a, b) => (a.completedOn as string).localeCompare(b.completedOn as string))[0]
  // A policy whose current version is a first version and took effect after the window did not exist yet.
  const policies = db.policies.filter((pol) => pol.requiresAck && !(pol.effectiveOn > deadline && /^v?1(\.0+)?$/i.test(pol.version.trim())))
  const missing = policies.filter((pol) => {
    const versionAtStart = pol.effectiveOn <= p.startDate
    return !db.acks.some(
      (a) => a.personId === p.id && a.policyId === pol.id && a.acknowledgedOn <= deadline && (!versionAtStart || sameVersion(a.version, pol.version)),
    )
  })
  const evidence: string[] = []
  if (training) evidence.push(`Security training ${fmtDate(training.completedOn)}`)
  if (policies.length) evidence.push(`${policies.length - missing.length} of ${policies.length} acknowledgements on time`)
  const link = training?.certificateLink
  if (training && !missing.length) return { ...base, ok: true, evidence: `${evidence.join('; ')}.`, dueOn: deadline, link }
  const gaps: string[] = []
  if (!training) gaps.push(`security training not done by ${fmtDate(deadline)}`)
  if (missing.length) {
    const names = missing.map((m) => (m.effectiveOn <= p.startDate && !/^v?1(\.0+)?$/i.test(m.version.trim()) ? withVersion(m) : m.title))
    gaps.push(`missing ${missing.length === 1 ? 'acknowledgement' : 'acknowledgements'}: ${listJoin(names)}`)
  }
  const gapText = gaps.join('; ')
  if (deadline >= asOf) {
    return { ...base, ok: false, pending: true, evidence: evidence.length ? `${evidence.join('; ')}.` : 'Not done yet.', gap: undefined, dueOn: deadline, link }
  }
  return { ...base, ok: false, evidence: evidence.length ? `${evidence.join('; ')}.` : 'Nothing recorded.', gap: gapText.charAt(0).toUpperCase() + gapText.slice(1) + '.', dueOn: deadline, link }
}

/**
 * Staff who were already on board when a policy version took effect acknowledge that exact version within
 * 30 days of its effective date. One row per person and policy; not due yet is pending, not a gap.
 */
function reacknowledgementRows(db: DB, active: Person[], from: ISODate, asOf: ISODate): Soc2Row[] {
  const rows: Soc2Row[] = []
  // The period's population: versions that took effect, or fell due (30 days later), inside the period.
  const policies = db.policies.filter((pol) => pol.requiresAck && pol.effectiveOn <= asOf && addDays(pol.effectiveOn, 30) >= from)
  for (const p of active) {
    for (const pol of policies) {
      if (p.startDate >= pol.effectiveOn) continue // covered by the onboarding check
      const base = { personId: p.id, label: `${fullName(p)}: ${withVersion(pol)}` }
      const dueOn = addDays(pol.effectiveOn, 30)
      const ack = db.acks
        .filter((a) => a.personId === p.id && a.policyId === pol.id && sameVersion(a.version, pol.version) && a.acknowledgedOn <= asOf)
        .sort((a, b) => a.acknowledgedOn.localeCompare(b.acknowledgedOn))[0]
      if (ack && ack.acknowledgedOn <= dueOn) {
        rows.push({ ...base, ok: true, evidence: `Acknowledged ${withVersion(pol)} on ${fmtDate(ack.acknowledgedOn)}.`, dueOn, link: pol.link })
      } else if (ack) {
        rows.push({
          ...base,
          ok: false,
          evidence: `Acknowledged ${fmtDate(ack.acknowledgedOn)}.`,
          gap: `Acknowledged ${withVersion(pol)} after the ${fmtDate(dueOn)} deadline.`,
          dueOn,
        })
      } else if (dueOn >= asOf) {
        rows.push({ ...base, ok: false, pending: true, evidence: `${withVersion(pol)} took effect ${fmtDate(pol.effectiveOn)}; due ${fmtDate(dueOn)}.`, dueOn })
      } else {
        rows.push({ ...base, ok: false, evidence: 'No acknowledgement of this version.', gap: `${withVersion(pol)} not acknowledged (due ${fmtDate(dueOn)}).`, dueOn })
      }
    }
  }
  return rows
}

function annualRow(db: DB, p: Person, evalDate: ISODate): Soc2Row {
  const base = { personId: p.id, label: fullName(p) }
  const last = db.trainings
    .filter((t) => t.personId === p.id && t.kind === 'security_awareness' && t.completedOn && t.completedOn <= evalDate)
    .sort((a, b) => (b.completedOn as string).localeCompare(a.completedOn as string))[0]
  const firstDue = addDays(p.startDate, 30)
  if (last?.completedOn) {
    const next = addMonths(last.completedOn, 12)
    if (next >= evalDate) return { ...base, ok: true, evidence: `Completed ${fmtDate(last.completedOn)}; next due ${fmtDate(next)}.`, dueOn: next, link: last.certificateLink }
    return { ...base, ok: false, evidence: `Last completed ${fmtDate(last.completedOn)}.`, gap: `Lapsed on ${fmtDate(next)}.`, dueOn: next }
  }
  if (firstDue >= evalDate) return { ...base, ok: false, pending: true, evidence: `New hire; first training due ${fmtDate(firstDue)}.`, dueOn: firstDue }
  return { ...base, ok: false, evidence: 'No security training recorded.', gap: `No security training on record (first due ${fmtDate(firstDue)}).`, dueOn: firstDue }
}

function revokedRow(db: DB, p: Person, asOf: ISODate): Soc2Row {
  const base = { personId: p.id, label: fullName(p) }
  const lastDay = (p.separation?.lastDay ?? p.endDate) as ISODate
  const deadline = addDays(lastDay, 1)
  const task = db.checklists
    .filter((c) => c.personId === p.id && c.kind === 'offboarding')
    .flatMap((c) => c.tasks)
    .find((t) => t.soc2Control === 'access-revoked')
  if (task?.status === 'done' && task.doneOn) {
    if (task.doneOn <= deadline) {
      return {
        ...base,
        ok: true,
        evidence: `Access revoked ${fmtDate(task.doneOn)} (last day ${fmtDate(lastDay)})${task.evidenceLink ? '' : '; add an evidence link'}.`,
        dueOn: deadline,
        link: task.evidenceLink,
      }
    }
    const late = daysBetween(lastDay, task.doneOn)
    return {
      ...base,
      ok: false,
      evidence: `Access revoked ${fmtDate(task.doneOn)}.`,
      gap: `Revoked ${late} days after the last day (${fmtDate(lastDay)}).`,
      dueOn: deadline,
      link: task.evidenceLink,
    }
  }
  if (deadline >= asOf) return { ...base, ok: false, pending: true, evidence: `Last day ${fmtDate(lastDay)}; not revoked yet.`, dueOn: deadline }
  if (task?.status === 'not_applicable') {
    return { ...base, ok: false, evidence: 'Revocation task marked not applicable.', gap: 'Auditors expect revocation evidence for every exit.', dueOn: deadline }
  }
  return { ...base, ok: false, evidence: 'No revocation recorded.', gap: `No access revocation recorded for the ${fmtDate(lastDay)} last day.`, dueOn: deadline }
}

function accessReviewRows(db: DB, from: ISODate, to: ISODate, asOf: ISODate): Soc2Row[] {
  const rec = db.recurring.find((r) => r.ruleId === SOC2_ACCESS_REVIEW_ID)
  const done = db.complianceStatus[SOC2_ACCESS_REVIEW_ID]?.actionsDone ?? {}
  const rows: Soc2Row[] = []
  let q = quarterOf(from)
  for (let i = 0; i < 200 && q <= quarterOf(to); i++) {
    const doneOn = done[q] ?? (rec?.lastDoneOn && quarterOf(rec.lastDoneOn) === q ? rec.lastDoneOn : undefined)
    const dueOn = rec?.nextDueOn && quarterOf(rec.nextDueOn) === q ? rec.nextDueOn : quarterEnd(q)
    const label = fmtQuarter(q)
    if (doneOn) rows.push({ label, ok: true, evidence: `Review completed ${fmtDate(doneOn)}.`, dueOn, link: rec?.link })
    else if (dueOn >= asOf) rows.push({ label, ok: false, pending: true, evidence: `Due ${fmtDate(dueOn)}.`, dueOn })
    else rows.push({ label, ok: false, evidence: 'No review recorded.', gap: `No access review recorded for ${label}.`, dueOn })
    q = nextQuarter(q)
  }
  return rows
}

/**
 * Evidence for the 5 people controls over [from, to]. Hires: start date in the period (future starts
 * included, pending). Exits: last day in the period. Active: employed on the evaluation date
 * (the earlier of `to` and `asOf`).
 */
export function soc2Evidence(db: DB, from: ISODate, to: ISODate, asOf: ISODate = to): Soc2Evidence {
  const evalDate = asOf < to ? asOf : to
  const byHire = (a: Person, b: Person) => a.hireNumber - b.hireNumber || a.startDate.localeCompare(b.startDate)
  const hires = db.people.filter((p) => p.startDate >= from && p.startDate <= to).sort(byHire)
  const exits = db.people
    .filter((p) => {
      const last = p.separation?.lastDay ?? p.endDate
      return !!last && last >= from && last <= to
    })
    .sort(byHire)
  const active = db.people.filter((p) => isEmployedOn(p, evalDate)).sort(byHire)
  return {
    from,
    to,
    asOf: evalDate,
    populations: { hires, exits, active },
    controls: [
      control('background-check', 'hires', hires.map((p) => backgroundRow(db, p, evalDate))),
      control(
        'onboarding-training-acks',
        'hires',
        hires.map((p) => onboardingRow(db, p, evalDate)),
        [reackCheck(reacknowledgementRows(db, active, from, evalDate))],
      ),
      control('annual-security-training', 'active', active.map((p) => annualRow(db, p, evalDate))),
      control('access-revoked', 'exits', exits.map((p) => revokedRow(db, p, evalDate))),
      control('access-review', 'quarters', accessReviewRows(db, from, to, evalDate)),
    ],
  }
}

function reackCheck(rows: Soc2Row[]): Soc2SubCheck {
  return {
    id: 'policy-reacknowledgement',
    title: 'New policy versions acknowledged within 30 days',
    description: 'Everyone on staff when a policy version took effect acknowledged that version within 30 days.',
    population: 'active',
    rows,
    gaps: gapCount(rows),
  }
}

/** CSV for one control, for the auditor. Sub-check rows follow, with the sub-check named in the Control column. */
export function soc2CSV(evidence: Soc2Evidence, controlId: Soc2ControlId): string {
  const c = evidence.controls.find((x) => x.id === controlId)
  if (!c) return ''
  const rows: Array<Soc2Row & { check: string }> = [
    ...c.rows.map((r) => ({ ...r, check: c.title })),
    ...(c.subChecks ?? []).flatMap((sc) => sc.rows.map((r) => ({ ...r, check: sc.title }))),
  ]
  return toCSV(rows, [
    { header: 'Control', value: (r) => r.check },
    { header: 'Period', value: () => `${evidence.from} to ${evidence.to}` },
    { header: c.population === 'quarters' ? 'Quarter' : 'Person', value: (r) => r.label },
    { header: 'Result', value: (r) => (r.ok ? 'OK' : r.pending ? 'Not due yet' : 'Gap') },
    { header: 'Evidence', value: (r) => r.evidence },
    { header: 'Gap', value: (r) => r.gap ?? '' },
    { header: 'Due', value: (r) => r.dueOn ?? '' },
    { header: 'Evidence link', value: (r) => r.link ?? '' },
  ])
}
