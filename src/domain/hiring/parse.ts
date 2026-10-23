// Quick-add by paste: pull a name, email, phone, LinkedIn, GitHub, location and current role out of a
// pasted email signature, LinkedIn header or list of URLs. Pronouns and credentials are dropped (the
// app never stores pronouns). Duplicates are caught by email, phone or profile URL. Pure functions.
import type { DB, ID } from '@/domain/types'

export type ParsedCandidate = {
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
  linkedin?: string
  github?: string
  location?: string
  currentTitle?: string
  currentCompany?: string
}

function stateCodes(): string[] {
  return 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ')
}

function stateNames(): string[] {
  return [
    'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia',
    'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts',
    'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
    'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island',
    'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia',
    'Wisconsin', 'Wyoming',
  ]
}

function titleCase(word: string): string {
  if (!word) return word
  return word
    .split(/([-'])/)
    .map((part) => (part === '-' || part === "'" ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
    .join('')
}

/** Lowercased LinkedIn profile slug, or null. */
export function linkedinSlug(url: string | undefined | null): string | null {
  if (!url) return null
  const m = url.match(/linkedin\.com\/(?:in|pub)\/([A-Za-z0-9\-_%]+)/i)
  return m ? decodeURIComponent(m[1]).toLowerCase() : null
}

/** Lowercased GitHub username, or null. */
export function githubUser(url: string | undefined | null): string | null {
  if (!url) return null
  const m = url.match(/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![A-Za-z0-9-])/i)
  if (!m) return null
  const user = m[1].toLowerCase()
  const reserved = ['orgs', 'about', 'features', 'pricing', 'login', 'join', 'settings', 'topics', 'explore', 'marketplace', 'sponsors', 'apps']
  return reserved.includes(user) ? null : user
}

/** Digits of a US phone number (10 digits), or all digits for other numbers. */
export function phoneDigits(phone: string | undefined | null): string {
  if (!phone) return ''
  const d = phone.replace(/\D/g, '')
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d
}

export function normalizeEmail(email: string | undefined | null): string {
  return (email ?? '').trim().toLowerCase()
}

function formatPhone(raw: string): string {
  const d = phoneDigits(raw)
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  return raw.trim()
}

function stripNoise(line: string): string {
  return line
    .replace(/\((?:she|he|they|ze|xe)\s*\/\s*\w+(?:\s*\/\s*\w+)?\)/gi, '') // (She/Her)
    .replace(/\b(?:she|he|they)\s*\/\s*(?:her|him|them|hers|his|theirs)\b/gi, '')
    .replace(/[·•]\s*(1st|2nd|3rd|3rd\+)\b.*$/i, '') // LinkedIn degree badge
    .replace(/,?\s*\b(CPA|CFA|PhD|Ph\.D\.|MBA|PE|CISSP|CIA|EA|MD|JD|Esq\.?)\b\.?/g, '') // credentials
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const NAME_PARTICLES = ['de', 'del', 'della', 'da', 'di', 'van', 'von', 'der', 'den', 'la', 'le', 'du', 'bin', 'al', 'st.']

function looksLikeName(line: string): boolean {
  if (!line || line.length > 60) return false
  if (/[@\d:/|]|https?|www\./i.test(line)) return false
  if (/^(best|thanks|thank you|regards|kind regards|cheers|sincerely|warmly|hi|hello|hey|dear|sent from|get outlook|on .* wrote)\b/i.test(line)) return false
  // Contact labels left behind once the number or address is taken out ('Work Phone (408) 555-0101').
  if (/\b(phone|mobile|cell|tel|telephone|fax|e-?mail|website|portfolio|contact|linkedin|github)\b/i.test(line)) return false
  const words = line.split(/\s+/).filter(Boolean)
  if (words.length < 2 || words.length > 4) return false
  if (/\b(at|engineer|manager|director|lead|founder|ceo|cto|cfo|senior|staff|head|president|accountant|controller|designer|analyst|consultant|inc|llc|corp)\b/i.test(line)) return false
  return words.every((w) => NAME_PARTICLES.includes(w.toLowerCase()) || /^[A-Z\u00C0-\u024F][A-Za-z\u00C0-\u024F'.-]*$/.test(w))
}

/**
 * A line without its email addresses, links and phone numbers, and the separators left at its ends, so
 * 'Marco Bianchi marco.b@example.com' or 'marco.b@example.com | Marco Bianchi' still reads as a name.
 */
function withoutContacts(line: string): string {
  return line
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')
    .replace(/https?:\/\/\S+|\bwww\.\S+|\b(?:[a-z]{2,3}\.)?(?:linkedin|github)\.com\/\S*/gi, ' ')
    .replace(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\+\d{1,3}[\s.-]?\d[\d\s.-]{6,14}\d/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;|·•<>–-]+|[\s,;|·•<>–-]+$/g, '')
}

function splitName(full: string): { firstName: string; lastName: string } {
  const words = full.split(/\s+/).filter(Boolean)
  if (words.length === 1) return { firstName: words[0], lastName: '' }
  // Particles stay with the last name: "Ana de la Cruz" -> "Ana" + "de la Cruz".
  const p = words.findIndex((w, i) => i >= 1 && i < words.length - 1 && NAME_PARTICLES.includes(w.toLowerCase()))
  const i = p >= 0 ? p : words.length - 1
  return { firstName: words.slice(0, i).join(' '), lastName: words.slice(i).join(' ') }
}

function nameFromSlug(slug: string): { firstName: string; lastName: string } | null {
  const parts = slug
    .split(/[-_.]+/)
    .filter((p) => p && !/\d/.test(p) && !/^[0-9a-f]{6,}$/i.test(p))
  if (parts.length < 2) return null
  return { firstName: titleCase(parts[0]), lastName: titleCase(parts[parts.length - 1]) }
}

function nameFromEmail(email: string): { firstName: string; lastName: string } | null {
  const local = email.split('@')[0].replace(/\+.*$/, '').replace(/\d+/g, '')
  const parts = local.split(/[._-]+/).filter((p) => p.length > 1)
  if (parts.length < 2) return null
  return { firstName: titleCase(parts[0]), lastName: titleCase(parts[parts.length - 1]) }
}

function findLocation(lines: string[]): string | undefined {
  const codes = stateCodes()
  const names = stateNames()
  for (const raw of lines) {
    const line = raw.replace(/^(location|based in|located in)\s*[:\-]?\s*/i, '').replace(/[·•].*$/, '').trim()
    if (/@|https?:|www\./i.test(line)) continue
    const bay = line.match(/\b((?:San Francisco )?Bay Area|Silicon Valley|Greater [A-Z][a-z]+(?: [A-Z][a-z]+)* Area)\b/)
    if (bay) return bay[1]
    const m = line.match(/\b([A-Z][a-zA-Z.'\- ]{1,30}?),\s*([A-Z]{2}|[A-Z][a-z]+(?: [A-Z][a-z]+)?)\b/)
    if (m) {
      const st = m[2]
      if (codes.includes(st) || names.includes(st)) return `${m[1].trim()}, ${st}`
    }
  }
  return undefined
}

/** Parses a pasted blob (signature, LinkedIn header, URLs) into candidate fields. */
export function parseCandidateBlob(text: string): ParsedCandidate {
  const out: ParsedCandidate = {}
  const src = (text ?? '').replace(/\r/g, '')
  const lines = src
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  // "Name <email>" is the strongest signal for both.
  const angle = src.match(/(?:^|\n|,)\s*"?([^"<>\n,@]{2,60}?)"?\s*<\s*([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)\s*>/)
  const email = angle?.[2] ?? src.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0]
  if (email) out.email = email.replace(/[.,;]+$/, '').toLowerCase()

  const li = src.match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[A-Za-z0-9\-_%]+\/?/i)
  if (li) {
    const slug = linkedinSlug(li[0])
    if (slug) out.linkedin = `https://www.linkedin.com/in/${slug}`
  }
  const gh = src.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9-]+/i)
  if (gh) {
    const user = githubUser(gh[0])
    if (user) out.github = `https://github.com/${user}`
  }

  // Phones: skip digit runs that are part of URLs.
  const noUrls = src.replace(/https?:\/\/\S+|\b(?:www\.)?(?:linkedin|github)\.com\/\S+/gi, ' ')
  const phone = noUrls.match(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\+\d{1,3}[\s.-]?\d[\d\s.-]{6,14}\d/)
  if (phone) out.phone = formatPhone(phone[0])

  // Name: "Name: X", then "Name <email>", then the first name-like line (with any email, link or phone on
  // that line taken out), then the LinkedIn slug, then the email.
  let name: { firstName: string; lastName: string } | null = null
  const labeled = src.match(/^\s*(?:name|candidate)\s*[:\-]\s*(.+)$/im)
  if (labeled) {
    const cleaned = stripNoise(labeled[1])
    if (cleaned.split(/\s+/).length >= 2) name = splitName(cleaned)
  }
  if (!name && angle) {
    const cleaned = stripNoise(angle[1])
    if (looksLikeName(cleaned)) name = splitName(cleaned)
  }
  let nameLineIndex = -1
  if (!name) {
    for (let i = 0; i < lines.length; i++) {
      const bare = withoutContacts(lines[i].replace(/\s*[|,-]\s*LinkedIn\s*$/i, ''))
      const cleaned = stripNoise(bare.split(/\s+[|]\s+|\s+-\s+/)[0])
      if (looksLikeName(cleaned)) {
        name = splitName(cleaned)
        nameLineIndex = i
        break
      }
    }
  }
  if (!name && out.linkedin) name = nameFromSlug(linkedinSlug(out.linkedin) ?? '')
  if (!name && out.email) name = nameFromEmail(out.email)
  if (name) {
    out.firstName = name.firstName
    if (name.lastName) out.lastName = name.lastName
  }

  // Current role: "Senior Engineer at Acme", "Staff Engineer | Brightwave", or a LinkedIn title line.
  const roleLines = nameLineIndex >= 0 ? lines.slice(nameLineIndex + 1, nameLineIndex + 4) : lines
  for (const raw of roleLines) {
    const line = stripNoise(raw)
    if (/@|https?:|www\.|\d{3}/i.test(line)) continue
    const at = line.match(/^(.{3,80}?)\s+(?:at|@)\s+(.{2,60})$/i)
    const bar = line.match(/^(.{3,80}?)\s+[|,]\s+(.{2,60})$/)
    const m = at ?? bar
    if (m && /[A-Za-z]/.test(m[1]) && !looksLikeName(m[1])) {
      out.currentTitle = m[1].trim()
      out.currentCompany = m[2].replace(/\s*[·•].*$/, '').trim()
      break
    }
  }

  const loc = findLocation(lines)
  if (loc) out.location = loc
  return out
}

/** Candidates that match by email, phone, LinkedIn profile or GitHub username. */
export function findDuplicates(
  db: Pick<DB, 'candidates'>,
  q: { email?: string; linkedin?: string; github?: string; phone?: string },
  exceptId?: ID,
): ID[] {
  const email = normalizeEmail(q.email)
  const li = linkedinSlug(q.linkedin)
  const gh = githubUser(q.github)
  const ph = phoneDigits(q.phone)
  const out: ID[] = []
  for (const c of db.candidates) {
    if (c.id === exceptId) continue
    const hit =
      (!!email && normalizeEmail(c.email) === email) ||
      (!!li && linkedinSlug(c.links.linkedin) === li) ||
      (!!gh && githubUser(c.links.github) === gh) ||
      (ph.length >= 10 && phoneDigits(c.phone) === ph)
    if (hit) out.push(c.id)
  }
  return out
}
