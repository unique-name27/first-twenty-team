import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import { interviewCancelMessage } from '@/domain/hiring/messages'
import { fixtureDB } from '@/domain/hiring/testkit'
import { interviewCancelICS, scheduleInterview, type ScheduleInput } from '@/domain/hiring/scheduling'
import { defaultLogStep, latestStartedTime, logPastInterview, pastDayPresets, pastStart, pastTimes, scheduledForStep } from './pastInterview'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

const SAT = '2026-10-10'

function input(startsAt: string): ScheduleInput {
  return { applicationId: 'a-chen', stageId: 'new', name: 'Phone screen', startsAt, durationMin: 30, interviewerIds: ['p-tomas'], format: 'phone', attributes: ['Communication'] }
}

describe('past interview choices', () => {
  it('offers Today, Yesterday and the four days before, weekends included', () => {
    const days = pastDayPresets(SAT)
    expect(days.map((d) => d.date)).toEqual(['2026-10-10', '2026-10-09', '2026-10-08', '2026-10-07', '2026-10-06', '2026-10-05'])
    expect(days.slice(0, 3).map((d) => d.label)).toEqual(['Today', 'Yesterday', 'Thu, Oct 8'])
  })

  it('keeps the picked day, even on a weekend (no snapping to Monday)', () => {
    expect(pastStart(SAT, 9)).toBe('2026-10-10T16:00:00.000Z') // 9:00 AM PDT on Saturday
    expect(pastTimes()[0].label).toBe('7:00 AM')
  })

  it('finds the latest hour that has started', () => {
    expect(latestStartedTime(SAT, '2026-10-10T07:06:00.000Z')).toBe(-1) // 12:06 AM PT: nothing yet today
    expect(latestStartedTime(SAT, '2026-10-10T17:30:00.000Z')).toBe(3) // 10:30 AM PT: 10:00 AM
    expect(latestStartedTime('2026-10-09', '2026-10-10T07:06:00.000Z')).toBe(pastTimes().length - 1)
  })
})

describe('logPastInterview', () => {
  it('records the interview as completed with a scorecard due a full window from now', () => {
    const db = fixtureDB()
    const now = '2026-10-10T07:06:00.000Z'
    let id = ''
    const next = produce(db, (d) => {
      id = logPastInterview(d, input(pastStart('2026-10-08', 14)), { date: SAT, now })
    })
    const iv = next.interviews.find((i) => i.id === id)
    expect(iv?.status).toBe('completed')
    expect(iv?.startsAt).toBe('2026-10-08T21:00:00.000Z')
    const cards = next.scorecards.filter((s) => s.interviewId === id)
    expect(cards).toHaveLength(1)
    expect(cards[0].interviewerId).toBe('p-tomas')
    expect(cards[0].dueAt).toBe('2026-10-11T07:06:00.000Z')
    const app = next.applications.find((a) => a.id === 'a-chen')
    expect(app?.nextStep?.text).toBe('Debrief and decide')
    expect(app?.nextStep?.dueOn).toBe(SAT)
    const rows = next.activity.filter((a) => a.entityId === 'a-chen')
    expect(rows.map((a) => a.kind)).toEqual(['interview_completed'])
    expect(rows[0].text).toMatch(/^Logged the phone screen with Chen Wu, held Thu, Oct 8, 2:00 PM PT/)
  })

  it('keeps the normal due time (24 hours after the end) when logged during the call', () => {
    const db = fixtureDB()
    const now = '2026-10-09T21:10:00.000Z'
    let id = ''
    const next = produce(db, (d) => {
      id = logPastInterview(d, input('2026-10-09T21:00:00.000Z'), { date: '2026-10-09', now })
    })
    expect(next.scorecards.find((s) => s.interviewId === id)?.dueAt).toBe('2026-10-10T21:30:00.000Z')
  })

  it('refuses a time that has not happened yet', () => {
    const db = fixtureDB()
    expect(() => produce(db, (d) => void logPastInterview(d, input('2026-10-12T17:00:00.000Z'), { date: SAT, now: '2026-10-10T17:00:00.000Z' }))).toThrow(/has not happened yet/)
  })
})

describe('logging a step that is already on the calendar', () => {
  const SUN = '2026-10-11'
  /** Ben's intro call booked for Mon Oct 12, 10:00 AM PT with Tomas and Priya. */
  function booked() {
    let bookedId = ''
    const db = produce(fixtureDB(), (d) => {
      const intro = d.jobs[0].interviewPlan.find((s) => s.stageId === 'intro')!
      bookedId = scheduleInterview(
        d,
        { applicationId: 'a-ben', stepId: intro.id, stageId: 'intro', name: intro.name, startsAt: '2026-10-12T17:00:00.000Z', durationMin: 30, interviewerIds: ['p-tomas', 'p-priya'], format: 'video', attributes: ['Communication'] },
        { date: '2026-10-09' },
      )
    })
    return { db, bookedId, intro: db.jobs[0].interviewPlan.find((s) => s.stageId === 'intro')! }
  }

  it('starts "Already happened" on the booked step, not the next one', () => {
    const { db, bookedId, intro } = booked()
    const app = db.applications.find((a) => a.id === 'a-ben')!
    expect(defaultLogStep(db.jobs[0], app, db.interviews)?.id).toBe(intro.id)
    expect(scheduledForStep(db.interviews, 'a-ben', intro.id)?.id).toBe(bookedId)
    expect(scheduledForStep(db.interviews, 'a-ben', 'nope')).toBeUndefined()
    expect(scheduledForStep(db.interviews, 'a-alex', intro.id)).toBeUndefined()
    // With nothing booked it is the next step to schedule, as before.
    const fresh = fixtureDB()
    expect(defaultLogStep(fresh.jobs[0], fresh.applications.find((a) => a.id === 'a-ben')!, fresh.interviews)?.stageId).toBe('intro')
  })

  it('moves the booked interview to the time it was held, with one set of owed scorecards', () => {
    const { db, bookedId, intro } = booked()
    const now = '2026-10-11T17:30:00.000Z' // Sun 10:30 AM PT
    let id = ''
    const next = produce(db, (d) => {
      id = logPastInterview(
        d,
        { applicationId: 'a-ben', stepId: intro.id, stageId: 'intro', name: intro.name, startsAt: pastStart(SUN, 9), durationMin: 30, interviewerIds: ['p-tomas', 'p-priya'], format: 'video', attributes: ['Communication'] },
        { date: SUN, now, replacesId: bookedId },
      )
    })
    expect(next.interviews.find((i) => i.id === bookedId)?.status).toBe('cancelled')
    const held = next.interviews.find((i) => i.id === id)
    expect(held).toMatchObject({ status: 'completed', startsAt: '2026-10-11T16:00:00.000Z', stepId: intro.id })
    // Nothing for this step is left on the calendar, and only the held interview owes scorecards.
    expect(next.interviews.filter((i) => i.applicationId === 'a-ben' && i.status === 'scheduled')).toEqual([])
    const owed = next.scorecards.filter((s) => s.applicationId === 'a-ben' && !s.submittedAt)
    expect(owed.map((s) => [s.interviewId, s.interviewerId])).toEqual([
      [id, 'p-tomas'],
      [id, 'p-priya'],
    ])
    const rows = next.activity.filter((a) => a.entityId === 'a-ben').slice(-1)
    expect(rows[0]).toMatchObject({ kind: 'interview_completed' })
    expect(rows[0].text).toBe(`Logged the ${intro.name.toLowerCase()} with Ben Ortiz, held Sun, Oct 11, 9:00 AM PT (it was on the calendar for Mon, Oct 12, 10:00 AM PT)`)
    // The old time keeps its own cancellation file and a note that does not promise a new time.
    expect(interviewCancelICS(next, bookedId, 'candidate')).toContain('METHOD:CANCEL')
    const note = interviewCancelMessage(next, bookedId, { senderId: 'p-tomas', heldAt: held!.startsAt })
    expect(note?.body).toContain('Since we already had it, the invite for Mon, Oct 12, 10:00 AM PT is no longer needed')
    expect(note?.body).not.toContain('new time')
  })

  it('adds a new interview when nothing was booked for the step', () => {
    const { db, bookedId, intro } = booked()
    const tech = db.jobs[0].interviewPlan.find((s) => s.stageId === 'technical')!
    const next = produce(db, (d) => {
      logPastInterview(
        d,
        { applicationId: 'a-ben', stepId: tech.id, stageId: 'technical', name: tech.name, startsAt: pastStart(SUN, 9), durationMin: 60, interviewerIds: ['p-tomas'], format: 'video', attributes: [] },
        { date: SUN, now: '2026-10-11T17:30:00.000Z' },
      )
    })
    expect(next.interviews.find((i) => i.id === bookedId)?.status).toBe('scheduled')
    expect(scheduledForStep(next.interviews, 'a-ben', intro.id)?.id).toBe(bookedId)
  })
})
