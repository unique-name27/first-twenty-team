// Minimal iCalendar (.ics) builder for interviews, time off and compliance deadlines.
// Timed events are written in UTC; all-day events use DATE values.

export type ICSEvent = {
  uid: string
  title: string
  description?: string
  location?: string
  /** Timed event: ISO timestamps. */
  start?: string
  end?: string
  /** All-day event: 'YYYY-MM-DD' (end is exclusive; defaults to the next day). */
  date?: string
  endDate?: string
  /** A link for the event (a video meeting room). */
  url?: string
  /** Revision of the event: a calendar applies a file for the same UID only when it is higher (0 when left out). */
  sequence?: number
  /** STATUS line; a cancellation file sets CANCELLED. */
  status?: 'CONFIRMED' | 'CANCELLED'
  /** People without an email address are left out (a calendar cannot invite them). */
  organizer?: { name: string; email: string }
  attendees?: Array<{ name: string; email: string }>
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

function utc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function ymd(d: string): string {
  return d.replace(/-/g, '')
}

function nextDay(d: string): string {
  const [y, m, day] = d.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, day + 1))
  return dt.toISOString().slice(0, 10)
}

/** Folds long lines at 75 octets as RFC 5545 requires. */
function fold(line: string): string {
  if (line.length <= 74) return line
  const parts: string[] = []
  let rest = line
  parts.push(rest.slice(0, 74))
  rest = rest.slice(74)
  while (rest.length > 73) {
    parts.push(` ${rest.slice(0, 73)}`)
    rest = rest.slice(73)
  }
  if (rest) parts.push(` ${rest}`)
  return parts.join('\r\n')
}

/**
 * A calendar file. `method` 'CANCEL' takes events off the calendars that have them: give each event the
 * UID of the invite it cancels, a higher `sequence` and `status: 'CANCELLED'`.
 */
export function buildICS(events: ICSEvent[], calendarName = 'First Twenty', opts: { method?: 'PUBLISH' | 'CANCEL' } = {}): string {
  const stamp = utc(new Date().toISOString())
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//First Twenty//EN', 'CALSCALE:GREGORIAN', `METHOD:${opts.method ?? 'PUBLISH'}`, `X-WR-CALNAME:${esc(calendarName)}`]
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}@first-twenty`, `DTSTAMP:${stamp}`, `SUMMARY:${esc(e.title)}`)
    if (e.sequence != null) lines.push(`SEQUENCE:${Math.max(0, Math.round(e.sequence))}`)
    if (e.status) lines.push(`STATUS:${e.status}`)
    if (e.date) {
      lines.push(`DTSTART;VALUE=DATE:${ymd(e.date)}`, `DTEND;VALUE=DATE:${ymd(e.endDate ?? nextDay(e.date))}`)
    } else if (e.start) {
      lines.push(`DTSTART:${utc(e.start)}`, `DTEND:${utc(e.end ?? e.start)}`)
    }
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`)
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`)
    if (e.url?.trim()) lines.push(`URL:${e.url.trim()}`)
    if (e.organizer?.email.trim()) lines.push(`ORGANIZER;CN=${esc(e.organizer.name)}:mailto:${e.organizer.email.trim()}`)
    for (const a of e.attendees ?? []) if (a.email.trim()) lines.push(`ATTENDEE;CN=${esc(a.name)};RSVP=TRUE:mailto:${a.email.trim()}`)
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}
