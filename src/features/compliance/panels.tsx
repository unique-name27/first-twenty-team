// Compliance panels reused by Home, person profiles, Me and the Hire flow (owned by the compliance feature).
import { useMemo } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canSeePerson } from '@/domain/access'
import { evaluateRule, headcountRuler, type NextThreshold, nextThreshold, RULE_BY_ID, type RulerDot } from '@/domain/compliance'
import { getPerson } from '@/domain/people'
import { TRAINING_LABELS, trainingRequirements } from '@/domain/trainings'
import type { ID } from '@/domain/types'
import { fmtDate, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Badge, Icon, Panel, TextLink } from '@/ui'
import { Disclosure, TrainingDoneControl } from './bits'
import { impactHeadline, postingBlock, thresholdImpact, thresholdLead, trainingCell } from './helpers'
import { ThresholdRuler } from './ruler'

/** The next threshold sentence, the ruler and the two expanders. Shared by Home and Milestones. */
export function NextThresholdBody({ nt, dots, compact }: { nt: NextThreshold | null; dots: RulerDot[]; compact?: boolean }) {
  const db = useDB((s) => s.db)
  const t = today()
  const open = useMemo(
    () =>
      (nt?.rules ?? [])
        .map((r) => RULE_BY_ID[r.id])
        .filter((r) => !!r)
        .map((r) => evaluateRule(db, r, t)),
    [db, nt, t],
  )
  // The pay-range block on job posts counts people starting soon and accepted offers, so it can be on
  // before this card's employee count reaches the threshold (the posting sheet shows the same count).
  const block = useMemo(() => (nt?.rules.some((r) => r.id === 'pay-scale-in-postings') ? postingBlock(db, t) : null), [db, nt, t])
  if (!nt) {
    return (
      <>
        <p className="text-[15px] text-ink">You are past every headcount threshold this app tracks. A full HRIS fits better from here.</p>
        <ThresholdRuler dots={dots} compact={compact} className="mt-3" />
      </>
    )
  }
  return (
    <>
      <p className="text-[15.5px] leading-relaxed font-semibold text-ink">{thresholdLead(nt, db)}</p>
      <p className="mt-1 text-[14.5px] leading-relaxed text-ink-2">{nt.summary}</p>
      {block?.line && (
        <p className="mt-1 flex items-start gap-1.5 text-[14.5px] leading-relaxed text-ink">
          <Icon name="lock" size={16} className="mt-1 shrink-0 text-warn" />
          <span>
            {block.line} <TextLink href={links.rule('pay-scale-in-postings')}>Open the card</TextLink>
          </span>
        </p>
      )}
      <ThresholdRuler dots={dots} next={{ n: nt.n, kind: nt.kind }} projectedOn={nt.projectedOn ?? nt.projectedIfOffersAccepted} compact={compact} className="mt-4" />
      <div className="mt-2 flex flex-col">
        <Disclosure label="How we counted" size="sm">
          <p className="text-[14px] text-ink-2">{nt.howCounted}</p>
        </Disclosure>
        <Disclosure label="What to do" size="sm">
          <ul className="flex flex-col gap-2">
            {open.map((r) => (
              <li key={r.rule.id} className="text-[14px]">
                <TextLink href={links.rule(r.rule.id)}>{r.rule.title}</TextLink>
                <span className="text-ink-3">
                  {r.openActions.length
                    ? `: ${r.openActions.map((a) => a.title.charAt(0).toLowerCase() + a.title.slice(1)).join('; ')}.`
                    : ': nothing open.'}
                </span>
              </li>
            ))}
          </ul>
        </Disclosure>
      </div>
    </>
  )
}

/** Home: next threshold card with the headcount ruler, projected date, How we counted, What to do. */
export function NextThresholdCard() {
  const viewer = useViewer()
  const db = useDB((s) => s.db)
  const t = today()
  const nt = useMemo(() => nextThreshold(db, t), [db, t])
  const dots = useMemo(() => headcountRuler(db, t), [db, t])
  if (viewer.role !== 'admin') return null
  const title = nt ? `Next threshold: ${nt.n}${nt.kind === 'site' ? ' on site' : ' employees'}` : 'Thresholds'
  return (
    <Panel
      title={title}
      icon="shield-check"
      actions={
        <a
          href={links.compliance('milestones')}
          className="inline-flex h-11 items-center gap-1 rounded-lg px-2 text-[14px] font-semibold text-accent hover:bg-accent-soft"
        >
          Milestones
          <Icon name="arrow-right" size={16} />
        </a>
      }
    >
      <NextThresholdBody nt={nt} dots={dots} compact />
    </Panel>
  )
}

/** A person's required trainings with one-tap Done today. */
export function PersonTrainingPanel({ personId }: { personId: ID }) {
  const viewer = useViewer()
  const db = useDB((s) => s.db)
  const t = today()
  const person = getPerson(db, personId)
  const rows = useMemo(() => (person ? trainingRequirements(db, person, t) : []), [db, person, t])
  if (!person || !canSeePerson(viewer, db, personId, 'training')) return null
  const canMark = viewer.role === 'admin' || viewer.personId === personId
  const self = viewer.personId === personId
  return (
    <Panel title="Training" icon="clipboard-check" subtitle={self ? 'Courses you need, and when.' : 'Required courses and when they are due.'}>
      <ul data-focus-scope className="flex flex-col divide-y divide-line">
        {rows.map((row) => {
          const cell = trainingCell(row, t)
          const actionable = canMark && row.status !== 'done' && (row.required || row.recommended)
          return (
            <li key={row.course} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[15px] font-semibold text-ink">{TRAINING_LABELS[row.kind]}</span>
                <Badge tone={cell.tone}>{cell.label}</Badge>
              </div>
              <p className="text-[13.5px] text-ink-3">
                {row.reason}
                {row.completedOn ? ` Last completed ${fmtDate(row.completedOn)}.` : ''}
              </p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13.5px]">
                {row.certificateLink && (
                  <a href={row.certificateLink} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-11 items-center gap-1 font-semibold text-accent">
                    <Icon name="file" size={15} />
                    Certificate
                    <Icon name="external" size={12} />
                  </a>
                )}
                {row.link && row.status !== 'done' && (
                  <a href={row.link} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-11 items-center gap-1 font-semibold text-accent">
                    {row.course === 'harassment' ? "CRD's free course" : 'Open the course'}
                    <Icon name="external" size={12} />
                  </a>
                )}
              </div>
              {actionable && <TrainingDoneControl db={db} personId={person.id} kind={row.kind} focusKey={`ptrain-${person.id}-${row.course}`} />}
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

const COUNTER_NAMES: Record<string, string> = {
  'title-vii-ada-gina-pwfa': 'Title VII, ADA, GINA and PWFA',
  adea: 'the ADEA (age discrimination)',
  fmla: 'the FMLA',
}

/** Inline preview used on the Hire button: 'This hire takes you to 15: 2 things change.' */
export function ThresholdPreview({ startDate, extra }: { startDate: string; extra?: number }) {
  const viewer = useViewer()
  const db = useDB((s) => s.db)
  const n = extra ?? 1
  const impact = useMemo(() => (startDate ? thresholdImpact(db, startDate, n) : null), [db, startDate, n])
  if (viewer.role !== 'admin' || !impact) return null
  const headline = impactHeadline(impact, n)
  if (!headline) return null
  return (
    <div role="note" className="rounded-xl bg-accent-soft px-4 py-3 text-[14px] text-ink">
      <p className="flex items-start gap-2 font-semibold">
        <Icon name="shield-check" size={17} className="mt-0.5 shrink-0 text-accent-soft-ink" />
        {headline}
      </p>
      {impact.rules.length > 0 && (
        // Each link is a full 40px row (hit targets, ARCHITECTURE accessibility), so the rows need no gap.
        <ul className="mt-0.5 flex flex-col pl-6">
          {impact.rules.map((r) => (
            <li key={r.id} className="list-disc">
              <TextLink href={links.rule(r.id)} hitArea={false} className="inline-flex min-h-10 items-center">
                {r.title}
              </TextLink>
            </li>
          ))}
        </ul>
      )}
      {impact.counters.map((c) => (
        <p key={c.id} className="mt-1.5 pl-6 text-ink-2">
          Also starts the federal 20-week counter for {COUNTER_NAMES[c.id] ?? c.title}.
        </p>
      ))}
    </div>
  )
}
