// The look contract (docs/LOOKS.md), checked on the stylesheets themselves: every look defines the
// complete token list, every rule is scoped to its own [data-look], and nothing leaks between looks.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LOOK, LOOK_IDS, RENAMED_LOOKS, savedLook } from './ids'

const TOKENS = [
  // Color
  '--paper', '--surface', '--surface-2', '--surface-3', '--ink', '--ink-2', '--ink-3', '--line', '--line-strong',
  '--control-border', '--accent', '--accent-hover', '--accent-ink', '--accent-soft', '--accent-soft-ink', '--good',
  '--good-soft', '--warn', '--warn-soft', '--bad', '--bad-soft', '--focus', '--scrim',
  '--cat-1', '--cat-2', '--cat-3', '--cat-4', '--cat-5', '--cat-6',
  // Type
  '--font-display', '--font-body', '--font-mono', '--font-size-base', '--line-height-base', '--heading-weight',
  '--heading-transform', '--heading-tracking', '--eyebrow-transform', '--eyebrow-tracking',
  // Shape and depth
  '--r-sm', '--r-md', '--r-lg', '--r-xl', '--r-2xl', '--r-pill', '--border-w', '--border-w-strong', '--shadow-sm',
  '--shadow', '--shadow-lg', '--focus-width', '--focus-style', '--focus-offset',
]

function css(id: string): string {
  const raw = readFileSync(fileURLToPath(new URL(`./${id}.css`, import.meta.url)), 'utf8')
  return raw.replace(/\/\*[\s\S]*?\*\//g, '')
}

type Rule = { prelude: string; body: string; kind: 'style' | 'group' | 'keyframes' | 'other' }

/** Top-level and @media-nested rules with their preludes (enough structure for these checks). */
function rules(src: string): Rule[] {
  const out: Rule[] = []
  const stack: Array<Rule & { start: number }> = []
  let preludeStart = 0
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') {
      const prelude = src.slice(preludeStart, i).trim()
      const parent = stack[stack.length - 1]
      let kind: Rule['kind'] = 'style'
      if (/^@(media|supports|container|layer|scope)\b/.test(prelude)) kind = 'group'
      else if (/^@(-webkit-)?keyframes\b/.test(prelude)) kind = 'keyframes'
      else if (prelude.startsWith('@')) kind = 'other'
      // Keyframe steps and nested rules inside a style rule (CSS nesting) are not checked on their own.
      else if (parent && parent.kind !== 'group') kind = 'other'
      stack.push({ prelude, body: '', kind, start: i + 1 })
      preludeStart = i + 1
    } else if (ch === '}') {
      const r = stack.pop()
      if (r) out.push({ prelude: r.prelude, body: src.slice(r.start, i), kind: r.kind })
      preludeStart = i + 1
    } else if (ch === ';') {
      preludeStart = i + 1
    }
  }
  return out
}

describe('looks (docs/LOOKS.md)', () => {
  for (const id of LOOK_IDS) {
    describe(id, () => {
      const src = css(id)
      const all = rules(src)

      it('defines the complete token list and color-scheme', () => {
        const missing = TOKENS.filter((t) => !new RegExp(`${t}\\s*:`).test(src))
        expect(missing).toEqual([])
        expect(src).toMatch(/color-scheme\s*:/)
      })

      it(`scopes every rule to [data-look="${id}"]`, () => {
        const scope = `[data-look="${id}"]`
        const unscoped = all
          .filter((r) => r.kind === 'style')
          .flatMap((r) => r.prelude.split(','))
          .map((s) => s.trim())
          .filter((s) => !s.includes(scope) && !(id === 'sleek' && s === ':where(:root)'))
        expect(unscoped).toEqual([])
      })

      it('names its keyframes after itself and keeps fonts in fonts.css', () => {
        const names = all.filter((r) => r.kind === 'keyframes').map((r) => r.prelude.replace(/^@(-webkit-)?keyframes\s+/, ''))
        expect(names.filter((n) => !n.startsWith(`ft-${id}-`))).toEqual([])
        expect(all.some((r) => r.prelude.startsWith('@font-face'))).toBe(false)
        expect(src).not.toMatch(/@import/)
      })
    })
  }

  it('only the looks with light and dark react to data-theme or the OS setting', () => {
    for (const id of LOOK_IDS) {
      const src = css(id)
      if (id === 'sleek') continue
      expect(src).not.toMatch(/data-theme|prefers-color-scheme/)
    }
  })

  it('ships the trading desk in place of the green-bar ledger', () => {
    expect(LOOK_IDS).toEqual(['sleek', 'web90s', 'comic', 'trading'])
    expect(LOOK_IDS).not.toContain('ledger')
  })
})

describe('saved look migration', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('moves a renamed look to its new id and keeps every current one', () => {
    expect(RENAMED_LOOKS.ledger).toBe('trading')
    expect(savedLook('ledger')).toBe('trading')
    for (const id of LOOK_IDS) expect(savedLook(id)).toBe(id)
  })

  it('falls back to the default for anything unknown', () => {
    for (const v of [undefined, null, '', 'green-bar', 'toString', 'constructor', 42, {}]) expect(savedLook(v)).toBe(DEFAULT_LOOK)
  })

  it("loads a saved 'ledger' preference as 'trading' and keeps the other prefs", async () => {
    const saved = JSON.stringify({ look: 'ledger', textScale: 1.3, privacyBlur: true })
    const store = new Map([['first-twenty:prefs:v1', saved]])
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
    vi.resetModules()
    const { usePrefs } = await import('@/store/prefs')
    const p = usePrefs.getState()
    expect(p.look).toBe('trading')
    expect(p.textScale).toBe(1.3)
    expect(p.privacyBlur).toBe(true)
  })

  it("keeps index.html's pre-paint script in step with the look ids and the rename", () => {
    const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8')
    expect(html).toContain(`[${LOOK_IDS.map((id) => `'${id}'`).join(', ')}]`)
    for (const [from, to] of Object.entries(RENAMED_LOOKS)) expect(html).toContain(`p.look === '${from}' ? '${to}'`)
  })
})
