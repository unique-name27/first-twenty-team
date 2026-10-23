// Me > Profile: contact info and emergency contacts the person edits in place (with the SB 294 notify
// choice), read-only work details, and the 'Data we don't keep' note.
import { useRef, useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { departmentName, fullName, getPerson, locationName } from '@/domain/people'
import type { DB, EmergencyContact, Person } from '@/domain/types'
import { fmtDate, today } from '@/lib/dates'
import { listJoin } from '@/lib/format'
import {
  Badge,
  Button,
  Callout,
  ChipGroup,
  CitationChip,
  DescriptionList,
  Field,
  FormGrid,
  Icon,
  Panel,
  SectionLabel,
  Select,
  TextInput,
} from '@/ui'
import { change, NotLegalAdvice } from './bits'
import {
  applyContactInfo,
  changedFields,
  type ContactDraft,
  contactErrors,
  type ContactInfo,
  contactInfoErrors,
  contactInfoOf,
  RELATIONS,
  removeContact,
  saveEmergencyContacts,
  sb294Index,
  upsertContact,
  withSb294Choice,
} from './profile'
import { stateName, US_STATES } from './states'
import { dayText, nextAnniversary, payrollProviderName, tenureText } from './summary'

const LC_1555 = 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=1555.&lawCode=LAB'

export function ProfileTab({ db, person }: { db: DB; person: Person }) {
  const saved = contactInfoOf(person)
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {/* Remounts after a save or an Undo so the form always starts from what is stored. */}
      <ContactInfoPanel key={`${person.id}:${JSON.stringify(saved)}`} person={person} saved={saved} />
      <EmergencyContactsPanel person={person} />
      <WorkDetailsPanel db={db} person={person} />
      <DataWeDontKeep db={db} />
    </div>
  )
}

// ---- Contact info -----------------------------------------------------------------------------

function ContactInfoPanel({ person, saved }: { person: Person; saved: ContactInfo }) {
  const [form, setForm] = useState<ContactInfo>(saved)
  const [touched, setTouched] = useState<Partial<Record<keyof ContactInfo, boolean>>>({})
  const errors = contactInfoErrors(form)
  const changed = changedFields(saved, form)
  const formRef = useRef<HTMLFormElement>(null)
  const set = (k: keyof ContactInfo) => (v: string) => setForm((f) => ({ ...f, [k]: v }))
  const blur = (k: keyof ContactInfo) => () => setTouched((t) => ({ ...t, [k]: true }))
  const err = (k: keyof ContactInfo) => (touched[k] ? errors[k] : undefined)

  const save = () => {
    const keys = Object.keys(errors) as Array<keyof ContactInfo>
    if (keys.length) {
      setTouched((t) => ({ ...t, ...Object.fromEntries(keys.map((k) => [k, true])) }))
      formRef.current?.querySelector<HTMLElement>(`#me-${keys[0]}`)?.focus()
      return
    }
    if (!changed.length) return
    change(`Updated your ${listJoin(changed)}`, (d) => {
      applyContactInfo(d, person.id, form)
    })
  }

  return (
    <Panel title="Contact info" icon="user" subtitle="How we reach you outside work. Edit it any time.">
      <form
        ref={formRef}
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <FormGrid>
          <Field id="me-preferredName" label="Preferred name" hint={`Shown instead of ${person.firstName} across the app.`} error={err('preferredName')}>
            {(id, describedBy) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                autoComplete="nickname"
                placeholder={person.firstName}
                value={form.preferredName}
                onChange={(e) => set('preferredName')(e.target.value)}
                onBlur={blur('preferredName')}
              />
            )}
          </Field>
          <Field id="me-personalEmail" label="Personal email" error={err('personalEmail')}>
            {(id, describedBy) => (
              <TextInput
                id={id}
                type="email"
                inputMode="email"
                autoComplete="email"
                aria-describedby={describedBy}
                aria-invalid={!!err('personalEmail') || undefined}
                value={form.personalEmail}
                onChange={(e) => set('personalEmail')(e.target.value)}
                onBlur={blur('personalEmail')}
              />
            )}
          </Field>
          <Field id="me-phone" label="Phone" error={err('phone')}>
            {(id, describedBy) => (
              <TextInput
                id={id}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                aria-describedby={describedBy}
                aria-invalid={!!err('phone') || undefined}
                value={form.phone}
                onChange={(e) => set('phone')(e.target.value)}
                onBlur={blur('phone')}
              />
            )}
          </Field>
          <Field id="me-homeCity" label="Home city" hint="City only. We never store a street address." error={err('homeCity')}>
            {(id, describedBy) => (
              <TextInput
                id={id}
                autoComplete="address-level2"
                aria-describedby={describedBy}
                aria-invalid={!!err('homeCity') || undefined}
                value={form.homeCity}
                onChange={(e) => set('homeCity')(e.target.value)}
                onBlur={blur('homeCity')}
              />
            )}
          </Field>
          <Field id="me-homeState" label="Home state" hint="The state you work from." error={err('homeState')} className="sm:col-span-2">
            {(id, describedBy) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                options={US_STATES}
                placeholder="Pick a state"
                value={form.homeState}
                onChange={(v) => {
                  set('homeState')(v)
                  setTouched((t) => ({ ...t, homeState: true }))
                }}
              />
            )}
          </Field>
        </FormGrid>
        {form.homeState && saved.homeState && form.homeState !== saved.homeState && (
          <Callout tone="warn" className="mt-4" title={`Moving to ${stateName(form.homeState)}?`}>
            Working from another state changes payroll registration, taxes and some rules. Tell an admin before your first workday
            there.
          </Callout>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" icon="check" disabled={!changed.length}>
            Save contact info
          </Button>
          {changed.length > 0 && (
            <Button
              variant="ghost"
              onClick={() => {
                setForm(saved)
                setTouched({})
              }}
            >
              Discard changes
            </Button>
          )}
          {changed.length > 0 && <span className="text-[13px] text-ink-3">Not saved yet: {listJoin(changed)}</span>}
        </div>
      </form>
    </Panel>
  )
}

// ---- Emergency contacts -----------------------------------------------------------------------

const EMPTY_DRAFT: ContactDraft = { name: '', relation: '', phone: '' }

function EmergencyContactsPanel({ person }: { person: Person }) {
  const contacts = person.emergencyContacts
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const notify = sb294Index(contacts)

  const save = (list: EmergencyContact[], label: string, activity: string) => {
    change(label, (d) => {
      saveEmergencyContacts(d, person.id, list, activity, today())
    })
  }

  return (
    <Panel
      title="Emergency contacts"
      icon="heart"
      subtitle="Who we call if something happens to you at work."
      actions={
        editing === null ? (
          <Button icon="plus" onClick={() => setEditing('new')}>
            Add contact
          </Button>
        ) : undefined
      }
    >
      {contacts.length === 0 && editing === null && (
        <p className="text-[14.5px] text-ink-2">No emergency contacts yet. Add one so we know who to call.</p>
      )}
      <ul className="-my-1 divide-y divide-line">
        {contacts.map((c, i) =>
          editing === i ? (
            <li key={`edit-${i}`} className="py-3">
              <ContactForm
                initial={{ name: c.name, relation: c.relation, phone: c.phone }}
                submitLabel="Save contact"
                onCancel={() => setEditing(null)}
                onSave={(draft) => {
                  setEditing(null)
                  save(upsertContact(contacts, i, draft), `Updated ${draft.name.trim()}'s contact details`, 'Updated an emergency contact in Me')
                }}
              />
            </li>
          ) : (
            <li key={`${c.name}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-[14.5px] font-semibold text-ink">{c.name}</p>
                <p className="text-[13.5px] text-ink-3">
                  {c.relation}, <span className="num">{c.phone}</span>
                </p>
                {c.sb294Notify && (
                  <Badge tone="accent" icon="bell" className="mt-1">
                    Notified if you are arrested or detained at work
                  </Badge>
                )}
              </div>
              <Button icon="edit" aria-label={`Edit ${c.name}`} onClick={() => setEditing(i)} disabled={editing !== null}>
                Edit
              </Button>
              <Button
                variant="ghost"
                icon="trash"
                aria-label={`Remove ${c.name}`}
                disabled={editing !== null}
                onClick={() => save(removeContact(contacts, i), `Removed ${c.name} from your emergency contacts`, 'Removed an emergency contact in Me')}
              >
                Remove
              </Button>
            </li>
          ),
        )}
        {editing === 'new' && (
          <li className="py-3">
            <ContactForm
              initial={EMPTY_DRAFT}
              submitLabel="Add contact"
              onCancel={() => setEditing(null)}
              onSave={(draft) => {
                setEditing(null)
                save(upsertContact(contacts, null, draft), `Added ${draft.name.trim()} as an emergency contact`, 'Added an emergency contact in Me')
              }}
            />
          </li>
        )}
      </ul>

      <SectionLabel className="mt-5">If you are arrested or detained at work</SectionLabel>
      <p className="mt-2 text-[14px] text-ink-2">
        California lets you pick an emergency contact we notify if you are arrested or detained at work or while working. It is your
        choice, and you can change it any time.
      </p>
      {contacts.length ? (
        <ChipGroup
          className="mt-3"
          label="Contact to notify if you are arrested or detained at work"
          value={notify == null ? 'none' : String(notify)}
          options={[...contacts.map((c, i) => ({ value: String(i), label: c.name })), { value: 'none', label: 'No one' }]}
          onChange={(v) => {
            const idx = v === 'none' ? null : Number(v)
            if (idx === notify) return
            save(
              withSb294Choice(contacts, idx),
              idx == null ? 'Turned off arrest or detention notification' : `${contacts[idx].name} is now your arrest or detention contact`,
              'Updated the SB 294 notification choice in Me',
            )
          }}
        />
      ) : (
        <p className="mt-2 text-[14px] text-ink-3">Add a contact first, then choose here.</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <CitationChip label="Labor Code 1555 (SB 294)" url={LC_1555} />
        <NotLegalAdvice />
      </div>
    </Panel>
  )
}

function ContactForm({
  initial,
  submitLabel,
  onSave,
  onCancel,
}: {
  initial: ContactDraft
  submitLabel: string
  onSave: (c: ContactDraft) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<ContactDraft>(initial)
  const [tried, setTried] = useState(false)
  const errors = contactErrors(draft)
  const relations: string[] = [...RELATIONS]
  if (draft.relation && !relations.includes(draft.relation)) relations.unshift(draft.relation)
  const ref = useRef<HTMLDivElement>(null)
  const submit = () => {
    const first = Object.keys(errors)[0]
    if (first) {
      setTried(true)
      ref.current?.querySelector<HTMLElement>(first === 'relation' ? '[role=radio]' : `#ec-${first}`)?.focus()
      return
    }
    onSave(draft)
  }
  return (
    <div
      ref={ref}
      className="rounded-xl bg-surface-2 p-4"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
          e.preventDefault()
          submit()
        }
        if (e.key === 'Escape') onCancel()
      }}
    >
      <FormGrid>
        <Field id="ec-name" label="Name" error={tried ? errors.name : undefined}>
          {(id, describedBy) => (
            <TextInput
              id={id}
              autoFocus
              autoComplete="off"
              aria-describedby={describedBy}
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          )}
        </Field>
        <Field id="ec-phone" label="Phone" error={tried ? errors.phone : undefined}>
          {(id, describedBy) => (
            <TextInput
              id={id}
              type="tel"
              inputMode="tel"
              autoComplete="off"
              aria-describedby={describedBy}
              value={draft.phone}
              onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
            />
          )}
        </Field>
      </FormGrid>
      <div className="mt-4">
        <p className="text-[13.5px] font-semibold text-ink-2" id="ec-relation-label">
          Relationship
        </p>
        <ChipGroup
          className="mt-1.5"
          size="sm"
          label="Relationship"
          value={draft.relation}
          options={relations.map((r) => ({ value: r, label: r }))}
          onChange={(v) => setDraft((d) => ({ ...d, relation: v }))}
        />
        {tried && errors.relation && <p className="mt-1.5 text-[12.5px] font-semibold text-bad">{errors.relation}</p>}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="primary" icon="check" onClick={submit}>
          {submitLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

// ---- Work details -----------------------------------------------------------------------------

const WORK_MODE: Record<Person['workMode'], string> = { onsite: 'On site', hybrid: 'Hybrid', remote: 'Remote' }

function WorkDetailsPanel({ db, person }: { db: DB; person: Person }) {
  const date = today()
  const manager = getPerson(db, person.managerId)
  const anniversary = nextAnniversary(person.startDate, date)
  const admin = useViewer().role === 'admin'
  return (
    <Panel title="Work details" icon="briefcase" subtitle={admin ? 'Change these on your profile page.' : 'Ask an admin to change these.'}>
      <DescriptionList
        items={[
          {
            label: 'Work email',
            value: person.workEmail || (
              <span className="flex flex-wrap items-center gap-x-3">
                <span className="text-ink-3">Not set</span>
                {/* Interview invites and candidate emails need it; Admin sets it on the person page. */}
                {admin && (
                  <a href={links.person(person.id)} className="-my-2.5 inline-flex min-h-10 items-center font-semibold text-accent underline decoration-accent/30 underline-offset-2">
                    Set it on your profile page
                  </a>
                )}
              </span>
            ),
          },
          { label: 'Title', value: person.title },
          { label: 'Team', value: departmentName(db, person.departmentId) },
          {
            label: 'Manager',
            value: manager ? (
              <a href={links.person(manager.id)} className="-my-2.5 inline-flex min-h-10 items-center font-semibold text-accent underline decoration-accent/30 underline-offset-2">
                {fullName(manager)}
              </a>
            ) : (
              'No manager'
            ),
          },
          { label: 'Location', value: `${locationName(db, person.locationId)}${person.workMode ? `, ${WORK_MODE[person.workMode].toLowerCase()}` : ''}` },
          { label: 'Employee number', value: <span className="num">#{person.hireNumber}</span> },
          { label: 'Start date', value: `${fmtDate(person.startDate)} (${tenureText(person.startDate, date).toLowerCase()})` },
          { label: 'Next work anniversary', value: anniversary ? dayText(anniversary.date, date) : 'After your first year', hidden: !anniversary },
        ]}
      />
    </Panel>
  )
}

// ---- Data we don't keep -----------------------------------------------------------------------

const NOT_KEPT = [
  'Social Security number',
  'Date of birth',
  'Bank or direct deposit details',
  'Home street address',
  'ID scans and I-9 forms',
  'Background check reports',
  'Medical details, including for leave',
  'Gender, race, ethnicity, age, disability, veteran status, religion, marital status or pronouns',
]

function DataWeDontKeep({ db }: { db: DB }) {
  const peo = db.company.payrollProvider
  const peoName = payrollProviderName(db)
  return (
    <Panel title="Data we don't keep" icon="eye-off" subtitle="This app stores status and dates, never these.">
      <ul className="grid gap-x-6 gap-y-2 text-[14px] text-ink-2 sm:grid-cols-2">
        {NOT_KEPT.map((t) => (
          <li key={t} className="flex gap-2">
            <Icon name="x" size={15} className="mt-0.5 shrink-0 text-ink-3" />
            <span>{t}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[14px] text-ink-2">
        Your payroll, tax, bank and benefits details live with {peoName ? <strong className="text-ink">{peoName}</strong> : 'the payroll provider'}
        . Update them there.
        {peo?.url && (
          <>
            {' '}
            <a href={peo.url} target="_blank" rel="noreferrer noopener" className="-my-2.5 inline-flex min-h-10 items-center gap-1 font-semibold text-accent underline">
              Open {peo.kind === 'PEO' ? 'the PEO' : 'payroll'}
              <Icon name="external" size={13} />
            </a>
          </>
        )}
      </p>
    </Panel>
  )
}
