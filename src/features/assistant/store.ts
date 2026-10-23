// The Ask sheet's state: whether it is open, the question being typed, this tab's conversation (memory plus
// sessionStorage, never synced), the answer being streamed, and what the server said about the assistant.
// createAssistantStore takes the server calls and the storage as arguments, so tests drive it with fakes;
// the app's one instance (./instance.ts) uses the real ones from @/sync.
//
// The history is the server's: each 'done' replaces it with the conversation the server ran, and it goes
// back with the next question exactly as it came. Nothing here edits, trims or reorders it (the Claude API
// refuses a conversation whose earlier turns changed). A question that did not get its answer is shown on
// its own (pending) and is not part of the history.
//
// The conversation belongs to one login and one server workspace history: another login, a sign-out, or a
// workspace replaced under it (Start fresh, Import, another computer's replace) drops it, so its answers
// and the records they quote never carry over to another company's questions.
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { AssistantFailure, AssistantInfo, AssistantResult, ChatDone, ChatHandlers, ChatInput } from '@/sync'
import {
  clearConversation,
  conversationFullText,
  CUT_OFF_TEXT,
  failureText,
  historyFits,
  type InfoState,
  lastAnswer,
  loadConversation,
  messageProblem,
  saveConversation,
  type SessionLike,
} from './logic'

/** A question on its way, or one that did not get its answer. */
export type Pending = {
  message: string
  /** The answer so far (streamed): the parts joined, a new paragraph after each lookup. */
  text: string
  /** The answer so far as received: one part per stretch of text between lookups. */
  parts: string[]
  /** What the assistant is doing right now ('Looking up people'), while no new text comes. */
  status: string | null
  phase: 'sending' | 'failed' | 'stopped'
  failure: AssistantFailure | null
}

/**
 * What the live region says: a finished answer (Markdown, made plain by the sheet) or a notice, and for an
 * answer, what changed with it (cut off, the conversation full, no questions left). The id changes with
 * each one, so the same words twice are still spoken twice.
 */
export type Announcement = { id: number; kind: 'answer' | 'notice'; text: string; note?: string }

export type AssistantState = {
  open: boolean
  draft: string
  /** The login this conversation belongs to (the sync status's user). */
  userId: string | null
  /** The server workspace and history this conversation is about (assistantWorkspaceKey), null until known. */
  workspace: string | null
  history: unknown[]
  /** The newest answer stopped at the server's length limit before it was finished. */
  cutOff: boolean
  /** Questions left today, as the server last said (null until it has). */
  remainingToday: number | null
  pending: Pending | null
  info: InfoState
  announcement: Announcement
}

export type AssistantDeps = {
  info: () => Promise<AssistantResult<AssistantInfo>>
  chat: (input: ChatInput, handlers?: ChatHandlers) => Promise<ChatDone | AssistantFailure>
  /** This tab's sessionStorage (null when the browser blocks it). */
  storage: () => SessionLike | null
  /** The assistant's name, for the words of a notice. */
  name: () => string
  /** The server workspace and history this tab is connected to now (sync's assistantWorkspaceKey); null: unknown. */
  workspace?: () => string | null
}

export type AssistantActions = {
  /** Opens the sheet; a prefill (a search typed in Ctrl K) becomes the question being typed. */
  openSheet(prefill?: string): void
  closeSheet(): void
  setDraft(text: string): void
  /**
   * The sync status's user changed. Another login (or none, after a sign-out) never sees this tab's
   * conversation: it is dropped from memory and from sessionStorage, and the new login's is loaded.
   */
  setUser(userId: string | null): void
  /**
   * Checks the conversation is still about the workspace this tab is connected to. When the workspace was
   * replaced (a new history) the conversation goes, its answer included; the question being typed stays.
   */
  checkWorkspace(): void
  loadInfo(): Promise<void>
  /** Sends the question being typed (or `text`, from a suggestion chip). */
  send(text?: string): Promise<void>
  /** Stops the answer being streamed (the server stops the model too). */
  stop(): void
  /** Sends a question that did not get its answer again, on the same conversation. */
  retry(): Promise<void>
  /** Starts over: the conversation goes, and a question without its answer comes back into the box. */
  newConversation(): void
}

export type AssistantStore = StoreApi<AssistantState> & { actions: AssistantActions }

const IDLE_INFO: InfoState = { phase: 'idle', data: null, failure: null }

/** The parts as one text: a blank line between them (none after a part that ends a line), and after the last when a lookup started. */
export function joinParts(parts: readonly string[]): string {
  let out = ''
  for (const p of parts) {
    if (out !== '' && !out.endsWith('\n')) out += '\n\n'
    out += p
  }
  return out
}

/**
 * The parts without the last `chars` characters of text: back to where the turn being asked again began.
 * A lookup the dropped turn started (a trailing empty part) goes with it; the part its text began in stays,
 * emptied, since a lookup of the turn before started it (the new turn's text goes there).
 */
function dropChars(parts: readonly string[], chars: number): string[] {
  const out = [...parts]
  while (out.length > 1 && out[out.length - 1] === '') out.pop()
  let left = chars
  while (left > 0 && out.length > 0) {
    const last = out[out.length - 1]
    if (last.length < left) {
      left -= last.length
      out.pop()
    } else {
      out[out.length - 1] = last.slice(0, last.length - left)
      left = 0
    }
  }
  return out
}

export function createAssistantStore(deps: AssistantDeps): AssistantStore {
  const store = createStore<AssistantState>()(() => ({
    open: false,
    draft: '',
    userId: null,
    workspace: null,
    history: [],
    cutOff: false,
    remainingToday: null,
    pending: null,
    info: IDLE_INFO,
    announcement: { id: 0, kind: 'notice', text: '' },
  }))
  const set = store.setState
  const get = store.getState
  const currentWorkspace = () => deps.workspace?.() ?? null
  /** The running answer's controller; a newer action replaces it, and the old answer's result is ignored. */
  let running: AbortController | null = null
  let infoAsking: Promise<void> | null = null

  const announce = (kind: Announcement['kind'], text: string, note?: string) =>
    set((s) => ({ announcement: note ? { id: s.announcement.id + 1, kind, text, note } : { id: s.announcement.id + 1, kind, text } }))

  const save = () => {
    const s = get()
    if (!s.userId) return
    if (s.history.length === 0) clearConversation(deps.storage())
    else saveConversation(deps.storage(), { v: 1, userId: s.userId, workspace: s.workspace, history: s.history, remainingToday: s.remainingToday })
  }

  const patchPending = (controller: AbortController, patch: (p: Pending) => Partial<Pending>) => {
    if (running !== controller) return
    set((s) => {
      if (!s.pending || s.pending.phase !== 'sending') return {}
      const next = { ...s.pending, ...patch(s.pending) }
      return { pending: { ...next, text: joinParts(next.parts) } }
    })
  }

  /** The question goes back into the box (unless something else is being typed there now). */
  const restoreDraft = (message: string) => set((s) => ({ draft: s.draft.trim() ? s.draft : message }))

  /** The conversation goes (another workspace now): no answer of it is kept, and nothing comes back into the box. */
  const dropConversation = (workspace: string | null) => {
    running?.abort()
    running = null
    set({ history: [], pending: null, cutOff: false, workspace })
    clearConversation(deps.storage())
  }

  const checkWorkspace = () => {
    const now = currentWorkspace()
    const s = get()
    if (!now || now === s.workspace) return
    if (s.workspace !== null) dropConversation(now)
    else {
      // Not known when it was saved: it is about the workspace connected now.
      set({ workspace: now })
      if (s.history.length > 0) save()
    }
  }

  async function send(text?: string): Promise<void> {
    checkWorkspace()
    const s = get()
    const message = (text ?? s.draft).trim()
    if (messageProblem(message) || s.pending?.phase === 'sending' || !s.userId) return
    if (!historyFits(s.history) || s.remainingToday === 0) return
    running?.abort()
    const controller = new AbortController()
    running = controller
    const userId = s.userId
    set({ pending: { message, text: '', parts: [], status: null, phase: 'sending', failure: null }, draft: text === undefined ? '' : s.draft, cutOff: false })
    const r = await deps.chat(
      { history: s.history, message, signal: controller.signal },
      {
        // New text ends the status line; a status after some text starts a new paragraph for what follows.
        onDelta: (t) =>
          patchPending(controller, (p) => ({ parts: p.parts.length === 0 ? [t] : [...p.parts.slice(0, -1), p.parts[p.parts.length - 1] + t], status: null })),
        onStatus: (label) => patchPending(controller, (p) => ({ status: label, parts: p.parts.length > 0 && p.parts[p.parts.length - 1] !== '' ? [...p.parts, ''] : p.parts })),
        // A turn the server asks again: its text so far goes (it comes again).
        onDiscard: (chars) => patchPending(controller, (p) => ({ parts: dropChars(p.parts, chars), status: null })),
      },
    )
    // A newer action (New conversation, another login, another question) took over: this answer is moot.
    if (running !== controller || get().userId !== userId) return
    running = null
    const name = deps.name()
    if (r.ok) {
      set((st) => ({
        history: r.history,
        cutOff: r.truncated,
        remainingToday: r.remainingToday ?? (st.remainingToday === null ? null : Math.max(0, st.remainingToday - 1)),
        pending: null,
        workspace: st.workspace ?? currentWorkspace(),
      }))
      save()
      // What changed with the answer is said with it: the box may have just closed for this conversation or today.
      const after = get()
      const notes = [
        r.truncated ? CUT_OFF_TEXT : '',
        !historyFits(after.history) ? conversationFullText(name) : '',
        after.remainingToday === 0 ? failureText({ kind: 'quota' }, name) : '',
      ].filter(Boolean)
      announce('answer', lastAnswer(r.history), notes.join(' ') || undefined)
      return
    }
    // An answer that failed may still have used one of today's questions: the server says how many are left.
    if (r.remainingToday !== undefined) set({ remainingToday: r.remainingToday })
    switch (r.kind) {
      case 'aborted':
        set((st) => ({ pending: st.pending ? { ...st.pending, phase: 'stopped', status: null, failure: r } : null }))
        announce('notice', 'Stopped.')
        // The server counted the question if its request had gone out: ask how many are left now.
        void actions.loadInfo()
        return
      case 'signed_out':
      case 'off':
      case 'not_found':
        // Not about this question: the sheet shows the state (sign in, the server has it off) instead.
        set((st) => ({ pending: null, info: { phase: 'failed', data: r.kind === 'signed_out' ? st.info.data : null, failure: r } }))
        restoreDraft(message)
        announce('notice', failureText(r, name))
        return
      case 'quota':
        set({ pending: null, remainingToday: 0 })
        restoreDraft(message)
        save()
        announce('notice', failureText(r, name))
        return
      default: {
        // A refusal or a cut-off tool call: the partial text is not an answer, so it does not stay on screen.
        const discard = r.discardPartial === true || (r.kind === 'model' && (r.error === 'refused' || r.error === 'truncated'))
        set((st) => ({
          pending: st.pending ? { ...st.pending, phase: 'failed', status: null, failure: r, ...(discard ? { text: '', parts: [] } : {}) } : null,
        }))
        announce('notice', failureText(r, name))
      }
    }
  }

  const actions: AssistantActions = {
    openSheet: (prefill) => {
      checkWorkspace()
      set((s) => ({ open: true, draft: prefill?.trim() ? prefill.trim() : s.draft }))
    },
    closeSheet: () => set({ open: false }),
    setDraft: (text) => set({ draft: text }),
    setUser: (userId) => {
      const s = get()
      if (userId === s.userId) return
      running?.abort()
      running = null
      infoAsking = null
      // The login this tab knew signed out or changed: its conversation leaves this tab.
      if (s.userId !== null) clearConversation(deps.storage())
      const saved = userId ? loadConversation(deps.storage(), userId) : null
      set({
        userId,
        workspace: saved?.workspace ?? null,
        history: saved?.history ?? [],
        cutOff: false,
        remainingToday: saved?.remainingToday ?? null,
        pending: null,
        info: IDLE_INFO,
        draft: s.userId !== null ? '' : s.draft,
      })
      checkWorkspace()
    },
    checkWorkspace,
    loadInfo: () => {
      if (infoAsking) return infoAsking
      const userId = get().userId
      set((s) => ({ info: { ...s.info, phase: 'loading' } }))
      const p = deps.info().then((r) => {
        if (infoAsking !== p) return
        infoAsking = null
        if (get().userId !== userId) return
        if (r.ok) set({ info: { phase: 'ready', data: r.data, failure: null }, remainingToday: r.data.remainingToday })
        else set((s) => ({ info: { phase: 'failed', data: r.kind === 'signed_out' || r.kind === 'not_found' ? null : s.info.data, failure: r } }))
      })
      infoAsking = p
      return p
    },
    send,
    stop: () => running?.abort(),
    retry: async () => {
      const p = get().pending
      if (!p || p.phase === 'sending') return
      set({ pending: null })
      await send(p.message)
    },
    newConversation: () => {
      const s = get()
      running?.abort()
      running = null
      if (s.pending) restoreDraft(s.pending.message)
      set({ history: [], pending: null, cutOff: false })
      save()
      announce('notice', 'New conversation started.')
    },
  }

  return Object.assign(store, { actions })
}
