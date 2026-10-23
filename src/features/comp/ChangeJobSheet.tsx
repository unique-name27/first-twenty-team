// Change job or pay (docs/SPEC.md, CHANGE JOB OR PAY): reason chip, new level, title, manager and
// department, base with band position before and after, effective date chips (next pay period by default),
// the exempt check rerun, the approval, an optional refresh grant, then changeJobOrPay and a toast that
// names the tasks it created.
import { useMemo, useRef, useState } from 'react'
import { useViewer } from '@/app/useViewer'
import { current409A, pctOfFullyDiluted } from '@/domain/equity'
import { defaultExemptionBasis, exemptCheck, isAdminPerson } from '@/domain/hiring/offers'
import { changeJobOrPay, changeTaskPlan, compReasonLabel, currentJob, type JobChange, reportsAsOf } from '@/domain/lifecycle'
import { bandFor, bandLabel, compaRatio, fullTimeEquivalentBase } from '@/domain/pay'
import { employedOn, founder, fullName, incomingOn } from '@/domain/people'
import type { CompReason, ExemptionBasis, FLSA, ID } from '@/domain/types'
import { fmtDate, fmtDay, today } from '@/lib/dates'
import { money, money2, num, pct } from '@/lib/format'
import { useDB } from '@/store/db'
import {
  Button,
  Callout,
  ChipGroup,
  CitationChip,
  DateChips,
  Field,
  focusFirstInvalid,
  FormGrid,
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
import {
  effectiveDatePresets,
  EXEMPTION_LABEL,
  nextLevel,
  NOTE_MAX_CHARS,
  noteCountText,
  payLimitProblem,
  proposedBase,
  REASON_LABEL,
  snapTo1K,
  suggestTitle,
} from './helpers'
import { BandTrack } from './shared'

const REASONS: CompReason[] = ['promotion', 'market', 'merit', 'title_only', 'manager_change', 'transfer']

const EXCEPTION_CHIPS = ['Founding, equity-heavy', 'Retention risk', 'Market data for this role', 'Internal equity'] as const

/** "Supervisor harassment..." becomes "supervisor harassment..." after a name; "Labor Code..." keeps its capital. */
function lowerFirst(s: string): string {
  return /^[A-Z][a-z]* [a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s
}

/** Change job or pay workflow. Admin only; the sheet explains when someone else opens it. */
export function ChangeJobSheet({ personId, open, onClose }: { personId: ID; open: boolean; onClose: () => void }) {
  const viewer = useViewer()
  const person = useDB((s) => s.db.people.find((p) => p.id === personId))
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Change job or pay"
      subtitle={person ? `${fullName(person)}, ${person.title}` : undefined}
      width={620}
    >
      {!person ? (
        <Callout tone="warn" title="Person not found">
          This record may have been removed. Close the sheet and try again.
        </Callout>
      ) : viewer.role !== 'admin' ? (
        <Callout tone="neutral" title="Admins record job and pay changes">
          Switch Viewing as to Admin to record a promotion, pay change or new manager.
        </Callout>
      ) : (
        <ChangeJobForm personId={personId} onClose={onClose} />
      )}
    </Sheet>
  )
}

function ChangeJobForm({ personId, onClose }: { personId: ID; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const date = today()
  const person = db.people.find((p) => p.id === personId)!
  const cur = currentJob(db, personId, date) ?? db.comp.filter((c) => c.personId === personId).sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))[0]
  const hourly = cur?.payType === 'hourly'
  const curPay = hourly ? (cur?.hourlyRate ?? 0) : (cur?.salary ?? 0)
  const curLevelId = cur?.levelId ?? person.levelId
  const curTitle = cur?.title ?? person.title
  const curManager = cur && cur.managerId !== undefined ? cur.managerId : person.managerId
  const curDept = cur?.departmentId ?? person.departmentId
  const curFlsa: FLSA = cur?.flsa ?? person.flsa
  // The exemption the person holds now (only meaningful while exempt). Records written before the
  // basis was tracked on history rows fall back to the person.
  const curBasis: ExemptionBasis | undefined = curFlsa === 'exempt' ? (cur?.exemptionBasis ?? person.exemptionBasis) : undefined
  const curVar = cur?.variablePct ?? 0

  const presets = effectiveDatePresets(date, db.company.paySchedule, db.company.firstPayrollOn)
  const [reason, setReason] = useState<CompReason | null>(null)
  const [levelId, setLevelId] = useState(curLevelId)
  const [title, setTitle] = useState(curTitle)
  const [managerId, setManagerId] = useState<ID | ''>(curManager ?? '')
  const [departmentId, setDepartmentId] = useState(curDept)
  const [pay, setPay] = useState<number | null>(curPay)
  const [variable, setVariable] = useState<number | null>(Math.round(curVar * 1000) / 10)
  const [flsa, setFlsa] = useState<FLSA>(curFlsa)
  const startBasis = curBasis ?? defaultExemptionBasis(person.familyId, curLevelId)
  const [basis, setBasis] = useState<ExemptionBasis>(startBasis)
  const [effectiveOn, setEffectiveOn] = useState(presets[0].date)
  const approvers = useMemo(() => {
    const ids = new Set<ID>()
    const f = founder(db)
    if (f) ids.add(f.id)
    for (const p of employedOn(db, date)) if (isAdminPerson(db, p.id, date)) ids.add(p.id)
    if (viewer.personId) ids.add(viewer.personId)
    return db.people.filter((p) => ids.has(p.id) && p.id !== personId)
  }, [db, date, viewer.personId, personId])
  const [approvedById, setApprovedById] = useState<ID>(viewer.personId && viewer.personId !== personId ? viewer.personId : (approvers[0]?.id ?? ''))
  const [exceptionChip, setExceptionChip] = useState<string | null>(null)
  const [exceptionOther, setExceptionOther] = useState(cur?.exceptionReason ?? '')
  const [refresh, setRefresh] = useState(false)
  const [refreshShares, setRefreshShares] = useState<number | null>(null)
  const [note, setNote] = useState('')
  // Errors show on the fields after the first failed save.
  const [tried, setTried] = useState(false)
  const reasonRef = useRef<HTMLDivElement>(null)

  const levels = db.levels.filter((l) => l.id === curLevelId || db.bands.some((b) => b.familyId === person.familyId && b.levelId === l.id))
  const levelName = (id: ID) => db.levels.find((l) => l.id === id)
  const curBand = bandFor(db, person.familyId, curLevelId)
  const newBand = bandFor(db, person.familyId, levelId)
  const hours = person.hoursPerWeek || 40
  const fte = (amount: number | null) =>
    fullTimeEquivalentBase(hourly ? { payType: 'hourly', hourlyRate: amount ?? 0 } : { payType: 'salary', salary: amount ?? 0 }, hours)
  const curFte = fte(curPay)
  const newFte = fte(pay)
  const outOfBand = !!newBand && pay != null && (newFte < newBand.min || newFte > newBand.max)
  // A mistyped amount (digits typed onto the prefilled one) blocks Save, exception reason or not.
  const payTooHigh = pay != null && pay > 0 ? payLimitProblem({ hourly, pay, fte: newFte, currentFte: curFte, bandMax: newBand?.max }) : null
  const exceptionReason = (exceptionChip ?? exceptionOther).trim()
  const noteCount = noteCountText(note)
  const fd = db.equity.fullyDilutedShares

  const pickReason = (r: CompReason) => {
    setReason(r)
    let lvl = curLevelId
    if (r === 'promotion') lvl = nextLevel(db, person.familyId, curLevelId)?.id ?? curLevelId
    setLevelId(lvl)
    setTitle(r === 'promotion' ? suggestTitle(curTitle, levelName(curLevelId)?.name, levelName(lvl)?.name) : curTitle)
    if (r === 'title_only' || r === 'manager_change' || r === 'transfer') {
      setPay(curPay)
      setManagerId(curManager ?? '')
      setDepartmentId(curDept)
    } else if (hourly) {
      setPay(r === 'merit' ? Math.round(curPay * 1.04 * 4) / 4 : curPay)
    } else {
      setPay(proposedBase(r, curPay, bandFor(db, person.familyId, lvl)))
    }
  }

  const pickFlsa = (v: FLSA) => {
    setFlsa(v)
    // Moving into exempt with no exemption on record: start from the likely one for the new level.
    if (v === 'exempt' && !curBasis) setBasis(defaultExemptionBasis(person.familyId, levelId))
  }

  const pickLevel = (id: ID) => {
    setLevelId(id)
    setTitle((t) => (t === curTitle ? suggestTitle(curTitle, levelName(curLevelId)?.name, levelName(id)?.name) : t))
  }

  // Exempt check on the new pay (hiring/offers exemptCheck: CA exempt floor and computer professional minimums).
  // A current employee gets the 2810.5 change-notice wording, not the hire's start-date wording.
  const exempt = exemptCheck(db, {
    context: 'change',
    flsa,
    payType: hourly ? 'hourly' : 'salary',
    ...(hourly ? { hourlyRate: pay ?? 0 } : { salary: pay ?? 0 }),
    familyId: person.familyId,
    exemptionBasis: flsa === 'exempt' ? basis : undefined,
    hoursPerWeek: hours,
    locationId: person.locationId,
  })
  const inCA = (person.homeState || 'CA').toUpperCase() === 'CA'

  // What changed (only changed fields go to changeJobOrPay; the rest carry forward).
  const change: JobChange | null = useMemo(() => {
    if (!reason) return null
    const c: JobChange = { effectiveOn, reason }
    if (title.trim() && title.trim() !== curTitle) c.title = title.trim()
    if (levelId !== curLevelId) c.levelId = levelId
    if ((managerId || null) !== (curManager ?? null)) c.managerId = managerId || null
    if (departmentId !== curDept) c.departmentId = departmentId
    if (pay != null && pay !== curPay) {
      if (hourly) c.hourlyRate = pay
      else c.salary = pay
    }
    const v = (variable ?? 0) / 100
    if (Math.abs(v - curVar) > 0.0001) c.variablePct = v
    if (flsa !== curFlsa) c.flsa = flsa
    // Exempt rows always carry their exemption, so the comp table checks the right pay floor.
    if (flsa === 'exempt' && (flsa !== curFlsa || basis !== curBasis)) c.exemptionBasis = basis
    if (outOfBand && exceptionReason) c.exceptionReason = exceptionReason
    if (approvedById) c.approvedById = approvedById
    if (refresh && refreshShares && refreshShares > 0) c.refreshGrantShares = refreshShares
    if (note.trim()) c.note = note.trim()
    return c
  }, [reason, effectiveOn, title, curTitle, levelId, curLevelId, managerId, curManager, departmentId, curDept, pay, curPay, hourly, variable, curVar, flsa, curFlsa, basis, curBasis, outOfBand, exceptionReason, approvedById, refresh, refreshShares, note])

  const changedSomething =
    !!change &&
    (change.title !== undefined ||
      change.levelId !== undefined ||
      change.managerId !== undefined ||
      change.departmentId !== undefined ||
      change.salary !== undefined ||
      change.hourlyRate !== undefined ||
      change.variablePct !== undefined ||
      change.flsa !== undefined ||
      (change.exemptionBasis !== undefined && basis !== startBasis) ||
      !!change.refreshGrantShares)

  const problems: string[] = []
  if (!reason) problems.push('Pick a reason.')
  else if (!changedSomething) problems.push('Change at least one field, or add a refresh grant.')
  if (pay == null || pay <= 0) problems.push('Enter the new pay.')
  else if (payTooHigh) problems.push(payTooHigh)
  if (outOfBand && !exceptionReason) problems.push('Pay is outside the band: add an exception reason.')
  if (refresh && !(refreshShares && refreshShares > 0)) problems.push('Enter the refresh grant shares, or turn it off.')
  const fieldError = {
    reason: tried && !reason ? 'Pick a reason.' : undefined,
    pay: !tried ? undefined : pay == null || pay <= 0 ? 'Enter the new pay.' : (payTooHigh ?? undefined),
    exception: tried && outOfBand && !exceptionReason ? 'Pick or write an exception reason.' : undefined,
    refresh: tried && refresh && !(refreshShares && refreshShares > 0) ? 'Enter the refresh grant shares, or turn it off.' : undefined,
  }

  // Task preview: the same plan changeJobOrPay saves with, so the list names only tasks the save creates
  // (no payroll task for a manager move alone, supervisor training only for a California manager at 5+ workers).
  const newManager = managerId ? db.people.find((p) => p.id === managerId) : undefined
  const firstReport =
    !!newManager && managerId !== curManager && reportsAsOf(db, managerId, effectiveOn).filter((p) => p.id !== personId).length === 0
  const plan = useMemo(() => (change ? changeTaskPlan(db, personId, change, date) : null), [db, personId, change, date])
  const preview: string[] = []
  if (plan?.payroll) preview.push(`Update payroll by ${fmtDay(plan.payroll)}`)
  if (plan?.notice2810_5) preview.push(`Give the Labor Code 2810.5 change notice by ${fmtDay(plan.notice2810_5)}`)
  const trainee = plan?.supervisorTraining ? db.people.find((p) => p.id === plan.supervisorTraining?.personId) : undefined
  if (plan?.supervisorTraining && trainee) {
    preview.push(`${fullName(trainee)} gets a first direct report: 2-hour supervisor harassment prevention training due ${fmtDate(plan.supervisorTraining.dueOn)}`)
  }

  const fmv = current409A(db, date)?.fmvPerShare
  const managers = [...employedOn(db, date), ...incomingOn(db, date)]
    .filter((p) => p.id !== personId)
    .sort((a, b) => fullName(a).localeCompare(fullName(b)))

  const save = () => {
    if (!change || problems.length) {
      setTried(true)
      toast({ text: problems.join(' '), tone: 'bad' })
      // The reason chips come first and are a radio group, so they take focus themselves.
      if (!reason) setTimeout(() => reasonRef.current?.querySelector<HTMLElement>('[role="radio"]:not([disabled])')?.focus(), 30)
      else focusFirstInvalid()
      return
    }
    const name = fullName(person)
    // The reason as the activity log words it ('a merit increase', 'a title change').
    const label = `Recorded a ${compReasonLabel(change.reason)} for ${name}`
    const before = useDB.getState().db.checklists.length
    useDB.getState().mutate(label, (draft) => {
      changeJobOrPay(draft, personId, change, { date, actorId: viewer.personId })
    })
    const after = useDB.getState().db
    const created = after.checklists.slice(before).flatMap((c) => c.tasks)
    const tasks = [...created]
      .sort((a, b) => a.dueOn.localeCompare(b.dueOn))
      .map((t) => {
        // A task someone else owns (the new manager's supervisor training) names them, so it does not read as this person's.
        const owner = t.assigneeId && t.assigneeId !== personId ? after.people.find((p) => p.id === t.assigneeId) : undefined
        const title = t.title.replace(/\.$/, '')
        const due = t.dueOn.slice(0, 4) === date.slice(0, 4) ? fmtDay(t.dueOn) : fmtDate(t.dueOn)
        return `${owner ? `${fullName(owner)}: ${lowerFirst(title)}` : title}, due ${due}`
      })
    toast({
      text: `${label}, effective ${fmtDate(change.effectiveOn)}.${tasks.length ? ` Tasks: ${tasks.join('; ')}.` : ''}`,
      action: { label: 'Undo', onClick: () => useDB.getState().undo() },
    })
    onClose()
  }

  const payStep = hourly ? 0.25 : 1000
  const basisChips: Array<{ label: string; value: number }> = []
  if (!hourly) {
    if (newBand) basisChips.push({ label: 'Band min', value: newBand.min }, { label: 'Band mid', value: newBand.mid })
    basisChips.push(
      { label: '+3%', value: snapTo1K(curPay * 1.03) },
      { label: '+5%', value: snapTo1K(curPay * 1.05) },
      { label: '+10%', value: snapTo1K(curPay * 1.1) },
    )
  } else {
    basisChips.push(
      { label: '+3%', value: Math.round(curPay * 1.03 * 4) / 4 },
      { label: '+5%', value: Math.round(curPay * 1.05 * 4) / 4 },
    )
  }
  basisChips.push({ label: 'No change', value: curPay })

  const refreshChips = [0.0005, 0.001, 0.002].map((f) => ({ fraction: f, value: Math.round((fd * f) / 1000) * 1000 }))

  return (
    <div className="flex flex-col gap-5 pb-2">
      {person.endDate && person.endDate < date && (
        <Callout tone="warn" title={`${fullName(person)} left on ${fmtDate(person.endDate)}`}>
          A change now only corrects history. Pay and payroll tasks still get created.
        </Callout>
      )}

      <div ref={reasonRef} className="flex flex-col gap-2">
        <span className="text-[13.5px] font-semibold text-ink-2">
          Reason
          <span className="ml-0.5 text-bad" aria-hidden>
            *
          </span>
        </span>
        <ChipGroup label="Reason for the change" value={reason} onChange={pickReason} options={REASONS.map((r) => ({ value: r, label: REASON_LABEL[r] }))} />
        {fieldError.reason && <p className="text-[12.5px] font-semibold text-bad">{fieldError.reason}</p>}
      </div>

      <SectionLabel>New job</SectionLabel>
      <FormGrid>
        <Field
          label="Level"
          hint={
            newBand ? (
              <>
                Band{' '}
                <Private>
                  {money(newBand.min)} to {money(newBand.max)}
                </Private>
              </>
            ) : (
              'No band set for this level'
            )
          }
        >
          {(id, d) => (
            <Select
              id={id}
              aria-describedby={d}
              value={levelId}
              onChange={pickLevel}
              options={levels.map((l) => ({ value: l.id, label: `${l.code} ${l.name}${l.id === curLevelId ? ' (current)' : ''}` }))}
            />
          )}
        </Field>
        <Field label="Title">{(id) => <TextInput id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label="Manager" hint={firstReport && newManager ? `First direct report for ${newManager.firstName}` : undefined}>
          {(id, d) => (
            <Select
              id={id}
              aria-describedby={d}
              value={managerId}
              onChange={(v) => setManagerId(v)}
              options={[{ value: '', label: 'No manager' }, ...managers.map((p) => ({ value: p.id, label: `${fullName(p)}${p.id === curManager ? ' (current)' : ''}` }))]}
            />
          )}
        </Field>
        <Field label="Department">
          {(id) => (
            <Select
              id={id}
              value={departmentId}
              onChange={setDepartmentId}
              options={db.departments.map((d) => ({ value: d.id, label: `${d.name}${d.id === curDept ? ' (current)' : ''}` }))}
            />
          )}
        </Field>
      </FormGrid>

      <SectionLabel>Pay</SectionLabel>
      <FormGrid>
        <Field
          label={hourly ? 'Hourly rate' : 'Base salary'}
          required
          error={fieldError.pay}
          hint={
            <>
              Now <Private>{hourly ? `${money2(curPay)} an hour` : money(curPay)}</Private>
            </>
          }
        >
          {(id, d) =>
            hourly ? (
              <NumberInput id={id} aria-describedby={d} value={pay} onChange={setPay} prefix="$" suffix="/hr" step={payStep} min={0} />
            ) : (
              <MoneyInput id={id} aria-describedby={d} value={pay} onChange={setPay} />
            )
          }
        </Field>
        <Field label="Variable at target" hint="Percent of base. 100% means a 50/50 OTE.">
          {(id, d) => <NumberInput id={id} aria-describedby={d} value={variable} onChange={setVariable} suffix="% of base" sensitive step={1} min={0} />}
        </Field>
      </FormGrid>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Quick pay amounts">
        {basisChips.map((c) => (
          <Button key={c.label} size="sm" variant={pay === c.value ? 'primary' : 'secondary'} aria-pressed={pay === c.value} onClick={() => setPay(c.value)}>
            {c.label}
          </Button>
        ))}
      </div>

      {(curBand || newBand) && (
        <div className="grid grid-cols-1 gap-4 rounded-xl border border-line bg-surface-2/50 p-4 sm:grid-cols-2">
          <div>
            <p className="text-[12.5px] font-semibold text-ink-3">Before: {levelName(curLevelId)?.code}</p>
            {curBand ? (
              <>
                <BandTrack band={curBand} base={curFte} className="mt-1.5" />
                <p className="mt-1 text-[13px] text-ink-2">
                  {bandLabel(curFte, curBand)}, compa-ratio <Private>{compaRatio(curFte, curBand).toFixed(2)}</Private>
                </p>
              </>
            ) : (
              <p className="mt-1 text-[13px] text-ink-3">No band for this level</p>
            )}
          </div>
          <div>
            <p className="text-[12.5px] font-semibold text-ink-3">After: {levelName(levelId)?.code}</p>
            {newBand ? (
              <>
                <BandTrack band={newBand} base={newFte} className="mt-1.5" />
                <p className="mt-1 text-[13px] text-ink-2">
                  {bandLabel(newFte, newBand)}, compa-ratio <Private>{compaRatio(newFte, newBand).toFixed(2)}</Private>
                </p>
              </>
            ) : (
              <p className="mt-1 text-[13px] text-ink-3">No band for this level</p>
            )}
          </div>
        </div>
      )}

      {outOfBand && (
        <div className="flex flex-col gap-2">
          <span className="text-[13.5px] font-semibold text-ink-2">Exception reason (pay is outside the band)</span>
          <ChipGroup
            label="Exception reason"
            value={exceptionChip}
            onChange={(v) => setExceptionChip(v === exceptionChip ? null : v)}
            options={EXCEPTION_CHIPS.map((c) => ({ value: c, label: c }))}
          />
          {!exceptionChip && (
            <Field label="Or write a reason" error={fieldError.exception}>
              {(id, d) => <TextInput id={id} aria-describedby={d} value={exceptionOther} onChange={(e) => setExceptionOther(e.target.value)} />}
            </Field>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13.5px] font-semibold text-ink-2">Overtime status</span>
          <Segmented
            label="Overtime status"
            value={flsa}
            onChange={pickFlsa}
            options={[
              { value: 'exempt', label: 'Exempt' },
              { value: 'non_exempt', label: 'Non-exempt' },
            ]}
          />
        </div>
        {flsa === 'exempt' && (
          <Field label="Exemption" hint="Decides which California pay minimum applies.">
            {(id, d) => (
              <Select
                id={id}
                aria-describedby={d}
                value={basis}
                onChange={setBasis}
                options={(Object.keys(EXEMPTION_LABEL) as ExemptionBasis[]).map((k) => ({
                  value: k,
                  label: `${EXEMPTION_LABEL[k]}${k === curBasis ? ' (current)' : ''}`,
                }))}
              />
            )}
          </Field>
        )}
        {flsa === 'exempt' && exempt.status === 'ok' ? (
          <Callout tone="good" title="Exempt pay check passes">
            {inCA
              ? `The new pay is above the ${db.settings.law.year} California minimum for an exempt role (${money(db.settings.law.exemptSalaryMin)} salary floor; ${money2(db.settings.law.computerProAnnual)} for computer professionals). Duties tests still apply.`
              : 'California exempt minimums apply to work in California only. Check the state rules where this person works.'}
          </Callout>
        ) : (
          <Callout tone={exempt.mustBeNonExempt ? 'warn' : 'neutral'} title={exempt.mustBeNonExempt ? 'This pay cannot support an exempt role' : 'Non-exempt rules'}>
            {exempt.messages.map((m) => (
              <p key={m} className="mt-1 first:mt-0">
                {m}
              </p>
            ))}
            {exempt.mustBeNonExempt && flsa === 'exempt' && (
              <Button size="sm" className="mt-2" onClick={() => setFlsa('non_exempt')}>
                Switch to non-exempt
              </Button>
            )}
          </Callout>
        )}
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
          {exempt.citations.slice(0, 3).map((c) => (
            <CitationChip key={c.url} label={c.label} url={c.url} />
          ))}
          <span>Not legal advice.</span>
        </div>
      </div>

      <SectionLabel>When and who</SectionLabel>
      <div className="flex flex-col gap-2">
        <span className="text-[13.5px] font-semibold text-ink-2">Effective date</span>
        <DateChips label="Effective date" value={effectiveOn} onChange={setEffectiveOn} presets={presets} />
      </div>
      <Field label="Approved by" hint="Recorded on the history row with today's date.">
        {(id, d) => (
          <Select
            id={id}
            aria-describedby={d}
            value={approvedById}
            onChange={setApprovedById}
            options={approvers.map((p) => ({ value: p.id, label: fullName(p) }))}
          />
        )}
      </Field>

      <div className="rounded-xl border border-line p-4">
        <Switch
          checked={refresh}
          onChange={(v) => {
            setRefresh(v)
            if (v && !refreshShares) setRefreshShares(refreshChips[1].value)
          }}
          label="Add a refresh grant"
          description={
            <>
              Queued for the next board consent. The board sets the strike at the 409A price on the board date
              {fmv ? (
                <>
                  {' '}
                  (now <Private>{money2(fmv)}</Private>)
                </>
              ) : null}
              .
            </>
          }
        />
        {refresh && (
          <div className="mt-3 flex flex-col gap-2">
            <Field
              label="Options"
              error={fieldError.refresh}
              hint={refreshShares ? `${pct(pctOfFullyDiluted(db, refreshShares), 3)} of fully diluted, vesting monthly over 4 years` : undefined}
            >
              {(id, d) => <NumberInput id={id} aria-describedby={d} value={refreshShares} onChange={setRefreshShares} step={1000} min={0} />}
            </Field>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Quick refresh grant sizes">
              {refreshChips.map((c) => (
                <Button key={c.fraction} size="sm" variant={refreshShares === c.value ? 'primary' : 'secondary'} aria-pressed={refreshShares === c.value} onClick={() => setRefreshShares(c.value)}>
                  <Private>{num(c.value)}</Private> ({pct(c.fraction, 2)})
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>

      <Field label="Note (optional)" hint={`Dictation works here: Win+H on Windows, or dictation on a Mac.${noteCount ? ` ${noteCount}.` : ''}`}>
        {(id, d) => <TextArea id={id} aria-describedby={d} rows={2} maxLength={NOTE_MAX_CHARS} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>

      <div className="rounded-xl bg-surface-2 px-4 py-3 text-[13.5px] text-ink-2">
        <p className="font-semibold text-ink">Saving will</p>
        <ul className="mt-1 list-disc pl-5">
          <li>Write a history row effective {fmtDate(effectiveOn)}</li>
          {preview.map((p) => (
            <li key={p}>{p}</li>
          ))}
          {refresh && !!refreshShares && (
            <li>
              Queue a <Private>{num(refreshShares)}</Private>-option refresh grant for the next board consent
            </li>
          )}
        </ul>
      </div>

      {problems.length > 0 && (
        <p className="text-[13px] font-semibold text-warn" role="status">
          {problems[0]}
        </p>
      )}
      <div className="sticky -bottom-4 z-10 -mx-5 flex flex-wrap justify-end gap-2 border-t border-line bg-surface px-5 pt-3 pb-4">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="lg" icon="check" onClick={save}>
          Save change
        </Button>
      </div>
    </div>
  )
}
