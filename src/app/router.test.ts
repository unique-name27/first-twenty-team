// The hash router's parsing (the hook itself needs a window and is covered by the route walks).
import { describe, expect, it } from 'vitest'
import { links, parse } from './router'

describe('parse', () => {
  it('splits the hash into a view and segments', () => {
    expect(parse('#person.p-founder.equity')).toEqual({ view: 'person', segments: ['person', 'p-founder', 'equity'], raw: 'person.p-founder.equity' })
    expect(parse('')).toEqual({ view: 'home', segments: [], raw: '' })
  })

  it('decodes %-escapes and keeps a broken one as typed instead of throwing', () => {
    expect(parse('#job.j%2Dstaff').segments).toEqual(['job', 'j-staff'])
    expect(() => parse('#job.%E0%A4%A')).not.toThrow()
    expect(parse('#job.%E0%A4%A')).toEqual({ view: 'job', segments: ['job', '%E0%A4%A'], raw: 'job.%E0%A4%A' })
  })
})

describe('links', () => {
  it('builds the candidate offer link, which parses back to the candidate page with the application', () => {
    expect(links.candidateOffer('c-104', 'a-7')).toBe('#candidate.c-104.offer.a-7')
    expect(parse(links.candidateOffer('c-104', 'a-7'))).toEqual({ view: 'candidate', segments: ['candidate', 'c-104', 'offer', 'a-7'], raw: 'candidate.c-104.offer.a-7' })
    expect(links.candidate('c-104')).toBe('#candidate.c-104')
  })
})
