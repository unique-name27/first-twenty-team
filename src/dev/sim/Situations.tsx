// The situations a run lives through: a list (each with what it did, or why the app skipped a step), a menu to
// add one, and a sheet to edit it with fields for its kind. People and departments come from the simulated
// company as of the last pause. Saving sends the whole list to the worker, which lives the days again from
// the last monthly point before the change when the change is in the past.
import { type ReactNode, useState } from 'react'
import type { ID } from '@/domain/types'
import { addDays, type ISODate } from '@/lib/dates'
import type { Situation, SituationInput, SituationKind } from '@/sim/situations'
import { Button, Checkbox, DateInput, Field, FormGrid, Menu, NumberInput, Panel, Segmented, Select, Sheet, Switch, TextInput } from '@/ui'
import { simulator, useSim } from './client'
import { ADDABLE_KINDS, fmtSimDay, KIND_LABELS, namesFrom, newSituation, situationProblems, situationSummary } from './helpers'
import type { DepartmentEntry, RosterEntry } from './protocol'

/** A situation being edited: the fields of one kind, loosely typed while the form changes them. */
type Draft = SituationInput & Record<string, unknown>

export function Situations({ locked, editing, onEdit }: { locked: boolean; editing: string | null; onEdit: (id: string | null) => void }) {
  const situations = useSim((s) => s.situations)
  const notes = useSim((s) => s.notes)
  const roster = useSim((s) => s.roster)
  const departments = useSim((s) => s.departments)
  const from = useSim((s) => s.from)
  const until = useSim((s) => s.run?.until ?? null)
  const date = useSim((s) => s.date)
  const [adding, setAdding] = useState<Draft | null>(null)
  if (!from || !until || !date) return null
  const names = namesFrom(roster, departments)
  const sorted = [...situations].sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0))
  const lastNote = (id: string) => notes.filter((n) => n.situationId === id).at(-1)
  // New situations default to the next simulated day (the day after the start at the latest).
  const nextDay = addDays(date, 1) > until ? until : addDays(date, 1)
  const open = editing ? situations.find((s) => s.id === editing) : undefined
  const remove = (id: string) => simulator.setSituations(situations.filter((s) => s.id !== id))
  const save = (draft: SituationInput) => {
    const exists = situations.some((s) => s.id === draft.id)
    simulator.setSituations(exists ? situations.map((s) => (s.id === draft.id ? (draft as Situation) : s)) : [...situations, draft as Situation])
    setAdding(null)
    onEdit(null)
  }
  return (
    <Panel
      title="Situations"
      subtitle="Things this run lives through. Each happens on the first business day on or after its date."
      actions={
        <Menu
          label="Add a situation"
          align="right"
          items={ADDABLE_KINDS.map((k) => ({ label: k.label, onSelect: () => setAdding(newSituation(k.kind, nextDay, situations, departments) as Draft), disabled: locked }))}
          trigger={(p) => (
            <Button size="sm" icon="plus" {...p} disabled={locked}>
              Add a situation
            </Button>
          )}
        />
      }
    >
      {sorted.length === 0 ? (
        <p className="text-[14px] text-ink-3">None yet. Add a hiring push, a freeze, someone quitting, a layoff, a leave, a raise round or a senior hire.</p>
      ) : (
        <ul className="flex flex-col">
          {sorted.map((s) => {
            const note = lastNote(s.id)
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2.5 last:border-b-0">
                <span className="num w-[6.5rem] shrink-0 text-[13px] font-semibold text-ink-2">{fmtSimDay(s.on).replace(/^\w+, /, '')}</span>
                <span className="min-w-0 flex-[1_1_14rem]">
                  <span className="block text-[14.5px] text-ink">{situationSummary(s, names)}</span>
                  {note && <span className={note.skipped ? 'block text-[13px] text-warn' : 'block text-[13px] text-ink-3'}>{note.skipped ? `Skipped: ${note.text}` : note.text}</span>}
                </span>
                <span className="ml-auto flex gap-1">
                  {s.kind !== 'pace' && (
                    <Button size="sm" variant="ghost" icon="edit" onClick={() => onEdit(s.id)} disabled={locked} aria-label={`Edit: ${situationSummary(s, names)}`}>
                      Edit
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => remove(s.id)} disabled={locked} aria-label={`Remove: ${situationSummary(s, names)}`}>
                    Remove
                  </Button>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {(adding || open) && (
        <SituationSheet
          key={(adding ?? open)?.id}
          initial={(adding ?? open) as Draft}
          isNew={!!adding}
          from={from}
          until={until}
          roster={roster}
          departments={departments}
          onSave={save}
          onClose={() => {
            setAdding(null)
            onEdit(null)
          }}
        />
      )}
    </Panel>
  )
}

function SituationSheet({
  initial,
  isNew,
  from,
  until,
  roster,
  departments,
  onSave,
  onClose,
}: {
  initial: Draft
  isNew: boolean
  from: ISODate
  until: ISODate
  roster: RosterEntry[]
  departments: DepartmentEntry[]
  onSave: (s: SituationInput) => void
  onClose: () => void
}) {
  const [d, setD] = useState<Draft>(initial)
  const [tried, setTried] = useState(false)
  const set = (patch: Record<string, unknown>) => setD((prev) => ({ ...prev, ...patch }) as Draft)
  const problems = { ...situationProblems(d, from, until), ...numberProblems(d) }
  const show = (field: string) => (tried ? problems[field] : undefined)
  const people = roster.filter((p) => !p.founder)
  const personOptions = [{ value: '', label: 'Someone at random' }, ...people.map((p) => ({ value: p.id, label: `${p.name}, ${p.title}` }))]
  const deptOptions = departments.map((x) => ({ value: x.id, label: x.name }))
  const submit = () => {
    setTried(true)
    if (Object.keys(problems).length === 0) onSave(clean(d))
  }
  const kind = d.kind as SituationKind
  return (
    <Sheet
      open
      onClose={onClose}
      title={`${isNew ? 'Add' : 'Edit'}: ${KIND_LABELS[kind]}`}
      subtitle="Saving lives the days again from the last month start before it, when it is in the past."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            {isNew ? 'Add to the run' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field label="Date" hint="Moves to the next business day when it falls on a weekend or holiday." error={show('on')} required>
          {(id, describedBy) => <DateInput id={id} aria-describedby={describedBy} value={d.on} min={addDays(from, 1)} max={until} onChange={(v) => set({ on: v })} />}
        </Field>
        {kind === 'hiringPush' && (
          <FormGrid>
            <Field label="Roles" error={show('roles')} required>
              {(id, describedBy) => <NumberInput id={id} aria-describedby={describedBy} min={1} max={10} step={1} value={d.roles as number} onChange={(v) => set({ roles: v })} />}
            </Field>
            <DepartmentField value={d.departmentId as ID | undefined} options={deptOptions} optional onChange={(v) => set({ departmentId: v })} />
          </FormGrid>
        )}
        {kind === 'growTo' && (
          <>
            <FormGrid>
              <Field label="Headcount to reach" error={show('headcount')} required>
                {(id, describedBy) => <NumberInput id={id} aria-describedby={describedBy} min={2} max={60} step={1} value={d.headcount as number} onChange={(v) => set({ headcount: v })} />}
              </Field>
              <Field label="By" error={show('by')} required>
                {(id, describedBy) => <DateInput id={id} aria-describedby={describedBy} value={d.by as string} onChange={(v) => set({ by: v })} />}
              </Field>
            </FormGrid>
            <DepartmentField value={d.departmentId as ID | undefined} options={deptOptions} optional onChange={(v) => set({ departmentId: v })} />
          </>
        )}
        {kind === 'freeze' && (
          <>
            <Field label="Until" hint="No roles planned or opened and no backfills through this day." error={show('until')} required>
              {(id, describedBy) => <DateInput id={id} aria-describedby={describedBy} value={d.until as string} onChange={(v) => set({ until: v })} />}
            </Field>
            <Switch checked={!!d.holdOpenJobs} onChange={(v) => set({ holdOpenJobs: v })} label="Put open jobs on hold" description="They go back up the business day after the freeze ends." />
          </>
        )}
        {kind === 'quit' && (
          <>
            <PersonField value={(d.personId as string | null) ?? ''} options={personOptions} onChange={(v) => set({ personId: v || null })} />
            <Labeled label="Notice">
              <Segmented<'two_weeks' | 'none'>
                label="Notice"
                value={d.notice as 'two_weeks' | 'none'}
                onChange={(v) => set({ notice: v })}
                options={[
                  { value: 'two_weeks', label: 'Two weeks' },
                  { value: 'none', label: 'Last day today' },
                ]}
              />
            </Labeled>
            <Switch checked={!!d.backfill} onChange={(v) => set({ backfill: v })} label="Backfill" description="Opens a job for their role the same day." />
          </>
        )}
        {kind === 'layoff' && <LayoffFields d={d} set={set} show={show} people={people} deptOptions={deptOptions} />}
        {kind === 'leave' && (
          <>
            <PersonField value={(d.personId as string | null) ?? ''} options={personOptions} onChange={(v) => set({ personId: v || null })} />
            <Labeled label="Kind of leave">
              <Segmented<'bonding' | 'cfra' | 'other'>
                label="Kind of leave"
                value={d.leaveKind as 'bonding' | 'cfra' | 'other'}
                onChange={(v) => set({ leaveKind: v })}
                options={[
                  { value: 'bonding', label: 'Bonding' },
                  { value: 'cfra', label: 'CFRA' },
                  { value: 'other', label: 'Other' },
                ]}
              />
            </Labeled>
            <Field label="Weeks" hint="Someone who does not qualify gets a note in the feed instead." error={show('weeks')} required>
              {(id, describedBy) => <NumberInput id={id} aria-describedby={describedBy} min={1} max={26} step={1} value={d.weeks as number} onChange={(v) => set({ weeks: v })} />}
            </Field>
          </>
        )}
        {kind === 'raiseRound' && (
          <>
            <Field label="Raise" error={show('percent')} required>
              {(id, describedBy) => <NumberInput id={id} aria-describedby={describedBy} min={0.1} max={50} step={0.5} suffix="%" sensitive={false} value={d.percent as number} onChange={(v) => set({ percent: v })} />}
            </Field>
            <Labeled label="Effective">
              <Segmented<'next_pay_period' | 'on_the_day'>
                label="Effective"
                value={d.effective as 'next_pay_period' | 'on_the_day'}
                onChange={(v) => set({ effective: v })}
                options={[
                  { value: 'next_pay_period', label: 'Next pay period' },
                  { value: 'on_the_day', label: 'On the day' },
                ]}
              />
            </Labeled>
            <Switch checked={!!d.respectBands} onChange={(v) => set({ respectBands: v })} label="Stay within bands" description="A raise that would leave its band is held and counted." />
            <Switch checked={!!d.includeFounder} onChange={(v) => set({ includeFounder: v })} label="Include the founder" />
          </>
        )}
        {kind === 'leaderHire' && (
          <>
            <DepartmentField value={d.departmentId as ID} options={deptOptions} onChange={(v) => set({ departmentId: v ?? departments[0]?.id })} />
            <Labeled label="Level">
              <Segmented<'lv-m2' | 'lv-x1'>
                label="Level"
                value={d.levelId as 'lv-m2' | 'lv-x1'}
                onChange={(v) => set({ levelId: v })}
                options={[
                  { value: 'lv-m2', label: 'Head of (M2)' },
                  { value: 'lv-x1', label: 'Executive (X1)' },
                ]}
              />
            </Labeled>
            <Field label="Title" hint="Left blank, the title comes from the department's role template.">
              {(id, describedBy) => <TextInput id={id} aria-describedby={describedBy} value={(d.title as string | undefined) ?? ''} onChange={(e) => set({ title: e.target.value || undefined })} />}
            </Field>
            <Labeled label="Who moves under them">
              <Segmented<'department' | 'picked'>
                label="Who moves under them"
                value={d.reports === 'department' ? 'department' : 'picked'}
                onChange={(v) => set({ reports: v === 'department' ? 'department' : [] })}
                options={[
                  { value: 'department', label: 'The department' },
                  { value: 'picked', label: 'People I pick' },
                ]}
              />
            </Labeled>
            {Array.isArray(d.reports) && (
              <PeoplePicker label="People who move under the leader" people={people} picked={d.reports as string[]} onChange={(ids) => set({ reports: ids })} error={show('reports')} />
            )}
          </>
        )}
        {/* Enter in a field saves, as in the app's other sheets. */}
        <button type="submit" hidden />
      </form>
    </Sheet>
  )
}

function LayoffFields({
  d,
  set,
  show,
  people,
  deptOptions,
}: {
  d: Draft
  set: (patch: Record<string, unknown>) => void
  show: (field: string) => string | undefined
  people: RosterEntry[]
  deptOptions: Array<{ value: string; label: string }>
}) {
  const mode: 'count' | 'department' | 'people' = d.personIds ? 'people' : d.departmentId ? 'department' : 'count'
  return (
    <>
      <Labeled label="Who">
        <Segmented<'count' | 'department' | 'people'>
          label="Who"
          value={mode}
          onChange={(v) => set({ count: v === 'count' ? 2 : undefined, departmentId: v === 'department' ? deptOptions[0]?.value : undefined, personIds: v === 'people' ? [] : undefined })}
          options={[
            { value: 'count', label: 'At random' },
            { value: 'department', label: 'A department' },
            { value: 'people', label: 'People I pick' },
          ]}
        />
      </Labeled>
      {mode === 'count' && (
        <Field label="How many" hint="Never the founder." error={show('count')} required>
          {(id, describedBy) => <NumberInput id={id} aria-describedby={describedBy} min={1} step={1} value={d.count as number} onChange={(v) => set({ count: v })} />}
        </Field>
      )}
      {mode === 'department' && <DepartmentField value={d.departmentId as ID} options={deptOptions} onChange={(v) => set({ departmentId: v ?? deptOptions[0]?.value })} />}
      {mode === 'people' && <PeoplePicker label="People laid off" people={people} picked={(d.personIds as string[]) ?? []} onChange={(ids) => set({ personIds: ids })} error={show('personIds')} />}
      <FormGrid>
        <Field label="Days of notice" hint="0: the last day is the same day." error={show('noticeDays')}>
          {(id, describedBy) => <NumberInput id={id} aria-describedby={describedBy} min={0} max={90} step={1} value={d.noticeDays as number} onChange={(v) => set({ noticeDays: v })} />}
        </Field>
        <Field label="Freeze after, in days" hint="0: no freeze." error={show('freezeDays')}>
          {(id, describedBy) => <NumberInput id={id} aria-describedby={describedBy} min={0} max={365} step={1} value={d.freezeDays as number} onChange={(v) => set({ freezeDays: v })} />}
        </Field>
      </FormGrid>
      <Switch checked={!!d.closeJobs} onChange={(v) => set({ closeJobs: v })} label="Close the open jobs" description="The department's jobs, or every open job for people at random or picked." />
    </>
  )
}

/** A visible name over a control that carries the same name for screen readers (Segmented's radiogroup). */
function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span aria-hidden className="ft-field__label text-[13.5px] font-semibold text-ink-2">
        {label}
      </span>
      {children}
    </div>
  )
}

function PersonField({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void }) {
  return <Field label="Who">{(id, describedBy) => <Select id={id} aria-describedby={describedBy} value={value} options={options} onChange={onChange} />}</Field>
}

function DepartmentField({ value, options, optional, onChange }: { value: ID | undefined; options: Array<{ value: string; label: string }>; optional?: boolean; onChange: (v: ID | undefined) => void }) {
  return (
    <Field label="Department" required={!optional}>
      {(id, describedBy) => (
        <Select id={id} aria-describedby={describedBy} value={value ?? ''} options={optional ? [{ value: '', label: 'Any department' }, ...options] : options} onChange={(v) => onChange(v || undefined)} />
      )}
    </Field>
  )
}

function PeoplePicker({ label, people, picked, onChange, error }: { label: string; people: RosterEntry[]; picked: string[]; onChange: (ids: string[]) => void; error?: string }) {
  return (
    <fieldset className="min-w-0">
      <legend className="ft-field__label text-[13.5px] font-semibold text-ink-2">{label}</legend>
      {error && <p className="ft-field__error mt-1 text-[12.5px] font-semibold text-bad">{error}</p>}
      <div className="mt-1 max-h-64 overflow-y-auto">
        {people.map((p) => (
          <Checkbox
            key={p.id}
            checked={picked.includes(p.id)}
            onChange={(on) => onChange(on ? [...picked, p.id] : picked.filter((x) => x !== p.id))}
            label={p.name}
            description={p.title}
          />
        ))}
      </div>
    </fieldset>
  )
}

/** Numbers the form left empty. */
function numberProblems(d: Draft): Record<string, string> {
  const out: Record<string, string> = {}
  const need: Partial<Record<SituationKind, string[]>> = {
    hiringPush: ['roles'],
    growTo: ['headcount'],
    leave: ['weeks'],
    raiseRound: ['percent'],
    layoff: ['noticeDays', 'freezeDays', ...(d.count !== undefined || (!d.personIds && !d.departmentId) ? ['count'] : [])],
  }
  for (const field of need[d.kind as SituationKind] ?? []) if (typeof d[field] !== 'number' || Number.isNaN(d[field])) out[field] = 'Enter a number.'
  if (d.kind === 'leaderHire' && Array.isArray(d.reports) && d.reports.length === 0) out.reports = 'Pick at least one person.'
  return out
}

/** The draft as the worker reads it: optional fields that are empty are left out. */
function clean(d: Draft): SituationInput {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d)) if (v !== undefined) out[k] = v
  return out as SituationInput
}
