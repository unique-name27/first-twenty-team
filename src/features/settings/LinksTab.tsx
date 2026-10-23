// Settings > Link-outs: where the real records live. The app stores status, dates and a link; payroll,
// background checks, signatures and the cap table stay in their own systems. Next to the provider, the pay run
// settings: how long before payday the provider needs the payroll, where a weekend or holiday payday moves, and the
// semi-monthly paydays (docs/SPEC.md PAY RUN PREP; checked against Labor Code 204, docs/LAW.md w-pay-frequency).
import { links } from '@/app/router'
import { LAW_SOURCES } from '@/data/law'
import {
  cutoffWords,
  latePaydaysText,
  latePaydaysWith,
  MAX_CUTOFF_BUSINESS_DAYS,
  paydayChangeNotice,
  paydayShiftWords,
  paydayWords,
  type PayrollSettings,
  payrollSettings,
  payrollSettingsProblem,
  semiMonthlyPaydayChoices,
  setPayrollSettings,
} from '@/domain/payrun'
import type { Company, LinkOuts } from '@/domain/types'
import { today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Badge, Callout, CitationChip, Field, FormGrid, Icon, Segmented, Select, TextInput, TextLink } from '@/ui'
import { commit, EditablePanel, RowList, Row } from './kit'
import { hostLabel, linkProblem, normalizeWebsite, payrollProviderName } from './logic'

type LinkKey = keyof LinkOuts

const LINKS: Array<{ key: LinkKey; label: string; what: string; placeholder: string }> = [
  { key: 'backgroundCheck', label: 'Background check vendor', what: 'Consent and FCRA and ICRAA disclosures go out from here. Only Clear or Consider comes back.', placeholder: 'https://' },
  { key: 'eSign', label: 'E-signature', what: 'Offer letters, PIIAs and policy acknowledgements are signed here.', placeholder: 'https://' },
  { key: 'capTable', label: 'Cap table tool', what: 'The source of truth for grants, exercises and 409A reports.', placeholder: 'https://' },
  { key: 'calendly', label: 'Scheduling link (Calendly)', what: 'Offered in interview scheduling messages.', placeholder: 'https://calendly.com/you' },
  { key: 'videoRoom', label: 'Video meeting room', what: 'Prefilled as the link for video interviews, in the confirmation message and the calendar files.', placeholder: 'https://meet.google.com/' },
  { key: 'training', label: 'Security training provider', what: 'Linked from security awareness training tasks.', placeholder: 'https://' },
  { key: 'handbook', label: 'Employee handbook', what: 'Linked from acknowledgements and Me.', placeholder: 'https://' },
  { key: 'benefits', label: 'Benefits summary', what: 'Shared on job postings and in onboarding.', placeholder: 'https://' },
]

type Draft = { providerName: string; providerKind: Company['payrollProvider']['kind']; providerUrl: string } & Record<LinkKey, string>

function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname
    const text = `${u.hostname.replace(/^www\./, '')}${path}`
    return text.length > 42 ? `${text.slice(0, 40)}...` : text
  } catch {
    return hostLabel(url) ?? url
  }
}

function ExternalLink({ url, label }: { url: string | undefined; label: string }) {
  if (!url) return <Badge tone="outline">Not set</Badge>
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`Open ${label} (new tab): ${shortUrl(url)}`}
      className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2 font-semibold break-all text-accent underline decoration-accent/30 hover:decoration-accent"
    >
      {shortUrl(url)}
      <Icon name="external" size={14} />
    </a>
  )
}

export function LinksTab() {
  return (
    <div className="flex flex-col gap-5">
      <LinkOutsPanel />
      <PayRunSettingsPanel />
    </div>
  )
}

function LinkOutsPanel() {
  const company = useDB((s) => s.db.company)
  const providerName = payrollProviderName(company)
  // What the provider is called while it has no name.
  const providerLabel = providerName || 'Payroll or PEO provider'
  const value: Draft = {
    providerName,
    providerKind: company.payrollProvider.kind,
    providerUrl: company.payrollProvider.url || company.linkOuts.payroll || '',
    ...(Object.fromEntries(LINKS.map((l) => [l.key, company.linkOuts[l.key] ?? ''])) as Record<LinkKey, string>),
    payroll: company.linkOuts.payroll ?? '',
  }
  return (
    <EditablePanel<Draft>
      title="Link-outs"
      subtitle="Files never live here. Each checklist item and document links to where the real record is."
      icon="link"
      value={value}
      editLabel="Edit links"
      saveLabel="Save links"
      // A link typed without https:// ('secure.justworks.com') is saved with it, as Start fresh does.
      validate={(d) => {
        const bad = [d.providerUrl, ...LINKS.map((l) => d[l.key])].map(linkProblem).find(Boolean)
        return bad ? `One of the links needs fixing: ${bad}` : null
      }}
      onSave={(d) =>
        commit('Updated link-outs', (draft) => {
          const c = draft.company
          const providerUrl = normalizeWebsite(d.providerUrl)
          c.payrollProvider = { name: d.providerName.trim(), kind: d.providerKind, url: providerUrl }
          const next: LinkOuts = {}
          if (providerUrl) next.payroll = providerUrl
          for (const l of LINKS) {
            const v = normalizeWebsite(d[l.key])
            if (v) next[l.key] = v
          }
          c.linkOuts = next
        })
      }
      view={
        <RowList label="Link-outs">
          <Row
            title={providerName ? `Payroll or PEO: ${providerName}` : providerLabel}
            badges={<Badge>{company.payrollProvider.kind === 'PEO' ? 'PEO' : 'Payroll provider'}</Badge>}
            meta="Pay, taxes, W-2s, I-9s, benefits enrollment and the sensitive records this app never keeps."
            actions={<ExternalLink label={providerLabel} url={company.payrollProvider.url || company.linkOuts.payroll} />}
          />
          {LINKS.map((l) => (
            <Row key={l.key} title={l.label} meta={l.what} actions={<ExternalLink label={l.label} url={company.linkOuts[l.key]} />} />
          ))}
        </RowList>
      }
      form={(d, set) => (
        <>
          <fieldset className="flex flex-col gap-3 rounded-xl border border-line p-3">
            <legend className="px-1 text-[13.5px] font-semibold text-ink-2">Payroll or PEO</legend>
            <FormGrid>
              <Field label="Provider name">
                {(id) => (
                  <TextInput id={id} placeholder="Your payroll or PEO provider" value={d.providerName} onChange={(e) => set({ providerName: e.target.value })} />
                )}
              </Field>
              <Field label="Provider link" error={linkProblem(d.providerUrl)}>
                {(id, hint) => (
                  <TextInput id={id} aria-describedby={hint} inputMode="url" placeholder="https://" value={d.providerUrl} onChange={(e) => set({ providerUrl: e.target.value })} />
                )}
              </Field>
            </FormGrid>
            <Segmented
              label="Provider kind"
              value={d.providerKind}
              onChange={(v) => set({ providerKind: v })}
              options={[
                { value: 'PEO', label: 'PEO' },
                { value: 'Payroll', label: 'Payroll provider' },
              ]}
            />
          </fieldset>
          <FormGrid>
            {LINKS.map((l) => (
              <Field key={l.key} label={l.label} error={linkProblem(d[l.key])} hint={linkProblem(d[l.key]) ? undefined : l.what}>
                {(id, hint) => (
                  <TextInput
                    id={id}
                    aria-describedby={hint}
                    inputMode="url"
                    placeholder={l.placeholder}
                    value={d[l.key]}
                    onChange={(e) => set({ [l.key]: e.target.value } as Partial<Draft>)}
                  />
                )}
              </Field>
            ))}
          </FormGrid>
        </>
      )}
    />
  )
}

// ---------------------------------------------------------------------------------------------
// Pay run settings
// ---------------------------------------------------------------------------------------------

type PayDraft = { cutoffBusinessDays: string; paydayShift: PayrollSettings['paydayShift']; first: string; second: string }

function toSettings(d: PayDraft): PayrollSettings {
  return { cutoffBusinessDays: Number(d.cutoffBusinessDays), paydayShift: d.paydayShift, semiMonthlyPaydays: { first: Number(d.first), second: Number(d.second) } }
}

const CUTOFF_OPTIONS = Array.from({ length: MAX_CUTOFF_BUSINESS_DAYS + 1 }, (_, n) => ({ value: String(n), label: cutoffWords(n).replace(/^./, (c) => c.toUpperCase()) }))

function PayRunSettingsPanel() {
  const db = useDB((s) => s.db)
  const company = db.company
  const s = payrollSettings(company)
  const value: PayDraft = {
    cutoffBusinessDays: String(s.cutoffBusinessDays),
    paydayShift: s.paydayShift,
    first: String(s.semiMonthlyPaydays.first),
    second: String(s.semiMonthlyPaydays.second),
  }
  const semi = company.paySchedule === 'semi_monthly'
  const choices = semiMonthlyPaydayChoices()
  const date = today()
  // A new payday is a change the Labor Code 2810.5 notice covers for non-exempt staff (written notice within 7 days).
  const changeNotice = paydayChangeNotice(db, date)
  return (
    <EditablePanel<PayDraft>
      id="pay-run-settings"
      title="Pay run settings"
      icon="calendar"
      subtitle="The pay calendar behind Comp and plan, Pay runs, and the inbox's Run payroll by reminder. Your provider still runs the payroll."
      value={value}
      editLabel="Edit pay run settings"
      saveLabel="Save pay run settings"
      fieldLabels={{ cutoffBusinessDays: 'Run payroll by', paydayShift: 'Weekend or holiday payday', first: 'Payday for the 1st to the 15th', second: 'Payday for the 16th to month end' }}
      validate={(d) => payrollSettingsProblem(toSettings(d), company.paySchedule)}
      onSave={(d) =>
        commit('Updated the pay run settings', (draft) => {
          setPayrollSettings(draft, toSettings(d))
        })
      }
      view={
        <RowList label="Pay run settings">
          <Row title={`Paydays: ${paydayWords(company)}`} meta="The pay schedule and the payday words on the wage notice are in Settings, Company." />
          <Row title={`Run payroll by: ${cutoffWords(s.cutoffBusinessDays)}`} meta="Your provider's deadline, not a legal one. Business days skip weekends, bank holidays and company holidays." />
          <Row
            title={`Weekend or holiday payday: ${paydayShiftWords(s.paydayShift)}`}
            meta={s.paydayShift === 'before' ? 'Paying early is always lawful, and payroll providers move paydays this way.' : "The Labor Commissioner's next-business-day position."}
            actions={<TextLink href={links.comp('payruns')}>Open Pay runs</TextLink>}
          />
        </RowList>
      }
      form={(d, set) => {
        const problem = payrollSettingsProblem(toSettings(d), company.paySchedule)
        // The next paydays these choices would put after the Labor Code 204 date, said before saving, not after.
        const late = problem ? null : latePaydaysText(latePaydaysWith(db, toSettings(d), company.paySchedule, date), date)
        return (
          <>
            <FormGrid>
              <Field label="Run payroll by" hint="How long before payday your provider needs the payroll. The inbox reminds you by then.">
                {(id, hint) => <Select id={id} aria-describedby={hint} value={d.cutoffBusinessDays} onChange={(v) => set({ cutoffBusinessDays: v })} options={CUTOFF_OPTIONS} />}
              </Field>
            </FormGrid>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13.5px] font-semibold text-ink-2">Weekend or holiday payday</span>
              <Segmented
                label="Weekend or holiday payday"
                value={d.paydayShift}
                onChange={(v) => set({ paydayShift: v })}
                options={[
                  { value: 'before', label: 'Business day before' },
                  { value: 'after', label: 'Next business day' },
                ]}
              />
              <p className="text-[12.5px] text-ink-3">
                Before is always lawful: wages may be paid early (Labor Code 219), and payroll providers move paydays this way. After is the Labor
                Commissioner&apos;s position for a payday on a weekend or holiday (DLSE Manual 7.6.2); a payday set on the last day Labor Code 204 allows then lands
                after it.
              </p>
            </div>
            {semi && (
              <FormGrid>
                <Field label="Payday for the 1st to the 15th" error={problem?.includes('26th') ? problem : undefined} hint="Labor Code 204: by the 26th of the same month.">
                  {(id, hint) => (
                    <Select id={id} aria-describedby={hint} value={d.first} onChange={(v) => set({ first: v })} options={choices.first.map((c) => ({ value: String(c.value), label: c.label }))} />
                  )}
                </Field>
                <Field label="Payday for the 16th to month end" error={problem?.includes('10th') ? problem : undefined} hint="Labor Code 204: by the 10th of the next month.">
                  {(id, hint) => (
                    <Select id={id} aria-describedby={hint} value={d.second} onChange={(v) => set({ second: v })} options={choices.second.map((c) => ({ value: String(c.value), label: c.label }))} />
                  )}
                </Field>
              </FormGrid>
            )}
            {late && (
              <Callout tone="warn" icon="calendar" title={late.title}>
                <p>{late.text}</p>
              </Callout>
            )}
            {changeNotice && <p className="text-[13px] text-ink-2">{changeNotice}</p>}
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
              <CitationChip label={LAW_SOURCES.lc204.label} url={LAW_SOURCES.lc204.url} />
              <CitationChip label={LAW_SOURCES.lc219.label} url={LAW_SOURCES.lc219.url} />
              <CitationChip label={LAW_SOURCES.dlseManual.label} url={LAW_SOURCES.dlseManual.url} />
              <span>Not legal advice.</span>
            </div>
          </>
        )
      }}
    />
  )
}
