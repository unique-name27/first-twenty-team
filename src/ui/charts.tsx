// Small hand-drawn charts (no chart library). Specs follow the dataviz method:
// 2px lines, ~10% area wash, hairline solid grid, >=8px end markers with a 2px surface ring,
// text in ink tokens (never the series color), crosshair tooltip on time series,
// per-mark tooltips on bars, legends for 2+ series. Every chart also offers its numbers
// as text (direct labels, aria summaries, or a table toggle) so color is never the only channel.
import type { ReactNode } from 'react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { daysBetween, fmtDate, parseDate, toISODate } from '@/lib/dates'
import { cx } from './cx'

function useWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null)
  const [w, setW] = useState(fallback)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth || fallback)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width
      if (cw) setW(cw)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [fallback])
  return [ref, w] as const
}

/** Round tick step that gives at most five gaps up to `max` (1, 2, 5, 10, 20, 25, 50, ...). */
export function niceStep(max: number): number {
  const candidates = [1, 2, 5, 10, 20, 25, 50]
  for (let pow = 1; pow <= 1e9; pow *= 100) {
    for (const c of candidates) if (max / (c * pow) <= 5) return c * pow
  }
  return max
}

/** Gridline values 0..max on a round step (0, 5, 10, 15, 20, 25), never odd halves like 13. */
export function niceTicks(max: number): number[] {
  const step = niceStep(max)
  const out: number[] = []
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Math.round(v * 100) / 100)
  return out
}

/** Month labels for time ticks: the year on the first tick and wherever the year changes ("Mar 2025", "Sep", "Mar 2026"). */
export function monthTickLabels(ticks: string[]): string[] {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return ticks.map((t, i) => {
    const mon = MONTHS[Number(t.slice(5, 7)) - 1]
    const yearChanged = i === 0 || ticks[i - 1].slice(0, 4) !== t.slice(0, 4)
    return yearChanged ? `${mon} ${t.slice(0, 4)}` : mon
  })
}

function niceMax(v: number): number {
  if (v <= 5) return 5
  if (v <= 10) return 10
  if (v <= 20) return 20
  if (v <= 25) return 25
  const pow = 10 ** Math.floor(Math.log10(v))
  return Math.ceil(v / pow) * pow
}

export type StepPoint = { date: string; value: number }
export type StepSeries = {
  key: string
  label: string
  points: StepPoint[]
  /** 'solid' for actuals, 'dashed' for plans/forecasts. Plans draw lighter, no fill. */
  style?: 'solid' | 'dashed'
  color?: string
}

/**
 * Step chart for counts over time (headcount). Values hold until the next point.
 * Optional horizontal reference lines (legal thresholds) and a "today" marker.
 */
export function StepChart({
  series,
  from,
  to,
  height = 220,
  references = [],
  todayDate,
  yMax,
  valueLabel = 'people',
  ariaLabel,
  markers = [],
}: {
  series: StepSeries[]
  from: string
  to: string
  height?: number
  references?: Array<{ value: number; label: string }>
  todayDate?: string
  yMax?: number
  valueLabel?: string
  ariaLabel: string
  /** Event markers along the time axis (funding rounds, threshold crossings). Shown as ticks with hover text. */
  markers?: Array<{ date: string; label: string }>
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<string | null>(null)
  // The event marker whose label is showing (keyboard focus, hover or tap).
  const [marker, setMarker] = useState<string | null>(null)
  const padL = 34
  const padR = 16
  const padT = 14
  const padB = 26
  const innerW = Math.max(60, width - padL - padR)
  const innerH = height - padT - padB
  const span = Math.max(1, daysBetween(from, to))
  const maxVal = yMax ?? niceMax(Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.value)), ...references.map((r) => r.value)))
  const x = (d: string) => padL + (Math.min(span, Math.max(0, daysBetween(from, d))) / span) * innerW
  const y = (v: number) => padT + innerH - (v / maxVal) * innerH

  const valueAt = (s: StepSeries, d: string): number | null => {
    let v: number | null = null
    for (const p of s.points) {
      if (p.date <= d) v = p.value
      else break
    }
    return v
  }

  const paths = useMemo(
    () =>
      series.map((s) => {
        const pts = [...s.points].sort((a, b) => a.date.localeCompare(b.date))
        if (pts.length === 0) return { s, line: '', area: '' }
        const end = s.style === 'dashed' ? (pts[pts.length - 1].date > to ? to : pts[pts.length - 1].date) : (todayDate && todayDate < to ? todayDate : to)
        let d = `M${x(pts[0].date)},${y(pts[0].value)}`
        for (let i = 1; i < pts.length; i++) {
          if (pts[i].date > to) break
          d += ` H${x(pts[i].date)} V${y(pts[i].value)}`
        }
        d += ` H${x(end)}`
        const area = `${d} V${y(0)} H${x(pts[0].date)} Z`
        return { s, line: d, area }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, width, maxVal, from, to, todayDate],
  )

  const ticks = useMemo(() => {
    const out: string[] = []
    const start = parseDate(from)
    const cur = new Date(start.getFullYear(), start.getMonth() + (start.getDate() > 1 ? 1 : 0), 1)
    const months = Math.max(1, Math.round(span / 30))
    const every = months > 18 ? 6 : months > 9 ? 3 : months > 4 ? 2 : 1
    let i = 0
    while (toISODate(cur) <= to) {
      if (i % every === 0) out.push(toISODate(cur))
      cur.setMonth(cur.getMonth() + 1)
      i++
    }
    return out
  }, [from, to, span])

  const yTicks = niceTicks(maxVal)
  const refValues = new Set(references.map((r) => r.value))
  const tickLabels = monthTickLabels(ticks)
  const shownMarkers = markers.filter((m) => m.date >= from && m.date <= to)
  // One 40px button per cluster: markers less than 40px apart share a button that lists every event,
  // so no target covers another on a phone. Each button centers on its cluster; neighbors stay 40px apart.
  const markerKey = (m: { date: string; label: string }) => `mk-${m.date}-${m.label}`
  const clusters: Array<{ key: string; x: number; items: Array<{ date: string; label: string }> }> = []
  for (const m of [...shownMarkers].sort((a, b) => a.date.localeCompare(b.date))) {
    const last = clusters[clusters.length - 1]
    const lastItem = last?.items[last.items.length - 1]
    if (last && lastItem && x(m.date) - x(lastItem.date) < 40) last.items.push(m)
    else clusters.push({ key: '', x: 0, items: [m] })
  }
  for (const c of clusters) {
    c.key = c.items.map(markerKey).join('|')
    c.x = (x(c.items[0].date) + x(c.items[c.items.length - 1].date)) / 2
  }
  const activeCluster = clusters.find((c) => c.key === marker)

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
    const px = e.clientX - rect.left
    const frac = Math.min(1, Math.max(0, (px - padL) / innerW))
    const day = Math.round(frac * span)
    const d = parseDate(from)
    d.setDate(d.getDate() + day)
    setHover(toISODate(d))
  }

  const hoverX = hover ? x(hover) : 0
  const tipLeft = Math.min(Math.max(hoverX - 80, 0), Math.max(0, width - 170))

  return (
    <div ref={wrapRef} className="ft-chart ft-chart--step relative w-full select-none">
      <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block overflow-visible">
        {/* grid */}
        {yTicks.map((t) => (
          <g key={t}>
            {/* A reference line already marks this value; skip the duplicate gridline. */}
            {!refValues.has(t) && <line x1={padL} x2={padL + innerW} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />}
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize={11.5} fill="var(--ink-3)" className="num">
              {t}
            </text>
          </g>
        ))}
        {ticks.map((t, i) => (
          <text
            key={t}
            x={x(t)}
            y={height - 6}
            textAnchor={i === 0 && x(t) - padL < 24 ? 'start' : 'middle'}
            fontSize={11.5}
            fill="var(--ink-3)"
            className={cx('ft-chart__xtick', i % 2 === 1 && 'ft-chart__xtick--odd')}
          >
            {tickLabels[i]}
          </text>
        ))}
        {/* threshold references */}
        {references
          .filter((r) => r.value <= maxVal)
          .map((r) => (
            <g key={r.value}>
              <line
                x1={padL}
                x2={padL + innerW}
                y1={y(r.value)}
                y2={y(r.value)}
                stroke="var(--line-strong)"
                strokeWidth={1}
              />
              <text x={padL + innerW} y={y(r.value) - 5} textAnchor="end" fontSize={11} fill="var(--ink-3)" fontWeight={600} className="ft-chart__reflabel">
                {r.label}
              </text>
            </g>
          ))}
        {/* today marker */}
        {todayDate && todayDate >= from && todayDate <= to && (
          <g>
            <line x1={x(todayDate)} x2={x(todayDate)} y1={padT - 4} y2={y(0)} stroke="var(--ink-3)" strokeWidth={1} />
            {/* Ends at the line near the right edge, and starts at it near the left, so it never runs into the end labels. */}
            <text
              x={x(todayDate)}
              y={padT - 6}
              textAnchor={padL + innerW - x(todayDate) < 24 ? 'end' : x(todayDate) - padL < 24 ? 'start' : 'middle'}
              fontSize={11}
              fill="var(--ink-2)"
              fontWeight={700}
              className="ft-chart__today"
            >
              Today
            </text>
          </g>
        )}
        {/* event markers: a short tick above the baseline; the focusable buttons sit over the chart below */}
        {shownMarkers.map((m) => {
          const key = markerKey(m)
          const on = !!activeCluster?.items.some((it) => markerKey(it) === key)
          return (
            <g key={key} aria-hidden>
              <line x1={x(m.date)} x2={x(m.date)} y1={y(0) - 10} y2={y(0)} stroke={on ? 'var(--ink)' : 'var(--ink-3)'} strokeWidth={1.5} />
              <circle cx={x(m.date)} cy={y(0) - 12} r={on ? 4.5 : 3} fill="var(--surface)" stroke={on ? 'var(--ink)' : 'var(--ink-3)'} strokeWidth={1.5} />
            </g>
          )
        })}
        {/* series */}
        {paths.map(({ s, line, area }, i) => {
          const color = s.color ?? (i === 0 ? 'var(--accent)' : `var(--cat-${(i % 6) + 1})`)
          return (
            <g key={s.key}>
              {s.style !== 'dashed' && <path d={area} fill={color} opacity={0.1} />}
              <path
                d={line}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={s.style === 'dashed' ? '5 5' : undefined}
                opacity={s.style === 'dashed' ? 0.75 : 1}
              />
            </g>
          )
        })}
        {/* end markers on solid series */}
        {series.map((s, i) => {
          if (s.style === 'dashed' || s.points.length === 0) return null
          const end = todayDate && todayDate < to ? todayDate : to
          const v = valueAt(s, end)
          if (v == null) return null
          const color = s.color ?? (i === 0 ? 'var(--accent)' : `var(--cat-${(i % 6) + 1})`)
          return (
            <g key={`end-${s.key}`} className="ft-chart__end">
              <circle cx={x(end)} cy={y(v)} r={5} fill={color} stroke="var(--surface)" strokeWidth={2} className="ft-chart__enddot" />
              {/* A box behind the value, invisible unless a look fills it (a price label in the trading look).
                  Sized for 12.5px monospace figures. */}
              <rect
                x={x(end) + 3}
                y={y(v) - 22}
                width={String(v).length * 7.6 + 8}
                height={17}
                fill="none"
                className="ft-chart__endtag"
                style={{ ['--ft-series' as string]: color }}
              />
              {/* Above and right of the dot, so a plan line starting here never crosses it. */}
              <text
                x={x(end) + 7}
                y={y(v) - 9}
                fontSize={12.5}
                fontWeight={700}
                fill="var(--ink)"
                stroke="var(--surface)"
                strokeWidth={3}
                paintOrder="stroke"
                className="num ft-chart__endlabel"
              >
                {v}
              </text>
            </g>
          )
        })}
        {hover && (
          <line x1={hoverX} x2={hoverX} y1={padT} y2={y(0)} stroke="var(--ink-3)" strokeWidth={1} pointerEvents="none" />
        )}
        <rect
          x={padL}
          y={padT}
          width={innerW}
          height={innerH}
          fill="transparent"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {/* Event markers as real buttons: 40px targets, label shown on focus, hover or tap. */}
      {clusters.map((c) => {
        const key = c.key
        const lines = c.items.map((m) => `${fmtDate(m.date)}: ${m.label}`)
        const text = lines.length > 1 ? `${lines.length} events. ${lines.join('. ')}` : lines[0]
        const mx = c.x
        const on = marker === key
        return (
          <div key={key} className="absolute" style={{ left: mx - 20, top: y(0) - 32 }}>
            <button
              type="button"
              aria-label={text}
              aria-expanded={on}
              onFocus={() => setMarker(key)}
              onBlur={() => setMarker((k) => (k === key ? null : k))}
              onMouseEnter={() => setMarker(key)}
              onMouseLeave={() => setMarker((k) => (k === key ? null : k))}
              onClick={() => setMarker((k) => (k === key ? null : key))}
              className="block h-10 w-10 rounded-full focus-visible:outline-offset-[-6px]"
            />
            {on && (
              <div
                role="tooltip"
                className="ft-chart__tip pointer-events-none absolute bottom-full z-10 mb-1 w-max max-w-[220px] rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-ink shadow-pop"
                style={mx > width / 2 ? { right: 0 } : { left: 0 }}
              >
                {lines.map((l) => (
                  <div key={l}>{l}</div>
                ))}
              </div>
            )}
          </div>
        )
      })}
      {hover && (
        <div
          className="ft-chart__tip pointer-events-none absolute top-1 z-10 w-[170px] rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] shadow-pop"
          style={{ left: tipLeft }}
        >
          <div className="font-semibold text-ink-3">{fmtDate(hover)}</div>
          {series.map((s, i) => {
            const v = valueAt(s, hover)
            if (v == null) return null
            const color = s.color ?? (i === 0 ? 'var(--accent)' : `var(--cat-${(i % 6) + 1})`)
            return (
              <div key={s.key} className="mt-1 flex items-center gap-2">
                <span className="h-0.5 w-3 rounded" style={{ background: color }} />
                <span className="num font-bold text-ink">{v}</span>
                <span className="text-ink-3">
                  {s.label}
                  {valueLabel && s.label === '' ? ` ${valueLabel}` : ''}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {(series.length > 1 || references.length > 0) && (
        <div className="ft-chart__legend mt-2 flex flex-wrap gap-x-4 gap-y-1 pl-[34px] text-[12.5px] text-ink-2">
          {series.map((s, i) => {
            const color = s.color ?? (i === 0 ? 'var(--accent)' : `var(--cat-${(i % 6) + 1})`)
            return (
              <span key={s.key} className="inline-flex items-center gap-1.5">
                <svg width="18" height="6" aria-hidden>
                  <line x1="1" x2="17" y1="3" y2="3" stroke={color} strokeWidth="2" strokeDasharray={s.style === 'dashed' ? '4 3' : undefined} />
                </svg>
                {s.label}
              </span>
            )
          })}
          {references.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <svg width="18" height="6" aria-hidden>
                <line x1="1" x2="17" y1="3" y2="3" stroke="var(--line-strong)" strokeWidth="1.5" />
              </svg>
              Legal thresholds ({references.map((r) => r.label).join(', ')})
            </span>
          )}
        </div>
      )}
      <details className="ft-chart__data mt-2 pl-[34px] text-[12.5px] text-ink-2">
        <summary className="inline-flex min-h-10 cursor-pointer items-center font-semibold text-ink-3 hover:text-ink">Show the numbers</summary>
        <table className="mt-1 text-left">
          <thead>
            <tr>
              <th className="pr-4 font-semibold text-ink-3">Date</th>
              {series.map((s) => (
                <th key={s.key} className="pr-4 font-semibold text-ink-3">
                  {s.label || valueLabel}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...new Set(series.flatMap((s) => s.points.map((p) => p.date)))]
              .filter((d) => d <= to)
              .sort()
              .map((d) => (
                <tr key={d}>
                  <td className="pr-4 num">{fmtDate(d)}</td>
                  {series.map((s) => (
                    <td key={s.key} className="pr-4 num text-ink">
                      {valueAt(s, d) ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

export type BarItem = {
  key: string
  label: ReactNode
  value: number
  /** Text shown at the bar tip; defaults to the number. */
  display?: ReactNode
  sub?: ReactNode
  href?: string
  tone?: 'accent' | 'good' | 'warn' | 'bad' | 'muted'
}

/** Horizontal bars with labels on the left and values at the tip. Single series = accent color. */
export function BarList({
  items,
  max,
  ariaLabel,
  className,
}: {
  items: BarItem[]
  max?: number
  ariaLabel: string
  className?: string
}) {
  const top = max ?? Math.max(1, ...items.map((i) => i.value))
  return (
    <ul aria-label={ariaLabel} className={cx('ft-chart ft-chart--bars flex flex-col gap-2.5', className)}>
      {items.map((it) => {
        const w = top <= 0 ? 0 : Math.max(0, Math.min(1, it.value / top))
        const bar =
          it.tone === 'good'
            ? 'bg-good'
            : it.tone === 'warn'
              ? 'bg-warn'
              : it.tone === 'bad'
                ? 'bg-bad'
                : it.tone === 'muted'
                  ? 'bg-line-strong'
                  : 'bg-accent'
        const row = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-[13.5px]">
              <span className="min-w-0 truncate font-medium text-ink">{it.label}</span>
              <span className="num shrink-0 font-bold text-ink">{it.display ?? it.value}</span>
            </div>
            <div className="ft-chart__track mt-1 h-2.5 w-full rounded-r-sm bg-surface-2">
              <div className={cx('ft-chart__bar h-full rounded-r-sm', bar)} style={{ width: `${w * 100}%`, minWidth: it.value > 0 ? 3 : 0 }} />
            </div>
            {it.sub && <div className="mt-0.5 text-[12px] text-ink-3">{it.sub}</div>}
          </>
        )
        return (
          <li key={it.key}>
            {it.href ? (
              <a href={it.href} className="block rounded-md hover:bg-surface-2/60">
                {row}
              </a>
            ) : (
              row
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** One 100% bar split into labeled segments, with a legend. Categorical colors in fixed order. */
export function SegmentBar({
  segments,
  ariaLabel,
  height = 14,
}: {
  segments: Array<{ key: string; label: string; value: number; color?: string }>
  ariaLabel: string
  height?: number
}) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const colorOf = (i: number, c?: string) => c ?? `var(--cat-${(i % 6) + 1})`
  return (
    <div className="ft-chart ft-chart--segments">
      <div role="img" aria-label={`${ariaLabel}: ${segments.map((s) => `${s.label} ${s.value}`).join(', ')}`} className="ft-chart__track flex w-full gap-[2px]" style={{ height }}>
        {total === 0 ? (
          <div className="h-full w-full rounded bg-surface-2" />
        ) : (
          segments
            .filter((s) => s.value > 0)
            .map((s) => {
              const i = segments.indexOf(s)
              return (
                <div
                  key={s.key}
                  title={`${s.label}: ${s.value}`}
                  className="ft-chart__bar h-full first:rounded-l-[4px] last:rounded-r-sm"
                  style={{ width: `${(s.value / total) * 100}%`, background: colorOf(i, s.color) }}
                />
              )
            })
        )}
      </div>
      <div className="ft-chart__legend mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-2">
        {segments.map((s, i) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: colorOf(i, s.color) }} />
            {s.label}
            <span className="num font-bold text-ink">{s.value}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

/** Tiny trend line for stat tiles; last point emphasized. */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  ariaLabel,
}: {
  values: number[]
  width?: number
  height?: number
  ariaLabel: string
}) {
  if (values.length < 2) return null
  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min || 1
  const step = (width - 8) / (values.length - 1)
  const pts = values.map((v, i) => [4 + i * step, 4 + (height - 8) * (1 - (v - min) / range)] as const)
  const d = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ')
  const [lx, ly] = pts[pts.length - 1]
  return (
    <svg width={width} height={height} role="img" aria-label={ariaLabel} className="ft-chart ft-chart--spark block">
      <path d={`${d} L${lx},${height} L4,${height} Z`} fill="var(--accent)" opacity={0.1} />
      <path d={d} fill="none" stroke="var(--ink-3)" strokeWidth={1.6} strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={3.5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
    </svg>
  )
}
