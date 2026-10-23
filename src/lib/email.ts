// Email helpers. There is no server, so messages go out through the user's mail app (mailto) or the
// clipboard. Templates use {{field}} merge fields: firstName, jobTitle, companyName, senderName,
// times, calendly, stageName and any others the caller passes.
import type { DB, EmailTemplate, StageKind } from '@/domain/types'

export type MergeFields = Record<string, string | number | null | undefined>

/**
 * Fills {{field}} merge fields (spaces inside the braces are allowed). Missing fields become empty
 * text unless keepMissing is set, and runs of blank lines left behind are collapsed.
 */
export function fillTemplate(body: string, fields: MergeFields, opts: { keepMissing?: boolean } = {}): string {
  const out = body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) => {
    const v = fields[key]
    if (v == null || v === '') return opts.keepMissing ? whole : ''
    return String(v)
  })
  return out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n')
}

function encodeAddress(addr: string): string {
  return encodeURIComponent(addr.trim()).replace(/%40/g, '@')
}

/**
 * A mailto: link that opens the user's mail app with the message filled in. Line breaks are sent as
 * CRLF (RFC 6068). Pass several recipients as an array; bcc is for bulk close-out notes.
 */
export function mailtoHref(
  to: string | string[],
  subject: string,
  body: string,
  opts: { cc?: string[]; bcc?: string[] } = {},
): string {
  const list = (Array.isArray(to) ? to : [to]).filter((x) => x && x.trim())
  const params: string[] = []
  if (opts.cc?.length) params.push(`cc=${opts.cc.map(encodeAddress).join(',')}`)
  if (opts.bcc?.length) params.push(`bcc=${opts.bcc.map(encodeAddress).join(',')}`)
  params.push(`subject=${encodeURIComponent(subject)}`)
  params.push(`body=${encodeURIComponent(body.replace(/\r?\n/g, '\r\n'))}`)
  return `mailto:${list.map(encodeAddress).join(',')}?${params.join('&')}`
}

/** Built-in brief rejection notes, used when the workspace has no template in the brief tone. */
export function builtInBriefRejections(): EmailTemplate[] {
  return [
    {
      id: 'em-reject-early-brief',
      kind: 'rejection',
      stageKinds: ['new', 'recruiter_screen', 'intro'],
      tone: 'brief',
      name: 'Not moving forward (early stage, brief)',
      subject: 'Your application to {{companyName}}',
      body: 'Hi {{firstName}},\n\nThanks for applying for the {{jobTitle}} role. We will not be moving forward, and we wish you the best in your search.\n\n{{senderName}}',
    },
    {
      id: 'em-reject-late-brief',
      kind: 'rejection',
      stageKinds: ['technical', 'onsite', 'offer', 'custom'],
      tone: 'brief',
      name: 'Not moving forward (after interviews, brief)',
      subject: 'Following up on your interviews',
      body: 'Hi {{firstName}},\n\nThank you for your time with the team. We have decided not to move forward for the {{jobTitle}} role. We appreciate your interest in {{companyName}}.\n\n{{senderName}}',
    },
  ]
}

/**
 * The best rejection template for a stage and tone: an exact stage and tone match first, then a
 * built-in brief note, then any template for the stage, then any rejection template.
 */
export function pickRejectionTemplate(
  db: Pick<DB, 'emailTemplates'>,
  stageKind: StageKind,
  tone: 'kind' | 'brief' = 'kind',
): EmailTemplate | undefined {
  const rejections = db.emailTemplates.filter((t) => t.kind === 'rejection')
  const forStage = (t: EmailTemplate) => !t.stageKinds || t.stageKinds.length === 0 || t.stageKinds.includes(stageKind)
  const exact = rejections.find((t) => forStage(t) && (t.tone ?? 'kind') === tone)
  if (exact) return exact
  if (tone === 'brief') {
    const builtIn = builtInBriefRejections().find(forStage)
    if (builtIn) return builtIn
  }
  return rejections.find(forStage) ?? rejections[0]
}

/** Final-round rejections deserve a call, not just an email. */
export function suggestCallForRejection(stageKind: StageKind): boolean {
  return stageKind === 'onsite' || stageKind === 'offer'
}
