// Add person: a manual hire without the ATS (or a contractor converted to an employee, or a former
// employee rehired). Creates employee #N as Pre-start with an effective-dated job and pay record and the
// onboarding checklist (plus the new-state checklist for a first employee in another state), all with
// computed dates. A name or personal email that matches a former employee offers to link the rehire.
import { useEffect, useMemo, useState } from 'react'
import { useViewer } from '@/app/useViewer'
import { ThresholdPreview } from '@/features/compliance'
import { hireStartPresets } from '@/features/timeoff'
import { generateChecklist, type TaskOverride } from '@/domain/checklists/generate'
import { TASK_IDS } from '@/domain/checklists/templates'
import { defaultExemptionBasis } from '@/domain/hiring/offers'
import { companyDomain, slugify } from '@/domain/lifecycle'
import { bandFor, exemptCheck } from '@/domain/pay'
import { daysAway, employedOn, founder, fullName, getPerson, incomingOn, priorStint } from '@/domain/people'
import type { CompRecord, DB, EmploymentType, ExemptionBasis, FLSA, ID, Person, WorkMode } from '@/domain/types'
import { links, navigate } from '@/app/router'
import { addDays, fmtDate, fmtMonth, type ISODate, today } from '@/lib/dates'
import { moneyShort } from '@/lib/format'
import { newId } from '@/lib/id'
import { logActivity, useDB } from '@/store/db'
import {
  Button,
  Callout,
  Checkbox,
  ChipGroup,
  DateChips,
  Field,
  focusFirstInvalid,
  FormGrid,
  Money,
  MoneyInput,
  NumberInput,
  Private,
  SectionLabel,
  Select,
  Sheet,
  TextInput,
  toast,
} from '@/ui'
import { LINE_MAX_CHARS, nextMonday, scopeSummary, splitName, titleFromScope } from './helpers'
import { undoToast } from './parts'

export const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]

const EXEMPTION_LABEL: Record<ExemptionBasis, string> = {
  executive: 'Executive',
  administrative: 'Administrative',
  professional: 'Professional',
  computer_professional: 'Computer professional',
  outside_sales: 'Outside sales',
}

export type PersonPrefill = Partial<PersonForm> & { fromContractorId?: ID; rehireOfPersonId?: ID }

type PersonForm = {
  firstName: string
  lastName: string
  preferredName: string
  workEmail: string
  personalEmail: string
  title: string
  departmentId: ID
  familyId: ID
  levelId: ID
  managerId: ID
  locationId: ID
  workMode: WorkMode
  homeCity: string
  homeState: string
  employmentType: EmploymentType
  hoursPerWeek: number | null
  flsa: FLSA
  exemptionBasis: ExemptionBasis
  payType: 'salary' | 'hourly'
  salary: number | null
  hourlyRate: number | null
  startDate: ISODate
  backgroundCheck: 'clear' | 'pending' | 'not_required'
}

function defaults(db: DB, prefill?: PersonPrefill): PersonForm {
  const dept = db.departments[0]
  const hq = db.locations.find((l) => l.kind === 'hq') ?? db.locations[0]
  const family = db.families.find((f) => f.track === 'engineering') ?? db.families[0]
  const level = db.levels.find((l) => l.code === 'L3') ?? db.levels[0]
  // A prefill's family and level (a rehire, a contractor) decide the band and the exemption.
  const familyId = prefill?.familyId ?? family?.id ?? ''
  const levelId = prefill?.levelId ?? level?.id ?? ''
  const band = familyId && levelId ? bandFor(db, familyId, levelId) : undefined
  return {
    firstName: '',
    lastName: '',
    preferredName: '',
    workEmail: '',
    personalEmail: '',
    title: '',
    departmentId: dept?.id ?? '',
    familyId: family?.id ?? '',
    levelId: level?.id ?? '',
    managerId: dept?.headId ?? db.people.find((p) => p.isFounder)?.id ?? '',
    locationId: hq?.id ?? '',
    workMode: /hybrid/i.test(db.company.workweek) ? 'hybrid' : /remote/i.test(db.company.workweek) ? 'remote' : 'onsite',
    homeCity: hq?.city ?? '',
    homeState: hq?.state ?? 'CA',
    employmentType: 'full_time',
    hoursPerWeek: 40,
    flsa: band?.flsaDefault ?? 'exempt',
    // The exemption that fits the family and level (computer professional for engineering and ML),
    // as in Change job or pay and the offer builder, so the exempt check uses the right minimum.
    exemptionBasis: defaultExemptionBasis(familyId, levelId),
    payType: 'salary',
    salary: band?.mid ?? null,
    hourlyRate: null,
    startDate: nextMonday(today()),
    backgroundCheck: db.company.soc2Enabled ? 'pending' : 'not_required',
  }
}

function uniquePersonId(db: DB, first: string, last: string): ID {
  const taken = new Set(db.people.map((p) => p.id))
  const a = `p-${slugify(first)}`
  const b = `p-${slugify(first)}-${slugify(last)}`
  if (!taken.has(a)) return a
  if (!taken.has(b)) return b
  for (let i = 2; ; i++) if (!taken.has(`${b}-${i}`)) return `${b}-${i}`
}

export function AddPersonSheet({
  open,
  onClose,
  onCreated,
  prefill,
}: {
  open: boolean
  onClose: () => void
  onCreated: (personId: ID) => void
  prefill?: PersonPrefill
}) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [form, setForm] = useState<PersonForm>(() => ({ ...defaults(db, prefill), ...prefill }))
  const [endContract, setEndContract] = useState(true)
  const [tried, setTried] = useState(false)
  // The exemption follows the family and level until someone picks one.
  const [basisPicked, setBasisPicked] = useState(!!prefill?.exemptionBasis)
  // The former employee this hire is linked to as a rehire, and a match someone said is a different person.
  const [rehireOf, setRehireOf] = useState<ID | null>(prefill?.rehireOfPersonId ?? null)
  const [notRehire, setNotRehire] = useState<ID | null>(null)
  // The employee this sheet just created (so the closing sheet does not flash the duplicate warning).
  const [createdId, setCreatedId] = useState<ID | null>(null)
  const contractor = prefill?.fromContractorId ? db.contractors.find((c) => c.id === prefill.fromContractorId) : undefined
  // A contractor converts once: a second conversion would add a duplicate employee.
  const convertedTo =
    contractor?.convertedToPersonId && contractor.convertedToPersonId !== createdId ? db.people.find((p) => p.id === contractor.convertedToPersonId) : undefined
  // The 2810.5 notice, overtime and break rules arrive with the first non-exempt employee.
  const nonExemptAlready = db.people.find((p) => p.flsa === 'non_exempt' && (!p.endDate || p.endDate >= today()))

  useEffect(() => {
    if (open) {
      setForm({ ...defaults(db, prefill), ...prefill })
      setTried(false)
      setCreatedId(null)
      setBasisPicked(!!prefill?.exemptionBasis)
      setRehireOf(prefill?.rehireOfPersonId ?? null)
      setNotRehire(null)
    }
    // Reset only when the sheet opens or the prefill changes.
  }, [open, prefill])

  const set = <K extends keyof PersonForm>(k: K, v: PersonForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const band = bandFor(db, form.familyId, form.levelId)
  const managers = useMemo(() => [...employedOn(db), ...incomingOn(db)].sort((a, b) => a.hireNumber - b.hireNumber), [db])
  const hireNumber = db.people.reduce((m, p) => Math.max(m, p.hireNumber), 0) + 1
  // Work emails prefill only on a known domain (the website or the founder's work email), never a guess.
  const domain = companyDomain(db.company, founder(db)?.workEmail)
  const emailDefault = form.firstName && domain ? `${slugify(form.firstName).replace(/-/g, '')}@${domain}` : ''
  const emailTaken = (e: string) => db.people.some((p) => p.workEmail.toLowerCase() === e.toLowerCase())
  const workEmail =
    form.workEmail.trim() ||
    (emailDefault && emailTaken(emailDefault) ? `${slugify(form.firstName).replace(/-/g, '')}.${slugify(form.lastName).replace(/-/g, '')}@${domain}` : emailDefault)
  // A former employee with this name or personal email: offer to link the rehire.
  const linked = rehireOf ? getPerson(db, rehireOf) : undefined
  const match = useMemo(() => {
    if (rehireOf || contractor || !form.firstName.trim() || !form.lastName.trim()) return undefined
    const found = priorStint(db, { id: '', firstName: form.firstName.trim(), lastName: form.lastName.trim(), personalEmail: form.personalEmail, startDate: form.startDate })
    return found && found.id !== notRehire ? found : undefined
  }, [db, rehireOf, contractor, form.firstName, form.lastName, form.personalEmail, form.startDate, notRehire])
  const linkRehire = (prior: Person) => {
    setRehireOf(prior.id)
    // The same person keeps the same work address.
    setForm((f) => ({ ...f, workEmail: f.workEmail.trim() || prior.workEmail, personalEmail: f.personalEmail.trim() || (prior.personalEmail ?? '') }))
  }
  const unlinkRehire = () => {
    if (linked) setNotRehire(linked.id)
    setRehireOf(null)
  }
  const away = linked?.endDate ? daysAway(linked.endDate, form.startDate) : undefined
  const outsideCA = form.homeState.toUpperCase() !== 'CA'
  const exemptIssue =
    form.flsa === 'exempt'
      ? exemptCheck(db.settings.law, {
          payType: form.payType,
          salary: form.salary ?? 0,
          hourlyRate: form.hourlyRate ?? 0,
          hoursPerWeek: form.hoursPerWeek ?? 40,
          exemptionBasis: form.exemptionBasis,
          state: form.homeState,
        })
      : null
  const errors = {
    firstName: !form.firstName.trim() ? 'Add a first name.' : '',
    lastName: !form.lastName.trim() ? 'Add a last name.' : '',
    title: !form.title.trim() ? 'Add a job title.' : '',
    pay: form.payType === 'salary' ? (!form.salary ? 'Add the annual salary.' : '') : !form.hourlyRate ? 'Add the hourly rate.' : '',
    hours: !form.hoursPerWeek || form.hoursPerWeek <= 0 ? 'Add hours per week.' : '',
  }
  const valid = Object.values(errors).every((e) => !e)

  const pickDepartment = (id: ID) => {
    const head = db.departments.find((d) => d.id === id)?.headId
    setForm((f) => ({ ...f, departmentId: id, managerId: head && head !== f.managerId ? head : f.managerId }))
  }
  const pickLevel = (familyId: ID, levelId: ID) => {
    const b = bandFor(db, familyId, levelId)
    setForm((f) => ({
      ...f,
      familyId,
      levelId,
      flsa: b?.flsaDefault ?? f.flsa,
      exemptionBasis: basisPicked ? f.exemptionBasis : defaultExemptionBasis(familyId, levelId),
      salary: f.payType === 'salary' && b ? b.mid : f.salary,
    }))
  }

  const save = () => {
    if (convertedTo) {
      navigate('person', convertedTo.id)
      return
    }
    setTried(true)
    if (!valid) {
      toast({ text: Object.values(errors).filter(Boolean).join(' '), tone: 'bad' })
      focusFirstInvalid()
      return
    }
    const t = today()
    const id = uniquePersonId(db, form.firstName, form.lastName)
    const person: Person = {
      id,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      workEmail,
      title: form.title.trim(),
      departmentId: form.departmentId,
      familyId: form.familyId,
      levelId: form.levelId,
      managerId: form.managerId || null,
      locationId: form.locationId,
      workMode: form.workMode,
      homeState: form.homeState,
      employmentType: form.employmentType,
      hoursPerWeek: form.hoursPerWeek ?? 40,
      flsa: form.flsa,
      startDate: form.startDate,
      endDate: null,
      hireNumber,
      emergencyContacts: [],
      backgroundCheck: form.backgroundCheck === 'clear' ? { status: 'clear', completedOn: t } : { status: form.backgroundCheck },
    }
    if (form.preferredName.trim()) person.preferredName = form.preferredName.trim()
    if (form.personalEmail.trim()) person.personalEmail = form.personalEmail.trim()
    if (form.homeCity.trim()) person.homeCity = form.homeCity.trim()
    if (form.flsa === 'exempt') person.exemptionBasis = form.exemptionBasis
    if (contractor) person.fromContractorId = contractor.id
    // Links the records: sick leave left at the exit comes back within 12 months, and no DE 34 is due under 60 days away.
    if (linked) person.rehireOfPersonId = linked.id
    const comp: CompRecord = {
      id: newId('cr'),
      personId: id,
      effectiveOn: form.startDate,
      payType: form.payType,
      title: person.title,
      levelId: person.levelId,
      managerId: person.managerId,
      departmentId: person.departmentId,
      flsa: person.flsa,
      reason: 'hire',
      appliedOn: t,
    }
    if (form.payType === 'salary') comp.salary = form.salary ?? 0
    else comp.hourlyRate = form.hourlyRate ?? 0
    if (viewer.personId) {
      comp.approvedById = viewer.personId
      comp.approvedOn = t
    }
    const name = fullName(person)
    const label = linked ? `Rehired ${name} as employee #${hireNumber}` : `Added ${name} as employee #${hireNumber}`
    useDB.getState().mutate(label, (d) => {
      d.people.push(person)
      d.comp.push(comp)
      const overrides: Record<ID, TaskOverride> = {}
      if (form.backgroundCheck === 'clear') overrides[TASK_IDS.backgroundCheck] = { status: 'done', doneOn: t, note: 'Cleared before the hire was recorded.' }
      const sameState = outsideCA
        ? d.people.find((p) => p.id !== id && p.homeState === person.homeState && (!p.endDate || p.endDate >= person.startDate))
        : undefined
      if (sameState) {
        overrides[TASK_IDS.newStatePointer] = {
          note: `${person.homeState} is already set up (${fullName(sameState)} works there). Confirm the state notices and sick leave rules.`,
        }
      }
      d.checklists.push(generateChecklist(d as DB, { person, templateId: 'tpl-onboarding', anchorDate: person.startDate, createdOn: t, overrides }))
      if (outsideCA && !sameState) {
        d.checklists.push(generateChecklist(d as DB, { person, templateId: 'tpl-new-state', anchorDate: person.startDate, createdOn: t }))
      }
      if (contractor) {
        const k = d.contractors.find((c) => c.id === contractor.id)
        if (k) {
          // Links both records: settles the AB5 alert and blocks a second conversion.
          k.convertedToPersonId = id
          k.convertedOn = t
          if (endContract && (!k.endOn || k.endOn >= person.startDate)) k.endOn = addDays(person.startDate, -1)
          logActivity(d, {
            entityType: 'contractor',
            entityId: k.id,
            relatedId: id,
            kind: 'converted_to_employee',
            text: `Converted ${k.name} to employee #${hireNumber}, starting ${fmtDate(person.startDate)}`,
          })
        }
      }
      logActivity(d, {
        entityType: 'person',
        entityId: id,
        ...(contractor ? { relatedId: contractor.id } : {}),
        kind: 'hired',
        text: contractor
          ? `Converted ${contractor.name} from contractor to employee #${hireNumber}, starting ${fmtDate(person.startDate)}`
          : linked
            ? `Rehired ${name} (formerly #${linked.hireNumber}) as ${person.title}, employee #${hireNumber}, starting ${fmtDate(person.startDate)}`
            : `Added ${name} as ${person.title}, employee #${hireNumber}, starting ${fmtDate(person.startDate)}`,
      })
    })
    undoToast(label)
    setCreatedId(id)
    onCreated(id)
  }

  const err = (k: keyof typeof errors) => (tried ? errors[k] || undefined : undefined)
  const t = today()

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={contractor ? `Convert ${contractor.name} to an employee` : linked && prefill?.rehireOfPersonId ? `Rehire ${fullName(linked)}` : 'Add a person'}
      subtitle={`Adds employee #${hireNumber} as Pre-start and builds the onboarding checklist with every date worked out.`}
      width={640}
      footer={
        convertedTo ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" size="lg" icon="user" onClick={save}>
              Open employee #{convertedTo.hireNumber}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" size="lg" icon="user-plus" onClick={save}>
              Add employee #{hireNumber}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-5">
        {convertedTo && contractor && (
          <Callout tone="warn" title={`${contractor.name} is already employee #${convertedTo.hireNumber}`}>
            Converted {contractor.convertedOn ? fmtDate(contractor.convertedOn) : 'earlier'}.{' '}
            <a href={links.person(convertedTo.id)} className="-my-2.5 inline-flex min-h-10 items-center font-semibold text-accent underline">
              Open {fullName(convertedTo)}
            </a>{' '}
            instead of adding a second employee record.
          </Callout>
        )}
        {contractor && !convertedTo && form.flsa === 'non_exempt' && !nonExemptAlready && (
          <Callout tone="accent" title="First non-exempt hire rules apply">
            A part-time hourly role is non-exempt: the Labor Code 2810.5 wage notice, sick leave accrual, overtime, meal and rest breaks and
            timekeeping through payroll. The onboarding checklist adds those items.
          </Callout>
        )}
        {contractor && !convertedTo && form.flsa === 'non_exempt' && nonExemptAlready && (
          <Callout tone="neutral" icon="info" title="Non-exempt hire">
            The onboarding checklist adds the Labor Code 2810.5 wage notice. Overtime, meal and rest breaks and timekeeping run through payroll, as they
            already do for {fullName(nonExemptAlready)}.
          </Callout>
        )}
        <SectionLabel>Who</SectionLabel>
        <FormGrid>
          <Field label="First name" required error={err('firstName')}>
            {(id, d) => <TextInput id={id} aria-describedby={d} maxLength={LINE_MAX_CHARS} value={form.firstName} onChange={(e) => set('firstName', e.target.value)} data-autofocus />}
          </Field>
          <Field label="Last name" required error={err('lastName')}>
            {(id, d) => <TextInput id={id} aria-describedby={d} maxLength={LINE_MAX_CHARS} value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />}
          </Field>
          <Field label="Preferred first name" hint="Optional">
            {(id, d) => <TextInput id={id} aria-describedby={d} maxLength={LINE_MAX_CHARS} value={form.preferredName} onChange={(e) => set('preferredName', e.target.value)} />}
          </Field>
          <Field
            label="Work email"
            hint={
              form.workEmail
                ? undefined
                : workEmail
                  ? `Will be ${workEmail}`
                  : domain
                    ? 'Made from the first name'
                    : 'Add your website in Settings > Company to prefill work emails'
            }
          >
            {(id, d) => (
              <TextInput
                id={id}
                aria-describedby={d}
                type="email"
                maxLength={LINE_MAX_CHARS}
                value={form.workEmail}
                placeholder={workEmail}
                onChange={(e) => set('workEmail', e.target.value)}
              />
            )}
          </Field>
          <Field label="Personal email" hint="Optional, for the welcome email before day 1">
            {(id, d) => <TextInput id={id} aria-describedby={d} type="email" maxLength={LINE_MAX_CHARS} value={form.personalEmail} onChange={(e) => set('personalEmail', e.target.value)} />}
          </Field>
        </FormGrid>
        {linked && (
          <Callout
            tone={linked.separation?.rehireEligible === false ? 'warn' : 'good'}
            icon="user"
            title={`Rehire of #${linked.hireNumber} ${fullName(linked)} (${fmtMonth(linked.startDate)} to ${fmtMonth(linked.endDate)})`}
            action={
              <Button variant="ghost" size="sm" onClick={unlinkRehire}>
                Not a rehire
              </Button>
            }
          >
            {linked.separation?.rehireEligible === false && <p className="font-semibold">Marked not eligible for rehire when they left. Check why before going ahead.</p>}
            <p>
              The new record links to the earlier one{linked.workEmail ? ' and keeps the same work email' : ''}. Sick leave left at the exit comes back
              within 12 months.
            </p>
            {away != null && (
              <p className="mt-1">
                {away < 60
                  ? `Back after ${away} ${away === 1 ? 'day' : 'days'}, so no DE 34 new hire report is needed (EDD counts a rehire after 60 days away).`
                  : `Back after ${away} days, so EDD needs a DE 34 new hire report within 20 days of the start date.`}
              </p>
            )}
          </Callout>
        )}
        {match && (
          <Callout
            tone={match.separation?.rehireEligible === false ? 'warn' : 'accent'}
            icon="user"
            title={`${fullName(match)} worked here until ${fmtDate(match.endDate)}. Link this as a rehire?`}
          >
            {match.separation?.rehireEligible === false && <p className="font-semibold">Marked not eligible for rehire when they left.</p>}
            <p>Employee #{match.hireNumber}. Linking connects the two records and reuses the work email.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="primary" size="sm" icon="link" onClick={() => linkRehire(match)}>
                Link as a rehire
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setNotRehire(match.id)}>
                Different person
              </Button>
            </div>
          </Callout>
        )}

        <SectionLabel>Job</SectionLabel>
        <FormGrid>
          <Field
            label="Job title"
            required
            error={err('title')}
            className="sm:col-span-2"
            hint={contractor ? `From their contract scope: ${scopeSummary(contractor.scope)}` : undefined}
          >
            {(id, d) => (
              <TextInput
                id={id}
                aria-describedby={d}
                maxLength={LINE_MAX_CHARS}
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder={contractor ? 'For example: Close review accountant' : 'For example: Senior data engineer'}
              />
            )}
          </Field>
          <Field label="Team">
            {(id) => <Select id={id} value={form.departmentId} onChange={pickDepartment} options={db.departments.map((d) => ({ value: d.id, label: d.name }))} />}
          </Field>
          <Field label="Manager">
            {(id) => (
              <Select
                id={id}
                value={form.managerId}
                onChange={(v) => set('managerId', v)}
                options={managers.map((p) => ({ value: p.id, label: `#${p.hireNumber} ${fullName(p)}` }))}
              />
            )}
          </Field>
          <Field label="Job family">
            {(id) => <Select id={id} value={form.familyId} onChange={(v) => pickLevel(v, form.levelId)} options={db.families.map((f) => ({ value: f.id, label: f.name }))} />}
          </Field>
          <Field
            label="Level"
            hint={band ? <>Band <Private>{`${moneyShort(band.min)} to ${moneyShort(band.max)}`}</Private></> : 'No band for this family and level'}
          >
            {(id, d) => (
              <Select
                id={id}
                aria-describedby={d}
                value={form.levelId}
                onChange={(v) => pickLevel(form.familyId, v)}
                options={[...db.levels].sort((a, b) => a.order - b.order).map((l) => ({ value: l.id, label: `${l.code} ${l.name}` }))}
              />
            )}
          </Field>
        </FormGrid>

        <SectionLabel>Where</SectionLabel>
        <FormGrid>
          <Field label="Location">
            {(id) => (
              <Select
                id={id}
                value={form.locationId}
                onChange={(v) => {
                  const loc = db.locations.find((l) => l.id === v)
                  setForm((f) => ({
                    ...f,
                    locationId: v,
                    workMode: loc?.kind === 'remote' ? 'remote' : f.workMode === 'remote' ? 'hybrid' : f.workMode,
                    homeState: loc?.state ?? f.homeState,
                    homeCity: loc?.city ?? f.homeCity,
                  }))
                }}
                options={db.locations.map((l) => ({ value: l.id, label: l.name }))}
              />
            )}
          </Field>
          <Field label="Work mode">
            {() => (
              <ChipGroup
                label="Work mode"
                size="sm"
                value={form.workMode}
                onChange={(v) => set('workMode', v)}
                options={[
                  { value: 'onsite', label: 'Onsite' },
                  { value: 'hybrid', label: 'Hybrid' },
                  { value: 'remote', label: 'Remote' },
                ]}
              />
            )}
          </Field>
          <Field label="Works from (city)" hint="City only. Never a street address.">
            {(id, d) => <TextInput id={id} aria-describedby={d} maxLength={LINE_MAX_CHARS} value={form.homeCity} onChange={(e) => set('homeCity', e.target.value)} />}
          </Field>
          <Field label="Works from (state)" hint={outsideCA ? 'Outside California: adds the new-state checklist.' : undefined}>
            {(id, d) => <Select id={id} aria-describedby={d} value={form.homeState} onChange={(v) => set('homeState', v)} options={US_STATES.map((s) => ({ value: s, label: s }))} />}
          </Field>
        </FormGrid>

        <SectionLabel>Pay and hours</SectionLabel>
        <Field label="Employment">
          {() => (
            <ChipGroup
              label="Employment"
              value={form.employmentType}
              onChange={(v) =>
                setForm((f) => ({
                  ...f,
                  employmentType: v,
                  hoursPerWeek: v === 'full_time' ? 40 : f.hoursPerWeek === 40 ? 20 : f.hoursPerWeek,
                }))
              }
              options={[
                { value: 'full_time', label: 'Full time' },
                { value: 'part_time', label: 'Part time' },
                { value: 'intern', label: 'Intern' },
              ]}
            />
          )}
        </Field>
        <FormGrid>
          <Field label="Hours per week" error={err('hours')}>
            {(id, d) => (
              <div className="flex flex-col gap-2">
                <ChipGroup
                  label="Hours per week"
                  size="sm"
                  value={String(form.hoursPerWeek ?? '')}
                  onChange={(v) => set('hoursPerWeek', Number(v))}
                  options={['20', '24', '25', '30', '40'].map((h) => ({ value: h, label: h }))}
                />
                <NumberInput id={id} aria-describedby={d} value={form.hoursPerWeek} onChange={(v) => set('hoursPerWeek', v)} min={1} max={60} suffix="hours" />
              </div>
            )}
          </Field>
          <Field label="Overtime status">
            {() => (
              <div className="flex flex-col gap-2">
                <ChipGroup
                  label="Overtime status"
                  size="sm"
                  value={form.flsa}
                  onChange={(v) => set('flsa', v)}
                  options={[
                    { value: 'exempt', label: 'Exempt' },
                    { value: 'non_exempt', label: 'Non-exempt' },
                  ]}
                />
              </div>
            )}
          </Field>
          {form.flsa === 'exempt' && (
            <Field label="Exemption" id="add-person-exemption" hint="Decides which California pay minimum the exempt check uses.">
              {(id, d) => (
                <Select
                  id={id}
                  aria-describedby={d}
                  value={form.exemptionBasis}
                  onChange={(v) => {
                    setBasisPicked(true)
                    set('exemptionBasis', v)
                  }}
                  options={(Object.keys(EXEMPTION_LABEL) as ExemptionBasis[]).map((k) => ({ value: k, label: EXEMPTION_LABEL[k] }))}
                />
              )}
            </Field>
          )}
          <Field label="Pay type">
            {() => (
              <ChipGroup
                label="Pay type"
                size="sm"
                value={form.payType}
                onChange={(v) => set('payType', v)}
                options={[
                  { value: 'salary', label: 'Salary' },
                  { value: 'hourly', label: 'Hourly' },
                ]}
              />
            )}
          </Field>
          {form.payType === 'salary' ? (
            <Field label="Annual salary" required error={err('pay')} hint={band ? <>Band midpoint <Money value={band.mid} /></> : undefined}>
              {(id, d) => <MoneyInput id={id} aria-describedby={d} value={form.salary} onChange={(v) => set('salary', v)} suffix="/ year" />}
            </Field>
          ) : (
            <Field label="Hourly rate" required error={err('pay')}>
              {(id, d) => <NumberInput id={id} aria-describedby={d} value={form.hourlyRate} onChange={(v) => set('hourlyRate', v)} prefix="$" suffix="/ hour" step="0.25" min={0} />}
            </Field>
          )}
        </FormGrid>
        {exemptIssue && (
          <Callout tone="warn" title="Exempt check">
            {exemptIssue.text}
          </Callout>
        )}

        <SectionLabel>Start</SectionLabel>
        <Field label="Start date">
          {(id) => (
            <DateChips
              id={id}
              label="Start date"
              value={form.startDate}
              onChange={(v) => set('startDate', v)}
              presets={hireStartPresets(t, db.holidays)}
            />
          )}
        </Field>
        <ThresholdPreview startDate={form.startDate} />
        <Field label="Background check">
          {() => (
            <ChipGroup
              label="Background check"
              size="sm"
              value={form.backgroundCheck}
              onChange={(v) => set('backgroundCheck', v)}
              options={[
                { value: 'clear', label: 'Cleared' },
                { value: 'pending', label: 'Pending' },
                { value: 'not_required', label: 'Not required' },
              ]}
            />
          )}
        </Field>
        {contractor && (
          <Checkbox
            checked={endContract}
            onChange={setEndContract}
            label={`End ${contractor.name}'s contract the day before the start date`}
            description="The contractor record stays for the 1099-NEC and retention."
          />
        )}
      </div>
    </Sheet>
  )
}

/**
 * Prefill for rehiring a former employee from their alumni profile: the same name, emails, job family,
 * level, title, team, location and hours, the manager when they are still here, and the link to the
 * earlier record. Pay starts from the band again (an offer is a new negotiation).
 */
export function prefillForRehire(db: DB, personId: ID): PersonPrefill | undefined {
  const p = db.people.find((x) => x.id === personId)
  if (!p) return undefined
  const t = today()
  const manager = p.managerId ? db.people.find((x) => x.id === p.managerId) : undefined
  const managerHere = !!manager && (!manager.endDate || manager.endDate >= t)
  return {
    rehireOfPersonId: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    preferredName: p.preferredName ?? '',
    workEmail: p.workEmail,
    personalEmail: p.personalEmail ?? '',
    title: p.title,
    departmentId: p.departmentId,
    familyId: p.familyId,
    levelId: p.levelId,
    ...(managerHere && manager ? { managerId: manager.id } : {}),
    locationId: p.locationId,
    workMode: p.workMode,
    homeCity: p.homeCity ?? '',
    homeState: p.homeState,
    employmentType: p.employmentType,
    hoursPerWeek: p.hoursPerWeek,
    flsa: p.flsa,
    ...(p.flsa === 'exempt' && p.exemptionBasis ? { exemptionBasis: p.exemptionBasis } : {}),
  }
}

/** Prefill for converting a contractor to a part-time hourly employee. */
export function prefillFromContractor(db: DB, contractorId: ID): PersonPrefill | undefined {
  const c = db.contractors.find((k) => k.id === contractorId)
  if (!c) return undefined
  const { first, last } = splitName(c.name)
  const head = db.departments.find((d) => d.id === c.departmentId)
  const hourly = c.rateUnit === 'hour' ? c.rate : c.rateUnit === 'month' && c.hoursPerWeek ? Math.round((c.rate * 12) / (c.hoursPerWeek * 52)) : null
  const hours = c.hoursPerWeek ?? 20
  // The job family most people on that team are in (an accounting contractor becomes an accounting hire).
  const counts = new Map<ID, number>()
  for (const p of db.people) if (p.departmentId === c.departmentId) counts.set(p.familyId, (counts.get(p.familyId) ?? 0) + 1)
  const familyId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  return {
    ...(familyId ? { familyId } : {}),
    fromContractorId: c.id,
    firstName: first,
    lastName: last,
    personalEmail: c.email,
    departmentId: c.departmentId,
    managerId: c.managerId || head?.headId || '',
    title: titleFromScope(c.scope),
    employmentType: hours >= 40 ? 'full_time' : 'part_time',
    hoursPerWeek: hours,
    flsa: 'non_exempt',
    payType: 'hourly',
    hourlyRate: hourly,
    salary: null,
    homeState: c.state,
  }
}
