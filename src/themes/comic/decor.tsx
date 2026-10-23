// Decorations for the comic look (docs/LOOKS.md, "Decor slots"). Optional components the shell renders
// while this look is active: Banner (top of the main column), Footer (bottom of it) and
// Headcount({ count, incoming }) in place of the rail's tally meter. Decor never covers content,
// never takes focus, respects reduced motion and carries no information that is not shown elsewhere:
// everything here is aria-hidden flavor (the issue number is the headcount the rail already shows).
// Styles live in src/themes/comic.css under the cmx- class prefix.
import { useRoute } from '@/app/router'
import { headcountOn } from '@/domain/people'
import { parseDate, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import type { HeadcountDecorProps, LookDecor } from '../registry'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A Silver Age masthead. Home is the cover: the corner box (price, issue number, month), the imprint and
 * the big logo. Interior pages carry only a slim imprint strip, so the cover gag costs its height once
 * and every other page starts with its own title.
 */
function Masthead() {
  const company = useDB((s) => s.db.company.name)
  const issue = useDB((s) => headcountOn(s.db))
  const month = MONTHS[parseDate(today()).getMonth()]
  const cover = useRoute().view === 'home'
  if (!cover) {
    return (
      <div aria-hidden className="cmx-mast cmx-mast--slim">
        <div className="cmx-mast__box">
          <span className="cmx-mast__price">12¢</span>
        </div>
        <span className="cmx-mast__imprint">
          {company} Comics · No. {issue}
          <span className="cmx-mast__month"> · {month}</span>
        </span>
        <span className="cmx-mast__dots" />
        <BenDayDefs />
      </div>
    )
  }
  return (
    <div aria-hidden className="cmx-mast">
      <div className="cmx-mast__box">
        <span className="cmx-mast__price">12¢</span>
        <span className="cmx-mast__issue">
          <span>No. {issue}</span>
          <span>{month}</span>
        </span>
      </div>
      <div className="cmx-mast__title">
        <span className="cmx-mast__imprint">{company} Comics presents</span>
        <span className="cmx-mast__name">The first twenty</span>
      </div>
      <span className="cmx-mast__dots" />
      <BenDayDefs />
    </div>
  )
}

// Fill colors the step chart uses for its areas (charts.tsx: the first series is the accent).
const BENDAY = [
  ['accent', 'var(--accent)'],
  ['cat-2', 'var(--cat-2)'],
  ['cat-3', 'var(--cat-3)'],
] as const

/**
 * Ben-Day dot patterns (a staggered screen, like print halftone) that comic.css uses to fill step chart
 * areas. Drawn once with the masthead; zero size, out of the accessibility tree.
 */
function BenDayDefs() {
  return (
    <svg aria-hidden focusable="false" width="0" height="0" className="cmx-defs">
      <defs>
        {BENDAY.map(([id, color]) => (
          <pattern key={id} id={`cmx-benday-${id}`} width="6" height="6" patternUnits="userSpaceOnUse">
            <circle cx="1.5" cy="1.5" r="1.25" fill={color} fillOpacity="0.5" />
            <circle cx="4.5" cy="4.5" r="1.25" fill={color} fillOpacity="0.5" />
          </pattern>
        ))}
      </defs>
    </svg>
  )
}

/** The last caption of the issue. */
function ToBeContinued() {
  return (
    <div aria-hidden className="cmx-tbc">
      <span className="cmx-tbc__box">To be continued...</span>
    </div>
  )
}

// Small deterministic wobble so the marker strokes look hand-drawn, not like a bar code.
const jit = (n: number, k: number) => ((((n + 1) * (37 + k * 11)) % 13) / 13 - 0.5) * 2

/**
 * Headcount drawn as bold marker tally marks: black strokes for people here, blue dashed strokes for
 * people starting soon, faint pencil strokes for open slots, a red slash across every full group of
 * five. The number and label above it stay (they carry the information); this is decoration.
 */
function MarkerTally({ count, incoming }: HeadcountDecorProps) {
  const slots = Math.max(20, Math.ceil((count + incoming) / 5) * 5)
  const groups = slots / 5
  const W = 216
  const gap = groups > 4 ? 7 : 12
  const groupW = (W - gap * (groups - 1)) / groups
  const step = (groupW - 6) / 4
  const top = 4
  const bottom = 32
  const state = (n: number) => (n < count ? 'on' : n < count + incoming ? 'incoming' : 'off')
  const marks = []
  for (let g = 0; g < groups; g++) {
    const x0 = g * (groupW + gap) + 3
    for (let i = 0; i < 4; i++) {
      const n = g * 5 + i
      const s = state(n)
      const x = x0 + i * step + step / 2
      const d = `M${(x + jit(n, 1) * 1.2).toFixed(1)} ${top + 1 + jit(n, 2)} Q${(x + jit(n, 3) * 2.2).toFixed(1)} ${(top + bottom) / 2} ${(x + jit(n, 4) * 1.4).toFixed(1)} ${bottom - jit(n, 5)}`
      marks.push(
        <path
          key={`m${n}`}
          d={d}
          className={`cmx-tally__mark cmx-tally__mark--${s}`}
          strokeWidth={s === 'off' ? 2 : 3.6 + jit(n, 6) * 0.5}
        />,
      )
    }
    const n5 = g * 5 + 4
    const s5 = state(n5)
    marks.push(
      <path
        key={`d${g}`}
        d={`M${x0 - 2} ${bottom - 5 + jit(g, 7)} Q${x0 + groupW / 2} ${(top + bottom) / 2 + 3 + jit(g, 8) * 2} ${x0 + groupW + 1} ${top + 5 + jit(g, 9)}`}
        className={`cmx-tally__slash cmx-tally__slash--${s5}`}
        strokeWidth={s5 === 'off' ? 2 : 4.2}
      />,
    )
    marks.push(
      <text key={`s${g}`} x={x0 + groupW / 2} y={bottom + 15} textAnchor="middle" className="cmx-tally__scale">
        {(g + 1) * 5}
      </text>,
    )
  }
  return (
    <svg aria-hidden width={W} height={bottom + 18} viewBox={`0 0 ${W} ${bottom + 18}`} className="cmx-tally block">
      {marks}
    </svg>
  )
}

export const decor: LookDecor = {
  Banner: Masthead,
  Footer: ToBeContinued,
  Headcount: MarkerTally,
}
