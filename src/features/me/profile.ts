// Self-service edits for Me: contact info, emergency contacts with the SB 294 notify choice, and
// policy acknowledgements. Validation is pure; the mutations work on Immer drafts inside
// useDB.getState().mutate(label, recipe) and log activity in plain words.
import type { Draft } from 'immer'
import { setTaskStatus } from '@/domain/checklists/actions'
import type { Acknowledgment, DB, EmergencyContact, ID, Person } from '@/domain/types'
import type { ISODate } from '@/lib/dates'
import { listJoin } from '@/lib/format'
import { newId } from '@/lib/id'
import { logActivity } from '@/store/draft'
import { ACK_TASK_FOR_POLICY, EMERGENCY_CONTACTS_TASK, sameVersion } from './summary'

export type ContactInfo = {
  preferredName: string
  personalEmail: string
  phone: string
  homeCity: string
  homeState: string
}

export const RELATIONS = ['Spouse or partner', 'Parent', 'Sibling', 'Child', 'Friend', 'Other'] as const

export function contactInfoOf(p: Pick<Person, 'preferredName' | 'personalEmail' | 'phone' | 'homeCity' | 'homeState'>): ContactInfo {
  return {
    preferredName: p.preferredName ?? '',
    personalEmail: p.personalEmail ?? '',
    phone: p.phone ?? '',
    homeCity: p.homeCity ?? '',
    homeState: p.homeState ?? '',
  }
}

const digits = (s: string) => s.replace(/\D/g, '')

/** A phone number has 7 to 15 digits; spaces, dashes, dots, parentheses and a leading + are fine. */
export function phoneError(phone: string, required = false): string | null {
  const t = phone.trim()
  if (!t) return required ? 'Add a phone number.' : null
  if (!/^[+\d\s().-]+$/.test(t)) return 'Use digits, spaces, dashes or parentheses only.'
  const n = digits(t).length
  if (n < 7 || n > 15) return 'Enter a full phone number, like (408) 555-0123.'
  return null
}

export function emailError(email: string): string | null {
  const t = email.trim()
  if (!t) return null
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? null : 'Enter an email like name@example.com.'
}

/**
 * Home city only, never a street address (the app does not store home addresses). Any digit is a sign
 * of a street number or ZIP code.
 */
export function cityError(city: string): string | null {
  const t = city.trim()
  if (!t) return null
  if (/\d/.test(t)) return 'Enter just the city, not a street address or ZIP code.'
  if (t.length > 60) return 'Keep the city under 60 characters.'
  return null
}

export function contactInfoErrors(info: ContactInfo): Partial<Record<keyof ContactInfo, string>> {
  const out: Partial<Record<keyof ContactInfo, string>> = {}
  const e = emailError(info.personalEmail)
  if (e) out.personalEmail = e
  const p = phoneError(info.phone)
  if (p) out.phone = p
  const c = cityError(info.homeCity)
  if (c) out.homeCity = c
  if (!info.homeState) out.homeState = 'Pick the state you work from.'
  if (info.preferredName.trim().length > 40) out.preferredName = 'Keep the preferred name under 40 characters.'
  return out
}

/** Field names that differ, in display words, for the activity line and the toast. */
export function changedFields(before: ContactInfo, after: ContactInfo): string[] {
  const labels: Record<keyof ContactInfo, string> = {
    preferredName: 'preferred name',
    personalEmail: 'personal email',
    phone: 'phone',
    homeCity: 'home city',
    homeState: 'home state',
  }
  return (Object.keys(labels) as Array<keyof ContactInfo>).filter((k) => before[k].trim() !== after[k].trim()).map((k) => labels[k])
}

/** Writes contact info onto the person. Empty optional fields are removed rather than stored blank. */
export function applyContactInfo(draft: Draft<DB>, personId: ID, info: ContactInfo): boolean {
  const p = draft.people.find((x) => x.id === personId)
  if (!p) return false
  const before = contactInfoOf(p)
  const set = (k: 'preferredName' | 'personalEmail' | 'phone' | 'homeCity', v: string) => {
    const t = v.trim()
    if (t) p[k] = t
    else delete p[k]
  }
  set('preferredName', info.preferredName)
  set('personalEmail', info.personalEmail)
  set('phone', info.phone)
  set('homeCity', info.homeCity)
  if (info.homeState) p.homeState = info.homeState
  const changed = changedFields(before, info)
  if (changed.length) {
    logActivity(draft, { entityType: 'person', entityId: personId, kind: 'field_change', text: `Updated ${listJoin(changed)} in Me` })
  }
  return true
}

// ---- Emergency contacts ----------------------------------------------------------------------

export type ContactDraft = { name: string; relation: string; phone: string }

export function contactErrors(c: ContactDraft): Partial<Record<keyof ContactDraft, string>> {
  const out: Partial<Record<keyof ContactDraft, string>> = {}
  if (!c.name.trim()) out.name = 'Add a name.'
  if (!c.relation.trim()) out.relation = 'Pick how you know them.'
  const p = phoneError(c.phone, true)
  if (p) out.phone = p
  return out
}

/**
 * The SB 294 choice: the index of the contact to notify if the employee is arrested or detained at work,
 * or null for nobody. Exactly zero or one contact carries the flag.
 */
export function sb294Index(contacts: EmergencyContact[]): number | null {
  const i = contacts.findIndex((c) => c.sb294Notify)
  return i >= 0 ? i : null
}

export function withSb294Choice(contacts: EmergencyContact[], index: number | null): EmergencyContact[] {
  return contacts.map((c, i) => {
    const { sb294Notify: _drop, ...rest } = c
    return i === index ? { ...rest, sb294Notify: true } : rest
  })
}

/** Adds (index null) or replaces a contact. A replaced contact keeps its SB 294 choice. */
export function upsertContact(contacts: EmergencyContact[], index: number | null, c: ContactDraft): EmergencyContact[] {
  const clean: EmergencyContact = { name: c.name.trim(), relation: c.relation.trim(), phone: c.phone.trim() }
  if (index == null || index < 0 || index >= contacts.length) return [...contacts, clean]
  return contacts.map((old, i) => (i === index ? { ...clean, ...(old.sb294Notify ? { sb294Notify: true } : {}) } : old))
}

export function removeContact(contacts: EmergencyContact[], index: number): EmergencyContact[] {
  return contacts.filter((_, i) => i !== index)
}

/**
 * Replaces the person's emergency contacts and logs it (no contact details in the activity text). Once at
 * least one contact is on file, the onboarding item 'Emergency contacts added' is marked done.
 */
export function saveEmergencyContacts(
  draft: Draft<DB>,
  personId: ID,
  contacts: EmergencyContact[],
  what: string,
  date?: ISODate,
): boolean {
  const p = draft.people.find((x) => x.id === personId)
  if (!p) return false
  p.emergencyContacts = contacts.map((c) => ({ ...c }))
  logActivity(draft, { entityType: 'person', entityId: personId, kind: 'field_change', text: what })
  if (date && contacts.length) {
    for (const cl of draft.checklists) {
      if (cl.personId !== personId) continue
      const task = cl.tasks.find((t) => t.templateTaskId === EMERGENCY_CONTACTS_TASK && t.status === 'open')
      if (task) setTaskStatus(draft, cl.id, task.id, 'done', { date, byId: personId })
    }
  }
  return true
}

// ---- Policy acknowledgements -----------------------------------------------------------------

/**
 * Records an acknowledgement of the policy's current version for the person, and marks the matching
 * onboarding item (handbook or security policy acknowledged) done. Returns the new acknowledgement, or
 * null when the policy is missing or this version is already acknowledged.
 */
export function acknowledgePolicy(draft: Draft<DB>, policyId: ID, personId: ID, date: ISODate): Acknowledgment | null {
  const policy = draft.policies.find((p) => p.id === policyId)
  if (!policy) return null
  if (draft.acks.some((a) => a.personId === personId && a.policyId === policyId && sameVersion(a.version, policy.version))) return null
  const ack: Acknowledgment = { id: newId('ack'), policyId, version: policy.version, personId, acknowledgedOn: date }
  draft.acks.push(ack)
  logActivity(draft, {
    entityType: 'person',
    entityId: personId,
    kind: 'policy_ack',
    text: `Acknowledged ${policy.title} ${policy.version}`,
  })
  const taskTemplateId = ACK_TASK_FOR_POLICY[policyId]
  if (taskTemplateId) {
    for (const cl of draft.checklists) {
      if (cl.personId !== personId) continue
      const task = cl.tasks.find((t) => t.templateTaskId === taskTemplateId && t.status === 'open')
      if (task) setTaskStatus(draft, cl.id, task.id, 'done', { date, byId: personId })
    }
  }
  return ack
}
