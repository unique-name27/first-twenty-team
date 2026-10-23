// Small building blocks shared by the hiring pages: status badges, source chips, the SLA pill, the
// mini funnel, a media-query hook, the 'Not legal advice' line and the free-text guardrail notes.
import { useEffect, useState } from 'react'
import type { FunnelStep, SlaDetail } from '@/domain/hiring'
import { sourceLabel } from '@/domain/hiring/sources'
import type { Application, Candidate, EmploymentType, Job, SourceKind } from '@/domain/types'
import { Badge, Callout, CitationChip, cx, Icon, type IconName, Kbd, type Tone } from '@/ui'
import { slaBadge, type TextIssue } from './logic'

/**
 * Class overrides that let a kit Button with a long label wrap instead of widening the page (at
 * 375px with 150% text a nowrap label can push the layout past the screen edge).
 */
export const WRAP_BUTTON = 'h-auto! min-h-11 max-w-full shrink! py-2 text-left leading-snug whitespace-normal!'

const LAW_CITATION: Record<TextIssue['law'], { label: string; url: string }> = {
  pay: { label: 'Labor Code 432.3', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=432.3.&lawCode=LAB' },
  criminal: { label: 'Gov Code 12952', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=12952.&lawCode=GOV' },
}

/**
 * Notes under a free-text field from textIssues(): a red note for what blocks the save (criminal
 * history before a conditional offer), a warning for the rest, each with its own citation.
 */
export function TextIssueNotes({ issues, className }: { issues: TextIssue[]; className?: string }) {
  if (issues.length === 0) return null
  return (
    <div className={cx('flex flex-col gap-2', className)}>
      {issues.map((i) => (
        <Callout key={i.law} tone={i.blocks ? 'bad' : 'warn'}>
          {i.text}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <CitationChip label={LAW_CITATION[i.law].label} url={LAW_CITATION[i.law].url} />
            <NotLegalAdvice />
          </div>
        </Callout>
      ))}
    </div>
  )
}

/** Employment type chips (job sheets and the offer builder); a ChipGroup gives them one Tab stop and arrows. */
export const EMPLOYMENT_OPTIONS: Array<{ value: EmploymentType; label: string }> = [
  { value: 'full_time', label: 'Full time' },
  { value: 'part_time', label: 'Part time' },
  { value: 'intern', label: 'Intern' },
]

export const JOB_STATUS: Record<Job['status'], { label: string; tone: Tone; icon: IconName }> = {
  open: { label: 'Open', tone: 'good', icon: 'check' },
  draft: { label: 'Draft', tone: 'neutral', icon: 'edit' },
  on_hold: { label: 'On hold', tone: 'warn', icon: 'clock' },
  filled: { label: 'Filled', tone: 'accent', icon: 'user' },
  closed: { label: 'Closed', tone: 'outline', icon: 'x' },
}

export function JobStatusBadge({ status }: { status: Job['status'] }) {
  const s = JOB_STATUS[status]
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  )
}

/** Job request state, next to the status badge: waiting for Admin, or declined. */
export function RequestBadge({ job }: { job: Pick<Job, 'status' | 'requisition'> }) {
  const r = job.requisition
  if (!r) return null
  if (r.status === 'pending' && job.status === 'draft')
    return (
      <Badge tone="warn" icon="clock">
        Requested, waiting for Admin
      </Badge>
    )
  if (r.status === 'declined')
    return (
      <Badge tone="outline" icon="x">
        Request declined
      </Badge>
    )
  return null
}

export function AppStatusBadge({ app }: { app: Application }) {
  switch (app.status) {
    case 'active':
      return app.conditionalOfferOn ? (
        <Badge tone="good" icon="check">
          Offer accepted
        </Badge>
      ) : (
        <Badge tone="accent">Active</Badge>
      )
    case 'hired':
      return (
        <Badge tone="good" icon="user">
          Hired
        </Badge>
      )
    case 'rejected':
      return <Badge tone="outline">Rejected</Badge>
    case 'withdrawn':
      return <Badge tone="outline">Withdrew</Badge>
  }
}

export { SOURCE_LABEL } from '@/domain/hiring/sources'
const SOURCE_ICON: Record<SourceKind, IconName> = { inbound: 'inbox', referral: 'heart', outbound: 'send', agency: 'building' }

/** The source as a chip; a careers page applicant always shows its detail (sourceLabel). */
export function SourceChip({ candidate, detail = false }: { candidate: Pick<Candidate, 'source' | 'sourceDetail'>; detail?: boolean }) {
  return (
    <span className="ft-tag ft-tag--source inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-surface-2 px-2 text-[12px] font-semibold text-ink-2">
      <Icon name={SOURCE_ICON[candidate.source]} size={12} />
      <span className="truncate">{sourceLabel(candidate, detail)}</span>
    </span>
  )
}

/** Days in stage against the stage SLA. The limit is read out to screen readers (not hover-only). */
export function SlaPill({ detail }: { detail: SlaDetail }) {
  const b = slaBadge(detail)
  return (
    <Badge tone={b.tone} {...(b.icon ? { icon: b.icon } : {})} title={b.title} className="relative">
      {b.text}
      <span className="sr-only">. {b.detail}</span>
    </Badge>
  )
}

/**
 * Mini funnel: one thin bar per stage, height by count (square-root scale so small stages stay
 * visible), with the count under each bar. Counts are people who reached each stage.
 */
export function MiniFunnel({ steps, className }: { steps: FunnelStep[]; className?: string }) {
  if (!steps.length) return null
  const max = Math.max(1, ...steps.map((s) => s.total))
  const label = steps.map((s) => `${s.name} ${s.total}`).join(', ')
  return (
    <div role="img" aria-label={`Funnel: ${label}`} title={label} className={cx('inline-flex items-end gap-1', className)}>
      {steps.map((s) => {
        const h = s.total === 0 ? 2 : Math.max(3, Math.round(Math.sqrt(s.total / max) * 22))
        return (
          <span key={s.stageId} className="flex w-[22px] flex-col items-center gap-0.5">
            <span className="flex h-[22px] w-full items-end justify-center">
              <span className={cx('w-2.5 rounded-t-[3px]', s.total ? 'bg-accent' : 'bg-line-strong')} style={{ height: h }} />
            </span>
            <span className="num text-[11px] leading-none font-semibold text-ink-2">{s.total}</span>
          </span>
        )
      })}
    </div>
  )
}

/** True when the viewport is narrower than the given width (list view is the default under 768px). */
export function useNarrow(maxWidth = 767): boolean {
  const query = `(max-width: ${maxWidth}px)`
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false))
  useEffect(() => {
    if (!window.matchMedia) return
    const m = window.matchMedia(query)
    const h = () => setNarrow(m.matches)
    h()
    m.addEventListener('change', h)
    return () => m.removeEventListener('change', h)
  }, [query])
  return narrow
}

export function NotLegalAdvice({ className }: { className?: string }) {
  return <p className={cx('text-[12.5px] text-ink-3', className)}>Not legal advice; confirm with counsel or your PEO.</p>
}

/** A key hint inside a button label: 'Advance A'. Hidden from screen readers (aria-keyshortcuts says it). */
export function KeyHint({ k }: { k: string }) {
  return (
    <span aria-hidden className="ml-1 hidden sm:inline-flex">
      <Kbd>{k}</Kbd>
    </span>
  )
}

/** Small external link for candidate profile links (never files). */
export function ExternalLink({ href, label, icon = 'link' }: { href: string; label: string; icon?: IconName }) {
  const url = /^https?:\/\//i.test(href) ? href : `https://${href}`
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[13.5px] font-semibold text-ink-2 hover:border-ink-3 hover:text-ink"
    >
      <Icon name={icon} size={15} />
      {label}
      <Icon name="external" size={12} />
    </a>
  )
}
