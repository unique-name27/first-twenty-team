import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import type { DB, Job, Offer } from '@/domain/types'
import { hiringMetrics, rate, reachedKinds } from './metrics'
import { createOffer, expireOffers, markAccepted, markSent, offerDefaults } from './offers'
import { withdrawApplication } from './pipeline'
import { application, candidate, fixtureDB } from './testkit'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

describe('rate', () => {
  it('shows counts for small n and a percentage from 5 up', () => {
    expect(rate(2, 3)).toEqual({ n: 2, d: 3, pct: 2 / 3, small: true, text: '2 of 3 (small n)' })
    expect(rate(4, 4).text).toBe('4 of 4 (small n)')
    expect(rate(4, 6)).toMatchObject({ small: false, text: '67%' })
    expect(rate(5, 5).text).toBe('100%')
    expect(rate(0, 0)).toEqual({ n: 0, d: 0, pct: null, small: true, text: 'None yet' })
  })
})

/** Fixture plus a closed job with history, offers and an archived funnel. */
function history(): DB {
  return produce(fixtureDB(), (d) => {
    const base = d.jobs[0]
    const closed: Job = { ...base, id: 'j-data', title: 'Data engineer (ERP connectors)', status: 'filled', openedOn: '2026-04-01', closedOn: '2026-06-15', archivedFunnel: { applied: 100, intro: 12, technical: 6, onsite: 3, offers: 1, accepted: 1 } }
    d.jobs.push(closed)
    d.candidates.push(
      candidate('c-hire', 'Omar', 'Hadd', { source: 'referral', referrerId: 'p-priya' }),
      candidate('c-lost', 'Lena', 'Ray', { source: 'outbound' }),
      candidate('c-early', 'Ray', 'Soto', { source: 'inbound' }),
    )
    d.applications.push(
      application('a-hire', 'c-hire', 'j-data', {
        appliedOn: '2026-04-06',
        stageId: 'hired',
        status: 'hired',
        stageEnteredOn: '2026-05-20',
        history: [
          { stageId: 'new', at: '2026-04-06' },
          { stageId: 'intro', at: '2026-04-08' },
          { stageId: 'technical', at: '2026-04-15' },
          { stageId: 'onsite', at: '2026-04-27' },
          { stageId: 'offer', at: '2026-05-01' },
          { stageId: 'hired', at: '2026-05-20' },
        ],
        conditionalOfferOn: '2026-05-08',
      }),
      application('a-lost', 'c-lost', 'j-data', {
        appliedOn: '2026-04-10',
        stageId: 'offer',
        status: 'withdrawn',
        outcomeReason: 'chose_other_offer',
        history: [
          { stageId: 'new', at: '2026-04-10' },
          { stageId: 'onsite', at: '2026-04-29' },
          { stageId: 'offer', at: '2026-05-04' },
        ],
      }),
      application('a-early', 'c-early', 'j-data', { appliedOn: '2026-04-12', status: 'rejected', outcomeReason: 'skills_gap' }),
    )
    d.offers.push(
      { id: 'o-hire', applicationId: 'a-hire', jobId: 'j-data', candidateId: 'c-hire', status: 'accepted', decidedOn: '2026-05-08', version: 1 } as Offer,
      { id: 'o-lost', applicationId: 'a-lost', jobId: 'j-data', candidateId: 'c-lost', status: 'declined', decidedOn: '2026-05-11', declineReason: 'chose_other_offer', version: 1 } as Offer,
    )
  })
}

describe('hiringMetrics', () => {
  it('builds a funnel by stage kind with drillable ids and archived counts', () => {
    const m = hiringMetrics(history(), { from: '2026-01-01', to: '2026-12-31' })
    expect(m.applications.count).toBe(6)
    const funnel = Object.fromEntries(m.funnel.map((r) => [r.kind, [r.count, r.archived, r.total]]))
    expect(funnel).toEqual({
      new: [6, 100, 106],
      intro: [4, 12, 16], // a-alex, a-ben, a-hire, a-lost (an offer implies the earlier stages)
      technical: [3, 6, 9],
      onsite: [3, 3, 6],
      offer: [2, 1, 3],
      hired: [1, 1, 2],
    })
    expect(m.funnel.find((r) => r.kind === 'offer')?.applicationIds.sort()).toEqual(['a-hire', 'a-lost'])
    expect(m.conversions[0]).toMatchObject({ from: 'new', to: 'intro' })
    expect(m.conversions[0].rate.text).toBe('15%')
    expect(m.conversions.at(-1)?.rate.text).toBe('2 of 3 (small n)')
  })

  it('reports time to accept, sources, offer acceptance and reasons', () => {
    const m = hiringMetrics(history(), { from: '2026-01-01', to: '2026-12-31' })
    expect(m.medianDaysToAccept).toEqual({ days: 32, n: 1, applicationIds: ['a-hire'] })
    const referral = m.sources.find((s) => s.source === 'referral')!
    expect(referral).toMatchObject({ applications: 2, hires: 1, applicationIds: ['a-ben', 'a-hire'], hireIds: ['a-hire'] })
    expect(referral.hireRate.text).toBe('1 of 2 (small n)')
    expect(m.offerAcceptance).toMatchObject({ accepted: 2, decided: 3, acceptedOfferIds: ['o-hire'], decidedOfferIds: ['o-hire', 'o-lost'], archivedAccepted: 1, archivedDecided: 1 })
    expect(m.offerAcceptance.rate.text).toBe('2 of 3 (small n)')
    expect(m.declineReasons).toEqual([{ reason: 'Chose another offer', count: 1, offerIds: ['o-lost'], applicationIds: ['a-lost'] }])
    expect(m.outcomeReasons.map((r) => [r.label, r.count])).toEqual([
      ['Chose another offer', 1],
      ['Skills gap', 1],
    ])
    const data = m.byJob.find((j) => j.jobId === 'j-data')!
    expect(data).toMatchObject({ applications: 3, hires: 1, hireIds: ['a-hire'] })
    expect(data.funnel[0].total).toBe(103)
  })

  it('filters by date range and job, and can leave archived counts out', () => {
    const db = history()
    const recent = hiringMetrics(db, { from: '2026-09-01', to: '2026-10-31' })
    expect(recent.applications.count).toBe(3)
    expect(recent.funnel[0]).toMatchObject({ count: 3, archived: 0 })
    expect(recent.offerAcceptance.rate.text).toBe('None yet')
    const onlyData = hiringMetrics(db, { from: '2026-01-01', to: '2026-12-31', jobIds: ['j-data'], includeArchived: false })
    expect(onlyData.applications.applicationIds.sort()).toEqual(['a-early', 'a-hire', 'a-lost'])
    expect(onlyData.funnel.every((r) => r.archived === 0)).toBe(true)
    expect(onlyData.offerAcceptance).toMatchObject({ accepted: 1, decided: 2 })
  })

  it('treats an accepted offer as reaching every earlier stage', () => {
    const db = history()
    const job = db.jobs.find((j) => j.id === 'j-data') as Job
    const lost = db.applications.find((a) => a.id === 'a-lost')!
    expect([...reachedKinds(db, job, lost)].sort()).toEqual(['intro', 'new', 'offer', 'onsite', 'technical'])
  })
})

describe('offer acceptance with lapsed offers', () => {
  it('counts an expired offer as decided on its expiry date', () => {
    const db = produce(fixtureDB(), (d) => {
      createOffer(d, { ...(offerDefaults(d as DB, 'a-alex', '2026-09-21') as Offer), id: 'o-alex', draftedByRole: 'admin' })
      createOffer(d, { ...(offerDefaults(d as DB, 'a-ben', '2026-09-21') as Offer), id: 'o-ben', draftedByRole: 'admin' })
      markSent(d, 'o-alex', { date: '2026-09-21' })
      markSent(d, 'o-ben', { date: '2026-09-21' })
      markAccepted(d, 'o-alex', { date: '2026-09-24' })
      expireOffers(d, '2026-10-01') // Ben's offer lapsed on Mon Sep 28
    })
    expect(db.offers.find((o) => o.id === 'o-ben')).toMatchObject({ status: 'expired', decidedOn: '2026-09-28' })
    const m = hiringMetrics(db, { from: '2026-09-01', to: '2026-10-31' })
    expect(m.offerAcceptance).toMatchObject({ accepted: 1, decided: 2, decidedOfferIds: ['o-alex', 'o-ben'] })
    expect(m.offerAcceptance.rate.text).toBe('1 of 2 (small n)')
  })

  it('counts a withdrawal with a sent offer as a decline with its reason', () => {
    const db = produce(fixtureDB(), (d) => {
      createOffer(d, { ...(offerDefaults(d as DB, 'a-alex', '2026-09-21') as Offer), id: 'o-alex', draftedByRole: 'admin' })
      markSent(d, 'o-alex', { date: '2026-09-21' })
      withdrawApplication(d, 'a-alex', 'chose_other_offer', { date: '2026-09-23' })
    })
    const m = hiringMetrics(db, { from: '2026-09-01', to: '2026-10-31' })
    expect(m.offerAcceptance).toMatchObject({ accepted: 0, decided: 1 })
    expect(m.declineReasons).toEqual([{ reason: 'Chose another offer', count: 1, offerIds: ['o-alex'], applicationIds: ['a-alex'] }])
  })
})

describe('cross-job conversions', () => {
  it('compares only jobs that have both stages, so a stage some jobs skip never tops 100%', () => {
    const db = produce(fixtureDB(), (d) => {
      const base = d.jobs[0]
      const stages = [
        base.stages[0],
        { id: 'screen', name: 'Recruiter screen', kind: 'recruiter_screen' as const, slaBusinessDays: 3 },
        ...base.stages.slice(1),
      ]
      d.jobs.push({ ...base, id: 'j-ae', title: 'Founding account executive', stages })
      d.candidates.push(candidate('c-dana', 'Dana', 'Lee'), candidate('c-eli', 'Eli', 'Moss'))
      d.applications.push(
        application('a-dana', 'c-dana', 'j-ae', { stageId: 'screen', stageEnteredOn: '2026-09-25' }),
        application('a-eli', 'c-eli', 'j-ae', { stageId: 'new' }),
      )
    })
    const m = hiringMetrics(db, { from: '2026-09-01', to: '2026-10-31' })
    const conv = (from: string, to: string) => m.conversions.find((c) => c.from === from && c.to === to)!
    // Full-stack: alex (onsite), ben (intro), chen (new). AE: dana (screen), eli (new).
    expect(m.funnel.find((r) => r.kind === 'recruiter_screen')?.count).toBe(1)
    expect(m.funnel.find((r) => r.kind === 'intro')?.count).toBe(2)
    expect(conv('new', 'recruiter_screen')).toMatchObject({ baseIds: ['a-dana', 'a-eli'], applicationIds: ['a-dana'], jobIds: ['j-ae'] })
    expect(conv('new', 'recruiter_screen').rate.text).toBe('1 of 2 (small n)')
    // Only the AE job has both a screen and an intro stage, and nobody there reached the intro yet.
    expect(conv('recruiter_screen', 'intro').rate.text).toBe('0 of 1 (small n)')
    for (const c of m.conversions) expect(c.rate.n).toBeLessThanOrEqual(c.rate.d)
    expect(conv('intro', 'technical').rate.text).toBe('1 of 2 (small n)')
  })
})
