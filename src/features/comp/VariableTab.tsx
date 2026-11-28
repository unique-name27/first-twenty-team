// Comp and plan > Components > Variable pay (#comp.variable): who earns variable pay on top of base when targets are
// met, and what it adds up to a year. Read only; variable pay is set when pay is changed (a person's Job and pay).
// Performance reviews are not tracked (docs/SPEC.md, Will not have), so this shows targets, never results.
import { useMemo } from 'react'
import { links } from '@/app/router'
import { compTable, type CompTableRow } from '@/domain/pay'
import { fmtDate, today } from '@/lib/dates'
import { pct, plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { Badge, type Column, DataTable, EmptyState, Money, Panel, Private } from '@/ui'
import { variableLabel, variableSummary } from './helpers'

export function VariableTab() {
  const db = useDB((s) => s.db)
  const date = today()
  const rows = useMemo(() => compTable(db, date).filter((r) => r.variable > 0), [db, date])
  const total = useMemo(() => variableSummary(rows), [rows])

  const columns: Array<Column<CompTableRow>> = [
    {
      key: 'name',
      header: 'Name',
      sort: (r) => r.name,
      cell: (r) => (
        <div>
          <span className="font-semibold text-ink">{r.name}</span>
          <span className="block text-[12px] text-ink-3">{r.title}</span>
          {r.incoming && (
            <Badge tone="accent" className="mt-1">
              Starts {fmtDate(db.people.find((p) => p.id === r.personId)?.startDate)}
            </Badge>
          )}
        </div>
      ),
    },
    { key: 'base', header: 'Base', align: 'right', sort: (r) => r.base, cell: (r) => <Money value={Math.round(r.base)} /> },
    {
      key: 'target',
      header: 'Variable at target',
      align: 'right',
      sort: (r) => r.variable,
      cell: (r) => (
        <span className="whitespace-nowrap">
          <Money value={Math.round(r.variable)} />
          <span className="block text-[12px] text-ink-3">
            <Private>{variableLabel(r.variablePct)}</Private>
          </span>
        </span>
      ),
    },
  ]

  return (
    <div className="@container flex flex-col gap-5">
      <Panel
        title="Variable pay targets"
        icon="coins"
        subtitle="What each person earns on top of base if targets are met. Change it from a person's Job and pay."
        padded={rows.length === 0}
      >
        {rows.length === 0 ? (
          <EmptyState compact icon="coins" title="No one has variable pay" body="Add a variable amount when you change someone's pay and it appears here." />
        ) : (
          <>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-5 py-4 @[420px]:grid-cols-3">
              <div className="ft-ministat min-w-0">
                <dt className="ft-ministat__label text-[12.5px] font-semibold text-ink-3">People with variable pay</dt>
                <dd className="ft-ministat__value num mt-0.5 text-[17px] font-bold text-ink">{plural(total.people, 'person', 'people')}</dd>
              </div>
              <div className="ft-ministat min-w-0">
                <dt className="ft-ministat__label text-[12.5px] font-semibold text-ink-3">Variable at target, a year</dt>
                <dd className="ft-ministat__value num mt-0.5 text-[17px] font-bold text-ink">
                  <Money value={Math.round(total.variable)} short />
                </dd>
              </div>
              <div className="ft-ministat min-w-0">
                <dt className="ft-ministat__label text-[12.5px] font-semibold text-ink-3">Share of their base</dt>
                <dd className="ft-ministat__value num mt-0.5 text-[17px] font-bold text-ink">
                  <Private>{pct(total.shareOfBase)}</Private>
                </dd>
                <dd className="text-[12px] text-ink-3">At target</dd>
              </div>
            </dl>
            <DataTable
              rows={rows}
              columns={columns}
              rowKey={(r) => r.personId}
              rowHref={(r) => links.person(r.personId, 'job')}
              initialSort={{ key: 'target', dir: 'desc' }}
              dense
              caption="Variable pay targets"
            />
          </>
        )}
      </Panel>
    </div>
  )
}
