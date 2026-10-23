// Me tabs other than Summary and Profile. Each one composes the owning feature's shared panel and
// adds only what is specific to looking at your own record.
import { type ReactNode, useId, useMemo, useState } from 'react'
import { useViewer } from '@/app/useViewer'
import { PersonEquityPanel, PersonJobPayPanel } from '@/features/comp'
import { OpenRolesList } from '@/features/hiring/interviews'
import { InboxView } from '@/features/home'
import { PersonTimeOffPanel } from '@/features/timeoff'
import { applyInboxOp } from '@/domain/inbox'
import { TRAINING_LABELS, trainingRequirements } from '@/domain/trainings'
import type { DB, ID, Person, TrainingKind } from '@/domain/types'
import { fmtDate, fmtDay, nowISO, today } from '@/lib/dates'
import { plural } from '@/lib/format'
import { Badge, Button, Callout, cx, Icon, Panel } from '@/ui'
import { change, LineItem } from './bits'
import { acknowledgePolicy } from './profile'
import { coveredByTasks, dayText, myTaskItems, payrollProviderName, policyStatuses, SOON_DAYS, taskCounts, trainingStatusText } from './summary'

// ---- Job and pay ------------------------------------------------------------------------------

export function JobTab({ db, person }: { db: DB; person: Person }) {
  const peo = db.company.payrollProvider
  const peoName = payrollProviderName(db) ?? 'the payroll provider'
  // PersonJobPayPanel (comp) shows the current job, pay, the band for the position with the Labor Code
  // 432.3 line, and the effective-dated history. Me adds only the privacy note and where payroll lives.
  return (
    <div className="flex flex-col gap-4">
      <PersonJobPayPanel personId={person.id} />
      <Callout tone="neutral" icon="lock" title="Who sees this">
        Your manager and teammates never see your pay or equity in this app. Pay stubs, tax forms and direct deposit live with{' '}
        {peo?.url ? (
          <a href={peo.url} target="_blank" rel="noreferrer noopener" className="-my-2.5 inline-flex min-h-10 items-center font-semibold text-accent underline">
            {peoName}
          </a>
        ) : (
          peoName
        )}
        .
      </Callout>
    </div>
  )
}

// ---- Equity -----------------------------------------------------------------------------------

export function EquityTab({ person }: { person: Person }) {
  // PersonEquityPanel (comp) has the grants, vesting chart, next vest, cliff countdown and the exercise
  // window explained, so Me shows it as is.
  return <PersonEquityPanel personId={person.id} />
}

// ---- Time off ---------------------------------------------------------------------------------

export function TimeOffTab({ db, person }: { db: DB; person: Person }) {
  const date = today()
  const year = Number(date.slice(0, 4))
  const holidays = db.holidays.filter((h) => h.date >= date && Number(h.date.slice(0, 4)) <= year + 1).sort((a, b) => a.date.localeCompare(b.date))
  const byYear = new Map<string, typeof holidays>()
  for (const h of holidays) byYear.set(h.date.slice(0, 4), [...(byYear.get(h.date.slice(0, 4)) ?? []), h])
  return (
    <div className="flex flex-col gap-4">
      <PersonTimeOffPanel personId={person.id} hideRequest />
      <Panel title="Company holidays" icon="star" subtitle="Paid days off for everyone">
        {holidays.length === 0 ? (
          <p className="text-[14.5px] text-ink-3">No upcoming holidays are loaded. An admin adds them in Settings.</p>
        ) : (
          <div className="grid gap-x-8 gap-y-2 md:grid-cols-2">
            {[...byYear.entries()].map(([y, list]) => (
              <div key={y} className="min-w-0">
                <h3 className="text-[13px] font-bold text-ink-3">{y}</h3>
                <ul className="divide-y divide-line">
                  {list.map((h) => (
                    <LineItem key={h.id} label={h.name} value={fmtDay(h.date)} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}

// ---- Tasks ------------------------------------------------------------------------------------

/**
 * One to-do list (myTaskItems: checklist items, tasks assigned to you, trainings, policy acknowledgements
 * and scorecards, each once with one action), then Policies and Training as status-only reference lists,
 * folded away. A reference row offers its own button only when the to-do list does not hold that item.
 */
export function TasksTab({ db, person }: { db: DB; person: Person }) {
  const viewer = useViewer()
  const date = today()
  const items = useMemo(() => myTaskItems(db, person.id, date, nowISO()), [db, person.id, date])
  const covered = useMemo(() => coveredByTasks(db, person.id, items), [db, person.id, items])
  const { soon, later } = taskCounts(items, date)
  // Same words and count as the Summary panel ("2 things need you") and the Tasks tab badge.
  const subtitle = soon
    ? `${soon} ${soon === 1 ? 'thing needs' : 'things need'} you${later ? `, ${later} later` : ''}`
    : later
      ? `Nothing due in the next ${SOON_DAYS} days. ${plural(later, 'task')} later.`
      : 'All caught up'
  return (
    <div className="flex flex-col gap-4">
      <Panel title="To do" icon="clipboard-check" subtitle={subtitle}>
        <InboxView
          items={items}
          date={date}
          viewer={viewer}
          showFilter={false}
          emptyBody="New-hire items, tasks assigned to you, trainings, policy acknowledgements and scorecards show up here when they come up."
        />
      </Panel>
      <PoliciesPanel db={db} person={person} covered={covered.policies} />
      <TrainingPanel db={db} person={person} covered={covered.trainings} />
    </div>
  )
}

/** A panel whose body folds away; the header button says what it does and is reachable by keyboard. */
function FoldingPanel({
  title,
  icon,
  subtitle,
  defaultOpen,
  children,
}: {
  title: string
  icon: 'file' | 'shield-check'
  subtitle: string
  defaultOpen: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = useId()
  return (
    <Panel
      title={title}
      icon={icon}
      subtitle={subtitle}
      padded={false}
      className={cx(!open && '[&>div:first-child]:border-b-0')}
      actions={
        <Button
          variant="ghost"
          size="sm"
          iconRight={open ? 'chevron-down' : 'chevron-right'}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${open ? 'Hide' : 'Show'} ${title.toLowerCase()}`}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide' : 'Show'}
        </Button>
      }
    >
      <div id={bodyId} hidden={!open} className="px-5 py-4">
        {open && children}
      </div>
    </Panel>
  )
}

const READ_LINK = 'inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-[14px] font-semibold text-accent hover:bg-accent-soft'

function PoliciesPanel({ db, person, covered }: { db: DB; person: Person; covered: Set<ID> }) {
  const date = today()
  const rows = useMemo(() => policyStatuses(db, person.id, date), [db, person.id, date])
  if (!rows.length) return null
  const owed = rows.filter((r) => r.owed)
  // Owed but not in the to-do list (someone starting soon, or a solo founder): acknowledge it here.
  const loose = owed.filter((r) => !covered.has(r.policy.id))
  const subtitle = !owed.length
    ? 'All acknowledged. Thank you.'
    : loose.length
      ? `${plural(loose.length, 'policy', 'policies')} to acknowledge here`
      : `${plural(owed.length, 'policy', 'policies')} to acknowledge, listed under To do`
  return (
    <FoldingPanel title="Policies" icon="file" subtitle={subtitle} defaultOpen={loose.length > 0}>
      <ul className="-my-1 divide-y divide-line">
        {rows.map((r) => {
          const label = `${r.policy.title} ${r.policy.version}`
          const inTodo = r.owed && covered.has(r.policy.id)
          return (
            <li key={r.policy.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
              <div className="min-w-0 flex-1 basis-56">
                <p className="text-[14.5px] font-semibold text-ink">
                  {r.policy.title} <span className="font-normal text-ink-3">version {r.policy.version}</span>
                </p>
                <p className="text-[13px] text-ink-3">{r.policy.summary}</p>
                {/* When the to-do list holds it, its row carries the due date, so the two never disagree. */}
                {r.owed && (r.previousVersionOn || !inTodo) && (
                  <p className="mt-0.5 text-[13px] text-ink-2">
                    {r.previousVersionOn ? `New version since you acknowledged on ${fmtDate(r.previousVersionOn)}. ` : ''}
                    {inTodo ? '' : r.dueOn < date ? `Was due ${dayText(r.dueOn, date)}.` : `Due ${dayText(r.dueOn, date)}.`}
                  </p>
                )}
              </div>
              {r.policy.link && (
                <a href={r.policy.link} target="_blank" rel="noreferrer noopener" className={READ_LINK} aria-label={`Read ${label} (opens in a new tab)`}>
                  Read
                  <Icon name="external" size={14} />
                </a>
              )}
              {!r.owed ? (
                <Badge tone="good" icon="check">
                  Acknowledged {r.acknowledgedOn ? fmtDate(r.acknowledgedOn) : ''}
                </Badge>
              ) : inTodo ? (
                <Badge tone="neutral" icon="clock">
                  To acknowledge, under To do
                </Badge>
              ) : (
                <Button
                  variant="primary"
                  icon="check"
                  aria-label={`Acknowledge ${label}`}
                  onClick={() =>
                    change(`Acknowledged ${label}`, (d) => {
                      acknowledgePolicy(d, r.policy.id, person.id, today())
                    })
                  }
                >
                  Acknowledge
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </FoldingPanel>
  )
}

function TrainingPanel({ db, person, covered }: { db: DB; person: Person; covered: Set<TrainingKind> }) {
  const date = today()
  const rows = useMemo(() => trainingRequirements(db, person, date), [db, person, date])
  if (!rows.length) return null
  const done = rows.filter((r) => r.status === 'done').length
  const inTodo = rows.filter((r) => r.status !== 'done' && covered.has(r.kind)).length
  const parts = [done ? `${done} done` : '', inTodo ? `${inTodo} under To do` : ''].filter(Boolean)
  const subtitle = parts.length ? `Courses you need, and when: ${parts.join(', ')}.` : 'Courses you need, and when.'
  const markDone = (kind: TrainingKind) => {
    const label = TRAINING_LABELS[kind]
    change(`Recorded ${label.charAt(0).toLowerCase()}${label.slice(1)} as done`, (d) => {
      applyInboxOp(d, { type: 'training_done', personId: person.id, kind }, { date: today(), actorId: person.id })
    })
  }
  return (
    <FoldingPanel title="Training" icon="shield-check" subtitle={subtitle} defaultOpen={false}>
      <ul className="-my-1 divide-y divide-line">
        {rows.map((row) => {
          const status = trainingStatusText(row, date)
          const listed = row.status !== 'done' && covered.has(row.kind)
          // Only rows the to-do list does not hold get a button here, so no task has two.
          const canMark = !listed && row.status !== 'done' && (row.required || row.recommended)
          return (
            <li key={row.kind} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
              <div className="min-w-0 flex-1 basis-56">
                <p className="text-[14.5px] font-semibold text-ink">{TRAINING_LABELS[row.kind]}</p>
                <p className="text-[13px] text-ink-3">
                  {row.reason}
                  {row.completedOn ? ` Last completed ${fmtDate(row.completedOn)}.` : ''}
                </p>
              </div>
              {row.certificateLink && (
                <a href={row.certificateLink} target="_blank" rel="noreferrer noopener" className={READ_LINK} aria-label={`Certificate for ${TRAINING_LABELS[row.kind]} (opens in a new tab)`}>
                  Certificate
                  <Icon name="external" size={14} />
                </a>
              )}
              {row.link && row.status !== 'done' && (
                <a href={row.link} target="_blank" rel="noreferrer noopener" className={READ_LINK} aria-label={`Open the course for ${TRAINING_LABELS[row.kind]} (opens in a new tab)`}>
                  Course
                  <Icon name="external" size={14} />
                </a>
              )}
              <Badge tone={status.tone}>{listed ? `${status.label}, under To do` : status.label}</Badge>
              {canMark && (
                <Button icon="check" aria-label={`Mark ${TRAINING_LABELS[row.kind]} done`} onClick={() => markDone(row.kind)}>
                  Mark done
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </FoldingPanel>
  )
}

// ---- Open roles -------------------------------------------------------------------------------

export function RolesTab() {
  // OpenRolesList (hiring) shows posted ranges, the referral bonus, Refer someone and the viewer's own
  // referrals with their stage only.
  return <OpenRolesList />
}
