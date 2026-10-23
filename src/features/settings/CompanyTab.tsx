// Settings > Company and funding: names, entity, HQ, pay schedule, funding rounds, cash and the
// inputs for runway, loaded-cost assumptions, SOC 2, and payroll registration and insurance.
// Each Save writes only the fields the user changed (SaveInfo from ./kit), so a field another computer
// saved while the form was open is never written back with the value the form opened with.
import { useMemo, useState } from 'react'
import { links } from '@/app/router'
import { assistantDisplayName, assistantNameError, defaultAssistantName, normalizeAssistantName } from '@/domain/assistant'
import { LAW_SOURCES } from '@/data/law'
import { CCPA_REVENUE_THRESHOLD } from '@/domain/compliance'
import { runway, STALE_CASH_DAYS } from '@/domain/pay'
import { dropStaleRegularPayday, monthlyScheduleProblem, paydayChangeNotice, paydayWords } from '@/domain/payrun'
import type { Company, FundingRound } from '@/domain/types'
import { daysBetween, fmtDate, today } from '@/lib/dates'
import { money, money2, moneyShort, pct } from '@/lib/format'
import { newId } from '@/lib/id'
import { useDB } from '@/store/db'
import {
  Badge,
  Button,
  ChipGroup,
  CitationChip,
  DescriptionList,
  Field,
  FormGrid,
  MoneyInput,
  Money,
  NumberInput,
  Panel,
  Private,
  Segmented,
  Switch,
  TextInput,
  TextLink,
} from '@/ui'
import { Blurrable, commit, DateField, EditablePanel, EditSheet, type FieldLabels, type FieldValues, pastPresets, Row, RowList } from './kit'
import { type HealthPlanChoice, healthPlanChoice, healthPlanProblem, linkProblem, maskDigits, normalizeWebsite, setHealthPlan } from './logic'

const ENTITY_TYPES = ['C corporation', 'Public benefit corporation', 'LLC', 'S corporation']
const INCORPORATED = ['Delaware', 'California']
const WORKWEEKS = ['Monday to Friday', 'Hybrid, office Tue to Thu', 'Remote first', 'In office']
const PAY_SCHEDULES: Array<{ value: Company['paySchedule']; label: string }> = [
  { value: 'semi_monthly', label: 'Semi-monthly' },
  { value: 'biweekly', label: 'Every two weeks' },
  { value: 'monthly', label: 'Monthly' },
]
const ROUND_NAMES = ['Pre-seed', 'Seed', 'Series A', 'Series B', 'Bridge']

function scheduleLabel(s: Company['paySchedule']) {
  return PAY_SCHEDULES.find((p) => p.value === s)?.label ?? s
}

/** An amount as the conflict notice says it ('$1,200,000', or 'blank'). */
const sayMoney = (v: number | null | undefined) => (v == null ? 'blank' : money(v))

/** Chip picker plus a free-text box for values that are usually one of a few (entity, workweek). */
function ChipsOrText({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: string[]
}) {
  return (
    <Field label={label} hint="Pick one or type your own.">
      {(id, hint) => (
        <div className="flex flex-col gap-2">
          <ChipGroup
            label={`${label} choices`}
           
            value={options.includes(value) ? value : null}
            onChange={onChange}
            options={options.map((o) => ({ value: o, label: o }))}
          />
          <TextInput id={id} aria-describedby={hint} value={value} onChange={(e) => onChange(e.target.value)} />
        </div>
      )}
    </Field>
  )
}

export function CompanyTab() {
  const company = useDB((s) => s.db.company)
  return (
    <div className="flex flex-col gap-5">
      <IdentityPanel company={company} />
      <HqPanel company={company} />
      <FundingPanel rounds={company.fundingRounds} />
      <CashPanel company={company} />
      <CostPanel company={company} />
      <HealthPlanPanel company={company} />
      <Soc2Panel company={company} />
      <RegistrationPanel company={company} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

type Identity = Pick<Company, 'name' | 'legalName' | 'entityType' | 'incorporatedIn' | 'foundedOn' | 'stage' | 'tagline'> & {
  website: string
  /** The in-app assistant's name ('' = the default, '<display name> Bot'). */
  assistantName: string
}

const IDENTITY_LABELS: FieldLabels<Identity> = {
  name: 'Display name',
  legalName: 'Legal name',
  entityType: 'Entity type',
  incorporatedIn: 'Incorporated in',
  foundedOn: 'Founded on',
  stage: 'Stage',
  tagline: 'One-line description',
  website: 'Website',
  assistantName: 'Assistant name',
}

function IdentityPanel({ company }: { company: Company }) {
  const value: Identity = {
    name: company.name,
    legalName: company.legalName,
    entityType: company.entityType,
    incorporatedIn: company.incorporatedIn,
    foundedOn: company.foundedOn,
    stage: company.stage,
    tagline: company.tagline,
    website: company.website ?? '',
    assistantName: company.assistantName ?? '',
  }
  return (
    <EditablePanel<Identity>
      title="Company"
      icon="building"
      value={value}
      editLabel="Edit company"
      saveLabel="Save company"
      validate={(d) =>
        !d.name.trim()
          ? 'Add a display name.'
          : !d.legalName.trim()
            ? 'Add the legal name as it appears on your formation documents.'
            : (linkProblem(d.website) ?? assistantNameError(d.assistantName))
      }
      fieldLabels={IDENTITY_LABELS}
      onSave={(d, { changed }) =>
        commit(
          'Updated company details',
          (draft) => {
            const c = draft.company
            const has = (k: keyof Identity) => changed.includes(k)
            if (has('name')) c.name = d.name.trim()
            if (has('legalName')) c.legalName = d.legalName.trim()
            if (has('entityType')) c.entityType = d.entityType.trim()
            if (has('incorporatedIn')) c.incorporatedIn = d.incorporatedIn.trim()
            if (has('foundedOn')) c.foundedOn = d.foundedOn
            if (has('stage')) c.stage = d.stage.trim()
            if (has('tagline')) c.tagline = d.tagline.trim()
            if (has('website')) {
              // 'ledgerlark.ai' is saved as https://ledgerlark.ai, as Start fresh saves it.
              if (d.website.trim()) c.website = normalizeWebsite(d.website)
              else delete c.website
            }
            if (has('assistantName')) {
              // An empty field goes back to the default name ('<display name> Bot').
              const name = normalizeAssistantName(d.assistantName)
              if (name) c.assistantName = name
              else delete c.assistantName
            }
          },
          { entityType: 'company', entityId: 'company' },
        )
      }
      view={
        <DescriptionList
          items={[
            { label: 'Display name', value: company.name },
            { label: 'Legal name', value: company.legalName },
            { label: 'Entity', value: [company.entityType, company.incorporatedIn && `incorporated in ${company.incorporatedIn}`].filter(Boolean).join(', ') },
            { label: 'Founded', value: fmtDate(company.foundedOn) },
            { label: 'Stage', value: company.stage },
            { label: 'Website', value: company.website },
            { label: 'One-line description', value: company.tagline },
            { label: 'Assistant name', value: company.assistantName?.trim() ? assistantDisplayName(company) : `${assistantDisplayName(company)} (the default)` },
          ]}
        />
      }
      form={(d, set) => (
        <>
          <FormGrid>
            <Field label="Display name" required hint="What people call the company.">
              {(id, hint) => <TextInput id={id} aria-describedby={hint} value={d.name} onChange={(e) => set({ name: e.target.value })} />}
            </Field>
            <Field label="Legal name" required hint="As on your formation documents and offer letters.">
              {(id, hint) => (
                <TextInput id={id} aria-describedby={hint} value={d.legalName} onChange={(e) => set({ legalName: e.target.value })} />
              )}
            </Field>
          </FormGrid>
          <ChipsOrText label="Entity type" value={d.entityType} onChange={(v) => set({ entityType: v })} options={ENTITY_TYPES} />
          <ChipsOrText label="Incorporated in" value={d.incorporatedIn} onChange={(v) => set({ incorporatedIn: v })} options={INCORPORATED} />
          <DateField label="Founded on" value={d.foundedOn} onChange={(v) => set({ foundedOn: v })} presets={pastPresets()} />
          <FormGrid>
            <ChipsOrText label="Stage" value={d.stage} onChange={(v) => set({ stage: v })} options={['Pre-seed', 'Seed', 'Series A']} />
            <Field label="Website" error={linkProblem(d.website)}>
              {(id, hint) => (
                <TextInput
                  id={id}
                  aria-describedby={hint}
                  inputMode="url"
                  placeholder="https://"
                  value={d.website}
                  onChange={(e) => set({ website: e.target.value })}
                />
              )}
            </Field>
          </FormGrid>
          <Field label="One-line description" hint="Shows on job postings.">
            {(id, hint) => <TextInput id={id} aria-describedby={hint} value={d.tagline} onChange={(e) => set({ tagline: e.target.value })} />}
          </Field>
          <Field
            label="Assistant name"
            hint={`Leave it empty to call it ${defaultAssistantName({ name: d.name })}. The header's Ask button uses this name.`}
            error={assistantNameError(d.assistantName)}
          >
            {(id, hint) => (
              <TextInput
                id={id}
                aria-describedby={hint}
                autoComplete="off"
                placeholder={defaultAssistantName({ name: d.name })}
                value={d.assistantName}
                onChange={(e) => set({ assistantName: e.target.value })}
              />
            )}
          </Field>
        </>
      )}
    />
  )
}

// ---------------------------------------------------------------------------------------------

type Hq = {
  street: string
  suite: string
  city: string
  state: string
  zip: string
  workweek: string
  paySchedule: Company['paySchedule']
  regularPayday: string
  phone: string
}

const HQ_LABELS: FieldLabels<Hq> = {
  street: 'Street',
  suite: 'Suite',
  city: 'City',
  state: 'State',
  zip: 'ZIP',
  workweek: 'Workweek',
  paySchedule: 'Pay schedule',
  regularPayday: 'Regular payday',
  phone: 'Main phone',
}

function HqPanel({ company }: { company: Company }) {
  const db = useDB((s) => s.db)
  const date = today()
  const value: Hq = {
    street: company.hq.street,
    suite: company.hq.suite ?? '',
    city: company.hq.city,
    state: company.hq.state,
    zip: company.hq.zip,
    workweek: company.workweek,
    paySchedule: company.paySchedule,
    regularPayday: company.regularPayday ?? '',
    phone: company.phone ?? '',
  }
  const address = [company.hq.street, company.hq.suite, `${company.hq.city}, ${company.hq.state} ${company.hq.zip}`]
    .filter(Boolean)
    .join(', ')
  return (
    <EditablePanel<Hq>
      title="Headquarters and pay schedule"
      icon="pin"
      value={value}
      editLabel="Edit HQ and pay"
      saveLabel="Save HQ and pay"
      validate={(d) =>
        !d.city.trim()
          ? 'Add the HQ city.'
          : !/^[A-Za-z]{2}$/.test(d.state.trim())
            ? 'Use the two-letter state code, like CA.'
            : !/^\d{5}(-\d{4})?$/.test(d.zip.trim())
              ? 'Use a 5-digit ZIP code.'
              : // Labor Code 204(a): monthly pay only when everyone on it is exempt (docs/LAW.md w-pay-frequency).
                d.paySchedule === 'monthly' && company.paySchedule !== 'monthly'
                ? monthlyScheduleProblem(db, date)
                : null
      }
      fieldLabels={HQ_LABELS}
      fieldValues={{ paySchedule: scheduleLabel }}
      onSave={(d, { changed }) =>
        commit(
          'Updated HQ and pay schedule',
          (draft) => {
            const c = draft.company
            const has = (k: keyof Hq) => changed.includes(k)
            if (has('street')) c.hq.street = d.street.trim()
            if (has('suite')) {
              if (d.suite.trim()) c.hq.suite = d.suite.trim()
              else delete c.hq.suite
            }
            if (has('city')) c.hq.city = d.city.trim()
            if (has('state')) c.hq.state = d.state.trim().toUpperCase()
            if (has('zip')) c.hq.zip = d.zip.trim()
            if (has('workweek')) c.workweek = d.workweek.trim()
            if (has('paySchedule')) {
              const before = { paySchedule: c.paySchedule, payroll: c.payroll }
              c.paySchedule = d.paySchedule
              // A 'Regular payday' that only repeated the old schedule's words would print stale on the wage notice.
              if (!has('regularPayday')) dropStaleRegularPayday(draft, before)
            }
            if (has('regularPayday')) {
              if (d.regularPayday.trim()) c.regularPayday = d.regularPayday.trim()
              else delete c.regularPayday
            }
            if (has('phone')) {
              if (d.phone.trim()) c.phone = d.phone.trim()
              else delete c.phone
            }
          },
          { entityType: 'company', entityId: 'company' },
        )
      }
      view={
        <DescriptionList
          items={[
            { label: 'HQ address', value: address },
            { label: 'Workweek', value: company.workweek },
            { label: 'Pay schedule', value: scheduleLabel(company.paySchedule) },
            { label: 'Regular payday', value: company.regularPayday || `${paydayWords(company)} (from the pay calendar)` },
            { label: 'Main phone', value: company.phone },
          ]}
        />
      }
      form={(d, set) => (
        <>
          <FormGrid>
            <Field label="Street" hint="The office address. Employee home addresses are never stored.">
              {(id, hint) => <TextInput id={id} aria-describedby={hint} value={d.street} onChange={(e) => set({ street: e.target.value })} />}
            </Field>
            <Field label="Suite">
              {(id) => <TextInput id={id} value={d.suite} onChange={(e) => set({ suite: e.target.value })} />}
            </Field>
            <Field label="City" required>
              {(id) => <TextInput id={id} value={d.city} onChange={(e) => set({ city: e.target.value })} />}
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="State" required>
                {(id) => (
                  <TextInput id={id} maxLength={2} value={d.state} onChange={(e) => set({ state: e.target.value.toUpperCase() })} />
                )}
              </Field>
              <Field label="ZIP" required>
                {(id) => <TextInput id={id} inputMode="numeric" value={d.zip} onChange={(e) => set({ zip: e.target.value })} />}
              </Field>
            </div>
          </FormGrid>
          <ChipsOrText label="Workweek" value={d.workweek} onChange={(v) => set({ workweek: v })} options={WORKWEEKS} />
          <div className="flex flex-col gap-1.5">
            <span className="text-[13.5px] font-semibold text-ink-2">Pay schedule</span>
            <Segmented label="Pay schedule" value={d.paySchedule} onChange={(v) => set({ paySchedule: v })} options={PAY_SCHEDULES} />
            {d.paySchedule !== company.paySchedule && paydayChangeNotice(db, date) && <p className="text-[13px] text-ink-2">{paydayChangeNotice(db, date)}</p>}
            <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
              <CitationChip label={LAW_SOURCES.lc204.label} url={LAW_SOURCES.lc204.url} />
              <span>Monthly pay is only for exempt staff. Not legal advice.</span>
            </span>
          </div>
          <FormGrid>
            <Field label="Regular payday" hint="In plain words, for the Labor Code 2810.5 wage notice. Leave it blank to print the pay calendar's own words (Pay runs), shown here.">
              {(id, hint) => (
                <TextInput
                  id={id}
                  aria-describedby={hint}
                  placeholder={paydayWords({ paySchedule: d.paySchedule, payroll: company.payroll })}
                  value={d.regularPayday}
                  onChange={(e) => set({ regularPayday: e.target.value })}
                />
              )}
            </Field>
            <Field label="Main phone" hint="Also printed on the wage notice.">
              {(id, hint) => (
                <TextInput id={id} aria-describedby={hint} inputMode="tel" value={d.phone} onChange={(e) => set({ phone: e.target.value })} />
              )}
            </Field>
          </FormGrid>
        </>
      )}
    />
  )
}

// ---------------------------------------------------------------------------------------------

const ROUND_VALUES: FieldValues<FundingRound> = {
  instrument: (v) => (v === 'SAFE' ? 'SAFE' : 'Priced round'),
  amount: sayMoney,
  postMoney: sayMoney,
  pricePerShare: (v) => (v == null ? 'blank' : money2(v)),
}

const ROUND_LABELS: FieldLabels<FundingRound> = {
  name: 'Round',
  instrument: 'Instrument',
  closedOn: 'Closed on',
  amount: 'Amount raised',
  postMoney: 'Post-money valuation',
  leadInvestor: 'Lead investor',
  pricePerShare: 'Preferred price per share',
}

function blankRound(): FundingRound {
  return { id: newId('fr'), name: 'Seed', closedOn: today(), amount: 0, instrument: 'Priced' }
}

function roundMeta(r: FundingRound) {
  return (
    <>
      <Private>{moneyShort(r.amount)}</Private>
      {r.postMoney ? (
        <>
          {' at '}
          <Private>{moneyShort(r.postMoney)}</Private> post
        </>
      ) : null}
      {r.pricePerShare ? (
        <>
          {', '}
          <Private>{money2(r.pricePerShare)}</Private> a share
        </>
      ) : null}
      {r.leadInvestor ? `, led by ${r.leadInvestor}` : ''}
    </>
  )
}

function FundingPanel({ rounds }: { rounds: FundingRound[] }) {
  const [editing, setEditing] = useState<FundingRound | null>(null)
  const sorted = useMemo(() => [...rounds].sort((a, b) => a.closedOn.localeCompare(b.closedOn)), [rounds])
  const isNew = editing ? !rounds.some((r) => r.id === editing.id) : false
  const total = rounds.reduce((n, r) => n + (r.amount || 0), 0)
  return (
    <Panel
      title="Funding rounds"
      subtitle={rounds.length ? <>Raised <Private>{moneyShort(total)}</Private> in {rounds.length === 1 ? '1 round' : `${rounds.length} rounds`}. The headcount chart marks each one.</> : 'Add rounds as they close; the growth chart marks each one.'}
      icon="trend"
      actions={
        <Button icon="plus" onClick={() => setEditing(blankRound())}>
          Add round
        </Button>
      }
    >
      {sorted.length === 0 ? (
        <p className="text-[14px] text-ink-3">No rounds yet. Bootstrapped is a fine answer.</p>
      ) : (
        <RowList label="Funding rounds">
          {sorted.map((r) => (
            <Row
              key={r.id}
              title={r.name}
              badges={r.instrument ? <Badge>{r.instrument === 'SAFE' ? 'SAFE' : 'Priced round'}</Badge> : null}
              meta={
                <>
                  Closed {fmtDate(r.closedOn)} · {roundMeta(r)}
                </>
              }
              actions={
                <>
                  <Button size="md" icon="edit" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}>
                    Edit
                  </Button>
                  <Button
                    size="md"
                    variant="ghost"
                    icon="trash"
                    aria-label={`Remove ${r.name}`}
                    onClick={() =>
                      commit(`Removed the ${r.name} round`, (d) => {
                        d.company.fundingRounds = d.company.fundingRounds.filter((x) => x.id !== r.id)
                      }, { entityType: 'company', entityId: 'company' })
                    }
                  >
                    Remove
                  </Button>
                </>
              }
            />
          ))}
        </RowList>
      )}
      {editing && (
        <EditSheet<FundingRound>
          key={editing.id}
          open
          title={isNew ? 'Add a funding round' : `Edit ${editing.name}`}
          initial={editing}
          current={rounds.find((r) => r.id === editing.id)}
          fieldLabels={ROUND_LABELS}
          fieldValues={ROUND_VALUES}
          onClose={() => setEditing(null)}
          saveLabel={isNew ? 'Add round' : 'Save round'}
          validate={(d) => (!d.name.trim() ? 'Name the round.' : !(d.amount > 0) ? 'Add the amount raised.' : null)}
          onSave={(d, { changed }) =>
            commit(isNew ? `Added the ${d.name.trim()} round` : `Updated the ${d.name.trim()} round`, (draft) => {
              const clean: FundingRound = { ...d, name: d.name.trim() }
              if (!clean.leadInvestor?.trim()) delete clean.leadInvestor
              if (!clean.postMoney) delete clean.postMoney
              if (clean.instrument !== 'Priced' || !clean.pricePerShare) delete clean.pricePerShare
              const list = draft.company.fundingRounds
              const i = list.findIndex((x) => x.id === d.id)
              if (i < 0) {
                list.push(clean)
                return
              }
              // Only the fields changed here; the rest keep what is stored (another computer may have saved them).
              const stored = list[i]
              for (const k of changed) {
                if (clean[k] === undefined) delete (stored as Partial<FundingRound>)[k]
                else Object.assign(stored, { [k]: clean[k] })
              }
              if (stored.instrument !== 'Priced') delete stored.pricePerShare
            }, { entityType: 'company', entityId: 'company' })
          }
        >
          {(d, set) => (
            <>
              <Field label="Round" required>
                {(id) => (
                  <div className="flex flex-col gap-2">
                    <ChipGroup
                      label="Round name choices"
                     
                      value={ROUND_NAMES.includes(d.name) ? d.name : null}
                      onChange={(v) => set({ name: v })}
                      options={ROUND_NAMES.map((n) => ({ value: n, label: n }))}
                    />
                    <TextInput id={id} value={d.name} onChange={(e) => set({ name: e.target.value })} />
                  </div>
                )}
              </Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-[13.5px] font-semibold text-ink-2">Instrument</span>
                <Segmented
                  label="Instrument"
                  value={d.instrument ?? 'Priced'}
                  onChange={(v) => set({ instrument: v })}
                  options={[
                    { value: 'SAFE', label: 'SAFE' },
                    { value: 'Priced', label: 'Priced round' },
                  ]}
                />
              </div>
              <DateField label="Closed on" value={d.closedOn} onChange={(v) => set({ closedOn: v })} presets={pastPresets()} />
              <FormGrid>
                <Field label="Amount raised" required>
                  {(id) => (
                    <Blurrable>
                      <MoneyInput id={id} value={d.amount || null} onChange={(v) => set({ amount: v ?? 0 })} />
                    </Blurrable>
                  )}
                </Field>
                <Field label="Post-money valuation" hint="Leave blank for an uncapped SAFE.">
                  {(id, hint) => (
                    <Blurrable>
                      <MoneyInput id={id} aria-describedby={hint} value={d.postMoney ?? null} onChange={(v) => set({ postMoney: v ?? undefined })} />
                    </Blurrable>
                  )}
                </Field>
                <Field label="Lead investor">
                  {(id) => <TextInput id={id} value={d.leadInvestor ?? ''} onChange={(e) => set({ leadInvestor: e.target.value })} />}
                </Field>
                {d.instrument === 'Priced' && (
                  <Field label="Preferred price per share" hint="A priced round usually ends the current 409A safe harbor.">
                    {(id, hint) => (
                      <Blurrable>
                        <NumberInput
                          id={id}
                          aria-describedby={hint}
                          prefix="$"
                          step="0.01"
                          min={0}
                          value={d.pricePerShare ?? null}
                          onChange={(v) => set({ pricePerShare: v ?? undefined })}
                        />
                      </Blurrable>
                    )}
                  </Field>
                )}
              </FormGrid>
            </>
          )}
        </EditSheet>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------

type Cash = {
  cashOnHand: number | null
  cashAsOf: string
  otherMonthlySpend: number | null
  monthlyRevenue: number | null
  annualRevenue: number | null
}

const CASH_LABELS: FieldLabels<Cash> = {
  cashOnHand: 'Cash on hand',
  cashAsOf: 'Cash as of',
  otherMonthlySpend: 'Other monthly spend',
  monthlyRevenue: 'Monthly revenue',
  annualRevenue: 'Trailing 12-month revenue',
}

function CashPanel({ company }: { company: Company }) {
  const db = useDB((s) => s.db)
  const rw = useMemo(() => runway(db, today()), [db])
  const stale = company.cashAsOf ? daysBetween(company.cashAsOf, today()) > STALE_CASH_DAYS : false
  const value: Cash = {
    cashOnHand: company.cashOnHand ?? null,
    cashAsOf: company.cashAsOf ?? today(),
    otherMonthlySpend: company.otherMonthlySpend ?? null,
    monthlyRevenue: company.monthlyRevenue ?? null,
    annualRevenue: company.annualRevenue ?? null,
  }
  return (
    <EditablePanel<Cash>
      title="Cash, spend and revenue"
      subtitle="Runway in Comp and plan comes from these."
      icon="coins"
      value={value}
      editLabel="Update cash"
      saveLabel="Save cash and spend"
      fieldLabels={CASH_LABELS}
      fieldValues={{ cashOnHand: sayMoney, otherMonthlySpend: sayMoney, monthlyRevenue: sayMoney, annualRevenue: sayMoney }}
      onSave={(d, { changed }) =>
        commit(
          'Updated cash, spend and revenue',
          (draft) => {
            const c = draft.company
            const setNum = (k: 'cashOnHand' | 'otherMonthlySpend' | 'monthlyRevenue' | 'annualRevenue', v: number | null) => {
              if (!changed.includes(k)) return
              if (v == null) delete c[k]
              else c[k] = v
            }
            setNum('cashOnHand', d.cashOnHand)
            // A cash figure always gets its date (the form shows today until one is picked).
            if (changed.includes('cashAsOf') || (changed.includes('cashOnHand') && !c.cashAsOf)) c.cashAsOf = d.cashAsOf
            setNum('otherMonthlySpend', d.otherMonthlySpend)
            setNum('monthlyRevenue', d.monthlyRevenue)
            setNum('annualRevenue', d.annualRevenue)
          },
          { entityType: 'company', entityId: 'company', log: 'Updated cash, spend and revenue figures' },
        )
      }
      view={
        <div className="flex flex-col gap-4">
          <DescriptionList
            columns={3}
            items={[
              {
                label: 'Cash on hand',
                value: (
                  <>
                    <Money value={company.cashOnHand} />
                    {company.cashAsOf && <span className="text-ink-3"> as of {fmtDate(company.cashAsOf)}</span>}
                  </>
                ),
              },
              { label: 'Other monthly spend', value: <Money value={company.otherMonthlySpend} /> },
              { label: 'Monthly revenue', value: <Money value={company.monthlyRevenue} /> },
              { label: 'Trailing 12-month revenue', value: <Money value={company.annualRevenue} /> },
            ]}
          />
          <p className="text-[14px] text-ink-2">
            {company.cashOnHand == null ? 'Add cash on hand to see runway.' : <Private>{rw.text}</Private>}{' '}
            <TextLink href={links.comp('cost')}>See cost and runway</TextLink>
          </p>
          {stale && (
            <p className="text-[13.5px] font-semibold text-warn">
              Cash is from {fmtDate(company.cashAsOf)}, more than {STALE_CASH_DAYS} days ago. Update it for an honest runway.
            </p>
          )}
        </div>
      }
      form={(d, set) => (
        <>
          <FormGrid>
            <Field label="Cash on hand">
              {(id) => (
                <Blurrable>
                  <MoneyInput id={id} value={d.cashOnHand} onChange={(v) => set({ cashOnHand: v })} />
                </Blurrable>
              )}
            </Field>
            <Field label="Other monthly spend" hint="Everything but payroll and contractors: cloud, office, tools.">
              {(id, hint) => (
                <Blurrable>
                  <MoneyInput id={id} aria-describedby={hint} value={d.otherMonthlySpend} onChange={(v) => set({ otherMonthlySpend: v })} />
                </Blurrable>
              )}
            </Field>
          </FormGrid>
          <DateField label="Cash as of" value={d.cashAsOf} onChange={(v) => set({ cashAsOf: v })} presets={pastPresets()} />
          <FormGrid>
            <Field label="Monthly revenue">
              {(id) => (
                <Blurrable>
                  <MoneyInput id={id} value={d.monthlyRevenue} onChange={(v) => set({ monthlyRevenue: v })} />
                </Blurrable>
              )}
            </Field>
            <Field
              label="Trailing 12-month revenue"
              hint={`Only used to say when California's CCPA employee-data rules apply (above ${moneyShort(CCPA_REVENUE_THRESHOLD)}).`}
            >
              {(id, hint) => (
                <Blurrable>
                  <MoneyInput id={id} aria-describedby={hint} value={d.annualRevenue} onChange={(v) => set({ annualRevenue: v })} />
                </Blurrable>
              )}
            </Field>
          </FormGrid>
        </>
      )}
    />
  )
}

// ---------------------------------------------------------------------------------------------

type Cost = { benefits: number | null; peoTools: number | null; wcPct: number | null }

function CostPanel({ company }: { company: Company }) {
  const m = company.costModel
  const value: Cost = {
    benefits: m.benefitsPerHeadMonthly,
    peoTools: m.peoToolsPerHeadMonthly,
    wcPct: Math.round(m.workersCompPct * 100_000) / 1000,
  }
  return (
    <EditablePanel<Cost>
      title="Loaded-cost assumptions"
      subtitle="Added to base pay for the fully loaded run-rate. Employer taxes come from Rules and rates."
      icon="chart"
      value={value}
      editLabel="Edit assumptions"
      saveLabel="Save assumptions"
      validate={(d) =>
        d.wcPct != null && (d.wcPct < 0 || d.wcPct > 20) ? "Workers' comp is usually well under 5% of wages for office work." : null
      }
      fieldLabels={{ benefits: 'Benefits per person', peoTools: 'PEO and tools per person', wcPct: "Workers' comp" }}
      fieldValues={{ benefits: sayMoney, peoTools: sayMoney, wcPct: (v) => (v == null ? 'blank' : `${v}% of wages`) }}
      onSave={(d, { changed }) =>
        commit('Updated loaded-cost assumptions', (draft) => {
          const cm = draft.company.costModel
          if (changed.includes('benefits')) cm.benefitsPerHeadMonthly = d.benefits ?? 0
          if (changed.includes('peoTools')) cm.peoToolsPerHeadMonthly = d.peoTools ?? 0
          if (changed.includes('wcPct')) cm.workersCompPct = (d.wcPct ?? 0) / 100
        }, { entityType: 'company', entityId: 'company' })
      }
      view={
        <div className="flex flex-col gap-3">
          <DescriptionList
            columns={3}
            items={[
              { label: 'Benefits per person, monthly', value: <Money value={m.benefitsPerHeadMonthly} /> },
              { label: 'PEO and tools per person, monthly', value: <Money value={m.peoToolsPerHeadMonthly} /> },
              { label: "Workers' comp", value: `${pct(m.workersCompPct, 2)} of wages` },
            ]}
          />
          <p className="text-[13.5px] text-ink-3">
            Employer taxes (Social Security, Medicare, FUTA, CA UI and ETT) are set in{' '}
            <TextLink href={links.settings('rules')}>Rules and rates</TextLink>.
          </p>
        </div>
      }
      form={(d, set) => (
        <FormGrid>
          <Field label="Benefits per person, monthly" hint="Employer share of medical, dental and vision.">
            {(id, hint) => (
              <Blurrable>
                <MoneyInput id={id} aria-describedby={hint} value={d.benefits} onChange={(v) => set({ benefits: v })} />
              </Blurrable>
            )}
          </Field>
          <Field label="PEO and tools per person, monthly" hint="PEO fee, laptop lease, software seats.">
            {(id, hint) => (
              <Blurrable>
                <MoneyInput id={id} aria-describedby={hint} value={d.peoTools} onChange={(v) => set({ peoTools: v })} />
              </Blurrable>
            )}
          </Field>
          <Field label="Workers' comp, % of wages" hint="From your policy. Office work is often 0.2% to 0.5%.">
            {(id, hint) => (
              <NumberInput id={id} aria-describedby={hint} suffix="%" step="0.01" min={0} value={d.wcPct} onChange={(v) => set({ wcPct: v })} />
            )}
          </Field>
        </FormGrid>
      )}
    />
  )
}

// ---------------------------------------------------------------------------------------------

type HealthPlan = { offered: HealthPlanChoice; startedOn: string }

const HEALTH_PLAN_CHOICES: Array<{ value: HealthPlanChoice; label: string }> = [
  { value: 'yes', label: 'We offer one' },
  { value: 'no', label: 'No plan' },
  { value: 'unknown', label: 'Not recorded' },
]

/** Company.groupHealthPlanStartedOn: a date, null for no plan (COBRA rules do not apply), or not recorded yet. */
function HealthPlanPanel({ company }: { company: Company }) {
  const on = company.groupHealthPlanStartedOn
  const value: HealthPlan = { offered: healthPlanChoice(on), startedOn: on ?? '' }
  return (
    <EditablePanel<HealthPlan>
      title="Group health plan"
      subtitle="Starts the first group health plan milestone. With no plan, Cal-COBRA and federal COBRA do not apply."
      icon="heart"
      value={value}
      editLabel="Edit health plan"
      saveLabel="Save health plan"
      validate={(d) => healthPlanProblem(d.offered, d.startedOn)}
      fieldLabels={{ offered: 'Group health plan', startedOn: 'Plan started on' }}
      onSave={(d, { changed }) =>
        // One stored field: the choice and its date are written together, and only when either changed.
        changed.length
          ? commit(
              d.offered === 'yes' ? 'Recorded the group health plan start date' : d.offered === 'no' ? 'Recorded no group health plan' : 'Cleared the group health plan',
              (draft) => setHealthPlan(draft.company, d.offered, d.startedOn),
              { entityType: 'company', entityId: 'company' },
            )
          : commit('Nothing changed', () => {})
      }
      view={
        <div className="flex flex-col gap-3">
          <DescriptionList
            items={[{ label: 'Group health plan', value: on ? `Started ${fmtDate(on)}` : on === null ? 'None offered' : '' }]}
          />
          <p className="text-[13.5px] text-ink-3">
            Used by <TextLink href={links.compliance('milestones')}>Compliance milestones</TextLink> and the offboarding checklist.
          </p>
        </div>
      }
      form={(d, set) => (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13.5px] font-semibold text-ink-2">Does the company offer a group health plan?</span>
            <Segmented
              label="Does the company offer a group health plan?"
              value={d.offered}
              onChange={(v) => set({ offered: v })}
              options={HEALTH_PLAN_CHOICES}
            />
          </div>
          {d.offered === 'yes' && (
            <DateField
              label="Plan started on"
              value={d.startedOn || null}
              onChange={(v) => set({ startedOn: v })}
              presets={pastPresets()}
              hint="The first day of coverage under the company's group plan (often the first of a month)."
            />
          )}
        </>
      )}
    />
  )
}

// ---------------------------------------------------------------------------------------------

type Soc2 = { on: boolean; typeIReportOn: string; from: string; to: string }

function Soc2Panel({ company }: { company: Company }) {
  const value: Soc2 = {
    on: company.soc2Enabled,
    typeIReportOn: company.soc2?.typeIReportOn ?? '',
    from: company.soc2?.typeIIWindow?.from ?? '',
    to: company.soc2?.typeIIWindow?.to ?? '',
  }
  const w = company.soc2?.typeIIWindow
  return (
    <EditablePanel<Soc2>
      title="SOC 2"
      subtitle="Turns on the people-evidence pack in Compliance. Financial customers ask for it early."
      icon="shield-check"
      value={value}
      editLabel="Edit SOC 2"
      saveLabel="Save SOC 2"
      validate={(d) => (d.from && d.to && d.to <= d.from ? 'The Type II window must end after it starts.' : null)}
      fieldLabels={{ on: 'SOC 2 evidence', typeIReportOn: 'Type I report date', from: 'Type II window start', to: 'Type II window end' }}
      onSave={(d, { changed }) =>
        commit(!changed.includes('on') ? 'Updated SOC 2 dates' : d.on ? 'Turned on SOC 2 evidence' : 'Turned off SOC 2 evidence', (draft) => {
          const c = draft.company
          if (changed.includes('on')) c.soc2Enabled = d.on
          const soc2: NonNullable<Company['soc2']> = { ...c.soc2 }
          if (changed.includes('typeIReportOn')) {
            if (d.typeIReportOn) soc2.typeIReportOn = d.typeIReportOn
            else delete soc2.typeIReportOn
          }
          // The window's two ends are saved as a pair.
          if (changed.includes('from') || changed.includes('to')) {
            if (d.from && d.to) soc2.typeIIWindow = { from: d.from, to: d.to }
            else delete soc2.typeIIWindow
          }
          if (Object.keys(soc2).length) c.soc2 = soc2
          else delete c.soc2
        }, { entityType: 'company', entityId: 'company' })
      }
      view={
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {company.soc2Enabled ? (
              <Badge tone="good" icon="check">
                On
              </Badge>
            ) : (
              <Badge>Off</Badge>
            )}
            {company.soc2Enabled && (
              <TextLink href={links.compliance('soc2')}>Open SOC 2 evidence</TextLink>
            )}
          </div>
          <DescriptionList
            items={[
              { label: 'Type I report', value: company.soc2?.typeIReportOn ? fmtDate(company.soc2.typeIReportOn) : '' },
              { label: 'Type II window', value: w ? `${fmtDate(w.from)} to ${fmtDate(w.to)}` : '' },
            ]}
          />
        </div>
      }
      form={(d, set) => (
        <>
          <Switch
            label="SOC 2 evidence"
            description="Shows the 5 people controls, gaps with Fix buttons and CSV exports."
            checked={d.on}
            onChange={(v) => set({ on: v })}
          />
          <DateField label="Type I report date" value={d.typeIReportOn || null} onChange={(v) => set({ typeIReportOn: v })} presets={pastPresets()} />
          <DateField
            label="Type II window starts"
            value={d.from || null}
            onChange={(v) => set({ from: v })}
            presets={[
              { label: '1st of this month', date: `${today().slice(0, 8)}01` },
              { label: `Jan 1, ${today().slice(0, 4)}`, date: `${today().slice(0, 4)}-01-01` },
            ]}
          />
          <DateField
            label="Type II window ends"
            value={d.to || null}
            onChange={(v) => set({ to: v })}
            presets={
              d.from
                ? [
                    { label: '3 months later', date: monthsLater(d.from, 3) },
                    { label: '6 months later', date: monthsLater(d.from, 6) },
                    { label: '12 months later', date: monthsLater(d.from, 12) },
                  ]
                : undefined
            }
          />
        </>
      )}
    />
  )
}

/** The day before the same date n months later (a window that starts Aug 1 and runs 6 months ends Jan 31). */
function monthsLater(from: string, n: number): string {
  const [y, m, day] = from.split('-').map(Number)
  const d = new Date(y, m - 1 + n, day - 1)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ---------------------------------------------------------------------------------------------

type Registration = {
  edd: string
  firstPayrollOn: string
  carrier: string
  carrierPhone: string
  policyNumber: string
  carrierAddress: string
}

function RegistrationPanel({ company }: { company: Company }) {
  const [showEdd, setShowEdd] = useState(false)
  const wc = company.workersCompCarrier
  const value: Registration = {
    edd: company.eddAccountNumber ?? '',
    firstPayrollOn: company.firstPayrollOn ?? '',
    carrier: wc?.name ?? '',
    carrierPhone: wc?.phone ?? '',
    policyNumber: wc?.policyNumber ?? '',
    carrierAddress: wc?.address ?? '',
  }
  return (
    <EditablePanel<Registration>
      title="Payroll registration and workers' comp"
      subtitle="Printed on the wage notice and the SB 294 notice. The EDD number stays masked until you show it."
      icon="file"
      value={value}
      editLabel="Edit registration"
      saveLabel="Save registration"
      fieldLabels={{
        edd: 'EDD employer account number',
        firstPayrollOn: 'First W-2 payroll',
        carrier: "Workers' comp carrier",
        carrierPhone: 'Carrier phone',
        policyNumber: 'Policy number',
        carrierAddress: 'Carrier address',
      }}
      // The EDD number stays masked: a conflict on it is only named.
      fieldValues={{ edd: false, policyNumber: 'private' }}
      onSave={(d, { changed }) =>
        commit('Updated payroll registration and insurance', (draft) => {
          const c = draft.company
          const has = (k: keyof Registration) => changed.includes(k)
          if (has('edd')) {
            if (d.edd.trim()) c.eddAccountNumber = d.edd.trim()
            else delete c.eddAccountNumber
          }
          if (has('firstPayrollOn')) {
            if (d.firstPayrollOn) c.firstPayrollOn = d.firstPayrollOn
            else delete c.firstPayrollOn
          }
          if (!has('carrier') && !has('carrierPhone') && !has('policyNumber') && !has('carrierAddress')) return
          // No carrier name means no carrier record; otherwise each changed detail is written on its own.
          if (!d.carrier.trim()) {
            delete c.workersCompCarrier
            return
          }
          const wc = (c.workersCompCarrier ??= { name: d.carrier.trim() })
          const detail = (k: 'carrierPhone' | 'policyNumber' | 'carrierAddress', field: 'phone' | 'policyNumber' | 'address') => {
            if (!has(k)) return
            if (d[k].trim()) wc[field] = d[k].trim()
            else delete wc[field]
          }
          if (has('carrier')) wc.name = d.carrier.trim()
          detail('carrierPhone', 'phone')
          detail('policyNumber', 'policyNumber')
          detail('carrierAddress', 'address')
        }, { entityType: 'company', entityId: 'company', log: 'Updated payroll registration and insurance details' })
      }
      view={
        <DescriptionList
          items={[
            {
              label: 'EDD employer account number',
              value: company.eddAccountNumber ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Private className="font-mono">{showEdd ? company.eddAccountNumber : maskDigits(company.eddAccountNumber)}</Private>
                  <Button variant="ghost" icon={showEdd ? 'eye-off' : 'eye'} aria-pressed={showEdd} onClick={() => setShowEdd((s) => !s)}>
                    {showEdd ? 'Hide' : 'Show'}
                  </Button>
                </span>
              ) : (
                ''
              ),
            },
            {
              label: 'First W-2 payroll',
              value: company.firstPayrollOn ? `${fmtDate(company.firstPayrollOn)} (starts the DE 1 clock)` : '',
            },
            { label: "Workers' comp carrier", value: wc ? [wc.name, wc.phone].filter(Boolean).join(', ') : '' },
            { label: 'Policy number', value: wc?.policyNumber ? <Private>{wc.policyNumber}</Private> : '' },
            { label: 'Carrier address', value: wc?.address },
          ]}
        />
      }
      form={(d, set) => (
        <>
          <FormGrid>
            <Field label="EDD employer account number" hint="From your DE 1 registration (8 digits, like 123-4567-8).">
              {(id, hint) => (
                <Blurrable>
                  <TextInput id={id} aria-describedby={hint} autoComplete="off" className="font-mono" value={d.edd} onChange={(e) => set({ edd: e.target.value })} />
                </Blurrable>
              )}
            </Field>
            <Field label="Workers' comp carrier" hint="Required before your first non-owner hire.">
              {(id, hint) => <TextInput id={id} aria-describedby={hint} value={d.carrier} onChange={(e) => set({ carrier: e.target.value })} />}
            </Field>
          </FormGrid>
          <DateField
            label="First W-2 payroll"
            value={d.firstPayrollOn || null}
            onChange={(v) => set({ firstPayrollOn: v })}
            presets={pastPresets()}
            hint="EDD registration (DE 1) is due within 15 days of first paying over $100 in a quarter."
          />
          <FormGrid>
            <Field label="Carrier phone">
              {(id) => <TextInput id={id} inputMode="tel" value={d.carrierPhone} onChange={(e) => set({ carrierPhone: e.target.value })} />}
            </Field>
            <Field label="Policy number">
              {(id) => (
                <Blurrable>
                  <TextInput id={id} autoComplete="off" value={d.policyNumber} onChange={(e) => set({ policyNumber: e.target.value })} />
                </Blurrable>
              )}
            </Field>
          </FormGrid>
          <Field label="Carrier address" hint="The wage notice needs the carrier's name, address and phone.">
            {(id, hint) => <TextInput id={id} aria-describedby={hint} value={d.carrierAddress} onChange={(e) => set({ carrierAddress: e.target.value })} />}
          </Field>
        </>
      )}
    />
  )
}
