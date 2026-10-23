// Pure logic behind the Ask sheet (the in-app assistant, docs/SERVER.md "Lark, the assistant"): the
// conversation as turns to show, what the sheet can do right now, suggestion chips fitted to the company,
// the per-tab copy of the conversation, the words for each failure, and renaming the assistant.
import type { Draft } from 'immer'
import { defaultAssistantName, normalizeAssistantName, questionTexts } from '@/domain/assistant'
import { employedOn, incomingOn } from '@/domain/people'
import type { Company, DB } from '@/domain/types'
import { addDays, type ISODate, today } from '@/lib/dates'
import { plural } from '@/lib/format'
import { logActivity } from '@/store/db'
import type { AssistantFailure, AssistantInfo, SyncStatus } from '@/sync'

/** Longest question the server takes (POST /api/assistant/chat refuses longer ones). */
export const MAX_MESSAGE_LENGTH = 2000
/** The longest conversation the server takes back (it answers 400 bad_history past either limit). */
export const MAX_HISTORY_MESSAGES = 40
export const MAX_HISTORY_BYTES = 150 * 1024
/** The public demo server: the place to try the assistant from a copy with no server. */
export const LIVE_DEMO_URL = 'https://hr-77-112-161-54.sslip.io/'
/** Its demo sign-up form (Settings > Server > Create a demo company). */
export const LIVE_DEMO_SIGNUP_URL = `${LIVE_DEMO_URL}#settings.server.signup`

// ---------------------------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------------------------

export type Turn = { role: 'user' | 'assistant'; text: string }

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** The text blocks of a message's content (a plain string counts as one). */
function textOf(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((b) => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
}

/**
 * The conversation as the sheet shows it: each question, then everything the assistant wrote until the
 * next one (tool calls, tool results, thinking and fallback markers are the server's business and are
 * not shown, nor is the context note the server puts before a question). The history itself is never
 * changed: it goes back to the server exactly as it came.
 */
export function turnsFromHistory(history: readonly unknown[]): Turn[] {
  const turns: Turn[] = []
  for (const m of history) {
    if (!isObj(m)) continue
    if (m.role === 'user') {
      // A user message that only carries tool results belongs to the assistant's turn.
      const isQuestion = typeof m.content === 'string' || (Array.isArray(m.content) && m.content.some((b) => isObj(b) && b.type === 'text'))
      if (isQuestion) turns.push({ role: 'user', text: questionTexts(textOf(m.content)).join('\n\n') })
    } else if (m.role === 'assistant') {
      const text = textOf(m.content)
        .map((t) => t.trim())
        .filter(Boolean)
        .join('\n\n')
      const last = turns[turns.length - 1]
      if (last?.role === 'assistant') last.text = [last.text, text].filter(Boolean).join('\n\n')
      else turns.push({ role: 'assistant', text })
    }
  }
  return turns
}

/** The answer to the newest question (for the announcement when it finishes). */
export function lastAnswer(history: readonly unknown[]): string {
  const turns = turnsFromHistory(history)
  const last = turns[turns.length - 1]
  return last?.role === 'assistant' ? last.text : ''
}

/** Whether the server takes this conversation back with another question (see the limits above). */
export function historyFits(history: readonly unknown[]): boolean {
  if (history.length > MAX_HISTORY_MESSAGES) return false
  try {
    return new TextEncoder().encode(JSON.stringify(history)).length <= MAX_HISTORY_BYTES
  } catch {
    return false
  }
}

/** The problem with a question as typed, or null when it can be sent. */
export function messageProblem(text: string): string | null {
  if (!text.trim()) return 'Type a question first.'
  if (text.length > MAX_MESSAGE_LENGTH) return `Shorten it to ${MAX_MESSAGE_LENGTH.toLocaleString('en-US')} characters to send it.`
  return null
}

// ---------------------------------------------------------------------------------------------
// What the sheet can do
// ---------------------------------------------------------------------------------------------

/** GET /api/assistant as the sheet knows it (data stays while a newer answer is on its way). */
export type InfoState = {
  phase: 'idle' | 'loading' | 'ready' | 'failed'
  data: AssistantInfo | null
  failure: AssistantFailure | null
}

export type SheetView =
  /** Not connected, on a copy no server serves (the one-file app, the GitHub Pages demo, the dev server). */
  | { kind: 'local' }
  /** A page a First Twenty server served, but this browser is not signed in to it. */
  | { kind: 'connect' }
  /** Signed in to the server, but this browser has not chosen a workspace yet (upload, or the server's copy). */
  | { kind: 'finish' }
  | { kind: 'signed_out' }
  | { kind: 'checking' }
  /** The server could not be asked (offline, an error): try again. */
  | { kind: 'unavailable'; failure: AssistantFailure }
  /** The server has no assistant (no API key, or a server from before it). */
  | { kind: 'off' }
  | { kind: 'ready' }

export type SheetInput = {
  mode: 'local' | 'server'
  /** The page was served by a First Twenty server (isServedPage). */
  served: boolean
  /** A login is signed in (the sync status's user), connected or not. */
  signedIn: boolean
  syncStatus: SyncStatus
  info: InfoState
}

export function sheetView(input: SheetInput): SheetView {
  if (input.mode !== 'server') return !input.served ? { kind: 'local' } : input.signedIn ? { kind: 'finish' } : { kind: 'connect' }
  if (input.syncStatus === 'signed_out') return { kind: 'signed_out' }
  const { info } = input
  if (info.phase === 'failed' && info.failure) {
    if (info.failure.kind === 'signed_out') return { kind: 'signed_out' }
    if (info.failure.kind === 'not_found' || info.failure.kind === 'off') return { kind: 'off' }
    // An answer from before (a refresh that failed) still says what the server does.
    if (!info.data) return { kind: 'unavailable', failure: info.failure }
  }
  if (!info.data) return { kind: 'checking' }
  return info.data.enabled ? { kind: 'ready' } : { kind: 'off' }
}

/**
 * When the day's questions come back, in this browser's time: the server counts them per UTC day, so for a
 * California user they come back the same afternoon ('More come back at 5 PM.'), and further east the
 * next morning ('More come back tomorrow at 2 AM.'). `timeZone` is for tests (default: this browser's).
 */
export function quotaBackText(now: Date = new Date(), timeZone?: string): string {
  const back = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  const day = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  // Some browsers put a narrow no-break space before AM/PM: one plain space, like the rest of the app's text.
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(back).replace(':00', '').replace(/\s+/g, ' ')
  const at = time === '12 AM' ? 'midnight' : time
  return day(back) === day(now) ? `More come back at ${at}.` : `More come back ${at === 'midnight' ? 'at midnight' : `tomorrow at ${at}`}.`
}

/** The words for a conversation the server will not take further (the box says it, and the answer's announcement). */
export function conversationFullText(name: string): string {
  return `This conversation is as long as ${name} can follow. Start a new one to keep asking.`
}

/** The words under an answer that stopped at the server's length limit. */
export const CUT_OFF_TEXT = 'This answer was cut off before it finished. Ask for the rest, or ask a narrower question.'

/** Plain words for a question that did not get its answer (copy rules: what happened, what to do). */
export function failureText(f: Pick<AssistantFailure, 'kind' | 'message'> & { error?: string | null }, name: string, now: Date = new Date()): string {
  switch (f.kind) {
    case 'busy':
      if (f.error === 'assistant_company_busy') return `${name} is answering other people at your company right now. Wait a moment, then send again.`
      return `${name} is still answering in another tab or window. Wait for that answer, then send again.`
    case 'quota':
      return `${name} has no questions left right now. ${quotaBackText(now)}`
    case 'offline':
      return 'Cannot reach the server. Check the connection, then send again.'
    case 'interrupted':
      return `The answer broke off before ${name} finished. Send the question again.`
    case 'bad_history':
      // The 'error' event bad_conversation says why (the Claude API will not take it further); a 400 does not.
      return f.message ?? `This conversation is longer than ${name} can follow. Start a new conversation to keep asking.`
    case 'too_large':
      return 'That question is too long for the server. Shorten it and send it again.'
    case 'rate_limited':
      return 'The server is taking too many requests right now. Wait a minute, then send again.'
    case 'model':
      return f.message ?? `${name} could not answer that. Try asking another way.`
    case 'forbidden':
      return "The server refused the request. Open the app from the server's own address and try again."
    case 'signed_out':
      return `Signed out of the server. Sign in again to ask ${name}.`
    case 'off':
    case 'not_found':
      return `${name} is not turned on for this server.`
    case 'aborted':
      return 'Stopped.'
    case 'server':
    case 'bad_request':
    case 'bad_response':
      return `The server had a problem answering. Send the question again in a moment.`
  }
}

/**
 * Answers the same question would fail again the same way: declined, too big for one answer, more lookups
 * than one question allows, or a server that is not set up right. They get no Retry (asking another way does).
 */
const FINAL_MODEL_ERRORS: ReadonlySet<string> = new Set(['refused', 'refusal', 'truncated', 'too_many_steps', 'assistant_misconfigured'])

/** Failures a second try can fix (Retry), as opposed to ones that need another step first. */
export function canRetry(f: Pick<AssistantFailure, 'kind' | 'error'>): boolean {
  if (f.kind === 'model') return !FINAL_MODEL_ERRORS.has(f.error ?? '')
  return ['busy', 'offline', 'interrupted', 'rate_limited', 'server', 'bad_response', 'bad_request'].includes(f.kind)
}

/** "12 questions left today" */
export function remainingText(n: number): string {
  return n === 0 ? 'No questions left today' : `${plural(n, 'question')} left today`
}

// ---------------------------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------------------------

/** 'Staff ML engineer' -> 'staff ML engineer' (an acronym keeps its capitals). */
function inSentence(title: string): string {
  const t = title.trim()
  return /^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a')

/**
 * Up to four questions to start with, fitted to the company: who starts soon, legal deadlines, the
 * busiest open search, a posting for the next planned role (or a first hire for a solo founder).
 */
export function suggestionsFor(db: DB, day: ISODate = today()): string[] {
  const out: string[] = []
  const incoming = incomingOn(db, day)
  const employed = employedOn(db, day)
  if (incoming.length > 0) out.push(incoming[0].startDate <= addDays(day, 13) ? 'Who starts next week?' : 'Who starts next?')
  else if (employed.length <= 1) out.push('What do I need to do before my first hire?')
  out.push('Which legal deadlines are overdue?')

  const active = new Map<string, number>()
  for (const a of db.applications) if (a.status === 'active') active.set(a.jobId, (active.get(a.jobId) ?? 0) + 1)
  const busiest = db.jobs
    .filter((j) => j.status === 'open')
    .sort((a, b) => (active.get(b.id) ?? 0) - (active.get(a.id) ?? 0) || a.title.localeCompare(b.title))[0]
  if (busiest) out.push(`Where does the ${inSentence(busiest.title)} search stand?`)
  else if (employed.length > 1) out.push('Who is out this week?')

  const planned = db.plan.filter((s) => s.status === 'planned' && !s.jobId).sort((a, b) => a.targetStart.localeCompare(b.targetStart))[0]
  const role = planned ? inSentence(planned.title) : employed.length <= 1 ? 'first hire' : 'founding designer'
  out.push(role === 'first hire' ? 'Draft a job posting for my first hire' : `Draft a job posting for ${article(role)} ${role}`)
  return out.slice(0, 4)
}

// ---------------------------------------------------------------------------------------------
// Renaming
// ---------------------------------------------------------------------------------------------

/** The Undo toast and activity text for a rename ('Renamed the assistant to Lark'). */
export function renameLabel(company: Pick<Company, 'name'>, raw: string): string {
  const next = normalizeAssistantName(raw)
  return next ? `Renamed the assistant to ${next}` : `Reset the assistant's name to ${defaultAssistantName(company)}`
}

/** Whether a typed name would change what is saved (an empty field and an unset name are the same). */
export function renameChanges(company: Pick<Company, 'assistantName'>, raw: string): boolean {
  return (normalizeAssistantName(raw) ?? '') !== (normalizeAssistantName(company.assistantName ?? '') ?? '')
}

/** Saves a typed name (validated with assistantNameError first): set, or removed for an empty field. */
export function applyAssistantName(draft: Draft<DB>, raw: string, label: string): void {
  const next = normalizeAssistantName(raw)
  if (next) draft.company.assistantName = next
  else delete draft.company.assistantName
  logActivity(draft, { entityType: 'company', entityId: 'company', kind: 'settings_changed', text: label })
}

// ---------------------------------------------------------------------------------------------
// The per-tab copy
// ---------------------------------------------------------------------------------------------

/**
 * sessionStorage key for this tab's conversation: it survives a reload, never reaches another tab or the
 * server's sync, and goes when the tab closes. It names the login it belongs to, so a different login in
 * this tab never sees or sends it, and the server workspace and history it was about (sync's
 * assistantWorkspaceKey), so after Start fresh, an Import or another computer's replace it is dropped
 * instead of carrying the old company's records into questions about the new one.
 */
export const CONVERSATION_KEY = 'first-twenty-assistant'

/** workspace: '<workspaceId>/<historyId>' it was about, or null when not known when it was saved. */
export type SavedConversation = { v: 1; userId: string; workspace: string | null; history: unknown[]; remainingToday: number | null }

export type SessionLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** This tab's conversation for the login, or null (none, another login's, or unreadable). */
export function loadConversation(storage: SessionLike | null, userId: string): SavedConversation | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(CONVERSATION_KEY)
    if (!raw) return null
    const saved = JSON.parse(raw) as Partial<SavedConversation> | null
    if (!saved || saved.v !== 1 || saved.userId !== userId || !Array.isArray(saved.history)) return null
    const remaining = typeof saved.remainingToday === 'number' && Number.isFinite(saved.remainingToday) ? Math.max(0, Math.floor(saved.remainingToday)) : null
    const workspace = typeof saved.workspace === 'string' && saved.workspace !== '' ? saved.workspace : null
    return { v: 1, userId, workspace, history: saved.history, remainingToday: remaining }
  } catch {
    return null
  }
}

/** Keeps the conversation for this tab. A browser that refuses (private mode, full) keeps it in memory only. */
export function saveConversation(storage: SessionLike | null, saved: SavedConversation): void {
  try {
    storage?.setItem(CONVERSATION_KEY, JSON.stringify(saved))
  } catch {
    /* storage refused: the conversation lives in this page only */
  }
}

export function clearConversation(storage: SessionLike | null): void {
  try {
    storage?.removeItem(CONVERSATION_KEY)
  } catch {
    /* nothing was saved there either */
  }
}
