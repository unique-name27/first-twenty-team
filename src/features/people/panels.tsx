// People panels reused by Home and Me (owned by the people feature).
import { useMemo, useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { mootAfterExit } from '@/domain/checklists/generate'
import { fullName, getPerson } from '@/domain/people'
import type { Checklist, ChecklistTask, ID, Person } from '@/domain/types'
import { addDays, fmtDate, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Avatar, Badge, EmptyState, Icon, Meter, Panel, SectionLabel } from '@/ui'
import { canSeeChecklist, CHECKLIST_KIND_LABEL, checklistStats, dayLabel, inFlightSummary } from './helpers'
import { anchorText, EmpNo, TaskRow } from './parts'

export { OffboardSheet } from './OffboardSheet'

/** Summary card for one checklist: kind, anchor, progress, overdue count, next due and Day 1 ready. */
export function ChecklistCard({ checklist }: { checklist: Checklist }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const t = today()
  const { progress, tasks } = checklistStats(viewer, db, checklist, t)
  const onboarding = checklist.kind === 'onboarding' || checklist.kind === 'new_state'
  const preStart = onboarding && checklist.anchorDate >= t
  const pre = tasks.filter((x) => x.status !== 'not_applicable' && x.dueOn < checklist.anchorDate)
  const preDone = pre.filter((x) => x.status === 'done').length
  const ready = onboarding && pre.length > 0 && preDone === pre.length
  return (
    <a
      href={links.checklist(checklist.id)}
      className="block rounded-xl border border-line bg-surface px-4 py-3 transition-colors hover:border-line-strong hover:bg-surface-2/50"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">{CHECKLIST_KIND_LABEL[checklist.kind]}</span>
        <span className="text-[13.5px] text-ink-3">{anchorText(checklist)}</span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          {checklist.completedOn ? (
            <Badge tone="good" icon="check">
              Complete {fmtDate(checklist.completedOn)}
            </Badge>
          ) : null}
          {preStart && ready && (
            <Badge tone="good" icon="check">
              Day 1 ready
            </Badge>
          )}
          {progress.statutoryOverdue > 0 ? (
            <Badge tone="bad" icon="alert">
              {progress.statutoryOverdue} {progress.statutoryOverdue === 1 ? 'legal deadline' : 'legal deadlines'} overdue
            </Badge>
          ) : progress.overdue > 0 ? (
            <Badge tone="warn" icon="clock">
              {progress.overdue} overdue
            </Badge>
          ) : null}
        </span>
      </div>
      <div className="mt-2.5 flex items-center gap-3">
        <Meter
          value={progress.done}
          max={Math.max(1, progress.total)}
          tone={progress.statutoryOverdue ? 'bad' : progress.done === progress.total ? 'good' : 'accent'}
          label={`${CHECKLIST_KIND_LABEL[checklist.kind]}: ${progress.done} of ${progress.total} done`}
        />
        <span className="num shrink-0 text-[13.5px] font-semibold text-ink-2">
          {progress.done} of {progress.total}
        </span>
      </div>
      {preStart && !ready && pre.length > 0 && (
        <p className="mt-1.5 text-[13px] text-ink-3">
          Pre-start {preDone} of {pre.length} done
        </p>
      )}
      {progress.nextDue && (
        <p className="mt-1.5 text-[13px] text-ink-3">
          Next: <span className="text-ink-2">{progress.nextDue.title}</span>, {dayLabel(progress.nextDue.dueOn)}
        </p>
      )}
    </a>
  )
}

function bucketOf(task: ChecklistTask, t: string): 'overdue' | 'week' | 'later' {
  if (task.dueOn < t) return 'overdue'
  if (task.dueOn <= addDays(t, 7)) return 'week'
  return 'later'
}

const BUCKET_LABEL = { overdue: 'Overdue', week: 'Due in the next 7 days', later: 'Coming up' } as const

/**
 * A person's checklists. On a profile: each checklist with progress, then the open tasks the viewer
 * can see, soonest first. With onlyMine (Me > My tasks): just the tasks this person owns, including
 * manager tasks on their reports' checklists, grouped Overdue, next 7 days, Coming up.
 */
export function PersonChecklistsPanel({ personId, onlyMine }: { personId: ID; onlyMine?: boolean }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const t = today()
  const [showDone, setShowDone] = useState(false)

  const mine = useMemo(() => {
    if (!onlyMine) return []
    const rows: Array<{ checklist: Checklist; task: ChecklistTask }> = []
    for (const cl of db.checklists) {
      if (!canSeeChecklist(viewer, db, cl)) continue
      const person = getPerson(db, cl.personId)
      for (const task of checklistStats(viewer, db, cl, t).tasks) {
        if (task.status !== 'open' || mootAfterExit(cl, task, person)) continue
        // An unassigned manager task (its manager left) belongs to whoever manages the person now.
        const owns = task.assigneeId
          ? task.assigneeId === personId
          : task.ownerRole === 'employee'
            ? cl.personId === personId
            : task.ownerRole === 'manager' && person?.managerId === personId
        if (owns) rows.push({ checklist: cl, task })
      }
    }
    return rows.sort((a, b) => a.task.dueOn.localeCompare(b.task.dueOn))
  }, [db, viewer, personId, onlyMine, t])

  if (onlyMine) {
    const groups = (['overdue', 'week', 'later'] as const)
      .map((k) => ({ k, rows: mine.filter((r) => bucketOf(r.task, t) === k) }))
      .filter((g) => g.rows.length)
    return (
      <Panel title="My checklist tasks" subtitle="Your own new-hire items, and manager tasks for your reports." icon="clipboard-check">
        {!mine.length ? (
          <EmptyState
            compact
            icon="clipboard-check"
            title="Nothing on your list"
            body="New-hire items and check-ins for your reports show up here when they are due."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((g) => (
              <section key={g.k} aria-label={BUCKET_LABEL[g.k]}>
                <SectionLabel>
                  {BUCKET_LABEL[g.k]} ({g.rows.length})
                </SectionLabel>
                <ul className="mt-1">
                  {g.rows.map((r) => (
                    <TaskRow key={r.task.id} checklist={r.checklist} task={r.task} showPerson={r.checklist.personId !== personId} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Panel>
    )
  }

  const lists = db.checklists.filter((c) => c.personId === personId && canSeeChecklist(viewer, db, c))
  const running = lists.filter((c) => !c.completedOn).sort((a, b) => a.anchorDate.localeCompare(b.anchorDate))
  const done = lists.filter((c) => c.completedOn).sort((a, b) => (b.completedOn ?? '').localeCompare(a.completedOn ?? ''))
  const openTasks = running
    .flatMap((cl) => checklistStats(viewer, db, cl, t).tasks.filter((x) => x.status === 'open').map((task) => ({ checklist: cl, task })))
    .sort((a, b) => a.task.dueOn.localeCompare(b.task.dueOn) || Number(b.task.statutory) - Number(a.task.statutory))
    .slice(0, 8)

  if (!lists.length) {
    return (
      <Panel title="Checklists" icon="clipboard-check">
        <EmptyState
          compact
          icon="clipboard"
          title="No checklists yet"
          body="Hiring someone builds their onboarding checklist with every California date worked out. Offboarding and leave add their own."
        />
      </Panel>
    )
  }
  return (
    <Panel title="Checklists" icon="clipboard-check">
      <div className="flex flex-col gap-4">
        {running.length > 0 && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {running.map((c) => (
              <ChecklistCard key={c.id} checklist={c} />
            ))}
          </div>
        )}
        {openTasks.length > 0 && (
          <section aria-label="Open tasks, soonest first">
            <SectionLabel>Open tasks, soonest first</SectionLabel>
            <ul className="mt-1">
              {openTasks.map((r) => (
                <TaskRow key={r.task.id} checklist={r.checklist} task={r.task} />
              ))}
            </ul>
          </section>
        )}
        {done.length > 0 && (
          <div>
            <button
              type="button"
              aria-expanded={showDone}
              onClick={() => setShowDone((v) => !v)}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md text-[13.5px] font-semibold text-ink-2 hover:text-ink"
            >
              <Icon name={showDone ? 'chevron-up' : 'chevron-down'} size={15} />
              {showDone ? 'Hide' : 'Show'} completed checklists ({done.length})
            </button>
            {showDone && (
              <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
                {done.map((c) => (
                  <ChecklistCard key={c.id} checklist={c} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  )
}

/** Home: onboarding and offboarding in flight, with progress and Day 1 ready badges. */
export function ChecklistsInFlight() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const t = today()
  const rows = useMemo(() => {
    const out: Array<{ cl: Checklist; person: Person; s: ReturnType<typeof inFlightSummary> }> = []
    for (const cl of db.checklists) {
      if (cl.completedOn || (cl.kind !== 'onboarding' && cl.kind !== 'offboarding')) continue
      if (!canSeeChecklist(viewer, db, cl)) continue
      const person = getPerson(db, cl.personId)
      if (!person) continue
      const { tasks } = checklistStats(viewer, db, cl, t)
      if (!tasks.some((x) => x.status === 'open')) continue
      const s = inFlightSummary(cl, tasks, person.startDate, t)
      // Onboarding counts as in flight for its first six weeks, or while something is overdue;
      // a 90-day check-in months later is the inbox's job.
      const recent = cl.anchorDate >= addDays(t, -42)
      const overdue = tasks.some((x) => x.status === 'open' && x.dueOn < t)
      if (cl.kind === 'onboarding' && !recent && !overdue) continue
      out.push({ cl, person, s })
    }
    const rank = (r: (typeof out)[number]) => (r.s.statutoryOverdue ? 0 : r.s.incoming ? 1 : r.cl.kind === 'onboarding' ? 2 : 3)
    return out.sort((a, b) => rank(a) - rank(b) || a.cl.anchorDate.localeCompare(b.cl.anchorDate))
  }, [db, viewer, t])

  return (
    <Panel
      title="Onboarding and offboarding"
      icon="clipboard-check"
      actions={
        <a href={links.people('checklists')} className="inline-flex min-h-10 items-center gap-1 text-[13.5px] font-semibold text-accent hover:underline">
          All checklists <Icon name="arrow-right" size={14} />
        </a>
      }
      padded={false}
    >
      {rows.length === 0 ? (
        <div className="px-5">
          <EmptyState
            compact
            icon="clipboard-check"
            title="Nothing in flight"
            body="Hiring someone starts their onboarding checklist with every California date worked out."
          />
        </div>
      ) : (
        <ul>
          {rows.map(({ cl, person, s }) => (
            <li key={cl.id} className="border-b border-line last:border-b-0">
              <a href={links.checklist(cl.id)} className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-surface-2/60">
                <Avatar name={fullName(person)} size={32} muted={cl.kind === 'offboarding'} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <EmpNo n={person.hireNumber} />
                    <span className="font-semibold text-ink">
                      {person.preferredName || person.firstName}
                      {cl.kind === 'offboarding' ? ' (exit)' : ''}
                    </span>
                    {s.dayOneReady && s.incoming && (
                      <Badge tone="good" icon="check">
                        Day 1 ready
                      </Badge>
                    )}
                    {s.statutoryOverdue && (
                      // Wraps onto two lines instead of overflowing a narrow card (375px at 150% text).
                      <Badge tone="bad" icon="alert" className="h-auto! min-h-6 shrink! rounded-xl! py-1 leading-tight! whitespace-normal!">
                        Legal deadline overdue
                      </Badge>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[13.5px] text-ink-2">{s.text}</span>
                  <span className="mt-2 flex items-center gap-2">
                    <Meter
                      value={s.done}
                      max={Math.max(1, s.total)}
                      tone={s.statutoryOverdue ? 'bad' : 'accent'}
                      label={`${fullName(person)}: ${s.done} of ${s.total} done`}
                      className="max-w-[260px]"
                    />
                    <span className="sr-only">{CHECKLIST_KIND_LABEL[cl.kind]}</span>
                  </span>
                </span>
                <Icon name="chevron-right" size={18} className="mt-1 shrink-0 text-ink-3" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

