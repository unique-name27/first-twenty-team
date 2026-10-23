// Pure rules behind toasts and two-step confirms (post-merge review: toasts over dialogs, stacked Undo
// toasts, a confirm that disarmed itself after 4 seconds).
import { describe, expect, it } from 'vitest'
import { twoStepNext } from './Overlay'
import { nextToasts, pickToastSpot, TOAST_SIDE_MIN } from './Toast'

describe('toast stack', () => {
  const undo = (id: number, entryId: number) => ({ id, entryId })
  const plain = (id: number) => ({ id })

  it('lets a newer Undo toast replace the older Undo toasts (their Undo could only refuse)', () => {
    expect(nextToasts([undo(1, 10), undo(2, 11)], undo(3, 12)).map((t) => t.id)).toEqual([3])
  })

  it('keeps toasts without an Undo (a link to the change, a notice) next to it', () => {
    expect(nextToasts([plain(1), undo(2, 11)], undo(3, 12)).map((t) => t.id)).toEqual([1, 3])
    expect(nextToasts([undo(1, 10)], plain(2)).map((t) => t.id)).toEqual([1, 2])
  })

  it('never pulls out the toast that holds keyboard focus', () => {
    expect(nextToasts([undo(1, 10), undo(2, 11)], undo(3, 12), 1).map((t) => t.id)).toEqual([1, 3])
  })

  it('shows at most three, dropping the oldest', () => {
    expect(nextToasts([plain(1), plain(2), plain(3)], plain(4)).map((t) => t.id)).toEqual([2, 3, 4])
  })
})

describe('toast placement while a sheet or dialog is open', () => {
  const desktop = { width: 1280, height: 900 }
  const one = { width: 420, height: 52 }
  const three = { width: 420, height: 172 }

  it('goes beside a sheet on a wide window, over the dimmed page instead of the sheet fields', () => {
    const sheet = { left: 720, top: 0, right: 1280, bottom: 900 }
    expect(pickToastSpot(sheet, desktop, one, 16)).toBe('beside')
  })

  it('stays at the bottom below a short centered dialog', () => {
    const dialog = { left: 380, top: 108, right: 900, bottom: 520 }
    expect(pickToastSpot(dialog, desktop, one, 16)).toBe('bottom')
  })

  it('goes to the top above a tall dialog when it fits there, and beside it when it does not', () => {
    const tall = { left: 380, top: 108, right: 900, bottom: 880 }
    expect(pickToastSpot(tall, desktop, one, 16)).toBe('top')
    expect(pickToastSpot(tall, desktop, three, 16)).toBe('beside')
  })

  it('falls back to just above the footer where the dialog fills the window (a phone)', () => {
    const phone = { width: 375, height: 812 }
    expect(pickToastSpot({ left: 0, top: 0, right: 375, bottom: 812 }, phone, { width: 343, height: 52 }, 16)).toBe('footer')
    // A strip narrower than a toast needs is no room either.
    expect(pickToastSpot({ left: TOAST_SIDE_MIN - 1, top: 0, right: 900, bottom: 900 }, { width: 900, height: 900 }, one, 16)).toBe('footer')
  })
})

describe('two-step confirm', () => {
  it('arms on the first press and confirms on the second', () => {
    expect(twoStepNext(false, 'press')).toEqual({ armed: true, confirm: false })
    expect(twoStepNext(true, 'press')).toEqual({ armed: false, confirm: true })
  })

  it('disarms only when the person moves on: there is no timer that reverts it behind their back', () => {
    expect(twoStepNext(true, 'leave')).toEqual({ armed: false, confirm: false })
    expect(twoStepNext(false, 'leave')).toEqual({ armed: false, confirm: false })
    // The rule has no time input at all: an armed button stays armed until a press or a leave.
    expect(twoStepNext.length).toBe(2)
  })
})
