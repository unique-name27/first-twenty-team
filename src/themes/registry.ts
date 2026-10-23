// The looks (visual skins) the app ships. docs/LOOKS.md is the contract: tokens, hook classes, decor.
// Each look's stylesheet is src/themes/<id>.css (imported by src/styles.css); its optional React
// decorations are src/themes/<id>/decor.tsx, registered here.
import type { ComponentType } from 'react'
import { decor as comicDecor } from './comic/decor'
import { type LookId, LOOK_IDS } from './ids'
import { decor as sleekDecor } from './sleek/decor'
import { decor as tradingDecor } from './trading/decor'
import { decor as web90sDecor } from './web90s/decor'

export { DEFAULT_LOOK, isLookId, LOOK_IDS, type LookId } from './ids'

export type HeadcountDecorProps = {
  /** Current employees (W-2, active). */
  count: number
  /** Accepted offers not yet started. */
  incoming: number
}

/**
 * Optional look-specific React decorations. The shell renders them only while the look is active:
 * Banner at the top of the main column, Footer at the bottom of it, Headcount in place of the tally
 * meter in the rail (the number and its label stay). Decor never covers content, never takes focus,
 * respects reduced motion, and carries no information that is not also shown normally.
 */
export type LookDecor = {
  Banner?: ComponentType
  Footer?: ComponentType
  Headcount?: ComponentType<HeadcountDecorProps>
}

export type LookInfo = {
  id: LookId
  /** Shown on the Display menu card and in the command palette ("Look: Comic book"). */
  name: string
  /** One line under the name on the card. Sentence case, no em dashes. */
  blurb: string
  /** True when the look has light and dark palettes (the Theme control applies). */
  supportsDark: boolean
  decor?: LookDecor
}

export const LOOKS: Record<LookId, LookInfo> = {
  sleek: {
    id: 'sleek',
    name: 'Sleek',
    blurb: 'Quiet and precise: crisp type, hairline rules, light or dark.',
    supportsDark: true,
    decor: sleekDecor,
  },
  web90s: {
    id: 'web90s',
    name: '1990s web',
    blurb: 'A 1997 company intranet: gray bevels, Times New Roman, blue links.',
    supportsDark: false,
    decor: web90sDecor,
  },
  comic: {
    id: 'comic',
    name: 'Comic book',
    blurb: 'Newsprint, inked outlines, halftone dots and hand-lettered titles.',
    supportsDark: false,
    decor: comicDecor,
  },
  trading: {
    id: 'trading',
    name: 'Trading desk',
    blurb: 'A dark trading terminal: amber labels, dense figures and a ticker tape.',
    supportsDark: false,
    decor: tradingDecor,
  },
}

/** Looks in display order. */
export const LOOK_LIST: LookInfo[] = LOOK_IDS.map((id) => LOOKS[id])
