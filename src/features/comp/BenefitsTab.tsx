// Comp and plan > Benefits (#comp.benefits): the group health plan as Settings, Company records it, what Cost and
// runway counts for benefits today and whom that leaves out, and the links to where benefits are really run. Read
// only: enrollment and open enrollment stay with the PEO or broker, so the app keeps a summary link and a cost per
// person and nothing else (docs/SPEC.md, Will not have). Edits happen in Settings.
import { useMemo } from 'react'
import { links, navigate } from '@/app/router'
import { BENEFITS_MIN_HOURS } from '@/domain/pay'
import { payrollProviderName } from '@/domain/payrun'
import { fmtDate, today } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { Button, DescriptionList, Icon, Money, Panel, TextLink } from '@/ui'
import { benefitsSummary, healthPlanText, linkOut, postingHealthText } from './helpers'

/** A link-out from Settings, Link-outs: a web address opens in a new tab, anything else typed there shows as text. */
function OutLink({ url, label }: { url: string | undefined; label: string }) {
  const out = linkOut(url)
  // The element is always truthy, so the list's own "Not set" fallback never shows: say it here, as it does.
  if (!out) return <span className="text-ink-3">Not set</span>
  if (!out.href) return <span className="break-all">{out.text}</span>
  return (
    <a
      href={out.href}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Open ${label} (new tab): ${out.text}`}
      className="ft-link inline-flex min-h-10 items-center gap-1.5 font-semibold break-all text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent"
    >
      {out.text}
      <Icon name="external" size={14} />
    </a>
  )
}

export function BenefitsTab() {
  const db = useDB((s) => s.db)
  const date = today()
  const s = useMemo(() => benefitsSummary(db, date), [db, date])
  const providerUrl = db.company.payrollProvider?.url || db.company.linkOuts.payroll
  const providerName = payrollProviderName(db.company)
  const total = s.counted + s.belowHours.length

  const costItems =
    s.basis === 'none'
      ? [{ label: 'Per person', value: 'None. Settings records no group health plan, so Cost and runway counts no benefits.' }]
      : [
          {
            label: 'Per person',
            value: (
              <>
                <Money value={s.perHeadMonthly} suffix=" a month" />
                {s.basis === 'assumed' && <span className="block text-[12.5px] text-ink-3">An assumption until the group health plan is recorded</span>}
                {s.basis === 'plan' && !s.planInPlace && (
                  <span className="block text-[12.5px] text-ink-3">The plan starts {fmtDate(s.planStartedOn)}. Cost and runway counts benefits from today.</span>
                )}
              </>
            ),
          },
          {
            label: 'People counted',
            value: (
              <>
                {s.counted} of {total}
                <span className="block text-[12.5px] text-ink-3">Those working {BENEFITS_MIN_HOURS} hours a week or more</span>
              </>
            ),
          },
          { label: 'A month', value: <Money value={s.monthly} /> },
          { label: 'A year', value: <Money value={s.monthly * 12} /> },
        ]

  return (
    <div className="@container flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-5 @[720px]:grid-cols-2">
        <Panel
          title="Group health plan"
          icon="heart"
          subtitle="As Settings, Company records it."
          actions={
            <Button size="sm" variant="ghost" icon="settings" onClick={() => navigate('settings', 'company')}>
              Edit in Settings
            </Button>
          }
        >
          <DescriptionList
            columns={1}
            items={[
              {
                label: 'Plan',
                value: (
                  <>
                    {healthPlanText(s)}
                    {s.basis === 'assumed' && <span className="block text-[12.5px] text-ink-3">Record whether the company offers one in Settings, Company.</span>}
                  </>
                ),
              },
              { label: 'Job postings', value: postingHealthText(s) },
            ]}
          />
        </Panel>

        <Panel title="Cost today" icon="coins" subtitle="The Benefits line in Cost and runway, Now.">
          <DescriptionList columns={2} items={costItems} />
          {s.basis !== 'none' && s.belowHours.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <h3 className="text-[13px] font-semibold text-ink-3">Not counted: under {BENEFITS_MIN_HOURS} hours a week</h3>
              <ul className="mt-1 flex flex-col">
                {s.belowHours.map((p) => (
                  <li key={p.personId} className="flex flex-wrap items-center justify-between gap-x-3 text-[14px]">
                    <a href={links.person(p.personId)} className="ft-link inline-flex min-h-10 items-center font-semibold text-ink hover:text-accent">
                      {p.name}
                    </a>
                    <span className="text-ink-3">{plural(p.hoursPerWeek, 'hour')} a week</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-3 text-[13px] text-ink-2">
            <TextLink href={links.comp('cost')}>See every scenario in Cost and runway</TextLink>
          </p>
        </Panel>
      </div>

      <Panel
        title="Where benefits are run"
        icon="link"
        subtitle="Enrollment and open enrollment stay with your PEO or broker. First Twenty keeps a summary link and a cost per person."
        actions={
          <Button size="sm" variant="ghost" icon="settings" onClick={() => navigate('settings', 'links')}>
            Edit link-outs
          </Button>
        }
      >
        <DescriptionList
          columns={2}
          items={[
            { label: 'Benefits summary', value: <OutLink url={db.company.linkOuts.benefits} label="Benefits summary" /> },
            {
              label: providerName ? `Payroll or PEO: ${providerName}` : 'Payroll or PEO',
              value: <OutLink url={providerUrl} label="Payroll or PEO" />,
            },
          ]}
        />
      </Panel>
    </div>
  )
}
