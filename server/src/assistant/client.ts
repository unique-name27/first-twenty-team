// The part of the Anthropic SDK the assistant uses, as a narrow interface, so tests and ASSISTANT_FAKE
// (fake.ts) can stand in for the real client: client.beta.messages.toolRunner with stream: true, which
// yields one message stream per model turn and runs the tools in between (runner.ts drives it).
//
// The API key: serve.ts passes ANTHROPIC_API_KEY from the environment straight into the client built here,
// and nothing else holds it. It is never logged (the SDK redacts it from its own debug output, and the
// server logs no headers), never returned in an answer and never sent to the browser.
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import type { BetaToolRunnerRequestOptions } from '@anthropic-ai/sdk/lib/tools/BetaToolRunner'
import type { BetaMessage, BetaMessageParam, BetaRawMessageStreamEvent, BetaToolRunnerParams } from '@anthropic-ai/sdk/resources/beta/messages'

/** One model turn as it streams: its events, then the whole message. */
export interface AssistantMessageStream extends AsyncIterable<BetaRawMessageStreamEvent> {
  finalMessage(): Promise<BetaMessage>
  /**
   * The message so far, from its message_start on (undefined before it, and once the turn ended well):
   * what a turn that failed part way had used (its usage), since finalMessage() rejects for it.
   */
  readonly currentMessage?: BetaMessage | undefined
}

/** The tool runner: one message stream per turn; `params.messages` holds the conversation so far. */
export interface AssistantRunner extends AsyncIterable<AssistantMessageStream> {
  readonly params: Readonly<BetaToolRunnerParams>
  /**
   * Appends to the conversation in place of the runner's own copy of the turn it just yielded (the SDK's
   * intervention hook): the runner then runs tools only for the turn appended here.
   */
  pushMessages(...messages: BetaMessageParam[]): void
}

export type AssistantRunnerParams = BetaToolRunnerParams & { stream: true }

export interface AssistantClient {
  beta: { messages: { toolRunner(params: AssistantRunnerParams, options?: BetaToolRunnerRequestOptions): AssistantRunner } }
}

/**
 * The real client for ANTHROPIC_API_KEY. Retries (429, 5xx and dropped connections, twice) are the SDK's
 * defaults; a chat's own AbortSignal ends a request when the browser goes away. authToken is null so the
 * configured key is the only credential sent: left out, the SDK would also send ANTHROPIC_AUTH_TOKEN from
 * the environment, and a request carrying both is refused (401). `options` is for tests (a fetch that
 * answers like the API).
 */
export function anthropicClient(apiKey: string, options: Omit<ClientOptions, 'apiKey' | 'authToken'> = {}): AssistantClient {
  const client = new Anthropic({ ...options, apiKey, authToken: null })
  return { beta: { messages: { toolRunner: (params, opts) => client.beta.messages.toolRunner(params, opts) } } }
}
