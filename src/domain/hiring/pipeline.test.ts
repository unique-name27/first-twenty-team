import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import type { DB, Job } from '@/domain/types'
import {
  advanceApplication,
  advanceNeedsHire,
  attentionReasons,
  backScheduleLine,
  businessDaysInStage,
  daysOpen,
  defaultNextStep,
  furthestStageIndex,
  isTerminal,
  jobStages,
  markNotified,
  miniFunnel,
  moveApplication,
  nextStage,
  ownerFor,
  pipelineCounts,
  prevStage,
  quickLog,
  rejectApplication,
  setNextStep,
  slaDetail,
  slaState,
  snoozeApplication,
  stageKind,
  stuckCount,
  withdrawApplication,
} from './pipeline'
import { scheduleInterview } from './scheduling'
import { application, candidate, fixtureDB, FRI } from './testkit'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

function job(db: DB, id = 'j-fullstack'): Job {
  return db.jobs.find((j) => j.id === id) as Job
}

describe('stages', () => {
  it('walks the default pipeline', () => {
    const db = fixtureDB()
    const j = job(db)
    expect(jobStages(j).map((s) => s.id)).toEqual(['new', 'intro', 'technical', 'onsite', 'offer', 'hired'])
    expect(nextStage(j, 'intro')?.id).toBe('technical')
    expect(prevStage(j, 'intro')?.id).toBe('new')
    expect(prevStage(j, 'new')).toBeUndefined()
    expect(nextStage(j, 'hired')).toBeUndefined()
    expect(isTerminal(j, 'hired')).toBe(true)
    expect(isTerminal(j, 'offer')).toBe(false)
    expect(stageKind(j, 'onsite')).toBe('onsite')
    expect(jobStages({ stages: [] }).length).toBe(6)
  })

  it('finds the furthest stage from history', () => {
    const j = job(fixtureDB())
    expect(furthestStageIndex(j, { stageId: 'intro', history: [{ stageId: 'new', at: FRI }, { stageId: 'onsite', at: FRI }, { stageId: 'intro', at: FRI }] })).toBe(3)
  })
})

describe('SLA', () => {
  const db = fixtureDB()
  const j = job(db)
  const app = application('a-x', 'c-chen', 'j-fullstack', { stageId: 'new', stageEnteredOn: '2026-10-09' })

  it('counts business days in stage across a weekend', () => {
    expect(businessDaysInStage(app, '2026-10-10')).toBe(0)
    expect(businessDaysInStage(app, '2026-10-11')).toBe(0)
    expect(businessDaysInStage(app, '2026-10-12')).toBe(1)
  })

  it('moves from ok to due soon to over against the New SLA of 3 business days', () => {
    expect(slaState(j, app, '2026-10-10')).toBe('ok') // Sat
    expect(slaState(j, app, '2026-10-12')).toBe('ok') // 1 day
    expect(slaState(j, app, '2026-10-13')).toBe('due_soon') // 2 days
    expect(slaState(j, app, '2026-10-14')).toBe('due_soon') // 3 days
    expect(slaState(j, app, '2026-10-15')).toBe('over') // 4 days
    expect(slaDetail(j, app, '2026-10-15')).toMatchObject({ state: 'over', days: 4, sla: 3, dueOn: '2026-10-14' })
  })

  it('does not count holidays', () => {
    const h = [{ date: '2026-10-12' }]
    expect(slaState(j, app, '2026-10-13', h)).toBe('ok')
    expect(slaState(j, app, '2026-10-15', h)).toBe('due_soon')
    expect(slaState(j, app, '2026-10-16', h)).toBe('over')
  })

  it('measures the Offer stage against the offer expiry', () => {
    const inOffer = { ...app, stageId: 'offer' }
    const offer = { status: 'sent', expiresOn: '2026-10-14' } as DB['offers'][number]
    expect(slaState(j, inOffer, '2026-10-09', [], offer)).toBe('ok')
    expect(slaState(j, inOffer, '2026-10-13', [], offer)).toBe('due_soon')
    expect(slaState(j, inOffer, '2026-10-14', [], offer)).toBe('due_soon')
    expect(slaState(j, inOffer, '2026-10-15', [], offer)).toBe('over')
    expect(slaState(j, inOffer, '2026-10-30')).toBe('ok') // no offer out, no SLA
  })

  it('is ok for closed applications', () => {
    expect(slaState(j, { ...app, status: 'rejected' }, '2026-11-30')).toBe('ok')
  })
})

describe('attention reasons', () => {
  it('flags no next step, overdue step, past SLA and waiting too long', () => {
    const db = produce(fixtureDB(), (d) => {
      d.applications.push(
        application('a-none', 'c-chen', 'j-fullstack', { stageId: 'intro', stageEnteredOn: '2026-10-08', nextStep: undefined }),
        application('a-late', 'c-chen', 'j-fullstack', {
          stageId: 'intro',
          stageEnteredOn: '2026-09-28',
          nextStep: { text: 'Schedule intro call', dueOn: '2026-10-01', ownerId: 'p-tomas' },
        }),
      )
    })
    const none = db.applications.find((a) => a.id === 'a-none')!
    expect(attentionReasons(db, none, FRI)).toEqual(['no_next_step'])
    const late = db.applications.find((a) => a.id === 'a-late')!
    expect(attentionReasons(db, late, FRI)).toEqual(['next_step_overdue', 'past_sla', 'waiting_too_long'])
  })

  it('stays quiet while snoozed and when contact is recent or an interview is ahead', () => {
    const base = produce(fixtureDB(), (d) => {
      d.applications.push(application('a-late', 'c-chen', 'j-fullstack', { stageId: 'intro', stageEnteredOn: '2026-09-28', nextStep: { text: 'x', dueOn: '2026-10-30', ownerId: 'p-tomas' } }))
    })
    const late = base.applications.find((a) => a.id === 'a-late')!
    expect(attentionReasons(base, late, FRI)).toEqual(['past_sla', 'waiting_too_long'])
    expect(attentionReasons(base, { ...late, snoozedUntil: '2026-10-12' }, FRI)).toEqual([])
    expect(attentionReasons(base, { ...late, snoozedUntil: FRI }, FRI)).toEqual(['past_sla', 'waiting_too_long'])
    expect(attentionReasons(base, { ...late, lastContactOn: '2026-10-07' }, FRI)).toEqual(['past_sla'])
    expect(attentionReasons(base, { ...late, conditionalOfferOn: '2026-09-29' }, FRI)).toEqual(['past_sla'])
    const withInterview = produce(base, (d) => {
      scheduleInterview(
        d,
        { applicationId: 'a-late', stageId: 'technical', name: 'Technical', startsAt: '2026-10-14T17:00:00.000Z', durationMin: 60, interviewerIds: ['p-tomas'], format: 'video', attributes: [] },
        { date: '2026-10-01' },
      )
    })
    const again = withInterview.applications.find((a) => a.id === 'a-late')!
    expect(attentionReasons(withInterview, again, FRI)).toEqual(['past_sla'])
  })
})

describe('next steps and moves', () => {
  it('sets stage-aware default next steps', () => {
    const db = fixtureDB()
    const j = job(db)
    expect(defaultNextStep(db, j, 'new', FRI)).toEqual({ text: 'Review application', dueOn: '2026-10-14', ownerId: 'p-tomas' })
    expect(defaultNextStep(db, j, 'intro', FRI, 'p-founder')).toEqual({ text: 'Schedule intro call', dueOn: '2026-10-13', ownerId: 'p-founder' })
    expect(defaultNextStep(db, j, 'technical', FRI)?.text).toBe('Schedule technical')
    expect(defaultNextStep(db, j, 'onsite', FRI)?.text).toBe('Schedule onsite')
    expect(defaultNextStep(db, j, 'offer', FRI)?.text).toBe('Send offer')
    expect(defaultNextStep(db, j, 'hired', FRI)).toBeUndefined()
    const ae = { ...j, stages: j.stages.map((s) => (s.id === 'technical' ? { ...s, name: 'Mock discovery call' } : s)) }
    expect(defaultNextStep(db, ae, 'technical', FRI)?.text).toBe('Schedule mock discovery call')
    // Thanksgiving week: Wed Nov 25, Mon Nov 30, Tue Dec 1.
    expect(defaultNextStep(db, j, 'new', '2026-11-24')?.dueOn).toBe('2026-12-01')
  })

  it('moves an application with history, a fresh stage clock, a new next step and activity', () => {
    const db = produce(fixtureDB(), (d) => {
      d.applications[2].snoozedUntil = '2026-10-20'
      expect(moveApplication(d, 'a-chen', 'onsite', { date: FRI, actorId: 'p-tomas' })).toBe(true)
      expect(moveApplication(d, 'a-chen', 'onsite', { date: FRI })).toBe(false)
      expect(moveApplication(d, 'a-chen', 'nope', { date: FRI })).toBe(false)
    })
    const app = db.applications.find((a) => a.id === 'a-chen')!
    expect(app.stageId).toBe('onsite')
    expect(app.stageEnteredOn).toBe(FRI)
    expect(app.history.at(-1)).toEqual({ stageId: 'onsite', at: FRI, byId: 'p-tomas' })
    expect(app.nextStep).toEqual({ text: 'Schedule onsite', dueOn: '2026-10-13', ownerId: 'p-tomas' })
    expect(app.snoozedUntil).toBeUndefined()
    expect(db.activity.at(-1)).toMatchObject({ entityType: 'application', entityId: 'a-chen', relatedId: 'c-chen', kind: 'stage_moved', text: 'Moved Chen Wu to Onsite' })
  })

  it('advances to the next stage but leaves Hired to the Hire flow', () => {
    const db = produce(fixtureDB(), (d) => {
      expect(advanceApplication(d, 'a-ben', { date: FRI })).toBe(true)
      expect(moveApplication(d, 'a-alex', 'offer', { date: FRI })).toBe(true)
      // Advance (A in Sweep) from Offer would land in Hired: refused, the UI opens the Hire flow.
      expect(advanceNeedsHire(d.jobs[0], 'offer')).toBe(true)
      expect(advanceApplication(d, 'a-alex', { date: FRI })).toBe(false)
      expect(moveApplication(d, 'a-alex', 'hired', { date: FRI })).toBe(false)
    })
    expect(db.applications.find((a) => a.id === 'a-ben')?.stageId).toBe('technical')
    const alex = db.applications.find((a) => a.id === 'a-alex')!
    expect(alex).toMatchObject({ stageId: 'offer', status: 'active' })
    expect(alex.nextStep?.text).toBe('Send offer')
    // Only the Hire flow passes viaHire.
    const hired = produce(db, (d) => {
      expect(moveApplication(d, 'a-alex', 'hired', { date: FRI, viaHire: true })).toBe(true)
    })
    const h = hired.applications.find((a) => a.id === 'a-alex')!
    expect(h.status).toBe('hired')
    expect(h.nextStep).toBeUndefined()
  })

  it('never moves a hired application out of Hired', () => {
    const db = produce(fixtureDB(), (d) => {
      const alex = d.applications[0]
      alex.status = 'hired'
      alex.stageId = 'hired'
      expect(moveApplication(d, 'a-alex', 'onsite', { date: FRI })).toBe(false)
      expect(advanceApplication(d, 'a-alex', { date: FRI })).toBe(false)
    })
    expect(db.applications[0]).toMatchObject({ status: 'hired', stageId: 'hired' })
    expect(db.activity).toHaveLength(0)
  })

  it('never hands a next step to someone who has left', () => {
    const db = produce(fixtureDB(), (d) => {
      const tomas = d.people.find((p) => p.id === 'p-tomas')!
      tomas.endDate = '2026-10-02'
    })
    const j = job(db)
    expect(ownerFor(db, j, FRI)).toBe('p-founder')
    expect(ownerFor(db, j, '2026-09-30')).toBe('p-tomas')
    expect(ownerFor(db, j, FRI, 'p-priya')).toBe('p-priya')
    expect(ownerFor(db, j, FRI, 'p-tomas')).toBe('p-founder')
    expect(defaultNextStep(db, j, 'intro', FRI)?.ownerId).toBe('p-founder')
    const moved = produce(db, (d) => {
      moveApplication(d, 'a-chen', 'intro', { date: FRI }) // current owner p-tomas has left
    })
    expect(moved.applications.find((a) => a.id === 'a-chen')?.nextStep?.ownerId).toBe('p-founder')
  })

  it('rejects with a reason, notifies, cancels future interviews and open offers, and keeps the record 4 years', () => {
    const base = produce(fixtureDB(), (d) => {
      scheduleInterview(
        d,
        { applicationId: 'a-alex', stageId: 'onsite', name: 'Onsite', startsAt: '2026-10-13T17:00:00.000Z', durationMin: 60, interviewerIds: ['p-tomas'], format: 'onsite', attributes: [] },
        { date: FRI },
      )
      d.offers.push({ id: 'o-1', applicationId: 'a-alex', status: 'sent', version: 1, candidateId: 'c-alex', jobId: 'j-fullstack' } as DB['offers'][number])
      d.grants.push({ id: 'g-1', personId: 'c-alex', holderType: 'candidate', type: 'ISO', shares: 1000, strikePrice: 1.15, vestingStart: '2026-11-02', cliffMonths: 12, vestingMonths: 48, status: 'reserved', exercisedShares: 0, postTerminationExerciseDays: 90, fromOfferId: 'o-1' })
    })
    const db = produce(base, (d) => {
      expect(rejectApplication(d, 'a-alex', 'skills_gap', { date: FRI, note: 'System design gaps', notified: true })).toBe(true)
    })
    const app = db.applications.find((a) => a.id === 'a-alex')!
    expect(app).toMatchObject({ status: 'rejected', outcomeReason: 'skills_gap', outcomeNote: 'System design gaps', closedOn: FRI, notifiedOn: FRI, lastContactOn: FRI })
    expect(app.nextStep).toBeUndefined()
    expect(db.interviews.every((i) => i.status === 'cancelled')).toBe(true)
    expect(db.scorecards).toHaveLength(0)
    expect(db.offers[0]).toMatchObject({ status: 'rescinded', decidedOn: FRI })
    expect(db.offers[0].declineReason).toBeUndefined()
    expect(db.grants[0]).toMatchObject({ status: 'cancelled', cancelledShares: 1000, cancelledOn: FRI })
    expect(db.candidates.find((c) => c.id === 'c-alex')?.retainUntil).toBe('2030-10-09')
    expect(db.activity.at(-1)?.text).toBe('Rejected Alex Kim (skills gap) and sent a note')
  })

  it('withdraws and can reopen by moving', () => {
    const db = produce(fixtureDB(), (d) => {
      withdrawApplication(d, 'a-ben', 'chose_other_offer', { date: FRI })
    })
    const ben = db.applications.find((a) => a.id === 'a-ben')!
    expect(ben).toMatchObject({ status: 'withdrawn', outcomeReason: 'chose_other_offer' })
    expect(db.activity.at(-1)?.text).toBe('Ben Ortiz withdrew (chose another offer)')
    const reopened = produce(db, (d) => {
      moveApplication(d, 'a-ben', 'intro', { date: '2026-10-12' })
    })
    const again = reopened.applications.find((a) => a.id === 'a-ben')!
    expect(again.status).toBe('active')
    expect(again.outcomeReason).toBeUndefined()
    expect(reopened.activity.at(-1)?.text).toBe('Reopened Ben Ortiz in Intro call')
  })

  it('quick-logs contact, snoozes, sets next steps and records notification', () => {
    const db = produce(fixtureDB(), (d) => {
      quickLog(d, 'a-ben', 'emailed', { date: '2026-10-06' })
      quickLog(d, 'a-ben', 'voicemail', { date: '2026-10-07' })
      quickLog(d, 'a-ben', 'called', { date: '2026-10-08' })
      snoozeApplication(d, 'a-ben', '2026-10-12')
      setNextStep(d, 'a-ben', { text: 'Send take-home', dueOn: '2026-10-14', ownerId: 'p-priya' })
      markNotified(d, 'a-chen', { date: FRI })
    })
    const ben = db.applications.find((a) => a.id === 'a-ben')!
    expect(ben.lastContactOn).toBe('2026-10-08')
    expect(ben.snoozedUntil).toBe('2026-10-12')
    expect(ben.nextStep).toEqual({ text: 'Send take-home', dueOn: '2026-10-14', ownerId: 'p-priya' })
    expect(db.activity.map((a) => a.text)).toEqual([
      'Emailed Ben Ortiz',
      'Left Ben Ortiz a voicemail',
      'Called Ben Ortiz',
      'Snoozed Ben Ortiz until Mon Oct 12',
      'Next step for Ben Ortiz: Send take-home, due Wed Oct 14',
      'Notified Chen Wu',
    ])
    expect(db.applications.find((a) => a.id === 'a-chen')?.notifiedOn).toBe(FRI)
  })
})

describe('closing out with offers and interviews in play', () => {
  function withSentOffer(status: DB['offers'][number]['status'] = 'sent', extra: Partial<DB['offers'][number]> = {}): DB {
    return produce(fixtureDB(), (d) => {
      d.offers.push({ id: 'o-1', applicationId: 'a-alex', status, version: 1, candidateId: 'c-alex', jobId: 'j-fullstack', ...extra } as DB['offers'][number])
      d.grants.push({ id: 'g-1', personId: 'c-alex', holderType: 'candidate', type: 'ISO', shares: 1000, strikePrice: 1.15, vestingStart: '2026-11-02', cliffMonths: 12, vestingMonths: 48, status: 'reserved', exercisedShares: 0, postTerminationExerciseDays: 90, fromOfferId: 'o-1' })
      if (status === 'accepted') d.applications[0].conditionalOfferOn = '2026-10-07'
    })
  }

  it('records a withdrawal with a sent offer as the candidate declining, with the reason', () => {
    const db = produce(withSentOffer(), (d) => {
      withdrawApplication(d, 'a-alex', 'chose_other_offer', { date: FRI })
    })
    expect(db.offers[0]).toMatchObject({ status: 'declined', declineReason: 'chose_other_offer', decidedOn: FRI })
    expect(db.grants[0].status).toBe('cancelled')
    expect(db.activity.map((a) => a.text)).toEqual(['Alex Kim declined the offer (chose another offer)', 'Alex Kim withdrew (chose another offer)'])
  })

  it('handles a renege after acceptance: declined on withdrawal, rescinded on rejection, options freed', () => {
    const withdrew = produce(withSentOffer('accepted'), (d) => {
      withdrawApplication(d, 'a-alex', 'comp', { date: FRI })
    })
    expect(withdrew.offers[0]).toMatchObject({ status: 'declined', declineReason: 'comp', decidedOn: FRI })
    expect(withdrew.grants[0].status).toBe('cancelled')
    expect(withdrew.activity[0].text).toBe('Alex Kim backed out after accepting the offer (comp)')
    const rejected = produce(withSentOffer('accepted'), (d) => {
      rejectApplication(d, 'a-alex', 'other', { date: FRI })
    })
    expect(rejected.offers[0]).toMatchObject({ status: 'rescinded', decidedOn: FRI })
    expect(rejected.grants[0].status).toBe('cancelled')
    // An offer that already became a hire is left alone.
    const hired = produce(withSentOffer('accepted', { personId: 'p-alex' }), (d) => {
      withdrawApplication(d, 'a-alex', 'other', { date: FRI })
    })
    expect(hired.offers[0].status).toBe('accepted')
    expect(hired.grants[0].status).toBe('reserved')
  })

  it('rescinds an unsent draft when the candidate withdraws', () => {
    const db = produce(withSentOffer('draft'), (d) => {
      withdrawApplication(d, 'a-alex', 'timing', { date: FRI })
    })
    expect(db.offers[0].status).toBe('rescinded')
    expect(db.activity[0].text).toBe('Closed the unsent offer for Alex Kim')
  })

  it("keeps today's interview that already happened, with its scorecards", () => {
    const base = produce(fixtureDB(), (d) => {
      // Onsite this morning, 9:00 AM Pacific, and a follow-up next week.
      scheduleInterview(
        d,
        { applicationId: 'a-alex', stageId: 'onsite', name: 'Onsite', startsAt: '2026-10-09T16:00:00.000Z', durationMin: 120, interviewerIds: ['p-tomas', 'p-priya'], format: 'onsite', attributes: [] },
        { date: '2026-10-05' },
      )
      scheduleInterview(
        d,
        { applicationId: 'a-alex', stageId: 'onsite', name: 'Founder chat', startsAt: '2026-10-14T17:00:00.000Z', durationMin: 30, interviewerIds: ['p-founder'], format: 'video', attributes: [] },
        { date: '2026-10-05' },
      )
      // And one this afternoon at 4:00 PM Pacific.
      scheduleInterview(
        d,
        { applicationId: 'a-alex', stageId: 'onsite', name: 'Values chat', startsAt: '2026-10-09T23:00:00.000Z', durationMin: 30, interviewerIds: ['p-jasmine'], format: 'video', attributes: [] },
        { date: '2026-10-05' },
      )
    })
    // Without the time of day: only later dates come off the calendar.
    const byDate = produce(base, (d) => {
      rejectApplication(d, 'a-alex', 'skills_gap', { date: FRI })
    })
    expect(byDate.interviews.map((i) => [i.name, i.status])).toEqual([
      ['Onsite', 'scheduled'],
      ['Founder chat', 'cancelled'],
      ['Values chat', 'scheduled'],
    ])
    expect(byDate.scorecards.map((s) => s.interviewerId).sort()).toEqual(['p-jasmine', 'p-priya', 'p-tomas'])
    // With the time: the afternoon interview that has not started is cancelled too.
    const byTime = produce(base, (d) => {
      rejectApplication(d, 'a-alex', 'skills_gap', { date: FRI, nowISO: '2026-10-09T20:30:00.000Z' })
    })
    expect(byTime.interviews.map((i) => i.status)).toEqual(['scheduled', 'cancelled', 'cancelled'])
    expect(byTime.scorecards.map((s) => s.interviewerId).sort()).toEqual(['p-priya', 'p-tomas'])
  })
})

describe('counts and funnels', () => {
  it('counts active applications per stage and reached-stage funnels with archived counts', () => {
    const db = produce(fixtureDB(), (d) => {
      d.candidates.push(candidate('c-dee', 'Dee', 'Park'))
      d.applications.push(application('a-dee', 'c-dee', 'j-fullstack', { stageId: 'technical', status: 'rejected' }))
    })
    const j = job(db)
    const counts = pipelineCounts(db, j)
    expect(counts.map((c) => c.count)).toEqual([1, 1, 0, 1, 0, 0])
    expect(counts.find((c) => c.stageId === 'onsite')?.applicationIds).toEqual(['a-alex'])
    const funnel = miniFunnel(db, j)
    expect(funnel.map((f) => f.count)).toEqual([4, 3, 2, 1, 0, 0])
    expect(funnel.find((f) => f.stageId === 'technical')?.applicationIds.sort()).toEqual(['a-alex', 'a-dee'])
    const closed = { ...j, archivedFunnel: { applied: 200, intro: 20, technical: 8, onsite: 3, offers: 1, accepted: 1 } }
    expect(miniFunnel(db, closed).map((f) => f.total)).toEqual([204, 23, 10, 4, 1, 1])
  })

  it('counts stuck candidates and days open', () => {
    // Alex is 4 business days into Onsite (SLA 3), Chen has sat in New since Sep 21, Ben has no next step.
    const db = produce(fixtureDB(), (d) => {
      d.applications[1].nextStep = undefined
    })
    expect(stuckCount(db, job(db), FRI)).toBe(3)
    const calm = produce(db, (d) => {
      for (const a of d.applications) {
        a.stageEnteredOn = FRI
        a.nextStep = { text: 'x', dueOn: '2026-10-20', ownerId: 'p-tomas' }
      }
      d.applications[0].nextStep = undefined
    })
    expect(stuckCount(calm, job(calm), FRI)).toBe(1)
    expect(daysOpen(job(db), FRI)).toBe(25)
    expect(daysOpen({ openedOn: '2026-09-14', closedOn: '2026-10-01' }, FRI)).toBe(17)
    expect(daysOpen({}, FRI)).toBeNull()
  })
})

describe('backScheduleLine', () => {
  it('uses sensible defaults when there is little history', () => {
    const db = produce(fixtureDB(), (d) => {
      d.jobs[0].targetStart = '2027-01-11'
    })
    const line = backScheduleLine(db, job(db), FRI)
    expect(line?.text).toBe('To start by Mon Jan 11, accept an offer by Mon Dec 7 and run onsites by Mon Nov 23.')
    expect(line?.status).toBe('on_track')
    expect(line?.basis.fromHistory).toBe(false)
  })

  it("uses the company's own medians once there are 3 data points", () => {
    const db = produce(fixtureDB(), (d) => {
      d.jobs[0].targetStart = '2027-01-11'
      const gaps: Array<[string, string]> = [
        ['2026-05-01', '2026-05-21'],
        ['2026-06-01', '2026-06-22'],
        ['2026-07-01', '2026-07-23'],
      ]
      gaps.forEach(([decided, start], i) => {
        d.offers.push({ id: `o-h${i}`, applicationId: `a-h${i}`, status: 'accepted', decidedOn: decided, startDate: start } as DB['offers'][number])
      })
    })
    const line = backScheduleLine(db, job(db), FRI)
    expect(line?.basis.acceptToStartDays).toBe(21)
    expect(line?.text).toBe('To start by Mon Jan 11, accept an offer by Mon Dec 21 and run onsites by Mon Dec 7.')
  })

  it('says when the plan is tight or at risk, and skips jobs without a target', () => {
    const db = produce(fixtureDB(), (d) => {
      d.jobs[0].targetStart = '2026-12-07'
    })
    const tight = backScheduleLine(db, job(db), '2026-10-28')
    expect(tight?.status).toBe('tight')
    expect(tight?.text).toBe('To start by Mon Dec 7, accept an offer by Mon Nov 2. Onsites should already be done (the target was Mon Oct 19).')
    const risk = backScheduleLine(db, job(db), '2026-11-10')
    expect(risk?.status).toBe('at_risk')
    expect(risk?.text).toContain('A Mon Dec 7 start is at risk')
    expect(backScheduleLine(fixtureDB(), job(fixtureDB()), FRI)).toBeNull()
  })
})
