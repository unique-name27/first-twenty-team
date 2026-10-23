// The one leave case sheet, used by the Time off tab, the Request sheet and the profile's Start leave.
// Admin opens a case of any kind for anyone. A person requests family or medical leave (CFRA, pregnancy
// disability or bonding) for themselves: that opens the case with today as the request date, so the
// 5-business-day response and designation notice lands in Admin's inbox. Shows the eligibility hint and the
// notice deadline; startLeave builds the leave checklist. No medical details are stored, and only Admin and
// the person see the type.
import { useState } from 'react'
import { useViewer } from '@/app/useViewer'
import { holidayDates } from '@/domain/checklists/generate'
import { leaveEligibility, startLeave } from '@/domain/lifecycle'
import { employedOn, fullName, incomingOn } from '@/domain/people'
import type { ID, LeaveCase } from '@/domain/types'
import { addBusinessDays, addDays, addMonths, fmtDay, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Badge, Button, Callout, ChipGroup, DateChips, Field, Icon, SectionLabel, Select, Sheet, TextArea, toast } from '@/ui'
import {
  defaultLeaveReturn,
  LEAVE_KIND_LABEL,
  leaveDatesValid,
  leaveKindsFor,
  leaveSheetMode,
  leaveStartPresets,
  nextWorkdayOnOrAfter,
  noteCountText,
  TIMEOFF_NOTE_MAX_CHARS,
} from './logic'
import { LEAVE_LINKS, LegalNote } from './parts'

const KIND_HINT: Record<LeaveCase['kind'], string> = {
  bonding: 'Bonding with a new child by birth, adoption or foster placement',
  cfra: "Own or a family member's serious health condition",
  pdl: 'Disabled by pregnancy, childbirth or a related condition',
  military: 'Military service or training',
  other: 'Another leave of absence the company grants',
}

/**
 * personId: open the sheet for that person (no person picker). Without it, Admin picks the person.
 * A non-admin can only use it for their own request.
 */
export function StartLeaveSheet(props: { open: boolean; onClose: () => void; personId?: ID }) {
  if (!props.open) return null
  return <StartLeaveInner {...props} />
}

function StartLeaveInner({ onClose, personId }: { onClose: () => void; personId?: ID }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const t = today()
  const mode = leaveSheetMode(viewer, personId)
  const self = mode === 'self'
  const people = [...employedOn(db, t), ...incomingOn(db, t)].sort((a, b) => a.hireNumber - b.hireNumber)
  const [pid, setPid] = useState<ID>(personId ?? people[0]?.id ?? '')
  const kinds = leaveKindsFor(mode)
  const [kind, setKind] = useState<LeaveCase['kind']>('bonding')
  const [requestedOn, setRequestedOn] = useState<string>(t)
  const [startDate, setStartDate] = useState<string | null>(null)
  const [expectedReturn, setExpectedReturn] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const person = db.people.find((p) => p.id === pid)
  const holidays = holidayDates(db)

  if (mode === 'none') {
    return (
      <Sheet open onClose={onClose} title="Start a leave case">
        <Callout tone="neutral" title="Admin opens leave cases">
          Leave types stay private, so only Admin, or the person asking for their own leave, can open one. Switch to Admin under Viewing as.
        </Callout>
      </Sheet>
    )
  }

  // A person's own request is dated today: the response clock starts when they ask.
  const askedOn = self ? t : requestedOn
  const designationDue = addBusinessDays(askedOn, 5, holidays)
  const elig = person && startDate ? leaveEligibility(db, person.id, kind, startDate) : null
  const startChips = leaveStartPresets(t, db.holidays)
  const returnChips = startDate
    ? [
        { label: '6 weeks', date: nextWorkdayOnOrAfter(addDays(startDate, 42), db.holidays) },
        { label: '8 weeks', date: nextWorkdayOnOrAfter(addDays(startDate, 56), db.holidays) },
        { label: '12 weeks', date: defaultLeaveReturn(startDate, db.holidays) },
        { label: '4 months', date: nextWorkdayOnOrAfter(addMonths(startDate, 4), db.holidays) },
      ]
    : []
  const valid = !!person && kinds.includes(kind) && leaveDatesValid(startDate, expectedReturn)
  const name = person ? fullName(person) : ''
  const noteCount = noteCountText(note)

  const submit = () => {
    if (!valid || !person || !startDate || !expectedReturn) return
    const label = self ? `Leave request sent to Admin: starts ${fmtDay(startDate)}` : `Opened a leave case for ${name}`
    useDB.getState().mutate(label, (d) => {
      startLeave(
        d,
        {
          personId: person.id,
          kind,
          requestedOn: askedOn,
          startDate,
          expectedReturn,
          ...(!self && note.trim() ? { note: note.trim() } : {}),
        },
        { date: t, actorId: viewer.personId },
      )
    })
    toast({ text: label, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
    onClose()
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={self ? 'Request family or medical leave' : personId && person ? `Start a leave case for ${name}` : 'Start a leave case'}
      subtitle={self ? 'Admin replies within 5 business days. You never need to share medical details.' : 'Protected leave with its notice, checklist and return date'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" icon={self ? 'send' : 'shield'} disabled={!valid} onClick={submit}>
            {self ? 'Send to Admin' : 'Open leave case'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {!personId && (
          <Field label="Person">
            {(id) => <Select id={id} value={pid} onChange={setPid} options={people.map((p) => ({ value: p.id, label: `${fullName(p)} (#${p.hireNumber})` }))} />}
          </Field>
        )}

        <div className="flex flex-col gap-2">
          <SectionLabel>Type of leave</SectionLabel>
          <ChipGroup label="Type of leave" value={kind} onChange={setKind} options={kinds.map((k) => ({ value: k, label: LEAVE_KIND_LABEL[k] }))} />
          <p className="text-[13px] text-ink-3">
            {KIND_HINT[kind]}. {self ? 'You never need to share a diagnosis or any medical details.' : 'Do not record a diagnosis or any medical details.'}
          </p>
        </div>

        {!self && (
          <Field label="Requested on">
            {(id) => (
              <DateChips
                id={id}
                label="Requested on"
                value={requestedOn}
                onChange={setRequestedOn}
                presets={[
                  { label: 'Today', date: t },
                  { label: 'Yesterday', date: addDays(t, -1) },
                  { label: '2 days ago', date: addDays(t, -2) },
                ]}
              />
            )}
          </Field>
        )}

        <Field label="First day of leave">
          {(id) => (
            <DateChips
              id={id}
              label="First day of leave"
              value={startDate}
              onChange={(d) => {
                setStartDate(d)
                setExpectedReturn((r) => (r && r > d ? r : defaultLeaveReturn(d, db.holidays)))
              }}
              presets={startChips}
            />
          )}
        </Field>

        {startDate && (
          <Field
            label="Expected first day back"
            hint={`CFRA and bonding allow up to 12 workweeks; pregnancy disability up to 4 months. ${self ? 'Your best guess is fine; tell Admin if it changes.' : 'The return-to-work check follows it.'}`}
          >
            {(id) => <DateChips id={id} label="Expected first day back" value={expectedReturn} onChange={setExpectedReturn} presets={returnChips} min={addDays(startDate, 1)} />}
          </Field>
        )}

        <div className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[14px]">
          <p className="flex items-center gap-2 font-semibold text-ink">
            <Icon name="clock" size={16} className="text-ink-3" />
            {self ? `Admin responds by ${fmtDay(designationDue)}` : `Response and designation notice due ${fmtDay(designationDue)}`}
          </p>
          <p className="mt-0.5 text-[13px] text-ink-2">
            {self
              ? `Admin sends a response and designation notice within 5 business days of your request (today, ${fmtDay(askedOn)}).`
              : `5 business days after the request (${fmtDay(askedOn)}), skipping weekends and company holidays.`}
          </p>
          <div className="mt-2">
            <LegalNote label={LEAVE_LINKS.designation.label} url={LEAVE_LINKS.designation.url} />
          </div>
        </div>

        {elig && person && (
          <div className="flex flex-col gap-2 rounded-xl border border-line px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink">{self ? 'Eligibility hint' : `Eligibility hint for ${name}`}</span>
              <Badge tone={elig.eligible ? 'good' : 'warn'} icon={elig.eligible ? 'check' : 'alert'}>
                {elig.eligible ? 'Likely eligible' : 'Check eligibility'}
              </Badge>
            </div>
            <ul className="list-disc pl-5 text-[13.5px] text-ink-2">
              {elig.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {self && <p className="text-[13px] text-ink-3">Admin confirms eligibility. Send the request either way.</p>}
            <LegalNote label={LEAVE_LINKS.cfra.label} url={LEAVE_LINKS.cfra.url} />
          </div>
        )}

        {self ? (
          <Callout tone="neutral" icon="info" title="What happens next">
            Admin gets your request in their inbox and sends the notice. Your manager and teammates see only &quot;Leave, back&quot; with a date, or
            &quot;Out&quot;; the type of leave stays between you and Admin. Pay during leave usually comes from state disability or paid family leave
            through EDD.
          </Callout>
        ) : (
          <Callout tone="neutral" icon="info" title="What opening the case does">
            Adds a leave checklist (notice, EDD link, coverage plan, return-to-work check), shows {person ? fullName(person) : 'them'} as on leave, and
            tells others only &quot;Out&quot; or &quot;Leave, back&quot; with a date. {LEAVE_KIND_LABEL[kind]} stays visible to Admin and the person.
          </Callout>
        )}

        {!self && (
          <Field
            label="Note (optional)"
            hint={`Coverage or logistics only. Never medical details. Dictation works here (Win+H or macOS dictation).${noteCount ? ` ${noteCount}.` : ''}`}
          >
            {(id, describedBy) => (
              <TextArea
                id={id}
                aria-describedby={describedBy}
                rows={2}
                maxLength={TIMEOFF_NOTE_MAX_CHARS}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Who covers what while they are out"
              />
            )}
          </Field>
        )}
      </form>
    </Sheet>
  )
}
