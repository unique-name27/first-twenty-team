// Records and retention: retain-until dates (computed, never remembered), the applicant anonymize
// queue with one-tap anonymize, and a records-request tracker with statutory clocks.
import { useEffect, useMemo, useState } from 'react'
import { links } from '@/app/router'
import { anonymizeQueue, isFehaEmployerOn, personRetention } from '@/domain/compliance'
import { anonymizeCandidate } from '@/domain/compliance/actions'
import { fullName, isEmployedOn } from '@/domain/people'
import type { DB, Person, RecordsRequest } from '@/domain/types'
import { addDays, fmtDate, type ISODate, today } from '@/lib/dates'
import { plural } from '@/lib/format'
import { newId } from '@/lib/id'
import { useDB } from '@/store/db'
import { logActivity } from '@/store/draft'
import { Badge, Button, ChipGroup, CitationChip, DataTable, DateChips, EmptyState, Field, Icon, Modal, Panel, Select, TextLink } from '@/ui'
import { LegalNote } from './bits'
import { applicantRecordStats, RECORDS_REQUEST_TYPES, recordsRequestDueOn, recordsRequestState, requestTypeInfo } from './helpers'
import { commit } from './mutate'

const SOURCES = {
  gov12946: { label: 'Gov. Code 12946', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=12946.&lawCode=GOV' },
  i9: { label: 'USCIS M-274: I-9 retention', url: 'https://www.uscis.gov/i-9-central/form-i-9-resources/handbook-for-employers-m-274/100-retaining-form-i-9' },
  lc1198: { label: 'Labor Code 1198.5', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=1198.5.&lawCode=LAB' },
  lc226: { label: 'Labor Code 226 and 1174', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=LAB&sectionNum=226' },
}

export function RecordsTab() {
  const db = useDB((s) => s.db)
  const [adding, setAdding] = useState(false)
  return (
    <div className="flex flex-col gap-5">
      <Panel title="How long to keep records" icon="clock" subtitle="Retention is computed from dates in the app, so nobody has to remember it.">
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <RetentionRule title="Applicant records: 4 years" body="From the hiring decision. Applications, notes, scorecards and selection criteria. Delete becomes Archive until then." source={SOURCES.gov12946} />
          <RetentionRule title="Form I-9: 3 years or 1 year after exit" body="Whichever is later: 3 years from the start date, or 1 year after the last day. The form itself lives with your PEO." source={SOURCES.i9} />
          <RetentionRule
            title="Personnel files: 4 years after exit"
            body="Employers with 5 or more employees keep personnel records 4 years after the employment action; 3 years after termination is the floor below 5."
            source={SOURCES.lc1198}
            extra={SOURCES.gov12946}
          />
          <RetentionRule title="Payroll records: 3 years" body="Wage statements and payroll records, at least 3 years. Your PEO or payroll provider keeps the originals." source={SOURCES.lc226} />
        </ul>
        <LegalNote className="mt-4" />
      </Panel>
      <PeopleRetention db={db} />
      <ApplicantRecords db={db} />
      <RequestsPanel db={db} onAdd={() => setAdding(true)} />
      <AddRequestModal open={adding} onClose={() => setAdding(false)} />
    </div>
  )
}

function RetentionRule({ title, body, source, extra }: { title: string; body: string; source: { label: string; url: string }; extra?: { label: string; url: string } }) {
  return (
    <li className="flex flex-col gap-1.5">
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      <p className="text-[14px] text-ink-2">{body}</p>
      <div className="flex flex-wrap gap-2">
        <CitationChip label={source.label} url={source.url} />
        {extra && <CitationChip label={extra.label} url={extra.url} />}
      </div>
    </li>
  )
}

type RetRow = { person: Person; lastDay: ISODate; i9: ISODate | null; personnel: ISODate | null; payroll: ISODate | null }

function PeopleRetention({ db }: { db: DB }) {
  const t = today()
  const former: RetRow[] = useMemo(
    () =>
      db.people
        .filter((p) => !!(p.separation?.lastDay ?? p.endDate) && !isEmployedOn(p, t) && p.startDate <= t)
        .map((p) => {
          const lastDay = (p.separation?.lastDay ?? p.endDate) as ISODate
          const r = personRetention(p, { fehaEmployer: isFehaEmployerOn(db, lastDay) })
          return { person: p, lastDay, i9: r.i9, personnel: r.personnelFile, payroll: r.payroll }
        })
        .sort((a, b) => b.lastDay.localeCompare(a.lastDay)),
    [db, t],
  )
  const current = db.people.filter((p) => isEmployedOn(p, t) || p.startDate > t).length
  const kept = (d: ISODate | null) => (d ? <span className={d < t ? 'font-semibold text-good' : 'text-ink'}>{fmtDate(d)}</span> : <span className="text-ink-3">While employed</span>)
  return (
    <Panel title="People records" icon="users" padded={false} subtitle={`${plural(current, 'current or incoming employee')}: keep everything while they work here. Former employees below.`}>
      <DataTable<RetRow>
        rows={former}
        rowKey={(r) => r.person.id}
        rowHref={(r) => links.person(r.person.id)}
        caption="Retain-until dates for former employees"
        empty={<EmptyState compact icon="users" title="No former employees" body="When someone leaves, their retain-until dates appear here." />}
        columns={[
          { key: 'name', header: 'Person', cell: (r) => fullName(r.person), sort: (r) => fullName(r.person) },
          { key: 'last', header: 'Last day', cell: (r) => fmtDate(r.lastDay), sort: (r) => r.lastDay },
          { key: 'i9', header: 'I-9 until', cell: (r) => kept(r.i9), sort: (r) => r.i9 },
          { key: 'file', header: 'Personnel file until', cell: (r) => kept(r.personnel), sort: (r) => r.personnel },
          { key: 'pay', header: 'Payroll until', cell: (r) => kept(r.payroll), sort: (r) => r.payroll, hideBelow: 'sm' },
        ]}
      />
      <p className="border-t border-line px-5 py-3 text-[13px] text-ink-3">A date shown in green has passed: those records may be destroyed under your own policy. The app never deletes a person.</p>
    </Panel>
  )
}

function ApplicantRecords({ db }: { db: DB }) {
  const t = today()
  const stats = useMemo(() => applicantRecordStats(db, t), [db, t])
  const queue = useMemo(() => anonymizeQueue(db, t), [db, t])
  const anonymize = (candidateId: string, name: string) =>
    commit(`Anonymized the applicant record for ${name}`, (d) => anonymizeCandidate(d, candidateId, t), { noChange: 'That record is still inside its retention period.' })
  return (
    <Panel title="Applicant records" icon="briefcase" subtitle="Kept 4 years after the decision, then offered for anonymizing. Counts stay for hiring metrics.">
      <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          { label: 'Candidate records', value: stats.total },
          { label: 'In process or hired', value: stats.inProcess },
          { label: 'Inside 4 years', value: stats.retained },
          { label: 'Anonymized', value: stats.anonymized },
        ].map((s) => (
          <div key={s.label}>
            <dt className="text-[13px] font-semibold text-ink-3">{s.label}</dt>
            <dd className="num mt-0.5 font-display text-[24px] leading-none font-bold text-ink">{s.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 border-t border-line pt-4">
        <h3 className="text-[15px] font-bold text-ink">Anonymize queue</h3>
        {queue.length === 0 ? (
          <p className="mt-1 text-[14px] text-ink-2">
            No applicant records are past their 4-year retention date.
            {stats.next ? ` The first one becomes eligible on ${fmtDate(stats.next.retainUntil)}.` : ''}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {queue.map((q) => (
              <li key={q.candidateId} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <a href={links.candidate(q.candidateId)} className="text-[14.5px] font-semibold text-ink hover:text-accent">
                    {q.name}
                  </a>
                  <p className="text-[13px] text-ink-3">
                    Kept until {fmtDate(q.retainUntil)}
                    {q.lastDecisionOn ? `; decided ${fmtDate(q.lastDecisionOn)}` : ''}. {q.reason}
                  </p>
                </div>
                <Button icon="eye-off" onClick={() => anonymize(q.candidateId, q.name)}>
                  Anonymize
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[13px] text-ink-3">Anonymizing removes the name, contact details, links, notes and desired pay. Stage history and dates stay.</p>
      </div>
    </Panel>
  )
}

function RequestsPanel({ db, onAdd }: { db: DB; onAdd: () => void }) {
  const t = today()
  const rows = [...db.recordsRequests].sort((a, b) => Number(!!a.fulfilledOn) - Number(!!b.fulfilledOn) || a.dueOn.localeCompare(b.dueOn))
  const open = rows.filter((r) => !r.fulfilledOn).length
  const name = (id: string) => {
    const p = db.people.find((x) => x.id === id)
    return p ? fullName(p) : 'Unknown person'
  }
  const fulfil = (r: RecordsRequest) =>
    commit(`Marked fulfilled: ${requestTypeInfo(r.type).label.toLowerCase()} request from ${name(r.personId)}`, (d) => {
      const row = d.recordsRequests.find((x) => x.id === r.id)
      if (!row || row.fulfilledOn) return
      row.fulfilledOn = t
      logActivity(d, { entityType: 'person', entityId: r.personId, kind: 'records_request_fulfilled', text: `${requestTypeInfo(r.type).label} request fulfilled on ${fmtDate(t)}` })
    })
  return (
    <Panel
      title="Records requests"
      icon="file"
      padded={false}
      subtitle="Current and former employees can ask for their records. Each request gets its clock."
      actions={
        <Button variant="primary" icon="plus" onClick={onAdd}>
          Add request
        </Button>
      }
    >
      <div className="flex flex-wrap gap-x-5 gap-y-2 border-b border-line px-5 py-3">
        {RECORDS_REQUEST_TYPES.map((x) => (
          // Wraps so the label, the days and the citation chip never run past the panel at 150% on a phone.
          <div key={x.value} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-ink-2">
            <span className="font-semibold text-ink">{x.label}:</span>
            <span>{x.statutory ? `${x.days} days` : 'promptly'}</span>
            <CitationChip label={x.citation.label} url={x.citation.url} />
          </div>
        ))}
      </div>
      {rows.length === 0 ? (
        <EmptyState
          compact
          icon="file"
          title="No records requests"
          body="When someone asks for their personnel file, pay records or a signed document, add it here so the deadline is visible."
          action={
            <Button icon="plus" onClick={onAdd}>
              Add request
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => {
            const st = recordsRequestState(r, t)
            const info = requestTypeInfo(r.type)
            return (
              <li key={r.id} className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold text-ink">
                    {info.label} for {name(r.personId)}
                  </p>
                  <p className="text-[13.5px] text-ink-3">
                    Received {fmtDate(r.receivedOn)}; due {fmtDate(r.dueOn)}. {info.clock}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge tone={st.tone} icon={r.fulfilledOn ? 'check' : st.tone === 'bad' ? 'alert' : 'clock'}>
                    {st.label}
                  </Badge>
                  {!r.fulfilledOn && (
                    <Button icon="check" onClick={() => fulfil(r)}>
                      Mark fulfilled today
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {open > 0 && <p className="border-t border-line px-5 py-3 text-[13px] text-ink-3">{plural(open, 'open request')}. Overdue legal requests show in red.</p>}
    </Panel>
  )
}

function AddRequestModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const t = today()
  const people = useMemo(
    () => [...db.people].sort((a, b) => Number(isEmployedOn(b, t)) - Number(isEmployedOn(a, t)) || fullName(a).localeCompare(fullName(b))),
    [db.people, t],
  )
  const [personId, setPersonId] = useState<string>('')
  const [type, setType] = useState<RecordsRequest['type']>('personnel_file')
  const [received, setReceived] = useState<ISODate>(t)
  useEffect(() => {
    if (!open) return
    setPersonId('')
    setType('personnel_file')
    setReceived(today())
  }, [open])
  if (!open) return null
  const due = recordsRequestDueOn(type, received)
  const person = db.people.find((p) => p.id === personId)
  const save = () => {
    if (!person) return
    commit(`Added a ${requestTypeInfo(type).label.toLowerCase()} request from ${fullName(person)}, due ${fmtDate(due)}`, (d) => {
      d.recordsRequests.push({ id: newId('rr'), personId: person.id, type, receivedOn: received, dueOn: due })
      logActivity(d, { entityType: 'person', entityId: person.id, kind: 'records_request', text: `${requestTypeInfo(type).label} request received ${fmtDate(received)}, due ${fmtDate(due)}` })
    })
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a records request"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!person} onClick={save}>
            Add request
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Who asked" hint="Former employees can ask too.">
          {(id, d) => (
            <Select
              id={id}
              aria-describedby={d}
              value={personId}
              onChange={setPersonId}
              placeholder="Pick a person"
              options={people.map((p) => ({ value: p.id, label: `${fullName(p)}${isEmployedOn(p, t) ? '' : p.startDate > t ? ' (starting soon)' : ' (former)'}` }))}
            />
          )}
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13.5px] font-semibold text-ink-2">What they asked for</span>
          <ChipGroup<RecordsRequest['type']>
            label="What they asked for"
            value={type}
            onChange={setType}
            options={RECORDS_REQUEST_TYPES.map((x) => ({ value: x.value, label: x.label, hint: x.clock }))}
          />
          <p className="text-[13px] text-ink-3">{requestTypeInfo(type).clock}</p>
        </div>
        <DateChips
          label="Received"
          value={received}
          onChange={setReceived}
          presets={[
            { label: 'Today', date: t },
            { label: 'Yesterday', date: addDays(t, -1) },
            { label: '2 days ago', date: addDays(t, -2) },
            { label: 'A week ago', date: addDays(t, -7) },
          ]}
        />
        <p className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-[14px] text-ink">
          <Icon name="clock" size={16} className="text-ink-3" />
          Due {fmtDate(due)}
          {requestTypeInfo(type).statutory ? ' (legal deadline)' : ' (app target)'}
        </p>
        <p className="text-[12.5px] text-ink-3">
          Track the request here; send the records from your PEO or payroll provider. <TextLink href={links.settings('links')}>Link-outs</TextLink>
        </p>
      </div>
    </Modal>
  )
}
