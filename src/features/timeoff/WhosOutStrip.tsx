// Compact who's-out list by day for a date range (Home "This week", People). Each absence shows once, on its
// first day in the range, with how long it runs; company holidays show on their day. Viewers without
// access to someone's time off see only "Out".
import { useMemo } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { fullName } from '@/domain/people'
import { whoIsOut } from '@/domain/timeoff'
import { addDays, fmtDay, type ISODate, isWeekday } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Avatar, Badge, Icon } from '@/ui'
import { entryView } from './logic'

type Line = { key: string; personId?: string; text: string; pending?: boolean; holiday?: boolean }

/** `personIds` limits the list to those people (a manager's team on Home); holidays still show. */
export function WhosOutStrip({ from, to, personIds }: { from: string; to: string; personIds?: string[] }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const scopeKey = personIds?.join('|')

  const days = useMemo(() => {
    const holidays = new Map(db.holidays.map((h) => [h.date, h.name]))
    const only = scopeKey === undefined ? null : new Set(scopeKey.split('|'))
    const entries = whoIsOut(db, from, to)
      .filter((e) => !only || only.has(e.personId))
      .map((e, i) => ({ e, v: entryView(db, viewer, e), i }))
      .filter(({ v }) => v.visible)
    const out: Array<{ date: ISODate; lines: Line[] }> = []
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (!isWeekday(d)) continue
      const lines: Line[] = []
      const hol = holidays.get(d)
      if (hol) lines.push({ key: `h-${d}`, text: `Company holiday: ${hol}`, holiday: true })
      for (const { e, v, i } of entries) {
        // Show each absence on its first weekday inside the range.
        let first = e.from > from ? e.from : from
        while (!isWeekday(first) && first < e.to) first = addDays(first, 1)
        if (first !== d) continue
        const multi = e.to > d
        // Leave reads "Leave, back <date>" for permitted viewers and just "Out" for everyone else.
        const text = e.kind === 'leave' ? v.text : multi ? `${v.text}, through ${fmtDay(e.to)}` : v.text
        lines.push({ key: `${e.requestId ?? e.leaveCaseId}-${i}`, personId: e.personId, text, pending: v.pending })
      }
      if (lines.length) out.push({ date: d, lines })
    }
    return out
  }, [db, viewer, from, to, scopeKey])

  if (days.length === 0) {
    return (
      <p className="flex items-center gap-2 py-2 text-[14px] text-ink-3">
        <Icon name="calendar-check" size={16} />
        Nobody is out {from === to ? `on ${fmtDay(from)}` : `from ${fmtDay(from)} to ${fmtDay(to)}`}.
      </p>
    )
  }

  return (
    <ul className="flex flex-col" aria-label={`Who is out, ${fmtDay(from)} to ${fmtDay(to)}`}>
      {days.map(({ date, lines }) => (
        <li key={date} className="flex gap-3 border-b border-line py-1.5 last:border-b-0">
          <span className="num w-[86px] shrink-0 pt-2.5 text-[13px] font-semibold text-ink-3">{fmtDay(date)}</span>
          <ul className="flex min-w-0 flex-1 flex-col">
            {lines.map((l) => {
              const p = l.personId ? db.people.find((x) => x.id === l.personId) : undefined
              if (l.holiday || !p) {
                return (
                  <li key={l.key} className="flex min-h-10 items-center gap-2 text-[14px] text-ink-2">
                    <Icon name="star" size={15} className="text-ink-3" />
                    {l.text}
                  </li>
                )
              }
              return (
                <li key={l.key} className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <a href={links.person(p.id)} className="inline-flex min-h-10 items-center gap-2 font-semibold text-ink hover:text-accent">
                    <Avatar name={fullName(p)} size={24} />
                    {fullName(p)}
                  </a>
                  <span className="text-[13.5px] text-ink-2">{l.text}</span>
                  {l.pending && <Badge tone="warn">Pending</Badge>}
                </li>
              )
            })}
          </ul>
        </li>
      ))}
    </ul>
  )
}
