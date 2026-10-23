// Offboarding wizard: separation type, last day (and notice date for a resignation), the live final
// pay deadline under Labor Code 201-203 with the waiting time penalty warning and payout rules,
// vested options and the exercise deadline, rehire eligibility and reports to reassign. Confirm runs
// offboardPerson (Undo available), says what the exit cancelled or closed (a promotion scheduled after the
// last day, time off after it), then offers 'Backfill?': a draft job on a backfill plan line (helpers.backfillPlanFor).
import { useEffect, useMemo, useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { finalPayDeadline, payoutRules, waitingTimePenaltyNote } from '@/domain/checklists/finalPay'
import { generateChecklist } from '@/domain/checklists/generate'
import { HANDOFF_KIND_ORDER, type HandoffKind, leaverRoles, recordHandoffs } from '@/domain/handoff'
import { exitCleanupLines, offboardPerson, openJobFromPlan, reassignReportsAtExit, reportsAsOf } from '@/domain/lifecycle'
import { employedOn, founder, fullName, getPerson, incomingOn } from '@/domain/people'
import { vacationPayout } from '@/domain/timeoff'
import type { DB, Handoff, ID, SeparationType } from '@/domain/types'
import { LAW_SOURCES } from '@/data/law'
import { addDays, fmtDate, fmtQuarter, type ISODate, quarterOf, today } from '@/lib/dates'
import { num } from '@/lib/format'
import { useDB } from '@/store/db'
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  ChipGroup,
  CitationChip,
  DateChips,
  Field,
  focusFirstInvalid,
  Icon,
  Money,
  Private,
  SectionLabel,
  Select,
  Sheet,
  TextInput,
  toast,
} from '@/ui'
import { backfillJobSummary, backfillPlanFor, dayLabel, equityAtExit, LINE_MAX_CHARS, nextFriday, prepareBackfillSlot } from './helpers'
import { NotLegalAdvice, undoToast } from './parts'
import { SeveranceRelease } from './SeveranceRelease'

export const SEPARATION_LABEL: Record<SeparationType, string> = {
  resigned_notice: 'Resigned with 72+ hours notice',
  resigned_no_notice: 'Resigned without notice',
  terminated: 'Terminated',
  laid_off: 'Laid off',
  contract_ended: 'Contract ended',
}

/** How each kind of hand-off reads in the wizard: a heading and the picker's label. */
const HANDOFF_COPY: Record<HandoffKind, { heading: string; picker: string }> = {
  job: { heading: 'Jobs they are hiring for', picker: 'New hiring manager' },
  next_step: { heading: 'Candidate next steps they own', picker: 'New owner of these next steps' },
  interview: { heading: 'Interviews they are on', picker: 'New interviewer' },
  contractor: { heading: 'Contractors and advisors who work with them', picker: 'New point of contact' },
  department: { heading: 'Teams they head', picker: 'New head of team' },
}

const REASONS: Record<SeparationType, string[]> = {
  resigned_notice: ['New job', 'Relocating', 'Career change', 'Personal reasons', 'Other'],
  resigned_no_notice: ['New job', 'Personal reasons', 'Other'],
  terminated: ['Performance', 'Conduct', 'Attendance', 'Other'],
  laid_off: ['Role eliminated', 'Restructuring', 'Other'],
  contract_ended: ['Fixed term ended', 'Project complete', 'Other'],
}

export function OffboardSheet({ personId, open, onClose }: { personId: ID; open: boolean; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const person = getPerson(db, personId)
  const t = today()
  const [type, setType] = useState<SeparationType>('resigned_notice')
  const [reason, setReason] = useState<string>(REASONS.resigned_notice[0])
  const [otherReason, setOtherReason] = useState('')
  const [lastDay, setLastDay] = useState<ISODate>(() => nextFriday(today(), 2))
  const [notice, setNotice] = useState<ISODate>(() => today())
  const [rehire, setRehire] = useState<'yes' | 'no'>('yes')
  const [reassign, setReassign] = useState<Record<ID, ID>>({})
  const [handTo, setHandTo] = useState<Partial<Record<HandoffKind, ID>>>({})
  const [handoffNow, setHandoffNow] = useState(false)
  const [step, setStep] = useState<'form' | 'done'>('form')
  const [checklistId, setChecklistId] = useState<ID | null>(null)
  // What starting offboarding cancelled or closed, in plain sentences for the summary.
  const [cleanupLines, setCleanupLines] = useState<string[]>([])
  const [backfillJobId, setBackfillJobId] = useState<ID | null>(null)
  const [tried, setTried] = useState(false)
  // The page stays mounted across sheet routes, so start each open from a clean form.
  useEffect(() => {
    if (!open) return
    setType('resigned_notice')
    setReason(REASONS.resigned_notice[0])
    setOtherReason('')
    setLastDay(nextFriday(today(), 2))
    setNotice(today())
    setRehire('yes')
    setReassign({})
    setHandTo({})
    setHandoffNow(false)
    setStep('form')
    setChecklistId(null)
    setCleanupLines([])
    setBackfillJobId(null)
    setTried(false)
  }, [open, personId])

  const resigned = type === 'resigned_notice' || type === 'resigned_no_notice'
  // Who reports to them the day after the last day, by the job history (a move scheduled away from them
  // before then is left out; one scheduled to them is in).
  const reports = useMemo(() => (person ? reportsAsOf(db, person.id, addDays(lastDay, 1)) : []), [db, person, lastDay])
  const managers = useMemo(
    () =>
      [...employedOn(db, t), ...incomingOn(db, t)]
        .filter((p) => p.id !== personId && !(p.endDate && p.endDate < t))
        .sort((a, b) => a.hireNumber - b.hireNumber),
    [db, personId, t],
  )
  const defaultManager = person?.managerId && person.managerId !== personId ? person.managerId : (founder(db)?.id ?? '')
  // Hand-offs land on the last day, or now when chosen (or when the last day is today or earlier).
  const handNow = handoffNow || lastDay <= t
  const roles = useMemo(() => (person ? leaverRoles(db, person.id, handNow ? addDays(t, -1) : lastDay) : []), [db, person, handNow, lastDay, t])
  const roleKinds = HANDOFF_KIND_ORDER.filter((k) => roles.some((r) => r.kind === k))
  const nameOf = (pid: ID | undefined) => {
    const p = getPerson(db, pid)
    return p ? fullName(p) : undefined
  }
  const fp = finalPayDeadline(type, lastDay, resigned ? notice : undefined)
  const payout = person ? vacationPayout(db, person.id, lastDay) : null
  const rules = person ? payoutRules(db.timeOffPolicies, person) : []
  const equity = person ? equityAtExit(db, person.id, lastDay) : { vested: 0, returned: 0 }
  const hadEquity = db.grants.some((g) => g.personId === personId && g.status !== 'cancelled')
  const preview = useMemo(() => {
    if (!person || person.separation) return []
    try {
      return generateChecklist(db, {
        person: { ...person, endDate: lastDay },
        templateId: 'tpl-offboarding',
        anchorDate: lastDay,
        createdOn: t,
        separationType: type,
        extra: { hasEquity: hadEquity, supervisor: reports.length > 0 },
      }).tasks
    } catch {
      return []
    }
  }, [db, person, lastDay, type, t, hadEquity, reports.length])

  if (!person) return null
  const name = fullName(person)
  // California's final pay deadlines (Labor Code 201-203) apply to work in California only.
  const workState = (person.homeState || 'CA').toUpperCase()
  const outsideCA = workState !== 'CA'
  const alreadyGone = !!person.separation && step === 'form'
  const offboardChecklist = db.checklists.find((c) => c.personId === personId && c.kind === 'offboarding')
  const backfillPlan = backfillPlanFor(db, personId, person.separation?.lastDay ?? lastDay, t)
  const finalReason = reason === 'Other' ? otherReason.trim() || 'Other' : reason
  const otherMissing = reason === 'Other' && !otherReason.trim()

  const pickType = (v: SeparationType) => {
    setType(v)
    setReason(REASONS[v][0])
    if (v === 'terminated' || v === 'laid_off') setLastDay(today())
  }

  const confirm = () => {
    if (otherMissing) {
      setTried(true)
      toast({ text: 'Write the reason in a line, or pick another reason.', tone: 'bad' })
      focusFirstInvalid()
      return
    }
    const label = `Started offboarding for ${name}`
    let id: ID = ''
    let lines: string[] = []
    useDB.getState().mutate(label, (d) => {
      const result = offboardPerson(
        d,
        personId,
        { type, reason: finalReason, lastDay, ...(resigned ? { noticeGivenOn: notice } : {}), rehireEligible: rehire === 'yes' },
        { date: today(), actorId: viewer.personId },
      )
      id = result.checklistId
      lines = exitCleanupLines(result.cleanup)
      reassignReportsAtExit(d, personId, lastDay, (reportId) => reassign[reportId] ?? defaultManager, {
        date: today(),
        actorId: viewer.personId,
        approvedById: viewer.personId,
        checklistId: id,
      })
      const handoffs: Handoff[] = roles
        .map((r) => ({ kind: r.kind, id: r.id, toId: handTo[r.kind] ?? defaultManager }))
        .filter((h) => !!h.toId && h.toId !== personId)
      if (handoffs.length) recordHandoffs(d, personId, handoffs, { date: today(), actorId: viewer.personId, now: handoffNow, checklistId: id })
    })
    undoToast(label)
    setChecklistId(id)
    setCleanupLines(lines)
    setStep('done')
  }

  const backfill = () => {
    const hm = person.managerId && person.managerId !== personId ? person.managerId : (founder(db)?.id ?? personId)
    const label = `Opened a backfill job for ${name}`
    let jobId: ID = ''
    useDB.getState().mutate(label, (d) => {
      const slotId = prepareBackfillSlot(d as DB, personId, person.separation?.lastDay ?? lastDay, today())
      jobId = openJobFromPlan(d, slotId, { date: today(), hiringManagerId: hm, actorId: viewer.personId })
    })
    undoToast(label)
    setBackfillJobId(jobId)
  }

  const backfillJob = backfillJobId ? db.jobs.find((j) => j.id === backfillJobId) : undefined
  const backfillSummary = backfillJob ? backfillJobSummary(backfillJob) : null

  const close = () => {
    setStep('form')
    setBackfillJobId(null)
    onClose()
  }

  const backfillBlock = (
    <>
      <SectionLabel>Backfill?</SectionLabel>
      {backfillJobId && backfillSummary ? (
        <Callout tone="accent" title={backfillSummary.title}>
          {backfillSummary.carried}{' '}
          <a href={links.job(backfillJobId)} className="-my-2.5 inline-flex min-h-10 items-center font-semibold text-accent underline">
            Open the job
          </a>{' '}
          to {backfillSummary.next}
        </Callout>
      ) : backfillPlan.kind === 'live' ? (
        <p className="text-[14px] text-ink-2">
          The {backfillPlan.slot.title} backfill line already has a live job.{' '}
          <a href={links.job(backfillPlan.jobId)} className="-my-2.5 inline-flex min-h-10 items-center font-semibold text-accent underline">
            Open the job
          </a>
        </p>
      ) : (
        <>
          <p className="text-[14px] text-ink-2">
            {backfillPlan.kind === 'reopen'
              ? `Reopen the ${backfillPlan.slot.title} backfill line as a draft job, targeting a ${dayLabel(backfillPlan.targetStart)} start. Title, level and band carry over.`
              : `Add a backfill line to the ${fmtQuarter(quarterOf(backfillPlan.targetStart))} headcount plan, targeting a ${dayLabel(backfillPlan.targetStart)} start, and open a draft ${person.title} job. Title, level and band carry over.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="lg" icon="briefcase" onClick={backfill}>
              {backfillPlan.kind === 'reopen' ? 'Reopen the plan line as a job' : 'Add a backfill job'}
            </Button>
            <Button variant="ghost" size="lg" onClick={close}>
              Not now
            </Button>
          </div>
        </>
      )}
    </>
  )

  const saved = person.separation?.handoffs ?? []
  const handoffLine = [...new Set(saved.map((h) => h.toId))].map((to) => `${nameOf(to) ?? 'a teammate'} (${saved.filter((h) => h.toId === to).length})`).join(', ')
  const doneView = (
    <div className="flex flex-col gap-4">
      <Callout tone="good" title={`Offboarding started for ${name}`}>
        Last day {dayLabel(person.separation?.lastDay ?? lastDay)}. The checklist has every deadline, and the headcount and every rule recount from
        that day.
        {handoffLine && (
          <p className="mt-1">
            {person.separation?.handoffsAppliedOn ? 'Roles handed off to ' : `Roles hand off on ${dayLabel(person.separation?.lastDay ?? lastDay)} to `}
            {handoffLine}.
          </p>
        )}
      </Callout>
      {cleanupLines.length > 0 && (
        <section aria-label="What the exit cancelled">
          <SectionLabel>Cancelled and closed</SectionLabel>
          <ul className="mt-2 flex flex-col gap-1.5 text-[14px] text-ink-2">
            {cleanupLines.map((line) => (
              <li key={line} className="flex items-start gap-2">
                <Icon name="check" size={16} className="mt-0.5 shrink-0 text-ink-3" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {(checklistId || offboardChecklist) && (
        <a href={links.checklist(checklistId ?? offboardChecklist?.id ?? '')} className="inline-flex min-h-11 items-center gap-2 font-semibold text-accent hover:underline">
          <Icon name="clipboard-check" size={18} />
          Open the offboarding checklist
        </a>
      )}
      <SeveranceRelease person={person} />
      {backfillBlock}
    </div>
  )

  return (
    <Sheet
      open={open}
      onClose={close}
      title={step === 'done' || alreadyGone ? `Offboarding: ${name}` : `Offboard ${name}`}
      subtitle={<span>#{person.hireNumber} · {person.title}</span>}
      width={620}
      footer={
        step === 'form' && !alreadyGone ? (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" size="lg" icon="log-out" onClick={confirm}>
              Start offboarding
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={close}>
            Close
          </Button>
        )
      }
    >
      {step === 'done' ? (
        doneView
      ) : alreadyGone ? (
        <div className="flex flex-col gap-4">
          <Callout tone="neutral" title={`${name} is already offboarded`}>
            {SEPARATION_LABEL[person.separation?.type ?? 'resigned_notice']}, last day {fmtDate(person.separation?.lastDay)}.
          </Callout>
          {offboardChecklist && (
            <a href={links.checklist(offboardChecklist.id)} className="inline-flex min-h-11 items-center gap-2 font-semibold text-accent hover:underline">
              <Icon name="clipboard-check" size={18} />
              Open the offboarding checklist
            </a>
          )}
          <SeveranceRelease person={person} />
          {backfillBlock}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <Field label="Type of separation" id="off-type">
            {() => (
              <ChipGroup
                label="Type of separation"
                value={type}
                onChange={pickType}
                options={(Object.keys(SEPARATION_LABEL) as SeparationType[]).map((k) => ({ value: k, label: SEPARATION_LABEL[k] }))}
              />
            )}
          </Field>

          <Field label="Reason" id="off-reason" hint="A plain reason for the record. Never a protected category.">
            {() => (
              <div className="flex flex-col gap-2">
                <ChipGroup label="Reason" size="sm" value={reason} onChange={setReason} options={REASONS[type].map((r) => ({ value: r, label: r }))} />
                {reason === 'Other' && (
                  <TextInput
                    id="off-other-reason"
                    aria-label="Other reason"
                    aria-required
                    aria-invalid={tried && otherMissing ? true : undefined}
                    aria-describedby={tried && otherMissing ? 'off-other-reason-error' : undefined}
                    maxLength={LINE_MAX_CHARS}
                    value={otherReason}
                    onChange={(e) => setOtherReason(e.target.value)}
                    placeholder="One line"
                  />
                )}
                {reason === 'Other' && tried && otherMissing && (
                  <p id="off-other-reason-error" className="text-[12.5px] font-semibold text-bad">
                    Write the reason in a line, or pick another reason.
                  </p>
                )}
              </div>
            )}
          </Field>

          {resigned && (
            <Field label="Notice given on" id="off-notice">
              {(id) => (
                <DateChips
                  id={id}
                  label="Notice given on"
                  value={notice}
                  onChange={setNotice}
                  presets={[
                    { label: 'Today', date: t },
                    { label: 'Yesterday', date: addDays(t, -1) },
                    { label: 'A week ago', date: addDays(t, -7) },
                  ]}
                />
              )}
            </Field>
          )}

          <Field label="Last day" id="off-last">
            {(id) => (
              <DateChips
                id={id}
                label="Last day"
                value={lastDay}
                onChange={setLastDay}
                presets={[
                  { label: 'Today', date: t },
                  { label: 'This Fri', date: nextFriday(t) },
                  { label: 'In 2 weeks (Fri)', date: nextFriday(t, 2) },
                  { label: 'In 3 weeks (Fri)', date: nextFriday(t, 3) },
                ]}
              />
            )}
          </Field>

          {outsideCA ? (
            <Callout tone="neutral" icon="clock" title={`Final pay follows ${workState} rules`}>
              <p>
                {name} works outside California, so the California deadlines and waiting time penalty do not apply. Final pay, vacation payout and separation notice rules differ by
                state: confirm {workState}'s rules with your PEO. Paying everything on the last day is always on time.
              </p>
              <NotLegalAdvice className="mt-2" />
            </Callout>
          ) : (
            <Callout tone="warn" icon="clock" title={fp.text}>
              <p>{fp.detail}</p>
              <p className="mt-1">{waitingTimePenaltyNote()}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <CitationChip label={fp.citation.label} url={fp.citation.url} />
                {fp.citation.label !== 'Labor Code 203' && (
                  <CitationChip label="Labor Code 203" url={LAW_SOURCES.waitingTime?.url ?? 'https://www.dir.ca.gov/dlse/faq_waitingtimepenalty.htm'} />
                )}
              </div>
              <NotLegalAdvice className="mt-2" />
            </Callout>
          )}

          <section aria-label="Final pay payouts">
            <SectionLabel>What final pay includes</SectionLabel>
            <ul className="mt-2 flex flex-col gap-2 text-[14px] text-ink-2">
              {payout && payout.hours > 0 ? (
                <li className="flex items-start gap-2">
                  <Icon name="coins" size={17} className="mt-0.5 shrink-0 text-ink-3" />
                  <span>
                    Accrued vacation: <Private>{num(payout.hours)} hours</Private>, about <Money value={Math.round(payout.amount)} /> at the final rate.
                  </span>
                </li>
              ) : (
                <li className="flex items-start gap-2">
                  <Icon name="coins" size={17} className="mt-0.5 shrink-0 text-ink-3" />
                  <span>{payout?.note}</span>
                </li>
              )}
              {rules.map((r) => (
                <li key={r.policyId} className="flex items-start gap-2">
                  <Icon name={r.paidOut ? 'check' : 'minus'} size={17} className="mt-0.5 shrink-0 text-ink-3" />
                  <span>{r.text}</span>
                </li>
              ))}
              <li className="flex items-start gap-2">
                <Icon name="laptop" size={17} className="mt-0.5 shrink-0 text-ink-3" />
                <span>Never deduct an unreturned laptop or equipment from final pay.</span>
              </li>
            </ul>
            <div className="mt-2 flex flex-wrap gap-2">
              <CitationChip label="Labor Code 227.3" url="https://www.dir.ca.gov/dlse/faq_vacation.htm" />
              <CitationChip label="Labor Code 246" url="https://www.dir.ca.gov/dlse/paid_sick_leave.htm" />
            </div>
          </section>

          <section aria-label="Equity at exit">
            <SectionLabel>Equity</SectionLabel>
            {equity.vested > 0 || equity.returned > 0 ? (
              <ul className="mt-2 flex flex-col gap-1.5 text-[14px] text-ink-2">
                {equity.vested > 0 && equity.deadline && (
                  <li>
                    <Private>{num(equity.vested)}</Private> vested options stay exercisable until <strong className="text-ink">{fmtDate(equity.deadline)}</strong>{' '}
                    (90 days after the last day). The exit note says so.
                  </li>
                )}
                {equity.vested === 0 && <li>No options are vested on the last day.</li>}
                {equity.returned > 0 && (
                  <li>
                    <Private>{num(equity.returned)}</Private> unvested or not yet granted options return to the pool.
                  </li>
                )}
              </ul>
            ) : (
              <p className="mt-2 text-[14px] text-ink-3">No options to handle.</p>
            )}
          </section>

          <Field label="Eligible for rehire?" id="off-rehire">
            {() => (
              <ChipGroup
                label="Eligible for rehire"
                value={rehire}
                onChange={setRehire}
                options={[
                  { value: 'yes', label: 'Yes' },
                  { value: 'no', label: 'No' },
                ]}
              />
            )}
          </Field>

          {reports.length > 0 && (
            <section aria-label="Reports to reassign">
              <SectionLabel>Reports to reassign</SectionLabel>
              <p className="mt-1 text-[13.5px] text-ink-3">The new manager takes over the day after the last day. Each move is recorded in job history.</p>
              <div className="mt-2 flex flex-col gap-3">
                {reports.map((r) => (
                  <Field key={r.id} label={`New manager for ${fullName(r)}`} id={`off-mgr-${r.id}`}>
                    {(id) => (
                      <Select
                        id={id}
                        value={reassign[r.id] ?? defaultManager}
                        onChange={(v) => setReassign((m) => ({ ...m, [r.id]: v }))}
                        options={managers.filter((m) => m.id !== r.id).map((m) => ({ value: m.id, label: `#${m.hireNumber} ${fullName(m)}` }))}
                      />
                    )}
                  </Field>
                ))}
              </div>
            </section>
          )}

          {roleKinds.length > 0 && (
            <section aria-label="Roles to hand off">
              <SectionLabel>Roles to hand off</SectionLabel>
              <p className="mt-1 text-[13.5px] text-ink-3">
                {handNow
                  ? 'These move to the new owner when you start offboarding.'
                  : `These move to the new owner on the last day, ${dayLabel(lastDay)}. Anything you reassign by hand before then stays put.`}{' '}
                Each one defaults to {nameOf(defaultManager) ?? 'their manager'}.
              </p>
              <div className="mt-2 flex flex-col gap-3">
                {roleKinds.map((kind) => {
                  const list = roles.filter((r) => r.kind === kind)
                  return (
                    <div key={kind} className="rounded-xl border border-line px-4 py-3">
                      <p className="text-[14px] font-semibold text-ink">
                        {HANDOFF_COPY[kind].heading} ({list.length})
                      </p>
                      <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 text-[13.5px] text-ink-2">
                        {list.slice(0, 6).map((r) => (
                          <li key={r.id}>{r.text}</li>
                        ))}
                        {list.length > 6 && <li>and {list.length - 6} more</li>}
                      </ul>
                      <Field label={HANDOFF_COPY[kind].picker} id={`off-hand-${kind}`} className="mt-2">
                        {(id) => (
                          <Select
                            id={id}
                            value={handTo[kind] ?? defaultManager}
                            onChange={(v) => setHandTo((m) => ({ ...m, [kind]: v }))}
                            options={managers.map((m) => ({ value: m.id, label: `#${m.hireNumber} ${fullName(m)}` }))}
                          />
                        )}
                      </Field>
                    </div>
                  )
                })}
              </div>
              {lastDay > t && (
                <Checkbox
                  className="mt-3"
                  checked={handoffNow}
                  onChange={setHandoffNow}
                  label="Hand these off now instead of on the last day"
                  description="Useful when they should stop hiring or interviewing during their notice period."
                />
              )}
            </section>
          )}

          {preview.length > 0 && (
            <section aria-label="Checklist preview">
              <SectionLabel>The offboarding checklist ({preview.length + (roleKinds.length ? 1 : 0)} items)</SectionLabel>
              <ul className="mt-2 flex flex-col gap-1.5 text-[13.5px] text-ink-2">
                {preview.map((task) => (
                  <li key={task.id} className="flex flex-wrap items-center gap-x-2">
                    <Icon name="check" size={14} className="text-ink-3" />
                    <span>{task.title}</span>
                    <span className="text-ink-3">, {dayLabel(task.dueOn)}</span>
                    {task.statutory && <Badge tone="outline">Legal deadline</Badge>}
                  </li>
                ))}
                {roleKinds.length > 0 && (
                  <li className="flex flex-wrap items-center gap-x-2">
                    <Icon name="check" size={14} className="text-ink-3" />
                    <span>Hiring and team roles handed off</span>
                    <span className="text-ink-3">, {handNow ? 'today' : dayLabel(lastDay)}</span>
                  </li>
                )}
              </ul>
            </section>
          )}
        </div>
      )}
    </Sheet>
  )
}
