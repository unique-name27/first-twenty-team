// A live careers page's application (server/src/careers/routes.ts): what the apply form accepts
// (parseApplication) and the records it becomes (applicationRecords). The records are the ones Add
// candidate makes in the app (addCandidate and addApplication in src/domain/hiring/candidates.ts): a new
// inbound candidate, an application in the job's first stage with the default next step and owner, and
// activity rows, plus the applicant's answer as a note. A test keeps the two in step. Pure: the server
// writes the records through the sync write path, so every connected browser receives them.
//
// The form comes from anyone on the internet, so every field is length-capped, stripped of control and
// direction-override characters, and checked; a link must be a plain http(s) address (the app renders it
// as a link), and the hidden 'website' field must stay empty (bots fill it). No file upload.
// It never asks for pay history or criminal history.
import { DEFAULT_STAGES } from '@/data/defaults'
import { CAREERS_SITE_DETAIL } from '@/domain/hiring/sources'
import { addYears, dbHolidays, lowerFirst } from '@/domain/hiring/util'
import { isEmployedOn } from '@/domain/people'
import type { Activity, Application, Candidate, DB, ID, Job } from '@/domain/types'
import { addBusinessDays, type ISODate, type ISODateTime } from '@/lib/dates'
import { newId } from '@/lib/id'
import { APPLY_MAX, type ApplyErrors, type ApplyField, type ApplyValues } from './render'

/** How a careers application is labeled on the candidate (Candidate.sourceDetail; source is 'inbound'). */
export const CAREERS_SOURCE_DETAIL = CAREERS_SITE_DETAIL

/** Shortest answer to the role question (the demo form's rule too). */
export const MIN_ANSWER_LENGTH = 20

export type ApplicationInput = {
  firstName: string
  lastName: string
  email: string
  phone?: string
  /** A checked http(s) address and the candidate link it fills. */
  link?: { kind: keyof Candidate['links']; url: string }
  answer: string
}

export type ParsedApplication = { ok: true; input: ApplicationInput; values: ApplyValues } | { ok: false; values: ApplyValues; errors: ApplyErrors }

// C0 and C1 controls, the bidirectional overrides and isolates that can make a name read backwards, and
// (in one-line fields) zero-width spaces and byte order marks that would hide inside a name or address.
const CONTROLS = /[\u0000-\u001F\u007F-\u009F​‎‏‪-‮⁦-⁩﻿]/g
const CONTROLS_BUT_LINES = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g
// The address an email field accepts (the HTML standard's), with a top-level domain of two letters or more.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/
const PHONE = /^[+\d\s().-]+$/

/** One line of text: controls removed, runs of white space as one space, trimmed. */
function line(raw: string | undefined): string {
  return (raw ?? '').replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim()
}

/** Paragraph text: controls other than line breaks and tabs removed, Windows line ends as \n, trimmed. */
function paragraphs(raw: string | undefined): string {
  return (raw ?? '').replace(/\r\n?/g, '\n').replace(CONTROLS_BUT_LINES, '').trim()
}

/** A web address someone typed, as a normalized http(s) URL, or null when it is not one. */
export function webAddress(raw: string): string | null {
  const text = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  // A host name with a dot and a real top-level domain; no user name or password in the address.
  if (url.username || url.password || !/^([a-z0-9-]+\.)+[a-z]{2,63}$/.test(url.hostname)) return null
  return url.href
}

/** Which candidate link an address fills: LinkedIn, GitHub, a resume file, else a portfolio. */
function linkKind(href: string): keyof Candidate['links'] {
  const url = new URL(href)
  const host = url.hostname
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'linkedin'
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github'
  if (/\.(pdf|docx?|rtf|odt|txt)$/i.test(url.pathname)) return 'resume'
  return 'portfolio'
}

/**
 * Checks a submitted form (field name to value, as the browser sends it). On success, the cleaned input;
 * either way, the values to show again in the form (each cut to its field's length) and, on failure, one
 * message per field in the words the demo form uses.
 */
export function parseApplication(form: Record<string, string | undefined>): ParsedApplication {
  const values: ApplyValues = {
    name: line(form.name),
    email: line(form.email),
    phone: line(form.phone),
    link: line(form.link),
    answer: paragraphs(form.answer),
  }
  const errors: ApplyErrors = {}
  const tooLong = (k: ApplyField) => (values[k] ?? '').length > APPLY_MAX[k]
  const { name = '', email = '', phone = '', link = '', answer = '' } = values

  if (name.length < 2) errors.name = 'Enter your full name.'
  else if (tooLong('name')) errors.name = `Shorten your name to ${APPLY_MAX.name} characters or fewer.`

  if (!email) errors.email = 'Enter your email address.'
  else if (tooLong('email') || !EMAIL.test(email)) errors.email = 'Enter an email address in the format name@example.com.'

  const digits = phone.replace(/\D/g, '').length
  if (phone && (tooLong('phone') || !PHONE.test(phone) || digits < 7 || digits > 15)) {
    errors.phone = 'Enter a phone number with at least 7 digits, or leave it blank.'
  }

  const href = link && !tooLong('link') ? webAddress(link) : null
  if (link && !href) errors.link = 'Enter a web address, like linkedin.com/in/yourname, or leave it blank.'

  if (!answer) errors.answer = 'Answer the question about this role.'
  else if (answer.length < MIN_ANSWER_LENGTH) errors.answer = `Write at least a sentence (${MIN_ANSWER_LENGTH} characters or more).`
  else if (tooLong('answer')) errors.answer = `Shorten your answer to ${APPLY_MAX.answer} characters or fewer.`

  // The hidden field people never see. The form shown again leaves it empty, so a person who somehow
  // filled it gets through by sending again.
  if (line(form.website)) errors.website = 'The form could not be sent. Check your answers and send it again.'

  // What goes back into the form: never more than the field takes.
  for (const k of Object.keys(values) as ApplyField[]) values[k] = (values[k] ?? '').slice(0, APPLY_MAX[k])
  if (Object.keys(errors).length > 0) return { ok: false, values, errors }

  const [firstName, ...rest] = name.split(' ')
  return {
    ok: true,
    values,
    input: {
      firstName,
      lastName: rest.join(' '),
      email,
      answer,
      ...(phone ? { phone } : {}),
      ...(href ? { link: { kind: linkKind(href), url: href } } : {}),
    },
  }
}

/** The job's first stage (the default pipeline's New when it has no stages), as jobStages does. */
function firstStage(job: Pick<Job, 'stages'>) {
  return (Array.isArray(job.stages) && job.stages.length > 0 ? job.stages : DEFAULT_STAGES)[0]
}

/** ownerFor in src/domain/hiring/pipeline.ts: the hiring manager while employed, else a founder. */
function owner(db: Pick<DB, 'people'>, job: Pick<Job, 'hiringManagerId'>, date: ISODate): ID {
  const hm = job.hiringManagerId
  const current = hm ? db.people.find((p) => p.id === hm) : undefined
  if (hm && current && isEmployedOn(current, date)) return hm
  const founderId = db.people.find((p) => p.isFounder && isEmployedOn(p, date))?.id ?? db.people.find((p) => p.isFounder)?.id
  return founderId ?? hm ?? ''
}

/** defaultNextStep in src/domain/hiring/pipeline.ts, for the stage an application starts in. */
function nextStep(db: Pick<DB, 'people' | 'holidays'>, job: Job, date: ISODate): Application['nextStep'] {
  const stage = firstStage(job)
  const due = (n: number) => addBusinessDays(date, n, dbHolidays(db))
  const ownerId = owner(db, job, date)
  switch (stage.kind) {
    case 'new':
      return { text: 'Review application', dueOn: due(stage.slaBusinessDays ?? 3), ownerId }
    case 'offer':
      return { text: 'Send offer', dueOn: due(2), ownerId }
    case 'hired':
      return undefined
    default:
      return { text: `Schedule ${lowerFirst(stage.name)}`, dueOn: due(2), ownerId }
  }
}

export type ApplicationRecords = { candidate: Candidate; application: Application; activity: Activity[] }

/**
 * The records one careers application adds to a workspace. `date` is the company's calendar day (the
 * server passes the Pacific date) and `at` the moment, for the activity rows; `question` is the one the
 * form asked. Ids are new unless given (tests).
 */
export function applicationRecords(opts: {
  db: Pick<DB, 'people' | 'holidays'>
  job: Job
  input: ApplicationInput
  question: string
  date: ISODate
  at: ISODateTime
  ids?: { candidate: ID; application: ID; activity: [ID, ID, ID] }
}): ApplicationRecords {
  const { db, job, input, date, at } = opts
  const ids = opts.ids ?? { candidate: newId('c'), application: newId('a'), activity: [newId('act'), newId('act'), newId('act')] }
  const stage = firstStage(job)
  const links: Candidate['links'] = input.link ? { [input.link.kind]: input.link.url } : {}
  const candidate: Candidate = {
    id: ids.candidate,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    links,
    source: 'inbound',
    sponsorship: 'unknown',
    tags: [],
    createdOn: date,
    ...(input.phone ? { phone: input.phone } : {}),
    sourceDetail: CAREERS_SOURCE_DETAIL,
    retainUntil: addYears(date, 4),
  }
  const step = nextStep(db, job, date)
  const application: Application = {
    id: ids.application,
    candidateId: candidate.id,
    jobId: job.id,
    stageId: stage.id,
    status: 'active',
    appliedOn: date,
    stageEnteredOn: date,
    history: [{ stageId: stage.id, at: date }],
    ...(step ? { nextStep: step } : {}),
  }
  const who = `${input.firstName} ${input.lastName}`.trim()
  // Nobody in the company made these changes: no actor and no Viewing-as mode.
  const row = (id: ID, a: Omit<Activity, 'id' | 'at' | 'actorId'>): Activity => ({ id, at, actorId: null, ...a })
  const activity = [
    row(ids.activity[0], { entityType: 'candidate', entityId: candidate.id, kind: 'candidate_added', text: `${who} applied on the careers site` }),
    row(ids.activity[1], {
      entityType: 'application',
      entityId: application.id,
      relatedId: candidate.id,
      kind: 'application_added',
      text: `Added ${who} to ${job.title} in ${stage.name} from the careers site`,
    }),
    row(ids.activity[2], {
      entityType: 'candidate',
      entityId: candidate.id,
      kind: 'note',
      text: `Answer on the careers site application for ${job.title}. ${opts.question}\n\n${input.answer}`,
    }),
  ]
  return { candidate, application, activity }
}
