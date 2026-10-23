import { describe, expect, it, vi } from 'vitest'
import { findDuplicates, githubUser, linkedinSlug, parseCandidateBlob, phoneDigits } from './parse'
import { fixtureDB } from './testkit'

vi.mock('@/data/seed', async () => {
  const { blankDB } = await import('@/data/blank')
  return { SAMPLE_ANCHOR: '2026-10-09', buildSampleDB: () => blankDB({ companyName: 'Fixture', founderFirstName: 'F', founderLastName: 'F' }) }
})

describe('parseCandidateBlob', () => {
  it('reads a LinkedIn header, dropping pronouns and the connection badge', () => {
    const blob = `Priya Nair (She/Her) · 2nd
Senior Software Engineer at Stripe
San Francisco Bay Area · 500+ connections
https://www.linkedin.com/in/priya-nair-12345/?trk=public_profile
priya.nair@example.com | +1 (408) 555-0101`
    expect(parseCandidateBlob(blob)).toEqual({
      firstName: 'Priya',
      lastName: 'Nair',
      email: 'priya.nair@example.com',
      phone: '(408) 555-0101',
      linkedin: 'https://www.linkedin.com/in/priya-nair-12345',
      location: 'San Francisco Bay Area',
      currentTitle: 'Senior Software Engineer',
      currentCompany: 'Stripe',
    })
  })

  it('reads an email signature with a sign-off and a GitHub link', () => {
    const blob = `Thanks so much,

Diego Morales
Staff Engineer | Brightwave
diego@brightwave.io
c: 408.555.0134
github.com/dmorales
Oakland, CA`
    expect(parseCandidateBlob(blob)).toEqual({
      firstName: 'Diego',
      lastName: 'Morales',
      email: 'diego@brightwave.io',
      phone: '(408) 555-0134',
      github: 'https://github.com/dmorales',
      location: 'Oakland, CA',
      currentTitle: 'Staff Engineer',
      currentCompany: 'Brightwave',
    })
  })

  it('reads "Name <email>" and keeps name particles with the last name', () => {
    expect(parseCandidateBlob('Mei Tanaka <Mei.Tanaka@Example.com>')).toMatchObject({ firstName: 'Mei', lastName: 'Tanaka', email: 'mei.tanaka@example.com' })
    expect(parseCandidateBlob('"Ana de la Cruz" <ana@cruz.dev>')).toMatchObject({ firstName: 'Ana', lastName: 'de la Cruz' })
  })

  it('falls back to the LinkedIn slug or the email for the name', () => {
    expect(parseCandidateBlob('https://linkedin.com/in/rahul-iyer-8a1b2c3d')).toMatchObject({ firstName: 'Rahul', lastName: 'Iyer', linkedin: 'https://www.linkedin.com/in/rahul-iyer-8a1b2c3d' })
    expect(parseCandidateBlob('jane_doe99@yahoo.com')).toMatchObject({ firstName: 'Jane', lastName: 'Doe', email: 'jane_doe99@yahoo.com' })
    expect(parseCandidateBlob('xyz@corp.com')).toEqual({ email: 'xyz@corp.com' })
  })

  it('drops credentials, handles apostrophes and labeled fields', () => {
    expect(parseCandidateBlob("Kevin O'Brien, CPA\nSan Jose, CA")).toMatchObject({ firstName: 'Kevin', lastName: "O'Brien", location: 'San Jose, CA' })
    expect(parseCandidateBlob('Name: Sofia Rossi\nLocation: Austin, Texas\nPhone 512-555-0199')).toMatchObject({
      firstName: 'Sofia',
      lastName: 'Rossi',
      location: 'Austin, Texas',
      phone: '(512) 555-0199',
    })
  })

  it('reads a name pasted on one line with an email, a phone or a link', () => {
    expect(parseCandidateBlob('Marco Bianchi marco.b@example.com')).toEqual({ firstName: 'Marco', lastName: 'Bianchi', email: 'marco.b@example.com' })
    expect(parseCandidateBlob('marco.b@example.com Marco Bianchi')).toEqual({ firstName: 'Marco', lastName: 'Bianchi', email: 'marco.b@example.com' })
    expect(parseCandidateBlob('marco.b@example.com | Marco Bianchi')).toMatchObject({ firstName: 'Marco', lastName: 'Bianchi' })
    expect(parseCandidateBlob('Marco Bianchi, marco.b@example.com')).toMatchObject({ firstName: 'Marco', lastName: 'Bianchi' })
    expect(parseCandidateBlob('Marco Bianchi (408) 555-0123')).toEqual({ firstName: 'Marco', lastName: 'Bianchi', phone: '(408) 555-0123' })
    expect(parseCandidateBlob('Marco Bianchi +1 408 555 0123 marco.b@example.com')).toEqual({
      firstName: 'Marco',
      lastName: 'Bianchi',
      email: 'marco.b@example.com',
      phone: '(408) 555-0123',
    })
    // The line name wins over the profile slug.
    expect(parseCandidateBlob('Ana de la Cruz https://www.linkedin.com/in/acruz-dev')).toMatchObject({ firstName: 'Ana', lastName: 'de la Cruz' })
  })

  it('never reads a contact label left beside a number as a name', () => {
    expect(parseCandidateBlob('Work Phone (408) 555-0123\nMarco Bianchi')).toMatchObject({ firstName: 'Marco', lastName: 'Bianchi', phone: '(408) 555-0123' })
    expect(parseCandidateBlob('Cell Phone: 408-555-0123')).toEqual({ phone: '(408) 555-0123' })
  })

  it('does not read profile URL digits as a phone, and ignores empty input', () => {
    expect(parseCandidateBlob('linkedin.com/in/alex-5551234567').phone).toBeUndefined()
    expect(parseCandidateBlob('')).toEqual({})
  })
})

describe('normalizers and duplicates', () => {
  it('normalizes profile URLs and phones', () => {
    expect(linkedinSlug('https://www.linkedin.com/in/Priya-Nair/')).toBe('priya-nair')
    expect(linkedinSlug('https://example.com')).toBeNull()
    expect(githubUser('https://github.com/DMorales/repo')).toBe('dmorales')
    expect(githubUser('https://github.com/orgs/acme')).toBeNull()
    expect(phoneDigits('+1 (408) 555-0101')).toBe('4085550101')
  })

  it('finds duplicates by email, LinkedIn, GitHub or phone', () => {
    const db = fixtureDB()
    db.candidates[0].links.linkedin = 'https://www.linkedin.com/in/alex-kim'
    db.candidates[1].links.github = 'https://github.com/benortiz'
    db.candidates[2].phone = '(408) 555-0188'
    expect(findDuplicates(db, { email: ' ALEX.KIM@example.com ' })).toEqual(['c-alex'])
    expect(findDuplicates(db, { linkedin: 'linkedin.com/in/Alex-Kim?x=1' })).toEqual(['c-alex'])
    expect(findDuplicates(db, { github: 'github.com/BenOrtiz' })).toEqual(['c-ben'])
    expect(findDuplicates(db, { phone: '+1 408 555 0188' })).toEqual(['c-chen'])
    expect(findDuplicates(db, { email: 'new@example.com' })).toEqual([])
    expect(findDuplicates(db, { email: 'alex.kim@example.com' }, 'c-alex')).toEqual([])
  })
})
