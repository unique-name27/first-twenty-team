import { describe, expect, it } from 'vitest'
import { planAutoconnect } from './autoconnect'

const base = { explicit: false, connected: false, localIsSample: true, doneStackId: null, stackId: 'stack-b' }

describe('planAutoconnect', () => {
  it('signs a fresh browser holding the sample in', () => {
    expect(planAutoconnect(base)).toBe('connect')
  })

  it('does it once per stack database', () => {
    expect(planAutoconnect({ ...base, doneStackId: 'stack-b' })).toBe('skip')
    expect(planAutoconnect({ ...base, connected: true, doneStackId: 'stack-b' })).toBe('skip')
  })

  it('always signs in for #dev.signin', () => {
    expect(planAutoconnect({ ...base, explicit: true, doneStackId: 'stack-b' })).toBe('connect')
    expect(planAutoconnect({ ...base, explicit: true, localIsSample: false })).toBe('connect')
  })

  it('never replaces a workspace of your own on load: it only says how', () => {
    expect(planAutoconnect({ ...base, localIsSample: false })).toBe('offer')
    expect(planAutoconnect({ ...base, localIsSample: false, connected: true, doneStackId: 'stack-a' })).toBe('offer')
  })

  it('moves to the new database after --fresh deleted the one it synced with', () => {
    expect(planAutoconnect({ ...base, connected: true, doneStackId: 'stack-a' })).toBe('replace')
  })

  it('leaves a connection made some other way alone', () => {
    expect(planAutoconnect({ ...base, connected: true })).toBe('skip')
  })
})
