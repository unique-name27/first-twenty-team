// Position-in-band meter: the band as a track, the offer as a solid dot, desired pay as a marker,
// peers at the level as unnamed hollow dots (Admin only) and the job's posted range (the good-faith
// estimate in the posting) as a dashed bar under the track. Everything sits inside <Private> so the
// privacy blur (B) hides it. Numbers are also given as text, so the marks are never the only channel.
// An hourly offer reads in dollars an hour (bandMeterFigures converts every figure), so a part-time
// rate is never compared with annualized full-time figures. Desired pay given in the other unit says it
// was converted at 2,080 hours; an hourly desired pay on an hourly offer reads as given.
import type { ReactNode } from 'react'
import type { Band } from '@/domain/types'
import { money2, moneyShort, pct, plural } from '@/lib/format'
import { usePrefs } from '@/store/prefs'
import { cx } from '@/ui'
import { bandMeterGeometry, bandWords } from './logic'

export function BandMeter({
  band,
  offer,
  desired,
  peers,
  posted,
  compact,
  unit = 'year',
  desiredFrom,
}: {
  band: Pick<Band, 'min' | 'mid' | 'max'>
  offer: number | null | undefined
  desired?: number | null
  /** The unit the candidate gave desired pay in, when it differs from the meter's (bandMeterFigures). */
  desiredFrom?: 'year' | 'hour' | undefined
  /** Unnamed peer bases at this level; undefined hides peers (non-admin views). */
  peers?: number[]
  /** The job's posted range in the meter's unit (bandMeterFigures); null or undefined when it has none. */
  posted?: { min: number; max: number } | null
  compact?: boolean
  /** 'hour' when every figure is an hourly rate (an hourly offer). */
  unit?: 'year' | 'hour'
}) {
  // Native tooltips sit outside the blur filter, so the marks carry no amounts while the blur is on.
  const blur = usePrefs((s) => s.privacyBlur)
  const tip = (text: string) => (blur ? undefined : text)
  const hourly = unit === 'hour'
  const fmt = (v: number) => (hourly ? money2(v) : moneyShort(v))
  const g = bandMeterGeometry(band, posted ? [posted.min, posted.max] : [])
  const left = (v: number) => `${g.at(v) * 100}%`
  const pos = offer != null && band.max > band.min ? (offer - band.min) / (band.max - band.min) : null
  const words = offer != null ? bandWords(offer, band) : 'No base yet'
  const summary = [
    offer != null
      ? `Offer ${fmt(offer)}${hourly ? ' an hour' : ''}: ${words.toLowerCase()}${pos != null && pos >= 0 && pos <= 1 ? `, ${pct(pos, 0)} of the way from minimum to maximum` : ''}.`
      : 'No base yet.',
    `Band ${fmt(band.min)} to ${fmt(band.max)}, midpoint ${fmt(band.mid)}${hourly ? ' an hour (the annual band over 2,080 hours)' : ''}.`,
    posted ? `Posted range ${fmt(posted.min)} to ${fmt(posted.max)}${hourly ? ' an hour' : ''}.` : '',
    desired != null
      ? `Desired pay ${fmt(desired)}${hourly ? ' an hour' : ''}${desiredFrom ? ` (from ${desiredFrom === 'year' ? 'a yearly' : 'an hourly'} figure, at 2,080 hours)` : ''}.`
      : '',
    peers ? `${plural(peers.length, 'peer')} at this level.` : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <PrivateBlock>
      <div role="img" aria-label={blur ? 'Position in band, hidden by privacy blur' : summary} className={compact ? 'pt-6 pb-5' : 'pt-7 pb-6'}>
        <div className="relative h-3">
          {/* Track and the band itself */}
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-surface-3" />
          <div
            className="absolute top-1/2 h-3 -translate-y-1/2 rounded-sm bg-accent-soft ring-1 ring-inset ring-accent/30"
            style={{ left: left(band.min), width: `${(g.at(band.max) - g.at(band.min)) * 100}%` }}
          />
          <div className="absolute top-1/2 h-4 w-[2px] -translate-x-1/2 -translate-y-1/2 bg-ink-3" style={{ left: left(band.mid) }} title={tip(`Midpoint ${fmt(band.mid)}`)} />
          {/* Peers: unnamed hollow dots */}
          {peers?.map((p, i) => (
            <span
              key={`${p}-${i}`}
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ink-3 bg-surface"
              style={{ left: left(p) }}
              title="A peer at this level"
            />
          ))}
          {/* Desired pay: a marker above the track */}
          {desired != null && (
            <span className="absolute -top-2.5 flex -translate-x-1/2 flex-col items-center" style={{ left: left(desired) }} title={tip(`Desired pay ${fmt(desired)}`)}>
              <span className="h-0 w-0 border-x-[6px] border-t-[8px] border-x-transparent border-t-ink" />
              <span className="h-4 w-[2px] bg-ink" />
            </span>
          )}
          {/* The offer: solid dot with a surface ring */}
          {offer != null && (
            <span
              className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-surface"
              style={{ left: left(offer) }}
              title={tip(`This offer ${fmt(offer)}${g.clipped(offer) ? ' (off the scale)' : ''}`)}
            />
          )}
          {offer != null && (
            <span className="num absolute -top-6 -translate-x-1/2 text-[12px] font-bold whitespace-nowrap text-ink" style={{ left: `clamp(24px, ${left(offer)}, calc(100% - 24px))` }}>
              {fmt(offer)}
            </span>
          )}
        </div>
        <div className="num relative mt-2 h-4 text-[11.5px] text-ink-3">
          <span className="absolute -translate-x-1/2" style={{ left: left(band.min) }}>
            {fmt(band.min)}
          </span>
          <span className="absolute -translate-x-1/2" style={{ left: left(band.mid) }}>
            {fmt(band.mid)}
          </span>
          <span className="absolute -translate-x-1/2" style={{ left: left(band.max) }}>
            {fmt(band.max)}
          </span>
        </div>
        {posted && (
          <div className="relative mt-1.5 h-9">
            {/* The posted range: a dashed bar on the same scale, labeled under it. */}
            <div
              className="absolute top-0 h-2.5 rounded-sm border-2 border-dashed border-ink-3"
              style={{ left: left(posted.min), width: `max(4px, ${(g.at(posted.max) - g.at(posted.min)) * 100}%)` }}
              title={tip(`Posted range ${fmt(posted.min)} to ${fmt(posted.max)}`)}
            />
            <span
              className="num absolute top-4 -translate-x-1/2 text-[11.5px] whitespace-nowrap text-ink-2"
              style={{ left: `clamp(64px, ${(g.at(posted.min) + g.at(posted.max)) * 50}%, calc(100% - 64px))` }}
            >
              Posted {fmt(posted.min)} to {fmt(posted.max)}
            </span>
          </div>
        )}
      </div>
      {!compact && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-2" aria-hidden>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-full bg-accent" />
            This offer
          </span>
          {desired != null && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-ink" />
              Desired pay
            </span>
          )}
          {peers && peers.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full border-2 border-ink-3" />
              Peers at this level (unnamed)
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-[2px] bg-ink-3" />
            Midpoint
          </span>
          {posted && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-4 rounded-sm border-2 border-dashed border-ink-3" />
              Posted range
            </span>
          )}
        </div>
      )}
      <p className="mt-1 text-[13px] text-ink-2">{summary}</p>
    </PrivateBlock>
  )
}

/** Block-level twin of <Private>: the privacy blur (B) hides everything inside. */
export function PrivateBlock({ children, className }: { children: ReactNode; className?: string }) {
  const blur = usePrefs((s) => s.privacyBlur)
  return (
    <div className={cx('ft-private ft-private--block num transition-[filter]', blur && 'ft-private--on select-none blur-[6px]', className)} aria-hidden={blur || undefined} title={blur ? 'Hidden by privacy blur (press B)' : undefined}>
      {children}
    </div>
  )
}
