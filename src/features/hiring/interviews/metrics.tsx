// Small-n hiring metrics: counts first, a percentage only when n >= 5 (rate() in the domain), and every
// number expands inline to the people behind it.
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canSeeApplication, canSeePipeline } from '@/domain/access'
import { hiringMetrics } from '@/domain/hiring/metrics'
import { stageById } from '@/domain/hiring/pipeline'
import { candidateName, outcomeReasonLabel } from '@/domain/hiring/util'
import type { ID, SourceKind } from '@/domain/types'
import { fmtDate, today } from '@/lib/dates'
import { num, plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { Badge, cx, Icon, Panel, Segmented } from '@/ui'
import { MoneyText } from './common'
import { conversionText, drillRows, medianDaysText, metricsRange } from './logic'

type Drill = { key: string; title: string; ids: ID[] }

const SOURCE_LABEL: Record<SourceKind, string> = { inbound: 'Inbound', referral: 'Referral', outbound: 'Outbound', agency: 'Agency' }

/** Hiring > Jobs: small-n metrics (funnel, source of hire, days to accept, offer accept rate, decline reasons). */
export function HiringMetricsPanel() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [range, setRange] = useState<'90d' | '12m' | 'all'>('all')
  const [drill, setDrill] = useState<Drill | null>(null)
  const date = today()
  const jobIds = useMemo(() => (viewer.role === 'admin' ? undefined : db.jobs.filter((j) => canSeePipeline(viewer, j)).map((j) => j.id)), [db.jobs, viewer])
  const q = useMemo(() => metricsRange(range, date, db.company.foundedOn), [range, date, db.company.foundedOn])
  const m = useMemo(() => hiringMetrics(db, { ...q, ...(jobIds ? { jobIds } : {}) }), [db, q, jobIds])

  if (jobIds && jobIds.length === 0) return null

  const toggle = (d: Drill) => setDrill((cur) => (cur?.key === d.key ? null : d))
  const hires = m.sources.reduce((s, x) => s + x.hires, 0)
  const hireIds = m.sources.flatMap((s) => s.hireIds)
  const acceptedApps = m.offerAcceptance.acceptedOfferIds.map((id) => db.offers.find((o) => o.id === id)?.applicationId).filter((x): x is ID => !!x)
  const decidedApps = m.offerAcceptance.decidedOfferIds.map((id) => db.offers.find((o) => o.id === id)?.applicationId).filter((x): x is ID => !!x)
  const top = Math.max(1, ...m.funnel.map((f) => f.total))
  // People at the offer step with no decision yet: counted in the funnel's Offer row, not in the decided-offer rate.
  const decidedSet = new Set(decidedApps)
  const stillOpen = (m.funnel.find((f) => f.kind === 'offer')?.applicationIds ?? []).filter((id) => !decidedSet.has(id) && db.applications.find((a) => a.id === id)?.status === 'active').length
  const baseDiffers = m.conversions.some((c, i) => c.rate.d !== m.funnel[i]?.total)

  const cp = { drill, onToggle: toggle }
  const dp = { drill, onClose: () => setDrill(null) }

  return (
    <Panel
      title="Hiring metrics"
      subtitle="Counts first. A percentage shows only when there are 5 or more. Tap any number to see the people behind it."
      icon="chart"
      actions={
        <Segmented
          size="sm"
          label="Date range"
          value={range}
          onChange={(v) => {
            setRange(v)
            setDrill(null)
          }}
          options={[
            { value: '90d', label: '90 days' },
            { value: '12m', label: '12 months' },
            { value: 'all', label: 'All time' },
          ]}
        />
      }
    >
      {/* Columns follow the panel's own width (container queries), so they stack at 150% text. */}
      <div className="@container flex flex-col gap-6">
        <section aria-label="Summary">
          <dl className="grid grid-cols-2 gap-3 @[720px]:grid-cols-4">
            <SummaryTile label="Applications on record">
              <Count {...cp} dkey="sum-apps" title="Applications" ids={m.applications.applicationIds} className="text-[22px]">
                {num(m.applications.count)}
              </Count>
            </SummaryTile>
            <SummaryTile label="Hires">
              <Count {...cp} dkey="sum-hires" title="Hires" ids={hireIds} className="text-[22px]">
                {num(hires)}
              </Count>
            </SummaryTile>
            <SummaryTile
              label="Offers accepted"
              sub={`${m.offerAcceptance.rate.small ? m.offerAcceptance.rate.text : `${m.offerAcceptance.rate.text} of decided offers`}${stillOpen ? `. ${num(stillOpen)} still open` : ''}`}
            >
              <Count {...cp} dkey="sum-acc" title="Accepted offers" ids={acceptedApps} className="text-[22px]">
                {num(m.offerAcceptance.accepted)} of {num(m.offerAcceptance.decided)}
              </Count>
            </SummaryTile>
            <SummaryTile
              label="Median days, application to acceptance"
              sub={m.medianDaysToAccept.n ? `From ${plural(m.medianDaysToAccept.n, 'hire')}${m.medianDaysToAccept.n < 5 ? ' (small n)' : ''}` : 'No acceptances in this range'}
            >
              <Count {...cp} dkey="sum-days" title="Hires counted in the median" ids={m.medianDaysToAccept.applicationIds} className="text-[22px]">
                {m.medianDaysToAccept.days == null ? 'None yet' : num(Math.round(m.medianDaysToAccept.days))}
              </Count>
            </SummaryTile>
          </dl>
          {(m.offerAcceptance.archivedDecided > 0 || m.funnel.some((f) => f.archived > 0)) && (
            <p className="mt-2 text-[12.5px] text-ink-3">Includes totals kept from closed jobs. Those counts are summaries, so they do not open a list of names.</p>
          )}
          <DrillHere {...dp} prefix="sum-" />
        </section>

        <section aria-labelledby="hm-funnel">
          <h3 id="hm-funnel" className="mb-2 text-[14px] font-bold text-ink">
            Funnel
          </h3>
          <ul className="flex flex-col gap-2.5">
            {m.funnel.map((f, i) => {
              const conv = m.conversions[i - 1]
              const w = f.total / top
              return (
                <li key={f.kind}>
                  <div className="flex flex-wrap items-center justify-between gap-x-3 text-[13.5px]">
                    <span className="font-medium text-ink">{f.name}</span>
                    <span className="flex items-center gap-2">
                      {conv && <span className="text-[12.5px] text-ink-3">{conversionText(conv.rate, m.funnel[i - 1].name)}</span>}
                      {f.archived > 0 ? (
                        <>
                          <span className="text-[12.5px] text-ink-3">
                            <span className="num text-[13.5px] font-bold text-ink">{num(f.total)}</span> in all,
                          </span>
                          <Count {...cp} dkey={`fun-${f.kind}`} title={`Reached ${f.name.toLowerCase()}`} ids={f.applicationIds} className="text-[12.5px] font-semibold">
                            {num(f.count)} with names
                          </Count>
                        </>
                      ) : (
                        <Count {...cp} dkey={`fun-${f.kind}`} title={`Reached ${f.name.toLowerCase()}`} ids={f.applicationIds}>
                          {num(f.count)}
                        </Count>
                      )}
                    </span>
                  </div>
                  <div className="mt-1 h-2 w-full rounded-r-[4px] bg-surface-2" aria-hidden>
                    <div className="h-full rounded-r-[4px] bg-accent" style={{ width: `${w * 100}%`, minWidth: f.total > 0 ? 3 : 0 }} />
                  </div>
                </li>
              )
            })}
          </ul>
          {baseDiffers && <p className="mt-2 text-[12.5px] text-ink-3">A rate counts only jobs that use both steps, so its base can be smaller than the count above it.</p>}
          <DrillHere {...dp} prefix="fun-" />
        </section>

        <div className="grid grid-cols-1 gap-6 @[780px]:grid-cols-2">
          <section aria-labelledby="hm-source">
            <h3 id="hm-source" className="mb-2 text-[14px] font-bold text-ink">
              Source of hire
            </h3>
            <div className="scroll-thin relative overflow-x-auto">
              <table className="w-full border-collapse text-[13.5px]">
                <caption className="sr-only">Applications and hires by source</caption>
                <thead>
                  <tr className="border-b border-line text-left text-[12.5px] text-ink-3">
                    <th scope="col" className="py-1.5 pr-2 font-bold">
                      Source
                    </th>
                    <th scope="col" className="py-1.5 pr-2 text-right font-bold">
                      Applications
                    </th>
                    <th scope="col" className="py-1.5 pr-2 text-right font-bold">
                      Hires
                    </th>
                    <th scope="col" className="py-1.5 text-right font-bold">
                      Hire rate
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {m.sources.map((s) => (
                    <tr key={s.source} className="border-b border-line last:border-0">
                      <th scope="row" className="py-1 pr-2 text-left font-semibold text-ink">
                        {SOURCE_LABEL[s.source]}
                      </th>
                      <td className="py-1 pr-2 text-right">
                        <Count {...cp} dkey={`src-a-${s.source}`} title={`${SOURCE_LABEL[s.source]} applications`} ids={s.applicationIds}>
                          {num(s.applications)}
                        </Count>
                      </td>
                      <td className="py-1 pr-2 text-right">
                        <Count {...cp} dkey={`src-h-${s.source}`} title={`${SOURCE_LABEL[s.source]} hires`} ids={s.hireIds}>
                          {num(s.hires)}
                        </Count>
                      </td>
                      <td className="num py-1 text-right text-ink-2">{s.hireRate.d === 0 ? 'None yet' : s.hireRate.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DrillHere {...dp} prefix="src-" />
          </section>

          <section aria-labelledby="hm-decline">
            <h3 id="hm-decline" className="mb-2 text-[14px] font-bold text-ink">
              Offers declined
            </h3>
            {m.declineReasons.length === 0 ? (
              <p className="text-[13.5px] text-ink-3">No declined offers in this range{m.offerAcceptance.archivedDecided > m.offerAcceptance.archivedAccepted ? ' on record (closed jobs keep totals only)' : ''}.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {m.declineReasons.map((r) => (
                  <li key={r.reason} className="flex items-center justify-between gap-2 text-[13.5px]">
                    <MoneyText text={r.reason} className="text-ink" />
                    <Count {...cp} dkey={`dec-${r.reason}`} title={`Declined: ${r.reason}`} ids={r.applicationIds}>
                      {num(r.count)}
                    </Count>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[12.5px] text-ink-3">
              Decided offers: <Count {...cp} dkey="dec-all" title="Decided offers" ids={decidedApps}>{num(m.offerAcceptance.decided)}</Count>
            </p>
            <DrillHere {...dp} prefix="dec-" />
            {m.outcomeReasons.length > 0 && (
              <>
                <h3 className="mt-4 mb-2 text-[14px] font-bold text-ink">Why candidates closed</h3>
                <ul className="flex flex-col gap-1">
                  {m.outcomeReasons.slice(0, 6).map((r) => (
                    <li key={r.reason} className="flex items-center justify-between gap-2 text-[13.5px]">
                      <span className="text-ink">{r.label}</span>
                      <Count {...cp} dkey={`out-${r.reason}`} title={`Closed: ${r.label}`} ids={r.applicationIds}>
                        {num(r.count)}
                      </Count>
                    </li>
                  ))}
                </ul>
                <DrillHere {...dp} prefix="out-" />
              </>
            )}
          </section>
        </div>

        {m.byJob.length > 0 && (
          <section aria-labelledby="hm-jobs">
            <h3 id="hm-jobs" className="mb-2 text-[14px] font-bold text-ink">
              By job
            </h3>
            <div className="scroll-thin relative overflow-x-auto">
              <table className="w-full min-w-[420px] border-collapse text-[13.5px]">
                <caption className="sr-only">Applications, hires and median days to acceptance per job</caption>
                <thead>
                  <tr className="border-b border-line text-left text-[12.5px] text-ink-3">
                    <th scope="col" className="py-1.5 pr-2 font-bold">
                      Job
                    </th>
                    <th scope="col" className="py-1.5 pr-2 text-right font-bold">
                      Applications
                    </th>
                    <th scope="col" className="py-1.5 pr-2 text-right font-bold">
                      Hires
                    </th>
                    <th scope="col" className="py-1.5 text-right font-bold">
                      Median days to accept
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...m.byJob]
                    .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || b.applications - a.applications)
                    .map((j) => (
                        <tr key={j.jobId} className="border-b border-line last:border-0">
                          <th scope="row" className="py-1 pr-2 text-left font-semibold">
                            <a href={links.job(j.jobId)} className="-my-2 inline-flex min-h-10 items-center text-ink hover:text-accent">
                              {j.title}
                            </a>{' '}
                            {j.status === 'open' && <Badge tone="accent">Open</Badge>}
                          </th>
                          <td className="py-1 pr-2 text-right">
                            <Count {...cp} dkey={`job-a-${j.jobId}`} title={`${j.title}: applications`} ids={db.applications.filter((a) => a.jobId === j.jobId && a.appliedOn >= q.from && a.appliedOn <= q.to).map((a) => a.id)}>
                              {num(j.applications)}
                            </Count>
                          </td>
                          <td className="py-1 pr-2 text-right">
                            <Count {...cp} dkey={`job-h-${j.jobId}`} title={`${j.title}: hires`} ids={j.hireIds}>
                              {num(j.hires)}
                            </Count>
                          </td>
                          <td className="num py-1 text-right text-ink-2">{medianDaysText(j.medianDaysToAccept.days, j.hires)}</td>
                        </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <DrillHere {...dp} prefix="job-" />
          </section>
        )}
      </div>
    </Panel>
  )
}

function Count({
  dkey,
  title,
  ids,
  children,
  className,
  drill,
  onToggle,
}: {
  dkey: string
  title: string
  ids: ID[]
  children: ReactNode
  className?: string
  drill: Drill | null
  onToggle: (d: Drill) => void
}) {
  if (ids.length === 0) return <span className={cx('num font-bold text-ink', className)}>{children}</span>
  const on = drill?.key === dkey
  return (
    <button
      type="button"
      aria-expanded={on}
      onClick={() => onToggle({ key: dkey, title, ids })}
      title={`Show the ${plural(ids.length, 'person', 'people')} behind this number`}
      className={cx(
        'num inline-flex min-h-10 min-w-10 items-center justify-center gap-1 rounded-lg px-2 font-bold text-ink underline decoration-accent/40 decoration-2 underline-offset-4 hover:bg-surface-2',
        on && 'bg-accent-soft text-accent-soft-ink',
        className,
      )}
    >
      {children}
    </button>
  )
}

function DrillHere({ prefix, drill, onClose }: { prefix: string; drill: Drill | null; onClose: () => void }) {
  return drill && drill.key.startsWith(prefix) ? <DrillList drill={drill} onClose={onClose} /> : null
}

function SummaryTile({ label, sub, children }: { label: string; sub?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface-2 px-3.5 py-3">
      <dt className="text-[12.5px] font-semibold text-ink-3">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
      {sub && <dd className="text-[12.5px] text-ink-3">{sub}</dd>}
    </div>
  )
}

function DrillList({ drill, onClose }: { drill: Drill; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const apps = drill.ids.map((id) => db.applications.find((a) => a.id === id)).filter((a) => !!a)
  const { rows, more } = drillRows(apps)
  return (
    <div className="mt-3 rounded-xl border border-line bg-surface px-3.5 py-3" role="region" aria-label={drill.title}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[13.5px] font-bold text-ink">
          {drill.title}: {plural(apps.length, 'person', 'people')}
        </p>
        <button type="button" onClick={onClose} className="inline-flex h-10 items-center gap-1 rounded-lg px-2 text-[13px] font-semibold text-ink-2 hover:bg-surface-2">
          <Icon name="x" size={15} />
          Close list
        </button>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((a) => {
          const job = db.jobs.find((j) => j.id === a.jobId)
          const stage = job ? stageById(job, a.stageId) : undefined
          const status =
            a.status === 'hired' ? 'Hired' : a.status === 'active' ? (a.conditionalOfferOn ? 'Accepted' : (stage?.name ?? 'Active')) : `${a.status === 'rejected' ? 'Rejected' : 'Withdrew'}: ${outcomeReasonLabel(a.outcomeReason).toLowerCase()}`
          const name = candidateName(db, a.candidateId)
          return (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-1.5 text-[13.5px]">
              {canSeeApplication(viewer, db, a) ? (
                <a href={links.candidate(a.candidateId)} className="-my-2 inline-flex min-h-10 items-center font-semibold text-ink hover:text-accent">
                  {name}
                </a>
              ) : (
                <span className="font-semibold text-ink">{name}</span>
              )}
              <span className="text-ink-3">
                {job?.title}. {status}. Applied {fmtDate(a.appliedOn)}
              </span>
            </li>
          )
        })}
      </ul>
      {more > 0 && <p className="mt-2 text-[12.5px] text-ink-3">And {plural(more, 'more person', 'more people')}.</p>}
    </div>
  )
}
