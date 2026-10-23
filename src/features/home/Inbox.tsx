// The action inbox UI: grouped rows (Overdue, This week, Coming up), a Waiting on you / them filter,
// one 48px primary action per row that runs the change through the store with an Undo toast, a Snooze
// menu capped for legal deadlines, a More menu and an Open link. Rows are compact: the title, one due
// chip and the actions; the explanation, law chip and date note sit behind the title (a disclosure).
// Each group shows its first few rows with a Show more button. Items come from src/domain/inbox.ts.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useViewer } from '@/app/useViewer'
import {
  applyInboxOp,
  canDismiss,
  dayText,
  dismissItem,
  filterItems,
  GROUP_LABELS,
  type InboxAction,
  type InboxGroup,
  type InboxItem,
  inboxItems,
  noSnoozeDetail,
  noSnoozeReason,
  snoozeItem,
  snoozeOptions,
  visibleForFilter,
} from '@/domain/inbox'
import { getPerson } from '@/domain/people'
import type { DB, ID, Viewer } from '@/domain/types'
import { ScorecardSheet } from '@/features/hiring/interviews'
import { fmtDay, type ISODate, today } from '@/lib/dates'
import { copyText } from '@/lib/files'
import { downloadBackupFile } from '@/store/backup'
import { useDB } from '@/store/db'
import { usePrefs } from '@/store/prefs'
import {
  Badge,
  Button,
  CitationChip,
  cx,
  EmptyState,
  Field,
  Icon,
  type IconName,
  Menu,
  type MenuItem,
  Modal,
  Private,
  Segmented,
  TextArea,
  toast,
} from '@/ui'

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

const MONEY_RE = /-?\$\s?\d[\d,]*(?:\.\d+)?(?:\s?[KkMm](?![a-z]))?/g

/**
 * The longest not-applicable note a row takes. It lands on the checklist or in the rules' status, which sync
 * as single records of at most 256 KB (docs/SYNC.md), so it stays short.
 */
const NOTE_MAX = 2_000

/** Item text with every dollar amount in <Private>, so notes people typed (an Admin's offer note) follow the blur. */
function ItemText({ text }: { text: string }) {
  const parts: Array<{ text: string; money: boolean }> = []
  let last = 0
  for (const m of text.matchAll(MONEY_RE)) {
    const at = m.index ?? 0
    if (at > last) parts.push({ text: text.slice(last, at), money: false })
    parts.push({ text: m[0], money: true })
    last = at + m[0].length
  }
  if (!parts.length) return <>{text}</>
  if (last < text.length) parts.push({ text: text.slice(last), money: false })
  return <>{parts.map((p, i) => (p.money ? <Private key={i}>{p.text}</Private> : <span key={i}>{p.text}</span>))}</>
}

/** A Viewer standing for one person's own tasks (Me > My tasks). */
function personalViewer(db: DB, personId: ID): Viewer {
  const person = getPerson(db, personId)
  return { role: 'employee', person, personId: person?.id ?? personId }
}

/** The viewer's inbox (or one person's own tasks when personId is given), recomputed on every change. */
export function useInboxItems(personId?: ID): { items: InboxItem[]; date: ISODate; viewer: Viewer } {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const date = today()
  const items = useMemo(() => {
    if (personId) return inboxItems(db, personalViewer(db, personId), date, { scope: 'personal' })
    return inboxItems(db, viewer, date)
  }, [db, viewer, date, personId])
  return { items, date, viewer }
}

// ---------------------------------------------------------------------------------------------
// Running actions
// ---------------------------------------------------------------------------------------------

function undoToast(text: string) {
  toast({ text, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
}

/** "(recorded as Tomas Herrera, preview)" for changes made outside Admin view, so the record stays honest. */
function previewSuffix(viewer: Viewer): string {
  if (viewer.role === 'admin' || !viewer.person) return ''
  return ` (recorded as ${viewer.person.preferredName || viewer.person.firstName} ${viewer.person.lastName}, preview)`
}

/** Text to copy by hand when the browser blocked the clipboard or a download (`note` says which, and what to do). */
type CopyFallback = { title: string; text: string; note?: string } | null
type OpenSheet = { sheet: 'scorecard'; id: ID } | null

/** Runs a row action. Returns true when the item is likely gone (so focus can move to the next row). */
async function runAction(
  action: InboxAction,
  viewer: Viewer,
  setFallback: (f: CopyFallback) => void,
  openSheet: (s: OpenSheet) => void = () => {},
): Promise<boolean> {
  if (action.kind === 'navigate') {
    window.location.hash = action.href.slice(1)
    return false
  }
  if (action.kind === 'sheet') {
    openSheet({ sheet: action.sheet, id: action.id })
    return false
  }
  if (action.kind === 'copy') {
    const ok = await copyText(action.text)
    if (ok) toast(action.toast)
    else setFallback({ title: action.label, text: action.text })
    return false
  }
  if (action.op.type === 'backup_downloaded') {
    // The same file as Settings, Data, and no Undo step: the backup time is stamped on every snapshot, so
    // Ctrl Z stays with the last real edit. Stamped either way, the row goes; a blocked download opens Copy.
    const { ok, json } = downloadBackupFile()
    if (ok) toast('Backup downloaded')
    else {
      setFallback({
        title: 'Copy your backup',
        text: json,
        note: 'This browser blocked the download. The backup is selected below: press Ctrl C (or Cmd C) to copy it, then paste it into a file you keep somewhere safe.',
      })
    }
    return true
  }
  const date = today()
  let result: ReturnType<typeof applyInboxOp> = { ok: false, reason: 'Nothing changed.' }
  const label = `${action.toast}${previewSuffix(viewer)}`
  useDB.getState().mutate(label, (draft) => {
    result = applyInboxOp(draft, action.op, { date, actorId: viewer.personId })
  })
  if (result.ok) {
    undoToast(label)
    return true
  }
  toast({ text: result.reason, tone: 'bad' })
  return false
}

// ---------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------

const ACTION_ICON: Record<InboxAction['kind'], IconName> = { mutate: 'check', navigate: 'arrow-right', copy: 'copy', sheet: 'edit' }

const LINK_BUTTON =
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl border font-semibold transition-colors select-none'

function DueChip({ item, date }: { item: InboxItem; date: ISODate }) {
  if (item.chip) {
    const tone = item.group === 'overdue' ? (item.statutory ? 'bad' : 'warn') : 'neutral'
    return (
      <Badge tone={tone} icon={item.group === 'overdue' ? 'alert' : 'calendar'} title={item.dueNote}>
        {item.chip}
      </Badge>
    )
  }
  if (!item.dueOn) return null
  // A scorecard can be overdue a few hours into its due day.
  const overdue = item.dueOn < date || item.group === 'overdue'
  const text = item.dueOn === date ? (overdue ? 'Was due today' : 'Due today') : overdue ? `Was due ${dayText(item.dueOn)}` : `Due ${dayText(item.dueOn)}`
  const tone = overdue ? (item.statutory ? 'bad' : 'warn') : item.dueOn === date ? 'accent' : 'neutral'
  return (
    <Badge tone={tone} icon={overdue ? 'alert' : 'calendar'} title={item.dueNote}>
      {text}
    </Badge>
  )
}

function NotApplicableModal({
  item,
  onClose,
  viewer,
}: {
  item: InboxItem | null
  onClose: () => void
  viewer: Viewer
}) {
  const [note, setNote] = useState('')
  useEffect(() => setNote(''), [item?.key])
  if (!item?.notApplicable) return null
  const na = item.notApplicable
  const needsNote = item.statutory || na.op === 'rule'
  const count = note.length >= NOTE_MAX - 200 ? ` ${note.length.toLocaleString('en-US')} of ${NOTE_MAX.toLocaleString('en-US')} characters.` : ''
  const save = () => {
    if (needsNote && !note.trim()) return
    const op =
      na.op === 'task' && na.checklistId && na.taskId
        ? ({ type: 'task_status', checklistId: na.checklistId, taskId: na.taskId, status: 'not_applicable', note: note.trim() } as const)
        : ({ type: 'rule_not_applicable', ruleId: na.ruleId ?? '', note: note.trim() } as const)
    void runAction({ kind: 'mutate', label: 'Mark not applicable', op, toast: `Marked not applicable: ${item.title}` }, viewer, () => {})
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Mark not applicable"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={needsNote && !note.trim()}>
            Mark not applicable
          </Button>
        </>
      }
    >
      <p className="text-[14.5px] text-ink">
        <ItemText text={item.title} />
      </p>
      <div className="mt-3">
        <Field
          label={needsNote ? 'Why it does not apply (required)' : 'Note (optional)'}
          hint={`${needsNote ? 'Legal items need a reason so the record explains itself later. ' : ''}Tip: Win+H or macOS dictation works here.${count}`}
        >
          {(id, describedBy) => (
            <TextArea id={id} aria-describedby={describedBy} rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} data-autofocus />
          )}
        </Field>
      </div>
    </Modal>
  )
}

function CopyFallbackModal({ fallback, onClose }: { fallback: CopyFallback; onClose: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (fallback) setTimeout(() => ref.current?.select(), 30)
  }, [fallback])
  if (!fallback) return null
  return (
    <Modal open onClose={onClose} title={fallback.title} footer={<Button onClick={onClose}>Done</Button>}>
      <p className="text-[14px] text-ink-2">
        {fallback.note ?? 'This browser blocked the clipboard. The text is selected below: press Ctrl C (or Cmd C) to copy it.'}
      </p>
      <textarea
        ref={ref}
        readOnly
        aria-label={fallback.title}
        value={fallback.text}
        rows={8}
        className="mt-3 w-full rounded-lg border border-line-strong bg-surface p-3 font-mono text-[12.5px] text-ink"
      />
    </Modal>
  )
}

function InboxRow({
  item,
  date,
  viewer,
  compact,
  holdFocus,
  onNotApplicable,
  setFallback,
  openSheet,
}: {
  item: InboxItem
  date: ISODate
  viewer: Viewer
  compact?: boolean
  /** Before a change that may remove the row: remember its place so focus lands on the next row. */
  holdFocus: (hold: boolean, row: HTMLElement | null) => void
  onNotApplicable: (item: InboxItem) => void
  setFallback: (f: CopyFallback) => void
  openSheet: (s: OpenSheet) => void
}) {
  const rowRef = useRef<HTMLLIElement>(null)
  const detailsId = useId()
  const [showDetails, setShowDetails] = useState(false)
  const options = snoozeOptions(item, date)
  const p = item.primary
  const hold = (h: boolean) => holdFocus(h, rowRef.current)
  const act = async (a: InboxAction) => {
    hold(a.kind === 'mutate')
    const gone = await runAction(a, viewer, setFallback, openSheet)
    if (!gone) hold(false)
  }
  const snooze = (until: ISODate, label: string) => {
    const text = `Snoozed until ${fmtDay(until)}: ${item.title}`
    hold(true)
    useDB.getState().mutate(text, (d) => snoozeItem(d, item.key, until))
    undoToast(label === 'Until the due date' ? `${text} (its due date)` : text)
  }
  const snoozeItems: MenuItem[] = options.map((o) => ({ label: o.label, hint: fmtDay(o.until), icon: 'clock' as const, onSelect: () => snooze(o.until, o.label) }))
  const moreItems: MenuItem[] = [
    ...(item.more ?? []).map((a) => ({ label: a.label, icon: ACTION_ICON[a.kind], onSelect: () => void act(a) })),
    ...(item.notApplicable ? [{ label: 'Mark not applicable…', icon: 'minus' as const, onSelect: () => onNotApplicable(item) }] : []),
    ...(canDismiss(item)
      ? [
          {
            label: 'Dismiss',
            icon: 'x' as const,
            onSelect: () => {
              const text = `Dismissed: ${item.title}`
              hold(true)
              useDB.getState().mutate(text, (d) => dismissItem(d, item.key, date))
              undoToast(text)
            },
          },
        ]
      : []),
  ]
  const red = item.statutory && item.group === 'overdue'
  const dueNote = item.dueNote && item.group !== 'coming_up' ? item.dueNote : undefined
  const hasDetails = !!(item.detail || item.citation || item.externalLink || dueNote || snoozeItems.length === 0)
  const primaryName = `${p.label}: ${item.title}`
  const titleClass = cx('font-semibold text-ink', compact ? 'text-[14.5px]' : 'text-[15px]')
  return (
    <li
      ref={rowRef}
      data-inbox-row
      className={cx(
        'ft-inboxrow border-b border-line py-3 last:border-b-0',
        red && 'ft-inboxrow--bad relative pl-3 before:absolute before:top-3 before:bottom-3 before:left-0 before:w-[3px] before:rounded-full before:bg-bad',
      )}
    >
      {hasDetails ? (
        <button
          type="button"
          aria-expanded={showDetails}
          aria-controls={detailsId}
          onClick={() => setShowDetails((v) => !v)}
          className="group -mx-1 flex min-h-10 w-[calc(100%+0.5rem)] items-start gap-1.5 rounded-lg px-1 py-0.5 text-left hover:bg-surface-2"
        >
          <span className={cx(titleClass, 'min-w-0 flex-1')}>
            <ItemText text={item.title} />
          </span>
          <Icon name={showDetails ? 'chevron-up' : 'chevron-down'} size={18} className="mt-0.5 shrink-0 text-ink-3 group-hover:text-ink" />
        </button>
      ) : (
        <p className={cx(titleClass, 'py-0.5')}>
          <ItemText text={item.title} />
        </p>
      )}
      {hasDetails && showDetails && (
        <div id={detailsId} className="mt-1 mb-1 flex flex-col gap-2">
          {item.detail && (
            <p className="text-[13.5px] text-ink-2">
              <ItemText text={item.detail} />
            </p>
          )}
          {snoozeItems.length === 0 && <p className="text-[13px] text-ink-3">{noSnoozeDetail(item, date)}</p>}
          {(item.citation || item.externalLink || dueNote) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {item.citation && <CitationChip label={item.citation.label} url={item.citation.url} />}
              {item.externalLink && (
                <a
                  href={item.externalLink.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex h-7 items-center gap-1 rounded-full border border-line-strong px-2.5 text-[12px] font-semibold text-ink-2 hover:border-ink-3 hover:text-ink"
                >
                  {item.externalLink.label}
                  <Icon name="external" size={11} />
                </a>
              )}
              {dueNote && <span className="text-[12.5px] text-ink-3">{dueNote}</span>}
            </div>
          )}
        </div>
      )}
      {/* One line under the title: the due chip on the left, the actions on the right (they wrap below on phones). */}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <DueChip item={item} date={date} />
          {red && (
            <Badge tone="bad" icon="scale">
              Legal deadline
            </Badge>
          )}
          {item.waitingOn === 'them' && (
            <Badge tone="outline" icon="clock">
              Waiting on {item.waitingOnName ?? 'them'}
            </Badge>
          )}
        </div>
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
          {p.kind === 'navigate' ? (
            <a
              href={p.href}
              data-inbox-primary
              aria-label={primaryName}
              className={cx('ft-btn ft-btn--secondary ft-btn--lg', LINK_BUTTON, 'h-12 border-line-strong bg-surface px-4 text-[15.5px] text-ink hover:bg-surface-2')}
            >
              {p.label}
              <Icon name="arrow-right" size={18} className="ft-btn__icon ft-btn__icon--right shrink-0" />
            </a>
          ) : (
            <Button size="lg" icon={ACTION_ICON[p.kind]} data-inbox-primary aria-label={primaryName} className="px-4" onClick={() => void act(p)}>
              {p.label}
            </Button>
          )}
          {snoozeItems.length > 0 ? (
            <Menu
              label={`Snooze: ${item.title}`}
              items={snoozeItems}
              trigger={(t) => (
                <Button {...t} variant="ghost" icon="clock" aria-label={`Snooze ${item.title}`} title="Snooze" className="px-3">
                  <span className="hidden @[860px]:inline">Snooze</span>
                </Button>
              )}
            />
          ) : (
            // A legal deadline that is due (or the payroll cutoff) cannot wait: say so instead of offering an empty menu.
            <span className="inline-flex h-11 items-center gap-1.5 px-2 text-[13px] font-semibold text-ink-3" title={noSnoozeReason(item, date)}>
              <Icon name="lock" size={15} />
              <span className="hidden @[860px]:inline">Cannot snooze</span>
              <span className="sr-only">{noSnoozeReason(item, date)}</span>
            </span>
          )}
          {moreItems.length > 0 && (
            <Menu
              label={`More actions: ${item.title}`}
              items={moreItems}
              trigger={(t) => (
                <button
                  type="button"
                  {...t}
                  aria-label={`More actions for ${item.title}`}
                  title="More actions"
                  className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink"
                >
                  <Icon name="more" size={19} />
                </button>
              )}
            />
          )}
          <a
            href={item.href}
            aria-label={`Open: ${item.title}`}
            title="Open"
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="chevron-right" size={20} />
          </a>
        </div>
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------

const GROUPS: InboxGroup[] = ['overdue', 'this_week', 'coming_up']

/** Rows shown per group before Show more; a group of up to GROUP_CAP + 1 shows whole. */
const GROUP_CAP = 5

/** Renders computed items with the filter and grouping. Home passes its own items; Me uses Inbox. */
export function InboxView({
  items,
  date,
  viewer,
  compact,
  showFilter = true,
  emptyBody,
}: {
  items: InboxItem[]
  date: ISODate
  viewer: Viewer
  compact?: boolean
  showFilter?: boolean
  emptyBody?: string
}) {
  const filter = usePrefs((s) => s.inboxFilter)
  const setFilter = usePrefs((s) => s.setInboxFilter)
  const hasThem = items.some((i) => i.waitingOn === 'them')
  const active = showFilter && hasThem ? filter : 'all'
  const shown = filterItems(items, active)
  const [naItem, setNaItem] = useState<InboxItem | null>(null)
  const [showLater, setShowLater] = useState(false)
  const [expanded, setExpanded] = useState<Partial<Record<InboxGroup, boolean>>>({})
  const [fallback, setFallback] = useState<CopyFallback>(null)
  const [sheet, setSheet] = useState<OpenSheet>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const focusIndex = useRef<number | null>(null)
  const keys = shown.map((i) => i.key).join('|')

  // After an action removes a row, move keyboard focus to the row that took its place.
  useEffect(() => {
    if (focusIndex.current == null || !listRef.current) return
    const rows = Array.from(listRef.current.querySelectorAll<HTMLElement>('[data-inbox-row]'))
    const row = rows[Math.min(focusIndex.current, rows.length - 1)]
    focusIndex.current = null
    row?.querySelector<HTMLElement>('[data-inbox-primary]')?.focus()
  }, [keys])

  const holdFocus = (hold: boolean, row: HTMLElement | null) => {
    if (!hold || !row || !listRef.current) {
      focusIndex.current = null
      return
    }
    const rows = Array.from(listRef.current.querySelectorAll<HTMLElement>('[data-inbox-row]'))
    const i = rows.indexOf(row)
    focusIndex.current = i >= 0 ? i : null
  }

  // The filter counts match the rows each filter shows (and the Tonight header while Coming up is folded).
  const count = (f: 'all' | 'you' | 'them') => visibleForFilter(items, f, showLater).length
  return (
    <div ref={listRef} className="@container">
      {showFilter && hasThem && (
        <div className="mb-2">
          <Segmented
            label="Show items"
            value={active}
            onChange={setFilter}
            size="sm"
            options={[
              { value: 'all', label: 'All', count: count('all') },
              { value: 'you', label: 'Waiting on you', count: count('you') },
              { value: 'them', label: 'Waiting on them', count: count('them') },
            ]}
          />
        </div>
      )}
      {shown.length === 0 ? (
        <EmptyState
          compact
          icon="check"
          title={active === 'them' ? 'Nothing waiting on anyone else' : 'Nothing needs you right now'}
          body={emptyBody ?? 'New items appear here as dates come due. Every item is computed from your data, so there is nothing to file away.'}
        />
      ) : (
        GROUPS.map((g) => {
          const list = shown.filter((i) => i.group === g)
          if (!list.length) return null
          // Coming up folds away while there is work due now, so the list starts with what matters tonight.
          const foldable = g === 'coming_up' && shown.length > list.length
          const open = !foldable || showLater
          const long = list.length > GROUP_CAP + 1
          const capped = long && !expanded[g]
          const rows = capped ? list.slice(0, GROUP_CAP) : list
          return (
            <section key={g} aria-labelledby={`inbox-${g}`} className="mt-2 first:mt-0">
              <h3 id={`inbox-${g}`} className="flex items-center gap-2 pt-2 text-[13px] font-bold tracking-wide text-ink-3 uppercase">
                {foldable ? (
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setShowLater((v) => !v)}
                    className="-ml-1 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-1 uppercase hover:text-ink"
                  >
                    <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
                    {GROUP_LABELS[g]}
                  </button>
                ) : (
                  GROUP_LABELS[g]
                )}
                <span className="ft-count num rounded-full bg-surface-2 px-2 py-0.5 text-[12px] text-ink-2">{list.length}</span>
              </h3>
              {!open ? null : (
                <>
                  <ul>
                    {rows.map((item) => (
                      <InboxRow
                        key={item.key}
                        item={item}
                        date={date}
                        viewer={viewer}
                        compact={compact}
                        setFallback={setFallback}
                        openSheet={setSheet}
                        onNotApplicable={setNaItem}
                        holdFocus={holdFocus}
                      />
                    ))}
                  </ul>
                  {long && (
                    <button
                      type="button"
                      aria-expanded={!capped}
                      onClick={() => setExpanded((e) => ({ ...e, [g]: !e[g] }))}
                      className="mt-1 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-[14px] font-semibold text-accent hover:bg-accent-soft"
                    >
                      <Icon name={capped ? 'chevron-down' : 'chevron-up'} size={16} />
                      {capped ? `Show ${list.length - GROUP_CAP} more in ${GROUP_LABELS[g]}` : `Show fewer in ${GROUP_LABELS[g]}`}
                    </button>
                  )}
                </>
              )}
            </section>
          )
        })
      )}
      {shown.some((i) => i.statutory || i.citation) && (
        <p className="mt-3 border-t border-line pt-3 text-[12.5px] text-ink-3">
          {shown.some((i) => i.statutory) ? 'Red marks an overdue legal deadline; legal deadlines cannot be snoozed past their due date. ' : ''}
          Tap a title for the why and the source. Not legal advice; confirm with counsel or your PEO.
        </p>
      )}
      <NotApplicableModal item={naItem} onClose={() => setNaItem(null)} viewer={viewer} />
      <CopyFallbackModal fallback={fallback} onClose={() => setFallback(null)} />
      <ScorecardSheet scorecardId={sheet?.sheet === 'scorecard' ? sheet.id : null} open={sheet?.sheet === 'scorecard'} onClose={() => setSheet(null)} />
    </div>
  )
}

/**
 * The action inbox. Without personId it shows the viewer's inbox for their Viewing-as mode; with
 * personId (Me > My tasks) it shows that person's own tasks: checklist items, trainings, policy
 * acknowledgements and scorecards.
 */
export function Inbox({ personId, compact }: { personId?: ID; compact?: boolean }) {
  const { items, date, viewer } = useInboxItems(personId)
  return (
    <InboxView
      items={items}
      date={date}
      viewer={viewer}
      compact={compact}
      showFilter={!personId && !compact}
      emptyBody={personId ? 'No tasks for you right now. New-hire items, trainings and policy acknowledgements show up here when they are due.' : undefined}
    />
  )
}
