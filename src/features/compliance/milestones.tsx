// Milestones: the threshold ruler and next-threshold story, the federal 20-week counter, crossings told
// as a story, a hire preview, and every rule card grouped by threshold and by event. Deep link
// #compliance.milestones.<ruleId> scrolls to and opens that rule.
import { useEffect, useMemo, useState } from 'react'
import { links } from '@/app/router'
import {
  evaluateAll,
  headcountRuler,
  JURISDICTION_LABELS,
  milestoneHistory,
  nextThreshold,
  RULE_BY_ID,
  roughDate,
  type RuleAction,
  type RuleResult,
} from '@/domain/compliance'
import { setCountOverride, setRuleActionDone, setRuleDeadline, setRuleStatus, trainingsRecordedBy } from '@/domain/compliance/actions'
import type { DB } from '@/domain/types'
import { addDays, fmtDate, type ISODate, parseDate, today } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useDB } from '@/store/db'
import {
  Badge,
  Button,
  ChipGroup,
  CitationChip,
  cx,
  DateChips,
  Field,
  FormGrid,
  Icon,
  Menu,
  Meter,
  Modal,
  NumberInput,
  Panel,
  Segmented,
  TextArea,
  TextInput,
  TextLink,
  toast,
} from '@/ui'
import { Disclosure, LegalNote } from './bits'
import {
  cycleLine,
  followUpDueText,
  followUpPeople,
  futureCrossingText,
  groupResults,
  impactHeadline,
  needsAction,
  postingBlock,
  type RuleFollowUp,
  ruleOwnDue,
  stateChip,
  statusLine,
  thresholdImpact,
  twentyWeekPaceText,
  whyText,
} from './helpers'
import { commit } from './mutate'
import { NextThresholdBody, ThresholdPreview } from './panels'

type Filter = 'all' | 'action' | 'done' | 'later'

/**
 * The longest note a rule card keeps (a not-applicable reason, a deadline's source, a count override's why).
 * Every rule's status syncs as one record of at most 256 KB (docs/SYNC.md), so each note stays short.
 */
const NOTE_MAX = 2_000

/** ' 1,850 of 2,000 characters.' once a note gets close to NOTE_MAX, else ''. */
function noteCount(text: string): string {
  return text.length >= NOTE_MAX - 200 ? ` ${text.length.toLocaleString('en-US')} of ${NOTE_MAX.toLocaleString('en-US')} characters.` : ''
}

export function MilestonesTab({ ruleId }: { ruleId?: string }) {
  const db = useDB((s) => s.db)
  const t = today()
  const results = useMemo(() => evaluateAll(db, t), [db, t])
  const nt = useMemo(() => nextThreshold(db, t), [db, t])
  const dots = useMemo(() => headcountRuler(db, t), [db, t])
  const [filter, setFilter] = useState<Filter>('all')
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set(ruleId ? [ruleId] : []))
  const [naFor, setNaFor] = useState<RuleResult | null>(null)
  const [deadlineFor, setDeadlineFor] = useState<RuleResult | null>(null)

  // Deep link: open the rule, make sure the filter shows it, then scroll after the page's own scroll-to-top.
  useEffect(() => {
    if (!ruleId || !RULE_BY_ID[ruleId]) return
    setFilter('all')
    setOpenIds((s) => (s.has(ruleId) ? s : new Set(s).add(ruleId)))
    const timer = setTimeout(() => {
      const el = document.getElementById(`rule-${ruleId}`)
      if (!el) return
      el.scrollIntoView({ block: 'start' })
      el.querySelector<HTMLElement>('[data-rule-toggle]')?.focus({ preventScroll: true })
    }, 120)
    return () => clearTimeout(timer)
  }, [ruleId])

  const counts = {
    all: results.length,
    action: results.filter(needsAction).length,
    done: results.filter((r) => r.state === 'done').length,
    later: results.filter((r) => r.state === 'not_yet').length,
  }
  const shown = results.filter((r) =>
    filter === 'all' ? true : filter === 'action' ? needsAction(r) : filter === 'done' ? r.state === 'done' : r.state === 'not_yet',
  )
  const groups = groupResults(shown)
  const toggle = (id: string) =>
    setOpenIds((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <div className="flex flex-col gap-5">
      {/* Measured on the page area, not the viewport, so text zoom and the rail both count. */}
      <div className="@container">
        <div className="grid grid-cols-1 gap-5 @[880px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Panel title={nt ? `Next threshold: ${nt.n}${nt.kind === 'site' ? ' on site' : ' employees'}` : 'Thresholds'} icon="target">
            <NextThresholdBody nt={nt} dots={dots} />
          </Panel>
          <div className="flex min-w-0 flex-col gap-5">
            <FederalCounter results={results} />
            <MilestoneStory db={db} />
          </div>
        </div>
      </div>

      <HirePreviewPanel />

      <section aria-labelledby="rules-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="rules-heading" className="text-[19px] font-bold text-ink">
              Rules at your size
            </h2>
            <p className="text-[14px] text-ink-3">
              {plural(counts.action, 'rule')} {counts.action === 1 ? 'needs' : 'need'} action, {counts.done} done, {counts.later} not yet. Each card says how we counted and what to do.
            </p>
            <LegalNote className="mt-0.5" />
          </div>
          <Segmented<Filter>
            label="Show rules"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All', count: counts.all },
              { value: 'action', label: 'Needs action', count: counts.action },
              { value: 'done', label: 'Done', count: counts.done },
              { value: 'later', label: 'Not yet', count: counts.later },
            ]}
          />
        </div>
        {groups.length === 0 && <p className="text-[14.5px] text-ink-3">Nothing here. Pick another filter.</p>}
        {groups.map((g) => {
          const open = g.results.filter(needsAction).length
          return (
            <Panel
              key={g.key}
              title={g.title}
              subtitle={g.subtitle}
              padded={false}
              actions={<Badge tone={open ? 'warn' : 'neutral'}>{open ? `${open} ${open === 1 ? 'needs' : 'need'} action` : plural(g.results.length, 'rule')}</Badge>}
            >
              <ul className="divide-y divide-line">
                {g.results.map((r) => (
                  <li key={r.rule.id}>
                    <RuleCard
                      r={r}
                      db={db}
                      open={openIds.has(r.rule.id)}
                      onToggle={() => toggle(r.rule.id)}
                      onNotApplicable={() => setNaFor(r)}
                      onDeadline={() => setDeadlineFor(r)}
                    />
                  </li>
                ))}
              </ul>
            </Panel>
          )
        })}
      </section>

      <NotApplicableModal result={naFor} onClose={() => setNaFor(null)} />
      <DeadlineModal result={deadlineFor} onClose={() => setDeadlineFor(null)} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Side panels
// ---------------------------------------------------------------------------------------------

function FederalCounter({ results }: { results: RuleResult[] }) {
  const fed = results.find((r) => r.rule.id === 'title-vii-ada-gina-pwfa')
  const adea = results.find((r) => r.rule.id === 'adea')
  if (!fed) return null
  const year = Number(today().slice(0, 4))
  const w = fed.weeks
  const est = w?.estimatedOn ?? w?.estimatedIfOffersAccepted
  const covered = fed.state === 'applies' || fed.state === 'done'
  return (
    <Panel title="Federal 20-week counter" icon="clock" subtitle="Title VII, ADA, GINA and PWFA at 15; the ADEA at 20.">
      {covered ? (
        <p className="text-[14.5px] text-ink">
          Covered{fed.firstAppliedOn ? ` since ${fmtDate(fed.firstAppliedOn)}` : ''}: you had 15 or more employees in 20 calendar weeks of this year or last
          year. Coverage reaches back to Jan 1 of the year week 20 was reached and lasts through the next year.
        </p>
      ) : (
        <>
          <p className="text-[14.5px] text-ink">
            Week {w?.thisYear ?? 0} of 20 in {year}.{est ? ` ${twentyWeekPaceText(est, !!w?.estimatedOn)}` : ''}
          </p>
          <Meter value={w?.thisYear ?? 0} max={20} label={`Qualifying weeks this year: ${w?.thisYear ?? 0} of 20`} className="mt-2" />
          <p className="mt-2 text-[13.5px] text-ink-3">
            A week counts when 15 or more people are on payroll every weekday. The count restarts each Jan 1, but reaching week 20 covers that
            whole year and the next. Last year: {w?.lastYear ?? 0}.
          </p>
          {est && (
            <p className="mt-2 text-[13.5px] text-ink-2">
              Due then: the federal notice, an accommodation process and the EEO statement in the handbook.
            </p>
          )}
        </>
      )}
      {adea?.weeks && adea.state === 'not_yet' && (
        <p className="mt-3 border-t border-line pt-3 text-[13.5px] text-ink-3">
          ADEA (20 employees): week {adea.weeks.thisYear} of 20{adea.weeks.estimatedOn ? `; week 20 around ${roughDate(adea.weeks.estimatedOn)}` : ''}.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <CitationChip label={fed.rule.citation.label} url={fed.rule.citation.url} />
      </div>
      <LegalNote className="mt-2" />
    </Panel>
  )
}

function MilestoneStory({ db }: { db: DB }) {
  const t = today()
  const all = useMemo(() => milestoneHistory(db), [db])
  const past = all.filter((m) => m.date <= t)
  const future = all.filter((m) => m.date > t)
  return (
    <Panel title="Milestone history" icon="flag">
      {all.length === 0 ? (
        <p className="text-[14.5px] text-ink-3">No thresholds crossed yet. The first big one is 5 employees.</p>
      ) : (
        <ol className="flex flex-col gap-2.5">
          {past.map((m) => (
            <li key={`${m.n}-${m.date}-${m.direction}`} className="flex items-start gap-2.5 text-[14.5px] text-ink">
              <Icon name={m.direction === 'up' ? 'trend' : 'minus'} size={16} className="mt-0.5 shrink-0 text-ink-3" />
              {m.text}
            </li>
          ))}
          {future.map((m) => (
            <li key={`${m.n}-${m.date}-${m.direction}`} className="flex items-start gap-2.5 text-[14.5px] text-ink-2">
              <Icon name="calendar" size={16} className="mt-0.5 shrink-0 text-accent" />
              {futureCrossingText(db, m)}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}

function nextMondayAfter(d: ISODate, days: number): ISODate {
  let x = addDays(d, days)
  while (parseDate(x).getDay() !== 1) x = addDays(x, 1)
  return x
}

function HirePreviewPanel() {
  const db = useDB((s) => s.db)
  const t = today()
  const presets = [
    { label: 'In 2 weeks', date: nextMondayAfter(t, 14) },
    { label: 'In a month', date: nextMondayAfter(t, 30) },
    { label: 'In 2 months', date: nextMondayAfter(t, 60) },
    { label: 'In 3 months', date: nextMondayAfter(t, 90) },
  ]
  const [start, setStart] = useState(presets[0].date)
  const [extra, setExtra] = useState<'1' | '2' | '3'>('1')
  const n = Number(extra)
  const impact = useMemo(() => thresholdImpact(db, start, n), [db, start, n])
  const changes = impactHeadline(impact, n)
  return (
    <Panel title="Preview a hire" icon="user-plus" subtitle="See what changes if someone starts on a date, before you make the offer.">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <DateChips label="Start date" value={start} onChange={setStart} presets={presets} />
        <div className="flex flex-col gap-1.5">
          <span className="text-[13.5px] font-semibold text-ink-2">How many people</span>
          <ChipGroup<'1' | '2' | '3'>
            label="How many people start"
            value={extra}
            onChange={setExtra}
            options={[
              { value: '1', label: '1' },
              { value: '2', label: '2' },
              { value: '3', label: '3' },
            ]}
          />
        </div>
      </div>
      <div className="mt-4">
        {changes ? (
          <ThresholdPreview startDate={start} extra={n} />
        ) : (
          <p className="text-[14.5px] text-ink-2">
            No new rules for {n === 1 ? 'a hire' : `${n} hires`} starting {fmtDate(start)}. You would have {impact.after} employees then.
          </p>
        )}
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// Rule card
// ---------------------------------------------------------------------------------------------

function RuleCard({
  r,
  db,
  open,
  onToggle,
  onNotApplicable,
  onDeadline,
}: {
  r: RuleResult
  db: DB
  open: boolean
  onToggle: () => void
  onNotApplicable: () => void
  onDeadline: () => void
}) {
  const rule = r.rule
  const chip = stateChip(r)
  const bodyId = `rule-body-${rule.id}`
  const t = rule.trigger
  const countable = t.kind === 'headcount' || t.kind === 'site'
  const cycle = cycleLine(r)
  const ownDue = ruleOwnDue(r)
  // The block Mark posted enforces counts people starting soon and accepted offers, so it can be on
  // while the legal rule is still approaching: say so on the card instead of two different counts.
  const hardStop = rule.hardStop ? postingBlock(db, today()) : null
  const blockEarly = !!hardStop?.on && (r.state === 'not_yet' || r.state === 'approaching')
  return (
    <article id={`rule-${rule.id}`} className={cx('scroll-mt-24', rule.upcoming && r.state === 'not_yet' && 'opacity-80')}>
      <button
        type="button"
        data-rule-toggle
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex min-h-14 w-full items-start gap-3 px-5 py-3.5 text-left hover:bg-surface-2/60"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={18} className="mt-0.5 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[15px] font-semibold text-ink">{rule.title}</span>
            {/* On a narrow screen the state chip sits here, under the title, so the text keeps the full width. */}
            <Badge tone={chip.tone} className="sm:hidden">
              {chip.label}
            </Badge>
            <Badge tone="neutral">{JURISDICTION_LABELS[rule.jurisdiction]}</Badge>
            {rule.hardStop && (
              <Badge tone="warn" icon="lock">
                {hardStop?.on ? 'Hard stop on' : 'Hard stop'}
              </Badge>
            )}
            {r.recommended && <Badge tone="accent">Recommended now</Badge>}
            {r.overridden && <Badge tone="outline">Count set by admin</Badge>}
          </span>
          <span className="mt-0.5 block text-[13.5px] text-ink-3">{statusLine(r)}</span>
          {blockEarly && hardStop?.line && <span className="mt-0.5 block text-[13.5px] font-semibold text-ink-2">{hardStop.line}</span>}
        </span>
        {/* Beside the text only from sm up: on a phone (or at 150% text) a long chip such as "Approaching
            (Oct 19)" would squeeze the title and status lines into a column of one word per line. */}
        <Badge tone={chip.tone} className="mt-0.5 max-sm:hidden">
          {chip.label}
        </Badge>
      </button>
      {open && (
        <div id={bodyId} className="flex flex-col gap-3 px-5 pb-5 sm:pl-[52px]">
          <div className="flex flex-wrap gap-2">
            <Badge tone="outline">{rule.statutory ? 'Statutory' : 'Good practice'}</Badge>
            {rule.verification === 'needs_review' && <Badge tone="outline">Source not yet double-checked</Badge>}
          </div>
          <p className="max-w-[75ch] text-[14.5px] leading-relaxed text-ink">{rule.summary}</p>
          {(ownDue || cycle || r.projectedIfOffersAccepted) && (
            <ul className="flex flex-col gap-1 text-[14px] text-ink-2">
              {ownDue && (
                <li>
                  {r.dueEstimated && !ownDue.recorded ? (
                    <>
                      Due about {fmtDate(ownDue.on)} (estimated).{' '}
                      <TextLink href={links.settings('company')}>Add your first payroll date in Settings, Company</TextLink>{' '}
                      for the exact deadline.
                    </>
                  ) : (
                    <>
                      Due {fmtDate(ownDue.on)}
                      {ownDue.recorded ? ' (deadline you recorded)' : ''}.
                    </>
                  )}
                </li>
              )}
              {cycle && <li>{cycle}</li>}
              {r.projectedIfOffersAccepted && <li>If outstanding offers are accepted: {fmtDate(r.projectedIfOffersAccepted)}.</li>}
            </ul>
          )}
          {r.followUps?.length ? <RuleFollowUps r={r} followUps={r.followUps} db={db} /> : null}
          {hardStop && (
            <div className="rounded-xl bg-warn-soft px-4 py-3 text-[14px] text-ink">
              <p className="font-semibold">{hardStop.on ? 'The posting block is on.' : 'The posting block is off for now.'}</p>
              {blockEarly && (
                <p className="text-ink-2">
                  It counts people starting soon and accepted offers, so it is on before the rule applies by law
                  {r.projectedOn ? ` (projected ${fmtDate(r.projectedOn)})` : ''}.
                </p>
              )}
              <p className="text-ink-2">{hardStop.howCounted}</p>
              {r.status?.countOverride && <p className="text-ink-2">The count override on this card does not change the posting block.</p>}
            </div>
          )}
          {r.status?.note && <p className="text-[14px] text-ink-2">Note: {r.status.note}</p>}

          <div>
            <h4 className="text-[14px] font-bold text-ink">What to do</h4>
            <RuleActions r={r} db={db} />
          </div>

          <Disclosure label="Why am I seeing this?" size="sm">
            <p className="max-w-[75ch] text-[14px] text-ink-2">{whyText(r)}</p>
          </Disclosure>
          <Disclosure label="How we counted" size="sm">
            <p className="max-w-[75ch] text-[14px] text-ink-2">{r.howCounted}</p>
            <p className="mt-1 max-w-[75ch] text-[13.5px] text-ink-3">The rule's count: {rule.countMethod}</p>
            {countable && <CountOverride r={r} />}
          </Disclosure>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <div>
                <CitationChip label={rule.citation.label} url={rule.citation.url} />
              </div>
              <LegalNote reviewedOn={rule.lastReviewedOn} />
            </div>
            <RuleMenu r={r} onNotApplicable={onNotApplicable} onDeadline={onDeadline} />
          </div>
        </div>
      )}
    </article>
  )
}

/** Where to fix one overdue follow-up: its checklist when one holds the open task, else the person's checklists and training. */
function followUpLink(db: DB, f: RuleFollowUp): { href: string; label: string } {
  const person = db.people.find((p) => p.id === f.personId)
  const first = person?.preferredName || person?.firstName || 'this person'
  if (f.source === 'checklist') {
    const list = db.checklists.find((c) => c.personId === f.personId && c.tasks.some((t) => t.status === 'open' && f.title.endsWith(`: ${t.title}`)))
    if (list) return { href: links.checklist(list.id), label: `Open ${first}'s checklist` }
    return { href: links.person(f.personId, 'checklists'), label: `Open ${first}'s checklists` }
  }
  return { href: links.person(f.personId, 'checklists'), label: `Open ${first}'s training` }
}

/** Overdue per-person legal deadlines under the rule (RuleResult.followUps): who, when it was due, and where to fix it. */
function RuleFollowUps({ r, followUps, db }: { r: RuleResult; followUps: RuleFollowUp[]; db: DB }) {
  const t = today()
  const people = followUpPeople(r)
  const headingId = `rule-followups-${r.rule.id}`
  return (
    <section aria-labelledby={headingId} className="rounded-xl bg-bad-soft px-4 py-3">
      <h4 id={headingId} className="flex items-center gap-1.5 text-[14px] font-bold text-ink">
        <Icon name="alert" size={16} className="shrink-0 text-bad" />
        Overdue for {plural(people, 'person', 'people')}
      </h4>
      <p className="text-[13.5px] text-ink-2">
        {followUps.length === 1
          ? 'This legal deadline for one person has passed. The card cannot read Done until it is recorded.'
          : 'These legal deadlines for individual people have passed. The card cannot read Done until they are recorded.'}
      </p>
      <ul className="mt-1 flex flex-col divide-y divide-line">
        {followUps.map((f) => {
          const link = followUpLink(db, f)
          return (
            <li key={`${f.personId}-${f.title}-${f.dueOn}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <div className="min-w-[12rem] flex-1">
                <p className="text-[14.5px] font-semibold text-ink">{f.title}</p>
                <p className="text-[13px] font-semibold text-bad">{followUpDueText(f, t)}</p>
              </div>
              <TextLink href={link.href} hitArea={false} className="inline-flex min-h-10 items-center text-[14px]">
                {link.label}
              </TextLink>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function rawKeysFor(r: RuleResult, a: RuleAction, db: DB): boolean {
  const raw = db.complianceStatus[r.rule.id]?.actionsDone ?? {}
  if (raw[a.id]) return true
  const yearly = !!r.rule.cycle?.actionIds.includes(a.id)
  return Object.keys(raw).some((k) => k.startsWith(`${a.id}@`) || (yearly && /^year-\d{4}$/.test(k)))
}

/**
 * Done today on a rule step. SB 553 'Train everyone' also records a WVPP completion for everyone in scope
 * (legal training records, kept 1 year), so its toast says how many and links to the Training tab.
 */
function markActionDone(db: DB, ruleId: string, a: RuleAction) {
  const t = today()
  const trained = trainingsRecordedBy(db, ruleId, a.id, t)
  const text = trained ? `Recorded WVPP training for ${plural(trained, 'person', 'people')} today` : `Done: ${a.title}`
  if (!commit(text, (d) => setRuleActionDone(d, ruleId, a.id, t), { quiet: trained > 0 })) return
  if (trained) {
    toast({ text, action: { label: 'Undo', onClick: () => useDB.getState().undo() }, link: { label: 'Review in Training', href: links.compliance('training') } })
  }
}

function RuleActions({ r, db }: { r: RuleResult; db: DB }) {
  const rule = r.rule
  return (
    <ul className="mt-1 flex flex-col divide-y divide-line">
      {rule.actions.map((a) => {
        const doneOn = r.actionsDone[a.id]
        const onFile = r.onFile.includes(a.id)
        const isOpen = r.openActions.some((o) => o.id === a.id)
        const canReopen = !!doneOn && !onFile && rawKeysFor(r, a, db)
        const status = doneOn ? (onFile ? 'On file' : `Done ${fmtDate(doneOn)}`) : isOpen ? (r.state === 'not_yet' ? 'For later' : 'Open') : 'Not due yet'
        return (
          <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
            <Icon
              name={doneOn ? 'check' : 'clock'}
              size={17}
              className={cx('shrink-0', doneOn ? 'text-good' : 'text-ink-3')}
              label={doneOn ? 'Done' : 'Not done'}
            />
            {/* A real basis, so Done today wraps below the text when both do not fit (instead of covering it). */}
            <div className="min-w-0 flex-[1_1_12rem]">
              <p className="text-[14.5px] text-ink">
                {a.link ? (
                  <a href={a.link} target="_blank" rel="noreferrer noopener" className="font-semibold text-accent underline decoration-accent/30 underline-offset-2">
                    {a.title}
                    <Icon name="external" size={12} className="ml-1 inline" />
                  </a>
                ) : (
                  a.title
                )}
              </p>
              <p className={cx('text-[13px]', doneOn ? 'text-good' : 'text-ink-3')}>{status}</p>
            </div>
            {isOpen && r.state !== 'not_applicable' && (
              <Button
                size="md"
                variant={r.state === 'applies' ? 'primary' : 'secondary'}
                icon="check"
                onClick={() => markActionDone(db, rule.id, a)}
              >
                Done today
              </Button>
            )}
            {canReopen && (
              <Button size="md" variant="ghost" onClick={() => commit(`Reopened: ${a.title}`, (d) => setRuleActionDone(d, rule.id, a.id, null))}>
                Reopen
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

const OVERRIDE_NOTES = ['An advisor gives regular services', 'A contractor should not count', 'Counsel advised this count', 'Seasonal or temporary staff']

function CountOverride({ r }: { r: RuleResult }) {
  const ov = r.status?.countOverride
  const weeks = r.rule.trigger.kind === 'headcount' && r.rule.trigger.method === 'weeks_20'
  const [value, setValue] = useState<number | null>(ov?.value ?? r.computedCount)
  const [note, setNote] = useState(ov?.note ?? '')
  const chip = OVERRIDE_NOTES.find((n) => n === note) ?? null
  return (
    <div className="mt-3 max-w-2xl rounded-xl bg-surface-2 p-4">
      <p className="text-[14px] font-bold text-ink">Override the count</p>
      <p className="mt-0.5 text-[13.5px] text-ink-3">
        Use this when the computed count is wrong for this rule. A note is required{weeks ? '; on this rule the count is qualifying weeks, not people' : ''}.
      </p>
      <FormGrid className="mt-3">
        <Field label={weeks ? 'Qualifying weeks' : 'Count'} id={`ov-value-${r.rule.id}`}>
          {(id, d) => <NumberInput id={id} aria-describedby={d} min={0} step={1} value={value} onChange={setValue} />}
        </Field>
        <Field label="Why (required)" id={`ov-note-${r.rule.id}`}>
          {(id) => <TextInput id={id} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Say why the count differs" />}
        </Field>
      </FormGrid>
      <ChipGroup<string>
        className="mt-3"
        label="Common reasons"
        value={chip}
        onChange={setNote}
        options={OVERRIDE_NOTES.map((n) => ({ value: n, label: n }))}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={value == null || value < 0 || !note.trim()}
          onClick={() => {
            if (value == null) return
            commit(`Set the count for ${r.rule.title} to ${value}`, (d) => setCountOverride(d, r.rule.id, { value, note }))
          }}
        >
          Save override
        </Button>
        {ov && (
          <Button
            variant="secondary"
            onClick={() => {
              commit(`Removed the count override on ${r.rule.title}`, (d) => setCountOverride(d, r.rule.id, null))
              setValue(r.computedCount)
              setNote('')
            }}
          >
            Remove override
          </Button>
        )}
      </div>
    </div>
  )
}

function RuleMenu({ r, onNotApplicable, onDeadline }: { r: RuleResult; onNotApplicable: () => void; onDeadline: () => void }) {
  const rule = r.rule
  const items = [
    // While per-person deadlines are overdue the card cannot read Done; with every step done, marking it done would change nothing.
    ...(r.state !== 'done' && !(r.followUps?.length && r.openActions.length === 0)
      ? [{ label: 'Mark the whole rule done today', icon: 'check' as const, onSelect: () => commit(`Marked done: ${rule.title}`, (d) => setRuleStatus(d, rule.id, 'done', today())) }]
      : []),
    { label: 'Record a deadline', icon: 'calendar' as const, onSelect: onDeadline },
    ...(r.state !== 'not_applicable' ? [{ label: 'Mark not applicable', icon: 'x' as const, onSelect: onNotApplicable }] : []),
    ...(r.status?.status
      ? [{ label: 'Clear the rule status', icon: 'rotate-ccw' as const, onSelect: () => commit(`Cleared the status of ${rule.title}`, (d) => setRuleStatus(d, rule.id, null, today())) }]
      : []),
  ]
  return (
    <Menu
      label={`More for ${rule.title}`}
      items={items}
      trigger={(p) => (
        <Button {...p} variant="secondary" icon="more" aria-label={`More actions for ${rule.title}`}>
          More
        </Button>
      )}
    />
  )
}

const NA_REASONS = ['Our PEO handles this', 'No staff in this city or state', 'Counsel says it does not apply', 'Other']

function NotApplicableModal({ result, onClose }: { result: RuleResult | null; onClose: () => void }) {
  const [reason, setReason] = useState<string | null>(null)
  const [note, setNote] = useState('')
  useEffect(() => {
    setReason(null)
    setNote('')
  }, [result])
  if (!result) return null
  const text = [reason && reason !== 'Other' ? reason : '', note.trim()].filter(Boolean).join('. ')
  return (
    <Modal
      open
      onClose={onClose}
      title={`Mark not applicable: ${result.rule.title}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!text}
            onClick={() => {
              commit(`Marked not applicable: ${result.rule.title}`, (d) => setRuleStatus(d, result.rule.id, 'not_applicable', today(), text))
              onClose()
            }}
          >
            Mark not applicable
          </Button>
        </>
      }
    >
      <p className="text-[14px] text-ink-2">Say why, so the next person (or an auditor) knows. You can clear this later from the card.</p>
      <ChipGroup<string> className="mt-3" label="Reason" value={reason} onChange={setReason} options={NA_REASONS.map((n) => ({ value: n, label: n }))} />
      <Field label="Note" className="mt-3" hint={`Optional when a reason above fits.${noteCount(note)}`}>
        {(id, d) => <TextArea id={id} aria-describedby={d} rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
    </Modal>
  )
}

function DeadlineModal({ result, onClose }: { result: RuleResult | null; onClose: () => void }) {
  const [date, setDate] = useState<string>(addDays(today(), 30))
  const [note, setNote] = useState('')
  useEffect(() => {
    setDate(result?.status?.dueOn ?? addDays(today(), 30))
    setNote('')
  }, [result])
  if (!result) return null
  const t = today()
  return (
    <Modal
      open
      onClose={onClose}
      title={`Record a deadline: ${result.rule.title}`}
      footer={
        <>
          {result.status?.dueOn && (
            <Button
              onClick={() => {
                commit(`Removed the deadline for ${result.rule.title}`, (d) => setRuleDeadline(d, result.rule.id, null))
                onClose()
              }}
            >
              Remove deadline
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              commit(`Set the deadline for ${result.rule.title} to ${fmtDate(date)}`, (d) => setRuleDeadline(d, result.rule.id, date, note.trim() || undefined))
              onClose()
            }}
          >
            Save deadline
          </Button>
        </>
      }
    >
      <p className="text-[14px] text-ink-2">For a date someone gave you, like the deadline in a CalSavers notice. It shows on the compliance calendar.</p>
      <div className="mt-3">
        <DateChips
          label="Deadline"
          value={date}
          onChange={setDate}
          presets={[
            { label: '+2 weeks', date: addDays(t, 14) },
            { label: '+30 days', date: addDays(t, 30) },
            { label: '+60 days', date: addDays(t, 60) },
            { label: '+90 days', date: addDays(t, 90) },
          ]}
        />
      </div>
      <Field label="Note" className="mt-3" hint="Optional, for example where the date came from.">
        {(id, d) => <TextInput id={id} aria-describedby={d} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
    </Modal>
  )
}
