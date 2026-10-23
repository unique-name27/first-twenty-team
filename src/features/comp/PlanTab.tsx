// Headcount plan (docs/SPEC.md, HEADCOUNT PLAN): role lines by quarter toward 20, status rolled up from
// the linked job, offer and person, Open job in one click, add/edit/cut lines, budget vs offered variance,
// the summary line and a one-page board print (with Copy).
import { useMemo, useState } from 'react'
import { links, navigate } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { openJobFromPlan } from '@/domain/lifecycle'
import { bandFor, candidateName } from '@/domain/pay'
import { formerOn, fullName } from '@/domain/people'
import { budgetVariance, headcountProjection, planCost, type PlanRow, planRollup, planStatusCounts, planSummary } from '@/domain/plan'
import type { ID, PlanSlot } from '@/domain/types'
import { addMonths, fmtDate, fmtQuarter, fmtShort, quarterOf, today } from '@/lib/dates'
import { copyText, printHTML } from '@/lib/files'
import { money, moneyShort, plural } from '@/lib/format'
import { newId } from '@/lib/id'
import { logActivity, useDB } from '@/store/db'
import {
  Badge,
  Button,
  Callout,
  ConfirmButton,
  DataTable,
  DateChips,
  EmptyState,
  Field,
  focusFirstInvalid,
  FormGrid,
  IconButton,
  Money,
  MoneyInput,
  Panel,
  Private,
  Select,
  Sheet,
  StepChart,
  Switch,
  TextArea,
  TextInput,
  toast,
  type Column,
} from '@/ui'
import { boardHTML, boardSummary, boardText, hiringManagerForSlot, NOTE_MAX_CHARS, noteCountText, PLAN_STATUS_LABEL, quarterStartPresets } from './helpers'
import { PlanStatusBadge } from './shared'

function undoToast(text: string) {
  toast({ text, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
}

export function PlanTab() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const date = today()
  const rows = useMemo(() => planRollup(db), [db])
  const counts = useMemo(() => planStatusCounts(db), [db])
  const variance = useMemo(() => budgetVariance(db), [db])
  const proj = useMemo(() => headcountProjection(db, date), [db, date])
  const cost = useMemo(() => planCost(db, date), [db, date])
  const summary = planSummary(db, date)
  const [editing, setEditing] = useState<PlanSlot | 'new' | null>(null)
  const varianceBySlot = new Map(variance.rows.map((r) => [r.slotId, r]))
  const varianceLines = variance.rows.filter((r) => r.variance != null)

  const quarters = [...new Set(rows.map((r) => r.slot.quarter))].sort()
  const costByQuarter = new Map(cost.byQuarter.map((q) => [q.quarter, q]))

  const openJob = (row: PlanRow) => {
    const fallback = viewer.personId ?? db.people.find((p) => p.isFounder)?.id ?? ''
    const hm = hiringManagerForSlot(db, row.slot, fallback, date)
    let jobId: ID | null = null
    const backfill = row.status === 'filled'
    const label = backfill ? `Reopened ${row.slot.title} as a backfill job` : `Opened a draft job for ${row.slot.title}`
    useDB.getState().mutate(label, (draft) => {
      jobId = openJobFromPlan(draft, row.slot.id, { date, hiringManagerId: hm, actorId: viewer.personId })
    })
    undoToast(label)
    if (jobId) navigate('job', jobId, 'posting')
  }

  const restore = (slot: PlanSlot) => {
    const label = `Restored the ${slot.title} plan line`
    useDB.getState().mutate(label, (draft) => {
      const s = draft.plan.find((x) => x.id === slot.id)
      if (!s) return
      s.status = s.jobId ? 'open' : 'planned'
      logActivity(draft, { entityType: 'plan', entityId: s.id, kind: 'plan_restored', text: label })
    })
    undoToast(label)
  }

  const board = () => {
    const s = boardSummary(db, date)
    const ok = printHTML(`${db.company.name} people update`, boardHTML(s))
    if (!ok) {
      void copyText(boardText(s)).then((copied) =>
        toast({ text: copied ? 'Pop-ups are blocked, so the board update was copied instead' : 'Pop-ups and copying are blocked here', tone: copied ? 'neutral' : 'bad' }),
      )
    }
  }
  const copyBoard = async () => {
    const ok = await copyText(boardText(boardSummary(db, date)))
    toast(ok ? 'Board update copied' : { text: 'Copying is blocked here. Use Print board page instead.', tone: 'bad' })
  }

  const lastPlan = proj.plan[proj.plan.length - 1]?.date ?? date
  const chartTo = addMonths(lastPlan > date ? lastPlan : date, 1)
  const actionCell = (r: PlanRow) => {
    const job = r.job
    const live = job && (job.status === 'draft' || job.status === 'open' || job.status === 'on_hold')
    const personLeft = r.status === 'filled' && r.person?.endDate && r.person.endDate < date
    return (
      <div className="flex items-center justify-end gap-1">
        {r.status === 'cut' ? (
          <Button size="sm" onClick={() => restore(r.slot)}>
            Restore
          </Button>
        ) : live && job ? (
          job.status === 'draft' ? (
            <Button size="sm" onClick={() => navigate('job', job.id, 'edit')}>
              Finish job
            </Button>
          ) : (
            <a href={links.job(job.id)} className="inline-flex h-10 items-center rounded-lg px-3 text-[13.5px] font-semibold whitespace-nowrap text-accent hover:bg-accent-soft">
              View job
            </a>
          )
        ) : r.status === 'planned' ? (
          <Button size="sm" variant="primary" icon="plus" onClick={() => openJob(r)}>
            Open job
          </Button>
        ) : personLeft ? (
          <Button size="sm" onClick={() => openJob(r)}>
            Open backfill
          </Button>
        ) : null}
        <IconButton icon="edit" size="sm" label={`Edit ${r.slot.title}`} onClick={() => setEditing(r.slot)} />
      </div>
    )
  }

  const columns: Array<Column<PlanRow>> = [
    {
      key: 'title',
      header: 'Role',
      sort: (r) => r.slot.title,
      cell: (r) => (
        <div className="min-w-[180px]">
          <div className="font-semibold text-ink">{r.slot.title}</div>
          <div className="text-[12.5px] text-ink-3">
            {db.departments.find((d) => d.id === r.slot.departmentId)?.name ?? ''}, {db.levels.find((l) => l.id === r.slot.levelId)?.code ?? ''}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-3">
            {r.slot.isBackfill && (
              <Badge tone="outline">
                Backfill{r.slot.backfillForPersonId ? ` for ${db.people.find((p) => p.id === r.slot.backfillForPersonId)?.firstName ?? 'a leaver'}` : ''}
              </Badge>
            )}
            {r.person ? (
              <a className="inline-flex min-h-10 items-center font-semibold text-accent hover:underline" href={links.person(r.person.id)}>
                {fullName(r.person)}
                {r.person.startDate > date ? `, starts ${fmtShort(r.person.startDate)}` : ''}
              </a>
            ) : r.offer ? (
              <span>Offer: {candidateName(db, r.offer.candidateId)}</span>
            ) : null}
          </div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', width: 'w-[110px]', sort: (r) => r.status, cell: (r) => <PlanStatusBadge status={r.status} /> },
    { key: 'start', header: 'Target start', width: 'w-[100px]', sort: (r) => r.slot.targetStart, cell: (r) => <span className="whitespace-nowrap">{fmtShort(r.slot.targetStart)}</span> },
    {
      key: 'budget',
      header: 'Budgeted base',
      align: 'right',
      width: 'w-[120px]',
      sort: (r) => r.budgetBase,
      cell: (r) => (
        <span className="whitespace-nowrap">
          <Money value={r.budgetBase} />
          {r.budgetFromBand && <span className="block text-[11.5px] text-ink-3">band mid</span>}
        </span>
      ),
    },
    {
      key: 'loaded',
      header: 'Loaded cost',
      align: 'right',
      width: 'w-[120px]',
      hideBelow: 'md',
      sort: (r) => r.loaded?.totalMonthly,
      cell: (r) => (r.loaded ? <Money value={Math.round(r.loaded.totalMonthly)} suffix="/mo" /> : <span className="text-ink-3">Not set</span>),
    },
    {
      key: 'variance',
      header: 'Offered vs budget',
      align: 'right',
      width: 'w-[140px]',
      hideBelow: 'lg',
      cell: (r) => {
        const v = varianceBySlot.get(r.slot.id)
        if (!v || v.actualBase == null) return <span className="text-ink-3">None yet</span>
        return (
          <span className="whitespace-nowrap">
            <Money value={v.actualBase} />
            {/* Budgets are full time, so part-time pay is compared at 40 hours a week (as Job and pay does). */}
            {v.restatedFromHours != null && <span className="block text-[11.5px] text-ink-3">restated at full time</span>}
            {v.variance != null && v.variance !== 0 && (
              <span className={v.variance > 0 ? 'block text-[12px] font-semibold text-warn' : 'block text-[12px] text-good'}>
                <Private>
                  {v.variance > 0 ? '+' : '-'}
                  {money(Math.abs(v.variance))}
                </Private>{' '}
                {v.variance > 0 ? 'over' : 'under'}
              </span>
            )}
          </span>
        )
      },
    },
    { key: 'actions', header: <span className="sr-only">Actions</span>, align: 'right', width: 'w-[160px]', cell: actionCell },
  ]

  const statusOrder: Array<PlanSlot['status']> = ['filled', 'offer', 'open', 'planned', 'cut']

  return (
    <div className="flex flex-col gap-5">
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-display text-[22px] leading-snug font-bold text-ink">{summary}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {statusOrder
                .filter((s) => counts[s] > 0)
                .map((s) => (
                  <Badge key={s} tone={s === 'filled' ? 'good' : s === 'offer' ? 'warn' : s === 'open' ? 'accent' : s === 'cut' ? 'outline' : 'neutral'}>
                    {counts[s]} {PLAN_STATUS_LABEL[s].toLowerCase()}
                  </Badge>
                ))}
            </div>
            <p className="mt-2 text-[14px] text-ink-2">
              {cost.count > 0 ? (
                <>
                  The {cost.count === 1 ? 'line' : `${cost.count} lines`} still to hire {cost.count === 1 ? 'adds' : 'add'}{' '}
                  <Money value={cost.monthly} short /> a month fully loaded.{' '}
                </>
              ) : db.plan.length > 0 ? (
                'Every plan line is filled or cut. '
              ) : (
                'No plan lines yet. '
              )}
              {varianceLines.length > 0 && (
                <>
                  Offers and hires vs budget:{' '}
                  <Private>
                    {variance.totals.variance > 0 ? '+' : variance.totals.variance < 0 ? '-' : ''}
                    {money(Math.abs(variance.totals.variance))}
                  </Private>{' '}
                  in base across {plural(varianceLines.length, 'line')}
                  {varianceLines.some((r) => r.restatedFromHours != null) ? ', part-time pay restated at full time' : ''}.
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
              Add plan line
            </Button>
            <Button icon="printer" onClick={board}>
              Print board page
            </Button>
            <Button icon="copy" onClick={copyBoard}>
              Copy board update
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title="Headcount, actual and plan" icon="trend" subtitle="W-2 employees. Contractors never count.">
        <StepChart
          ariaLabel={`Headcount since founding: ${proj.current} today. ${summary}.`}
          series={[
            { key: 'actual', label: 'Actual', points: proj.actual, style: 'solid' },
            { key: 'plan', label: 'Plan', points: proj.plan, style: 'dashed', color: 'var(--ink-3)' },
          ]}
          from={db.company.foundedOn}
          to={chartTo}
          todayDate={date}
          references={[
            { value: 5, label: '5' },
            { value: 15, label: '15' },
            { value: 20, label: '20' },
          ]}
        />
        {proj.targets.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13.5px] text-ink-2">
            {proj.targets.map((t) => (
              <li key={t.quarter}>
                <span className="font-semibold text-ink">{t.value}</span> by {fmtDate(t.date)}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {rows.length === 0 ? (
        <Panel>
          <EmptyState
            icon="target"
            title="No headcount plan yet"
            body="Add the roles you expect to hire by quarter. Each line can open a job in one click."
            action={
              <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
                Add plan line
              </Button>
            }
          />
        </Panel>
      ) : (
        quarters.map((q) => {
          const qRows = rows.filter((r) => r.slot.quarter === q)
          const qc = costByQuarter.get(q)
          const open = qRows.filter((r) => r.status === 'open' || r.status === 'planned' || r.status === 'offer').length
          return (
            <Panel
              key={q}
              title={fmtQuarter(q)}
              padded={false}
              subtitle={
                <>
                  {qRows.length} {qRows.length === 1 ? 'line' : 'lines'}
                  {open > 0 ? `, ${open} still to hire` : ', all filled or cut'}
                  {qc && qc.monthly > 0 && (
                    <>
                      {', adds '}
                      <Private>{moneyShort(qc.monthly)}</Private> a month
                    </>
                  )}
                </>
              }
            >
              <DataTable rows={qRows} columns={columns} rowKey={(r) => r.slot.id} dense caption={`Plan lines for ${fmtQuarter(q)}`} />
            </Panel>
          )
        })
      )}

      <PlanLineSheet slot={editing} onClose={() => setEditing(null)} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Add or edit a plan line
// ---------------------------------------------------------------------------------------------

function PlanLineSheet({ slot, onClose }: { slot: PlanSlot | 'new' | null; onClose: () => void }) {
  const isNew = slot === 'new'
  return (
    <Sheet
      open={slot != null}
      onClose={onClose}
      title={isNew ? 'Add plan line' : 'Edit plan line'}
      subtitle={!isNew && slot ? slot.title : 'A role you expect to hire, with its quarter and budget'}
    >
      {slot != null && <PlanLineForm key={isNew ? 'new' : slot.id} slot={isNew ? null : slot} onClose={onClose} />}
    </Sheet>
  )
}

function PlanLineForm({ slot, onClose }: { slot: PlanSlot | null; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const date = today()
  const presets = quarterStartPresets(date)
  const [title, setTitle] = useState(slot?.title ?? '')
  // New lines default to a senior individual contributor in the first family that has that band.
  const defaultLevel = db.levels.find((l) => l.code === 'L3')?.id ?? db.levels[0]?.id ?? ''
  const defaultFamily = db.families.find((f) => db.bands.some((b) => b.familyId === f.id && b.levelId === defaultLevel))?.id ?? db.families[0]?.id ?? ''
  const defaultDept = db.people.find((p) => p.familyId === defaultFamily)?.departmentId ?? db.departments[0]?.id ?? ''
  const [departmentId, setDepartmentId] = useState<ID>(slot?.departmentId ?? defaultDept)
  const [familyId, setFamilyId] = useState<ID>(slot?.familyId ?? defaultFamily)
  const [levelId, setLevelId] = useState<ID>(slot?.levelId ?? defaultLevel)
  const [targetStart, setTargetStart] = useState(slot?.targetStart ?? presets[0].date)
  const [budgetBase, setBudgetBase] = useState<number | null>(slot?.budgetBase ?? null)
  const [isBackfill, setIsBackfill] = useState(!!slot?.isBackfill)
  const [backfillFor, setBackfillFor] = useState<ID | ''>(slot?.backfillForPersonId ?? '')
  const [rationale, setRationale] = useState(slot?.rationale ?? '')
  const rationaleCount = noteCountText(rationale)
  const [tried, setTried] = useState(false)
  const band = bandFor(db, familyId, levelId)
  const levels = db.levels.filter((l) => db.bands.some((b) => b.familyId === familyId && b.levelId === l.id) || l.id === levelId)
  const former = formerOn(db, date)
  const linkedJob = slot?.jobId ? db.jobs.find((j) => j.id === slot.jobId) : undefined
  const effectiveBase = budgetBase ?? band?.mid ?? null
  const problems: string[] = []
  if (!title.trim()) problems.push('Enter a role title.')

  const save = () => {
    if (problems.length) {
      setTried(true)
      toast({ text: problems.join(' '), tone: 'bad' })
      focusFirstInvalid()
      return
    }
    const label = slot ? `Updated the ${title.trim()} plan line` : `Added ${title.trim()} to the headcount plan`
    useDB.getState().mutate(label, (draft) => {
      const fields = {
        title: title.trim(),
        departmentId,
        familyId,
        levelId,
        targetStart,
        quarter: quarterOf(targetStart),
        ...(budgetBase != null ? { budgetBase } : {}),
        isBackfill,
        backfillForPersonId: isBackfill && backfillFor ? backfillFor : null,
        ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
      }
      if (slot) {
        const s = draft.plan.find((x) => x.id === slot.id)
        if (!s) return
        Object.assign(s, fields)
        if (budgetBase == null) delete s.budgetBase
        if (!rationale.trim()) delete s.rationale
        logActivity(draft, { entityType: 'plan', entityId: s.id, kind: 'plan_updated', text: label })
      } else {
        const id = newId('ps')
        draft.plan.push({ id, status: 'planned', jobId: null, personId: null, ...fields })
        logActivity(draft, { entityType: 'plan', entityId: id, kind: 'plan_added', text: label })
      }
    })
    undoToast(label)
    onClose()
  }

  const cut = () => {
    if (!slot) return
    const label = `Cut the ${slot.title} plan line`
    useDB.getState().mutate(label, (draft) => {
      const s = draft.plan.find((x) => x.id === slot.id)
      if (!s) return
      s.status = 'cut'
      logActivity(draft, { entityType: 'plan', entityId: s.id, kind: 'plan_cut', text: label })
    })
    undoToast(label)
    onClose()
  }

  const canCut = slot && slot.status !== 'cut' && slot.status !== 'filled'
  const remove = () => {
    if (!slot) return
    const label = `Removed the ${slot.title} plan line`
    useDB.getState().mutate(label, (draft) => {
      const i = draft.plan.findIndex((x) => x.id === slot.id)
      if (i >= 0) draft.plan.splice(i, 1)
      for (const j of draft.jobs) if (j.planSlotId === slot.id) j.planSlotId = null
      logActivity(draft, { entityType: 'plan', entityId: slot.id, kind: 'plan_removed', text: label })
    })
    undoToast(label)
    onClose()
  }

  return (
    <div className="flex flex-col gap-5 pb-2">
      <Field label="Role title" required error={tried && !title.trim() ? 'Enter a role title.' : undefined}>
        {(id, d) => (
          <TextInput
            id={id}
            aria-describedby={d}
            data-autofocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Product manager, close and reconciliation"
          />
        )}
      </Field>
      <FormGrid>
        <Field label="Team">
          {(id) => <Select id={id} value={departmentId} onChange={setDepartmentId} options={db.departments.map((d) => ({ value: d.id, label: d.name }))} />}
        </Field>
        <Field label="Job family">
          {(id) => <Select id={id} value={familyId} onChange={setFamilyId} options={db.families.map((f) => ({ value: f.id, label: f.name }))} />}
        </Field>
        <Field label="Level" hint={band ? `Band ${money(band.min)} to ${money(band.max)}` : 'No band for this family and level'}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={levelId} onChange={setLevelId} options={levels.map((l) => ({ value: l.id, label: `${l.code} ${l.name}` }))} />
          )}
        </Field>
        <Field label="Budgeted base" hint={budgetBase == null && band ? `Empty uses the band midpoint, ${money(band.mid)}` : undefined}>
          {(id, d) => <MoneyInput id={id} aria-describedby={d} value={budgetBase} onChange={setBudgetBase} />}
        </Field>
      </FormGrid>
      {band && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Quick budget amounts">
          {[
            { label: 'Band min', value: band.min },
            { label: 'Band mid', value: band.mid },
            { label: 'Band max', value: band.max },
          ].map((c) => (
            <Button key={c.label} size="sm" variant={budgetBase === c.value ? 'primary' : 'secondary'} aria-pressed={budgetBase === c.value} onClick={() => setBudgetBase(c.value)}>
              {c.label}
            </Button>
          ))}
        </div>
      )}
      <DateChips label="Target start" value={targetStart} onChange={setTargetStart} presets={presets} />
      <p className="-mt-3 text-[12.5px] text-ink-3">Quarter: {fmtQuarter(quarterOf(targetStart))}</p>
      <div className="rounded-xl border border-line p-4">
        <Switch checked={isBackfill} onChange={setIsBackfill} label="Backfill" description="This role replaces someone who left." />
        {isBackfill && (
          <Field label="Replaces" className="mt-2">
            {(id) => (
              <Select
                id={id}
                value={backfillFor}
                onChange={setBackfillFor}
                options={[{ value: '', label: 'Not set' }, ...former.map((p) => ({ value: p.id, label: fullName(p) }))]}
              />
            )}
          </Field>
        )}
      </div>
      <Field label="Why this role (optional)" hint={`Dictation works here: Win+H on Windows, or dictation on a Mac.${rationaleCount ? ` ${rationaleCount}.` : ''}`}>
        {(id, d) => <TextArea id={id} aria-describedby={d} rows={3} maxLength={NOTE_MAX_CHARS} value={rationale} onChange={(e) => setRationale(e.target.value)} />}
      </Field>
      {effectiveBase != null && (
        <p className="text-[13.5px] text-ink-2">
          Planned at <Money value={effectiveBase} /> base{budgetBase == null ? ' (band midpoint)' : ''}.
        </p>
      )}
      {slot && linkedJob && (
        <Callout tone="neutral" title={`Linked job: ${linkedJob.title}`}>
          Status rolls up from the job, its offers and the hire. Cutting this line leaves the job as it is; close the job in Hiring.
        </Callout>
      )}
      <div className="sticky -bottom-4 z-10 -mx-5 flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface px-5 pt-3 pb-4">
        <div className="flex flex-wrap gap-2">
          {canCut && (
            <Button icon="minus" onClick={cut}>
              Cut this line
            </Button>
          )}
          {slot && !slot.personId && (
            <ConfirmButton icon="trash" variant="ghost" onConfirm={remove} confirmLabel="Remove for good">
              Remove
            </ConfirmButton>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="lg" icon="check" onClick={save}>
            {slot ? 'Save plan line' : 'Add plan line'}
          </Button>
        </div>
      </div>
    </div>
  )
}
