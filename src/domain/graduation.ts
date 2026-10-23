// Graduation: the end of the road for a "first twenty" app (docs/SPEC.md growth journey stage 20 and
// the Should-have "Graduation export packs"). Counts how close the company is, and builds CSV packs
// shaped for common HRIS and ATS imports: one row per record, ISO dates, plain column names, ids kept
// so rows can be joined. Nothing here is sensitive beyond what the app already holds (no SSNs, birth
// dates, bank details or protected characteristics are ever stored), and candidates' desired pay is
// left out.
import { vestedHeld } from '@/domain/equity'
import { stageById } from '@/domain/hiring/pipeline'
import { employedOn, employmentState, fullName, incomingOn } from '@/domain/people'
import { balances } from '@/domain/timeoff'
import type { DB, ID } from '@/domain/types'
import type { ISODate } from '@/lib/dates'
import { toCSV } from '@/lib/files'

/** The headcount (employees plus accepted offers) where the Graduation panel and its inbox item appear. */
export const GRADUATION_HEADCOUNT = 20
/** Past about this many people, a real HRIS and ATS fits better. */
export const GRADUATION_OUTGROW_AT = 25

export type GraduationCount = {
  employed: number
  /** People with a future start date, plus accepted offers not yet turned into a person. */
  incoming: number
  total: number
  /** Employees (current and incoming) who work outside the HQ state. */
  outOfState: number
  outOfStateStates: string[]
}

/** Employees today plus accepted offers, and how many work outside the HQ state. */
export function graduationCount(db: DB, date: ISODate): GraduationCount {
  const employed = employedOn(db, date)
  const starting = incomingOn(db, date)
  const offersOnly = db.offers.filter(
    (o) =>
      o.status === 'accepted' &&
      !o.personId &&
      o.startDate > date &&
      !db.people.some((p) => p.fromApplicationId === o.applicationId),
  ).length
  const hq = (db.company.hq.state || 'CA').toUpperCase()
  const away = [...employed, ...starting].filter((p) => (p.homeState || hq).toUpperCase() !== hq)
  return {
    employed: employed.length,
    incoming: starting.length + offersOnly,
    total: employed.length + starting.length + offersOnly,
    outOfState: away.length,
    outOfStateStates: [...new Set(away.map((p) => p.homeState.toUpperCase()))].sort(),
  }
}

export type GraduationPackId = 'people' | 'job_pay' | 'time_off' | 'grants' | 'candidates'

export type GraduationPack = {
  id: GraduationPackId
  label: string
  description: string
  /** File name stem; the date and .csv are added. */
  file: string
  /** Contains pay or equity (rendered behind the privacy blur and kept to Admin). */
  sensitive: boolean
}

export const GRADUATION_PACKS: GraduationPack[] = [
  {
    id: 'people',
    label: 'People',
    description: 'Everyone employed, starting soon or gone: job, manager, department, location, work state, type, FLSA and dates.',
    file: 'people',
    sensitive: false,
  },
  {
    id: 'job_pay',
    label: 'Job and pay history',
    description: 'Every effective-dated title, level, manager and pay change, with the reason and approval.',
    file: 'job-and-pay-history',
    sensitive: true,
  },
  {
    id: 'time_off',
    label: 'Time off balances',
    description: "Each current employee's balance for every tracked policy as of today, so balances carry over.",
    file: 'time-off-balances',
    sensitive: false,
  },
  {
    id: 'grants',
    label: 'Equity grants',
    description: 'Every grant with shares, strike price, vesting schedule, vested to date, exercised and cancelled shares.',
    file: 'equity-grants',
    sensitive: true,
  },
  {
    id: 'candidates',
    label: 'Candidates and applications',
    description: 'One row per application with the candidate, job, stage, source and outcome. Desired pay is left out.',
    file: 'candidates-and-applications',
    sensitive: false,
  },
]

const yesNo = (v: boolean | undefined) => (v ? 'Yes' : 'No')
const titleCase = (s: string | undefined) => (s ? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '')

/** CSV text and row count for one pack. */
export function buildGraduationPack(db: DB, id: GraduationPackId, date: ISODate): { csv: string; rows: number } {
  const name = (pid: ID | null | undefined) => {
    const p = pid ? db.people.find((x) => x.id === pid) : undefined
    return p ? fullName(p) : ''
  }
  const dept = (did: ID | undefined) => db.departments.find((d) => d.id === did)?.name ?? ''
  const level = (lid: ID | undefined) => {
    const l = db.levels.find((x) => x.id === lid)
    return l ? `${l.code} ${l.name}` : ''
  }
  const family = (fid: ID | undefined) => db.families.find((f) => f.id === fid)?.name ?? ''
  const location = (lid: ID | undefined) => db.locations.find((l) => l.id === lid)?.name ?? ''
  const STATE: Record<string, string> = { incoming: 'Starting', active: 'Active', on_leave: 'On leave', former: 'Former' }

  switch (id) {
    case 'people': {
      const rows = [...db.people].sort((a, b) => a.hireNumber - b.hireNumber)
      return {
        rows: rows.length,
        csv: toCSV(rows, [
          { header: 'Employee ID', value: (p) => p.id },
          { header: 'Employee number', value: (p) => p.hireNumber },
          { header: 'First name', value: (p) => p.firstName },
          { header: 'Last name', value: (p) => p.lastName },
          { header: 'Preferred name', value: (p) => p.preferredName ?? '' },
          { header: 'Work email', value: (p) => p.workEmail },
          { header: 'Personal email', value: (p) => p.personalEmail ?? '' },
          { header: 'Phone', value: (p) => p.phone ?? '' },
          { header: 'Job title', value: (p) => p.title },
          { header: 'Department', value: (p) => dept(p.departmentId) },
          { header: 'Job family', value: (p) => family(p.familyId) },
          { header: 'Level', value: (p) => level(p.levelId) },
          { header: 'Manager ID', value: (p) => p.managerId ?? '' },
          { header: 'Manager', value: (p) => name(p.managerId) },
          { header: 'Location', value: (p) => location(p.locationId) },
          { header: 'Work mode', value: (p) => titleCase(p.workMode) },
          { header: 'Work city', value: (p) => p.homeCity ?? '' },
          { header: 'Work state', value: (p) => p.homeState },
          { header: 'Employment type', value: (p) => titleCase(p.employmentType) },
          { header: 'Hours per week', value: (p) => p.hoursPerWeek },
          { header: 'FLSA status', value: (p) => (p.flsa === 'exempt' ? 'Exempt' : 'Non-exempt') },
          { header: 'Exemption', value: (p) => titleCase(p.exemptionBasis) },
          { header: 'Start date', value: (p) => p.startDate },
          { header: 'End date', value: (p) => p.endDate ?? '' },
          { header: 'Status', value: (p) => STATE[employmentState(p, date, db)] },
          { header: 'Separation type', value: (p) => titleCase(p.separation?.type) },
        ]),
      }
    }
    case 'job_pay': {
      const rows = [...db.comp].sort((a, b) => name(a.personId).localeCompare(name(b.personId)) || a.effectiveOn.localeCompare(b.effectiveOn))
      return {
        rows: rows.length,
        csv: toCSV(rows, [
          { header: 'Employee ID', value: (r) => r.personId },
          { header: 'Employee', value: (r) => name(r.personId) },
          { header: 'Effective date', value: (r) => r.effectiveOn },
          { header: 'Reason', value: (r) => titleCase(r.reason) },
          { header: 'Job title', value: (r) => r.title },
          { header: 'Level', value: (r) => level(r.levelId) },
          { header: 'Department', value: (r) => dept(r.departmentId) },
          { header: 'Manager', value: (r) => name(r.managerId) },
          { header: 'FLSA status', value: (r) => (r.flsa ? (r.flsa === 'exempt' ? 'Exempt' : 'Non-exempt') : '') },
          { header: 'Pay type', value: (r) => (r.payType === 'salary' ? 'Salary' : 'Hourly') },
          { header: 'Annual salary (USD)', value: (r) => r.salary ?? '' },
          { header: 'Hourly rate (USD)', value: (r) => r.hourlyRate ?? '' },
          { header: 'Variable target (%)', value: (r) => (r.variablePct != null ? Math.round(r.variablePct * 1000) / 10 : '') },
          { header: 'Outside band because', value: (r) => r.exceptionReason ?? '' },
          { header: 'Approved by', value: (r) => name(r.approvedById) },
          { header: 'Approved on', value: (r) => r.approvedOn ?? '' },
          { header: 'Scheduled (future)', value: (r) => yesNo(r.effectiveOn > date) },
          { header: 'Note', value: (r) => r.note ?? '' },
        ]),
      }
    }
    case 'time_off': {
      const people = employedOn(db, date).sort((a, b) => a.hireNumber - b.hireNumber)
      const rows = people.flatMap((p) => balances(db, p.id, date).map((b) => ({ p, b })))
      return {
        rows: rows.length,
        csv: toCSV(rows, [
          { header: 'Employee ID', value: ({ p }) => p.id },
          { header: 'Employee', value: ({ p }) => fullName(p) },
          { header: 'Policy', value: ({ b }) => b.policy.name },
          { header: 'Kind', value: ({ b }) => titleCase(b.policy.kind) },
          { header: 'Method', value: ({ b }) => titleCase(b.policy.method) },
          { header: 'Earned or granted (hours)', value: ({ b }) => b.earned ?? '' },
          { header: 'Used (hours)', value: ({ b }) => b.used },
          { header: 'Scheduled (hours)', value: ({ b }) => b.scheduled },
          { header: 'Pending approval (hours)', value: ({ b }) => b.pending },
          { header: 'Adjustments (hours)', value: ({ b }) => b.adjustments },
          { header: 'Balance (hours)', value: ({ b }) => b.balance ?? '' },
          { header: 'Available (hours)', value: ({ b }) => b.available ?? '' },
          { header: 'Usable from', value: ({ b }) => b.usableFrom ?? '' },
          { header: 'Paid out at exit', value: ({ b }) => yesNo(b.policy.paidOutOnExit) },
          { header: 'As of', value: () => date },
        ]),
      }
    }
    case 'grants': {
      const holder = (pid: ID) => {
        const p = db.people.find((x) => x.id === pid)
        if (p) return fullName(p)
        const k = db.contractors.find((x) => x.id === pid)
        if (k) return k.name
        const c = db.candidates.find((x) => x.id === pid)
        return c ? `${c.firstName} ${c.lastName}` : ''
      }
      const rows = [...db.grants].sort((a, b) => a.vestingStart.localeCompare(b.vestingStart))
      return {
        rows: rows.length,
        csv: toCSV(rows, [
          { header: 'Grant ID', value: (g) => g.id },
          { header: 'Holder ID', value: (g) => g.personId },
          { header: 'Holder', value: (g) => holder(g.personId) },
          { header: 'Holder type', value: (g) => titleCase(g.holderType) },
          { header: 'Type', value: (g) => g.type },
          { header: 'Status', value: (g) => titleCase(g.status) },
          { header: 'Shares', value: (g) => g.shares },
          { header: 'Strike price (USD)', value: (g) => g.strikePrice },
          { header: 'Vesting start', value: (g) => g.vestingStart },
          { header: 'Cliff (months)', value: (g) => g.cliffMonths },
          { header: 'Vesting (months)', value: (g) => g.vestingMonths },
          { header: 'Board approved on', value: (g) => g.boardApprovedOn ?? '' },
          { header: 'Vested as of today', value: (g) => vestedHeld(db, g, date) },
          { header: 'Exercised shares', value: (g) => g.exercisedShares },
          { header: 'Cancelled shares', value: (g) => g.cancelledShares ?? '' },
          { header: 'Cancelled on', value: (g) => g.cancelledOn ?? '' },
          { header: 'Early exercise', value: (g) => yesNo(g.earlyExercise) },
          { header: 'Post-termination exercise (days)', value: (g) => g.postTerminationExerciseDays },
        ]),
      }
    }
    case 'candidates': {
      const rows = db.applications
        .map((a) => ({ a, c: db.candidates.find((x) => x.id === a.candidateId), j: db.jobs.find((x) => x.id === a.jobId) }))
        .filter((r) => r.c)
        .sort((x, y) => x.a.appliedOn.localeCompare(y.a.appliedOn))
      return {
        rows: rows.length,
        csv: toCSV(rows, [
          { header: 'Candidate ID', value: ({ c }) => c?.id },
          { header: 'First name', value: ({ c }) => c?.firstName },
          { header: 'Last name', value: ({ c }) => c?.lastName },
          { header: 'Email', value: ({ c }) => c?.email },
          { header: 'Phone', value: ({ c }) => c?.phone ?? '' },
          { header: 'Location', value: ({ c }) => c?.location ?? '' },
          { header: 'Current title', value: ({ c }) => c?.currentTitle ?? '' },
          { header: 'Current company', value: ({ c }) => c?.currentCompany ?? '' },
          { header: 'LinkedIn', value: ({ c }) => c?.links.linkedin ?? '' },
          { header: 'Source', value: ({ c }) => titleCase(c?.source) },
          { header: 'Source detail', value: ({ c }) => c?.sourceDetail ?? '' },
          { header: 'Referred by', value: ({ c }) => name(c?.referrerId) },
          { header: 'Tags', value: ({ c }) => c?.tags.join('; ') ?? '' },
          { header: 'Application ID', value: ({ a }) => a.id },
          { header: 'Job ID', value: ({ a }) => a.jobId },
          { header: 'Job', value: ({ j }) => j?.title ?? '' },
          { header: 'Stage', value: ({ a, j }) => (j ? stageById(j, a.stageId)?.name : '') ?? '' },
          { header: 'Status', value: ({ a }) => titleCase(a.status) },
          { header: 'Applied on', value: ({ a }) => a.appliedOn },
          { header: 'Closed on', value: ({ a }) => a.closedOn ?? '' },
          { header: 'Outcome reason', value: ({ a }) => titleCase(a.outcomeReason) },
          { header: 'Keep record until', value: ({ c }) => c?.retainUntil ?? '' },
        ]),
      }
    }
  }
}
