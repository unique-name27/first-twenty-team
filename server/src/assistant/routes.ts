// The assistant's routes (docs/SERVER.md "Lark, the assistant"), registered inside app.ts's API plugin, so
// the CSRF header, the cross-site refusal and Cache-Control: no-store apply, and both need a session (checked
// before the body is read). The company is the session login's, never one a request names.
//
//   GET  /api/assistant        {enabled, name, model, remainingToday}
//   POST /api/assistant/chat   {history, message} -> 200 text/event-stream of
//                                event: delta   data: {"text": "..."}       answer text as it arrives
//                                event: status  data: {"label": "..."}      a tool is running
//                                event: discard data: {"chars": n}          drop the last n characters of
//                                                                           answer text (a turn asked again)
//                                event: done    data: {"history": [...], "remainingToday": n, "truncated"?: true}
//                                event: error   data: {"error": "...", "message": "...", "remainingToday"?: n,
//                                                      "discardPartial"?: true}
//                              Before the stream starts: 503 assistant_off (no ANTHROPIC_API_KEY), 400
//                              bad_request or bad_history, 409 assistant_busy (this login has a chat
//                              running), 409 assistant_company_busy (the company runs MAX_CHATS_PER_COMPANY
//                              already), 503 assistant_full (the server runs MAX_RUNNING_CHATS already),
//                              429 assistant_quota (the company's or the server's messages for today are
//                              used up).
//
// Each stream ends with exactly one done or error event. While tools run, a comment line every
// KEEPALIVE_MS keeps proxies from closing a quiet connection. When the browser goes away the chat's
// AbortSignal ends the request to Claude; a message whose request already went out still counts. Logs say
// who asked and how it went, never what was asked.
import { PassThrough } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { assistantDisplayName } from '../../../src/domain/assistant'
import type { Company } from '../../../src/domain/types'
import { pacificDateOf } from '../../../src/lib/dates'
import type { AuthUser } from '../auth'
import type { Config } from '../config'
import type { Db } from '../db'
import { badRequest } from '../errors'
import { isPlainObject } from '../validate'
import { workspaceInfo } from '../workspaces'
import type { AssistantClient } from './client'
import { FAKE_MODEL } from './fake'
import { MESSAGE_MAX, parseHistory } from './history'
import { contextNote, systemPrompt } from './prompt'
import { billedInput, type DailyLimits, LIGHT_USE, type QuotaScope, recordTokens, releaseMessage, remainingToday, reserveMessage } from './quota'
import { WorkspaceReader } from './reader'
import { runChat } from './runner'
import { assistantTools, TOOL_NAME_SET } from './tools'

/** A chat body: a history of up to ~150 KB and a 2,000-character message, with room to spare. */
export const CHAT_BODY_LIMIT = 200 * 1024
/** Chats the server runs at once, across every company (each holds records in memory while it runs). */
export const MAX_RUNNING_CHATS = 8
/** Chats one company runs at once, across its logins, so no company can take every server slot. */
export const MAX_CHATS_PER_COMPANY = 2
/** How often a quiet stream sends a comment line. */
export const KEEPALIVE_MS = 15_000

export type AssistantRouteDeps = {
  db: Db
  config: Config
  /** The model client, or null when the assistant is off. */
  client: AssistantClient | null
  /** app.ts's session check (onRequest). */
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  currentUser: (request: FastifyRequest) => AuthUser
  /** The clock (tests). */
  now?: () => Date
}

/** The parts of the company document the assistant names: read alone, not the whole document. */
async function companyNames(db: Db, workspaceId: string): Promise<Partial<Pick<Company, 'name' | 'legalName' | 'assistantName'>>> {
  const r = await db.query<{ name: unknown; legal_name: unknown; assistant_name: unknown }>(
    `SELECT data->'name' AS name, data->'legalName' AS legal_name, data->'assistantName' AS assistant_name
       FROM workspace_docs WHERE workspace_id = $1 AND key = 'company'`,
    [workspaceId],
  )
  const row = r.rows[0]
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined)
  if (row && text(row.name)?.trim()) return { name: text(row.name), legalName: text(row.legal_name), assistantName: text(row.assistant_name) }
  // Not uploaded yet: the name the company signed up with.
  return { name: (await workspaceInfo(db, workspaceId))?.name, assistantName: text(row?.assistant_name) }
}

/** One server-sent event: `event:` and one `data:` line of JSON (JSON.stringify never writes a raw line break). */
export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** The 429 body's words for a used-up limit. */
function quotaDetail(scope: QuotaScope, limits: DailyLimits): string {
  const reset = 'The count starts again at midnight UTC.'
  if (scope === 'workspace') return `This company has used its ${limits.perWorkspace} assistant messages for today. ${reset}`
  if (scope === 'reserve') return `This server is down to the messages it keeps for companies that have asked fewer than ${LIGHT_USE} today. ${reset}`
  return `This server has used its assistant messages for today. ${reset}`
}

export async function registerAssistantRoutes(api: FastifyInstance, deps: AssistantRouteDeps): Promise<void> {
  const { db, config, client, requireAuth, currentUser } = deps
  const now = deps.now ?? (() => new Date())
  const enabled = config.assistant.enabled && client !== null
  const limits: DailyLimits = { perWorkspace: config.assistant.perWorkspaceDaily, global: config.assistant.globalDaily }
  /** Logins with a chat running (one at a time each). */
  const running = new Set<string>()
  /** Chats running per company (at most MAX_CHATS_PER_COMPANY each). */
  const perCompany = new Map<string, number>()
  const release = (user: AuthUser) => {
    running.delete(user.id)
    const n = (perCompany.get(user.workspaceId) ?? 1) - 1
    if (n > 0) perCompany.set(user.workspaceId, n)
    else perCompany.delete(user.workspaceId)
  }
  const authed = { onRequest: requireAuth }

  api.get('/assistant', authed, async (request) => {
    const user = currentUser(request)
    const name = assistantDisplayName(await companyNames(db, user.workspaceId))
    if (!enabled) return { enabled: false, name, model: null, remainingToday: 0 }
    return {
      enabled: true,
      name,
      model: config.assistant.fake ? FAKE_MODEL : config.assistant.model,
      remainingToday: await remainingToday(db, user.workspaceId, limits, now()),
    }
  })

  api.post('/assistant/chat', { ...authed, bodyLimit: CHAT_BODY_LIMIT }, async (request, reply) => {
    const user = currentUser(request)
    if (!enabled || !client) {
      return reply.code(503).send({ error: 'assistant_off', detail: 'The assistant is not turned on on this server.' })
    }
    const body = request.body
    if (!isPlainObject(body) || typeof body.message !== 'string' || !('history' in body)) {
      throw badRequest('Send {"history": [...], "message": "..."}.')
    }
    const message = body.message
    if (message.trim() === '') throw badRequest('Type a question first.')
    if (message.length > MESSAGE_MAX) throw badRequest(`Keep a message to ${MESSAGE_MAX.toLocaleString('en-US')} characters or fewer.`)
    const parsed = parseHistory(body.history, TOOL_NAME_SET)
    if (!parsed.ok) return reply.code(400).send({ error: 'bad_history', reason: parsed.reason, detail: parsed.detail })

    // Taken before any await, so two requests from one login (or one company) cannot both start.
    if (running.has(user.id)) {
      return reply.code(409).send({ error: 'assistant_busy', detail: 'An answer is still on its way. Wait for it, or stop it, before asking again.' })
    }
    if ((perCompany.get(user.workspaceId) ?? 0) >= MAX_CHATS_PER_COMPANY) {
      return reply.code(409).send({ error: 'assistant_company_busy', detail: 'Other people at this company are asking right now. Try again in a moment.' })
    }
    if (running.size >= MAX_RUNNING_CHATS) {
      reply.header('Retry-After', '20')
      return reply.code(503).send({ error: 'assistant_full', detail: 'Many people are asking right now. Try again in a minute.', retryAfter: 20 })
    }
    running.add(user.id)
    perCompany.set(user.workspaceId, (perCompany.get(user.workspaceId) ?? 0) + 1)
    let started = false
    // Listening from here on, before any await: a browser that leaves while the message is being counted
    // never gets a request to Claude made for it (runChat checks the signal first).
    const controller = new AbortController()
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort()
    })
    try {
      const reservation = await reserveMessage(db, user.workspaceId, limits, now())
      if (!reservation.ok) {
        return reply.code(429).send({ error: 'assistant_quota', scope: reservation.scope, detail: quotaDetail(reservation.scope, limits), remainingToday: 0 })
      }
      let company: Awaited<ReturnType<typeof companyNames>>
      try {
        company = await companyNames(db, user.workspaceId)
      } catch (err) {
        // Nothing was asked: the message does not count.
        await releaseMessage(db, user.workspaceId, reservation.day).catch(() => {})
        throw err
      }
      const name = assistantDisplayName(company)
      const today = pacificDateOf(now().toISOString())
      const tools = assistantTools({ reader: new WorkspaceReader(db, user.workspaceId), today })

      const stream = new PassThrough()
      // A write after the browser left goes nowhere; it must not throw.
      stream.on('error', () => {})
      const send = (event: string, data: unknown) => {
        if (!stream.destroyed && !stream.writableEnded) stream.write(sseEvent(event, data))
      }
      const keepalive = setInterval(() => {
        if (!stream.destroyed && !stream.writableEnded) stream.write(': keep-alive\n\n')
      }, KEEPALIVE_MS)
      keepalive.unref()

      // no-transform: proxies pass each event on as it is, never holding it back to compress (Caddy's encode
      // skips such responses); X-Accel-Buffering does the same for nginx.
      reply
        .code(200)
        .header('Content-Type', 'text/event-stream; charset=utf-8')
        .header('Cache-Control', 'no-store, no-transform')
        .header('X-Accel-Buffering', 'no')
        .send(stream)
      started = true

      void (async () => {
        try {
          const outcome = await runChat({
            client,
            config: config.assistant,
            system: systemPrompt(),
            tools,
            history: parsed.history,
            message,
            // Who it is, for whom, and today: before the question when the conversation does not say it yet.
            context: contextNote(parsed.history, company, today),
            name,
            signal: controller.signal,
            sink: { delta: (text) => send('delta', { text }), status: (label) => send('status', { label }), discard: (chars) => send('discard', { chars }) },
            log: (detail, text) => request.log.warn({ ...detail, userId: user.id, workspaceId: user.workspaceId }, text),
          })
          await recordTokens(db, user.workspaceId, reservation.day, outcome.usage)
          // A message counts once its request went out (hanging up does not give it back); see runner.ts.
          if (outcome.kind !== 'done' && !outcome.charged) await releaseMessage(db, user.workspaceId, reservation.day)
          const u = outcome.usage
          request.log.info(
            {
              userId: user.id,
              workspaceId: user.workspaceId,
              outcome: outcome.kind === 'error' ? outcome.error : outcome.kind,
              // The whole prompt as billed; `input` is only its uncached tail.
              billedInput: billedInput(u),
              input: u.input,
              cacheWrite: u.cacheWrite,
              cacheRead: u.cacheRead,
              output: u.output,
            },
            'assistant answered',
          )
          if (outcome.kind === 'aborted') return
          const left = await remainingToday(db, user.workspaceId, limits, now()).catch(() => reservation.remaining)
          if (outcome.kind === 'done') send('done', { history: outcome.history, remainingToday: left, ...(outcome.truncated ? { truncated: true } : {}) })
          else send('error', { error: outcome.error, message: outcome.message, remainingToday: left, ...(outcome.discardPartial ? { discardPartial: true } : {}) })
        } catch (err) {
          request.log.error({ err, userId: user.id, workspaceId: user.workspaceId }, 'assistant chat failed')
          send('error', { error: 'server_error', message: 'Something went wrong on the server. Try again.' })
        } finally {
          clearInterval(keepalive)
          release(user)
          if (!stream.destroyed && !stream.writableEnded) stream.end()
        }
      })()
      return reply
    } finally {
      // Refused before the stream started (quota, or an error on the way): the login is free again.
      if (!started) release(user)
    }
  })
}
