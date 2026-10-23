// Job pipeline: Board (columns = the job's stages) and List (default under 768px). Every drag has a
// button and a key: Advance (A), Move to…, Reject (R), Snooze 3 days (S), next (J), arrow keys to
// move the selection and Enter to open. Cards show days in stage against the SLA (word + color).
// The single keys act only while focus is inside the pipeline, so a stray key press elsewhere never
// changes a candidate the user is not looking at; the ? sheet still lists them while the pipeline is on
// screen. Landing in a stage with an interview step offers Schedule on the card (copy the scheduling
// message and download the .ics). Focus moving into a card scrolls the board so the whole card shows.
import { useCallback, useMemo, useRef, useState } from 'react'
import { links, navigate, navigateTo } from '@/app/router'
import { useShortcut } from '@/app/shortcuts'
import { useViewer } from '@/app/useViewer'
import { attentionReasonLabel, attentionReasons, dbHolidays, jobStages, openOffer, outcomeReasonLabel, slaDetail } from '@/domain/hiring'
import { firstName, getPerson } from '@/domain/people'
import type { Application, DB, ID, Job, JobStage } from '@/domain/types'
import { addDays, fmtDay, fmtShort, today } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { Avatar, Badge, Button, cx, EmptyState, Icon, Menu, type MenuItem } from '@/ui'
import { advance, moveTo, snooze3 } from './actions'
import { ScheduleSheet } from './interviews/ScheduleSheet'
import { stepToSchedule } from './logic'
import { KeyHint, SlaPill, SourceChip, WRAP_BUTTON } from './parts'
import { RejectFlow } from './RejectFlow'

type Column = { stage: JobStage; apps: Application[] }

function buildColumns(db: DB, job: Job): Column[] {
  const stages = jobStages(job)
  const hiredStage = stages.find((s) => s.kind === 'hired') ?? stages[stages.length - 1]
  const holidays = dbHolidays(db)
  const t = today()
  const cols = stages.map((stage) => ({ stage, apps: [] as Application[] }))
  for (const a of db.applications) {
    if (a.jobId !== job.id) continue
    if (a.status === 'hired') cols.find((c) => c.stage.id === hiredStage.id)?.apps.push(a)
    else if (a.status === 'active') (cols.find((c) => c.stage.id === a.stageId) ?? cols[0]).apps.push(a)
  }
  for (const c of cols) {
    c.apps.sort((x, y) => {
      const sx = x.snoozedUntil && x.snoozedUntil > t ? 1 : 0
      const sy = y.snoozedUntil && y.snoozedUntil > t ? 1 : 0
      return sx - sy || slaDetail(job, y, t, holidays).days - slaDetail(job, x, t, holidays).days || x.id.localeCompare(y.id)
    })
  }
  return cols
}

export function Pipeline({ job, layout }: { job: Job; layout: 'board' | 'list' }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const columns = useMemo(() => buildColumns(db, job), [db, job])
  const flat = useMemo(() => columns.flatMap((c) => c.apps.map((a) => a.id)), [columns])
  const [selected, setSelected] = useState<ID | null>(null)
  const [focusInside, setFocusInside] = useState(false)
  const [cardFocused, setCardFocused] = useState(false)
  const [rejecting, setRejecting] = useState<ID | null>(null)
  const [showClosed, setShowClosed] = useState(false)
  const [noting, setNoting] = useState<ID | null>(null)
  /** The card that just landed in a stage with an interview step to book. */
  const [schedulePrompt, setSchedulePrompt] = useState<ID | null>(null)
  const [scheduling, setScheduling] = useState<ID | null>(null)
  const afterReject = useRef<ID | null>(null)
  const cardRefs = useRef(new Map<ID, HTMLDivElement>())
  const regionRef = useRef<HTMLDivElement>(null)

  const sel = selected && flat.includes(selected) ? selected : null

  const focusCard = useCallback((id: ID | null) => {
    setSelected(id)
    if (!id) return
    requestAnimationFrame(() => {
      const el = cardRefs.current.get(id)
      el?.focus({ preventScroll: true })
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }, [])

  const position = (id: ID): [number, number] => {
    for (let c = 0; c < columns.length; c++) {
      const r = columns[c].apps.findIndex((a) => a.id === id)
      if (r >= 0) return [c, r]
    }
    return [-1, -1]
  }

  /**
   * The card to select after this one leaves its spot. List: the next card, else the previous one.
   * Board: the next in the column, else the previous, else the nearest card in the nearest non-empty
   * column (right first, then left), so focus stays on the board when a column empties.
   */
  const neighbor = (id: ID): ID | null => {
    const [c, r] = position(id)
    if (c < 0) return null
    if (layout === 'list') {
      const i = flat.indexOf(id)
      return flat[i + 1] ?? flat[i - 1] ?? null
    }
    const col = columns[c].apps
    const same = col[r + 1]?.id ?? col[r - 1]?.id
    if (same) return same
    for (let k = 1; k < columns.length; k++) {
      for (const cc of [c + k, c - k]) {
        const other = columns[cc]?.apps
        if (other?.length) return other[Math.min(r, other.length - 1)].id
      }
    }
    return null
  }

  const step = (dir: 'up' | 'down' | 'left' | 'right') => {
    if (!flat.length) return
    if (!sel) return focusCard(flat[0])
    const [c, r] = position(sel)
    if (layout === 'list' || dir === 'up' || dir === 'down') {
      if (layout === 'list') {
        const i = flat.indexOf(sel)
        const next = dir === 'up' || dir === 'left' ? flat[i - 1] : flat[i + 1]
        if (next) focusCard(next)
        return
      }
      const col = columns[c].apps
      const next = dir === 'up' ? col[r - 1] : col[r + 1]
      if (next) focusCard(next.id)
      return
    }
    const d = dir === 'left' ? -1 : 1
    for (let k = c + d; k >= 0 && k < columns.length; k += d) {
      const col = columns[k].apps
      if (col.length) return focusCard(col[Math.min(r, col.length - 1)].id)
    }
  }

  const inMenu = (e: KeyboardEvent) => !!(e.target as Element | null)?.closest?.('[role=menu],[role=radiogroup],[role=tablist]')
  // listed: the ? sheet takes focus out of the board, and these keys should still show there.
  const arrows = { group: 'Pipeline', enabled: focusInside, listed: true }
  useShortcut('arrowleft', (e) => !inMenu(e) && step('left'), { ...arrows, description: 'Select the card to the left' })
  useShortcut('arrowright', (e) => !inMenu(e) && step('right'), { ...arrows, description: 'Select the card to the right' })
  useShortcut('arrowup', (e) => !inMenu(e) && step('up'), { ...arrows, description: 'Select the card above' })
  useShortcut('arrowdown', (e) => !inMenu(e) && step('down'), { ...arrows, description: 'Select the card below' })
  useShortcut('j', () => {
    if (!flat.length) return
    const i = sel ? flat.indexOf(sel) : -1
    focusCard(flat[(i + 1) % flat.length])
  }, { group: 'Pipeline', description: 'Select the next candidate', listed: true })

  /** After a move: keep the card selected and focused in its new column, and offer Schedule there. */
  const afterMove = (id: ID) => {
    focusCard(id)
    const now = useDB.getState().db
    const moved = now.applications.find((a) => a.id === id)
    setSchedulePrompt(moved && stepToSchedule(now, moved) ? id : null)
  }
  const doAdvance = (id: ID) => {
    const app = db.applications.find((a) => a.id === id)
    if (!app || app.status !== 'active') return
    const outcome = advance(id, viewer.personId)
    if (outcome === 'needs_hire') navigateTo(links.candidateOffer(app.candidateId, app.id))
    if (outcome === 'moved') afterMove(id)
  }
  const doSnooze = (id: ID) => {
    const next = neighbor(id)
    if (snooze3(id) && next) focusCard(next)
  }

  // Like the arrows, the single keys need focus inside the pipeline (not just a remembered selection).
  const keysOn = !!sel && focusInside
  useShortcut('a', () => sel && doAdvance(sel), { group: 'Pipeline', description: 'Advance the selected candidate', enabled: keysOn, listed: true })
  const openReject = (id: ID) => {
    afterReject.current = neighbor(id)
    setRejecting(id)
  }
  useShortcut('r', () => sel && openReject(sel), { group: 'Pipeline', description: 'Reject the selected candidate', enabled: keysOn, listed: true })
  useShortcut('s', () => sel && doSnooze(sel), { group: 'Pipeline', description: 'Snooze the selected candidate 3 days', enabled: keysOn, listed: true })
  useShortcut(
    'enter',
    () => {
      const app = sel && db.applications.find((a) => a.id === sel)
      if (app) navigate('candidate', app.candidateId)
    },
    { group: 'Pipeline', description: 'Open the selected candidate', enabled: cardFocused && keysOn, listed: true },
  )

  /**
   * Tab into a card, or on to its buttons, in a column the board strip cuts off: scroll the strip
   * sideways so the whole card shows (the browser leaves a control half hidden at the strip's edge).
   * Only the strip moves; the page's own scrolling to the focused control is left to the browser. The
   * List has no side scroller, so it needs none of this. Menus render in a portal, so focus in an open
   * Move to menu finds no card in the strip and scrolls nothing.
   */
  const revealFocusedCard = (e: React.FocusEvent<HTMLElement>) => {
    const strip = e.currentTarget
    const card = e.target instanceof Element ? e.target.closest<HTMLElement>('.ft-boardcard') : null
    if (!card || !strip.contains(card)) return
    const s = strip.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    const gap = 8 // room for the focus ring
    if (c.left < s.left + gap) strip.scrollLeft -= s.left + gap - c.left
    else if (c.right > s.right - gap) strip.scrollLeft += Math.min(c.right - (s.right - gap), c.left - (s.left + gap))
  }

  const active = db.applications.filter((a) => a.jobId === job.id && a.status === 'active')
  const closed = db.applications.filter((a) => a.jobId === job.id && (a.status === 'rejected' || a.status === 'withdrawn')).sort((a, b) => (b.closedOn ?? '').localeCompare(a.closedOn ?? ''))

  const card = (app: Application, stage: JobStage) => (
    <PipelineCard
      key={app.id}
      scheduleStep={schedulePrompt === app.id ? stepToSchedule(db, app)?.name : undefined}
      onSchedule={() => setScheduling(app.id)}
      onDismissSchedule={() => {
        setSchedulePrompt(null)
        focusCard(app.id)
      }}
      app={app}
      job={job}
      stage={stage}
      layout={layout}
      selected={sel === app.id}
      tabbable={sel ? sel === app.id : flat[0] === app.id}
      refFn={(el) => {
        if (el) cardRefs.current.set(app.id, el)
        else cardRefs.current.delete(app.id)
      }}
      onSelect={() => setSelected(app.id)}
      onFocusCard={(f) => {
        setCardFocused(f)
        if (f) setSelected(app.id)
      }}
      onAdvance={() => doAdvance(app.id)}
      onMove={(stageId) => {
        const outcome = moveTo(app.id, stageId, viewer.personId)
        if (outcome === 'needs_hire') navigateTo(links.candidateOffer(app.candidateId, app.id))
        // The card remounts in another column: move focus with it so keyboard users are not dropped.
        if (outcome === 'moved') afterMove(app.id)
      }}
      onReject={() => openReject(app.id)}
      onSnooze={() => doSnooze(app.id)}
    />
  )

  return (
    <div
      ref={regionRef}
      onFocus={() => setFocusInside(true)}
      onBlur={(e) => {
        if (!regionRef.current?.contains(e.relatedTarget as Node | null)) setFocusInside(false)
      }}
    >
      <p className="sr-only" aria-live="polite">
        {sel ? `Selected ${db.candidates.find((c) => c.id === db.applications.find((a) => a.id === sel)?.candidateId)?.firstName ?? ''}` : ''}
      </p>
      {active.length === 0 && !columns.some((c) => c.apps.length) ? (
        job.status === 'filled' || job.status === 'closed' ? (
          <EmptyState icon="check" title="This search is closed" body="Nobody is active on this job. Closed candidates stay on record below." />
        ) : (
          <EmptyState
            icon="users"
            title="No active candidates yet"
            body="Paste a name, email and LinkedIn link into Add candidate, or add someone from the talent pool."
            action={
              <Button variant="primary" icon="user-plus" onClick={() => navigate('hiring', 'add', job.id)}>
                Add candidate
              </Button>
            }
          />
        )
      ) : layout === 'board' ? (
        <div className="ft-board scroll-thin relative -mx-1 overflow-x-auto px-1 pb-2" role="region" aria-label="Pipeline board" tabIndex={-1} onFocusCapture={revealFocusedCard}>
          <div className="flex min-w-max gap-3">
            {columns.map((col) => (
              <section key={col.stage.id} aria-label={`${col.stage.name}: ${plural(col.apps.length, 'candidate')}`} className="ft-board__col flex w-[272px] shrink-0 flex-col rounded-2xl bg-surface-2/70 p-2">
                <header className="flex items-center justify-between px-2 pt-1 pb-2">
                  <h3 className="text-[14px] font-bold text-ink">{col.stage.name}</h3>
                  <span className="ft-count num rounded-full bg-surface px-2 text-[12.5px] font-bold text-ink-2">{col.apps.length}</span>
                </header>
                <div className="flex flex-col gap-2">
                  {col.apps.length === 0 ? <p className="px-2 pb-2 text-[13px] text-ink-3">Nobody here</p> : col.apps.map((a) => card(a, col.stage))}
                </div>
              </section>
            ))}
          </div>
        </div>
      ) : (
        <div className="ft-boardlist flex flex-col gap-5" role="region" aria-label="Pipeline list">
          {columns
            .filter((c) => c.apps.length > 0)
            .map((col) => (
              <section key={col.stage.id} aria-label={`${col.stage.name}: ${plural(col.apps.length, 'candidate')}`}>
                <h3 className="mb-2 flex items-center gap-2 text-[14.5px] font-bold text-ink">
                  {col.stage.name}
                  <span className="ft-count num rounded-full bg-surface-2 px-2 text-[12.5px] text-ink-2">{col.apps.length}</span>
                </h3>
                <div className="ft-boardlist__rows flex flex-col gap-2">{col.apps.map((a) => card(a, col.stage))}</div>
              </section>
            ))}
        </div>
      )}

      {closed.length > 0 && (
        <div className="mt-5">
          <Button variant="ghost" icon={showClosed ? 'chevron-up' : 'chevron-down'} className={WRAP_BUTTON} onClick={() => setShowClosed((v) => !v)} aria-expanded={showClosed}>
            {showClosed ? 'Hide' : 'Show'} {plural(closed.length, 'closed candidate')}
          </Button>
          {showClosed && (
            <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface">
              {closed.slice(0, 200).map((a) => {
                const c = db.candidates.find((x) => x.id === a.candidateId)
                return (
                  <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                    <a href={links.candidate(a.candidateId)} className="min-w-0 font-semibold text-ink hover:text-accent">
                      {c ? `${c.firstName} ${c.lastName}` : 'Candidate'}
                    </a>
                    <span className="text-[13px] text-ink-3">
                      {a.status === 'withdrawn' ? 'Withdrew' : 'Rejected'}: {outcomeReasonLabel(a.outcomeReason).toLowerCase()}
                      {a.closedOn ? `, ${fmtShort(a.closedOn)}` : ''}
                    </span>
                    <span className="ml-auto">
                      {a.notifiedOn ? (
                        <Badge tone="good" icon="check">
                          Notified {fmtShort(a.notifiedOn)}
                        </Badge>
                      ) : (
                        <Button size="sm" icon="mail" onClick={() => setNoting(a.id)}>
                          Send note
                        </Button>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      <RejectFlow
        appId={rejecting}
        mode="reject"
        onClose={(r) => {
          setRejecting(null)
          if (r.closed && afterReject.current) focusCard(afterReject.current)
          // Nobody left on the board: land on the pipeline (its empty state or the closed list), not the page title.
          else if (r.closed) requestAnimationFrame(() => regionRef.current?.querySelector<HTMLElement>('[role=region], button, a[href]')?.focus())
          afterReject.current = null
        }}
      />
      <RejectFlow appId={noting} mode="reject" startAt="notify" onClose={() => setNoting(null)} />
      {scheduling && (
        <ScheduleSheet
          applicationId={scheduling}
          open
          onClose={() => {
            const id = scheduling
            setScheduling(null)
            if (flat.includes(id)) focusCard(id)
          }}
        />
      )}
    </div>
  )
}

function PipelineCard({
  scheduleStep,
  onSchedule,
  onDismissSchedule,
  app,
  job,
  stage,
  layout,
  selected,
  tabbable,
  refFn,
  onSelect,
  onFocusCard,
  onAdvance,
  onMove,
  onReject,
  onSnooze,
}: {
  /** Interview step name to offer Schedule for (right after the card moved into its stage). */
  scheduleStep: string | undefined
  onSchedule: () => void
  onDismissSchedule: () => void
  app: Application
  job: Job
  stage: JobStage
  layout: 'board' | 'list'
  selected: boolean
  tabbable: boolean
  refFn: (el: HTMLDivElement | null) => void
  onSelect: () => void
  onFocusCard: (focused: boolean) => void
  onAdvance: () => void
  onMove: (stageId: string) => void
  onReject: () => void
  onSnooze: () => void
}) {
  const db = useDB((s) => s.db)
  const c = db.candidates.find((x) => x.id === app.candidateId)
  const name = c ? `${c.firstName} ${c.lastName}` : 'Candidate'
  const t = today()
  const hired = app.status === 'hired'
  const sla = slaDetail(job, app, t, dbHolidays(db), openOffer(db, app.id))
  const reasons = attentionReasons(db, app, t)
  const snoozed = app.snoozedUntil && app.snoozedUntil > t ? app.snoozedUntil : null
  const stages = jobStages(job)
  const moveItems: MenuItem[] = stages
    .filter((s) => s.id !== app.stageId)
    .map((s) => ({
      label: s.name,
      icon: s.kind === 'hired' ? 'user' : 'arrow-right',
      onSelect: () => onMove(s.id),
      ...(s.kind === 'hired' ? { hint: 'Use Hire' } : {}),
    }))
  const overdue = app.nextStep && app.nextStep.dueOn < t
  const owner = app.nextStep ? getPerson(db, app.nextStep.ownerId) : undefined

  return (
    <div
      ref={refFn}
      role="group"
      aria-label={`${name}, ${stage.name}`}
      aria-keyshortcuts="A R S Enter"
      tabIndex={tabbable ? 0 : -1}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('a,button')) onSelect()
      }}
      onFocus={(e) => e.target === e.currentTarget && onFocusCard(true)}
      onBlur={(e) => e.target === e.currentTarget && onFocusCard(false)}
      className={cx(
        'ft-boardcard rounded-xl border bg-surface p-3 shadow-card transition-colors focus:outline-none',
        selected && 'ft-boardcard--selected',
        selected ? 'border-accent ring-2 ring-accent/40' : 'border-line hover:border-line-strong',
        layout === 'list' && 'ft-boardcard--row sm:flex sm:items-center sm:gap-4',
      )}
    >
      <div className={cx('min-w-0', layout === 'list' && 'sm:flex-1')}>
        <div className="flex items-start gap-2.5">
          <Avatar name={name} size={30} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            {/* The name leads the accessible name (label in name); the stage and job say which card it is. */}
            {/* A 40px-tall target (the card itself only selects); the negative margin keeps the card compact. */}
            <a
              href={links.candidate(app.candidateId)}
              aria-label={`${name}, ${stage.name}, ${job.title}`}
              className="-my-2 flex min-h-10 min-w-0 items-center font-bold text-ink hover:text-accent"
            >
              <span className="truncate">{name}</span>
            </a>
            {(c?.currentTitle || c?.currentCompany) && (
              <p className="truncate text-[13px] text-ink-3">{[c?.currentTitle, c?.currentCompany].filter(Boolean).join(' at ')}</p>
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {c && <SourceChip candidate={c} />}
          {!hired && <SlaPill detail={sla} />}
          {hired && (
            <Badge tone="good" icon="user">
              Hired
            </Badge>
          )}
          {app.conditionalOfferOn && !hired && (
            <Badge tone="good" icon="check">
              Accepted {fmtShort(app.conditionalOfferOn)}
            </Badge>
          )}
          {snoozed && (
            <Badge tone="neutral" icon="clock">
              Snoozed to {fmtShort(snoozed)}
            </Badge>
          )}
        </div>
        {!hired && (
          <div className="mt-2 text-[13px]">
            {app.nextStep ? (
              <p className={cx('ft-boardcard__next text-ink-2', overdue && 'ft-boardcard__next--overdue font-semibold text-warn')}>
                <Icon name="arrow-right" size={13} className="mr-1 inline align-[-2px]" />
                {app.nextStep.text}, {overdue ? 'was due' : 'due'} {dueText(app.nextStep.dueOn, t)}
                {owner && <span className="font-normal text-ink-3">. Owner: {firstName(owner)}</span>}
              </p>
            ) : (
              <Badge tone="warn" icon="alert">
                No next step
              </Badge>
            )}
            {reasons.includes('waiting_too_long') && <p className="mt-1 text-[12.5px] text-warn">{attentionReasonLabel('waiting_too_long')}</p>}
          </div>
        )}
        {!hired && scheduleStep && (
          <div className="mt-2 rounded-lg bg-accent-soft p-2.5 text-[13px] text-accent-soft-ink">
            <p className="flex items-start gap-1.5">
              <Icon name="calendar" size={14} className="mt-0.5 shrink-0" />
              <span className="min-w-0">
                Schedule next: <span className="font-semibold">{scheduleStep}</span>
              </span>
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" variant="primary" icon="calendar" onClick={onSchedule} className="flex-1">
                Schedule
              </Button>
              <Button size="sm" variant="ghost" onClick={onDismissSchedule}>
                Not now
              </Button>
            </div>
          </div>
        )}
      </div>
      {!hired && (
        <div className={cx('mt-3 grid grid-cols-2 gap-2', layout === 'list' && 'sm:mt-0 sm:flex sm:shrink-0 sm:flex-nowrap sm:[&_button]:w-auto')}>
          <Button
            variant="primary"
            icon={stage.kind === 'offer' ? 'user' : 'arrow-right'}
            onClick={onAdvance}
            className="col-span-2"
            aria-keyshortcuts="A"
            title={stage.kind === 'offer' ? 'Opens their offer on the profile, where Hire lives too (A)' : 'Advance to the next stage (A)'}
          >
            {stage.kind === 'offer' ? (app.conditionalOfferOn ? 'Hire' : 'Open offer') : 'Advance'}
            <KeyHint k="A" />
          </Button>
          <div className="min-w-0 [&>div]:block [&>div]:w-full">
            <Menu
              label={`Move ${name} to`}
              align="left"
              items={[...moveItems, { divider: true }, { label: 'Snooze 3 days', icon: 'clock', onSelect: onSnooze, hint: 'S' }]}
              trigger={(p) => (
                // Tight gap and padding keep "Move to…" on one line in a half-width board card column.
                <Button {...p} iconRight="chevron-down" className="w-full gap-1! px-2!">
                  Move to…
                </Button>
              )}
            />
          </div>
          <Button variant="ghost" onClick={onReject} className="w-full px-3" aria-keyshortcuts="R">
            Reject
            <KeyHint k="R" />
          </Button>
        </div>
      )}
    </div>
  )
}

/** 'today', 'tomorrow' or 'Mon, Oct 12'. */
export function dueText(d: string, t: string): string {
  if (d === t) return 'today'
  if (d === addDays(t, 1)) return 'tomorrow'
  return fmtDay(d)
}
