// One checklist: tasks grouped by phase (Before day 1, Day 1, Week 1, Month 1, Later; or by deadline
// for offboarding), each with a due date that explains itself, the weekend-aware file-by day for agency
// filings, the citation, a legal deadline badge (red only when overdue) and one-tap Done with Undo.
import { useState } from 'react'
import type { PageProps } from '@/app/routes'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { fullName, getPerson } from '@/domain/people'
import { fmtDate, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Badge, Callout, EmptyState, Meter, PageHeader, Panel, Segmented } from '@/ui'
import { canSeeChecklist, CHECKLIST_KIND_LABEL, checklistStats, dayLabel, groupByPhase, isMyTask } from './helpers'
import { SEPARATION_LABEL } from './OffboardSheet'
import { anchorText, EmpNo, NotLegalAdvice, TaskRow } from './parts'

type Show = 'all' | 'open' | 'mine'

export function ChecklistPage({ route }: PageProps) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [show, setShow] = useState<Show>('all')
  const t = today()
  const id = route.segments[1]
  const checklist = db.checklists.find((c) => c.id === id)

  if (!checklist) {
    return (
      <EmptyState
        icon="search"
        title="No checklist with that link"
        action={
          <a href={links.people('checklists')} className="inline-flex min-h-10 items-center font-bold text-accent underline">
            All checklists
          </a>
        }
      />
    )
  }
  const person = getPerson(db, checklist.personId)
  if (!canSeeChecklist(viewer, db, checklist)) {
    return (
      <EmptyState
        icon="lock"
        title="Not part of this view"
        body="Checklists are visible to Admin, the person themself and their manager line."
        action={
          <a href={links.people()} className="inline-flex min-h-10 items-center font-bold text-accent underline">
            Back to People
          </a>
        }
      />
    )
  }
  const { tasks, progress } = checklistStats(viewer, db, checklist, t)
  const name = person ? fullName(person) : 'Unknown person'
  const filtered = tasks.filter((x) => (show === 'open' ? x.status === 'open' : show === 'mine' ? isMyTask(viewer, db, checklist, x) : true))
  const groups = groupByPhase(checklist, filtered)
  const onboarding = checklist.kind === 'onboarding' || checklist.kind === 'new_state'
  const pre = tasks.filter((x) => x.status !== 'not_applicable' && x.dueOn < checklist.anchorDate)
  const preDone = pre.filter((x) => x.status === 'done').length
  const ready = onboarding && pre.length > 0 && preDone === pre.length
  const limited = checklist.kind === 'leave' && viewer.role !== 'admin' && viewer.personId !== checklist.personId
  const title = checklist.kind === 'leave' && limited ? `Leave for ${name}` : `${CHECKLIST_KIND_LABEL[checklist.kind]} for ${name}`

  return (
    <>
      <PageHeader
        back={person ? { href: links.person(person.id, 'checklists'), label: name } : { href: links.people('checklists'), label: 'Checklists' }}
        eyebrow={
          person ? (
            <span className="inline-flex items-center gap-2">
              <EmpNo n={person.hireNumber} />
              {person.title}
            </span>
          ) : undefined
        }
        title={title}
        subtitle={
          <>
            {anchorText(checklist)}
            {checklist.kind === 'offboarding' && checklist.separationType ? `, ${SEPARATION_LABEL[checklist.separationType].toLowerCase()}` : ''}
            {checklist.completedOn ? `. Completed ${fmtDate(checklist.completedOn)}.` : '.'}
          </>
        }
      />

      <Panel className="mb-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="num font-display text-[24px] font-bold text-ink">
                {progress.done} of {progress.total}
              </span>
              <span className="text-[14px] text-ink-3">done</span>
              {onboarding && ready && checklist.anchorDate >= t && (
                <Badge tone="good" icon="check">
                  Day 1 ready
                </Badge>
              )}
              {onboarding && !ready && pre.length > 0 && checklist.anchorDate > t && (
                <Badge tone="accent">
                  Pre-start {preDone} of {pre.length}
                </Badge>
              )}
              {progress.statutoryOverdue > 0 && (
                <Badge tone="bad" icon="alert">
                  {progress.statutoryOverdue} {progress.statutoryOverdue === 1 ? 'legal deadline' : 'legal deadlines'} overdue
                </Badge>
              )}
              {progress.overdue - progress.statutoryOverdue > 0 && (
                <Badge tone="warn" icon="clock">
                  {progress.overdue - progress.statutoryOverdue} overdue
                </Badge>
              )}
            </div>
            <Meter
              className="mt-2 max-w-[520px]"
              value={progress.done}
              max={Math.max(1, progress.total)}
              tone={progress.statutoryOverdue ? 'bad' : progress.open === 0 ? 'good' : 'accent'}
              label={`${progress.done} of ${progress.total} done`}
            />
            {progress.nextDue && (
              <p className="mt-2 text-[13.5px] text-ink-3">
                Next: <span className="text-ink-2">{progress.nextDue.title}</span>, {dayLabel(progress.nextDue.dueOn)}
              </p>
            )}
          </div>
          <Segmented
            label="Show tasks"
            value={show}
            onChange={setShow}
            options={[
              { value: 'all', label: 'All', count: tasks.length },
              { value: 'open', label: 'Open', count: progress.open },
              { value: 'mine', label: 'Mine', count: tasks.filter((x) => isMyTask(viewer, db, checklist, x)).length },
            ]}
          />
        </div>
        {limited && (
          <Callout tone="neutral" icon="lock" className="mt-4">
            Leave stays private: you see the manager tasks only, such as the coverage plan and the return-to-work check.
          </Callout>
        )}
      </Panel>

      {groups.length === 0 ? (
        <Panel>
          <EmptyState compact icon="clipboard-check" title={show === 'mine' ? 'Nothing here is yours to do' : 'Nothing open'} body="Switch to All to see every task." />
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => {
            const open = g.tasks.filter((x) => x.status === 'open').length
            const last = g.tasks[g.tasks.length - 1]
            return (
              <Panel
                key={g.key}
                title={g.label}
                subtitle={`${g.tasks.length - open} of ${g.tasks.length} done${last ? `, by ${dayLabel(last.dueOn)}` : ''}`}
              >
                <ul>
                  {g.tasks.map((task) => (
                    <TaskRow key={task.id} checklist={checklist} task={task} />
                  ))}
                </ul>
              </Panel>
            )
          })}
        </div>
      )}
      <p className="mt-4 text-[13px] text-ink-3">
        Business days skip weekends and company holidays. A legal deadline keeps its date. An agency filing such as the DE 34 new hire report that is
        due on a weekend or holiday also shows the business day before it to file by. Red marks only a legal deadline that has passed.
      </p>
      <NotLegalAdvice className="mt-1" />
    </>
  )
}
