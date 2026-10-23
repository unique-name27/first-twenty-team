import { describe, expect, it, vi } from 'vitest'
import { fixtureDB } from '@/domain/hiring/testkit'
import type { Interview, InterviewStep, Job, JobStage, Offer } from '@/domain/types'
import {
  clockLabel,
  confirmationBody,
  defaultStepFor,
  drillRows,
  durationChoices,
  expiryPhrase,
  formatForStage,
  looksLikeEmail,
  metricsRange,
  offerPulseLine,
  orderedSteps,
  pickedStart,
  pickTimes,
  pulseJobs,
  pulseOfferLines,
  ratingTone,
  ratingWord,
  referralStatus,
  splitName,
} from './logic'
import { canSeeKitBand, conversionText, interviewsEmptyText, medianDaysText, referralRows, splitMoney } from './logic'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

const stages: JobStage[] = [
  { id: 'new', kind: 'new', name: 'New', slaBusinessDays: 3 },
  { id: 'intro', kind: 'intro', name: 'Intro call', slaBusinessDays: 5 },
  { id: 'technical', kind: 'technical', name: 'Technical', slaBusinessDays: 5 },
  { id: 'onsite', kind: 'onsite', name: 'Onsite', slaBusinessDays: 3 },
  { id: 'offer', kind: 'offer', name: 'Offer' },
  { id: 'hired', kind: 'hired', name: 'Hired' },
]

function step(id: string, stageId: string): InterviewStep {
  return { id, stageId, name: id, durationMin: 45, interviewerIds: [], attributes: [] }
}

const job = { stages, interviewPlan: [step('s-onsite-b', 'onsite'), step('s-intro', 'intro'), step('s-tech', 'technical'), step('s-onsite-a', 'onsite')] } as Pick<Job, 'stages' | 'interviewPlan'>

function iv(stepId: string, status: Interview['status'] = 'scheduled'): Interview {
  return { id: `i-${stepId}`, applicationId: 'a1', stepId, stageId: 'x', name: stepId, startsAt: '2026-10-12T17:00:00.000Z', durationMin: 30, interviewerIds: [], format: 'video', status, attributes: [] }
}

describe('interview steps', () => {
  it('orders steps by the job stage order', () => {
    expect(orderedSteps(job).map((s) => s.id)).toEqual(['s-intro', 's-tech', 's-onsite-b', 's-onsite-a'])
  })

  it('picks the first unscheduled step from the current stage forward', () => {
    expect(defaultStepFor(job, { stageId: 'intro' }, [])?.id).toBe('s-intro')
    expect(defaultStepFor(job, { stageId: 'intro' }, [iv('s-intro')])?.id).toBe('s-tech')
    expect(defaultStepFor(job, { stageId: 'onsite' }, [iv('s-onsite-b')])?.id).toBe('s-onsite-a')
  })

  it('treats cancelled and no-show interviews as not scheduled', () => {
    expect(defaultStepFor(job, { stageId: 'intro' }, [iv('s-intro', 'cancelled')])?.id).toBe('s-intro')
  })

  it('falls back to the current stage step when everything is scheduled', () => {
    const all = ['s-intro', 's-tech', 's-onsite-a', 's-onsite-b'].map((s) => iv(s))
    expect(defaultStepFor(job, { stageId: 'technical' }, all)?.id).toBe('s-tech')
    expect(defaultStepFor({ stages, interviewPlan: [] }, { stageId: 'intro' }, [])).toBeUndefined()
  })

  it('suggests on site for onsite rounds and video otherwise', () => {
    expect(formatForStage('onsite')).toBe('onsite')
    expect(formatForStage('intro')).toBe('video')
    expect(formatForStage(undefined)).toBe('video')
  })

  it('always offers the step duration among the length chips', () => {
    expect(durationChoices(45)).toEqual([30, 45, 60, 75, 90])
    expect(durationChoices(180)).toEqual([30, 45, 60, 75, 90, 180])
  })
})

describe('picked times', () => {
  it('labels Pacific clock times', () => {
    expect(clockLabel(9, 0)).toBe('9:00 AM')
    expect(clockLabel(12, 0)).toBe('12:00 PM')
    expect(clockLabel(15, 30)).toBe('3:30 PM')
    expect(pickTimes()[0].label).toBe('9:00 AM')
  })

  it('converts a Pacific date and time to UTC with daylight time, moving weekends to Monday', () => {
    expect(pickedStart('2026-10-12', 10, 0)).toBe('2026-10-12T17:00:00.000Z') // PDT
    expect(pickedStart('2026-11-16', 10, 0)).toBe('2026-11-16T18:00:00.000Z') // PST
    expect(pickedStart('2026-10-10', 9, 0)).toBe('2026-10-12T16:00:00.000Z') // Saturday -> Monday
  })
})

describe('ratings', () => {
  it('words and tones never use red and have no neutral', () => {
    expect([1, 2, 3, 4].map((r) => ratingWord(r as 1))).toEqual(['Strong no', 'No', 'Yes', 'Strong yes'])
    expect(ratingTone(4)).toBe('good')
    expect(ratingTone(3)).toBe('good')
    expect(ratingTone(2)).toBe('warn')
    expect(ratingTone(1)).toBe('warn')
    expect(ratingTone(undefined)).toBe('outline')
  })
})

describe('pulse lines', () => {
  const base = { expiresOn: '2026-10-14', startDate: '2026-11-09' }
  it('describes outstanding offers in plain words', () => {
    expect(offerPulseLine({ ...base, status: 'sent' }, 'Danielle Brooks', '2026-10-09')).toBe('Offer out to Danielle Brooks, expires in 5 days')
    expect(offerPulseLine({ ...base, status: 'awaiting_approval' }, 'Daniel Reyes', '2026-10-09')).toBe('Offer for Daniel Reyes waiting for approval')
    expect(offerPulseLine({ ...base, status: 'accepted' }, 'Lucas Ferreira', '2026-10-09')).toBe('Lucas Ferreira accepted, starts Mon, Nov 9')
    expect(offerPulseLine({ ...base, status: 'declined' }, 'X', '2026-10-09')).toBeNull()
  })

  it('phrases expiry relative to today', () => {
    expect(expiryPhrase('2026-10-09', '2026-10-09')).toBe('Expires today')
    expect(expiryPhrase('2026-10-10', '2026-10-09')).toBe('Expires tomorrow')
    expect(expiryPhrase('2026-10-08', '2026-10-09')).toBe('Expired Thu, Oct 8')
  })

  it('lowercases only the leading word mid-sentence, keeping day and month names capitalized', () => {
    expect(expiryPhrase('2026-10-14', '2026-10-19', { midSentence: true })).toBe('expired Wed, Oct 14')
    expect(expiryPhrase('2026-10-09', '2026-10-09', { midSentence: true })).toBe('expires today')
    expect(expiryPhrase('2026-10-14', '2026-10-09', { midSentence: true })).toBe('expires in 5 days')
  })

  it('phrases a sent offer past its expiry as expired, not out', () => {
    expect(offerPulseLine({ ...base, status: 'sent', expiresOn: '2026-10-16' }, 'Kenji Mori', '2026-10-19')).toBe('Offer to Kenji Mori expired Fri, Oct 16')
    expect(offerPulseLine({ ...base, status: 'sent', expiresOn: '2026-10-19' }, 'Kenji Mori', '2026-10-19')).toBe('Offer out to Kenji Mori, expires today')
  })

  it('keeps an offer marked expired in the pulse while the candidate is still active', () => {
    expect(offerPulseLine({ ...base, status: 'expired', expiresOn: '2026-10-16' }, 'Rosa Delgado', '2026-10-19')).toBe('Offer to Rosa Delgado expired Fri, Oct 16')
    expect(offerPulseLine({ ...base, status: 'expired', expiresOn: '2026-10-16' }, 'Rosa Delgado', '2026-10-19', { appActive: true })).toBe('Offer to Rosa Delgado expired Fri, Oct 16')
    expect(offerPulseLine({ ...base, status: 'expired', expiresOn: '2026-10-16' }, 'Rosa Delgado', '2026-10-19', { appActive: false })).toBeNull()
  })

  describe('jobs and lines', () => {
    const offer = (id: string, applicationId: string, candidateId: string, extra: Partial<Offer>): Offer =>
      ({
        id,
        applicationId,
        candidateId,
        jobId: 'j-fullstack',
        version: 1,
        status: 'sent',
        expiresOn: '2026-10-16',
        startDate: '2026-11-09',
        createdOn: '2026-10-05',
        ...extra,
      }) as Offer
    const withOffers = (jobStatus: Job['status'], offers: Offer[]) => {
      const db = fixtureDB()
      const job = db.jobs.find((j) => j.id === 'j-fullstack')
      if (job) job.status = jobStatus
      db.offers.push(...offers)
      return db
    }

    it('lists an expired offer for an active candidate, and drops it once the application closes', () => {
      const db = withOffers('open', [offer('o-1', 'a-alex', 'c-alex', { status: 'expired' })])
      expect(pulseOfferLines(db, 'j-fullstack', '2026-10-19')).toEqual(['Offer to Alex Kim expired Fri, Oct 16'])
      const alex = db.applications.find((a) => a.id === 'a-alex')
      if (alex) alex.status = 'rejected'
      expect(pulseOfferLines(db, 'j-fullstack', '2026-10-19')).toEqual([])
    })

    it('speaks for the newest offer version only', () => {
      const db = withOffers('open', [offer('o-1', 'a-alex', 'c-alex', { status: 'rescinded' }), offer('o-2', 'a-alex', 'c-alex', { version: 2, status: 'awaiting_approval' })])
      expect(pulseOfferLines(db, 'j-fullstack', '2026-10-09')).toEqual(['Offer for Alex Kim waiting for approval'])
    })

    it('keeps a filled job in the pulse while an offer on it is still out', () => {
      const hired = offer('o-1', 'a-alex', 'c-alex', { status: 'accepted', personId: 'p-new' })
      expect(pulseJobs(withOffers('filled', [hired])).map((j) => j.id)).toEqual([])
      for (const status of ['sent', 'awaiting_approval', 'approved'] as const) {
        const db = withOffers('filled', [hired, offer('o-2', 'a-ben', 'c-ben', { status })])
        expect(pulseJobs(db).map((j) => j.id)).toEqual(['j-fullstack'])
      }
      const acceptedNotStarted = withOffers('filled', [hired, offer('o-2', 'a-ben', 'c-ben', { status: 'accepted' })])
      expect(pulseJobs(acceptedNotStarted).map((j) => j.id)).toEqual(['j-fullstack'])
      expect(pulseOfferLines(acceptedNotStarted, 'j-fullstack', '2026-10-09')).toEqual(['Alex Kim accepted, starts Mon, Nov 9', 'Ben Ortiz accepted, starts Mon, Nov 9'])
      expect(pulseJobs(withOffers('filled', [hired, offer('o-2', 'a-ben', 'c-ben', { status: 'declined' })]))).toEqual([])
      expect(pulseJobs(withOffers('closed', [offer('o-2', 'a-ben', 'c-ben', { status: 'sent' })]))).toEqual([])
      expect(pulseJobs(withOffers('open', [])).map((j) => j.id)).toEqual(['j-fullstack'])
    })

    it('keeps a filled job while its expired offer to an active candidate waits for a decision', () => {
      const hired = offer('o-1', 'a-alex', 'c-alex', { status: 'accepted', personId: 'p-new' })
      const db = withOffers('filled', [hired, offer('o-2', 'a-ben', 'c-ben', { status: 'expired', expiresOn: '2026-10-14' })])
      expect(pulseJobs(db).map((j) => j.id)).toEqual(['j-fullstack'])
      expect(pulseOfferLines(db, 'j-fullstack', '2026-10-19')).toEqual(['Alex Kim accepted, starts Mon, Nov 9', 'Offer to Ben Ortiz expired Wed, Oct 14'])
      // Once the application closes, the job drops out of the pulse.
      const ben = db.applications.find((a) => a.id === 'a-ben')
      if (ben) ben.status = 'withdrawn'
      expect(pulseJobs(db)).toEqual([])
      // A sent offer past its expiry (not marked expired yet) keeps the job too.
      const lapsed = withOffers('filled', [hired, offer('o-2', 'a-ben', 'c-ben', { status: 'sent', expiresOn: '2026-10-14' })])
      expect(pulseJobs(lapsed).map((j) => j.id)).toEqual(['j-fullstack'])
      expect(pulseOfferLines(lapsed, 'j-fullstack', '2026-10-19')).toEqual(['Alex Kim accepted, starts Mon, Nov 9', 'Offer to Ben Ortiz expired Wed, Oct 14'])
    })
  })
})

describe('referrals', () => {
  it('splits a full name and checks an email lightly', () => {
    expect(splitName('  Jordan  Lee Park ')).toEqual({ firstName: 'Jordan', lastName: 'Lee Park' })
    expect(splitName('Cher')).toEqual({ firstName: 'Cher', lastName: '' })
    expect(looksLikeEmail('jordan@example.com')).toBe(true)
    expect(looksLikeEmail('jordan@example')).toBe(false)
  })

  it('shows referrers the stage only', () => {
    const db = { jobs: [{ id: 'j1', stages } as unknown as Job] }
    expect(referralStatus(db, { status: 'active', stageId: 'new', jobId: 'j1' })).toBe('New, in review')
    expect(referralStatus(db, { status: 'active', stageId: 'technical', jobId: 'j1' })).toBe('In technical')
    expect(referralStatus(db, { status: 'rejected', stageId: 'technical', jobId: 'j1' })).toBe('Closed')
    expect(referralStatus(db, { status: 'hired', stageId: 'hired', jobId: 'j1' })).toBe('Hired')
  })
})

describe('metrics helpers', () => {
  it('caps drill-down rows, newest applied first', () => {
    const apps = Array.from({ length: 70 }, (_, i) => ({ id: `a${i}`, appliedOn: `2026-01-${String((i % 28) + 1).padStart(2, '0')}` }))
    const { rows, more } = drillRows(apps, 60)
    expect(rows).toHaveLength(60)
    expect(more).toBe(10)
    expect(rows[0].appliedOn >= rows[59].appliedOn).toBe(true)
  })

  it('builds date ranges', () => {
    expect(metricsRange('90d', '2026-10-09', '2025-02-03')).toEqual({ from: '2026-07-11', to: '2026-10-09' })
    expect(metricsRange('all', '2026-10-09', '2025-02-03').from < '2025-02-03').toBe(true)
  })
})

describe('confirmation message', () => {
  it('names the time, length, format and panel, with no em dashes', () => {
    const body = confirmationBody({
      firstName: 'Ritika',
      interviewName: 'Agent design deep dive',
      when: 'Mon, Oct 12, 10:00 AM PT (1:00 PM ET)',
      durationMin: 75,
      format: 'video',
      panel: ['Hannah Kim', 'Ravi Subramanian'],
      companyName: 'Ledgerlark',
      senderName: 'Maya Raman',
    })
    expect(body).toContain('You are confirmed for the agent design deep dive with Ledgerlark')
    expect(body).toContain('Mon, Oct 12, 10:00 AM PT (1:00 PM ET)')
    expect(body).toContain('It runs 75 minutes, on video')
    expect(body).toContain('You will meet Hannah Kim and Ravi Subramanian.')
    expect(body).not.toMatch(/—/)
  })

  it('puts the video link in the message, or promises one, and never claims an attachment', () => {
    const base = { firstName: 'R', interviewName: 'Intro call', when: 'x', durationMin: 30, format: 'video' as const, panel: [], companyName: 'C', senderName: 'S' }
    const linked = confirmationBody({ ...base, videoLink: 'https://meet.example.com/room' })
    expect(linked).toContain('It runs 30 minutes, on video.')
    expect(linked).toContain('Join here: https://meet.example.com/room')
    const bare = confirmationBody(base)
    expect(bare).toContain('It runs 30 minutes, on video. I will send the video link before the call.')
    for (const body of [linked, bare, confirmationBody({ ...base, format: 'onsite' }), confirmationBody({ ...base, format: 'phone' })]) {
      expect(body).not.toMatch(/attached|attachment|in the calendar invite/i)
    }
    expect(confirmationBody({ ...base, format: 'phone', videoLink: 'https://x' })).not.toContain('https://x')
  })

  it('says when an interview moved, and asks to drop the old time', () => {
    const body = confirmationBody({
      firstName: 'Maya',
      interviewName: 'Intro call',
      when: 'Thu, Oct 15, 10:00 AM PT',
      movedFrom: 'Tue, Oct 13, 1:00 PM PT',
      durationMin: 30,
      format: 'video',
      panel: [],
      companyName: 'Ledgerlark',
      senderName: 'S',
    })
    expect(body).toContain('Your intro call with Ledgerlark has moved from Tue, Oct 13, 1:00 PM PT to:\n\nThu, Oct 15, 10:00 AM PT')
    expect(body).toContain('Please take the old time off your calendar.')
    expect(body).not.toContain('You are confirmed')
  })

  it('keeps acronyms in interview names', () => {
    const body = confirmationBody({ firstName: 'A', interviewName: 'LLM systems review', when: 'x', durationMin: 30, format: 'onsite', panel: [], companyName: 'C', address: '99 S Almaden Blvd', senderName: 'S' })
    expect(body).toContain('the LLM systems review')
    expect(body).toContain('at our office (99 S Almaden Blvd)')
  })
})

describe('money in free text', () => {
  it('splits dollar amounts out of notes so they can be blurred', () => {
    const parts = splitMoney('Wanted $240,000 base, above the $230K top of the range.')
    expect(parts.filter((p) => p.money).map((p) => p.text)).toEqual(['$240,000', '$230K'])
    expect(parts.map((p) => p.text).join('')).toBe('Wanted $240,000 base, above the $230K top of the range.')
  })

  it('leaves text without amounts alone and does not swallow words after K or M', () => {
    expect(splitMoney('Chose another offer')).toEqual([{ text: 'Chose another offer', money: false }])
    expect(splitMoney('$1.2M Series A, $5 Million').filter((p) => p.money).map((p) => p.text)).toEqual(['$1.2M', '$5'])
  })
})

describe('your referrals', () => {
  it('lists people the teammate referred with the stage only', () => {
    const db = fixtureDB()
    const rows = referralRows(db, 'p-priya')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ candidateId: 'c-ben', jobId: 'j-fullstack', status: 'In intro call', tone: 'accent' })
  })

  it('shows a referral of someone already on file the same way as a new referral', () => {
    const db = fixtureDB()
    // Alex is already in Onsite; Jasmine refers Alex without knowing.
    const alex = db.candidates.find((c) => c.id === 'c-alex')
    if (!alex) throw new Error('fixture')
    alex.otherReferrals = [{ referrerId: 'p-jasmine', jobId: 'j-fullstack', on: '2026-10-10' }]
    const rows = referralRows(db, 'p-jasmine')
    expect(rows).toEqual([{ key: 'ref-c-alex:j-fullstack', candidateId: 'c-alex', jobId: 'j-fullstack', on: '2026-10-10', status: 'New, in review', tone: 'accent' }])
    // A brand-new referral reads the same on day one.
    expect(referralStatus(db, { status: 'active', stageId: 'new', jobId: 'j-fullstack' })).toBe('New, in review')
  })

  it('closes a duplicate referral when the job closes, and follows an application added after it', () => {
    const db = fixtureDB()
    const chen = db.candidates.find((c) => c.id === 'c-chen')
    if (!chen) throw new Error('fixture')
    chen.otherReferrals = [{ referrerId: 'p-jasmine', jobId: 'j-fullstack', on: '2026-09-01' }]
    // Chen's application (Sep 21) came after the referral, so its stage shows.
    expect(referralRows(db, 'p-jasmine')[0].status).toBe('New, in review')
    const app = db.applications.find((a) => a.id === 'a-chen')
    if (!app) throw new Error('fixture')
    app.stageId = 'intro'
    expect(referralRows(db, 'p-jasmine')[0].status).toBe('In intro call')
    chen.otherReferrals = [{ referrerId: 'p-jasmine', jobId: 'j-fullstack', on: '2026-10-10' }]
    const job = db.jobs.find((j) => j.id === 'j-fullstack')
    if (!job) throw new Error('fixture')
    job.status = 'filled'
    expect(referralRows(db, 'p-jasmine')[0]).toMatchObject({ status: 'Closed', tone: 'neutral' })
  })

  it('returns nothing without a person', () => {
    expect(referralRows(fixtureDB(), null)).toEqual([])
  })
})

describe('kit bands', () => {
  it('shows every band to Admin and none to employees', () => {
    const db = fixtureDB()
    expect(canSeeKitBand({ role: 'admin', personId: null }, db, 'f-ops', 'lv-l3')).toBe(true)
    expect(canSeeKitBand({ role: 'employee', personId: 'p-tomas' }, db, 'f-eng', 'lv-l3')).toBe(false)
  })

  it("shows a manager the bands for their own level, their reports' levels and the jobs they hire for", () => {
    const db = fixtureDB()
    const tomas = { role: 'manager' as const, personId: 'p-tomas' }
    // Hiring manager for the full-stack L3 job.
    expect(canSeeKitBand(tomas, db, 'f-eng', 'lv-l3')).toBe(true)
    // Own level.
    expect(canSeeKitBand(tomas, db, 'f-eng', 'lv-l4')).toBe(true)
    // Ops is not his team.
    expect(canSeeKitBand(tomas, db, 'f-ops', 'lv-l3')).toBe(false)
    // Once Jasmine reports to him, her level's band shows.
    const jasmine = db.people.find((p) => p.id === 'p-jasmine')
    if (!jasmine) throw new Error('fixture')
    jasmine.managerId = 'p-tomas'
    expect(canSeeKitBand(tomas, db, 'f-ops', 'lv-l3', '2026-10-10')).toBe(true)
    // A closed job no longer opens its band.
    const job = db.jobs.find((j) => j.id === 'j-fullstack')
    if (!job) throw new Error('fixture')
    job.status = 'closed'
    job.levelId = 'lv-l5'
    expect(canSeeKitBand(tomas, db, 'f-eng', 'lv-l5')).toBe(false)
  })
})

describe('metric wording', () => {
  it('names the base of a conversion so it reads next to the count above it', () => {
    expect(conversionText({ n: 135, d: 313, small: false, text: '43%' }, 'Intro call')).toBe('43% of the 313 who reached intro call')
    expect(conversionText({ n: 2, d: 3, small: true, text: '2 of 3 (small n)' }, 'Onsite')).toBe('2 of the 3 who reached onsite (small n)')
    expect(conversionText({ n: 0, d: 0, small: true, text: 'None yet' }, 'Offer')).toBe('None yet from offer')
    expect(conversionText({ n: 1200, d: 2925, small: false, text: '41%' }, 'Applied')).toBe('41% of the 2,925 who applied')
  })

  it('explains a missing median instead of printing None', () => {
    expect(medianDaysText(33.4, 3)).toBe('33 days')
    expect(medianDaysText(1, 1)).toBe('1 day')
    expect(medianDaysText(null, 0)).toBe('No hires yet')
    expect(medianDaysText(null, 2)).toBe('Not recorded')
  })
})

describe('interviews panel with no interviews (post-merge: a rejected candidate told Admin "Interviews you are on will show here")', () => {
  it('tells someone who sees every interview whether any were held', () => {
    expect(interviewsEmptyText({ seesAll: true, active: true })).toBe('None are scheduled yet.')
    expect(interviewsEmptyText({ seesAll: true, active: false })).toBe('None were held while the application was open.')
  })

  it('tells an interviewer, who sees only their own, that theirs show here', () => {
    expect(interviewsEmptyText({ seesAll: false, active: true })).toBe('Interviews you are on will show here.')
    expect(interviewsEmptyText({ seesAll: false, active: false })).toBe('Interviews you are on will show here.')
  })
})
