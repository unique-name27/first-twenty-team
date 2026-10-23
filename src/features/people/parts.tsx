// Small building blocks shared across the People pages: employee numbers, status badges, the AB5
// chip and the checklist task row (one-tap Done with Undo, Not applicable with a note, evidence link).
import { useEffect, useId, useRef, useState } from 'react'
import { setTaskStatus } from '@/domain/checklists/actions'
import { TASK_IDS } from '@/domain/checklists/templates'
import { fullName, getPerson } from '@/domain/people'
import type { Checklist, ChecklistTask, Contractor, DB, LeaveCase, Person } from '@/domain/types'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { daysBetween, fmtDate, fmtShort, type ISODate, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Avatar, Badge, Button, ChipGroup, CitationChip, cx, Field, Icon, restoreFocus, TextInput, toast, type Tone } from '@/ui'
import {
  AB5_LABEL,
  ab5Result,
  type Ab5Outcome,
  canActOnTask,
  dayLabel,
  type DirStatus,
  dueLine,
  LINE_MAX_CHARS,
  LINK_MAX_CHARS,
  taskOwnerText,
} from './helpers'

export const LEAVE_KIND_LABEL: Record<LeaveCase['kind'], string> = {
  cfra: 'CFRA leave',
  pdl: 'Pregnancy disability leave',
  bonding: 'Bonding leave',
  military: 'Military leave',
  other: 'Leave',
}

export function undoToast(text: string): void {
  toast({ text, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
}

/** "#16" in the mono face. Employee numbers appear everywhere a person does. */
export function EmpNo({ n, className }: { n: number | undefined; className?: string }) {
  if (n == null) return null
  return <span className={cx('ft-empno font-mono text-[12.5px] font-semibold text-ink-3', className)}>#{n}</span>
}

/** Avatar, number and name (optionally a link to the profile). */
export function PersonChip({
  person,
  link = true,
  size = 28,
  sub,
}: {
  person: Person
  link?: boolean
  size?: number
  sub?: React.ReactNode
}) {
  const muted = !!person.endDate && person.endDate < today()
  const name = (
    <span className="min-w-0">
      <span className="flex items-baseline gap-1.5">
        <EmpNo n={person.hireNumber} />
        <span className={cx('truncate font-semibold', muted ? 'text-ink-3' : 'text-ink')}>{fullName(person)}</span>
      </span>
      {sub && <span className="block truncate text-[13px] text-ink-3">{sub}</span>}
    </span>
  )
  return (
    <span className="inline-flex min-w-0 items-center gap-2.5">
      <Avatar name={fullName(person)} size={size} muted={muted} />
      {link ? (
        <a href={links.person(person.id)} className="-my-2.5 inline-flex min-h-10 min-w-0 items-center hover:[&_.font-semibold]:text-accent">
          {name}
        </a>
      ) : (
        name
      )}
    </span>
  )
}

/**
 * Pre-start, Active, On leave (back Jan 11), Last day Oct 30, Alumni. Leave type only for those allowed
 * to see it; a last day still ahead only with showLastDay (canSeeSeparation), else they read Active.
 */
export function PersonStatusBadge({
  db,
  person,
  status,
  leave,
  showLeaveType,
  showLastDay,
}: {
  db: DB
  person: Person
  status: DirStatus
  leave?: LeaveCase
  showLeaveType?: boolean
  showLastDay?: boolean
}) {
  const t = today()
  if (status === 'starting') {
    return (
      <Badge tone="accent" icon="calendar">
        Starts {fmtShort(person.startDate)}
      </Badge>
    )
  }
  if (status === 'alumni') return <Badge tone="outline">Alumni</Badge>
  if (status === 'on_leave') {
    const lc = leave ?? db.leaveCases.find((l) => l.personId === person.id && l.startDate <= t && !l.returnedOn && !l.endedOn)
    const back = lc?.expectedReturn ? `, back ${fmtShort(lc.expectedReturn)}` : ''
    const kind = showLeaveType && lc ? LEAVE_KIND_LABEL[lc.kind] : 'Leave'
    return (
      <Badge tone="neutral" icon="plane">
        {kind}
        {back}
      </Badge>
    )
  }
  if (showLastDay && person.endDate && person.endDate >= t) {
    return (
      <Badge tone="warn" icon="clock">
        Last day {fmtShort(person.endDate)}
      </Badge>
    )
  }
  return <Badge tone="good">Active</Badge>
}

export function ContractorStatusBadge({ status }: { status: DirStatus }) {
  if (status === 'starting') return <Badge tone="accent">Starting soon</Badge>
  if (status === 'alumni') return <Badge tone="outline">Ended</Badge>
  return <Badge tone="good">Active</Badge>
}

const AB5_TONE: Record<Ab5Outcome, Tone> = { likely_ok: 'good', review: 'warn', likely_employee: 'warn', incomplete: 'outline' }

/** AB5 result chip. Never red: red is reserved for statutory deadlines. */
export function Ab5Badge({ contractor }: { contractor: Pick<Contractor, 'ab5' | 'kind'> }) {
  if (contractor.kind === 'advisor') return <Badge tone="outline">Advisor</Badge>
  const r = ab5Result(contractor.ab5)
  return (
    <Badge tone={AB5_TONE[r.outcome]} icon={r.outcome === 'likely_ok' ? 'check' : r.outcome === 'incomplete' ? 'info' : 'alert'}>
      {AB5_LABEL[r.outcome]}
    </Badge>
  )
}

export function Ab5OutcomeBadge({ outcome }: { outcome: Ab5Outcome }) {
  return (
    <Badge tone={AB5_TONE[outcome]} icon={outcome === 'likely_ok' ? 'check' : outcome === 'incomplete' ? 'info' : 'alert'}>
      {AB5_LABEL[outcome]}
    </Badge>
  )
}

export function NotLegalAdvice({ className }: { className?: string }) {
  return <p className={cx('text-[12.5px] text-ink-3', className)}>Not legal advice; confirm with counsel or your PEO.</p>
}

// ---------------------------------------------------------------------------------------------
// Task row
// ---------------------------------------------------------------------------------------------

const NA_NOTES = ['Not needed for this role', 'Handled by the PEO', 'Done outside the app']

function daysLate(dueOn: ISODate, date: ISODate): number {
  return Math.max(0, daysBetween(dueOn, date))
}

/** State in a word and a color. Red only for an overdue statutory deadline. */
export function TaskStateBadges({ task }: { task: ChecklistTask }) {
  const t = today()
  const overdue = task.status === 'open' && task.dueOn < t
  return (
    <>
      {task.status === 'done' && (
        <Badge tone="good" icon="check">
          Done {task.doneOn ? fmtShort(task.doneOn) : ''}
        </Badge>
      )}
      {task.status === 'not_applicable' && <Badge tone="neutral">Not applicable</Badge>}
      {overdue && task.statutory && (
        <Badge tone="bad" icon="alert">
          Legal deadline, {daysLate(task.dueOn, t)} {daysLate(task.dueOn, t) === 1 ? 'day' : 'days'} late
        </Badge>
      )}
      {overdue && !task.statutory && (
        <Badge tone="warn" icon="clock">
          Overdue {daysLate(task.dueOn, t)} {daysLate(task.dueOn, t) === 1 ? 'day' : 'days'}
        </Badge>
      )}
      {!overdue && task.statutory && task.status === 'open' && (
        <Badge tone="outline" icon="scale">
          Legal deadline
        </Badge>
      )}
    </>
  )
}

/**
 * After a task leaves the open list its Done button is gone, so keyboard focus moves on: to the next
 * task's Done button, else this row's Reopen button, else the previous task's Done button.
 */
function moveFocusAfter(key: string): void {
  const all = [...document.querySelectorAll<HTMLElement>('[data-done-for]')]
  const i = all.findIndex((b) => b.dataset.doneFor === key)
  const next = i >= 0 ? all[i + 1]?.dataset.doneFor : undefined
  const prev = i > 0 ? all[i - 1]?.dataset.doneFor : undefined
  const find = (sel: string) => document.querySelector<HTMLElement>(sel)
  let tries = 0
  const go = () => {
    const el =
      (next && find(`[data-done-for="${CSS.escape(next)}"]`)) ||
      find(`[data-reopen-for="${CSS.escape(key)}"]`) ||
      (prev && find(`[data-done-for="${CSS.escape(prev)}"]`))
    if (el) el.focus()
    else if (tries++ < 5) requestAnimationFrame(go)
  }
  requestAnimationFrame(go)
}

/**
 * One checklist task: title, state, a due date that explains itself (and its weekend-aware file-by
 * day), owner, why with the citation, and the actions the viewer may take. The Not applicable and
 * Evidence panels open below the buttons, take focus, and give it back to their button on Cancel,
 * save or Escape.
 */
export function TaskRow({ checklist, task, showPerson }: { checklist: Checklist; task: ChecklistTask; showPerson?: boolean }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const canAct = canActOnTask(viewer, db, checklist, task)
  // Skipping a task is an admin call; managers may skip their own non-statutory tasks.
  const canSkip = viewer.role === 'admin' || (viewer.role === 'manager' && task.ownerRole === 'manager' && !task.statutory)
  const [whyOpen, setWhyOpen] = useState(false)
  const [mode, setMode] = useState<null | 'na' | 'evidence'>(null)
  const [note, setNote] = useState('')
  const [link, setLink] = useState(task.evidenceLink ?? '')
  const uid = useId().replace(/:/g, '')
  const line = dueLine(db, checklist, task)
  const person = getPerson(db, checklist.personId)
  const open = task.status === 'open'
  const naRef = useRef<HTMLButtonElement>(null)
  const evidenceRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // An opened panel takes focus (its first control), so Tab continues inside it rather than past it.
  useEffect(() => {
    if (!mode) return
    panelRef.current?.querySelector<HTMLElement>('input, textarea, button:not([tabindex="-1"]):not([disabled])')?.focus()
  }, [mode])

  const toggle = (m: 'na' | 'evidence') => setMode(mode === m ? null : m)
  /** Closes the panel and gives focus back to the button that opened it. */
  const closePanel = () => {
    const trigger = mode === 'na' ? naRef.current : evidenceRef.current
    setMode(null)
    restoreFocus(trigger)
  }
  const hasWhy = !!(task.why || task.citation || task.soc2Control || task.link)

  const focusKey = `${checklist.id}:${task.id}`
  const setStatus = (status: ChecklistTask['status'], label: string, extra: { note?: string; evidenceLink?: string } = {}) => {
    const leavingOpen = task.status === 'open' && status !== 'open'
    useDB.getState().mutate(label, (d) => {
      setTaskStatus(d, checklist.id, task.id, status, { date: today(), byId: viewer.personId, ...extra })
    })
    undoToast(label)
    if (leavingOpen) moveFocusAfter(focusKey)
  }

  const saveEvidence = () => {
    const label = link ? `Saved the evidence link for ${task.title}` : `Removed the evidence link for ${task.title}`
    useDB.getState().mutate(label, (d) => {
      const t = d.checklists.find((c) => c.id === checklist.id)?.tasks.find((x) => x.id === task.id)
      if (t) t.evidenceLink = link.trim() || undefined
    })
    undoToast(label)
    closePanel()
  }

  return (
    <li className="@container border-b border-line py-3.5 last:border-b-0">
      {/* Side by side only when the list itself is wide (a container query, not the viewport), so large text
          or a narrow panel stacks the buttons under the task instead of squeezing the title. */}
      <div className="flex flex-col gap-3 @2xl:flex-row @2xl:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            aria-hidden
            className={cx(
              'ft-checkmark',
              task.status === 'done' ? 'ft-checkmark--done' : task.status === 'not_applicable' ? 'ft-checkmark--na' : 'ft-checkmark--open',
              'mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2',
              task.status === 'done'
                ? 'border-good bg-good text-surface'
                : task.status === 'not_applicable'
                  ? 'border-line-strong bg-surface-2 text-ink-3'
                  : 'border-line-strong',
            )}
          >
            {task.status === 'done' && <Icon name="check" size={14} strokeWidth={3} />}
            {task.status === 'not_applicable' && <Icon name="minus" size={14} strokeWidth={3} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={cx('text-[15px] font-semibold', open ? 'text-ink' : 'text-ink-2')}>{task.title}</span>
              <TaskStateBadges task={task} />
            </div>
            {showPerson && person && (
              <p className="mt-0.5 text-[13px] text-ink-3">
                For{' '}
                <a className="-my-2.5 inline-flex min-h-10 items-center font-semibold text-ink-2 hover:text-accent" href={links.checklist(checklist.id)}>
                  {fullName(person)}
                </a>
              </p>
            )}
            <p className="mt-1 text-[13.5px] text-ink-2" title={line.full}>
              <span className="font-semibold text-ink">{line.label}</span>
              {line.explain && <span className="text-ink-2">{` · ${line.explain}`}</span>}
            </p>
            <p className="mt-0.5 text-[13px] text-ink-3">
              {taskOwnerText(db, checklist, task)}
              {task.status === 'done' && task.doneById && getPerson(db, task.doneById) ? ` · done by ${fullName(getPerson(db, task.doneById) as Person)}` : ''}
            </p>
            {task.note && <p className="mt-1 text-[13.5px] text-ink-2">Note: {task.note}</p>}
            {task.evidenceLink && (
              <p className="mt-1 text-[13.5px]">
                <a href={task.evidenceLink} target="_blank" rel="noreferrer noopener" className="-my-2.5 inline-flex min-h-10 items-center gap-1 font-semibold text-accent hover:underline">
                  <Icon name="link" size={14} />
                  Evidence
                  <Icon name="external" size={12} />
                </a>
              </p>
            )}
            {hasWhy && (
              <button
                type="button"
                aria-expanded={whyOpen}
                aria-controls={`${uid}-why`}
                aria-label={`Why this matters: ${task.title}`}
                onClick={() => setWhyOpen((o) => !o)}
                className="ft-why mt-1.5 inline-flex min-h-10 items-center gap-1 rounded-md text-[13.5px] font-semibold text-ink-2 hover:text-ink"
              >
                <Icon name={whyOpen ? 'chevron-up' : 'chevron-down'} size={15} />
                Why this matters
              </button>
            )}
            {whyOpen && (
              <div id={`${uid}-why`} className="mt-1 rounded-lg bg-surface-2 px-3 py-2.5 text-[13.5px] text-ink-2">
                {task.why && <p>{task.why}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {task.citation && <CitationChip label={task.citation.label} url={task.citation.url} />}
                  {task.soc2Control && <Badge tone="outline">SOC 2 evidence</Badge>}
                  {/* A link into the app (the accepted offer for a sign-on bonus) opens here, not in a new tab. */}
                  {task.link && task.link.startsWith('#') ? (
                    <a href={task.link} className="-my-2.5 inline-flex min-h-10 items-center gap-1 text-[13px] font-semibold text-accent hover:underline">
                      {task.templateTaskId === TASK_IDS.signOnBonus ? 'Open the accepted offer' : 'Open the related record'} <Icon name="arrow-right" size={12} />
                    </a>
                  ) : task.link ? (
                    <a href={task.link} target="_blank" rel="noreferrer noopener" className="-my-2.5 inline-flex min-h-10 items-center gap-1 text-[13px] font-semibold text-accent hover:underline">
                      Open the form or guide <Icon name="external" size={12} />
                    </a>
                  ) : null}
                </div>
                {task.citation && <p className="mt-2 text-[12.5px] text-ink-3">Not legal advice; confirm with counsel or your PEO.</p>}
              </div>
            )}
          </div>
        </div>
        {canAct && (
          <div className="flex flex-wrap gap-2 pl-9 @2xl:max-w-[45%] @2xl:shrink-0 @2xl:justify-end @2xl:pl-0">
            {open ? (
              <>
                <Button
                  variant="primary"
                  icon="check"
                  data-done-for={focusKey}
                  aria-label={`Mark done: ${task.title}`}
                  onClick={() => setStatus('done', `Marked done: ${task.title}`)}
                >
                  Done
                </Button>
                {canSkip && (
                  <Button
                    ref={naRef}
                    variant="ghost"
                    aria-expanded={mode === 'na'}
                    aria-controls={mode === 'na' ? `${uid}-panel` : undefined}
                    aria-label={`Not applicable: ${task.title}`}
                    onClick={() => toggle('na')}
                  >
                    Not applicable
                  </Button>
                )}
              </>
            ) : (
              <Button
                variant="ghost"
                icon="rotate-ccw"
                data-reopen-for={focusKey}
                aria-label={`Reopen: ${task.title}`}
                onClick={() => setStatus('open', `Reopened: ${task.title}`)}
              >
                Reopen
              </Button>
            )}
            <Button
              ref={evidenceRef}
              variant="ghost"
              icon="link"
              aria-expanded={mode === 'evidence'}
              aria-controls={mode === 'evidence' ? `${uid}-panel` : undefined}
              aria-label={`${task.evidenceLink ? 'Edit' : 'Add'} evidence link: ${task.title}`}
              onClick={() => toggle('evidence')}
            >
              {task.evidenceLink ? 'Edit link' : 'Evidence'}
            </Button>
          </div>
        )}
      </div>
      {/* Below the buttons that open it (full width, lined up with the title), so it comes next in Tab order. */}
      {canAct && mode && (mode === 'evidence' || open) && (
        <div
          ref={panelRef}
          id={`${uid}-panel`}
          role="group"
          aria-label={mode === 'na' ? `Not applicable: ${task.title}` : `Evidence link: ${task.title}`}
          className="mt-3 ml-9 rounded-xl border border-line bg-surface-2/60 p-3"
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return
            // Closes only this panel: a sheet or dialog underneath stays open.
            e.preventDefault()
            e.stopPropagation()
            closePanel()
          }}
        >
          {mode === 'na' ? (
            <>
              <p className="text-[13.5px] font-semibold text-ink-2">Why is it not needed?</p>
              <ChipGroup
                label="Common reasons"
                size="sm"
                className="mt-2"
                value={NA_NOTES.includes(note) ? note : null}
                onChange={(v) => setNote(v)}
                options={NA_NOTES.map((n) => ({ value: n, label: n }))}
              />
              <Field label="Note" className="mt-2" id={`${uid}-na`} hint={task.statutory ? 'Items required by law need a note.' : undefined}>
                {(id, d) => (
                  <TextInput id={id} aria-describedby={d} maxLength={LINE_MAX_CHARS} value={note} onChange={(e) => setNote(e.target.value)} placeholder="One line is enough" />
                )}
              </Field>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={!note.trim()}
                  onClick={() => {
                    // The task leaves the open list, so focus moves on to the next task (setStatus), not back here.
                    setStatus('not_applicable', `Marked not applicable: ${task.title}`, { note: note.trim() })
                    setMode(null)
                  }}
                >
                  Mark not applicable
                </Button>
                <Button variant="ghost" onClick={closePanel}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <Field label="Link to the proof" id={`${uid}-ev`} hint="Where it lives: the PEO, Drive or a ticket. Never upload the file here.">
                {(id, d) => (
                  <TextInput
                    id={id}
                    aria-describedby={d}
                    type="url"
                    inputMode="url"
                    maxLength={LINK_MAX_CHARS}
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                    placeholder="https://"
                  />
                )}
              </Field>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="primary" onClick={saveEvidence}>
                  Save link
                </Button>
                <Button variant="ghost" onClick={closePanel}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  )
}

/** "Starts Mon Oct 19", "Last day Fri Aug 28", "Leave starts Mon Nov 16", "Takes effect Jan 1, 2027". */
export function anchorText(checklist: Checklist): string {
  const d = dayLabel(checklist.anchorDate)
  switch (checklist.kind) {
    case 'onboarding':
    case 'new_state':
      return `${checklist.anchorDate > today() ? 'Starts' : 'Started'} ${d}`
    case 'offboarding':
      return `Last day ${d}`
    case 'leave':
      return `Leave starts ${d}`
    case 'change':
      return `Takes effect ${fmtDate(checklist.anchorDate)}`
  }
}
