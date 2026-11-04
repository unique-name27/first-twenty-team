// The simulator's actions: each runs inside a run as the store's mutate would, checks its args, refuses the
// way the app refuses (the DB stays as it was) and adds one trace line with the ids it created.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { blankDB } from '@/data/blank'
import { setClockOverride } from '@/lib/dates'
import { withRunContext } from '@/lib/runContext'
import { ACTIONS, type ActionContext, ActionRefused, applyAction, type SimState, traceToJsonLines } from './actions'

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

afterEach(() => {
  setClockOverride(null)
  vi.restoreAllMocks()
})

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

  it("tells the app's refusals (ActionRefused, with the app's words) from a crash or args that do not fit", () => {
    const sim = fresh()
    const jobId = inRun(() => postedJob(sim))
    const before = sim.db
    const thrown = (fn: () => unknown): unknown => {
      try {
        fn()
      } catch (e) {
        return e
      }
      throw new Error('expected a throw')
    }
    inRun(() => {
      const refusal = thrown(() => applyAction(sim, 'markPosted', { jobId: 'j-missing' }, ADMIN))
      expect(refusal).toBeInstanceOf(ActionRefused)
      expect((refusal as ActionRefused).reason).toBe('Job not found.')
      vi.spyOn(ACTIONS.setJobStatus, 'run').mockImplementationOnce(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'status')")
      })
      const crash = thrown(() => applyAction(sim, 'setJobStatus', { jobId, status: 'on_hold' }, ADMIN))
      expect(crash).not.toBeInstanceOf(ActionRefused)
      expect((crash as Error).message).toBe("setJobStatus on 2026-03-09 10:30 failed: TypeError: Cannot read properties of undefined (reading 'status')")
      expect(thrown(() => applyAction(sim, 'markPosted', {} as never, ADMIN))).not.toBeInstanceOf(ActionRefused)
    })
    expect(sim.db).toBe(before)
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

  it('rejects as the reject flow does: a reason chip closes the application, then Mark told records the note', () => {
    const sim = fresh()
    const told = (appId: string) => sim.db.activity.filter((a) => a.entityId === appId && ['rejected', 'withdrawn', 'notified'].includes(a.kind)).map((a) => a.text)
    inRun(() => {
      const jobId = postedJob(sim)
      const ids = ['noor', 'remy', 'ines'].map(
        (first) => applyAction(sim, 'addCandidate', { candidate: { ...NOOR, firstName: first[0].toUpperCase() + first.slice(1), email: `${first}@example.com` }, jobId }, ADMIN).applicationId as string,
      )
      applyAction(sim, 'rejectApplication', { applicationId: ids[0], reason: 'skills_gap', notified: true }, ADMIN)
      applyAction(sim, 'rejectApplication', { applicationId: ids[1], reason: 'withdrew', withdraw: true, notified: true }, ADMIN)
      applyAction(sim, 'rejectApplication', { applicationId: ids[2], reason: 'timing' }, ADMIN)
      expect(told(ids[0])).toEqual(['Rejected Noor Lindqvist (skills gap)', 'Notified Noor Lindqvist'])
      expect(told(ids[1])).toEqual(['Remy Lindqvist withdrew', 'Notified Remy Lindqvist'])
      expect(told(ids[2])).toEqual(['Rejected Ines Lindqvist (timing)'])
      expect(sim.db.applications.filter((a) => ids.includes(a.id)).map((a) => [a.status, a.notifiedOn ?? null])).toEqual([
        ['rejected', '2026-03-09'],
        ['withdrawn', '2026-03-09'],
        ['rejected', null],
      ])
    })
  })

  it('keeps a source detail for an agency only, as Quick add does', () => {
    const sim = fresh()
    inRun(() => {
      const jobId = postedJob(sim)
      expect(() => applyAction(sim, 'addCandidate', { candidate: { ...NOOR, sourceDetail: 'A job board' }, jobId }, ADMIN)).toThrow(/the args do not fit \(candidate\.sourceDetail: /)
      const { candidateId } = applyAction(sim, 'addCandidate', { candidate: { ...NOOR, source: 'agency', sourceDetail: ' Lanternfish Talent ' }, jobId }, ADMIN)
      expect(sim.db.candidates.find((c) => c.id === candidateId)).toMatchObject({ source: 'agency', sourceDetail: 'Lanternfish Talent' })
    })
  })

  it("takes a job's FLSA status from its band, as New job does: no job screen has an FLSA field", () => {
    const sim = fresh()
    inRun(() => {
      expect(() => applyAction(sim, 'createJob', { templateId: 'rt-ops-people', hiringManagerId: 'p-founder', flsa: 'non_exempt' } as never, ADMIN)).toThrow(/the args do not fit/)
      const band = sim.db.bands.find((b) => b.familyId === 'f-ops' && b.levelId === 'lv-l1')
      if (!band) throw new Error('The defaults have an Operations L1 band.')
      const before = applyAction(sim, 'createJob', { templateId: 'rt-ops-people', hiringManagerId: 'p-founder', familyId: 'f-ops', levelId: 'lv-l1' }, ADMIN)
      const { min, mid, max, equityMinPct, equityMaxPct } = band
      applyAction(sim, 'saveBand', { familyId: 'f-ops', levelId: 'lv-l1', min, mid, max, equityMinPct, equityMaxPct, flsaDefault: 'non_exempt' }, ADMIN)
      const planSlotId = applyAction(sim, 'addPlanLine', { title: 'Office coordinator', departmentId: 'd-ops', familyId: 'f-ops', levelId: 'lv-l1', targetStart: '2026-05-04' }, ADMIN)
      const after = applyAction(sim, 'createJob', { templateId: 'rt-ops-people', hiringManagerId: 'p-founder', planSlotId }, ADMIN)
      expect([before, after].map((id) => sim.db.jobs.find((j) => j.id === id)?.flsa)).toEqual(['exempt', 'non_exempt'])
    })
  })

  it('hands off what a leaver holds to their manager, as the Offboard wizard does by default', () => {
    const sim = fresh()
    inRun(() => {
      const jobId = postedJob(sim)
      const appId = applyAction(sim, 'addCandidate', { candidate: NOOR, jobId }, ADMIN).applicationId as string
      applyAction(sim, 'moveApplication', { applicationId: appId, toStageId: 'offer' }, ADMIN)
      const offerId = applyAction(sim, 'createOffer', { applicationId: appId, edits: { startDate: '2026-03-23' } }, ADMIN)
      applyAction(sim, 'markSent', { offerId }, ADMIN)
      applyAction(sim, 'markAccepted', { offerId }, ADMIN)
      const personId = applyAction(sim, 'hireFromOffer', { offerId }, ADMIN)
      const later = { ...ADMIN, day: '2026-04-06' }
      // The new engineer hires for the next role, then resigns with the job still open.
      const second = applyAction(sim, 'createJob', { templateId: 'rt-fullstack', hiringManagerId: personId, title: 'Second engineer' }, later)
      applyAction(sim, 'offboardPerson', { personId, type: 'resigned_notice', reason: 'New job', lastDay: '2026-04-17', noticeGivenOn: '2026-04-06', rehireEligible: true }, later)
      const leaver = sim.db.people.find((p) => p.id === personId)
      expect(leaver?.separation?.handoffs).toEqual([{ kind: 'job', id: second, toId: 'p-founder' }])
      const tasks = sim.db.checklists.find((c) => c.personId === personId && c.kind === 'offboarding')?.tasks ?? []
      expect(tasks.find((t) => t.templateTaskId === 'off-handoff-roles')).toMatchObject({ dueOn: '2026-04-17', status: 'open' })
    })
  })

  it('requests time off as the sheet sends it: Admin approves their own on save unless they switch it off', () => {
    const sim = fresh()
    const days = { personId: 'p-founder', policyId: 'pol-vacation', startDate: '2026-03-16', endDate: '2026-03-17' }
    inRun(() => {
      const own = applyAction(sim, 'requestTimeOff', days, ADMIN)
      expect(sim.db.timeOffRequests.find((r) => r.id === own)).toMatchObject({ status: 'approved', approverId: 'p-founder', decidedOn: '2026-03-09' })
      const later = applyAction(sim, 'requestTimeOff', { ...days, startDate: '2026-03-23', endDate: '2026-03-23', approveNow: false }, ADMIN)
      expect(sim.db.timeOffRequests.find((r) => r.id === later)?.status).toBe('pending')
      applyAction(sim, 'approveTimeOff', { requestId: later }, { ...ADMIN, day: '2026-03-10' })
      expect(sim.db.timeOffRequests.find((r) => r.id === later)).toMatchObject({ status: 'approved', decidedOn: '2026-03-10' })
      expect(() => applyAction(sim, 'approveTimeOff', { requestId: later }, ADMIN)).toThrow('is not waiting for a decision')
      // Only Admin records time off for someone else, and only on days with work.
      expect(() => applyAction(sim, 'requestTimeOff', days, { ...ADMIN, actorId: 'p-someone', viewingAs: 'employee' })).toThrow('Only Admin records time off for someone else.')
      expect(() => applyAction(sim, 'requestTimeOff', { ...days, startDate: '2026-03-14', endDate: '2026-03-15' }, ADMIN)).toThrow('Pick dates with at least one workday.')
    })
  })

  it('opens a job from a plan line, puts the hiring manager on its panel and posts it', () => {
    const sim = fresh()
    inRun(() => {
      const planSlotId = applyAction(sim, 'addPlanLine', { title: 'Founding engineer', departmentId: 'd-eng', familyId: 'f-eng', levelId: 'lv-l4', targetStart: '2026-05-04' }, ADMIN)
      const jobId = applyAction(sim, 'openJobFromPlan', { planSlotId, hiringManagerId: 'p-founder' }, ADMIN)
      const draft = sim.db.jobs.find((j) => j.id === jobId)
      expect(draft).toMatchObject({ status: 'draft', planSlotId, panelIds: [] })
      const interviewers = Object.fromEntries((draft?.interviewPlan ?? []).map((s) => [s.id, ['p-founder']]))
      applyAction(sim, 'editJob', { jobId, panelIds: ['p-founder'], interviewers }, ADMIN)
      expect(() => applyAction(sim, 'editJob', { jobId, panelIds: ['p-founder'] }, ADMIN)).toThrow('No changes to save.')
      applyAction(sim, 'markPosted', { jobId }, ADMIN)
    })
    const job = sim.db.jobs[0]
    expect(job).toMatchObject({ status: 'open', panelIds: ['p-founder'] })
    expect(job.interviewPlan.every((s) => s.interviewerIds.join() === 'p-founder')).toBe(true)
    expect(sim.db.plan[0]).toMatchObject({ status: 'open', jobId: job.id })
  })

  it("changes a job's status as its status menu does, and Mark posted resumes a job on hold", () => {
    const sim = fresh()
    const jobId = inRun(() => postedJob(sim))
    inRun(() => applyAction(sim, 'setJobStatus', { jobId, status: 'on_hold' }, ADMIN))
    expect(sim.db.jobs.find((j) => j.id === jobId)?.status).toBe('on_hold')
    expect(() => inRun(() => applyAction(sim, 'setJobStatus', { jobId, status: 'on_hold' }, ADMIN))).toThrow(`The job ${jobId} is missing or already on hold.`)
    inRun(() => applyAction(sim, 'markPosted', { jobId }, ADMIN))
    inRun(() => applyAction(sim, 'setJobStatus', { jobId, status: 'closed' }, ADMIN))
    expect(sim.db.jobs.find((j) => j.id === jobId)).toMatchObject({ status: 'closed', closedOn: ADMIN.day })
  })

  it('applies only the inbox ops an admin clears with one button, refusing as the inbox does', () => {
    const sim = fresh()
    inRun(() => {
      expect(() => applyAction(sim, 'inboxOp', { op: { type: 'backup_downloaded' } } as never, ADMIN)).toThrow('inboxOp on 2026-03-09: the args do not fit')
      expect(() => applyAction(sim, 'inboxOp', { op: { type: 'add_holidays', year: 2026 } }, ADMIN)).toThrow('The 2026 holidays are already listed.')
    })
    expect(sim.trace).toEqual([])
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
