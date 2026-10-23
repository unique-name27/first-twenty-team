// Quick add (#hiring.add[.<jobId>]): one paste box parsed live (name, email, phone, LinkedIn, GitHub),
// duplicates caught by email or profile URL (a phone-only match is a soft 'may be the same person'
// note that never blocks: office lines get shared), a preselected job, source chips and an optional
// desired pay (never pay history), per year or, for an hourly or part-time job, per hour. Add lands
// the candidate in New with 'Review application, due in 3 business days'. Paste plus Add: two actions.
import { useMemo, useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canManageJob } from '@/domain/access'
import { addApplication, addCandidate, parseCandidateBlob } from '@/domain/hiring'
import { employedOn, fullName } from '@/domain/people'
import type { Candidate, ID, SourceKind } from '@/domain/types'
import { today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Button, Callout, ChipGroup, CitationChip, Field, focusFirstInvalid, FormGrid, MoneyInput, NumberInput, Segmented, Select, Sheet, TextArea, TextInput, toast } from '@/ui'
import { commit } from './actions'
import { compareJobs, guessTimezone, hourlyDesiredFits, payTooHighError, type QuickAddFields, quickAddMatches, quickAddProblems, switchDesiredUnit } from './logic'
import { NotLegalAdvice } from './parts'

const FIELD_LABELS: Array<[keyof QuickAddFields, string]> = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['linkedin', 'LinkedIn'],
  ['github', 'GitHub'],
  ['location', 'Location'],
  ['currentTitle', 'Current title'],
  ['currentCompany', 'Current company'],
]

export function QuickAddSheet({ open, jobId, onClose }: { open: boolean; jobId?: ID | null; onClose: (addedCandidateId?: ID) => void }) {
  if (!open) return null
  return <QuickAddInner jobId={jobId ?? null} onClose={onClose} />
}

function QuickAddInner({ jobId, onClose }: { jobId: ID | null; onClose: (addedCandidateId?: ID) => void }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const t = today()
  const jobs = useMemo(
    () => db.jobs.filter((j) => (j.status === 'open' || j.status === 'draft' || j.status === 'on_hold') && canManageJob(viewer, j)).sort(compareJobs),
    [db.jobs, viewer],
  )
  const [blob, setBlob] = useState('')
  const [edits, setEdits] = useState<Partial<QuickAddFields>>({})
  const [job, setJob] = useState<ID | ''>(jobId && jobs.some((j) => j.id === jobId) ? jobId : (jobs[0]?.id ?? ''))
  const [source, setSource] = useState<SourceKind>('inbound')
  const [referrerId, setReferrerId] = useState<ID | ''>('')
  const [agency, setAgency] = useState('')
  const [desiredPay, setDesiredPay] = useState<number | null>(null)
  // Per hour for a job posted with an hourly range (or part time), so a part-time figure reads as one.
  const hourlyRangeOf = (id: ID | '') => {
    const j = db.jobs.find((x) => x.id === id)
    return !!j && j.payMax != null && j.payMax < 1000
  }
  const [desiredUnit, setDesiredUnit] = useState<'year' | 'hour'>(() => (hourlyRangeOf(job) ? 'hour' : 'year'))
  const [sponsorship, setSponsorship] = useState<Candidate['sponsorship']>('unknown')
  const [tried, setTried] = useState(false)

  const parsed = useMemo(() => parseCandidateBlob(blob), [blob])
  const fields: QuickAddFields = {
    firstName: edits.firstName ?? parsed.firstName ?? '',
    lastName: edits.lastName ?? parsed.lastName ?? '',
    email: edits.email ?? parsed.email ?? '',
    phone: edits.phone ?? parsed.phone ?? '',
    linkedin: edits.linkedin ?? parsed.linkedin ?? '',
    github: edits.github ?? parsed.github ?? '',
    location: edits.location ?? parsed.location ?? '',
    currentTitle: edits.currentTitle ?? parsed.currentTitle ?? '',
    currentCompany: edits.currentCompany ?? parsed.currentCompany ?? '',
  }
  const matches = quickAddMatches(db, viewer, fields)
  const hiddenDupe = matches.strongHidden
  // A strong match (email or profile link) is the same person; a phone-only match only may be.
  const strong = matches.strong.length > 0
  const dupe = db.candidates.find((c) => c.id === (matches.strong[0] ?? matches.phoneOnly[0]))
  const dupeOnJob = dupe && job ? db.applications.find((a) => a.candidateId === dupe.id && a.jobId === job) : undefined
  const blockedByDupe = strong && !!dupeOnJob
  const problems = quickAddProblems(fields)
  if (source === 'referral' && !referrerId) problems.push('Pick who referred them.')
  // A match the viewer may not see: never name it, never attach it. Admin adds them instead.
  if (hiddenDupe) problems.unshift('This person may already be on file. Ask an admin to add them to this job.')
  const selectedJob = db.jobs.find((j) => j.id === job)
  const showUnit = hourlyDesiredFits([selectedJob]) || desiredUnit === 'hour'
  const payHigh = payTooHighError(desiredPay, desiredUnit === 'hour' ? 'hourly' : 'annual')
  const team = employedOn(db, t)
    .sort((a, b) => fullName(a).localeCompare(fullName(b)))
    .map((p) => ({ value: p.id, label: fullName(p) }))
  const agencies = [...new Set(db.candidates.filter((c) => c.source === 'agency' && c.sourceDetail).map((c) => c.sourceDetail as string))].slice(0, 4)
  const touched = blob.trim() !== '' || Object.values(fields).some((v) => v.trim() !== '')
  const name = `${fields.firstName} ${fields.lastName}`.trim()
  // Field errors after a failed Add: on the field to fix, where focusFirstInvalid() lands.
  const fieldErrors: Partial<Record<keyof QuickAddFields | 'referrer', string>> = {}
  if (tried) {
    for (const p of quickAddProblems(fields)) {
      if (p.startsWith('Add a first name')) fieldErrors.firstName = p
      else fieldErrors.email = p
    }
    if (source === 'referral' && !referrerId) fieldErrors.referrer = 'Pick who referred them.'
  }

  const add = () => {
    if (problems.length) {
      setTried(true)
      toast({ text: problems[0], tone: 'bad' })
      focusFirstInvalid()
      return
    }
    if (payHigh) {
      setTried(true)
      focusFirstInvalid()
      return
    }
    const result: { id?: ID } = {}
    const label = selectedJob ? `Added ${name} to ${selectedJob.title}` : `Added ${name} to the talent pool`
    const ok = commit(label, (d) => {
      const r = addCandidate(
        d,
        {
          firstName: fields.firstName,
          lastName: fields.lastName,
          email: fields.email,
          ...(fields.phone ? { phone: fields.phone } : {}),
          ...(fields.linkedin ? { linkedin: fields.linkedin } : {}),
          ...(fields.github ? { github: fields.github } : {}),
          ...(fields.location ? { location: fields.location } : {}),
          ...(guessTimezone(fields.location) ? { timezone: guessTimezone(fields.location) } : {}),
          ...(fields.currentTitle ? { currentTitle: fields.currentTitle } : {}),
          ...(fields.currentCompany ? { currentCompany: fields.currentCompany } : {}),
          source,
          ...(source === 'agency' && agency.trim() ? { sourceDetail: agency.trim() } : {}),
          ...(source === 'referral' && referrerId ? { referrerId } : {}),
          ...(desiredPay != null ? { desiredPay, ...(desiredUnit === 'hour' ? { desiredPayUnit: 'hour' as const } : {}) } : {}),
          sponsorship,
        },
        { date: t, ...(job ? { jobId: job } : {}), ...(selectedJob ? { ownerId: selectedJob.hiringManagerId } : {}) },
      )
      result.id = r.candidateId
    })
    if (ok) onClose(result.id)
  }

  const addExisting = () => {
    if (!dupe || !selectedJob) return
    const ok = commit(`Added ${dupe.firstName} ${dupe.lastName} to ${selectedJob.title}`, (d) => !!addApplication(d, dupe.id, selectedJob.id, { date: t, ownerId: selectedJob.hiringManagerId }))
    if (ok) onClose(dupe.id)
  }

  if (jobs.length === 0 && viewer.role !== 'admin') {
    return (
      <Sheet open onClose={() => onClose()} title="Add candidate">
        <p className="text-[14.5px] text-ink-2">You can add candidates to jobs where you are the hiring manager. You have none open right now.</p>
      </Sheet>
    )
  }

  return (
    <Sheet
      open
      onClose={() => onClose()}
      title="Add candidate"
      subtitle="Paste an email signature, a LinkedIn header or a few links."
      width={640}
      footer={
        <>
          {problems.length > 0 && touched && (
            <span id="qa-problem" className="mr-auto text-[13px] font-semibold text-ink-2">
              {problems[0]}
            </span>
          )}
          <Button variant="ghost" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="lg"
            icon="user-plus"
            onClick={add}
            disabled={blockedByDupe}
            {...(problems.length > 0 && touched ? { 'aria-describedby': 'qa-problem' } : {})}
          >
            {selectedJob ? 'Add to job' : 'Add to talent pool'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Paste anything about them" hint="Name, email, phone, LinkedIn and GitHub are picked out as you paste. Links only, never files." id="qa-blob">
          {(id, hint) => (
            <TextArea
              id={id}
              aria-describedby={hint}
              rows={5}
              data-autofocus
              placeholder={'Priya Nair\nSenior Engineer at Brightwave\npriya.nair@example.com\nlinkedin.com/in/priyanair'}
              value={blob}
              onChange={(e) => {
                setBlob(e.target.value)
                setEdits({})
              }}
            />
          )}
        </Field>

        {hiddenDupe && (
          <Callout tone="neutral" icon="lock" title="This person may already be on file">
            An admin can check and add them to this job, so nobody is attached twice. Ask an admin, or check the email and links you pasted.
          </Callout>
        )}

        {dupe && strong && (
          <Callout
            tone="warn"
            title={dupeOnJob ? `${dupe.firstName} ${dupe.lastName} is already on this job` : `${dupe.firstName} ${dupe.lastName} is already in your candidates`}
            action={
              !dupeOnJob && selectedJob ? (
                <Button onClick={addExisting}>Add them to this job</Button>
              ) : undefined
            }
          >
            Matched by email or profile link.{' '}
            <a href={links.candidate(dupe.id)} className="font-semibold text-accent underline" onClick={() => onClose()}>
              Open their profile
            </a>
          </Callout>
        )}

        {dupe && !strong && (
          <Callout
            tone="neutral"
            icon="info"
            title={`Same phone as ${dupe.firstName} ${dupe.lastName}`}
            action={
              !dupeOnJob && selectedJob ? (
                <Button onClick={addExisting}>Add {dupe.firstName} instead</Button>
              ) : undefined
            }
          >
            This may be the same person, or a shared line. You can still add {name || 'them'} as someone new
            {dupeOnJob ? `; ${dupe.firstName} is already on this job` : ''}.{' '}
            <a href={links.candidate(dupe.id)} className="font-semibold text-accent underline" onClick={() => onClose()}>
              Open {dupe.firstName}'s profile
            </a>
          </Callout>
        )}

        <FormGrid>
          {FIELD_LABELS.map(([key, label]) => (
            <Field
              key={key}
              label={label}
              required={key === 'firstName'}
              id={`qa-${key}`}
              error={fieldErrors[key]}
              {...(key === 'email' ? { hint: 'Or a phone, LinkedIn or GitHub: one way to reach them is needed.' } : {})}
            >
              {(id, hint) => (
                <TextInput
                  id={id}
                  aria-describedby={hint}
                  value={fields[key]}
                  inputMode={key === 'email' ? 'email' : key === 'phone' ? 'tel' : undefined}
                  autoComplete="off"
                  onChange={(e) => setEdits((x) => ({ ...x, [key]: e.target.value }))}
                />
              )}
            </Field>
          ))}
        </FormGrid>

        <Field label="Job" id="qa-job">
          {(id) => (
            <Select<string>
              id={id}
              value={job}
              onChange={(v) => {
                setJob(v)
                // Nothing typed yet: the unit follows the job's posted range.
                if (desiredPay == null) setDesiredUnit(hourlyRangeOf(v) ? 'hour' : 'year')
              }}
              options={[...(viewer.role === 'admin' ? [{ value: '', label: 'No job yet (talent pool)' }] : []), ...jobs.map((j) => ({ value: j.id, label: `${j.title}${j.status === 'open' ? '' : ` (${j.status === 'on_hold' ? 'on hold' : 'draft'})`}` }))]}
            />
          )}
        </Field>

        <div className="flex flex-col gap-2">
          <p className="text-[13.5px] font-semibold text-ink-2">Source</p>
          <ChipGroup<SourceKind>
            label="Source"
            value={source}
            onChange={setSource}
            options={[
              { value: 'inbound', label: 'Inbound', icon: 'inbox' },
              { value: 'referral', label: 'Referral', icon: 'heart' },
              { value: 'outbound', label: 'Outbound', icon: 'send' },
              { value: 'agency', label: 'Agency', icon: 'building' },
            ]}
          />
          {source === 'referral' && (
            <Field label="Referred by" required id="qa-referrer" error={fieldErrors.referrer}>
              {(id, hint) => <Select id={id} aria-describedby={hint} value={referrerId} onChange={setReferrerId} placeholder="Pick a teammate" options={team} />}
            </Field>
          )}
          {source === 'agency' && (
            <div className="flex flex-col gap-2">
              <Field label="Agency name" id="qa-agency">
                {(id) => <TextInput id={id} value={agency} onChange={(e) => setAgency(e.target.value)} />}
              </Field>
              {agencies.length > 0 && (
                <ChipGroup<string> size="sm" label="Agencies you have used" value={agencies.includes(agency) ? agency : null} onChange={setAgency} options={agencies.map((a) => ({ value: a, label: a }))} />
              )}
            </div>
          )}
        </div>

        <FormGrid>
          <div className="flex flex-col gap-2">
            <Field
              label="Desired pay (optional)"
              id="qa-pay"
              hint="Ask about desired pay only. California bans asking about current or past pay."
              error={tried ? payHigh : undefined}
            >
              {(id, hint) =>
                desiredUnit === 'hour' ? (
                  <NumberInput id={id} aria-describedby={hint} prefix="$" suffix="/ hour" step={0.25} min={0} sensitive value={desiredPay} onChange={setDesiredPay} />
                ) : (
                  <MoneyInput id={id} aria-describedby={hint} value={desiredPay} onChange={setDesiredPay} suffix="/ year" />
                )
              }
            </Field>
            {showUnit && (
              <Segmented
                size="sm"
                label="Desired pay per"
                value={desiredUnit}
                onChange={(u) => {
                  setDesiredUnit(u)
                  setDesiredPay((v) => switchDesiredUnit(v, u))
                }}
                options={[
                  { value: 'year', label: 'Per year' },
                  { value: 'hour', label: 'Per hour' },
                ]}
              />
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-[13.5px] font-semibold text-ink-2">Needs visa sponsorship</p>
            <ChipGroup<Candidate['sponsorship']>
              size="sm"
              label="Needs visa sponsorship"
              value={sponsorship}
              onChange={setSponsorship}
              options={[
                { value: 'unknown', label: 'Unknown' },
                { value: 'no', label: 'No' },
                { value: 'yes', label: 'Yes' },
              ]}
            />
          </div>
        </FormGrid>
        <div className="flex flex-wrap items-center gap-2">
          <CitationChip label="Labor Code 432.3" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=432.3.&lawCode=LAB" />
          <NotLegalAdvice />
        </div>
        {selectedJob && <p className="text-[13px] text-ink-3">They land in New with the next step Review application, due in 3 business days.</p>}
      </div>
    </Sheet>
  )
}
