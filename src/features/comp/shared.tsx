// Small building blocks shared by the comp pages and panels: the band position track, the vesting
// chart, plan status badges and sentences whose amounts blur with the privacy key (B).
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { bandLabel, bandPosition, compaRatio } from '@/domain/pay'
import type { Band, PlanSlot } from '@/domain/types'
import { addMonths, daysBetween, fmtDate, fmtShort, type ISODate, parseDate, toISODate } from '@/lib/dates'
import { moneyShort, num } from '@/lib/format'
import { Badge, cx, Private } from '@/ui'
import { PLAN_STATUS_LABEL, PLAN_STATUS_TONE, splitMoneyText, type VestPoint } from './helpers'

/** A sentence from the domain with every dollar amount wrapped in <Private>. */
export function MoneyText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      {splitMoneyText(text).map((p, i) => (p.money ? <Private key={i}>{p.text}</Private> : <span key={i}>{p.text}</span>))}
    </span>
  )
}

export function PlanStatusBadge({ status }: { status: PlanSlot['status'] }) {
  return <Badge tone={PLAN_STATUS_TONE[status]}>{PLAN_STATUS_LABEL[status]}</Badge>
}

// The track spans 15% of the band width beyond each edge so out-of-band dots stay visible.
const OVER = 0.15
const toPct = (pos: number) => ((Math.max(-OVER, Math.min(1 + OVER, pos)) + OVER) / (1 + 2 * OVER)) * 100

/**
 * Where pay sits in a band: a min-to-max track with a midpoint tick and a dot (a hollow dot for a
 * second, "after" value). Wrapped in <Private> because the dot reveals pay.
 */
export function BandTrack({
  band,
  base,
  after,
  showLabels = true,
  className,
}: {
  band: Pick<Band, 'min' | 'mid' | 'max'>
  base: number | null
  /** Optional second value, drawn as a hollow dot (for example a proposed new base). */
  after?: { base: number; band?: Pick<Band, 'min' | 'mid' | 'max'> }
  showLabels?: boolean
  className?: string
}) {
  const pos = base != null ? bandPosition(base, band) : null
  const out = pos != null && (pos < 0 || pos > 1)
  const posAfter = after ? bandPosition(after.base, band) : null
  const label =
    base != null
      ? `${bandLabel(base, band)}, compa-ratio ${compaRatio(base, band).toFixed(2)}${after ? `; proposed ${bandLabel(after.base, band)}` : ''}`
      : 'No pay recorded'
  return (
    <Private className={cx('block min-w-[120px]', className)}>
      <span role="img" aria-label={label} className="relative block h-5">
        <span className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-surface-2" />
        <span
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent-soft ring-1 ring-inset ring-line-strong"
          style={{ left: `${toPct(0)}%`, width: `${toPct(1) - toPct(0)}%` }}
        />
        <span className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-ink-3" style={{ left: `${toPct(0.5)}%` }} />
        {posAfter != null && (
          <span
            className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-surface"
            style={{ left: `${toPct(posAfter)}%` }}
          />
        )}
        {pos != null && (
          <span
            className={cx(
              'absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface',
              out ? 'bg-warn' : 'bg-accent',
            )}
            style={{ left: `${toPct(pos)}%` }}
          />
        )}
      </span>
      {showLabels && (
        <span className="mt-0.5 flex justify-between text-[11.5px] text-ink-3">
          <span>{moneyShort(band.min)}</span>
          <span>{moneyShort(band.max)}</span>
        </span>
      )}
    </Private>
  )
}

function useWidth<T extends HTMLElement>(fallback = 560) {
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

/**
 * Cumulative vested options over time: a step line with a light wash, the cliff marked, a today line,
 * and a crosshair tooltip. Numbers use thousands separators. The whole chart blurs with B.
 */
export function VestingChart({
  points,
  total,
  start,
  end,
  today,
  cliff,
  height = 200,
}: {
  points: VestPoint[]
  total: number
  start: ISODate
  end: ISODate
  today: ISODate
  cliff?: ISODate | null
  height?: number
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<ISODate | null>(null)
  const padL = 52
  const padR = 14
  const padT = 18
  const padB = 26
  const innerW = Math.max(80, width - padL - padR)
  const innerH = height - padT - padB
  const span = Math.max(1, daysBetween(start, end))
  const top = Math.max(1, total)
  const x = (d: ISODate) => padL + (Math.min(span, Math.max(0, daysBetween(start, d))) / span) * innerW
  const y = (v: number) => padT + innerH - (v / top) * innerH
  const valueAt = (d: ISODate) => {
    let v = 0
    for (const p of points) {
      if (p.date <= d) v = p.vested
      else break
    }
    return v
  }
  const line = useMemo(() => {
    if (!points.length) return ''
    let d = `M${x(start)},${y(0)}`
    for (const p of points) d += ` H${x(p.date)} V${y(p.vested)}`
    d += ` H${x(end)}`
    return d
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, width, start, end, total])
  const years: ISODate[] = []
  for (let m = 12; addMonths(start, m) <= end; m += 12) years.push(addMonths(start, m))
  const showToday = today > start && today < end
  const yTicks = [0, Math.round(top / 2), top]
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left - padL) / innerW))
    const d = parseDate(start)
    d.setDate(d.getDate() + Math.round(frac * span))
    setHover(toISODate(d))
  }
  const hx = hover ? x(hover) : 0
  const tipLeft = Math.min(Math.max(hx - 80, 0), Math.max(0, width - 170))
  const nowVested = valueAt(today)
  return (
    <Private className="block">
      <div ref={ref} className="ft-chart ft-chart--step relative w-full select-none">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Vesting: ${num(nowVested)} of ${num(total)} options vested today; fully vested ${fmtDate(end)}.`}
          className="block overflow-visible"
        >
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={padL + innerW} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
              <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize={11.5} fill="var(--ink-3)" className="num">
                {num(t)}
              </text>
            </g>
          ))}
          {years.map((d) => (
            <text key={d} x={x(d)} y={height - 6} textAnchor="middle" fontSize={11.5} fill="var(--ink-3)" className="ft-chart__xtick">
              {fmtShort(d).split(' ')[0]} {d.slice(0, 4)}
            </text>
          ))}
          <path d={`${line} V${y(0)} H${x(start)} Z`} fill="var(--accent)" opacity={0.1} />
          <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
          {cliff && cliff > start && cliff <= end && (
            <g>
              <circle cx={x(cliff)} cy={y(valueAt(cliff))} r={4.5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
              <text x={x(cliff) - 8} y={y(valueAt(cliff)) + 4} textAnchor="end" fontSize={11.5} fontWeight={700} fill="var(--ink-2)">
                Cliff
              </text>
            </g>
          )}
          {showToday && (
            <g>
              <line x1={x(today)} x2={x(today)} y1={padT - 6} y2={y(0)} stroke="var(--ink-3)" strokeWidth={1} />
              <text x={x(today)} y={padT - 8} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--ink-2)" className="ft-chart__today">
                Today
              </text>
              <circle cx={x(today)} cy={y(nowVested)} r={5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
            </g>
          )}
          {hover && <line x1={hx} x2={hx} y1={padT} y2={y(0)} stroke="var(--ink-3)" strokeWidth={1} pointerEvents="none" />}
          <rect
            x={padL}
            y={padT}
            width={innerW}
            height={innerH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hover && (
          <div
            className="ft-chart__tip pointer-events-none absolute top-1 z-10 w-[170px] rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] shadow-pop"
            style={{ left: tipLeft }}
          >
            <div className="font-semibold text-ink-3">{fmtDate(hover)}</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="h-0.5 w-3 rounded bg-accent" />
              <span className="num font-bold text-ink">{num(valueAt(hover))}</span>
              <span className="text-ink-3">vested</span>
            </div>
          </div>
        )}
      </div>
    </Private>
  )
}
