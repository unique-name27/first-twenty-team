// Person profile: header (avatar, #number, title, team, manager, location, status, tenure, actions
// by role) and tabs gated by canSeePerson: Overview, Job and pay, Equity, Time off, Checklists and
// documents, Emergency contacts, Activity. '.offboard' and '.change' open those sheets. A pending last
// day shows only to those canSeeSeparation allows; an alumni profile offers Rehire to Admin.
import { useMemo, useRef, useState } from 'react'
import type { PageProps } from '@/app/routes'
import { links, navigate, replaceRoute } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { ChangeJobSheet, PersonEquityPanel, PersonJobPayPanel } from '@/features/comp'
import { PersonTrainingPanel } from '@/features/compliance'
import { PersonTimeOffPanel, StartLeaveSheet } from '@/features/timeoff'
import { canSeeBackgroundDetail, canSeePerson, canSeeSeparation, type PersonArea } from '@/domain/access'
import { personRetention } from '@/domain/compliance'
import { grantSummary } from '@/domain/equity'
import { departmentName, directReports, fullName, getPerson, levelLabel, onLeave } from '@/domain/people'
import { trainingRequirements } from '@/domain/trainings'
import type { DocumentRecord, EmergencyContact, ID, Person, Role } from '@/domain/types'
import { addDays, fmtDate, fmtDateTime, fmtDuration, fmtMonth, type ISODate, today } from '@/lib/dates'
import { num } from '@/lib/format'
import { newId } from '@/lib/id'
import { logActivity, useDB } from '@/store/db'
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Checkbox,
  ChipGroup,
  CitationChip,
  DateChips,
  DescriptionList,
  EmptyState,
  Field,
  FormGrid,
  Icon,
  Panel,
  Private,
  Select,
  Tabs,
  TextInput,
} from '@/ui'
import { AddPersonSheet, prefillForRehire } from './AddPersonSheet'
import { dayLabel, LINE_MAX_CHARS, LINK_MAX_CHARS, nextAnniversary, personDirStatus, personLocation, startsInText } from './helpers'
import { OffboardSheet, SEPARATION_LABEL } from './OffboardSheet'
import { ChecklistCard, PersonChecklistsPanel } from './panels'
import { EmpNo, LEAVE_KIND_LABEL, PersonStatusBadge, undoToast } from './parts'
import { undoChange, undoneLabelFor, useLatestChange } from './undo'

type TabKey = 'overview' | 'job' | 'equity' | 'timeoff' | 'checklists' | 'emergency' | 'activity'

const WORK_MODE: Record<Person['workMode'], string> = { onsite: 'Onsite', hybrid: 'Hybrid', remote: 'Remote' }
const EMPLOYMENT: Record<Person['employmentType'], string> = { full_time: 'Full time', part_time: 'Part time', intern: 'Intern' }
const ROLE_LABEL: Record<Role, string> = { admin: 'Admin', manager: 'Hiring manager', employee: 'Employee' }

/** A 40px tall target; `inline` pulls it back to the line height inside running text. */
const LINK = 'inline-flex min-h-10 items-center font-semibold text-accent hover:underline'

function PersonLink({ person, inline = true, suffix }: { person: Person | undefined; inline?: boolean; suffix?: string }) {
  if (!person) return <span className="text-ink-3">None</span>
  return (
    <a href={links.person(person.id)} className={inline ? `-my-2.5 ${LINK}` : LINK}>
      #{person.hireNumber} {fullName(person)}
      {suffix}
    </a>
  )
}

/** Work email, or "Not set" (no known company domain at hire); Admin can set it in place. */
function WorkEmail({ person }: { person: Person }) {
  const viewer = useViewer()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(person.workEmail)
  const [tried, setTried] = useState(false)
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  const id = `work-email-${person.id}`
  if (editing) {
    const save = () => {
      setTried(true)
      if (!valid) return
      const label = `Set the work email for ${fullName(person)}`
      useDB.getState().mutate(label, (d) => {
        const p = d.people.find((x) => x.id === person.id)
        if (!p) return
        p.workEmail = value.trim()
        logActivity(d, { entityType: 'person', entityId: person.id, kind: 'work_email', text: label })
      })
      undoToast(label)
      setEditing(false)
    }
    return (
      <span className="flex flex-col gap-2">
        <TextInput
          id={id}
          aria-label="Work email"
          aria-invalid={tried && !valid ? true : undefined}
          aria-describedby={tried && !valid ? `${id}-error` : undefined}
          type="email"
          maxLength={LINE_MAX_CHARS}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="name@yourcompany.com"
          data-autofocus
        />
        {tried && !valid && (
          <span id={`${id}-error`} className="text-[12.5px] font-semibold text-bad">
            Enter an email address like name@yourcompany.com.
          </span>
        )}
        <span className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" onClick={save}>
            Save
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </span>
      </span>
    )
  }
  const edit = () => {
    setValue(person.workEmail)
    setTried(false)
    setEditing(true)
  }
  return (
    <span className="flex flex-wrap items-center gap-x-3">
      {person.workEmail ? (
        <a className={`-my-2.5 ${LINK} font-normal`} href={`mailto:${person.workEmail}`}>
          {person.workEmail}
        </a>
      ) : (
        <span className="text-ink-3">Not set</span>
      )}
      {viewer.role === 'admin' && (
        <button type="button" onClick={edit} className="-my-2.5 inline-flex min-h-10 items-center text-[13.5px] font-semibold text-ink-2 hover:text-ink" aria-label={`${person.workEmail ? 'Change' : 'Set'} the work email for ${fullName(person)}`}>
          {person.workEmail ? 'Change' : 'Set work email'}
        </button>
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

type UpcomingEvent = { date: ISODate; text: React.ReactNode; icon: React.ComponentProps<typeof Icon>['name']; tone?: 'warn' | 'bad' }

function Overview({ person }: { person: Person }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const t = today()
  const can = (a: PersonArea) => canSeePerson(viewer, db, person.id, a)
  const manager = getPerson(db, person.managerId)
  const reports = directReports(db, person.id)
  const status = personDirStatus(db, person, t)
  const anniv = nextAnniversary(person.startDate, t)
  // A departure still ahead shows only to Admin, the person and their manager line; others see Active.
  const separationVisible = canSeeSeparation(viewer, db, person.id)
  const earlier = person.rehireOfPersonId ? getPerson(db, person.rehireOfPersonId) : undefined
  const backAs = db.people.find((p) => p.rehireOfPersonId === person.id)
  const leave = db.leaveCases
    .filter((l) => l.personId === person.id && !l.returnedOn && !l.endedOn && (!l.expectedReturn || l.expectedReturn > t))
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0]

  const events: UpcomingEvent[] = []
  if (person.startDate > t) events.push({ date: person.startDate, icon: 'calendar', text: `Starts ${dayLabel(person.startDate)} (${startsInText(person.startDate, t).replace('starts ', '')})` })
  if (separationVisible && person.endDate && person.endDate >= t) events.push({ date: person.endDate, icon: 'log-out', text: `Last day ${dayLabel(person.endDate)}` })
  if (status !== 'alumni') {
    events.push({ date: anniv.date, icon: 'star', text: `${anniv.years}-year work anniversary ${dayLabel(anniv.date)}` })
  }
  if (leave && can('timeoff')) {
    const kind = can('leave') ? LEAVE_KIND_LABEL[leave.kind] : 'Leave'
    if (leave.startDate > t) events.push({ date: leave.startDate, icon: 'plane', text: `${kind} starts ${dayLabel(leave.startDate)}` })
    if (leave.expectedReturn) events.push({ date: leave.expectedReturn, icon: 'plane', text: `Back from leave ${dayLabel(leave.expectedReturn)}` })
  }
  if (can('equity') && status !== 'alumni') {
    const g = grantSummary(db, person.id, t)
    if (g.cliff && !g.cliff.passed) {
      events.push({
        date: g.cliff.date,
        icon: 'coins',
        text: (
          <>
            1-year cliff {dayLabel(g.cliff.date)}: <Private>{num(g.cliff.shares)}</Private> options vest
          </>
        ),
      })
    } else if (g.nextVest) {
      events.push({
        date: g.nextVest.date,
        icon: 'coins',
        text: (
          <>
            Next vest {dayLabel(g.nextVest.date)}: <Private>{num(g.nextVest.shares)}</Private> options
          </>
        ),
      })
    }
    if (g.status === 'awaiting_board') events.push({ date: t, icon: 'coins', text: 'Grant awaiting board consent' })
  }
  if (can('training') && status !== 'alumni') {
    for (const r of trainingRequirements(db, person, t)) {
      if (!r.dueOn || r.status === 'done' || r.status === 'not_required') continue
      const late = r.status === 'overdue'
      events.push({
        date: r.dueOn,
        icon: 'shield-check',
        tone: late ? (r.required ? 'bad' : 'warn') : undefined,
        text: `${r.title} ${late ? 'was due' : 'due'} ${dayLabel(r.dueOn)}${r.required ? '' : ' (recommended)'}`,
      })
    }
  }
  // A leaver's anniversaries, vests and trainings after the last day never happen (cut only where the
  // viewer may know the last day, so the list itself never gives a pending departure away).
  const until = separationVisible || status === 'alumni' ? person.endDate : undefined
  const upcoming = (until ? events.filter((e) => e.date <= until) : events).sort((a, b) => a.date.localeCompare(b.date))

  const lists = can('checklists') ? db.checklists.filter((c) => c.personId === person.id && !c.completedOn) : []

  return (
    // Columns follow the page area (a container query), so 150% text and the rail both count.
    <div className="@container">
      <div className="ft-split ft-split--person grid grid-cols-1 gap-4 @[640px]:grid-cols-3">
        <div className="@container flex min-w-0 flex-col gap-4 @[640px]:col-span-2">
          <Panel title="Key facts">
            <DescriptionList
              items={[
                { label: 'Employee number', value: <span className="font-mono font-semibold">#{person.hireNumber}</span> },
                { label: 'Title', value: person.title },
                { label: 'Team', value: departmentName(db, person.departmentId) },
                { label: 'Manager', value: <PersonLink person={manager} /> },
                {
                  label: 'Direct reports',
                  value: reports.length ? (
                    <span className="-my-2.5 flex flex-col">
                      {reports.map((r) => (
                        <PersonLink key={r.id} person={r} inline={false} />
                      ))}
                    </span>
                  ) : (
                    <span className="text-ink-3">None</span>
                  ),
                },
                { label: 'Location', value: personLocation(db, person) },
                { label: 'Work mode', value: WORK_MODE[person.workMode] },
                { label: 'Start date', value: fmtDate(person.startDate) },
                { label: 'Tenure', value: person.startDate > t ? 'Not started yet' : fmtDuration(person.startDate, person.endDate && person.endDate < t ? person.endDate : t) },
                { label: 'Work email', value: <WorkEmail person={person} /> },
                {
                  label: 'Rehire of',
                  value: earlier ? <PersonLink person={earlier} suffix={` (${fmtMonth(earlier.startDate)} to ${fmtMonth(earlier.endDate)})`} /> : '',
                  hidden: !earlier || !can('job'),
                },
                { label: 'Rehired as', value: <PersonLink person={backAs} />, hidden: !backAs || !can('job') },
                { label: 'Level', value: levelLabel(db, person.levelId), hidden: !can('job') },
                { label: 'Employment', value: `${EMPLOYMENT[person.employmentType]}, ${person.hoursPerWeek} hours a week`, hidden: !can('job') },
                {
                  label: 'Overtime status',
                  value: person.flsa === 'exempt' ? `Exempt${person.exemptionBasis ? ` (${person.exemptionBasis.replace('_', ' ')})` : ''}` : 'Non-exempt',
                  hidden: !can('job'),
                },
                { label: 'Phone', value: person.phone, hidden: !can('emergency') },
                { label: 'Personal email', value: person.personalEmail, hidden: !can('emergency') },
                {
                  label: 'Background check',
                  value: person.backgroundCheck
                    ? person.backgroundCheck.status === 'clear'
                      ? `Clear${person.backgroundCheck.completedOn ? ` ${fmtDate(person.backgroundCheck.completedOn)}` : ''}`
                      : person.backgroundCheck.status === 'pending'
                        ? 'Pending'
                        : 'Not required'
                    : 'Not recorded',
                  hidden: !canSeeBackgroundDetail(viewer),
                },
                {
                  label: 'Hired from',
                  value: person.fromCandidateId ? (
                    <a className={`-my-2.5 ${LINK}`} href={links.candidate(person.fromCandidateId)}>
                      Candidate record
                    </a>
                  ) : person.fromContractorId && db.contractors.some((k) => k.id === person.fromContractorId) ? (
                    <a className={`-my-2.5 ${LINK}`} href={links.contractor(person.fromContractorId)}>
                      Converted from a contractor
                    </a>
                  ) : earlier ? (
                    'Rehired by hand'
                  ) : (
                    'Added by hand'
                  ),
                  hidden: viewer.role !== 'admin',
                },
              ]}
            />
            {person.bio && <p className="mt-4 text-[14px] text-ink-2">{person.bio}</p>}
          </Panel>
          {lists.length > 0 && (
            <Panel
              title="Checklists in progress"
              actions={
                <a href={links.person(person.id, 'checklists')} className="inline-flex min-h-10 items-center gap-1 text-[13.5px] font-semibold text-accent hover:underline">
                  All checklists and documents <Icon name="arrow-right" size={14} />
                </a>
              }
            >
              <div className="grid grid-cols-1 gap-3 @[560px]:grid-cols-2">
                {lists.map((c) => (
                  <ChecklistCard key={c.id} checklist={c} />
                ))}
              </div>
            </Panel>
          )}
        </div>
        <div className="ft-split__side flex min-w-0 flex-col gap-4">
          <Panel title="Coming up">
            {upcoming.length === 0 ? (
              <p className="text-[14px] text-ink-3">Nothing scheduled.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {upcoming.slice(0, 8).map((e, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-[14px]">
                    <Icon name={e.icon} size={17} className={e.tone === 'bad' ? 'mt-0.5 shrink-0 text-bad' : e.tone === 'warn' ? 'mt-0.5 shrink-0 text-warn' : 'mt-0.5 shrink-0 text-ink-3'} />
                    <span className={e.tone === 'bad' ? 'font-semibold text-bad' : 'text-ink-2'}>{e.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {leave && can('timeoff') && <LeavePanel personId={person.id} />}
          {person.separation && can('separation') && <ExitPanel person={person} />}
        </div>
      </div>
    </div>
  )
}

function LeavePanel({ personId }: { personId: ID }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const t = today()
  const showType = canSeePerson(viewer, db, personId, 'leave')
  const leave = db.leaveCases
    .filter((l) => l.personId === personId && !l.returnedOn && !l.endedOn && (!l.expectedReturn || l.expectedReturn > t))
    .sort((a, b) => a.startDate.localeCompare(b.startDate))[0]
  if (!leave) return null
  const current = onLeave(db, personId, t)
  return (
    <Panel title={showType ? LEAVE_KIND_LABEL[leave.kind] : 'Leave'} icon="plane">
      <DescriptionList
        columns={1}
        items={[
          { label: current ? 'On leave since' : 'Starts', value: fmtDate(leave.startDate) },
          { label: 'Expected first day back', value: leave.expectedReturn ? fmtDate(leave.expectedReturn) : 'Not set' },
          { label: 'Requested', value: fmtDate(leave.requestedOn), hidden: !showType },
          {
            label: 'Designation notice',
            value: leave.designationNoticeSentOn ? (
              `Sent ${fmtDate(leave.designationNoticeSentOn)}`
            ) : leave.designationNoticeDueOn ? (
              <span className={leave.designationNoticeDueOn < t ? 'font-semibold text-bad' : ''}>Due {dayLabel(leave.designationNoticeDueOn)}</span>
            ) : (
              'Not needed'
            ),
            hidden: !showType,
          },
        ]}
      />
      {showType ? (
        <p className="mt-3 text-[13px] text-ink-3">No medical details are stored. Managers and teammates see only 'Leave, back' and the date.</p>
      ) : (
        <p className="mt-3 text-[13px] text-ink-3">The type of leave stays private.</p>
      )}
    </Panel>
  )
}

function ExitPanel({ person }: { person: Person }) {
  const db = useDB((s) => s.db)
  const sep = person.separation
  if (!sep) return null
  const keep = personRetention(person)
  const cl = db.checklists.find((c) => c.personId === person.id && c.kind === 'offboarding')
  return (
    <Panel title="Exit" icon="log-out">
      <DescriptionList
        columns={1}
        items={[
          { label: 'Type', value: SEPARATION_LABEL[sep.type] },
          { label: 'Reason', value: sep.reason },
          { label: 'Notice given', value: sep.noticeGivenOn ? fmtDate(sep.noticeGivenOn) : '', hidden: !sep.noticeGivenOn },
          { label: 'Last day', value: fmtDate(sep.lastDay) },
          { label: 'Final pay due', value: sep.finalPayDueOn ? fmtDate(sep.finalPayDueOn) : 'Not recorded' },
          { label: 'Rehire eligible', value: sep.rehireEligible == null ? 'Not recorded' : sep.rehireEligible ? 'Yes' : 'No' },
          {
            label: 'Vested options',
            value: sep.vestedAtSeparation ? (
              <>
                <Private>{num(sep.vestedAtSeparation)}</Private>, exercise by {fmtDate(sep.exerciseDeadline)}
              </>
            ) : (
              'None'
            ),
          },
          { label: 'Keep personnel records until', value: keep.personnelFile ? fmtDate(keep.personnelFile) : '' },
          { label: 'Keep the I-9 until', value: keep.i9 ? fmtDate(keep.i9) : '' },
        ]}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {cl && (
          <a href={links.checklist(cl.id)} className="inline-flex min-h-10 items-center gap-1 text-[13.5px] font-semibold text-accent hover:underline">
            Offboarding checklist <Icon name="arrow-right" size={14} />
          </a>
        )}
        <CitationChip label="Gov Code 12946" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=12946.&lawCode=GOV" />
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// Emergency contacts (SB 294)
// ---------------------------------------------------------------------------------------------

const RELATIONS = ['Partner', 'Spouse', 'Parent', 'Sibling', 'Child', 'Friend']

function ContactForm({ initial, onSave, onCancel, saveLabel }: { initial: EmergencyContact; onSave: (c: EmergencyContact) => void; onCancel: () => void; saveLabel: string }) {
  const [c, setC] = useState<EmergencyContact>(initial)
  const [tried, setTried] = useState(false)
  const other = !RELATIONS.includes(c.relation)
  const valid = c.name.trim() && c.phone.trim() && c.relation.trim()
  return (
    <div className="rounded-xl border border-line bg-surface-2/50 p-4">
      <FormGrid>
        <Field label="Name" required error={tried && !c.name.trim() ? 'Add a name.' : undefined}>
          {(id, d) => <TextInput id={id} aria-describedby={d} maxLength={LINE_MAX_CHARS} value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} data-autofocus autoComplete="off" />}
        </Field>
        <Field label="Phone" required error={tried && !c.phone.trim() ? 'Add a phone number.' : undefined}>
          {(id, d) => <TextInput id={id} aria-describedby={d} type="tel" inputMode="tel" maxLength={LINE_MAX_CHARS} value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} autoComplete="off" />}
        </Field>
      </FormGrid>
      <Field label="Relationship" className="mt-4" id={`rel-${initial.name || 'new'}`}>
        {() => (
          <div className="flex flex-col gap-2">
            <ChipGroup
              label="Relationship"
              size="sm"
              value={other ? 'Other' : c.relation}
              onChange={(v) => setC({ ...c, relation: v === 'Other' ? '' : v })}
              options={[...RELATIONS, 'Other'].map((r) => ({ value: r, label: r }))}
            />
            {other && (
              <TextInput
                aria-label="Relationship (other)"
                placeholder="For example: roommate"
                maxLength={LINE_MAX_CHARS}
                value={c.relation}
                onChange={(e) => setC({ ...c, relation: e.target.value })}
              />
            )}
          </div>
        )}
      </Field>
      <Checkbox
        className="mt-3"
        checked={!!c.sb294Notify}
        onChange={(v) => setC({ ...c, sb294Notify: v })}
        label="Also notify this contact if I am arrested or detained at work"
        description="California SB 294 lets each employee choose this. It can be changed at any time."
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={() => {
            setTried(true)
            if (valid) onSave({ ...c, name: c.name.trim(), phone: c.phone.trim(), relation: c.relation.trim() })
          }}
        >
          {saveLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function EmergencyContacts({ person }: { person: Person }) {
  const viewer = useViewer()
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const self = viewer.personId === person.id
  const canEdit = viewer.role === 'admin' || self
  const contacts = person.emergencyContacts
  const who = self ? 'your' : `${person.preferredName || person.firstName}'s`

  const write = (label: string, next: EmergencyContact[]) => {
    useDB.getState().mutate(label, (d) => {
      const p = d.people.find((x) => x.id === person.id)
      if (!p) return
      p.emergencyContacts = next
      logActivity(d, { entityType: 'person', entityId: person.id, kind: 'emergency_contacts', text: `Updated emergency contacts for ${fullName(person)}` })
    })
    undoToast(label)
    setEditing(null)
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Emergency contacts"
        subtitle={canEdit ? `Edit ${who} contacts in place. Only Admin and ${self ? 'you' : person.preferredName || person.firstName} can see them.` : undefined}
        actions={
          canEdit && editing === null ? (
            <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
              Add contact
            </Button>
          ) : undefined
        }
      >
        {contacts.length === 0 && editing !== 'new' && (
          <EmptyState compact icon="phone" title="No emergency contacts yet" body="Add at least one. You can also choose who to tell if an arrest or detention happens at work (SB 294)." />
        )}
        <ul className="flex flex-col gap-3">
          {contacts.map((c, i) =>
            editing === i ? (
              <li key={i}>
                <ContactForm
                  initial={c}
                  saveLabel="Save contact"
                  onCancel={() => setEditing(null)}
                  onSave={(next) => write(`Updated ${c.name} as an emergency contact`, contacts.map((x, j) => (j === i ? next : x)))}
                />
              </li>
            ) : (
              <li key={i} className="flex flex-col gap-3 rounded-xl border border-line px-4 py-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink">
                    {c.name} <span className="font-normal text-ink-3">({c.relation})</span>
                  </p>
                  <p className="text-[14px] text-ink-2">
                    <a href={`tel:${c.phone}`} className="-my-2.5 inline-flex min-h-10 items-center hover:text-accent">
                      {c.phone}
                    </a>
                  </p>
                  {c.sb294Notify ? (
                    <Badge tone="accent" icon="shield" className="mt-1.5">
                      Notify if arrested or detained at work
                    </Badge>
                  ) : (
                    <p className="mt-1 text-[13px] text-ink-3">Not chosen for arrest or detention notices</p>
                  )}
                </div>
                {canEdit && editing === null && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" icon="edit" aria-label={`Edit ${c.name}`} onClick={() => setEditing(i)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      icon="trash"
                      aria-label={`Remove ${c.name}`}
                      onClick={() => write(`Removed ${c.name} as an emergency contact`, contacts.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            ),
          )}
          {editing === 'new' && (
            <li>
              <ContactForm
                initial={{ name: '', relation: 'Partner', phone: '', sb294Notify: false }}
                saveLabel="Add contact"
                onCancel={() => setEditing(null)}
                onSave={(next) => write(`Added ${next.name} as an emergency contact`, [...contacts, next])}
              />
            </li>
          )}
        </ul>
      </Panel>
      <Callout tone="neutral" icon="info" title="About SB 294">
        <p>
          The Workplace Know Your Rights Act lets each employee name a contact the company tells if they are arrested or detained at work. Employees
          choose yes or no per contact and can change it any time. Home addresses are never stored here.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <CitationChip label="Labor Code 1553 and 1555 (SB 294)" url="https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=1553.&lawCode=LAB" />
        </div>
        <p className="mt-2 text-[12.5px] text-ink-3">Not legal advice; confirm with counsel or your PEO.</p>
      </Callout>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Documents (status, date and a link, never the file)
// ---------------------------------------------------------------------------------------------

const DOC_TYPE: Record<DocumentRecord['type'], string> = {
  offer_letter: 'Offer letter',
  piia: 'PIIA',
  i9_section1: 'I-9 section 1',
  i9_section2: 'I-9 section 2',
  wage_notice_2810_5: 'Labor Code 2810.5 notice',
  notice: 'Notice',
  handbook_ack: 'Handbook acknowledgement',
  grant_agreement: 'Grant agreement',
  election_83b: '83(b) election',
  other: 'Other',
}
const DOC_STATUS: Record<DocumentRecord['status'], string> = { not_sent: 'Not sent', sent: 'Sent', signed: 'Signed', filed: 'Filed', delivered: 'Delivered' }

function Documents({ person }: { person: Person }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const admin = viewer.role === 'admin'
  const docs = db.documents.filter((d) => d.personId === person.id).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
  const [adding, setAdding] = useState(false)
  const t = today()
  const [form, setForm] = useState<{ type: DocumentRecord['type']; name: string; status: DocumentRecord['status']; date: ISODate; link: string }>({
    type: 'other',
    name: '',
    status: 'signed',
    date: t,
    link: '',
  })
  const save = () => {
    const name = form.name.trim() || DOC_TYPE[form.type]
    const label = `Added the ${name} record for ${fullName(person)}`
    useDB.getState().mutate(label, (d) => {
      const rec: DocumentRecord = { id: newId('doc'), personId: person.id, type: form.type, name, status: form.status, date: form.date }
      if (form.link.trim()) rec.link = form.link.trim()
      d.documents.push(rec)
      logActivity(d, { entityType: 'person', entityId: person.id, kind: 'document_added', text: label })
    })
    undoToast(label)
    setAdding(false)
    setForm({ type: 'other', name: '', status: 'signed', date: t, link: '' })
  }
  return (
    <Panel
      title="Documents"
      subtitle="Status, date and a link to where the file lives. Files themselves stay with the PEO, e-sign tool or Drive."
      actions={
        admin && !adding ? (
          <Button variant="secondary" icon="plus" onClick={() => setAdding(true)}>
            Add a record
          </Button>
        ) : undefined
      }
    >
      {adding && (
        <div className="mb-4 rounded-xl border border-line bg-surface-2/50 p-4">
          <FormGrid>
            <Field label="Type">
              {(id) => (
                <Select
                  id={id}
                  value={form.type}
                  onChange={(v) => setForm((f) => ({ ...f, type: v }))}
                  options={(Object.keys(DOC_TYPE) as Array<DocumentRecord['type']>).map((k) => ({ value: k, label: DOC_TYPE[k] }))}
                />
              )}
            </Field>
            <Field label="Name" hint="Optional">
              {(id, d) => (
                <TextInput
                  id={id}
                  aria-describedby={d}
                  maxLength={LINE_MAX_CHARS}
                  value={form.name}
                  placeholder={DOC_TYPE[form.type]}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              )}
            </Field>
          </FormGrid>
          <Field label="Status" className="mt-4" id="doc-status">
            {() => (
              <ChipGroup
                label="Status"
                size="sm"
                value={form.status}
                onChange={(v) => setForm((f) => ({ ...f, status: v }))}
                options={(Object.keys(DOC_STATUS) as Array<DocumentRecord['status']>).map((k) => ({ value: k, label: DOC_STATUS[k] }))}
              />
            )}
          </Field>
          <Field label="Date" className="mt-4" id="doc-date">
            {(id) => (
              <DateChips
                id={id}
                label="Date"
                value={form.date}
                onChange={(v) => setForm((f) => ({ ...f, date: v }))}
                presets={[
                  { label: 'Today', date: t },
                  { label: 'Yesterday', date: addDays(t, -1) },
                ]}
              />
            )}
          </Field>
          <Field label="Link to the file" className="mt-4" hint="Where it lives. Never upload the file here.">
            {(id, d) => (
              <TextInput
                id={id}
                aria-describedby={d}
                type="url"
                maxLength={LINK_MAX_CHARS}
                value={form.link}
                placeholder="https://"
                onChange={(e) => setForm((f) => ({ ...f, link: e.target.value }))}
              />
            )}
          </Field>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onClick={save}>
              Add record
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {docs.length === 0 ? (
        <p className="text-[14px] text-ink-3">No document records yet.</p>
      ) : (
        <ul className="flex flex-col">
          {docs.map((d) => (
            <li key={d.id} className="flex flex-col gap-1 border-b border-line py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-3">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-ink">{d.name}</span>
                <span className="block text-[13px] text-ink-3">
                  {DOC_TYPE[d.type]}
                  {d.retainUntil ? `, keep until ${fmtDate(d.retainUntil)}` : ''}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={d.status === 'not_sent' ? 'warn' : d.status === 'sent' ? 'neutral' : 'good'}>
                  {DOC_STATUS[d.status]}
                  {d.date ? ` ${fmtDate(d.date)}` : ''}
                </Badge>
                {d.link && (
                  <a href={d.link} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-10 items-center gap-1 text-[13.5px] font-semibold text-accent hover:underline">
                    Open <Icon name="external" size={12} />
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// Activity (admin)
// ---------------------------------------------------------------------------------------------

function ActivityList({ person }: { person: Person }) {
  const db = useDB((s) => s.db)
  const latest = useLatestChange()
  const listRef = useRef<HTMLOListElement>(null)
  const [limit, setLimit] = useState(40)
  const rows = useMemo(() => {
    const checklistIds = new Set(db.checklists.filter((c) => c.personId === person.id).map((c) => c.id))
    return db.activity
      .filter((a) => a.entityId === person.id || a.relatedId === person.id || checklistIds.has(a.entityId))
      .sort((a, b) => b.at.localeCompare(a.at))
  }, [db, person.id])
  // Undo sits on the newest row the latest change wrote (one change can write several rows).
  const undoRowId = latest ? rows.find((a) => latest.activityIds.has(a.id))?.id : undefined
  return (
    <Panel
      title="Activity"
      subtitle="Every change to this person's record, newest first. The latest change made in this browser session can be undone from its row, even after the toast is gone."
    >
      {rows.length === 0 ? (
        <p className="text-[14px] text-ink-3">No activity yet.</p>
      ) : (
        <>
          <ol ref={listRef} tabIndex={-1} aria-label={`Activity for ${fullName(person)}`} className="flex flex-col outline-none">
            {rows.slice(0, limit).map((a) => {
              const actor = getPerson(db, a.actorId)
              const canUndo = !!latest && a.id === undoRowId
              return (
                <li key={a.id} className="flex flex-col gap-2 border-b border-line py-2.5 last:border-b-0 sm:flex-row sm:items-center sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] text-ink">{a.text}</p>
                    <p className="text-[12.5px] text-ink-3">
                      {fmtDateTime(a.at)}
                      {actor ? `, ${fullName(actor)}` : ''}
                      {a.viewingAs && a.viewingAs !== 'admin' ? ` (recorded in ${ROLE_LABEL[a.viewingAs]} preview)` : ''}
                    </p>
                  </div>
                  {canUndo && latest && (
                    <Button
                      variant="secondary"
                      icon="rotate-ccw"
                      className="self-start sm:self-center"
                      aria-label={`Undo: ${latest.label}`}
                      onClick={() => {
                        if (undoChange(latest.entryId, latest.label)) requestAnimationFrame(() => listRef.current?.focus())
                      }}
                    >
                      Undo
                    </Button>
                  )}
                </li>
              )
            })}
          </ol>
          {rows.length > limit && (
            <Button className="mt-3" variant="ghost" icon="chevron-down" onClick={() => setLimit((n) => n + 40)}>
              Show more ({rows.length - limit} older)
            </Button>
          )}
        </>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

export function PersonPage({ route }: PageProps) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const id = route.segments[1]
  const seg = route.segments[2]
  const person = getPerson(db, id)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [rehireOpen, setRehireOpen] = useState(false)
  // Built once per opening, so the sheet resets to it (a new object every render would reset it each time).
  const rehirePrefill = useMemo(() => (rehireOpen && person ? prefillForRehire(useDB.getState().db, person.id) : undefined), [rehireOpen, person?.id])
  const t = today()

  if (!person) {
    const contractor = db.contractors.find((c) => c.id === id)
    const undone = contractor ? null : undoneLabelFor((d) => d.people.some((p) => p.id === id))
    if (undone) {
      return (
        <EmptyState
          icon="rotate-ccw"
          title="This change was undone"
          body={`Undid: ${undone}. The record is no longer in this workspace.`}
          action={
            <a href={links.people()} className="inline-flex min-h-10 items-center font-bold text-accent underline">
              Back to People
            </a>
          }
        />
      )
    }
    return (
      <EmptyState
        icon="search"
        title={contractor ? `${contractor.name} is a ${contractor.kind}` : 'No one with that link'}
        body={contractor ? 'Contractors and advisors have their own page.' : 'This link does not match anyone in this workspace. Data lives in each browser, so someone added in another browser is not here.'}
        action={
          <a href={contractor ? links.contractor(contractor.id) : links.people()} className="inline-flex min-h-10 items-center font-bold text-accent underline">
            {contractor ? 'Open their page' : 'Back to People'}
          </a>
        }
      />
    )
  }

  const can = (a: PersonArea) => canSeePerson(viewer, db, person.id, a)
  const admin = viewer.role === 'admin'
  const status = personDirStatus(db, person, t)
  const leave = onLeave(db, person.id, t)
  const manager = getPerson(db, person.managerId)
  const name = fullName(person)
  const allTabs: Array<{ key: TabKey; label: string; show: boolean }> = [
    { key: 'overview', label: 'Overview', show: true },
    { key: 'job', label: 'Job and pay', show: can('job') || can('band') || can('pay') },
    { key: 'equity', label: 'Equity', show: can('equity') },
    { key: 'timeoff', label: 'Time off', show: can('timeoff') },
    { key: 'checklists', label: 'Checklists and documents', show: can('checklists') },
    { key: 'emergency', label: 'Emergency contacts', show: can('emergency') },
    { key: 'activity', label: 'Activity', show: can('activity') },
  ]
  const tabs = allTabs.filter((x) => x.show)
  const requested = (['overview', 'job', 'equity', 'timeoff', 'checklists', 'emergency', 'activity'] as TabKey[]).includes(seg as TabKey) ? (seg as TabKey) : 'overview'
  const allowed = tabs.some((x) => x.key === requested)
  const tab: TabKey = allowed ? requested : 'overview'
  const offboardOpen = seg === 'offboard' && admin
  const changeOpen = seg === 'change' && admin
  const closeSheet = () => replaceRoute('person', person.id)
  const alumni = status === 'alumni'
  // Rehire is offered until a newer record for the same person exists.
  const rehiredAs = db.people.find((p) => p.rehireOfPersonId === person.id)

  return (
    <>
      <header className="ft-personhead flex flex-wrap items-start justify-between gap-x-6 gap-y-4 pb-5">
        <div className="min-w-0">
          <a href={links.people()} className="ft-pagehead__back mb-2 inline-flex min-h-10 items-center gap-1 text-[13.5px] font-semibold text-ink-3 hover:text-ink">
            <Icon name="arrow-left" size={15} />
            People
          </a>
          <div className="flex items-start gap-4">
            {/* Wrappers carry the breakpoint display: Avatar's own inline-flex would beat a 'hidden' on it. */}
            <span className="hidden shrink-0 sm:inline-flex">
              <Avatar name={name} size={64} muted={alumni} />
            </span>
            <span className="inline-flex shrink-0 sm:hidden">
              <Avatar name={name} size={48} muted={alumni} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2.5">
                <EmpNo n={person.hireNumber} className="text-[15px]" />
                <h1 className="ft-pagehead__title min-w-0 text-[26px] leading-tight font-bold break-words text-ink sm:text-[30px]">{name}</h1>
              </div>
              <p className="mt-0.5 text-[15px] text-ink-2">
                {person.title}, {departmentName(db, person.departmentId)}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13.5px] text-ink-2">
                <PersonStatusBadge db={db} person={person} status={status} leave={leave} showLeaveType={can('leave')} showLastDay={canSeeSeparation(viewer, db, person.id)} />
                {manager && (
                  <span>
                    Reports to <PersonLink person={manager} />
                  </span>
                )}
                <span className="inline-flex items-center gap-1">
                  <Icon name="pin" size={14} className="text-ink-3" />
                  {personLocation(db, person)}, {WORK_MODE[person.workMode].toLowerCase()}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Icon name="clock" size={14} className="text-ink-3" />
                  {person.startDate > t
                    ? startsInText(person.startDate, t).replace(/^s/, 'S')
                    : alumni
                      ? `Was here ${fmtDuration(person.startDate, person.endDate ?? t)}`
                      : `Here ${fmtDuration(person.startDate, t)}`}
                </span>
              </div>
            </div>
          </div>
        </div>
        {admin && (
          <div className="ft-pagehead__actions flex flex-wrap items-center gap-2">
            {alumni && !rehiredAs && (
              <Button variant="primary" icon="user-plus" onClick={() => setRehireOpen(true)}>
                Rehire
              </Button>
            )}
            {!alumni && (
              <>
                <Button variant="primary" icon="trend" data-change-job onClick={() => navigate('person', person.id, 'change')}>
                  Change job or pay
                </Button>
                {!leave && (
                  <Button variant="secondary" icon="plane" onClick={() => setLeaveOpen(true)}>
                    Start leave
                  </Button>
                )}
                {!person.separation && (
                  <Button variant="secondary" icon="log-out" onClick={() => navigate('person', person.id, 'offboard')}>
                    Offboard
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </header>

      <Tabs label={`${name} profile`} value={tab} tabs={tabs.map((x) => ({ key: x.key, label: x.label, href: links.person(person.id, x.key) }))} className="mb-5" />

      {!allowed && seg && seg !== 'offboard' && seg !== 'change' && (
        <Callout tone="neutral" icon="lock" className="mb-4" title="Not part of this view">
          That tab is hidden in {ROLE_LABEL[viewer.role]} view. Showing the overview instead.
        </Callout>
      )}

      {tab === 'overview' && <Overview person={person} />}
      {tab === 'job' && <PersonJobPayPanel personId={person.id} hideAction={admin && !alumni} />}
      {tab === 'equity' && <PersonEquityPanel personId={person.id} />}
      {tab === 'timeoff' && <PersonTimeOffPanel personId={person.id} />}
      {tab === 'checklists' && (
        <div className="flex flex-col gap-4">
          <PersonChecklistsPanel personId={person.id} />
          {(admin || viewer.personId === person.id) && <Documents person={person} />}
          {can('training') && <PersonTrainingPanel personId={person.id} />}
        </div>
      )}
      {tab === 'emergency' && <EmergencyContacts person={person} />}
      {tab === 'activity' && <ActivityList person={person} />}

      {admin && (
        <>
          <OffboardSheet personId={person.id} open={offboardOpen} onClose={closeSheet} />
          <ChangeJobSheet personId={person.id} open={changeOpen} onClose={closeSheet} />
          <StartLeaveSheet personId={person.id} open={leaveOpen} onClose={() => setLeaveOpen(false)} />
          {alumni && (
            <AddPersonSheet
              open={rehireOpen}
              prefill={rehirePrefill}
              onClose={() => setRehireOpen(false)}
              onCreated={(newId) => {
                setRehireOpen(false)
                navigate('person', newId)
              }}
            />
          )}
        </>
      )}
    </>
  )
}
