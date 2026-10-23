// The current viewer: role from "Viewing as" plus the person they are viewing as.
// Admin defaults to the founder; manager/employee views need a person and fall back to one that fits.
import { useMemo } from 'react'
import { viewerPerson } from '@/domain/people'
import type { DB, Role, Viewer } from '@/domain/types'
import { useDB } from '@/store/db'
import { usePrefs } from '@/store/prefs'

export type { Viewer }

export function resolveViewer(db: DB, role: Role, personId: string | null): Viewer {
  const person = viewerPerson(db, role, personId)
  return { role, person, personId: person?.id ?? null }
}

export function useViewer(): Viewer {
  const db = useDB((s) => s.db)
  const viewAs = usePrefs((s) => s.viewAs)
  return useMemo(() => resolveViewer(db, viewAs.role, viewAs.personId), [db, viewAs.role, viewAs.personId])
}
