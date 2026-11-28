// I-9: one place to see who has finished Form I-9 and whose work authorization needs reverifying.
// Status and dates only: the form and ID documents live with the PEO or payroll provider and are
// never stored here (ARCHITECTURE.md, privacy). Facts and links: docs/LAW.md b-i9-deadlines,
// b-i9-retention, b-i9-edition, b-i9-reverify.
import { useEffect, useMemo, useState } from 'react'
import { links } from '@/app/router'
import { providerPhrase } from '@/domain/payrun'
import { fullName } from '@/domain/people'
import { fmtDate, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Badge, Button, CitationChip, DataTable, DateInput, EmptyState, Field, Icon, Modal, Panel, TextLink } from '@/ui'
import { LegalNote } from './bits'
import { type I9Row, type I9RowState, i9Rows, i9StepText, REVERIFY_SOON_DAYS, type Tone } from './helpers'
import { commit } from './mutate'

const SOURCES = {
  form: { label: 'USCIS: Form I-9', url: 'https://www.uscis.gov/i-9' },
  section1: { label: 'USCIS: Section 1', url: 'https://www.uscis.gov/i-9-central/complete-correct-form-i-9/completing-section-1-employee-information-and-attestation' },
  section2: { label: 'USCIS: Section 2', url: 'https://www.uscis.gov/i-9-central/complete-correct-form-i-9/completing-section-2-employer-review-and-attestation' },
  retention: { label: 'USCIS M-274: retention', url: 'https://www.uscis.gov/i-9-central/form-i-9-resources/handbook-for-employers-m-274/100-retaining-form-i-9' },
  reverify: { label: 'USCIS: Reverification', url: 'https://www.uscis.gov/i-9-central/complete-correct-form-i-9/completing-supplement-b-reverification-and-rehires-formerly-section-3' },
}

const ROW_CHIP: Record<I9RowState, { label: string; tone: Tone }> = {
  overdue: { label: 'Overdue', tone: 'bad' },
  reverify_soon: { label: 'Reverify soon', tone: 'warn' },
  due: { label: 'In progress', tone: 'accent' },
  not_tracked: { label: 'Not tracked', tone: 'neutral' },
  done: { label: 'Done', tone: 'good' },
}

export function I9Tab() {
  const db = useDB((s) => s.db)
  const t = today()
  const rows = useMemo(() => i9Rows(db, t), [db, t])
  const [editing, setEditing] = useState<I9Row | null>(null)
  const providerUrl = db.company.payrollProvider.url || db.company.linkOuts.payroll
  const providerName = providerPhrase(db.company)

  return (
    <div className="flex flex-col gap-5">
      <Panel title="Where the form gets filled in" icon="file">
        <p className="text-[14.5px] text-ink-2">
          Each new employee completes Form I-9 with {providerName}, or on the official USCIS form. This page tracks status and dates only. It never stores the
          form or ID documents.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {providerUrl ? (
            <a
              href={providerUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 font-semibold text-accent underline decoration-accent/30 hover:decoration-accent"
            >
              Complete or reverify in {providerName}
              <Icon name="external" size={14} />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : (
            <TextLink href={links.settings('links')}>Add your PEO or payroll link in Settings</TextLink>
          )}
          <CitationChip label={SOURCES.form.label} url={SOURCES.form.url} />
        </div>
      </Panel>

      <Panel title="Every employee" icon="users" padded={false} subtitle={`Current and incoming employees, and anyone who left with a section still open. Overdue first; reverification shows ${REVERIFY_SOON_DAYS} days ahead.`}>
        <DataTable<I9Row>
          rows={rows}
          rowKey={(r) => r.person.id}
          caption="Form I-9 status for each employee"
          empty={<EmptyState compact icon="users" title="No employees yet" body="Each hire gets I-9 section 1 and 2 tasks on their onboarding checklist." />}
          columns={[
            {
              key: 'name',
              header: 'Person',
              cell: (r) => <TextLink href={links.person(r.person.id)}>{fullName(r.person)}</TextLink>,
              sort: (r) => fullName(r.person),
            },
            { key: 'state', header: 'Status', cell: (r) => <Badge tone={ROW_CHIP[r.state].tone}>{ROW_CHIP[r.state].label}</Badge> },
            { key: 'start', header: 'Start', cell: (r) => fmtDate(r.person.startDate), sort: (r) => r.person.startDate, hideBelow: 'sm' },
            { key: 's1', header: 'Section 1', cell: (r) => <StepText text={i9StepText(r.section1)} late={r.section1.state === 'overdue'} /> },
            { key: 's2', header: 'Section 2', cell: (r) => <StepText text={i9StepText(r.section2)} late={r.section2.state === 'overdue'} /> },
            {
              key: 'reverify',
              header: 'Reverify by',
              sort: (r) => r.reverifyOn ?? '9999',
              cell: (r) => (
                <Button
                  size="sm"
                  onClick={() => setEditing(r)}
                  aria-label={
                    r.reverifyOn
                      ? `${fmtDate(r.reverifyOn)}${r.reverify === 'overdue' ? ', past' : ''}: change the reverify date for ${fullName(r.person)}`
                      : `Set date: reverify date for ${fullName(r.person)}`
                  }
                >
                  {r.reverifyOn ? fmtDate(r.reverifyOn) : 'Set date'}
                </Button>
              ),
            },
            {
              key: 'keep',
              header: 'Keep at least until',
              cell: (r) => (r.keepAtLeastUntil ? fmtDate(r.keepAtLeastUntil) : <span className="text-ink-3">While employed</span>),
              sort: (r) => r.keepAtLeastUntil,
              hideBelow: 'md',
            },
          ]}
        />
        <p className="border-t border-line px-5 py-3 text-[13px] text-ink-3">
          Reverify by is only for time-limited work authorization. Never reverify US citizens, noncitizen nationals or permanent residents who showed a Green
          Card, and never reverify a List B identity document. Record the date only, never the document.{' '}
          <CitationChip label={SOURCES.reverify.label} url={SOURCES.reverify.url} />
        </p>
      </Panel>

      <Panel title="The deadlines" icon="clock">
        <ul className="flex flex-col gap-3 text-[14.5px] text-ink-2">
          <li>
            <span className="font-semibold text-ink">Section 1: by the first day of work.</span> The employee fills it in and signs it.{' '}
            <CitationChip label={SOURCES.section1.label} url={SOURCES.section1.url} />
          </li>
          <li>
            <span className="font-semibold text-ink">Section 2: within 3 business days of the first day of work for pay.</span> You review the documents, for
            example a Monday start is due Thursday. If the job lasts less than 3 business days, complete it by the first day of work for pay.{' '}
            <CitationChip label={SOURCES.section2.label} url={SOURCES.section2.url} />
          </li>
          <li>
            <span className="font-semibold text-ink">Keep it 3 years from hire, or 1 year after the last day, whichever is later.</span>{' '}
            <CitationChip label={SOURCES.retention.label} url={SOURCES.retention.url} />
          </li>
        </ul>
        <LegalNote className="mt-4" />
      </Panel>

      <ReverifyModal row={editing} onClose={() => setEditing(null)} />
    </div>
  )
}

function StepText({ text, late }: { text: string; late: boolean }) {
  return <span className={late ? 'font-semibold text-bad' : 'text-ink'}>{text}</span>
}

function ReverifyModal({ row, onClose }: { row: I9Row | null; onClose: () => void }) {
  const [date, setDate] = useState<string>('')
  // Empty until the admin enters the date from the document: never a guessed default.
  useEffect(() => {
    if (row) setDate(row.reverifyOn ?? '')
  }, [row])
  if (!row) return null
  const name = fullName(row.person)
  const close = onClose
  return (
    <Modal
      open
      onClose={close}
      title={`Reverify date: ${name}`}
      footer={
        <>
          {row.reverifyOn && (
            <Button
              onClick={() => {
                commit(`Removed the I-9 reverify date for ${name}`, (d) => {
                  const p = d.people.find((x) => x.id === row.person.id)
                  if (p) delete p.i9ReverifyOn
                })
                close()
              }}
            >
              Remove date
            </Button>
          )}
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!date}
            onClick={() => {
              commit(`Set the I-9 reverify date for ${name} to ${fmtDate(date)}`, (d) => {
                const p = d.people.find((x) => x.id === row.person.id)
                if (p) p.i9ReverifyOn = date
              })
              close()
            }}
          >
            Save date
          </Button>
        </>
      }
    >
      <p className="text-[14px] text-ink-2">
        Only for time-limited work authorization: the date it expires, from the document you reviewed. Never for US citizens, noncitizen nationals, permanent
        residents who showed a Green Card, or a List B identity document. Record the date only, never the document. It shows on the compliance calendar.
      </p>
      <Field label="Reverify by" className="mt-3">
        {(id, describedBy) => <DateInput id={id} aria-describedby={describedBy} value={date} onChange={setDate} />}
      </Field>
    </Modal>
  )
}
