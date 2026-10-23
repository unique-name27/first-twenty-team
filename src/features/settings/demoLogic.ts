// Pure helpers for the demo server screens (Settings, Server when anyone may sign up, and the invite page
// at #invite.<token>): the company a sign-up starts, what creating or joining a company does to this
// browser's workspace, and how an invite link and a careers page address read. No DOM, no store.
import type { DB } from '@/domain/types'
import { fmtDateTime, type ISODate, today } from '@/lib/dates'
import type { OpenInvite } from '@/sync'
import { buildFreshDB } from './logic'
import type { WorkspaceSummary } from './serverLogic'

export type DemoCompanyInput = { companyName: string; firstName: string; lastName: string }

/**
 * The company a demo sign-up starts: Start fresh as a solo founder with its defaults (headquarters in San
 * Jose, the founder starting today), named as typed. Everything else is edited later in Settings.
 * meta.signupDefaults records the facts the sign-up filled in rather than asked for (headquarters,
 * stage, workweek, founding date), so the public careers page leaves each out until the company changes
 * it (src/careers/render.ts companyFactsSet) and never states a made-up fact.
 */
export function demoCompanyDB(input: DemoCompanyInput, startDate: ISODate = today()): DB {
  const db = buildFreshDB({
    companyName: input.companyName,
    website: '',
    hqStreet: '',
    hqCity: 'San Jose',
    hqState: 'CA',
    hqZip: '95113',
    firstName: input.firstName,
    lastName: input.lastName,
    title: 'Founder and CEO',
    workEmail: '',
    startDate,
  })
  const c = db.company
  const signupDefaults = { hqCity: c.hq.city, hqState: c.hq.state, stage: c.stage, workweek: c.workweek, foundedOn: c.foundedOn }
  return { ...db, meta: { ...db.meta, signupDefaults } }
}

/** What is wrong with the founder's name for the new company, or null. */
export function founderNameProblem(firstName: string, lastName: string): string | null {
  if (!firstName.trim() && !lastName.trim()) return 'Add your first and last name. They go on your profile in the new company.'
  if (!firstName.trim()) return 'Add your first name.'
  if (!lastName.trim()) return 'Add your last name.'
  return null
}

/**
 * The company this browser holds that creating or joining a company here would replace, or null when
 * nothing of anyone's is lost (the sample company). Only asked for a browser that does not sync yet.
 */
export function replacedHere(local: WorkspaceSummary): string | null {
  return local.sample ? null : local.companyName.trim() || 'an unnamed company'
}

/**
 * How long an invite link works, in words: "It works once, until Sat, Oct 17, 5:00 PM." A date the app
 * cannot read says what the server promises (7 days).
 */
export function inviteExpiryText(expiresAt: string): string {
  const when = fmtDateTime(expiresAt)
  return when ? `It works once, until ${when}.` : 'It works once, for 7 days.'
}

/** An address without its scheme or a trailing slash, to read in a sentence ("careers.example.com/acme"). */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

/**
 * One open invite link in words, for the list an admin can revoke from: who made it and how long it
 * works. "Made by sam@acme.test. Works until Sat, Oct 17, 5:00 PM."
 */
export function openInviteText(invite: OpenInvite): string {
  const by = invite.createdBy ? `Made by ${invite.createdBy}.` : 'Made by a login that is gone now.'
  const until = fmtDateTime(invite.expiresAt)
  return until ? `${by} Works until ${until}.` : by
}

/**
 * What a company's careers page switch says: whether strangers can see the page, and what turning it on
 * or off does. Off is where the owner's own workspace starts; demo companies start on.
 */
export function careersSwitchText(on: boolean): string {
  return on
    ? 'Public: anyone with the link sees the open jobs you marked posted, and can apply. Turn it off to take the page down at once.'
    : 'Off: the link shows nothing and takes no applications. Turn it on to publish the open jobs you marked posted.'
}

/**
 * Where the sign-in form says the login comes from: on a demo server, the email and password someone
 * signed up or joined with (there is no reset there); otherwise the admin login made at setup (null:
 * the form's own text).
 */
export function signInFootnote(demo: boolean): string | null {
  return demo ? 'Use the email and password you signed up or joined with. A demo server has no password reset: create a new demo company if you lost it.' : null
}
