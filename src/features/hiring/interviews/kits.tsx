// Hiring > Interview kits: the 13 role templates with stages, interview steps, scorecard attributes
// with one-line anchors and suggested questions. Print a kit per interviewer, or start a job from it.
import { useState } from 'react'
import { links, useRoute } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { bandFor } from '@/domain/hiring/offers'
import { roleTemplates } from '@/domain/hiring/jobs'
import { familyName, levelLabel } from '@/domain/people'
import type { RoleTemplate } from '@/domain/types'
import { escapeHTML, printHTML } from '@/lib/files'
import { useDB } from '@/store/db'
import { Badge, Button, cx, EmptyState, Icon, MoneyRange, Panel, Select, toast } from '@/ui'
import { copyWithToast } from './common'
import { canSeeKitBand } from './logic'

function kitText(t: RoleTemplate, stageName: (id: string) => string): string {
  const lines: string[] = [`Interview kit: ${t.name}`, '']
  for (const s of t.interviewPlan) {
    lines.push(`${stageName(s.stageId)}: ${s.name} (${s.durationMin} min)`)
    for (const a of s.attributes) {
      lines.push(`  ${a.name}${a.anchor ? `. Strong yes: ${a.anchor}` : ''}`)
      for (const q of a.questions ?? []) lines.push(`    - ${q}`)
    }
    lines.push('')
  }
  lines.push('Score each attribute Strong no, No, Yes or Strong yes (no neutral). Submit within 24 hours. Never ask about current or past pay.')
  return lines.join('\n')
}

function kitHTML(t: RoleTemplate, stageName: (id: string) => string): string {
  const parts = [`<h1>Interview kit: ${escapeHTML(t.name)}</h1>`]
  for (const s of t.interviewPlan) {
    parts.push(`<h2>${escapeHTML(stageName(s.stageId))}: ${escapeHTML(s.name)} (${s.durationMin} min)</h2>`)
    parts.push('<table><tr><th>Attribute</th><th>Strong yes looks like</th><th>Suggested questions</th><th>Rating</th></tr>')
    for (const a of s.attributes) {
      parts.push(
        `<tr><td>${escapeHTML(a.name)}</td><td>${escapeHTML(a.anchor ?? '')}</td><td>${(a.questions ?? []).map((q) => escapeHTML(q)).join('<br>')}</td><td>Strong no / No / Yes / Strong yes</td></tr>`,
      )
    }
    parts.push('</table>')
  }
  parts.push('<p class="muted">Submit your scorecard within 24 hours. Never ask about current or past pay (Labor Code 432.3) or criminal history before a conditional offer (Gov Code 12952).</p>')
  return parts.join('\n')
}

/** Interview kits (role templates) browser for Hiring > Interview kits. */
export function InterviewKitsTab() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const route = useRoute()
  const templates = roleTemplates(db)
  const fromRoute = route.segments[0] === 'hiring' && route.segments[1] === 'kits' ? route.segments[2] : undefined
  const [selected, setSelected] = useState<string>(templates.find((t) => t.id === fromRoute)?.id ?? templates[0]?.id ?? '')
  const t = templates.find((x) => x.id === selected) ?? templates[0]
  if (!t) return <EmptyState icon="clipboard" title="No interview kits yet" body="Role templates live in Settings > Hiring." />

  const stageName = (id: string) => t.stages.find((s) => s.id === id)?.name ?? id
  const band = bandFor(db, t.familyId, t.levelId)
  const showBand = canSeeKitBand(viewer, db, t.familyId, t.levelId)
  const print = () => {
    if (!printHTML(`Interview kit: ${t.name}`, kitHTML(t, stageName))) {
      toast({ text: 'Printing is blocked here. Use Copy kit instead.', tone: 'bad' })
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
      <div className="md:hidden">
        <Select aria-label="Interview kit" value={t.id} onChange={setSelected} options={templates.map((x) => ({ value: x.id, label: x.name }))} />
      </div>
      <nav aria-label="Interview kits" className="hidden md:block">
        <ul className="ft-navlist flex flex-col gap-1">
          {templates.map((x) => (
            <li key={x.id}>
              <button
                type="button"
                aria-pressed={x.id === t.id}
                onClick={() => setSelected(x.id)}
                className={cx(
                  'ft-navlist__item',
                  x.id === t.id && 'ft-navlist__item--on',
                  'flex min-h-11 w-full items-center rounded-lg px-3 text-left text-[14px] font-semibold transition-colors',
                  x.id === t.id ? 'bg-accent-soft text-accent-soft-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                )}
              >
                {x.name}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <Panel
        title={t.name}
        subtitle={`${familyName(db, t.familyId)}, ${levelLabel(db, t.levelId)}`}
        actions={
          <>
            <Button variant="ghost" size="sm" icon="copy" onClick={() => void copyWithToast(kitText(t, stageName), `the ${t.name} kit`)}>
              Copy kit
            </Button>
            <Button variant="ghost" size="sm" icon="printer" onClick={print}>
              Print kit
            </Button>
            {viewer.role === 'admin' && (
              <a
                href={links.newJob()}
                className="ft-btn ft-btn--primary ft-btn--sm inline-flex h-10 items-center gap-1.5 rounded-lg bg-accent px-3 text-[13.5px] font-semibold text-accent-ink hover:bg-accent-hover"
              >
                Start a job from this kit
              </a>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13.5px] text-ink-2">
            {band &&
              (showBand ? (
                <span>
                  Band: <MoneyRange min={band.min} max={band.max} className="font-semibold text-ink" />
                </span>
              ) : (
                <span className="text-ink-3">Band visible to Admin</span>
              ))}
            <span>
              Stages: {t.stages.map((s) => `${s.name}${s.slaBusinessDays ? ` (${s.slaBusinessDays} days)` : ''}`).join(', ')}
            </span>
          </div>
          <ol className="flex flex-col gap-4">
            {t.interviewPlan.map((s, i) => (
              <li key={s.id} className="rounded-xl border border-line p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="ft-count num inline-flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-[12.5px] font-bold text-ink-2">{i + 1}</span>
                  <h3 className="text-[15px] font-bold text-ink">{s.name}</h3>
                  <Badge tone="outline">{stageName(s.stageId)}</Badge>
                  <span className="text-[13px] text-ink-3">{s.durationMin} min</span>
                </div>
                <ul className="mt-3 flex flex-col gap-3">
                  {s.attributes.map((a) => (
                    <li key={a.name} className="border-l-2 border-line pl-3">
                      <p className="text-[14px] font-bold text-ink">{a.name}</p>
                      {a.anchor && <p className="text-[13.5px] text-ink-2">Strong yes: {a.anchor}</p>}
                      {(a.questions ?? []).length > 0 && (
                        <ul className="mt-1 list-disc pl-5 text-[13.5px] text-ink-2">
                          {(a.questions ?? []).map((q) => (
                            <li key={q}>{q}</li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          <details className="group rounded-xl bg-surface-2 px-4 py-3">
            <summary className="flex min-h-10 w-fit cursor-pointer items-center gap-1.5 text-[14px] font-semibold text-ink">
              <Icon name="chevron-right" size={16} className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
              Job description outline
            </summary>
            <p className="mt-2 text-[13.5px] whitespace-pre-wrap text-ink-2">{t.jdOutline}</p>
          </details>
        </div>
      </Panel>
    </div>
  )
}
