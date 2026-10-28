// The simulator's actions: each runs inside a run as the store's mutate would, checks its args, refuses the
// way the app refuses (the DB stays as it was) and adds one trace line with the ids it created.
import { afterEach, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { setClockOverride } from '@/lib/dates'
import { withRunContext } from '@/lib/runContext'
import { ACTIONS, type ActionContext, applyAction, type SimState, traceToJsonLines } from './actions'

const FOUNDED = '2026-03-02'
const ADMIN: ActionContext = { day: '2026-03-09', time: '10:30', actorId: 'p-founder', viewingAs: 'admin' }

function fresh(): SimState {
  setClockOverride(FOUNDED)
  return { db: blankDB({ companyName: 'Quillpine', founderFirstName: 'Avery', founderLastName: 'Quill', founderEmail: 'avery@quillpine.example', foundedOn: FOUNDED }), trace: [] }
}

/** Runs fn in a run, as generateCompany does. */
function inRun<T>(fn: () => T): T {
  return withRunContext({ seed: 'actions test', actorId: 'p-founder', timeOfDay: '09:00' }, fn)
}

/** A posted job from the full-stack template, with the founder hiring. */
function postedJob(sim: SimState): string {
  const jobId = applyAction(sim, 'createJob', { templateId: 'rt-fullstack', hiringManagerId: 'p-founder' }, ADMIN)
  applyAction(sim, 'markPosted', { jobId }, ADMIN)
  return jobId
}

const NOOR = { firstName: 'Noor', lastName: 'Lindqvist', email: 'noor.lindqvist@example.com', location: 'Sunnyvale, CA', source: 'inbound' as const }

afterEach(() => setClockOverride(null))

describe('applyAction', () => {
  it('lists every action under its own name', () => {
    for (const [key, spec] of Object.entries(ACTIONS)) expect(spec.name).toBe(key)
  })

  it('works only inside a run, so ids and timestamps are reproducible', () => {
    const sim = fresh()
    expect(() => applyAction(sim, 'markPosted', { jobId: 'j-x' }, ADMIN)).toThrow('Simulator actions run inside a run (withRunContext)')
  })

  it('applies the action on its day, as its person, at its time, and adds one trace line with the records it created', () => {
    const sim = fresh()
    const jobId = inRun(() => postedJob(sim))
    const added = inRun(() => applyAction(sim, 'addCandidate', { candidate: NOOR, jobId }, { ...ADMIN, time: '11:15' }))
    const line = sim.trace[sim.trace.length - 1]
    expect(line).toEqual({
      day: '2026-03-09',
      time: '11:15',
      actor: 'p-founder',
      viewingAs: 'admin',
      action: 'addCandidate',
      args: { candidate: NOOR, jobId },
      // Activity rows are left out: nearly every action writes one.
      created: [added.candidateId, added.applicationId],
    })
    const cand = sim.db.candidates.find((c) => c.id === added.candidateId)
    // Quick add guesses the time zone from the location, as the sheet does.
    expect(cand).toMatchObject({ createdOn: '2026-03-09', timezone: 'America/Los_Angeles', source: 'inbound' })
    const rows = sim.db.activity.filter((a) => a.entityId === added.candidateId || a.entityId === added.applicationId)
    expect(rows.map((a) => [a.at, a.actorId, a.viewingAs])).toEqual([
      ['2026-03-09T18:15:00.000Z', 'p-founder', 'admin'],
      ['2026-03-09T18:15:00.000Z', 'p-founder', 'admin'],
    ])
    expect(sim.trace.map((t) => t.action)).toEqual(['createJob', 'markPosted', 'addCandidate'])
  })

  it('refuses args that do not fit, naming the action and the field', () => {
    const sim = fresh()
    inRun(() => {
      expect(() => applyAction(sim, 'markPosted', {} as never, ADMIN)).toThrow(/^markPosted on 2026-03-09: the args do not fit \(jobId: /)
      expect(() => applyAction(sim, 'addCandidate', { candidate: { ...NOOR, email: 'noor at example' } }, ADMIN)).toThrow(/candidate\.email/)
      expect(() => applyAction(sim, 'markPosted', { jobId: 'j-x', extra: 1 } as never, ADMIN)).toThrow(/the args do not fit/)
    })
    expect(sim.trace).toEqual([])
  })

  it("throws the app's own refusal and leaves the DB and the trace as they were", () => {
    const sim = fresh()
    const jobId = inRun(() => postedJob(sim))
    const { db, trace } = { db: sim.db, trace: [...sim.trace] }
    inRun(() => {
      expect(() => applyAction(sim, 'markPosted', { jobId: 'j-missing' }, ADMIN)).toThrow('markPosted on 2026-03-09 10:30 was refused: Job not found.')
      const { applicationId } = applyAction(sim, 'addCandidate', { candidate: NOOR, jobId }, ADMIN)
      const before = sim.db
      // Hired is the Hire flow's: moving there by hand is refused (moveApplication returns false).
      expect(() => applyAction(sim, 'moveApplication', { applicationId: applicationId as string, toStageId: 'hired' }, ADMIN)).toThrow(/was refused: Could not move/)
      expect(sim.db).toBe(before)
    })
    expect(sim.trace.slice(0, trace.length)).toEqual(trace)
    expect(sim.trace).toHaveLength(trace.length + 1)
    expect(db.jobs).toEqual(sim.db.jobs)
  })

  it('lets opening the app on a day nothing is due change nothing, with no trace line', () => {
    const sim = fresh()
    const before = sim.db
    inRun(() => {
      applyAction(sim, 'openApp', {}, ADMIN)
      expect(sim.db).toBe(before)
      expect(sim.trace).toEqual([])
      applyAction(sim, 'saveDepartment', { id: 'd-cs', name: 'Customer success' }, ADMIN)
      // A name another department has is refused, as the sheet refuses it.
      expect(() => applyAction(sim, 'saveDepartment', { id: 'd-cs2', name: 'customer success' }, ADMIN)).toThrow('A department with that name already exists.')
    })
    expect(sim.trace.map((t) => [t.action, t.created])).toEqual([['saveDepartment', ['d-cs']]])
  })

  it('records an offer drafted as a manager as needing approval, and an approval by the person acting', () => {
    const sim = fresh()
    inRun(() => {
      const jobId = postedJob(sim)
      const { applicationId } = applyAction(sim, 'addCandidate', { candidate: NOOR, jobId }, ADMIN)
      const appId = applicationId as string
      applyAction(sim, 'moveApplication', { applicationId: appId, toStageId: 'offer' }, ADMIN)
      const offerId = applyAction(sim, 'createOffer', { applicationId: appId }, { ...ADMIN, viewingAs: 'manager' })
      expect(sim.db.offers.find((o) => o.id === offerId)).toMatchObject({ draftedById: 'p-founder', draftedByRole: 'manager', status: 'draft', createdOn: '2026-03-09' })
      expect(() => applyAction(sim, 'markSent', { offerId }, ADMIN)).toThrow('This offer needs Admin approval before it goes out.')
      applyAction(sim, 'submitForApproval', { offerId }, { ...ADMIN, viewingAs: 'manager' })
      applyAction(sim, 'approveOffer', { offerId }, { ...ADMIN, day: '2026-03-10', time: '09:30' })
      expect(sim.db.offers.find((o) => o.id === offerId)?.approvals).toEqual([{ approverId: 'p-founder', decision: 'approved', at: '2026-03-10T16:30:00.000Z' }])
    })
  })

  it('never counts the records a list rewrite keeps as created', () => {
    const sim = fresh()
    inRun(() => {
      const jobId = postedJob(sim)
      const { applicationId } = applyAction(sim, 'addCandidate', { candidate: NOOR, jobId }, ADMIN)
      const appId = applicationId as string
      applyAction(sim, 'moveApplication', { applicationId: appId, toStageId: 'intro' }, ADMIN)
      const step = sim.db.jobs[0].interviewPlan[0]
      applyAction(
        sim,
        'scheduleInterview',
        { applicationId: appId, stepId: step.id, stageId: 'intro', name: step.name, startsAt: '2026-03-11T17:00:00.000Z', durationMin: 30, interviewerIds: ['p-founder'], format: 'video', attributes: ['Ownership'] },
        ADMIN,
      )
      expect(sim.db.scorecards).toHaveLength(1)
      // Rejecting cancels the interview and drops its owed scorecard: the scorecard list is written anew.
      applyAction(sim, 'rejectApplication', { applicationId: appId, reason: 'skills_gap', notified: true }, ADMIN)
    })
    expect(sim.db.scorecards).toEqual([])
    expect(sim.trace[sim.trace.length - 1]).toMatchObject({ action: 'rejectApplication', created: [] })
    expect(sim.db.applications[0]).toMatchObject({ status: 'rejected', notifiedOn: '2026-03-09' })
  })

  it('writes the trace as JSON lines, one action a line', () => {
    const sim = fresh()
    inRun(() => postedJob(sim))
    const text = traceToJsonLines(sim.trace)
    expect(text.endsWith('\n')).toBe(true)
    expect(text.trim().split('\n').map((l) => JSON.parse(l))).toEqual(sim.trace)
    expect(traceToJsonLines([])).toBe('')
  })
})
