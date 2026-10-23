// Posting (#job.<id>.posting): copy-ready posting text, the job post linter and hard stop 1 of 2: once
// employees plus incoming hires and accepted offers reach 15, Mark posted is disabled without a pay
// range (Labor Code 432.3). Everything else is a warning with a why and a citation. The benefits line
// promises health coverage only once Settings > Company records a group health plan; until it is
// recorded either way, the checks ask for it.
import { useRef } from 'react'
import { href, links } from '@/app/router'
import {
  healthPlanUnrecorded,
  isPendingRequisition,
  markPosted,
  payTransparencyThreshold,
  postingBlockReason,
  postingHeadcount,
  postingLint,
  postingText,
} from '@/domain/hiring'
import type { Job } from '@/domain/types'
import { fmtDate, today } from '@/lib/dates'
import { copyText } from '@/lib/files'
import { plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { Badge, Button, Callout, CitationChip, Icon, Sheet, toast } from '@/ui'
import { commit } from './actions'
import { NotLegalAdvice } from './parts'

const LC_4323 = 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=432.3.&lawCode=LAB'

export function PostingSheet({ job, open, onClose, canManage }: { job: Job; open: boolean; onClose: () => void; canManage: boolean }) {
  const db = useDB((s) => s.db)
  const copyRef = useRef<HTMLButtonElement>(null)
  if (!open) return null
  const t = today()
  const text = postingText(db, job.id, t)
  const block = postingBlockReason(db, job.id, t)
  const waiting = isPendingRequisition(job)
  // The hard stop callout already explains a missing range; do not say it twice.
  const lint = postingLint(job, text).filter((w) => !(block && w.code === 'missing_range'))
  // Not recorded (as opposed to recorded as no plan): the posting leaves health coverage out until it is.
  const healthUnknown = healthPlanUnrecorded(db)
  const hc = postingHeadcount(db, t)
  const postable = job.status === 'draft' || job.status === 'on_hold'
  // Edit from here comes back here after saving ('#job.<id>.edit.posting').
  const editHref = href('job', job.id, 'edit', 'posting')

  const copy = async () => {
    const ok = await copyText(text)
    toast(ok ? 'Posting copied' : { text: 'Copy was blocked by the browser. Select the text and copy it by hand.', tone: 'bad' })
  }

  const post = () => {
    const failed: { reason?: string } = {}
    const ok = commit(`Posted the ${job.title} job`, (d) => {
      const res = markPosted(d, job.id, { date: t })
      if (!res.ok) failed.reason = res.reason
      return res.ok
    })
    if (failed.reason) toast({ text: failed.reason, tone: 'bad' })
    // Mark posted goes away once the job is open: keep focus inside the sheet, on Copy posting.
    else if (ok) requestAnimationFrame(() => copyRef.current?.focus())
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Posting"
      subtitle={job.title}
      width={680}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button ref={copyRef} icon="copy" onClick={copy}>
            Copy posting
          </Button>
          {canManage && postable && (
            <Button
              variant="primary"
              icon="send"
              onClick={post}
              disabled={!!block || waiting}
              title={waiting ? 'Posting opens once Admin approves the job request.' : (block ?? undefined)}
            >
              Mark posted
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-2">
          {job.postedOn && job.status === 'open' ? (
            <Badge tone="good" icon="check">
              Posted {fmtDate(job.postedOn)}
            </Badge>
          ) : (
            <Badge tone="neutral">Not posted</Badge>
          )}
          {canManage && (
            <a href={editHref} className="ml-auto inline-flex h-10 items-center gap-1.5 rounded-lg px-2 font-semibold text-accent hover:bg-accent-soft">
              <Icon name="edit" size={15} />
              Edit details
            </a>
          )}
          <span>
            Counted toward the 15-employee rule: {hc.employed} employed
            {hc.incoming ? `, ${hc.incoming} starting soon` : ''}
            {hc.acceptedOffers ? `, ${plural(hc.acceptedOffers, 'accepted offer')}` : ''} = {hc.total}.
          </span>
        </div>

        {waiting && (
          <Callout tone="neutral" icon="clock" title="Mark posted opens once Admin approves the job request">
            You can copy the posting and edit the details now.
          </Callout>
        )}

        {block && (
          <Callout
            tone="bad"
            icon="lock"
            title="Mark posted is off until this job has a pay range"
            action={
              canManage ? (
                <a href={editHref} className="inline-flex h-11 items-center rounded-lg bg-surface px-3 text-[14px] font-bold text-ink ring-1 ring-line-strong hover:bg-surface-2">
                  Add a pay range
                </a>
              ) : undefined
            }
          >
            {block} You have {hc.total}, counting people starting soon and accepted offers, and the rule starts at {payTransparencyThreshold()}.
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CitationChip label="Labor Code 432.3" url={LC_4323} />
              <NotLegalAdvice />
            </div>
          </Callout>
        )}

        {healthUnknown && (
          <Callout tone="warn" title="Add your group health plan in Settings > Company if you offer one">
            The benefits line leaves out health coverage until a group health plan is recorded, so the posting never promises coverage you have not set up.{' '}
            <a href={links.settings('company')} className="-my-2 inline-flex min-h-10 items-center font-semibold text-accent underline">
              Open Settings &gt; Company
            </a>
          </Callout>
        )}

        {lint.length > 0 ? (
          <section aria-label="Posting checks" className="flex flex-col gap-2">
            <h3 className="text-[14.5px] font-bold text-ink">
              {plural(lint.length, 'thing')} to fix before posting
            </h3>
            <ul className="flex flex-col gap-2">
              {lint.map((w, i) => (
                <li key={`${w.code}-${i}`} className="rounded-xl bg-warn-soft px-4 py-3 text-[14px] text-ink">
                  <p>{w.message}</p>
                  {(w.citation || w.reviewNote) && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {w.citation && <CitationChip label={w.citation.label} url={w.citation.url} />}
                      {w.reviewNote && <span className="text-[12.5px] text-ink-3">{w.reviewNote}</span>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <NotLegalAdvice />
          </section>
        ) : block ? null : (
          <Callout tone="good" title="The posting checks out">
            {healthUnknown
              ? 'Pay range, the no-salary-history line, the Fair Chance statement and sponsorship are all in. Benefits list time off only until a health plan is recorded.'
              : 'Pay range, the no-salary-history line, the Fair Chance statement, sponsorship and benefits are all in.'}
          </Callout>
        )}

        <section aria-label="Posting text">
          <h3 className="mb-2 text-[14.5px] font-bold text-ink">Posting text</h3>
          <pre className="scroll-thin max-h-[52vh] overflow-auto rounded-xl border border-line bg-surface-2 p-4 font-body text-[14px] leading-relaxed whitespace-pre-wrap text-ink">
            {text}
          </pre>
        </section>
      </div>
    </Sheet>
  )
}
