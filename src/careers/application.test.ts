// The live careers application: what the form accepts, and the records it becomes, which must match what
// Add candidate makes in the app (addCandidate in src/domain/hiring/candidates.ts) for the same person.
import type { Draft } from 'immer'
import { describe, expect, it } from 'vitest'
import { buildSampleDB, SAMPLE_ANCHOR } from '@/data/seed'
import { addCandidate } from '@/domain/hiring/candidates'
import type { DB, Job } from '@/domain/types'
import { applicationRecords, CAREERS_SOURCE_DETAIL, parseApplication, webAddress } from './application'

const ok = { name: 'Rosa Alvarez Diaz', email: 'rosa@example.com', phone: '+1 (408) 555-0134', link: 'linkedin.com/in/rosa', answer: 'I rebuilt our month-end close checklist and cut it from nine days to five.' }

function parsed(form: Record<string, string | undefined>) {
  const r = parseApplication(form)
  if (!r.ok) throw new Error(`not ok: ${JSON.stringify(r.errors)}`)
  return r.input
}

describe('parseApplication', () => {
  it('accepts a complete application and splits the name', () => {
    expect(parsed(ok)).toEqual({
      firstName: 'Rosa',
      lastName: 'Alvarez Diaz',
      email: 'rosa@example.com',
      phone: '+1 (408) 555-0134',
      link: { kind: 'linkedin', url: 'https://linkedin.com/in/rosa' },
      answer: ok.answer,
    })
    const bare = parsed({ name: 'Rosa', email: 'rosa@example.com', answer: ok.answer })
    expect(bare).toEqual({ firstName: 'Rosa', lastName: '', email: 'rosa@example.com', answer: ok.answer })
  })

  it('says what is wrong with each field, in the demo form words', () => {
    const r = parseApplication({ name: ' ', email: 'rosa@', phone: '12', link: 'not a link', answer: 'Too short.' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual({
      name: 'Enter your full name.',
      email: 'Enter an email address in the format name@example.com.',
      phone: 'Enter a phone number with at least 7 digits, or leave it blank.',
      link: 'Enter a web address, like linkedin.com/in/yourname, or leave it blank.',
      answer: 'Write at least a sentence (20 characters or more).',
    })
    const empty = parseApplication({})
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.errors).toEqual({ name: 'Enter your full name.', email: 'Enter your email address.', answer: 'Answer the question about this role.' })
  })

  it('refuses fields over their length, and gives back no more than each field takes', () => {
    const r = parseApplication({ ...ok, name: 'R'.repeat(121), email: `${'a'.repeat(250)}@example.com`, phone: `+1 ${'5'.repeat(40)}`, link: `example.com/${'x'.repeat(300)}`, answer: 'y'.repeat(2001) })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(Object.keys(r.errors).sort()).toEqual(['answer', 'email', 'link', 'name', 'phone'])
    expect(r.errors.name).toBe('Shorten your name to 120 characters or fewer.')
    expect(r.errors.answer).toBe('Shorten your answer to 2000 characters or fewer.')
    expect(r.values.name).toHaveLength(120)
    expect(r.values.answer).toHaveLength(2000)
    expect(r.values.link).toHaveLength(300)
  })

  it('removes control and direction-override characters, keeps line breaks in the answer', () => {
    const input = parsed({ ...ok, name: 'Rosa‮ zaid\u0000\tAlvarez', answer: `First line\r\nSecond line\u0007 with a bell${'.'.repeat(10)}` })
    expect(input.firstName).toBe('Rosa')
    expect(input.lastName).toBe('zaid Alvarez')
    expect(input.answer).toBe(`First line\nSecond line with a bell${'.'.repeat(10)}`)
  })

  it('takes only plain web addresses, and files each link where the candidate keeps it', () => {
    expect(webAddress('linkedin.com/in/rosa')).toBe('https://linkedin.com/in/rosa')
    expect(webAddress('http://rosa.dev')).toBe('http://rosa.dev/')
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://example.com/x', 'https://user:pw@example.com', 'https://localhost/x', 'https://10.0.0.1/', 'mailto:a@b.co', 'example']) {
      expect(webAddress(bad), bad).toBeNull()
    }
    expect(parsed({ ...ok, link: 'https://www.linkedin.com/in/rosa' }).link?.kind).toBe('linkedin')
    expect(parsed({ ...ok, link: 'github.com/rosa' }).link?.kind).toBe('github')
    expect(parsed({ ...ok, link: 'https://rosa.dev/Resume.PDF' }).link?.kind).toBe('resume')
    expect(parsed({ ...ok, link: 'rosa.dev' }).link).toEqual({ kind: 'portfolio', url: 'https://rosa.dev/' })
    expect(parsed({ ...ok, link: '' }).link).toBeUndefined()
  })

  it('refuses a form whose hidden field was filled, and never gives that field back', () => {
    const r = parseApplication({ ...ok, website: 'http://spam.example' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(Object.keys(r.errors)).toEqual(['website'])
    expect(Object.keys(r.values)).not.toContain('website')
  })

  it('accepts emails the HTML email field accepts, with a real top-level domain', () => {
    for (const good of ['a@b.co', 'first.last+jobs@sub.example.org', "o'brien@example.ie"]) expect(parseApplication({ ...ok, email: good }).ok, good).toBe(true)
    for (const bad of ['a@b', 'a b@example.com', 'a@example.c', '<a@example.com>', 'a@-example.com', 'a@example.com\u0000']) {
      const r = parseApplication({ ...ok, email: bad })
      expect(r.ok && r.input.email, bad).not.toBe(bad)
    }
  })
})

describe('applicationRecords', () => {
  const date = SAMPLE_ANCHOR
  const sample = () => structuredClone(buildSampleDB()) as DB
  const openJob = (db: DB) => db.jobs.find((j) => j.status === 'open' && j.postedOn) as Job

  it('makes the candidate and application that Add candidate makes in the app', () => {
    const db = sample()
    const job = openJob(db)
    const input = parsed(ok)
    const ours = applicationRecords({ db, job, input, question: 'Why?', date, at: '2026-10-09T19:00:00.000Z' })
    const app = sample()
    const made = addCandidate(app as Draft<DB>, {
      id: ours.candidate.id,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      linkedin: input.link?.url,
      source: 'inbound',
      sourceDetail: CAREERS_SOURCE_DETAIL,
    }, { date, jobId: job.id })
    const theirs = {
      candidate: app.candidates.find((c) => c.id === made.candidateId),
      application: app.applications.find((a) => a.id === made.applicationId),
    }
    expect(ours.candidate).toEqual(theirs.candidate)
    expect({ ...ours.application, id: 'x' }).toEqual({ ...theirs.application, id: 'x' })
    expect(ours.application.nextStep?.text).toBe('Review application')
    expect(ours.candidate.sourceDetail).toBe('Careers site')
  })

  it('logs who applied and their answer, with no one in the company as the actor', () => {
    const db = sample()
    const job = openJob(db)
    const r = applicationRecords({ db, job, input: parsed(ok), question: 'What made you apply?', date, at: '2026-10-09T19:00:00.000Z' })
    expect(r.activity.map((a) => [a.entityType, a.kind])).toEqual([
      ['candidate', 'candidate_added'],
      ['application', 'application_added'],
      ['candidate', 'note'],
    ])
    for (const a of r.activity) {
      expect(a.actorId).toBeNull()
      expect(a.viewingAs).toBeUndefined()
      expect(a.at).toBe('2026-10-09T19:00:00.000Z')
    }
    expect(r.activity[0].text).toBe('Rosa Alvarez Diaz applied on the careers site')
    expect(r.activity[1].relatedId).toBe(r.candidate.id)
    expect(r.activity[2].text).toContain('What made you apply?')
    expect(r.activity[2].text).toContain(ok.answer)
    expect(new Set([r.candidate.id, r.application.id, ...r.activity.map((a) => a.id)]).size).toBe(5)
  })

  it('starts in the job first stage, with its next step, and owners who still work there', () => {
    const db = sample()
    const job: Job = { ...openJob(db), stages: [{ id: 'screen', kind: 'recruiter_screen', name: 'Recruiter screen' }, { id: 'hired', kind: 'hired', name: 'Hired' }] }
    const founder = db.people.find((p) => p.isFounder)!
    const r = applicationRecords({ db, job, input: parsed(ok), question: 'Q', date, at: '2026-10-09T19:00:00.000Z' })
    expect(r.application.stageId).toBe('screen')
    expect(r.application.history).toEqual([{ stageId: 'screen', at: date }])
    expect(r.application.nextStep?.text).toBe('Schedule recruiter screen')
    // A hiring manager who left hands the next step to a founder.
    const gone = { ...job, hiringManagerId: 'p-nobody' }
    expect(applicationRecords({ db, job: gone, input: parsed(ok), question: 'Q', date, at: 'x' }).application.nextStep?.ownerId).toBe(founder.id)
    const hired = { ...job, stages: [{ id: 'hired', kind: 'hired' as const, name: 'Hired' }] }
    expect(applicationRecords({ db, job: hired, input: parsed(ok), question: 'Q', date, at: 'x' }).application.nextStep).toBeUndefined()
  })
})
