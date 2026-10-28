// The journey kit itself (kit.ts): another computer of the admin gets the same workspace, act refuses what
// the app's act() refuses and a change that changes nothing, the clock only moves forward, sql reads as the
// server's role in a read-only transaction on the journey's day, a failed step prints the failure dump, and
// what the browsers change happens at noon in California, as their Viewing as, with ids from the journey's seed.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { approveOffer } from '@/domain/hiring'
import { changeJobOrPay } from '@/domain/lifecycle'
import { nowISO, today } from '@/lib/dates'
import { diffDB } from '../../../src/sync/diff'
import { type Journey, startJourney } from './kit'

describe('the journey kit', () => {
  let j: Journey

  beforeAll(async () => {
    j = await startJourney()
  }, 60_000)
  afterAll(async () => {
    await j?.close()
  })

  it('starts with the admin connected to the uploaded sample and the careers page on', () => {
    expect(j.admin.status()).toMatchObject({ status: 'synced', mode: 'server', pending: 0, hold: null })
    expect(j.admin.db().company.name).toBe('Ledgerlark')
    expect(j.careersUrl).toBe('https://careers.journey.test/ledgerlark/')
  })

  it("connects another computer of the admin, which takes the server's copy", async () => {
    const laptop = await j.connect('laptop')
    expect(laptop.userId).toBe(j.admin.userId)
    expect(diffDB(j.admin.db(), laptop.db())).toEqual([])
  })

  it('refuses what the domain refuses and a change that changes nothing, naming the browser and the label', async () => {
    await expect(j.act(j.admin, 'Approved a missing offer', (d) => approveOffer(d, 'o-missing', { approverId: 'p-founder', at: nowISO() }))).rejects.toThrow(
      'admin: "Approved a missing offer" was refused: Offer not found.',
    )
    await expect(j.act(j.admin, 'Did nothing', () => false)).rejects.toThrow('admin: "Did nothing" was refused: nothing changed')
    await expect(j.act(j.admin, 'Looked around', () => undefined)).rejects.toThrow('admin: "Looked around" changed nothing')
    expect(j.admin.status()).toMatchObject({ pending: 0, rejected: 0 })
  })

  it('moves the clock forward only', () => {
    const day = today()
    expect(() => j.advanceTo('2026-01-01')).toThrow(`the journey's clock only moves forward (today is ${day}, asked for 2026-01-01)`)
    j.advanceTo('2026-10-12')
    expect(today()).toBe('2026-10-12')
  })

  it("reads as the server's role, read-only, with the read model's today on the journey's day", async () => {
    expect(await j.sql(`SELECT current_user AS who, ft_today()::text AS day`)).toEqual([{ who: 'first_twenty', day: today() }])
    await expect(j.sql(`INSERT INTO jobs (workspace_id, id, data) VALUES ('default', 'j-x', '{}'::jsonb)`)).rejects.toThrow(/read-only transaction/)
  })

  it('prints the step log, the hire journeys, the integrity problems and the change log when a step fails', async () => {
    const printed: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(' ')))
    try {
      await expect(
        j.step('a step that fails', () => {
          throw new Error('on purpose')
        }),
      ).rejects.toThrow('Journey step "a step that fails" failed: on purpose')
    } finally {
      spy.mockRestore()
    }
    const dump = printed.join('\n')
    expect(dump).toContain('2026-10-12  step: a step that fails')
    expect(dump).toContain('2026-10-12  FAILED: a step that fails')
    expect(dump).toMatch(/v_hire_journey, the 8 newest hires[^\n]*\n {2}\{"application_id":"a-hire-mei"/)
    expect(dump).toContain('v_integrity_problems:\n  (none)')
    expect(dump).toMatch(/change_log, the last 25 writes[^\n]*\n {2}\{"seq":\d+,"collection":"[^"]+","record_id":"[^"]+","op":"upsert","user":"admin@example.com"\}/)
  })

  it("makes a browser's changes at noon in California as its Viewing as, with ids from the journey's seed, on load too", async () => {
    const { admin } = j
    const before = new Set(admin.db().activity.map((a) => a.id))
    // A new title from next Monday, as Change job or pay records it (no actor passed: the Viewing as one logs it).
    const recordId = await j.act(admin, 'Recorded a title change for Priya Nair', (d) =>
      changeJobOrPay(d, 'p-priya', { effectiveOn: '2026-10-19', reason: 'title_only', title: 'Head of applied AI' }, { date: today() }),
    )
    expect(recordId).toMatch(/^cr-s[0-9a-z]{9}$/)
    const added = admin.db().activity.filter((a) => !before.has(a.id))
    expect(added.map((a) => a.kind)).toContain('job_changed')
    for (const row of added) {
      expect(row).toMatchObject({ id: expect.stringMatching(/^act-s[0-9a-z]{9}$/), at: '2026-10-12T19:00:00.000Z', actorId: admin.viewerId(), viewingAs: 'admin' })
    }

    // Another computer opens the workspace on that Monday and applies the change on load, in a run too. The
    // row's id is one every device shares (src/sync/loadTime.ts renames a run's id as it renames a random one).
    j.advanceTo('2026-10-19')
    const desk = await j.connect('desk')
    const seen = new Set(admin.db().activity.map((a) => a.id))
    expect(desk.db().activity.filter((a) => !seen.has(a.id) && a.kind === 'job_change_effective')).toEqual([
      expect.objectContaining({ id: expect.stringMatching(/^act-auto-/), entityId: 'p-priya', at: '2026-10-19T19:00:00.000Z', actorId: desk.viewerId(), viewingAs: 'admin' }),
    ])
  })
})
