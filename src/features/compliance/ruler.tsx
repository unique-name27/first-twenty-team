// The threshold ruler: one dot per employee on a 0 to 20 scale (25 to 100 faded after it). People
// already hired who start later are solid dots with a dashed halo; outstanding offers are hollow dots
// labeled 'if accepted'. Ticks at 5, 10 (site), 15 and 20. The figure has a text summary and a
// legend, so nothing depends on color or on hovering.
import type { RulerDot } from '@/domain/compliance'
import { fmtDate, fmtShort, type ISODate } from '@/lib/dates'
import { listJoin, plural } from '@/lib/format'
import { cx } from '@/ui'
import { RULER_TAIL, RULER_TICKS, rulerX } from './helpers'

const pct = (v: number) => `${(rulerX(v) * 100).toFixed(3)}%`

export function rulerSummary(dots: RulerDot[], next?: { n: number; kind: 'headcount' | 'site' }, projectedOn?: ISODate): string {
  const employees = dots.filter((d) => d.kind === 'employee').length
  const incoming = dots.filter((d) => d.kind === 'incoming')
  const offers = dots.filter((d) => d.kind === 'if_accepted')
  const parts = [`${plural(employees, 'employee')} now`]
  if (incoming.length) parts.push(`${incoming.length} starting soon (${listJoin(incoming.map((d) => `${d.label}, ${fmtShort(d.date)}`))})`)
  if (offers.length) parts.push(`${plural(offers.length, 'offer')} out (${listJoin(offers.map((d) => d.label))}, if accepted)`)
  const tail = next ? ` Next threshold: ${next.n}${next.kind === 'site' ? ' on site' : ''}${projectedOn ? `, reached ${fmtDate(projectedOn)}` : ''}.` : ''
  return `Headcount ruler: ${parts.join(', ')}.${tail}`
}

export function ThresholdRuler({
  dots,
  next,
  projectedOn,
  compact,
  className,
}: {
  dots: RulerDot[]
  next?: { n: number; kind: 'headcount' | 'site' }
  projectedOn?: ISODate
  compact?: boolean
  className?: string
}) {
  const size = compact ? 9 : 11
  const dotTop = compact ? 10 : 12
  const axisTop = dotTop + size / 2 + (compact ? 7 : 9)
  const labelTop = axisTop + 8
  const height = labelTop + (compact ? 28 : 40)
  const incoming = dots.filter((d) => d.kind === 'incoming')
  const offers = dots.filter((d) => d.kind === 'if_accepted')
  const employees = dots.length - incoming.length - offers.length

  return (
    <div className={className}>
      <figure role="img" aria-label={rulerSummary(dots, next, projectedOn)} className="m-0">
        <div className="relative mx-4" style={{ height }}>
          {/* Axis: solid to 20, faded and dashed after */}
          <div className="absolute left-0 h-[2px] rounded bg-line-strong" style={{ top: axisTop, width: pct(20) }} aria-hidden />
          <div
            className="absolute h-0 border-t-2 border-dashed border-line"
            style={{ top: axisTop, left: pct(20), right: 0 }}
            aria-hidden
          />
          {/* Next threshold marker */}
          {next && next.n <= 100 && (
            <div className="absolute w-[2px] rounded bg-accent/60" style={{ left: pct(next.n), top: 0, height: axisTop + 6, transform: 'translateX(-50%)' }} aria-hidden />
          )}
          {/* Ticks and labels */}
          {[0, ...RULER_TICKS].map((t) => {
            const isNext = next?.n === t
            return (
              <div key={t} aria-hidden>
                <div className="absolute w-px bg-line-strong" style={{ left: pct(t), top: axisTop - 4, height: 10 }} />
                <div
                  className={cx(
                    'num absolute -translate-x-1/2 text-center leading-tight whitespace-nowrap',
                    compact ? 'text-[11px]' : 'text-[12.5px]',
                    isNext ? 'font-bold text-accent' : 'font-semibold text-ink-2',
                  )}
                  style={{ left: pct(t), top: labelTop }}
                >
                  {t}
                  {t === 10 && <span className="block text-[10.5px] font-semibold text-ink-3">on site</span>}
                  {isNext && projectedOn && !compact && <span className="block text-[11px] font-semibold text-accent">{fmtShort(projectedOn)}</span>}
                </div>
              </div>
            )
          })}
          {RULER_TAIL.map((t) => (
            <div key={t} aria-hidden>
              <div className="absolute w-px bg-line" style={{ left: pct(t), top: axisTop - 3, height: 8 }} />
              <div
                className={cx(
                  'num absolute -translate-x-1/2 text-[10.5px] font-semibold text-ink-3',
                  // The compact ruler (Home's side column) has no room for every tail label.
                  t !== 50 && t !== 100 && (compact ? 'hidden' : 'hidden sm:block'),
                )}
                style={{ left: pct(t), top: labelTop }}
              >
                {t}
              </div>
            </div>
          ))}
          {/* Dots: the k-th person sits on k, so the 15th dot lands on the 15 tick */}
          {dots.map((d, i) => {
            const k = i + 1
            return (
              <span
                key={`${d.personId ?? d.offerId ?? i}-${k}`}
                aria-hidden
                title={`#${k} ${d.label}${d.kind === 'employee' ? '' : d.kind === 'incoming' ? `, starts ${fmtDate(d.date)}` : `, ${fmtDate(d.date)} if accepted`}`}
                className={cx(
                  'absolute -translate-x-1/2 -translate-y-1/2 rounded-full',
                  d.kind === 'employee' && 'bg-accent',
                  d.kind === 'incoming' && 'bg-accent outline-[1.5px] outline-offset-[1.5px] outline-accent outline-dashed',
                  d.kind === 'if_accepted' && 'border-2 border-accent bg-surface',
                )}
                style={{ left: pct(k), top: dotTop, width: size, height: size }}
              />
            )
          })}
        </div>
      </figure>
      <ul className={cx('mt-1 flex flex-wrap gap-x-4 gap-y-1 text-ink-2', compact ? 'text-[12.5px]' : 'text-[13.5px]')}>
        <li className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full bg-accent" />
          {plural(employees, 'employee')}
        </li>
        {incoming.length > 0 && (
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full bg-accent outline-[1.5px] outline-offset-[1.5px] outline-accent outline-dashed" />
            {compact
              ? `${incoming.length} starting soon`
              : `Starting: ${listJoin(incoming.map((d) => `${d.label} (${fmtShort(d.date)})`))}`}
          </li>
        )}
        {offers.length > 0 && (
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full border-2 border-accent bg-surface" />
            {compact
              ? `${plural(offers.length, 'offer')} out, if accepted`
              : `If accepted: ${listJoin(offers.map((d) => `${d.label} (${fmtShort(d.date)})`))}`}
          </li>
        )}
      </ul>
    </div>
  )
}
