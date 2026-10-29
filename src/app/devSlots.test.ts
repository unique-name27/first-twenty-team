// The development slots: empty until src/dev registers something (only in a development build, main.tsx),
// and free of any development content themselves, since this module ships in every build.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { devSlots, registerDevNav, registerDevPage, setDevBanner } from './devSlots'

describe('development slots', () => {
  it('start empty', () => {
    expect(devSlots().pages).toEqual({})
    expect(devSlots().banner).toBeNull()
    expect(devSlots().nav).toEqual([])
  })

  it('keep one page and one link per view, the latest registered', () => {
    const A = () => null
    const B = () => null
    registerDevPage('lab', { component: A, title: 'Lab' })
    registerDevPage('lab', { component: B, title: 'Lab two' })
    expect(devSlots().pages.lab).toEqual({ component: B, title: 'Lab two' })
    registerDevNav({ view: 'lab', label: 'Lab', href: '#lab', icon: 'zap' })
    registerDevNav({ view: 'lab', label: 'Lab two', href: '#lab', icon: 'zap' })
    registerDevNav({ view: 'bench', label: 'Bench', href: '#bench', icon: 'zap' })
    expect(devSlots().nav.map((n) => n.label)).toEqual(['Lab two', 'Bench'])
    setDevBanner(A)
    expect(devSlots().banner).toBe(A)
    setDevBanner(null)
    expect(devSlots().banner).toBeNull()
  })

  it('names no development page, banner or marker in its own source', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const code = readFileSync(path.join(here, 'devSlots.ts'), 'utf8')
    expect(code).not.toMatch(/simulator|ft-dev-|__dev\//i)
  })
})
