// The assistant's fetch client: GET /api/assistant and the streamed POST /api/assistant/chat.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CSRF_HEADER, type FetchLike } from './api'
import { createAssistantApi } from './assistant'

type Call = { url: string; init: RequestInit }

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn: FetchLike = async (url, init = {}) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { fn, calls }
}

const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const header = (c: Call, name: string) => (c.init.headers as Record<string, string>)[name]

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/** A streamed event-stream response whose chunks the test pushes one by one. */
function stream(signal?: AbortSignal | null) {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c
    },
  })
  signal?.addEventListener('abort', () => {
    try {
      ctrl.error(new DOMException('Aborted', 'AbortError'))
    } catch {
      /* already closed */
    }
  })
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }),
    push: (text: string) => ctrl.enqueue(enc.encode(text)),
    close: () => ctrl.close(),
  }
}

const eventStream = (text: string) => new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

/** Lets the client read what was pushed so far. */
const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  vi.useRealTimers()
})

describe('createAssistantApi().info', () => {
  it('asks GET /api/assistant same-origin, without the CSRF header, and reads the answer', async () => {
    const { fn, calls } = fakeFetch(() => json(200, { enabled: true, name: 'Lark', model: 'claude-opus-5-5', remainingToday: 37 }))
    const r = await createAssistantApi({ fetch: fn }).info()
    expect(r).toEqual({ ok: true, data: { enabled: true, name: 'Lark', model: 'claude-opus-5-5', remainingToday: 37 } })
    expect(calls[0].url).toBe('/api/assistant')
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.credentials).toBe('same-origin')
    expect(header(calls[0], CSRF_HEADER)).toBeUndefined()
  })

  it('reads a count sent as a string, and never a negative one', async () => {
    const api = createAssistantApi({ fetch: fakeFetch(() => json(200, { enabled: false, name: 'Quillfin Bot', model: '', remainingToday: '-3' })).fn })
    expect(await api.info()).toEqual({ ok: true, data: { enabled: false, name: 'Quillfin Bot', model: '', remainingToday: 0 } })
  })

  it('tells signed out, a server without the assistant, offline and a bad answer apart', async () => {
    expect(await createAssistantApi({ fetch: fakeFetch(() => json(401, { error: 'unauthorized' })).fn }).info()).toMatchObject({ ok: false, kind: 'signed_out' })
    expect(await createAssistantApi({ fetch: fakeFetch(() => json(404, { error: 'not_found' })).fn }).info()).toMatchObject({ ok: false, kind: 'not_found' })
    expect(await createAssistantApi({ fetch: fakeFetch(() => Promise.reject(new TypeError('Failed to fetch'))).fn }).info()).toMatchObject({ ok: false, kind: 'offline' })
    expect(await createAssistantApi({ fetch: fakeFetch(() => json(200, { name: 'Lark' })).fn }).info()).toMatchObject({ ok: false, kind: 'bad_response' })
    expect(await createAssistantApi({ fetch: fakeFetch(() => json(500, { error: 'server_error' })).fn }).info()).toMatchObject({ ok: false, kind: 'server' })
  })
})

describe('createAssistantApi().chat', () => {
  const history = [
    { role: 'user', content: 'Who starts next week?' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'tool_use', id: 'toolu_1', name: 'find_people', input: { query: 'start' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"people":[]}' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Nobody starts next week.' }] },
  ]

  it('posts the history exactly as it came, the message, the CSRF header and same-origin credentials', async () => {
    const { fn, calls } = fakeFetch(() => eventStream(sse('done', { history: [], remainingToday: 3 })))
    const sent = structuredClone(history)
    await createAssistantApi({ fetch: fn }).chat({ history: sent, message: 'And the week after?' })
    const c = calls[0]
    expect(c.url).toBe('/api/assistant/chat')
    expect(c.init.method).toBe('POST')
    expect(c.init.credentials).toBe('same-origin')
    expect(header(c, CSRF_HEADER)).toBe('1')
    expect(header(c, 'Content-Type')).toBe('application/json')
    expect(header(c, 'Accept')).toBe('text/event-stream')
    expect(c.init.body).toBe(JSON.stringify({ history, message: 'And the week after?' }))
    // The caller's copy is untouched.
    expect(sent).toEqual(history)
  })

  it('hands deltas and statuses over in order, then resolves with the history and the count from done', async () => {
    const seen: string[] = []
    const next = [...history, { role: 'user', content: 'Thanks' }, { role: 'assistant', content: [{ type: 'text', text: 'Any time.' }] }]
    const body =
      sse('status', { label: 'Looking up people' }) +
      sse('delta', { text: 'Any ' }) +
      ': keep-alive\n\n' +
      sse('delta', { text: 'time.' }) +
      sse('done', { history: next, remainingToday: 12 }) +
      sse('delta', { text: 'after done' })
    const api = createAssistantApi({ fetch: fakeFetch(() => eventStream(body)).fn })
    const r = await api.chat({ history, message: 'Thanks' }, { onDelta: (t) => seen.push(`delta:${t}`), onStatus: (l) => seen.push(`status:${l}`) })
    expect(r).toEqual({ ok: true, history: next, remainingToday: 12, truncated: false })
    expect(seen).toEqual(['status:Looking up people', 'delta:Any ', 'delta:time.'])
  })

  it('passes on a discard (a turn asked again), and says when the answer was cut off', async () => {
    const seen: string[] = []
    const body =
      sse('delta', { text: 'Let me look.' }) +
      sse('discard', { chars: 12 }) +
      sse('discard', { chars: -4 }) +
      sse('discard', { chars: 'lots' }) +
      sse('delta', { text: 'Let me look.' }) +
      sse('done', { history: [], remainingToday: 2, truncated: true })
    const r = await createAssistantApi({ fetch: fakeFetch(() => eventStream(body)).fn }).chat(
      { history: [], message: 'x' },
      { onDelta: (t) => seen.push(`delta:${t}`), onDiscard: (n) => seen.push(`discard:${n}`) },
    )
    // Only a positive count is passed on.
    expect(seen).toEqual(['delta:Let me look.', 'discard:12', 'delta:Let me look.'])
    expect(r).toEqual({ ok: true, history: [], remainingToday: 2, truncated: true })
  })

  it('says when the streamed text of a failed answer is to be dropped', async () => {
    const r = await createAssistantApi({ fetch: fakeFetch(() => eventStream(sse('delta', { text: 'Sure' }) + sse('error', { error: 'refused', message: 'No.', discardPartial: true }))).fn }).chat({
      history: [],
      message: 'x',
    })
    expect(r).toEqual({ ok: false, kind: 'model', status: 200, error: 'refused', message: 'No.', discardPartial: true })
  })

  it('reads a stream that arrives in pieces', async () => {
    const s = stream()
    const deltas: string[] = []
    const pending = createAssistantApi({ fetch: fakeFetch(() => s.response).fn }).chat({ history: [], message: 'Hi' }, { onDelta: (t) => deltas.push(t) })
    const all = sse('delta', { text: 'Hello there' }) + sse('done', { history: [{ role: 'user', content: 'Hi' }], remainingToday: 5 })
    for (let i = 0; i < all.length; i += 7) {
      s.push(all.slice(i, i + 7))
      await flush()
    }
    expect(await pending).toEqual({ ok: true, history: [{ role: 'user', content: 'Hi' }], remainingToday: 5, truncated: false })
    expect(deltas.join('')).toBe('Hello there')
  })

  it('turns an error event into a failure with its message as plain text', async () => {
    const body = sse('delta', { text: 'Let me' }) + sse('error', { error: 'refusal', message: 'Lark could not answer that.\n<b>Try</b>   rephrasing.' })
    const r = await createAssistantApi({ fetch: fakeFetch(() => eventStream(body)).fn }).chat({ history: [], message: 'x' })
    expect(r).toEqual({ ok: false, kind: 'model', status: 200, error: 'refusal', message: 'Lark could not answer that. <b>Try</b> rephrasing.' })
    const quota = await createAssistantApi({ fetch: fakeFetch(() => eventStream(sse('error', { error: 'assistant_quota' }))).fn }).chat({ history: [], message: 'x' })
    expect(quota).toMatchObject({ ok: false, kind: 'quota', error: 'assistant_quota' })
  })

  it('passes on the questions left with a failure, and asks for a new conversation when the API will not go on', async () => {
    const used = await createAssistantApi({ fetch: fakeFetch(() => eventStream(sse('error', { error: 'upstream_busy', message: 'Try again in a minute.', remainingToday: 7 }))).fn }).chat({
      history: [],
      message: 'x',
    })
    expect(used).toEqual({ ok: false, kind: 'model', status: 200, error: 'upstream_busy', message: 'Try again in a minute.', remainingToday: 7 })
    const stuck = await createAssistantApi({ fetch: fakeFetch(() => eventStream(sse('error', { error: 'bad_conversation', message: 'Start a new conversation.' }))).fn }).chat({
      history: [],
      message: 'x',
    })
    expect(stuck).toMatchObject({ ok: false, kind: 'bad_history', error: 'bad_conversation' })
  })

  it('maps the refusals the server answers before streaming', async () => {
    const chatWith = (res: Response) => createAssistantApi({ fetch: fakeFetch(() => res).fn }).chat({ history: [], message: 'x' })
    expect(await chatWith(json(503, { error: 'assistant_off' }))).toMatchObject({ ok: false, kind: 'off', status: 503 })
    expect(await chatWith(json(429, { error: 'assistant_quota', retryAfter: 3600 }))).toMatchObject({ ok: false, kind: 'quota', retryAfter: 3600 })
    expect(await chatWith(json(409, { error: 'assistant_busy' }))).toMatchObject({ ok: false, kind: 'busy' })
    expect(await chatWith(json(409, { error: 'assistant_company_busy' }))).toMatchObject({ ok: false, kind: 'busy', error: 'assistant_company_busy' })
    expect(await chatWith(json(503, { error: 'assistant_full', retryAfter: 20 }))).toMatchObject({ ok: false, kind: 'rate_limited', retryAfter: 20 })
    expect(await chatWith(json(400, { error: 'bad_history' }))).toMatchObject({ ok: false, kind: 'bad_history' })
    expect(await chatWith(json(400, { error: 'bad_request' }))).toMatchObject({ ok: false, kind: 'bad_request' })
    expect(await chatWith(json(401, { error: 'unauthorized' }))).toMatchObject({ ok: false, kind: 'signed_out' })
    expect(await chatWith(json(403, { error: 'csrf' }))).toMatchObject({ ok: false, kind: 'forbidden' })
    expect(await chatWith(json(413, { error: 'too_large' }))).toMatchObject({ ok: false, kind: 'too_large' })
    expect(await chatWith(json(404, { error: 'not_found' }))).toMatchObject({ ok: false, kind: 'not_found' })
    expect(await chatWith(json(502))).toMatchObject({ ok: false, kind: 'server', status: 502 })
    expect(await chatWith(json(200, { history: [] }))).toMatchObject({ ok: false, kind: 'bad_response' })
  })

  it('says offline when nothing answered, and interrupted when the answer broke off before done', async () => {
    const down = createAssistantApi({ fetch: fakeFetch(() => Promise.reject(new TypeError('Failed to fetch'))).fn })
    expect(await down.chat({ history: [], message: 'x' })).toMatchObject({ ok: false, kind: 'offline' })
    const cut = createAssistantApi({ fetch: fakeFetch(() => eventStream(sse('delta', { text: 'Half an ans' }))).fn })
    expect(await cut.chat({ history: [], message: 'x' })).toMatchObject({ ok: false, kind: 'interrupted' })
    const garbled = createAssistantApi({ fetch: fakeFetch(() => eventStream(sse('done', { history: 'nope' }))).fn })
    expect(await garbled.chat({ history: [], message: 'x' })).toMatchObject({ ok: false, kind: 'bad_response' })
  })

  it('stops the request when the caller aborts, so the server stops the model too', async () => {
    let fetchSignal: AbortSignal | null | undefined
    let s!: ReturnType<typeof stream>
    const { fn } = fakeFetch((_url, init) => {
      fetchSignal = init.signal
      s = stream(init.signal)
      return s.response
    })
    const stop = new AbortController()
    const deltas: string[] = []
    const pending = createAssistantApi({ fetch: fn }).chat({ history: [], message: 'x', signal: stop.signal }, { onDelta: (t) => deltas.push(t) })
    await flush()
    s.push(sse('delta', { text: 'Starting' }))
    await flush()
    stop.abort()
    expect(await pending).toMatchObject({ ok: false, kind: 'aborted' })
    expect(fetchSignal?.aborted).toBe(true)
    expect(deltas).toEqual(['Starting'])
  })

  it('does not even ask when the signal is already aborted', async () => {
    const { fn, calls } = fakeFetch(() => eventStream(''))
    const stop = new AbortController()
    stop.abort()
    expect(await createAssistantApi({ fetch: fn }).chat({ history: [], message: 'x', signal: stop.signal })).toMatchObject({ ok: false, kind: 'aborted' })
    expect(calls).toHaveLength(0)
  })

  it('gives up on an answer that goes silent', async () => {
    vi.useFakeTimers()
    let s!: ReturnType<typeof stream>
    const api = createAssistantApi({
      fetch: fakeFetch((_url, init) => {
        s = stream(init.signal)
        return s.response
      }).fn,
      idleTimeoutMs: 10_000,
    })
    const pending = api.chat({ history: [], message: 'x' })
    await vi.advanceTimersByTimeAsync(0)
    s.push(sse('delta', { text: 'Thinking about it' }))
    await vi.advanceTimersByTimeAsync(9_000)
    s.push(sse('status', { label: 'Looking up jobs' }))
    await vi.advanceTimersByTimeAsync(9_000)
    // Still alive: each piece restarts the silence timer.
    let settled = false
    void pending.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).toMatchObject({ ok: false, kind: 'interrupted' })
  })
})
