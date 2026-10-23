// The conversation a browser sends back with each message (POST /api/assistant/chat): the `history` the
// previous 'done' event carried, unchanged, or [] for a new conversation. The server keeps no conversations,
// so it checks the shape before a byte of it goes to the model, and never changes it: thinking blocks are
// tied to the exact conversation that produced them (preserved thinking), so the history is used as sent
// or refused whole (400 bad_history).
//
// What passes: at most HISTORY_LIMITS.messages messages and HISTORY_LIMITS.bytes of JSON; roles user and
// assistant only (never 'system', which would speak with the operator's authority), alternating and starting
// with the user; user content of text and tool_result blocks, assistant content of text, thinking,
// redacted_thinking, tool_use (one of the assistant's own tools) and fallback blocks (the marker a
// server-side refusal fallback leaves); every tool call answered in the next user message. Nothing that
// could pull outside content into a request (images, documents, URLs, citations) and no cache_control
// markers (the server places its own).
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages'

export const HISTORY_LIMITS = {
  /** Messages a history may hold (each tool round adds two). */
  messages: 40,
  /** Bytes of JSON a history may hold. */
  bytes: 150 * 1024,
}

/** The most characters a user's message may have (the app shows the count). */
export const MESSAGE_MAX = 2000
/** Longest id a tool_use block may carry. */
const ID_MAX = 200

export type HistoryResult =
  | { ok: true; history: BetaMessageParam[] }
  | { ok: false; reason: 'too_long' | 'malformed'; detail: string }

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const nullish = (v: unknown) => v === undefined || v === null

class Malformed extends Error {}

function fail(detail: string): never {
  throw new Malformed(detail)
}

/** Checks one block of an assistant message; returns the tool_use id it opens, if any. */
function assistantBlock(b: Obj, where: string, toolNames: ReadonlySet<string>): string | null {
  switch (b.type) {
    case 'text':
      if (!isStr(b.text) || !nullish(b.citations)) fail(`${where}: a text block holds text only.`)
      return null
    case 'thinking':
      if (!isStr(b.thinking) || !isStr(b.signature)) fail(`${where}: a thinking block needs thinking and signature.`)
      return null
    case 'redacted_thinking':
      if (!isStr(b.data)) fail(`${where}: a redacted_thinking block needs data.`)
      return null
    case 'tool_use':
      if (!isStr(b.id) || b.id.length === 0 || b.id.length > ID_MAX) fail(`${where}: a tool_use block needs an id.`)
      if (!isStr(b.name) || !toolNames.has(b.name)) fail(`${where}: ${JSON.stringify(String(b.name).slice(0, 40))} is not one of the assistant's tools.`)
      if (!isObj(b.input)) fail(`${where}: a tool_use block needs an input object.`)
      if (!nullish(b.caller) && !isObj(b.caller)) fail(`${where}: a tool_use caller must be an object.`)
      if (!nullish(b.toolset_name)) fail(`${where}: the assistant's tools belong to no toolset.`)
      return b.id
    case 'fallback':
      if (!isObj(b.from) || !isStr(b.from.model) || !isObj(b.to) || !isStr(b.to.model)) fail(`${where}: a fallback block names the models it went from and to.`)
      return null
    default:
      return fail(`${where}: ${JSON.stringify(String(b.type).slice(0, 40))} blocks are not accepted from an assistant turn.`)
  }
}

/** Checks one block of a user message; returns the tool_use id it answers, if any. */
function userBlock(b: Obj, where: string): string | null {
  switch (b.type) {
    case 'text':
      if (!isStr(b.text) || !nullish(b.citations)) fail(`${where}: a text block holds text only.`)
      return null
    case 'tool_result': {
      if (!isStr(b.tool_use_id) || b.tool_use_id.length === 0) fail(`${where}: a tool_result block needs its tool_use_id.`)
      if (!nullish(b.is_error) && typeof b.is_error !== 'boolean') fail(`${where}: is_error must be true or false.`)
      const content = b.content
      const textOnly = (c: unknown) => isObj(c) && c.type === 'text' && isStr(c.text) && nullish(c.citations) && !('cache_control' in c)
      if (!nullish(content) && !isStr(content) && !(Array.isArray(content) && content.every(textOnly))) {
        fail(`${where}: a tool result holds text only.`)
      }
      return b.tool_use_id
    }
    default:
      return fail(`${where}: ${JSON.stringify(String(b.type).slice(0, 40))} blocks are not accepted from a user turn.`)
  }
}

/**
 * Validates a history (see the top of this file) without changing it. `toolNames`: the assistant's tools.
 * Returns the same array, typed, or why it was refused.
 */
export function parseHistory(raw: unknown, toolNames: ReadonlySet<string>): HistoryResult {
  if (!Array.isArray(raw)) return { ok: false, reason: 'malformed', detail: 'history must be a list (the one the last answer sent, or []).' }
  if (raw.length > HISTORY_LIMITS.messages) {
    return { ok: false, reason: 'too_long', detail: 'This conversation is too long to go on. Start a new conversation.' }
  }
  const json = JSON.stringify(raw)
  if (json.length > HISTORY_LIMITS.bytes / 4 && Buffer.byteLength(json, 'utf8') > HISTORY_LIMITS.bytes) {
    return { ok: false, reason: 'too_long', detail: 'This conversation is too long to go on. Start a new conversation.' }
  }
  try {
    /** tool_use ids the previous assistant message opened, which this user message must answer. */
    let open: string[] = []
    raw.forEach((m: unknown, i) => {
      const where = `history[${i}]`
      if (!isObj(m)) fail(`${where} must be an object.`)
      for (const key of Object.keys(m)) if (key !== 'role' && key !== 'content') fail(`${where}: messages hold a role and content only.`)
      const role = i % 2 === 0 ? 'user' : 'assistant'
      if (m.role !== 'user' && m.role !== 'assistant') fail(`${where}: the role must be user or assistant.`)
      if (m.role !== role) fail(`${where}: turns must alternate, starting with the user.`)
      const content = m.content
      if (isStr(content)) {
        if (content.length === 0) fail(`${where}: the content is empty.`)
        if (open.length > 0) fail(`${where}: the tool calls before it have no results.`)
        return
      }
      if (!Array.isArray(content) || content.length === 0) fail(`${where}: content must be text or a list of blocks.`)
      const blocks = content as unknown[]
      if (role === 'assistant') {
        const opened: string[] = []
        blocks.forEach((b, j) => {
          if (!isObj(b) || 'cache_control' in b) fail(`${where}.content[${j}] is not an accepted block.`)
          const id = assistantBlock(b, `${where}.content[${j}]`, toolNames)
          if (id !== null) opened.push(id)
        })
        if (new Set(opened).size !== opened.length) fail(`${where}: two tool calls share an id.`)
        open = opened
        return
      }
      const answered: string[] = []
      let textSeen = false
      blocks.forEach((b, j) => {
        if (!isObj(b) || 'cache_control' in b) fail(`${where}.content[${j}] is not an accepted block.`)
        const id = userBlock(b, `${where}.content[${j}]`)
        if (id === null) textSeen = true
        else if (textSeen) fail(`${where}: tool results come before any text.`)
        else answered.push(id)
      })
      const answersEvery = answered.length === open.length && open.every((id) => answered.includes(id))
      if (!answersEvery) fail(`${where}: the tool results do not match the tool calls before them.`)
      open = []
    })
    if (raw.length % 2 === 1) fail('history must end with an answer from the assistant.')
    if (open.length > 0) fail('history ends with tool calls that have no results.')
  } catch (err) {
    if (err instanceof Malformed) return { ok: false, reason: 'malformed', detail: err.message }
    throw err
  }
  return { ok: true, history: raw as BetaMessageParam[] }
}
