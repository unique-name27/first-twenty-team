// Settings > Hiring: default stages and SLAs, close-out reasons, response times, offer and referral
// defaults, the scheduling link and the email templates (with merge-field help and a live preview).
import { useId, useMemo, useRef, useState } from 'react'
import { links } from '@/app/router'
import { OUTCOME_REASON_LABELS } from '@/domain/hiring'
import { founder, fullName } from '@/domain/people'
import type { EmailTemplate, JobStage, OutcomeReason, Settings, StageKind } from '@/domain/types'
import { addBusinessDays, fmtDate, fmtDay, today } from '@/lib/dates'
import { fillTemplate } from '@/lib/email'
import { moneyShort } from '@/lib/format'
import { newId } from '@/lib/id'
import { useDB } from '@/store/db'
import {
  Badge,
  Button,
  ChipGroup,
  ChipMulti,
  DescriptionList,
  Field,
  FormGrid,
  IconButton,
  Money,
  MoneyInput,
  NumberInput,
  Panel,
  Segmented,
  Select,
  TextArea,
  TextInput,
  TextLink,
} from '@/ui'
import { Blurrable, commit, EditablePanel, EditSheet, NewOnlyNote, Row, RowList } from './kit'
import { hintWithCount, linkProblem, moveItem, normalizeWebsite, TEXT_MAX_CHARS } from './logic'

export function HiringTab() {
  const settings = useDB((s) => s.db.settings)
  const calendly = useDB((s) => s.db.company.linkOuts.calendly)
  return (
    <div className="flex flex-col gap-5">
      <StagesPanel stages={settings.defaultStages} />
      <ReasonsPanel reasons={settings.outcomeReasons} />
      <TimesPanel settings={settings} />
      <OfferDefaultsPanel settings={settings} />
      <CalendlyPanel calendly={calendly ?? ''} />
      <EmailTemplatesPanel />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

const LOCKED_KINDS: StageKind[] = ['new', 'offer', 'hired']

function slaText(s: JobStage): string {
  if (s.kind === 'offer') return 'Until the offer expires'
  if (s.kind === 'hired') return 'Done'
  if (s.slaBusinessDays == null) return 'No time limit'
  return `${s.slaBusinessDays} business ${s.slaBusinessDays === 1 ? 'day' : 'days'}`
}

function StagesPanel({ stages }: { stages: JobStage[] }) {
  return (
    <EditablePanel<{ stages: JobStage[] }>
      title="Default pipeline"
      subtitle="Every new job starts with these stages. SLAs are business days in a stage before a candidate counts as waiting too long."
      icon="layers"
      value={{ stages }}
      editLabel="Edit stages"
      saveLabel="Save stages"
      validate={(d) =>
        d.stages.some((s) => !s.name.trim())
          ? 'Every stage needs a name.'
          : new Set(d.stages.map((s) => s.name.trim().toLowerCase())).size !== d.stages.length
            ? 'Two stages have the same name.'
            : null
      }
      onSave={(d) =>
        commit('Updated the default pipeline', (draft) => {
          draft.settings.defaultStages = d.stages.map((s) => {
            const row: JobStage = { id: s.id, kind: s.kind, name: s.name.trim() }
            if (s.slaBusinessDays != null && s.kind !== 'offer' && s.kind !== 'hired') row.slaBusinessDays = s.slaBusinessDays
            return row
          })
        })
      }
      view={
        <>
          <ol className="flex flex-col gap-2" aria-label="Default stages">
            {stages.map((s, i) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-surface-2 px-3.5 py-2.5">
                <span className="num w-6 font-bold text-ink-3">{i + 1}</span>
                <span className="font-semibold text-ink">{s.name}</span>
                <span className="text-[13.5px] text-ink-3">{slaText(s)}</span>
              </li>
            ))}
          </ol>
          <NewOnlyNote>
            Changes apply to jobs you open from now on. Each job can still rename, add or remove its own stages. Rejected and
            Withdrew are outcomes with a reason, not stages.
          </NewOnlyNote>
        </>
      }
      form={(d, set) => {
        const list = d.stages
        const setList = (next: JobStage[]) => set({ stages: next })
        const update = (i: number, patch: Partial<JobStage>) => setList(list.map((s, j) => (j === i ? { ...s, ...patch } : s)))
        const offerAt = list.findIndex((s) => s.kind === 'offer')
        const insertAt = offerAt >= 0 ? offerAt : list.length - 1
        const hasScreen = list.some((s) => s.kind === 'recruiter_screen')
        const add = (stage: JobStage) => setList([...list.slice(0, insertAt), stage, ...list.slice(insertAt)])
        return (
          <>
            <ol className="flex flex-col gap-3" aria-label="Stages being edited">
              {list.map((s, i) => {
                const locked = LOCKED_KINDS.includes(s.kind)
                const canUp = !locked && i > 1
                const canDown = !locked && i < insertAt - 1
                return (
                  <li key={s.id} className="rounded-xl border border-line p-3">
                    <div className="flex flex-wrap items-end gap-3">
                      <span className="num pb-3 font-bold text-ink-3">{i + 1}</span>
                      <Field label="Stage name" className="min-w-[180px] flex-1">
                        {(id) => <TextInput id={id} value={s.name} onChange={(e) => update(i, { name: e.target.value })} />}
                      </Field>
                      {s.kind !== 'offer' && s.kind !== 'hired' ? (
                        <Field label="SLA, business days" className="w-40">
                          {(id) => (
                            <NumberInput
                              id={id}
                              min={1}
                              max={30}
                              step="1"
                              value={s.slaBusinessDays ?? null}
                              onChange={(v) => update(i, { slaBusinessDays: v == null ? undefined : Math.max(1, Math.round(v)) })}
                            />
                          )}
                        </Field>
                      ) : (
                        <p className="pb-3 text-[13.5px] text-ink-3">{slaText(s)}</p>
                      )}
                      <div className="flex gap-1 pb-0.5">
                        <IconButton icon="chevron-up" label={`Move ${s.name || 'stage'} up`} disabled={!canUp} onClick={() => setList(moveItem(list, i, -1))} />
                        <IconButton icon="chevron-down" label={`Move ${s.name || 'stage'} down`} disabled={!canDown} onClick={() => setList(moveItem(list, i, 1))} />
                        <IconButton
                          icon="trash"
                          label={locked ? `${s.name} is required` : `Remove ${s.name || 'stage'}`}
                          disabled={locked}
                          onClick={() => setList(list.filter((_, j) => j !== i))}
                        />
                      </div>
                    </div>
                  </li>
                )
              })}
            </ol>
            <div className="flex flex-wrap gap-2">
              {!hasScreen && (
                <Button icon="plus" onClick={() => add({ id: 'recruiter_screen', kind: 'recruiter_screen', name: 'Recruiter screen', slaBusinessDays: 3 })}>
                  Add recruiter screen
                </Button>
              )}
              <Button icon="plus" onClick={() => add({ id: newId('st'), kind: 'custom', name: 'New stage', slaBusinessDays: 5 })}>
                Add custom stage
              </Button>
            </div>
            <p className="text-[13px] text-ink-3">New stays first; Offer and Hired stay last. A recruiter screen is worth adding once you have a recruiter.</p>
          </>
        )
      }}
    />
  )
}

// ---------------------------------------------------------------------------------------------

const ALL_REASONS = Object.keys(OUTCOME_REASON_LABELS) as OutcomeReason[]

function ReasonsPanel({ reasons }: { reasons: OutcomeReason[] }) {
  return (
    <EditablePanel<{ reasons: OutcomeReason[] }>
      title="Close-out reasons"
      subtitle="The one-tap reason chips for Reject and Withdrew. Reasons feed the decline and pipeline reports."
      icon="flag"
      value={{ reasons }}
      editLabel="Edit reasons"
      saveLabel="Save reasons"
      validate={(d) => (d.reasons.length === 0 ? 'Keep at least one reason.' : null)}
      onSave={(d) =>
        commit('Updated close-out reasons', (draft) => {
          // Keep the canonical order so chips always read the same way.
          draft.settings.outcomeReasons = ALL_REASONS.filter((r) => d.reasons.includes(r))
        })
      }
      view={
        <div className="flex flex-wrap gap-2">
          {reasons.map((r) => (
            <Badge key={r} tone="outline">
              {OUTCOME_REASON_LABELS[r]}
            </Badge>
          ))}
        </div>
      }
      form={(d, set) => (
        <div className="flex flex-col gap-1.5">
          <span className="text-[13.5px] font-semibold text-ink-2">Reasons offered</span>
          <ChipMulti
            label="Reasons offered"
            values={d.reasons}
            onChange={(v) => set({ reasons: v })}
            options={ALL_REASONS.map((r) => ({ value: r, label: OUTCOME_REASON_LABELS[r] }))}
          />
          <p className="text-[13px] text-ink-3">Reasons are for your records only. Never record a protected characteristic as a reason.</p>
        </div>
      )}
    />
  )
}

// ---------------------------------------------------------------------------------------------

type Times = Pick<Settings, 'scorecardDueHours' | 'responseSlaBusinessDays' | 'offerExpiryBusinessDays'>

function numberChips(label: string, values: number[], value: number, onChange: (n: number) => void, unit: (n: number) => string) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13.5px] font-semibold text-ink-2">{label}</span>
      <ChipGroup
        label={label}
       
        value={String(value)}
        onChange={(v) => onChange(Number(v))}
        options={values.map((n) => ({ value: String(n), label: unit(n) }))}
      />
    </div>
  )
}

function TimesPanel({ settings }: { settings: Settings }) {
  const value: Times = {
    scorecardDueHours: settings.scorecardDueHours,
    responseSlaBusinessDays: settings.responseSlaBusinessDays,
    offerExpiryBusinessDays: settings.offerExpiryBusinessDays,
  }
  return (
    <EditablePanel<Times>
      title="Response times"
      subtitle="Late items land in the inbox so nobody is left waiting."
      icon="clock"
      value={value}
      editLabel="Edit response times"
      saveLabel="Save response times"
      onSave={(d) =>
        commit('Updated hiring response times', (draft) => {
          draft.settings.scorecardDueHours = d.scorecardDueHours
          draft.settings.responseSlaBusinessDays = d.responseSlaBusinessDays
          draft.settings.offerExpiryBusinessDays = d.offerExpiryBusinessDays
        })
      }
      view={
        <DescriptionList
          columns={3}
          items={[
            { label: 'Scorecards due', value: `${settings.scorecardDueHours} hours after the interview` },
            { label: 'Candidates hear back within', value: `${settings.responseSlaBusinessDays} business days` },
            { label: 'Offers expire after', value: `${settings.offerExpiryBusinessDays} business days` },
          ]}
        />
      }
      form={(d, set) => (
        <>
          {numberChips('Scorecards due after the interview', [24, 48, 72], d.scorecardDueHours, (n) => set({ scorecardDueHours: n }), (n) => `${n} hours`)}
          {numberChips(
            'Candidates hear back within',
            [3, 5, 7, 10],
            d.responseSlaBusinessDays,
            (n) => set({ responseSlaBusinessDays: n }),
            (n) => `${n} business days`,
          )}
          {numberChips(
            'Offers expire after',
            [3, 5, 7, 10],
            d.offerExpiryBusinessDays,
            (n) => set({ offerExpiryBusinessDays: n }),
            (n) => `${n} business days`,
          )}
        </>
      )}
    />
  )
}

// ---------------------------------------------------------------------------------------------

type OfferDefaults = Pick<Settings, 'referralBonusDefault' | 'referralBonusPayableDays' | 'defaultVestingMonths' | 'defaultCliffMonths'>

function OfferDefaultsPanel({ settings }: { settings: Settings }) {
  const value: OfferDefaults = {
    referralBonusDefault: settings.referralBonusDefault,
    referralBonusPayableDays: settings.referralBonusPayableDays,
    defaultVestingMonths: settings.defaultVestingMonths,
    defaultCliffMonths: settings.defaultCliffMonths,
  }
  return (
    <EditablePanel<OfferDefaults>
      title="Offer and referral defaults"
      subtitle="Prefilled on new offers and referrals; each can still be changed."
      icon="gift"
      value={value}
      editLabel="Edit defaults"
      saveLabel="Save defaults"
      validate={(d) => (d.defaultCliffMonths >= d.defaultVestingMonths ? 'The cliff must be shorter than the vesting period.' : null)}
      onSave={(d) =>
        commit('Updated offer and referral defaults', (draft) => {
          draft.settings.referralBonusDefault = d.referralBonusDefault
          draft.settings.referralBonusPayableDays = d.referralBonusPayableDays
          draft.settings.defaultVestingMonths = d.defaultVestingMonths
          draft.settings.defaultCliffMonths = d.defaultCliffMonths
        })
      }
      view={
        <DescriptionList
          items={[
            {
              label: 'Referral bonus',
              value: (
                <>
                  <Money value={settings.referralBonusDefault} />, payable {settings.referralBonusPayableDays} days after the hire starts
                </>
              ),
            },
            {
              label: 'Employee option vesting',
              value: `${settings.defaultVestingMonths / 12} years${settings.defaultCliffMonths ? ` with a ${settings.defaultCliffMonths}-month cliff` : ', no cliff'}, then monthly`,
            },
          ]}
        />
      }
      form={(d, set) => (
        <>
          <FormGrid>
            <Field label="Referral bonus" hint={`Common at seed stage: ${moneyShort(2500)} to ${moneyShort(10000)}.`}>
              {(id, hint) => (
                <Blurrable>
                  <MoneyInput id={id} aria-describedby={hint} value={d.referralBonusDefault} onChange={(v) => set({ referralBonusDefault: v ?? 0 })} />
                </Blurrable>
              )}
            </Field>
          </FormGrid>
          {numberChips('Referral bonus payable after', [30, 60, 90, 180], d.referralBonusPayableDays, (n) => set({ referralBonusPayableDays: n }), (n) => `${n} days`)}
          {numberChips('Vesting period', [24, 36, 48], d.defaultVestingMonths, (n) => set({ defaultVestingMonths: n }), (n) => `${n / 12} years`)}
          {numberChips('Cliff', [0, 6, 12], d.defaultCliffMonths, (n) => set({ defaultCliffMonths: n }), (n) => (n ? `${n} months` : 'No cliff'))}
        </>
      )}
    />
  )
}

// ---------------------------------------------------------------------------------------------

function CalendlyPanel({ calendly }: { calendly: string }) {
  return (
    <EditablePanel<{ url: string }>
      title="Scheduling link"
      subtitle="Offered in scheduling messages instead of three proposed times. Calendly or any booking page works."
      icon="calendar"
      value={{ url: calendly }}
      editLabel="Edit link"
      saveLabel="Save link"
      validate={(d) => linkProblem(d.url)}
      onSave={(d) => {
        // A link typed without https:// is saved with it, as under Link-outs.
        const url = normalizeWebsite(d.url)
        return commit(url ? 'Updated the scheduling link' : 'Removed the scheduling link', (draft) => {
          if (url) draft.company.linkOuts.calendly = url
          else delete draft.company.linkOuts.calendly
        })
      }}
      view={
        calendly ? (
          <a href={calendly} target="_blank" rel="noreferrer noopener" className="font-semibold break-all text-accent underline">
            {calendly}
          </a>
        ) : (
          <p className="text-[14px] text-ink-3">Not set. Scheduling messages will offer three times instead.</p>
        )
      }
      form={(d, set) => (
        <Field label="Booking page link" error={linkProblem(d.url)} hint="Also listed under Link-outs.">
          {(id, hint) => (
            <TextInput id={id} aria-describedby={hint} inputMode="url" placeholder="https://calendly.com/you/intro" value={d.url} onChange={(e) => set({ url: e.target.value })} />
          )}
        </Field>
      )}
    />
  )
}

// ---------------------------------------------------------------------------------------------

export const TEMPLATE_KIND_LABELS: Record<EmailTemplate['kind'], string> = {
  scheduling: 'Scheduling',
  rejection: 'Rejection',
  close_out: 'Close-out',
  offer: 'Offer',
  offer_nudge: 'Offer nudge',
  welcome: 'Welcome',
  reminder: 'Reminder',
  other: 'Other',
}

const STAGE_KIND_LABELS: Record<StageKind, string> = {
  new: 'New',
  recruiter_screen: 'Recruiter screen',
  intro: 'Intro call',
  technical: 'Technical',
  onsite: 'Onsite',
  offer: 'Offer',
  hired: 'Hired',
  custom: 'Custom stages',
}

export const MERGE_FIELDS: Array<{ key: string; help: string }> = [
  { key: 'firstName', help: "Candidate's first name" },
  { key: 'jobTitle', help: 'The job title' },
  { key: 'companyName', help: 'Your company name' },
  { key: 'senderName', help: 'Who sends it (you)' },
  { key: 'times', help: 'Proposed times, in Pacific and their time zone' },
  { key: 'calendly', help: 'Your scheduling link' },
  { key: 'stageName', help: 'The stage they are in' },
  { key: 'duration', help: 'Interview length, like "45-minute "' },
  { key: 'expiresOn', help: 'Offer expiry date (offer nudges)' },
]

function blankTemplate(): EmailTemplate {
  return { id: newId('em'), kind: 'other', tone: 'kind', name: '', subject: '', body: 'Hi {{firstName}},\n\n\n\n{{senderName}}' }
}

function EmailTemplatesPanel() {
  const templates = useDB((s) => s.db.emailTemplates)
  const [editing, setEditing] = useState<EmailTemplate | null>(null)
  const isNew = editing ? !templates.some((t) => t.id === editing.id) : false
  const groups = useMemo(() => {
    const order = Object.keys(TEMPLATE_KIND_LABELS) as Array<EmailTemplate['kind']>
    return order.map((k) => ({ kind: k, items: templates.filter((t) => t.kind === k) })).filter((g) => g.items.length > 0)
  }, [templates])
  return (
    <Panel
      title="Email templates"
      subtitle="Messages open in your mail app or copy to the clipboard. Merge fields fill in names and times."
      icon="mail"
      actions={
        <Button icon="plus" onClick={() => setEditing(blankTemplate())}>
          Add template
        </Button>
      }
    >
      {groups.map((g) => (
        <div key={g.kind} className="mb-2 last:mb-0">
          <h3 className="eyebrow mt-2">{TEMPLATE_KIND_LABELS[g.kind]}</h3>
          <RowList label={`${TEMPLATE_KIND_LABELS[g.kind]} templates`}>
            {g.items.map((t) => (
              <Row
                key={t.id}
                title={t.name || 'Untitled template'}
                badges={
                  <>
                    {t.tone && <Badge tone="outline">{t.tone === 'kind' ? 'Kind tone' : 'Brief tone'}</Badge>}
                    {t.stageKinds?.length ? <Badge>{t.stageKinds.map((k) => STAGE_KIND_LABELS[k]).join(', ')}</Badge> : null}
                  </>
                }
                meta={`Subject: ${t.subject}`}
                actions={
                  <>
                    <Button icon="edit" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      icon="copy"
                      aria-label={`Duplicate ${t.name}`}
                      onClick={() =>
                        commit(`Duplicated the ${t.name} template`, (draft) => {
                          const i = draft.emailTemplates.findIndex((x) => x.id === t.id)
                          draft.emailTemplates.splice(i + 1, 0, { ...structuredClone(t), id: newId('em'), name: `${t.name} (copy)` })
                        })
                      }
                    >
                      Duplicate
                    </Button>
                    <Button
                      variant="ghost"
                      icon="trash"
                      aria-label={`Remove ${t.name}`}
                      onClick={() =>
                        commit(`Removed the ${t.name} template`, (draft) => {
                          draft.emailTemplates = draft.emailTemplates.filter((x) => x.id !== t.id)
                        })
                      }
                    >
                      Remove
                    </Button>
                  </>
                }
              />
            ))}
          </RowList>
        </div>
      ))}
      {templates.length === 0 && <p className="text-[14px] text-ink-3">No templates. Built-in messages are used until you add one.</p>}
      {editing && (
        <EditSheet<EmailTemplate>
          key={editing.id}
          open
          width={720}
          title={isNew ? 'Add an email template' : `Edit ${editing.name}`}
          initial={editing}
          onClose={() => setEditing(null)}
          saveLabel={isNew ? 'Add template' : 'Save template'}
          validate={(d) => (!d.name.trim() ? 'Name the template.' : !d.subject.trim() ? 'Add a subject line.' : !d.body.trim() ? 'Write the message.' : null)}
          onSave={(d) =>
            commit(isNew ? `Added the ${d.name.trim()} template` : `Updated the ${d.name.trim()} template`, (draft) => {
              const row: EmailTemplate = { ...d, name: d.name.trim(), subject: d.subject.trim() }
              if (row.kind !== 'rejection' || !row.stageKinds?.length) delete row.stageKinds
              const i = draft.emailTemplates.findIndex((x) => x.id === d.id)
              if (i >= 0) draft.emailTemplates[i] = row
              else draft.emailTemplates.push(row)
            })
          }
        >
          {(d, set) => <TemplateForm d={d} set={set} />}
        </EditSheet>
      )}
    </Panel>
  )
}

function TemplateForm({ d, set }: { d: EmailTemplate; set: (patch: Partial<EmailTemplate>) => void }) {
  const db = useDB((s) => s.db)
  const base = useId().replace(/:/g, '')
  const subjectId = `${base}-subject`
  const bodyId = `${base}-body`
  const lastField = useRef<'subject' | 'body'>('body')
  const sample = useMemo(() => {
    const f = founder(db)
    const job = db.jobs.find((j) => j.status === 'open')
    return {
      firstName: 'Priya',
      jobTitle: job?.title ?? 'Senior full-stack engineer',
      companyName: db.company.name,
      senderName: f ? fullName(f) : db.company.name,
      times: [
        `${fmtDay(addBusinessDays(today(), 2))}, 10:00 AM Pacific (1:00 PM Eastern)`,
        `${fmtDay(addBusinessDays(today(), 3))}, 2:00 PM Pacific (5:00 PM Eastern)`,
        `${fmtDay(addBusinessDays(today(), 4))}, 11:30 AM Pacific (2:30 PM Eastern)`,
      ].join('\n'),
      calendly: db.company.linkOuts.calendly ?? '',
      stageName: 'Onsite',
      duration: '45-minute ',
      expiresOn: fmtDate(addBusinessDays(today(), db.settings.offerExpiryBusinessDays)),
    }
  }, [db])

  const insert = (key: string) => {
    const token = `{{${key}}}`
    const target = lastField.current
    const el = document.getElementById(target === 'subject' ? subjectId : bodyId) as HTMLInputElement | HTMLTextAreaElement | null
    const current = target === 'subject' ? d.subject : d.body
    const start = el?.selectionStart ?? current.length
    const end = el?.selectionEnd ?? current.length
    const next = current.slice(0, start) + token + current.slice(end)
    set(target === 'subject' ? { subject: next } : { body: next })
    setTimeout(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    }, 0)
  }

  return (
    <>
      <FormGrid>
        <Field label="Template name" required>
          {(id) => <TextInput id={id} value={d.name} onChange={(e) => set({ name: e.target.value })} />}
        </Field>
        <Field label="Kind">
          {(id) => (
            <Select
              id={id}
              value={d.kind}
              onChange={(v) => set({ kind: v })}
              options={(Object.keys(TEMPLATE_KIND_LABELS) as Array<EmailTemplate['kind']>).map((k) => ({ value: k, label: TEMPLATE_KIND_LABELS[k] }))}
            />
          )}
        </Field>
      </FormGrid>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13.5px] font-semibold text-ink-2">Tone</span>
        <Segmented
          label="Tone"
          value={d.tone ?? 'kind'}
          onChange={(v) => set({ tone: v })}
          options={[
            { value: 'kind', label: 'Kind' },
            { value: 'brief', label: 'Brief' },
          ]}
        />
      </div>
      {d.kind === 'rejection' && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[13.5px] font-semibold text-ink-2">Use for candidates in</span>
          <ChipMulti
            label="Use for candidates in"
            values={d.stageKinds ?? []}
            onChange={(v) => set({ stageKinds: v })}
            options={(['new', 'recruiter_screen', 'intro', 'technical', 'onsite', 'offer', 'custom'] as StageKind[]).map((k) => ({
              value: k,
              label: STAGE_KIND_LABELS[k],
            }))}
          />
          <p className="text-[13px] text-ink-3">Final-round rejections (Onsite, Offer) also suggest a call instead of only an email.</p>
        </div>
      )}
      <Field label="Subject" required id={subjectId}>
        {(id) => (
          <TextInput
            id={id}
            value={d.subject}
            onFocus={() => (lastField.current = 'subject')}
            onChange={(e) => set({ subject: e.target.value })}
          />
        )}
      </Field>
      <Field
        label="Message"
        required
        id={bodyId}
        hint={hintWithCount('Tip: dictate with Win+H on Windows or the dictation key on a Mac.', d.body, TEXT_MAX_CHARS)}
      >
        {(id, hint) => (
          <TextArea
            id={id}
            aria-describedby={hint}
            rows={9}
            maxLength={TEXT_MAX_CHARS}
            value={d.body}
            onFocus={() => (lastField.current = 'body')}
            onChange={(e) => set({ body: e.target.value })}
          />
        )}
      </Field>
      <div className="flex flex-col gap-2">
        <span className="text-[13.5px] font-semibold text-ink-2">Insert a merge field</span>
        <p className="text-[13px] text-ink-3">Inserts where the cursor was in the subject or message.</p>
        <ul className="flex flex-wrap gap-2" aria-label="Merge fields">
          {MERGE_FIELDS.map((m) => (
            <li key={m.key}>
              <Button variant="quiet" title={m.help} aria-label={`Insert ${m.key}: ${m.help}`} onClick={() => insert(m.key)}>
                <span className="font-mono">{`{{${m.key}}}`}</span>
              </Button>
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-2">
          {MERGE_FIELDS.map((m) => (
            <div key={m.key} className="flex gap-2">
              <dt className="font-mono text-ink-2">{m.key}</dt>
              <dd className="text-ink-3">{m.help}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="rounded-xl border border-line bg-surface-2 p-4">
        <p className="eyebrow mb-2">Preview with sample details</p>
        <p className="text-[14px] font-semibold break-words text-ink">{fillTemplate(d.subject, sample) || 'No subject yet'}</p>
        <pre className="mt-2 font-body text-[14px] break-words whitespace-pre-wrap text-ink-2">{fillTemplate(d.body, sample)}</pre>
        {!sample.calendly && d.body.includes('{{calendly}}') && (
          <p className="mt-2 text-[13px] font-semibold text-warn">
            No scheduling link is set, so {'{{calendly}}'} will be blank. <TextLink href={links.settings('links')}>Add one in Link-outs</TextLink>.
          </p>
        )}
      </div>
    </>
  )
}
