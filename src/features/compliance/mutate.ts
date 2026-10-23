// One place for compliance writes: run the recipe through the store, then show a toast that names
// the change with Undo. If the recipe changed nothing, no Undo is offered (Undo would otherwise
// reverse an unrelated earlier change).
import type { Draft } from 'immer'
import type { DB } from '@/domain/types'
import { useDB } from '@/store/db'
import { toast } from '@/ui'

export function commit(label: string, recipe: (draft: Draft<DB>) => void, opts: { quiet?: boolean; noChange?: string } = {}): boolean {
  const before = useDB.getState().db
  useDB.getState().mutate(label, recipe)
  if (useDB.getState().db === before) {
    if (opts.noChange) toast({ text: opts.noChange, tone: 'neutral' })
    return false
  }
  if (!opts.quiet) toast({ text: label, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
  return true
}
