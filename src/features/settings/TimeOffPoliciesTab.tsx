// Settings > Time off policies and holidays. Policies say how each kind of time off works (method,
// hours, caps, wait before use, payout at exit); holidays are what business-day math skips.
import { useMemo, useState } from 'react'
import { DEFAULT_TIME_OFF_POLICIES } from '@/data/defaults'
import { type HolidayRollover, hasHolidaysIn, rolloverHolidays } from '@/domain/holidays'
import { hoursLabel } from '@/domain/timeoff'
import type { Holiday, TimeOffPolicy } from '@/domain/types'
import { fmtDay, isWeekday, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import {
  Badge,
  Button,
  Callout,
  ChipGroup,
  CitationChip,
  Field,
  FormGrid,
  NumberInput,
  Panel,
  Segmented,
  Switch,
  TextArea,
  TextInput,
} from '@/ui'
import { commit, DateField, EditSheet, Row, RowList } from './kit'
import { hintWithCount, longestWorkday, sickLeaveMinimums, sickPolicyProblem, TEXT_MAX_CHARS } from './logic'

const METHOD_LABELS: Record<TimeOffPolicy['method'], string> = {
  accrual: 'Earned each pay period',
  frontload: 'Granted up front each year',
  flexible: 'Flexible, no balance',
  as_needed: 'As needed',
}

const VACATION_PAYOUT = { label: 'Labor Code 227.3', url: 'https://www.dir.ca.gov/dlse/faq_vacation.htm' }
const SICK_LEAVE = { label: 'Labor Code 246', url: 'https://www.dir.ca.gov/dlse/Paid_Sick_Leave.htm' }

function policyFacts(p: TimeOffPolicy): string {
  const parts: string[] = [METHOD_LABELS[p.method]]
  if (p.annualHours) parts.push(`${hoursLabel(p.annualHours)} a year`)
  if (p.capHours) parts.push(`cap ${hoursLabel(p.capHours)}`)
  if (p.usageCapHours) parts.push(`use up to ${hoursLabel(p.usageCapHours)} a year`)
  if (p.perEventHours) parts.push(`up to ${hoursLabel(p.perEventHours)} each time`)
  if (p.usableAfterDays) parts.push(`usable after ${p.usableAfterDays} days`)
  parts.push(p.paidOutOnExit ? 'paid out at exit' : 'not paid out at exit')
  return parts.join(' · ')
}

export function TimeOffPoliciesTab() {
  return (
    <div className="flex flex-col gap-5">
      <PoliciesPanel />
      <HolidaysPanel />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

type PolicyDraft = Omit<TimeOffPolicy, 'annualHours' | 'capHours' | 'usageCapHours' | 'usableAfterDays' | 'perEventHours'> & {
  annualHours: number | null
  capHours: number | null
  usageCapHours: number | null
  usableAfterDays: number | null
  perEventHours: number | null
}

function toDraft(p: TimeOffPolicy): PolicyDraft {
  return {
    ...p,
    annualHours: p.annualHours ?? null,
    capHours: p.capHours ?? null,
    usageCapHours: p.usageCapHours ?? null,
    usableAfterDays: p.usableAfterDays ?? null,
    perEventHours: p.perEventHours ?? null,
  }
}

function fromDraft(d: PolicyDraft): TimeOffPolicy {
  const out: TimeOffPolicy = { ...d, name: d.name.trim(), description: d.description.trim() } as TimeOffPolicy
  for (const k of ['annualHours', 'capHours', 'usageCapHours', 'usableAfterDays', 'perEventHours'] as const) {
    const v = d[k]
    if (v == null || v <= 0) delete out[k]
    else out[k] = v
  }
  return out
}

const ACCRUED_DESC = DEFAULT_TIME_OFF_POLICIES.find((p) => p.id === 'pol-vacation')?.description ?? ''
const FLEX_DESC =
  "Take the time you need with your manager's OK. There is no balance to track and no cap, so nothing is paid out at exit."

/** ' (50 hours here)' when the longest workday makes the day-based floor higher than the hour-based one. */
const hereHours = (hours: number, floor: number) => (hours > floor ? ` (${hours} hours here)` : '')

const isVacation = (p: Pick<TimeOffPolicy, 'kind'>) => p.kind === 'vacation' || p.kind === 'flexible_vacation'

function PoliciesPanel() {
  const policies = useDB((s) => s.db.timeOffPolicies)
  const people = useDB((s) => s.db.people)
  const hqState = useDB((s) => s.db.company.hq.state)
  const [editing, setEditing] = useState<PolicyDraft | null>(null)
  // "5 days" of sick leave is measured in the longest normal workday among the people the policy covers.
  const workdayFor = (p: Pick<TimeOffPolicy, 'appliesToStates'>) => longestWorkday(people, today(), p.appliesToStates, hqState || 'CA')
  return (
    <Panel
      title="Time off policies"
      subtitle="Leave types that start at a headcount appear on their own once you get there."
      icon="calendar"
    >
      <RowList label="Time off policies">
        {policies.map((p) => (
          <Row
            key={p.id}
            title={p.name}
            badges={
              <>
                {p.appliesFromHeadcount ? <Badge tone="outline">From {p.appliesFromHeadcount} employees</Badge> : null}
                {p.appliesToStates?.length ? <Badge tone="outline">{p.appliesToStates.join(', ')} staff</Badge> : null}
                {p.autoApprove && <Badge tone="good">Auto-approved</Badge>}
              </>
            }
            meta={
              <span className="flex flex-col gap-1">
                <span>{policyFacts(p)}</span>
                <span className="text-ink-2">{p.description}</span>
                {p.citation && (
                  <span>
                    <CitationChip label={p.citation.label} url={p.citation.url} />
                  </span>
                )}
              </span>
            }
            actions={
              <Button icon="edit" onClick={() => setEditing(toDraft(p))} aria-label={`Edit ${p.name}`}>
                Edit
              </Button>
            }
          />
        ))}
      </RowList>
      {editing && (
        <EditSheet<PolicyDraft>
          key={editing.id}
          open
          title={`Edit ${editing.name}`}
          initial={editing}
          onClose={() => setEditing(null)}
          saveLabel="Save policy"
          validate={(d) => (!d.name.trim() ? 'Name the policy.' : sickPolicyProblem(d, workdayFor(d)))}
          onSave={(d) => commit(`Updated the ${d.name.trim()} policy`, (draft) => {
            const i = draft.timeOffPolicies.findIndex((x) => x.id === d.id)
            if (i >= 0) draft.timeOffPolicies[i] = fromDraft(d)
          })}
        >
          {(d, set) => (
            <>
              <Field label="Name" required>
                {(id) => <TextInput id={id} value={d.name} onChange={(e) => set({ name: e.target.value })} />}
              </Field>
              {isVacation(d) && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13.5px] font-semibold text-ink-2">Vacation style</span>
                  <Segmented
                    label="Vacation style"
                    value={d.method === 'flexible' ? 'flexible' : 'accrual'}
                    onChange={(v) =>
                      set(
                        v === 'flexible'
                          ? {
                              kind: 'flexible_vacation',
                              method: 'flexible',
                              paidOutOnExit: false,
                              annualHours: null,
                              capHours: null,
                              description: d.description === ACCRUED_DESC ? FLEX_DESC : d.description,
                            }
                          : {
                              kind: 'vacation',
                              method: 'accrual',
                              paidOutOnExit: true,
                              annualHours: d.annualHours ?? 120,
                              capHours: d.capHours ?? 180,
                              description: d.description === FLEX_DESC ? ACCRUED_DESC : d.description,
                            },
                      )
                    }
                    options={[
                      { value: 'accrual', label: 'Accrued' },
                      { value: 'flexible', label: 'Flexible' },
                    ]}
                  />
                  <Callout tone="neutral" className="mt-1">
                    <p>
                      {d.method === 'flexible'
                        ? 'Flexible vacation pays nothing at exit only when it is truly unlimited. A hidden cap or accrual makes it vacation that must be paid out.'
                        : 'Accrued vacation vests as earned and is paid out at exit. A cap is allowed; use-it-or-lose-it is not.'}
                    </p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-2">
                      <CitationChip label={VACATION_PAYOUT.label} url={VACATION_PAYOUT.url} />
                      <span className="text-[13px] text-ink-3">Not legal advice.</span>
                    </p>
                  </Callout>
                </div>
              )}
              {d.method !== 'flexible' && d.method !== 'as_needed' && (
                <FormGrid>
                  <Field label={d.method === 'frontload' ? 'Hours granted each year' : 'Hours earned each year'}>
                    {(id) => (
                      <NumberInput id={id} min={0} step="1" suffix="hours" value={d.annualHours} onChange={(v) => set({ annualHours: v })} />
                    )}
                  </Field>
                  <Field
                    label="Balance cap"
                    hint={
                      d.kind === 'sick' && d.method === 'accrual'
                        ? `Earning pauses at the cap. California allows a cap of no less than 80 hours or 10 days, whichever is more${hereHours(sickLeaveMinimums(workdayFor(d)).cap, 80)}.`
                        : d.kind === 'sick'
                          ? 'Leave blank, or set it at or above the yearly grant.'
                          : 'Earning pauses at the cap.'
                    }
                  >
                    {(id, hint) => (
                      <NumberInput id={id} aria-describedby={hint} min={0} step="1" suffix="hours" value={d.capHours} onChange={(v) => set({ capHours: v })} />
                    )}
                  </Field>
                  {d.kind === 'sick' && (
                    <Field
                      label="Yearly use limit"
                      hint={`Leave blank for no limit. California allows a limit of no less than 40 hours or 5 days a year, whichever is more${hereHours(sickLeaveMinimums(workdayFor(d)).yearly, 40)}.`}
                    >
                      {(id, hint) => (
                        <NumberInput
                          id={id}
                          aria-describedby={hint}
                          min={0}
                          step="1"
                          suffix="hours"
                          value={d.usageCapHours}
                          onChange={(v) => set({ usageCapHours: v })}
                        />
                      )}
                    </Field>
                  )}
                </FormGrid>
              )}
              {d.method === 'as_needed' && (
                <Field label="Limit each time" hint="Leave blank for no set limit.">
                  {(id, hint) => (
                    <NumberInput
                      id={id}
                      aria-describedby={hint}
                      min={0}
                      step="1"
                      suffix="hours"
                      value={d.perEventHours}
                      onChange={(v) => set({ perEventHours: v })}
                    />
                  )}
                </Field>
              )}
              <div className="flex flex-col gap-1.5">
                <span className="text-[13.5px] font-semibold text-ink-2">Usable after</span>
                <ChipGroup
                  label="Usable after"
                 
                  value={String(d.usableAfterDays ?? 0)}
                  onChange={(v) => set({ usableAfterDays: Number(v) || null })}
                  options={[0, 30, 60, 90].map((n) => ({ value: String(n), label: n ? `${n} days` : 'Day one' }))}
                />
                {d.kind === 'sick' && (
                  <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
                    California allows a wait of up to 90 days before sick leave can be used. <CitationChip label={SICK_LEAVE.label} url={SICK_LEAVE.url} />
                  </p>
                )}
              </div>
              {d.method !== 'flexible' && (
                <Switch
                  label="Paid out at exit"
                  description={
                    d.kind === 'sick'
                      ? 'Separate sick leave is not paid out in California, and is restored if the person is rehired within 12 months.'
                      : d.kind === 'vacation'
                        ? 'California requires accrued vacation to be paid out at exit.'
                        : undefined
                  }
                  checked={d.paidOutOnExit}
                  disabled={d.kind === 'vacation'}
                  onChange={(v) => set({ paidOutOnExit: v })}
                />
              )}
              {d.kind === 'sick' && (
                <Switch
                  label="Auto-approve"
                  description="No reason is asked for sick leave, so approval is automatic."
                  checked={!!d.autoApprove}
                  onChange={(v) => set({ autoApprove: v })}
                />
              )}
              <Field label="Description" hint={hintWithCount('What employees see in Me when they request time off.', d.description, TEXT_MAX_CHARS)}>
                {(id, hint) => (
                  <TextArea
                    id={id}
                    aria-describedby={hint}
                    rows={4}
                    maxLength={TEXT_MAX_CHARS}
                    value={d.description}
                    onChange={(e) => set({ description: e.target.value })}
                  />
                )}
              </Field>
            </>
          )}
        </EditSheet>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------

function HolidaysPanel() {
  const holidays = useDB((s) => s.db.holidays)
  const thisYear = Number(today().slice(0, 4))
  const years = useMemo(() => {
    const ys = new Set(holidays.map((h) => Number(h.date.slice(0, 4))))
    ys.add(thisYear)
    ys.add(thisYear + 1)
    return [...ys].filter((y) => y >= thisYear - 1).sort()
  }, [holidays, thisYear])
  const [year, setYear] = useState(thisYear)
  const [adding, setAdding] = useState<Holiday | null>(null)
  const list = holidays.filter((h) => h.date.startsWith(String(year))).sort((a, b) => a.date.localeCompare(b.date))
  // Next year's set rolls over from this company's recent lists (docs/SPEC.md: annual reset in December).
  const nextYear = thisYear + 1
  const month = Number(today().slice(5, 7))
  const nextRoll = useMemo(() => (hasHolidaysIn(holidays, nextYear) ? null : rolloverHolidays(holidays, nextYear)), [holidays, nextYear])
  const yearRoll = useMemo(() => (list.length === 0 ? rolloverHolidays(holidays, year) : null), [holidays, list.length, year])
  const addYear = (roll: HolidayRollover) => {
    const done = commit(`Added ${roll.add.length} ${roll.add.length === 1 ? 'holiday' : 'holidays'} for ${roll.year}`, (d) => {
      const have = new Set(d.holidays.map((h) => h.date))
      d.holidays.push(...roll.add.filter((h) => !have.has(h.date)))
      d.holidays.sort((a, b) => a.date.localeCompare(b.date))
    })
    if (done) setYear(roll.year)
  }
  return (
    <Panel
      title="Company holidays"
      subtitle="Time off requests, hiring SLAs and offer expiry skip these days. Legal deadlines such as I-9 section 2 skip only weekends and federal holidays."
      icon="calendar-check"
      actions={
        <Button icon="plus" onClick={() => setAdding({ id: '', date: `${year}-01-01`, name: '' })}>
          Add holiday
        </Button>
      }
    >
      <div className="mb-3 flex flex-col gap-1.5">
        <span className="text-[13.5px] font-semibold text-ink-2">Year</span>
        <Segmented
          label="Year"
          value={String(year)}
          onChange={(v) => setYear(Number(v))}
          options={years.map((y) => ({ value: String(y), label: String(y), count: holidays.filter((h) => h.date.startsWith(String(y))).length }))}
        />
      </div>
      {nextRoll && nextRoll.add.length > 0 && month >= 11 && year !== nextYear && (
        <Callout
          tone={month === 12 ? 'warn' : 'neutral'}
          className="mb-3"
          title={`No holidays for ${nextYear} yet`}
          action={
            <Button variant="ghost" onClick={() => setYear(nextYear)}>
              Review {nextYear}
            </Button>
          }
        >
          <p>Business-day due dates in {nextYear} count holidays as workdays until they are listed.</p>
          <Button className="mt-2" variant="primary" icon="plus" onClick={() => addYear(nextRoll)}>
            Add {nextRoll.add.length} holidays for {nextYear}
          </Button>
        </Callout>
      )}
      {list.length === 0 ? (
        <div className="flex flex-col gap-3">
          <p className="text-[14px] text-ink-3">No holidays for {year} yet. Add them before the year starts so due dates skip them.</p>
          {yearRoll && yearRoll.add.length > 0 && (
            <div className="flex flex-col gap-3 rounded-xl border border-line p-4">
              <p className="text-[14px] text-ink">
                <span className="font-semibold">
                  {yearRoll.add.length} {yearRoll.add.length === 1 ? 'holiday' : 'holidays'} for {year}
                </span>
                {yearRoll.basedOn.length
                  ? `, carried over from your ${yearRoll.basedOn.slice().sort().join(' and ')} ${yearRoll.basedOn.length === 1 ? 'list' : 'lists'}`
                  : ', the standard set'}
                . Weekend dates move to the observed weekday.
              </p>
              <ul className="grid gap-x-6 gap-y-1 text-[14px] text-ink-2 sm:grid-cols-2" aria-label={`Holidays to add for ${year}`}>
                {yearRoll.add.map((h) => (
                  <li key={h.date} className="flex gap-2">
                    <span className="num w-[6.5rem] shrink-0 text-ink-3">{fmtDay(h.date)}</span>
                    <span>{h.name}</span>
                  </li>
                ))}
              </ul>
              {yearRoll.observedYearBefore && (
                <p className="text-[13.5px] text-ink-3">
                  New Year's Day {year} falls on a Saturday, so it is observed on {fmtDay(yearRoll.observedYearBefore.date)}, {year - 1}
                  {holidays.some((h) => h.date === yearRoll.observedYearBefore?.date)
                    ? `, already in the ${year - 1} list.`
                    : `. Add it to the ${year - 1} list.`}
                </p>
              )}
              {yearRoll.byHand.length > 0 && (
                <p className="text-[13.5px] text-ink-3">
                  No date rule for {yearRoll.byHand.join(', ')}. Add {yearRoll.byHand.length === 1 ? 'it' : 'them'} with Add holiday.
                </p>
              )}
              <div>
                <Button variant="primary" size="lg" icon="plus" onClick={() => addYear(yearRoll)}>
                  Add {yearRoll.add.length} holidays for {year}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <RowList label={`Holidays in ${year}`}>
          {list.map((h) => (
            <Row
              key={h.id}
              title={h.name}
              meta={fmtDay(h.date)}
              actions={
                <Button
                  variant="ghost"
                  icon="trash"
                  aria-label={`Remove ${h.name} on ${fmtDay(h.date)}`}
                  onClick={() =>
                    commit(`Removed ${h.name} ${year}`, (d) => {
                      d.holidays = d.holidays.filter((x) => x.id !== h.id)
                    })
                  }
                >
                  Remove
                </Button>
              }
            />
          ))}
        </RowList>
      )}
      {adding && (
        <EditSheet<Holiday>
          key={`${year}-add`}
          open
          title={`Add a ${year} holiday`}
          initial={adding}
          onClose={() => setAdding(null)}
          saveLabel="Add holiday"
          validate={(d) =>
            !d.name.trim()
              ? 'Name the holiday.'
              : !d.date
                ? 'Pick the date.'
                : holidays.some((h) => h.date === d.date)
                  ? 'There is already a holiday on that date.'
                  : null
          }
          onSave={(d) =>
            commit(`Added ${d.name.trim()} on ${fmtDay(d.date)}`, (draft) => {
              draft.holidays.push({ id: `hol-${d.date}`, date: d.date, name: d.name.trim() })
              draft.holidays.sort((a, b) => a.date.localeCompare(b.date))
            })
          }
        >
          {(d, set) => (
            <>
              <Field label="Name" required>
                {(id) => (
                  <div className="flex flex-col gap-2">
                    <ChipGroup
                      label="Common holidays"
                     
                      value={null}
                      onChange={(v) => set({ name: v })}
                      options={['Floating holiday', 'Company day off', "Cesar Chavez Day", "Veterans Day", 'Day after Christmas'].map((n) => ({ value: n, label: n }))}
                    />
                    <TextInput id={id} value={d.name} onChange={(e) => set({ name: e.target.value })} />
                  </div>
                )}
              </Field>
              <DateField
                label="Date"
                value={d.date}
                onChange={(v) => set({ date: v })}
                presets={[
                  { label: `Jan 1, ${year}`, date: `${year}-01-01` },
                  { label: `Jul 4, ${year}`, date: `${year}-07-04` },
                  { label: `Dec 26, ${year}`, date: `${year}-12-26` },
                ]}
                hint={
                  d.date && !isWeekday(d.date) ? (
                    <span className="font-semibold text-warn">
                      {fmtDay(d.date)} is a weekend day, so business-day math skips it anyway. Add the observed weekday instead.
                    </span>
                  ) : (
                    'If it falls on a weekend, add the observed weekday instead.'
                  )
                }
              />
            </>
          )}
        </EditSheet>
      )}
    </Panel>
  )
}
