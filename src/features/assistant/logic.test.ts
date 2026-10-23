// The Ask sheet's pure logic: naming, the conversation as turns, limits, the sheet's states, suggestions,
// renaming and the per-tab copy of the conversation.
import { produce } from 'immer'
import { afterEach, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { buildSampleDB, SAMPLE_ANCHOR } from '@/data/seed'
import { assistantDisplayName } from '@/domain/assistant'
import type { DB } from '@/domain/types'
import { addDays, setClockOverride } from '@/lib/dates'
import type { AssistantFailure } from '@/sync'
import {
  applyAssistantName,
  canRetry,
  clearConversation,
  CONVERSATION_KEY,
  failureText,
  historyFits,
  type InfoState,
  lastAnswer,
  LIVE_DEMO_SIGNUP_URL,
  loadConversation,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_LENGTH,
  messageProblem,
  quotaBackText,
  remainingText,
  renameChanges,
  renameLabel,
  saveConversation,
  type SessionLike,
  sheetView,
  suggestionsFor,
  turnsFromHistory,
} from './logic'

afterEach(() => setClockOverride(null))

const solo = () => blankDB({ companyName: 'Quillfin', founderFirstName: 'Ada', founderLastName: 'Byte', foundedOn: '2026-01-05' })

function fakeStorage(): SessionLike & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k])
    Object.freeze(v)
  }
  return v
}

describe('the assistant name', () => {
  it('defaults to the company name and Bot, and the sample company calls it Lark', () => {
    expect(assistantDisplayName(solo().company)).toBe('Quillfin Bot')
    expect(assistantDisplayName(buildSampleDB().company)).toBe('Lark')
  })

  it('renames and resets through the same save, with an activity row and words for the Undo toast', () => {
    const db = solo()
    const label = renameLabel(db.company, '  Penny  ')
    expect(label).toBe('Renamed the assistant to Penny')
    const named = produce(db, (d) => applyAssistantName(d, '  Penny  ', label))
    expect(named.company.assistantName).toBe('Penny')
    expect(assistantDisplayName(named.company)).toBe('Penny')
    expect(named.activity.at(-1)).toMatchObject({ entityType: 'company', entityId: 'company', kind: 'settings_changed', text: label })

    const resetLabel = renameLabel(named.company, '   ')
    expect(resetLabel).toBe("Reset the assistant's name to Quillfin Bot")
    const reset = produce(named, (d) => applyAssistantName(d, '   ', resetLabel))
    expect('assistantName' in reset.company).toBe(false)
    expect(assistantDisplayName(reset.company)).toBe('Quillfin Bot')
  })

  it('knows when a typed name changes nothing', () => {
    expect(renameChanges({}, '')).toBe(false)
    expect(renameChanges({}, '   ')).toBe(false)
    expect(renameChanges({ assistantName: 'Lark' }, ' Lark ')).toBe(false)
    expect(renameChanges({ assistantName: 'Lark' }, 'Wren')).toBe(true)
    expect(renameChanges({ assistantName: 'Lark' }, '')).toBe(true)
  })
})

describe('turnsFromHistory', () => {
  const history = deepFreeze([
    { role: 'user', content: 'Who starts next week?' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_use', id: 'toolu_1', name: 'find_people', input: {} },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"people":[]}' }] },
    { role: 'assistant', content: [{ type: 'fallback', from: { model: 'a' }, to: { model: 'b' } }, { type: 'text', text: '[Kofi Boateng](#person.p-kofi) starts Monday.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Thanks' }] },
    { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }] },
  ])

  it('shows each question and everything the assistant wrote until the next one, never tool calls or results', () => {
    expect(turnsFromHistory(history)).toEqual([
      { role: 'user', text: 'Who starts next week?' },
      { role: 'assistant', text: 'Let me look.\n\n[Kofi Boateng](#person.p-kofi) starts Monday.' },
      { role: 'user', text: 'Thanks' },
      { role: 'assistant', text: '' },
    ])
  })

  it('reads the history without changing it (it goes back to the server exactly as it came)', () => {
    const before = JSON.stringify(history)
    turnsFromHistory(history)
    lastAnswer(history)
    expect(JSON.stringify(history)).toBe(before)
  })

  it('skips anything that is not a message', () => {
    expect(turnsFromHistory([null, 3, 'x', { role: 'system', content: 'no' }, { role: 'user', content: 'Hi' }])).toEqual([{ role: 'user', text: 'Hi' }])
  })

  it('never shows the context note the server puts before a question, and leaves the history as it came', () => {
    const note = '<app_context>You are Lark, the HR assistant inside First Twenty for Ledgerlark. Today is Sunday, October 11, 2026 (2026-10-11) in California, where the company keeps its dates.</app_context>'
    const withNote = deepFreeze([
      { role: 'user', content: [{ type: 'text', text: note }, { type: 'text', text: 'Who starts next week?' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Nobody.' }] },
      // A person who types a note-shaped question on its own still sees it: only a leading note before a question is the server's.
      { role: 'user', content: note },
      { role: 'assistant', content: 'Odd question.' },
    ])
    expect(turnsFromHistory(withNote)).toEqual([
      { role: 'user', text: 'Who starts next week?' },
      { role: 'assistant', text: 'Nobody.' },
      { role: 'user', text: note },
      { role: 'assistant', text: 'Odd question.' },
    ])
  })

  it('finds the newest answer', () => {
    expect(lastAnswer(history.slice(0, 4))).toBe('Let me look.\n\n[Kofi Boateng](#person.p-kofi) starts Monday.')
    expect(lastAnswer([{ role: 'user', content: 'Hi' }])).toBe('')
  })
})

describe('limits', () => {
  it('takes questions up to 2,000 characters', () => {
    expect(messageProblem('')).not.toBeNull()
    expect(messageProblem('   \n ')).not.toBeNull()
    expect(messageProblem('x'.repeat(MAX_MESSAGE_LENGTH))).toBeNull()
    expect(messageProblem('x'.repeat(MAX_MESSAGE_LENGTH + 1))).toBe('Shorten it to 2,000 characters to send it.')
  })

  it('knows when the server would no longer take the conversation back', () => {
    const msg = { role: 'user', content: 'hi' }
    expect(historyFits([])).toBe(true)
    expect(historyFits(Array.from({ length: MAX_HISTORY_MESSAGES }, () => msg))).toBe(true)
    expect(historyFits(Array.from({ length: MAX_HISTORY_MESSAGES + 1 }, () => msg))).toBe(false)
    expect(historyFits([{ role: 'user', content: 'x'.repeat(MAX_HISTORY_BYTES) }])).toBe(false)
  })
})

describe('sheetView', () => {
  const ready: InfoState = { phase: 'ready', data: { enabled: true, name: 'Lark', model: 'claude-opus-5-5', remainingToday: 40 }, failure: null }
  const fail = (kind: AssistantFailure['kind']): AssistantFailure => ({ ok: false, kind, status: null, error: null })
  const base = { mode: 'server' as const, served: true, signedIn: true, syncStatus: 'synced' as const, info: ready }

  it('explains a copy with no server, and a server page this browser is not connected to', () => {
    expect(sheetView({ ...base, mode: 'local', served: false, signedIn: false })).toEqual({ kind: 'local' })
    expect(sheetView({ ...base, mode: 'local', served: true, signedIn: false })).toEqual({ kind: 'connect' })
  })

  it('asks a login that signed in but has not chosen a workspace yet to finish connecting, not to sign in', () => {
    expect(sheetView({ ...base, mode: 'local', served: true, signedIn: true })).toEqual({ kind: 'finish' })
    // A copy no server serves has no server to finish connecting to.
    expect(sheetView({ ...base, mode: 'local', served: false, signedIn: true })).toEqual({ kind: 'local' })
  })

  it('says signed out, from the sync status or from the server', () => {
    expect(sheetView({ ...base, syncStatus: 'signed_out' })).toEqual({ kind: 'signed_out' })
    expect(sheetView({ ...base, info: { phase: 'failed', data: null, failure: fail('signed_out') } })).toEqual({ kind: 'signed_out' })
  })

  it('checks first, then shows the conversation or says the assistant is off', () => {
    expect(sheetView({ ...base, info: { phase: 'idle', data: null, failure: null } })).toEqual({ kind: 'checking' })
    expect(sheetView({ ...base, info: { phase: 'loading', data: null, failure: null } })).toEqual({ kind: 'checking' })
    expect(sheetView(base)).toEqual({ kind: 'ready' })
    // A refresh on its way keeps what the server said before.
    expect(sheetView({ ...base, info: { ...ready, phase: 'loading' } })).toEqual({ kind: 'ready' })
    expect(sheetView({ ...base, info: { ...ready, data: { ...ready.data!, enabled: false } } })).toEqual({ kind: 'off' })
    expect(sheetView({ ...base, info: { phase: 'failed', data: null, failure: fail('not_found') } })).toEqual({ kind: 'off' })
    expect(sheetView({ ...base, info: { phase: 'failed', data: null, failure: fail('off') } })).toEqual({ kind: 'off' })
  })

  it('offers a retry when the server could not be asked, unless an earlier answer still holds', () => {
    expect(sheetView({ ...base, info: { phase: 'failed', data: null, failure: fail('offline') } })).toEqual({ kind: 'unavailable', failure: fail('offline') })
    expect(sheetView({ ...base, info: { ...ready, phase: 'failed', failure: fail('offline') } })).toEqual({ kind: 'ready' })
  })
})

describe('failure words', () => {
  const f = (kind: AssistantFailure['kind'], extra: Partial<AssistantFailure> = {}): AssistantFailure => ({ ok: false, kind, status: null, error: null, ...extra })

  it('names the assistant and says what to do', () => {
    expect(failureText(f('busy'), 'Lark')).toBe('Lark is still answering in another tab or window. Wait for that answer, then send again.')
    expect(failureText(f('busy', { error: 'assistant_company_busy' }), 'Lark')).toBe('Lark is answering other people at your company right now. Wait a moment, then send again.')
    // The day's count resets at midnight UTC: in California that is the same afternoon.
    const noon = new Date('2026-10-11T19:00:00Z')
    expect(failureText(f('quota'), 'Quillfin Bot', noon)).toBe(`Quillfin Bot has no questions left right now. ${quotaBackText(noon)}`)
    expect(failureText(f('off'), 'Lark')).toBe('Lark is not turned on for this server.')
    expect(failureText(f('model', { message: 'Lark could not answer that.' }), 'Lark')).toBe('Lark could not answer that.')
    expect(failureText(f('model'), 'Lark')).toBe('Lark could not answer that. Try asking another way.')
    // A conversation the Claude API will not take further says so in its own words; a 400 bad_history has none.
    expect(failureText(f('bad_history', { error: 'bad_conversation', message: 'This conversation cannot go on. Start a new conversation.' }), 'Lark')).toBe(
      'This conversation cannot go on. Start a new conversation.',
    )
    expect(failureText(f('bad_history', { error: 'bad_history' }), 'Lark')).toBe('This conversation is longer than Lark can follow. Start a new conversation to keep asking.')
  })

  it('offers Retry only where a second try can help', () => {
    expect(canRetry(f('busy'))).toBe(true)
    expect(canRetry(f('offline'))).toBe(true)
    expect(canRetry(f('interrupted'))).toBe(true)
    expect(canRetry(f('model', { error: 'max_tokens' }))).toBe(true)
    expect(canRetry(f('model', { error: 'upstream_busy' }))).toBe(true)
    expect(canRetry(f('model', { error: 'server_error' }))).toBe(true)
    // The same question would fail the same way: ask another way instead.
    for (const error of ['refused', 'refusal', 'truncated', 'too_many_steps', 'assistant_misconfigured']) expect(canRetry(f('model', { error })), error).toBe(false)
    expect(canRetry(f('quota'))).toBe(false)
    expect(canRetry(f('bad_history'))).toBe(false)
  })

  it('counts the questions left', () => {
    expect(remainingText(0)).toBe('No questions left today')
    expect(remainingText(1)).toBe('1 question left today')
    expect(remainingText(37)).toBe('37 questions left today')
  })

  it('says when the questions come back in local time, never "tomorrow" when it is this afternoon', () => {
    const la = 'America/Los_Angeles'
    // Noon in California, daylight time: midnight UTC is 5 PM the same day.
    expect(quotaBackText(new Date('2026-10-11T19:00:00Z'), la)).toBe('More come back at 5 PM.')
    // Winter: 4 PM.
    expect(quotaBackText(new Date('2026-12-10T20:00:00Z'), la)).toBe('More come back at 4 PM.')
    // Late evening in California (after the reset): the next one is tomorrow afternoon.
    expect(quotaBackText(new Date('2026-10-12T06:30:00Z'), la)).toBe('More come back tomorrow at 5 PM.')
    // Further east the reset is the next morning, on the half hour in India; at midnight in London's winter.
    expect(quotaBackText(new Date('2026-10-11T12:00:00Z'), 'Asia/Kolkata')).toBe('More come back tomorrow at 5:30 AM.')
    expect(quotaBackText(new Date('2026-12-10T12:00:00Z'), 'Europe/London')).toBe('More come back at midnight.')
  })

  it('points a copy with no server at the live demo sign-up', () => {
    expect(LIVE_DEMO_SIGNUP_URL).toBe('https://hr-77-112-161-54.sslip.io/#settings.server.signup')
  })
})

describe('suggestionsFor', () => {
  it('starts a solo founder at the first hire', () => {
    const db = solo()
    expect(suggestionsFor(db, '2026-03-02')).toEqual(['What do I need to do before my first hire?', 'Which legal deadlines are overdue?', 'Draft a job posting for my first hire'])
  })

  it('fits the sample company: who starts, deadlines, its busiest search and its next planned role', () => {
    setClockOverride(SAMPLE_ANCHOR)
    const db = buildSampleDB()
    const s = suggestionsFor(db, SAMPLE_ANCHOR)
    expect(s).toHaveLength(4)
    expect(s[1]).toBe('Which legal deadlines are overdue?')
    expect(s[2]).toMatch(/^Where does the .+ search stand\?$/)
    expect(s[3]).toMatch(/^Draft a job posting for an? .+$/)
  })

  it('names the open job with the most active candidates, and the soonest planned role', () => {
    // A solo founder's workspace with records shaped like the sample's.
    const sample = buildSampleDB()
    const db: DB = produce(solo(), (d) => {
      d.jobs = [
        { ...sample.jobs[0], id: 'j-a', title: 'Staff ML engineer', status: 'open' },
        { ...sample.jobs[0], id: 'j-b', title: 'Office manager', status: 'open' },
        { ...sample.jobs[0], id: 'j-c', title: 'Closed role', status: 'closed' },
      ]
      d.applications = [
        { ...sample.applications[0], id: 'a-1', jobId: 'j-b', status: 'active' },
        { ...sample.applications[0], id: 'a-2', jobId: 'j-b', status: 'active' },
        { ...sample.applications[0], id: 'a-3', jobId: 'j-a', status: 'active' },
        { ...sample.applications[0], id: 'a-4', jobId: 'j-c', status: 'active' },
        { ...sample.applications[0], id: 'a-5', jobId: 'j-c', status: 'active' },
        { ...sample.applications[0], id: 'a-6', jobId: 'j-c', status: 'active' },
        { ...sample.applications[0], id: 'a-7', jobId: 'j-a', status: 'rejected' },
        { ...sample.applications[0], id: 'a-8', jobId: 'j-a', status: 'rejected' },
      ]
      d.plan = [
        { ...sample.plan[0], id: 'ps-2', title: 'Engineering manager', status: 'planned', jobId: null, targetStart: '2027-03-01' },
        { ...sample.plan[0], id: 'ps-1', title: 'Account executive', status: 'planned', jobId: null, targetStart: '2027-01-04' },
      ]
      d.people.push({ ...d.people[0], id: 'p-new', firstName: 'Kofi', lastName: 'Boateng', startDate: addDays('2026-03-02', 5), hireNumber: 2, isFounder: false })
    })
    expect(suggestionsFor(db, '2026-03-02')).toEqual([
      'Who starts next week?',
      'Which legal deadlines are overdue?',
      'Where does the office manager search stand?',
      'Draft a job posting for an account executive',
    ])
    // An acronym keeps its capitals.
    const ml = produce(db, (d) => {
      d.applications = d.applications.map((a) => ({ ...a, jobId: 'j-a' }))
    })
    expect(suggestionsFor(ml, '2026-03-02')[2]).toBe('Where does the staff ML engineer search stand?')
  })
})

describe('the per-tab conversation', () => {
  const history = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }]

  it('keeps it for the login it belongs to only, with the workspace it was about', () => {
    const s = fakeStorage()
    saveConversation(s, { v: 1, userId: 'u-1', workspace: 'w-1/h-1', history, remainingToday: 12 })
    expect(JSON.parse(s.data.get(CONVERSATION_KEY)!)).toEqual({ v: 1, userId: 'u-1', workspace: 'w-1/h-1', history, remainingToday: 12 })
    expect(loadConversation(s, 'u-1')).toEqual({ v: 1, userId: 'u-1', workspace: 'w-1/h-1', history, remainingToday: 12 })
    expect(loadConversation(s, 'u-2')).toBeNull()
    // A copy saved before the workspace was known reads as unknown.
    s.data.set(CONVERSATION_KEY, JSON.stringify({ v: 1, userId: 'u-1', history, remainingToday: 3 }))
    expect(loadConversation(s, 'u-1')).toEqual({ v: 1, userId: 'u-1', workspace: null, history, remainingToday: 3 })
    clearConversation(s)
    expect(loadConversation(s, 'u-1')).toBeNull()
  })

  it('ignores a damaged copy and a browser that blocks storage', () => {
    const s = fakeStorage()
    s.data.set(CONVERSATION_KEY, '{nope')
    expect(loadConversation(s, 'u-1')).toBeNull()
    s.data.set(CONVERSATION_KEY, JSON.stringify({ v: 1, userId: 'u-1', history: 'x' }))
    expect(loadConversation(s, 'u-1')).toBeNull()
    s.data.set(CONVERSATION_KEY, JSON.stringify({ v: 1, userId: 'u-1', workspace: 42, history, remainingToday: 'lots' }))
    expect(loadConversation(s, 'u-1')).toEqual({ v: 1, userId: 'u-1', workspace: null, history, remainingToday: null })
    const blocked: SessionLike = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(loadConversation(blocked, 'u-1')).toBeNull()
    expect(() => saveConversation(blocked, { v: 1, userId: 'u-1', workspace: null, history, remainingToday: null })).not.toThrow()
    expect(() => clearConversation(blocked)).not.toThrow()
    expect(loadConversation(null, 'u-1')).toBeNull()
  })
})
