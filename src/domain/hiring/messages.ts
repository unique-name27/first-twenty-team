// Ready-to-send candidate messages: stage-aware rejections (kind or brief, founder signature, a call
// suggested for final rounds), bulk close-out notes for a filled job (BCC list), offer nudges and
// interview cancellations.
// They open in the mail app (mailto) or get copied; nothing is sent from the app. Pure functions.
import { founder, personNameById } from '@/domain/people'
import type { DB, ID } from '@/domain/types'
import type { ISODate, ISODateTime } from '@/lib/dates'
import { fillTemplate, mailtoHref, pickRejectionTemplate, suggestCallForRejection } from '@/lib/email'
import { stageKind } from './pipeline'
import { formatDual } from './scheduling'
import { candidateName, fmtDayPlain, lowerFirst } from './util'

export type ComposedMessage = { to: string; subject: string; body: string; mailto: string }

function senderName(db: DB, senderId?: ID): string {
  if (senderId) return personNameById(db, senderId, db.company.name)
  const f = founder(db)
  return f ? `${f.preferredName || f.firstName} ${f.lastName}` : db.company.name
}

/**
 * Rejection note for an application, matched to its stage and the tone. Signed by the sender (the
 * founder by default). suggestCall is true for onsite and offer stages.
 */
export function rejectionMessage(
  db: DB,
  appId: ID,
  opts: { tone?: 'kind' | 'brief'; senderId?: ID } = {},
): (ComposedMessage & { suggestCall: boolean; templateId?: ID }) | null {
  const app = db.applications.find((a) => a.id === appId)
  if (!app) return null
  const cand = db.candidates.find((c) => c.id === app.candidateId)
  const job = db.jobs.find((j) => j.id === app.jobId)
  if (!cand || !job) return null
  const kind = stageKind(job, app.stageId) ?? 'new'
  const template = pickRejectionTemplate(db, kind, opts.tone ?? 'kind')
  const fields = { firstName: cand.firstName, jobTitle: job.title, companyName: db.company.name, senderName: senderName(db, opts.senderId) }
  const subject = fillTemplate(template?.subject ?? 'Your application to {{companyName}}', fields)
  const body = fillTemplate(
    template?.body ?? 'Hi {{firstName}},\n\nThank you for your interest in the {{jobTitle}} role. We have decided not to move forward.\n\n{{senderName}}',
    fields,
  )
  return {
    to: cand.email,
    subject,
    body,
    mailto: mailtoHref(cand.email, subject, body),
    suggestCall: suggestCallForRejection(kind),
    ...(template ? { templateId: template.id } : {}),
  }
}

/** The sender's work email, or '' when none is on file (never a guessed address). */
export function senderEmail(db: DB, senderId?: ID): string {
  const p = senderId ? db.people.find((x) => x.id === senderId) : founder(db)
  return p?.workEmail?.trim() ?? ''
}

/**
 * Close-out note for everyone still open (or closed but not yet told) on a job: one message with the
 * candidates on BCC. It is addressed to the sender's own work email when one is on file; otherwise the
 * To line stays empty (BCC only) and `from` is '' so the sheet can ask for the address.
 */
export function closeOutMessage(
  db: DB,
  jobId: ID,
  opts: { senderId?: ID } = {},
): { bcc: string[]; applicationIds: ID[]; subject: string; body: string; mailto: string; from: string } | null {
  const job = db.jobs.find((j) => j.id === jobId)
  if (!job) return null
  const apps = db.applications.filter(
    (a) => a.jobId === jobId && ((a.status === 'active' && !a.conditionalOfferOn) || ((a.status === 'rejected' || a.status === 'withdrawn') && !a.notifiedOn)),
  )
  const emails = new Map<string, ID>()
  for (const a of apps) {
    const c = db.candidates.find((x) => x.id === a.candidateId)
    if (c?.email && !emails.has(c.email.toLowerCase())) emails.set(c.email.toLowerCase(), a.id)
  }
  const template = db.emailTemplates.find((t) => t.kind === 'close_out')
  const fields = { firstName: 'there', jobTitle: job.title, companyName: db.company.name, senderName: senderName(db, opts.senderId) }
  const subject = fillTemplate(template?.subject ?? 'An update on the {{jobTitle}} role at {{companyName}}', fields)
  const body = fillTemplate(
    template?.body ??
      'Hi there,\n\nThank you for your interest in the {{jobTitle}} role at {{companyName}}. We have filled the position, so we are closing this search. We are grateful for the time you spent with us, and we would be glad to stay in touch about future roles.\n\n{{senderName}}',
    fields,
  )
  const bcc = [...emails.keys()]
  const from = senderEmail(db, opts.senderId)
  return { bcc, applicationIds: apps.map((a) => a.id), subject, body, mailto: mailtoHref(from, subject, body, { bcc }), from }
}

/**
 * A friendly nudge before an offer expires. Pass `date` (today): an offer whose expiry has already
 * passed, or that is marked expired, gets no nudge, since it would say the offer is open until a date
 * gone by. Extend it instead.
 */
export function offerNudgeMessage(db: DB, offerId: ID, opts: { senderId?: ID; date?: ISODate } = {}): ComposedMessage | null {
  const offer = db.offers.find((o) => o.id === offerId)
  if (!offer) return null
  if (offer.status === 'expired' || (opts.date && offer.expiresOn < opts.date)) return null
  const cand = db.candidates.find((c) => c.id === offer.candidateId)
  if (!cand) return null
  const template = db.emailTemplates.find((t) => t.kind === 'offer_nudge')
  const fields = {
    firstName: cand.firstName,
    jobTitle: offer.title,
    companyName: db.company.name,
    senderName: senderName(db, opts.senderId),
    expiresOn: fmtDayPlain(offer.expiresOn),
  }
  const subject = fillTemplate(template?.subject ?? 'Checking in on your {{companyName}} offer', fields)
  const body = fillTemplate(
    template?.body ??
      'Hi {{firstName}},\n\nI wanted to check in on your offer for the {{jobTitle}} role. It is open until {{expiresOn}}. Happy to answer any questions or walk through the details together, including the equity.\n\n{{senderName}}',
    fields,
  )
  return { to: cand.email, subject, body, mailto: mailtoHref(cand.email, subject, body) }
}

/**
 * Note to the candidate that an interview is off: which one and when (Pacific, plus their time zone),
 * a request to take it off their calendar, and that a new time follows. The subject reads like the
 * confirmation's ('Cancelled: Intro call with Ledgerlark, Tue, Oct 13'). With `heldAt` (the call already
 * happened earlier and was logged in its place) it says so instead of promising a new time. Copy or open
 * in the mail app; nothing is sent from the app.
 */
export function interviewCancelMessage(db: DB, interviewId: ID, opts: { senderId?: ID; heldAt?: ISODateTime } = {}): ComposedMessage | null {
  const interview = db.interviews.find((i) => i.id === interviewId)
  if (!interview) return null
  const app = db.applications.find((a) => a.id === interview.applicationId)
  const cand = app ? db.candidates.find((c) => c.id === app.candidateId) : undefined
  if (!cand) return null
  const when = formatDual(interview.startsAt, cand.timezone)
  const day = formatDual(interview.startsAt).split(',').slice(0, 2).join(',')
  const subject = `Cancelled: ${interview.name} with ${db.company.name}, ${day}`
  const body = opts.heldAt
    ? `Hi ${cand.firstName},

Thanks again for making time for the ${lowerFirst(interview.name)} on ${formatDual(opts.heldAt, cand.timezone)}. Since we already had it, the invite for ${when} is no longer needed, so please take it off your calendar.

${senderName(db, opts.senderId)}`
    : `Hi ${cand.firstName},

The ${lowerFirst(interview.name)} with ${db.company.name} on ${when} is cancelled, so please take it off your calendar. Sorry for the change.

I will be in touch soon about a new time.

${senderName(db, opts.senderId)}`
  return { to: cand.email, subject, body, mailto: mailtoHref(cand.email, subject, body) }
}

/** "Priya Nair" for an application id (handy for toasts). */
export function applicationLabel(db: DB, appId: ID): string {
  const app = db.applications.find((a) => a.id === appId)
  return app ? candidateName(db, app.candidateId) : 'Candidate'
}
