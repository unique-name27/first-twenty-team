// Headcount drawn as tally marks in groups of five: four strokes and a diagonal.
// The group edges at 5, 15 and 20 line up with California and federal headcount thresholds.
import { cx } from './cx'

type Props = {
  /** Current employees (W-2, active). */
  count: number
  /** Accepted offers not yet started; drawn as outlined marks after the filled ones. */
  incoming?: number
  /** Slots to draw (rounded up to a multiple of 5). */
  slots?: number
  size?: 'sm' | 'md' | 'lg'
  className?: string
  /** Accessible summary override. */
  label?: string
  /** Draws the running count (5, 10, 15, 20) under each group. */
  showScale?: boolean
}

export function Tally({ count, incoming = 0, slots = 20, size = 'md', className, label, showScale }: Props) {
  const total = Math.max(5, Math.ceil(Math.max(slots, count + incoming) / 5) * 5)
  const groups = total / 5
  const h = size === 'sm' ? 16 : size === 'lg' ? 30 : 22
  const gap = size === 'sm' ? 3.4 : size === 'lg' ? 6 : 4.6
  const groupW = gap * 4 + 2
  const groupGap = size === 'sm' ? 6 : size === 'lg' ? 11 : 8
  const width = groups * groupW + (groups - 1) * groupGap + 4
  const sw = size === 'sm' ? 1.7 : size === 'lg' ? 2.6 : 2.1
  const scaleH = showScale ? 14 : 0

  const state = (n: number): 'on' | 'incoming' | 'off' => (n < count ? 'on' : n < count + incoming ? 'incoming' : 'off')
  const stroke = (s: ReturnType<typeof state>) =>
    s === 'on' ? 'var(--accent)' : s === 'incoming' ? 'var(--accent)' : 'var(--line-strong)'

  const marks = []
  for (let g = 0; g < groups; g++) {
    const x0 = 2 + g * (groupW + groupGap)
    for (let i = 0; i < 4; i++) {
      const n = g * 5 + i
      const s = state(n)
      // A slight wobble so the strokes read as hand-made rather than a bar code.
      const wob = ((n * 37) % 7) / 10 - 0.3
      marks.push(
        <line
          key={`m${n}`}
          x1={x0 + i * gap + 1 + wob}
          x2={x0 + i * gap + 1 - wob}
          y1={2}
          y2={h - 2}
          stroke={stroke(s)}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeDasharray={s === 'incoming' ? '2.5 2.5' : undefined}
          opacity={s === 'off' ? 0.7 : 1}
        />,
      )
    }
    const n5 = g * 5 + 4
    const s5 = state(n5)
    if (showScale) {
      marks.push(
        <text key={`s${g}`} x={x0 + groupW / 2} y={h + 12} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="var(--ink-3)">
          {(g + 1) * 5}
        </text>,
      )
    }
    marks.push(
      <line
        key={`d${g}`}
        x1={x0 - 2}
        x2={x0 + groupW + 0.5}
        y1={h - 4}
        y2={4}
        stroke={stroke(s5)}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeDasharray={s5 === 'incoming' ? '2.5 2.5' : undefined}
        opacity={s5 === 'off' ? 0.7 : 1}
      />,
    )
  }

  const summary =
    label ?? `${count} ${count === 1 ? 'person' : 'people'}${incoming ? `, ${incoming} starting soon` : ''}, of ${total} drawn`
  return (
    <svg width={width} height={h + scaleH} viewBox={`0 0 ${width} ${h + scaleH}`} role="img" aria-label={summary} className={cx('ft-tally block', className)}>
      {marks}
    </svg>
  )
}
