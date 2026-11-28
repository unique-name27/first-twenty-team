// Comp and plan (#comp[.table|.components|.plan|.cost|.payruns[.<period start>]], and under Components
// .bands|.variable|.benefits|.equity): what we pay, what we've granted, who we hire next, what it costs, and each pay
// run prepared for the payroll provider. Admin only; the person panels below are reused by People, Me and Home.
import type { PageProps } from '@/app/routes'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { boardConsentQueue } from '@/domain/equity'
import { outOfBand } from '@/domain/pay'
import { today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { EmptyState, PageHeader, Tabs } from '@/ui'
import { BandsTab } from './BandsTab'
import { BenefitsTab } from './BenefitsTab'
import { CompTableTab } from './CompTableTab'
import { CostTab } from './CostTab'
import { EquityTab } from './EquityTab'
import { compTabFor } from './helpers'
import { PayRunsTab } from './PayRunsTab'
import { PlanTab } from './PlanTab'
import { VariableTab } from './VariableTab'

export function CompPage({ route }: PageProps) {
  const viewer = useViewer()
  const db = useDB((s) => s.db)
  const { tab, sub } = compTabFor(route.segments[1])
  if (viewer.role !== 'admin') {
    return (
      <>
        <PageHeader title="Comp and plan" />
        <EmptyState icon="lock" title="Admins only" body="Comp and plan shows everyone's pay and equity, so only the Admin view opens it." />
      </>
    )
  }
  const queue = boardConsentQueue(db).length
  const oob = outOfBand(db, today()).length
  return (
    <>
      <PageHeader
        title="Comp and plan"
        subtitle="What we pay, what we've granted, who we hire next and what it costs. Press B to blur amounts when sharing your screen."
      />
      <Tabs
        label="Comp and plan sections"
        value={tab}
        className="mb-5"
        tabs={[
          { key: 'table', label: 'Summary table', href: links.comp('table'), ...(oob ? { count: oob } : {}) },
          { key: 'components', label: 'Components', href: links.comp('components') },
          { key: 'plan', label: 'Headcount plan', href: links.comp('plan') },
          { key: 'cost', label: 'Cost and runway', href: links.comp('cost') },
          { key: 'payruns', label: 'Pay runs', href: links.comp('payruns') },
        ]}
      />
      {tab === 'table' && <CompTableTab />}
      {tab === 'components' && (
        <>
          <Tabs
            label="Components sections"
            value={sub}
            className="mb-4"
            tabs={[
              { key: 'bands', label: 'Base salary', href: links.comp('bands') },
              { key: 'variable', label: 'Variable pay', href: links.comp('variable') },
              { key: 'benefits', label: 'Benefits', href: links.comp('benefits') },
              { key: 'equity', label: 'Equity', href: links.comp('equity'), ...(queue ? { count: queue } : {}) },
            ]}
          />
          {sub === 'bands' && <BandsTab />}
          {sub === 'variable' && <VariableTab />}
          {sub === 'benefits' && <BenefitsTab />}
          {sub === 'equity' && <EquityTab />}
        </>
      )}
      {tab === 'plan' && <PlanTab />}
      {tab === 'cost' && <CostTab />}
      {tab === 'payruns' && <PayRunsTab segment={route.segments[2]} />}
    </>
  )
}

export { ChangeJobSheet, PeopleCostCard, PersonEquityPanel, PersonJobPayPanel } from './panels'
