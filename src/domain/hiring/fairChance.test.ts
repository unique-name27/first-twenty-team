import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import type { BackgroundCheck, DB, Offer } from '@/domain/types'
import { decideFairChance, recordBackgroundResult, startBackgroundCheck, updateFairChance } from './backgroundChecks'
import {
  canRecordCriminalHistory,
  canStartBackgroundCheck,
  CREDIT_CHECK_BASES,
  creditCheckAllowed,
  creditCheckNoticeTask,
  criminalHistoryLockReason,
  earliestFinalNoticeOn,
  fairChanceSteps,
  preliminaryNoticeReceivedOn,
  preliminaryNoticeWarnings,
  responseDueOn,
} from './fairChance'
import { createOffer, markAccepted, markSent, offerDefaults } from './offers'
import { fixtureDB, FRI } from './testkit'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

describe('gating (hard stop 2)', () => {
  it('locks checks and criminal history until a conditional offer exists', () => {
    expect(canStartBackgroundCheck({})).toBe(false)
    expect(canRecordCriminalHistory({})).toBe(false)
    expect(canStartBackgroundCheck(undefined)).toBe(false)
    expect(criminalHistoryLockReason({})).toContain('Fair Chance Act, Gov Code 12952')
    expect(canStartBackgroundCheck({ conditionalOfferOn: '2026-10-07' })).toBe(true)
    expect(canRecordCriminalHistory({ conditionalOfferOn: '2026-10-07' })).toBe(true)
    expect(criminalHistoryLockReason({ conditionalOfferOn: '2026-10-07' })).toBeNull()
  })
})

describe('Fair Chance steps', () => {
  const bg: BackgroundCheck = {
    status: 'complete',
    result: 'consider',
    completedOn: '2026-10-05',
    fairChance: { assessmentOn: '2026-10-06', preliminaryNoticeOn: '2026-10-07' },
  }

  it('computes a 5 business day response window and the earliest final notice', () => {
    expect(responseDueOn(bg)).toBe('2026-10-14')
    expect(earliestFinalNoticeOn(bg)).toBe('2026-10-15')
    const steps = fairChanceSteps(bg)
    expect(steps.map((s) => s.key)).toEqual(['assessment', 'preliminary_notice', 'response_window', 'final_notice', 'decision'])
    expect(steps[0]).toMatchObject({ done: true, doneOn: '2026-10-06', dueOn: '2026-10-07', statutory: false })
    expect(steps[1]).toMatchObject({ done: true, doneOn: '2026-10-07', dueOn: '2026-10-08' })
    expect(steps[2]).toMatchObject({ title: 'Response window (5 business days)', dueOn: '2026-10-14', statutory: true, done: false })
    expect(steps[3]).toMatchObject({ notBefore: '2026-10-15', done: false })
    expect(steps[2].citation.label).toBe('Gov Code 12952')
  })

  it('adds 5 more business days when the candidate disputes, and skips holidays', () => {
    const disputed = { ...bg, fairChance: { ...bg.fairChance, disputed: true } }
    expect(responseDueOn(disputed)).toBe('2026-10-21')
    expect(fairChanceSteps(disputed)[2].title).toBe('Response window (disputed: 10 business days)')
    const thanksgiving = { ...bg, fairChance: { preliminaryNoticeOn: '2026-11-23' } }
    expect(responseDueOn(thanksgiving, [{ date: '2026-11-26' }, { date: '2026-11-27' }])).toBe('2026-12-02')
  })

  it('starts the window 5 calendar days after a mailed notice', () => {
    const mailed: BackgroundCheck = { ...bg, fairChance: { ...bg.fairChance, preliminaryNoticeMethod: 'mail' } }
    // Mailed Wed Oct 7, treated as received Mon Oct 12, so the response is due Mon Oct 19.
    expect(preliminaryNoticeReceivedOn(mailed)).toBe('2026-10-12')
    expect(responseDueOn(mailed)).toBe('2026-10-19')
    expect(earliestFinalNoticeOn(mailed)).toBe('2026-10-20')
    expect(preliminaryNoticeReceivedOn({ fairChance: { ...bg.fairChance, preliminaryNoticeMethod: 'email' } })).toBe('2026-10-07')
  })

  it('warns when the preliminary notice comes before the assessment or the result', () => {
    expect(preliminaryNoticeWarnings(bg)).toEqual([])
    expect(preliminaryNoticeWarnings({ completedOn: '2026-10-05', fairChance: { preliminaryNoticeOn: '2026-10-06' } })).toEqual([
      'Record the individualized assessment. The law requires it before the preliminary notice.',
    ])
    expect(preliminaryNoticeWarnings({ completedOn: '2026-10-05', fairChance: { assessmentOn: '2026-10-08', preliminaryNoticeOn: '2026-10-04' } })).toEqual([
      'The preliminary notice is dated before the individualized assessment. The assessment has to come first.',
      'The preliminary notice is dated before the background check result came back. Check the dates.',
    ])
  })

  it('has no steps for a clear result or no check', () => {
    expect(fairChanceSteps({ status: 'complete', result: 'clear' })).toEqual([])
    expect(fairChanceSteps(undefined)).toEqual([])
    expect(fairChanceSteps({ status: 'complete', result: 'consider', completedOn: '2026-10-05' })[0]).toMatchObject({ done: false, dueOn: '2026-10-07' })
  })
})

describe('credit checks', () => {
  it('lists the Labor Code 1024.5 bases including the GLBA exception', () => {
    const ids = CREDIT_CHECK_BASES.map((b) => b.id)
    expect(ids).toEqual(expect.arrayContaining(['managerial', 'signatory_money', 'account_and_identity_access', 'trade_secrets', 'cash_10k', 'required_by_law', 'law_enforcement', 'doj', 'glba']))
    expect(creditCheckAllowed({ creditCheckBasis: null })).toBe(false)
    expect(creditCheckAllowed({ creditCheckBasis: 'made_up' })).toBe(false)
    expect(creditCheckAllowed({ creditCheckBasis: 'signatory_money' })).toBe(true)
  })

  it('creates the Civil Code 1785.20.5 notice task text, labeled as needing review', () => {
    const task = creditCheckNoticeTask({ title: 'Accounting lead (CPA)', creditCheckBasis: 'signatory_money' })
    expect(task.citation.label).toBe('Civil Code 1785.20.5')
    expect(task.title).toBe('Send the written credit check notice before ordering a report (Accounting lead (CPA))')
    expect(task.why).toContain('Signs on company accounts or moves money')
    expect(task.why).toContain('free copy')
    expect(task).toMatchObject({ needsReview: true, reviewNote: 'Not verified here; confirm with counsel.' })
    expect(creditCheckNoticeTask({ title: 'Accounting lead (CPA)', creditCheckBasis: 'signatory_money' }, 'Alex Kim').title).toBe(
      'Send Alex Kim the written credit check notice before ordering a credit report (Accounting lead (CPA))',
    )
  })
})

describe('background check mutations', () => {
  function sentOffer(): DB {
    return produce(fixtureDB(), (d) => {
      createOffer(d, { ...(offerDefaults(d as DB, 'a-alex', FRI) as Offer), id: 'o-1', draftedByRole: 'admin' })
      markSent(d, 'o-1', { date: FRI })
    })
  }

  it('refuses to start a check or record a result before acceptance', () => {
    produce(sentOffer(), (d) => {
      const r = startBackgroundCheck(d, 'o-1', { date: FRI })
      expect(r.ok).toBe(false)
      expect(recordBackgroundResult(d, 'o-1', 'consider', { date: FRI }).ok).toBe(false)
      expect(d.offers[0].backgroundCheck).toBeUndefined()
    })
  })

  it('runs the Fair Chance process after acceptance and rescinds only after the final notice', () => {
    const db = produce(sentOffer(), (d) => {
      markAccepted(d, 'o-1', { date: '2026-10-12' })
      expect(startBackgroundCheck(d, 'o-1', { date: '2026-10-12', provider: 'Checkr' }).ok).toBe(true)
      expect(recordBackgroundResult(d, 'o-1', 'consider', { date: '2026-10-15' }).ok).toBe(true)
      expect(updateFairChance(d, 'o-1', { assessmentOn: '2026-10-16', assessmentNote: 'Offense unrelated to duties? Reviewing.' }, { date: '2026-10-16' }).ok).toBe(true)
      expect(updateFairChance(d, 'o-1', { preliminaryNoticeOn: '2026-10-19' }, { date: '2026-10-19' }).ok).toBe(true)
      expect(d.offers[0].backgroundCheck?.fairChance?.responseDueOn).toBe('2026-10-26')
      const early = updateFairChance(d, 'o-1', { finalNoticeOn: '2026-10-26' }, { date: '2026-10-26' })
      expect(early).toEqual({ ok: false, reason: 'The final notice can go out only after the response window closes on Mon Oct 26.' })
      expect(decideFairChance(d, 'o-1', 'rescind', { date: '2026-10-26' }).ok).toBe(false)
      expect(updateFairChance(d, 'o-1', { finalNoticeOn: '2026-10-27' }, { date: '2026-10-27' }).ok).toBe(true)
      expect(decideFairChance(d, 'o-1', 'rescind', { date: '2026-10-27', reason: 'Role handles customer funds' }).ok).toBe(true)
    })
    const offer = db.offers[0]
    expect(offer.backgroundCheck).toMatchObject({ status: 'complete', result: 'consider', provider: 'Checkr', consentSentOn: '2026-10-12' })
    expect(offer.backgroundCheck?.fairChance?.decision).toBe('rescind')
    expect(offer.status).toBe('rescinded')
    expect(db.applications.find((a) => a.id === 'a-alex')).toMatchObject({ status: 'rejected', outcomeNote: 'Role handles customer funds' })
    expect(db.grants[0].status).toBe('cancelled')
  })

  it('creates the credit check notice for this candidate when the check starts on a credit-check job', () => {
    const db = produce(sentOffer(), (d) => {
      d.jobs[0].creditCheckBasis = 'account_and_identity_access'
      markAccepted(d, 'o-1', { date: '2026-10-12' })
      const r = startBackgroundCheck(d, 'o-1', { date: '2026-10-12' })
      expect(r.ok && r.creditNotice?.recurringId).toBe('rc-credit-notice-o-1')
      // Starting again returns the same item instead of adding another.
      expect(startBackgroundCheck(d, 'o-1', { date: '2026-10-13' }).ok).toBe(true)
    })
    const items = db.recurring.filter((r) => r.ruleId === 'credit-check-notice')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'rc-credit-notice-o-1', cadence: 'once', nextDueOn: '2026-10-12' })
    expect(items[0].title).toBe('Send Alex Kim the written credit check notice before ordering a credit report (Senior full-stack engineer)')
    expect(items[0].notes).toContain('Not verified here; confirm with counsel.')
    // No credit check basis, no notice.
    const plain = produce(sentOffer(), (d) => {
      markAccepted(d, 'o-1', { date: '2026-10-12' })
      const r = startBackgroundCheck(d, 'o-1', { date: '2026-10-12' })
      expect(r.ok && r.creditNotice).toBeUndefined()
    })
    expect(plain.recurring.some((r) => r.ruleId === 'credit-check-notice')).toBe(false)
  })

  it('saves a preliminary notice dated before the assessment, with a warning, and logs a proceed reason', () => {
    const db = produce(sentOffer(), (d) => {
      markAccepted(d, 'o-1', { date: '2026-10-12' })
      recordBackgroundResult(d, 'o-1', 'consider', { date: '2026-10-15' })
      const r = updateFairChance(d, 'o-1', { preliminaryNoticeOn: '2026-10-16', preliminaryNoticeMethod: 'mail' }, { date: '2026-10-16' })
      expect(r).toEqual({ ok: true, warnings: ['Record the individualized assessment. The law requires it before the preliminary notice.'] })
      expect(d.offers[0].backgroundCheck?.fairChance?.responseDueOn).toBe('2026-10-28') // received Wed Oct 21
      expect(decideFairChance(d, 'o-1', 'proceed', { date: '2026-10-29', reason: 'Offense unrelated to the duties and 6 years old' }).ok).toBe(true)
    })
    expect(db.activity.at(-1)?.text).toBe('Confirmed the offer for Alex Kim after the Fair Chance review: Offense unrelated to the duties and 6 years old')
  })

  it('extends the window on dispute and can confirm the offer', () => {
    const db = produce(sentOffer(), (d) => {
      markAccepted(d, 'o-1', { date: '2026-10-12' })
      recordBackgroundResult(d, 'o-1', 'consider', { date: '2026-10-15' })
      updateFairChance(d, 'o-1', { preliminaryNoticeOn: '2026-10-19' }, { date: '2026-10-19' })
      updateFairChance(d, 'o-1', { disputed: true }, { date: '2026-10-21' })
      decideFairChance(d, 'o-1', 'proceed', { date: '2026-11-03' })
    })
    expect(db.offers[0].backgroundCheck?.fairChance).toMatchObject({ disputed: true, responseDueOn: '2026-11-02', decision: 'proceed' })
    expect(db.offers[0].status).toBe('accepted')
  })
})
