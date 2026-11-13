import { produce } from 'immer'
import { describe, expect, it, vi } from 'vitest'
import type { DB, Offer } from '@/domain/types'
import {
  healthPlanUnrecorded,
  jobStates,
  offersHealthPlanOn,
  payRangeLine,
  payTransparencyRules,
  postingBlockReason,
  postingBlockRule,
  postingHeadcount,
  postingLint,
  postingText,
  salaryHistoryLint,
} from './postings'
import { fixtureDB, FRI, person } from './testkit'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

/** Fixture plus extra employees so the company has `employed` people today. */
function withHeadcount(employed: number, opts: { incoming?: number; acceptedOffers?: number; convertedOffers?: number } = {}): DB {
  return produce(fixtureDB(), (d) => {
    let n = d.people.length
    while (n < employed) {
      d.people.push(person(`p-e${n}`, `Emp${n}`, 'Test', { hireNumber: n + 1, startDate: '2026-01-05' }))
      n += 1
    }
    for (let i = 0; i < (opts.incoming ?? 0); i++) d.people.push(person(`p-in${i}`, `New${i}`, 'Hire', { startDate: '2026-10-19', hireNumber: 50 + i }))
    for (let i = 0; i < (opts.acceptedOffers ?? 0); i++) {
      d.offers.push({ id: `o-acc${i}`, applicationId: `a-acc${i}`, status: 'accepted' } as Offer)
    }
    for (let i = 0; i < (opts.convertedOffers ?? 0); i++) {
      d.offers.push({ id: `o-conv${i}`, applicationId: `a-conv${i}`, status: 'accepted', personId: `p-in${i}` } as Offer)
    }
    d.jobs[0].payMin = null
    d.jobs[0].payMax = null
  })
}

describe('postingBlockReason (hard stop 1)', () => {
  it('allows a post without a range below 15', () => {
    const db = withHeadcount(14)
    expect(postingHeadcount(db, FRI)).toEqual({ employed: 14, incoming: 0, acceptedOffers: 0, total: 14 })
    expect(postingBlockReason(db, 'j-fullstack', FRI)).toBeNull()
  })

  it('blocks at 15 when incoming hires are counted', () => {
    const db = withHeadcount(14, { incoming: 1 })
    expect(postingHeadcount(db, FRI).total).toBe(15)
    expect(postingBlockReason(db, 'j-fullstack', FRI)).toBe('At 15 employees, California requires a pay range on every job post (Labor Code 432.3).')
  })

  it('counts accepted offers not yet hired, without double counting converted ones', () => {
    expect(postingBlockReason(withHeadcount(13, { incoming: 1, acceptedOffers: 1 }), 'j-fullstack', FRI)).not.toBeNull()
    expect(postingHeadcount(withHeadcount(13, { incoming: 1, convertedOffers: 1 }), FRI).total).toBe(14)
  })

  it('stops counting an accepted offer once the candidate backs out', () => {
    const db = produce(withHeadcount(14), (d) => {
      d.offers.push({ id: 'o-alex', applicationId: 'a-alex', jobId: 'j-fullstack', candidateId: 'c-alex', status: 'accepted', version: 1 } as Offer)
    })
    expect(postingHeadcount(db, FRI).acceptedOffers).toBe(1)
    expect(postingBlockReason(db, 'j-fullstack', FRI)).not.toBeNull()
    const reneged = produce(db, (d) => {
      d.applications[0].status = 'withdrawn'
    })
    expect(postingHeadcount(reneged, FRI)).toMatchObject({ acceptedOffers: 0, total: 14 })
    expect(postingBlockReason(reneged, 'j-fullstack', FRI)).toBeNull()
  })

  it('stops counting someone after their last day and lifts the block once a range is set', () => {
    const db = produce(withHeadcount(15), (d) => {
      d.people[d.people.length - 1].endDate = '2026-09-30'
    })
    expect(postingBlockReason(db, 'j-fullstack', FRI)).toBeNull()
    const ranged = produce(withHeadcount(16), (d) => {
      d.jobs[0].payMin = 180_000
      d.jobs[0].payMax = 235_000
    })
    expect(postingBlockReason(ranged, 'j-fullstack', FRI)).toBeNull()
  })
})

describe('postingText', () => {
  it('includes the range, equity, benefits, no-salary-history line, Fair Chance, EEO and sponsorship', () => {
    const db = produce(fixtureDB(), (d) => {
      d.company.groupHealthPlanStartedOn = '2025-05-12'
    })
    const t = postingText(db, 'j-fullstack')
    expect(t.startsWith('Senior full-stack engineer\nSan Jose, CA (hybrid) | Full time\n')).toBe(true)
    expect(t).toContain('About Ledgerlark\nLedgerlark builds AI agents')
    expect(t).toContain("What you'll do")
    expect(t).toContain('Pay range: $180,000 to $235,000 base salary. This is a good-faith estimate of what we expect to pay.')
    expect(t).toContain('Equity: stock options of 0.1% to 0.35% of fully diluted shares, 4-year vesting with a 1-year cliff, then monthly.')
    expect(t).toContain('Benefits: medical, dental and vision coverage, 15 days of vacation a year, California paid sick leave and 11 paid company holidays.')
    expect(t).toContain('We never ask about salary history.')
    expect(t).toContain('Visa sponsorship for this role is considered case by case.')
    expect(t).toContain('in a manner consistent with the California Fair Chance Act')
    expect(t).toContain('Ledgerlark is an equal opportunity employer.')
    expect(t.includes(String.fromCharCode(0x2014))).toBe(false)
  })

  it('promises health coverage only once the company has a group health plan, never from the runway cost assumption', () => {
    const benefits = (db: DB, date?: string) => postingText(db, 'j-fullstack', date).split('\n').find((l) => l.startsWith('Benefits:'))
    const base = fixtureDB()
    expect(base.company.costModel.benefitsPerHeadMonthly).toBeGreaterThan(0)
    expect(base.company.groupHealthPlanStartedOn).toBeUndefined()
    expect(healthPlanUnrecorded(base)).toBe(true)
    expect(benefits(base)).toBe('Benefits: 15 days of vacation a year, California paid sick leave and 11 paid company holidays.')
    const none = produce(base, (d) => {
      d.company.groupHealthPlanStartedOn = null
    })
    expect(healthPlanUnrecorded(none)).toBe(false)
    expect(benefits(none)).not.toContain('medical')
    const starting = produce(base, (d) => {
      d.company.groupHealthPlanStartedOn = '2026-11-01'
    })
    expect(offersHealthPlanOn(starting, FRI)).toBe(false)
    expect(benefits(starting, FRI)).not.toContain('medical')
    expect(benefits(starting, '2026-11-01')).toContain('medical, dental and vision coverage')
  })

  it('lints clean on its own output', () => {
    const db = fixtureDB()
    expect(postingLint(db.jobs[0], postingText(db, 'j-fullstack'))).toEqual([])
  })

  it('handles hourly ranges, sales variable pay and missing ranges', () => {
    expect(payRangeLine({ payMin: 28, payMax: 34, flsa: 'non_exempt', employmentType: 'part_time' })).toBe(
      'Pay range: $28.00 to $34.00 an hour. This is a good-faith estimate of what we expect to pay.',
    )
    const db = produce(fixtureDB(), (d) => {
      d.jobs[0].familyId = 'f-gtm'
      d.jobs[0].sponsorship = 'no'
      d.jobs[0].payMin = null
    })
    const t = postingText(db, 'j-fullstack')
    expect(t).toContain('Plus variable pay (commission) targeted at 100% of base under a written plan.')
    expect(t).toContain('Pay range: available on request.')
    expect(t).toContain('We are not able to sponsor work visas for this role.')
  })
})

describe('postingLint', () => {
  it('flags a missing range and a missing Fair Chance statement', () => {
    const codes = postingLint({ payMin: null, payMax: 200_000, description: 'Build things.' }, 'Build things.').map((w) => w.code)
    expect(codes).toEqual(['missing_range', 'missing_fair_chance'])
    // Linting only the description skips the Fair Chance check (postingText adds it).
    expect(postingLint({ payMin: 1, payMax: 2, description: 'Build things.' })).toEqual([])
  })

  it('flags criminal-history screening, age-coded words, jargon and cannabis questions', () => {
    const text =
      'We want a young, energetic digital native, ideally a recent grad. Rockstar ninja wanted. No felons; clean record required. Do you use cannabis?'
    const warnings = postingLint({ payMin: 1, payMax: 2, description: text })
    const matches = warnings.map((w) => `${w.code}:${w.match}`)
    expect(matches).toEqual([
      'criminal_history:No felons',
      'criminal_history:clean record',
      'age_coded:young',
      'age_coded:energetic',
      'age_coded:digital native',
      'age_coded:recent grad',
      'jargon:Rockstar',
      'jargon:ninja',
      'cannabis:cannabis',
    ])
    expect(warnings.find((w) => w.code === 'age_coded')?.message).toBe('"young" reads as age-coded. Describe the skills and the work instead.')
  })

  it('does not trip on ordinary words', () => {
    expect(postingLint({ payMin: 1, payMax: 2, description: 'Youngstown office. Energy sector clients. Stage of company.' })).toEqual([])
    expect(postingLint({ payMin: 1, payMax: 2, description: 'We are a young company with a young team. Our evals weed out bad agent runs.' })).toEqual([])
    expect(postingLint({ payMin: 1, payMax: 2, description: 'Ask about weed use' }).map((w) => w.code)).toEqual(['cannabis'])
  })

  it('adds the Colorado note for remote roles without a range, labeled as needing review', () => {
    const [remote] = postingLint({ payMin: null, payMax: null, description: '', workMode: 'remote' })
    expect(remote.code).toBe('missing_range')
    expect(remote.message).toContain('Remote roles a Colorado resident could fill need a range at any size.')
    expect(remote.reviewNote).toBe('The Colorado rule is not verified here; confirm with counsel.')
    const [hybrid] = postingLint({ payMin: null, payMax: null, description: '', workMode: 'hybrid' })
    expect(hybrid.message).not.toContain('Colorado')
    expect(hybrid.reviewNote).toBeUndefined()
  })

  it('lints every role template posting clean', () => {
    const db = fixtureDB()
    for (const t of db.settings.roleTemplates) {
      const job = { ...db.jobs[0], id: `j-${t.id}`, title: t.name, familyId: t.familyId, levelId: t.levelId, description: t.jdOutline }
      const withJob = produce(db, (d) => {
        d.jobs.push(job)
      })
      expect(postingLint(job, postingText(withJob, job.id)).map((w) => `${t.id} ${w.code}:${w.match ?? ''}`)).toEqual([])
    }
  })
})

describe('salaryHistoryLint', () => {
  it('fires on questions about current or past pay', () => {
    for (const note of [
      'What is her current salary?',
      'He is making now about 210k',
      'Ask for previous salary',
      'Get their pay history',
      'what do you make at Stripe',
      'How much did you earn last year?',
      'Currently making 190',
      'How much are you making?',
      'What are you making these days',
      'Asked about her salary history',
      'salary history?',
      'She makes 180k now',
      'He is earning $210,000 at Ramp',
      'made 150K last year',
      'What is his comp history',
    ]) {
      expect(salaryHistoryLint(note)).toBe('Heads up: California bans asking about pay history. Ask about desired pay instead.')
    }
  })

  it('stays quiet for desired pay and our own posting line', () => {
    expect(salaryHistoryLint('Desired pay is $200K base')).toBeNull()
    expect(salaryHistoryLint('We never ask about salary history.')).toBeNull()
    expect(salaryHistoryLint('Great current role at Brex')).toBeNull()
    expect(salaryHistoryLint('We do not ask about salary history.')).toBeNull()
    expect(salaryHistoryLint('We will not ask about your pay history')).toBeNull()
    expect(salaryHistoryLint('Making 3 hires this quarter')).toBeNull()
    expect(salaryHistoryLint('Wants $210K base')).toBeNull()
  })
})

/** A job in New York: the fixture's first job moved to a remote New York location (or added to its locations). */
function inNewYork(db: DB, opts: { alsoHQ?: boolean } = {}): DB {
  return produce(db, (d) => {
    // minWageHourly is a placeholder: New York wage rules are not researched yet (LAW.md, issue #8).
    d.locations.push({ id: 'loc-remote-ny', name: 'Remote (New York)', kind: 'remote', state: 'NY', minWageHourly: 0 })
    d.jobs[0].locationIds = opts.alsoHQ ? ['loc-hq', 'loc-remote-ny'] : ['loc-remote-ny']
    d.jobs[0].workMode = 'remote'
  })
}

/** The fixture (4 people) cut down to its first `employed` people, plus incoming hires and accepted offers. */
function smallCompany(employed: number, opts: { incoming?: number; acceptedOffers?: number } = {}): DB {
  return produce(withHeadcount(0, opts), (d) => {
    const incoming = d.people.filter((p) => p.id.startsWith('p-in'))
    d.people = [...d.people.filter((p) => !p.id.startsWith('p-in')).slice(0, employed), ...incoming]
  })
}

describe('New York pay range (Labor Law 194-b, LAW.md ny-paytrans-4)', () => {
  const NY_REASON = 'At 4 employees, New York requires a pay range on every post for a job done at least in part in New York (Labor Law 194-b).'

  it('reads the states from the job locations, and the HQ state when it has none', () => {
    const db = inNewYork(fixtureDB(), { alsoHQ: true })
    expect([...jobStates(db, db.jobs[0])].sort()).toEqual(['CA', 'NY'])
    expect([...jobStates(db, { locationIds: [] })]).toEqual(['CA'])
    expect(payTransparencyRules(db, { locationIds: ['loc-hq'] }).map((r) => r.state)).toEqual(['CA'])
    expect(payTransparencyRules(db, db.jobs[0]).map((r) => `${r.state} ${r.threshold}`)).toEqual(['NY 4', 'CA 15'])
  })

  it('blocks a New York job without a range at 4, with the New York reason and citation', () => {
    const db = inNewYork(withHeadcount(4))
    expect(postingHeadcount(db, FRI).total).toBe(4)
    expect(postingBlockReason(db, 'j-fullstack', FRI)).toBe(NY_REASON)
    expect(postingBlockRule(db, 'j-fullstack', FRI)).toMatchObject({ state: 'NY', threshold: 4, citation: { label: 'Labor Law 194-b', url: 'https://www.nysenate.gov/legislation/laws/LAB/194-B' } })
  })

  it('counts incoming hires and accepted offers toward the 4, as in California', () => {
    const db = inNewYork(smallCompany(2, { incoming: 1, acceptedOffers: 1 }))
    expect(postingHeadcount(db, FRI)).toEqual({ employed: 2, incoming: 1, acceptedOffers: 1, total: 4 })
    expect(postingBlockReason(db, 'j-fullstack', FRI)).toBe(NY_REASON)
  })

  it('allows a New York job without a range below 4, while the same job in California stays postable until 15', () => {
    const three = inNewYork(smallCompany(3))
    expect(postingHeadcount(three, FRI).total).toBe(3)
    expect(postingBlockReason(three, 'j-fullstack', FRI)).toBeNull()
    expect(postingBlockReason(withHeadcount(4), 'j-fullstack', FRI)).toBeNull()
  })

  it('applies the lower threshold to a job in both California and New York', () => {
    expect(postingBlockReason(inNewYork(withHeadcount(4), { alsoHQ: true }), 'j-fullstack', FRI)).toBe(NY_REASON)
    expect(postingBlockReason(inNewYork(withHeadcount(16), { alsoHQ: true }), 'j-fullstack', FRI)).toBe(NY_REASON)
  })

  it('posts a New York job with a range, and prints the range and the description', () => {
    const db = produce(inNewYork(withHeadcount(16)), (d) => {
      d.jobs[0].payMin = 180_000
      d.jobs[0].payMax = 235_000
      d.jobs[0].description = 'Build the close agents.'
    })
    expect(postingBlockReason(db, 'j-fullstack', FRI)).toBeNull()
    const text = postingText(db, 'j-fullstack', FRI)
    expect(text).toContain('Remote (New York) (remote)')
    expect(text).toContain('Pay range: $180,000 to $235,000 base salary. This is a good-faith estimate of what we expect to pay.')
    expect(text).toContain('Build the close agents.')
    expect(postingLint(db.jobs[0], text, { db })).toEqual([])
  })

  it('warns about a missing range with the New York rule, and leaves the California warning as it was', () => {
    const db = inNewYork(withHeadcount(1))
    const [ny] = postingLint({ ...db.jobs[0], description: 'Build things.' }, undefined, { db })
    expect(ny.code).toBe('missing_range')
    expect(ny.message).toContain('New York requires it on every post for this job once you have 4 employees (Labor Law 194-b).')
    expect(ny.citation).toEqual({ label: 'Labor Law 194-b', url: 'https://www.nysenate.gov/legislation/laws/LAB/194-B' })
    const ca = { ...fixtureDB().jobs[0], payMin: null, payMax: null, description: 'Build things.' }
    const [caWarning] = postingLint(ca, undefined, { db: fixtureDB() })
    expect(caWarning).toEqual(postingLint(ca)[0])
    expect(caWarning.message).not.toContain('New York')
    expect(caWarning.citation?.label).toBe('Labor Code 432.3')
  })

  it('asks for a job description and a range per location on a New York post', () => {
    const db = produce(inNewYork(fixtureDB(), { alsoHQ: true }), (d) => {
      d.jobs[0].payMin = 1
      d.jobs[0].payMax = 2
      d.jobs[0].description = '   '
    })
    expect(postingLint(db.jobs[0], undefined, { db }).map((w) => w.code)).toEqual(['ny_description', 'ny_range_per_location'])
    // Without the db the linter cannot see the locations, so it stays as it was.
    expect(postingLint(db.jobs[0])).toEqual([])
  })
})
