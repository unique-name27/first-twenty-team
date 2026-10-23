// Number and text formatting. Money is whole US dollars unless noted.

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const usd2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

/** "$185,000" */
export function money(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return ''
  return usd0.format(n)
}

/** "$0.62" for per-share prices and hourly rates. */
export function money2(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return ''
  return usd2.format(n)
}

/** "$185K", "$1.2M", "$1.2B" (a mistyped amount still reads as what it is) */
export function moneyShort(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return ''
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000_000) return `${sign}$${trim(abs / 1_000_000_000, abs >= 10_000_000_000 ? 1 : 2)}B`
  if (abs >= 1_000_000) return `${sign}$${trim(abs / 1_000_000, abs >= 10_000_000 ? 1 : 2)}M`
  if (abs >= 1_000) return `${sign}$${trim(abs / 1_000, abs >= 100_000 ? 0 : 1)}K`
  return `${sign}$${int.format(abs)}`
}

/** "$170K-$205K" */
export function moneyRange(min: number | null | undefined, max: number | null | undefined): string {
  if (min == null && max == null) return ''
  if (min == null) return `up to ${moneyShort(max)}`
  if (max == null) return `from ${moneyShort(min)}`
  return `${moneyShort(min)}-${moneyShort(max)}`
}

/** "12,500" */
export function num(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return ''
  return int.format(n)
}

/** 0.0125 -> "1.25%"; digits adapt so small equity grants stay readable. */
export function pct(fraction: number | null | undefined, digits?: number): string {
  if (fraction == null || Number.isNaN(fraction)) return ''
  const p = fraction * 100
  const d = digits ?? (Math.abs(p) < 1 ? 2 : Math.abs(p) < 10 ? 1 : 0)
  return `${trim(p, d)}%`
}

function trim(n: number, digits: number): string {
  const s = n.toFixed(digits)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

/** Hours to at most one decimal: 127.333 -> "127.3", 40 -> "40". */
export function hoursNum(hours: number): string {
  return trim(Math.round(hours * 10) / 10, 1)
}

/** "127.3 hours", "1 hour". */
export function hoursText(hours: number): string {
  const h = Math.round(hours * 10) / 10
  return `${hoursNum(h)} ${h === 1 ? 'hour' : 'hours'}`
}

/** Hours as days to at most one decimal: (127.33, 8) -> "15.9 days", (14.4, 4.8) -> "3 days". */
export function daysFromHours(hours: number, hoursPerDay = 8): string {
  const d = hoursPerDay > 0 ? Math.round((hours / hoursPerDay) * 10) / 10 : 0
  return `${trim(d, 1)} ${d === 1 ? 'day' : 'days'}`
}

/**
 * The one way to write a time off balance: hours to one decimal with the days in brackets.
 * "127.3 hours (15.9 days)", "40 hours (5 days)", "0 hours".
 */
export function hoursWithDays(hours: number, hoursPerDay = 8): string {
  const h = Math.round(hours * 10) / 10
  if (hoursPerDay <= 0 || h === 0) return hoursText(h)
  return `${hoursText(h)} (${daysFromHours(hours, hoursPerDay)})`
}

/** "1 candidate" / "3 candidates" */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Stable small hash for picking avatar colors etc. */
export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Sentence-case label from an enum key: "non_exempt" -> "Non exempt". Prefer explicit label maps for UI. */
export function humanize(key: string): string {
  const s = key.replace(/[_-]+/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** "Ana, Ben and Chen" */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('')
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
