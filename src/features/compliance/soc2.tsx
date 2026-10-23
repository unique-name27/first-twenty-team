// SOC 2 people-evidence pack: a period (default the Type II window), populations, 5 controls with
// pass and gap rows (gaps in red with a Fix link to the right place), CSV per control with Copy, and
// a print view. SOC 2 is a company attestation, not a law.
import { useMemo, useState } from 'react'
import { links } from '@/app/router'
import { type Soc2Control, type Soc2Evidence, type Soc2Row, soc2CSV, soc2Evidence } from '@/domain/compliance'
import { markAccessReviewDone } from '@/domain/compliance/actions'
import { fullName } from '@/domain/people'
import type { DB, Person } from '@/domain/types'
import { addDays, addMonths, fmtDate, fmtQuarter, type ISODate, quarterEnd, quarterOf, quarterStart, today } from '@/lib/dates'
import { copyText, downloadFile, escapeHTML, printHTML, slug } from '@/lib/files'
import { listJoin, plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { Badge, Button, cx, DateChips, EmptyState, Icon, Panel, Segmented, TextLink, toast } from '@/ui'
import { Disclosure } from './bits'
import { commit } from './mutate'

type PeriodKey = 'window' | 'quarter' | 'year' | 'custom'

function windowFor(db: DB, t: ISODate): { from: ISODate; to: ISODate } {
  const w = db.company.soc2?.typeIIWindow
  if (w?.from && w.to) return { from: w.from, to: w.to }
  return { from: addMonths(t, -6), to: t }
}

export function Soc2Tab() {
  const db = useDB((s) => s.db)
  const t = today()
  const win = windowFor(db, t)
  const [key, setKey] = useState<PeriodKey>('window')
  const [custom, setCustom] = useState<{ from: ISODate; to: ISODate }>(win)
  const period =
    key === 'window'
      ? win
      : key === 'quarter'
        ? { from: quarterStart(quarterOf(t)), to: quarterEnd(quarterOf(t)) }
        : key === 'year'
          ? { from: addDays(addMonths(t, -12), 1), to: t }
          : custom
  const valid = period.from <= period.to
  const ev = useMemo(() => (valid ? soc2Evidence(db, period.from, period.to, t) : null), [db, period.from, period.to, t, valid])

  if (!db.company.soc2Enabled) {
    return (
      <EmptyState
        icon="shield"
        title="SOC 2 evidence is off"
        body="Turn it on in Settings when a customer asks for SOC 2. The pack then checks background checks, security training, policy acknowledgements, access removal and access reviews."
        action={<TextLink href={links.settings('company')}>Open company settings</TextLink>}
      />
    )
  }

  const gaps = ev?.controls.reduce((n, c) => n + c.gaps, 0) ?? 0
  const fileStem = `${slug(db.company.name || 'company')}-soc2-${period.from}-to-${period.to}`

  return (
    <div className="flex flex-col gap-5">
      <Panel title="Audit period" icon="calendar">
        <div className="flex flex-col gap-4">
          <Segmented<PeriodKey>
            label="Audit period"
            value={key}
            onChange={setKey}
            options={[
              { value: 'window', label: 'Type II window' },
              { value: 'quarter', label: 'This quarter' },
              { value: 'year', label: 'Last 12 months' },
              { value: 'custom', label: 'Custom' },
            ]}
          />
          {key === 'custom' && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <DateChips
                label="From"
                value={custom.from}
                onChange={(from) => setCustom((c) => ({ ...c, from }))}
                presets={[
                  { label: 'Window start', date: win.from },
                  { label: 'Quarter start', date: quarterStart(quarterOf(t)) },
                  { label: 'Year start', date: `${t.slice(0, 4)}-01-01` },
                ]}
              />
              <DateChips
                label="To"
                value={custom.to}
                onChange={(to) => setCustom((c) => ({ ...c, to }))}
                presets={[
                  { label: 'Today', date: t },
                  { label: 'Window end', date: win.to },
                  { label: 'Quarter end', date: quarterEnd(quarterOf(t)) },
                ]}
              />
            </div>
          )}
          <p className="text-[14.5px] text-ink">
            {fmtDate(period.from)} to {fmtDate(period.to)}. Gaps are judged as of today ({fmtDate(t)}); anything not due yet is not a gap.
          </p>
          {!valid && <p className="text-[14px] font-semibold text-bad">The start date is after the end date. Pick an earlier start.</p>}
        </div>
      </Panel>

      {ev && (
        <>
          <Populations ev={ev} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[15px] text-ink">
              <span className={cx('font-bold', gaps ? 'text-bad' : 'text-good')}>{gaps ? plural(gaps, 'gap') : 'No gaps'}</span> across 5 controls.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button icon="printer" onClick={() => printPack(db, ev)}>
                Print evidence pack
              </Button>
              <Button
                icon="copy"
                onClick={async () => {
                  const ok = await copyText(packText(ev))
                  toast(ok ? 'Copied the evidence summary' : { text: 'Copy did not work in this browser.', tone: 'bad' })
                }}
              >
                Copy summary
              </Button>
            </div>
          </div>
          {ev.controls.map((c, i) => (
            <ControlPanel key={c.id} index={i + 1} control={c} ev={ev} fileStem={fileStem} />
          ))}
          <p className="text-[12.5px] text-ink-3">
            SOC 2 is an audit framework your customers ask for, not a law. These are company controls; confirm the exact controls and sample sizes with your auditor.
          </p>
        </>
      )}
    </div>
  )
}

function names(people: Person[]): string {
  return people.length ? listJoin(people.map(fullName)) : 'none'
}

function Populations({ ev }: { ev: Soc2Evidence }) {
  const p = ev.populations
  const items = [
    { label: 'Hires', people: p.hires, hint: 'Start date in the period (later starts are checked when due).' },
    { label: 'Exits', people: p.exits, hint: 'Last day in the period.' },
    { label: 'Active staff', people: p.active, hint: `Employed on ${fmtDate(ev.asOf)}.` },
  ]
  return (
    <Panel title="Populations" icon="users">
      <dl className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {items.map((it) => (
          <div key={it.label} className="min-w-0">
            <dt className="text-[13px] font-semibold text-ink-3">{it.label}</dt>
            <dd className="mt-0.5">
              <span className="num font-display text-[26px] leading-none font-bold text-ink">{it.people.length}</span>
              {!(it.label === 'Active staff' && it.people.length > 6) && <p className="mt-1 text-[13.5px] text-ink-2">{names(it.people)}</p>}
              <p className="text-[12.5px] text-ink-3">{it.hint}</p>
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  )
}

/** Where to fix a gap row. Returns a link or an inline action. */
function fixFor(control: Soc2Control, row: Soc2Row, subCheck: boolean): { href?: string; label: string; run?: () => void } | null {
  if (row.ok || row.pending) return null
  if (subCheck) return { href: links.compliance('notices'), label: 'Fix in Notices' }
  switch (control.id) {
    case 'background-check':
    case 'access-revoked':
      return row.personId ? { href: links.person(row.personId, 'checklists'), label: 'Fix in checklist' } : null
    case 'onboarding-training-acks':
      return /security training/i.test(row.gap ?? '') ? { href: links.compliance('training'), label: 'Fix in Training' } : { href: links.compliance('notices'), label: 'Fix in Notices' }
    case 'annual-security-training':
      return { href: links.compliance('training'), label: 'Fix in Training' }
    case 'access-review': {
      const [q, y] = row.label.split(' ')
      const quarter = `${y}-${q}`
      return { label: 'Record review today', run: () => commit(`Recorded the ${fmtQuarter(quarter)} access review`, (d) => markAccessReviewDone(d, quarter, today())) }
    }
  }
}

function RowList({ control, rows, subCheck }: { control: Soc2Control; rows: Soc2Row[]; subCheck?: boolean }) {
  if (!rows.length) return <p className="px-5 py-3 text-[14px] text-ink-3">Nobody in this population for the period.</p>
  return (
    <ul className="divide-y divide-line">
      {rows.map((r, i) => {
        const fix = fixFor(control, r, !!subCheck)
        const tone = r.ok ? 'good' : r.pending ? 'neutral' : 'bad'
        return (
          <li key={`${r.label}-${i}`} className={cx('flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center', !r.ok && !r.pending && 'ft-row--gap bg-bad-soft/40')}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14.5px] font-semibold text-ink">{r.label}</span>
                <Badge tone={tone} icon={r.ok ? 'check' : r.pending ? 'clock' : 'alert'}>
                  {r.ok ? 'Pass' : r.pending ? 'Not due yet' : 'Gap'}
                </Badge>
              </div>
              <p className="mt-0.5 text-[13.5px] text-ink-2">{r.evidence}</p>
              {r.gap && <p className="text-[13.5px] font-semibold text-bad">{r.gap}</p>}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {r.link && (
                <a href={r.link} target="_blank" rel="noreferrer noopener" className="inline-flex h-11 items-center gap-1 rounded-lg px-2 text-[13.5px] font-semibold text-accent hover:bg-accent-soft">
                  Evidence
                  <Icon name="external" size={12} />
                </a>
              )}
              {fix?.href && (
                <a href={fix.href} className="ft-btn ft-btn--secondary ft-btn--md ft-btn--urgent inline-flex h-11 items-center gap-1 rounded-lg border border-bad! bg-surface px-3 text-[14px] font-semibold text-bad! hover:bg-bad-soft!">
                  {fix.label}
                  <Icon name="arrow-right" size={15} className="ft-btn__icon ft-btn__icon--right" />
                </a>
              )}
              {fix?.run && (
                <Button icon="check" className="ft-btn--urgent border-bad! text-bad! hover:bg-bad-soft!" onClick={fix.run}>
                  {fix.label}
                </Button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function ControlPanel({ index, control, ev, fileStem }: { index: number; control: Soc2Control; ev: Soc2Evidence; fileStem: string }) {
  const pending = control.rows.filter((r) => r.pending).length + (control.subChecks ?? []).reduce((n, s) => n + s.rows.filter((r) => r.pending).length, 0)
  const file = `${fileStem}-${control.id}.csv`
  const csv = () => soc2CSV(ev, control.id)
  return (
    <Panel
      title={`${index}. ${control.title}`}
      subtitle={control.description}
      padded={false}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={control.gaps ? 'bad' : 'good'} icon={control.gaps ? 'alert' : 'check'}>
            {control.gaps ? plural(control.gaps, 'gap') : 'No gaps'}
          </Badge>
          {pending > 0 && <Badge tone="neutral">{pending} not due yet</Badge>}
        </div>
      }
    >
      <RowList control={control} rows={control.rows} />
      {(control.subChecks ?? []).map((sc) => (
        <div key={sc.id} className="border-t border-line">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-3">
            <div>
              <h4 className="text-[14.5px] font-bold text-ink">{sc.title}</h4>
              <p className="text-[13px] text-ink-3">{sc.description}</p>
            </div>
            <Badge tone={sc.gaps ? 'bad' : 'good'}>{sc.gaps ? plural(sc.gaps, 'gap') : 'No gaps'}</Badge>
          </div>
          {sc.rows.length > 8 ? (
            <div className="px-5 py-2">
              <Disclosure label={`Show all ${sc.rows.length} rows (${plural(sc.gaps, 'gap')}, ${sc.rows.filter((r) => r.pending).length} not due yet)`} size="sm">
                <div className="-mx-5 -mr-5 sm:-ml-11">
                  <RowList control={control} rows={[...sc.rows].sort((a, b) => Number(a.ok) - Number(b.ok))} subCheck />
                </div>
              </Disclosure>
            </div>
          ) : (
            <RowList control={control} rows={sc.rows} subCheck />
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">
        <Button
          icon="download"
          onClick={() => {
            const ok = downloadFile(file, csv(), 'text/csv;charset=utf-8')
            toast(ok ? `Downloaded ${file}` : { text: 'The download was blocked. Use Copy CSV instead.', tone: 'bad' })
          }}
        >
          Download CSV
        </Button>
        <Button
          icon="copy"
          onClick={async () => {
            const ok = await copyText(csv())
            toast(ok ? `Copied the CSV for ${control.title.toLowerCase()}` : { text: 'Copy did not work in this browser.', tone: 'bad' })
          }}
        >
          Copy CSV
        </Button>
      </div>
    </Panel>
  )
}

function packText(ev: Soc2Evidence): string {
  const lines = [`SOC 2 people evidence, ${fmtDate(ev.from)} to ${fmtDate(ev.to)} (as of ${fmtDate(ev.asOf)})`, '']
  lines.push(`Hires: ${names(ev.populations.hires)}`, `Exits: ${names(ev.populations.exits)}`, `Active staff: ${ev.populations.active.length}`, '')
  for (const c of ev.controls) {
    lines.push(`${c.title}: ${c.gaps ? plural(c.gaps, 'gap') : 'no gaps'}`)
    for (const r of [...c.rows, ...(c.subChecks ?? []).flatMap((s) => s.rows)]) {
      if (!r.ok && !r.pending) lines.push(`  Gap: ${r.label}. ${r.gap ?? ''}`)
    }
  }
  return lines.join('\n')
}

function printPack(db: DB, ev: Soc2Evidence): void {
  const table = (rows: Soc2Row[], header: string) =>
    `<table><thead><tr><th>${header}</th><th>Result</th><th>Evidence</th><th>Gap</th><th>Due</th></tr></thead><tbody>${rows
      .map(
        (r) =>
          `<tr><td>${escapeHTML(r.label)}</td><td>${r.ok ? 'Pass' : r.pending ? 'Not due yet' : '<strong>Gap</strong>'}</td><td>${escapeHTML(r.evidence)}${
            r.link ? `<br><span class="muted">${escapeHTML(r.link)}</span>` : ''
          }</td><td>${escapeHTML(r.gap ?? '')}</td><td>${r.dueOn ? escapeHTML(fmtDate(r.dueOn)) : ''}</td></tr>`,
      )
      .join('')}</tbody></table>`
  const body = [
    `<h1>${escapeHTML(db.company.legalName || db.company.name)}: SOC 2 people evidence</h1>`,
    `<p class="muted">Period ${escapeHTML(fmtDate(ev.from))} to ${escapeHTML(fmtDate(ev.to))}. Evaluated ${escapeHTML(fmtDate(ev.asOf))}.</p>`,
    `<h2>Populations</h2><p>Hires: ${escapeHTML(names(ev.populations.hires))}<br>Exits: ${escapeHTML(names(ev.populations.exits))}<br>Active staff: ${escapeHTML(
      names(ev.populations.active),
    )}</p>`,
    ...ev.controls.map(
      (c, i) =>
        `<h2>${i + 1}. ${escapeHTML(c.title)} (${c.gaps ? plural(c.gaps, 'gap') : 'no gaps'})</h2><p class="muted">${escapeHTML(c.description)}</p>${table(
          c.rows,
          c.population === 'quarters' ? 'Quarter' : 'Person',
        )}${(c.subChecks ?? []).map((s) => `<h3>${escapeHTML(s.title)}</h3>${table(s.rows, 'Person and policy')}`).join('')}`,
    ),
  ].join('\n')
  const ok = printHTML('SOC 2 people evidence', body)
  if (!ok) toast({ text: 'Printing was blocked. Use Copy summary or the CSV buttons instead.', tone: 'bad' })
}
