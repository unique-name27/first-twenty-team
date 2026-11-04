// The strip above the Jobs list (docs/SPEC.md, Hiring): four tiles for Admin, three for a Hiring manager.
// Each tile is a button that jumps to the list. Cost appears only in Admin's tiles; summary.ts never
// computes it for anyone else.
import { runwayMonthsLabel } from '@/domain/pay'
import { fmtShort } from '@/lib/dates'
import { plural } from '@/lib/format'
import { Badge, KpiSub, KpiTile, KpiValue, Money } from '@/ui'
import type { CostVsRunway, HiringSummary as Summary, InterviewsThisWeek, OffersWaiting, RolesVsPlan, StuckSummary } from './summary'

/** The id of the Jobs list, which every tile jumps to. */
export const JOBS_SECTION = 'hiring-jobs'

const JUMP = 'Go to the jobs list'

function OffersTile({ offers }: { offers: OffersWaiting }) {
  return (
    <KpiTile label="Offers waiting on you" target={JOBS_SECTION} jumpLabel={JUMP}>
      <KpiValue>{offers.count}</KpiValue>
      <KpiSub>
        {offers.count ? (
          <>
            <Money value={offers.monthly} short /> a month fully loaded once {offers.count === 1 ? 'it lands' : 'they land'}
          </>
        ) : (
          'Nothing to approve'
        )}
      </KpiSub>
    </KpiTile>
  )
}

function StuckTile({ stuck }: { stuck: StuckSummary }) {
  return (
    <KpiTile label="Stuck candidates" target={JOBS_SECTION} jumpLabel={JUMP}>
      <span className="mt-1.5">
        <Badge tone={stuck.candidates ? 'warn' : 'good'} icon={stuck.candidates ? 'alert' : 'check'}>
          {stuck.candidates ? 'Needs a sweep' : 'None stuck'}
        </Badge>
      </span>
      <KpiValue>{stuck.candidates}</KpiValue>
      <KpiSub>{stuck.candidates ? `In ${plural(stuck.roles, 'role')}, past an SLA or with no next step` : 'Every candidate has a next step'}</KpiSub>
    </KpiTile>
  )
}

function RolesTile({ roles, mine }: { roles: RolesVsPlan; mine: boolean }) {
  return (
    <KpiTile label={mine ? 'Your open roles' : 'Open roles vs plan'} target={JOBS_SECTION} jumpLabel={JUMP}>
      <span className="mt-1.5 flex items-baseline gap-1.5">
        <span className="ft-stat__value num font-display text-[28px] leading-none font-bold text-ink">{roles.open}</span>
        {roles.plan && (
          <span className="num text-[13px] text-ink-2">
            / plan {roles.plan.value} by {fmtShort(roles.plan.date)}
          </span>
        )}
      </span>
      <KpiSub>
        {roles.plan && roles.toPlan != null
          ? roles.toPlan === 0
            ? 'Every planned hire is made'
            : roles.uncovered
              ? `${plural(roles.toPlan, 'hire')} to plan, ${roles.uncovered} without an open role`
              : `${plural(roles.toPlan, 'hire')} to plan, every one has a role`
          : !mine
            ? 'No headcount plan yet'
            : roles.open
              ? 'Jobs you hire for'
              : 'No open roles'}
      </KpiSub>
    </KpiTile>
  )
}

function CostTile({ cost }: { cost: CostVsRunway }) {
  // runwayMonthsLabel capitalizes for a figure on its own; here it sits mid-sentence ("Runway not shrinking").
  const runway =
    cost.runwayNow == null
      ? null
      : {
          now: runwayMonthsLabel(cost.runwayNow).toLowerCase(),
          after: cost.runwayWithOffers == null ? null : runwayMonthsLabel(cost.runwayWithOffers).toLowerCase(),
        }
  return (
    <KpiTile label="Hire cost vs runway" target={JOBS_SECTION} jumpLabel={JUMP}>
      <KpiValue>
        {cost.addedMonthly ? (
          <>
            +<Money value={cost.addedMonthly} short />
            <span className="text-[13px] font-normal text-ink-2"> /mo</span>
          </>
        ) : (
          'No new cost'
        )}
      </KpiValue>
      <KpiSub>
        {runway
          ? runway.after && cost.addedMonthly
            ? `Runway ${runway.now}, ${runway.after} once offers and hires start.`
            : `Runway ${runway.now}.`
          : 'Add cash on hand in Settings for runway.'}
        {cost.next && (
          <>
            {' '}
            {cost.next.away === 0
              ? `At ${cost.next.n}: new rules apply.`
              : cost.next.reached
                ? `Approving takes you to ${cost.next.n}, a legal threshold.`
                : `${plural(cost.next.away, 'hire')} to ${cost.next.n}, a legal threshold.`}
          </>
        )}
      </KpiSub>
    </KpiTile>
  )
}

function InterviewsTile({ interviews }: { interviews: InterviewsThisWeek }) {
  return (
    <KpiTile label="Interviews this week" target={JOBS_SECTION} jumpLabel={JUMP}>
      <KpiValue>{interviews.count}</KpiValue>
      <KpiSub>{interviews.nextAt ? `Next ${fmtShort(interviews.nextAt)}` : 'None scheduled in the next 7 days'}</KpiSub>
    </KpiTile>
  )
}

export function HiringSummary({ summary }: { summary: Summary }) {
  return (
    <div className="@container" role="group" aria-label="Hiring at a glance">
      <div
        className={
          summary.kind === 'admin' ? 'grid grid-cols-1 gap-3 @[520px]:grid-cols-2 @[760px]:grid-cols-4' : 'grid grid-cols-1 gap-3 @[520px]:grid-cols-3'
        }
      >
        {summary.kind === 'admin' ? (
          <>
            <OffersTile offers={summary.offers} />
            <StuckTile stuck={summary.stuck} />
            <RolesTile roles={summary.roles} mine={false} />
            <CostTile cost={summary.cost} />
          </>
        ) : (
          <>
            <StuckTile stuck={summary.stuck} />
            <RolesTile roles={summary.roles} mine />
            <InterviewsTile interviews={summary.interviews} />
          </>
        )}
      </div>
    </div>
  )
}
