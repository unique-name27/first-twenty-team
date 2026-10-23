// The app's one assistant store (./store), wired to the server calls in @/sync, this tab's sessionStorage
// and the sync status's login and workspace, plus the hooks the sheet and the header use.
import { useStore } from 'zustand'
import { assistantDisplayName } from '@/domain/assistant'
import { useDB } from '@/store/db'
import { assistantChat, assistantInfo, assistantWorkspaceKey, useSyncStatus } from '@/sync'
import type { SessionLike } from './logic'
import { type AssistantState, createAssistantStore } from './store'

function sessionStore(): SessionLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export const assistant = createAssistantStore({
  info: assistantInfo,
  chat: assistantChat,
  storage: sessionStore,
  name: () => assistantDisplayName(useDB.getState().db.company),
  workspace: assistantWorkspaceKey,
})

// The conversation belongs to the signed-in login and the server workspace it was about: a sign-out,
// another login, or a workspace replaced under it (Start fresh, Import, Use the server's copy of another
// history, another computer's replace) drops it from this tab. The sync engine publishes its status after
// each of those, so both are checked then.
assistant.actions.setUser(useSyncStatus.getState().user?.id ?? null)
useSyncStatus.subscribe((s) => {
  assistant.actions.setUser(s.user?.id ?? null)
  assistant.actions.checkWorkspace()
})

export function useAssistant<T>(selector: (s: AssistantState) => T): T {
  return useStore(assistant, selector)
}

/** Opens the Ask sheet from anywhere; a prefill (a search typed in Ctrl K) becomes the question being typed. */
export function openAssistant(prefill?: string): void {
  assistant.actions.openSheet(prefill)
}

/** What the company calls its assistant ('Lark', or '<company> Bot'). */
export function useAssistantName(): string {
  return useDB((s) => assistantDisplayName(s.db.company))
}
