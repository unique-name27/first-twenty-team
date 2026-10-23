// Training tracker: people by course, status words with color, one-tap Done today (optional
// certificate link), the California-only harassment requirement explained, and CRD's free course.
import { useMemo, useState } from 'react'
import { links } from '@/app/router'
import { evaluateRule, RULE_BY_ID } from '@/domain/compliance'
import { fullName } from '@/domain/people'
import { CRD_COURSE_URL, isStatutoryTraining, TRAINING_LABELS, type TrainingCourse, trainingMatrix, type TrainingRow } from '@/domain/trainings'
import type { ID, Person } from '@/domain/types'
import { fmtDate, fmtShort, today } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { Avatar, Badge, Button, Callout, CitationChip, cx, Icon, Modal, Panel, Sheet, TextLink } from '@/ui'
import { LegalNote, TrainingDoneControl } from './bits'
import { trainingCell, trainingTodo } from './helpers'
import { PersonTrainingPanel } from './panels'

type Cell = { person: Person; row: TrainingRow }

export function TrainingTab() {
  const db = useDB((s) => s.db)
  const t = today()
  const m = useMemo(() => trainingMatrix(db, t), [db, t])
  const [cellFor, setCellFor] = useState<{ personId: ID; course: TrainingCourse } | null>(null)
  const [personFor, setPersonFor] = useState<ID | null>(null)
  const all: Cell[] = m.rows.flatMap((r) => m.courses.map((c) => ({ person: r.person, row: r.cells[c.course] })))
  const todo = trainingTodo(all)
  const overdue = all.filter((c) => c.row.required && c.row.status === 'overdue').length
  // Red only for a legal deadline; a missed company target (security awareness, the first WVPP round) stays ink.
  const overdueLegal = all.some((c) => c.row.required && c.row.status === 'overdue' && isStatutoryTraining(c.row))
  const dueSoon = all.filter((c) => c.row.required && c.row.status === 'due' && !!c.row.dueOn).length
  const waitingPlan = all.filter((c) => c.row.course === 'wvpp' && c.row.required && !c.row.dueOn && c.row.status !== 'done').length
  const harassment = RULE_BY_ID['harassment-training']
  const wvpp = evaluateRule(db, RULE_BY_ID.wvpp, t)
  const selected = cellFor ? all.find((c) => c.person.id === cellFor.personId && c.row.course === cellFor.course) : undefined

  return (
    <div data-focus-scope className="flex flex-col gap-5">
      {/* Where focus lands when Done today empties the to-do list (keepFocusAfter): the counts, read aloud. */}
      <p data-focus-fallback className="text-[15px] text-ink">
        <span className={cx('font-bold', overdueLegal ? 'text-bad' : 'text-ink')}>{plural(overdue, 'overdue course')}</span>, {dueSoon} due in the next 30 days
        {waitingPlan ? `, ${plural(waitingPlan, 'person', 'people')} waiting on the workplace violence prevention plan` : ''}.
      </p>

      {todo.length > 0 && (
        <Panel title="To do now" icon="clipboard-check" padded={false} subtitle="One tap records today's date. Add the certificate link if you have it.">
          <ul className="divide-y divide-line">
            {todo.map((c) => {
              const cell = trainingCell(c.row, t)
              return (
                <li key={`${c.person.id}-${c.row.course}`} className="flex flex-col gap-3 px-5 py-3.5 md:flex-row md:items-start">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <Avatar name={fullName(c.person)} size={36} />
                    <div className="min-w-0">
                      <p className="text-[15px] font-semibold text-ink">
                        {fullName(c.person)}: {TRAINING_LABELS[c.row.kind]}
                      </p>
                      <p className="text-[13.5px] text-ink-3">{c.row.reason}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        <Badge tone={cell.tone}>{cell.label}</Badge>
                        {cell.detail && <Badge tone="neutral">{cell.detail}</Badge>}
                      </div>
                    </div>
                  </div>
                  <TrainingDoneControl db={db} personId={c.person.id} kind={c.row.kind} focusKey={`train-${c.person.id}-${c.row.course}`} />
                </li>
              )
            })}
          </ul>
        </Panel>
      )}

      {/* Measured on the page area, not the viewport, so text zoom and the rail both count. */}
      <div className="@container">
        <div className="grid grid-cols-1 gap-4 @[800px]:grid-cols-2">
          <Callout tone="accent" icon="scale" title="Harassment prevention: California staff only">
            <p>
              Once you have 5 or more employees and contractors (counted in every state), California requires training for everyone based in
              California: 1 hour for staff and 2 hours for supervisors, within 6 months of hire or of becoming a supervisor, then every 2 years.
              People outside California see it as recommended. Keep certificates at least 2 years.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CitationChip label={harassment.citation.label} url={harassment.citation.url} />
              <a
                href={CRD_COURSE_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex h-11 items-center gap-1.5 rounded-lg px-2 text-[14px] font-semibold text-accent hover:bg-surface"
              >
                Open CRD's free online course
                <Icon name="external" size={13} />
              </a>
            </div>
            <LegalNote reviewedOn={harassment.lastReviewedOn} className="mt-1" />
          </Callout>
          {wvpp.state === 'applies' && waitingPlan > 0 ? (
            <Callout tone="warn" title="Workplace violence prevention training starts with the plan">
              <p>
                SB 553 applies at your office, and no plan is on file yet. Write the plan first: everyone who works on site trains when the plan
                is established (new staff when they start), then every year. The law sets no day count for that first round; once the plan is on
                file, this tracker sets a 30-day company target. The yearly refresher is required.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <CitationChip label={wvpp.rule.citation.label} url={wvpp.rule.citation.url} />
                <TextLink href={links.rule('wvpp')}>Open the SB 553 card</TextLink>
              </div>
            </Callout>
          ) : (
            <Callout tone="neutral" icon="shield" title="Security awareness is a company control">
              <p>Within 30 days of starting, then every year. It is SOC 2 evidence, not a legal requirement, so overdue rows stay amber.</p>
            </Callout>
          )}
        </div>
      </div>

      <Panel title="Everyone" subtitle="Tap a cell to mark it done or add a certificate link. Tap a name for that person's courses." padded={false}>
        <div className="scroll-thin relative overflow-x-auto">
          <table className="ft-matrix w-full min-w-[680px] border-collapse text-left text-[14px]">
            <caption className="sr-only">Training status by person and course</caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="h-10 bg-surface-2/60 px-4 text-[12.5px] font-bold text-ink-3">
                  Person
                </th>
                {m.courses.map((c) => (
                  <th key={c.course} scope="col" className="h-10 bg-surface-2/60 px-3 text-[12.5px] font-bold text-ink-3">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.rows.map((r) => {
                const starting = r.person.startDate > t
                return (
                  <tr key={r.person.id} className="border-b border-line last:border-b-0">
                    <th scope="row" className="px-4 py-2 align-middle font-normal">
                      <button
                        type="button"
                        onClick={() => setPersonFor(r.person.id)}
                        className="flex min-h-11 items-center gap-2.5 rounded-lg text-left hover:text-accent"
                      >
                        <Avatar name={fullName(r.person)} size={30} />
                        <span className="min-w-0">
                          <span className="block font-semibold text-ink">{fullName(r.person)}</span>
                          <span className="block text-[12.5px] text-ink-3">
                            {starting ? `Starts ${fmtShort(r.person.startDate)}` : r.person.homeState !== 'CA' ? `Works in ${r.person.homeState}` : r.person.title}
                          </span>
                        </span>
                      </button>
                    </th>
                    {m.courses.map((c) => {
                      const row = r.cells[c.course]
                      const cell = trainingCell(row, t)
                      return (
                        <td key={c.course} className="px-2 py-1.5 align-middle">
                          <button
                            type="button"
                            onClick={() => setCellFor({ personId: r.person.id, course: c.course })}
                            aria-label={`${fullName(r.person)}, ${c.label}: ${cell.label}${cell.detail ? `, ${cell.detail}` : ''}`}
                            className="flex min-h-12 w-full flex-col items-start justify-center gap-0.5 rounded-lg px-2 py-1 text-left hover:bg-surface-2"
                          >
                            <Badge tone={cell.tone}>{cell.label}</Badge>
                            {cell.detail && <span className="pl-1 text-[12px] text-ink-3">{cell.detail}</span>}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {selected && <TrainingCellModal cell={selected} onClose={() => setCellFor(null)} />}
      <Sheet
        open={!!personFor}
        onClose={() => setPersonFor(null)}
        title={personFor ? fullName(db.people.find((p) => p.id === personFor) as Person) : 'Training'}
      >
        {personFor && (
          <div className="flex flex-col gap-3">
            <PersonTrainingPanel personId={personFor} />
            <TextLink href={links.person(personFor)}>Open the full profile</TextLink>
          </div>
        )}
      </Sheet>
    </div>
  )
}

function TrainingCellModal({ cell, onClose }: { cell: Cell; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const { person, row } = cell
  const state = trainingCell(row, today())
  const canMark = row.required || row.recommended
  return (
    <Modal open onClose={onClose} title={`${fullName(person)}: ${TRAINING_LABELS[row.kind]}`}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={state.tone}>{state.label}</Badge>
          {state.detail && <Badge tone="neutral">{state.detail}</Badge>}
        </div>
        <p className="text-[14px] text-ink-2">{row.reason}</p>
        <ul className="flex flex-col gap-1 text-[14px] text-ink-2">
          {row.dueOn && <li>{row.completedOn ? 'Next due' : row.required ? 'Due' : 'Suggested by'} {fmtDate(row.dueOn)}.</li>}
          {row.completedOn && <li>Last completed {fmtDate(row.completedOn)}.</li>}
        </ul>
        <div className="flex flex-wrap gap-x-4">
          {row.certificateLink && (
            <a href={row.certificateLink} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-11 items-center gap-1 text-[14px] font-semibold text-accent">
              <Icon name="file" size={15} />
              Certificate on file
              <Icon name="external" size={12} />
            </a>
          )}
          {row.link && (
            <a href={row.link} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-11 items-center gap-1 text-[14px] font-semibold text-accent">
              {row.course === 'harassment' ? "CRD's free course" : 'Open the course'}
              <Icon name="external" size={12} />
            </a>
          )}
        </div>
        {canMark ? (
          <TrainingDoneControl
            db={db}
            personId={person.id}
            kind={row.kind}
            size="lg"
            label={row.status === 'done' ? 'Record another completion today' : 'Done today'}
            onDone={onClose}
          />
        ) : (
          <p className="text-[13.5px] text-ink-3">Nothing to record for this course right now.</p>
        )}
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  )
}
