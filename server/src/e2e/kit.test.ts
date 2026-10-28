// The journey kit itself (kit.ts): another computer of the admin gets the same workspace, act refuses what
// the app's act() refuses and a change that changes nothing, the clock only moves forward, sql reads as the
// server's role in a read-only transaction on the journey's day, and a failed step prints the failure dump.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { approveOffer } from '@/domain/hiring'
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
})
