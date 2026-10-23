import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import type { Band, DB, Job, Offer } from '@/domain/types'
import {
  approvalRequired,
  approvalRequiredAfterEdit,
  approveOffer,
  bandFor,
  bandPosition,
  classificationIssues,
  compaRatio,
  createOffer,
  defaultBase,
  defaultHourlyRate,
  defaultStartDate,
  exemptCheck,
  expireOffers,
  extendOffer,
  hoursPerWeekProblem,
  isDiscarded,
  isLapsed,
  jobWorkLocation,
  letterStartIssue,
  markAccepted,
  markDeclined,
  markSent,
  moveOfferStart,
  notApprovedMark,
  offerDefaults,
  offerEquitySummary,
  offerExceptions,
  offerFromPrevious,
  offerLetter,
  offerLocationDrift,
  offerWorkLocationText,
  postedRangeCheck,
  requestOfferChanges,
  rescindOffer,
  sendBlockerList,
  startHasPassed,
  submitForApproval,
  updateOffer,
  regularPaydayText,
  wageNotice2810_5,
  waitingOnApproval,
} from './offers'
import { fixtureDB, FRI, person } from './testkit'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

/** A default offer drafted by an admin (Viewing as Admin) unless the test names another drafter. */
function draftOffer(db: DB, appId = 'a-alex', extra: Partial<Offer> = {}): Offer {
  const drafter: Partial<Offer> = extra.draftedById ? {} : { draftedByRole: 'admin' }
  return { ...(offerDefaults(db, appId, FRI) as Offer), id: 'o-1', ...drafter, ...extra }
}

function withOffer(extra: Partial<Offer> = {}): DB {
  return produce(fixtureDB(), (d) => {
    createOffer(d, draftOffer(d as DB, 'a-alex', extra))
  })
}

describe('bands and defaults', () => {
  it('finds the band for a family and level', () => {
    expect(bandFor(fixtureDB(), 'f-eng', 'lv-l3')).toMatchObject({ min: 180_000, mid: 205_000, max: 230_000 })
    expect(bandFor(fixtureDB(), 'f-eng', 'lv-x1')).toBeUndefined()
  })

  it('prefills an offer from the job, band, settings and calendar', () => {
    const o = offerDefaults(fixtureDB(), 'a-alex', FRI)
    expect(o).toMatchObject({
      applicationId: 'a-alex',
      candidateId: 'c-alex',
      jobId: 'j-fullstack',
      version: 1,
      title: 'Senior full-stack engineer',
      levelId: 'lv-l3',
      familyId: 'f-eng',
      departmentId: 'd-eng',
      managerId: 'p-tomas',
      locationId: 'loc-hq',
      workMode: 'hybrid',
      flsa: 'exempt',
      exemptionBasis: 'computer_professional',
      payType: 'salary',
      salary: 187_000, // desired $187,400 is inside the band, snapped to $1,000
      equityType: 'ISO',
      equityShares: 27_000, // (0.10% + 0.35%) / 2 x 12,000,000
      vestingMonths: 48,
      cliffMonths: 12,
      startDate: '2026-10-26', // first Monday at least 14 days out
      expiresOn: '2026-10-16', // 5 business days
      contingencies: ['background_check', 'i9', 'piia'],
      status: 'draft',
      createdOn: FRI,
    })
  })

  it('uses the band midpoint when desired pay is outside the band or missing', () => {
    const high = produce(fixtureDB(), (d) => {
      d.candidates[0].desiredPay = 250_000
    })
    expect(offerDefaults(high, 'a-alex', FRI).salary).toBe(205_000)
    expect(offerDefaults(fixtureDB(), 'a-chen', FRI).salary).toBe(205_000)
  })

  it('snaps an odd midpoint to $1,000 and equity to 500 shares', () => {
    const db = produce(fixtureDB(), (d) => {
      const b = d.bands.find((x) => x.familyId === 'f-eng' && x.levelId === 'lv-l3') as Band
      b.mid = 207_600
      d.equity.fullyDilutedShares = 11_111_111
      d.jobs[0].backgroundCheck = false
    })
    const o = offerDefaults(db, 'a-chen', FRI)
    expect(o.salary).toBe(208_000)
    expect(o.equityShares).toBe(25_000)
    expect(o.contingencies).toEqual(['i9', 'piia'])
  })

  it('carries variable pay from the band and numbers new versions', () => {
    const db = produce(withOffer(), (d) => {
      const b = d.bands.find((x) => x.familyId === 'f-eng' && x.levelId === 'lv-l3') as Band
      b.variablePct = 0.1
    })
    const o = offerDefaults(db, 'a-alex', FRI)
    expect(o.variablePct).toBe(0.1)
    expect(o.version).toBe(2)
  })

  it('picks the start date Monday, moving off holidays', () => {
    expect(defaultStartDate('2026-10-12')).toBe('2026-10-26') // exactly 14 days, a Monday
    expect(defaultStartDate('2027-01-04', ['2027-01-18'])).toBe('2027-01-19') // MLK Day
  })

  it('places base in the band', () => {
    const band = { min: 180_000, mid: 205_000, max: 230_000 }
    expect(bandPosition(205_000, band)).toBe(0.5)
    expect(bandPosition(180_000, band)).toBe(0)
    expect(bandPosition(240_000, band)).toBeCloseTo(1.2)
    expect(bandPosition(170_000, band)).toBeCloseTo(-0.2)
    expect(compaRatio(225_500, band)).toBeCloseTo(1.1)
  })
})

describe('exceptions and exempt check', () => {
  it('flags pay above band and equity above guideline until a reason is given', () => {
    const db = fixtureDB()
    const o = draftOffer(db, 'a-alex', { salary: 240_000, equityShares: 50_000 })
    const ex = offerExceptions(db, o)
    expect(ex.map((e) => e.field)).toEqual(['salary', 'equity'])
    expect(ex[0].message).toBe('Base of $240,000 is above the band maximum of $230,000. Add an exception reason.')
    expect(ex[1].message).toContain('42,000 options')
    expect(ex.every((e) => !e.resolved)).toBe(true)
    expect(offerExceptions(db, { ...o, exceptionReason: 'Competing offer' }).every((e) => e.resolved)).toBe(true)
    expect(offerExceptions(db, draftOffer(db))).toEqual([])
  })

  it('applies the exempt salary floor at exactly $70,304', () => {
    const db = fixtureDB()
    const base = { flsa: 'exempt' as const, payType: 'salary' as const, familyId: 'f-ops', exemptionBasis: 'administrative' as const }
    expect(exemptCheck(db, { ...base, salary: 70_304 })).toMatchObject({ status: 'ok', mustBeNonExempt: false, messages: [] })
    const low = exemptCheck(db, { ...base, salary: 70_303 })
    expect(low.status).toBe('warn')
    expect(low.mustBeNonExempt).toBe(true)
    expect(low.messages[0]).toContain('$70,304')
    expect(low.messages[1]).toContain('overtime')
    expect(low.messages[1]).toContain('meal and rest breaks')
    expect(low.messages[1]).toContain('time tracking')
  })

  it('applies the computer professional minimums (annual and hourly)', () => {
    const db = fixtureDB()
    const cp = { flsa: 'exempt' as const, familyId: 'f-eng', exemptionBasis: 'computer_professional' as const }
    expect(exemptCheck(db, { ...cp, payType: 'salary', salary: 122_573 }).mustBeNonExempt).toBe(true) // below $122,573.13
    expect(exemptCheck(db, { ...cp, payType: 'salary', salary: 122_574 }).status).toBe('ok')
    expect(exemptCheck(db, { ...cp, payType: 'hourly', hourlyRate: 58.85 }).status).toBe('ok')
    expect(exemptCheck(db, { ...cp, payType: 'hourly', hourlyRate: 58.84 }).mustBeNonExempt).toBe(true)
    // An engineering role with no basis is treated as a computer professional.
    expect(exemptCheck(db, { flsa: 'exempt', payType: 'salary', salary: 100_000, familyId: 'f-ml' }).mustBeNonExempt).toBe(true)
  })

  it('warns on hourly exempt pay, outside sales and low non-exempt pay', () => {
    const db = fixtureDB()
    expect(exemptCheck(db, { flsa: 'exempt', payType: 'hourly', hourlyRate: 90, exemptionBasis: 'administrative' }).mustBeNonExempt).toBe(true)
    const os = exemptCheck(db, { flsa: 'exempt', payType: 'salary', salary: 60_000, exemptionBasis: 'outside_sales' })
    expect(os).toMatchObject({ status: 'warn', mustBeNonExempt: false })
    const lowHourly = exemptCheck(db, { flsa: 'non_exempt', payType: 'hourly', hourlyRate: 18, locationId: 'loc-hq' })
    expect(lowHourly.status).toBe('warn')
    expect(lowHourly.messages[0]).toBe('$18.00 an hour is below the $18.45 minimum wage for San Jose HQ.')
    const fine = exemptCheck(db, { flsa: 'non_exempt', payType: 'hourly', hourlyRate: 30, locationId: 'loc-hq' })
    expect(fine.status).toBe('ok')
    expect(fine.messages[0]).toContain('Labor Code 2810.5')
  })

  it('gives a current employee the 2810.5 change-notice wording, and a hire the start-date wording', () => {
    const db = fixtureDB()
    const input = { flsa: 'non_exempt' as const, payType: 'hourly' as const, hourlyRate: 30, locationId: 'loc-hq' }
    const startDate = 'Give the Labor Code 2810.5 wage notice by the start date.'
    const changeNotice = 'When the pay changes, give the written Labor Code 2810.5 change notice within 7 calendar days, unless the next timely pay stub shows the change.'
    // Offers (and anything that passes no context) keep the hire wording.
    expect(exemptCheck(db, input).messages[0]).toContain(startDate)
    expect(exemptCheck(db, { ...input, context: 'offer' }).messages[0]).toContain(startDate)
    const change = exemptCheck(db, { ...input, context: 'change' })
    expect(change.messages[0]).toContain(changeNotice)
    expect(change.messages[0]).not.toContain('by the start date')
    expect(change.messages[0]).toContain('overtime after 8 hours in a day')
    // Pay that drops below the exempt floor: the must-be-non-exempt reminder follows the context too.
    const low = { flsa: 'exempt' as const, payType: 'salary' as const, salary: 60_000, familyId: 'f-ops', exemptionBasis: 'administrative' as const }
    expect(exemptCheck(db, low).messages[1]).toContain(startDate)
    expect(exemptCheck(db, { ...low, context: 'change' }).messages[1]).toContain(changeNotice)
    // Outside California the federal wording has no 2810.5 sentence either way.
    expect(exemptCheck(db, { ...input, state: 'TX', context: 'change' }).messages.join(' ')).not.toContain('2810.5')
  })
})

describe('equity summary and approval', () => {
  it('shows shares, % fully diluted and the current 409A, with no paper value', () => {
    const s = offerEquitySummary(fixtureDB(), { equityShares: 27_000, equityType: 'ISO', vestingMonths: 48, cliffMonths: 12 }, FRI)
    expect(s).toMatchObject({ shares: 27_000, pctFD: 0.00225, strikeEstimate: 1.15, valuationOn: '2026-03-20', note: 'Strike is set by the board at grant' })
    expect(Object.keys(s)).not.toContain('value')
    expect(offerEquitySummary(fixtureDB(), { equityShares: 1, equityType: 'ISO', vestingMonths: 48, cliffMonths: 12 }, '2025-01-01').strikeEstimate).toBeNull()
  })

  it('routes approval only when a non-admin drafted the offer', () => {
    const db = produce(fixtureDB(), (d) => {
      d.people.push(
        person('p-luis', 'Luis', 'Ortega', { familyId: 'f-ops', departmentId: 'd-ops', levelId: 'lv-l1', title: 'Office and events coordinator' }),
        person('p-gone', 'Gwen', 'Hale', { familyId: 'f-ops', departmentId: 'd-ops', title: 'People operations lead', endDate: '2026-09-30' }),
        person('p-cro', 'Cam', 'Reyes', { familyId: 'f-exec', departmentId: 'd-exec', levelId: 'lv-x1', title: 'Chief revenue officer' }),
      )
    })
    // The Viewing-as role recorded on the offer decides.
    expect(approvalRequired(db, { draftedByRole: 'admin' })).toBe(false)
    expect(approvalRequired(db, { draftedByRole: 'manager', draftedById: 'p-founder' })).toBe(true)
    // Without a role: current founders and people-ops staff only.
    expect(approvalRequired(db, { draftedById: 'p-tomas' }, FRI)).toBe(true)
    expect(approvalRequired(db, { draftedById: 'p-jasmine' }, FRI)).toBe(false)
    expect(approvalRequired(db, { draftedById: 'p-founder' }, FRI)).toBe(false)
    expect(approvalRequired(db, { draftedById: 'p-luis' }, FRI)).toBe(true) // junior ops role
    expect(approvalRequired(db, { draftedById: 'p-cro' }, FRI)).toBe(true) // exec outside people ops
    expect(approvalRequired(db, { draftedById: 'p-gone' }, FRI)).toBe(true) // left on Sep 30
    expect(approvalRequired(db, { draftedById: 'p-gone' }, '2026-09-15')).toBe(false)
    // No drafter on record: route to Admin.
    expect(approvalRequired(db, {})).toBe(true)
  })
})

describe('transitions', () => {
  it('sends an offer: reserves options, moves to Offer and sets a follow-up', () => {
    const db = produce(withOffer(), (d) => {
      expect(markSent(d, 'o-1', { date: FRI })).toEqual({ ok: true })
    })
    const o = db.offers[0]
    expect(o).toMatchObject({ status: 'sent', sentOn: FRI })
    expect(db.grants).toHaveLength(1)
    expect(db.grants[0]).toMatchObject({ personId: 'c-alex', holderType: 'candidate', status: 'reserved', shares: 27_000, strikePrice: 1.15, fromOfferId: 'o-1', vestingStart: '2026-10-26' })
    const app = db.applications.find((a) => a.id === 'a-alex')!
    expect(app.stageId).toBe('offer')
    expect(app.nextStep).toEqual({ text: 'Follow up on the offer', dueOn: '2026-10-15', ownerId: 'p-tomas' })
    expect(db.activity.at(-1)?.text).toBe('Sent the offer to Alex Kim, expires Fri Oct 16')
  })

  it('blocks sending until approval and exceptions are handled', () => {
    const needsApproval = withOffer({ draftedById: 'p-tomas' })
    produce(needsApproval, (d) => {
      expect(markSent(d, 'o-1', { date: FRI })).toEqual({ ok: false, reason: 'This offer needs Admin approval before it goes out.' })
      expect(submitForApproval(d, 'o-1', { date: FRI }).ok).toBe(true)
      expect(approveOffer(d, 'o-1', { approverId: 'p-founder', at: '2026-10-09T18:00:00.000Z' }).ok).toBe(true)
      expect(markSent(d, 'o-1', { date: FRI }).ok).toBe(true)
    })
    const overBand = withOffer({ salary: 240_000 })
    produce(overBand, (d) => {
      const r = markSent(d, 'o-1', { date: FRI })
      expect(r.ok).toBe(false)
      d.offers[0].exceptionReason = 'Competing offer from a public company'
      expect(markSent(d, 'o-1', { date: FRI }).ok).toBe(true)
    })
  })

  it('accepting records the conditional offer date and keeps the reservation for Hire', () => {
    const db = produce(withOffer(), (d) => {
      markSent(d, 'o-1', { date: FRI })
      expect(markAccepted(d, 'o-1', { date: '2026-10-12' }).ok).toBe(true)
    })
    expect(db.offers[0]).toMatchObject({ status: 'accepted', decidedOn: '2026-10-12' })
    const app = db.applications.find((a) => a.id === 'a-alex')!
    expect(app.conditionalOfferOn).toBe('2026-10-12')
    expect(app.nextStep?.text).toBe('Start the background check')
    expect(db.grants[0].status).toBe('reserved')
  })

  it('declining releases the options and closes the application with the reason', () => {
    const db = produce(withOffer(), (d) => {
      markSent(d, 'o-1', { date: FRI })
      markDeclined(d, 'o-1', 'chose_other_offer', { date: '2026-10-13', note: 'Big-tech counteroffer' })
    })
    expect(db.offers[0]).toMatchObject({ status: 'declined', declineReason: 'chose_other_offer', competingNote: 'Big-tech counteroffer' })
    expect(db.grants[0].status).toBe('cancelled')
    expect(db.applications.find((a) => a.id === 'a-alex')).toMatchObject({ status: 'withdrawn', outcomeReason: 'chose_other_offer' })
  })

  it('expires, extends and rescinds', () => {
    const sent = produce(withOffer(), (d) => {
      markSent(d, 'o-1', { date: FRI })
    })
    const notYet = produce(sent, (d) => {
      expect(expireOffers(d, '2026-10-16')).toBe(0)
    })
    expect(notYet.offers[0].status).toBe('sent')
    const expired = produce(sent, (d) => {
      expect(expireOffers(d, '2026-10-17')).toBe(1)
    })
    expect(expired.offers[0].status).toBe('expired')
    expect(expired.offers[0].decidedOn).toBe('2026-10-16') // the expiry date is the decision date
    expect(expired.grants[0].status).toBe('cancelled')
    expect(expired.applications.find((a) => a.id === 'a-alex')?.nextStep?.text).toBe('Offer expired: extend it or close out')
    const extended = produce(expired, (d) => {
      expect(extendOffer(d, 'o-1', '2026-10-21', { date: '2026-10-17' }).ok).toBe(true)
    })
    expect(extended.offers[0]).toMatchObject({ status: 'sent', expiresOn: '2026-10-21' })
    expect(extended.offers[0].decidedOn).toBeUndefined()
    expect(extended.grants.filter((g) => g.status === 'reserved')).toHaveLength(1)
    const rescinded = produce(sent, (d) => {
      rescindOffer(d, 'o-1', { date: '2026-10-12', reason: 'Role eliminated', closeApplication: true })
    })
    expect(rescinded.offers[0].status).toBe('rescinded')
    expect(rescinded.grants[0].status).toBe('cancelled')
    expect(rescinded.applications.find((a) => a.id === 'a-alex')?.status).toBe('rejected')
  })
})

describe('generated documents', () => {
  it('writes an offer letter with the required California terms and no dollar projections', () => {
    const db = withOffer()
    const letter = offerLetter(db, 'o-1')!
    expect(letter.subject).toBe('Your offer from Ledgerlark')
    const t = letter.text
    expect(t).toContain('Ledgerlark, Inc.')
    expect(t).toContain('99 S Almaden Blvd, Suite 410, San Jose, CA 95113')
    expect(t).toContain('reporting to Tomas Herrera, Founding engineer')
    expect(t).toContain('Your start date will be October 26, 2026')
    expect(t).toContain('$187,000 a year')
    expect(t).toContain('This position is exempt')
    expect(t).toContain('Subject to approval by the Board of Directors')
    expect(t).toContain('27,000 shares')
    expect(t).toContain('fully diluted')
    expect(t).toContain('incentive stock option (ISO)')
    expect(t).toContain('fair market value of a share on the date the Board grants the option')
    expect(t).toContain('25% vests after 12 months of service')
    expect(t).toContain('Labor Code 2922')
    expect(t).toContain('Fair Chance Act (Government Code 12952)')
    expect(t).toContain('Labor Code 2870')
    expect(t).toContain('Form I-9')
    expect(t).toContain('Business and Professions Code 16600')
    expect(t).toContain('Labor Code 925')
    expect(t).toContain('October 16, 2026')
    expect(t).toContain('Accepted by Alex Kim')
    expect(t).toContain('Maya Raman')
    expect(t).not.toMatch(/\$5\.83|paper value|worth \$/i)
    expect(t.includes(String.fromCharCode(0x2014))).toBe(false)
    expect(letter.html).toContain('<h2>At-will employment</h2>')
  })

  it('states the % of fully diluted shares only once the cap table is confirmed', () => {
    const confirmed = offerLetter(withOffer(), 'o-1')!.text
    expect(confirmed).toContain("27,000 shares of the company's common stock, about 0.22% of the company's fully diluted shares today, as an incentive stock option")
    // Start fresh leaves placeholder numbers: the letter gives the share count only.
    const placeholder = produce(withOffer(), (d) => {
      delete d.equity.capTableConfirmedOn
    })
    const t = offerLetter(placeholder, 'o-1')!.text
    expect(t).toContain("an option to purchase 27,000 shares of the company's common stock, as an incentive stock option")
    expect(t).not.toContain('fully diluted')
    // The builder's numbers are unchanged; only the letter leaves the estimate out.
    expect(offerEquitySummary(placeholder, placeholder.offers[0], FRI).pctFD).toBeCloseTo(27_000 / 12_000_000)
  })

  it('escapes HTML and describes non-exempt hourly pay', () => {
    const db = produce(withOffer({ payType: 'hourly', hourlyRate: 32, salary: undefined, flsa: 'non_exempt', employmentType: 'part_time', hoursPerWeek: 24, equityShares: 0 }), (d) => {
      d.candidates[0].firstName = '<b>Alex</b>'
    })
    const letter = offerLetter(db, 'o-1')!
    expect(letter.html).toContain('&lt;b&gt;Alex&lt;/b&gt;')
    expect(letter.html).not.toContain('<b>Alex</b>')
    expect(letter.text).toContain('$32.00 an hour')
    expect(letter.text).toContain('non-exempt')
    expect(letter.text).toContain('part-time (about 24 hours a week)')
    expect(letter.text).not.toContain('Equity')
  })

  it('builds the Labor Code 2810.5 notice from an offer', () => {
    const db = withOffer({ payType: 'hourly', hourlyRate: 30, salary: undefined, flsa: 'non_exempt', hoursPerWeek: 24 })
    const n = wageNotice2810_5(db, { offerId: 'o-1' })!
    expect(n.text).toContain('$30.00 per hour (rate by the hour)')
    expect(n.text).toContain('$45.00 per hour (1.5 times')
    expect(n.text).toContain('$60.00 per hour (2 times)')
    expect(n.text).toContain('Regular payday: the 15th and the last day of each month')
    expect(n.text).toContain('Legal name: Ledgerlark, Inc.')
    expect(n.text).toContain('Phone: (408) 555-0100')
    expect(n.text).toContain('Carrier: Golden Poppy Mutual')
    expect(n.text).toContain('Carrier address: 1 Market St, San Francisco, CA 94105')
    expect(n.text).toContain('Carrier phone: (800) 555-0199')
    expect(n.text).toContain('Policy number: WC-2026-118')
    expect(n.text).toContain('paid sick leave')
    expect(n.text).toContain('Santa Clara County within 30 days before your first day of work')
    // A blank regular payday is not missing: the notice prints the pay calendar's own words.
    expect(n.text).toContain('Regular payday: the 15th and the last day of each month, or the business day before when that is a weekend or holiday.')
    expect(n.missing).toEqual([])
  })

  it('takes the regular payday from the pay calendar when Settings leaves it blank, so the notice never drifts', () => {
    const db = produce(fixtureDB(), (d) => {
      delete d.company.regularPayday
    })
    expect(regularPaydayText(db)).toBe('the 15th and the last day of each month, or the business day before when that is a weekend or holiday')
    const moved = produce(db, (d) => {
      d.company.paySchedule = 'monthly'
      d.company.payroll = { paydayShift: 'after' }
    })
    // Monthly pay is on the 26th (Labor Code 204), never 'the last business day'.
    expect(regularPaydayText(moved)).toBe('the 26th of each month, for the whole month, or the next business day when that is a weekend or holiday')
    const typed = produce(db, (d) => {
      d.company.regularPayday = ' the 10th and 25th of each month '
    })
    expect(regularPaydayText(typed)).toBe('the 10th and 25th of each month')
  })

  it('builds the notice for an existing person from their comp record and lists missing settings', () => {
    const db = produce(fixtureDB(), (d) => {
      d.people.push(person('p-luis', 'Luis', 'Ortega', { employmentType: 'part_time', hoursPerWeek: 24, flsa: 'non_exempt', title: 'Office and events coordinator', startDate: '2026-07-20', familyId: 'f-ops' }))
      d.comp.push({ id: 'cr-1', personId: 'p-luis', effectiveOn: '2026-07-20', payType: 'hourly', hourlyRate: 30, title: 'Office and events coordinator', levelId: 'lv-l1', reason: 'hire' })
      delete d.company.workersCompCarrier
      delete d.company.phone
      d.company.regularPayday = 'the 10th and 25th of each month'
    })
    const n = wageNotice2810_5(db, { personId: 'p-luis' })!
    expect(n.text).toContain('Name: Luis Ortega')
    expect(n.text).toContain('$45.00 per hour')
    expect(n.text).toContain('Regular payday: the 10th and 25th of each month')
    expect(n.missing).toEqual([
      "Workers' comp carrier (Settings > Company)",
      "Workers' comp carrier address (Settings > Company)",
      "Workers' comp carrier phone (Settings > Company)",
      'Company phone number (Settings > Company)',
    ])
    expect(n.text).toContain('Carrier address: Not set')
    expect(wageNotice2810_5(db, { personId: 'nobody' })).toBeNull()
  })
})

describe('approval and status guards', () => {
  it('force skips band exceptions only, never approval or missing pay', () => {
    produce(withOffer({ draftedById: 'p-tomas', salary: 240_000 }), (d) => {
      expect(markSent(d, 'o-1', { date: FRI, force: true })).toEqual({ ok: false, reason: 'This offer needs Admin approval before it goes out.' })
      expect(submitForApproval(d, 'o-1', { date: FRI }).ok).toBe(true)
      expect(markSent(d, 'o-1', { date: FRI })).toEqual({ ok: false, reason: 'This offer is waiting for Admin approval.' })
      approveOffer(d, 'o-1', { approverId: 'p-founder', at: '2026-10-09T18:00:00.000Z' })
      expect(markSent(d, 'o-1', { date: FRI }).ok).toBe(false) // unresolved exception
      expect(markSent(d, 'o-1', { date: FRI, force: true }).ok).toBe(true)
      // A resend of a sent, approved offer is not blocked by approval again.
      expect(markSent(d, 'o-1', { date: '2026-10-12', force: true }).ok).toBe(true)
      d.offers[0].exceptionReason = 'Competing offer'
      expect(markSent(d, 'o-1', { date: '2026-10-13' }).ok).toBe(true)
    })
    produce(withOffer({ salary: undefined }), (d) => {
      expect(markSent(d, 'o-1', { date: FRI, force: true })).toEqual({ ok: false, reason: 'Add the base pay.' })
    })
  })

  it('sends an approved offer back to draft when pay, equity, level or start date change', () => {
    const db = produce(withOffer({ draftedById: 'p-tomas' }), (d) => {
      submitForApproval(d, 'o-1', { date: FRI })
      approveOffer(d, 'o-1', { approverId: 'p-founder', at: '2026-10-09T18:00:00.000Z' })
      expect(updateOffer(d, 'o-1', { signOnBonus: undefined, title: 'Senior full-stack engineer, platform' }, { date: FRI }).ok).toBe(true)
      expect(d.offers[0].status).toBe('approved') // title only
      expect(updateOffer(d, 'o-1', { salary: 195_000 }, { date: FRI }).ok).toBe(true)
    })
    expect(db.offers[0]).toMatchObject({ status: 'draft', salary: 195_000, title: 'Senior full-stack engineer, platform' })
    expect(db.activity.at(-1)?.text).toBe(
      'Updated the offer for Alex Kim. Pay, equity, level, start date or work location changed, so it is back in draft and needs Admin approval again before it goes out.',
    )
    produce(db, (d) => {
      expect(markSent(d, 'o-1', { date: FRI }).ok).toBe(false)
      d.offers[0].status = 'sent'
      expect(updateOffer(d, 'o-1', { salary: 200_000 }, { date: FRI })).toEqual({ ok: false, reason: 'This offer has already gone out. Draft a new version to change its terms.' })
    })
  })

  it('accepts only a sent offer', () => {
    produce(withOffer({ draftedById: 'p-tomas' }), (d) => {
      submitForApproval(d, 'o-1', { date: FRI })
      approveOffer(d, 'o-1', { approverId: 'p-founder', at: '2026-10-09T18:00:00.000Z' })
      expect(markAccepted(d, 'o-1', { date: FRI })).toEqual({ ok: false, reason: 'Mark the offer sent before recording the acceptance.' })
      expect(d.grants).toHaveLength(0)
      markSent(d, 'o-1', { date: FRI })
      expect(markAccepted(d, 'o-1', { date: '2026-10-12' }).ok).toBe(true)
      expect(d.grants[0].status).toBe('reserved')
    })
  })

  it('records a renege after acceptance as a decline and frees the options', () => {
    const db = produce(withOffer(), (d) => {
      markSent(d, 'o-1', { date: FRI })
      markAccepted(d, 'o-1', { date: '2026-10-12' })
      expect(markDeclined(d, 'o-1', 'chose_other_offer', { date: '2026-10-14' }).ok).toBe(true)
    })
    expect(db.offers[0]).toMatchObject({ status: 'declined', declineReason: 'chose_other_offer', decidedOn: '2026-10-14' })
    expect(db.grants[0].status).toBe('cancelled')
    expect(db.applications.find((a) => a.id === 'a-alex')).toMatchObject({ status: 'withdrawn', outcomeReason: 'chose_other_offer' })
    expect(db.activity.map((a) => a.text)).toContain('Alex Kim backed out after accepting the offer (chose another offer)')
    produce(db, (d) => {
      d.offers[0].status = 'accepted'
      d.offers[0].personId = 'p-alex'
      expect(markDeclined(d, 'o-1', 'other', { date: FRI }).ok).toBe(false)
      expect(rescindOffer(d, 'o-1', { date: FRI, reason: 'x' }).ok).toBe(false)
    })
  })
})

describe('offer letter wording', () => {
  it('uses exempt wording for an hourly computer professional and keeps headings in sentence case', () => {
    const db = withOffer({ payType: 'hourly', hourlyRate: 95, salary: undefined, flsa: 'exempt', exemptionBasis: 'computer_professional' })
    const t = offerLetter(db, 'o-1')!.text
    expect(t).toContain('$95.00 an hour')
    expect(t).toContain('This position is exempt under the computer professional exemption (Labor Code 515.5), which means it is not eligible for overtime.')
    expect(t).not.toContain('non-exempt')
    expect(t).toContain('\nPay and benefits\n----------------\n')
    expect(t).not.toContain('PAY AND BENEFITS')
  })

  it('describes an internship plainly', () => {
    const db = withOffer({ employmentType: 'intern', title: 'Software engineering intern', payType: 'hourly', hourlyRate: 40, salary: undefined, flsa: 'non_exempt' })
    const t = offerLetter(db, 'o-1')!.text
    expect(t).toContain('This is an internship. You will work as Software engineering intern, reporting to Tomas Herrera')
    expect(t).not.toContain('work intern')
  })
})

describe('wage notice details', () => {
  it('says exempt from overtime for an exempt hire and prints no overtime rates', () => {
    const n = wageNotice2810_5(withOffer(), { offerId: 'o-1' })!
    expect(n.text).toContain('Rate of pay: $187,000 per year, paid as a salary\n')
    expect(n.text).toContain('Overtime: Exempt from overtime.')
    expect(n.text).not.toContain('1.5 times')
  })

  it('uses the pay in effect at the start date, not a future raise, and works out sick days from hours', () => {
    const db = produce(fixtureDB(), (d) => {
      d.people.push(person('p-luis', 'Luis', 'Ortega', { employmentType: 'part_time', hoursPerWeek: 24, flsa: 'non_exempt', startDate: '2026-07-20', familyId: 'f-ops' }))
      d.comp.push(
        { id: 'cr-1', personId: 'p-luis', effectiveOn: '2026-07-20', payType: 'hourly', hourlyRate: 30, title: 'Office and events coordinator', levelId: 'lv-l1', reason: 'hire' },
        { id: 'cr-2', personId: 'p-luis', effectiveOn: '2027-01-01', payType: 'hourly', hourlyRate: 33, title: 'Office and events coordinator', levelId: 'lv-l1', reason: 'merit' },
      )
      const sick = d.timeOffPolicies.find((p) => p.kind === 'sick')
      if (sick) {
        sick.method = 'frontload'
        sick.annualHours = 48
      }
    })
    const atStart = wageNotice2810_5(db, { personId: 'p-luis' })!
    expect(atStart.text).toContain('$30.00 per hour (rate by the hour)')
    expect(atStart.text).toContain('48 hours (6 days) of paid sick leave')
    const change = wageNotice2810_5(db, { personId: 'p-luis', date: '2027-01-01' })!
    expect(change.text).toContain('$33.00 per hour (rate by the hour)')
    const odd = produce(db, (d) => {
      const sick = d.timeOffPolicies.find((p) => p.kind === 'sick')
      if (sick) sick.annualHours = 44
    })
    expect(wageNotice2810_5(odd, { personId: 'p-luis' })!.text).toContain('provides 44 hours of paid sick leave')
  })
})

/** The fixture job as an L1 operations role (band $60K-$80K, midpoint under the $70,304 exempt floor). */
function opsDB(desiredPay = 62_000): DB {
  return produce(fixtureDB(), (d) => {
    const job = d.jobs[0]
    job.title = 'Operations coordinator'
    job.familyId = 'f-ops'
    job.levelId = 'lv-l1'
    job.payMin = 60_000
    job.payMax = 80_000
    job.flsa = 'exempt'
    d.candidates[0].desiredPay = desiredPay
  })
}

describe('classification blocks sending (exempt floor, minimum wage)', () => {
  it('starts a role non-exempt and hourly when the default base cannot support an exemption', () => {
    const o = offerDefaults(opsDB(), 'a-alex', FRI)
    expect(o).toMatchObject({ flsa: 'non_exempt', payType: 'hourly', hourlyRate: 29.75 })
    expect(o.salary).toBeUndefined()
    expect(o.exemptionBasis).toBeUndefined()
    // Desired pay above the floor keeps the exempt default.
    expect(offerDefaults(opsDB(75_000), 'a-alex', FRI)).toMatchObject({ flsa: 'exempt', exemptionBasis: 'administrative', payType: 'salary', salary: 75_000 })
    // Engineering under the computer professional minimum ($122,573.13) starts non-exempt too.
    const junior = produce(fixtureDB(), (d) => {
      d.jobs[0].payMin = 100_000
      d.jobs[0].payMax = 120_000
      d.bands = d.bands.filter((b) => !(b.familyId === 'f-eng' && b.levelId === 'lv-l3'))
      delete d.candidates[0].desiredPay
    })
    expect(offerDefaults(junior, 'a-alex', FRI)).toMatchObject({ flsa: 'non_exempt', payType: 'hourly' })
  })

  it('blocks an exempt offer under the salary floor, and force does not skip it', () => {
    const db = produce(opsDB(), (d) => {
      const o = { ...(offerDefaults(d as DB, 'a-alex', FRI) as Offer), id: 'o-1', draftedByRole: 'admin' as const, flsa: 'exempt' as const, exemptionBasis: 'administrative' as const, payType: 'salary' as const, salary: 62_000 }
      delete o.hourlyRate
      createOffer(d, o)
    })
    const issues = classificationIssues(db, db.offers[0])
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('below the California exempt salary floor of $70,304')
    expect(sendBlockerList(db, db.offers[0], FRI).map((b) => b.kind)).toEqual(['classification'])
    produce(db, (d) => {
      const r = markSent(d, 'o-1', { date: FRI, force: true })
      expect(r.ok).toBe(false)
      expect(r.ok ? '' : r.reason).toContain('$70,304')
      expect(d.offers[0].status).toBe('draft')
    })
  })

  it('blocks an hourly rate under the local minimum wage, and salaried pay that works out under it', () => {
    const hourly = produce(opsDB(), (d) => {
      createOffer(d, { ...(offerDefaults(d as DB, 'a-alex', FRI) as Offer), id: 'o-1', draftedByRole: 'admin', hourlyRate: 17.5 })
    })
    expect(classificationIssues(hourly, hourly.offers[0])).toEqual([
      { kind: 'classification', message: '$17.50 an hour is below the $18.45 minimum wage for San Jose HQ. Raise the pay before it goes out.' },
    ])
    produce(hourly, (d) => {
      expect(markSent(d, 'o-1', { date: FRI, force: true }).ok).toBe(false)
      d.offers[0].hourlyRate = 18.45
      expect(markSent(d, 'o-1', { date: FRI }).ok).toBe(true)
    })
    const salaried = produce(opsDB(), (d) => {
      const o = { ...(offerDefaults(d as DB, 'a-alex', FRI) as Offer), id: 'o-1', draftedByRole: 'admin' as const, payType: 'salary' as const, salary: 30_000 }
      delete o.hourlyRate
      createOffer(d, o)
    })
    expect(classificationIssues(salaried, salaried.offers[0])[0].message).toContain('below the $18.45 minimum wage')
    // No pay yet: only the pay blocker speaks.
    const empty = produce(opsDB(), (d) => {
      const o = { ...(offerDefaults(d as DB, 'a-alex', FRI) as Offer), id: 'o-1', draftedByRole: 'admin' as const }
      delete o.hourlyRate
      createOffer(d, o)
    })
    expect(sendBlockerList(empty, empty.offers[0], FRI).map((b) => b.kind)).toEqual(['pay'])
  })
})

describe('expiry', () => {
  it('blocks sending a draft whose expiry date has passed, even with force', () => {
    produce(withOffer({ expiresOn: '2026-10-14' }), (d) => {
      expect(sendBlockerList(d as DB, d.offers[0] as Offer, '2026-10-15').map((b) => b.message)).toEqual(['The expiry date Wed, Oct 14 has passed. Pick a new expiry before sending.'])
      expect(markSent(d, 'o-1', { date: '2026-10-15', force: true }).ok).toBe(false)
      expect(markSent(d, 'o-1', { date: '2026-10-14' }).ok).toBe(true) // the last day still counts
    })
    // A reset expiry through updateOffer lets it go out.
    produce(withOffer({ expiresOn: '2026-10-14' }), (d) => {
      expect(updateOffer(d, 'o-1', { expiresOn: '2026-10-22' }, { date: '2026-10-15' }).ok).toBe(true)
      expect(markSent(d, 'o-1', { date: '2026-10-15' }).ok).toBe(true)
    })
  })

  it('treats a sent offer past its expiry as lapsed and refuses to accept it until extended', () => {
    const sent = produce(withOffer(), (d) => {
      markSent(d, 'o-1', { date: FRI })
    })
    expect(isLapsed(sent.offers[0], '2026-10-16')).toBe(false)
    expect(isLapsed(sent.offers[0], '2026-10-17')).toBe(true)
    produce(sent, (d) => {
      expect(markAccepted(d, 'o-1', { date: '2026-10-19' })).toEqual({ ok: false, reason: 'This offer expired on Fri, Oct 16. Extend it first.' })
      expect(extendOffer(d, 'o-1', '2026-10-21', { date: '2026-10-19' }).ok).toBe(true)
      expect(markAccepted(d, 'o-1', { date: '2026-10-19' }).ok).toBe(true)
    })
    produce(sent, (d) => {
      expireOffers(d, '2026-10-19')
      expect(markAccepted(d, 'o-1', { date: '2026-10-19' })).toEqual({ ok: false, reason: 'This offer expired on Fri, Oct 16. Extend it first.' })
    })
  })

  it('expires offers the same way whatever day it runs, so every device writes identical records', () => {
    const sent = produce(withOffer(), (d) => {
      markSent(d, 'o-1', { date: FRI })
    })
    const monday = produce(sent, (d) => {
      expect(expireOffers(d, '2026-10-19')).toBe(1)
    })
    const later = produce(sent, (d) => {
      expect(expireOffers(d, '2026-11-02')).toBe(1)
    })
    const pick = (db: DB) => ({ offers: db.offers, grants: db.grants, applications: db.applications, activity: db.activity.filter((a) => a.kind === 'offer_expired') })
    expect(pick(later)).toEqual(pick(monday))
    expect(monday.grants[0]).toMatchObject({ status: 'cancelled', cancelledOn: '2026-10-16' })
    expect(monday.applications.find((a) => a.id === 'a-alex')?.nextStep).toEqual({ text: 'Offer expired: extend it or close out', dueOn: '2026-10-19', ownerId: 'p-tomas' })
    expect(monday.activity.filter((a) => a.kind === 'offer_expired')).toEqual([
      {
        id: 'act-offer-expired-o-1-2026-10-16',
        at: '2026-10-17T07:00:00.000Z',
        actorId: null,
        entityType: 'offer',
        entityId: 'o-1',
        relatedId: 'c-alex',
        kind: 'offer_expired',
        text: 'The offer for Alex Kim expired on Fri Oct 16',
      },
    ])
    // Running again changes nothing.
    produce(monday, (d) => {
      expect(expireOffers(d, '2026-11-02')).toBe(0)
    })
  })
})

describe('manager edits to an admin draft', () => {
  const manager = { role: 'manager' as const, personId: 'p-tomas' }

  it('routes the offer to Admin when a hiring manager changes pay, and blocks sending', () => {
    const db = produce(withOffer(), (d) => {
      expect(approvalRequiredAfterEdit(d as DB, d.offers[0] as Offer, { salary: 228_000 }, manager, FRI)).toBe(true)
      expect(approvalRequiredAfterEdit(d as DB, d.offers[0] as Offer, { title: 'Founding full-stack engineer' }, manager, FRI)).toBe(false)
      expect(approvalRequiredAfterEdit(d as DB, d.offers[0] as Offer, { salary: 228_000 }, { role: 'admin', personId: 'p-founder' }, FRI)).toBe(false)
      expect(updateOffer(d, 'o-1', { salary: 228_000 }, { date: FRI, editor: manager }).ok).toBe(true)
    })
    expect(db.offers[0]).toMatchObject({ salary: 228_000, draftedByRole: 'manager', draftedById: 'p-tomas', status: 'draft' })
    expect(approvalRequired(db, db.offers[0], FRI)).toBe(true)
    expect(db.activity.at(-1)?.text).toBe('Updated the offer for Alex Kim. Pay, equity, level, start date or work location changed, so it needs Admin approval before it goes out.')
    produce(db, (d) => {
      expect(markSent(d, 'o-1', { date: FRI })).toEqual({ ok: false, reason: 'This offer needs Admin approval before it goes out.' })
    })
  })

  it('leaves the drafter alone for title-only edits and for Admin edits', () => {
    const db = produce(withOffer(), (d) => {
      updateOffer(d, 'o-1', { title: 'Founding full-stack engineer' }, { date: FRI, editor: manager })
      updateOffer(d, 'o-1', { salary: 200_000 }, { date: FRI, editor: { role: 'admin', personId: 'p-founder' } })
    })
    expect(db.offers[0]).toMatchObject({ draftedByRole: 'admin', salary: 200_000 })
    expect(approvalRequired(db, db.offers[0], FRI)).toBe(false)
  })

  it('sends an approved offer back to draft when a manager changes its equity', () => {
    const db = produce(withOffer({ draftedById: 'p-tomas', draftedByRole: 'manager' }), (d) => {
      submitForApproval(d, 'o-1', { date: FRI })
      approveOffer(d, 'o-1', { approverId: 'p-founder', at: '2026-10-09T18:00:00.000Z' })
      updateOffer(d, 'o-1', { equityShares: 30_000 }, { date: FRI, editor: manager })
    })
    expect(db.offers[0].status).toBe('draft')
  })
})

describe('hours a week', () => {
  it('accepts whole or half hours from 1 to 60 and refuses anything else', () => {
    expect(hoursPerWeekProblem(undefined)).toBeNull()
    expect(hoursPerWeekProblem(32.5)).toBeNull()
    expect(hoursPerWeekProblem(60)).toBeNull()
    for (const bad of [0, 0.5, 61, 4032, Number.NaN]) expect(hoursPerWeekProblem(bad)).toBe('Enter 1 to 60 hours a week.')
    // In range but not a whole or half hour: the message names that problem, not the range.
    for (const odd of [24.25, 32.75, 1.1]) expect(hoursPerWeekProblem(odd)).toBe('Use whole or half hours, like 24 or 24.5.')
    produce(fixtureDB(), (d) => {
      expect(createOffer(d, { ...draftOffer(d as DB), hoursPerWeek: 24.25 })).toEqual({ ok: false, reason: 'Use whole or half hours, like 24 or 24.5.' })
    })
    produce(fixtureDB(), (d) => {
      expect(createOffer(d, { ...draftOffer(d as DB), hoursPerWeek: 4032 })).toEqual({ ok: false, reason: 'Enter 1 to 60 hours a week.' })
      expect(d.offers).toHaveLength(0)
      expect(createOffer(d, draftOffer(d as DB))).toEqual({ ok: true, id: 'o-1' })
      expect(updateOffer(d, 'o-1', { hoursPerWeek: 4032 }, { date: FRI })).toEqual({ ok: false, reason: 'Enter 1 to 60 hours a week.' })
      expect(updateOffer(d, 'o-1', { hoursPerWeek: 32 }, { date: FRI }).ok).toBe(true)
      expect(d.offers[0].hoursPerWeek).toBe(32)
    })
  })

  it('writes part-time in the letter for under 30 hours, even when the type was left at full time', () => {
    const t = offerLetter(withOffer({ employmentType: 'full_time', hoursPerWeek: 24 }), 'o-1')!.text
    expect(t).toContain('You will work part-time (about 24 hours a week) as Senior full-stack engineer')
    expect(offerLetter(withOffer({ employmentType: 'full_time', hoursPerWeek: 40 }), 'o-1')!.text).toContain('You will work full-time as')
    expect(offerLetter(withOffer({ employmentType: 'part_time', hoursPerWeek: 32 }), 'o-1')!.text).toContain('You will work part-time (about 32 hours a week)')
  })
})

describe('posted range check', () => {
  const job = { payMin: 175_000, payMax: 215_000 }

  it('warns when the base is outside the posted range, in annual or hourly terms', () => {
    expect(postedRangeCheck(job, { payType: 'salary', salary: 222_000 })).toEqual({
      side: 'above',
      message: '$222K is above the posted range of $175K to $215K. Pay outside the good-faith range can undercut the pay-scale disclosure.',
    })
    expect(postedRangeCheck(job, { payType: 'salary', salary: 200_000 })).toBeNull()
    expect(postedRangeCheck(job, { payType: 'salary', salary: 215_000 })).toBeNull()
    expect(postedRangeCheck(job, { payType: 'hourly', hourlyRate: 80 })?.message).toBe(
      '$80.00 an hour ($166K a year) is below the posted range of $175K to $215K. Pay outside the good-faith range can undercut the pay-scale disclosure.',
    )
    const hourlyJob = { payMin: 20, payMax: 25 }
    expect(postedRangeCheck(hourlyJob, { payType: 'hourly', hourlyRate: 17.5 })?.message).toBe(
      '$17.50 an hour is below the posted range of $20.00 to $25.00 an hour. Pay outside the good-faith range can undercut the pay-scale disclosure.',
    )
    expect(postedRangeCheck(hourlyJob, { payType: 'hourly', hourlyRate: 25 })).toBeNull()
    expect(postedRangeCheck(hourlyJob, { payType: 'salary', salary: 62_000 })?.side).toBe('above')
  })

  it('says nothing without a range or without pay', () => {
    expect(postedRangeCheck({ payMin: null, payMax: null }, { payType: 'salary', salary: 1 })).toBeNull()
    expect(postedRangeCheck(undefined, { payType: 'salary', salary: 1 })).toBeNull()
    expect(postedRangeCheck(job, { payType: 'salary' })).toBeNull()
  })
})

describe('after a rescind or decline', () => {
  it('asks for a decision instead of a stale follow-up when the application stays open', () => {
    const rescinded = produce(withOffer(), (d) => {
      markSent(d, 'o-1', { date: FRI })
      expect(rescindOffer(d, 'o-1', { date: '2026-10-12', reason: 'Offer made in error', closeApplication: false }).ok).toBe(true)
    })
    const app = rescinded.applications.find((a) => a.id === 'a-alex')!
    expect(app.status).toBe('active')
    expect(app.nextStep).toEqual({ text: 'Decide: make a new offer or close out', dueOn: '2026-10-13', ownerId: 'p-tomas' })
    expect(rescinded.offers[0]).toMatchObject({ status: 'rescinded', rescindReason: 'Offer made in error' })
    expect(rescinded.activity.at(-1)?.text).toBe('Rescinded the offer for Alex Kim: Offer made in error')
    const declined = produce(withOffer(), (d) => {
      markSent(d, 'o-1', { date: FRI })
      markDeclined(d, 'o-1', 'comp', { date: '2026-10-12', closeApplication: false })
    })
    expect(declined.applications.find((a) => a.id === 'a-alex')?.nextStep?.text).toBe('Decide: make a new offer or close out')
  })

  it('records a never-sent draft as discarded, with its reason', () => {
    const db = produce(withOffer(), (d) => {
      rescindOffer(d, 'o-1', { date: FRI, reason: 'Budget changed' })
    })
    expect(isDiscarded(db.offers[0])).toBe(true)
    expect(db.offers[0].rescindReason).toBe('Budget changed')
    expect(db.activity.at(-1)).toMatchObject({ kind: 'offer_discarded', text: 'Discarded the draft offer for Alex Kim: Budget changed' })
    const sent = produce(withOffer(), (d) => {
      markSent(d, 'o-1', { date: FRI })
      rescindOffer(d, 'o-1', { date: FRI, reason: 'Role on hold' })
    })
    expect(isDiscarded(sent.offers[0])).toBe(false)
  })

  it('starts the next version from the previous terms, with a fresh expiry and a future start date', () => {
    const prev: Offer = {
      ...(offerDefaults(opsDB(), 'a-alex', FRI) as Offer),
      id: 'o-1',
      hourlyRate: 17.5,
      hoursPerWeek: 32,
      employmentType: 'part_time',
      variablePct: 0.1,
      equityShares: 50_000,
      exceptionReason: 'Competing offer',
      status: 'rescinded',
      sentOn: FRI,
      decidedOn: '2026-10-12',
      declineReason: 'comp',
      approvals: [{ approverId: 'p-founder', decision: 'approved', at: '2026-10-09T18:00:00.000Z' }],
      backgroundCheck: { status: 'not_started' },
      startDate: '2026-10-26',
    }
    const withPrev = produce(opsDB(), (d) => {
      d.offers.push(prev)
    })
    const defaults = offerDefaults(withPrev, 'a-alex', '2026-10-13')
    const next = offerFromPrevious(prev, defaults, '2026-10-13')
    expect(next).toMatchObject({
      version: 2,
      flsa: 'non_exempt',
      payType: 'hourly',
      hourlyRate: 17.5,
      hoursPerWeek: 32,
      employmentType: 'part_time',
      variablePct: 0.1,
      equityShares: 50_000,
      exceptionReason: 'Competing offer',
      status: 'draft',
      approvals: [],
      startDate: '2026-10-26',
      expiresOn: '2026-10-20',
      createdOn: '2026-10-13',
    })
    for (const k of ['sentOn', 'decidedOn', 'declineReason', 'backgroundCheck', 'personId', 'id'] as const) expect(next[k]).toBeUndefined()
    // A start date already past falls back to the default.
    expect(offerFromPrevious(prev, defaults, '2026-10-27').startDate).toBe(defaults.startDate)
  })
})

/** The fixture job as a part-time L1 operations role posted at $24 to $28 an hour (the L1 band is $60K-$80K a year). */
function partTimeDB(desiredPay?: number, extra: Partial<Job> = {}): DB {
  return produce(fixtureDB(), (d) => {
    Object.assign(d.jobs[0], { title: 'Office coordinator', familyId: 'f-ops', levelId: 'lv-l1', employmentType: 'part_time', flsa: 'non_exempt', payMin: 24, payMax: 28 }, extra)
    if (desiredPay == null) delete d.candidates[0].desiredPay
    else d.candidates[0].desiredPay = desiredPay
  })
}

describe('defaults inside the posted range', () => {
  it('offers an hourly role the midpoint of its hourly posted range, not the annual band over 2,080 hours', () => {
    const db = partTimeDB()
    const o = offerDefaults(db, 'a-alex', FRI)
    expect(o).toMatchObject({ flsa: 'non_exempt', payType: 'hourly', hourlyRate: 26, hoursPerWeek: 20 })
    expect(o.salary).toBeUndefined()
    expect(postedRangeCheck(db.jobs[0], o as Offer)).toBeNull()
    // Desired pay inside the range (at 2,080 hours) is kept; outside it, the midpoint.
    expect(offerDefaults(partTimeDB(52_000), 'a-alex', FRI).hourlyRate).toBe(25)
    expect(offerDefaults(partTimeDB(187_400), 'a-alex', FRI).hourlyRate).toBe(26)
    // A full-time non-exempt role posted by the hour is paid by the hour too.
    expect(offerDefaults(partTimeDB(undefined, { employmentType: 'full_time' }), 'a-alex', FRI)).toMatchObject({ payType: 'hourly', hourlyRate: 26 })
    // The next candidate on the job starts inside the range as well.
    expect(offerDefaults(db, 'a-ben', FRI).hourlyRate).toBe(26)
  })

  it('moves an annual default inside the posted range, keeping desired pay the range holds', () => {
    const narrow = (desiredPay?: number) =>
      produce(fixtureDB(), (d) => {
        d.jobs[0].payMin = 150_000
        d.jobs[0].payMax = 190_000
        if (desiredPay == null) delete d.candidates[0].desiredPay
        else d.candidates[0].desiredPay = desiredPay
      })
    // The band midpoint ($205K) is above the range: the nearest end.
    expect(offerDefaults(narrow(), 'a-alex', FRI).salary).toBe(190_000)
    // Desired pay below the band but inside the range.
    expect(offerDefaults(narrow(170_200), 'a-alex', FRI).salary).toBe(170_000)
    // Desired pay inside both stays as it was.
    expect(offerDefaults(narrow(185_000), 'a-alex', FRI).salary).toBe(185_000)
  })

  it('snaps into the range without stepping outside it', () => {
    expect(defaultBase({ min: 60_000, mid: 70_000, max: 80_000 }, { payMin: 50_500, payMax: 58_250 })).toBe(58_000)
    expect(defaultBase({ min: 60_000, mid: 70_000, max: 80_000 }, { payMin: 81_200, payMax: 81_700 })).toBe(81_200)
    expect(defaultBase(undefined, { payMin: null, payMax: null }, 101_400)).toBe(101_000)
    // An annual range: $50,000 / 2,080 is $24.04, and $24.00 would fall under the range.
    expect(defaultHourlyRate(50_000, { payMin: 50_000, payMax: 60_000 })).toBe(24.25)
    expect(defaultHourlyRate(70_000, { payMin: null, payMax: null })).toBe(33.75)
    expect(defaultHourlyRate(undefined, { payMin: 24.1, payMax: 24.2 })).toBeCloseTo(24.15, 5)
  })
})

describe('start dates that have passed', () => {
  const admin = { role: 'admin' as const, personId: 'p-founder' }

  it('blocks sending an offer whose start date has passed, even with force, until the start moves', () => {
    produce(withOffer({ expiresOn: '2026-10-30' }), (d) => {
      const message = 'The start date Mon, Oct 26 has passed. Pick a new start date before sending.'
      expect(sendBlockerList(d as DB, d.offers[0] as Offer, '2026-10-27')).toEqual([{ kind: 'start', message }])
      expect(markSent(d, 'o-1', { date: '2026-10-27', force: true })).toEqual({ ok: false, reason: message })
      expect(sendBlockerList(d as DB, d.offers[0] as Offer, '2026-10-26')).toEqual([]) // the start day itself is fine
      expect(moveOfferStart(d, 'o-1', '2026-10-23', { date: '2026-10-27' })).toEqual({ ok: false, reason: 'Pick a start date on or after today.' })
      expect(moveOfferStart(d, 'o-1', '2026-11-16', { date: '2026-10-27', editor: admin }).ok).toBe(true)
      expect(markSent(d, 'o-1', { date: '2026-10-27' }).ok).toBe(true)
      expect(d.offers[0].startDate).toBe('2026-11-16')
    })
  })

  it('sends an approved offer back to draft when its start moves', () => {
    const db = produce(withOffer({ draftedById: 'p-tomas', draftedByRole: 'manager', expiresOn: '2026-10-30' }), (d) => {
      submitForApproval(d, 'o-1', { date: FRI })
      approveOffer(d, 'o-1', { approverId: 'p-founder', at: '2026-10-09T18:00:00.000Z' })
      expect(moveOfferStart(d, 'o-1', '2026-11-16', { date: '2026-10-27', editor: admin }).ok).toBe(true)
    })
    expect(db.offers[0]).toMatchObject({ status: 'draft', startDate: '2026-11-16' })
    expect(approvalRequired(db, db.offers[0], '2026-10-27')).toBe(true)
  })

  it('records a late acceptance and moves an accepted start without sending it back to draft', () => {
    const accepted = produce(withOffer({ expiresOn: '2026-10-30' }), (d) => {
      markSent(d, 'o-1', { date: FRI })
      // A founder may record the acceptance after the start date.
      expect(markAccepted(d, 'o-1', { date: '2026-10-27' }).ok).toBe(true)
    })
    expect(accepted.offers[0]).toMatchObject({ status: 'accepted', startDate: '2026-10-26' })
    const moved = produce(accepted, (d) => {
      expect(moveOfferStart(d, 'o-1', '2026-10-28', { date: '2026-10-27' }).ok).toBe(true)
    })
    expect(moved.offers[0]).toMatchObject({ status: 'accepted', startDate: '2026-10-28', decidedOn: '2026-10-27' })
    expect(moved.grants.find((g) => g.fromOfferId === 'o-1' && g.status === 'reserved')?.vestingStart).toBe('2026-10-28')
    expect(moved.activity.at(-1)).toMatchObject({ kind: 'offer_start_moved', text: 'Moved the start date for Alex Kim to Wed Oct 28' })
    produce(accepted, (d) => {
      d.offers[0].personId = 'p-alex'
      expect(moveOfferStart(d, 'o-1', '2026-10-28', { date: '2026-10-27' })).toEqual({ ok: false, reason: 'This offer is already a hire, so the start date is on their profile.' })
    })
  })

  it('refuses to extend while the start has passed, unless the extension moves the start too', () => {
    const sent = produce(withOffer(), (d) => {
      markSent(d, 'o-1', { date: FRI }) // expires Fri Oct 16, starts Mon Oct 26
    })
    produce(sent, (d) => {
      expireOffers(d, '2026-10-27')
      expect(extendOffer(d, 'o-1', '2026-10-30', { date: '2026-10-27' })).toEqual({
        ok: false,
        reason: 'The start date Mon, Oct 26 has passed. Open the offer to extend it with a new start date.',
      })
      expect(d.offers[0].status).toBe('expired')
      expect(extendOffer(d, 'o-1', '2026-10-30', { date: '2026-10-27', startDate: '2026-10-23' })).toEqual({ ok: false, reason: 'Pick a start date on or after today.' })
      expect(extendOffer(d, 'o-1', '2026-10-30', { date: '2026-10-27', startDate: '2026-11-16' }).ok).toBe(true)
      expect(d.offers[0]).toMatchObject({ status: 'sent', expiresOn: '2026-10-30', startDate: '2026-11-16' })
      expect(d.grants.find((g) => g.fromOfferId === 'o-1' && g.status === 'reserved')?.vestingStart).toBe('2026-11-16')
      expect(d.activity.at(-1)?.text).toBe('Extended the offer for Alex Kim to Fri Oct 30 and moved the start date to Mon Nov 16')
    })
    // Before the start date, extending works as before.
    produce(sent, (d) => {
      expect(extendOffer(d, 'o-1', '2026-10-21', { date: '2026-10-19' }).ok).toBe(true)
      expect(d.offers[0].startDate).toBe('2026-10-26')
    })
    // An offer that is out keeps its status when only the start moves; its reserved options follow.
    produce(sent, (d) => {
      expect(moveOfferStart(d, 'o-1', '2026-11-02', { date: '2026-10-14' }).ok).toBe(true)
      expect(d.offers[0]).toMatchObject({ status: 'sent', startDate: '2026-11-02' })
      expect(d.grants.find((g) => g.fromOfferId === 'o-1' && g.status === 'reserved')?.vestingStart).toBe('2026-11-02')
    })
  })

  it('keeps the letter from promising a start date that has passed', () => {
    const draft = withOffer({ expiresOn: '2026-10-30' }).offers[0]
    expect(letterStartIssue(draft, '2026-10-27')).toBe('The start date Mon, Oct 26 has passed. Pick a new start date before you generate the letter.')
    expect(letterStartIssue(draft, '2026-10-26')).toBeNull()
    // An accepted offer recorded late is a record of what was agreed.
    expect(letterStartIssue({ ...draft, status: 'accepted', sentOn: FRI }, '2026-10-27')).toBeNull()
    // Never a start date before the letter's own date.
    expect(letterStartIssue({ ...draft, status: 'accepted', sentOn: '2026-10-27' }, '2026-10-28')).not.toBeNull()
    expect(startHasPassed(draft, '2026-10-27')).toBe(true)
  })
})

describe('letter work location', () => {
  it('says a remote hire works remotely from their state, with no office address', () => {
    const remote = offerLetter(withOffer({ workMode: 'remote' }), 'o-1')!.text
    expect(remote).toContain('You will work remotely from California. Your start date will be October 26, 2026.')
    expect(remote).not.toContain('Your work location')
    const texas = produce(withOffer({ workMode: 'remote', locationId: 'loc-tx' }), (d) => {
      d.locations.push({ id: 'loc-tx', name: 'Remote (Texas)', kind: 'remote', state: 'TX', minWageHourly: 7.25 })
    })
    expect(offerLetter(texas, 'o-1')!.text).toContain('You will work remotely from Texas.')
  })

  it('gives the office address for hybrid and on-site work', () => {
    expect(offerLetter(withOffer({ workMode: 'hybrid' }), 'o-1')!.text).toContain(
      'Your work location is San Jose HQ (99 S Almaden Blvd, Suite 410, San Jose, CA 95113), hybrid.',
    )
    expect(offerLetter(withOffer({ workMode: 'onsite' }), 'o-1')!.text).toContain(
      'Your work location is San Jose HQ (99 S Almaden Blvd, Suite 410, San Jose, CA 95113), on site.',
    )
  })
})

/** The fixture job moved from hybrid at San Jose HQ to remote (Remote (California)) after an offer was drafted. */
function remoteJob(db: DB): DB {
  return produce(db, (d) => {
    d.jobs[0].workMode = 'remote'
    d.jobs[0].locationIds = ['loc-remote-ca']
  })
}

describe('work location follows the job', () => {
  it('starts an offer at the job location that fits its work mode', () => {
    expect(jobWorkLocation(fixtureDB(), { workMode: 'hybrid', locationIds: ['loc-hq'] })).toEqual({ workMode: 'hybrid', locationId: 'loc-hq' })
    // A remote job that still lists the office picks its remote location.
    expect(jobWorkLocation(fixtureDB(), { workMode: 'remote', locationIds: ['loc-hq', 'loc-remote-ca'] })).toEqual({ workMode: 'remote', locationId: 'loc-remote-ca' })
    expect(jobWorkLocation(fixtureDB(), { workMode: 'onsite', locationIds: [] })).toEqual({ workMode: 'onsite', locationId: 'loc-hq' })
    expect(offerDefaults(remoteJob(fixtureDB()), 'a-alex', FRI)).toMatchObject({ workMode: 'remote', locationId: 'loc-remote-ca' })
  })

  it('names the work location in plain words', () => {
    const db = fixtureDB()
    expect(offerWorkLocationText(db, { workMode: 'hybrid', locationId: 'loc-hq' })).toBe('Hybrid at San Jose HQ')
    expect(offerWorkLocationText(db, { workMode: 'onsite', locationId: 'loc-hq' })).toBe('On site at San Jose HQ')
    expect(offerWorkLocationText(db, { workMode: 'remote', locationId: 'loc-remote-ca' })).toBe('Remote from California')
  })

  it('spots a draft whose job moved, and clears once the offer takes the job location', () => {
    const db = remoteJob(withOffer())
    const drift = offerLocationDrift(db, db.offers[0])
    expect(drift).toEqual({
      workMode: 'remote',
      locationId: 'loc-remote-ca',
      job: 'remote from California',
      offer: 'hybrid at San Jose HQ',
      message: 'The job is now remote from California. This offer still says hybrid at San Jose HQ.',
    })
    const fixed = produce(db, (d) => {
      expect(updateOffer(d, 'o-1', { workMode: 'remote', locationId: 'loc-remote-ca' }, { date: FRI }).ok).toBe(true)
    })
    expect(offerLocationDrift(fixed, fixed.offers[0])).toBeNull()
    expect(offerLetter(fixed, 'o-1')!.text).toContain('You will work remotely from California.')
    const same = withOffer()
    expect(offerLocationDrift(same, same.offers[0])).toBeNull()
  })

  it('starts a new version at the job location as it is now, not the old version location', () => {
    const db = produce(remoteJob(withOffer()), (d) => {
      markSent(d, 'o-1', { date: FRI })
      rescindOffer(d, 'o-1', { date: '2026-10-12', reason: 'Offer made in error. Hours were wrong' })
    })
    const prev = db.offers[0]
    expect(prev).toMatchObject({ workMode: 'hybrid', locationId: 'loc-hq' })
    const next = offerFromPrevious(prev, offerDefaults(db, 'a-alex', '2026-10-12'), '2026-10-12')
    expect(next).toMatchObject({ version: 2, workMode: 'remote', locationId: 'loc-remote-ca', salary: prev.salary })
  })

  it('treats a new work location as a change Admin approves', () => {
    const manager = { role: 'manager' as const, personId: 'p-tomas' }
    const db = withOffer()
    expect(approvalRequiredAfterEdit(db, db.offers[0], { locationId: 'loc-remote-ca' }, manager, FRI)).toBe(true)
    expect(approvalRequiredAfterEdit(db, db.offers[0], { workMode: 'onsite' }, manager, FRI)).toBe(true)
    const approved = produce(withOffer({ draftedById: 'p-tomas', draftedByRole: 'manager' }), (d) => {
      submitForApproval(d, 'o-1', { date: FRI })
      approveOffer(d, 'o-1', { approverId: 'p-founder', at: '2026-10-09T18:00:00.000Z' })
      updateOffer(d, 'o-1', { workMode: 'remote', locationId: 'loc-remote-ca' }, { date: FRI, editor: { role: 'admin', personId: 'p-founder' } })
    })
    expect(approved.offers[0].status).toBe('draft')
  })

  it('checks the classification against the new work state', () => {
    // $17.50 an hour is under the California minimum wage, and fine for remote work from Texas.
    const db = produce(withOffer({ flsa: 'non_exempt', payType: 'hourly', hourlyRate: 17.5, salary: undefined, exemptionBasis: undefined }), (d) => {
      d.locations.push({ id: 'loc-tx', name: 'Remote (Texas)', kind: 'remote', state: 'TX', minWageHourly: 7.25 })
    })
    expect(classificationIssues(db, db.offers[0])).toHaveLength(1)
    expect(classificationIssues(db, { ...db.offers[0], workMode: 'remote', locationId: 'loc-tx' })).toEqual([])
  })
})

describe('letters before Admin approves', () => {
  it('knows when an offer still waits on Admin', () => {
    const managerDraft = withOffer({ draftedById: 'p-tomas', draftedByRole: 'manager' })
    expect(waitingOnApproval(managerDraft, managerDraft.offers[0], FRI)).toBe(true)
    const waiting = produce(managerDraft, (d) => {
      submitForApproval(d, 'o-1', { date: FRI })
    })
    expect(waitingOnApproval(waiting, waiting.offers[0], FRI)).toBe(true)
    const approved = produce(waiting, (d) => {
      approveOffer(d, 'o-1', { approverId: 'p-founder', at: '2026-10-09T18:00:00.000Z' })
    })
    expect(waitingOnApproval(approved, approved.offers[0], FRI)).toBe(false)
    // An Admin draft needs no separate approval.
    const adminDraft = withOffer()
    expect(waitingOnApproval(adminDraft, adminDraft.offers[0], FRI)).toBe(false)
  })

  it('marks a letter and wage notice as a draft, not approved, in the preview, print and copied text', () => {
    const db = withOffer({ draftedById: 'p-tomas', draftedByRole: 'manager', flsa: 'non_exempt', payType: 'hourly', hourlyRate: 95, salary: undefined, exemptionBasis: undefined })
    const letter = offerLetter(db, 'o-1', { notApproved: true })!
    expect(letter.subject).toBe('Draft, not approved: Your offer from Ledgerlark')
    expect(letter.text.startsWith(notApprovedMark() + '\n\nOffer of employment: Senior full-stack engineer')).toBe(true)
    expect(letter.html.startsWith('<p class="draft-mark"><strong>Draft, not approved. Admin approves this offer before it goes out. Do not send this copy.</strong></p>\n<h1>')).toBe(true)
    const notice = wageNotice2810_5(db, { offerId: 'o-1', notApproved: true })!
    expect(notice.text.startsWith(notApprovedMark())).toBe(true)
    // The approved letter carries no mark.
    const plain = offerLetter(db, 'o-1')!
    expect(plain.subject).toBe('Your offer from Ledgerlark')
    expect(plain.text).not.toContain('not approved')
    expect(wageNotice2810_5(db, { offerId: 'o-1' })!.text).not.toContain('not approved')
  })
})

describe('next step while the offer has not gone out', () => {
  const nextOf = (db: DB) => db.applications.find((a) => a.id === 'a-alex')?.nextStep

  it('asks Admin to send an offer Admin drafted, so no stale debrief goes overdue', () => {
    const db = produce(fixtureDB(), (d) => {
      const app = d.applications.find((a) => a.id === 'a-alex')!
      app.nextStep = { text: 'Debrief and decide', dueOn: '2026-10-12', ownerId: 'p-tomas' }
      createOffer(d, draftOffer(d as DB))
    })
    expect(nextOf(db)).toEqual({ text: 'Send the offer', dueOn: '2026-10-12', ownerId: 'p-tomas' })
    expect(db.applications.find((a) => a.id === 'a-alex')?.stageId).toBe('onsite')
  })

  it('walks a manager draft through submit, approve and ask for changes', () => {
    const drafted = withOffer({ draftedById: 'p-tomas', draftedByRole: 'manager' })
    expect(nextOf(drafted)).toEqual({ text: 'Submit the offer for approval', dueOn: '2026-10-12', ownerId: 'p-tomas' })
    const waiting = produce(drafted, (d) => {
      submitForApproval(d, 'o-1', { date: FRI })
    })
    expect(nextOf(waiting)).toEqual({ text: 'Send the offer once Admin approves', dueOn: '2026-10-13', ownerId: 'p-tomas' })
    const changes = produce(waiting, (d) => {
      requestOfferChanges(d, 'o-1', { approverId: 'p-founder', at: '2026-10-12T17:00:00.000Z', note: 'Bring base inside the band' })
    })
    expect(nextOf(changes)).toEqual({ text: 'Submit the offer for approval', dueOn: '2026-10-13', ownerId: 'p-tomas' })
    const approved = produce(waiting, (d) => {
      approveOffer(d, 'o-1', { approverId: 'p-founder', at: '2026-10-09T18:00:00.000Z' })
    })
    expect(nextOf(approved)).toEqual({ text: 'Send the offer', dueOn: '2026-10-12', ownerId: 'p-tomas' })
    // Sending replaces it with the follow-up, as before.
    const sent = produce(approved, (d) => {
      markSent(d, 'o-1', { date: FRI })
    })
    expect(nextOf(sent)?.text).toBe('Follow up on the offer')
  })

  it('asks again for approval when an approved offer goes back to draft', () => {
    const db = produce(withOffer({ draftedById: 'p-tomas', draftedByRole: 'manager' }), (d) => {
      submitForApproval(d, 'o-1', { date: FRI })
      approveOffer(d, 'o-1', { approverId: 'p-founder', at: '2026-10-09T18:00:00.000Z' })
      updateOffer(d, 'o-1', { salary: 200_000 }, { date: '2026-10-13' })
    })
    expect(db.offers[0].status).toBe('draft')
    expect(nextOf(db)).toEqual({ text: 'Submit the offer for approval', dueOn: '2026-10-14', ownerId: 'p-tomas' })
  })

  it('leaves a closed application without a next step alone', () => {
    const db = produce(fixtureDB(), (d) => {
      const app = d.applications.find((a) => a.id === 'a-alex')!
      app.status = 'withdrawn'
      delete app.nextStep
      createOffer(d, draftOffer(d as DB))
    })
    expect(nextOf(db)).toBeUndefined()
  })
})

describe('desired pay by the hour', () => {
  it('compares an hourly desired pay with an hourly range directly', () => {
    const hourlyDesired = (rate: number) =>
      produce(partTimeDB(rate), (d) => {
        d.candidates[0].desiredPayUnit = 'hour'
      })
    // $27 an hour sits inside the $24 to $28 range.
    expect(offerDefaults(hourlyDesired(27), 'a-alex', FRI)).toMatchObject({ payType: 'hourly', hourlyRate: 27 })
    // $31 an hour is above it: the midpoint.
    expect(offerDefaults(hourlyDesired(31), 'a-alex', FRI).hourlyRate).toBe(26)
    // The same figure read as a year ($62,000, or $29.81 an hour at 2,080 hours) is above the range too.
    expect(offerDefaults(partTimeDB(62_000), 'a-alex', FRI).hourlyRate).toBe(26)
    expect(defaultHourlyRate(undefined, { payMin: 24, payMax: 28 }, { amount: 25.5, unit: 'hour' })).toBe(25.5)
    expect(defaultHourlyRate(undefined, { payMin: 24, payMax: 28 }, 52_000)).toBe(25)
  })

  it('reads an hourly desired pay at 2,080 hours against an annual band', () => {
    const db = produce(fixtureDB(), (d) => {
      d.candidates[0].desiredPay = 100
      d.candidates[0].desiredPayUnit = 'hour'
    })
    // $100 an hour is $208,000 a year, inside the $180K to $230K band and the posted range.
    expect(offerDefaults(db, 'a-alex', FRI).salary).toBe(208_000)
  })
})
