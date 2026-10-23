// Optional severance release at an exit: review periods that never need anyone's age, the SB 331
// statements, a draft to copy or print for counsel, and a status-and-date record (never the file).
import { useState } from 'react'
import { getRule, ruleApplies } from '@/domain/compliance'
import { fullName } from '@/domain/people'
import type { DocumentRecord, Person } from '@/domain/types'
import { fmtDate, today } from '@/lib/dates'
import { copyText, escapeHTML, printHTML } from '@/lib/files'
import { newId } from '@/lib/id'
import { logActivity, useDB } from '@/store/db'
import { Badge, Button, Checkbox, CitationChip, Icon, SectionLabel, toast } from '@/ui'
import { releaseTerms, releaseText } from './helpers'
import { NotLegalAdvice, undoToast } from './parts'

export const RELEASE_DOC_NAME = 'Severance release'

const SB331_URL = 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=GOV&sectionNum=12964.5.'
const OWBPA_URL = 'https://www.law.cornell.edu/uscode/text/29/626'

export function SeveranceRelease({ person }: { person: Person }) {
  const db = useDB((s) => s.db)
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState(false)
  const sep = person.separation
  if (!sep) return null
  const t = today()
  const adeaRule = getRule('adea')
  const adea = !!adeaRule && ruleApplies(db, adeaRule, t)
  const terms = releaseTerms(adea, group)
  const name = fullName(person)
  const record = db.documents.find((d) => d.personId === person.id && d.name === RELEASE_DOC_NAME)
  const text = releaseText({ company: db.company.legalName || db.company.name, name, lastDay: sep.lastDay, terms })
  const periods = `${terms.considerDays} ${terms.considerUnit} to consider${terms.revokeDays ? ` and ${terms.revokeDays} days to revoke` : ''}`

  const setStatus = (status: DocumentRecord['status']) => {
    const label = status === 'sent' ? `Recorded the severance release as sent to ${name}` : `Recorded the severance release as signed by ${name}`
    useDB.getState().mutate(label, (d) => {
      const existing = d.documents.find((x) => x.personId === person.id && x.name === RELEASE_DOC_NAME)
      if (existing) {
        existing.status = status
        existing.date = t
      } else {
        d.documents.push({ id: newId('doc'), personId: person.id, type: 'other', name: RELEASE_DOC_NAME, status, date: t })
      }
      logActivity(d, { entityType: 'person', entityId: person.id, kind: 'document_added', text: label })
    })
    undoToast(label)
  }

  const copy = async () => {
    const ok = await copyText(text)
    toast(ok ? 'Copied the draft release' : { text: 'Copy was blocked. Select the text in the preview instead.', tone: 'bad' })
  }
  const print = () => {
    const html = text
      .split('\n')
      .map((line, i) => (i === 0 ? `<h1>${escapeHTML(line)}</h1>` : line ? `<p>${escapeHTML(line)}</p>` : ''))
      .join('')
    if (!printHTML(`Severance release for ${name}`, html)) {
      void copy()
    }
  }

  return (
    <section aria-label="Severance release">
      <SectionLabel>Severance release (optional)</SectionLabel>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {record && (
          <Badge tone={record.status === 'signed' ? 'good' : 'neutral'} icon={record.status === 'signed' ? 'check' : 'file'}>
            {record.status === 'signed' ? 'Signed' : 'Sent'} {record.date ? fmtDate(record.date) : ''}
          </Badge>
        )}
        <Button variant="secondary" icon={open ? 'chevron-up' : 'file'} aria-expanded={open} aria-controls="severance-release" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide the release helper' : record ? 'Open the release helper' : 'Prepare a severance release'}
        </Button>
      </div>
      {open && (
        <div id="severance-release" className="mt-3 flex flex-col gap-3 rounded-xl border border-line px-4 py-3 text-[14px] text-ink-2">
          <p>
            <strong className="text-ink">{periods}.</strong>{' '}
            {adea
              ? 'The federal ADEA applies here, so everyone gets these periods and nobody needs to share their age.'
              : 'California requires at least 5 business days to consult an attorney. Once the federal ADEA applies (20 employees for 20 weeks), this switches to 21 days to consider and 7 to revoke for everyone, so age is never needed.'}
          </p>
          {adea && (
            <Checkbox
              checked={group}
              onChange={setGroup}
              label="Offered to a group, such as a layoff of 2 or more"
              description="Group programs get 45 days to consider and 7 to revoke, plus a written disclosure counsel prepares."
            />
          )}
          <ul className="flex flex-col gap-1.5">
            <li className="flex items-start gap-2">
              <Icon name="check" size={16} className="mt-0.5 shrink-0 text-ink-3" />
              The right to consult an attorney, with the review period above
            </li>
            <li className="flex items-start gap-2">
              <Icon name="check" size={16} className="mt-0.5 shrink-0 text-ink-3" />
              The required carve-out: nothing stops them discussing unlawful acts in the workplace
            </li>
            <li className="flex items-start gap-2">
              <Icon name="check" size={16} className="mt-0.5 shrink-0 text-ink-3" />
              Final pay, accrued vacation owed and vested options never depend on signing
            </li>
          </ul>
          <pre tabIndex={0} aria-label="Draft release text" className="max-h-56 overflow-auto rounded-lg bg-surface-2 px-3 py-2 font-sans text-[13px] whitespace-pre-wrap text-ink-2">{text}</pre>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon="copy" onClick={() => void copy()}>
              Copy the draft
            </Button>
            <Button variant="secondary" icon="printer" onClick={print}>
              Print
            </Button>
            {(!record || record.status === 'not_sent') && (
              <Button variant="primary" icon="check" onClick={() => setStatus('sent')}>
                Record as sent today
              </Button>
            )}
            {record?.status === 'sent' && (
              <Button variant="primary" icon="check" onClick={() => setStatus('signed')}>
                Record as signed today
              </Button>
            )}
          </div>
          <p className="text-[13px] text-ink-3">Only the status and date are kept here. The signed release stays with counsel or your e-sign tool.</p>
          <div className="flex flex-wrap items-center gap-2">
            <CitationChip label="Gov Code 12964.5 (SB 331)" url={SB331_URL} />
            {adea && <CitationChip label="29 U.S.C. 626(f) (OWBPA)" url={OWBPA_URL} />}
          </div>
          <NotLegalAdvice />
        </div>
      )}
    </section>
  )
}
