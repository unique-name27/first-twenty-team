// One message to the assistant, start to finish: the SDK's tool runner (client.beta.messages.toolRunner with
// stream: true) asks the model, runs the tools it calls, and asks again until it answers, at most
// MAX_ITERATIONS requests. Text streams out as it arrives (sink.delta) and each tool call as a status line
// (sink.status). Follows the streaming tool-runner pattern of the Claude API docs:
// - the model, effort and max_tokens come from the config; `thinking` is left out (on claude-opus-5-5
//   adaptive thinking is the only mode, and disabling it or giving it a budget is a 400), so effort alone
//   sets how much the model thinks; no assistant prefill, no forced tool_choice (auto, the default);
// - each turn's stop_reason is checked before its tools run: a refusal ends the message, and a tool call cut
//   off at max_tokens never runs (the input may parse but be incomplete); a text answer cut off at
//   max_tokens is returned, marked as cut off;
// - a tool input the SDK cannot parse at all (a plain AnthropicError, not an API error) rejects the
//   iteration: the turn is asked again (at most twice in a row) on a new runner built from runner.params,
//   which holds the conversation so far, and the browser first drops the text that turn had streamed
//   (sink.discard), since the turn comes again;
// - API errors are told apart by their typed classes (rate limits, overload and outages, a bad request,
//   a bad key, billing) and never retried here (the SDK already retried 429, 5xx and dropped connections
//   twice);
// - the conversation is append-only: the history the browser sent goes in as it was, the runner appends
//   each answer exactly as received, and 'done' hands back runner.params.messages. The one exception is the
//   documented echo form of a turn a refusal fallback took over mid-stream: the declined model's thinking,
//   redacted thinking and tool calls before the last `fallback` block are left out (its text stays), and
//   those tool calls never run (fallbackEcho).
// Refusals are retried server-side on the model Anthropic recommends for the refusal's category
// (fallbacks: 'default', beta server-side-fallback-2026-07-01) on the models that offer it.
//
// Preserved thinking: the thinking blocks a conversation carries are tied to the system prompt, the tools
// and every earlier message they were written under. The server never changes those under a running
// conversation (prompt.ts: a frozen system prompt, the date and names in a context note in the
// conversation, a fixed tool list). Should a deploy change them anyway, the API refuses a later question of
// an older conversation (400), which comes out as bad_conversation: the app starts a new one.
//
// Tokens (ChatOutcome `usage`, recorded by quota.ts recordTokens): the whole billed input of every request
// the message made, failed ones included, each kind apart (turnTokens): input_tokens is only the uncached
// tail after the last cache breakpoint, so most of a prompt shows as cache writes and cache reads.
//
// Counting (ChatOutcome `charged`): a message counts against the day once a request went out for it (the
// SDK sends the request as the runner yields its turn), whether or not the browser stays to read the
// answer. It does not count when nothing was sent, or when the API turned the request away with an HTTP
// error (or could not be reached) before answering, which is not billed.
import Anthropic from '@anthropic-ai/sdk'
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool'
import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta'
import type { BetaContentBlock, BetaMessage, BetaMessageParam, BetaTextBlockParam, BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages'
import type { AssistantConfig } from '../config'
import type { AssistantClient, AssistantMessageStream, AssistantRunner, AssistantRunnerParams } from './client'
import { questionTurn } from './prompt'
import { NO_TOKENS, type TokenCounts } from './quota'
import { toolStatus } from './tools'

/** Requests to the model per message (each tool round is one more). */
export const MAX_ITERATIONS = 8
/** Times in a row a turn is asked again after a tool input that could not be parsed. */
const MAX_JSON_RETRIES = 2

/** Models whose requests carry fallbacks: 'default' (the Claude API docs: Opus 5.5 and 5, Fable 5 and 5.1, Sonnet 5.5). */
export const FALLBACK_MODELS: ReadonlySet<string> = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-sonnet-5-5'])
/** The beta for fallbacks: 'default' (the array form takes a different one; pairing them wrong is a 400). */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export type ChatSink = {
  delta(text: string): void
  status(label: string): void
  /** Drop the last `chars` characters of answer text sent (a turn being asked again streams them anew). */
  discard(chars: number): void
}
export type ChatUsage = TokenCounts
export type ChatOutcome =
  | { kind: 'done'; history: BetaMessageParam[]; usage: ChatUsage; truncated: boolean }
  | { kind: 'error'; error: string; message: string; usage: ChatUsage; charged: boolean; discardPartial: boolean }
  | { kind: 'aborted'; usage: ChatUsage; charged: boolean }

export type ChatRequest = {
  client: AssistantClient
  config: Pick<AssistantConfig, 'model' | 'effort' | 'maxTokens'>
  system: BetaTextBlockParam[]
  tools: BetaRunnableTool[]
  /** The validated history (history.ts), sent as it came. */
  history: BetaMessageParam[]
  message: string
  /** The context note that goes before the question (prompt.ts contextNote), or null/absent for none. */
  context?: string | null
  /** The assistant's display name, for the error messages. */
  name: string
  signal: AbortSignal
  sink: ChatSink
  /** Logs a failure (never with message content). */
  log?: (detail: Record<string, unknown>, text: string) => void
}

/** A tool call cut off at max_tokens: its input may be incomplete, so it never runs. */
class TruncatedToolInput extends Error {}

/** The request every message starts from. */
export function runnerParams(req: Pick<ChatRequest, 'config' | 'system' | 'tools' | 'history' | 'message' | 'context'>): AssistantRunnerParams {
  const fallbacks = FALLBACK_MODELS.has(req.config.model)
  const betas: AnthropicBeta[] = [FALLBACK_BETA]
  return {
    model: req.config.model,
    max_tokens: req.config.maxTokens,
    // No `thinking`: claude-opus-5-5 always thinks adaptively. Effort, set explicitly (that model's default
    // would be medium), is the control for how much.
    output_config: { effort: req.config.effort },
    system: req.system,
    tools: req.tools,
    messages: [...req.history, questionTurn(req.message, req.context ?? null)],
    // The growing conversation is cached too (the system prompt carries its own breakpoint).
    cache_control: { type: 'ephemeral' },
    ...(fallbacks ? { betas, fallbacks: 'default' as const } : {}),
    max_iterations: MAX_ITERATIONS,
    stream: true,
  }
}

const addTokens = (a: ChatUsage, b: ChatUsage): ChatUsage => ({
  input: a.input + b.input,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
})

type UsageLike = { input_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null; output_tokens?: number | null }

/**
 * Every token a turn used, by kind: the billed input as input_tokens (the uncached tail),
 * cache_creation_input_tokens and cache_read_input_tokens, and the output. Summed over each attempt in
 * usage.iterations when present (a refusal fallback adds one: the declined attempt's `message` entry, then
 * the `fallback_message` that served the turn), else the totals.
 *
 * The top-level fields cover the attempt that produced the message, so the sum over every attempt is never
 * below them, kind by kind. Each kind is at least its top-level count all the same: a stream whose final
 * message_delta does not repeat `iterations` leaves the copy from message_start in place (the SDK only
 * overwrites what the event carries), and that copy's output is from before the turn wrote anything.
 */
export function turnTokens(usage: BetaUsage | null | undefined): ChatUsage {
  if (!usage) return { ...NO_TOKENS }
  const one = (u: UsageLike): ChatUsage => ({
    input: u.input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  })
  const top = one(usage)
  const attempts = (usage.iterations ?? []).filter((i): i is Extract<typeof i, { input_tokens: number; output_tokens: number }> => 'input_tokens' in i && 'output_tokens' in i)
  if (attempts.length === 0) return top
  const all = attempts.map(one).reduce(addTokens, { ...NO_TOKENS })
  return {
    input: Math.max(all.input, top.input),
    cacheWrite: Math.max(all.cacheWrite, top.cacheWrite),
    cacheRead: Math.max(all.cacheRead, top.cacheRead),
    output: Math.max(all.output, top.output),
  }
}

/** Blocks of the declined model's partial output that echo back (the rest before the last `fallback` block does not). */
const ECHOED_BEFORE_FALLBACK: ReadonlySet<string> = new Set(['text', 'fallback'])

/**
 * The turn as it goes back into the conversation. A turn a server-side refusal fallback took over
 * mid-stream keeps the declined model's partial output before the last `fallback` block; per "Echoing
 * fallback turns back" in the Claude API docs, its thinking, redacted_thinking and tool_use blocks (and any
 * other model-internal block) are left out, so those tool calls never run, while its text, the fallback
 * blocks and everything after the boundary echo as they came. Returns `content` itself when nothing is
 * left out (every other turn: no fallback, or one before any output, which comes first).
 */
export function fallbackEcho(content: BetaContentBlock[]): BetaContentBlock[] {
  const boundary = content.map((b) => b.type).lastIndexOf('fallback')
  if (boundary <= 0 || content.slice(0, boundary).every((b) => ECHOED_BEFORE_FALLBACK.has(b.type))) return content
  return content.filter((b, i) => i >= boundary || ECHOED_BEFORE_FALLBACK.has(b.type))
}

/** An error response from the API (an HTTP status), as opposed to an error event inside a stream. */
const isHttpError = (err: unknown): boolean => err instanceof Anthropic.APIError && typeof err.status === 'number'

/**
 * The error event for an API failure (typed classes, most specific first). `fresh`: the conversation had
 * no earlier turns, so a refused request cannot be the conversation's fault.
 */
function apiFailure(err: unknown, name: string, fresh: boolean): { error: string; message: string; serious: boolean } {
  const misconfigured = { error: 'assistant_misconfigured', message: `${name} is not set up correctly on this server. Tell whoever runs it.`, serious: true }
  const busy = { error: 'upstream_busy', message: 'Claude has too many requests right now. Try again in a minute.', serious: false }
  const unavailable = { error: 'upstream_unavailable', message: 'Claude is not available right now. Try again in a minute.', serious: false }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError) return misconfigured
  if (err instanceof Anthropic.RateLimitError) return busy
  if (err instanceof Anthropic.BadRequestError) {
    // A first question carries nothing of a conversation: the request itself is wrong (a beta the
    // organization lacks, an effort or setting the model does not take). Starting over would fail the same way.
    if (fresh) return misconfigured
    return { error: 'bad_conversation', message: 'This conversation cannot go on. Start a new conversation.', serious: true }
  }
  if (err instanceof Anthropic.InternalServerError) return unavailable
  if (err instanceof Anthropic.APIConnectionError) {
    return { error: 'upstream_unreachable', message: 'The server could not reach Claude. Try again in a minute.', serious: true }
  }
  if (err instanceof Anthropic.APIError) {
    // 402 billing_error: the organization's credit or payment, the owner's to fix.
    if (err.status === 402) return misconfigured
    if (err.status === 413) return { error: 'bad_conversation', message: 'This conversation is too long to go on. Start a new conversation.', serious: false }
    // An error event inside a stream has no status; its type says what happened.
    if (err.status === undefined && (err.type === 'overloaded_error' || err.type === 'api_error')) return unavailable
    if (err.status === undefined && err.type === 'rate_limit_error') return busy
    return { error: 'upstream_error', message: 'Claude could not answer. Try again in a minute.', serious: true }
  }
  return { error: 'server_error', message: 'Something went wrong on the server. Try again.', serious: true }
}

/** Runs one message (see the top of this file). Never throws: every ending is an outcome. */
export async function runChat(req: ChatRequest): Promise<ChatOutcome> {
  const { client, signal, sink, name } = req
  let usage: ChatUsage = { ...NO_TOKENS }
  /** A request went out to the API (the SDK sends it as the runner yields its turn). */
  let sent = false
  /** The API answered a request with a stream (an event came): that request is billed. */
  let answered = false
  let last: BetaMessage | null = null
  let refused = false
  /** The conversation already ends with the final answer (a fallback turn appended here, with no tools to run). */
  let finished = false
  /** Requests made so far, failed ones included: a retry gets only what is left of MAX_ITERATIONS. */
  let requests = 0
  /** The turn streaming now, the characters of text it sent the browser, and whether its tokens are counted. */
  let turn: AssistantMessageStream | null = null
  let turnChars = 0
  let turnCounted = false
  // The browser left before the message started: nothing is asked.
  if (signal.aborted) return { kind: 'aborted', usage, charged: false }
  const options = { signal }
  let runner: AssistantRunner = client.beta.messages.toolRunner(runnerParams(req), options)

  /** What a turn that failed part way had used: its message so far (finalMessage() rejects for it). */
  const countFailedTurn = () => {
    if (turn && !turnCounted) usage = addTokens(usage, turnTokens(turn.currentMessage?.usage))
    turnCounted = true
  }
  const fail = (error: string, message: string, o: { charged?: boolean; discardPartial?: boolean } = {}): ChatOutcome => ({
    kind: 'error',
    error,
    message,
    usage,
    charged: o.charged ?? sent,
    discardPartial: o.discardPartial ?? false,
  })
  const aborted = (): ChatOutcome => {
    countFailedTurn()
    // A request that went out counts, read or not.
    return { kind: 'aborted', usage, charged: sent }
  }
  const tooManySteps = () => fail('too_many_steps', `${name} needed more lookups than one question allows. Ask a narrower question.`)

  for (let attempt = 0; ; attempt++) {
    try {
      // Outer loop: one stream per model turn. Inner loop: that turn's events.
      for await (const stream of runner) {
        requests += 1
        sent = true
        turn = stream
        turnChars = 0
        turnCounted = false
        for await (const event of stream) {
          answered = true
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') sink.status(toolStatus(event.content_block.name))
          else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            turnChars += event.delta.text.length
            sink.delta(event.delta.text)
          }
        }
        const message = await stream.finalMessage()
        attempt = 0 // the turn completed; the retry cap counts failures in a row
        last = message
        usage = addTokens(usage, turnTokens(message.usage))
        turnCounted = true
        // The turn is done: only the next turn's text could ever be asked again.
        turnChars = 0
        // A refusal can cut a tool call off mid-input: that turn's tools never run.
        if (message.stop_reason === 'refusal') {
          refused = true
          break
        }
        const content = fallbackEcho(message.content)
        const hasToolUse = content.some((b) => b.type === 'tool_use')
        if (message.stop_reason === 'max_tokens' && hasToolUse) throw new TruncatedToolInput()
        if (content !== message.content) {
          // The SDK's intervention hook: this turn goes in in its echo form, and the runner runs only the
          // fallback model's tool calls (none: the answer is complete).
          runner.pushMessages({ role: 'assistant', content: content as BetaMessageParam['content'] })
          if (!hasToolUse) {
            finished = true
            break
          }
        }
      }
      break
    } catch (err) {
      if (signal.aborted) return aborted()
      countFailedTurn()
      if (err instanceof TruncatedToolInput) return fail('truncated', `${name} ran out of room for that answer. Ask a narrower question.`, { discardPartial: true })
      // The SDK reports a tool input it cannot parse as a plain AnthropicError; nothing else is asked again.
      const unparseableInput = err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError)
      if (!unparseableInput || attempt >= MAX_JSON_RETRIES) {
        const f = apiFailure(err, name, req.history.length === 0)
        // Never the error's message: a parse error can quote what the model wrote.
        const detail = err instanceof Anthropic.APIError ? { status: err.status, type: err.type, requestId: err.requestID } : { error: err instanceof Error ? err.name : typeof err }
        req.log?.(detail, f.serious ? 'assistant request failed' : 'assistant request refused upstream')
        // Turned away before any answer (an HTTP error, or Claude not reached): not billed, so not counted.
        const turnedAway = !answered && (isHttpError(err) || err instanceof Anthropic.APIConnectionError)
        return fail(f.error, f.message, { charged: sent && !turnedAway })
      }
      if (requests >= MAX_ITERATIONS) return tooManySteps()
      // The turn is asked again from the conversation so far, with what is left of the request budget. The
      // browser drops the text it had streamed first: the new turn writes its own.
      if (turnChars > 0) sink.discard(turnChars)
      turnChars = 0
      turn = null
      runner = client.beta.messages.toolRunner({ ...runner.params, max_iterations: MAX_ITERATIONS - requests, stream: true }, options)
    }
  }

  if (signal.aborted) return aborted()
  if (refused) return fail('refused', `${name} cannot help with that request. Ask it another way, or start a new conversation.`, { discardPartial: true })
  if (!last) return fail('server_error', 'Something went wrong on the server. Try again.')
  // The runner stopped at its request budget while the model still wanted tools.
  if (last.stop_reason === 'tool_use' && !finished) return tooManySteps()
  // A text answer cut off at max_tokens (thinking counts toward it) is kept, and said to be cut off.
  return { kind: 'done', history: runner.params.messages as BetaMessageParam[], usage, truncated: last.stop_reason === 'max_tokens' }
}
