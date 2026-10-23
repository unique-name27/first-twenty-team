// The Ask sheet's state, driven with a fake server: sending, streaming (a turn asked again drops its
// text), every way an answer can fail, an answer cut off, starting over, and a conversation that never
// outlives its login or the server workspace it was about.
import { describe, expect, it } from 'vitest'
import type { AssistantFailure, AssistantInfo, AssistantResult, ChatDone, ChatHandlers, ChatInput } from '@/sync'
import { CONVERSATION_KEY, CUT_OFF_TEXT, MAX_HISTORY_MESSAGES, MAX_MESSAGE_LENGTH, type SessionLike, sheetView } from './logic'
import { createAssistantStore, joinParts } from './store'

type Call = { input: ChatInput; handlers: ChatHandlers; resolve: (r: ChatDone | AssistantFailure) => void }

function setup(opts: { info?: () => AssistantResult<AssistantInfo>; workspace?: () => string | null } = {}) {
  const data = new Map<string, string>()
  const storage: SessionLike = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
  const calls: Call[] = []
  const infoCalls: number[] = []
  const store = createAssistantStore({
    info: async () => {
      infoCalls.push(1)
      return opts.info?.() ?? { ok: true, data: { enabled: true, name: 'Lark', model: 'claude-opus-5-5', remainingToday: 40 } }
    },
    chat: (input, handlers = {}) =>
      new Promise((resolve) => {
        calls.push({ input, handlers, resolve })
        // A stopped request resolves the way the real client does.
        input.signal?.addEventListener('abort', () => resolve({ ok: false, kind: 'aborted', status: null, error: null }))
      }),
    storage: () => storage,
    name: () => 'Lark',
    workspace: opts.workspace,
  })
  store.actions.setUser('u-1')
  return { store, calls, data, infoCalls, a: store.actions }
}

const fail = (kind: AssistantFailure['kind'], extra: Partial<AssistantFailure> = {}): AssistantFailure => ({ ok: false, kind, status: null, error: null, ...extra })
const tick = () => new Promise((r) => setTimeout(r, 0))

const answered = (history: unknown[], question: string, answer: string) => [
  ...history,
  { role: 'user', content: question },
  { role: 'assistant', content: [{ type: 'text', text: answer }] },
]

describe('sending a question', () => {
  it('streams the answer, then keeps the conversation exactly as the server sent it', async () => {
    const { store, calls, data, a } = setup()
    a.setDraft('  Who starts next week?  ')
    const sending = a.send()
    expect(store.getState().draft).toBe('')
    expect(store.getState().pending).toMatchObject({ message: 'Who starts next week?', text: '', status: null, phase: 'sending' })
    expect(calls[0].input).toMatchObject({ history: [], message: 'Who starts next week?' })

    calls[0].handlers.onStatus?.('Looking up people')
    expect(store.getState().pending).toMatchObject({ status: 'Looking up people', text: '' })
    calls[0].handlers.onDelta?.('Kofi starts ')
    calls[0].handlers.onDelta?.('Monday.')
    expect(store.getState().pending).toMatchObject({ status: null, text: 'Kofi starts Monday.' })
    // A status after some text starts a new paragraph for what follows.
    calls[0].handlers.onStatus?.('Looking up time off')
    expect(store.getState().pending?.text).toBe('Kofi starts Monday.\n\n')

    const history = answered([], 'Who starts next week?', 'Kofi starts Monday.')
    calls[0].resolve({ ok: true, history, remainingToday: 39, truncated: false })
    await sending
    const s = store.getState()
    expect(s.history).toBe(history)
    expect(s.pending).toBeNull()
    expect(s.remainingToday).toBe(39)
    expect(s.announcement).toMatchObject({ kind: 'answer', text: 'Kofi starts Monday.' })
    expect(JSON.parse(data.get(CONVERSATION_KEY)!)).toEqual({ v: 1, userId: 'u-1', workspace: null, history, remainingToday: 39 })
  })

  it('sends the previous conversation back unchanged with the next question', async () => {
    const { store, calls, a } = setup()
    const first = answered([], 'Hi', 'Hello')
    void a.send('Hi')
    calls[0].resolve({ ok: true, history: first, remainingToday: 10, truncated: false })
    await tick()
    void a.send('And next week?')
    expect(calls[1].input.history).toBe(store.getState().history)
    expect(calls[1].input.history).toBe(first)
  })

  it('keeps what is being typed when a suggestion chip sends its own question', () => {
    const { store, calls, a } = setup()
    a.setDraft('half a thought')
    void a.send('Which legal deadlines are overdue?')
    expect(calls[0].input.message).toBe('Which legal deadlines are overdue?')
    expect(store.getState().draft).toBe('half a thought')
  })

  it('counts down on its own when the server leaves the count out', async () => {
    const { store, calls, a } = setup()
    await a.loadInfo()
    void a.send('Hi')
    calls[0].resolve({ ok: true, history: answered([], 'Hi', 'Hello'), remainingToday: null, truncated: false })
    await tick()
    expect(store.getState().remainingToday).toBe(39)
  })

  it('sends nothing that the server would refuse, and nothing while an answer streams', async () => {
    const { store, calls, a } = setup()
    await a.send('   ')
    await a.send('x'.repeat(MAX_MESSAGE_LENGTH + 1))
    expect(calls).toHaveLength(0)

    void a.send('First')
    void a.send('Second')
    expect(calls).toHaveLength(1)
    calls[0].resolve({ ok: true, history: answered([], 'First', 'One'), remainingToday: 0, truncated: false })
    await tick()
    // No questions left today.
    await a.send('Third')
    expect(calls).toHaveLength(1)

    store.setState({ remainingToday: 5, history: Array.from({ length: MAX_HISTORY_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' })) })
    await a.send('Too long a conversation')
    expect(calls).toHaveLength(1)

    store.actions.setUser(null)
    await a.send('Nobody signed in')
    expect(calls).toHaveLength(1)
  })
})

describe('when an answer does not come', () => {
  it('shows a busy login as a failed turn, and Retry asks again on the same conversation', async () => {
    const { store, calls, a } = setup()
    const sending = a.send('Who is out?')
    calls[0].resolve(fail('busy', { status: 409, error: 'assistant_busy' }))
    await sending
    expect(store.getState().pending).toMatchObject({ phase: 'failed', message: 'Who is out?', failure: { kind: 'busy' } })
    expect(store.getState().announcement).toMatchObject({ kind: 'notice', text: 'Lark is still answering in another tab or window. Wait for that answer, then send again.' })
    void a.retry()
    expect(calls[1].input).toMatchObject({ history: [], message: 'Who is out?' })
    expect(store.getState().pending?.phase).toBe('sending')
  })

  it('takes the questions left from a failure that says, and offers a new conversation when the API will not go on', async () => {
    const { store, calls, a } = setup()
    await a.loadInfo()
    let sending = a.send('Hi')
    calls[0].resolve(fail('model', { error: 'upstream_busy', message: 'Claude has too many requests right now.', remainingToday: 31 }))
    await sending
    expect(store.getState().remainingToday).toBe(31)
    expect(store.getState().pending).toMatchObject({ phase: 'failed', failure: { kind: 'model' } })
    sending = a.send('Hi again')
    calls[1].resolve(fail('bad_history', { error: 'bad_conversation' }))
    await sending
    expect(store.getState().pending).toMatchObject({ phase: 'failed', failure: { kind: 'bad_history' } })
    expect(store.getState().remainingToday).toBe(31)
  })

  it('keeps the partial text of an answer that broke off', async () => {
    const { store, calls, a } = setup()
    const sending = a.send('Draft a posting')
    calls[0].handlers.onDelta?.('## Founding designer')
    calls[0].resolve(fail('interrupted'))
    await sending
    expect(store.getState().pending).toMatchObject({ phase: 'failed', text: '## Founding designer', failure: { kind: 'interrupted' } })
    expect(store.getState().history).toEqual([])
  })

  it('drops the partial answer of a refusal or a cut-off lookup: it is not an answer', async () => {
    for (const failure of [
      fail('model', { error: 'refused', discardPartial: true, message: 'Lark cannot help with that request.' }),
      fail('model', { error: 'truncated', discardPartial: true }),
      // An older server that sends no flag: the codes alone say it.
      fail('model', { error: 'refused' }),
    ]) {
      const { store, calls, a } = setup()
      const sending = a.send('Something')
      calls[0].handlers.onDelta?.('Sure, here is how to')
      calls[0].resolve(failure)
      await sending
      expect(store.getState().pending, failure.error ?? '').toMatchObject({ phase: 'failed', text: '', parts: [], failure: { error: failure.error } })
    }
  })

  it('drops the text of a turn the server asks again, so the answer never shows a sentence twice', async () => {
    const { store, calls, a } = setup()
    void a.send('Who starts next week?')
    const h = calls[0].handlers
    h.onDelta?.('Kofi starts Monday.')
    h.onStatus?.('Looking up people')
    h.onDelta?.('Let me look ')
    h.onDelta?.('again.')
    expect(store.getState().pending?.text).toBe('Kofi starts Monday.\n\nLet me look again.')
    // The turn that wrote 'Let me look again.' (18 characters) is asked again.
    h.onDiscard?.(18)
    expect(store.getState().pending).toMatchObject({ text: 'Kofi starts Monday.\n\n', status: null })
    h.onDelta?.('Let me look.')
    expect(store.getState().pending?.text).toBe('Kofi starts Monday.\n\nLet me look.')
    // Never more than there is.
    h.onDiscard?.(500)
    expect(store.getState().pending?.text).toBe('')
    expect(joinParts(['a', '', 'b'])).toBe('a\n\nb')
    expect(joinParts(['a\n', 'b'])).toBe('a\nb')
  })

  it('marks an answer cut off at the length limit, and says so with the answer', async () => {
    const { store, calls, a } = setup()
    let sending = a.send('Draft a posting')
    calls[0].resolve({ ok: true, history: answered([], 'Draft a posting', '## Founding designer\n\nWe are look'), remainingToday: 30, truncated: true })
    await sending
    expect(store.getState().cutOff).toBe(true)
    expect(store.getState().announcement).toMatchObject({ kind: 'answer', note: CUT_OFF_TEXT })
    // The next question clears it.
    sending = a.send('Go on')
    expect(store.getState().cutOff).toBe(false)
    calls[1].resolve({ ok: true, history: answered(store.getState().history, 'Go on', 'ing for a designer.'), remainingToday: 29, truncated: false })
    await sending
    expect(store.getState().cutOff).toBe(false)
    expect(store.getState().announcement.note).toBeUndefined()
  })

  it('says with the answer when the conversation is now full or the questions are used up', async () => {
    const { store, calls, a } = setup()
    const long = Array.from({ length: MAX_HISTORY_MESSAGES / 2 }, (_, i) => answered([], `q${i}`, `a${i}`)).flat()
    let sending = a.send('One more')
    calls[0].resolve({ ok: true, history: answered(long, 'One more', 'Done.'), remainingToday: 5, truncated: false })
    await sending
    expect(store.getState().announcement).toMatchObject({ kind: 'answer', text: 'Done.', note: 'This conversation is as long as Lark can follow. Start a new one to keep asking.' })
    a.newConversation()
    sending = a.send('Last one')
    calls[1].resolve({ ok: true, history: answered([], 'Last one', 'Sure.'), remainingToday: 0, truncated: false })
    await sending
    expect(store.getState().announcement.note).toMatch(/^Lark has no questions left right now\. More come back /)
  })

  it('stops an answer: the request is aborted, the turn says stopped, and the questions left are asked again', async () => {
    let left = 35
    const { store, calls, a, infoCalls } = setup({ info: () => ({ ok: true, data: { enabled: true, name: 'Lark', model: 'claude-opus-5-5', remainingToday: left } }) })
    await a.loadInfo()
    expect(store.getState().remainingToday).toBe(35)
    const sending = a.send('Long question')
    calls[0].handlers.onDelta?.('Part of')
    // The server counted it: the request had gone out.
    left = 34
    a.stop()
    await sending
    await new Promise((r) => setTimeout(r, 0))
    expect(infoCalls).toHaveLength(2)
    expect(store.getState().remainingToday).toBe(34)
    expect(calls[0].input.signal?.aborted).toBe(true)
    expect(store.getState().pending).toMatchObject({ phase: 'stopped', text: 'Part of' })
    expect(store.getState().history).toEqual([])
  })

  it('treats the day being used up as a state: no questions left, and the question back in the box', async () => {
    const { store, calls, a } = setup()
    a.setDraft('Who starts?')
    const sending = a.send()
    calls[0].resolve(fail('quota', { status: 429, error: 'assistant_quota' }))
    await sending
    const s = store.getState()
    expect(s.pending).toBeNull()
    expect(s.remainingToday).toBe(0)
    expect(s.draft).toBe('Who starts?')
  })

  it('turns a signed-out or switched-off server into the sheet state, keeping the question', async () => {
    const { store, calls, a } = setup()
    await a.loadInfo()
    const view = () => sheetView({ mode: 'server', served: true, signedIn: true, syncStatus: 'synced', info: store.getState().info })
    expect(view()).toEqual({ kind: 'ready' })

    a.setDraft('Who starts?')
    let sending = a.send()
    calls[0].resolve(fail('signed_out', { status: 401 }))
    await sending
    expect(view()).toEqual({ kind: 'signed_out' })
    expect(store.getState().pending).toBeNull()
    expect(store.getState().draft).toBe('Who starts?')

    await a.loadInfo()
    expect(view()).toEqual({ kind: 'ready' })
    sending = a.send()
    calls[1].resolve(fail('off', { status: 503, error: 'assistant_off' }))
    await sending
    expect(view()).toEqual({ kind: 'off' })
  })
})

describe('starting over', () => {
  it('clears the conversation here and in the tab copy, and brings a failed question back', async () => {
    const { store, calls, data, a } = setup()
    void a.send('Hi')
    calls[0].resolve({ ok: true, history: answered([], 'Hi', 'Hello'), remainingToday: 9, truncated: false })
    await tick()
    expect(data.has(CONVERSATION_KEY)).toBe(true)
    const sending = a.send('Who is out?')
    calls[1].resolve(fail('server', { status: 500 }))
    await sending
    a.newConversation()
    const s = store.getState()
    expect(s.history).toEqual([])
    expect(s.pending).toBeNull()
    expect(s.draft).toBe('Who is out?')
    expect(s.remainingToday).toBe(9)
    expect(data.has(CONVERSATION_KEY)).toBe(false)
  })

  it('ignores the answer of a question asked before starting over', async () => {
    const { store, calls, a } = setup()
    const sending = a.send('Old question')
    a.newConversation()
    expect(calls[0].input.signal?.aborted).toBe(true)
    calls[0].resolve({ ok: true, history: answered([], 'Old question', 'Old answer'), remainingToday: 3, truncated: false })
    await sending
    expect(store.getState().history).toEqual([])
  })
})

describe('the login the conversation belongs to', () => {
  it('drops the conversation from the tab on sign-out, and never shows it to another login', async () => {
    const { store, calls, data, a } = setup()
    void a.send('Hi')
    calls[0].resolve({ ok: true, history: answered([], 'Hi', 'Hello'), remainingToday: 9, truncated: false })
    await tick()
    a.setUser(null)
    expect(store.getState().history).toEqual([])
    expect(data.has(CONVERSATION_KEY)).toBe(false)
    a.setUser('u-2')
    expect(store.getState().history).toEqual([])
  })

  it('picks up the conversation this tab kept for the login after a reload', () => {
    const first = setup()
    const history = answered([], 'Hi', 'Hello')
    first.data.set(CONVERSATION_KEY, JSON.stringify({ v: 1, userId: 'u-1', history, remainingToday: 4 }))
    // A new page: nobody known yet, then the saved login.
    const store = createAssistantStore({
      info: async () => fail('offline'),
      chat: async () => fail('offline'),
      storage: () => ({ getItem: (k) => first.data.get(k) ?? null, setItem: () => undefined, removeItem: () => undefined }),
      name: () => 'Lark',
    })
    store.actions.setUser('u-1')
    expect(store.getState().history).toEqual(history)
    expect(store.getState().remainingToday).toBe(4)
  })

  it('stops an answer streaming for a login that signed out, and ignores its result', async () => {
    const { store, calls, a } = setup()
    const sending = a.send('Hi')
    a.setUser('u-2')
    expect(calls[0].input.signal?.aborted).toBe(true)
    calls[0].resolve({ ok: true, history: answered([], 'Hi', 'Hello'), remainingToday: 1, truncated: false })
    await sending
    expect(store.getState()).toMatchObject({ userId: 'u-2', history: [], pending: null })
  })
})

describe('the workspace the conversation is about', () => {
  it('drops the conversation when the workspace is replaced (Start fresh), its answer included, keeping what is being typed', async () => {
    let ws: string | null = 'w-1/h-ledgerlark'
    const { store, calls, data, a } = setup({ workspace: () => ws })
    void a.send('Who starts next week?')
    calls[0].resolve({ ok: true, history: answered([], 'Who starts next week?', '[Lucas Ferreira](#person.p-lucas) starts Monday.'), remainingToday: 9, truncated: false })
    await new Promise((r) => setTimeout(r, 0))
    expect(store.getState().workspace).toBe('w-1/h-ledgerlark')
    expect(JSON.parse(data.get(CONVERSATION_KEY)!).workspace).toBe('w-1/h-ledgerlark')
    // A question on its way about the old records, and something typed.
    void a.send('And his manager?')
    a.setDraft('Who is Quillfin hiring?')
    // Start fresh as Quillfin: the same workspace, a new history.
    ws = 'w-1/h-quillfin'
    a.checkWorkspace()
    const s = store.getState()
    expect(s.history).toEqual([])
    expect(s.pending).toBeNull()
    expect(calls[1].input.signal?.aborted).toBe(true)
    expect(s.workspace).toBe('w-1/h-quillfin')
    expect(s.draft).toBe('Who is Quillfin hiring?')
    expect(data.has(CONVERSATION_KEY)).toBe(false)
    // The next question goes out with no old records in it.
    void a.send()
    expect(calls[2].input.history).toEqual([])
  })

  it('checks when the sheet opens and before a question goes out', async () => {
    let ws: string | null = 'w-1/h-1'
    const { store, calls, a } = setup({ workspace: () => ws })
    void a.send('Hi')
    calls[0].resolve({ ok: true, history: answered([], 'Hi', 'Hello'), remainingToday: 9, truncated: false })
    await new Promise((r) => setTimeout(r, 0))
    ws = 'w-1/h-2'
    a.openSheet()
    expect(store.getState().history).toEqual([])
    void a.send('Hi again')
    calls[1].resolve({ ok: true, history: answered([], 'Hi again', 'Hello'), remainingToday: 8, truncated: false })
    await new Promise((r) => setTimeout(r, 0))
    ws = 'w-1/h-3'
    void a.send('Third')
    expect(calls[2].input.history).toEqual([])
  })

  it('keeps it while the workspace is not known (not connected yet, the engine not started), and after a reload of the same one', () => {
    const first = setup()
    const history = answered([], 'Hi', 'Hello')
    first.data.set(CONVERSATION_KEY, JSON.stringify({ v: 1, userId: 'u-1', workspace: 'w-1/h-1', history, remainingToday: 4 }))
    let ws: string | null = null
    const make = () =>
      createAssistantStore({
        info: async () => fail('offline'),
        chat: async () => fail('offline'),
        storage: () => ({ getItem: (k) => first.data.get(k) ?? null, setItem: (k, v) => void first.data.set(k, v), removeItem: (k) => void first.data.delete(k) }),
        name: () => 'Lark',
        workspace: () => ws,
      })
    const same = make()
    same.actions.setUser('u-1')
    expect(same.getState().history).toEqual(history)
    ws = 'w-1/h-1'
    same.actions.checkWorkspace()
    expect(same.getState().history).toEqual(history)
    // Another tab of the same browser after Start fresh elsewhere: a reload finds the old copy and drops it.
    ws = 'w-1/h-2'
    const other = make()
    other.actions.setUser('u-1')
    expect(other.getState().history).toEqual([])
    expect(first.data.has(CONVERSATION_KEY)).toBe(false)
  })
})

describe('what the server says about the assistant', () => {
  it('reads the questions left, asks once at a time, and keeps an earlier answer through a failed refresh', async () => {
    let answer: AssistantResult<AssistantInfo> = { ok: true, data: { enabled: true, name: 'Lark', model: 'claude-opus-5-5', remainingToday: 12 } }
    const store = createAssistantStore({ info: async () => answer, chat: async () => fail('offline'), storage: () => null, name: () => 'Lark' })
    store.actions.setUser('u-1')
    const p1 = store.actions.loadInfo()
    const p2 = store.actions.loadInfo()
    expect(p1).toBe(p2)
    await p1
    expect(store.getState().remainingToday).toBe(12)
    expect(store.getState().info.phase).toBe('ready')
    answer = fail('offline')
    await store.actions.loadInfo()
    expect(store.getState().info).toMatchObject({ phase: 'failed', data: { remainingToday: 12 }, failure: { kind: 'offline' } })
  })

  it('opens with a question typed in from search', () => {
    const { store, a } = setup()
    a.openSheet('  who starts next week  ')
    expect(store.getState()).toMatchObject({ open: true, draft: 'who starts next week' })
    a.closeSheet()
    a.openSheet()
    expect(store.getState()).toMatchObject({ open: true, draft: 'who starts next week' })
  })
})
