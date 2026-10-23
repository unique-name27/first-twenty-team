// ASSISTANT_FAKE=1: a scripted stand-in for the Claude API, for development and tests (a production server
// refuses to start with it). It mirrors what runner.ts and the app rely on from the SDK's tool runner: one
// message stream per turn with the same events (message_start, content blocks with their deltas,
// message_delta with the stop reason and usage, message_stop), the message so far (currentMessage) while a
// turn streams, a thinking block with a signature like the real model's, tools that really run against the
// workspace, the conversation in runner.params.messages (pushMessages takes the place of the runner's own
// copy of a turn, as in the SDK), and the request's AbortSignal ending the stream.
//
// A message that mentions who, people or start makes it call find_people (the chat shows "Looking up
// people"), then answer with a link to the first person found. Anything else gets an echo. No question
// leaves the server.
import Anthropic from '@anthropic-ai/sdk'
import type { BetaToolRunnerRequestOptions } from '@anthropic-ai/sdk/lib/tools/BetaToolRunner'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError'
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaStopReason,
  BetaToolResultBlockParam,
  BetaToolRunnerParams,
} from '@anthropic-ai/sdk/resources/beta/messages'
import { questionTexts } from '../../../src/domain/assistant'
import type { AssistantClient, AssistantMessageStream, AssistantRunner, AssistantRunnerParams } from './client'

export type FakeOptions = {
  /** Milliseconds between streamed pieces (default 15, so the chat visibly streams; tests pass 0). */
  delayMs?: number
  /** Called with each run's request and signal (tests). */
  onRun?: (params: AssistantRunnerParams, signal: AbortSignal | undefined) => void
}

export const FAKE_MODEL = 'fake-scripted-model'
const PEOPLE_QUESTION = /\b(who|people|start)/i

const wait = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Anthropic.APIUserAbortError())
    if (ms <= 0) return resolve()
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Anthropic.APIUserAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** What the person typed in the conversation's last user message (its text blocks without the context note, or the string). */
function lastUserText(messages: BetaMessageParam[]): string {
  const m = [...messages].reverse().find((x) => x.role === 'user')
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  return questionTexts(m.content.flatMap((b) => (b.type === 'text' ? [b.text] : []))).join(' ')
}

let counter = 0
const nextId = (prefix: string) => `${prefix}_fake_${Date.now().toString(36)}${(counter++).toString(36)}`

/** A finished message as the API returns it (tests build turns with it too). */
export function fakeMessage(content: BetaContentBlock[], stopReason: BetaStopReason, inputTokens: number): BetaMessage {
  const output = Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
  return {
    id: nextId('msg'),
    type: 'message',
    role: 'assistant',
    model: FAKE_MODEL,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: 'standard',
      speed: 'standard',
    },
  } as unknown as BetaMessage
}

/** One turn as the SDK streams it: the events of `msg`, text in small pieces. */
export class FakeStream implements AssistantMessageStream {
  #current: BetaMessage | undefined

  constructor(
    private readonly msg: BetaMessage,
    private readonly delayMs: number,
    private readonly signal: AbortSignal | undefined,
  ) {}

  /** Like the SDK's: the message from its message_start on, until the turn ends well (its usage: input, then output). */
  get currentMessage(): BetaMessage | undefined {
    return this.#current
  }

  async *[Symbol.asyncIterator](): AsyncIterator<BetaRawMessageStreamEvent> {
    const { msg, delayMs, signal } = this
    await wait(delayMs, signal)
    this.#current = { ...msg, content: [], stop_reason: null, usage: { ...msg.usage, output_tokens: 0 } }
    yield { type: 'message_start', message: { ...msg, content: [], stop_reason: null } } as BetaRawMessageStreamEvent
    for (const [index, block] of msg.content.entries()) {
      await wait(delayMs, signal)
      if (block.type === 'text') {
        yield { type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } } as BetaRawMessageStreamEvent
        for (const piece of block.text.match(/\S+\s*|\s+/g) ?? []) {
          await wait(delayMs, signal)
          yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } } as BetaRawMessageStreamEvent
        }
      } else if (block.type === 'thinking') {
        yield { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } } as BetaRawMessageStreamEvent
        yield { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } } as BetaRawMessageStreamEvent
      } else if (block.type === 'tool_use') {
        yield { type: 'content_block_start', index, content_block: { ...block, input: {} } } as BetaRawMessageStreamEvent
        yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } } as BetaRawMessageStreamEvent
      }
      yield { type: 'content_block_stop', index } as BetaRawMessageStreamEvent
    }
    await wait(delayMs, signal)
    if (this.#current) this.#current = { ...this.#current, stop_reason: msg.stop_reason, usage: { ...this.#current.usage, output_tokens: msg.usage.output_tokens } }
    yield {
      type: 'message_delta',
      delta: { stop_reason: msg.stop_reason, stop_sequence: null, stop_details: null, container: null },
      usage: {
        output_tokens: msg.usage.output_tokens,
        input_tokens: msg.usage.input_tokens,
        cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
        fallback_credit: null,
        iterations: null,
      },
      context_management: null,
    } as BetaRawMessageStreamEvent
    yield { type: 'message_stop' } as BetaRawMessageStreamEvent
    this.#current = undefined
  }

  async finalMessage(): Promise<BetaMessage> {
    if (this.signal?.aborted) throw new Anthropic.APIUserAbortError()
    return this.msg
  }
}

/** Runs one tool call the way the SDK's runner does: parse the input, run, errors become is_error results. */
async function runTool(tools: BetaToolRunnerParams['tools'], call: { id: string; name: string; input: unknown }, signal: AbortSignal | undefined): Promise<BetaToolResultBlockParam> {
  const tool = tools.find((t): t is BetaRunnableTool => 'run' in t && t.name === call.name)
  if (!tool) return { type: 'tool_result', tool_use_id: call.id, content: `Error: Tool '${call.name}' not found`, is_error: true }
  try {
    const input = tool.parse(call.input)
    const content = await tool.run(input, { toolUse: call as never, toolUseBlock: call as never, signal: signal ?? undefined })
    return { type: 'tool_result', tool_use_id: call.id, content }
  } catch (err) {
    const content = err instanceof ToolError ? err.content : `Error: ${err instanceof Error ? err.message : String(err)}`
    return { type: 'tool_result', tool_use_id: call.id, content, is_error: true }
  }
}

/** The first `link` and `name` of a find_people result, if it found anyone. */
function firstPerson(result: BetaToolResultBlockParam): { name: string; link: string } | null {
  if (result.is_error || typeof result.content !== 'string') return null
  try {
    const parsed = JSON.parse(result.content) as { people?: Array<{ name?: unknown; link?: unknown }> }
    const p = parsed.people?.find((x) => typeof x.name === 'string' && typeof x.link === 'string' && x.link.startsWith('#'))
    return p ? { name: p.name as string, link: p.link as string } : null
  } catch {
    return null
  }
}

const thinking = (): BetaContentBlock => ({ type: 'thinking', thinking: '', signature: `fake-signature-${nextId('sig')}` }) as BetaContentBlock

class FakeRunner implements AssistantRunner {
  #params: AssistantRunnerParams
  /** The caller appended to the conversation during the turn just yielded (pushMessages). */
  #mutated = false

  constructor(
    params: AssistantRunnerParams,
    private readonly signal: AbortSignal | undefined,
    private readonly delayMs: number,
  ) {
    // Like the SDK: the runner works on its own copy of the conversation.
    this.#params = { ...params, messages: JSON.parse(JSON.stringify(params.messages)) as BetaMessageParam[] }
  }

  get params(): Readonly<BetaToolRunnerParams> {
    return this.#params
  }

  pushMessages(...messages: BetaMessageParam[]): void {
    this.#params = { ...this.#params, messages: [...this.#params.messages, ...messages] }
    this.#mutated = true
  }

  /** Yields one turn; afterwards the conversation holds it (the runner's copy, or what the caller pushed instead). */
  async *#turn(msg: BetaMessage): AsyncGenerator<AssistantMessageStream, BetaMessageParam> {
    this.#mutated = false
    yield new FakeStream(msg, this.delayMs, this.signal)
    if (!this.#mutated) this.#params.messages.push({ role: 'assistant', content: msg.content as BetaMessageParam['content'] })
    return this.#params.messages.at(-1)!
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageStream> {
    const question = lastUserText(this.#params.messages).trim()
    const turn = (content: BetaContentBlock[], stop: BetaStopReason) => fakeMessage(content, stop, Math.round(50 + JSON.stringify(this.#params.messages).length / 4))
    if (PEOPLE_QUESTION.test(question) && (this.#params.max_iterations ?? 2) >= 2) {
      const call = { type: 'tool_use' as const, id: nextId('toolu'), name: 'find_people', input: {} }
      const kept = yield* this.#turn(turn([thinking(), call as BetaContentBlock], 'tool_use'))
      // Tools run for the turn as the conversation holds it.
      const calls = Array.isArray(kept.content) ? kept.content.filter((b) => b.type === 'tool_use') : []
      if (calls.length === 0) return
      const result = await runTool(this.#params.tools, call, this.signal)
      this.#params.messages.push({ role: 'user', content: [result] })
      const person = firstPerson(result)
      const text = person
        ? `The first person on the list is [${person.name}](${person.link}). This is a scripted answer: ASSISTANT_FAKE is on, so nothing went to Claude.`
        : 'I found no one in the records. This is a scripted answer: ASSISTANT_FAKE is on, so nothing went to Claude.'
      yield* this.#turn(turn([thinking(), { type: 'text', text, citations: null } as BetaContentBlock], 'end_turn'))
      return
    }
    const echo = question.length > 200 ? `${question.slice(0, 197)}...` : question
    yield* this.#turn(
      turn(
        [thinking(), { type: 'text', text: `You asked: "${echo}". This is a scripted answer: ASSISTANT_FAKE is on, so nothing went to Claude.`, citations: null } as BetaContentBlock],
        'end_turn',
      ),
    )
  }
}

/** The scripted client (see the top of this file). */
export function fakeAssistantClient(options: FakeOptions = {}): AssistantClient {
  const delayMs = options.delayMs ?? 15
  return {
    beta: {
      messages: {
        toolRunner(params: AssistantRunnerParams, requestOptions?: BetaToolRunnerRequestOptions): AssistantRunner {
          options.onRun?.(params, requestOptions?.signal ?? undefined)
          return new FakeRunner(params, requestOptions?.signal ?? undefined, delayMs)
        },
      },
    },
  }
}
