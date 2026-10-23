// Comp and plan > Pay runs (#comp.payruns[.<period start>], docs/SPEC.md PAY RUN PREP): each pay period prepared for
// the payroll provider or PEO. Who is on payroll, what changed, an estimated gross per person, the things to check
// before submitting, an export (generic CSV, ADP RUN time sheet import, Justworks bonus upload), Mark submitted, and
// the totals from the provider that Cost and runway uses as actuals. The provider keeps taxes, filings, pay stubs and
// money movement. Admin only (the Comp page checks); every amount goes through <Money>/<Private> for the blur (B).
import { useMemo, useState } from 'react'
import { links, navigateTo } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { LAW_SOURCES } from '@/data/law'
import {
  cutoffWords,
  downloadBlocked,
  exportColumnDocs,
  hasPaidPeople,
  markPayRunSubmitted,
  type PayPeriod,
  paydayWords,
  type PayRunFormat,
  type PayRunResult,
  payRunExport,
  payRunFormats,
  payRunPrep,
  type PayRunRow,
  type PayRunTotals,
  payrollSettings,
  paydayShiftWords,
  periodLabel,
  periodLabelLong,
  providerPhrase,
  providerTitle,
  runForPeriod,
  unmarkPayRunSubmitted,
} from '@/domain/payrun'
import { fmtDate, fmtDay, today } from '@/lib/dates'
import { copyText, downloadFile, printHTML } from '@/lib/files'
import { money, money2, plural } from '@/lib/format'
import { useDB } from '@/store/db'
import {
  Badge,
  Button,
  buttonClass,
  Callout,
  CitationChip,
  type Column,
  DataTable,
  DescriptionList,
  EmptyState,
  Field,
  Icon,
  Panel,
  Private,
  Segmented,
  Select,
  TextLink,
  toast,
} from '@/ui'
import { AdpSettingsSheet, PayrollIdsSheet, TotalsModal } from './PayRunSheets'
import {
  changeLines,
  checkList,
  estimateNote,
  flagWord,
  grossFooter,
  neighborPeriods,
  paydayNoticeHTML,
  paydayNoticeText,
  periodChoices,
  periodStatusShort,
  periodStatusWord,
  rowNotes,
  selectedPeriod,
  submittedText,
  timeOffText,
  upcomingPaydays,
} from './payRunView'
import { MoneyText } from './shared'

function undoToast(text: string) {
  toast({ text, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
}

const FLAG_TONE = { bad: 'bad', warn: 'warn', info: 'neutral' } as const

export function PayRunsTab({ segment }: { segment?: string }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const date = today()
  const period = useMemo(() => selectedPeriod(db, segment, date), [db, segment, date])
  const prep = useMemo(() => payRunPrep(db, period, date), [db, period, date])
  const provider = providerPhrase(db.company)
  const [totalsOpen, setTotalsOpen] = useState(false)
  const [adpOpen, setAdpOpen] = useState(false)
  const [idsOpen, setIdsOpen] = useState(false)
  const paid = hasPaidPeople(db, period)

  const mark = () => {
    const label = `Marked the ${periodLabel(period)} payroll submitted to ${provider}`
    let result = { ok: false, reason: 'Nothing changed.' } as PayRunResult
    useDB.getState().mutate(label, (d) => {
      result = markPayRunSubmitted(d, period, { date, actorId: viewer.person?.id ?? null })
    })
    if (!result.ok) {
      toast({ text: result.reason, tone: 'bad' })
      return
    }
    undoToast(
      result.firstPayrollOn
        ? `${label}. First payroll date set to ${fmtDate(result.firstPayrollOn)} (it starts the EDD registration clock)`
        : result.firstPayrollUnknown
          ? `${label}. People were paid before this period: add your first payroll date in Settings, Company (it starts the EDD registration clock)`
          : label,
    )
  }

  const unmark = () => {
    const label = `Took back the submitted mark on the ${periodLabel(period)} payroll`
    let ok = false
    useDB.getState().mutate(label, (d) => {
      ok = unmarkPayRunSubmitted(d, period).ok
    })
    if (ok) undoToast(label)
  }

  return (
    <div className="@container flex flex-col gap-5">
      <PeriodPanel period={period} onMark={mark} onUnmark={unmark} onTotals={() => setTotalsOpen(true)} paid={paid} prepPeople={prep.rows.length} gross={prep.totals.estimatedGross} />

      {prep.notices.map((n) => (
        <Callout key={n} tone="warn" icon="calendar" title="Payday and the Labor Code 204 dates">
          <p>{n}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <CitationChip label={LAW_SOURCES.lc204.label} url={LAW_SOURCES.lc204.url} />
            <CitationChip label={LAW_SOURCES.dlseManual.label} url={LAW_SOURCES.dlseManual.url} />
            <CitationChip label={LAW_SOURCES.lc219.label} url={LAW_SOURCES.lc219.url} />
          </div>
        </Callout>
      ))}

      {!paid ? (
        <Panel title="Nobody is paid on this payroll yet" icon="coins">
          <EmptyState
            compact
            icon="coins"
            title="No pay rates for this period"
            body="Pay run prep starts once someone on payroll has a salary or an hourly rate. Add one from their profile with Change job or pay."
            action={<TextLink href={links.people('directory')}>Open the directory</TextLink>}
          />
        </Panel>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-5 @[760px]:grid-cols-2">
            <CheckPanel items={checkList(prep)} pendingTimeOff={prep.pendingTimeOff.length} />
            <Panel title="What changed" icon="layers" subtitle="Against a regular check for everyone">
              {changeLines(prep).length === 0 ? (
                <p className="text-[14px] text-ink-3">No starts, last days, pay changes, bonuses, time off or leave this period: everyone gets the regular check.</p>
              ) : (
                <DescriptionList columns={1} items={changeLines(prep).map((l) => ({ label: l.label, value: l.text }))} />
              )}
            </Panel>
          </div>
          <PeoplePanel rows={prep.rows} periodsPerYear={prep.periodsPerYear} totals={prep.totals} />
          <ExportPanel period={period} onAdp={() => setAdpOpen(true)} onIds={() => setIdsOpen(true)} />
        </>
      )}

      <CalendarPanel shown={period} />

      <TotalsModal open={totalsOpen} onClose={() => setTotalsOpen(false)} period={period} record={prep.record} />
      <AdpSettingsSheet open={adpOpen} onClose={() => setAdpOpen(false)} />
      <PayrollIdsSheet open={idsOpen} onClose={() => setIdsOpen(false)} rows={prep.rows} />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// The period: picker, dates, status, Mark submitted and totals
// ---------------------------------------------------------------------------------------------

function PeriodPanel({
  period,
  onMark,
  onUnmark,
  onTotals,
  paid,
  prepPeople,
  gross,
}: {
  period: PayPeriod
  onMark: () => void
  onUnmark: () => void
  onTotals: () => void
  paid: boolean
  prepPeople: number
  gross: number
}) {
  const db = useDB((s) => s.db)
  const date = today()
  const provider = providerPhrase(db.company)
  const settings = payrollSettings(db.company)
  const choices = periodChoices(db, date, period)
  const { prev, next } = neighborPeriods(db, period)
  const status = periodStatusWord(db, period, date)
  const prepRecord = runForPeriod(db.company.payRuns, period)
  const submitted = !!prepRecord?.submittedOn
  const moved = period.payday !== period.scheduledPayday

  return (
    <Panel
      title={`Pay period ${periodLabelLong(period)}`}
      icon="calendar"
      subtitle={
        <>
          Prepare the payroll for {provider}: who is on it, what changed and an estimated gross. {providerTitle(db)} calculates taxes and net pay and
          moves the money.
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Pay period" className="min-w-0 flex-1 basis-64">
            {(id) => (
              <Select
                id={id}
                value={period.start}
                onChange={(v) => navigateTo(links.payRun(v))}
                options={choices.map((p) => ({ value: p.start, label: `${periodLabelLong(p)}: ${periodStatusWord(db, p, date).label}` }))}
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            {prev && (
              <a href={links.payRun(prev.start)} className={buttonClass('ghost', 'md')} aria-label={`Earlier period: ${periodLabelLong(prev)}`}>
                <Icon name="chevron-left" size={17} className="ft-btn__icon shrink-0" />
                Earlier
              </a>
            )}
            {next && (
              <a href={links.payRun(next.start)} className={buttonClass('ghost', 'md')} aria-label={`Later period: ${periodLabelLong(next)}`}>
                Later
                <Icon name="chevron-right" size={17} className="ft-btn__icon ft-btn__icon--right shrink-0" />
              </a>
            )}
          </div>
        </div>

        <DescriptionList
          columns={3}
          items={[
            {
              label: 'Payday',
              value: (
                <>
                  {fmtDay(period.payday)}
                  {moved && (
                    <span className="block text-[13px] text-ink-3">
                      Moved from {fmtDay(period.scheduledPayday)} to {paydayShiftWords(settings.paydayShift)}: not a business day
                    </span>
                  )}
                </>
              ),
            },
            {
              label: 'Run payroll by',
              value: (
                <>
                  {fmtDay(period.cutoff)}
                  <span className="block text-[13px] text-ink-3">The provider's cutoff, {cutoffWords(settings.cutoffBusinessDays)}</span>
                </>
              ),
            },
            {
              label: 'Status',
              value: (
                <span className="flex flex-col items-start gap-1">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {submitted && <span className="text-[13px] text-ink-3">{submittedText(db, prepRecord)}</span>}
                </span>
              ),
            },
            { label: 'On this payroll', value: paid ? plural(prepPeople, 'person', 'people') : 'Nobody paid yet' },
            {
              label: 'Estimated gross (salaried)',
              value: paid ? <Private>{money2(gross)}</Private> : 'None',
            },
            {
              label: `Totals from ${provider}`,
              value: prepRecord?.totals ? (
                <>
                  <Private>{money2(prepRecord.totals.gross)}</Private> gross, <Private>{money2(prepRecord.totals.employerTaxes)}</Private> employer taxes
                  <span className="block text-[13px] text-ink-3">Entered {fmtDay(prepRecord.totals.enteredOn)}</span>
                </>
              ) : (
                <span className="text-ink-3">Not entered</span>
              ),
            },
          ]}
        />

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {submitted ? (
            <Button variant="ghost" icon="rotate-ccw" onClick={onUnmark}>
              Take back the submitted mark
            </Button>
          ) : (
            <Button variant="primary" size="lg" icon="check" onClick={onMark} disabled={!paid}>
              Mark submitted to {provider}
            </Button>
          )}
          <Button icon="coins" onClick={onTotals}>
            {prepRecord?.totals ? `Edit the totals from ${provider}` : `Enter totals from ${provider}`}
          </Button>
        </div>
        {!submitted && paid && (
          <p className="text-[13px] text-ink-3">
            Mark it once the payroll is in {provider}. The inbox reminds you before the cutoff and asks after a payday that passed with no mark.
          </p>
        )}
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// Things to check
// ---------------------------------------------------------------------------------------------

function CheckPanel({ items, pendingTimeOff }: { items: ReturnType<typeof checkList>; pendingTimeOff: number }) {
  return (
    <Panel title="Check before you submit" icon="clipboard-check" subtitle="Deadlines first, then reminders and notes">
      {items.length === 0 ? (
        <p className="text-[14px] text-ink-3">Nothing to check: no final pay deadlines, pay floors, unpaid days or open requests in this period.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {items.map((c, i) => (
            <li key={`${c.personId}-${c.flag.kind}-${i}`} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={FLAG_TONE[c.flag.tone]}>{flagWord(c.flag.tone)}</Badge>
                <a
                  href={links.person(c.personId)}
                  className="ft-link inline-flex min-h-10 items-center font-semibold text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
                >
                  {c.name}
                </a>
              </span>
              <span className="text-[14px] text-ink-2">{c.flag.private ? <MoneyText text={c.flag.text} /> : c.flag.text}</span>
            </li>
          ))}
        </ul>
      )}
      {pendingTimeOff > 0 && (
        <p className="mt-3 text-[13.5px] text-ink-2">
          {plural(pendingTimeOff, 'time off request')} in this period {pendingTimeOff === 1 ? 'waits' : 'wait'} for a decision.{' '}
          <TextLink href={links.people('timeoff')}>Open time off requests</TextLink>
        </p>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// Everyone on the payroll, with estimates
// ---------------------------------------------------------------------------------------------

function PeoplePanel({ rows, periodsPerYear, totals }: { rows: PayRunRow[]; periodsPerYear: number; totals: PayRunTotals }) {
  const db = useDB((s) => s.db)
  const footer = grossFooter(totals)
  const columns: Array<Column<PayRunRow>> = [
    {
      key: 'person',
      header: 'Person',
      sort: (r) => r.employeeNumber,
      // One link for the name and its line, a 40px target like the Comp table's person cell.
      cell: (r) => (
        <a href={links.person(r.personId, 'job')} className="ft-link group flex min-h-10 min-w-[8rem] flex-col justify-center">
          <span className="font-semibold text-ink underline decoration-line-strong underline-offset-2 group-hover:decoration-ink">{r.name}</span>
          <span className="text-[12.5px] text-ink-3">
            <span className="ft-empno">#{r.employeeNumber}</span>, {r.payType === 'hourly' ? 'hourly' : 'salary'}, {r.flsa === 'exempt' ? 'exempt' : 'non-exempt'}
          </span>
        </a>
      ),
    },
    {
      key: 'rate',
      header: 'Pay rate',
      align: 'right',
      // On a phone the estimate is the column that matters; the rate is one tap away on the person's Job and pay.
      hideBelow: 'sm',
      sort: (r) => r.rate,
      cell: (r) =>
        r.rate > 0 ? (
          <span className="whitespace-nowrap">
            <Private>{r.rateBasis === 'hour' ? `${money2(r.rate)}/hr` : `${money(r.rate)}/yr`}</Private>
            {r.hourlyEquivalent != null && (
              <span className="block text-[12px] text-ink-3">
                <Private>{money2(r.hourlyEquivalent)}</Private>/hr for overtime
                {r.hourlyBasis === 'scheduled_hours' && <span className="block">weekly salary / {r.hoursPerWeek} hours</span>}
              </span>
            )}
          </span>
        ) : (
          <span className="text-ink-3">No rate</span>
        ),
    },
    {
      key: 'estimate',
      header: 'Estimated gross',
      align: 'right',
      sort: (r) => r.estimatedGross ?? -1,
      cell: (r) => (
        <span className="inline-block min-w-[7.5rem]">
          {r.estimatedGross != null ? <Private className="font-semibold">{money2(r.estimatedGross)}</Private> : <span className="text-ink-2">By the hour</span>}
          <span className="block text-[12px] text-ink-3">{estimateNote(r)}</span>
          {r.bonus > 0 && (
            <span className="block text-[12px] text-ink-3">
              Sign-on bonus <Private>{money2(r.bonus)}</Private>
            </span>
          )}
          {r.vacationPayout && !r.paidOffCycle && (
            <span className="block text-[12px] text-ink-3">
              Vacation payout <Private>{money2(r.vacationPayout.amount)}</Private>
            </span>
          )}
          {r.otherPayout && !r.paidOffCycle && (
            <span className="block text-[12px] text-ink-3">
              {r.otherPayout.name} payout <Private>{money2(r.otherPayout.amount)}</Private>
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'regular',
      header: 'Regular check',
      align: 'right',
      hideBelow: 'md',
      sort: (r) => r.regularAmount,
      cell: (r) => (r.regularAmount > 0 ? <Private>{money2(r.regularAmount)}</Private> : <span className="text-ink-3">Hourly</span>),
    },
    {
      key: 'timeoff',
      header: 'Time off',
      hideBelow: 'md',
      cell: (r) => <span className="inline-block min-w-[7rem] text-[13.5px]">{timeOffText(r.timeOff) || <span className="text-ink-3">None</span>}</span>,
    },
    {
      key: 'notes',
      header: 'Notes',
      hideBelow: 'lg',
      cell: (r) => (
        <span className="inline-block min-w-[10rem] text-[13px] text-ink-2">
          {rowNotes(r).map((n) => (
            <span key={n} className="block">
              <MoneyText text={n} />
            </span>
          ))}
        </span>
      ),
    },
  ]
  return (
    <Panel
      title="Everyone on this payroll"
      icon="users"
      padded={false}
      subtitle={
        <>
          Estimate: working days. A first or last check is annual salary / 260 x weekdays on payroll, never more than the regular check (annual /{' '}
          {periodsPerYear}). {providerTitle(db)} calculates the real amount, taxes and net pay.
        </>
      }
    >
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.personId} initialSort={{ key: 'person', dir: 'asc' }} caption="People on this payroll with estimated gross pay" />
      <div className="flex flex-col gap-2 border-t border-line px-5 py-4 text-[13.5px] text-ink-2">
        <p>
          <span className="font-semibold text-ink">
            Estimated gross: <Private>{money2(totals.estimatedGross)}</Private>
          </span>{' '}
          for {plural(totals.salaried, 'salaried person', 'salaried people')}
          {footer.included.map((a, i) => (
            <span key={a.what}>
              {i === 0 ? ', including ' : i === footer.included.length - 1 ? ' and ' : ', '}
              <Private>{money2(a.amount)}</Private> {a.what}
            </span>
          ))}
          .
          {footer.outside.map((a, i) => (
            <span key={`${a.name}-${a.what}`}>
              {' '}
              {i === 0 ? 'Plus' : 'And'} <Private>{money2(a.amount)}</Private> {a.what} for {a.name} (hourly, not in this total).
            </span>
          ))}
          {footer.hourlyNote && ` ${footer.hourlyNote}`}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
          <CitationChip label={LAW_SOURCES.salaryBasis.label} url={LAW_SOURCES.salaryBasis.url} />
          <CitationChip label={LAW_SOURCES.dlseManual.label} url={LAW_SOURCES.dlseManual.url} />
          {rows.some((r) => r.hourlyBasis === 'full_time') && <CitationChip label={LAW_SOURCES.lc515.label} url={LAW_SOURCES.lc515.url} />}
          <span>
            A method for the estimate, not a legal rule: no California rule sets how to prorate a partial period.
            {rows.some((r) => r.hourlyBasis === 'scheduled_hours') && ' A part-time salary per hour is weekly salary / scheduled hours, also a method (Labor Code 515(d) covers 40 hours).'} Not
            legal advice.
          </span>
        </div>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

const FORMAT_NOTES: Record<PayRunFormat, string> = {
  generic:
    "Works with any provider. Gusto's Smart Import matches columns itself: check its matches and leave the estimate columns unmatched. Cells with nothing to report are blank, never 0, because zeros overwrite entries in Gusto. OnPay and Rippling publish no import layout: map these columns by hand.",
  adp: "From ADP's Time Sheet Import guide (2018): the import template inside RUN is the source of truth. This file carries sign-on bonuses and time off hours. A salary that is not the regular check (a prorated first or last check, a pay change, unpaid days, leave) and payouts at exit are listed above to enter in RUN by hand.",
  justworks_bonus: 'Justworks bulk payments are for bonuses and off-cycle pay, never regular wages. Upload it in Justworks, then review it before it pays.',
}

function ExportPanel({ period, onAdp, onIds }: { period: PayPeriod; onAdp: () => void; onIds: () => void }) {
  const db = useDB((s) => s.db)
  const date = today()
  const provider = providerPhrase(db.company)
  const [format, setFormat] = useState<PayRunFormat>('generic')
  const out = useMemo(() => payRunExport(db, payRunPrep(db, period, date), format), [db, period, date, format])
  const formats = payRunFormats()
  const hint = formats.find((f) => f.value === format)?.hint

  const download = () => {
    const blocked = downloadBlocked(out)
    if (blocked) {
      toast({ text: blocked, tone: 'bad' })
      return
    }
    if (downloadFile(out.filename, out.text, 'text/csv;charset=utf-8')) toast({ text: `Downloaded ${out.filename}`, tone: 'good' })
    else toast({ text: 'This browser blocked the download. Use Copy CSV instead.', tone: 'bad' })
  }
  const copy = async () => {
    if (await copyText(out.text)) toast({ text: `Copied the ${periodLabel(period)} CSV`, tone: 'good' })
    else toast({ text: 'Could not copy. Use Download CSV instead.', tone: 'bad' })
  }

  return (
    <Panel title={`Export for ${provider}`} icon="download" subtitle="One file for this pay period. No SSNs, birth dates, bank details or addresses: the app never has them.">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13.5px] font-semibold text-ink-2" id="payrun-format-label">
            Format
          </span>
          <Segmented label="Export format" value={format} onChange={setFormat} options={formats.map((f) => ({ value: f.value, label: f.label }))} />
          {hint && <p className="text-[13px] text-ink-3">{hint}</p>}
        </div>

        {out.problem && (
          <Callout
            tone="warn"
            title={out.problem}
            action={
              format === 'adp' && !db.company.payroll?.adp?.companyCode ? (
                <Button size="sm" icon="settings" onClick={onAdp}>
                  ADP settings
                </Button>
              ) : undefined
            }
          />
        )}
        {out.skipped.length > 0 && (
          <Callout tone="neutral" title={`Not in the file: ${plural(out.skipped.length, 'line')}`}>
            <ul className="flex flex-col gap-0.5">
              {out.skipped.map((s, i) => (
                <li key={`${s.name}-${i}`}>
                  {s.name}: <MoneyText text={s.reason} />
                </li>
              ))}
            </ul>
          </Callout>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon="download" onClick={download}>
            Download CSV
          </Button>
          <Button icon="copy" onClick={() => void copy()}>
            Copy CSV
          </Button>
          {format === 'adp' && (
            <Button variant="ghost" icon="settings" onClick={onAdp}>
              ADP settings
            </Button>
          )}
          {format !== 'justworks_bonus' && (
            <Button variant="ghost" icon="key" onClick={onIds}>
              Payroll IDs
            </Button>
          )}
          <span className="text-[13px] text-ink-3">
            {out.filename}, {plural(out.rows, 'row')}
          </span>
        </div>

        <p className="text-[13.5px] text-ink-2">{FORMAT_NOTES[format]}</p>

        <details className="group rounded-lg">
          <summary className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 font-semibold text-ink">
            <Icon name="chevron-right" size={16} className="shrink-0 transition-transform group-open:rotate-90" />
            What each column holds
          </summary>
          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 text-[13.5px] @[640px]:grid-cols-[minmax(10rem,auto)_1fr]">
            {exportColumnDocs(format).map((c) => (
              <div key={c.header} className="contents">
                <dt className="font-semibold text-ink">{c.header}</dt>
                <dd className="mb-1 text-ink-2 @[640px]:mb-0">{c.about}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[12.5px] text-ink-3">
            Text that starts with =, +, -, @, a tab or a return gets a leading apostrophe, so a spreadsheet never runs it as a formula. Leave types are never named:
            bereavement and reproductive loss hours sit under Other time off.
          </p>
        </details>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// Pay calendar and the regular paydays notice
// ---------------------------------------------------------------------------------------------

function CalendarPanel({ shown }: { shown: PayPeriod }) {
  const db = useDB((s) => s.db)
  const date = today()
  const settings = payrollSettings(db.company)
  const upcoming = upcomingPaydays(db, date, 6)

  const print = () => {
    if (!printHTML('Regular paydays', paydayNoticeHTML(db, date))) toast({ text: 'This browser blocked the print window. Use Copy notice instead.', tone: 'bad' })
  }
  const copy = async () => {
    if (await copyText(paydayNoticeText(db, date))) toast({ text: 'Copied the regular paydays notice', tone: 'good' })
    else toast({ text: 'Could not copy. Use Print notice instead.', tone: 'bad' })
  }

  const columns: Array<Column<PayPeriod>> = [
    {
      key: 'period',
      header: 'Pay period',
      cell: (p) => (
        <a
          href={links.payRun(p.start)}
          aria-current={p.start === shown.start ? 'page' : undefined}
          className="ft-link inline-flex min-h-10 items-center font-semibold whitespace-nowrap text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
        >
          {periodLabel(p)}
        </a>
      ),
    },
    {
      key: 'payday',
      header: 'Payday',
      cell: (p) => (
        <span className="whitespace-nowrap">
          {fmtDay(p.payday)}
          {p.payday !== p.scheduledPayday && <span className="block text-[12px] text-ink-3">for {fmtDay(p.scheduledPayday)}</span>}
          {/* On a phone the Run by column folds in here, so four columns fit at 375px in every look. */}
          <span className="block text-[12px] text-ink-3 sm:hidden">Run by {fmtDay(p.cutoff)}</span>
        </span>
      ),
    },
    { key: 'cutoff', header: 'Run by', hideBelow: 'sm', cell: (p) => <span className="whitespace-nowrap">{fmtDay(p.cutoff)}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (p) => {
        const s = periodStatusShort(db, p, date)
        return <Badge tone={s.tone}>{s.label}</Badge>
      },
    },
  ]

  return (
    <Panel
      title="Pay calendar"
      icon="calendar-check"
      padded={false}
      subtitle={<>Paid {paydayWords(db.company)}. Run payroll {cutoffWords(settings.cutoffBusinessDays)}.</>}
      actions={
        <a href={links.settings('links')} className={buttonClass('ghost', 'sm')}>
          <Icon name="settings" size={16} className="ft-btn__icon shrink-0" />
          Pay run settings
        </a>
      }
    >
      <DataTable rows={upcoming} columns={columns} rowKey={(p) => p.start} dense caption="Upcoming paydays and cutoffs" />
      <div className="flex flex-col gap-3 border-t border-line px-5 py-4">
        <p className="text-[13.5px] text-ink-2">
          Business days skip weekends, Federal Reserve bank holidays (no direct deposits settle) and your company holidays. A payday that is not a business day
          moves to {paydayShiftWords(settings.paydayShift)}.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon="printer" onClick={print}>
            Print paydays notice
          </Button>
          <Button size="sm" icon="copy" onClick={() => void copy()}>
            Copy notice
          </Button>
          <span className="text-[13px] text-ink-3">California employers keep the regular paydays posted where employees can see them.</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
          <CitationChip label={LAW_SOURCES.lc207.label} url={LAW_SOURCES.lc207.url} />
          <CitationChip label={LAW_SOURCES.bankHolidays.label} url={LAW_SOURCES.bankHolidays.url} />
          <CitationChip label={LAW_SOURCES.lc204.label} url={LAW_SOURCES.lc204.url} />
          <span>Not legal advice.</span>
        </div>
      </div>
    </Panel>
  )
}
