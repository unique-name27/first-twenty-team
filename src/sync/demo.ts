// Pure helpers for a server that runs as a public demo (SIGNUP_MODE=open: anyone may create an account
// and a company): the checks a sign-up or an invite form runs before it sends anything (the same rules the
// server enforces), the demo notice, invite tokens and links, and plain-language texts for what can go
// wrong. No DOM, no store, no network.
import { type ApiFailure, describeFailure } from './api'
import {
  DEFAULT_DEMO_EXPIRE_DAYS,
  MAX_COMPANY_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_COMPANY_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  type SignupModeResponse,
} from './protocol'

/**
 * A server that lets anyone create a demo company (signupMode 'open'). expireDays: days without activity
 * before a demo company is deleted (0: never), for the demo notice.
 */
export type DemoSignup = { expireDays: number }

/** What GET /api/auth/signup-mode means for the app: a demo sign-up to offer, or null. */
export function demoSignupOf(r: SignupModeResponse): DemoSignup | null {
  return r.signupMode === 'open' ? { expireDays: r.demoExpireDays ?? DEFAULT_DEMO_EXPIRE_DAYS } : null
}

/** What is wrong with an email for a new login, or null. The server trims and lowercases it. */
export function signupEmailProblem(email: string): string | null {
  const e = email.trim()
  if (!e) return 'Add your email.'
  if (e.length > MAX_EMAIL_LENGTH) return `Use an email of at most ${MAX_EMAIL_LENGTH} characters.`
  if (e.length < 3 || !/^[^\s@]+@[^\s@]+$/.test(e)) return 'Check the email. It looks like you@company.com.'
  return null
}

/** What is wrong with the password for a new login, or null (server/src/auth.ts passwordProblem). */
export function newPasswordProblem(password: string): string | null {
  if (!password) return `Add a password of at least ${MIN_PASSWORD_LENGTH} characters.`
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters (${password.length} so far). A few words in a row work well.`
  }
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH.toLocaleString('en-US')} characters.`
  return null
}

/** What is wrong with a new company's name, or null (2 to 80 characters once trimmed). */
export function companyNameProblem(name: string): string | null {
  const n = name.trim()
  if (!n) return 'Add the company name.'
  if (n.length < MIN_COMPANY_NAME_LENGTH) return `Use at least ${MIN_COMPANY_NAME_LENGTH} characters.`
  if (n.length > MAX_COMPANY_NAME_LENGTH) return `Use at most ${MAX_COMPANY_NAME_LENGTH} characters (${n.length} now).`
  return null
}

/**
 * The notice every sign-up shows: anyone can sign up, so no real data, and when demo companies go.
 * expireDays: the server's DEMO_EXPIRE_DAYS when it says (0: never), else the default.
 */
export function demoNotice(expireDays: number = DEFAULT_DEMO_EXPIRE_DAYS): string {
  const lead = 'This is a demo server. Anyone can sign up, so do not enter real employee or candidate data.'
  if (expireDays <= 0) return `${lead} Whoever runs it can delete demo companies at any time.`
  return `${lead} Demo companies are deleted after ${expireDays} ${expireDays === 1 ? 'day' : 'days'} without activity.`
}

/**
 * True for something that can be an invite token: base64url (the server makes 32 random bytes, 43
 * characters). Anything else is never sent to the server.
 */
export function isInviteToken(token: string | undefined | null): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(token)
}

/** "in 1 minute", "in 15 minutes", from a retryAfter in seconds (15 minutes when the server gave none). */
function minutesText(retryAfter: number | undefined): string {
  const m = Math.max(1, Math.ceil((retryAfter ?? 900) / 60))
  return `${m} minute${m === 1 ? '' : 's'}`
}

type Failure = Pick<ApiFailure, 'kind' | 'status' | 'error' | 'retryAfter'>

/** A 429 the server sends while too many password checks wait (any sign-in, sign-up or join). */
const BUSY_TEXT = 'The server is busy checking other passwords. Try again in a moment.'

/**
 * Why creating a demo company did not work, in words. Nothing was created whatever the answer, and no
 * changes are waiting (the engine's own texts talk about those), so the texts say what to do instead.
 */
export function signupFailureText(f: Failure): string {
  switch (f.kind) {
    case 'not_found':
      return 'This server does not take new demo companies. Sign in with a login you already have instead.'
    case 'rate_limited':
      if (f.error === 'busy') return BUSY_TEXT
      return `Too many demo companies were created from this network or on this server in the last hour. Try again in ${minutesText(f.retryAfter)}.`
    case 'bad_request':
      return `The server did not accept these details. Check the email, a password of at least ${MIN_PASSWORD_LENGTH} characters and a company name of ${MIN_COMPANY_NAME_LENGTH} to ${MAX_COMPANY_NAME_LENGTH} characters, then try again.`
    case 'offline':
      return 'Cannot reach the server. Check the connection, then try again.'
    case 'server':
      return `The server had a problem (error ${f.status ?? 500}). Try again in a minute.`
    default:
      return describeFailure(f)
  }
}

/** Why an invite step did not work: looking at the link, joining with it, or creating one. */
export function inviteFailureText(f: Failure, step: 'look' | 'join' | 'create'): string {
  if (step !== 'create' && f.kind === 'not_found') {
    return 'This invite link does not work. It was used already, it expired, or only part of it was copied. Ask whoever sent it for a new one.'
  }
  switch (f.kind) {
    case 'forbidden':
      return step === 'create'
        ? 'Only an admin of this company can invite teammates.'
        : describeFailure(f)
    case 'rate_limited':
      if (f.error === 'busy') return BUSY_TEXT
      if (step !== 'create') return `Too many tries from this network. Try again in ${minutesText(f.retryAfter)}.`
      // The server says which cap it hit: open links, or logins (open links count as logins to be).
      if (f.error === 'too_many_logins') {
        return 'This company has as many logins as the server allows, counting open invite links. An open link frees its place when it expires.'
      }
      if (f.error === 'too_many_invites') {
        return 'This company has as many open invite links as the server allows. One frees up when it is used or expires.'
      }
      return `Invite links were made too fast. Try again in ${minutesText(f.retryAfter)}.`
    case 'bad_request':
      return step === 'join'
        ? `The server did not accept these details. Check the email and a password of at least ${MIN_PASSWORD_LENGTH} characters, then try again.`
        : `The server refused the request (error ${f.status ?? 400}). Try again.`
    case 'signed_out':
      return 'Your session on the server ended. Sign in again, then create the invite.'
    case 'offline':
      return 'Cannot reach the server. Check the connection, then try again.'
    case 'server':
      return `The server had a problem (error ${f.status ?? 500}). Try again in a minute.`
    default:
      return describeFailure(f)
  }
}
