import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import { addApplication, addCandidate, archiveCandidate, toggleCandidateTag } from './candidates'
import { closeOutMessage, offerNudgeMessage, rejectionMessage } from './messages'
import { parseCandidateBlob } from './parse'
import { createReferral, markReferralPaid, referralFor, referralPayable, referralPayableOn, referralUpcoming, setReferralPayable } from './referrals'
import { fixtureDB, FRI } from './testkit'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

describe('addCandidate', () => {
  it('adds a pasted candidate to New with the review next step and records a referral', () => {
    const parsed = parseCandidateBlob('Rahul Iyer <rahul@iyer.dev>\nhttps://linkedin.com/in/rahul-iyer')
    let ids: { candidateId: string; applicationId?: string } = { candidateId: '' }
    const db = produce(fixtureDB(), (d) => {
      ids = addCandidate(
        d,
        { ...parsed, firstName: parsed.firstName ?? '', lastName: parsed.lastName ?? '', email: parsed.email ?? '', source: 'referral', referrerId: 'p-priya', desiredPay: 210_000 },
        { date: FRI, jobId: 'j-fullstack' },
      )
    })
    const cand = db.candidates.find((c) => c.id === ids.candidateId)!
    expect(cand).toMatchObject({ firstName: 'Rahul', lastName: 'Iyer', email: 'rahul@iyer.dev', source: 'referral', referrerId: 'p-priya', desiredPay: 210_000, sponsorship: 'unknown', retainUntil: '2030-10-09' })
    expect(cand.links.linkedin).toBe('https://www.linkedin.com/in/rahul-iyer')
    const app = db.applications.find((a) => a.id === ids.applicationId)!
    expect(app).toMatchObject({ stageId: 'new', status: 'active', appliedOn: FRI, history: [{ stageId: 'new', at: FRI }] })
    expect(app.nextStep).toEqual({ text: 'Review application', dueOn: '2026-10-14', ownerId: 'p-tomas' })
    expect(referralFor(db, ids.candidateId)).toMatchObject({ referrerId: 'p-priya', bonusAmount: 5000 })
    expect(db.activity.map((a) => a.text)).toEqual([
      'Added Rahul Iyer',
      'Priya Nair referred Rahul Iyer',
      'Added Rahul Iyer to Senior full-stack engineer in New',
    ])
  })

  it('keeps an hourly desired pay with its unit, and stores no unit for a yearly figure', () => {
    let hourly = ''
    let yearly = ''
    const db = produce(fixtureDB(), (d) => {
      hourly = addCandidate(d, { firstName: 'Ana', lastName: 'Ruiz', email: 'ana@example.com', source: 'inbound', desiredPay: 29.5, desiredPayUnit: 'hour' }, { date: FRI }).candidateId
      yearly = addCandidate(d, { firstName: 'Bo', lastName: 'Lee', email: 'bo@example.com', source: 'inbound', desiredPay: 62_000, desiredPayUnit: 'year' }, { date: FRI }).candidateId
    })
    expect(db.candidates.find((c) => c.id === hourly)).toMatchObject({ desiredPay: 29.5, desiredPayUnit: 'hour' })
    const bo = db.candidates.find((c) => c.id === yearly)!
    expect(bo.desiredPay).toBe(62_000)
    expect('desiredPayUnit' in bo).toBe(false)
  })

  it('does not create a second application for the same job', () => {
    produce(fixtureDB(), (d) => {
      expect(addApplication(d, 'c-alex', 'j-fullstack', { date: FRI })).toBe('a-alex')
      expect(addApplication(d, 'c-alex', 'nope', { date: FRI })).toBeNull()
    })
  })

  it('archives instead of deleting and keeps the 4-year retention from the last decision', () => {
    const db = produce(fixtureDB(), (d) => {
      d.applications[2].status = 'rejected'
      d.applications[2].closedOn = '2026-10-01'
      archiveCandidate(d, 'c-chen', { date: FRI })
      toggleCandidateTag(d, 'c-alex', 'keep warm')
    })
    expect(db.candidates.find((c) => c.id === 'c-chen')).toMatchObject({ archived: true, retainUntil: '2030-10-01' })
    expect(db.candidates.find((c) => c.id === 'c-alex')?.tags).toEqual(['keep warm'])
  })

  it('never shortens retention when imported decisions are older than the record', () => {
    const db = produce(fixtureDB(), (d) => {
      const ben = d.candidates.find((c) => c.id === 'c-ben')!
      ben.createdOn = '2026-09-20'
      ben.retainUntil = '2030-09-20'
      d.applications[1].status = 'rejected'
      d.applications[1].closedOn = '2024-03-01' // back-dated import
      archiveCandidate(d, 'c-ben', { date: FRI })
      const chen = d.candidates.find((c) => c.id === 'c-chen')!
      delete chen.retainUntil
      d.applications[2].status = 'rejected'
      d.applications[2].closedOn = '2024-03-01'
      archiveCandidate(d, 'c-chen', { date: FRI })
    })
    expect(db.candidates.find((c) => c.id === 'c-ben')?.retainUntil).toBe('2030-09-20')
    expect(db.candidates.find((c) => c.id === 'c-chen')?.retainUntil).toBe('2030-09-20') // 4 years from the record date
  })
})

describe('referrals', () => {
  it('becomes payable 90 days after the referred hire starts', () => {
    const db = produce(fixtureDB(), (d) => {
      createReferral(d, { candidateId: 'c-ben', referrerId: 'p-priya' })
      setReferralPayable(d, 'c-ben', '2026-07-06')
    })
    expect(referralPayableOn(db, '2026-07-06')).toBe('2026-10-04')
    expect(referralPayable(db, '2026-10-03')).toEqual([])
    expect(referralUpcoming(db, '2026-10-01').map((r) => r.candidateId)).toEqual(['c-ben'])
    expect(referralPayable(db, FRI).map((r) => r.candidateId)).toEqual(['c-ben'])
    const paid = produce(db, (d) => {
      expect(markReferralPaid(d, d.referrals[0].id, FRI)).toBe(true)
      expect(markReferralPaid(d, d.referrals[0].id, FRI)).toBe(false)
    })
    expect(referralPayable(paid, FRI)).toEqual([])
    expect(paid.activity.at(-1)?.text).toBe('Paid the $5,000 referral bonus to Priya Nair for Ben Ortiz')
  })
})

describe('messages', () => {
  it('writes a stage-aware rejection and suggests a call for final rounds', () => {
    const db = fixtureDB()
    const early = rejectionMessage(db, 'a-chen')!
    expect(early).toMatchObject({ to: 'chen.wu@example.com', subject: 'Your application to Ledgerlark', suggestCall: false, templateId: 'em-reject-early' })
    expect(early.body).toContain('Hi Chen,')
    expect(early.body.trim().endsWith('Maya Raman')).toBe(true)
    const late = rejectionMessage(db, 'a-alex', { tone: 'brief', senderId: 'p-tomas' })!
    expect(late).toMatchObject({ suggestCall: true, templateId: 'em-reject-late-brief' })
    expect(late.body.trim().endsWith('Tomas Herrera')).toBe(true)
    expect(late.mailto.startsWith('mailto:alex.kim@example.com?subject=Following%20up')).toBe(true)
  })

  it('builds a BCC close-out note for everyone not yet told', () => {
    const db = produce(fixtureDB(), (d) => {
      d.applications[0].conditionalOfferOn = FRI
      d.applications[2].status = 'rejected'
      d.applications[2].notifiedOn = '2026-10-01'
    })
    const note = closeOutMessage(db, 'j-fullstack')!
    expect(note.bcc).toEqual(['ben.ortiz@example.com'])
    expect(note.applicationIds).toEqual(['a-ben'])
    expect(note.subject).toBe('An update on the Senior full-stack engineer role at Ledgerlark')
    expect(note.mailto).toContain('bcc=ben.ortiz@example.com')
  })

  it('nudges before an offer expires', () => {
    const db = produce(fixtureDB(), (d) => {
      d.offers.push({ id: 'o-1', candidateId: 'c-alex', title: 'Senior full-stack engineer', expiresOn: '2026-10-14' } as (typeof d.offers)[number])
    })
    const m = offerNudgeMessage(db, 'o-1')!
    expect(m.body).toContain('It is open until Wed Oct 14.')
    expect(m.subject).toBe('Checking in on your Ledgerlark offer')
    expect(offerNudgeMessage(db, 'o-1', { date: '2026-10-14' })?.body).toContain('It is open until Wed Oct 14.')
  })

  it('never nudges with an expiry date that has already passed', () => {
    const db = produce(fixtureDB(), (d) => {
      d.offers.push({ id: 'o-1', candidateId: 'c-alex', title: 'Senior full-stack engineer', status: 'sent', expiresOn: '2026-10-14' } as (typeof d.offers)[number])
    })
    expect(offerNudgeMessage(db, 'o-1', { date: '2026-10-19' })).toBeNull()
    const expired = produce(db, (d) => {
      d.offers[0].status = 'expired'
    })
    expect(offerNudgeMessage(expired, 'o-1', { date: '2026-10-12' })).toBeNull()
  })

  it('addresses the close-out note to the sender only when they have a work email', () => {
    const db = produce(fixtureDB(), (d) => {
      const founder = d.people.find((p) => p.isFounder)
      if (founder) founder.workEmail = ''
    })
    const note = closeOutMessage(db, 'j-fullstack')!
    expect(note.from).toBe('')
    expect(note.mailto.startsWith('mailto:?bcc=')).toBe(true)
    const withEmail = closeOutMessage(fixtureDB(), 'j-fullstack', { senderId: 'p-tomas' })!
    expect(withEmail.from).toBe('tomas@ledgerlark.com')
    expect(withEmail.mailto.startsWith('mailto:tomas@ledgerlark.com?bcc=')).toBe(true)
  })
})
