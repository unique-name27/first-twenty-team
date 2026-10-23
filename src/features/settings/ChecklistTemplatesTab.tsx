// Settings > Checklist templates: each template's tasks with due rule, owner, conditions and citation.
// Edit a task's title, why, due rule and owner; add custom tasks; reset a template to the defaults.
// Edits apply to checklists generated from now on; running checklists keep their tasks.
import { useMemo, useState } from 'react'
import { dueRuleText } from '@/domain/checklists/generate'
import { DEFAULT_CHECKLIST_TEMPLATES } from '@/domain/checklists/templates'
import type { ChecklistKind, ChecklistTemplate, DueRule, OwnerRole, TaskCategory, TemplateTask } from '@/domain/types'
import { useDB } from '@/store/db'
import {
  Badge,
  Button,
  ChipGroup,
  CitationChip,
  ConfirmButton,
  Field,
  FormGrid,
  NumberInput,
  Panel,
  Segmented,
  Select,
  Switch,
  TextArea,
  TextInput,
} from '@/ui'
import { commit, EditSheet, Row, RowList } from './kit'
import { CUSTOM_TASK_PREFIX, describeCondition, hintWithCount, isCustomTask, SHORT_TEXT_MAX_CHARS } from './logic'
import { newId } from '@/lib/id'

const KIND_LABELS: Record<ChecklistKind, string> = {
  onboarding: 'Onboarding',
  offboarding: 'Offboarding',
  new_state: 'New state',
  leave: 'Leave',
  change: 'Job or pay change',
}

const OWNER_LABELS: Record<OwnerRole, string> = { admin: 'Admin', manager: 'Manager', employee: 'The person', it: 'IT' }

const CATEGORY_LABELS: Record<TaskCategory, string> = {
  legal: 'Legal',
  payroll: 'Payroll',
  benefits: 'Benefits',
  it: 'IT',
  security: 'Security',
  equity: 'Equity',
  culture: 'Culture',
  training: 'Training',
  notice: 'Notice',
}

const ANCHORS: Record<ChecklistKind, Array<{ value: DueRule['anchor']; label: string }>> = {
  onboarding: [
    { value: 'start', label: 'Start date' },
    { value: 'offer_accepted', label: 'Offer accepted' },
  ],
  offboarding: [{ value: 'last_day', label: 'Last day' }],
  new_state: [{ value: 'start', label: 'Start date' }],
  leave: [
    { value: 'created', label: 'Request date' },
    { value: 'leave_start', label: 'Leave start' },
  ],
  change: [{ value: 'created', label: 'Day the change is recorded' }],
}

type TaskDraft = Omit<TemplateTask, 'due'> & { due: Omit<DueRule, 'offset'> & { offset: number | null }; before: boolean }

function toDraft(t: TemplateTask): TaskDraft {
  return { ...t, due: { ...t.due, offset: Math.abs(t.due.offset) }, before: t.due.offset < 0 }
}

function fromDraft(d: TaskDraft): TemplateTask {
  const { before, ...rest } = d
  const n = Math.abs(Math.round(d.due.offset ?? 0))
  const task: TemplateTask = { ...rest, title: d.title.trim(), due: { anchor: d.due.anchor, unit: d.due.unit, offset: before ? -n : n } }
  if (!task.why?.trim()) delete task.why
  else task.why = task.why.trim()
  return task
}

export function ChecklistTemplatesTab() {
  const templates = useDB((s) => s.db.checklistTemplates)
  const [selected, setSelected] = useState<string>(templates[0]?.id ?? '')
  const template = templates.find((t) => t.id === selected) ?? templates[0]
  if (!template) return <p className="text-[14px] text-ink-3">No checklist templates.</p>
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-[13.5px] font-semibold text-ink-2">Template</span>
        <ChipGroup
          label="Template"
          value={template.id}
          onChange={setSelected}
          options={templates.map((t) => ({ value: t.id, label: `${KIND_LABELS[t.kind] ?? t.name} (${t.tasks.length})` }))}
        />
      </div>
      <TemplatePanel template={template} />
    </div>
  )
}

function TemplatePanel({ template }: { template: ChecklistTemplate }) {
  const [editing, setEditing] = useState<TaskDraft | null>(null)
  const defaults = useMemo(() => DEFAULT_CHECKLIST_TEMPLATES.find((t) => t.id === template.id), [template.id])
  const changed = defaults ? JSON.stringify(defaults.tasks) !== JSON.stringify(template.tasks) : false
  const isNew = editing ? !template.tasks.some((t) => t.id === editing.id) : false
  const anchors = ANCHORS[template.kind] ?? [{ value: 'start' as const, label: 'Start date' }]
  const custom = template.tasks.filter((t) => isCustomTask(t.id)).length

  const save = (task: TemplateTask, label: string) =>
    commit(label, (d) => {
      const tpl = d.checklistTemplates.find((t) => t.id === template.id)
      if (!tpl) return
      const i = tpl.tasks.findIndex((t) => t.id === task.id)
      if (i >= 0) tpl.tasks[i] = task
      else tpl.tasks.push(task)
    })

  return (
    <Panel
      title={template.name}
      subtitle={`${template.tasks.length} tasks${custom ? `, ${custom} custom` : ''}. Conditional tasks are added only for the people they fit.`}
      icon="clipboard-check"
      actions={
        <>
          <Button
            icon="plus"
            onClick={() =>
              setEditing(
                toDraft({
                  id: `${CUSTOM_TASK_PREFIX}${newId('t')}`,
                  title: '',
                  ownerRole: 'admin',
                  due: { anchor: anchors[0].value, offset: 1, unit: 'business_days' },
                  category: 'culture',
                  statutory: false,
                }),
              )
            }
          >
            Add custom task
          </Button>
          {defaults && changed && (
            <ConfirmButton
              icon="rotate-ccw"
              confirmLabel="Press again to reset"
              onConfirm={() =>
                commit(`Reset ${template.name} to the defaults`, (d) => {
                  const i = d.checklistTemplates.findIndex((t) => t.id === template.id)
                  if (i >= 0) d.checklistTemplates[i] = structuredClone(defaults)
                })
              }
            >
              Reset to defaults
            </ConfirmButton>
          )}
        </>
      }
    >
      <RowList label={`${template.name} tasks`}>
        {template.tasks.map((t) => {
          const conds = describeCondition(t.when)
          return (
            <Row
              key={t.id}
              title={t.title}
              badges={
                <>
                  {t.statutory && (
                    <Badge tone="outline" icon="scale">
                      Legal deadline
                    </Badge>
                  )}
                  {isCustomTask(t.id) && <Badge tone="accent">Custom</Badge>}
                  {t.soc2Control && <Badge tone="outline">SOC 2 {t.soc2Control}</Badge>}
                </>
              }
              meta={
                <span className="flex flex-col gap-1.5">
                  <span>
                    {dueRuleText(t.due, template.kind)} · Owner: {OWNER_LABELS[t.ownerRole]} · {CATEGORY_LABELS[t.category]}
                  </span>
                  {t.why && <span className="text-ink-2">{t.why}</span>}
                  {(conds.length > 0 || t.citation) && (
                    <span className="flex flex-wrap items-center gap-2">
                      {conds.length > 0 && (
                        <span>
                          Only when: <span className="font-semibold text-ink-2">{conds.join('; ')}</span>
                        </span>
                      )}
                      {t.citation && <CitationChip label={t.citation.label} url={t.citation.url} />}
                    </span>
                  )}
                </span>
              }
              actions={
                <>
                  <Button icon="edit" onClick={() => setEditing(toDraft(t))} aria-label={`Edit task: ${t.title}`}>
                    Edit
                  </Button>
                  {isCustomTask(t.id) && (
                    <Button
                      variant="ghost"
                      icon="trash"
                      aria-label={`Remove task: ${t.title}`}
                      onClick={() =>
                        commit(`Removed the task "${t.title}"`, (d) => {
                          const tpl = d.checklistTemplates.find((x) => x.id === template.id)
                          if (tpl) tpl.tasks = tpl.tasks.filter((x) => x.id !== t.id)
                        })
                      }
                    >
                      Remove
                    </Button>
                  )}
                </>
              }
            />
          )
        })}
      </RowList>
      <p className="mt-3 text-[13px] text-ink-3">
        Edits apply to checklists started from now on; running checklists keep their tasks. Built-in tasks can be reworded or
        rescheduled but not removed, because some are legal deadlines. Not legal advice; confirm with counsel or your PEO.
      </p>
      {editing && (
        <EditSheet<TaskDraft>
          key={editing.id}
          open
          title={isNew ? 'Add a custom task' : 'Edit task'}
          subtitle={template.name}
          initial={editing}
          onClose={() => setEditing(null)}
          saveLabel={isNew ? 'Add task' : 'Save task'}
          validate={(d) => (!d.title.trim() ? 'Give the task a title.' : d.due.offset == null ? 'Set when it is due.' : null)}
          onSave={(d) => save(fromDraft(d), isNew ? `Added the task "${d.title.trim()}"` : `Updated the task "${d.title.trim()}"`)}
        >
          {(d, set) => (
            <>
              <Field label="Title" required>
                {(id) => <TextInput id={id} value={d.title} onChange={(e) => set({ title: e.target.value })} />}
              </Field>
              <Field label="Why it matters" hint={hintWithCount('One plain sentence. Shows on the task.', d.why, SHORT_TEXT_MAX_CHARS)}>
                {(id, hint) => (
                  <TextArea
                    id={id}
                    aria-describedby={hint}
                    rows={3}
                    maxLength={SHORT_TEXT_MAX_CHARS}
                    value={d.why ?? ''}
                    onChange={(e) => set({ why: e.target.value })}
                  />
                )}
              </Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-[13.5px] font-semibold text-ink-2">Owner</span>
                <ChipGroup
                  label="Owner"
                 
                  value={d.ownerRole}
                  onChange={(v) => set({ ownerRole: v })}
                  options={(Object.keys(OWNER_LABELS) as OwnerRole[]).map((o) => ({ value: o, label: OWNER_LABELS[o] }))}
                />
              </div>
              <fieldset className="flex flex-col gap-3 rounded-xl border border-line p-3">
                <legend className="px-1 text-[13.5px] font-semibold text-ink-2">Due</legend>
                <FormGrid>
                  <Field label="How many">
                    {(id) => (
                      <NumberInput
                        id={id}
                        min={0}
                        step="1"
                        value={d.due.offset}
                        onChange={(v) => set({ due: { ...d.due, offset: v } })}
                      />
                    )}
                  </Field>
                  <Field label="Unit">
                    {(id) => (
                      <Select
                        id={id}
                        value={d.due.unit}
                        onChange={(v) => set({ due: { ...d.due, unit: v } })}
                        options={[
                          { value: 'business_days', label: 'Business days' },
                          { value: 'days', label: 'Calendar days' },
                          { value: 'months', label: 'Months' },
                        ]}
                      />
                    )}
                  </Field>
                </FormGrid>
                <Segmented
                  label="Before or after"
                  value={d.before ? 'before' : 'after'}
                  onChange={(v) => set({ before: v === 'before' })}
                  options={[
                    { value: 'before', label: 'Before' },
                    { value: 'after', label: 'After' },
                  ]}
                />
                <Field label="Counted from">
                  {(id) => (
                    <Select id={id} value={d.due.anchor} onChange={(v) => set({ due: { ...d.due, anchor: v } })} options={anchors} />
                  )}
                </Field>
                <p className="text-[13.5px] text-ink-2">
                  Reads as: <span className="font-semibold">{dueRuleText(fromDraft(d).due, template.kind)}</span>. Weekends and holidays
                  move legal deadlines to the business day before.
                </p>
              </fieldset>
              {isNew || isCustomTask(d.id) ? (
                <>
                  <Field label="Category">
                    {(id) => (
                      <Select
                        id={id}
                        value={d.category}
                        onChange={(v) => set({ category: v })}
                        options={(Object.keys(CATEGORY_LABELS) as TaskCategory[]).map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
                      />
                    )}
                  </Field>
                  <Field label="Link (optional)" hint="Where the form or tool lives.">
                    {(id, hint) => (
                      <TextInput id={id} aria-describedby={hint} inputMode="url" placeholder="https://" value={d.link ?? ''} onChange={(e) => set({ link: e.target.value || undefined })} />
                    )}
                  </Field>
                  <Switch
                    label="Legal deadline"
                    description="Shows red when overdue and cannot be snoozed past its due date. Use only for real statutory deadlines."
                    checked={d.statutory}
                    onChange={(v) => set({ statutory: v })}
                  />
                </>
              ) : (
                <p className="text-[13px] text-ink-3">
                  Conditions, citation and legal-deadline status stay as built so the California rules keep working.
                  {d.statutory ? ' This is a legal deadline: moving it later than the law allows is on you.' : ''}
                </p>
              )}
            </>
          )}
        </EditSheet>
      )}
    </Panel>
  )
}
