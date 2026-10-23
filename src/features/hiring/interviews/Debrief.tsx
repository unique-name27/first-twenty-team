// Debrief: scorecards side by side (attributes down, one column per scorecard), missing flagged.
// Respects canSeeOthersScorecards: other interviewers' ratings stay hidden until yours is in.
import { useState } from 'react'
import { useViewer } from '@/app/useViewer'
import { canSeeOthersScorecards } from '@/domain/access'
import { debrief } from '@/domain/hiring/scorecards'
import { personNameById } from '@/domain/people'
import type { ID } from '@/domain/types'
import { fmtDateTime, nowISO } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Badge, Button, Callout } from '@/ui'
import { Block, MoneyText } from './common'
import { ratingTone, ratingWord } from './logic'

export function DebriefGrid({ applicationId, onFill }: { applicationId: ID; onFill: (scorecardId: ID) => void }) {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const [showNotes, setShowNotes] = useState(false)
  const app = db.applications.find((a) => a.id === applicationId)
  if (!app) return null
  // Only interviews that have started: scorecards for later interviews are not owed yet.
  const now = nowISO()
  const all = debrief(db, applicationId)
  const started = new Set(db.interviews.filter((i) => i.applicationId === applicationId && i.startsAt <= now).map((i) => i.id))
  const keep = new Set(all.columns.filter((c) => started.has(c.interviewId)).map((c) => c.scorecardId))
  const d = {
    ...all,
    columns: all.columns.filter((c) => keep.has(c.scorecardId)),
    grid: all.grid
      .map((r) => ({ ...r, cells: r.cells.filter((c) => keep.has(c.scorecardId)) }))
      .filter((r) => r.cells.some((c) => !c.notAsked)),
    overall: all.overall.filter((o) => keep.has(o.scorecardId)),
    missing: all.missing.filter((m) => keep.has(m.scorecardId)),
  }
  d.allIn = d.columns.length > 0 && d.missing.length === 0
  const upcoming = db.interviews.filter((i) => i.applicationId === applicationId && i.status === 'scheduled' && i.startsAt > now).length
  if (d.columns.length === 0) return null
  const canSeeAll = canSeeOthersScorecards(viewer, db, app)
  const submitted = d.columns.filter((c) => c.submitted).length
  const mine = d.columns.find((c) => c.interviewerId === viewer.personId && !c.submitted)
  const summary = `${submitted} of ${d.columns.length} scorecards in`

  if (!canSeeAll) {
    return (
      <Block title="Debrief" actions={<Badge tone={d.allIn ? 'good' : 'neutral'}>{summary}</Badge>}>
        <Callout
          tone="neutral"
          icon="lock"
          title="Other scorecards stay hidden until you submit yours"
          action={
            mine ? (
              <Button variant="primary" onClick={() => onFill(mine.scorecardId)}>
                Fill scorecard
              </Button>
            ) : undefined
          }
        >
          This keeps each interviewer&apos;s view independent. Once yours is in, the side-by-side view opens.
        </Callout>
      </Block>
    )
  }

  const notes = d.columns
    .map((c) => ({ c, sc: db.scorecards.find((s) => s.id === c.scorecardId) }))
    .filter((x) => x.c.submitted && x.sc?.notes)

  return (
    <Block
      title="Debrief"
      actions={
        <>
          <Badge tone={d.allIn ? 'good' : 'warn'} icon={d.allIn ? 'check' : 'clock'}>
            {d.allIn ? (upcoming ? `All in so far, ${upcoming} ${upcoming === 1 ? 'interview' : 'interviews'} to come` : 'All scorecards in') : summary}
          </Badge>
          {notes.length > 0 && (
            <Button size="sm" variant="ghost" aria-expanded={showNotes} onClick={() => setShowNotes((v) => !v)}>
              {showNotes ? 'Hide notes' : `Show notes (${notes.length})`}
            </Button>
          )}
        </>
      }
    >
      <div className="scroll-thin relative overflow-x-auto rounded-xl border border-line">
        <table className="ft-matrix w-full min-w-[480px] border-collapse text-left text-[13.5px]">
          <caption className="sr-only">Scorecard ratings by attribute and interviewer</caption>
          <thead>
            <tr className="border-b border-line bg-surface-2/60">
              <th scope="col" className="sticky left-0 z-[1] min-w-[150px] bg-surface-2 px-3 py-2 text-[12.5px] font-bold text-ink-3">
                Attribute
              </th>
              {d.columns.map((c) => (
                <th key={c.scorecardId} scope="col" className="px-3 py-2 align-bottom">
                  <span className="block text-[13px] font-bold text-ink">{c.interviewerName}</span>
                  <span className="block text-[12px] font-normal text-ink-3">{c.interviewName}</span>
                  {c.enteredById && <span className="block text-[11.5px] font-normal text-ink-3">Entered by {personNameById(db, c.enteredById, 'Admin')}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.grid.map((row) => (
              <tr key={row.attribute} className="border-b border-line">
                <th scope="row" className="sticky left-0 z-[1] min-w-[150px] bg-surface px-3 py-2 font-semibold text-ink">
                  {row.attribute}
                </th>
                {row.cells.map((cell) => (
                  <td key={cell.scorecardId} className="px-3 py-2">
                    {cell.rating ? (
                      <Badge tone={ratingTone(cell.rating)}>{ratingWord(cell.rating)}</Badge>
                    ) : cell.missing ? (
                      <Badge tone="outline">Missing</Badge>
                    ) : (
                      <span className="text-ink-3" title="Not part of this interview">
                        <span aria-hidden>·</span>
                        <span className="sr-only">Not asked</span>
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="bg-surface-2/40">
              <th scope="row" className="sticky left-0 z-[1] bg-surface-2 px-3 py-2.5 font-bold text-ink">
                Overall
              </th>
              {d.overall.map((o) => (
                <td key={o.scorecardId} className="px-3 py-2.5">
                  {o.rating ? (
                    <Badge tone={ratingTone(o.rating)} icon={o.rating >= 3 ? 'check' : 'x'}>
                      {ratingWord(o.rating)}
                    </Badge>
                  ) : (
                    <Badge tone="outline">Missing</Badge>
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {d.missing.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {d.missing.map((m) => {
            const sc = db.scorecards.find((s) => s.id === m.scorecardId)
            const isMe = m.interviewerId === viewer.personId
            const step = d.columns.find((c) => c.scorecardId === m.scorecardId)?.interviewName ?? 'the interview'
            return (
              <li key={m.scorecardId} className="flex flex-wrap items-center justify-between gap-2 text-[13.5px] text-ink-2">
                <span>
                  Waiting on <span className="font-semibold text-ink">{isMe ? 'you' : m.name}</span> for {step}
                  {sc ? `, due ${fmtDateTime(sc.dueAt)}` : ''}
                </span>
                {(isMe || viewer.role === 'admin') && (
                  <Button
                    size="sm"
                    variant={isMe ? 'primary' : 'secondary'}
                    onClick={() => onFill(m.scorecardId)}
                    aria-label={isMe ? `Fill scorecard for ${step}` : `Enter for ${m.name.split(' ')[0]}: ${step}`}
                  >
                    {isMe ? 'Fill scorecard' : `Enter for ${m.name.split(' ')[0]}`}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {showNotes && (
        <div className="mt-3 flex flex-col gap-3">
          {notes.map(({ c, sc }) => (
            <div key={c.scorecardId} className="rounded-xl bg-surface-2 px-3.5 py-3">
              <p className="text-[13px] font-bold text-ink">
                {c.interviewerName}, {c.interviewName}
              </p>
              <p className="mt-1 text-[13.5px] whitespace-pre-wrap text-ink-2">
                <MoneyText text={sc?.notes ?? ''} />
              </p>
            </div>
          ))}
        </div>
      )}
    </Block>
  )
}
