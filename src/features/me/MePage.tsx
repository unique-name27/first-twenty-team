// Me: self-service for one person (the viewer). It is the home screen in Employee view; in Admin and
// Hiring manager view it shows your own record. Routes: #me[.summary|.job|.equity|.timeoff|.tasks|
// .profile|.roles]; #me.timeoff.request opens the request sheet.
import { format } from 'date-fns'
import { useEffect, useMemo, useRef } from 'react'
import type { PageProps } from '@/app/routes'
import { links, navigate, replaceRoute } from '@/app/router'
import { useShortcut } from '@/app/shortcuts'
import { useViewer } from '@/app/useViewer'
import { RequestTimeOffSheet } from '@/features/timeoff'
import { firstName } from '@/domain/people'
import type { DB, Person } from '@/domain/types'
import { nowISO, parseDate, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Button, EmptyState, PageHeader, type TabDef, Tabs } from '@/ui'
import { ProfileTab } from './ProfileTab'
import { dayText, greetingFor, myTaskItems, taskCounts, tenureText } from './summary'
import { SummaryExportButtons } from './SummaryExport'
import { SummaryTab } from './SummaryTab'
import { EquityTab, JobTab, RolesTab, TasksTab, TimeOffTab } from './tabs'

export type MeTab = 'summary' | 'job' | 'equity' | 'timeoff' | 'tasks' | 'profile' | 'roles'

const TAB_KEYS: MeTab[] = ['summary', 'job', 'equity', 'timeoff', 'tasks', 'profile', 'roles']

/** The tab from the route. Employees also land here from #home, so anything unknown is the summary. */
export function tabFromSegments(segments: string[]): MeTab {
  if (segments[0] !== 'me') return 'summary'
  const t = segments[1] as MeTab | undefined
  return t && TAB_KEYS.includes(t) ? t : 'summary'
}

export function MePage({ route }: PageProps) {
  const viewer = useViewer()
  const db = useDB((s) => s.db)
  const person = viewer.person
  const tab = tabFromSegments(route.segments)
  const requestOpen = route.segments[0] === 'me' && route.segments[1] === 'timeoff' && route.segments[2] === 'request'

  useShortcut('t', () => navigate('me', 'timeoff', 'request'), { description: 'Request time off', group: 'Me', enabled: !!person && !requestOpen })

  if (!person) {
    return (
      <>
        <PageHeader title="Me" />
        <EmptyState icon="user" title="No one to show yet" body="Add yourself under People, then your own record shows here." />
      </>
    )
  }

  return (
    <>
      <MeHeader db={db} person={person} tab={tab} />
      <MeTabs db={db} person={person} tab={tab} />
      <div className="mt-5">
        {tab === 'summary' && <SummaryTab db={db} person={person} role={viewer.role} />}
        {tab === 'job' && <JobTab db={db} person={person} />}
        {tab === 'equity' && <EquityTab person={person} />}
        {tab === 'timeoff' && <TimeOffTab db={db} person={person} />}
        {tab === 'tasks' && <TasksTab db={db} person={person} />}
        {tab === 'profile' && <ProfileTab db={db} person={person} />}
        {tab === 'roles' && <RolesTab />}
      </div>
      <RequestTimeOffSheet open={requestOpen} onClose={() => replaceRoute('me', 'timeoff')} personId={person.id} />
    </>
  )
}

function MeHeader({ db, person, tab }: { db: DB; person: Person; tab: MeTab }) {
  const date = today()
  const incoming = person.startDate > date
  const dateLine = format(parseDate(date), 'EEEE, MMMM d, yyyy')
  // Time of day only (nowISO keeps the real hour on a demo date); calendar logic uses today().
  const title = incoming ? `Welcome, ${firstName(person)}` : `${greetingFor(parseDate(nowISO()).getHours())}, ${firstName(person)}`
  const subtitle = incoming
    ? `You start ${dayText(person.startDate, date)} as ${person.title}. Your first tasks are below.`
    : `${person.title}, employee #${person.hireNumber}. ${tenureText(person.startDate, date)} at ${db.company.name}.`

  return (
    <PageHeader
      eyebrow={dateLine}
      title={title}
      subtitle={subtitle}
      actions={
        <>
          <Button variant="primary" size="lg" icon="calendar" onClick={() => navigate('me', 'timeoff', 'request')}>
            Request time off
          </Button>
          {tab === 'summary' && (
            // On phones these move to the end of the summary so Request time off stays the one big action up top.
            <span className="hidden flex-wrap gap-2 sm:flex">
              <SummaryExportButtons db={db} person={person} />
            </span>
          )}
        </>
      }
    />
  )
}

function MeTabs({ db, person, tab }: { db: DB; person: Person; tab: MeTab }) {
  const date = today()
  const tasks = useMemo(() => taskCounts(myTaskItems(db, person.id, date, nowISO()), date).soon, [db, person.id, date])
  const openRoles = db.jobs.filter((j) => j.status === 'open').length
  const tabs: Array<TabDef<MeTab>> = [
    { key: 'summary', label: 'Summary', href: links.me('summary') },
    { key: 'tasks', label: 'Tasks', href: links.me('tasks'), ...(tasks ? { count: tasks } : {}) },
    { key: 'timeoff', label: 'Time off', href: links.me('timeoff') },
    { key: 'job', label: 'Job and pay', href: links.me('job') },
    { key: 'equity', label: 'Equity', href: links.me('equity') },
    { key: 'profile', label: 'Profile', href: links.me('profile') },
    { key: 'roles', label: 'Open roles', href: links.me('roles'), ...(openRoles ? { count: openRoles } : {}) },
  ]
  // On phones the tab strip scrolls sideways; keep the active tab in view after a deep link.
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = wrap.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')
    const strip = el?.closest<HTMLElement>('.overflow-x-auto')
    if (!el || !strip) return
    const a = el.getBoundingClientRect()
    const b = strip.getBoundingClientRect()
    const left = strip.scrollLeft + (a.left - b.left) - strip.clientWidth / 2 + a.width / 2
    strip.scrollTo({ left: Math.max(0, left) })
  }, [tab])
  return (
    <div ref={wrap}>
      <Tabs label="My sections" tabs={tabs} value={tab} />
    </div>
  )
}
