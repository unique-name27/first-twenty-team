// The real Anthropic SDK (its tool runner and message streams) driven by runner.ts against a fetch that
// answers like the Claude API, so the whole path runs without a network or a key: the request the SDK
// sends (endpoint, beta headers, credentials, body), the stream it parses, the tools it runs between turns,
// the conversation it hands back, the request ending when the chat's signal aborts, and whether the
// message counts when that happens before the first event or when the API answers with an error.
import type { BetaContentBlock, BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import type { Db } from '../db'
import { replaceWorkspace } from '../repo'
import { makeTestDb, resetDb } from '../test/helpers'
import { parseWorkspace } from '../validate'
import { anthropicClient } from './client'
import { fakeMessage, FakeStream } from './fake'
import { parseHistory } from './history'
import { contextText, systemPrompt } from './prompt'
import { WorkspaceReader } from './reader'
import { runChat } from './runner'
import { assistantTools, TOOL_NAME_SET, TOOL_NAMES } from './tools'

let db: Db
beforeAll(async () => {
  db = await makeTestDb()
  await resetDb(db)
  await replaceWorkspace(db, parseWorkspace({ db: buildSampleDB() }), null, 'default')
})
afterAll(async () => {
  await db.close()
})
const savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
afterEach(() => {
  if (savedAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
  else process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken
})

/** A message as the API streams it: the server-sent events of `msg`. */
async function sseBody(msg: BetaMessage): Promise<string> {
  let out = ''
  for await (const event of new FakeStream(msg, 0, undefined)) out += `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  return out
}

type Sent = { url: string; headers: Headers; body: Record<string, unknown> }

/** A fetch that answers each request with the next scripted message, recording what was sent. */
function apiLike(answers: BetaMessage[]): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = []
  const fetchLike = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
    const msg = answers.shift()
    if (!msg) return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'script ran out' } }), { status: 500 })
    return new Response(await sseBody(msg), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' } })
  }) as typeof fetch
  return { fetch: fetchLike, sent }
}

const toolCall = { type: 'tool_use', id: 'toolu_01', name: 'find_people', input: { query: 'kofi' } } as BetaContentBlock
const thinking = { type: 'thinking', thinking: '', signature: 'EqQBCkgIBRABGAIiQL' } as BetaContentBlock

describe('the real SDK tool runner', () => {
  it('sends the documented request, runs the tool between turns, and returns the conversation as received', async () => {
    const answer = 'It is [Kofi Boateng](#person.p-kofi).'
    const { fetch, sent } = apiLike([
      fakeMessage([thinking, toolCall], 'tool_use', 3000),
      fakeMessage([thinking, { type: 'text', text: answer, citations: null } as BetaContentBlock], 'end_turn', 3500),
    ])
    const client = anthropicClient('test-key-not-real', { fetch, maxRetries: 0 })
    const deltas: string[] = []
    const statuses: string[] = []
    const note = contextText({ name: 'Ledgerlark', assistantName: 'Lark' }, '2026-10-09')
    const outcome = await runChat({
      client,
      config: { model: 'claude-opus-5-5', effort: 'low', maxTokens: 8000 },
      system: systemPrompt(),
      tools: assistantTools({ reader: new WorkspaceReader(db, 'default'), today: '2026-10-09' }),
      history: [],
      message: 'Who is Kofi?',
      context: note,
      name: 'Lark',
      signal: new AbortController().signal,
      sink: { delta: (t) => deltas.push(t), status: (s) => statuses.push(s), discard: () => {} },
    })
    expect(outcome.kind, JSON.stringify(outcome)).toBe('done')
    if (outcome.kind !== 'done') return
    expect(statuses).toEqual(['Looking up people'])
    expect(deltas.join('')).toBe(answer)

    // Two requests to the Messages API (beta), with the betas the request needs and only the key as credential.
    expect(sent).toHaveLength(2)
    expect(sent[0].url).toMatch(/\/v1\/messages\?beta=true$/)
    expect(sent[0].headers.get('x-api-key')).toBe('test-key-not-real')
    expect(sent[0].headers.get('authorization')).toBeNull()
    const betas = (sent[0].headers.get('anthropic-beta') ?? '').split(',').map((s) => s.trim())
    // Exactly the beta of the 'default' fallback form (the array form's beta with it would be a 400).
    expect(betas).toEqual(['server-side-fallback-2026-07-01'])
    const body = sent[0].body
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      output_config: { effort: 'low' },
      fallbacks: 'default',
      stream: true,
      cache_control: { type: 'ephemeral' },
      // The context note goes before the question, as a block of its own.
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: note },
            { type: 'text', text: 'Who is Kofi?' },
          ],
        },
      ],
    })
    // The runner's own options never reach the API, and nothing forces a tool or prefills an answer.
    // No thinking setting either: claude-opus-5-5 thinks adaptively, its only mode, and effort sets how much.
    for (const key of ['max_iterations', 'betas', 'tool_choice', 'temperature', 'thinking']) expect(body, key).not.toHaveProperty(key)
    const tools = body.tools as Array<{ name: string; eager_input_streaming?: boolean; input_schema?: { type: string }; run?: unknown }>
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES])
    for (const t of tools) {
      expect(t.eager_input_streaming).toBe(true)
      expect(t.input_schema?.type).toBe('object')
      expect(t).not.toHaveProperty('run')
    }
    // One system block, the frozen prompt, cached.
    expect(body.system).toEqual(systemPrompt())

    // The second request is the first one plus the answer as received and the tool's real result.
    const second = sent[1].body.messages as Array<{ role: string; content: unknown }>
    expect(second.slice(0, 1)).toEqual(body.messages)
    expect(second[1]).toEqual({ role: 'assistant', content: [thinking, toolCall] })
    const result = (second[2].content as Array<{ type: string; tool_use_id: string; content: string }>)[0]
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_01' })
    expect(JSON.parse(result.content).people.map((p: { link: string }) => p.link)).toEqual(['#person.p-kofi'])
    expect(sent[1].body.tools).toEqual(body.tools)
    expect(sent[1].body.system).toEqual(body.system)

    // The conversation handed back is what the API saw, plus the final answer, and it passes as a history.
    expect(outcome.history.slice(0, 3)).toEqual(second)
    expect(outcome.history[3]).toMatchObject({ role: 'assistant', content: [thinking, { type: 'text', text: answer }] })
    expect(parseHistory(outcome.history, TOOL_NAME_SET).ok).toBe(true)
    expect(outcome.usage.input).toBe(6500)
  })

  it('sends only the configured key, even when ANTHROPIC_AUTH_TOKEN is in the environment', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'leftover-token-not-real'
    const { fetch, sent } = apiLike([fakeMessage([{ type: 'text', text: 'Hi.', citations: null } as BetaContentBlock], 'end_turn', 10)])
    const outcome = await runChat({
      client: anthropicClient('test-key-not-real', { fetch, maxRetries: 0 }),
      config: { model: 'claude-opus-5-5', effort: 'low', maxTokens: 8000 },
      system: systemPrompt(),
      tools: [],
      history: [],
      message: 'Hi',
      name: 'Lark',
      signal: new AbortController().signal,
      sink: { delta: () => {}, status: () => {}, discard: () => {} },
    })
    expect(outcome.kind).toBe('done')
    expect(sent[0].headers.get('x-api-key')).toBe('test-key-not-real')
    expect(sent[0].headers.get('authorization')).toBeNull()
  })

  it('ends the request when the chat is aborted', async () => {
    const controller = new AbortController()
    let aborted = false
    const fetchLike = (async (_input: string | URL | Request, init?: RequestInit) => {
      // Start an answer, then go quiet until the request is aborted.
      const first = (await sseBody(fakeMessage([{ type: 'text', text: 'Thinking it over', citations: null } as BetaContentBlock], 'end_turn', 10))).split('event: content_block_stop')[0]
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(first))
          // As a real fetch does: aborting the request's signal errors the body being read.
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            c.error(new DOMException('This operation was aborted', 'AbortError'))
          })
          setTimeout(() => controller.abort(), 20)
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const outcome = await runChat({
      client: anthropicClient('test-key-not-real', { fetch: fetchLike, maxRetries: 0 }),
      config: { model: 'claude-opus-5-5', effort: 'low', maxTokens: 8000 },
      system: systemPrompt(),
      tools: assistantTools({ reader: new WorkspaceReader(db, 'default'), today: '2026-10-09' }),
      history: [],
      message: 'Hi',
      name: 'Lark',
      signal: controller.signal,
      sink: { delta: () => {}, status: () => {}, discard: () => {} },
    })
    // The prompt message_start reported is billed, so it is counted.
    expect(outcome).toMatchObject({ kind: 'aborted', charged: true, usage: { input: 10 } })
    expect(aborted).toBe(true)
  })

  /** A chat on the real SDK with `fetch`, `signal` and history as given. */
  const chatWith = (fetchLike: typeof fetch, signal: AbortSignal, history: Parameters<typeof runChat>[0]['history'] = []) =>
    runChat({
      client: anthropicClient('test-key-not-real', { fetch: fetchLike, maxRetries: 0 }),
      config: { model: 'claude-opus-5-5', effort: 'low', maxTokens: 8000 },
      system: systemPrompt(),
      tools: [],
      history,
      message: 'Who starts next week?',
      name: 'Lark',
      signal,
      sink: { delta: () => {}, status: () => {}, discard: () => {} },
    })

  it('counts a message the browser left before the first event: the request had already gone to the API', async () => {
    // The API takes a while before its first event (it does for a long conversation); the browser leaves at once.
    const controller = new AbortController()
    let requests = 0
    const fetchLike = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests += 1
      const body = await sseBody(fakeMessage([{ type: 'text', text: 'Hello', citations: null } as BetaContentBlock], 'end_turn', 40_000))
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          const t = setTimeout(() => {
            c.enqueue(new TextEncoder().encode(body))
            c.close()
          }, 1500)
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(t)
            c.error(new DOMException('This operation was aborted', 'AbortError'))
          })
          setTimeout(() => controller.abort(), 20)
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    const outcome = await chatWith(fetchLike, controller.signal, [
      { role: 'user', content: 'x'.repeat(50_000) },
      { role: 'assistant', content: 'ok' },
    ])
    expect(requests).toBe(1)
    expect(outcome).toMatchObject({ kind: 'aborted', charged: true })
  })

  it("counts the whole billed input the SDK's stream reports, cache writes and reads apart, over every attempt", async () => {
    /** A message whose usage is `usage` (message_start carries all of it, iterations included). */
    const withUsage = (msg: BetaMessage, usage: Partial<BetaMessage['usage']>) => {
      msg.usage = { ...msg.usage, ...usage }
      return msg
    }
    const iteration = (type: string, input: number, cacheWrite: number, cacheRead: number, output: number) => ({
      type,
      input_tokens: input,
      cache_creation_input_tokens: cacheWrite,
      cache_read_input_tokens: cacheRead,
      output_tokens: output,
      model: 'claude-opus-5-5',
      cache_creation: null,
    })
    const reply = (t: string) => [{ type: 'text', text: t, citations: null } as BetaContentBlock]
    const { fetch } = apiLike([
      // A cached question: 6 tokens at full price. The final message_delta does not repeat iterations, so the
      // copy from message_start (no output yet) stays in the message the SDK hands back.
      withUsage(fakeMessage(reply('Nobody starts next week.'), 'end_turn', 0), {
        input_tokens: 6,
        cache_creation_input_tokens: 650,
        cache_read_input_tokens: 14_200,
        output_tokens: 380,
        iterations: [iteration('message', 6, 650, 14_200, 0)] as BetaMessage['usage']['iterations'],
      }),
      // A turn a refusal fallback served: the declined attempt read the cache, the fallback model did not.
      withUsage(fakeMessage(reply('Here is the policy.'), 'end_turn', 0), {
        input_tokens: 14_504,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 420,
        iterations: [iteration('message', 4, 300, 14_200, 25), iteration('fallback_message', 14_504, 0, 0, 420)] as BetaMessage['usage']['iterations'],
      }),
    ])
    const first = await chatWith(fetch, new AbortController().signal)
    expect(first).toMatchObject({ kind: 'done', usage: { input: 6, cacheWrite: 650, cacheRead: 14_200, output: 380 } })
    const second = await chatWith(fetch, new AbortController().signal)
    expect(second).toMatchObject({ kind: 'done', usage: { input: 14_508, cacheWrite: 300, cacheRead: 14_200, output: 445 } })
  })

  it('does not count a request the API refused with an HTTP error, and counts one whose stream broke with an error event', async () => {
    const refusing = (async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'request-id': 'req_429' },
      })) as unknown as typeof fetch
    expect(await chatWith(refusing, new AbortController().signal)).toMatchObject({ kind: 'error', error: 'upstream_busy', charged: false })

    // A stream that starts (its prompt is billed), then carries an overloaded_error event.
    const start = (await sseBody(fakeMessage([{ type: 'text', text: 'Kofi', citations: null } as BetaContentBlock], 'end_turn', 2500))).split('event: content_block_stop')[0]
    const overloaded = (async () =>
      new Response(`${start}event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch
    const broken = await chatWith(overloaded, new AbortController().signal)
    // Told apart by its type (an event has no status): Claude is busy, not a fault of this server.
    expect(broken).toMatchObject({ kind: 'error', error: 'upstream_unavailable', charged: true, usage: { input: 2500 } })
  })

  it('says a first question refused as a bad request is a setup problem, not the conversation', async () => {
    const badBeta = (async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Unexpected value(s) `x` for the `anthropic-beta` header.' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    expect(await chatWith(badBeta, new AbortController().signal)).toMatchObject({ kind: 'error', error: 'assistant_misconfigured', charged: false })
    expect(
      await chatWith(badBeta, new AbortController().signal, [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
      ]),
    ).toMatchObject({ kind: 'error', error: 'bad_conversation' })
  })
})
