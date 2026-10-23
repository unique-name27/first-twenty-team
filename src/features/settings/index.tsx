// Settings (admin only): one home per setting. Tabs are deep-linkable (#settings.company ... #settings.server).
// Opinionated defaults ship filled in, so most founders never need to open this page.
import type { ComponentType } from 'react'
import { useEffect, useRef } from 'react'
import type { PageProps } from '@/app/routes'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { canSeeSection } from '@/domain/access'
import { useSyncStatus } from '@/sync'
import { EmptyState, PageHeader, Tabs } from '@/ui'
import { ChecklistTemplatesTab } from './ChecklistTemplatesTab'
import { CompanyTab } from './CompanyTab'
import { DataTab } from './DataTab'
import { HiringTab } from './HiringTab'
import { LinksTab } from './LinksTab'
import { OrgTab } from './OrgTab'
import { RulesTab } from './RulesTab'
import { ServerTab } from './ServerTab'
import { TimeOffPoliciesTab } from './TimeOffPoliciesTab'

export { InvitePage } from './InvitePage'

type TabKey = 'company' | 'org' | 'hiring' | 'templates' | 'timeoff' | 'rules' | 'links' | 'data' | 'server'

const TABS: Array<{ key: TabKey; label: string; title: string; blurb: string; blurbConnected?: string; view: ComponentType }> = [
  {
    key: 'company',
    label: 'Company',
    title: 'Company and funding',
    blurb: 'Legal name, HQ, funding, cash and the assumptions behind cost and runway.',
    view: CompanyTab,
  },
  {
    key: 'org',
    label: 'Org',
    title: 'Departments, locations and levels',
    blurb: 'The lists that people, jobs and bands point at. Location head counts drive the SB 553 check.',
    view: OrgTab,
  },
  {
    key: 'hiring',
    label: 'Hiring',
    title: 'Hiring',
    blurb: 'Default stages and SLAs, close-out reasons, offer and referral defaults, and email templates.',
    view: HiringTab,
  },
  {
    key: 'templates',
    label: 'Checklists',
    title: 'Checklist templates',
    blurb: 'Onboarding, offboarding, new state, leave and job change tasks. Edits apply to checklists started from now on.',
    view: ChecklistTemplatesTab,
  },
  {
    key: 'timeoff',
    label: 'Time off',
    title: 'Time off policies and holidays',
    blurb: 'How each kind of time off works, and the company holidays that business-day math skips.',
    view: TimeOffPoliciesTab,
  },
  {
    key: 'rules',
    label: 'Rules and rates',
    title: 'Rules and rates',
    blurb: 'Yearly legal values and employer tax rates, each with its source and the date someone last checked it.',
    view: RulesTab,
  },
  {
    key: 'links',
    label: 'Link-outs',
    title: 'Link-outs',
    blurb: 'Where the real records live: payroll or PEO, background checks, e-sign, cap table and more.',
    view: LinksTab,
  },
  {
    key: 'data',
    label: 'Data',
    title: 'Data and backups',
    blurb: 'Back up, import, reset the sample or start fresh. Everything lives in this browser only.',
    blurbConnected: 'Back up, import or start fresh. This browser syncs with your server, so Import and Start fresh replace its workspace too.',
    view: DataTab,
  },
  {
    key: 'server',
    label: 'Server',
    title: 'Server',
    blurb: 'Optional: sync this workspace with your own First Twenty server and its Postgres database. The app works fully without one.',
    view: ServerTab,
  },
]

export function SettingsPage({ route }: PageProps) {
  const viewer = useViewer()
  const connected = useSyncStatus((s) => s.mode === 'server')
  const tabsRef = useRef<HTMLDivElement>(null)
  const current = route.segments[1]
  // On a phone the tab strip scrolls sideways; keep the open tab in view.
  useEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [current])
  if (!canSeeSection(viewer, 'settings')) {
    return (
      <EmptyState
        icon="lock"
        title="Settings are for Admin"
        body="Switch to Admin under Viewing as to change settings. Viewing as is a preview, not security."
        action={
          <a href={links.home()} className="font-bold text-accent underline">
            Go home
          </a>
        }
      />
    )
  }
  const key = (TABS.some((t) => t.key === route.segments[1]) ? route.segments[1] : 'company') as TabKey
  const tab = TABS.find((t) => t.key === key) ?? TABS[0]
  const View = tab.view
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="One home per setting. Defaults ship filled in, so most of this can wait until you need it."
      />
      <div ref={tabsRef}>
        <Tabs
          label="Settings sections"
          value={key}
          tabs={TABS.map((t) => ({ key: t.key, label: t.label, href: links.settings(t.key) }))}
        />
      </div>
      <section aria-labelledby="settings-tab-title" className="pt-5">
        <div className="mb-4">
          <h2 id="settings-tab-title" className="font-display text-[20px] font-bold text-ink">
            {tab.title}
          </h2>
          <p className="mt-0.5 max-w-[75ch] text-[14.5px] text-ink-2">{(connected && tab.blurbConnected) || tab.blurb}</p>
        </div>
        <View />
      </section>
    </>
  )
}
