import { describe, expect, it } from 'vitest'
import { DEFAULT_EMAIL_TEMPLATES } from '@/data/defaults'
import { fillTemplate, mailtoHref, pickRejectionTemplate, suggestCallForRejection } from './email'

describe('fillTemplate', () => {
  it('fills merge fields, tolerating spaces inside the braces', () => {
    expect(fillTemplate('Hi {{firstName}}, welcome to {{ companyName }}.', { firstName: 'Mei', companyName: 'Ledgerlark' })).toBe('Hi Mei, welcome to Ledgerlark.')
  })

  it('drops missing fields and collapses the blank lines they leave', () => {
    expect(fillTemplate('Hi {{firstName}},\n\n{{calendly}}\n\nThanks', { firstName: 'Ben' })).toBe('Hi Ben,\n\nThanks')
    expect(fillTemplate('Hi {{firstName}}', {}, { keepMissing: true })).toBe('Hi {{firstName}}')
    expect(fillTemplate('{{n}} days', { n: 5 })).toBe('5 days')
  })
})

describe('mailtoHref', () => {
  it('encodes subject and body with CRLF line breaks and keeps @ readable', () => {
    const href = mailtoHref('mei.tanaka@example.com', 'Intro call & next steps', 'Hi Mei,\nTalk soon')
    expect(href).toBe('mailto:mei.tanaka@example.com?subject=Intro%20call%20%26%20next%20steps&body=Hi%20Mei%2C%0D%0ATalk%20soon')
  })

  it('supports several recipients and a BCC list', () => {
    const href = mailtoHref(['a@x.com', 'b+tag@y.com'], 'S', 'B', { bcc: ['c@z.com', 'd@z.com'] })
    expect(href).toBe('mailto:a@x.com,b%2Btag@y.com?bcc=c@z.com,d@z.com&subject=S&body=B')
    expect(mailtoHref('', 'S', 'B')).toBe('mailto:?subject=S&body=B')
  })

  it('leaves the To line empty for a BCC-only note when there is no sender address', () => {
    expect(mailtoHref('', 'S', 'B', { bcc: ['c@z.com'] })).toBe('mailto:?bcc=c@z.com&subject=S&body=B')
    expect(mailtoHref('   ', 'S', 'B', { bcc: ['c@z.com'] })).toBe('mailto:?bcc=c@z.com&subject=S&body=B')
    expect(mailtoHref(['', 'a@x.com'], 'S', 'B')).toBe('mailto:a@x.com?subject=S&body=B')
  })
})

describe('pickRejectionTemplate', () => {
  const db = { emailTemplates: DEFAULT_EMAIL_TEMPLATES }

  it('matches the stage and tone', () => {
    expect(pickRejectionTemplate(db, 'new')?.id).toBe('em-reject-early')
    expect(pickRejectionTemplate(db, 'intro', 'kind')?.id).toBe('em-reject-early')
    expect(pickRejectionTemplate(db, 'onsite')?.id).toBe('em-reject-late')
    expect(pickRejectionTemplate(db, 'technical', 'kind')?.id).toBe('em-reject-late')
  })

  it('falls back to a built-in brief note, then to any rejection template', () => {
    expect(pickRejectionTemplate(db, 'new', 'brief')?.id).toBe('em-reject-early-brief')
    expect(pickRejectionTemplate(db, 'onsite', 'brief')?.id).toBe('em-reject-late-brief')
    expect(pickRejectionTemplate({ emailTemplates: [] }, 'new')).toBeUndefined()
    const onlyOne = { emailTemplates: DEFAULT_EMAIL_TEMPLATES.filter((t) => t.id === 'em-reject-late') }
    expect(pickRejectionTemplate(onlyOne, 'new')?.id).toBe('em-reject-late')
  })

  it('suggests a call for final-round rejections', () => {
    expect(suggestCallForRejection('onsite')).toBe(true)
    expect(suggestCallForRejection('offer')).toBe(true)
    expect(suggestCallForRejection('intro')).toBe(false)
  })
})
