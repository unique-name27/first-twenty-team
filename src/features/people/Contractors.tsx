// Contractors and advisors: the list with AB5 results and paperwork flags, the Add sheet with the
// 30-second AB5 check, and the contractor page. Contractors never count toward headcount, but they
// do count toward the 5-person harassment training threshold. Advisors hold NSOs and no checklist.
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { PageProps } from '@/app/routes'
import { href, links, navigate } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { current409A, grantSummary, grantsFor, scheduleText } from '@/domain/equity'
import { contractorMonthly } from '@/domain/pay'
import { employedOn, fullName, getPerson } from '@/domain/people'
import type { Contractor, DB, EquityGrant, ID, Person } from '@/domain/types'
import { addDays, fmtDate, type ISODate, today } from '@/lib/dates'
import { money2, num } from '@/lib/format'
import { newId } from '@/lib/id'
import { logActivity, useDB } from '@/store/db'
import {
  Badge,
  Button,
  Callout,
  ChipGroup,
  CitationChip,
  type Column,
  DataTable,
  DateChips,
  DescriptionList,
  EmptyState,
  Field,
  focusFirstInvalid,
  FormGrid,
  Icon,
  MoneyInput,
  NumberInput,
  PageHeader,
  Panel,
  Private,
  SectionLabel,
  Select,
  Sheet,
  Switch,
  TextArea,
  TextInput,
  toast,
} from '@/ui'
import { US_STATES } from './AddPersonSheet'
import {
  AB5_CITATION,
  AB5_PRONGS,
  ab5Result,
  contractorDirStatus,
  contractorSizeError,
  contractorTooLarge,
  convertedPerson,
  DE542_CITATION,
  de542Status,
  endReminder,
  FORM_1099_CITATION,
  form1099Flag,
  LINE_MAX_CHARS,
  nextMonday,
  rateLabel,
  SCOPE_MAX_CHARS,
  scopeCountText,
  scopeSummary,
  titleFromScope,
} from './helpers'
import { Ab5Badge, Ab5OutcomeBadge, ContractorStatusBadge, NotLegalAdvice, undoToast } from './parts'
import type { PersonPrefill } from './AddPersonSheet'
import { undoneLabelFor } from './undo'

type Ab5Value = Contractor['ab5']

// ---------------------------------------------------------------------------------------------
// AB5 check (shared by the Add sheet and the contractor page)
// ---------------------------------------------------------------------------------------------

export function Ab5Check({
  value,
  onChange,
  onConvert,
  onEndBy,
  endBy,
}: {
  value: Ab5Value
  onChange: (v: Ab5Value) => void
  onConvert?: () => void
  onEndBy?: (d: ISODate) => void
  endBy?: ISODate | null
}) {
  const r = ab5Result(value)
  const t = today()
  const yesNo = (k: 'a' | 'b' | 'c') => (
    <div key={k} className="rounded-xl border border-line px-4 py-3">
      <p className="font-semibold text-ink">{AB5_PRONGS[k].title}</p>
      <p className="mt-0.5 text-[14px] text-ink-2">{AB5_PRONGS[k].question}</p>
      <p className="mt-1 text-[13px] text-ink-3">{AB5_PRONGS[k].example}</p>
      <ChipGroup
        className="mt-2"
        size="sm"
        label={`${AB5_PRONGS[k].title}: ${AB5_PRONGS[k].question}`}
        value={value[k] == null ? null : value[k] ? 'yes' : 'no'}
        onChange={(v) => onChange({ ...value, [k]: v === 'yes' })}
        options={[
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ]}
      />
    </div>
  )
  return (
    <div className="flex flex-col gap-3">
      <Field label="Exemption" id="ab5-exemption" hint="Some relationships are judged under the older Borello test instead of ABC.">
        {() => (
          <ChipGroup
            label="Exemption"
            size="sm"
            value={value.exemption}
            onChange={(v) => onChange({ ...value, exemption: v })}
            options={[
              { value: 'b2b', label: 'Business-to-business', hint: 'Their own business serving us as a client' },
              { value: 'professional_services', label: 'Professional services', hint: 'For example graphic design or marketing' },
              { value: 'none', label: 'None' },
            ]}
          />
        )}
      </Field>
      {yesNo('a')}
      {yesNo('b')}
      {yesNo('c')}
      <div aria-live="polite" className="rounded-xl border border-line bg-surface-2/60 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-ink">Result</span>
          <Ab5OutcomeBadge outcome={r.outcome} />
        </div>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-[13.5px] text-ink-2">
          {r.reasons.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <CitationChip label={AB5_CITATION.label} url={AB5_CITATION.url} />
        </div>
        <NotLegalAdvice className="mt-2" />
      </div>
      {r.askCounsel && (
        <Callout tone="warn" title="Ask counsel before relying on this">
          {r.outcome === 'likely_employee'
            ? 'Misclassified contractors are employees for pay, taxes, sick leave and every headcount rule. Convert them, or set an end date and restructure the work.'
            : 'An exemption only holds if every condition is met. Have counsel or your PEO confirm before the contract continues.'}
        </Callout>
      )}
      {r.outcome === 'likely_employee' && (onConvert || onEndBy) && (
        <div className="flex flex-col gap-3 rounded-xl border border-line px-4 py-3">
          {onConvert && (
            <div className="flex flex-wrap items-center gap-3">
              {/* Wraps instead of overflowing the panel at 375px and 150% text. */}
              <Button variant="primary" icon="user-plus" onClick={onConvert} className="h-auto! min-h-11 max-w-full shrink! py-2 text-left whitespace-normal!">
                Convert to employee
              </Button>
              <span className="text-[13.5px] text-ink-3">Prefills a part-time hourly hire with their hours and rate.</span>
            </div>
          )}
          {onEndBy && (
            <Field label="Or end the contract by" id="ab5-endby">
              {(id) => (
                <DateChips
                  id={id}
                  label="End the contract by"
                  value={endBy ?? null}
                  onChange={onEndBy}
                  presets={[
                    { label: 'In 2 weeks', date: addDays(t, 14) },
                    { label: 'In 30 days', date: addDays(t, 30) },
                    { label: 'In 60 days', date: addDays(t, 60) },
                  ]}
                />
              )}
            </Field>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Paperwork badges
// ---------------------------------------------------------------------------------------------

export function De542Badge({ db, c }: { db: DB; c: Contractor }) {
  const s = de542Status(db, c, today())
  if (s.state === 'not_needed') return <span className="text-[13px] text-ink-3">{s.text}</span>
  if (s.state === 'filed') return <Badge tone="good" icon="check">Filed {fmtDate(s.filedOn)}</Badge>
  // Statutory deadline: red only once it is overdue.
  return (
    <Badge tone={s.overdue ? 'bad' : 'warn'} icon={s.overdue ? 'alert' : 'clock'}>
      {s.overdue ? 'Overdue since' : 'Due'} {fmtDate(s.dueOn)}
    </Badge>
  )
}

export function Form1099Badge({ db, c }: { db: DB; c: Contractor }) {
  const f = form1099Flag(db, c, today())
  if (!f.needed) return <span className="text-[13px] text-ink-3">Not needed for {f.year}</span>
  return (
    <Badge tone="neutral" icon="file">
      1099-NEC by {fmtDate(f.dueOn)}
    </Badge>
  )
}

/** 'Now employee #18' once converted (the AB5 risk is settled); otherwise the AB5 result. */
function Ab5OrConverted({ c, person }: { c: Contractor; person: Person | undefined }) {
  if (person) {
    return (
      <Badge tone="good" icon="user">
        Now employee #{person.hireNumber}
      </Badge>
    )
  }
  return <Ab5Badge contractor={c} />
}

function EndBadge({ c }: { c: Contractor }) {
  const r = endReminder(c, today())
  if (r.kind === 'soon') return <Badge tone="warn" icon="clock">{r.text}</Badge>
  if (r.kind === 'ended') return <Badge tone="outline">{r.text}</Badge>
  return <span className="text-[13px] text-ink-3">{r.text}</span>
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

export function ContractorsTab({ onAdd }: { onAdd: () => void }) {
  const db = useDB((s) => s.db)
  const t = today()
  const rows = [...db.contractors].sort(
    (a, b) =>
      Number(contractorDirStatus(a, t) === 'alumni') - Number(contractorDirStatus(b, t) === 'alumni') ||
      a.kind.localeCompare(b.kind) * -1 ||
      (a.entityName || a.name).localeCompare(b.entityName || b.name),
  )
  const active = rows.filter((c) => contractorDirStatus(c, t) !== 'alumni')
  const contractors = active.filter((c) => c.kind === 'contractor')
  const advisors = active.filter((c) => c.kind === 'advisor')
  const risky = contractors.filter((c) => ab5Result(c.ab5).outcome === 'likely_employee' && !convertedPerson(db, c))
  const monthly = contractors.reduce((s, c) => s + contractorMonthly(c).monthly, 0)

  const columns: Array<Column<Contractor>> = [
    {
      key: 'name',
      header: 'Name',
      sort: (c) => c.entityName || c.name,
      cell: (c) => (
        <span className="block min-w-[180px]">
          <span className="block font-semibold">{c.entityName || c.name}</span>
          <span className="block text-[13px] font-normal text-ink-3">
            {c.kind === 'advisor' ? 'Advisor' : 'Contractor'}
            {c.entityName ? `, ${c.name}` : c.entityType === 'individual' ? ', individual' : ''}
          </span>
        </span>
      ),
    },
    { key: 'ab5', header: 'AB5', cell: (c) => <Ab5OrConverted c={c} person={convertedPerson(db, c)} /> },
    { key: 'rate', header: 'Rate', cell: (c) => <Private className="whitespace-nowrap">{rateLabel(c)}</Private> },
    { key: 'hours', header: 'Hours', hideBelow: 'md', cell: (c) => (c.hoursPerWeek ? <span className="num whitespace-nowrap">{c.hoursPerWeek} a week</span> : <span className="text-ink-3">Project</span>) },
    {
      key: 'dates',
      header: 'Dates',
      sort: (c) => c.startOn,
      cell: (c) => (
        <span className="block min-w-[140px]">
          <span className="block text-[13.5px]">Since {fmtDate(c.startOn)}</span>
          <EndBadge c={c} />
        </span>
      ),
    },
    {
      key: 'w9',
      header: 'W-9',
      cell: (c) => (c.w9OnFile ? <Badge tone="good" icon="check">On file</Badge> : <Badge tone="warn">Missing</Badge>),
    },
    { key: 'de542', header: 'DE 542', cell: (c) => <De542Badge db={db} c={c} /> },
    { key: '1099', header: '1099-NEC', hideBelow: 'sm', cell: (c) => <Form1099Badge db={db} c={c} /> },
  ]

  if (db.contractors.length === 0) {
    return (
      <Panel>
        <EmptyState
          icon="file"
          title="No contractors yet"
          body="Before you sign one, run the 30-second AB5 check. It tells you whether California would see them as an employee."
          action={
            <Button variant="primary" icon="plus" onClick={onAdd}>
              Add a contractor or advisor
            </Button>
          }
        />
      </Panel>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Contractors and advisors"
        subtitle={`${contractors.length} active ${contractors.length === 1 ? 'contractor' : 'contractors'}, ${advisors.length} ${advisors.length === 1 ? 'advisor' : 'advisors'}. They never count toward headcount; contractors count toward the 5-person harassment training threshold.`}
        actions={
          <Button variant="primary" icon="plus" onClick={onAdd}>
            Add contractor or advisor
          </Button>
        }
        padded={false}
      >
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line px-5 py-3 text-[14px] text-ink-2">
          <span>
            About <Private>${num(Math.round(monthly))}</Private> a month in contractor fees
          </span>
          {risky.length > 0 && (
            <span className="inline-flex items-center gap-1.5 font-semibold text-warn">
              <Icon name="alert" size={16} />
              {risky.length} likely {risky.length === 1 ? 'employee' : 'employees'} under AB5
            </span>
          )}
        </div>
        <DataTable rows={rows} columns={columns} rowKey={(c) => c.id} rowHref={(c) => links.contractor(c.id)} caption="Contractors and advisors" />
      </Panel>
      <p className="text-[13px] text-ink-3">
        DE 542 is for individual contractors paid or contracted for ${db.settings.law.de542Threshold} or more, within 20 days. 1099-NEC is for anyone
        but a corporation paid ${num(db.settings.law.form1099Threshold)} or more in the year, due Jan 31. Not legal advice.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Add sheet
// ---------------------------------------------------------------------------------------------

type ContractorForm = {
  kind: Contractor['kind']
  name: string
  entityType: Contractor['entityType']
  entityName: string
  email: string
  scope: string
  rate: number | null
  rateUnit: Contractor['rateUnit']
  hoursPerWeek: number | null
  startOn: ISODate
  endOn: ISODate | null
  managerId: ID
  departmentId: ID
  state: string
  w9OnFile: boolean
  ab5: Ab5Value
  options: number | null
}

function blankForm(db: DB): ContractorForm {
  const founderId = db.people.find((p) => p.isFounder)?.id ?? db.people[0]?.id ?? ''
  return {
    kind: 'contractor',
    name: '',
    entityType: 'individual',
    entityName: '',
    email: '',
    scope: '',
    rate: null,
    rateUnit: 'hour',
    hoursPerWeek: 10,
    startOn: today(),
    endOn: null,
    managerId: founderId,
    departmentId: db.departments[0]?.id ?? '',
    state: db.company.hq.state || 'CA',
    w9OnFile: false,
    ab5: { exemption: 'none', a: null, b: null, c: null },
    options: null,
  }
}

/** The basic fields of a saved contractor, for the Edit sheet (AB5 and options are edited elsewhere). */
function formFor(c: Contractor): ContractorForm {
  return {
    kind: c.kind,
    name: c.name,
    entityType: c.entityType,
    entityName: c.entityName ?? '',
    email: c.email,
    scope: c.scope,
    rate: c.rate,
    rateUnit: c.rateUnit,
    hoursPerWeek: c.hoursPerWeek ?? null,
    startOn: c.startOn,
    endOn: c.endOn ?? null,
    managerId: c.managerId,
    departmentId: c.departmentId,
    state: c.state,
    w9OnFile: c.w9OnFile,
    ab5: c.ab5,
    options: null,
  }
}

/** Writes the form's basic fields onto a contractor (a draft, or a copy to check before saving). */
function applyBasics(k: Contractor, form: ContractorForm): void {
  k.name = form.name.trim()
  k.entityType = form.entityType
  if (form.entityType !== 'individual' && form.entityName.trim()) k.entityName = form.entityName.trim()
  else delete k.entityName
  k.email = form.email.trim()
  k.scope = form.scope.trim()
  if (k.kind === 'contractor') {
    k.rate = form.rate ?? 0
    k.rateUnit = form.rateUnit
    if (form.rateUnit !== 'project' && form.hoursPerWeek) k.hoursPerWeek = form.hoursPerWeek
    else delete k.hoursPerWeek
  }
  k.startOn = form.startOn
  if (form.endOn) k.endOn = form.endOn
  else if (k.endOn !== undefined) k.endOn = null
  k.managerId = form.managerId
  k.departmentId = form.departmentId
  k.state = form.state
}

/** What a contractor form is missing, by field. */
function formErrors(form: ContractorForm, scopeChanged = true): { name: string; scope: string; rate: string } {
  const advisor = form.kind === 'advisor'
  return {
    name: !form.name.trim() ? 'Add a name.' : '',
    scope: !form.scope.trim()
      ? 'Describe the work in a line.'
      : scopeChanged && form.scope.trim().length > SCOPE_MAX_CHARS
        ? `A scope of work can be up to ${SCOPE_MAX_CHARS.toLocaleString('en-US')} characters. Shorten this one.`
        : '',
    rate: !advisor && !form.rate ? 'Add the rate.' : '',
  }
}

/**
 * The fields the Add and Edit sheets share: name and email, entity, scope of work, rate and hours, dates, who
 * they work with and where. `children` goes after the rate (the Add sheet's advisor options).
 */
function ContractorFields({
  form,
  set,
  err,
  focusScope,
  children,
}: {
  form: ContractorForm
  set: <K extends keyof ContractorForm>(k: K, v: ContractorForm[K]) => void
  err: (k: 'name' | 'scope' | 'rate') => string | undefined
  /** Focus the scope of work when the sheet opens (to shorten one too large to sync) instead of the name. */
  focusScope?: boolean
  children?: ReactNode
}) {
  const db = useDB((s) => s.db)
  const t = today()
  const advisor = form.kind === 'advisor'
  const people = useMemo(() => {
    const list = employedOn(db).sort((a, b) => a.hireNumber - b.hireNumber)
    // Someone who has since left still shows as who they work with until it is changed.
    const current = getPerson(db, form.managerId)
    return current && !list.includes(current) ? [...list, current] : list
  }, [db, form.managerId])
  const scopeCount = scopeCountText(form.scope)
  return (
    <>
      <FormGrid>
        <Field label="Name" required error={err('name')}>
          {(id, d) => (
            <TextInput
              id={id}
              aria-describedby={d}
              maxLength={LINE_MAX_CHARS}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              data-autofocus={focusScope ? undefined : true}
            />
          )}
        </Field>
        <Field label="Email">
          {(id) => <TextInput id={id} type="email" maxLength={LINE_MAX_CHARS} value={form.email} onChange={(e) => set('email', e.target.value)} />}
        </Field>
      </FormGrid>
      {!advisor && (
        <Field label="Entity type" id="k-entity" hint="DE 542 is only for individuals, not LLCs or corporations.">
          {() => (
            <div className="flex flex-col gap-2">
              <ChipGroup
                label="Entity type"
                size="sm"
                value={form.entityType}
                onChange={(v) => set('entityType', v)}
                options={[
                  { value: 'individual', label: 'Individual' },
                  { value: 'llc', label: 'LLC' },
                  { value: 'corporation', label: 'Corporation' },
                ]}
              />
              {form.entityType !== 'individual' && (
                <TextInput
                  aria-label="Business name"
                  placeholder="Business name"
                  maxLength={LINE_MAX_CHARS}
                  value={form.entityName}
                  onChange={(e) => set('entityName', e.target.value)}
                />
              )}
            </div>
          )}
        </Field>
      )}
      <Field label="Scope of work" required error={err('scope')} hint={scopeCount ? `${scopeCount}.` : undefined}>
        {(id, d) => (
          <TextArea
            id={id}
            aria-describedby={d}
            rows={2}
            maxLength={SCOPE_MAX_CHARS}
            value={form.scope}
            onChange={(e) => set('scope', e.target.value)}
            placeholder="One or two lines. Dictation works here (Win+H)."
            data-autofocus={focusScope ? true : undefined}
          />
        )}
      </Field>
      {!advisor && (
        <FormGrid>
          <Field label="Rate" required error={err('rate')}>
            {(id, d) => (
              <div className="flex flex-col gap-2">
                <ChipGroup
                  label="Rate unit"
                  size="sm"
                  value={form.rateUnit}
                  onChange={(v) => set('rateUnit', v)}
                  options={[
                    { value: 'hour', label: 'Hourly' },
                    { value: 'month', label: 'Monthly' },
                    { value: 'project', label: 'Project' },
                  ]}
                />
                <MoneyInput id={id} aria-describedby={d} value={form.rate} onChange={(v) => set('rate', v)} suffix={form.rateUnit === 'hour' ? '/ hour' : form.rateUnit === 'month' ? '/ month' : 'total'} />
              </div>
            )}
          </Field>
          {form.rateUnit !== 'project' && (
            <Field label="Hours per week">
              {(id) => (
                <div className="flex flex-col gap-2">
                  <ChipGroup
                    label="Hours per week"
                    size="sm"
                    value={String(form.hoursPerWeek ?? '')}
                    onChange={(v) => set('hoursPerWeek', Number(v))}
                    options={['5', '10', '20', '25', '40'].map((h) => ({ value: h, label: h }))}
                  />
                  <NumberInput id={id} value={form.hoursPerWeek} onChange={(v) => set('hoursPerWeek', v)} min={0} max={60} suffix="hours" />
                </div>
              )}
            </Field>
          )}
        </FormGrid>
      )}
      {children}
      <FormGrid>
        <Field label="Starts" id="k-start">
          {(id) => (
            <DateChips
              id={id}
              label="Starts"
              value={form.startOn}
              onChange={(v) => set('startOn', v)}
              presets={[
                { label: 'Today', date: t },
                { label: 'Next Mon', date: nextMonday(t) },
                { label: '+2 weeks', date: addDays(t, 14) },
              ]}
            />
          )}
        </Field>
        <Field label="Ends" id="k-end">
          {(id) => (
            <div className="flex flex-col gap-2">
              <DateChips
                id={id}
                label="Ends"
                value={form.endOn}
                onChange={(v) => set('endOn', v)}
                presets={[
                  { label: '3 months', date: addDays(form.startOn, 91) },
                  { label: '6 months', date: addDays(form.startOn, 182) },
                  { label: '1 year', date: addDays(form.startOn, 365) },
                ]}
              />
              {form.endOn && (
                <Button variant="ghost" size="sm" onClick={() => set('endOn', null)}>
                  No end date
                </Button>
              )}
            </div>
          )}
        </Field>
      </FormGrid>
      <FormGrid>
        <Field label="Works with">
          {(id) => <Select id={id} value={form.managerId} onChange={(v) => set('managerId', v)} options={people.map((p) => ({ value: p.id, label: `#${p.hireNumber} ${fullName(p)}` }))} />}
        </Field>
        <Field label="Team">
          {(id) => <Select id={id} value={form.departmentId} onChange={(v) => set('departmentId', v)} options={db.departments.map((d) => ({ value: d.id, label: d.name }))} />}
        </Field>
        <Field label="Works from (state)">
          {(id) => <Select id={id} value={form.state} onChange={(v) => set('state', v)} options={US_STATES.map((s) => ({ value: s, label: s }))} />}
        </Field>
      </FormGrid>
    </>
  )
}

export function AddContractorSheet({ open, onClose, onConvert }: { open: boolean; onClose: () => void; onConvert: (p: PersonPrefill) => void }) {
  const db = useDB((s) => s.db)
  const [form, setForm] = useState<ContractorForm>(() => blankForm(db))
  const [tried, setTried] = useState(false)
  // Set when the record would be too large to sync; cleared when the scope changes.
  const [sizeError, setSizeError] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setForm(blankForm(db))
      setTried(false)
      setSizeError(null)
    }
    // Reset when the sheet opens.
  }, [open])
  const set = <K extends keyof ContractorForm>(k: K, v: ContractorForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    if (k === 'scope') setSizeError(null)
  }
  const t = today()
  const advisor = form.kind === 'advisor'
  const errors = formErrors(form)
  if (!errors.scope && sizeError) errors.scope = sizeError
  const valid = Object.values(errors).every((e) => !e)
  const err = (k: keyof typeof errors) => (tried ? errors[k] || undefined : undefined)
  const strike = current409A(db, t)?.fmvPerShare

  const save = () => {
    setTried(true)
    if (!valid) {
      toast({ text: Object.values(errors).filter(Boolean).join(' '), tone: 'bad' })
      focusFirstInvalid()
      return
    }
    const id = newId('k')
    const c: Contractor = {
      id,
      kind: form.kind,
      name: form.name.trim(),
      entityType: form.entityType,
      email: form.email.trim(),
      scope: form.scope.trim(),
      rate: form.rate ?? 0,
      rateUnit: form.rateUnit,
      startOn: form.startOn,
      endOn: form.endOn,
      managerId: form.managerId,
      departmentId: form.departmentId,
      state: form.state,
      ab5: { ...form.ab5, assessedOn: t },
      w9OnFile: form.w9OnFile,
    }
    if (form.entityType !== 'individual' && form.entityName.trim()) c.entityName = form.entityName.trim()
    if (form.rateUnit !== 'project' && form.hoursPerWeek) c.hoursPerWeek = form.hoursPerWeek
    // A record the server could never take is stopped here, before it is saved.
    const tooLarge = contractorSizeError(c)
    if (tooLarge) {
      setSizeError(tooLarge)
      toast({ text: tooLarge, tone: 'bad' })
      focusFirstInvalid()
      return
    }
    const display = c.entityName || c.name
    const label = `Added ${display} as ${advisor ? 'an advisor' : 'a contractor'}`
    useDB.getState().mutate(label, (d) => {
      d.contractors.push(c)
      if (advisor && form.options && form.options > 0) {
        const g: EquityGrant = {
          id: newId('g'),
          personId: id,
          holderType: 'advisor',
          type: 'NSO',
          shares: form.options,
          strikePrice: strike ?? 0,
          vestingStart: form.startOn,
          cliffMonths: 0,
          vestingMonths: 24,
          status: 'promised',
          proposedOn: t,
          exercisedShares: 0,
          postTerminationExerciseDays: 90,
          note: 'Advisor grant: 2 years monthly, no cliff',
        }
        d.grants.push(g)
      }
      logActivity(d, { entityType: 'contractor', entityId: id, kind: 'contractor_added', text: label })
      if (!advisor) {
        const r = ab5Result(c.ab5)
        logActivity(d, { entityType: 'contractor', entityId: id, kind: 'ab5_checked', text: `Ran the AB5 check for ${display}: ${r.outcome.replace('_', ' ')}` })
      }
    })
    undoToast(label)
    onClose()
    navigate('contractor', id)
  }

  const convert = () => {
    const parts = form.name.trim().split(/\s+/)
    onConvert({
      firstName: parts[0] ?? '',
      lastName: parts.slice(1).join(' '),
      personalEmail: form.email,
      title: titleFromScope(form.scope),
      departmentId: form.departmentId,
      managerId: form.managerId,
      employmentType: (form.hoursPerWeek ?? 20) >= 40 ? 'full_time' : 'part_time',
      hoursPerWeek: form.hoursPerWeek ?? 20,
      flsa: 'non_exempt',
      payType: 'hourly',
      hourlyRate: form.rateUnit === 'hour' ? form.rate : null,
      salary: null,
      homeState: form.state,
    })
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add a contractor or advisor"
      subtitle="Contractors never count toward headcount. Run the AB5 check before you sign."
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" icon="plus" onClick={save}>
            {advisor ? 'Add advisor' : 'Add contractor'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Kind" id="k-kind">
          {() => (
            <ChipGroup
              label="Kind"
              value={form.kind}
              onChange={(v) =>
                setForm((f) => ({ ...f, kind: v, rate: v === 'advisor' ? 0 : f.rate, rateUnit: v === 'advisor' ? 'month' : f.rateUnit, hoursPerWeek: v === 'advisor' ? 1 : f.hoursPerWeek }))
              }
              options={[
                { value: 'contractor', label: 'Contractor' },
                { value: 'advisor', label: 'Advisor' },
              ]}
            />
          )}
        </Field>
        <ContractorFields form={form} set={set} err={err}>
          {advisor && (
            <Field label="Options (NSO)" hint={`Vest monthly over 2 years with no cliff${strike ? `, strike ${money2(strike)} at the current 409A` : ''}. Queued for board consent.`}>
              {(id, d) => <NumberInput id={id} aria-describedby={d} value={form.options} onChange={(v) => set('options', v)} min={0} step={1000} suffix="options" />}
            </Field>
          )}
        </ContractorFields>
        <Switch checked={form.w9OnFile} onChange={(v) => set('w9OnFile', v)} label="W-9 on file" description="Collect it before the first payment. Keep it with your PEO or accounting system, not here." />
        {!advisor && (
          <>
            <SectionLabel>AB5 check</SectionLabel>
            <Ab5Check value={form.ab5} onChange={(v) => set('ab5', v)} onConvert={convert} onEndBy={(d) => set('endOn', d)} endBy={form.endOn} />
          </>
        )}
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------------------------
// Edit sheet
// ---------------------------------------------------------------------------------------------

/**
 * Edit a contractor's or advisor's basic details (name, entity, scope, rate, dates, who and where). The AB5 check,
 * paperwork and options keep their own controls on the page. A record too large to sync opens with the scope
 * focused, and the save is stopped until it fits.
 */
function EditContractorSheet({ c, open, onClose, focusScope }: { c: Contractor; open: boolean; onClose: () => void; focusScope?: boolean }) {
  const [form, setForm] = useState<ContractorForm>(() => formFor(c))
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (open) {
      setForm(formFor(c))
      setTried(false)
    }
    // Reset when the sheet opens.
  }, [open])
  const set = <K extends keyof ContractorForm>(k: K, v: ContractorForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const scopeChanged = form.scope.trim() !== c.scope
  const next: Contractor = { ...c }
  applyBasics(next, form)
  const errors = formErrors(form, scopeChanged)
  const tooLarge = contractorSizeError(next, { scopeChanged })
  if (!errors.scope && tooLarge) errors.scope = tooLarge
  const valid = Object.values(errors).every((e) => !e)
  const err = (k: keyof typeof errors) => (tried || (k === 'scope' && !!tooLarge) ? errors[k] || undefined : undefined)
  const name = c.entityName || c.name

  const save = () => {
    setTried(true)
    if (!valid) {
      toast({ text: Object.values(errors).filter(Boolean).join(' '), tone: 'bad' })
      focusFirstInvalid()
      return
    }
    if (JSON.stringify(next) === JSON.stringify(c)) {
      onClose()
      return
    }
    const label = `Updated the details for ${next.entityName || next.name}`
    useDB.getState().mutate(label, (d) => {
      const k = d.contractors.find((x) => x.id === c.id)
      if (!k) return
      applyBasics(k, form)
      logActivity(d, { entityType: 'contractor', entityId: c.id, kind: 'contractor_updated', text: label })
    })
    undoToast(label)
    onClose()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Edit ${name}`}
      subtitle={c.kind === 'advisor' ? 'Advisor details. Options are on the page.' : 'Contract details. The AB5 check and paperwork are on the page.'}
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" icon="check" onClick={save}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <ContractorFields form={form} set={set} err={err} focusScope={focusScope} />
      </div>
    </Sheet>
  )
}

/** The whole scope of work, cut to a preview with a Show all button when it runs long. */
function ScopeText({ scope }: { scope: string }) {
  const [all, setAll] = useState(false)
  const long = scope.length > SCOPE_PREVIEW_CHARS
  const shown = long && !all ? `${scope.slice(0, SCOPE_PREVIEW_CHARS).trimEnd()}...` : scope
  return (
    <div>
      <p className="mt-0.5 text-[14.5px] break-words whitespace-pre-line text-ink">{shown || <span className="text-ink-3">Not set</span>}</p>
      {long && (
        <Button variant="ghost" size="sm" className="mt-1" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? 'Show less' : `Show all ${scope.length.toLocaleString('en-US')} characters`}
        </Button>
      )}
    </div>
  )
}

/** How much of a long scope the page shows before Show all. */
const SCOPE_PREVIEW_CHARS = 600

// ---------------------------------------------------------------------------------------------
// Contractor page
// ---------------------------------------------------------------------------------------------

function AdvisorGrants({ c }: { c: Contractor }) {
  const db = useDB((s) => s.db)
  const grants = grantsFor(db, c.id)
  if (!grants.length) return <p className="text-[14px] text-ink-3">No option grant recorded.</p>
  const sum = grantSummary(db, c.id, today())
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[14px] text-ink-2">
        <Private>{sum.text}</Private>
      </p>
      <ul className="flex flex-col gap-2">
        {grants.map((g) => (
          <li key={g.id} className="rounded-xl border border-line px-4 py-3 text-[14px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink">
                <Private>{num(g.shares)}</Private> {g.type}s
              </span>
              <Badge tone={g.status === 'approved' ? 'good' : g.status === 'promised' ? 'warn' : 'outline'}>
                {g.status === 'approved' ? 'Granted' : g.status === 'promised' ? 'Awaiting board consent' : g.status === 'reserved' ? 'Reserved' : 'Cancelled'}
              </Badge>
            </div>
            <p className="mt-1 text-ink-3">
              Strike <Private>{money2(g.strikePrice)}</Private>, {scheduleText(g)}, from {fmtDate(g.vestingStart)}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function ContractorPage({ route }: PageProps) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const id = route.segments[1]
  const c = db.contractors.find((k) => k.id === id)
  const [ab5, setAb5] = useState<Ab5Value | null>(null)
  const [endBy, setEndBy] = useState<ISODate | null>(null)
  const [editing, setEditing] = useState<null | 'details' | 'scope'>(null)
  useEffect(() => {
    setAb5(null)
    setEndBy(null)
    setEditing(null)
  }, [id])
  const t = today()

  if (!c) {
    const undone = undoneLabelFor((d) => d.contractors.some((k) => k.id === id))
    return (
      <EmptyState
        icon={undone ? 'rotate-ccw' : 'search'}
        title={undone ? 'This change was undone' : 'No contractor or advisor with that link'}
        body={undone ? `Undid: ${undone}. The record is no longer in this workspace.` : undefined}
        action={
          <a href={links.people('contractors')} className="inline-flex min-h-10 items-center font-bold text-accent underline">
            Back to contractors
          </a>
        }
      />
    )
  }
  const admin = viewer.role === 'admin'
  const manager = getPerson(db, c.managerId)
  const name = c.entityName || c.name
  const status = contractorDirStatus(c, t)
  const convertedTo = convertedPerson(db, c)
  const ab5Value = ab5 ?? c.ab5
  const tooLarge = admin && contractorTooLarge(c)
  const dirty = !!ab5 && JSON.stringify({ ...ab5, assessedOn: undefined }) !== JSON.stringify({ ...c.ab5, assessedOn: undefined })

  const update = (label: string, fn: (k: Contractor) => void) => {
    useDB.getState().mutate(label, (d) => {
      const k = d.contractors.find((x) => x.id === c.id)
      if (!k) return
      fn(k)
      logActivity(d, { entityType: 'contractor', entityId: c.id, kind: 'contractor_updated', text: label })
    })
    undoToast(label)
  }

  const de542 = de542Status(db, c, t)

  return (
    <>
      <PageHeader
        back={{ href: admin ? links.people('contractors') : links.people(), label: admin ? 'Contractors and advisors' : 'People' }}
        eyebrow={c.kind === 'advisor' ? 'Advisor' : 'Contractor'}
        title={name}
        subtitle={scopeSummary(c.scope)}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <ContractorStatusBadge status={status} />
            {admin && <Ab5OrConverted c={c} person={convertedTo} />}
            {admin && (
              <Button size="sm" icon="edit" onClick={() => setEditing('details')}>
                Edit details
              </Button>
            )}
          </span>
        }
      />
      {tooLarge && (
        <Callout
          tone="warn"
          icon="alert"
          className="mb-4"
          title="Too large to sync"
          action={
            <Button variant="primary" size="sm" icon="edit" onClick={() => setEditing('scope')}>
              Shorten the scope
            </Button>
          }
        >
          This record is over 256 KB, the most a server takes for one record, so its changes stay on this device. Shorten the scope of work to sync it.
        </Callout>
      )}
      {/* Columns follow the page area (a container query), so 150% text and the rail both count. */}
      <div className="@container">
        <div className="grid grid-cols-1 gap-4 @[640px]:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-4 @[640px]:col-span-2">
            <Panel title="Details">
              {/* The subtitle holds a short scope; a longer one is cut there and shown in full here. */}
              {scopeSummary(c.scope) !== c.scope.trim() && (
                <div className="mb-4 min-w-0">
                  <p className="text-[12.5px] font-semibold text-ink-3">Scope of work</p>
                  <ScopeText scope={c.scope} />
                </div>
              )}
              <DescriptionList
                items={[
                  { label: 'Name', value: c.entityName ? `${c.name} (${c.entityName})` : c.name },
                  { label: 'Entity', value: c.entityType === 'individual' ? 'Individual' : c.entityType === 'llc' ? 'LLC' : 'Corporation', hidden: !admin },
                  { label: 'Works with', value: manager ? <a className="-my-2.5 inline-flex min-h-10 items-center font-semibold text-accent hover:underline" href={links.person(manager.id)}>#{manager.hireNumber} {fullName(manager)}</a> : '' },
                  { label: 'Team', value: db.departments.find((d) => d.id === c.departmentId)?.name },
                  { label: 'Started', value: fmtDate(c.startOn) },
                  { label: 'Ends', value: c.endOn ? fmtDate(c.endOn) : 'No end date' },
                  { label: 'Rate', value: <Private>{rateLabel(c)}</Private>, hidden: !admin },
                  { label: 'Hours', value: c.hoursPerWeek ? `${c.hoursPerWeek} a week` : 'Project based', hidden: !admin },
                  { label: 'About a month', value: <Private>${num(Math.round(contractorMonthly(c).monthly))}</Private>, hidden: !admin || c.kind === 'advisor' },
                  { label: 'Works from', value: c.state },
                  { label: 'Email', value: c.email ? <a className="-my-2.5 inline-flex min-h-10 items-center text-accent hover:underline" href={`mailto:${c.email}`}>{c.email}</a> : '' },
                  { label: 'Agreement signed', value: c.agreementSignedOn ? fmtDate(c.agreementSignedOn) : 'Not recorded', hidden: !admin },
                ]}
              />
              {admin && c.notes && <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-[14px] text-ink-2">{c.notes}</p>}
            </Panel>

            {admin && c.kind === 'contractor' && (
              <Panel
                title="AB5 check"
                subtitle={c.ab5.assessedOn ? `Last checked ${fmtDate(c.ab5.assessedOn)}` : 'Not checked yet'}
                actions={
                  dirty ? (
                    <Button
                      variant="primary"
                      icon="check"
                      onClick={() => {
                        const next = ab5 as Ab5Value
                        const r = ab5Result(next)
                        update(`Saved the AB5 check for ${name}: ${r.outcome.replace('_', ' ')}`, (k) => {
                          k.ab5 = { ...next, assessedOn: t }
                        })
                        setAb5(null)
                      }}
                    >
                      Save AB5 check
                    </Button>
                  ) : undefined
                }
              >
                {c.ab5.note && !ab5 && <p className="mb-3 text-[14px] text-ink-2">{c.ab5.note}</p>}
                {convertedTo && (
                  <Callout tone="good" icon="check" className="mb-3" title={`Converted to employee #${convertedTo.hireNumber}`}>
                    {c.convertedOn ? `Recorded ${fmtDate(c.convertedOn)}. ` : ''}
                    {fullName(convertedTo)} {convertedTo.startDate > t ? 'starts' : 'started'} as an employee {fmtDate(convertedTo.startDate)}, so the AB5
                    risk is settled. The check below stays as the record.{' '}
                    <a href={links.person(convertedTo.id)} className="-my-2.5 inline-flex min-h-10 items-center font-semibold text-accent underline">
                      Open employee #{convertedTo.hireNumber}
                    </a>
                  </Callout>
                )}
                <Ab5Check
                  value={ab5Value}
                  onChange={(v) => setAb5(v)}
                  onConvert={convertedTo ? undefined : () => navigate('people', 'new', c.id)}
                  onEndBy={convertedTo ? undefined : (d) => setEndBy(d)}
                  endBy={endBy}
                />
                {endBy && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      variant="primary"
                      icon="calendar"
                      onClick={() => {
                        update(`Set ${name}'s contract to end ${fmtDate(endBy)}`, (k) => {
                          k.endOn = endBy
                        })
                        setEndBy(null)
                      }}
                    >
                      End the contract {fmtDate(endBy)}
                    </Button>
                    <Button variant="ghost" onClick={() => setEndBy(null)}>
                      Cancel
                    </Button>
                  </div>
                )}
              </Panel>
            )}

            {c.kind === 'advisor' && (admin || viewer.personId === c.managerId) && (
              <Panel title="Options" subtitle="Advisors get NSOs, usually vesting monthly over 2 years. No checklist.">
                {admin ? <AdvisorGrants c={c} /> : <p className="text-[14px] text-ink-3">Grant details are visible to Admin only.</p>}
              </Panel>
            )}
          </div>

          {admin && (
            <div className="flex min-w-0 flex-col gap-4">
              <Panel title="Paperwork">
                <ul className="flex flex-col gap-4">
                  <li>
                    <Switch
                      checked={c.w9OnFile}
                      onChange={(v) => update(v ? `Marked the W-9 on file for ${name}` : `Marked the W-9 missing for ${name}`, (k) => (k.w9OnFile = v))}
                      label="W-9 on file"
                      description="Needed for the 1099-NEC. Keep the form itself with accounting."
                    />
                  </li>
                  <li>
                    <p className="text-[14px] font-semibold text-ink">DE 542 (individuals only)</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <De542Badge db={db} c={c} />
                      <CitationChip label={DE542_CITATION.label} url={DE542_CITATION.url} />
                    </div>
                    <p className="mt-1 text-[13px] text-ink-3">Within 20 days of paying or contracting for ${db.settings.law.de542Threshold} or more in a year.</p>
                    {de542.state === 'due' && (
                      <Button className="mt-2" variant="secondary" icon="check" onClick={() => update(`Marked DE 542 filed for ${name}`, (k) => (k.de542FiledOn = t))}>
                        Mark DE 542 filed today
                      </Button>
                    )}
                  </li>
                  <li>
                    <p className="text-[14px] font-semibold text-ink">1099-NEC</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Form1099Badge db={db} c={c} />
                      <CitationChip label={FORM_1099_CITATION.label} url={FORM_1099_CITATION.url} />
                    </div>
                    <p className="mt-1 text-[13px] text-ink-3">
                      Estimated <Private>${num(form1099Flag(db, c, t).estimate)}</Private> paid in {t.slice(0, 4)} from the rate and dates.
                    </p>
                  </li>
                  <li>
                    <p className="text-[14px] font-semibold text-ink">Contract end</p>
                    <div className="mt-1">
                      <EndBadge c={c} />
                    </div>
                  </li>
                </ul>
                <NotLegalAdvice className="mt-4" />
              </Panel>
              {c.kind === 'contractor' && convertedTo && (
                <Panel title="Now an employee">
                  <p className="text-[14px] text-ink-2">
                    {fullName(convertedTo)} is employee #{convertedTo.hireNumber}, {convertedTo.startDate > t ? 'starting' : 'since'} {fmtDate(convertedTo.startDate)}. This
                    record stays for the 1099-NEC and retention.
                  </p>
                  <a
                    href={links.person(convertedTo.id)}
                    className="ft-btn ft-btn--secondary ft-btn--md mt-3 inline-flex h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-[14.5px] font-semibold text-ink hover:bg-surface-2"
                  >
                    <Icon name="user" size={18} className="ft-btn__icon" />
                    Now employee #{convertedTo.hireNumber}
                  </a>
                </Panel>
              )}
              {c.kind === 'contractor' && !convertedTo && (
                <Panel title="Convert to employee">
                  <p className="text-[14px] text-ink-2">Bring them on as a W-2 employee. The Add person sheet fills in their title, hours and rate.</p>
                  <a
                    href={href('people', 'new', c.id)}
                    className="ft-btn ft-btn--secondary ft-btn--md mt-3 inline-flex h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-[14.5px] font-semibold text-ink hover:bg-surface-2"
                  >
                    <Icon name="user-plus" size={18} className="ft-btn__icon" />
                    Convert to employee
                  </a>
                </Panel>
              )}
            </div>
          )}
        </div>
      </div>
      {admin && <EditContractorSheet c={c} open={!!editing} onClose={() => setEditing(null)} focusScope={editing === 'scope'} />}
    </>
  )
}
