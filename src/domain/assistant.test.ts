import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { buildSampleDB } from '@/data/seed'
import {
  ASSISTANT_NAME_MAX,
  assistantDisplayName,
  assistantNameError,
  defaultAssistantName,
  isAssistantContext,
  isOfficialSourceHost,
  normalizeAssistantName,
  officialSourceHosts,
  questionTexts,
} from './assistant'

describe('assistantDisplayName', () => {
  it("is the company's name and Bot when the company has not named it", () => {
    expect(assistantDisplayName({ name: 'Quillfin' })).toBe('Quillfin Bot')
    expect(assistantDisplayName({ name: 'Quillfin', assistantName: '' })).toBe('Quillfin Bot')
    expect(assistantDisplayName({ name: 'Quillfin', assistantName: '   ' })).toBe('Quillfin Bot')
    expect(defaultAssistantName({ name: '  Quillfin   Labs ' })).toBe('Quillfin Labs Bot')
  })

  it('is the name the company gave it, trimmed', () => {
    expect(assistantDisplayName({ name: 'Quillfin', assistantName: 'Lark' })).toBe('Lark')
    expect(assistantDisplayName({ name: 'Quillfin', assistantName: '  Ada  Byte ' })).toBe('Ada Byte')
  })

  it('falls back to Company Bot for a company with no name', () => {
    expect(assistantDisplayName({ name: '' })).toBe('Company Bot')
    expect(assistantDisplayName(undefined)).toBe('Company Bot')
    expect(assistantDisplayName(null)).toBe('Company Bot')
  })

  it('takes anything a browser uploaded without throwing: other types count as unset, long names are cut', () => {
    const odd = (v: Record<string, unknown>) => assistantDisplayName(v as unknown as Parameters<typeof assistantDisplayName>[0])
    expect(odd({ name: 42, assistantName: { x: 1 } })).toBe('Company Bot')
    expect(odd({ name: 'Acme', assistantName: ['Lark'] })).toBe('Acme Bot')
    expect(odd({ name: 'Acme', assistantName: 'L\u0000a\u0007r\u009fk' })).toBe('L a r k')
    expect(odd({ name: 'Acme', assistantName: 'x'.repeat(500) })).toBe('x'.repeat(ASSISTANT_NAME_MAX))
    expect(odd({ name: 'y'.repeat(500) })).toBe(`${'y'.repeat(80)} Bot`)
  })

  it('names the sample company Lark, and leaves a new company on the default', () => {
    expect(buildSampleDB().company.assistantName).toBe('Lark')
    expect(assistantDisplayName(buildSampleDB().company)).toBe('Lark')
    const fresh = blankDB({ companyName: 'Quillfin', founderFirstName: 'Ada', founderLastName: 'Byte', foundedOn: '2026-01-05' })
    expect(fresh.company.assistantName).toBeUndefined()
    expect(assistantDisplayName(fresh.company)).toBe('Quillfin Bot')
  })

  it('follows a rename, and an emptied field goes back to the default', () => {
    const company = { name: 'Quillfin', assistantName: normalizeAssistantName('  Pip ') }
    expect(assistantDisplayName(company)).toBe('Pip')
    company.assistantName = normalizeAssistantName('   ')
    expect(company.assistantName).toBeUndefined()
    expect(assistantDisplayName(company)).toBe('Quillfin Bot')
  })
})

describe('assistantNameError', () => {
  it('accepts an empty field and names up to the limit', () => {
    expect(assistantNameError('')).toBeNull()
    expect(assistantNameError('   ')).toBeNull()
    expect(assistantNameError('Lark')).toBeNull()
    expect(assistantNameError('a'.repeat(ASSISTANT_NAME_MAX))).toBeNull()
    // Surrounding spaces do not count toward the limit.
    expect(assistantNameError(`  ${'a'.repeat(ASSISTANT_NAME_MAX)}  `)).toBeNull()
  })

  it('refuses names over the limit and control characters, with a plain reason', () => {
    expect(assistantNameError('a'.repeat(ASSISTANT_NAME_MAX + 1))).toBe('Keep it to 40 characters or fewer.')
    expect(assistantNameError('La\u0000rk')).toBe('Use letters, numbers and punctuation only.')
    // The same answer every time (no regular expression state carried between calls).
    expect(assistantNameError('La\u0000rk')).toBe('Use letters, numbers and punctuation only.')
    expect(assistantNameError('Lark')).toBeNull()
  })
})

describe('the context note', () => {
  const note = '<app_context>You are Lark, the HR assistant inside First Twenty for Ledgerlark.</app_context>'

  it('is recognized only as a whole note', () => {
    expect(isAssistantContext(note)).toBe(true)
    expect(isAssistantContext(`${note} and more`)).toBe(false)
    expect(isAssistantContext('<app_context>no close')).toBe(false)
    expect(isAssistantContext(42)).toBe(false)
  })

  it('is left out of what the person typed only where the server puts it: first, before the question', () => {
    expect(questionTexts([note, 'Who starts next week?'])).toEqual(['Who starts next week?'])
    expect(questionTexts([note])).toEqual([note])
    expect(questionTexts(['Who?', note])).toEqual(['Who?', note])
    expect(questionTexts([])).toEqual([])
  })
})

describe('officialSourceHosts', () => {
  it('holds the government and law sites the lookups cite, with and without www., and nothing else', () => {
    const hosts = officialSourceHosts()
    for (const h of ['www.dir.ca.gov', 'dir.ca.gov', 'leginfo.legislature.ca.gov', 'www.irs.gov', 'irs.gov', 'edd.ca.gov', 'www.eeoc.gov', 'www.uscis.gov', 'www.sanjoseca.gov', 'calcivilrights.ca.gov']) {
      expect(hosts.has(h), h).toBe(true)
    }
    for (const h of ['evil.example', 'hr-77-112-161-54.sslip.io', 'localhost', 'dir.ca.gov.evil.example']) expect(isOfficialSourceHost(h), h).toBe(false)
    expect(isOfficialSourceHost('WWW.DIR.CA.GOV')).toBe(true)
  })
})
