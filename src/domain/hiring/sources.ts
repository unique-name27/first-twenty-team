// Where a candidate came from, beyond the four source kinds: a candidate who applied on a live careers
// page is inbound with the source detail "Careers site" (src/careers/application.ts writes it), and the
// app shows and filters that detail wherever it shows the source, so those applicants are told apart.
import type { Candidate, SourceKind } from '@/domain/types'

/** Candidate.sourceDetail of an application from a careers page. */
export const CAREERS_SITE_DETAIL = 'Careers site'

export const SOURCE_LABEL: Record<SourceKind, string> = { inbound: 'Inbound', referral: 'Referral', outbound: 'Outbound', agency: 'Agency' }

/** True for a candidate who applied on the company's careers page. */
export function isCareersSiteCandidate(c: Pick<Candidate, 'source' | 'sourceDetail'>): boolean {
  return c.source === 'inbound' && c.sourceDetail === CAREERS_SITE_DETAIL
}

/**
 * A candidate's source as a short label: the kind ("Referral"), with its detail when asked ("Agency:
 * Talentlane") and always for a careers page applicant ("Inbound: Careers site"), which the plain kind
 * would hide among every other inbound candidate.
 */
export function sourceLabel(c: Pick<Candidate, 'source' | 'sourceDetail'>, detail = false): string {
  const kind = SOURCE_LABEL[c.source] ?? c.source
  return (detail || isCareersSiteCandidate(c)) && c.sourceDetail ? `${kind}: ${c.sourceDetail}` : kind
}
