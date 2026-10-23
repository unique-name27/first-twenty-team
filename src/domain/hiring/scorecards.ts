// Scorecards: 3 to 5 role attributes on a 4-point scale with no neutral, plus an overall Strong no,
// No, Yes or Strong yes. Due settings.scorecardDueHours after the interview ends. Visibility (hidden
// until your own is in) is enforced by src/domain/access.ts; these helpers return everything.
// Module rule: the store import stays LAST and there are no module-level runtime constants.
import type { Draft } from 'immer'
import { personNameById } from '@/domain/people'
import type { DB, ID, Interview, Rating, Scorecard } from '@/domain/types'
import { type ISODateTime } from '@/lib/dates'
import { addMinutesISO, candidateName } from './util'
import { logActivity } from '@/store/draft'

export function ratingLabel(r: Rating | null | undefined): string {
  switch (r) {
    case 1:
      return 'Strong no'
    case 2:
      return 'No'
    case 3:
      return 'Yes'
    case 4:
      return 'Strong yes'
    default:
      return ''
  }
}

export function isRating(n: unknown): n is Rating {
  return n === 1 || n === 2 || n === 3 || n === 4
}

export function interviewEndsAt(i: Pick<Interview, 'startsAt' | 'durationMin'>): ISODateTime {
  return addMinutesISO(i.startsAt, i.durationMin)
}

export type OwedScorecard = { scorecard: Scorecard; interview: Interview; overdue: boolean }

/**
 * Scorecards a person still owes: the interview has ended (scheduled or completed, not cancelled or
 * a no-show), the scorecard is not submitted, and the application is still active (nobody is nagged
 * about a candidate who was already hired, rejected or withdrew). Oldest due first.
 */
export function scorecardsOwed(
  db: Pick<DB, 'scorecards' | 'interviews'> & Partial<Pick<DB, 'applications'>>,
  personId: ID,
  nowISO: ISODateTime,
): OwedScorecard[] {
  const now = new Date(nowISO).getTime()
  const out: OwedScorecard[] = []
  for (const s of db.scorecards) {
    if (s.interviewerId !== personId || s.submittedAt) continue
    const i = db.interviews.find((x) => x.id === s.interviewId)
    if (!i || (i.status !== 'scheduled' && i.status !== 'completed')) continue
    const app = db.applications?.find((a) => a.id === i.applicationId)
    if (app && app.status !== 'active') continue
    if (new Date(interviewEndsAt(i)).getTime() > now) continue
    out.push({ scorecard: s, interview: i, overdue: new Date(s.dueAt).getTime() < now })
  }
  return out.sort((a, b) => a.scorecard.dueAt.localeCompare(b.scorecard.dueAt))
}

/** All owed scorecards across the team (for the admin inbox). */
export function allScorecardsOwed(db: Pick<DB, 'scorecards' | 'interviews'> & Partial<Pick<DB, 'applications'>>, nowISO: ISODateTime): OwedScorecard[] {
  const people = [...new Set(db.scorecards.map((s) => s.interviewerId))]
  return people.flatMap((p) => scorecardsOwed(db, p, nowISO)).sort((a, b) => a.scorecard.dueAt.localeCompare(b.scorecard.dueAt))
}

/**
 * Suggested overall from attribute ratings: the average, rounded. A tie at exactly 2.5 goes to No,
 * because a split panel is not a yes. Never neutral. Null when nothing is rated.
 */
export function overallSuggestion(ratings: Record<string, Rating | undefined>): Rating | null {
  const values = Object.values(ratings).filter(isRating)
  if (values.length === 0) return null
  const avg = values.reduce((s, v) => s + v, 0) / values.length
  const rounded = avg === 2.5 ? 2 : Math.round(avg)
  return Math.min(4, Math.max(1, rounded)) as Rating
}

/**
 * Submits a scorecard. Notes are optional; the overall defaults to the suggestion from the ratings.
 * When an admin enters it for the interviewer, enteredById records who did. Returns false when the
 * scorecard is missing or nothing is rated.
 */
export function submitScorecard(
  draft: Draft<DB>,
  scorecardId: ID,
  input: { ratings: Record<string, Rating>; overall?: Rating; notes?: string; enteredById?: ID },
  nowISO: ISODateTime,
): boolean {
  const s = draft.scorecards.find((x) => x.id === scorecardId)
  if (!s) return false
  const ratings: Record<string, Rating> = {}
  for (const [k, v] of Object.entries(input.ratings)) if (isRating(v)) ratings[k] = v
  const overall = input.overall ?? overallSuggestion(ratings)
  if (!overall) return false
  s.ratings = ratings
  s.overall = overall
  if (input.notes?.trim()) s.notes = input.notes.trim()
  else delete s.notes
  s.submittedAt = nowISO
  if (input.enteredById && input.enteredById !== s.interviewerId) s.enteredById = input.enteredById
  const i = draft.interviews.find((x) => x.id === s.interviewId)
  if (i && i.status === 'scheduled') i.status = 'completed'
  const app = draft.applications.find((a) => a.id === s.applicationId)
  const cand = app ? candidateName(draft, app.candidateId) : 'a candidate'
  const who = personNameById(draft, s.interviewerId, 'An interviewer')
  // The rating stays out of the activity text so it does not leak to other interviewers.
  const text = s.enteredById
    ? `${personNameById(draft, s.enteredById, 'An admin')} entered ${who}'s scorecard for ${cand}`
    : `${who} submitted a scorecard for ${cand}`
  logActivity(draft, {
    entityType: 'application',
    entityId: s.applicationId,
    ...(app ? { relatedId: app.candidateId } : {}),
    kind: 'scorecard_submitted',
    text,
  })
  return true
}

export type DebriefColumn = {
  scorecardId: ID
  interviewerId: ID
  interviewerName: string
  interviewId: ID
  interviewName: string
  submitted: boolean
  overall?: Rating
  enteredById?: ID
}

export type DebriefCell = {
  scorecardId: ID
  rating?: Rating
  /** The attribute was on this interview but has no rating yet. */
  missing: boolean
  /** The attribute was not part of this interview. */
  notAsked: boolean
}

export type Debrief = {
  attributes: string[]
  columns: DebriefColumn[]
  grid: Array<{ attribute: string; cells: DebriefCell[] }>
  /** Interviewers who still owe a scorecard. */
  missing: Array<{ interviewerId: ID; name: string; scorecardId: ID }>
  overall: Array<{ scorecardId: ID; rating?: Rating; missing: boolean }>
  allIn: boolean
}

/** Scorecards side by side: attributes down, one column per scorecard, with missing flags. */
export function debrief(db: DB, applicationId: ID): Debrief {
  const interviews = db.interviews.filter((i) => i.applicationId === applicationId && i.status !== 'cancelled' && i.status !== 'no_show')
  const order = new Map(interviews.map((i) => [i.id, i.startsAt]))
  const cards = db.scorecards
    .filter((s) => s.applicationId === applicationId && order.has(s.interviewId))
    .sort((a, b) => (order.get(a.interviewId) ?? '').localeCompare(order.get(b.interviewId) ?? '') || a.interviewerId.localeCompare(b.interviewerId))
  const attributes: string[] = []
  for (const i of [...interviews].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
    for (const a of i.attributes) if (!attributes.includes(a)) attributes.push(a)
  }
  for (const s of cards) for (const a of Object.keys(s.ratings)) if (!attributes.includes(a)) attributes.push(a)
  const interviewById = new Map(interviews.map((i) => [i.id, i]))
  const columns: DebriefColumn[] = cards.map((s) => {
    const i = interviewById.get(s.interviewId) as Interview
    return {
      scorecardId: s.id,
      interviewerId: s.interviewerId,
      interviewerName: personNameById(db, s.interviewerId),
      interviewId: i.id,
      interviewName: i.name,
      submitted: !!s.submittedAt,
      ...(s.overall ? { overall: s.overall } : {}),
      ...(s.enteredById ? { enteredById: s.enteredById } : {}),
    }
  })
  const grid = attributes.map((attribute) => ({
    attribute,
    cells: cards.map((s) => {
      const i = interviewById.get(s.interviewId) as Interview
      const asked = i.attributes.includes(attribute) || s.ratings[attribute] != null
      const rating = s.submittedAt ? s.ratings[attribute] : undefined
      return { scorecardId: s.id, ...(rating ? { rating } : {}), missing: asked && rating == null, notAsked: !asked }
    }),
  }))
  const missing = cards
    .filter((s) => !s.submittedAt)
    .map((s) => ({ interviewerId: s.interviewerId, name: personNameById(db, s.interviewerId), scorecardId: s.id }))
  return {
    attributes,
    columns,
    grid,
    missing,
    overall: cards.map((s) => ({ scorecardId: s.id, ...(s.submittedAt && s.overall ? { rating: s.overall } : {}), missing: !s.submittedAt || !s.overall })),
    allIn: cards.length > 0 && missing.length === 0,
  }
}
