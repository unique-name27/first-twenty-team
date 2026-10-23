// Decorations for the sleek look (docs/LOOKS.md, "Decor slots"). Optional components the shell renders
// while this look is active: Banner (top of the main column), Footer (bottom of it) and
// Headcount({ count, incoming }) in place of the rail's tally meter. Decor never covers content,
// never takes focus, respects reduced motion and carries no information that is not shown elsewhere.
//
// Sleek adds no banner or footer. It redraws the headcount tally as an instrument scale under the big
// figure: crisp, straight ink strokes in groups of five on a pixel grid (the kit's Tally wobbles on
// purpose, which suits the other looks better than this one), standing on a ruled baseline with one tick
// per seat and a long tick at every fifth, numbered 5, 10, 15 and 20. The marks where California and
// federal rules change (5, 15 and 20) reach above the rule and their numbers are set bold, like the
// marked points on a dial. In this look the tally is the brand mark of the rail.
import type { ReactNode } from 'react'
import type { HeadcountDecorProps, LookDecor } from '../registry'

const SLOTS = 20
// Geometry in px. Strokes are 2px wide and centered on whole pixels, so each vertical mark covers
// exactly two pixel columns: sharp at 1x and 2x, never a blurred 3px smear. Ticks are 1px on half pixels.
const STROKE = 2
const GAP = 10
const MARK_H = 30
const GROUP_GAP = 18
const LEFT = 3
const GROUP_W = GAP * 3 + STROKE
/** The baseline sits under the strokes; ticks hang from it. */
const RULE_Y = MARK_H + 4.5
const TICK_Y = RULE_Y + 0.5
const MINOR = 3
const MAJOR = 6
/** Group ends where a rule changes: 5 (California), 15 (California and federal), 20 (federal). */
const RULE_AT = new Set([5, 15, 20])

/** The rail's headcount as tally marks on a ruled scale: groups of five, four strokes and a diagonal. */
function SleekTally({ count, incoming }: HeadcountDecorProps) {
  const total = Math.max(5, Math.ceil(Math.max(SLOTS, count + incoming) / 5) * 5)
  const groups = total / 5
  const x0 = (g: number) => LEFT + g * (GROUP_W + GROUP_GAP)
  // The fifth seat of a group (its diagonal) is marked between groups, on the long tick.
  const boundary = (g: number) => x0(g) + GAP * 3 + GROUP_GAP / 2 + 1
  const width = boundary(groups - 1) + 9
  const height = TICK_Y + MAJOR + 13
  const state = (n: number): 'on' | 'incoming' | 'off' => (n < count ? 'on' : n < count + incoming ? 'incoming' : 'off')
  const cls = (s: ReturnType<typeof state>) => `ft-sleektally__mark ft-sleektally__mark--${s}`

  const marks: ReactNode[] = []
  const ticks: ReactNode[] = []
  for (let g = 0; g < groups; g++) {
    const left = x0(g)
    for (let i = 0; i < 4; i++) {
      const n = g * 5 + i
      const x = left + i * GAP
      marks.push(<line key={`m${n}`} x1={x} x2={x} y1={1} y2={MARK_H - 1} className={cls(state(n))} strokeWidth={STROKE} />)
      ticks.push(<line key={`t${n}`} x1={x - 0.5} x2={x - 0.5} y1={TICK_Y} y2={TICK_Y + MINOR} className="ft-sleektally__tick" strokeWidth={1} />)
    }
    const n5 = g * 5 + 4
    marks.push(
      <line
        key={`d${g}`}
        x1={left - 4}
        x2={left + GAP * 3 + 4}
        y1={MARK_H - 6}
        y2={6}
        className={cls(state(n5))}
        strokeWidth={STROKE}
      />,
    )
    const value = (g + 1) * 5
    const law = RULE_AT.has(value)
    const bx = boundary(g) + 0.5
    ticks.push(
      <line
        key={`b${g}`}
        x1={bx}
        x2={bx}
        y1={TICK_Y - (law ? 5 : 0)}
        y2={TICK_Y + MAJOR}
        className={law ? 'ft-sleektally__tick ft-sleektally__tick--major ft-sleektally__tick--law' : 'ft-sleektally__tick ft-sleektally__tick--major'}
        strokeWidth={1}
      />,
    )
    ticks.push(
      <text
        key={`s${g}`}
        x={bx}
        y={height - 1}
        textAnchor="middle"
        className={law ? 'ft-sleektally__scale ft-sleektally__scale--rule' : 'ft-sleektally__scale'}
      >
        {value}
      </text>,
    )
  }

  // Same summary the kit's Tally gives, so screen readers hear the same thing in every look.
  const summary = `${count} ${count === 1 ? 'person' : 'people'}${incoming ? `, ${incoming} starting soon` : ''}, of ${total} drawn`
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={summary}
      className="ft-tally ft-sleektally block"
      shapeRendering="geometricPrecision"
    >
      {marks}
      <line x1={0} x2={width} y1={RULE_Y} y2={RULE_Y} className="ft-sleektally__rule" strokeWidth={1} />
      {ticks}
    </svg>
  )
}

export const decor: LookDecor = { Headcount: SleekTally }
