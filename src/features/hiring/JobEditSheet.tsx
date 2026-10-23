// Edit a job (#job.<id>.edit): basics, team, employment type, pay range, stages and SLAs (Recruiter
// screen optional), panel, interview plan, sponsorship, background check and the credit check (off by
// default; turning it on needs a Labor Code 1024.5 basis and shows the written-notice rule). Saves in
// one undoable change, writing only the fields changed here: a change another computer made while the
// sheet was open survives, and one that touches the same field asks first (EditConflict.tsx). The
// description is capped and the whole job must fit one sync record. Picking Remote with only an office
// as the location swaps in the workspace's remote location, as in the New job sheet.
import { useState } from 'react'
import { CREDIT_CHECK_BASES, creditCheckNoticeTask, effectiveBand, jobStages, mondayOnOrAfter, setCreditCheckBasis } from '@/domain/hiring'
import { personNameById } from '@/domain/people'
import type { Attribute, ID, InterviewStep, Job, JobStage } from '@/domain/types'
import { addDays, fmtDate, today } from '@/lib/dates'
import { moneyRange } from '@/lib/format'
import { newId } from '@/lib/id'
import { logActivity, useDB } from '@/store/db'
import {
  Button,
  Callout,
  ChipGroup,
  ChipMulti,
  CitationChip,
  DateChips,
  Field,
  focusFirstInvalid,
  FormGrid,
  IconButton,
  MoneyInput,
  NumberInput,
  Private,
  SectionLabel,
  Segmented,
  Select,
  Sheet,
  Switch,
  TextArea,
  TextInput,
  toast,
} from '@/ui'
import { commit } from './actions'
import { EditConflictCallout, focusEditConflict, useEditConflicts } from './EditConflict'
import {
  JOB_DESC_MAX_CHARS,
  jobDescCountText,
  jobSizeError,
  moveStage,
  officeOnly,
  payTooHighError,
  remoteLocationsFor,
  stageRemovalBlock,
  teamOptions,
  withCustomStage,
  withRecruiterScreen,
} from './logic'
import { EMPLOYMENT_OPTIONS, NotLegalAdvice } from './parts'

type Draft = Pick<
  Job,
  | 'title'
  | 'departmentId'
  | 'hiringManagerId'
  | 'panelIds'
  | 'locationIds'
  | 'workMode'
  | 'employmentType'
  | 'payMin'
  | 'payMax'
  | 'stages'
  | 'interviewPlan'
  | 'sponsorship'
  | 'backgroundCheck'
  | 'description'
  | 'priority'
> & { targetStart: string | null; creditOn: boolean; creditBasis: string | null }

function toDraft(job: Job): Draft {
  return {
    title: job.title,
    departmentId: job.departmentId,
    hiringManagerId: job.hiringManagerId,
    panelIds: [...job.panelIds],
    locationIds: [...job.locationIds],
    workMode: job.workMode,
    employmentType: job.employmentType,
    payMin: job.payMin,
    payMax: job.payMax,
    stages: jobStages(job).map((s) => ({ ...s })),
    interviewPlan: job.interviewPlan.map((s) => ({ ...s, interviewerIds: [...s.interviewerIds], attributes: s.attributes.map((a) => ({ ...a })) })),
    sponsorship: job.sponsorship,
    backgroundCheck: job.backgroundCheck,
    description: job.description,
    priority: job.priority,
    targetStart: job.targetStart ?? null,
    creditOn: !!job.creditCheckBasis,
    creditBasis: job.creditCheckBasis ?? null,
  }
}

export function JobEditSheet({ job, open, onClose }: { job: Job; open: boolean; onClose: () => void }) {
  if (!open) return null
  return <JobEditInner key={job.id} job={job} onClose={onClose} />
}

/** How a conflicting field reads in the 'changed on another computer' callout. */
const FIELD_WORDS: Record<keyof Draft, string> = {
  title: 'the title',
  departmentId: 'the team',
  hiringManagerId: 'the hiring manager',
  panelIds: 'the interview panel',
  locationIds: 'the locations',
  workMode: 'the work mode',
  employmentType: 'the employment type',
  payMin: 'the pay range',
  payMax: 'the pay range',
  stages: 'the stages',
  interviewPlan: 'the interview plan',
  sponsorship: 'visa sponsorship',
  backgroundCheck: 'the background check',
  description: 'the job description',
  priority: 'the priority',
  targetStart: 'the target start',
  creditOn: 'the credit check',
  creditBasis: 'the credit check',
}

function JobEditInner({ job: opened, onClose }: { job: Job; onClose: () => void }) {
  const db = useDB((s) => s.db)
  // The job as stored now (a pull may bring in another computer's change while the sheet is open).
  const job = db.jobs.find((x) => x.id === opened.id) ?? opened
  const current = toDraft(job)
  const edit = useEditConflicts(current)
  const [d, setD] = useState<Draft>(() => edit.base)
  const [newAttr, setNewAttr] = useState<Record<string, string>>({})
  const [tried, setTried] = useState(false)
  // The remote location picked when Work mode became Remote (said under Locations).
  const [swappedTo, setSwappedTo] = useState<string | null>(null)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }))
  const setWorkMode = (mode: Job['workMode']) => {
    const remote = mode === 'remote' ? remoteLocationsFor(db.locations, d.locationIds) : undefined
    setD((x) => ({ ...x, workMode: mode, ...(remote ? { locationIds: remote } : {}) }))
    setSwappedTo(remote ? remote.map((id) => db.locations.find((l) => l.id === id)?.name ?? '').join(', ') : null)
  }
  const t = today()
  const team = teamOptions(db, t)
  const band = effectiveBand(db, job.familyId, job.levelId)
  const minHigh = payTooHighError(d.payMin, 'annual')
  const maxHigh = payTooHighError(d.payMax, 'annual')
  const errors: string[] = []
  if (!d.title.trim()) errors.push('Add a title.')
  if (!d.hiringManagerId) errors.push('Pick a hiring manager.')
  if (minHigh || maxHigh) errors.push('A pay range amount looks too high. Check the number.')
  if (d.payMin != null && d.payMax != null && d.payMin > d.payMax) errors.push('The pay range minimum is above the maximum.')
  if (d.creditOn && !d.creditBasis) errors.push('Pick a Labor Code 1024.5 basis or turn the credit check off.')
  if (d.stages.some((s) => !s.name.trim())) errors.push('Every stage needs a name.')
  // The job as it would be stored: the description cap applies once it is edited, the sync record size always.
  const { creditOn: _creditOn, creditBasis: _creditBasis, targetStart: _targetStart, ...stored } = d
  const sizeError = jobSizeError({ ...job, ...stored }, { descriptionChanged: d.description !== edit.base.description })
  if (sizeError) errors.push(sizeError)
  const descCount = jobDescCountText(d.description)
  const noRange = d.payMin == null || d.payMax == null
  const remoteOnOffice = d.workMode === 'remote' && officeOnly(db.locations, d.locationIds)
  const locationNote =
    swappedTo && !remoteOnOffice
      ? `Picked ${swappedTo} for a remote job. Add an office back if people also work there.`
      : !remoteOnOffice
        ? null
        : db.locations.some((l) => l.kind === 'remote')
          ? 'The posting and the offer letter use these locations. Pick a remote one unless people report to the office.'
          : 'The posting and the offer letter use these locations, so a remote job would quote the office. Add a remote location in Settings > Org.'
  // Shown on the fields after a failed save, so focusFirstInvalid() lands on the first one to fix.
  const err = {
    title: tried && !d.title.trim() ? 'Add a title.' : undefined,
    hm: tried && !d.hiringManagerId ? 'Pick a hiring manager.' : undefined,
    min: tried ? minHigh : undefined,
    range: tried ? (maxHigh ?? (d.payMin != null && d.payMax != null && d.payMin > d.payMax ? 'The minimum is above the maximum.' : undefined)) : undefined,
    credit: tried && d.creditOn && !d.creditBasis,
    desc: tried ? sizeError : undefined,
  }
  const conflicts = edit.conflicts(d)
  const conflictLines = [
    ...new Set(
      conflicts.map((k) =>
        k === 'title' ? `the title is now "${current.title}"` : k === 'hiringManagerId' ? `the hiring manager is now ${personNameById(db, current.hiringManagerId)}` : `${FIELD_WORDS[k]} changed`,
      ),
    ),
  ]

  const save = () => {
    if (errors.length) {
      setTried(true)
      toast({ text: errors[0], tone: 'bad' })
      focusFirstInvalid()
      return
    }
    if (conflicts.length) {
      toast({ text: 'This job changed on another computer. Pick Use theirs or Keep mine first.', tone: 'neutral' })
      focusEditConflict()
      return
    }
    const changed = edit.changed(d)
    if (changed.length === 0) {
      toast({ text: 'No changes to save.', tone: 'neutral' })
      onClose()
      return
    }
    const basis = d.creditOn ? d.creditBasis : null
    const ok = commit(`Updated the ${d.title.trim()} job`, (draft) => {
      const j = draft.jobs.find((x) => x.id === job.id)
      if (!j) return false
      // Only the fields changed in this sheet: anything else keeps what is stored now.
      const target = j as unknown as Record<string, unknown>
      for (const k of changed) {
        if (k === 'title') j.title = d.title.trim()
        else if (k === 'stages') j.stages = d.stages.map((s) => ({ ...s, name: s.name.trim() }))
        else if (k === 'targetStart') {
          if (d.targetStart) j.targetStart = d.targetStart
          else delete j.targetStart
        } else if (k !== 'creditOn' && k !== 'creditBasis') target[k] = d[k]
      }
      if ((changed.includes('creditOn') || changed.includes('creditBasis')) && (j.creditCheckBasis ?? null) !== basis) {
        const r = setCreditCheckBasis(draft, job.id, basis, { date: t })
        if (!r.ok) return false
      }
      logActivity(draft, { entityType: 'job', entityId: job.id, kind: 'job_updated', text: `Edited the ${j.title} job` })
    })
    if (!ok) toast({ text: 'No changes to save.', tone: 'neutral' })
    onClose()
  }

  // ---- stages ----
  const setStage = (id: string, patch: Partial<JobStage>) => set('stages', d.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  const removeStage = (id: string) => {
    const i = d.stages.findIndex((s) => s.id === id)
    const stages = d.stages.filter((s) => s.id !== id)
    const fallback = stages[Math.max(0, i - 1)]?.id ?? stages[0]?.id
    setD((x) => ({ ...x, stages, interviewPlan: x.interviewPlan.map((p) => (p.stageId === id ? { ...p, stageId: fallback } : p)) }))
  }
  const interviewStages = d.stages.filter((s) => s.kind !== 'new' && s.kind !== 'offer' && s.kind !== 'hired')

  // ---- interview plan ----
  const setStep = (id: ID, patch: Partial<InterviewStep>) => set('interviewPlan', d.interviewPlan.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  const addStep = () =>
    set('interviewPlan', [
      ...d.interviewPlan,
      { id: newId('step'), stageId: interviewStages[0]?.id ?? 'intro', name: 'New interview', durationMin: 45, interviewerIds: [d.hiringManagerId], attributes: [] },
    ])
  const addAttr = (step: InterviewStep) => {
    const name = (newAttr[step.id] ?? '').trim()
    if (!name || step.attributes.some((a) => a.name === name)) return
    setStep(step.id, { attributes: [...step.attributes, { name } as Attribute] })
    setNewAttr((m) => ({ ...m, [step.id]: '' }))
  }
  const interviewerOptions = team.filter((p) => d.panelIds.includes(p.value) || d.interviewPlan.some((s) => s.interviewerIds.includes(p.value)) || p.value === d.hiringManagerId)

  const notice = creditCheckNoticeTask({ title: d.title, creditCheckBasis: d.creditBasis })

  return (
    <Sheet
      open
      onClose={onClose}
      title={`Edit ${job.title}`}
      subtitle="Changes save together. You can undo them."
      width={720}
      footer={
        <>
          {errors.length > 0 && <span className="mr-auto text-[13px] font-semibold text-bad">{errors[0]}</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <EditConflictCallout
          what="job"
          lines={conflictLines}
          onTheirs={() => edit.takeTheirs(conflicts, setD)}
          onMine={() => edit.keepMine(conflicts)}
        />
        <section className="flex flex-col gap-4">
          <SectionLabel>Basics</SectionLabel>
          <Field label="Title" required id="je-title" error={err.title}>
            {(id, hint) => <TextInput id={id} aria-describedby={hint} value={d.title} onChange={(e) => set('title', e.target.value)} />}
          </Field>
          <FormGrid>
            <Field label="Hiring manager" id="je-hm" error={err.hm}>
              {(id, hint) => <Select id={id} aria-describedby={hint} value={d.hiringManagerId} onChange={(v) => set('hiringManagerId', v)} options={team} placeholder={d.hiringManagerId ? undefined : 'Pick a hiring manager'} />}
            </Field>
            <Field label="Team" id="je-team" hint="Hires from this job join this team.">
              {(id, hint) => <Select id={id} aria-describedby={hint} value={d.departmentId} onChange={(v) => set('departmentId', v)} options={db.departments.map((x) => ({ value: x.id, label: x.name }))} />}
            </Field>
          </FormGrid>
          <FormGrid>
            <div>
              <p className="mb-1.5 text-[13.5px] font-semibold text-ink-2">Employment</p>
              <ChipGroup label="Employment" value={d.employmentType} onChange={(v) => set('employmentType', v)} options={EMPLOYMENT_OPTIONS} />
            </div>
            <div>
              <p className="mb-1.5 text-[13.5px] font-semibold text-ink-2">Priority</p>
              <Segmented label="Priority" value={d.priority} onChange={(v) => set('priority', v)} options={[{ value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }]} />
            </div>
          </FormGrid>
          <div>
            <p className="mb-1.5 text-[13.5px] font-semibold text-ink-2">Work mode</p>
            <Segmented
              label="Work mode"
              value={d.workMode}
              onChange={setWorkMode}
              options={[
                { value: 'onsite', label: 'On site' },
                { value: 'hybrid', label: 'Hybrid' },
                { value: 'remote', label: 'Remote' },
              ]}
            />
          </div>
          <div>
            <p className="mb-1.5 text-[13.5px] font-semibold text-ink-2">Locations</p>
            <ChipMulti
              label="Locations"
              values={d.locationIds}
              onChange={(v) => {
                set('locationIds', v)
                setSwappedTo(null)
              }}
              options={db.locations.map((l) => ({ value: l.id, label: l.name }))}
            />
            <div aria-live="polite">
              {locationNote && <p className="mt-1.5 text-[12.5px] text-ink-3">{locationNote}</p>}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-[13.5px] font-semibold text-ink-2">Target start</p>
            <DateChips
              label="Target start"
              value={d.targetStart}
              onChange={(v) => set('targetStart', v)}
              weekdaysOnly
              presets={[
                { label: '+6 weeks', date: mondayOnOrAfter(addDays(t, 42)) },
                { label: '+8 weeks', date: mondayOnOrAfter(addDays(t, 56)) },
                { label: '+12 weeks', date: mondayOnOrAfter(addDays(t, 84)) },
              ]}
            />
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <SectionLabel>Pay range</SectionLabel>
          <FormGrid>
            <Field label="Minimum base" id="je-min" error={err.min}>
              {(id, hint) => <MoneyInput id={id} aria-describedby={hint} value={d.payMin} onChange={(v) => set('payMin', v)} />}
            </Field>
            <Field label="Maximum base" id="je-max" error={err.range}>
              {(id, hint) => <MoneyInput id={id} aria-describedby={hint} value={d.payMax} onChange={(v) => set('payMax', v)} />}
            </Field>
          </FormGrid>
          {band && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-ink-3">
              <span>
                Band for this level: <Private>{moneyRange(band.min, band.max)}</Private>
              </span>
              {(d.payMin !== band.min || d.payMax !== band.max) && (
                <Button size="sm" icon="check" onClick={() => setD((x) => ({ ...x, payMin: band.min, payMax: band.max }))}>
                  Use the band as the range
                </Button>
              )}
            </div>
          )}
          {noRange && (
            <Callout tone="warn" title="Every job needs a pay range">
              Applicants can ask for it at any size, and from 15 employees California blocks posting without one.
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <CitationChip label="Labor Code 432.3" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=432.3.&lawCode=LAB" />
                <NotLegalAdvice />
              </div>
            </Callout>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <SectionLabel>Stages and SLAs</SectionLabel>
          <p className="text-[13px] text-ink-3">SLAs are business days in a stage before a candidate counts as waiting too long. Rejected and Withdrew are outcomes, not stages.</p>
          <ol className="flex flex-col gap-2">
            {d.stages.map((s, i) => {
              const block = stageRemovalBlock(db, job, d.stages, s.id)
              const fixed = s.kind === 'new' || s.kind === 'offer' || s.kind === 'hired'
              return (
                <li key={s.id} className="rounded-xl border border-line p-3">
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label={`Stage ${i + 1} name`} className="min-w-[160px] flex-1" id={`je-stage-${s.id}`} error={tried && !s.name.trim() ? 'Add a name.' : undefined}>
                      {(id, hint) => <TextInput id={id} aria-describedby={hint} value={s.name} onChange={(e) => setStage(s.id, { name: e.target.value })} />}
                    </Field>
                    {s.kind === 'offer' || s.kind === 'hired' ? (
                      <p className="pb-3 text-[13px] text-ink-3">{s.kind === 'offer' ? 'Until the offer expires' : 'No SLA'}</p>
                    ) : (
                      <Field label="SLA (business days)" className="w-[150px]" id={`je-sla-${s.id}`}>
                        {(id) => (
                          <NumberInput id={id} min={1} max={30} value={s.slaBusinessDays ?? null} onChange={(v) => setStage(s.id, v == null ? { slaBusinessDays: undefined } : { slaBusinessDays: Math.max(1, Math.round(v)) })} />
                        )}
                      </Field>
                    )}
                    {!fixed && (
                      <div className="flex gap-1">
                        <IconButton icon="chevron-up" label={`Move ${s.name} earlier`} onClick={() => set('stages', moveStage(d.stages, s.id, -1))} />
                        <IconButton icon="chevron-down" label={`Move ${s.name} later`} onClick={() => set('stages', moveStage(d.stages, s.id, 1))} />
                        <IconButton icon="trash" label={block ?? `Remove ${s.name}`} disabled={!!block} onClick={() => removeStage(s.id)} />
                      </div>
                    )}
                  </div>
                  {!fixed && block && <p className="mt-1 text-[12.5px] text-ink-3">{block}</p>}
                </li>
              )
            })}
          </ol>
          <div className="flex flex-wrap gap-2">
            {!d.stages.some((s) => s.kind === 'recruiter_screen') && (
              <Button icon="plus" onClick={() => set('stages', withRecruiterScreen(d.stages))}>
                Add recruiter screen
              </Button>
            )}
            <Button icon="plus" onClick={() => set('stages', withCustomStage(d.stages, 'New stage'))}>
              Add a stage
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <SectionLabel>Interview panel</SectionLabel>
          <ChipMulti label="Interview panel" values={d.panelIds} onChange={(v) => set('panelIds', v)} options={team.map((p) => ({ value: p.value, label: p.label }))} />
        </section>

        <section className="flex flex-col gap-3">
          <SectionLabel>Interview plan</SectionLabel>
          {d.interviewPlan.length === 0 && <p className="text-[13.5px] text-ink-3">No interview steps yet. Pick a role template or add a step.</p>}
          {d.interviewPlan.map((step) => {
            const n = step.attributes.length
            return (
              <div key={step.id} className="flex flex-col gap-3 rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Step name" className="min-w-[180px] flex-1" id={`je-step-${step.id}`}>
                    {(id) => <TextInput id={id} value={step.name} onChange={(e) => setStep(step.id, { name: e.target.value })} />}
                  </Field>
                  <Field label="Stage" className="w-[170px]" id={`je-step-stage-${step.id}`}>
                    {(id) => <Select id={id} value={step.stageId} onChange={(v) => setStep(step.id, { stageId: v })} options={interviewStages.map((s) => ({ value: s.id, label: s.name }))} />}
                  </Field>
                  <Field label="Minutes" className="w-[100px]" id={`je-step-min-${step.id}`}>
                    {(id) => <NumberInput id={id} min={15} max={240} step={15} value={step.durationMin} onChange={(v) => setStep(step.id, { durationMin: Math.max(15, Math.round(v ?? 45)) })} />}
                  </Field>
                  <IconButton icon="trash" label={`Remove ${step.name}`} onClick={() => set('interviewPlan', d.interviewPlan.filter((s) => s.id !== step.id))} />
                </div>
                <div>
                  <p className="mb-1.5 text-[13px] font-semibold text-ink-2">Interviewers</p>
                  {interviewerOptions.length ? (
                    <ChipMulti label={`Interviewers for ${step.name}`} values={step.interviewerIds} onChange={(v) => setStep(step.id, { interviewerIds: v })} options={interviewerOptions} />
                  ) : (
                    <p className="text-[13px] text-ink-3">Add people to the panel first.</p>
                  )}
                </div>
                <div>
                  <p className="mb-1.5 text-[13px] font-semibold text-ink-2">
                    Scorecard attributes{' '}
                    <span className={n < 3 || n > 5 ? 'text-warn' : 'text-ink-3'}>({n}; 3 to 5 works best)</span>
                  </p>
                  <ul className="flex flex-wrap gap-2">
                    {step.attributes.map((a) => (
                      <li key={a.name} className="inline-flex items-center gap-1 rounded-full border border-line-strong pl-3 text-[13px] text-ink">
                        <span title={a.anchor}>{a.name}</span>
                        <IconButton icon="x" size="sm" label={`Remove ${a.name}`} onClick={() => setStep(step.id, { attributes: step.attributes.filter((x) => x.name !== a.name) })} />
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex gap-2">
                    <label htmlFor={`je-attr-${step.id}`} className="sr-only">
                      New attribute for {step.name}
                    </label>
                    <TextInput
                      id={`je-attr-${step.id}`}
                      placeholder="Add an attribute, e.g. Security mindset"
                      value={newAttr[step.id] ?? ''}
                      onChange={(e) => setNewAttr((m) => ({ ...m, [step.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addAttr(step)
                        }
                      }}
                    />
                    <Button onClick={() => addAttr(step)}>Add</Button>
                  </div>
                </div>
              </div>
            )
          })}
          <div>
            <Button icon="plus" onClick={addStep}>
              Add interview step
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <SectionLabel>Checks and sponsorship</SectionLabel>
          <div>
            <p className="mb-1.5 text-[13.5px] font-semibold text-ink-2">Visa sponsorship</p>
            <ChipGroup
              label="Visa sponsorship"
              value={d.sponsorship}
              onChange={(v) => set('sponsorship', v)}
              options={[
                { value: 'yes', label: 'We sponsor' },
                { value: 'no', label: 'No sponsorship' },
                { value: 'case_by_case', label: 'Case by case' },
              ]}
            />
          </div>
          <Switch
            checked={d.backgroundCheck}
            onChange={(v) => set('backgroundCheck', v)}
            label="Background check after a conditional offer"
            description="Runs only once an offer is accepted (Fair Chance Act). Status only; the report stays with the vendor."
          />
          <Switch
            checked={d.creditOn}
            onChange={(v) => setD((x) => ({ ...x, creditOn: v, creditBasis: v ? x.creditBasis : null }))}
            label="Credit check"
            description="Off by default. California allows one only for listed roles (Labor Code 1024.5)."
          />
          {d.creditOn && (
            <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
              <fieldset>
                <legend className="mb-2 text-[13.5px] font-semibold text-ink-2">Labor Code 1024.5 basis</legend>
                <div className="flex flex-col gap-1" role="radiogroup" aria-label="Labor Code 1024.5 basis" aria-describedby={err.credit ? 'je-credit-error' : undefined}>
                  {CREDIT_CHECK_BASES.map((b) => (
                    <label key={b.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
                      <input
                        type="radio"
                        name={`credit-basis-${job.id}`}
                        className="mt-1 h-[18px] w-[18px] accent-[var(--accent)]"
                        checked={d.creditBasis === b.id}
                        aria-invalid={err.credit || undefined}
                        onChange={() => set('creditBasis', b.id)}
                      />
                      <span>
                        <span className="block text-[14px] text-ink">{b.label}</span>
                        {b.detail && <span className="block text-[12.5px] text-ink-3">{b.detail}</span>}
                      </span>
                    </label>
                  ))}
                </div>
                {err.credit && (
                  <p id="je-credit-error" className="mt-1 text-[12.5px] font-semibold text-bad">
                    Pick a basis, or turn the credit check off.
                  </p>
                )}
              </fieldset>
              <Callout tone="neutral" title="Written notice before each report">
                {notice.why}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <CitationChip label="Labor Code 1024.5" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=1024.5.&lawCode=LAB" />
                  <CitationChip label={notice.citation.label} url={notice.citation.url} />
                  <span className="text-[12.5px] text-ink-3">{notice.reviewNote}</span>
                </div>
                <NotLegalAdvice className="mt-1" />
              </Callout>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <SectionLabel>Description</SectionLabel>
          <Field
            label="Job description"
            hint={`Pay range, benefits, the no-salary-history line, Fair Chance and EEO statements are added to the posting for you.${descCount ? ` ${descCount}.` : ''}`}
            error={err.desc}
            id="je-desc"
          >
            {(id, hint) => (
              <TextArea id={id} aria-describedby={hint} rows={10} maxLength={JOB_DESC_MAX_CHARS} value={d.description} onChange={(e) => set('description', e.target.value)} />
            )}
          </Field>
          {job.postedOn && <p className="text-[12.5px] text-ink-3">Posted {fmtDate(job.postedOn)}.</p>}
        </section>
      </div>
    </Sheet>
  )
}
