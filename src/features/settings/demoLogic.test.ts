import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companyFactsSet } from '@/careers/render'
import { setClockOverride } from '@/lib/dates'
import { careersSwitchText, demoCompanyDB, displayUrl, founderNameProblem, inviteExpiryText, openInviteText, replacedHere, signInFootnote } from './demoLogic'
import type { WorkspaceSummary } from './serverLogic'

beforeAll(() => setClockOverride('2026-10-10'))
afterAll(() => setClockOverride(null))

describe('the company a demo sign-up starts', () => {
  it('is Start fresh as a solo founder, named as typed, with its defaults', () => {
    const db = demoCompanyDB({ companyName: '  Acme Robots ', firstName: ' Sam ', lastName: ' Rivera ' })
    expect(db.meta.sample).toBe(false)
    expect(db.company.name).toBe('Acme Robots')
    expect(db.company.hq).toMatchObject({ city: 'San Jose', state: 'CA', zip: '95113' })
    expect(db.people).toHaveLength(1)
    expect(db.people[0]).toMatchObject({ firstName: 'Sam', lastName: 'Rivera', title: 'Founder and CEO', startDate: '2026-10-10' })
    // Nothing guessed: the founder adds a work email on their profile.
    expect(db.people[0].workEmail ?? '').toBe('')
    expect(db.jobs).toEqual([])
    expect(db.candidates).toEqual([])
  })

  it("records the facts it filled in, so the public careers page never states them as the company's", () => {
    const db = demoCompanyDB({ companyName: 'Acme Robots', firstName: 'Sam', lastName: 'Rivera' })
    expect(db.meta.signupDefaults).toEqual({ hqCity: 'San Jose', hqState: 'CA', stage: db.company.stage, workweek: db.company.workweek, foundedOn: '2026-10-10' })
    expect(companyFactsSet(db)).toEqual({ hq: false, stage: false, workweek: false, foundedOn: false })
    // The company sets its own headquarters: that one shows.
    expect(companyFactsSet({ ...db, company: { ...db.company, hq: { ...db.company.hq, city: 'Oakland' } } })).toMatchObject({ hq: true, stage: false })
  })

  it('takes another start date when given', () => {
    expect(demoCompanyDB({ companyName: 'Acme', firstName: 'Sam', lastName: 'Rivera' }, '2026-11-02').people[0].startDate).toBe('2026-11-02')
  })

  it('wants both names of the founder', () => {
    expect(founderNameProblem('', ' ')).toMatch(/first and last name/)
    expect(founderNameProblem('Sam', '')).toBe('Add your last name.')
    expect(founderNameProblem('', 'Rivera')).toBe('Add your first name.')
    expect(founderNameProblem(' Sam ', ' Rivera ')).toBeNull()
  })
})

describe('what creating or joining a company replaces here', () => {
  const summary = (over: Partial<WorkspaceSummary>): WorkspaceSummary => ({ companyName: 'Acme', sample: false, counts: { people: 1, candidates: 0, jobs: 0 }, ...over })

  it('names a company of this browser\'s own, never the sample', () => {
    expect(replacedHere(summary({ companyName: 'Acme' }))).toBe('Acme')
    expect(replacedHere(summary({ companyName: '  ' }))).toBe('an unnamed company')
    expect(replacedHere(summary({ companyName: 'Ledgerlark, Inc.', sample: true }))).toBeNull()
  })
})

describe('invite and careers texts', () => {
  it('names who made an open invite link and until when it works, for the list it can be revoked from', () => {
    const invite = { id: 'i-1', createdAt: '2026-10-10T17:00:00.000Z', expiresAt: '2026-10-17T17:00:00.000Z', createdBy: 'sam@acme.test' }
    expect(openInviteText(invite)).toMatch(/^Made by sam@acme\.test\. Works until Sat, Oct 17, \d{1,2}:00 (AM|PM)\.$/)
    expect(openInviteText({ ...invite, createdBy: null })).toMatch(/^Made by a login that is gone now\. Works until/)
    expect(openInviteText({ ...invite, expiresAt: 'soon' })).toBe('Made by sam@acme.test.')
  })

  it('says what the careers page switch does, on and off', () => {
    expect(careersSwitchText(true)).toMatch(/^Public: anyone with the link/)
    expect(careersSwitchText(false)).toMatch(/^Off: the link shows nothing and takes no applications/)
  })

  it('sends demo logins to their own email and password, never to whoever set the server up', () => {
    expect(signInFootnote(true)).toMatch(/signed up or joined with.*no password reset/)
    expect(signInFootnote(false)).toBeNull()
  })

  it('says until when an invite link works', () => {
    expect(inviteExpiryText('2026-10-17T17:00:00.000Z')).toMatch(/^It works once, until Sat, Oct 17, \d{1,2}:00 (AM|PM)\.$/)
    expect(inviteExpiryText('soon')).toBe('It works once, for 7 days.')
  })

  it('shows an address without its scheme or trailing slash', () => {
    expect(displayUrl('https://careers-77-112-161-54.sslip.io/acme-robots/')).toBe('careers-77-112-161-54.sslip.io/acme-robots')
    expect(displayUrl('http://localhost:8826/')).toBe('localhost:8826')
  })
})
