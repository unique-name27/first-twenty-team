// The in-app HR assistant's name, shared by the app (header button, the Ask sheet, Settings > Company) and the
// server (GET /api/assistant, the system prompt; docs/SERVER.md "Lark, the assistant"). A company may name it
// (company.assistantName); otherwise it is the company's name and "Bot" ("Quillfin Bot"). The sample company
// calls it Lark.
//
// The server reads the company document a browser uploaded, so these functions take any shape and never
// throw: a name that is not text, is blank or holds control characters counts as unset, and one that is too
// long is cut to the limit (the app's form never saves one that long).
//
// Also shared: the context note the server puts at the start of a question (who the assistant is, for
// which company, and today's date), which the app never shows as part of the question; and the official
// sources an answer may link to outside the app.
import { LAW_SOURCES } from '../data/law'
import { RULES } from './compliance/rules'
import type { Company } from './types'

/** The longest assistant name Settings > Company saves. */
export const ASSISTANT_NAME_MAX = 40
/** Longest company name the default name uses (sign-up allows 80). */
const COMPANY_NAME_MAX = 80
/** The company part of the default name when the company has no name yet. */
export const FALLBACK_COMPANY_NAME = 'Company'

// C0 controls, DEL and C1 controls: a name ends up in page text, aria labels and the system prompt.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
/** The same characters minus tab and line breaks, which a typed name may hold as plain whitespace. */
const TYPED_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/

/** Text with runs of whitespace as one space, control characters dropped, trimmed, at most `max` characters. */
function cleanName(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  const text = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  return Array.from(text).slice(0, max).join('').trim()
}

/** The default name for a company: '<company name> Bot', or 'Company Bot' while it has no name. */
export function defaultAssistantName(company: Partial<Pick<Company, 'name'>> | null | undefined): string {
  return `${cleanName(company?.name, COMPANY_NAME_MAX) || FALLBACK_COMPANY_NAME} Bot`
}

/** What the assistant is called: the company's assistantName when it set one, else defaultAssistantName. */
export function assistantDisplayName(company: Partial<Pick<Company, 'name' | 'assistantName'>> | null | undefined): string {
  return cleanName(company?.assistantName, ASSISTANT_NAME_MAX) || defaultAssistantName(company)
}

/**
 * What Settings > Company stores for a typed name: the trimmed text, or undefined for an empty field (the
 * default name applies again). Validate first with assistantNameError.
 */
export function normalizeAssistantName(raw: string): string | undefined {
  const text = raw.replace(/\s+/g, ' ').trim()
  return text === '' ? undefined : text
}

/** The problem with a typed assistant name, or null when it can be saved (an empty field is fine). */
export function assistantNameError(raw: string): string | null {
  if (TYPED_CONTROL.test(raw)) return 'Use letters, numbers and punctuation only.'
  const text = normalizeAssistantName(raw) ?? ''
  if (Array.from(text).length > ASSISTANT_NAME_MAX) return `Keep it to ${ASSISTANT_NAME_MAX} characters or fewer.`
  return null
}

// ---------------------------------------------------------------------------------------------
// The context note
// ---------------------------------------------------------------------------------------------

/**
 * The server starts a question with this note (a text block of its own, before the question) on the first
 * question of a conversation and whenever what it says changes (a new day, a rename): who the assistant
 * is, for which company, and today's date. It goes into the conversation instead of the system prompt, so
 * the system prompt never changes under a running conversation (server/src/assistant/prompt.ts).
 */
export const ASSISTANT_CONTEXT_OPEN = '<app_context>'
export const ASSISTANT_CONTEXT_CLOSE = '</app_context>'

/** Whether a text block is a context note. */
export function isAssistantContext(text: unknown): boolean {
  return typeof text === 'string' && text.startsWith(ASSISTANT_CONTEXT_OPEN) && text.endsWith(ASSISTANT_CONTEXT_CLOSE)
}

/**
 * The texts of a user message that the person typed: its text blocks in order, without a leading context
 * note (a note counts only as the first of two or more text blocks, where the server puts it).
 */
export function questionTexts(texts: readonly string[]): string[] {
  return texts.length > 1 && isAssistantContext(texts[0]) ? texts.slice(1) : [...texts]
}

// ---------------------------------------------------------------------------------------------
// Official sources an answer may link to
// ---------------------------------------------------------------------------------------------

let officialHosts: ReadonlySet<string> | null = null

/**
 * The sites an answer may link to outside the app: the hosts of the official sources the assistant's
 * lookups return (law_facts: the sources in src/data/law.ts and the compliance rules' citations;
 * compliance_status: the rules' citations), each with and without "www.". Any other address in an answer
 * is shown as text that cannot be followed: a planted instruction in a record must not be able to turn an
 * answer into a link that carries company data, or a sign-in page, to someone else's site.
 */
export function officialSourceHosts(): ReadonlySet<string> {
  if (officialHosts) return officialHosts
  const hosts = new Set<string>()
  for (const url of [...Object.values(LAW_SOURCES).map((s) => s.url), ...RULES.map((r) => r.citation.url)]) {
    try {
      const u = new URL(url)
      if (u.protocol !== 'https:') continue
      const host = u.hostname.toLowerCase()
      hosts.add(host)
      hosts.add(host.startsWith('www.') ? host.slice(4) : `www.${host}`)
    } catch {
      /* not an address */
    }
  }
  officialHosts = hosts
  return hosts
}

/** Whether an https address goes to one of the official sources (officialSourceHosts). */
export function isOfficialSourceHost(hostname: string): boolean {
  return officialSourceHosts().has(hostname.toLowerCase())
}
