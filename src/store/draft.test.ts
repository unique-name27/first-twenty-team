// Who an activity row says did it: the device's Viewing as, or inside a run (src/lib/runContext.ts) the
// run's explicit actor and Viewing-as, whatever the device's preferences say.
import { produce } from 'immer'
import { afterEach, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import type { Activity } from '@/domain/types'
import { setClockOverride } from '@/lib/dates'
import { withRunContext } from '@/lib/runContext'
import { currentActorId, logActivity } from './draft'
import { usePrefs } from './prefs'

const DEFAULT_VIEW = usePrefs.getState().viewAs
const db = blankDB({ companyName: 'Ledgerlark', founderFirstName: 'Avery', founderLastName: 'Quill', foundedOn: '2026-01-05' })
const NOTE = { entityType: 'person', entityId: 'p-founder', kind: 'note', text: 'Added a note' } as const

/** The activity row logActivity adds to the db. */
function logged(): Activity {
  const next = produce(db, (d) => logActivity(d, NOTE))
  return next.activity[next.activity.length - 1]
}

afterEach(() => {
  usePrefs.setState({ viewAs: DEFAULT_VIEW })
  setClockOverride(null)
})

describe('outside a run', () => {
  it("records the device's Viewing as, as before runs existed", () => {
    usePrefs.setState({ viewAs: { role: 'manager', personId: 'p-maya' } })
    expect(currentActorId(db)).toBe('p-maya')
    expect(logged()).toEqual({ id: expect.stringMatching(/^act-[0-9a-f]{10}$/), at: expect.any(String), actorId: 'p-maya', viewingAs: 'manager', ...NOTE })
    // Viewing as Admin with no saved person: the founder, as useViewer shows; without a db, no one.
    usePrefs.setState({ viewAs: { role: 'admin', personId: null } })
    expect(currentActorId(db)).toBe('p-founder')
    expect(currentActorId()).toBeNull()
    expect(logged()).toMatchObject({ actorId: 'p-founder', viewingAs: 'admin' })
  })
})

describe('inside a run', () => {
  it("records the run's actor and Viewing-as, at the run's time, with an id from its seed", () => {
    usePrefs.setState({ viewAs: { role: 'manager', personId: 'p-maya' } })
    setClockOverride('2026-10-09')
    const row = withRunContext({ seed: 1, actorId: 'p-dev', viewingAs: 'employee', timeOfDay: '12:00' }, () => {
      expect(currentActorId(db)).toBe('p-dev')
      expect(currentActorId()).toBe('p-dev')
      return logged()
    })
    expect(row).toEqual({ id: expect.stringMatching(/^act-s[0-9a-z]{9}$/), at: '2026-10-09T19:00:00.000Z', actorId: 'p-dev', viewingAs: 'employee', ...NOTE })
    expect(withRunContext({ seed: 1, actorId: 'p-dev', viewingAs: 'employee', timeOfDay: '12:00' }, logged)).toEqual(row)
  })

  it('views as Admin by default, and records no one for a null actor (not the founder, not the device)', () => {
    usePrefs.setState({ viewAs: { role: 'manager', personId: 'p-maya' } })
    setClockOverride('2026-10-09')
    const row = withRunContext({ seed: 2, actorId: null, timeOfDay: '12:00' }, () => {
      expect(currentActorId(db)).toBeNull()
      return logged()
    })
    expect(row).toMatchObject({ actorId: null, viewingAs: 'admin' })
  })

  it("never changes the device's preferences, and they apply again after the run", () => {
    usePrefs.setState({ viewAs: { role: 'manager', personId: 'p-maya' } })
    setClockOverride('2026-10-09')
    const before = usePrefs.getState().viewAs
    withRunContext({ seed: 3, actorId: 'p-dev', timeOfDay: '12:00' }, logged)
    expect(usePrefs.getState().viewAs).toBe(before)
    expect(logged()).toMatchObject({ id: expect.stringMatching(/^act-[0-9a-f]{10}$/), actorId: 'p-maya', viewingAs: 'manager' })
  })
})

