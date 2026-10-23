// Notices and policies: policy versions with who acknowledged each, who still owes one (Copy
// reminder, Mark acknowledged), publishing a new version (prompts re-acknowledgement), and the
// required notices packet per person, read from onboarding checklists.
import { useEffect, useMemo, useState } from 'react'
import { links } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { closeAckTasks, setTaskStatus } from '@/domain/checklists/actions'
import { fullName, isEmployedOn } from '@/domain/people'
import type { Checklist, ChecklistTask, DB, Person, Policy } from '@/domain/types'
import { fmtDate, fmtShort, today } from '@/lib/dates'
import { copyText } from '@/lib/files'
import { plural } from '@/lib/format'
import { newId } from '@/lib/id'
import { useDB } from '@/store/db'
import { logActivity } from '@/store/draft'
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  ChipGroup,
  CitationChip,
  DateChips,
  EmptyState,
  Field,
  Icon,
  Meter,
  Modal,
  Panel,
  Segmented,
  TextArea,
  TextInput,
  TextLink,
  toast,
} from '@/ui'
import { Disclosure, keepFocusAfter, LegalNote } from './bits'
import { ackReminderText, acksOwed, nextVersions, policyVersions, sameVersion } from './helpers'
import { commit } from './mutate'

/** Lets a button's label wrap instead of running past a narrow or zoomed panel. */
const WRAP_BUTTON = 'h-auto! min-h-11 max-w-full shrink! py-2 text-left whitespace-normal!'

/**
 * The longest 'What changed' summary a policy version keeps. A policy record holds every past version's
 * summary and syncs as at most 256 KB (docs/SYNC.md), so each one stays short.
 */
const SUMMARY_MAX = 2_000

export function NoticesTab() {
  const db = useDB((s) => s.db)
  const [publishFor, setPublishFor] = useState<Policy | null>(null)
  return (
    <div className="flex flex-col gap-5">
      <Panel title="Policies and acknowledgements" icon="file" padded={false} subtitle="Each person acknowledges each version. A new version asks everyone again.">
        {db.policies.length === 0 ? (
          <EmptyState compact icon="file" title="No policies yet" body="Add your handbook in Settings, then track who acknowledged it here." />
        ) : (
          <ul className="divide-y divide-line">
            {db.policies.map((p) => (
              <li key={p.id}>
                <PolicyRow db={db} policy={p} onPublish={() => setPublishFor(p)} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <NoticesPacket db={db} />
      <PublishModal policy={publishFor} onClose={() => setPublishFor(null)} />
    </div>
  )
}

function PolicyRow({ db, policy, onPublish }: { db: DB; policy: Policy; onPublish: () => void }) {
  const viewer = useViewer()
  const t = today()
  const owed = useMemo(() => acksOwed(db, policy, t), [db, policy, t])
  const versions = useMemo(() => policyVersions(policy, db.acks), [policy, db.acks])
  const employed = db.people.filter((p) => isEmployedOn(p, t)).length
  const current = versions.find((v) => v.current)
  const ackedNow = policy.requiresAck ? employed - owed.length : 0
  const name = (id: string) => {
    const p = db.people.find((x) => x.id === id)
    return p ? fullName(p) : 'Former employee'
  }
  const sender = viewer.person ? viewer.person.preferredName || viewer.person.firstName : db.company.name

  const copyReminder = async () => {
    const ok = await copyText(ackReminderText(policy, owed, sender))
    toast(ok ? `Copied a reminder for ${plural(owed.length, 'person', 'people')}` : { text: 'Copy did not work in this browser.', tone: 'bad' })
  }
  const markAck = (person: Person) =>
    commit(`Recorded ${fullName(person)}'s acknowledgement of ${policy.title} ${policy.version}`, (d) => {
      d.acks.push({ id: newId('ack'), policyId: policy.id, version: policy.version, personId: person.id, acknowledgedOn: t })
      logActivity(d, { entityType: 'person', entityId: person.id, kind: 'policy_ack', text: `Acknowledged ${policy.title} ${policy.version} on ${fmtDate(t)}` })
      closeAckTasks(d, person.id, policy.id, t)
    })

  return (
    <article data-focus-scope className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[16px] font-bold text-ink">{policy.title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone="accent">Version {policy.version}</Badge>
            <Badge tone="neutral">Effective {fmtDate(policy.effectiveOn)}</Badge>
            {!policy.requiresAck && <Badge tone="outline">No acknowledgement needed</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {policy.link && (
            <a
              href={policy.link}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-[14px] font-semibold text-accent hover:bg-accent-soft"
            >
              Open policy
              <Icon name="external" size={13} />
            </a>
          )}
          <Button icon="plus" onClick={onPublish}>
            Publish a new version
          </Button>
        </div>
      </div>
      {policy.summary && <p className="max-w-[80ch] text-[14px] text-ink-2">{policy.summary}</p>}

      {policy.requiresAck && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[14.5px] font-semibold text-ink">
              {ackedNow} of {employed} acknowledged version {policy.version}
            </span>
            {owed.length === 0 ? (
              <Badge tone="good" icon="check">
                Everyone is current
              </Badge>
            ) : (
              <Badge tone={owed.some((o) => o.overdue) ? 'warn' : 'neutral'}>
                {plural(owed.length, 'person', 'people')} still {owed.length === 1 ? 'owes' : 'owe'} it
              </Badge>
            )}
          </div>
          <Meter value={ackedNow} max={Math.max(1, employed)} tone={owed.some((o) => o.overdue) ? 'warn' : owed.length ? 'accent' : 'good'} label={`${ackedNow} of ${employed} acknowledged`} className="max-w-md" />
        </div>
      )}

      {owed.length > 0 && (
        <div className="rounded-xl bg-surface-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[14px] font-semibold text-ink">Still owe version {policy.version}</p>
            <Button icon="copy" onClick={() => void copyReminder()}>
              Copy reminder
            </Button>
          </div>
          <ul className="mt-2 flex flex-col divide-y divide-line">
            {owed.map((o) => (
              <li key={o.person.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
                {/* The name keeps a real width; the badge and button wrap below it on narrow or zoomed screens. */}
                <div className="flex min-w-0 flex-[1_1_14rem] items-center gap-3">
                  <Avatar name={fullName(o.person)} size={30} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14.5px] font-semibold text-ink">{fullName(o.person)}</p>
                    <p className="text-[13px] text-ink-3">{o.person.title}</p>
                  </div>
                </div>
                <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
                  {o.overdue ? <Badge tone="warn">Overdue</Badge> : <Badge tone="neutral">Due {fmtShort(o.dueOn)}</Badge>}
                  <Button
                    icon="check"
                    data-focus-key={`ack-${o.person.id}`}
                    className={WRAP_BUTTON}
                    onClick={(e) => {
                      keepFocusAfter(e.currentTarget)
                      markAck(o.person)
                    }}
                  >
                    Mark acknowledged
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Disclosure label={`Versions and who acknowledged (${versions.length})`} size="sm">
        <ul className="flex flex-col gap-3">
          {versions.map((v) => (
            <li key={v.version} className="text-[14px]">
              <p className="font-semibold text-ink">
                Version {v.version}
                {v.current ? ' (current)' : ''}
                {v.effectiveOn ? `, effective ${fmtDate(v.effectiveOn)}` : ''}
              </p>
              <p className="text-ink-2">
                {v.acks.length
                  ? `${plural(v.acks.length, 'acknowledgement')}: ${[...v.acks]
                      .sort((a, b) => a.acknowledgedOn.localeCompare(b.acknowledgedOn))
                      .map((a) => `${name(a.personId)} (${fmtShort(a.acknowledgedOn)})`)
                      .join(', ')}`
                  : 'No acknowledgements recorded.'}
              </p>
            </li>
          ))}
          {current && !current.effectiveOn && <li className="text-[13px] text-ink-3">The current version has no effective date.</li>}
        </ul>
      </Disclosure>
    </article>
  )
}

function PublishModal({ policy, onClose }: { policy: Policy | null; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const suggestions = policy ? nextVersions(policy.version) : []
  const [choice, setChoice] = useState<string>('')
  const [custom, setCustom] = useState('')
  const [date, setDate] = useState(today())
  const [summary, setSummary] = useState('')
  const [link, setLink] = useState('')
  const [ask, setAsk] = useState(true)
  useEffect(() => {
    if (!policy) return
    setChoice(nextVersions(policy.version)[1])
    setCustom('')
    setDate(today())
    setSummary(policy.summary)
    setLink(policy.link ?? '')
    setAsk(policy.requiresAck)
  }, [policy])
  if (!policy) return null
  const version = (choice === 'other' ? custom : choice).trim()
  const invalid = !version || sameVersion(version, policy.version)
  const employed = db.people.filter((p) => isEmployedOn(p, date)).length
  const publish = () => {
    const label = `Published ${policy.title} ${version}${ask ? `; ${plural(employed, 'person', 'people')} need to acknowledge it` : ''}`
    commit(label, (d) => {
      const p = d.policies.find((x) => x.id === policy.id)
      if (!p) return
      p.history = [...(p.history ?? []), { version: p.version, effectiveOn: p.effectiveOn, summary: p.summary, link: p.link }]
      p.version = version
      p.effectiveOn = date
      p.summary = summary.trim() || p.summary
      p.link = link.trim() || undefined
      p.requiresAck = ask
      logActivity(d, { entityType: 'compliance', entityId: p.id, kind: 'policy_version', text: `Published ${p.title} ${version}, effective ${fmtDate(date)}` })
    })
    onClose()
  }
  return (
    <Modal
      open
      onClose={onClose}
      width={600}
      title={`New version of the ${policy.title.charAt(0).toLowerCase()}${policy.title.slice(1)}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={invalid} onClick={publish}>
            Publish version {version || ''}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13.5px] font-semibold text-ink-2">Version (now {policy.version})</span>
          <ChipGroup<string>
            label="Version"
            value={choice}
            onChange={setChoice}
            options={[...suggestions.map((v) => ({ value: v, label: v })), { value: 'other', label: 'Other' }]}
          />
          {choice === 'other' && (
            <Field label="Version number" error={custom && sameVersion(custom, policy.version) ? 'That is the current version. Pick a new number.' : undefined}>
              {(id, d) => <TextInput id={id} aria-describedby={d} maxLength={20} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="For example 2.5" />}
            </Field>
          )}
        </div>
        <DateChips label="Effective date" value={date} onChange={setDate} />
        <Field
          label="What changed"
          hint={`A sentence or two. People see this when they acknowledge.${summary.length >= SUMMARY_MAX - 200 ? ` ${summary.length.toLocaleString('en-US')} of ${SUMMARY_MAX.toLocaleString('en-US')} characters.` : ''}`}
        >
          {(id, d) => <TextArea id={id} aria-describedby={d} rows={3} maxLength={SUMMARY_MAX} value={summary} onChange={(e) => setSummary(e.target.value)} />}
        </Field>
        <Field label="Link to the policy" hint="Where the document lives (Drive, Notion, the PEO). Never the file itself.">
          {(id, d) => <TextInput id={id} aria-describedby={d} type="url" inputMode="url" maxLength={500} value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" />}
        </Field>
        <Checkbox
          checked={ask}
          onChange={setAsk}
          label="Ask everyone to acknowledge this version"
          description={`${plural(employed, 'person', 'people')} will owe an acknowledgement, due 30 days after the effective date.`}
        />
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// Required notices packet (from onboarding checklists)
// ---------------------------------------------------------------------------------------------

type PacketRow = { person: Person; checklist: Checklist; tasks: ChecklistTask[]; open: ChecklistTask[]; done: number; total: number }

function packetRows(db: DB, date: string): PacketRow[] {
  const rows: PacketRow[] = []
  for (const c of db.checklists) {
    if (c.kind !== 'onboarding') continue
    const person = db.people.find((p) => p.id === c.personId)
    if (!person || (person.endDate && person.endDate < date)) continue
    const tasks = c.tasks.filter((t) => t.category === 'notice')
    if (!tasks.length) continue
    const counted = tasks.filter((t) => t.status !== 'not_applicable')
    rows.push({ person, checklist: c, tasks, open: tasks.filter((t) => t.status === 'open'), done: counted.filter((t) => t.status === 'done').length, total: counted.length })
  }
  return rows.sort((a, b) => b.person.startDate.localeCompare(a.person.startDate))
}

function NoticesPacket({ db }: { db: DB }) {
  const viewer = useViewer()
  const t = today()
  const rows = useMemo(() => packetRows(db, t), [db, t])
  const withOpen = rows.filter((r) => r.open.length > 0)
  const [show, setShow] = useState<'open' | 'all'>(withOpen.length ? 'open' : 'all')
  const shown = show === 'open' ? withOpen : rows
  const packetItems = useMemo(() => {
    const tpl = db.checklistTemplates.find((x) => x.kind === 'onboarding')
    const seen = new Set<string>()
    return (tpl?.tasks ?? []).filter((x) => x.category === 'notice' && !seen.has(x.title.replace(/ \(recommended\)$/, '')) && seen.add(x.title.replace(/ \(recommended\)$/, '')))
  }, [db.checklistTemplates])

  const deliver = (row: PacketRow, task: ChecklistTask) =>
    commit(`Marked delivered: ${task.title.replace(/ given$/, '')} for ${fullName(row.person)}`, (d) => {
      setTaskStatus(d, row.checklist.id, task.id, 'done', { date: t, byId: viewer.personId })
    })
  const deliverAll = (row: PacketRow) =>
    commit(`Marked ${plural(row.open.length, 'notice')} delivered for ${fullName(row.person)}`, (d) => {
      for (const task of row.open) setTaskStatus(d, row.checklist.id, task.id, 'done', { date: t, byId: viewer.personId })
    })

  return (
    <div data-focus-scope>
      <Panel
        title="Required notices packet"
        icon="clipboard"
        padded={false}
        subtitle="What each new hire must receive, read from their onboarding checklist."
        actions={
          <Segmented<'open' | 'all'>
            label="Show people"
            value={show}
            onChange={setShow}
            options={[
              { value: 'open', label: 'Open items', count: withOpen.length },
              { value: 'all', label: 'Everyone', count: rows.length },
            ]}
          />
        }
      >
        <div className="border-b border-line px-5 py-3">
          <Disclosure label={`What is in the packet (${packetItems.length} items)`} size="sm">
            <ul className="flex flex-col gap-2">
              {packetItems.map((it) => (
                <li key={it.id} className="flex flex-wrap items-center gap-2 text-[14px] text-ink-2">
                  <span>{it.title.replace(/ given$/, '').replace(/ \(recommended\)$/, '')}</span>
                  {it.statutory && <Badge tone="outline">Legal deadline</Badge>}
                  {it.citation && <CitationChip label={it.citation.label} url={it.citation.url} />}
                </li>
              ))}
            </ul>
            <LegalNote className="mt-2" />
          </Disclosure>
        </div>
        {shown.length === 0 ? (
          <EmptyState compact icon="check" title="Every packet is complete" body="New hires get their notices on day 1. Open items show here." />
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((row) => {
              const late = row.open.some((x) => x.dueOn < t && x.statutory)
              return (
                <li key={row.checklist.id} className="flex flex-col gap-2 px-5 py-3.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    {/* The name and start date keep a real width; the badge and button wrap below them when space runs out. */}
                    <div className="flex min-w-0 flex-[1_1_14rem] items-center gap-3">
                      <Avatar name={fullName(row.person)} size={32} />
                      <div className="min-w-0 flex-1">
                        <a href={links.checklist(row.checklist.id)} className="text-[15px] font-semibold text-ink hover:text-accent">
                          {fullName(row.person)}
                        </a>
                        <p className="text-[13px] text-ink-3">
                          {row.person.startDate > t ? `Starts ${fmtDate(row.person.startDate)}` : `Started ${fmtDate(row.person.startDate)}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2">
                      <Badge tone={row.open.length === 0 ? 'good' : late ? 'bad' : 'warn'} icon={row.open.length === 0 ? 'check' : undefined}>
                        {row.done} of {row.total} delivered
                      </Badge>
                      {row.open.length > 1 && (
                        <Button
                          icon="check"
                          data-focus-key={`pkt-all-${row.checklist.id}`}
                          className={WRAP_BUTTON}
                          onClick={(e) => {
                            keepFocusAfter(e.currentTarget)
                            deliverAll(row)
                          }}
                        >
                          Mark all {row.open.length} delivered today
                        </Button>
                      )}
                    </div>
                  </div>
                  {row.open.length > 0 && (
                    <ul className="flex flex-col gap-1 sm:pl-11">
                      {row.open.map((task) => {
                        const overdue = task.dueOn < t
                        return (
                          <li key={task.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-surface-2 px-3 py-2">
                            <div className="min-w-0 flex-[1_1_12rem]">
                              <p className="text-[14px] text-ink">{task.title.replace(/ given$/, '')}</p>
                              <p className={overdue && task.statutory ? 'text-[12.5px] font-semibold text-bad' : 'text-[12.5px] text-ink-3'}>
                                {overdue ? 'Was due' : 'Due'} {fmtDate(task.dueOn)}
                                {task.statutory ? ' (legal deadline)' : ''}
                              </p>
                            </div>
                            <Button
                              icon="check"
                              data-focus-key={`pkt-${row.checklist.id}-${task.id}`}
                              className={WRAP_BUTTON}
                              onClick={(e) => {
                                keepFocusAfter(e.currentTarget)
                                deliver(row, task)
                              }}
                            >
                              Mark delivered
                            </Button>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <div className="border-t border-line px-5 py-3 text-[13.5px] text-ink-3">
          Checklists live under People. <TextLink href={links.people('checklists')}>Open all checklists</TextLink>
        </div>
      </Panel>
    </div>
  )
}
