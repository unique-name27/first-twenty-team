// Comp table (docs/SPEC.md, LEVELS AND BANDS): everyone's base, variable, band position dot on a min-max
// track, compa-ratio, last change date and reason, exception reason, out-of-band and below-exempt-floor
// flags. Sortable, CSV export (with Copy), and every amount goes through <Money>/<Private>.
import { useMemo, useState } from 'react'
import { links } from '@/app/router'
import { compTable, type CompTableRow, exemptFlags, outOfBand } from '@/domain/pay'
import type { ID } from '@/domain/types'
import { fmtDate, fmtShort, today } from '@/lib/dates'
import { copyText, downloadFile } from '@/lib/files'
import { money2, pct } from '@/lib/format'
import { useDB } from '@/store/db'
import { Badge, Button, CitationChip, DataTable, EmptyState, IconButton, Money, Panel, Private, Segmented, Select, toast, type Column } from '@/ui'
import { LAW_SOURCES } from '@/data/law'
import { ChangeJobSheet } from './ChangeJobSheet'
import { compTableCSV, median, REASON_LABEL } from './helpers'
import { BandTrack } from './shared'

type Filter = 'all' | 'flags' | 'incoming'

export function CompTableTab() {
  const db = useDB((s) => s.db)
  const date = today()
  const rows = useMemo(() => compTable(db, date), [db, date])
  const flags = useMemo(() => new Map(exemptFlags(db, date).map((f) => [f.personId, f])), [db, date])
  const oob = useMemo(() => new Map(outOfBand(db, date).map((r) => [r.personId, r])), [db, date])
  const [filter, setFilter] = useState<Filter>('all')
  const [dept, setDept] = useState<ID | ''>('')
  const [changing, setChanging] = useState<ID | null>(null)

  const flagged = (r: CompTableRow) => flags.has(r.personId) || oob.has(r.personId)
  const shown = rows.filter(
    (r) => (filter === 'all' || (filter === 'flags' ? flagged(r) : r.incoming)) && (!dept || r.departmentId === dept),
  )
  const ratios = rows.filter((r) => r.compaRatio != null).map((r) => r.compaRatio as number)
  const med = median(ratios)
  const incoming = rows.filter((r) => r.incoming).length
  const levelCode = (id: ID) => db.levels.find((l) => l.id === id)?.code ?? ''

  const exportCSV = () => {
    const csv = compTableCSV(db, shown, date)
    const ok = downloadFile(`comp-table-${date}.csv`, csv, 'text/csv;charset=utf-8')
    toast(ok ? 'Comp table CSV downloaded' : { text: 'Downloads are blocked here. Use Copy CSV instead.', tone: 'bad' })
  }
  const copyCSV = async () => {
    const ok = await copyText(compTableCSV(db, shown, date))
    toast(ok ? 'Comp table CSV copied' : { text: 'Copying is blocked here', tone: 'bad' })
  }

  const columns: Array<Column<CompTableRow>> = [
    {
      key: 'name',
      header: 'Name',
      sort: (r) => r.name,
      cell: (r) => (
        <div className="min-w-[150px]">
          <span className="font-semibold">{r.name}</span>
          <div className="text-[12.5px] text-ink-3">
            {r.title}, {levelCode(r.levelId)}
          </div>
          {r.incoming && (
            <Badge tone="accent" className="mt-1">
              Starts {fmtShort(db.people.find((p) => p.id === r.personId)?.startDate)}
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: 'base',
      header: 'Base',
      align: 'right',
      sort: (r) => r.base,
      cell: (r) => (
        <span className="whitespace-nowrap">
          <Money value={Math.round(r.base)} />
          {r.payType === 'hourly' && (
            <span className="block text-[12px] text-ink-3">
              <Private>{money2(r.hourlyRate ?? 0)}</Private> an hour
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'variable',
      header: 'Variable',
      align: 'right',
      sort: (r) => r.variable,
      cell: (r) =>
        r.variablePct ? (
          <span className="whitespace-nowrap">
            <Money value={Math.round(r.variable)} />
            <span className="block text-[12px] text-ink-3">
              <Private>{r.variablePct >= 0.999 && r.variablePct <= 1.001 ? '50/50 OTE' : pct(r.variablePct)}</Private>
            </span>
          </span>
        ) : (
          <span className="text-ink-3">None</span>
        ),
    },
    {
      key: 'band',
      header: 'Band position, compa-ratio',
      sort: (r) => r.compaRatio,
      cell: (r) =>
        r.band ? (
          <div className="w-[180px]">
            <BandTrack band={r.band} base={r.fteBase} />
            <span className="text-[12px] text-ink-2">
              {r.bandLabel}, <Private>{r.compaRatio != null ? r.compaRatio.toFixed(2) : ''}</Private>
            </span>
          </div>
        ) : (
          <span className="text-ink-3">No band</span>
        ),
    },
    {
      key: 'last',
      header: 'Last change',
      sort: (r) => r.lastChange?.effectiveOn,
      hideBelow: 'lg',
      cell: (r) =>
        r.lastChange ? (
          <span className="whitespace-nowrap">
            {fmtDate(r.lastChange.effectiveOn)}
            <span className="block text-[12px] text-ink-3">{REASON_LABEL[r.lastChange.reason]}</span>
          </span>
        ) : (
          <span className="text-ink-3">None</span>
        ),
    },
    {
      key: 'flags',
      header: 'Flags',
      sort: (r) => (flagged(r) ? 0 : 1),
      cell: (r) => {
        const o = oob.get(r.personId)
        const f = flags.get(r.personId)
        if (!o && !f) return <span className="text-ink-3">None</span>
        return (
          <div className="flex min-w-[130px] flex-col items-start gap-1">
            {o && (
              <Badge tone="warn" icon="alert">
                {o.direction === 'below' ? 'Below band' : 'Above band'}
              </Badge>
            )}
            {o?.exceptionReason && <span className="text-[12px] text-ink-2">{o.exceptionReason}</span>}
            {o && !o.exceptionReason && <span className="text-[12px] text-warn">No exception reason</span>}
            {f && (
              <Badge tone="bad" icon="alert" title={f.text}>
                Below exempt floor
              </Badge>
            )}
          </div>
        )
      },
    },
    {
      key: 'act',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) => <IconButton icon="edit" size="sm" label={`Change job or pay for ${r.name}`} onClick={() => setChanging(r.personId)} />,
    },
  ]

  return (
    <div className="flex flex-col gap-5">
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 text-[14.5px] text-ink-2">
            <p className="text-ink">
              {rows.length} people{incoming ? ` (${incoming} starting soon)` : ''}. Median compa-ratio{' '}
              <Private>{med != null ? med.toFixed(2) : 'not available'}</Private>.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone={oob.size ? 'warn' : 'good'} icon={oob.size ? 'alert' : 'check'}>
                {oob.size} out of band
              </Badge>
              <Badge tone={flags.size ? 'bad' : 'good'} icon={flags.size ? 'alert' : 'check'}>
                {flags.size} below the exempt floor
              </Badge>
            </div>
            {flags.size > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
                <CitationChip label={LAW_SOURCES.exemptSalary.label} url={LAW_SOURCES.exemptSalary.url} />
                <span>Exempt roles in California need at least the salary floor. Not legal advice.</span>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button icon="download" onClick={exportCSV}>
              Download CSV
            </Button>
            <Button icon="copy" onClick={copyCSV}>
              Copy CSV
            </Button>
          </div>
        </div>
      </Panel>

      <Panel padded={false}>
        <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'Everyone', count: rows.length },
              { value: 'flags', label: 'Flags', count: rows.filter(flagged).length },
              { value: 'incoming', label: 'Starting soon', count: incoming },
            ]}
          />
          <div className="w-full sm:w-56">
            <label htmlFor="comp-dept" className="sr-only">
              Department
            </label>
            <Select
              id="comp-dept"
              value={dept}
              onChange={setDept}
              options={[{ value: '', label: 'All departments' }, ...db.departments.map((d) => ({ value: d.id, label: d.name }))]}
            />
          </div>
        </div>
        <DataTable
          rows={shown}
          columns={columns}
          rowKey={(r) => r.personId}
          rowHref={(r) => links.person(r.personId, 'job')}
          initialSort={{ key: 'name', dir: 'asc' }}
          dense
          caption="Comp table"
          empty={<EmptyState compact title="Nobody matches this filter" />}
        />
      </Panel>
      {changing && <ChangeJobSheet personId={changing} open onClose={() => setChanging(null)} />}
    </div>
  )
}
