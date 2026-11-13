// Compliance (admin): what the law expects at your size, with one-tap tasks, official sources and the
// proof that you did it. Tabs: #compliance.milestones[.<ruleId>] | calendar | training | notices | soc2 | records.
import { useMemo } from 'react'
import { links } from '@/app/router'
import type { PageProps } from '@/app/routes'
import { useViewer } from '@/app/useViewer'
import { complianceCalendar, evaluateAll, soc2Evidence } from '@/domain/compliance'
import { trainingMatrix } from '@/domain/trainings'
import { isEmployedOn } from '@/domain/people'
import { addDays, addMonths, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { EmptyState, PageHeader, Stat, type TabDef, Tabs } from '@/ui'
import { CalendarTab } from './calendar'
import { acksOwed, bucketCalendar, needsAction } from './helpers'
import { MilestonesTab } from './milestones'
import { NoticesTab } from './notices'
import { RecordsTab } from './records'
import { Soc2Tab } from './soc2'
import { TrainingTab } from './training'

type TabKey = 'milestones' | 'calendar' | 'training' | 'notices' | 'records' | 'soc2'
const TAB_KEYS: TabKey[] = ['milestones', 'calendar', 'training', 'notices', 'records', 'soc2']

const SUBTITLES: Record<TabKey, string> = {
  milestones: 'What the law expects at your size and in each state, with official sources.',
  calendar: 'Dated and yearly obligations, overdue first.',
  training: 'Who needs which course, and by when.',
  notices: 'Policies, who acknowledged them, and the notices each new hire gets.',
  records: 'How long to keep records, and requests to see them.',
  soc2: 'People evidence for your SOC 2 audit.',
}

/** The overview boxes: one clickable box per area, in tab order, with a few words under the number. */
const OVERVIEW: Array<{ key: TabKey; label: string; open: string; clear: string; tone: 'warn' | 'bad' }> = [
  { key: 'milestones', label: 'Rules', open: 'need action', clear: 'All handled', tone: 'warn' },
  { key: 'calendar', label: 'Calendar', open: 'overdue', clear: 'Nothing overdue', tone: 'bad' },
  { key: 'training', label: 'Training', open: 'overdue', clear: 'All current', tone: 'bad' },
  { key: 'notices', label: 'Notices', open: 'owed', clear: 'All acknowledged', tone: 'warn' },
  { key: 'records', label: 'Records', open: 'requests open', clear: 'No open requests', tone: 'warn' },
  { key: 'soc2', label: 'SOC 2', open: 'gaps', clear: 'No gaps', tone: 'warn' },
]

export function CompliancePage({ route }: PageProps) {
  const viewer = useViewer()
  const db = useDB((s) => s.db)
  const t = today()
  const seg = route.segments[1] as TabKey | undefined
  const tab: TabKey = seg && TAB_KEYS.includes(seg) ? seg : 'milestones'
  const ruleId = tab === 'milestones' ? route.segments[2] : undefined

  // Tab counts: what needs attention in each area.
  const counts = useMemo(() => {
    const rules = evaluateAll(db, t).filter(needsAction).length
    const overdueDates = bucketCalendar(complianceCalendar(db, addDays(t, -365), addMonths(t, 6)), t).overdue.length
    const m = trainingMatrix(db, t)
    const training = m.counts.overdue
    const notices =
      db.policies.reduce((n, p) => n + acksOwed(db, p, t).length, 0) +
      db.checklists
        .filter((c) => c.kind === 'onboarding' && db.people.some((p) => p.id === c.personId && (isEmployedOn(p, t) || p.startDate > t)))
        .reduce((n, c) => n + c.tasks.filter((x) => x.category === 'notice' && x.status === 'open' && x.dueOn < t).length, 0)
    const w = db.company.soc2?.typeIIWindow
    const soc2 = db.company.soc2Enabled && w ? soc2Evidence(db, w.from, w.to, t).controls.reduce((n, c) => n + c.gaps, 0) : 0
    const records = db.recordsRequests.filter((r) => !r.fulfilledOn).length
    return { milestones: rules, calendar: overdueDates, training, notices, soc2, records }
  }, [db, t])

  if (viewer.role !== 'admin') {
    return <EmptyState icon="lock" title="Compliance is for admins" body="Switch to Admin under Viewing as to see it. This is a preview, not security." />
  }

  const tabs: Array<TabDef<TabKey>> = [
    { key: 'milestones', label: 'Milestones', count: counts.milestones || undefined, href: links.compliance('milestones') },
    { key: 'calendar', label: 'Calendar', count: counts.calendar || undefined, href: links.compliance('calendar') },
    { key: 'training', label: 'Training', count: counts.training || undefined, href: links.compliance('training') },
    { key: 'notices', label: 'Notices and policies', count: counts.notices || undefined, href: links.compliance('notices') },
    { key: 'records', label: 'Records', count: counts.records || undefined, href: links.compliance('records') },
    ...(db.company.soc2Enabled || tab === 'soc2'
      ? [{ key: 'soc2' as const, label: 'SOC 2 evidence', count: counts.soc2 || undefined, href: links.compliance('soc2') }]
      : []),
  ]
  const boxes = OVERVIEW.filter((o) => o.key !== 'soc2' || db.company.soc2Enabled)

  return (
    <>
      <PageHeader title="Compliance" subtitle={SUBTITLES[tab]} />
      <nav aria-label="Compliance overview" className="mb-5">
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {boxes.map((o) => (
            <li key={o.key} className="flex">
              <Stat
                href={links.compliance(o.key)}
                label={o.label}
                value={counts[o.key]}
                tone={counts[o.key] ? o.tone : 'good'}
                sub={counts[o.key] ? o.open : o.clear}
              />
            </li>
          ))}
        </ul>
      </nav>
      <Tabs<TabKey> tabs={tabs} value={tab} label="Compliance sections" className="mb-5" />
      {tab === 'milestones' && <MilestonesTab ruleId={ruleId} />}
      {tab === 'calendar' && <CalendarTab />}
      {tab === 'training' && <TrainingTab />}
      {tab === 'notices' && <NoticesTab />}
      {tab === 'soc2' && <Soc2Tab />}
      {tab === 'records' && <RecordsTab />}
    </>
  )
}

export { NextThresholdCard, PersonTrainingPanel, ThresholdPreview } from './panels'
