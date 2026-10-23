// Fetch client for the assistant (GET /api/assistant, POST /api/assistant/chat; docs/SERVER.md, "Lark, the
// assistant"). Same rules as the sync client (api.ts): same origin, the session cookie, the CSRF header on
// the POST, and every call resolves (never throws) to a typed result, so the sheet can tell "the server
// has it off" from "used up today" from "another tab is asking" from "offline".
//
// The chat answers as server-sent events: 'delta' {text} while the answer is written, 'status' {label}
// while records are looked up, 'discard' {chars} when the last chars of text sent belong to a turn the
// server asks again (drop them), then 'done' {history, remainingToday, truncated?} or 'error' {error,
// message, discardPartial?}. The history 'done' carries is the conversation as the server ran it; the
// caller keeps it exactly as it came and sends it back unchanged with the next question (the server
// refuses an edited one).
import { CSRF_HEADER, type FetchLike } from './api'
import { createSSEParser, type SSEMessage } from './sse'

export type AssistantInfo = {
  enabled: boolean
  /** The assistant's name as the server knows it (assistantDisplayName of the company's documents). */
  name: string
  model: string
  /** Questions this company may still ask today (the smaller of its own and the server's allowance). */
  remainingToday: number
}

export type AssistantFailureKind =
  | 'off' // 503 assistant_off: the server has no API key, or the assistant is turned off
  | 'quota' // 429 assistant_quota: the company's or the server's questions for today are used up
  | 'busy' // 409 assistant_busy: this login already has an answer running (another tab or window); 409 assistant_company_busy: the company's other logins have as many running as it may
  | 'signed_out' // 401
  | 'offline' // network error or timeout before an answer started
  | 'interrupted' // the answer started, then the stream broke off (or went silent) before 'done'
  | 'aborted' // the caller stopped it
  | 'bad_history' // 400 bad_history (too long, or not one the server sent), or the 'error' event bad_conversation
  | 'too_large' // 413
  | 'forbidden' // 403 (CSRF guard, cross-site refusal)
  | 'not_found' // 404: a server from before the assistant
  | 'rate_limited' // 503 assistant_full (as many answers running as the server allows), another 429
  | 'model' // an 'error' event: the model refused, ran out of room, or the Claude API failed (its message says)
  | 'bad_request' // another 4xx
  | 'server' // 5xx
  | 'bad_response' // an answer this client does not understand

export type AssistantFailure = {
  ok: false
  kind: AssistantFailureKind
  status: number | null
  /** The server's error code ({error}, or the 'error' event's), never shown raw. */
  error: string | null
  /** The 'error' event's plain-language message, when it sent one. */
  message?: string
  /** Seconds, for quota and rate_limited when the server says. */
  retryAfter?: number
  /** Questions left today, when the server says along with the failure (an 'error' event does). */
  remainingToday?: number
  /** The text streamed for this question is not an answer (a refusal, a cut-off tool call): drop it. */
  discardPartial?: boolean
}

export type AssistantResult<T> = { ok: true; data: T } | AssistantFailure

export type ChatInput = {
  /** The history the previous 'done' returned (or []), sent back exactly as it came. */
  history: readonly unknown[]
  message: string
  signal?: AbortSignal
}

export type ChatHandlers = {
  /** A piece of the answer's text. */
  onDelta?: (text: string) => void
  /** What the assistant is doing between pieces ('Looking up people'). */
  onStatus?: (label: string) => void
  /** Drop the last `chars` characters of the text received so far: their turn is being asked again. */
  onDiscard?: (chars: number) => void
}

/** truncated: the answer stopped at the server's length limit before it was finished. */
export type ChatDone = { ok: true; history: unknown[]; remainingToday: number | null; truncated: boolean }

export type AssistantApi = {
  info(): Promise<AssistantResult<AssistantInfo>>
  chat(input: ChatInput, handlers?: ChatHandlers): Promise<ChatDone | AssistantFailure>
}

export type AssistantApiOptions = {
  /** Prefix for /api paths. '' (same origin) in the app; tests may point it elsewhere. */
  baseUrl?: string
  fetch?: FetchLike
  /** GET /api/assistant, and the wait for the chat's answer to start. Default 30 s. */
  timeoutMs?: number
  /** Longest silence inside a running answer before it counts as broken off. Default 150 s. */
  idleTimeoutMs?: number
}

export function createAssistantApi(options: AssistantApiOptions = {}): AssistantApi {
  const base = (options.baseUrl ?? '').replace(/\/+$/, '')
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = options.timeoutMs ?? 30_000
  const idleTimeoutMs = options.idleTimeoutMs ?? 150_000

  return {
    info: async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let res: Response
      let text: string
      try {
        res = await doFetch(`${base}/api/assistant`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        })
        text = await res.text()
      } catch {
        return failure('offline', null, null)
      } finally {
        clearTimeout(timer)
      }
      const json = parseJSON(text)
      if (!res.ok) return failureFor(res, json)
      const info = parseInfo(json)
      return info ? { ok: true, data: info } : failure('bad_response', res.status, null)
    },

    chat: async (input, handlers = {}) => {
      const controller = new AbortController()
      let stoppedByCaller = false
      const onAbort = () => {
        stoppedByCaller = true
        controller.abort()
      }
      if (input.signal?.aborted) return failure('aborted', null, null)
      input.signal?.addEventListener('abort', onAbort)
      // One timer: the wait for the answer to start, then the longest silence between pieces of it.
      let timer: ReturnType<typeof setTimeout> | null = null
      const arm = (ms: number) => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => controller.abort(), ms)
      }
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        input.signal?.removeEventListener('abort', onAbort)
      }
      arm(timeoutMs)

      let res: Response
      try {
        res = await doFetch(`${base}/api/assistant/chat`, {
          method: 'POST',
          headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', [CSRF_HEADER]: '1' },
          body: JSON.stringify({ history: input.history, message: input.message }),
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        })
      } catch {
        cleanup()
        return failure(stoppedByCaller ? 'aborted' : 'offline', null, null)
      }

      if (!res.ok) {
        let text = ''
        try {
          text = await res.text()
        } catch {
          /* the error body never came: the status says enough */
        }
        cleanup()
        return stoppedByCaller ? failure('aborted', res.status, null) : failureFor(res, parseJSON(text))
      }
      if (!/^text\/event-stream\b/i.test(res.headers.get('Content-Type') ?? '')) {
        cleanup()
        return failure('bad_response', res.status, null)
      }

      // Read the stream. The first 'done' or 'error' settles the answer; anything after it is ignored.
      const settled: { outcome: ChatDone | AssistantFailure | null } = { outcome: null }
      const parser = createSSEParser((m) => {
        if (!settled.outcome) settled.outcome = handleEvent(m, handlers)
      })
      const decoder = new TextDecoder()
      try {
        if (res.body) {
          const reader = res.body.getReader()
          arm(idleTimeoutMs)
          while (!settled.outcome) {
            const { done, value } = await reader.read()
            if (done) break
            arm(idleTimeoutMs)
            parser.push(decoder.decode(value, { stream: true }))
          }
          if (settled.outcome) void reader.cancel().catch(() => undefined)
        } else {
          // A fetch without streaming bodies (some test doubles): the whole answer at once.
          parser.push(await res.text())
        }
        if (!settled.outcome) {
          parser.push(decoder.decode())
          parser.end()
        }
      } catch {
        // The connection broke, the silence timer fired, or the caller stopped it: nothing settled the answer.
      }
      cleanup()
      return settled.outcome ?? failure(stoppedByCaller ? 'aborted' : 'interrupted', res.status, null)
    },
  }
}

/** One server-sent event: deltas and statuses go to the handlers; 'done' and 'error' settle the answer. */
function handleEvent(m: SSEMessage, handlers: ChatHandlers): ChatDone | AssistantFailure | null {
  const json = parseJSON(m.data)
  switch (m.event) {
    case 'delta':
      if (isObj(json) && typeof json.text === 'string' && json.text !== '') handlers.onDelta?.(json.text)
      return null
    case 'status':
      if (isObj(json) && typeof json.label === 'string' && json.label.trim() !== '') handlers.onStatus?.(json.label.trim().slice(0, 120))
      return null
    case 'discard': {
      const chars = isObj(json) ? num(json.chars) : null
      if (chars !== null && chars > 0) handlers.onDiscard?.(Math.floor(chars))
      return null
    }
    case 'done': {
      if (!isObj(json) || !Array.isArray(json.history)) return failure('bad_response', 200, null)
      const remaining = num(json.remainingToday)
      return { ok: true, history: json.history, remainingToday: remaining === null ? null : Math.max(0, Math.floor(remaining)), truncated: json.truncated === true }
    }
    case 'error': {
      const error = isObj(json) && typeof json.error === 'string' ? json.error : null
      const message = isObj(json) ? plainMessage(json.message) : null
      // The server may also report its own refusals this way (the quota ran out mid-way, the login is busy),
      // and a conversation the Claude API will not take further (bad_conversation) needs a new one.
      const kind: AssistantFailureKind =
        error === 'assistant_quota'
          ? 'quota'
          : error === 'assistant_busy'
            ? 'busy'
            : error === 'assistant_off'
              ? 'off'
              : error === 'bad_conversation'
                ? 'bad_history'
                : 'model'
      const out: AssistantFailure = { ok: false, kind, status: 200, error }
      if (message) out.message = message
      const remaining = isObj(json) ? num(json.remainingToday) : null
      if (remaining !== null) out.remainingToday = Math.max(0, Math.floor(remaining))
      if (isObj(json) && json.discardPartial === true) out.discardPartial = true
      return out
    }
    default:
      // Events this client does not know (a newer server's): skipped.
      return null
  }
}

/**
 * A message from the server shown as plain text: one paragraph, no control characters, at most 400
 * characters. The sheet renders it as text, never as markup.
 */
function plainMessage(v: unknown): string | null {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.length > 400 ? `${s.slice(0, 399)}…` : s
}

function failure(kind: AssistantFailureKind, status: number | null, error: string | null, retryAfter?: number): AssistantFailure {
  return retryAfter === undefined ? { ok: false, kind, status, error } : { ok: false, kind, status, error, retryAfter }
}

function failureFor(res: Response, json: unknown): AssistantFailure {
  const status = res.status
  const error = isObj(json) && typeof json.error === 'string' ? json.error : null
  const retryAfter = (isObj(json) ? num(json.retryAfter) : null) ?? num(res.headers.get('Retry-After')) ?? undefined
  if (status === 401) return failure('signed_out', status, error)
  if (status === 503 && error === 'assistant_off') return failure('off', status, error)
  // assistant_full: the server runs as many answers as it may at once; a minute later there is room.
  if (status === 503 && error === 'assistant_full') return failure('rate_limited', status, error, retryAfter)
  if (status === 429) return failure(error === 'assistant_quota' ? 'quota' : 'rate_limited', status, error, retryAfter)
  if (status === 409 && (error === 'assistant_busy' || error === 'assistant_company_busy')) return failure('busy', status, error)
  if (status === 400 && error === 'bad_history') return failure('bad_history', status, error)
  if (status === 413) return failure('too_large', status, error)
  if (status === 403) return failure('forbidden', status, error)
  if (status === 404) return failure('not_found', status, error)
  if (status >= 500) return failure('server', status, error)
  if (status >= 400) return failure('bad_request', status, error)
  return failure('bad_response', status, error)
}

function parseInfo(j: unknown): AssistantInfo | null {
  if (!isObj(j) || typeof j.enabled !== 'boolean') return null
  const remaining = num(j.remainingToday)
  return {
    enabled: j.enabled,
    name: typeof j.name === 'string' ? j.name.slice(0, 120) : '',
    model: typeof j.model === 'string' ? j.model.slice(0, 120) : '',
    remainingToday: remaining === null ? 0 : Math.max(0, Math.floor(remaining)),
  }
}

function parseJSON(text: string): unknown {
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Numbers, or numeric strings (a bigint count may arrive as a string). */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}
