import { describe, expect, it } from 'vitest'
import { parse } from '@/app/router'
import {
  companyNameProblem,
  demoNotice,
  demoSignupOf,
  inviteFailureText,
  isInviteToken,
  newPasswordProblem,
  signupEmailProblem,
  signupFailureText,
} from './demo'
import { DEFAULT_DEMO_EXPIRE_DAYS, INVITE_ROUTE } from './protocol'

describe('sign-up checks (the server enforces the same rules)', () => {
  it('wants a plausible email of at most 254 characters', () => {
    expect(signupEmailProblem('')).toMatch(/Add your email/)
    expect(signupEmailProblem('   ')).toMatch(/Add your email/)
    expect(signupEmailProblem('sam')).toMatch(/you@company\.com/)
    expect(signupEmailProblem('sam@')).toMatch(/you@company\.com/)
    expect(signupEmailProblem('sam smith@example.test')).toMatch(/you@company\.com/)
    expect(signupEmailProblem('  sam@example.test ')).toBeNull()
    expect(signupEmailProblem(`${'a'.repeat(250)}@example.test`)).toMatch(/at most 254/)
  })

  it('wants a password of 12 to 1,024 characters and says how far along it is', () => {
    expect(newPasswordProblem('')).toMatch(/at least 12/)
    expect(newPasswordProblem('short')).toBe('Use at least 12 characters (5 so far). A few words in a row work well.')
    expect(newPasswordProblem('x'.repeat(12))).toBeNull()
    // Spaces count: a passphrase is a fine password.
    expect(newPasswordProblem('correct horse')).toBeNull()
    expect(newPasswordProblem('x'.repeat(1025))).toBe('Use at most 1,024 characters.')
  })

  it('wants a company name of 2 to 80 characters once trimmed', () => {
    expect(companyNameProblem('')).toMatch(/Add the company name/)
    expect(companyNameProblem('  A ')).toMatch(/at least 2/)
    expect(companyNameProblem(' Ab ')).toBeNull()
    expect(companyNameProblem('x'.repeat(80))).toBeNull()
    expect(companyNameProblem('x'.repeat(81))).toBe('Use at most 80 characters (81 now).')
  })
})

describe('demo notice', () => {
  it('says the contract text with the default 30 days', () => {
    expect(demoNotice()).toBe(
      'This is a demo server. Anyone can sign up, so do not enter real employee or candidate data. Demo companies are deleted after 30 days without activity.',
    )
    expect(DEFAULT_DEMO_EXPIRE_DAYS).toBe(30)
  })

  it('follows what the server says, and never promises a deletion date when there is none', () => {
    expect(demoNotice(7)).toMatch(/deleted after 7 days without activity\.$/)
    expect(demoNotice(1)).toMatch(/deleted after 1 day without activity\.$/)
    expect(demoNotice(0)).toMatch(/Whoever runs it can delete demo companies at any time\.$/)
    expect(demoNotice(0)).toMatch(/^This is a demo server\. Anyone can sign up, so do not enter real employee or candidate data\./)
  })

  it('offers a sign-up only when the mode is open', () => {
    expect(demoSignupOf({ signupMode: 'open' })).toEqual({ expireDays: 30 })
    expect(demoSignupOf({ signupMode: 'open', demoExpireDays: 0 })).toEqual({ expireDays: 0 })
    expect(demoSignupOf({ signupMode: 'closed', demoExpireDays: 30 })).toBeNull()
  })
})

describe('invite tokens and links', () => {
  const token = 'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5Xw'

  it('accepts base64url only, never something to put in a path as is', () => {
    expect(isInviteToken(token)).toBe(true)
    expect(isInviteToken('abc_DEF-1234567890')).toBe(true)
    expect(isInviteToken('short')).toBe(false)
    expect(isInviteToken('has/slash-1234567890')).toBe(false)
    expect(isInviteToken('has.dot-12345678901')).toBe(false)
    expect(isInviteToken('has%20space-1234567')).toBe(false)
    expect(isInviteToken('x'.repeat(257))).toBe(false)
    expect(isInviteToken(undefined)).toBe(false)
    expect(isInviteToken(null)).toBe(false)
  })

  it('reads a link the server made (PUBLIC_ORIGIN + /#invite.<token>) as the invite page with its token', () => {
    const hash = new URL(`https://hr-77-112-161-54.sslip.io/#${INVITE_ROUTE}.${token}`).hash
    // base64url never holds the router's '.', so the token arrives whole as the second segment.
    expect(parse(hash)).toMatchObject({ view: 'invite', segments: ['invite', token] })
    expect(isInviteToken(parse(hash).segments[1])).toBe(true)
    expect(isInviteToken(parse('#invite').segments[1])).toBe(false)
  })
})

describe('failure texts', () => {
  const f = (kind: Parameters<typeof signupFailureText>[0]['kind'], extra: { status?: number; retryAfter?: number } = {}) => ({
    kind,
    status: extra.status ?? null,
    error: null,
    ...(extra.retryAfter !== undefined ? { retryAfter: extra.retryAfter } : {}),
  })

  it('says what to do when a sign-up did not work, never that changes wait', () => {
    expect(signupFailureText(f('not_found', { status: 404 }))).toMatch(/does not take new demo companies/)
    expect(signupFailureText(f('rate_limited', { status: 429, retryAfter: 61 }))).toMatch(/Try again in 2 minutes\.$/)
    expect(signupFailureText(f('email_taken', { status: 409 }))).toMatch(/already has a login/)
    expect(signupFailureText(f('demo_full', { status: 503 }))).toMatch(/as many demo companies as it can/)
    expect(signupFailureText(f('bad_request', { status: 400 }))).toMatch(/at least 12 characters/)
    expect(signupFailureText(f('server', { status: 502 }))).toBe('The server had a problem (error 502). Try again in a minute.')
    // Too many password checks waiting is not a sign-up limit.
    const busy = { ...f('rate_limited', { status: 429, retryAfter: 2 }), error: 'busy' }
    expect(signupFailureText(busy)).toMatch(/busy checking other passwords/)
    expect(inviteFailureText(busy, 'join')).toMatch(/busy checking other passwords/)
    for (const kind of ['offline', 'server', 'not_found', 'rate_limited'] as const) {
      const text = signupFailureText(f(kind))
      expect(text, kind).not.toMatch(/Changes stay in this browser/)
      expect(text, kind).not.toMatch(/—/)
    }
  })

  it('words invite failures for their step', () => {
    expect(inviteFailureText(f('not_found', { status: 404 }), 'look')).toMatch(/This invite link does not work\. It was used already, it expired/)
    expect(inviteFailureText(f('not_found', { status: 404 }), 'join')).toMatch(/This invite link does not work/)
    expect(inviteFailureText(f('forbidden', { status: 403 }), 'create')).toBe('Only an admin of this company can invite teammates.')
    expect(inviteFailureText(f('rate_limited', { status: 429, retryAfter: 300 }), 'create')).toBe('Invite links were made too fast. Try again in 5 minutes.')
    expect(inviteFailureText({ ...f('rate_limited', { status: 429 }), error: 'too_many_invites' }, 'create')).toMatch(/as many open invite links as the server allows/)
    expect(inviteFailureText({ ...f('rate_limited', { status: 429 }), error: 'too_many_logins' }, 'create')).toMatch(/as many logins as the server allows/)
    expect(inviteFailureText(f('rate_limited', { status: 429, retryAfter: 60 }), 'join')).toBe('Too many tries from this network. Try again in 1 minute.')
    expect(inviteFailureText(f('email_taken', { status: 409 }), 'join')).toMatch(/already has a login/)
    expect(inviteFailureText(f('signed_out', { status: 401 }), 'create')).toMatch(/Sign in again/)
    expect(inviteFailureText(f('offline'), 'look')).not.toMatch(/Changes stay in this browser/)
  })
})
