// Settings > Rules and rates: the yearly legal values (settings.law) and employer tax rates
// (company.costModel.taxOverrides), each with its source, the date it was last reviewed and a one-tap
// "Mark reviewed today". Also the Bay Area local minimum wage table and the January review prompt.
import { useMemo, useState } from 'react'
import { links } from '@/app/router'
import { DEFAULT_LAW, LAW_SOURCES, LOCAL_MIN_WAGES, PAYROLL_TAX_2026 } from '@/data/law'
import { contractors1099 } from '@/domain/compliance'
import { exemptFlags } from '@/domain/pay'
import type { LawSettings, PayrollTaxRateOverrides } from '@/domain/types'
import { addDays, fmtDate, isWeekday, today } from '@/lib/dates'
import { money, money2, pct } from '@/lib/format'
import { useDB } from '@/store/db'
import {
  Badge,
  Button,
  Callout,
  ChipGroup,
  CitationChip,
  DataTable,
  Field,
  MoneyInput,
  NumberInput,
  Panel,
  Private,
  Segmented,
  TextLink,
} from '@/ui'
import { commit, EditSheet, Row, RowList } from './kit'
import { exemptFloorFrom, exemptRecheck, exemptRecheckText, reviewedDate } from './logic'

const NOT_ADVICE = 'Not legal advice; confirm with counsel or your PEO.'

const IRS_1099 = { label: 'IRS Form 1099-NEC', url: 'https://www.irs.gov/forms-pubs/about-form-1099-nec' }
const EDD_DE542 = { label: 'EDD DE 542 contractor reporting', url: 'https://edd.ca.gov/en/payroll_taxes/independent_contractor_reporting/' }

/** money: whole dollars; money2: dollars and cents (amounts the law sets to the cent). */
type Input = 'money' | 'money2' | 'hourly' | 'percent'
type Source = { label: string; url: string }

type LawKey = 'caMinWageHourly' | 'exemptSalaryMin' | 'computerProHourly' | 'computerProAnnual' | 'form1099Threshold' | 'de542Threshold'

type LawDef = { key: LawKey; label: string; hint: string; input: Input; source: Source }

const PAY_FLOORS: LawDef[] = [
  { key: 'caMinWageHourly', label: 'California minimum wage', hint: 'Every employer, from Jan 1.', input: 'hourly', source: LAW_SOURCES.caMinWage },
  {
    key: 'exemptSalaryMin',
    label: 'Exempt salary floor',
    hint: '2 x the state minimum wage x 2,080 hours. Exempt salaries below it fail the test.',
    input: 'money',
    source: LAW_SOURCES.exemptSalary,
  },
  {
    key: 'computerProHourly',
    label: 'Computer professional minimum, hourly',
    hint: 'Labor Code 515.5, adjusted by DIR each year.',
    input: 'hourly',
    source: LAW_SOURCES.computerPro,
  },
  {
    key: 'computerProAnnual',
    label: 'Computer professional minimum, annual',
    hint: 'The salaried version of the same test. Set to the cent.',
    input: 'money2',
    source: LAW_SOURCES.computerPro,
  },
]

const THRESHOLDS: LawDef[] = [
  {
    key: 'form1099Threshold',
    label: '1099-NEC reporting threshold',
    hint: 'Payments to a contractor in a year at or above this need a 1099-NEC by Jan 31. $2,000 for 2026 payments.',
    input: 'money',
    source: IRS_1099,
  },
  {
    key: 'de542Threshold',
    label: 'DE 542 contractor report threshold',
    hint: 'Individual contractors paid or contracted for this much or more are reported to EDD within 20 days.',
    input: 'money',
    source: EDD_DE542,
  },
]

type TaxKey = keyof PayrollTaxRateOverrides
type TaxDef = { key: TaxKey; label: string; hint: string; input: Input; source: Source; fallback: number }

const TAX_ROWS: TaxDef[] = [
  { key: 'socialSecurityRate', label: 'Social Security, employer', hint: 'Up to the wage base.', input: 'percent', source: LAW_SOURCES.fica, fallback: PAYROLL_TAX_2026.socialSecurityRate },
  { key: 'socialSecurityWageBase', label: 'Social Security wage base', hint: 'Wages above this owe no Social Security.', input: 'money', source: LAW_SOURCES.fica, fallback: PAYROLL_TAX_2026.socialSecurityWageBase },
  { key: 'medicareRate', label: 'Medicare, employer', hint: 'No wage base.', input: 'percent', source: LAW_SOURCES.fica, fallback: PAYROLL_TAX_2026.medicareRate },
  { key: 'futaWageBase', label: 'FUTA wage base', hint: "First $7,000 of each person's wages.", input: 'money', source: LAW_SOURCES.futa, fallback: PAYROLL_TAX_2026.futaWageBase },
  { key: 'caUiRate', label: 'California UI rate', hint: 'New employers start at 3.4%; EDD sends your rate each December.', input: 'percent', source: LAW_SOURCES.eddRates, fallback: PAYROLL_TAX_2026.caUiRate },
  { key: 'caEttRate', label: 'California ETT', hint: 'Employment Training Tax.', input: 'percent', source: LAW_SOURCES.eddRates, fallback: PAYROLL_TAX_2026.caEttRate },
  { key: 'caUiWageBase', label: 'California UI wage base', hint: 'UI and ETT apply to the first $7,000.', input: 'money', source: LAW_SOURCES.eddRates, fallback: PAYROLL_TAX_2026.caUiWageBase },
]

function fmt(v: number, input: Input): string {
  if (input === 'percent') return pct(v, 2)
  if (input === 'hourly') return `${money2(v)} an hour`
  if (input === 'money2') return money2(v)
  return money(v)
}

/** A label inside a sentence: lowercases the first word unless it is a proper noun or an acronym. */
function inSentence(label: string): string {
  const first = label.split(/[\s,]/)[0]
  if (/^(California|Social|Medicare|FUTA|DE|ETT|SDI)$/.test(first) || /\d/.test(first)) return label
  return label.charAt(0).toLowerCase() + label.slice(1)
}

function isStale(reviewed: string, year: number): boolean {
  return reviewed < `${year}-01-01`
}

function ReviewedBadge({ date }: { date: string }) {
  const year = Number(today().slice(0, 4))
  return isStale(date, year) ? (
    <Badge tone="warn" icon="alert" title={`Last reviewed ${fmtDate(date)}`}>
      Review for {year}
    </Badge>
  ) : (
    <Badge tone="good" icon="check" title={`Last reviewed ${fmtDate(date)}`}>
      Reviewed
    </Badge>
  )
}

function markReviewed(key: string, label: string) {
  commit(`Marked ${inSentence(label)} reviewed today`, (d) => {
    d.settings.law.reviewedOn = { ...(d.settings.law.reviewedOn ?? {}), [key]: today() }
  })
}

export function RulesTab() {
  const law = useDB((s) => s.db.settings.law)
  return (
    <div className="flex flex-col gap-5">
      <ReviewPrompt law={law} />
      <LawPanel
        title={`California pay floors for ${law.year}`}
        subtitle="Used by the exempt check on offers, pay changes and the yearly recheck."
        icon="scale"
        defs={PAY_FLOORS}
        law={law}
        extra={<YearControl law={law} />}
      />
      <LawPanel
        title="Contractor reporting thresholds"
        subtitle="Used for the 1099-NEC list and DE 542 reminders."
        icon="file"
        defs={THRESHOLDS}
        law={law}
        extra={<Form1099Note />}
      />
      <LocalWagesPanel />
      <TaxPanel />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

function ReviewPrompt({ law }: { law: LawSettings }) {
  const db = useDB((s) => s.db)
  const t = today()
  const year = Number(t.slice(0, 4))
  const month = Number(t.slice(5, 7))
  const keys = [...PAY_FLOORS, ...THRESHOLDS].map((d) => d.key as string).concat(TAX_ROWS.map((r) => `tax.${r.key}`))
  const stale = keys.filter((k) => isStale(reviewedDate(law, k), year)).length
  const flags = useMemo(() => exemptFlags(db, t), [db, t])
  // Only exempt people with a salary on file are checked; the others are named, not counted as passing.
  const recheck = useMemo(() => exemptRecheck(db, t), [db, t])
  const december = month === 12
  return (
    <Panel title="Yearly review" icon="calendar-check" subtitle="Minimum wages, the exempt floor and wage bases change on January 1.">
      <div className="flex flex-col gap-3">
        {december ? (
          <Callout tone="warn" title={`Next year's rates are out. Review them before Jan 1, ${year + 1}.`}>
            Check the state and city minimum wages, the exempt floor, the computer professional minimum and the Social Security wage
            base. Then switch the rate year to {year + 1}.
          </Callout>
        ) : stale > 0 ? (
          <Callout tone="warn" title={`${stale} ${stale === 1 ? 'value was' : 'values were'} last reviewed before Jan 1, ${year}.`}>
            Rates often change each January. Check each one against its source, then mark it reviewed.
          </Callout>
        ) : (
          <Callout tone="good" title={`Every value has been reviewed for ${year}.`}>
            Last full review {fmtDate(law.lastReviewedOn)}.
          </Callout>
        )}
        {flags.length > 0 ? (
          <Callout tone="bad" title={`${flags.length} exempt ${flags.length === 1 ? 'salary is' : 'salaries are'} below the floor`}>
            <ul className="mt-1 flex flex-col gap-1">
              {flags.map((f) => (
                <li key={f.personId}>
                  <TextLink href={links.person(f.personId, 'job')}>{f.name}</TextLink>: <Private>{f.text}</Private>
                </li>
              ))}
            </ul>
          </Callout>
        ) : (
          <p className="text-[14px] text-ink-2">Exempt recheck: {exemptRecheckText(recheck, law.exemptSalaryMin)}</p>
        )}
        {recheck.noSalary.length > 0 && (
          <p className="text-[14px] text-ink-2">
            No salary on file:{' '}
            {recheck.noSalary.map((p, i) => (
              <span key={p.personId}>
                {i > 0 && ', '}
                <TextLink href={links.person(p.personId, 'job')}>{p.name}</TextLink>
                {p.founder && ' (founder)'}
              </span>
            ))}
            . Pay is checked once it is recorded (Change job or pay on the profile).
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            icon="check"
            onClick={() =>
              commit('Marked all rules and rates reviewed today', (d) => {
                d.settings.law.lastReviewedOn = today()
                delete d.settings.law.reviewedOn
              })
            }
          >
            Mark all reviewed today
          </Button>
          <span className="text-[13px] text-ink-3">{NOT_ADVICE}</span>
        </div>
      </div>
    </Panel>
  )
}

/** The 1099-NEC list for this year's payments, built from contractor records (rate x time worked). */
function Form1099Note() {
  const db = useDB((s) => s.db)
  const year = Number(today().slice(0, 4))
  const list = useMemo(() => contractors1099(db, year), [db, year])
  // Jan 31 rolls to the next business day when it falls on a weekend (Jan 31, 2027 is a Sunday).
  let due = `${year + 1}-01-31`
  while (!isWeekday(due)) due = addDays(due, 1)
  return (
    <p className="mb-3 rounded-xl bg-surface-2 px-3.5 py-2.5 text-[14px] text-ink-2">
      {list.length === 0
        ? `No contractors look likely to reach the 1099-NEC threshold for ${year} payments.`
        : `For ${year} payments, ${list.length === 1 ? '1 contractor looks' : `${list.length} contractors look`} likely to need a 1099-NEC by ${fmtDate(due)}: ${list.map((x) => x.contractor.name).join(', ')}. `}
      <TextLink href={links.people('contractors')}>See contractors</TextLink>
    </p>
  )
}

function YearControl({ law }: { law: LawSettings }) {
  const year = Number(today().slice(0, 4))
  const options = [...new Set([year - 1, year, year + 1, law.year])].sort()
  return (
    <div className="mb-3 flex flex-col gap-1.5">
      <span className="text-[13.5px] font-semibold text-ink-2">Rate year</span>
      <Segmented
        label="Rate year"
       
        value={String(law.year)}
        onChange={(v) =>
          commit(`Set the rate year to ${v}`, (d) => {
            d.settings.law.year = Number(v)
          })
        }
        options={options.map((y) => ({ value: String(y), label: String(y) }))}
      />
    </div>
  )
}

function LawPanel({
  title,
  subtitle,
  icon,
  defs,
  law,
  extra,
}: {
  title: string
  subtitle: string
  icon: 'scale' | 'file'
  defs: LawDef[]
  law: LawSettings
  extra?: React.ReactNode
}) {
  const [editing, setEditing] = useState<LawDef | null>(null)
  return (
    <Panel title={title} subtitle={subtitle} icon={icon}>
      {extra}
      <RowList label={title}>
        {defs.map((def) => {
          const reviewed = reviewedDate(law, def.key)
          const isDefault = law[def.key] === DEFAULT_LAW[def.key]
          return (
            <Row
              key={def.key}
              title={def.label}
              badges={<ReviewedBadge date={reviewed} />}
              meta={
                <span className="flex flex-col gap-1.5">
                  <span>
                    <span className="num font-semibold text-ink">{fmt(law[def.key], def.input)}</span>
                    {!isDefault && <span> (default {fmt(DEFAULT_LAW[def.key], def.input)})</span>}
                    {' · '}
                    {def.hint}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <CitationChip label={def.source.label} url={def.source.url} />
                    <span>Last reviewed {fmtDate(reviewed)}</span>
                  </span>
                </span>
              }
              actions={
                <>
                  <Button icon="check" onClick={() => markReviewed(def.key, def.label)} aria-label={`Mark ${def.label} reviewed today`}>
                    Mark reviewed today
                  </Button>
                  <Button variant="ghost" icon="edit" onClick={() => setEditing(def)} aria-label={`Edit ${def.label}`}>
                    Edit
                  </Button>
                </>
              }
            />
          )
        })}
      </RowList>
      <p className="mt-3 text-[13px] text-ink-3">{NOT_ADVICE}</p>
      {editing && (
        <EditSheet<{ value: number | null }>
          key={editing.key}
          open
          title={`Edit ${inSentence(editing.label)}`}
          subtitle="Saving also marks it reviewed today."
          initial={{ value: law[editing.key] }}
          onClose={() => setEditing(null)}
          saveLabel="Save value"
          validate={(d) => (d.value == null || d.value <= 0 ? 'Enter a value above zero.' : null)}
          onSave={(d) =>
            commit(`Updated ${inSentence(editing.label)}`, (draft) => {
              draft.settings.law[editing.key] = d.value ?? 0
              draft.settings.law.reviewedOn = { ...(draft.settings.law.reviewedOn ?? {}), [editing.key]: today() }
            })
          }
        >
          {(d, set) => (
            <>
              <ValueInput label={editing.label} input={editing.input} value={d.value} onChange={(v) => set({ value: v })} />
              <p className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-2">
                Check it against <CitationChip label={editing.source.label} url={editing.source.url} />
              </p>
              {editing.key === 'exemptSalaryMin' && (
                <Button onClick={() => set({ value: exemptFloorFrom(law.caMinWageHourly) })}>
                  Use 2 x {money2(law.caMinWageHourly)} x 2,080 = {money(exemptFloorFrom(law.caMinWageHourly))}
                </Button>
              )}
              {d.value !== DEFAULT_LAW[editing.key] && (
                <Button variant="ghost" icon="rotate-ccw" onClick={() => set({ value: DEFAULT_LAW[editing.key] })}>
                  Use the built-in {DEFAULT_LAW.year} value ({fmt(DEFAULT_LAW[editing.key], editing.input)})
                </Button>
              )}
            </>
          )}
        </EditSheet>
      )}
    </Panel>
  )
}

function ValueInput({ label, input, value, onChange }: { label: string; input: Input; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <Field label={input === 'percent' ? `${label} (%)` : label}>
      {(id) =>
        input === 'money' ? (
          <MoneyInput id={id} value={value} onChange={onChange} />
        ) : input === 'hourly' || input === 'money2' ? (
          <NumberInput id={id} prefix="$" step="0.01" min={0} value={value} onChange={onChange} />
        ) : (
          <NumberInput
            id={id}
            suffix="%"
            step="0.01"
            min={0}
            value={value == null ? null : Math.round(value * 1_000_000) / 10_000}
            onChange={(v) => onChange(v == null ? null : v / 100)}
          />
        )
      }
    </Field>
  )
}

// ---------------------------------------------------------------------------------------------

type WageRow = { city: string; hourly: number; effective: string; next?: { hourly: number; effective: string }; isState?: boolean }

function LocalWagesPanel() {
  const law = useDB((s) => s.db.settings.law)
  const locations = useDB((s) => s.db.locations)
  const hq = locations.find((l) => l.kind === 'hq')
  const rows: WageRow[] = [
    { city: 'California (statewide)', hourly: law.caMinWageHourly, effective: `${law.year}-01-01`, isState: true },
    ...LOCAL_MIN_WAGES,
  ]
  const hqRow = hq?.city ? LOCAL_MIN_WAGES.find((r) => r.city.toLowerCase() === hq.city?.toLowerCase()) : undefined
  return (
    <Panel
      title="Local minimum wages"
      subtitle="Bay Area cities set their own rates, usually each January (San Francisco in July)."
      icon="pin"
    >
      {hq && hqRow && hq.minWageHourly !== hqRow.hourly && (
        <Callout
          tone="warn"
          className="mb-3"
          title={`${hq.name} uses ${money2(hq.minWageHourly)}, but ${hqRow.city}'s rate is ${money2(hqRow.hourly)}.`}
          action={
            <Button
              onClick={() =>
                commit(`Set ${hq.name} minimum wage to ${money2(hqRow.hourly)}`, (d) => {
                  const loc = d.locations.find((l) => l.id === hq.id)
                  if (loc) {
                    loc.minWageHourly = hqRow.hourly
                    loc.minWageNote = `City of ${hqRow.city} minimum wage`
                  }
                })
              }
            >
              Update {hq.name}
            </Button>
          }
        />
      )}
      <DataTable<WageRow>
        caption="Local minimum wages"
        rows={rows}
        rowKey={(r) => r.city}
        dense
        columns={[
          {
            key: 'city',
            header: 'Where',
            cell: (r) => (
              <span className="inline-flex flex-wrap items-center gap-2 font-semibold">
                {r.city}
                {hq?.city && r.city.toLowerCase() === hq.city.toLowerCase() && <Badge tone="accent">Your HQ</Badge>}
              </span>
            ),
          },
          { key: 'hourly', header: 'Hourly', align: 'right', cell: (r) => <span className="num">{money2(r.hourly)}</span> },
          { key: 'effective', header: 'Since', cell: (r) => fmtDate(r.effective) },
          {
            key: 'next',
            header: 'Next change',
            cell: (r) => (r.next ? `${money2(r.next.hourly)} on ${fmtDate(r.next.effective)}` : <span className="text-ink-3">Not announced</span>),
          },
        ]}
      />
      <p className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
        Sources: <CitationChip label={LAW_SOURCES.bayAreaWages.label} url={LAW_SOURCES.bayAreaWages.url} />
        <CitationChip label="San Jose 2026 rate" url={LAW_SOURCES.sanJoseMinWage.url} />
        <span>
          San Jose's 2026 rate is $18.45 (flagged to verify). Set each office's rate under{' '}
          <TextLink href={links.settings('org')}>Org, Locations</TextLink>. {NOT_ADVICE}
        </span>
      </p>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------

function TaxPanel() {
  const costModel = useDB((s) => s.db.company.costModel)
  const law = useDB((s) => s.db.settings.law)
  const overrides = costModel.taxOverrides?.rates ?? {}
  const futa = costModel.taxOverrides?.futaScenario ?? 'waiver'
  const [editing, setEditing] = useState<TaxDef | null>(null)
  const value = (r: TaxDef) => overrides[r.key] ?? r.fallback
  return (
    <Panel
      title="Employer payroll taxes"
      subtitle="Used only for fully loaded cost estimates. Your payroll provider calculates the real amounts."
      icon="coins"
    >
      <div className="mb-4 flex flex-col gap-2 rounded-xl bg-surface-2 p-3.5">
        <span className="text-[14px] font-semibold text-ink">California FUTA credit reduction</span>
        <p className="text-[13.5px] text-ink-2">
          California employers pay extra FUTA while the state repays a federal loan. The 2026 rate is final after Nov 10, 2026: about{' '}
          {pct(PAYROLL_TAX_2026.futaEffectiveRate, 1)} if the waiver is granted, up to {pct(PAYROLL_TAX_2026.futaEffectiveRateNoWaiver, 1)} if not, on
          the first $7,000 of wages.
        </p>
        <ChipGroup
          label="FUTA scenario"
         
          value={futa}
          onChange={(v) =>
            commit(v === 'waiver' ? 'Planning with the FUTA waiver' : 'Planning without the FUTA waiver', (d) => {
              const cm = d.company.costModel
              cm.taxOverrides = { ...(cm.taxOverrides ?? {}), futaScenario: v }
            })
          }
          options={[
            { value: 'waiver', label: `Waiver granted (${pct(PAYROLL_TAX_2026.futaEffectiveRate, 1)})` },
            { value: 'no_waiver', label: `No waiver (${pct(PAYROLL_TAX_2026.futaEffectiveRateNoWaiver, 1)})` },
          ]}
        />
        <span className="flex flex-wrap items-center gap-2">
          <CitationChip label={LAW_SOURCES.futaCredit.label} url={LAW_SOURCES.futaCredit.url} />
          <CitationChip label={LAW_SOURCES.futa.label} url={LAW_SOURCES.futa.url} />
        </span>
      </div>
      <RowList label="Employer payroll tax rates">
        {TAX_ROWS.map((r) => {
          const key = `tax.${r.key}`
          const reviewed = reviewedDate(law, key)
          const overridden = overrides[r.key] != null
          return (
            <Row
              key={r.key}
              title={r.label}
              badges={
                <>
                  <ReviewedBadge date={reviewed} />
                  {overridden && <Badge tone="accent">Your value</Badge>}
                </>
              }
              meta={
                <span className="flex flex-col gap-1.5">
                  <span>
                    <span className="num font-semibold text-ink">{fmt(value(r), r.input)}</span>
                    {overridden && <span> (default {fmt(r.fallback, r.input)})</span>}
                    {' · '}
                    {r.hint}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <CitationChip label={r.source.label} url={r.source.url} />
                    <span>Last reviewed {fmtDate(reviewed)}</span>
                  </span>
                </span>
              }
              actions={
                <>
                  <Button icon="check" onClick={() => markReviewed(key, r.label)} aria-label={`Mark ${r.label} reviewed today`}>
                    Mark reviewed today
                  </Button>
                  <Button variant="ghost" icon="edit" onClick={() => setEditing(r)} aria-label={`Edit ${r.label}`}>
                    Edit
                  </Button>
                </>
              }
            />
          )
        })}
      </RowList>
      <p className="mt-3 text-[13px] text-ink-3">
        State disability insurance (SDI) is paid by employees, so it is not an employer cost. {NOT_ADVICE}
      </p>
      {editing && (
        <EditSheet<{ value: number | null }>
          key={editing.key}
          open
          title={`Edit ${inSentence(editing.label)}`}
          subtitle="Saving also marks it reviewed today."
          initial={{ value: value(editing) }}
          onClose={() => setEditing(null)}
          saveLabel="Save rate"
          validate={(d) => (d.value == null || d.value < 0 ? 'Enter a value of zero or more.' : editing.input === 'percent' && (d.value ?? 0) > 0.2 ? 'That rate looks too high. Enter it as a percent, like 3.4.' : null)}
          onSave={(d) =>
            commit(`Updated ${inSentence(editing.label)}`, (draft) => {
              const cm = draft.company.costModel
              const rates = { ...(cm.taxOverrides?.rates ?? {}) }
              if (d.value == null || d.value === editing.fallback) delete rates[editing.key]
              else rates[editing.key] = d.value
              cm.taxOverrides = { ...(cm.taxOverrides ?? {}), rates }
              draft.settings.law.reviewedOn = { ...(draft.settings.law.reviewedOn ?? {}), [`tax.${editing.key}`]: today() }
            })
          }
        >
          {(d, set) => (
            <>
              <ValueInput label={editing.label} input={editing.input} value={d.value} onChange={(v) => set({ value: v })} />
              <p className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-2">
                Check it against <CitationChip label={editing.source.label} url={editing.source.url} />
              </p>
              {d.value !== editing.fallback && (
                <Button variant="ghost" icon="rotate-ccw" onClick={() => set({ value: editing.fallback })}>
                  Use the default ({fmt(editing.fallback, editing.input)})
                </Button>
              )}
            </>
          )}
        </EditSheet>
      )}
    </Panel>
  )
}
