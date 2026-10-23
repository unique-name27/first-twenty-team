// Settings, Server: a message from the server that appears below the fold is scrolled into view.
import { describe, expect, it } from 'vitest'
import { revealElement } from './serverFocus'

describe('revealElement', () => {
  it('scrolls a message into view by its nearest edge, without animation when motion is reduced', () => {
    const calls: unknown[] = []
    const el = { scrollIntoView: (opts?: boolean | ScrollIntoViewOptions) => void calls.push(opts) }
    revealElement(el, false)
    revealElement(el, true)
    expect(calls).toEqual([
      { block: 'nearest', behavior: 'smooth' },
      { block: 'nearest', behavior: 'auto' },
    ])
    // Nothing there yet, or a browser without scrolling: nothing happens.
    expect(() => revealElement(null)).not.toThrow()
    expect(() => revealElement({} as never)).not.toThrow()
  })
})
