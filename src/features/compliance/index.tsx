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
import { EmptyState, PageHeader, type TabDef, Tabs } from '@/ui'
import { CalendarTab } from './calendar'
import { acksOwed, bucketCalendar, needsAction } from './helpers'
import { MilestonesTab } from './milestones'
import { NoticesTab } from './notices'
import { RecordsTab } from './records'
import { Soc2Tab } from './soc2'
import { TrainingTab } from './training'

type TabKey = 'milestones' | 'calendar' | 'training' | 'notices' | 'soc2' | 'records'
const TAB_KEYS: TabKey[] = ['milestones', 'calendar', 'training', 'notices', 'soc2', 'records']

const SUBTITLES: Record<TabKey, string> = {
  milestones: 'What the law expects at your size, in plain English, with one-tap tasks and official sources.',
  calendar: 'Recurring and dated obligations, overdue first. Download them to your calendar.',
  training: 'Who needs which course, and when. One tap records a completion.',
  notices: 'Policy versions, who acknowledged them, and the notices every new hire gets.',
  soc2: 'People evidence for your SOC 2 audit: populations, 5 controls, gaps and CSVs.',
  records: 'Retain-until dates, the applicant anonymize queue and records requests.',
}

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
    ...(db.company.soc2Enabled || tab === 'soc2'
      ? [{ key: 'soc2' as const, label: 'SOC 2 evidence', count: counts.soc2 || undefined, href: links.compliance('soc2') }]
      : []),
    { key: 'records', label: 'Records', count: counts.records || undefined, href: links.compliance('records') },
  ]

  return (
    <>
      <PageHeader title="Compliance" subtitle={SUBTITLES[tab]} />
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
