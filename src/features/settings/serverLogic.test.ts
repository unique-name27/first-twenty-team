import { describe, expect, it } from 'vitest'
import { signedInHere, signedOutText, syncView } from '@/app/Header'
import type { DB } from '@/domain/types'
import type { SyncUser } from '@/sync'
import { makeDB } from '@/sync/testing/kit'
import { serverStep } from './serverFocus'
import {
  agoText,
  checkFailureText,
  classifyCheckFailure,
  compareWorkspaces,
  describeCounts,
  describeDetail,
  describeRecord,
  describeRefreshed,
  hostContext,
  joinAnd,
  missingRecords,
  moreWorkIn,
  recommendedCopy,
  refreshedNames,
  refreshedText,
  refusedText,
  retryIn,
  serverAddress,
  signInSubtitle,
  statusView,
  summarize,
  SYNC_KIND_TONE,
  tooLargeManyText,
  tooLargeTail,
  tooLargeText,
} from './serverLogic'

describe('hostContext', () => {
  it('treats a file opened from disk as file, even with a runtime', () => {
    expect(hostContext({ protocol: 'file:', hasClaudeRuntime: false })).toBe('file')
    expect(hostContext({ protocol: 'file:', hasClaudeRuntime: true })).toBe('file')
  })
  it('treats the artifact viewer as artifact', () => {
    expect(hostContext({ protocol: 'https:', hasClaudeRuntime: true })).toBe('artifact')
  })
  it('treats an ordinary web page as web', () => {
    expect(hostContext({ protocol: 'https:', hasClaudeRuntime: false })).toBe('web')
    expect(hostContext({ protocol: 'http:', hasClaudeRuntime: false })).toBe('web')
  })
})

describe('classifyCheckFailure', () => {
  it('reads a static host as no server', () => {
    expect(classifyCheckFailure('not_found')).toBe('missing')
    expect(classifyCheckFailure('bad_response')).toBe('missing')
    expect(classifyCheckFailure('forbidden')).toBe('missing')
  })
  it('reads network and server errors as unreachable', () => {
    expect(classifyCheckFailure('offline')).toBe('unreachable')
    expect(classifyCheckFailure('server')).toBe('unreachable')
    expect(classifyCheckFailure('rate_limited')).toBe('unreachable')
  })
})

describe('statusView', () => {
  const base = { hold: null, pending: 0, storageFull: false } as const
  it('gives every status a word and an icon', () => {
    for (const status of ['local', 'synced', 'syncing', 'offline', 'signed_out', 'error'] as const) {
      const v = statusView({ ...base, status })
      expect(v.word.length).toBeGreaterThan(0)
      expect(v.icon.length).toBeGreaterThan(0)
      expect(v.sentence).not.toMatch(/—/)
    }
  })
  it('counts waiting changes', () => {
    expect(statusView({ ...base, status: 'syncing', pending: 1 }).sentence).toBe('Sending 1 change to your server.')
    expect(statusView({ ...base, status: 'offline', pending: 3 }).sentence).toContain('3 changes are waiting')
  })
  it('names a hold as paused', () => {
    const v = statusView({ ...base, status: 'local', hold: 'sample' })
    expect(v.word).toBe('Paused')
    expect(v.sentence).toContain('sample company')
  })
  it('names the demo clock hold as a pause the person chose', () => {
    const v = statusView({ ...base, status: 'local', hold: 'demo_clock' })
    expect(v).toMatchObject({ word: 'Paused', tone: SYNC_KIND_TONE.paused })
    expect(v.sentence).toBe('Syncing is paused while the app pretends today is another day.')
  })
  it('does not call refused changes synced, and words them without a per-record count', () => {
    const v = statusView({ ...base, status: 'synced', rejected: 2 })
    expect(v.word).toBe('Needs attention')
    expect(v.tone).toBe('bad')
    expect(v.sentence).toContain('refused some changes')
  })
  it('says when the browser cannot save', () => {
    expect(statusView({ ...base, status: 'error', storageFull: true }).word).toBe('Not saving')
  })
})

describe('statusView agrees with the header chip', () => {
  // The same state must read the same in the header chip and in Settings: word and seriousness.
  const chipWord: Record<keyof typeof SYNC_KIND_TONE, string> = {
    synced: 'Synced',
    syncing: 'Syncing',
    offline: 'Offline',
    'signed-out': 'Signed out',
    attention: 'Needs attention',
    paused: 'Paused',
  }
  type Case = Parameters<typeof statusView>[0]
  const base = { pending: 0, rejected: 0, storageFull: false, hold: null } as const
  const cases: Array<[string, Case]> = [
    ['synced', { ...base, status: 'synced' }],
    ['syncing', { ...base, status: 'syncing', pending: 2 }],
    ['offline', { ...base, status: 'offline', pending: 1 }],
    ['signed out', { ...base, status: 'signed_out' }],
    ['error', { ...base, status: 'error' }],
    ['refused', { ...base, status: 'synced', rejected: 2 }],
    ['sample hold', { ...base, status: 'local', hold: 'sample' }],
    ['demo clock hold', { ...base, status: 'local', hold: 'demo_clock' }],
    ['empty server hold', { ...base, status: 'local', hold: 'server_empty' }],
    ['replaced hold', { ...base, status: 'local', hold: 'replaced' }],
  ]
  for (const [name, c] of cases) {
    it(name, () => {
      const chip = syncView({
        status: c.status,
        mode: 'server',
        pending: c.pending,
        rejected: c.rejected ?? 0,
        lastSyncAt: null,
        lastError: null,
        hold: c.hold,
        user: null,
      })
      expect(chip).not.toBeNull()
      const v = statusView(c)
      expect(v.tone).toBe(SYNC_KIND_TONE[chip!.kind])
      expect(v.word).toBe(chipWord[chip!.kind])
    })
  }
})

describe('compareWorkspaces', () => {
  const server = { companyName: 'Acme', sample: false, counts: { people: 3, candidates: 4, jobs: 1 } }
  it('sees the sample first', () => {
    expect(compareWorkspaces({ ...server, sample: true }, server)).toBe('sample')
  })
  it('matches the company name only, ignoring case, and never claims more', () => {
    expect(compareWorkspaces({ ...server, companyName: ' acme ' }, server)).toBe('same_name')
    // Two fresh starts with one name: same counts, and still not called the same workspace.
    const fresh = { companyName: 'Delta Inc', sample: false, counts: { people: 1, candidates: 0, jobs: 0 } }
    expect(compareWorkspaces(fresh, { ...fresh })).toBe('same_name')
  })
  it('flags another company', () => {
    expect(compareWorkspaces({ ...server, companyName: 'Other' }, server)).toBe('different')
  })
})

describe('wording helpers', () => {
  it('describes counts with plurals', () => {
    expect(describeCounts({ people: 1, candidates: 0, jobs: 2 })).toBe('1 person, 2 jobs and 0 candidates')
  })
  it('says when the next retry runs', () => {
    expect(retryIn(null, 0)).toBeNull()
    expect(retryIn(1000, 0)).toBe('in a moment')
    expect(retryIn(40_000, 0)).toBe('in 40 seconds')
    expect(retryIn(60_000, 0)).toBe('in 1 minute')
    expect(retryIn(150_000, 0)).toBe('in 3 minutes')
  })
  it('says how long ago', () => {
    const now = Date.parse('2026-10-10T12:00:00Z')
    expect(agoText(null, now)).toBeNull()
    expect(agoText('2026-10-10T11:59:50Z', now)).toBe('just now')
    expect(agoText('2026-10-10T11:56:00Z', now)).toBe('4 minutes ago')
    expect(agoText('2026-10-10T10:00:00Z', now)).toBe('2 hours ago')
    expect(agoText('2026-10-08T10:00:00Z', now)).toBeNull()
  })
  it('falls back to the placeholder address', () => {
    expect(serverAddress('https://hr.example.com')).toBe('https://hr.example.com')
    expect(serverAddress('null')).toBe('https://your-domain')
    expect(serverAddress(undefined)).toBe('https://your-domain')
  })
})

describe('checkFailureText', () => {
  it('words a network error by whether the computer is online', () => {
    expect(checkFailureText({ kind: 'offline', status: null, message: '' }, false, 'https://a.test')).toContain('offline')
    expect(checkFailureText({ kind: 'offline', status: null, message: '' }, true, 'https://a.test')).toContain('Nothing answered at https://a.test')
  })
  it('tells a database outage from other server errors', () => {
    expect(checkFailureText({ kind: 'server', status: 503, message: '' }, true, '')).toContain('database')
    expect(checkFailureText({ kind: 'server', status: 502, message: '' }, true, '')).toContain('error 502')
  })
  it('keeps the engine text for anything else', () => {
    expect(checkFailureText({ kind: 'rate_limited', status: 429, message: 'Wait.' }, true, '')).toBe('Wait.')
  })
})

describe('describeRecord: naming a record in a sync notice (r1-01)', () => {
  const db = makeDB()
  db.jobs.push({ id: 'j-ml', title: 'ML engineer (agents)' } as unknown as DB['jobs'][number])
  db.candidates.push({ id: 'c-priya', firstName: 'Priya', lastName: 'Offlineson' } as unknown as DB['candidates'][number])
  db.offers.push({ id: 'o-1', candidateId: 'c-priya', applicationId: 'a-1', jobId: 'j-ml' } as unknown as DB['offers'][number])
  db.activity.push(
    { id: 'act-note', at: '2026-10-10T17:00:00.000Z', entityType: 'candidate', entityId: 'c-priya', kind: 'note', text: 'Long note' },
    { id: 'act-edit', at: '2026-10-10T17:00:00.000Z', entityType: 'job', entityId: 'j-ml', kind: 'edited', text: 'Edited the job' },
  )
  it('names jobs, candidates, offers and people, with a link to each', () => {
    expect(describeRecord(db, 'jobs', 'j-ml')).toEqual({ label: 'the ML engineer (agents) job', href: '#job.j-ml' })
    expect(describeRecord(db, 'candidates', 'c-priya')).toEqual({ label: 'Priya Offlineson', href: '#candidate.c-priya' })
    expect(describeRecord(db, 'offers', 'o-1')).toEqual({ label: 'the offer for Priya Offlineson', href: '#candidate.c-priya' })
    expect(describeRecord(db, 'people', 'p-founder')).toEqual({ label: 'Ada Lovelace', href: '#person.p-founder' })
  })
  it('names documents by what they hold, linking to where they are edited', () => {
    expect(describeRecord(db, '$doc', 'company')).toEqual({ label: 'Company details', href: '#settings.company' })
    expect(describeRecord(db, '$doc', 'settings').href).toBe('#settings.hiring')
    expect(describeRecord(db, '$doc', 'equity').href).toBe('#comp.equity')
  })
  it('names a note by what it is about', () => {
    expect(describeRecord(db, 'activity', 'act-note')).toEqual({ label: 'a note on Priya Offlineson', href: '#candidate.c-priya' })
    expect(describeRecord(db, 'activity', 'act-edit')).toEqual({ label: 'an activity log entry about the ML engineer (agents) job', href: '#job.j-ml' })
  })
  it('names a record the server removed by its kind, with no link', () => {
    expect(describeRecord(db, 'jobs', 'j-gone')).toEqual({ label: 'a job your server removed', href: null })
    expect(describeRecord(db, 'interviews', 'i-gone')).toEqual({ label: 'an interview your server removed', href: null })
  })
})

describe('refreshedText and refreshedNames', () => {
  const db = makeDB()
  db.jobs.push({ id: 'j-ml', title: 'ML engineer (agents)' } as unknown as DB['jobs'][number])
  it('names the record that lost an edit', () => {
    expect(refreshedText(db, 1, [{ collection: 'jobs', id: 'j-ml' }])).toBe("Your edit to the ML engineer (agents) job was replaced by your server's copy.")
    expect(refreshedText(db, 1, [{ collection: '$doc', id: 'company' }])).toContain('Your edit to Company details was replaced')
  })
  it('names the newest three and counts the rest', () => {
    const keys = [
      { collection: 'people', id: 'p-founder' },
      { collection: '$doc', id: 'company' },
      { collection: 'jobs', id: 'j-ml' },
      { collection: '$doc', id: 'settings' },
    ]
    const { names, more } = refreshedNames(db, 5, keys)
    expect(names.map((n) => n.label)).toEqual(['Hiring settings and rules', 'the ML engineer (agents) job', 'Company details'])
    expect(more).toBe(2)
    expect(refreshedText(db, 5, keys)).toBe(
      "Your edits to Hiring settings and rules, the ML engineer (agents) job, Company details and 2 more were replaced by your server's copy.",
    )
  })
  it('falls back to a count when no record is named, and never says "at the same time"', () => {
    expect(refreshedText(db, 2, [])).toBe("This device's edits to 2 items were replaced by your server's copy.")
    expect(refreshedText(db, 1, [])).toBe("This device's edit to 1 item was replaced by your server's copy.")
    expect(refreshedText(db, 1, [{ collection: 'jobs', id: 'j-ml' }])).not.toMatch(/same time/)
  })
  it('never claims the server had a newer change: after a restore its copy is older (r2-43)', () => {
    const keys = [{ collection: 'jobs', id: 'j-ml' }]
    for (const text of [refreshedText(db, 1, keys), refreshedText(db, 3, keys), refreshedText(db, 1, []), refreshedText(db, 4, [])]) {
      expect(text).not.toMatch(/newer/)
    }
  })
})

describe('changes too large to sync (r1-05)', () => {
  it('says what to do with a note and with any other record, without blaming the server', () => {
    expect(tooLargeText({ label: 'a note on Priya Offlineson', href: null }, 'activity')).toBe(
      'A note on Priya Offlineson is too large to sync (over 256 KB). Discard it, then add a shorter one.',
    )
    expect(tooLargeText({ label: 'the ML engineer job', href: null }, 'jobs')).toBe(
      'The ML engineer job is too large to sync (over 256 KB). Shorten it, or discard this change.',
    )
    expect(refusedText(2)).toBe('Your server refused 2 changes. They are kept on this device until you retry.')
    expect(`${tooLargeText({ label: 'x', href: null }, 'jobs')} ${refusedText(1)}`).not.toMatch(/whoever runs/)
  })
})

describe('signed out on purpose (r1-10)', () => {
  it('keeps saying the user signed out, and says the session ended only when it did', () => {
    expect(signInSubtitle({ signedOutByUser: true })).toMatch(/^You signed out\./)
    expect(signInSubtitle({ signedOutByUser: false })).toMatch(/^Your session on the server ended\./)
    // On a demo server, which company's login carries on with this browser's copy.
    expect(signInSubtitle({ signedOutByUser: true, company: ' Acme Robots ' })).toMatch(/^You signed out\..* Sign in with a login of Acme Robots\.$/)
    expect(signInSubtitle({ signedOutByUser: true, company: ' ' })).not.toMatch(/login of/)
    const base = { status: 'signed_out', hold: null, pending: 4, pendingEdits: 2, storageFull: false } as const
    expect(statusView({ ...base, signedOutByUser: true }).sentence).toBe(
      'You signed out. Sign in to sync again; this browser keeps an offline copy until then. 2 changes are waiting in this browser.',
    )
    expect(statusView({ ...base, signedOutByUser: false }).sentence).toContain('Sign in to keep syncing')
  })
  it('counts waiting changes as the header chip does (r1-09)', () => {
    expect(statusView({ status: 'offline', hold: null, pending: 6, pendingEdits: 2, storageFull: false }).sentence).toContain('2 changes are waiting')
  })
})

describe('telling two workspaces with one name apart (r1-07)', () => {
  const hour = (i: number) => `2026-10-10T${String(10 + (i % 10)).padStart(2, '0')}:00:00.000Z`
  function worked(): DB {
    const db = makeDB({ company: 'Ledgerline AI' })
    db.meta.createdOn = '2026-10-09'
    db.company.phone = '408-555-0100'
    db.company.website = 'https://ledgerline.ai'
    db.company.eddAccountNumber = '123-4567-8'
    db.company.cashOnHand = 2_000_000
    db.company.linkOuts = { payroll: 'https://payroll.example' }
    db.company.fundingRounds = [{ id: 'fr-1' }, { id: 'fr-2' }] as unknown as DB['company']['fundingRounds']
    for (let i = 0; i < 48; i++) db.activity.push({ id: `act-${i}`, at: hour(i), entityType: 'company', entityId: 'company', kind: 'edited', text: 'Edit' })
    return db
  }
  function fresh(): DB {
    const db = makeDB({ company: 'Ledgerline AI' })
    db.meta.createdOn = '2026-10-10'
    db.activity = [{ id: 'act-start', at: '2026-10-10T08:00:00.000Z', entityType: 'company', entityId: 'company', kind: 'created', text: 'Started' }]
    return db
  }
  it('summarizes what was filled in, not only the counts', () => {
    const s = summarize(worked())
    expect(s.counts).toEqual({ people: 1, candidates: 0, jobs: 0 })
    expect(s.detail).toMatchObject({ createdOn: '2026-10-09', changesLogged: 48, fundingRounds: 2, settingsFilled: 5, lastChangeAt: hour(9) })
    expect(summarize(fresh()).detail?.settingsFilled).toBe(0)
    expect(describeDetail(summarize(fresh()))).toMatch(/^Created Oct 10, 2026, last change .+, 1 change logged, 0 company settings filled$/)
  })
  it('recommends the copy that is newer and holds more of the work, and says what replacing it would lose', () => {
    const server = summarize(worked())
    const local = summarize(fresh())
    expect(compareWorkspaces(local, server)).toBe('same_name')
    expect(recommendedCopy(local, server)).toBe('server')
    expect(moreWorkIn(server, local)).toEqual(['2 more funding rounds', '5 more company settings filled', '47 more logged changes'])
    expect(moreWorkIn(local, server)).toEqual([])
  })
  it('recommends nothing when one copy is newer but the other holds more, or for the sample', () => {
    const server = summarize(worked())
    const newerButEmpty = summarize(fresh())
    newerButEmpty.detail = { ...newerButEmpty.detail!, lastChangeAt: '2026-10-11T08:00:00.000Z' }
    expect(recommendedCopy(newerButEmpty, server)).toBeNull()
    expect(recommendedCopy({ ...summarize(fresh()), sample: true }, server)).toBeNull()
    expect(recommendedCopy({ companyName: 'Ledgerline AI', sample: false, counts: { people: 1, jobs: 0, candidates: 0 } }, server)).toBeNull()
  })
  it('joins a list in words', () => {
    expect(joinAnd(['a'])).toBe('a')
    expect(joinAnd(['a', 'b', 'c'])).toBe('a, b and c')
  })
})

describe('the sample banner after signing in or out (r2-38: it kept the page-load answer)', () => {
  const admin: SyncUser = { id: 'u-1', email: 'admin@e2e.test', role: 'admin' }
  it('keeps the page-load answer while the user is the one it had then', () => {
    expect(signedInHere({ signedIn: false, user: null }, null)).toBe(false)
    expect(signedInHere({ signedIn: true, user: admin }, admin)).toBe(true)
    // A user the server no longer knows (a saved session that ended) does not count as signed in.
    expect(signedInHere({ signedIn: false, user: admin }, admin)).toBe(false)
  })
  it('follows a sign-in or a sign-out made after the page loaded', () => {
    const signedIn: SyncUser = { ...admin }
    expect(signedInHere({ signedIn: false, user: null }, signedIn)).toBe(true)
    expect(signedInHere({ signedIn: false, user: admin }, signedIn)).toBe(true)
    expect(signedInHere({ signedIn: true, user: admin }, null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------
// End-to-end review, round 3
// ---------------------------------------------------------------------------------------------

describe('two copies that each hold something the other lacks (r3-02)', () => {
  // A disconnected browser edited the one-liner three times; the server got a candidate from B.
  function base(): DB {
    const db = makeDB({ company: 'Ledgerwise' })
    db.meta.createdOn = '2026-10-09'
    for (let i = 0; i < 19; i++) {
      db.activity.push({ id: `act-${i}`, at: `2026-10-10T10:${String(i).padStart(2, '0')}:00.000Z`, entityType: 'company', entityId: 'company', kind: 'edited', text: 'Edit' })
    }
    return db
  }
  function browserCopy(): DB {
    const db = base()
    for (let i = 0; i < 3; i++) {
      db.activity.push({ id: `act-line-${i}`, at: `2026-10-10T12:0${i}:00.000Z`, entityType: 'company', entityId: 'company', kind: 'edited', text: 'Changed the one-liner' })
    }
    return db
  }
  function serverCopy(): DB {
    const db = base()
    db.candidates.push({ id: 'c-b', firstName: 'Bea', lastName: 'Added' } as unknown as DB['candidates'][number])
    db.activity.push({ id: 'act-cand', at: '2026-10-10T11:00:00.000Z', entityType: 'candidate', entityId: 'c-b', kind: 'created', text: 'Added Bea' })
    return db
  }

  it('recommends neither copy when the one it would replace holds a record the other lacks', () => {
    const local = summarize(browserCopy())
    const server = summarize(serverCopy())
    expect(local.detail!.changesLogged).toBe(22)
    // The browser is newer and logged more changes, but the server holds a candidate it does not have.
    expect(recommendedCopy(local, server)).toBeNull()
    expect(missingRecords(server, local)).toEqual(['1 more candidate'])
    expect(missingRecords(local, server)).toEqual([])
    // What each choice would lose, for both warnings.
    expect(moreWorkIn(local, server)).toEqual(['2 more logged changes'])
    expect(moreWorkIn(server, local)).toEqual(['1 more candidate'])
  })

  it('a few activity rows never outweigh a record, and more records still win when nothing would be lost', () => {
    const local = summarize(browserCopy())
    const server = summarize(serverCopy())
    // The server's copy is the newer one now: it holds everything the browser has, plus a candidate.
    server.detail = { ...server.detail!, lastChangeAt: '2026-10-10T13:00:00.000Z', changesLogged: 25 }
    expect(recommendedCopy(local, server)).toBe('server')
    // Same records, newer and more logged changes: the tie goes to the copy with more of the log.
    expect(recommendedCopy(summarize(browserCopy()), summarize(base()))).toBe('local')
    // Each copy holds a record the other lacks: neither, whatever the dates say.
    const both = summarize(serverCopy())
    const other = summarize(browserCopy())
    other.counts = { ...other.counts, jobs: 1 }
    other.detail = { ...other.detail!, lastChangeAt: '2026-10-11T08:00:00.000Z' }
    expect(recommendedCopy(other, both)).toBeNull()
    expect(recommendedCopy(both, other)).toBeNull()
  })
})

describe('naming an edit that lost to a delete (r3-12)', () => {
  const db = makeDB()
  const ops = { collection: 'departments', id: 'd-research', removed: true as const, copy: { id: 'd-research', name: 'Research' } }

  it('names the removed record from the copy this browser had, with no link', () => {
    expect(db.departments.some((d) => d.id === 'd-research')).toBe(false)
    expect(describeRefreshed(db, ops)).toEqual({ label: 'the Research department', href: null, removed: true })
    expect(describeRefreshed(db, { collection: 'departments', id: 'd-gone', removed: true })).toEqual({ label: 'a department', href: null, removed: true })
  })

  it('says the edit was dropped because the record was removed', () => {
    expect(refreshedText(db, 1, [ops])).toBe('Your edit to the Research department was dropped: it was removed on another computer.')
    const db2 = makeDB()
    db2.jobs.push({ id: 'j-ml', title: 'ML engineer (agents)' } as unknown as DB['jobs'][number])
    expect(refreshedText(db2, 2, [{ collection: 'jobs', id: 'j-ml' }, ops])).toBe(
      "Your edit to the ML engineer (agents) job was replaced by your server's copy. Your edit to the Research department was dropped: it was removed on another computer.",
    )
    // Unnamed ones are not called removed.
    expect(refreshedText(db, 3, [ops])).toBe(
      "Your edit to the Research department was dropped: it was removed on another computer. 2 more edits were replaced by your server's copy.",
    )
    expect(refreshedNames(db, 1, [ops]).names).toEqual([{ label: 'the Research department', href: null, removed: true }])
  })
})

describe('changes too large to sync, for records with no way to shorten them (r3-14)', () => {
  it('says Shorten it only where the app can edit the long text', () => {
    expect(tooLargeTail('jobs')).toContain('Shorten it, or discard this change.')
    expect(tooLargeTail('candidates')).toContain('Shorten it')
    // A contractor's scope can be edited on its page.
    expect(tooLargeTail('contractors')).toContain('Shorten it')
    expect(tooLargeText({ label: "Ada Lovelace's checklist", href: null }, 'checklists')).toBe(
      "Ada Lovelace's checklist is too large to sync (over 256 KB). Discard this change, then add it again with shorter text.",
    )
    expect(tooLargeTail('activity')).toContain('Discard it, then add a shorter one.')
    expect(tooLargeManyText(2, ['jobs', 'candidates'])).toContain('Shorten them, or discard them.')
    expect(tooLargeManyText(2, ['jobs', 'checklists'])).toBe(
      '2 changes are too large to sync (over 256 KB). Discard them, then add them again with shorter text.',
    )
  })
})

describe('signed out, or a session that ended (r3-09)', () => {
  it('words the header the way Settings, Server does', () => {
    expect(signedOutText({ signedOutByUser: true })).toBe('You signed out of your server. Changes stay on this device until you sign in again.')
    expect(signedOutText({ signedOutByUser: false })).toBe('Your session on your server ended. Changes stay on this device until you sign in again.')
    expect(signedOutText({ signedOutByUser: true, logoutPending: true })).toMatch(/session stays open until this browser reaches it again\.$/)
    const chip = (signedOutByUser: boolean) =>
      syncView({ status: 'signed_out', mode: 'server', pending: 0, rejected: 0, lastSyncAt: null, lastError: null, hold: null, user: null, signedOutByUser })
    expect(chip(false)!.tip).toMatch(/^Your session on your server ended\./)
    expect(chip(true)!.tip).toMatch(/^You signed out of your server\./)
  })
})

describe('a link to Settings, Server clicked on that page (post-merge: the banner linked to the page it was on)', () => {
  const page = (...present: string[]) => (selector: string) => present.includes(selector)

  it('goes to the sign-in form first', () => {
    expect(serverStep(page('#server-signin input[name="username"]', '#server-connect'))).toEqual({ kind: 'signin' })
  })

  it('else to the first step panel that shows: Upload, a paused sync, the status', () => {
    expect(serverStep(page('#server-connect', '#server-status'))).toEqual({ kind: 'panel', id: 'server-connect' })
    expect(serverStep(page('#server-hold', '#server-status'))).toEqual({ kind: 'panel', id: 'server-hold' })
    expect(serverStep(page('#server-status'))).toEqual({ kind: 'panel', id: 'server-status' })
  })

  it('leaves the link alone when no step shows (a server check still running)', () => {
    expect(serverStep(page())).toBeNull()
  })
})
