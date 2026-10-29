// Open in the app, Back to my company and Keep. With stand-ins, the order of the steps and each refusal; with
// a real sync engine on the fake server, that nothing reaches the server while the simulated company is open,
// even with an edit queued from before, that Back leaves the store and the outbox exactly as they were and
// syncing goes again by itself, that Open waits for a running sync on the real date, and that it refuses
// while a connect flow is on the wire.
import type { Draft } from 'immer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DB } from '@/domain/types'
import { getClockOverride, setClockOverride } from '@/lib/dates'
import type { HistoryEntry } from '@/store/db'
import { createSyncEngine, DEBOUNCE_MS, type SyncEngine } from '@/sync/engine'
import { FakeServer } from '@/sync/testing/fakeServer'
import { createStatusStore, createTestStore, makeDB, makePerson, memoryStorage, testEnv } from '@/sync/testing/kit'
import { KEEP_LIMIT } from './helpers'
import { createSandbox, KEEP_LABEL, type SandboxDeps } from './sandbox'

const SIM_DATE = '2027-03-04'

function simulated(name = 'Tidebeam'): DB {
  const db = makeDB({ company: name })
  db.people.push(makePerson('p-sim-1'), makePerson('p-sim-2'))
  return db
}

/** A sandbox on stand-ins that write down every step, in order. */
function standIns(over: Partial<SandboxDeps> = {}) {
  const log: string[] = []
  const original = makeDB({ company: 'Ledgerlark' })
  const past: HistoryEntry[] = [{ db: makeDB({ company: 'Earlier' }), label: 'An edit', id: 1, at: 0 }]
  let state = { db: original, past }
  let clock: string | null = null
  let held = 0
  const replaced: Array<[DB, string]> = []
  const deps: SandboxDeps = {
    store: {
      getState: () => state,
      setState: (next) => {
        log.push(`store ${next.db.company.name}`)
        state = next
      },
    },
    getClock: () => clock,
    setClock: (d) => {
      log.push(`clock ${d}`)
      clock = d
    },
    syncNow: async () => {
      log.push(`syncNow (clock ${clock})`)
    },
    whenIdle: async () => {
      log.push(`whenIdle (clock ${clock})`)
    },
    holdPersisting: () => {
      log.push('hold')
      held += 1
      return () => {
        log.push('release')
        held -= 1
      }
    },
    blocked: () => null,
    connected: () => false,
    replaceWorkspace: async (db, label) => {
      log.push('replaceWorkspace')
      replaced.push([db, label])
      return { ok: true }
    },
    replaceLocal: (db, label) => {
      log.push('replaceLocal')
      replaced.push([db, label])
    },
    download: () => {
      log.push('download')
      return true
    },
    pretendToday: (d) => log.push(`pretend ${d}`),
    newWorkspaceId: () => 'ws-kept',
    go: (hash) => log.push(`go ${hash}`),
    ...over,
  }
  return { sandbox: createSandbox(deps), log, state: () => state, original, past, clock: () => clock, held: () => held, replaced, setClock: (d: string | null) => (clock = d) }
}

describe('the sandbox, step by step', () => {
  it('waits for a running sync on the real date, then sets the clock, then holds saving and swaps the company in', async () => {
    const t = standIns()
    const sim = simulated()
    expect(await t.sandbox.open({ db: sim, date: SIM_DATE, companyName: 'Tidebeam' })).toMatchObject({ ok: true })
    expect(t.log).toEqual(['whenIdle (clock null)', `clock ${SIM_DATE}`, `syncNow (clock ${SIM_DATE})`, 'hold', 'store Tidebeam', 'go #home'])
    expect(t.state().past).toEqual([])
    expect((t.state().db.meta as { workspaceId?: string }).workspaceId).toBe(`ws-sim-${SIM_DATE}`)
    expect(t.state().db.people).toBe(sim.people)
    expect(t.sandbox.view.getState()).toEqual({ open: true, date: SIM_DATE, companyName: 'Tidebeam', originalName: 'Ledgerlark' })
    expect(t.held()).toBe(1)
  })

  it('puts back the same company and Undo history while the clock is still on, then the clock, then saving', async () => {
    const t = standIns()
    t.setClock('2026-12-01')
    await t.sandbox.open({ db: simulated(), date: SIM_DATE, companyName: 'Tidebeam' })
    t.log.length = 0
    t.sandbox.back()
    expect(t.log).toEqual(['store Ledgerlark', 'clock 2026-12-01', 'release', 'go #sim'])
    expect(t.state().db).toBe(t.original)
    expect(t.state().past).toBe(t.past)
    expect(t.clock()).toBe('2026-12-01')
    expect(t.held()).toBe(0)
    expect(t.sandbox.isOpen()).toBe(false)
    // Back again does nothing.
    t.sandbox.back()
    expect(t.log).toHaveLength(4)
    // Connected, Back then asks for a sync: timers that came due meanwhile scheduled nothing.
    const c = standIns({ connected: () => true })
    await c.sandbox.open({ db: simulated(), date: SIM_DATE, companyName: 'Tidebeam' })
    c.log.length = 0
    c.sandbox.back()
    expect(c.log).toEqual(['store Ledgerlark', 'clock null', 'release', 'syncNow (clock null)', 'go #sim'])
  })

  it('refuses to open twice, or while something else holds the connection, also once a running sync is done', async () => {
    const busy = standIns({ blocked: () => 'The dev sign-in is still connecting.' })
    expect(await busy.sandbox.open({ db: simulated(), date: SIM_DATE, companyName: 'Tidebeam' })).toEqual({ ok: false, message: 'The dev sign-in is still connecting.' })
    expect(busy.log).toEqual([])
    let flowStarted = false
    const later = standIns({ blocked: () => (flowStarted ? 'A sign-in or server step in Settings is still running.' : null), whenIdle: async () => void (flowStarted = true) })
    expect(await later.sandbox.open({ db: simulated(), date: SIM_DATE, companyName: 'Tidebeam' })).toMatchObject({ ok: false, message: 'A sign-in or server step in Settings is still running.' })
    expect(later.log).toEqual([])
    expect(later.clock()).toBeNull()
    const t = standIns()
    await t.sandbox.open({ db: simulated(), date: SIM_DATE, companyName: 'Tidebeam' })
    expect(await t.sandbox.open({ db: simulated(), date: SIM_DATE, companyName: 'Tidebeam' })).toMatchObject({ ok: false })
  })

  it('tells when the simulated company was edited in the app', async () => {
    const t = standIns()
    await t.sandbox.open({ db: simulated(), date: SIM_DATE, companyName: 'Tidebeam' })
    expect(t.sandbox.edited()).toBe(false)
    t.state().db = { ...t.state().db, company: { ...t.state().db.company, name: 'Edited' } }
    expect(t.sandbox.edited()).toBe(true)
  })
})

describe('keeping the simulated company', () => {
  it('not connected: goes back first, then replaces the company in one Undo step, under a new identity', async () => {
    const t = standIns()
    await t.sandbox.open({ db: simulated(), date: SIM_DATE, companyName: 'Tidebeam' })
    t.log.length = 0
    const done = await t.sandbox.keep({ downloadOriginal: true, pretend: false })
    expect(done).toMatchObject({ ok: true, message: expect.stringMatching(/^Kept Tidebeam as your company/) })
    expect(t.log).toEqual(['download', 'store Ledgerlark', 'clock null', 'release', 'replaceLocal', 'go #home'])
    const [kept, label] = t.replaced[0]
    expect(label).toBe(KEEP_LABEL)
    expect(kept.company.name).toBe('Tidebeam')
    expect(kept.meta).toMatchObject({ workspaceId: 'ws-kept', sample: false })
  })

  it('connected: replaces the server copy once, and says so when the server refuses', async () => {
    const ok = standIns({ connected: () => true })
    await ok.sandbox.open({ db: simulated(), date: SIM_DATE, companyName: 'Tidebeam' })
    expect(await ok.sandbox.keep({ downloadOriginal: false, pretend: true })).toMatchObject({ ok: true })
    expect(ok.log.filter((l) => l === 'replaceWorkspace')).toHaveLength(1)
    expect(ok.log.at(-1)).toBe(`pretend ${SIM_DATE}`)
    const refused = standIns({ connected: () => true, replaceWorkspace: async () => ({ ok: false, message: 'The server cannot be reached.' }) })
    await refused.sandbox.open({ db: simulated(), date: SIM_DATE, companyName: 'Tidebeam' })
    expect(await refused.sandbox.keep({ downloadOriginal: false, pretend: false })).toEqual({ ok: false, message: 'The server cannot be reached. Your company is as it was.' })
    expect(refused.state().db).toBe(refused.original)
  })

  it('refuses a company too big for a browser, or a blocked download, with the simulated company still open', async () => {
    const big = standIns()
    const huge = simulated()
    huge.company = { ...huge.company, mission: 'x'.repeat(KEEP_LIMIT) } as DB['company']
    await big.sandbox.open({ db: huge, date: SIM_DATE, companyName: 'Tidebeam' })
    expect(await big.sandbox.keep({ downloadOriginal: false, pretend: false })).toMatchObject({ ok: false, message: expect.stringMatching(/^Too big for this browser to keep \(4\.\d MB\)/) })
    expect(big.sandbox.isOpen()).toBe(true)
    const blocked = standIns({ download: () => false })
    await blocked.sandbox.open({ db: simulated(), date: SIM_DATE, companyName: 'Tidebeam' })
    expect(await blocked.sandbox.keep({ downloadOriginal: true, pretend: false })).toMatchObject({ ok: false, message: expect.stringMatching(/blocked the download of Ledgerlark/) })
    expect(blocked.sandbox.isOpen()).toBe(true)
    expect(blocked.replaced).toEqual([])
  })
})

/** A sandbox wired to a real sync engine, as appSandbox.ts wires it to the app's. */
function sandboxFor(store: ReturnType<typeof createTestStore>, engine: SyncEngine) {
  return createSandbox({
    store,
    getClock: getClockOverride,
    setClock: setClockOverride,
    syncNow: () => engine.syncNow(),
    whenIdle: () => engine.whenIdle(),
    holdPersisting: () => () => {},
    blocked: () => (engine.busy() ? 'A sign-in or server step in Settings is still running.' : null),
    connected: () => true,
    replaceWorkspace: async () => ({ ok: true }),
    replaceLocal: () => {},
    download: () => true,
    pretendToday: () => {},
    newWorkspaceId: () => 'ws-kept',
    go: () => {},
  })
}

/** Holds one kind of call to the fake server on the wire until the returned function lets it go. */
function onTheWire(server: FakeServer, name: 'getChanges' | 'getWorkspace'): () => void {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const real = (server[name] as (...a: unknown[]) => Promise<unknown>).bind(server)
  ;(server as unknown as Record<string, unknown>)[name] = async (...a: unknown[]) => {
    await gate
    return real(...a)
  }
  return release
}

const rename = (id: string, title: string) => (d: Draft<DB>) => {
  d.people.find((p) => p.id === id)!.title = title
}

describe('the sandbox with a real sync engine', () => {
  const stops: Array<() => void> = []
  /** A browser connected to the fake server with `db` uploaded. */
  async function connected(server: FakeServer, db: DB) {
    const store = createTestStore(db)
    const page = testEnv()
    const status = createStatusStore()
    const engine = createSyncEngine({ store, api: server, storage: memoryStorage(), env: page.env, status, clockOverride: getClockOverride })
    stops.push(() => engine.stop())
    expect(await engine.uploadLocal()).toEqual({ ok: true })
    await engine.whenIdle()
    return { store, page, status, engine }
  }
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-28T17:00:00.000Z') })
    setClockOverride(null)
  })
  afterEach(() => {
    for (const stop of stops.splice(0)) stop()
    vi.useRealTimers()
    setClockOverride(null)
  })

  it('sends nothing while open, and after Back the queued edit syncs and the simulated one never does', async () => {
    const server = new FakeServer()
    const db = makeDB()
    db.people.push(makePerson('p-1'), makePerson('p-2'))
    const { store, page, status, engine } = await connected(server, db)
    // An edit queued from before (the server could not be reached).
    server.online = false
    store.getState().mutate('Edit', rename('p-1', 'Queued before'))
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await engine.whenIdle()
    expect(status.getState().pending).toBe(1)
    server.online = true
    const before = { db: store.getState().db, past: store.getState().past, pending: status.getState().pending }

    const sandbox = sandboxFor(store, engine)
    const calls = server.calls.length
    const sim = simulated()
    expect(await sandbox.open({ db: sim, date: SIM_DATE, companyName: 'Tidebeam' })).toMatchObject({ ok: true })
    // Edits in the app, focus and coming online, a long wait and Sync now: nothing goes out.
    store.getState().mutate('Edit', rename('p-sim-1', 'Simulated edit'))
    page.emit('focus')
    page.emit('online')
    await vi.advanceTimersByTimeAsync(120_000)
    await engine.syncNow()
    expect(server.calls.length).toBe(calls)

    sandbox.back()
    expect(store.getState().db).toBe(before.db)
    expect(store.getState().past).toBe(before.past)
    expect(status.getState().pending).toBe(before.pending)
    expect(getClockOverride()).toBeNull()
    // Back asks for a sync itself: nobody presses Sync now.
    await vi.advanceTimersByTimeAsync(0)
    await engine.whenIdle()
    expect(status.getState().pending).toBe(0)
    expect(server.snapshot().people.find((p) => p.id === 'p-1')?.title).toBe('Queued before')
    expect(server.snapshot().people.some((p) => p.id.startsWith('p-sim'))).toBe(false)
    expect(server.snapshot().company.name).toBe('Acme')
    // The next edit syncs as usual.
    store.getState().mutate('Edit', rename('p-2', 'After the sandbox'))
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await engine.whenIdle()
    expect(server.snapshot().people.find((p) => p.id === 'p-2')?.title).toBe('After the sandbox')
  })

  it('pushes an edit made just before Open once Back comes, with no Sync now', async () => {
    const server = new FakeServer()
    const db = makeDB()
    db.people.push(makePerson('p-1'))
    const { store, status, engine } = await connected(server, db)
    // Queued, its push not yet due: the timer comes due while the simulated company is open.
    store.getState().mutate('Edit', rename('p-1', 'Edited just before'))
    const sandbox = sandboxFor(store, engine)
    expect(await sandbox.open({ db: simulated(), date: SIM_DATE, companyName: 'Tidebeam' })).toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(server.snapshot().people.find((p) => p.id === 'p-1')?.title).not.toBe('Edited just before')
    sandbox.back()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await engine.whenIdle()
    expect(server.snapshot().people.find((p) => p.id === 'p-1')?.title).toBe('Edited just before')
    expect(status.getState().pending).toBe(0)
  })

  it('waits for a sync on the wire on the real date, so an edit made meanwhile is queued and reaches the server', async () => {
    const server = new FakeServer()
    const db = makeDB()
    db.people.push(makePerson('p-1'))
    const { store, status, engine } = await connected(server, db)
    const release = onTheWire(server, 'getChanges')
    const cycle = engine.syncNow()
    await vi.advanceTimersByTimeAsync(5)
    const sandbox = sandboxFor(store, engine)
    const opening = sandbox.open({ db: simulated(), date: SIM_DATE, companyName: 'Tidebeam' })
    await vi.advanceTimersByTimeAsync(5)
    // Still the real company on the real date: an edit now is an ordinary edit.
    expect(getClockOverride()).toBeNull()
    expect(sandbox.isOpen()).toBe(false)
    store.getState().mutate('Edit', rename('p-1', 'Edited while opening'))
    expect(status.getState().pending).toBeGreaterThan(0)
    release()
    await cycle
    expect(await opening).toMatchObject({ ok: true })
    sandbox.back()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await engine.whenIdle()
    expect(server.snapshot().people.find((p) => p.id === 'p-1')?.title).toBe('Edited while opening')
    expect(status.getState().pending).toBe(0)
  })

  it("refuses while Use the server's copy is on the wire, so it can never land on the simulated company", async () => {
    const server = new FakeServer()
    const other = makeDB({ company: 'Wavecrest' })
    other.people.push(makePerson('p-w1'))
    await connected(server, other)
    const local = makeDB({ company: 'Localco' })
    local.people.push(makePerson('p-l1'))
    const store = createTestStore(local)
    const status = createStatusStore()
    const engine = createSyncEngine({ store, api: server, storage: memoryStorage(), env: testEnv().env, status, clockOverride: getClockOverride })
    stops.push(() => engine.stop())
    const release = onTheWire(server, 'getWorkspace')
    const flow = engine.useServerCopy()
    await vi.advanceTimersByTimeAsync(5)
    const sandbox = sandboxFor(store, engine)
    expect(await sandbox.open({ db: simulated(), date: SIM_DATE, companyName: 'Tidebeam' })).toEqual({ ok: false, message: 'A sign-in or server step in Settings is still running.' })
    expect(getClockOverride()).toBeNull()
    release()
    expect(await flow).toMatchObject({ ok: true })
    expect(store.getState().db.company.name).toBe('Wavecrest')
    // Once it is done, the sandbox opens and Back puts the server's company back.
    expect(await sandbox.open({ db: simulated(), date: SIM_DATE, companyName: 'Tidebeam' })).toMatchObject({ ok: true })
    sandbox.back()
    expect(store.getState().db.company.name).toBe('Wavecrest')
    store.getState().mutate('Edit', rename('p-w1', 'After the sandbox'))
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    await engine.whenIdle()
    expect(server.snapshot().people.map((p) => `${p.id}:${p.title}`)).toContain('p-w1:After the sandbox')
    expect(server.snapshot().people.some((p) => p.id === 'p-l1')).toBe(false)
  })
})
