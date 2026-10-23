// Edit sheets that stay open across a sync pull: the sheet keeps the record as it was when it opened,
// saves only the fields the user changed, and asks before overwriting a field another computer changed
// in the meantime ('Use theirs' or 'Keep mine'). Used by job Edit, candidate Edit details and the offer
// builder. The pure comparisons live in logic.ts (changedFields, conflictingFields).
import { useState } from 'react'
import { Button, Callout } from '@/ui'
import { changedFields, conflictingFields } from './logic'

function pick<T extends object>(from: T, keys: Array<keyof T>): Partial<T> {
  const out: Partial<T> = {}
  for (const k of keys) out[k] = from[k]
  return out
}

/**
 * State for a sheet that edits `current` (the stored record, as a form value, re-read on every render).
 * `base` is the record when the sheet opened; `changed(draft)` lists what the user changed and
 * `conflicts(draft)` what also changed in the store since. `takeTheirs` adopts the stored values (they
 * stop counting as changed); `keepMine` keeps the user's values for the stored values seen now (a later
 * change on another computer asks again).
 */
export function useEditConflicts<T extends object>(current: T) {
  const [base, setBase] = useState<T>(current)
  const [kept, setKept] = useState<Partial<Record<keyof T, string>>>({})
  const changed = (draft: T) => changedFields(base, draft)
  const conflicts = (draft: T) => conflictingFields(base, draft, current).filter((k) => kept[k] !== JSON.stringify(current[k]))
  const takeTheirs = (keys: Array<keyof T>, setDraft: (fn: (d: T) => T) => void) => {
    const theirs = pick(current, keys)
    setDraft((d) => ({ ...d, ...theirs }))
    setBase((b) => ({ ...b, ...theirs }))
  }
  const keepMine = (keys: Array<keyof T>) => setKept((m) => ({ ...m, ...Object.fromEntries(keys.map((k) => [k, JSON.stringify(current[k])])) }))
  return { base, changed, conflicts, takeTheirs, keepMine }
}

/**
 * 'This job changed on another computer while you were editing' with 'The title is now X. Pick which
 * version to keep before you save.', Use theirs and Keep mine. `lines` describes each conflicting field
 * in plain words, mid-sentence ('the title is now X'); they are joined with semicolons and the sentence
 * gets its capital here.
 */
export function EditConflictCallout({ what, lines, onTheirs, onMine }: { what: string; lines: string[]; onTheirs: () => void; onMine: () => void }) {
  if (lines.length === 0) return null
  const sentence = lines.join('; ')
  return (
    <div role="alert" data-edit-conflict>
      <Callout tone="warn" title={`This ${what} changed on another computer while you were editing`}>
        <span className="block">
          {sentence.charAt(0).toUpperCase() + sentence.slice(1)}. Pick which version to keep before you save.
        </span>
        <span className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" onClick={onTheirs}>
            Use theirs
          </Button>
          <Button size="sm" onClick={onMine}>
            Keep mine
          </Button>
        </span>
      </Callout>
    </div>
  )
}

/** Moves focus to the conflict callout's first button (after a Save that was stopped by a conflict). */
export function focusEditConflict(): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-edit-conflict] button')?.focus())
}
