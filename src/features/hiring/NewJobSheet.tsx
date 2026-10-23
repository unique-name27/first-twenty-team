// New job (#hiring.new-job[.<planSlotId>]): a role template prefills title, family, level, the band
// as the posted range, the description, stages and interview plan. The team follows the family until
// picked by hand. Pick the employment type, hiring manager, panel, locations, work mode, sponsorship
// and background check, then create a draft job.
// Hiring managers get the request mode instead ('Request a job'): template, title, level, quarter and
// a reason, saved as a draft job that waits for Admin approval in the inbox.
// Picking Remote with only an office as the location swaps in the workspace's remote location (the
// posting and the offer letter quote it). After a create, focus lands on the new job page's title.
import { useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { DEFAULT_ROLE_TEMPLATES } from '@/data/starterRoleTemplates'
import { createJob, departmentForFamily, effectiveBand, jobFromTemplate, requestJob, requisitionQuarters, roleTemplates, templateLabel } from '@/domain/hiring'
import { founder } from '@/domain/people'
import type { ID, Job, PlanSlot, RoleTemplate } from '@/domain/types'
import { fmtQuarter, today } from '@/lib/dates'
import { moneyRange } from '@/lib/format'
import { useDB } from '@/store/db'
import {
  Button,
  Callout,
  ChipGroup,
  ChipMulti,
  CitationChip,
  Field,
  focusFirstInvalid,
  focusPageStart,
  FormGrid,
  MoneyInput,
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
import { JOB_DESC_MAX_CHARS, jobDescCountText, jobSizeError, NOTE_MAX_CHARS, noteCountText, officeOnly, payTooHighError, remoteLocationsFor, teamOptions } from './logic'
import { EMPLOYMENT_OPTIONS, NotLegalAdvice } from './parts'

/**
 * After a create the sheet closes onto the new job page, but its trigger may still be on screen (the
 * header New menu), where the sheet would hand focus back. Once the job page has rendered, with no sheet
 * over it (from a plan line the posting sheet opens and takes focus itself), focus its title instead,
 * after the sheet's own focus return.
 */
function focusNewJobPage(jobId: ID): void {
  const page = links.job(jobId)
  let frames = 0
  const tick = () => {
    const onPage = window.location.hash === page || window.location.hash.startsWith(`${page}.`)
    if (onPage && !document.querySelector('[role="dialog"][aria-modal="true"]') && document.querySelector('#main h1')) {
      setTimeout(focusPageStart, 0)
      return
    }
    if (++frames < 30) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

export function NewJobSheet({
  open,
  planSlotId,
  onClose,
  mode = 'create',
}: {
  open: boolean
  planSlotId?: ID | null
  onClose: (jobId?: ID) => void
  /** 'request': a hiring manager asks for a job; it waits for Admin approval (no cost shown). */
  mode?: 'create' | 'request'
}) {
  if (!open) return null
  return mode === 'request' ? <RequestJobInner onClose={onClose} /> : <NewJobInner planSlotId={planSlotId ?? null} onClose={onClose} />
}

/**
 * Request a job (Hiring manager view): template, title, level, quarter and a reason. It saves a draft
 * job with a pending request that lands as an approval in Admin's inbox. No loaded cost is shown.
 */
function RequestJobInner({ onClose }: { onClose: (jobId?: ID) => void }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const t = today()
  const me = viewer.personId
  const templates = roleTemplates(db).length ? roleTemplates(db) : DEFAULT_ROLE_TEMPLATES
  const quarters = requisitionQuarters(t)
  const mine = viewer.person
  const firstTemplate = templates.find((x) => x.departmentId === mine?.departmentId) ?? templates[0]
  const build = (tpl: RoleTemplate | undefined): Job => jobFromTemplate(db, tpl, { date: t, hiringManagerId: me ?? '' })
  const [templateId, setTemplateId] = useState<ID | ''>(firstTemplate?.id ?? '')
  const [job, setJob] = useState<Job>(() => build(firstTemplate))
  const [quarter, setQuarter] = useState<string>(quarters[1] ?? quarters[0])
  const [reason, setReason] = useState('')
  const [tried, setTried] = useState(false)
  const band = effectiveBand(db, job.familyId, job.levelId)
  const families = db.families.map((f) => ({ value: f.id, label: f.name }))
  const levels = [...db.levels].sort((a, b) => a.order - b.order).map((l) => ({ value: l.id, label: `${l.code} ${l.name}` }))

  const pickTemplate = (id: ID) => {
    setTemplateId(id)
    const next = build(templates.find((x) => x.id === id))
    setJob((cur) => ({ ...next, id: cur.id }))
  }
  const setFamilyLevel = (familyId: ID, levelId: ID) => {
    const b = effectiveBand(db, familyId, levelId)
    setJob((j) => ({ ...j, familyId, levelId, payMin: b?.min ?? null, payMax: b?.max ?? null, ...(b ? { equityMinPct: b.equityMinPct, equityMaxPct: b.equityMaxPct } : {}) }))
  }

  // The reason is stored on the job's request, so it is capped like a note (the record must fit one sync).
  const reasonCount = noteCountText(reason)
  const problems: string[] = []
  if (!me) problems.push('Pick who you are under Viewing as first.')
  if (!job.title.trim()) problems.push('Add a title.')
  if (!reason.trim()) problems.push('Say why the team needs this role.')

  const send = () => {
    if (problems.length || !me) {
      setTried(true)
      toast({ text: problems[0] ?? 'Pick who you are under Viewing as first.', tone: 'bad' })
      focusFirstInvalid()
      return
    }
    const title = job.title.trim()
    const ok = commit(`Requested the ${title} job. Admin will review it.`, (d) => {
      requestJob(d, { ...job, title, interviewPlan: job.interviewPlan.map((s) => (s.interviewerIds.length ? s : { ...s, interviewerIds: [me] })) }, { requestedById: me, quarter, reason, date: t })
    })
    if (ok) {
      onClose(job.id)
      focusNewJobPage(job.id)
    }
  }

  return (
    <Sheet
      open
      onClose={() => onClose()}
      title="Request a job"
      subtitle="Admin approves it and adds it to the headcount plan. Then you can post it."
      width={640}
      footer={
        <>
          {problems.length > 0 && (
            <span className="mr-auto text-[13px] font-semibold text-ink-2">
              {problems[0]}
            </span>
          )}
          <Button variant="ghost" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" icon="send" onClick={send}>
            Send request
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Role template" hint="Prefills the level, description, stages and interview plan." id="rj-template">
          {(id, hint) => (
            <Select<string> id={id} aria-describedby={hint} value={templateId} onChange={pickTemplate} placeholder="Start blank" options={templates.map((tpl) => ({ value: tpl.id, label: templateLabel(tpl) }))} />
          )}
        </Field>
        <Field label="Title" required id="rj-title" error={tried && !job.title.trim() ? 'Add a title.' : undefined}>
          {(id, hint) => <TextInput id={id} aria-describedby={hint} value={job.title} onChange={(e) => setJob((j) => ({ ...j, title: e.target.value }))} />}
        </Field>
        <FormGrid>
          <Field label="Job family" id="rj-family">
            {(id) => <Select id={id} value={job.familyId} onChange={(v) => setFamilyLevel(v, job.levelId)} options={families} />}
          </Field>
          <Field label="Level" id="rj-level">
            {(id) => <Select id={id} value={job.levelId} onChange={(v) => setFamilyLevel(job.familyId, v)} options={levels} />}
          </Field>
        </FormGrid>
        {band && (
          <p className="text-[13px] text-ink-3">
            The posted range starts from the band for this level: <Private>{moneyRange(band.min, band.max)}</Private>. Admin can adjust it.
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <p className="text-[13.5px] font-semibold text-ink-2">Quarter to hire in</p>
          <ChipGroup<string> label="Quarter to hire in" value={quarter} onChange={setQuarter} options={quarters.map((q) => ({ value: q, label: fmtQuarter(q) }))} />
        </div>
        <Field
          label="Why the team needs this role"
          required
          hint={`A sentence or two for Admin: the work it unblocks, or who it replaces.${reasonCount ? ` ${reasonCount}.` : ''}`}
          error={tried && !reason.trim() ? 'Say why the team needs this role, in a sentence or two.' : undefined}
          id="rj-reason"
        >
          {(id, hint) => <TextArea id={id} aria-describedby={hint} rows={3} maxLength={NOTE_MAX_CHARS} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <p className="text-[13px] text-ink-3">
          You will be the hiring manager. It shows on your Jobs list as a draft and in your inbox until Admin decides. Viewing as is a preview, not security.
        </p>
      </div>
    </Sheet>
  )
}

function templateFor(templates: RoleTemplate[], slot: PlanSlot | undefined): RoleTemplate | undefined {
  if (!slot) return undefined
  return templates.find((t) => t.familyId === slot.familyId && t.levelId === slot.levelId) ?? templates.find((t) => t.familyId === slot.familyId)
}

function NewJobInner({ planSlotId, onClose }: { planSlotId: ID | null; onClose: (jobId?: ID) => void }) {
  const db = useDB((s) => s.db)
  const t = today()
  const templates = roleTemplates(db).length ? roleTemplates(db) : DEFAULT_ROLE_TEMPLATES
  const slot = planSlotId ? db.plan.find((s) => s.id === planSlotId) : undefined
  const team = teamOptions(db, t)
  const defaultHm = founder(db)?.id ?? team[0]?.value ?? ''
  const build = (tpl: RoleTemplate | undefined, hm: ID): Job =>
    jobFromTemplate(db, tpl, {
      date: t,
      hiringManagerId: hm,
      ...(slot
        ? { title: slot.title, familyId: slot.familyId, levelId: slot.levelId, departmentId: slot.departmentId, planSlotId: slot.id, targetStart: slot.targetStart, ...(slot.isBackfill ? { isBackfill: true, backfillForPersonId: slot.backfillForPersonId ?? null } : {}) }
        : {}),
    })
  const [templateId, setTemplateId] = useState<ID | ''>(templateFor(templates, slot)?.id ?? '')
  const [job, setJob] = useState<Job>(() => build(templateFor(templates, slot), defaultHm))
  const [tried, setTried] = useState(false)
  // Once the team is picked by hand, a later template or family change leaves it alone.
  const [teamPicked, setTeamPicked] = useState(false)
  // The remote location picked automatically when Work mode became Remote (said under Locations).
  const [swappedTo, setSwappedTo] = useState<string | null>(null)
  const set = <K extends keyof Job>(k: K, v: Job[K]) => setJob((j) => ({ ...j, [k]: v }))
  const setWorkMode = (mode: Job['workMode']) => {
    const remote = mode === 'remote' ? remoteLocationsFor(db.locations, job.locationIds) : undefined
    setJob((j) => ({ ...j, workMode: mode, ...(remote ? { locationIds: remote } : {}) }))
    setSwappedTo(remote ? remote.map((id) => db.locations.find((l) => l.id === id)?.name ?? '').join(', ') : null)
  }

  const pickTemplate = (id: ID) => {
    setTemplateId(id)
    const tpl = templates.find((x) => x.id === id)
    setJob((cur) => {
      const next = build(tpl, cur.hiringManagerId)
      return {
        ...next,
        id: cur.id,
        hiringManagerId: cur.hiringManagerId,
        panelIds: cur.panelIds,
        ...(slot ? { title: slot.title } : {}),
        ...(teamPicked ? { departmentId: cur.departmentId } : {}),
        locationIds: cur.locationIds,
        workMode: cur.workMode,
        employmentType: cur.employmentType,
        sponsorship: cur.sponsorship,
        backgroundCheck: cur.backgroundCheck,
      }
    })
  }

  const band = effectiveBand(db, job.familyId, job.levelId)
  const families = db.families.map((f) => ({ value: f.id, label: f.name }))
  const levels = [...db.levels].sort((a, b) => a.order - b.order).map((l) => ({ value: l.id, label: `${l.code} ${l.name}` }))
  const minHigh = payTooHighError(job.payMin, 'annual')
  const maxHigh = payTooHighError(job.payMax, 'annual')
  const problems: string[] = []
  if (!job.title.trim()) problems.push('Add a title.')
  if (!job.hiringManagerId) problems.push('Pick a hiring manager.')
  if (minHigh || maxHigh) problems.push('A pay range amount looks too high. Check the number.')
  if (job.payMin != null && job.payMax != null && job.payMin > job.payMax) problems.push('The pay range minimum is above the maximum.')
  const sizeError = jobSizeError(job)
  if (sizeError) problems.push(sizeError)
  const descCount = jobDescCountText(job.description)
  const remoteOnOffice = job.workMode === 'remote' && officeOnly(db.locations, job.locationIds)
  const locationNote =
    swappedTo && !remoteOnOffice
      ? `Picked ${swappedTo} for a remote job. Add an office back if people also work there.`
      : !remoteOnOffice
        ? null
        : db.locations.some((l) => l.kind === 'remote')
          ? 'The posting and the offer letter use these locations. Pick a remote one unless people report to the office.'
          : 'The posting and the offer letter use these locations, so a remote job would quote the office. Add a remote location in Settings > Org.'

  const create = () => {
    if (problems.length) {
      setTried(true)
      toast({ text: problems[0], tone: 'bad' })
      focusFirstInvalid()
      return
    }
    const final: Job = {
      ...job,
      title: job.title.trim(),
      panelIds: job.panelIds.includes(job.hiringManagerId) ? job.panelIds : [job.hiringManagerId, ...job.panelIds],
      // Until interviewers are picked in Edit, the hiring manager runs each step.
      interviewPlan: job.interviewPlan.map((s) => (s.interviewerIds.length ? s : { ...s, interviewerIds: [job.hiringManagerId] })),
    }
    const ok = commit(`Created the ${final.title} job (draft)`, (d) => {
      createJob(d, final)
      if (slot) {
        const s = d.plan.find((x) => x.id === slot.id)
        if (s) {
          s.jobId = final.id
          if (s.status === 'planned') s.status = 'open'
        }
      }
    })
    if (ok) {
      onClose(final.id)
      focusNewJobPage(final.id)
    }
  }

  const setFamilyLevel = (familyId: ID, levelId: ID) => {
    const b = effectiveBand(db, familyId, levelId)
    setJob((j) => ({
      ...j,
      familyId,
      levelId,
      // The team follows the family (People and operations lands in Finance and operations) until picked by hand.
      ...(!teamPicked && familyId !== j.familyId ? { departmentId: departmentForFamily(db, familyId) } : {}),
      payMin: b?.min ?? j.payMin,
      payMax: b?.max ?? j.payMax,
      ...(b ? { equityMinPct: b.equityMinPct, equityMaxPct: b.equityMaxPct } : {}),
    }))
  }

  return (
    <Sheet
      open
      onClose={() => onClose()}
      title="New job"
      subtitle={slot ? `From the plan: ${fmtQuarter(slot.quarter)} ${slot.title}` : 'Starts as a draft. Post it when the posting checks out.'}
      width={680}
      footer={
        <>
          {problems.length > 0 && <span className="mr-auto text-[13px] font-semibold text-bad">{problems[0]}</span>}
          <Button variant="ghost" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" icon="briefcase" onClick={create}>
            Create draft job
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-3">
          <SectionLabel>Role template</SectionLabel>
          <p className="text-[13.5px] text-ink-3">Prefills the level, band, description, stages and interview plan with scorecard attributes.</p>
          <Field label="Template" id="nj-template">
            {(id) => (
              <Select<string>
                id={id}
                value={templateId}
                onChange={pickTemplate}
                placeholder="Start blank"
                options={templates.map((tpl) => ({ value: tpl.id, label: templateLabel(tpl) }))}
              />
            )}
          </Field>
        </section>

        <section className="flex flex-col gap-4">
          <SectionLabel>The role</SectionLabel>
          <Field label="Title" required id="nj-title" error={tried && !job.title.trim() ? 'Add a title.' : undefined}>
            {(id, hint) => <TextInput id={id} aria-describedby={hint} value={job.title} onChange={(e) => set('title', e.target.value)} />}
          </Field>
          <FormGrid>
            <Field label="Job family" id="nj-family">
              {(id) => <Select id={id} value={job.familyId} onChange={(v) => setFamilyLevel(v, job.levelId)} options={families} />}
            </Field>
            <Field label="Level" id="nj-level">
              {(id) => <Select id={id} value={job.levelId} onChange={(v) => setFamilyLevel(job.familyId, v)} options={levels} />}
            </Field>
          </FormGrid>
          <FormGrid>
            <Field label="Team" id="nj-team" hint="Hires from this job join this team.">
              {(id, hint) => (
                <Select
                  id={id}
                  aria-describedby={hint}
                  value={job.departmentId}
                  onChange={(v) => {
                    setTeamPicked(true)
                    set('departmentId', v)
                  }}
                  options={db.departments.map((x) => ({ value: x.id, label: x.name }))}
                />
              )}
            </Field>
            <div>
              <p className="mb-1.5 text-[13.5px] font-semibold text-ink-2">Employment</p>
              <ChipGroup label="Employment" value={job.employmentType} onChange={(v) => set('employmentType', v)} options={EMPLOYMENT_OPTIONS} />
            </div>
          </FormGrid>
          <FormGrid>
            <Field label="Pay range minimum" id="nj-min" error={tried ? minHigh : undefined}>
              {(id, hint) => <MoneyInput id={id} aria-describedby={hint} value={job.payMin} onChange={(v) => set('payMin', v)} />}
            </Field>
            <Field
              label="Pay range maximum"
              id="nj-max"
              error={tried ? (maxHigh ?? (job.payMin != null && job.payMax != null && job.payMin > job.payMax ? 'The maximum is below the minimum.' : undefined)) : undefined}
            >
              {(id, hint) => <MoneyInput id={id} aria-describedby={hint} value={job.payMax} onChange={(v) => set('payMax', v)} />}
            </Field>
          </FormGrid>
          {band ? (
            <p className="text-[13px] text-ink-3">
              Prefilled from the band: <Private>{moneyRange(band.min, band.max)}</Private>
            </p>
          ) : (
            <p className="text-[13px] text-ink-3">No band for this family and level yet. Set a range anyway.</p>
          )}
          {(job.payMin == null || job.payMax == null) && (
            <Callout tone="warn" title="Every job needs a pay range from day one">
              Applicants can ask for it at any size, and from 15 employees California blocks posting without one.
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <CitationChip label="Labor Code 432.3" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=432.3.&lawCode=LAB" />
                <NotLegalAdvice />
              </div>
            </Callout>
          )}
        </section>

        <section className="flex flex-col gap-4">
          <SectionLabel>People</SectionLabel>
          <Field label="Hiring manager" id="nj-hm" error={tried && !job.hiringManagerId ? 'Pick a hiring manager.' : undefined}>
            {(id, hint) => <Select id={id} aria-describedby={hint} value={job.hiringManagerId} onChange={(v) => set('hiringManagerId', v)} options={team} placeholder={job.hiringManagerId ? undefined : 'Pick a hiring manager'} />}
          </Field>
          <div>
            <p className="mb-1.5 text-[13.5px] font-semibold text-ink-2">Interview panel</p>
            <ChipMulti label="Interview panel" values={job.panelIds} onChange={(v) => set('panelIds', v)} options={team} />
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <SectionLabel>Where and how</SectionLabel>
          <div>
            <p className="mb-1.5 text-[13.5px] font-semibold text-ink-2">Locations</p>
            <ChipMulti
              label="Locations"
              values={job.locationIds}
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
            <p className="mb-1.5 text-[13.5px] font-semibold text-ink-2">Work mode</p>
            <Segmented
              label="Work mode"
              value={job.workMode}
              onChange={setWorkMode}
              options={[
                { value: 'onsite', label: 'On site' },
                { value: 'hybrid', label: 'Hybrid' },
                { value: 'remote', label: 'Remote' },
              ]}
            />
          </div>
          <div>
            <p className="mb-1.5 text-[13.5px] font-semibold text-ink-2">Visa sponsorship</p>
            <ChipGroup
              label="Visa sponsorship"
              value={job.sponsorship}
              onChange={(v) => set('sponsorship', v)}
              options={[
                { value: 'yes', label: 'We sponsor' },
                { value: 'no', label: 'No sponsorship' },
                { value: 'case_by_case', label: 'Case by case' },
              ]}
            />
          </div>
          <Switch
            checked={job.backgroundCheck}
            onChange={(v) => set('backgroundCheck', v)}
            label="Background check after a conditional offer"
            description="Runs only once an offer is accepted (Fair Chance Act). Credit checks stay off; turn one on later in Edit if the role qualifies."
          />
        </section>

        <section className="flex flex-col gap-3">
          <SectionLabel>Description and interview plan</SectionLabel>
          <Field
            label="Job description"
            hint={`The posting adds the pay range, benefits, the no-salary-history line and the Fair Chance and EEO statements.${descCount ? ` ${descCount}.` : ''}`}
            error={tried ? sizeError : undefined}
            id="nj-desc"
          >
            {(id, hint) => (
              <TextArea id={id} aria-describedby={hint} rows={8} maxLength={JOB_DESC_MAX_CHARS} value={job.description} onChange={(e) => set('description', e.target.value)} />
            )}
          </Field>
          <p className="text-[13.5px] text-ink-2">
            {job.stages.map((s) => s.name).join(', ')}.{' '}
            {job.interviewPlan.length ? `${job.interviewPlan.length} interview steps: ${job.interviewPlan.map((s) => s.name).join(', ')}.` : 'No interview steps yet.'} The hiring manager runs each step until you pick interviewers in Edit.
          </p>
        </section>
      </div>
    </Sheet>
  )
}
