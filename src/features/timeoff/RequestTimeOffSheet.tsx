// Request time off in 3 taps: type chip, first day chip (the last day follows), Send.
// Sick leave and other auto-approve policies are approved on the spot; vacation waits for the manager or Admin.
// Sick leave before the policy's 90-day wait is never approved on the spot: Admin records it with the wait
// waived (paid) or as unpaid leave, and a person's own request goes to Admin to decide.
// The leave chip opens StartLeaveSheet: Admin opens a case for anyone, a person requests family or medical leave.
import { useMemo, useState } from 'react'
import { useViewer } from '@/app/useViewer'
import { employedOn, firstName, fullName, incomingOn } from '@/domain/people'
import {
  approveAsUnpaid,
  approveRequest,
  balances,
  checkRequest,
  createRequest,
  hoursPerDayFor,
  policiesFor,
  serviceWait,
  type ServiceWait,
  unpaidPolicyFor,
} from '@/domain/timeoff'
import type { ID, TimeOffPolicy } from '@/domain/types'
import { fmtDate, fmtDay, fmtShort, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Button, Callout, ChipGroup, type ChipOption, cx, DateChips, Field, Icon, SectionLabel, Segmented, Select, Sheet, Switch, TextArea, toast } from '@/ui'
import {
  afterTheFactKind,
  approverLabel,
  endPresets,
  hoursWithDays,
  noReasonKind,
  noteCountText,
  rangePresets,
  rangeSummary,
  rangeText,
  startPresets,
  TIMEOFF_NOTE_MAX_CHARS,
} from './logic'
import { LegalNote } from './parts'
import { StartLeaveSheet } from './StartLeaveSheet'

const LEAVE_CHIP = '__leave'
type DayLength = 'full' | 'am' | 'pm'
/** How Admin records sick leave that falls before the policy's service wait. */
type EarlyChoice = 'waive' | 'unpaid'

/** Request time off for a person: type chip, date chips, submit (3 taps). */
export function RequestTimeOffSheet(props: {
  open: boolean
  onClose: () => void
  personId: ID
  /** Admin only: show a person picker so time off can be recorded for anyone. */
  allowPersonPick?: boolean
}) {
  if (!props.open) return null
  return <RequestSheetInner {...props} />
}

function policyOrder(p: TimeOffPolicy): number {
  const order = ['flexible_vacation', 'vacation', 'sick', 'bereavement', 'reproductive_loss', 'jury_duty', 'voting', 'organ_donor', 'bone_marrow_donor', 'unpaid']
  const i = order.indexOf(p.kind)
  return i < 0 ? order.length : i
}

function RequestSheetInner({ onClose, personId, allowPersonPick }: { onClose: () => void; personId: ID; allowPersonPick?: boolean }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const t = today()
  const isAdmin = viewer.role === 'admin'
  const [pid, setPid] = useState<ID>(personId)
  const person = db.people.find((p) => p.id === pid)
  const policies = useMemo(() => (person ? [...policiesFor(db, person, t)].sort((a, b) => policyOrder(a) - policyOrder(b)) : []), [db, person, t])
  const [chosenPolicyId, setPolicyId] = useState<string | null>(null)
  const policyId = chosenPolicyId && policies.some((p) => p.id === chosenPolicyId) ? chosenPolicyId : (policies[0]?.id ?? null)
  const [start, setStart] = useState<string | null>(null)
  const [end, setEnd] = useState<string | null>(null)
  const [partial, setPartial] = useState<DayLength>('full')
  const [note, setNote] = useState('')
  const self = !!viewer.personId && viewer.personId === pid
  const [approveNow, setApproveNow] = useState(isAdmin)
  const [leaveMode, setLeaveMode] = useState(false)
  const [earlyChoice, setEarlyChoice] = useState<EarlyChoice | null>(null)

  if (leaveMode) return <StartLeaveSheet open onClose={onClose} personId={pid} />

  const policy = policies.find((p) => p.id === policyId)
  const allowed = isAdmin || self
  const holidays = db.holidays
  const hpd = person ? hoursPerDayFor(person) : 8
  const part = partial === 'full' ? undefined : partial
  const summary = start && end ? rangeSummary(start, end, holidays, part, hpd) : null
  const check = person && policy && start && end ? checkRequest(db, { personId: person.id, policyId: policy.id, startDate: start, endDate: end, partial: part }, t) : null
  // Sick leave before the 90-day wait: not approved on the spot (Admin waives the wait or records it unpaid).
  // Known before the dates are picked too (counted from today), so the sheet never promises an approval.
  const wait = policy?.autoApprove && person ? (serviceWait(db, { personId: person.id, policyId: policy.id, startDate: start ?? t }) ?? undefined) : undefined
  const early = !!wait
  const auto = !!policy?.autoApprove && !early
  const unpaidPolicy = person ? unpaidPolicyFor(db, person, start ?? t) : undefined
  const approver = early ? 'Admin' : person ? approverLabel(db, person) : 'Admin'
  const approverShort = early ? 'Admin' : person?.managerId ? firstName(db.people.find((p) => p.id === person.managerId) ?? { firstName: 'Admin' }) : 'Admin'
  const willApprove = !auto && !early && isAdmin && approveNow
  const askNote = policy ? !noReasonKind(policy.kind) : false
  const needsChoice = early && isAdmin && !earlyChoice
  const canSubmit = !!(allowed && person && policy && start && end && end >= start && summary && summary.workdays > 0 && !needsChoice)

  const pickable = isAdmin ? [...employedOn(db, t), ...incomingOn(db, t)].sort((a, b) => a.hireNumber - b.hireNumber) : []
  const noteCount = noteCountText(note)

  const pickStart = (d: string) => {
    setStart(d)
    setEnd((e) => (!e || e < d || e === start ? d : e))
  }

  const submit = () => {
    if (!canSubmit || !person || !policy || !start || !end) return
    const name = fullName(person)
    const range = rangeText(start, end)
    const recordedFor = self ? '' : ` for ${name}`
    const label =
      early && isAdmin && earlyChoice === 'waive' && wait
        ? `${policy.name} recorded${recordedFor} with the ${wait.days}-day wait waived: ${range}`
        : early && isAdmin && earlyChoice === 'unpaid'
          ? `Unpaid leave recorded${recordedFor}: ${range}`
          : auto
            ? `${policy.name} recorded${recordedFor}: ${range}`
            : willApprove
              ? `${policy.name} approved for ${name}: ${range}`
              : self
                ? `Request sent to ${approver} for approval: ${range}`
                : `${name}'s request sent to ${approver} for approval: ${range}`
    const input = { personId: person.id, policyId: policy.id, startDate: start, endDate: end, ...(part ? { partial: part } : {}), ...(askNote && note.trim() ? { note: note.trim() } : {}) }
    const by = viewer.personId ? { approverId: viewer.personId } : {}
    useDB.getState().mutate(label, (d) => {
      const req = createRequest(d, input, { date: t, beforeWait: isAdmin && earlyChoice === 'waive' ? 'waive' : 'hold' })
      if (early && isAdmin && earlyChoice === 'unpaid') approveAsUnpaid(d, req.id, { date: t, ...by })
      if (willApprove && req.status === 'pending') approveRequest(d, req.id, { date: t, ...by })
    })
    toast({ text: label, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
    onClose()
  }

  const typeOptions: Array<ChipOption<string>> = policies.map((p) => ({ value: p.id, label: p.name }))
  // Admin opens a leave case for anyone; a person asks for their own (the response clock starts at their request).
  if (isAdmin) typeOptions.push({ value: LEAVE_CHIP, label: 'Protected leave', icon: 'shield' })
  else if (self) typeOptions.push({ value: LEAVE_CHIP, label: 'Family or medical leave', icon: 'shield' })

  // The footer button sends a request to an approver, or (Admin recording, an auto-approved type) saves it.
  const sends = !auto && !willApprove && !(early && isAdmin)
  const submitLabel =
    early && isAdmin
      ? earlyChoice === 'waive'
        ? `Record ${policy?.name.toLowerCase() ?? 'time off'}`
        : earlyChoice === 'unpaid'
          ? 'Record unpaid leave'
          : 'Pick how to record it'
      : auto
        ? `Record ${policy?.name.toLowerCase() ?? 'time off'}`
        : willApprove
          ? 'Save and approve'
          : `Send to ${approverShort}`

  return (
    <Sheet
      open
      onClose={onClose}
      title={self ? 'Request time off' : person ? `Time off for ${fullName(person)}` : 'Record time off'}
      subtitle={summary && summary.workdays > 0 ? summary.text : 'Pick a type and the first day off'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" icon={auto || willApprove || (early && isAdmin) ? 'check' : 'send'} disabled={!canSubmit} onClick={submit}>
            {submitLabel}
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
        {!allowed && (
          <Callout tone="warn" title="Only the person or Admin can request time off">
            Switch to Admin under Viewing as, or ask {person ? firstName(person) : 'them'} to request it from Me.
          </Callout>
        )}

        {isAdmin && allowPersonPick && (
          <Field label="Person">
            {(id) => (
              <Select
                id={id}
                value={pid}
                onChange={(v) => {
                  setPid(v)
                  setPolicyId(null)
                }}
                options={pickable.map((p) => ({ value: p.id, label: `${fullName(p)} (#${p.hireNumber})` }))}
              />
            )}
          </Field>
        )}

        <div className="flex flex-col gap-2">
          <SectionLabel>Type</SectionLabel>
          {policies.length === 0 && <p className="text-[14px] text-ink-3">No time off types apply to this person yet. Admin can set them up in Settings.</p>}
          {typeOptions.length > 0 && (
            <ChipGroup
              label="Type of time off"
              value={policyId}
              onChange={(v) => {
                if (v === LEAVE_CHIP) setLeaveMode(true)
                else setPolicyId(v)
              }}
              options={typeOptions}
            />
          )}
          {policy && (
            <div className="flex flex-col gap-1.5 text-[13.5px] text-ink-2">
              <p>{policy.description}</p>
              {policy.citation && <LegalNote label={policy.citation.label} url={policy.citation.url} />}
            </div>
          )}
          {!isAdmin && self && (
            <p className="text-[13px] text-ink-3">
              Family or medical leave covers bonding with a new child, a serious health condition, or pregnancy disability. You never need to share medical details.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <SectionLabel>Quick picks</SectionLabel>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Quick date ranges">
            {rangePresets(t, holidays).map((r) => {
              const on = start === r.start && end === r.end
              return (
                <button
                  key={r.label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    setStart(r.start)
                    setEnd(r.end)
                  }}
                  className={cx(
                    'inline-flex h-10 items-center gap-1.5 rounded-full border px-3.5 text-[13.5px] font-semibold transition-colors',
                    on ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong bg-surface text-ink-2 hover:text-ink',
                  )}
                >
                  <Icon name="calendar" size={15} />
                  {r.label}
                </button>
              )
            })}
          </div>
        </div>

        <Field label="First day off">
          {(id) => (
            <DateChips id={id} label="First day off" value={start} onChange={pickStart} presets={startPresets(t, holidays, { past: !!policy && afterTheFactKind(policy.kind) })} />
          )}
        </Field>

        {start && (
          <Field label="Last day off">
            {(id) => <DateChips id={id} label="Last day off" value={end} onChange={setEnd} presets={endPresets(start, holidays)} min={start} />}
          </Field>
        )}

        {start && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[13.5px] font-semibold text-ink-2" id="partial-label">
              Day length
            </span>
            <Segmented
              label="Day length"
              value={partial}
              onChange={setPartial}
              options={[
                { value: 'full', label: 'Full day' },
                { value: 'am', label: 'Half, morning' },
                { value: 'pm', label: 'Half, afternoon' },
              ]}
            />
            {end && end !== start && partial !== 'full' && <p className="text-[12.5px] text-ink-3">The half day is the last day off.</p>}
          </div>
        )}

        {summary && start && end && (
          <div className="rounded-xl border border-line bg-surface-2 px-4 py-3" aria-live="polite">
            <p className="num font-display text-[20px] font-bold text-ink">{summary.text}</p>
            <p className="mt-0.5 text-[13.5px] text-ink-2">{rangeText(start, end)}</p>
            {(summary.holidaysSkipped.length > 0 || summary.weekendDays > 0) && (
              <p className="mt-1 text-[13px] text-ink-3">
                Skips{' '}
                {[
                  ...summary.holidaysSkipped.map((h) => `${h.name} (${fmtDay(h.date)})`),
                  ...(summary.weekendDays > 0 ? [`${summary.weekendDays} weekend ${summary.weekendDays === 1 ? 'day' : 'days'}`] : []),
                ].join(', ')}
                .
              </p>
            )}
            {person && policy && check && (
              <BalanceImpact
                personId={person.id}
                policy={policy}
                start={start}
                hours={check.hours}
                after={check.balanceAfter}
                hpd={hpd}
                wait={early && earlyChoice !== 'waive' ? wait : undefined}
                who={self ? 'you' : firstName(person)}
              />
            )}
          </div>
        )}

        {early && wait && policy && (
          <div className="flex flex-col gap-2">
            {isAdmin ? (
              <Field label="How to record it" id="timeoff-early-choice" hint={`The policy waits ${wait.days} days before sick leave can be used. Waiving it is allowed; the note says so on the request.`}>
                {() => (
                  <ChipGroup
                    label="How to record it"
                    value={earlyChoice}
                    onChange={setEarlyChoice}
                    options={[
                      { value: 'waive', label: 'Waive the wait for this request (paid sick leave)' },
                      { value: 'unpaid', label: unpaidPolicy ? 'Record as unpaid leave' : 'Record as unpaid leave (no hours used)' },
                    ]}
                  />
                )}
              </Field>
            ) : (
              <p className="flex items-start gap-2 text-[13.5px] text-ink-2">
                <Icon name="send" size={15} className="mt-0.5 shrink-0 text-ink-3" />
                It goes to Admin, who can waive the wait for this request or record it as unpaid leave.
              </p>
            )}
          </div>
        )}

        {check && check.warnings.filter((w) => !early || w !== check.wait?.text).length > 0 && (
          <Callout tone="warn" title={sends ? 'Before you send' : 'Before you save'}>
            <ul className="list-disc pl-4">
              {check.warnings
                .filter((w) => !early || w !== check.wait?.text)
                .map((w) => (
                  <li key={w}>{w}</li>
                ))}
            </ul>
            <p className="mt-1 text-[12.5px]">These are heads-ups. You can still {sends ? 'send' : 'save'} it.</p>
          </Callout>
        )}

        {policy && auto && (
          <Callout tone="good" icon="check" title={`${policy.name} is approved right away`}>
            No reason needed.{' '}
            {policy.kind === 'sick'
              ? self || !person
                ? 'Use it for yourself or a family member, including preventive care.'
                : `${firstName(person)} can use it for their own care or a family member's, including preventive care.`
              : ''}
          </Callout>
        )}

        {policy && !auto && !early && (
          <div className="flex flex-col gap-2">
            {isAdmin ? (
              <Switch
                checked={approveNow}
                onChange={setApproveNow}
                label="Approve now"
                description={
                  approveNow
                    ? 'You are in Admin view, so it is saved as approved.'
                    : `It waits for ${approver} to approve it.`
                }
              />
            ) : (
              <p className="flex items-center gap-2 text-[13.5px] text-ink-2">
                <Icon name="send" size={15} className="text-ink-3" />
                Goes to {approver} for approval.
              </p>
            )}
          </div>
        )}

        {askNote && (
          <Field label="Note (optional)" hint={`Dictation works here (Win+H on Windows, or macOS dictation).${noteCount ? ` ${noteCount}.` : ''}`}>
            {(id, describedBy) => (
              <TextArea
                id={id}
                aria-describedby={describedBy}
                rows={2}
                maxLength={TIMEOFF_NOTE_MAX_CHARS}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={self ? 'Anything your approver should know' : 'Anything the approver should know'}
              />
            )}
          </Field>
        )}
      </form>
    </Sheet>
  )
}

function BalanceImpact({
  personId,
  policy,
  start,
  hours,
  after,
  hpd,
  wait,
  who,
}: {
  personId: ID
  policy: TimeOffPolicy
  start: string
  hours: number
  after: number | null
  hpd: number
  /** The request falls before the service wait: the hours are not usable yet, so none are "available". */
  wait?: ServiceWait
  /** 'you' for the person's own request, else their first name (Admin recording time off for someone). */
  who: string
}) {
  const db = useDB((s) => s.db)
  const t = today()
  const asOf = start > t ? start : t
  const row = balances(db, personId, asOf).find((b) => b.policy.id === policy.id)
  if (wait) {
    return (
      <p className="mt-2 text-[13.5px] font-semibold text-warn">
        {policy.name} becomes usable {fmtDate(wait.usableFrom)} ({wait.days}-day wait in the policy).
      </p>
    )
  }
  if (!row) return null
  if (row.display === 'flexible') {
    return <p className="mt-2 text-[13.5px] text-ink-2">Flexible vacation has no balance to track. {hoursWithDays(row.used + row.scheduled, hpd)} taken or planned this year.</p>
  }
  if (row.display === 'per_event') {
    return <p className="mt-2 text-[13.5px] text-ink-2">{row.note}</p>
  }
  const available = row.available != null ? Math.round((row.available - row.pending) * 100) / 100 : null
  return (
    <p className={cx('mt-2 text-[13.5px]', after != null && after < 0 ? 'font-semibold text-warn' : 'text-ink-2')}>
      {policy.name}: {available != null ? hoursWithDays(available, hpd) : 'no balance'} available
      {asOf > t ? ` by ${fmtShort(asOf)}` : ''}. This uses {hoursWithDays(hours, hpd)}
      {after == null ? '.' : after < 0 ? `, ${hoursWithDays(-after, hpd)} more than ${who} will have.` : `, leaving ${hoursWithDays(after, hpd)}.`}
    </p>
  )
}
