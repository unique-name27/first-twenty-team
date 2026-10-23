// Decorations for the trading desk look (docs/LOOKS.md, "Decor slots"). Styles live in
// src/themes/trading.css under the ft-tr- class prefix.
//
// - Banner: a ticker tape built from the workspace's real numbers (headcount, open jobs, pipeline,
//   offers, days to accept, runway, overdue legal deadlines, the next threshold). It scrolls slowly
//   only when one copy of the figures is wider than the column (a ResizeObserver decides); when they
//   fit it stands still with one copy, like a quote strip. A moving tape pauses on hover and while
//   keyboard focus is in the page, and stands still under reduced motion. Screen readers get one
//   plain summary (aria-label); the visible copy is aria-hidden. Only figures the current Viewing-as
//   mode can already see are shown, and cost figures (burn) go through <Private>. An as-of stamp
//   (the app's date and the time of day) is pinned at the right end, outside the moving strip.
// - Headcount: a quote block in the rail: the symbol HC over the rail's own number, and a step
//   sparkline of headcount history with the last value in a price-label box.
// - Footer: a key bar of real links to the sections this viewer can see, plus Search with its real
//   chord (Ctrl K) on a keycap. No F-number caps: function keys belong to the browser and nothing binds them.
import { type CSSProperties, type Ref, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { openPalette } from '@/app/Header'
import { activeNavKey, visibleNav } from '@/app/nav'
import { useRoute } from '@/app/router'
import { keyLabel, useShortcutList } from '@/app/shortcuts'
import { useViewer } from '@/app/useViewer'
import { canSeePipeline } from '@/domain/access'
import { nextThreshold } from '@/domain/compliance'
import { hiringMetrics } from '@/domain/hiring/metrics'
import { inboxItems } from '@/domain/inbox'
import { outstandingOffers, RUNWAY_CAP_MONTHS, runway } from '@/domain/pay'
import { headcountOn, headcountSeries, incomingOn } from '@/domain/people'
import type { DB, Viewer } from '@/domain/types'
import { addMonths, fmtDate, parseDate, today } from '@/lib/dates'
import { moneyShort } from '@/lib/format'
import { useDB } from '@/store/db'
import { usePrefs } from '@/store/prefs'
import { Private } from '@/ui'
import type { HeadcountDecorProps, LookDecor } from '../registry'

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

/** '2026-10-19' -> 'OCT19', the way a terminal prints a settlement date. */
function tapeDate(d: string): string {
  return `${MONTHS[Number(d.slice(5, 7)) - 1]}${d.slice(8, 10)}`
}

/** '2025-10-10' -> 'OCT 2025', for the ends of the rail chart's time axis. */
function axisDate(d: string): string {
  return `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`
}

/** The tape's as-of stamp: 'SAT 10 OCT 18:42' (the app's date, so a pretend today shows; the real time of day). */
function clockText(): string {
  const d = parseDate(today())
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  return `${WEEKDAYS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${hh}:${mm}`
}

/** Re-renders once a minute, on the minute. */
function useClock(): string {
  const [text, setText] = useState(clockText)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      setText(clockText())
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50)
    }
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50)
    return () => clearTimeout(timer)
  }, [])
  return text
}

type Dir = 'up' | 'down' | 'flat'
type Tone = 'good' | 'bad' | 'warn' | 'plain'

type TapeItem = {
  key: string
  sym: string
  value: string
  /** Shown through <Private> (cost figures). */
  sensitive?: boolean
  chg?: { dir: Dir; text: string }
  tone: Tone
  /** Plain words for the screen reader summary. */
  say: string
}

/** A small triangle drawn in SVG, so the arrow never depends on a font having the glyph. */
function Arrow({ dir }: { dir: Dir }) {
  if (dir === 'flat') return null
  return (
    <svg width="7" height="6" viewBox="0 0 7 6" className="ft-tr-arrow" aria-hidden>
      <path d={dir === 'up' ? 'M3.5 0 7 6H0Z' : 'M0 0h7L3.5 6Z'} fill="currentColor" />
    </svg>
  )
}

function tapeItems(db: DB, viewer: Viewer, date: string, blur: boolean): TapeItem[] {
  const admin = viewer.role === 'admin'
  const out: TapeItem[] = []

  // Headcount: everyone sees it in the rail.
  const hc = headcountOn(db, date)
  const incoming = incomingOn(db, date).length
  const leaving = db.people.filter((p) => p.startDate <= date && p.endDate && p.endDate >= date).length
  out.push({
    key: 'hc',
    sym: 'HC',
    value: String(hc),
    chg: incoming ? { dir: 'up', text: String(incoming) } : leaving ? { dir: 'down', text: String(leaving) } : undefined,
    tone: incoming ? 'good' : leaving ? 'bad' : 'plain',
    say: `Headcount ${hc}${incoming ? `, ${incoming} starting` : ''}${leaving ? `, ${leaving} leaving` : ''}`,
  })
  if (viewer.role === 'employee') {
    // Employees see every open job under Me, Open roles.
    const open = db.jobs.filter((j) => j.status === 'open').length
    out.push({ key: 'open', sym: 'OPEN', value: String(open), tone: 'plain', say: `${open} open ${open === 1 ? 'role' : 'roles'}` })
    return out
  }

  // Hiring: the jobs whose pipeline this viewer can see.
  const jobs = db.jobs.filter((j) => j.status === 'open' && canSeePipeline(viewer, j))
  const jobIds = new Set(jobs.map((j) => j.id))
  const active = new Set(db.applications.filter((a) => a.status === 'active' && jobIds.has(a.jobId)).map((a) => a.candidateId))
  out.push({ key: 'open', sym: 'OPEN', value: String(jobs.length), tone: 'plain', say: `${jobs.length} open ${jobs.length === 1 ? 'job' : 'jobs'}` })
  out.push({
    key: 'pipe',
    sym: 'PIPE',
    value: String(active.size),
    tone: 'plain',
    say: `${active.size} active ${active.size === 1 ? 'candidate' : 'candidates'}`,
  })

  if (admin) {
    const offers = outstandingOffers(db, date).length
    // An offer out is pending, not a caution: a plain figure (warn is kept for real warnings).
    out.push({ key: 'offers', sym: 'OFFERS', value: String(offers), tone: 'plain', say: `${offers} ${offers === 1 ? 'offer' : 'offers'} out` })
    const days = hiringMetrics(db, { from: db.company.foundedOn ?? '2000-01-01', to: date }).medianDaysToAccept.days
    if (days != null) {
      const d = Math.round(days)
      out.push({ key: 'tth', sym: 'TTH', value: `${d}D`, tone: 'plain', say: `Median ${d} days to accept` })
    }
    const rw = runway(db, date)
    if (rw.months != null) {
      // A count of months, not pay: shown in the clear, as Cost and runway shows it while blurred. Past
      // RUNWAY_CAP_MONTHS the figure is capped ("60M+"), as Cost and runway says "More than 5 years".
      const capped = rw.months !== Infinity && rw.months > RUNWAY_CAP_MONTHS
      const m = rw.months === Infinity ? 'INF' : capped ? `${RUNWAY_CAP_MONTHS}M+` : `${rw.months >= 2 ? Math.round(rw.months) : rw.months.toFixed(1)}M`
      out.push({
        key: 'runway',
        sym: 'RUNWAY',
        value: m,
        tone: 'plain',
        say: rw.months === Infinity ? 'Runway: cash is not going down' : capped ? 'Runway more than 5 years' : `Runway ${m.replace('M', ' months')}`,
      })
    }
    if (rw.netBurnMonthly > 0) {
      out.push({
        key: 'burn',
        sym: 'BURN',
        value: `${moneyShort(rw.netBurnMonthly)}/MO`,
        sensitive: true,
        tone: 'plain',
        say: blur ? 'Monthly burn hidden' : `Net burn ${moneyShort(rw.netBurnMonthly)} a month`,
      })
    }
  }

  // Legal deadlines that are overdue, from the same inbox Home shows this viewer.
  const overdue = inboxItems(db, viewer, date).filter((i) => i.statutory && i.group === 'overdue').length
  out.push({
    key: 'overdue',
    // Legal deadlines only (the inbox's Overdue group also holds hiring and task follow-ups).
    sym: 'LEGAL OVERDUE',
    value: String(overdue),
    chg: overdue ? { dir: 'down', text: '' } : undefined,
    tone: overdue ? 'bad' : 'good',
    say: overdue ? `${overdue} legal ${overdue === 1 ? 'deadline' : 'deadlines'} overdue` : 'No legal deadlines overdue',
  })

  if (admin) {
    const next = nextThreshold(db, date)
    if (next) {
      const on = next.projectedOn ?? next.projectedIfOffersAccepted
      out.push({
        key: 'next',
        sym: `NEXT ${next.n}`,
        value: on ? tapeDate(on) : 'NO DATE',
        tone: 'warn',
        say: `Next threshold ${next.n} employees${on ? `, ${fmtDate(on)}` : ''}`,
      })
    }
  }
  return out
}

function TapeRow({ items, groupRef }: { items: TapeItem[]; groupRef?: Ref<HTMLSpanElement> }) {
  return (
    <span className="ft-tr-tape__group" ref={groupRef}>
      {items.map((it) => (
        <span key={it.key} className={`ft-tr-tick ft-tr-tick--${it.tone}`}>
          <span className="ft-tr-tick__sym">{it.sym}</span>
          {it.sensitive ? <Private className="ft-tr-tick__value">{it.value}</Private> : <span className="ft-tr-tick__value">{it.value}</span>}
          {it.chg && (
            <span className="ft-tr-tick__chg">
              <Arrow dir={it.chg.dir} />
              {it.chg.text}
            </span>
          )}
        </span>
      ))}
    </span>
  )
}

/** The ticker tape across the top of the main column. */
function TickerTape() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const blur = usePrefs((s) => s.privacyBlur)
  const date = today()
  const items = useMemo(() => tapeItems(db, viewer, date, blur), [db, viewer, date, blur])
  const summary = items.map((i) => i.say).join('. ')
  const viewportRef = useRef<HTMLDivElement>(null)
  const groupRef = useRef<HTMLSpanElement>(null)
  // The width of one copy of the figures, and whether it is wider than the column.
  const [fit, setFit] = useState({ width: 0, moving: false })
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const group = groupRef.current
    if (!viewport || !group || typeof ResizeObserver === 'undefined') return
    const check = () => {
      // Ticks pad the same in both modes, so one copy measures the same moving or still (no flip-flop).
      // Under reduced motion the copy wraps to the column, so it always fits and the tape stays still.
      const width = group.offsetWidth
      const moving = width > viewport.clientWidth + 1
      setFit((f) => (f.width === width && f.moving === moving ? f : { width, moving }))
    }
    const ro = new ResizeObserver(check)
    ro.observe(viewport)
    ro.observe(group)
    check()
    return () => ro.disconnect()
  }, [])
  const { moving } = fit
  const clock = useClock()
  return (
    <div
      className={`ft-tr-tape${moving ? ' ft-tr-tape--moving' : ' ft-tr-tape--still'}`}
      role="marquee"
      aria-label={summary}
      // A steady 20px a second, whatever the number of figures.
      style={moving ? ({ '--ft-tr-tape-duration': `${Math.max(20, Math.round(fit.width / 20))}s` } as CSSProperties) : undefined}
    >
      <div className="ft-tr-tape__viewport" ref={viewportRef} aria-hidden>
        {/* Moving, two copies make the loop seamless: the track moves left by exactly one copy. */}
        <div className="ft-tr-tape__track">
          <TapeRow items={items} groupRef={groupRef} />
          {moving && <TapeRow items={items} />}
        </div>
      </div>
      {/* Pinned outside the moving strip, like a terminal status bar's time. Decoration only. */}
      <span className="ft-tr-tape__clock" aria-hidden>
        {clock}
      </span>
    </div>
  )
}

// Sparkline geometry (viewBox units; the svg scales to the rail's width).
const SW = 216
const SH = 46
const PAD_T = 5
const PAD_B = 5
const TAG_W = 30

/**
 * The rail's quote block. The shell keeps its own big number and label ('14 employees', '+2 starting');
 * this adds the symbol line above them and the history chart below (trading.css orders the pieces).
 */
function HeadcountQuote({ count, incoming }: HeadcountDecorProps) {
  const db = useDB((s) => s.db)
  const date = today()
  const { line, area, last, lo, hi, threshold, from } = useMemo(() => {
    const series = headcountSeries(db, date)
    // A year of history (or since founding, if that is shorter).
    const start = addMonths(date, -12)
    const before = series.filter((p) => p.date <= start)
    const firstVal = before.length ? before[before.length - 1].value : 0
    const pts = [{ date: start, value: firstVal }, ...series.filter((p) => p.date > start), { date, value: count }]
    const from = series.length && series[0].date > start ? series[0].date : start
    const shown = pts.filter((p) => p.date >= from)
    const values = shown.map((p) => p.value)
    const next = nextThreshold(db, date)?.n
    const top = Math.max(1, ...values, count + incoming, next && next <= Math.max(...values, count) * 2 ? next : 0)
    const t0 = new Date(from).getTime()
    const span = Math.max(1, new Date(date).getTime() - t0)
    const x = (d: string) => ((new Date(d).getTime() - t0) / span) * (SW - TAG_W - 4)
    const y = (v: number) => PAD_T + (1 - v / top) * (SH - PAD_T - PAD_B)
    let d = ''
    shown.forEach((p, i) => {
      d += i === 0 ? `M${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}` : ` H${x(p.date).toFixed(1)} V${y(p.value).toFixed(1)}`
    })
    const endX = SW - TAG_W - 4
    d += ` H${endX}`
    return {
      line: d,
      area: `${d} V${SH - PAD_B} H0 Z`,
      last: { x: endX, y: y(count) },
      lo: Math.min(...values),
      hi: Math.max(...values),
      threshold: next && next <= top ? { n: next, y: y(next) } : null,
      from,
    }
  }, [db, date, count, incoming])

  // Same words the kit's tally gives screen readers, so the rail sounds the same in every look.
  const summary = `${count} ${count === 1 ? 'person' : 'people'}${incoming ? `, ${incoming} starting soon` : ''}`
  const tagY = Math.min(Math.max(last.y - 7, 0), SH - 14)
  return (
    <div className="ft-tr-quote">
      <div className="ft-tr-quote__head" aria-hidden>
        <span className="ft-tr-quote__sym">HC</span>
        <span className="ft-tr-quote__name">Headcount</span>
        <span className="ft-tr-quote__range">
          LO <span className="ft-tr-quote__val">{lo}</span> HI <span className="ft-tr-quote__val">{hi}</span>
        </span>
      </div>
      <div className="ft-tr-quote__chart">
        <svg viewBox={`0 0 ${SW} ${SH}`} width="100%" role="img" aria-label={summary} className="ft-tally ft-tr-spark block">
          {/* dotted price grid */}
          <line x1={0} x2={SW - TAG_W - 4} y1={SH - PAD_B} y2={SH - PAD_B} className="ft-tr-spark__base" />
          <line x1={0} x2={SW - TAG_W - 4} y1={(SH - PAD_B + PAD_T) / 2} y2={(SH - PAD_B + PAD_T) / 2} className="ft-tr-spark__grid" />
          {threshold && (
            <g className="ft-tr-spark__level">
              <line x1={0} x2={SW - TAG_W - 4} y1={threshold.y} y2={threshold.y} />
              {/* Above the line, or under it when the line runs along the top edge. */}
              <text x={2} y={threshold.y < 12 ? threshold.y + 9 : threshold.y - 2.5}>
                {threshold.n}
              </text>
            </g>
          )}
          <path d={area} className="ft-tr-spark__area" />
          <path d={line} className="ft-tr-spark__line" />
          <rect x={SW - TAG_W} y={tagY} width={TAG_W} height={14} className="ft-tr-spark__tag" />
          <text x={SW - TAG_W / 2} y={tagY + 10.5} textAnchor="middle" className="ft-tr-spark__tagtext">
            {count}
          </text>
        </svg>
        <div className="ft-tr-quote__axis" aria-hidden>
          <span>{axisDate(from)}</span>
          <span>{axisDate(date)}</span>
        </div>
      </div>
    </div>
  )
}

/**
 * The key bar at the bottom of the main column: real links, labeled with the nav's own words. Only a key
 * that really works gets a keycap (Search shows its chord from the shortcut registry); the sections have
 * no keys, so they show none rather than F numbers the browser owns (F3 is Find).
 */
function FunctionKeys() {
  const viewer = useViewer()
  const route = useRoute()
  const active = activeNavKey(route.view, viewer)
  const items = visibleNav(viewer)
  const search = useShortcutList().find((s) => s.keys === 'mod+k')
  return (
    <nav className="ft-tr-fkeys" aria-label="Quick links">
      <ul className="ft-tr-fkeys__list">
        <li>
          <button type="button" className="ft-tr-fkey" onClick={openPalette} aria-keyshortcuts={search ? 'Control+K Meta+K' : undefined}>
            {search && (
              <span className="ft-tr-fkey__key" aria-hidden>
                {keyLabel(search.keys).join(' ')}
              </span>
            )}
            <span className="ft-tr-fkey__label">Search</span>
          </button>
        </li>
        {items.map((n) => (
          <li key={n.key}>
            <a href={n.href} className="ft-tr-fkey" aria-current={n.key === active ? 'page' : undefined}>
              <span className="ft-tr-fkey__label">{n.label}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export const decor: LookDecor = {
  Banner: TickerTape,
  Headcount: HeadcountQuote,
  Footer: FunctionKeys,
}
