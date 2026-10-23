// The message loop against scripted clients that behave like the SDK's tool runner: the request it sends
// (model, effort, no thinking setting, fallbacks, caching, the context note, the history untouched), what it streams, how every way a message can end comes out (done, cut off, refused, too many
// steps, unparseable tool input, each kind of API error, aborted), whether the message counts against the
// day, and the tokens by kind, summed over every turn including the ones that failed part way.
import Anthropic from '@anthropic-ai/sdk'
import type { BetaToolRunnerRequestOptions } from '@anthropic-ai/sdk/lib/tools/BetaToolRunner'
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaToolRunnerParams,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages'
import { describe, expect, it } from 'vitest'
import type { AssistantClient, AssistantMessageStream, AssistantRunner, AssistantRunnerParams } from './client'
import { fakeMessage, FakeStream } from './fake'
import { contextText, systemPrompt } from './prompt'
import { billedInput } from './quota'
import type { WorkspaceReader } from './reader'
import { type ChatOutcome, fallbackEcho, MAX_ITERATIONS, runChat, runnerParams, turnTokens } from './runner'
import { assistantTools, TOOL_NAMES } from './tools'

/** A turn: a message the runner streams; an Error the runner throws before yielding; a stream to yield as it is. */
type Turn = BetaMessage | Error | (() => never) | { stream: AssistantMessageStream }

const text = (t: string) => ({ type: 'text', text: t, citations: null }) as BetaContentBlock
const toolUse = (id: string, name = 'find_people') => ({ type: 'tool_use', id, name, input: {} }) as BetaContentBlock
const thinking = (sig = 'sig') => ({ type: 'thinking', thinking: '', signature: sig }) as BetaContentBlock
const fallback = () => ({ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal' } }) as unknown as BetaContentBlock
const usageOf = (input: number, output = 0, cacheRead = 0) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead }) as BetaUsage

/** A stream that sends `events`, then fails with `err` (finalMessage rejects too), its message so far `current`. */
function failingStream(events: BetaRawMessageStreamEvent[], err: Error, current?: BetaMessage): { stream: AssistantMessageStream } {
  return {
    stream: {
      currentMessage: current,
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e
        throw err
      },
      finalMessage: () => Promise.reject(err),
    },
  }
}

const textDelta = (t: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }) as BetaRawMessageStreamEvent

/**
 * A client whose runner plays `turns` in order the way the SDK's does: each turn streams; then, unless the
 * caller pushed a turn of its own (pushMessages), the answer is appended and a turn that did not stop for
 * tools ends the run. Tools run for the conversation's last message (and `ran` records them). As in the
 * SDK, a caller that pushed a turn without tool calls makes the runner ask again, so a caller must stop it.
 */
function scripted(turns: Turn[]) {
  const calls: Array<{ params: AssistantRunnerParams; options?: BetaToolRunnerRequestOptions }> = []
  const ran: string[] = []
  let next = 0
  const client: AssistantClient = {
    beta: {
      messages: {
        toolRunner(params, options) {
          calls.push({ params, options })
          let state = { ...params, messages: JSON.parse(JSON.stringify(params.messages)) as BetaMessageParam[] }
          let mutated = false
          const runner: AssistantRunner = {
            get params(): Readonly<BetaToolRunnerParams> {
              return state
            },
            pushMessages(...messages) {
              state = { ...state, messages: [...state.messages, ...messages] }
              mutated = true
            },
            async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageStream> {
              for (let i = 0; i < (state.max_iterations ?? Infinity); i++) {
                const turn = turns[next++]
                if (turn === undefined) throw new Error('script ran out')
                if (turn instanceof Error) throw turn
                if (typeof turn === 'function') turn()
                mutated = false
                if ('stream' in turn) {
                  yield turn.stream
                  return
                }
                const msg = turn as BetaMessage
                yield new FakeStream(msg, 0, options?.signal ?? undefined)
                if (!mutated) {
                  state.messages.push({ role: 'assistant', content: msg.content as BetaMessageParam['content'] })
                  if (msg.stop_reason !== 'tool_use') return
                }
                const last = state.messages.at(-1)!
                const uses = Array.isArray(last.content) ? (last.content as BetaContentBlock[]).filter((b) => b.type === 'tool_use') : []
                if (uses.length === 0) {
                  if (!mutated) return
                  continue
                }
                ran.push(...uses.map((b) => (b as { id: string }).id))
                state.messages.push({ role: 'user', content: uses.map((b) => ({ type: 'tool_result' as const, tool_use_id: (b as { id: string }).id, content: '{"people":[]}' })) })
              }
            },
          }
          return runner
        },
      },
    },
  }
  return { client, calls, ran }
}

const reader = {} as WorkspaceReader
const base = (client: AssistantClient, extra: Partial<Parameters<typeof runChat>[0]> = {}) => {
  const deltas: string[] = []
  const statuses: string[] = []
  const discards: number[] = []
  const logs: Array<{ detail: Record<string, unknown>; text: string }> = []
  return {
    deltas,
    statuses,
    discards,
    logs,
    run: () =>
      runChat({
        client,
        config: { model: 'claude-opus-5-5', effort: 'low', maxTokens: 8000 },
        system: systemPrompt(),
        tools: assistantTools({ reader, today: '2026-10-11' }),
        history: [],
        message: 'Who starts next week?',
        name: 'Quillfin Bot',
        signal: new AbortController().signal,
        sink: { delta: (t) => deltas.push(t), status: (s) => statuses.push(s), discard: (n) => discards.push(n) },
        log: (detail, t) => logs.push({ detail, text: t }),
        ...extra,
      }),
  }
}

const done = (o: ChatOutcome) => {
  if (o.kind !== 'done') throw new Error(`expected done, got ${JSON.stringify(o)}`)
  return o
}
const headers = new Headers()

describe('the request', () => {
  it('uses the configured model, effort and max_tokens, adaptive thinking that drops blocks whose conversation changed, the default fallbacks and no forced tool choice', () => {
    const history: BetaMessageParam[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Hello' }] },
    ]
    const frozen = JSON.stringify(history)
    const note = contextText({ name: 'Quillfin' }, '2026-10-11')
    const p = runnerParams({
      config: { model: 'claude-opus-5-5', effort: 'medium', maxTokens: 9000 },
      system: systemPrompt(),
      tools: assistantTools({ reader, today: '2026-10-11' }),
      history,
      message: 'Next?',
      context: note,
    })
    expect(p).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 9000, output_config: { effort: 'medium' }, stream: true, max_iterations: MAX_ITERATIONS })
    // No thinking setting at all: adaptive is the only mode on claude-opus-5-5 (disabled or a budget is a
    // 400), and effort is the control. Nothing forces a tool or samples.
    expect(p).not.toHaveProperty('thinking')
    expect(p).not.toHaveProperty('tool_choice')
    expect(p).not.toHaveProperty('temperature')
    // The refusal fallback in its 'default' form, with exactly the beta that form takes.
    expect(p.fallbacks).toBe('default')
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01'])
    expect(p.cache_control).toEqual({ type: 'ephemeral' })
    // One system block, frozen and cached: nothing in it varies by company or day.
    expect(p.system).toEqual(systemPrompt())
    expect(p.tools.map((t) => (t as { name: string }).name)).toEqual([...TOOL_NAMES])
    // The history goes in as it came (the same objects, unchanged), then the question with the context note
    // before it as a block of its own; nothing is prefilled.
    expect(p.messages.slice(0, 2)).toEqual(history)
    expect(p.messages[0]).toBe(history[0])
    expect(p.messages[2]).toEqual({ role: 'user', content: [{ type: 'text', text: note }, { type: 'text', text: 'Next?' }] })
    expect(p.messages.at(-1)!.role).toBe('user')
    expect(JSON.stringify(history)).toBe(frozen)
    // Without a note, the question alone.
    expect(runnerParams({ config: { model: 'claude-opus-5-5', effort: 'low', maxTokens: 1 }, system: [], tools: [], history, message: 'x' }).messages[2]).toEqual({ role: 'user', content: 'x' })
  })

  it('leaves fallbacks and their beta off for a model that does not offer them, and sends no thinking setting there either', () => {
    const p = runnerParams({ config: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 1000 }, system: [], tools: [], history: [], message: 'x' })
    expect(p).not.toHaveProperty('fallbacks')
    expect(p).not.toHaveProperty('betas')
    expect(p).not.toHaveProperty('thinking')
    expect(p.output_config).toEqual({ effort: 'low' })
  })
})

describe('a message', () => {
  it('streams text and a status per tool call, and ends with the whole conversation, append-only', async () => {
    const { client, calls } = scripted([
      fakeMessage([thinking(), toolUse('t1')], 'tool_use', 100),
      fakeMessage([thinking(), text('Nobody '), text('starts next week.')], 'end_turn', 200),
    ])
    const history: BetaMessageParam[] = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }]
    const t = base(client, { history })
    const o = done(await t.run())
    expect(t.statuses).toEqual(['Looking up people'])
    expect(t.deltas.join('')).toBe('Nobody starts next week.')
    expect(o.truncated).toBe(false)
    expect(o.history.slice(0, 2)).toEqual(history)
    expect(o.history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    expect(o.history[2]).toEqual({ role: 'user', content: 'Who starts next week?' })
    expect((o.history[3].content as BetaContentBlock[])[1]).toMatchObject({ type: 'tool_use', id: 't1' })
    expect((o.history[5].content as BetaContentBlock[]).map((b) => b.type)).toEqual(['thinking', 'text', 'text'])
    expect(calls).toHaveLength(1)
    expect(calls[0].options?.signal).toBeInstanceOf(AbortSignal)
    // Tokens: both turns.
    expect(o.usage.input).toBe(300)
    expect(o.usage.output).toBeGreaterThan(0)
  })

  it('ends with an error on a refusal that says to drop the partial answer, and never runs that turn or returns it as history', async () => {
    const { client, ran } = scripted([fakeMessage([text('I can help with tha'), toolUse('t1')], 'refusal', 50)])
    const t = base(client)
    const o = await t.run()
    expect(o).toMatchObject({ kind: 'error', error: 'refused', message: expect.stringMatching(/^Quillfin Bot cannot help/), charged: true, discardPartial: true })
    expect(t.deltas.join('')).toBe('I can help with tha')
    expect(ran).toEqual([])
  })

  it('never runs a tool call that was cut off at max_tokens, and says to drop the partial answer', async () => {
    const { client, ran } = scripted([fakeMessage([text('Looking'), toolUse('t1')], 'max_tokens', 50)])
    expect(await base(client).run()).toMatchObject({ kind: 'error', error: 'truncated', discardPartial: true, charged: true })
    expect(ran).toEqual([])
  })

  it('returns a text answer cut off at max_tokens, marked as cut off', async () => {
    const { client } = scripted([fakeMessage([text('Part of an ans')], 'max_tokens', 50)])
    const o = done(await base(client).run())
    expect(o.truncated).toBe(true)
    expect((o.history.at(-1)!.content as BetaContentBlock[])[0]).toMatchObject({ text: 'Part of an ans' })
  })

  it(`stops after ${MAX_ITERATIONS} requests when the model still wants tools`, async () => {
    const { client } = scripted(Array.from({ length: MAX_ITERATIONS }, (_, i) => fakeMessage([toolUse(`t${i}`)], 'tool_use', 10)))
    const t = base(client)
    expect(await t.run()).toMatchObject({ kind: 'error', error: 'too_many_steps', charged: true })
    expect(t.statuses).toHaveLength(MAX_ITERATIONS)
  })

})

describe('a tool input that could not be parsed', () => {
  // What the SDK raises for it: a plain AnthropicError, not an API error.
  const parseError = () => new Anthropic.AnthropicError('Unable to parse tool parameter JSON from model. Error: Unexpected token')

  it('asks for the turn again, at most twice in a row, and the browser drops the text that turn had streamed', async () => {
    const half = failingStream([{ type: 'message_start', message: fakeMessage([], 'tool_use', 40) } as BetaRawMessageStreamEvent, textDelta('Let me '), textDelta('check.')], parseError())
    const ok = scripted([half, fakeMessage([text('Let me check. Fine.')], 'end_turn', 10)])
    const t = base(ok.client)
    const o = done(await t.run())
    expect(ok.calls).toHaveLength(2)
    // The retry starts from the conversation so far, still streaming.
    expect(ok.calls[1].params.messages).toEqual(ok.calls[0].params.messages)
    expect(ok.calls[1].params.stream).toBe(true)
    // 'Let me check.' (13 characters) went to the browser, which drops it before the turn streams again.
    expect(t.discards).toEqual([13])
    expect(t.deltas.join('')).toBe('Let me check.Let me check. Fine.')
    expect((o.history.at(-1)!.content as BetaContentBlock[])[0]).toMatchObject({ text: 'Let me check. Fine.' })
    const bad = scripted([parseError(), parseError(), parseError()])
    const tb = base(bad.client)
    expect(await tb.run()).toMatchObject({ kind: 'error', error: 'server_error' })
    expect(bad.calls).toHaveLength(3)
    // Nothing was streamed, so nothing to drop.
    expect(tb.discards).toEqual([])
    // A retry gets only what is left of the request budget, so retries never add requests.
    const later = scripted([fakeMessage([toolUse('t1')], 'tool_use', 10), parseError(), fakeMessage([text('Done.')], 'end_turn', 10)])
    done(await base(later.client).run())
    expect(later.calls.map((c) => c.params.max_iterations)).toEqual([MAX_ITERATIONS, MAX_ITERATIONS - 1])
    expect(later.calls[1].params.messages).toHaveLength(3) // the question, the tool call, its result
  })

  it('asks nothing again for any other error: one of its own, a TypeError, a SyntaxError', async () => {
    for (const err of [new TypeError('x is undefined'), new SyntaxError('Unexpected token'), new Error('boom')]) {
      const s = scripted([err, fakeMessage([text('never')], 'end_turn', 10)])
      const t = base(s.client)
      expect(await t.run(), err.name).toMatchObject({ kind: 'error', error: 'server_error' })
      expect(s.calls, err.name).toHaveLength(1)
      expect(t.logs[0].detail, err.name).toEqual({ error: err.name })
    }
  })
})

describe('API errors', () => {
  const status = (Cls: unknown, code: number, type: string) => new (Cls as new (...a: unknown[]) => Error)(code, { type: 'error', error: { type, message: 'm' } }, 'm', headers, type)

  it('are told apart by their typed classes and never retried here', async () => {
    const history: BetaMessageParam[] = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }]
    const cases: Array<[Error, string, BetaMessageParam[]]> = [
      [status(Anthropic.RateLimitError, 429, 'rate_limit_error'), 'upstream_busy', []],
      [status(Anthropic.InternalServerError, 529, 'overloaded_error'), 'upstream_unavailable', []],
      [status(Anthropic.AuthenticationError, 401, 'authentication_error'), 'assistant_misconfigured', []],
      [status(Anthropic.NotFoundError, 404, 'not_found_error'), 'assistant_misconfigured', []],
      [status(Anthropic.APIError, 402, 'billing_error'), 'assistant_misconfigured', []],
      // A bad request on a conversation's later question is the conversation's; on its first, the server's setup.
      [status(Anthropic.BadRequestError, 400, 'invalid_request_error'), 'bad_conversation', history],
      [status(Anthropic.BadRequestError, 400, 'invalid_request_error'), 'assistant_misconfigured', []],
      [new Anthropic.APIConnectionError({ message: 'connect ETIMEDOUT' }), 'upstream_unreachable', []],
    ]
    for (const [err, code, h] of cases) {
      const { client, calls } = scripted([err])
      const t = base(client, { history: h })
      const o = await t.run()
      expect(o, code).toMatchObject({ kind: 'error', error: code, charged: false })
      expect(calls, code).toHaveLength(1)
      expect(t.logs, code).toHaveLength(1)
      expect(t.logs[0].detail.type, code).toBe((err as InstanceType<typeof Anthropic.APIError>).type ?? null)
    }
  })

  it('reads an error event inside a stream (no status) by its type, and counts the message: the API had answered', async () => {
    const start = { type: 'message_start', message: fakeMessage([], 'end_turn', 700) } as BetaRawMessageStreamEvent
    const midStream = (type: string) => new Anthropic.APIError(undefined, { type: 'error', error: { type, message: 'm' } }, undefined, headers, type as never)
    const cases: Array<[string, string, string]> = [
      ['overloaded_error', 'upstream_unavailable', 'assistant request refused upstream'],
      ['api_error', 'upstream_unavailable', 'assistant request refused upstream'],
      ['rate_limit_error', 'upstream_busy', 'assistant request refused upstream'],
      ['something_new', 'upstream_error', 'assistant request failed'],
    ]
    for (const [type, code, logged] of cases) {
      const current = fakeMessage([], 'end_turn', 700)
      current.usage = usageOf(700, 12, 9000)
      const t = base(scripted([failingStream([start, textDelta('Kofi')], midStream(type), current)]).client)
      const o = await t.run()
      expect(o, type).toMatchObject({ kind: 'error', error: code, charged: true })
      // The billed input of the failed turn is counted, by kind.
      expect(o.usage, type).toEqual({ input: 700, cacheWrite: 0, cacheRead: 9000, output: 12 })
      expect(t.logs[0].text, type).toBe(logged)
    }
  })
})

describe('whether a message counts', () => {
  it('counts once the request went out, even when the browser left before the first event', async () => {
    // As with the real API on a long conversation, the first event takes a while: the browser leaves first.
    const controller = new AbortController()
    const slow = new FakeStream(fakeMessage([text('Hello')], 'end_turn', 40_000), 200, controller.signal)
    const { client } = scripted([{ stream: slow }])
    setTimeout(() => controller.abort(), 20)
    const o = await base(client, { signal: controller.signal }).run()
    expect(o).toEqual({ kind: 'aborted', charged: true, usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } })
  })

  it('counts the tokens of a turn the browser left part way through', async () => {
    const controller = new AbortController()
    const msg = fakeMessage([text('A long answer that streams slowly, word by word.')], 'end_turn', 3000)
    const stream = new FakeStream(msg, 5, controller.signal)
    const deltas: string[] = []
    const t = base(scripted([{ stream }]).client, {
      signal: controller.signal,
      sink: {
        delta: (d) => {
          deltas.push(d)
          if (deltas.length === 2) controller.abort()
        },
        status: () => {},
        discard: () => {},
      },
    })
    const o = await t.run()
    // message_start had reported the prompt: it is billed, so it is counted.
    expect(o).toMatchObject({ kind: 'aborted', charged: true, usage: { input: 3000, output: 0 } })
  })

  it('ends as aborted when the browser went away between turns, keeping the tokens already used', async () => {
    const controller = new AbortController()
    const { client } = scripted([
      fakeMessage([toolUse('t1')], 'tool_use', 100),
      () => {
        controller.abort()
        throw new Anthropic.APIUserAbortError()
      },
    ])
    const o = await base(client, { signal: controller.signal }).run()
    expect(o).toMatchObject({ kind: 'aborted', charged: true, usage: { input: 100 } })
  })

  it('does not count a request the API turned away with an HTTP error, or that never reached it', async () => {
    for (const err of [
      new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', headers, 'rate_limit_error'),
      new Anthropic.InternalServerError(529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 'busy', headers, 'overloaded_error'),
      new Anthropic.APIConnectionError({ message: 'connect ETIMEDOUT' }),
    ]) {
      // The SDK throws these as the yielded stream is read, before any event.
      const o = await base(scripted([failingStream([], err)]).client).run()
      expect(o, err.constructor.name).toMatchObject({ kind: 'error', charged: false, usage: { input: 0, output: 0 } })
    }
  })

  it('counts a message whose first turn was answered, whatever failed after it', async () => {
    const { client } = scripted([
      fakeMessage([toolUse('t1')], 'tool_use', 100),
      new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }, 'x', headers, 'rate_limit_error'),
    ])
    expect(await base(client).run()).toMatchObject({ kind: 'error', error: 'upstream_busy', charged: true, usage: { input: 100 } })
  })

  it('asks nothing when the browser went away before the message started', async () => {
    const controller = new AbortController()
    controller.abort()
    const { client, calls } = scripted([fakeMessage([text('never sent')], 'end_turn', 100)])
    const { deltas, run } = base(client, { signal: controller.signal })
    expect(await run()).toEqual({ kind: 'aborted', charged: false, usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } })
    expect(calls).toHaveLength(0)
    expect(deltas).toEqual([])
  })
})

describe('a turn a refusal fallback took over mid-stream', () => {
  it("echoes it in the documented form: the declined model's text stays, its thinking and tool call go, and that call never runs", async () => {
    const redacted = { type: 'redacted_thinking', data: 'opaque' } as BetaContentBlock
    const turn = fakeMessage([thinking('declined'), redacted, text('Let me look'), toolUse('declined_call'), fallback(), thinking('fallback'), text('Nobody starts next week.')], 'end_turn', 500)
    const { client, ran } = scripted([turn])
    const t = base(client)
    const o = done(await t.run())
    expect(ran).toEqual([])
    // The text streamed before the switch is part of the answer.
    expect(t.deltas.join('')).toBe('Let me lookNobody starts next week.')
    const last = o.history.at(-1)!
    expect(last.role).toBe('assistant')
    expect((last.content as BetaContentBlock[]).map((b) => b.type)).toEqual(['text', 'fallback', 'thinking', 'text'])
    // Everything kept is exactly as it came: the declined text, the fallback block, the fallback model's turn.
    expect((last.content as BetaContentBlock[])[0]).toEqual(text('Let me look'))
    expect((last.content as BetaContentBlock[])[1]).toEqual(fallback())
    expect((last.content as BetaContentBlock[])[2]).toEqual(thinking('fallback'))
    // The conversation ends with the answer (no tool call left without a result).
    expect(o.history.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it("runs only the fallback model's tool calls", async () => {
    const turn = fakeMessage([toolUse('declined_call'), fallback(), toolUse('fallback_call', 'list_jobs')], 'tool_use', 500)
    const { client, ran } = scripted([turn, fakeMessage([text('Two open jobs.')], 'end_turn', 600)])
    const t = base(client)
    const o = done(await t.run())
    expect(ran).toEqual(['fallback_call'])
    expect((o.history[1].content as BetaContentBlock[]).map((b) => (b as { id?: string }).id ?? b.type)).toEqual(['fallback', 'fallback_call'])
    expect((o.history[2].content as Array<{ tool_use_id: string }>).map((r) => r.tool_use_id)).toEqual(['fallback_call'])
  })

  it('leaves a turn alone when nothing came before the fallback block, only text did, or there is no fallback', () => {
    const a = [fallback(), thinking(), toolUse('t1')]
    const b = [text('Hm'), fallback(), thinking(), text('Done')]
    const c = [thinking(), toolUse('t1'), text('no fallback')]
    for (const content of [a, b, c]) expect(fallbackEcho(content)).toBe(content)
    // Thinking alone before the switch is left out too (the fallback model cannot read it); the input never changes.
    const d = [thinking('declined'), fallback(), text('Done')]
    const frozen = JSON.stringify(d)
    expect(fallbackEcho(d).map((x) => x.type)).toEqual(['fallback', 'text'])
    expect(JSON.stringify(d)).toBe(frozen)
    // With several fallback blocks, everything before the last one is the declined part; its text stays.
    expect(fallbackEcho([toolUse('a'), text('x'), fallback(), thinking(), toolUse('b'), fallback(), toolUse('c')]).map((x) => (x as { id?: string }).id ?? x.type)).toEqual([
      'text',
      'fallback',
      'fallback',
      'c',
    ])
  })
})

describe('turnTokens', () => {
  it('counts each kind of prompt token apart, and every attempt when a fallback ran', () => {
    const u = (extra: Partial<BetaUsage>) => ({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, iterations: null, ...extra }) as BetaUsage
    expect(turnTokens(u({}))).toEqual({ input: 10, cacheWrite: 100, cacheRead: 1000, output: 5 })
    expect(
      turnTokens(
        u({
          // The top-level fields are the attempt that served the turn, as the API reports them.
          input_tokens: 950,
          output_tokens: 40,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          iterations: [
            { type: 'message', input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 900, model: 'claude-opus-5-5', cache_creation: null },
            { type: 'fallback_message', input_tokens: 950, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'claude-opus-4-8', cache_creation: null },
          ] as BetaUsage['iterations'],
        }),
      ),
    ).toEqual({ input: 960, cacheWrite: 0, cacheRead: 900, output: 40 })
    expect(turnTokens(null)).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 })
  })

  const entry = (type: 'message' | 'fallback_message', input: number, cacheWrite: number, cacheRead: number, output: number, model = 'claude-opus-5-5') => ({
    type,
    input_tokens: input,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    model,
    cache_creation: null,
  })
  const usage = (input: number, cacheWrite: number, cacheRead: number, output: number, iterations: ReturnType<typeof entry>[] | null = null) =>
    ({ input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: output, iterations }) as BetaUsage

  it('keeps the whole billed input of a cached turn: the uncached tail, the cache write and the cache read', () => {
    // A turn with the conversation cached: 6 tokens at full price, the prompt written to and read from the cache.
    const t = turnTokens(usage(6, 650, 14_200, 380))
    expect(t).toEqual({ input: 6, cacheWrite: 650, cacheRead: 14_200, output: 380 })
    expect(billedInput(t)).toBe(14_856)
    // The same with usage.iterations: one `message` entry, the same numbers.
    expect(turnTokens(usage(6, 650, 14_200, 380, [entry('message', 6, 650, 14_200, 380)]))).toEqual(t)
  })

  it("sums every kind over each attempt of a fallback turn, the declined model's cache reads and writes included", () => {
    // The requested model read the cached prompt and declined part way; the fallback model (no cache of its own) served the turn.
    const declined = entry('message', 4, 300, 14_200, 25)
    const served = entry('fallback_message', 14_504, 0, 0, 420, 'claude-opus-5')
    const t = turnTokens(usage(14_504, 0, 0, 420, [declined, served]))
    expect(t).toEqual({ input: 14_508, cacheWrite: 300, cacheRead: 14_200, output: 445 })
    expect(billedInput(t)).toBe(29_008)
  })

  it('never counts a kind below the top-level count when usage.iterations is a stale copy from message_start', () => {
    // The final message_delta did not repeat iterations: the copy from message_start has no output yet, and
    // this one also carried no cache counts. The top-level fields, which the SDK updates, stand for those kinds.
    expect(turnTokens(usage(6, 650, 14_200, 380, [entry('message', 6, 0, 0, 1)]))).toEqual({ input: 6, cacheWrite: 650, cacheRead: 14_200, output: 380 })
  })
})

describe('the tokens of a message', () => {
  it('adds up the billed input of every turn, by kind: the live case of 12 input tokens over two requests', async () => {
    const cached = (msg: BetaMessage, input: number, cacheWrite: number, cacheRead: number) => {
      msg.usage = { ...msg.usage, input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead }
      return msg
    }
    const { client } = scripted([
      cached(fakeMessage([thinking(), toolUse('t1')], 'tool_use', 0), 6, 14_200, 0),
      cached(fakeMessage([thinking(), text('Nobody starts next week.')], 'end_turn', 0), 6, 650, 14_200),
    ])
    const o = done(await base(client).run())
    expect(o.usage).toMatchObject({ input: 12, cacheWrite: 14_850, cacheRead: 14_200 })
    expect(billedInput(o.usage)).toBe(29_062)
  })
})
