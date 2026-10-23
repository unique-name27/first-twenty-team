import { describe, expect, it } from 'vitest'
import type { BackgroundCheck, CompRecord, Offer, Person } from '@/domain/types'
import {
  approvalLine,
  backgroundStep,
  bandMeterFigures,
  bandMeterGeometry,
  bandWords,
  checkCleared,
  contingenciesCleared,
  declineReasonChoices,
  dropOfferDraft,
  expiryPresets,
  extendOptions,
  groupOffers,
  hasKeptOfferDraft,
  keepOfferDraft,
  keptOfferDraft,
  latestPerApplication,
  offerActionPlan,
  offerDisplayStatus,
  offerStatusLabel,
  otherOffersText,
  postedRangeAnnual,
  peerBases,
  rescindReasonText,
  restoreOfferDraft,
  rulesAtThreshold,
  startDatePresets,
  trimPeriod,
} from './logic'

const band = { min: 225_000, mid: 255_000, max: 285_000 }

describe('band meter', () => {
  it('pads the band so nearby outliers still fit, and clamps the rest', () => {
    const g = bandMeterGeometry(band)
    expect(g.at(band.min)).toBeCloseTo(0.12 / 1.24, 5)
    expect(g.at(band.max)).toBeCloseTo(1.12 / 1.24, 5)
    expect(g.at(100_000)).toBe(0)
    expect(g.clipped(100_000)).toBe(true)
    expect(g.at(400_000)).toBe(1)
    expect(g.clipped(260_000)).toBe(false)
  })

  it('widens the scale to fit the posted range too', () => {
    const g = bandMeterGeometry(band, [200_000, 280_000])
    expect(g.clipped(200_000)).toBe(false)
    expect(g.at(200_000)).toBeGreaterThan(0)
    expect(g.at(200_000)).toBeLessThan(g.at(band.min))
  })

  it('describes the position in plain words', () => {
    expect(bandWords(200_000, band)).toBe('Below the band')
    expect(bandWords(230_000, band)).toBe('Low in the band')
    expect(bandWords(262_000, band)).toBe('Mid band')
    expect(bandWords(280_000, band)).toBe('High in the band')
    expect(bandWords(298_000, band)).toBe('Above the band')
  })
})

describe('peers at a level', () => {
  const person = (id: string, extra: Partial<Person> = {}) =>
    ({ id, familyId: 'f-ml', levelId: 'lv-l4', startDate: '2025-01-01', endDate: null, hoursPerWeek: 40, ...extra }) as Person
  const comp = (personId: string, effectiveOn: string, salary: number, levelId = 'lv-l4'): CompRecord =>
    ({ id: `${personId}-${effectiveOn}`, personId, effectiveOn, payType: 'salary', salary, title: 't', levelId, reason: 'hire' }) as CompRecord

  it('uses the comp row in effect and skips other levels, leavers and future hires', () => {
    const people = [person('p1'), person('p2'), person('p3', { endDate: '2026-01-01' }), person('p4', { startDate: '2026-12-01' }), person('p5')]
    const rows = [
      comp('p1', '2025-01-01', 200_000),
      comp('p1', '2026-03-01', 228_000),
      comp('p2', '2025-01-01', 240_000),
      comp('p3', '2025-01-01', 250_000),
      comp('p4', '2026-12-01', 260_000),
      comp('p5', '2025-01-01', 190_000, 'lv-l3'),
    ]
    expect(peerBases(people, rows, 'f-ml', 'lv-l4', '2026-10-09')).toEqual([228_000, 240_000])
    expect(peerBases(people, rows, 'f-ml', 'lv-l4', '2026-10-09', ['p2'])).toEqual([228_000])
  })

  it('annualizes hourly rows at the person hours', () => {
    const people = [person('p1', { hoursPerWeek: 24 })]
    const rows = [{ ...comp('p1', '2025-01-01', 0), payType: 'hourly', hourlyRate: 30, salary: undefined } as CompRecord]
    expect(peerBases(people, rows, 'f-ml', 'lv-l4', '2026-10-09')).toEqual([30 * 24 * 52])
  })
})

describe('dates', () => {
  it('offers Mondays from the default start date', () => {
    const p = startDatePresets('2026-10-26', 3)
    expect(p.map((x) => x.date)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09'])
    expect(p[0].label).toBe('Mon, Oct 26')
    expect(startDatePresets('2026-10-28', 1)[0].date).toBe('2026-11-02')
  })

  it('prefills expiry in business days, skipping holidays', () => {
    const p = expiryPresets('2026-10-09', ['2026-10-12'])
    expect(p[1]).toEqual({ label: '5 business days', date: '2026-10-19' })
    expect(expiryPresets('2026-10-09')[1].date).toBe('2026-10-16')
  })

  it('extends from the later of today and the current expiry', () => {
    expect(extendOptions('2026-10-14', '2026-10-09').map((o) => o.date)).toEqual(['2026-10-16', '2026-10-19', '2026-10-21'])
    expect(extendOptions('2026-10-01', '2026-10-09')[0].date).toBe('2026-10-13')
  })
})

describe('background checks', () => {
  const clear: BackgroundCheck = { status: 'complete', result: 'clear', completedOn: '2026-10-07' }
  const consider: BackgroundCheck = { status: 'complete', result: 'consider', completedOn: '2026-10-07', fairChance: {} }

  it('stays locked until a conditional offer exists', () => {
    expect(backgroundStep(undefined, clear)).toBe('locked')
    expect(backgroundStep('2026-10-05', undefined)).toBe('not_started')
    expect(backgroundStep('2026-10-05', { status: 'consent_sent' })).toBe('consent_sent')
    expect(backgroundStep('2026-10-05', { status: 'in_progress' })).toBe('in_progress')
    expect(backgroundStep('2026-10-05', clear)).toBe('clear')
    expect(backgroundStep('2026-10-05', consider)).toBe('consider')
  })

  it('counts Consider as cleared only after a Proceed decision', () => {
    expect(checkCleared(clear)).toBe(true)
    expect(checkCleared(consider)).toBe(false)
    expect(checkCleared({ ...consider, fairChance: { decision: 'proceed' } })).toBe(true)
    expect(checkCleared({ status: 'in_progress' })).toBe(false)
  })

  it('tells hiring managers only whether contingencies cleared', () => {
    expect(contingenciesCleared({ contingencies: ['i9', 'piia'] })).toBe(true)
    expect(contingenciesCleared({ contingencies: ['background_check', 'i9'] })).toBe(false)
    expect(contingenciesCleared({ contingencies: ['background_check'], backgroundCheck: clear })).toBe(true)
  })
})

describe('offers tab groups', () => {
  const offer = (id: string, appId: string, status: Offer['status'], extra: Partial<Offer> = {}) =>
    ({ id, applicationId: appId, version: 1, status, createdOn: '2026-10-01', expiresOn: '2026-10-20', startDate: '2026-11-02', ...extra }) as Offer

  it('keeps only the latest version per application', () => {
    const list = latestPerApplication([offer('o1', 'a1', 'declined'), offer('o2', 'a1', 'sent', { version: 2 }), offer('o3', 'a2', 'draft')])
    expect(list.map((o) => o.id).sort()).toEqual(['o2', 'o3'])
  })

  it('groups by status and counts older decided offers instead of hiding them silently', () => {
    const people = [{ id: 'p-old', startDate: '2026-03-01' }, { id: 'p-new', startDate: '2026-11-02' }]
    const { groups, earlier } = groupOffers(
      [
        offer('o1', 'a1', 'awaiting_approval'),
        offer('o2', 'a2', 'sent', { expiresOn: '2026-10-14' }),
        offer('o3', 'a3', 'sent', { expiresOn: '2026-10-12' }),
        offer('o4', 'a4', 'accepted', { personId: 'p-old', decidedOn: '2026-02-01' }),
        offer('o5', 'a5', 'accepted', { personId: 'p-new', decidedOn: '2026-10-07' }),
        offer('o6', 'a6', 'accepted', { decidedOn: '2026-10-08' }),
        offer('o7', 'a7', 'declined', { decidedOn: '2026-01-15' }),
        offer('o8', 'a8', 'declined', { decidedOn: '2026-09-30' }),
      ],
      '2026-06-11',
      people,
      '2026-09-09',
    )
    expect(groups.awaiting_approval.map((o) => o.id)).toEqual(['o1'])
    expect(groups.sent.map((o) => o.id)).toEqual(['o3', 'o2'])
    expect(groups.accepted.map((o) => o.id).sort()).toEqual(['o5', 'o6'])
    expect(groups.declined.map((o) => o.id)).toEqual(['o8'])
    expect(earlier).toBe(2)
  })

  it('files a sent offer past its expiry under Expired, and a never-sent rescind under Discarded', () => {
    const list = [
      offer('o1', 'a1', 'sent', { expiresOn: '2026-10-14', sentOn: '2026-10-07' }),
      offer('o2', 'a2', 'sent', { expiresOn: '2026-10-19', sentOn: '2026-10-12' }),
      offer('o3', 'a3', 'rescinded', { decidedOn: '2026-10-10' }),
      offer('o4', 'a4', 'rescinded', { sentOn: '2026-10-05', decidedOn: '2026-10-08' }),
    ]
    const { groups } = groupOffers(list, '2026-06-11', [], '2026-09-09', '2026-10-19')
    expect(groups.sent.map((o) => o.id)).toEqual(['o2'])
    expect(groups.expired.map((o) => o.id)).toEqual(['o1'])
    expect(groups.discarded.map((o) => o.id)).toEqual(['o3'])
    expect(groups.rescinded.map((o) => o.id)).toEqual(['o4'])
    // Without a date, status alone decides (expireOffers has not run).
    expect(groupOffers(list, '2026-06-11', []).groups.sent.map((o) => o.id).sort()).toEqual(['o1', 'o2'])
  })

  it('labels lapsed offers Expired and unsent rescinds Discarded', () => {
    expect(offerStatusLabel({ status: 'sent', expiresOn: '2026-10-14' }, '2026-10-19')).toEqual({ label: 'Expired', tone: 'neutral' })
    expect(offerStatusLabel({ status: 'sent', expiresOn: '2026-10-19' }, '2026-10-19').label).toBe('Out')
    expect(offerStatusLabel({ status: 'rescinded', expiresOn: '2026-10-19' }).label).toBe('Discarded')
    expect(offerStatusLabel({ status: 'rescinded', expiresOn: '2026-10-19', sentOn: '2026-10-12' }).label).toBe('Rescinded')
    expect(offerDisplayStatus({ status: 'draft', expiresOn: '2026-10-01' }, '2026-10-19')).toBe('draft')
  })
})

describe('copy helpers', () => {
  it('trims trailing periods so sentences end once', () => {
    expect(trimPeriod('Big-tech counteroffer.')).toBe('Big-tech counteroffer')
    expect(trimPeriod(undefined)).toBe('')
  })

  it('reads a rescind reason with one colon at most, old or new', () => {
    // The dialog joins the reason chip and the details with a period.
    expect(rescindReasonText('Offer made in error. Hours were wrong: the role is 30 hours a week.')).toBe('Offer made in error. Hours were wrong: the role is 30 hours a week')
    // Saved before that with a colon: read the same way.
    expect(rescindReasonText('Offer made in error: Hours were wrong: the role is 30 hours a week')).toBe('Offer made in error. Hours were wrong: the role is 30 hours a week')
    expect(rescindReasonText('Budget changed')).toBe('Budget changed')
    expect(rescindReasonText('Rescinded after the Fair Chance review')).toBe('Rescinded after the Fair Chance review')
  })

  it('includes a competing offer among decline reasons', () => {
    expect(declineReasonChoices().some((r) => r.label === 'Competing offer' && r.value === 'chose_other_offer')).toBe(true)
  })
})

describe('threshold preview', () => {
  it('lists the rules that switch on at 15 and none at a count with no milestone', () => {
    const at15 = rulesAtThreshold(15)
    expect(at15.length).toBeGreaterThan(0)
    expect(at15.every((r) => r.trigger.kind === 'headcount' && r.trigger.n === 15 && !r.upcoming)).toBe(true)
    expect(rulesAtThreshold(17)).toEqual([])
  })
})

describe('approval line', () => {
  const nameOf = (id: string) => (id === 'p-maya' ? 'Maya Raman' : 'Admin')
  const approved = { approverId: 'p-maya', decision: 'approved' as const, at: '2026-10-10T17:00:00.000Z' }

  it('shows the approval while it stands', () => {
    expect(approvalLine({ status: 'approved', approvals: [approved] }, true, nameOf)).toBe('Approved by Maya Raman, Sat, Oct 10')
    expect(approvalLine({ status: 'sent', approvals: [approved] }, true, nameOf)).toBe('Approved by Maya Raman, Sat, Oct 10')
  })

  it('does not show an old approval on an offer that was edited back to draft or resubmitted', () => {
    expect(approvalLine({ status: 'draft', approvals: [approved] }, true, nameOf)).toBe('Needs Admin approval (changed since the Oct 10 approval)')
    expect(approvalLine({ status: 'awaiting_approval', approvals: [approved] }, true, nameOf)).toBe('Waiting for Admin approval (changed since the Oct 10 approval)')
  })

  it('covers offers that never needed or never had an approval', () => {
    expect(approvalLine({ status: 'draft', approvals: [] }, true, nameOf)).toBe('Needs Admin approval')
    expect(approvalLine({ status: 'awaiting_approval', approvals: [] }, true, nameOf)).toBe('Waiting for Admin approval')
    expect(approvalLine({ status: 'draft', approvals: [] }, false, nameOf)).toBe('Drafted by Admin, no separate approval')
    expect(approvalLine({ status: 'sent', approvals: [] }, true, nameOf)).toBe('No approval on record')
  })

  it('names the drafter as the subtitle does, with Admin as their role (post-merge: "drafted by Rae Okafor" vs "Drafted by Admin")', () => {
    expect(approvalLine({ status: 'draft', approvals: [] }, false, nameOf, 'Rae Okafor')).toBe('Drafted by Rae Okafor as Admin, no separate approval')
    expect(approvalLine({ status: 'sent', approvals: [] }, false, nameOf, 'Rae Okafor')).toBe('Drafted by Rae Okafor as Admin, no separate approval')
  })
})

describe('offer panel actions (post-merge: Mark sent came before the letter, and the letter hid in More once sent)', () => {
  const base = { lapsed: false, needsApproval: false, isAdmin: true, hired: false, letter: true }

  it('leads with the letter when an offer is ready to go out, then Mark sent', () => {
    for (const status of ['draft', 'approved'] as const) {
      const plan = offerActionPlan({ ...base, status })
      expect(plan.lead).toBe('letter')
      expect(plan.buttons.indexOf('letter')).toBeLessThan(plan.buttons.indexOf('send'))
    }
  })

  it('keeps the letter a visible button once the offer is out', () => {
    const plan = offerActionPlan({ ...base, status: 'sent' })
    expect(plan.lead).toBe('accept')
    expect(plan.buttons).toEqual(['accept', 'decline', 'extend', 'letter'])
    expect(plan.more).not.toContain('letter')
    expect(plan.more).toEqual(['nudge', 'divider', 'rescind'])
    expect(offerActionPlan({ ...base, status: 'sent', isAdmin: false }).more).toEqual(['nudge'])
  })

  it('routes a draft that needs approval to Approve or Submit, and gives a hiring manager no letter until it is approved', () => {
    expect(offerActionPlan({ ...base, status: 'draft', needsApproval: true })).toMatchObject({ lead: 'approve', buttons: ['approve', 'edit', 'letter'] })
    expect(offerActionPlan({ ...base, status: 'draft', needsApproval: true, isAdmin: false, letter: false })).toMatchObject({ lead: 'submit', buttons: ['submit', 'edit'] })
    expect(offerActionPlan({ ...base, status: 'awaiting_approval', isAdmin: false, letter: false })).toEqual({ lead: null, buttons: ['edit'], more: [] })
  })

  it('reopens a lapsed or expired offer, and keeps the letter of an accepted one in More until the hire', () => {
    expect(offerActionPlan({ ...base, status: 'sent', lapsed: true })).toMatchObject({ lead: 'reopen', buttons: ['reopen', 'decline'], more: ['letter', 'divider', 'rescind'] })
    expect(offerActionPlan({ ...base, status: 'expired' })).toMatchObject({ lead: 'reopen', buttons: ['reopen', 'decline'] })
    expect(offerActionPlan({ ...base, status: 'accepted' }).more).toEqual(['backed-out', 'letter'])
    expect(offerActionPlan({ ...base, status: 'accepted', hired: true })).toEqual({ lead: null, buttons: [], more: [] })
  })
})

describe('hire preview wording', () => {
  it('says still out only for a sent offer, and names drafts, approvals and accepted offers for what they are', () => {
    expect(otherOffersText([])).toBeNull()
    expect(otherOffersText([{ status: 'sent' }])).toBe('Keeps the job open, because another offer on it is still out.')
    expect(otherOffersText([{ status: 'draft' }])).toBe('Keeps the job open, because another offer on it is in draft.')
    expect(otherOffersText([{ status: 'approved' }])).toBe('Keeps the job open, because another offer on it is in draft.')
    expect(otherOffersText([{ status: 'awaiting_approval' }])).toBe('Keeps the job open, because another offer on it is waiting for approval.')
    expect(otherOffersText([{ status: 'accepted' }])).toBe('Keeps the job open, because another offer on it is accepted and not hired yet.')
    expect(otherOffersText([{ status: 'sent' }, { status: 'draft' }])).toBe('Keeps the job open, because other offers on it are still out or in draft.')
  })
})

describe('posted range for the band meter', () => {
  it('annualizes an hourly posted range and skips a job without one', () => {
    expect(postedRangeAnnual({ payMin: 175_000, payMax: 215_000 })).toEqual({ min: 175_000, max: 215_000 })
    expect(postedRangeAnnual({ payMin: 20, payMax: 25 })).toEqual({ min: 41_600, max: 52_000 })
    expect(postedRangeAnnual({ payMin: null, payMax: 25 })).toBeNull()
    expect(postedRangeAnnual(undefined)).toBeNull()
  })
})

describe('band meter figures in the offer terms', () => {
  const l1 = { min: 60_000, mid: 70_000, max: 80_000 }

  it('reads a salary in annual base, with an hourly posted range at 2,080 hours', () => {
    expect(bandMeterFigures({ payType: 'salary', salary: 72_000 }, l1, { payMin: 24, payMax: 28 }, 65_000)).toEqual({
      unit: 'year',
      band: l1,
      offer: 72_000,
      posted: { min: 49_920, max: 58_240 },
      desired: 65_000,
    })
  })

  it('reads an hourly offer in dollars an hour, the posted hourly range as posted', () => {
    expect(bandMeterFigures({ payType: 'hourly', hourlyRate: 26 }, l1, { payMin: 24, payMax: 28 }, 52_000)).toEqual({
      unit: 'hour',
      band: { min: 28.85, mid: 33.65, max: 38.46 },
      offer: 26,
      posted: { min: 24, max: 28 },
      desired: 25,
      desiredFrom: 'year',
    })
    // An annual posted range is divided by 2,080 hours too; no rate or range reads as null.
    expect(bandMeterFigures({ payType: 'hourly' }, l1, { payMin: 52_000, payMax: 62_400 })).toMatchObject({ offer: null, posted: { min: 25, max: 30 }, desired: null })
    expect(bandMeterFigures({ payType: 'hourly', hourlyRate: 30 }, l1, undefined).posted).toBeNull()
  })

  it('uses an hourly desired pay as given on an hourly meter, and converts it only for a salary', () => {
    const hourlyWant = { amount: 27, unit: 'hour' as const }
    const rate = bandMeterFigures({ payType: 'hourly', hourlyRate: 26 }, l1, { payMin: 24, payMax: 28 }, hourlyWant)
    expect(rate).toMatchObject({ unit: 'hour', desired: 27 })
    expect(rate.desiredFrom).toBeUndefined()
    expect(bandMeterFigures({ payType: 'salary', salary: 72_000 }, l1, { payMin: 24, payMax: 28 }, hourlyWant)).toMatchObject({ unit: 'year', desired: 56_160, desiredFrom: 'hour' })
    expect(bandMeterFigures({ payType: 'salary', salary: 72_000 }, l1, undefined, { amount: 65_000, unit: 'year' }).desiredFrom).toBeUndefined()
  })

  it('gives peer rates for an hourly meter', () => {
    const people = [
      { id: 'p1', familyId: 'f-ops', levelId: 'lv-l1', startDate: '2025-01-01', endDate: null, hoursPerWeek: 24 },
      { id: 'p2', familyId: 'f-ops', levelId: 'lv-l1', startDate: '2025-01-01', endDate: null, hoursPerWeek: 40 },
    ] as Person[]
    const rows = [
      { id: 'c1', personId: 'p1', effectiveOn: '2025-01-01', payType: 'hourly', hourlyRate: 27, title: 't', levelId: 'lv-l1', reason: 'hire' },
      { id: 'c2', personId: 'p2', effectiveOn: '2025-01-01', payType: 'salary', salary: 62_400, title: 't', levelId: 'lv-l1', reason: 'hire' },
    ] as CompRecord[]
    expect(peerBases(people, rows, 'f-ops', 'lv-l1', '2026-10-09', [], 'hour')).toEqual([27, 30])
    expect(peerBases(people, rows, 'f-ops', 'lv-l1', '2026-10-09')).toEqual([27 * 24 * 52, 62_400])
  })
})

describe('unsaved offer builder drafts', () => {
  type F = { salary: number | null; startDate: string; contingencies: string[] }
  const base: F = { salary: 205_000, startDate: '2026-10-26', contingencies: ['i9'] }

  it('keeps a draft per application and offer until it is dropped', () => {
    const form: F = { ...base, salary: 200_000, startDate: '2026-11-02' }
    keepOfferDraft<F>('a-1', undefined, { base, form, version: 1 })
    keepOfferDraft<F>('a-1', 'o-9', { base, form: { ...base, salary: 1 } })
    expect(keptOfferDraft<F>('a-1', undefined, 1)).toEqual({ base, form, version: 1 })
    expect(keptOfferDraft<F>('a-1', 'o-9')?.form.salary).toBe(1)
    expect(hasKeptOfferDraft('a-1', undefined, 1)).toBe(true)
    expect(hasKeptOfferDraft('a-2')).toBe(false)
    // A new offer's draft never comes back on a later version.
    expect(keptOfferDraft<F>('a-1', undefined, 2)).toBeUndefined()
    // What comes back is a copy: editing it leaves the kept draft alone.
    keptOfferDraft<F>('a-1', undefined, 1)!.form.contingencies.push('piia')
    expect(keptOfferDraft<F>('a-1', undefined, 1)?.form.contingencies).toEqual(['i9'])
    dropOfferDraft('a-1')
    expect(keptOfferDraft<F>('a-1', undefined, 1)).toBeUndefined()
    expect(hasKeptOfferDraft('a-1', 'o-9')).toBe(true)
    dropOfferDraft('a-1', 'o-9')
    expect(hasKeptOfferDraft('a-1', 'o-9')).toBe(false)
  })

  it('brings back only what the user changed, and lets a change made elsewhere since win', () => {
    const kept = { base, form: { ...base, salary: 200_000, startDate: '2026-11-02' } }
    // Nothing changed elsewhere: both edits come back.
    expect(restoreOfferDraft(kept, base)).toEqual({ form: kept.form, restored: ['salary', 'startDate'], dropped: [] })
    // The start date was changed elsewhere since: the saved value wins there; the salary edit still comes back.
    const now = { ...base, startDate: '2026-11-09', contingencies: ['i9', 'piia'] }
    expect(restoreOfferDraft(kept, now)).toEqual({ form: { salary: 200_000, startDate: '2026-11-09', contingencies: ['i9', 'piia'] }, restored: ['salary'], dropped: ['startDate'] })
  })
})
