// Compliance calendar: recurring and dated obligations by month, overdue first, statutory badges,
// one-tap Mark done, and an .ics download with Copy fallbacks.
import { format } from 'date-fns'
import { useMemo, useState } from 'react'
import { links } from '@/app/router'
import { type CalendarItem, calendarICS, complianceCalendar, RULE_BY_ID } from '@/domain/compliance'
import { completeRecurringItem, markAccessReviewDone, markAnnualDone } from '@/domain/compliance/actions'
import { markDesignationSent } from '@/domain/lifecycle'
import { fullName } from '@/domain/people'
import type { DB } from '@/domain/types'
import { addDays, addMonths, daysBetween, fmtDate, fmtDay, fmtQuarter, parseDate, today } from '@/lib/dates'
import { copyText, downloadFile, slug } from '@/lib/files'
import { plural } from '@/lib/format'
import { useDB } from '@/store/db'
import { currentActorId, logActivity } from '@/store/draft'
import { Badge, Button, cx, EmptyState, Icon, Menu, Panel, Segmented, toast } from '@/ui'
import { Disclosure, keepFocusAfter, LegalNote, markTrainingDone } from './bits'
import { bucketCalendar, type CalendarDone, calendarDoneAction, calendarText } from './helpers'
import { commit } from './mutate'

type Horizon = '3' | '6' | '12'

export function CalendarTab() {
  const db = useDB((s) => s.db)
  const t = today()
  const [horizon, setHorizon] = useState<Horizon>('6')
  const items = useMemo(() => complianceCalendar(db, addDays(t, -365), addMonths(t, Number(horizon))), [db, t, horizon])
  const b = useMemo(() => bucketCalendar(items, t), [items, t])
  const visible = [...b.overdue, ...b.months.flatMap((m) => m.items)]
  const upcoming = b.months.reduce((n, m) => n + m.items.length, 0)
  const fileName = `${slug(db.company.name || 'company')}-compliance-calendar.ics`

  const download = () => {
    const ok = downloadFile(fileName, calendarICS(visible, `${db.company.name} compliance`), 'text/calendar;charset=utf-8')
    toast(ok ? `Downloaded ${plural(visible.length, 'date')} as ${fileName}` : { text: 'The download was blocked. Use Copy instead.', tone: 'bad' })
  }
  const copy = async (what: 'list' | 'ics') => {
    const text = what === 'list' ? calendarText(visible, fmtDay) : calendarICS(visible, `${db.company.name} compliance`)
    const ok = await copyText(text)
    toast(ok ? (what === 'list' ? `Copied ${plural(visible.length, 'date')} as a list` : 'Copied the .ics text') : { text: 'Copy did not work in this browser.', tone: 'bad' })
  }

  return (
    <div data-focus-scope className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {/* Where focus lands when Mark done empties every list (keepFocusAfter): the counts, read aloud. */}
        <div data-focus-fallback>
          <p className="text-[15px] text-ink">
            <span className={cx('font-bold', b.overdue.length ? 'text-bad' : 'text-ink')}>{plural(b.overdue.length, 'overdue item')}</span>
            {', '}
            {plural(upcoming, 'date')} in the next {horizon} months.
          </p>
          <p className="text-[13.5px] text-ink-3">Only legal deadlines turn red. Company controls and reminders stay amber.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Horizon>
            label="How far ahead"
            value={horizon}
            onChange={setHorizon}
            options={[
              { value: '3', label: '3 months' },
              { value: '6', label: '6 months' },
              { value: '12', label: '12 months' },
            ]}
          />
          <Button icon="download" onClick={download} disabled={!visible.length}>
            Download .ics
          </Button>
          <Menu
            label="Copy the calendar"
            items={[
              { label: 'Copy as a list', icon: 'copy', onSelect: () => void copy('list') },
              { label: 'Copy the .ics text', icon: 'calendar', onSelect: () => void copy('ics') },
            ]}
            trigger={(p) => (
              <Button {...p} icon="copy" disabled={!visible.length}>
                Copy
              </Button>
            )}
          />
        </div>
      </div>

      {b.overdue.length > 0 && (
        <Panel title="Overdue" icon="alert" padded={false} actions={<Badge tone={b.overdue.some((i) => i.statutory) ? 'bad' : 'warn'} className="ft-count">{b.overdue.length}</Badge>}>
          <ul className="divide-y divide-line">
            {b.overdue.map((i) => (
              <CalendarRow key={i.id} item={i} db={db} overdue />
            ))}
          </ul>
        </Panel>
      )}

      {b.months.length === 0 && b.overdue.length === 0 && (
        <EmptyState icon="calendar-check" title="Nothing due in this window" body="Pick a longer window to see what comes later." />
      )}

      {b.months.map((m) => (
        <Panel key={m.month} title={format(parseDate(`${m.month}-01`), 'MMMM yyyy')} padded={false} actions={<Badge className="ft-count">{m.items.length}</Badge>}>
          <ul className="divide-y divide-line">
            {m.items.map((i) => (
              <CalendarRow key={i.id} item={i} db={db} />
            ))}
          </ul>
        </Panel>
      ))}

      {b.recentlyDone.length > 0 && (
        <Disclosure label={`Done in the last 30 days (${b.recentlyDone.length})`}>
          <ul className="flex flex-col gap-1.5">
            {b.recentlyDone.map((i) => (
              <li key={i.id} className="flex items-start gap-2 text-[14px] text-ink-2">
                <Icon name="check" size={16} className="mt-0.5 shrink-0 text-good" />
                <span>
                  {fmtDay(i.date)}: {i.title}
                </span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      <LegalNote />
    </div>
  )
}

const DONE_LABEL: Record<CalendarDone['kind'], string> = {
  recurring: 'Mark done',
  training: 'Done today',
  annual: 'Mark done',
  access_review: 'Mark done',
  leave_notice: 'Mark sent',
  de542: 'Mark filed',
}

function itemLink(item: CalendarItem): { href: string; label: string } | null {
  if (item.kind === 'training') return { href: links.compliance('training'), label: 'Open training' }
  if (item.personId) return { href: links.person(item.personId), label: 'Open person' }
  if (item.contractorId) return { href: links.contractor(item.contractorId), label: 'Open contractor' }
  if (item.kind === 'valuation_409a') return { href: links.comp('equity'), label: 'Open equity' }
  if (item.kind === 'rate_review' || item.ruleId === 'rate-review') return { href: links.settings('rules'), label: 'Open rules and rates' }
  if (item.ruleId && RULE_BY_ID[item.ruleId]) return { href: links.rule(item.ruleId), label: 'Open rule' }
  return null
}

function markDone(db: DB, item: CalendarItem, action: CalendarDone): void {
  const t = today()
  switch (action.kind) {
    case 'recurring':
      commit(`Done: ${item.title}`, (d) => {
        completeRecurringItem(d, action.recurringId, t)
        if (action.ruleId && action.year) markAnnualDone(d, action.ruleId, action.year, t)
      })
      return
    case 'training':
      markTrainingDone(db, action.personId, action.trainingKind)
      return
    case 'annual':
      commit(`Done for ${action.year}: ${item.title}`, (d) => markAnnualDone(d, action.ruleId, action.year, t))
      return
    case 'access_review':
      commit(`Recorded the ${fmtQuarter(action.quarter)} access review`, (d) => markAccessReviewDone(d, action.quarter, t))
      return
    case 'leave_notice': {
      const leave = db.leaveCases.find((l) => l.id === action.leaveId)
      const person = db.people.find((p) => p.id === leave?.personId)
      // Same write as the time off panel and the inbox: dates the case and closes the leave checklist task.
      commit(`Marked the leave notice sent${person ? ` to ${fullName(person)}` : ''}`, (d) => {
        markDesignationSent(d, action.leaveId, { date: t, byId: currentActorId(d) })
      })
      return
    }
    case 'de542': {
      const c = db.contractors.find((x) => x.id === action.contractorId)
      commit(`Filed DE 542 for ${c?.entityName || c?.name || 'the contractor'}`, (d) => {
        const row = d.contractors.find((x) => x.id === action.contractorId)
        if (!row || row.de542FiledOn) return
        row.de542FiledOn = t
        logActivity(d, { entityType: 'contractor', entityId: row.id, kind: 'de542_filed', text: `DE 542 filed on ${fmtDate(t)}` })
      })
      return
    }
  }
}

function CalendarRow({ item, db, overdue }: { item: CalendarItem; db: DB; overdue?: boolean }) {
  const t = today()
  const action = calendarDoneAction(db, item)
  const link = itemLink(item)
  const late = overdue ? daysBetween(item.date, t) : 0
  const [weekday, day] = fmtDay(item.date).split(', ')
  return (
    <li className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3.5">
        <div
          className={cx(
            'ft-datetile',
            overdue && (item.statutory ? 'ft-datetile--bad' : 'ft-datetile--warn'),
            'flex w-14 shrink-0 flex-col items-center rounded-lg py-1.5 text-center',
            overdue ? (item.statutory ? 'bg-bad-soft text-bad' : 'bg-warn-soft text-warn') : 'bg-surface-2 text-ink-2',
          )}
        >
          <span className="ft-datetile__weekday text-[11.5px] font-bold uppercase">{weekday}</span>
          <span className="ft-datetile__day num text-[13.5px] font-bold whitespace-nowrap">{day}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-ink">{item.title}</p>
          {item.fileBy && !item.done && (
            <p className="mt-0.5 text-[13.5px] font-semibold text-ink-2">
              File by {fmtDay(item.fileBy)}: the deadline falls on a weekend or company holiday.
            </p>
          )}
          {item.detail && <p className="mt-0.5 text-[13.5px] text-ink-3">{item.detail}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {overdue && (
              <Badge tone={item.statutory ? 'bad' : 'warn'} icon="alert">
                Overdue {plural(late, 'day')}
              </Badge>
            )}
            {item.statutory ? (
              <Badge tone="outline" icon="scale">
                Legal deadline
              </Badge>
            ) : (
              <Badge tone="neutral">Reminder</Badge>
            )}
            {item.link && (
              // A 40px hit area around the 28px pill, like CitationChip.
              <a
                href={item.link}
                target="_blank"
                rel="noreferrer noopener"
                className="ft-cite-link group -my-1.5 inline-flex h-10 items-center rounded-full"
                title={item.kind === 'training' ? 'Open the course' : 'Open the source'}
              >
                <span className="ft-cite inline-flex h-7 items-center gap-1 rounded-full border border-line-strong px-2.5 text-[12px] font-semibold text-ink-2 group-hover:border-ink-3 group-hover:text-ink">
                  {item.kind === 'training' ? 'Course' : 'Source'}
                  <Icon name="external" size={11} />
                </span>
              </a>
            )}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
        {link && (
          <a href={link.href} className="inline-flex h-11 items-center rounded-lg px-3 text-[14px] font-semibold text-accent hover:bg-accent-soft">
            {link.label}
          </a>
        )}
        {action && (
          <Button
            variant={overdue ? 'primary' : 'secondary'}
            icon="check"
            data-focus-key={`cal-${item.id}`}
            onClick={(e) => {
              keepFocusAfter(e.currentTarget)
              markDone(db, item, action)
            }}
          >
            {DONE_LABEL[action.kind]}
          </Button>
        )}
      </div>
    </li>
  )
}
