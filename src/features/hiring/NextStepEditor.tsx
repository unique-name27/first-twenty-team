// Next step editor: every active candidate has a next step, a due date and an owner. Chips for the
// common steps and dates, a picker for the owner; typing is optional.
import { useState } from 'react'
import { candidateName, ownerFor, setNextStep } from '@/domain/hiring'
import type { Application, Job } from '@/domain/types'
import { addBusinessDays, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Button, ChipGroup, DateChips, Field, focusFirstInvalid, Select, TextInput } from '@/ui'
import { commit } from './actions'
import { teamOptions } from './logic'

const COMMON_STEPS = ['Review application', 'Send scheduling message', 'Schedule intro call', 'Debrief and decide', 'Follow up', 'Send offer', 'Check references']

export function NextStepEditor({ app, job, onDone, autoFocus }: { app: Application; job: Job; onDone?: () => void; autoFocus?: boolean }) {
  const db = useDB((s) => s.db)
  const t = today()
  const holidays = db.holidays.map((h) => h.date)
  const [text, setText] = useState(app.nextStep?.text ?? 'Follow up')
  const [dueOn, setDueOn] = useState(app.nextStep?.dueOn ?? addBusinessDays(t, 2, holidays))
  const [ownerId, setOwnerId] = useState(app.nextStep?.ownerId ?? ownerFor(db, job, t))
  const owners = teamOptions(db, t)
  const name = candidateName(db, app.candidateId)
  const idBase = `ns-${app.id}`
  const valid = text.trim().length > 0 && !!dueOn && !!ownerId
  const [tried, setTried] = useState(false)

  const save = () => {
    if (!valid) {
      setTried(true)
      focusFirstInvalid()
      return
    }
    const ok = commit(`Set the next step for ${name}`, (d) => setNextStep(d, app.id, { text: text.trim(), dueOn, ownerId }))
    if (ok) onDone?.()
  }

  const presets = [
    { label: 'Tomorrow', date: addBusinessDays(t, 1, holidays) },
    { label: '+2 business days', date: addBusinessDays(t, 2, holidays) },
    { label: '+3 business days', date: addBusinessDays(t, 3, holidays) },
    { label: '+1 week', date: addBusinessDays(t, 5, holidays) },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="mb-2 text-[13.5px] font-semibold text-ink-2">Step</p>
        <ChipGroup<string>
          size="sm"
          label="Common next steps"
          value={COMMON_STEPS.includes(text) ? text : null}
          onChange={setText}
          options={COMMON_STEPS.map((s) => ({ value: s, label: s }))}
        />
      </div>
      <Field label="Or type it" id={`${idBase}-text`} error={tried && !text.trim() ? 'Pick a step above or type one.' : undefined}>
        {(id, hint) => <TextInput id={id} aria-describedby={hint} autoFocus={autoFocus} value={text} onChange={(e) => setText(e.target.value)} maxLength={140} />}
      </Field>
      <div>
        <p className="mb-2 text-[13.5px] font-semibold text-ink-2">Due</p>
        <DateChips label="Next step due date" value={dueOn} onChange={setDueOn} presets={presets} min={t} id={`${idBase}-due`} />
      </div>
      <Field label="Owner" id={`${idBase}-owner`} error={tried && !ownerId ? 'Pick who owns the next step.' : undefined}>
        {(id, hint) => <Select id={id} aria-describedby={hint} value={ownerId} onChange={setOwnerId} options={owners} placeholder={ownerId ? undefined : 'Pick an owner'} />}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={save}>
          Save next step
        </Button>
        {onDone && app.nextStep && (
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}
