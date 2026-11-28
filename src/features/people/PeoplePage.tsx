// People: Directory (list with filters), Org chart, Checklists, Time off and
// Contractors tabs. '#people.new' opens Add person; '#people.contractors.new' opens Add contractor.
import { useEffect, useMemo, useState } from 'react'
import type { PageProps } from '@/app/routes'
import { links, navigate, replaceRoute } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { TimeOffTab, WhosOutStrip } from '@/features/timeoff'
import { canSeePerson, canSeeSeparation } from '@/domain/access'
import { headcountOn, incomingOn } from '@/domain/people'
import type { ChecklistKind, DB, Viewer } from '@/domain/types'
import { addDays, fmtDate, fmtShort, today } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useDB } from '@/store/db'
import {
  Avatar,
  Badge,
  Button,
  ChipMulti,
  type Column,
  cx,
  DataTable,
  EmptyState,
  Meter,
  PageHeader,
  Panel,
  SearchInput,
  Segmented,
  Select,
  Tabs,
} from '@/ui'
import { AddContractorSheet, ContractorsTab } from './Contractors'
import { AddPersonSheet, type PersonPrefill, prefillFromContractor } from './AddPersonSheet'
import {
  canSeeChecklist,
  CHECKLIST_KIND_LABEL,
  checklistStats,
  dayLabel,
  DIR_STATUS_LABEL,
  type DirectoryFilter,
  type DirectoryRow,
  directoryRows,
  type DirStatus,
  filterDirectory,
  nextAnniversary,
  WORKER_KIND_LABEL,
  type WorkerKind,
} from './helpers'
import { OrgChart } from './OrgChart'
import { anchorText, ContractorStatusBadge, EmpNo, PersonStatusBadge } from './parts'

type TabKey = 'directory' | 'org' | 'checklists' | 'timeoff' | 'contractors'

// ---------------------------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------------------------

const DEFAULT_FILTER: DirectoryFilter = { statuses: ['active', 'starting', 'on_leave'], kinds: ['employee', 'contractor', 'advisor'], departmentId: '', location: '', query: '' }

function Directory({ db, viewer }: { db: DB; viewer: Viewer }) {
  const t = today()
  const [f, setF] = useState<DirectoryFilter>(DEFAULT_FILTER)
  const all = useMemo(() => directoryRows(db, t), [db, t])
  const rows = useMemo(() => filterDirectory(all, f), [all, f])
  const count = (s: DirStatus) => filterDirectory(all, { ...f, statuses: [s], query: '' }).length
  const countKind = (k: WorkerKind) => filterDirectory(all, { ...f, kinds: [k], query: '' }).length
  const locationOptions = useMemo(() => {
    const opts = db.locations.map((l) => ({ value: l.id, label: l.name }))
    const states = [...new Set(db.contractors.map((c) => c.state))].map((s) => ({ value: `state:${s}`, label: `Contractors in ${s}` }))
    return [{ value: '', label: 'All locations' }, ...opts, ...states]
  }, [db])

  const columns: Array<Column<DirectoryRow>> = [
    {
      key: 'name',
      header: 'Name',
      sort: (r) => (r.number != null ? r.number : 1000) + (r.kind === 'employee' ? 0 : 1000),
      cell: (r) => (
        <span className="flex min-w-[200px] items-center gap-3">
          <Avatar name={r.contractor?.name ?? r.name} size={34} muted={r.status === 'alumni' || r.kind !== 'employee'} />
          <span className="min-w-0">
            <span className="flex items-baseline gap-1.5">
              {r.number != null && <EmpNo n={r.number} />}
              <span className={cx('font-semibold', r.status === 'alumni' ? 'text-ink-3' : 'text-ink')}>{r.name}</span>
            </span>
            <span className="block text-[13px] font-normal text-ink-3">{r.title}</span>
          </span>
        </span>
      ),
    },
    { key: 'team', header: 'Team', sort: (r) => r.team, hideBelow: 'md', cell: (r) => r.team },
    { key: 'manager', header: 'Manager', sort: (r) => r.managerName, hideBelow: 'lg', cell: (r) => r.managerName || <span className="text-ink-3">None</span> },
    { key: 'location', header: 'Location', sort: (r) => r.location, hideBelow: 'lg', cell: (r) => r.location },
    {
      key: 'start',
      header: 'Started',
      sort: (r) => r.startDate,
      hideBelow: 'sm',
      cell: (r) => {
        if (r.status === 'starting') return <span className="whitespace-nowrap">Starts {fmtShort(r.startDate)}</span>
        if (r.status === 'alumni' && r.endDate) return <span className="whitespace-nowrap text-ink-3">Left {fmtDate(r.endDate)}</span>
        const anniv = r.kind === 'employee' ? nextAnniversary(r.startDate, t) : null
        return (
          <span className="block whitespace-nowrap">
            <span className="block">{fmtDate(r.startDate)}</span>
            {anniv && (
              <span className="block text-[12.5px] text-ink-3">
                {anniv.years}-year anniversary {fmtShort(anniv.date)}
              </span>
            )}
          </span>
        )
      },
    },
    {
      key: 'status',
      header: 'Status',
      sort: (r) => r.status,
      cell: (r) =>
        r.person ? (
          <PersonStatusBadge
            db={db}
            person={r.person}
            status={r.status}
            leave={r.leave}
            showLeaveType={canSeePerson(viewer, db, r.person.id, 'leave')}
            showLastDay={canSeeSeparation(viewer, db, r.person.id)}
          />
        ) : (
          <span className="flex flex-col items-start gap-1">
            <Badge tone="outline">{r.kind === 'advisor' ? 'Advisor' : 'Contractor'}</Badge>
            {r.status !== 'active' && <ContractorStatusBadge status={r.status} />}
          </span>
        ),
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      {viewer.role === 'employee' && <WhosOutStrip from={t} to={addDays(t, 6)} />}
      <Panel padded={false}>
        <div className="flex flex-col gap-3 border-b border-line px-4 py-3 sm:px-5">
          <SearchInput value={f.query} onChange={(q) => setF((x) => ({ ...x, query: q }))} placeholder="Search by name, #number, title, team or manager" />
          <ChipMulti
            label="Status"
            values={f.statuses}
            onChange={(v) => setF((x) => ({ ...x, statuses: v }))}
            options={(Object.keys(DIR_STATUS_LABEL) as DirStatus[]).map((s) => ({ value: s, label: `${DIR_STATUS_LABEL[s]} ${count(s)}` }))}
          />
          <ChipMulti
            label="Worker type"
            values={f.kinds}
            onChange={(v) => setF((x) => ({ ...x, kinds: v }))}
            options={(Object.keys(WORKER_KIND_LABEL) as WorkerKind[]).map((k) => ({ value: k, label: `${WORKER_KIND_LABEL[k]} ${countKind(k)}` }))}
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:max-w-[640px]">
            <Select
              aria-label="Team"
              value={f.departmentId}
              onChange={(v) => setF((x) => ({ ...x, departmentId: v }))}
              options={[{ value: '', label: 'All teams' }, ...db.departments.map((d) => ({ value: d.id, label: d.name }))]}
            />
            <Select aria-label="Location" value={f.location} onChange={(v) => setF((x) => ({ ...x, location: v }))} options={locationOptions} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-2 text-[13.5px] text-ink-3 sm:px-5">
          <span aria-live="polite">{plural(rows.length, 'person', 'people')} shown</span>
          {JSON.stringify(f) !== JSON.stringify(DEFAULT_FILTER) && (
            <Button variant="ghost" size="sm" icon="rotate-ccw" onClick={() => setF(DEFAULT_FILTER)}>
              Reset filters
            </Button>
          )}
        </div>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.id}
          rowHref={(r) => (r.kind === 'employee' ? links.person(r.id) : links.contractor(r.id))}
          caption="People directory"
          empty={
            <div className="px-5">
              <EmptyState compact icon="search" title="No one matches these filters" body="Clear the search or turn on more statuses." />
            </div>
          }
        />
      </Panel>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Checklists tab
// ---------------------------------------------------------------------------------------------

type KindFilter = 'all' | 'onboarding' | 'offboarding' | 'leave' | 'other'

function ChecklistsTab({ db, viewer }: { db: DB; viewer: Viewer }) {
  const t = today()
  const [state, setState] = useState<'open' | 'done'>('open')
  const [kind, setKind] = useState<KindFilter>('all')
  const rows = useMemo(() => {
    return db.checklists
      .filter((c) => canSeeChecklist(viewer, db, c))
      .map((c) => ({ c, ...checklistStats(viewer, db, c, t) }))
      .filter((r) => r.tasks.length > 0)
      .filter((r) => (state === 'open' ? !r.c.completedOn && r.progress.open > 0 : !!r.c.completedOn || r.progress.open === 0))
      .filter((r) =>
        kind === 'all' ? true : kind === 'other' ? r.c.kind === 'new_state' || r.c.kind === 'change' : r.c.kind === (kind as ChecklistKind),
      )
      .sort(
        (a, b) =>
          b.progress.statutoryOverdue - a.progress.statutoryOverdue ||
          b.progress.overdue - a.progress.overdue ||
          (a.progress.nextDue?.dueOn ?? '9999').localeCompare(b.progress.nextDue?.dueOn ?? '9999') ||
          (b.c.completedOn ?? '').localeCompare(a.c.completedOn ?? ''),
      )
  }, [db, viewer, t, state, kind])

  type Row = (typeof rows)[number]
  const columns: Array<Column<Row>> = [
    {
      key: 'person',
      header: 'Person',
      cell: (r) => {
        const p = db.people.find((x) => x.id === r.c.personId)
        return p ? (
          <span className="flex min-w-[170px] items-center gap-2.5">
            <Avatar name={`${p.firstName} ${p.lastName}`} size={30} muted={!!p.endDate && p.endDate < t} />
            <span className="min-w-0">
              <span className="flex items-baseline gap-1.5">
                <EmpNo n={p.hireNumber} />
                <span className="font-semibold">{`${p.preferredName || p.firstName} ${p.lastName}`}</span>
              </span>
              <span className="block text-[13px] font-normal text-ink-3">{anchorText(r.c)}</span>
            </span>
          </span>
        ) : (
          r.c.personId
        )
      },
    },
    { key: 'kind', header: 'Checklist', cell: (r) => <Badge tone={r.c.kind === 'offboarding' ? 'outline' : 'neutral'}>{CHECKLIST_KIND_LABEL[r.c.kind]}</Badge> },
    {
      key: 'progress',
      header: 'Progress',
      cell: (r) => (
        <span className="flex min-w-[140px] items-center gap-2">
          <Meter
            value={r.progress.done}
            max={Math.max(1, r.progress.total)}
            tone={r.progress.statutoryOverdue ? 'bad' : r.progress.open === 0 ? 'good' : 'accent'}
            label={`${r.progress.done} of ${r.progress.total} done`}
          />
          <span className="num shrink-0 text-[13px] text-ink-2">
            {r.progress.done}/{r.progress.total}
          </span>
        </span>
      ),
    },
    {
      key: 'overdue',
      header: 'Overdue',
      cell: (r) =>
        r.progress.statutoryOverdue > 0 ? (
          <Badge tone="bad" icon="alert">
            {r.progress.overdue} overdue, {r.progress.statutoryOverdue} {r.progress.statutoryOverdue === 1 ? 'legal deadline' : 'legal deadlines'}
          </Badge>
        ) : r.progress.overdue > 0 ? (
          <Badge tone="warn" icon="clock">
            {r.progress.overdue} overdue
          </Badge>
        ) : (
          <span className="text-[13px] text-ink-3">None</span>
        ),
    },
    {
      key: 'next',
      header: state === 'open' ? 'Next due' : 'Completed',
      hideBelow: 'sm',
      cell: (r) =>
        state === 'open' && r.progress.nextDue ? (
          <span className="block min-w-[160px]">
            <span className="block text-[13.5px]">{r.progress.nextDue.title}</span>
            <span className="block text-[12.5px] text-ink-3">{dayLabel(r.progress.nextDue.dueOn)}</span>
          </span>
        ) : r.c.completedOn ? (
          fmtDate(r.c.completedOn)
        ) : (
          <span className="text-ink-3">Nothing open</span>
        ),
    },
  ]

  return (
    <Panel padded={false}>
      <div className="flex flex-col gap-3 border-b border-line px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-5">
        <Segmented
          label="Open or completed"
          value={state}
          onChange={setState}
          options={[
            { value: 'open', label: 'Running' },
            { value: 'done', label: 'Completed' },
          ]}
        />
        <Segmented
          label="Kind"
          size="sm"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'All' },
            { value: 'onboarding', label: 'Onboarding' },
            { value: 'offboarding', label: 'Offboarding' },
            { value: 'leave', label: 'Leave' },
            { value: 'other', label: 'New state and changes' },
          ]}
        />
      </div>
      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.c.id}
        rowHref={(r) => links.checklist(r.c.id)}
        caption="Checklists"
        empty={
          <div className="px-5">
            <EmptyState
              compact
              icon="clipboard-check"
              title={state === 'open' ? 'No checklists running' : 'No completed checklists yet'}
              body="Hiring someone starts their onboarding checklist with every California date worked out. Offboarding, leave and job changes add their own."
            />
          </div>
        }
      />
      <p className="border-t border-line px-5 py-3 text-[13px] text-ink-3">
        Overdue first. Red marks a legal deadline that has passed; everything else stays amber.
        {viewer.role === 'manager' ? ' You see checklists for your reports; leave checklists show only the manager tasks.' : ''}
      </p>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

export function PeoplePage({ route }: PageProps) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const t = today()
  const seg1 = route.segments[1]
  const admin = viewer.role === 'admin'
  const newPerson = seg1 === 'new'
  const newContractor = seg1 === 'contractors' && route.segments[2] === 'new'
  const tabs: Array<{ key: TabKey; label: string; show: boolean }> = [
    { key: 'directory', label: 'Directory', show: true },
    { key: 'org', label: 'Org chart', show: true },
    { key: 'checklists', label: 'Checklists', show: viewer.role !== 'employee' },
    { key: 'timeoff', label: 'Time off', show: viewer.role !== 'employee' },
    { key: 'contractors', label: 'Contractors and advisors', show: admin },
  ]
  const shown = tabs.filter((x) => x.show)
  const tab: TabKey = newPerson ? 'directory' : shown.some((x) => x.key === seg1) ? (seg1 as TabKey) : 'directory'
  const [prefill, setPrefill] = useState<PersonPrefill | undefined>(undefined)
  const fromContractor = newPerson ? route.segments[2] : undefined
  useEffect(() => {
    if (newPerson && fromContractor) setPrefill(prefillFromContractor(useDB.getState().db, fromContractor))
    else if (!newPerson) setPrefill(undefined)
  }, [newPerson, fromContractor])

  const hc = headcountOn(db, t)
  const incoming = incomingOn(db, t).length
  const activeContractors = db.contractors.filter((c) => c.kind === 'contractor' && c.startOn <= t && (!c.endOn || c.endOn >= t)).length
  const advisors = db.contractors.filter((c) => c.kind === 'advisor' && c.startOn <= t && (!c.endOn || c.endOn >= t)).length

  const solo = db.people.length <= 1 && db.contractors.length === 0

  return (
    <>
      <PageHeader
        title="People"
        subtitle={`${plural(hc, 'employee')}${incoming ? `, ${incoming} starting soon` : ''}, ${plural(activeContractors, 'contractor')}, ${plural(advisors, 'advisor')}. Contractors and advisors never count toward headcount.`}
        actions={
          admin ? (
            <>
              <Button variant="secondary" icon="file" onClick={() => navigate('people', 'contractors', 'new')}>
                Add contractor or advisor
              </Button>
              <Button variant="primary" icon="user-plus" onClick={() => navigate('people', 'new')}>
                Add person
              </Button>
            </>
          ) : undefined
        }
      />
      <Tabs label="People views" value={tab} tabs={shown.map((x) => ({ key: x.key, label: x.label, href: links.people(x.key) }))} className="mb-5" />
      {solo && tab === 'directory' ? (
        <Panel>
          <EmptyState
            icon="users"
            title="It's just you so far"
            body="Your first hire lands here from an accepted offer in Hiring, with their onboarding checklist already built. You can also add someone by hand."
            action={
              admin ? (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="primary" icon="briefcase" onClick={() => navigate('hiring', 'jobs')}>
                    Open a job
                  </Button>
                  <Button variant="secondary" icon="user-plus" onClick={() => navigate('people', 'new')}>
                    Add a person
                  </Button>
                </div>
              ) : undefined
            }
          />
        </Panel>
      ) : tab === 'directory' ? (
        <Directory db={db} viewer={viewer} />
      ) : tab === 'org' ? (
        <Panel>
          <OrgChart />
        </Panel>
      ) : tab === 'checklists' ? (
        <ChecklistsTab db={db} viewer={viewer} />
      ) : tab === 'timeoff' ? (
        <TimeOffTab />
      ) : (
        <ContractorsTab onAdd={() => navigate('people', 'contractors', 'new')} />
      )}

      {admin && (
        <>
          <AddPersonSheet
            open={newPerson}
            prefill={prefill}
            onClose={() => (fromContractor ? replaceRoute('contractor', fromContractor) : replaceRoute('people'))}
            onCreated={(id) => navigate('person', id)}
          />
          <AddContractorSheet
            open={newContractor}
            onClose={() => replaceRoute('people', 'contractors')}
            onConvert={(p) => {
              setPrefill(p)
              navigate('people', 'new')
            }}
          />
        </>
      )}
    </>
  )
}

