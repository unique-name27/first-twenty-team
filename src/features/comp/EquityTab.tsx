// Equity planning view (docs/SPEC.md, EQUITY PLANNING VIEW and OFFER TO BOARD-APPROVED GRANT): pool
// summary with the cap table numbers (Edit cap table), upcoming cliffs, the board consent queue (Copy
// consent table, Mark approved with the board date), grants with vesting, 409A history with warnings
// (Record 409A, edit or remove), and the 25102(o) note. The cap table tool stays the source of truth.
import { useMemo, useState } from 'react'
import { links } from '@/app/router'
import {
  approveGrants,
  boardConsentQueue,
  cancellationPending,
  capTableIsPlaceholder,
  consentTableText,
  current409A,
  grantNeeds409A,
  holderName,
  pctOfFullyDiluted,
  poolSummary,
  scheduleText,
  sharesHeld,
  valuationWarnings,
  vestedHeld,
} from '@/domain/equity'
import type { EquityGrant, ID, Valuation409A } from '@/domain/types'
import { addDays, daysBetween, fmtDate, fmtShort, type ISODate, today } from '@/lib/dates'
import { copyText } from '@/lib/files'
import { listJoin, money2, num, pct } from '@/lib/format'
import { logActivity, useDB } from '@/store/db'
import { usePrefs } from '@/store/prefs'
import { Avatar, Badge, Button, Callout, Checkbox, CitationChip, DataTable, DateChips, EmptyState, Panel, Private, Segmented, toast, type Column } from '@/ui'
import { CapTableSheet, ValuationSheet } from './EquitySetup'
import { cliffCards } from './helpers'

const SOURCES = {
  corp25102o: { label: 'Corporations Code 25102(o)', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=25102.&lawCode=CORP' },
  irs409a: { label: 'Treasury Reg. 1.409A-1', url: 'https://www.ecfr.gov/current/title-26/chapter-I/subchapter-A/part-1/section-1.409A-1' },
}

function PoolBar({ segments, total }: { segments: Array<{ key: string; label: string; value: number; color: string }>; total: number }) {
  // Segment tooltips carry share counts, so they follow the privacy blur too.
  const blur = usePrefs((s) => s.privacyBlur)
  return (
    <Private className="ft-chart ft-chart--segments ft-poolbar block">
      <div
        role="img"
        aria-label={`Option pool of ${num(total)}: ${segments.map((s) => `${s.label} ${num(s.value)}`).join(', ')}`}
        className="ft-chart__track flex h-4 w-full gap-[2px]"
      >
        {segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <div
              key={s.key}
              title={blur ? 'Hidden by privacy blur (press B)' : `${s.label}: ${num(s.value)}`}
              data-seg={s.key}
              className="ft-chart__bar ft-poolbar__seg h-full first:rounded-l-[4px] last:rounded-r-[4px]"
              style={{ width: `${(s.value / Math.max(1, total)) * 100}%`, background: s.color }}
            />
          ))}
      </div>
      <dl className="ft-poolbar__legend mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        {segments.map((s) => (
          <div key={s.key} className="ft-ministat min-w-0">
            <dt className="ft-ministat__label flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3">
              <span className="ft-poolbar__seg h-2.5 w-2.5 shrink-0 rounded-sm" data-seg={s.key} style={{ background: s.color }} />
              {s.label}
            </dt>
            <dd className="ft-ministat__value num mt-0.5 text-[17px] font-bold text-ink">{num(s.value)}</dd>
            <dd className="text-[12px] text-ink-3">{pct(total ? s.value / total : 0)} of the pool</dd>
          </div>
        ))}
      </dl>
    </Private>
  )
}

function holderHref(db: ReturnType<typeof useDB.getState>['db'], g: EquityGrant): string | undefined {
  if (db.people.some((p) => p.id === g.personId)) return links.person(g.personId, 'equity')
  if (db.contractors.some((c) => c.id === g.personId)) return links.contractor(g.personId)
  if (db.candidates.some((c) => c.id === g.personId)) return links.candidate(g.personId)
  return undefined
}

const STATUS: Record<EquityGrant['status'], { label: string; tone: 'good' | 'warn' | 'neutral' | 'outline' }> = {
  approved: { label: 'Granted', tone: 'good' },
  promised: { label: 'Awaiting board', tone: 'warn' },
  reserved: { label: 'Reserved by offer', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'outline' },
}

const HOLDER: Record<EquityGrant['holderType'], string> = { employee: 'Employee', advisor: 'Advisor', contractor: 'Contractor', candidate: 'Candidate' }

export function EquityTab() {
  const db = useDB((s) => s.db)
  const date = today()
  const pool = useMemo(() => poolSummary(db, date), [db, date])
  const queue = useMemo(() => boardConsentQueue(db), [db])
  const cliffs = useMemo(() => cliffCards(db, date, 365), [db, date])
  const v = current409A(db, date)
  const [show, setShow] = useState<'active' | 'all'>('active')
  // The 409A sheet: a new valuation (optionally starting on a board date) or one on file to correct.
  const [valuationSheet, setValuationSheet] = useState<{ valuation?: Valuation409A; effectiveOn?: ISODate } | null>(null)
  const [capOpen, setCapOpen] = useState(false)
  const placeholder = capTableIsPlaceholder(db)
  const record409A = (effectiveOn?: ISODate) => setValuationSheet(effectiveOn ? { effectiveOn } : {})
  // A leaver's grant still holds its shares until the cancellation date (their last day), so it stays listed.
  const grants = db.grants
    .filter((g) => show === 'all' || g.status !== 'cancelled' || cancellationPending(g, date))
    .filter((g) => show === 'all' || !(g.status === 'approved' && sharesHeld(g, date) === 0))
  const warningsToday = valuationWarnings(db, date)

  const columns: Array<Column<EquityGrant>> = [
    {
      key: 'holder',
      header: 'Holder',
      sort: (g) => holderName(db, g),
      cell: (g) => {
        // The grant type rides under the name (no column of its own), so the register fits a half page at 1280.
        return (
          <div className="min-w-[150px]">
            <span className="font-semibold">{holderName(db, g)}</span>
            <div className="text-[12px] text-ink-3">
              {HOLDER[g.holderType]}, {g.type}
            </div>
          </div>
        )
      },
    },
    { key: 'shares', header: 'Shares', align: 'right', sort: (g) => g.shares, cell: (g) => <Private>{num(g.shares)}</Private> },
    { key: 'pct', header: '% fully diluted', align: 'right', hideBelow: 'sm', sort: (g) => g.shares, cell: (g) => <Private>{pct(pctOfFullyDiluted(db, g.shares), 3)}</Private> },
    { key: 'strike', header: 'Strike', align: 'right', sort: (g) => g.strikePrice, cell: (g) => <Private>{g.strikePrice ? money2(g.strikePrice) : 'Set at grant'}</Private> },
    { key: 'start', header: 'Vest start', sort: (g) => g.vestingStart, cell: (g) => <span className="whitespace-nowrap">{fmtDate(g.vestingStart)}</span> },
    { key: 'schedule', header: 'Schedule', hideBelow: 'lg', width: 'min-w-[12rem]', cell: (g) => scheduleText(g) },
    { key: 'vested', header: 'Vested today', align: 'right', sort: (g) => vestedHeld(db, g, date), cell: (g) => <Private>{num(vestedHeld(db, g, date))}</Private> },
    {
      key: 'status',
      header: 'Status',
      sort: (g) => g.status,
      cell: (g) => {
        // Offboarding records the cancellation ahead of the last day: until then the shares are still held.
        const pending = cancellationPending(g, date)
        const back = g.cancelledShares ?? (g.status === 'cancelled' ? g.shares : 0)
        return (
          <span className="flex flex-col items-start gap-0.5">
            {pending && g.status === 'cancelled' ? (
              <Badge tone="warn">Cancellation pending</Badge>
            ) : (
              <Badge tone={STATUS[g.status].tone}>{STATUS[g.status].label}</Badge>
            )}
            {pending && back > 0 ? (
              <span className="text-[12px] text-ink-3">
                <Private>{num(back)}</Private> returns {fmtDate(g.cancelledOn)}
              </span>
            ) : (
              g.cancelledShares != null &&
              g.status !== 'cancelled' &&
              g.cancelledShares > 0 && (
                <span className="text-[12px] text-ink-3">
                  <Private>{num(g.cancelledShares)}</Private> returned
                </span>
              )
            )}
          </span>
        )
      },
    },
  ]

  const segments = [
    { key: 'granted', label: 'Granted, outstanding', value: pool.grantedOutstanding, color: 'var(--cat-1)' },
    { key: 'awaiting', label: 'Awaiting board', value: pool.awaitingBoard, color: 'var(--cat-2)' },
    { key: 'reserved', label: 'Reserved by offers', value: pool.reservedByOffers, color: 'var(--cat-3)' },
    { key: 'available', label: 'Available', value: Math.max(0, pool.available), color: 'var(--line-strong)' },
  ]

  // Columns follow the tab's own width (a container query), so 150% text and the rail both count.
  return (
    <div className="@container flex flex-col gap-5">
      <Panel
        title="Option pool"
        icon="key"
        subtitle={
          <>
            <Private>{num(pool.poolShares)}</Private> shares
            {pool.increases > 0 && (
              <>
                {' '}
                (<Private>{num(pool.basePool)}</Private> plus <Private>{num(pool.increases)}</Private> added later)
              </>
            )}
            , <Private>{pct(pool.poolShares / Math.max(1, db.equity.fullyDilutedShares))}</Private> of fully diluted
          </>
        }
        actions={
          // While the numbers are placeholders, the button sits in the callout that says so.
          placeholder ? undefined : (
            <Button icon="edit" onClick={() => setCapOpen(true)}>
              Edit cap table
            </Button>
          )
        }
      >
        {placeholder && (
          <Callout tone="warn" className="mb-3" title="Placeholder numbers: check these against your cap table tool">
            Start fresh filled in an example cap table. Percentages of fully diluted shares are estimates, and offer letters give the share
            count only until you enter or confirm the real numbers.
            {/* Below the text, not beside it: at phone width a side button would squeeze the text into a sliver. */}
            <span className="mt-2 flex">
              <Button size="sm" icon="edit" onClick={() => setCapOpen(true)}>
                Edit cap table
              </Button>
            </span>
          </Callout>
        )}
        <PoolBar segments={segments} total={pool.poolShares} />
        <p className="mt-3 text-[13px] text-ink-2">
          Cap table: <Private>{num(db.equity.fullyDilutedShares)}</Private> fully diluted, <Private>{num(db.equity.founderShares)}</Private> founder
          shares, <Private>{num(db.equity.authorizedShares)}</Private> authorized.
        </p>
        <p className="mt-1 text-[13px] text-ink-3">
          <Private>{num(pool.returned)}</Private> unvested options came back to the pool from people who left. The cap table tool is the source
          of truth for issued options.
        </p>
        {pool.available < 0 && (
          <Callout tone="bad" className="mt-3" title="The pool is overcommitted">
            Grants and offers use more shares than the pool holds. Ask the board for a pool increase before the next grant.
          </Callout>
        )}
        {pool.unrecordedForfeitures > 0 && (
          <Callout tone="warn" className="mt-3" title="Forfeitures not recorded">
            <Private>{num(pool.unrecordedForfeitures)}</Private> unvested options from people who left are counted as returned, but no
            cancellation is recorded on their grants. Record it from their offboarding.
          </Callout>
        )}
      </Panel>

      <BoardQueue queue={queue} onRecord409A={record409A} />

      <Panel title="Upcoming cliffs" icon="calendar" subtitle="Next 12 months">
        {cliffs.length === 0 ? (
          <EmptyState compact icon="calendar" title="No cliffs in the next 12 months" />
        ) : (
          <ul className="grid grid-cols-1 gap-3 @[560px]:grid-cols-2">
            {cliffs.map((c) => {
              const days = daysBetween(date, c.date)
              return (
                <li key={c.grantId}>
                  <a href={links.person(c.personId, 'equity')} className="ft-cliff flex items-start gap-3 rounded-xl border border-line p-3.5 transition-colors hover:border-line-strong hover:bg-surface-2/60">
                    <Avatar name={c.name} size={36} />
                    <span className="min-w-0">
                      <span className="block text-[14.5px] text-ink">
                        <Private>{c.text}</Private>
                      </span>
                      <span className="mt-1 flex flex-wrap gap-1.5">
                        <Badge tone={days <= 30 ? 'accent' : 'neutral'}>{days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`}</Badge>
                        {c.awaitingBoard && (
                          // Wraps instead of overflowing the card at 375px and 150% text.
                          <Badge tone="warn" className="h-auto! min-h-6 shrink! rounded-xl! py-1 leading-tight! whitespace-normal!">
                            Awaiting board consent
                          </Badge>
                        )}
                      </span>
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      <Panel
        title="Grants"
        icon="layers"
        padded={false}
        actions={
          <Segmented
            label="Show grants"
            value={show}
            onChange={setShow}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'all', label: 'All', count: db.grants.length },
            ]}
          />
        }
      >
        <DataTable
          rows={grants}
          columns={columns}
          rowKey={(g) => g.id}
          rowHref={(g) => holderHref(db, g) ?? ''}
          initialSort={{ key: 'start', dir: 'asc' }}
          caption="Equity grants"
          empty={<EmptyState compact icon="key" title="No grants yet" body="Grants appear when an offer with options is accepted." />}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-5 @[640px]:grid-cols-2">
        <Panel
          title="409A valuations"
          icon="scale"
          padded={false}
          actions={
            <Button icon="plus" onClick={() => record409A()}>
              Record 409A
            </Button>
          }
        >
          {/* Each valuation opens for editing from its row (the date cell is its button, named for the edit), and the
              provider rides under the date: no pencil column, so the table fits its half-width column at 1280 and a
              phone without hiding the action behind a scrollbar. */}
          <DataTable
            rows={[...db.equity.valuations].sort((a, b) => b.effectiveOn.localeCompare(a.effectiveOn))}
            rowKey={(r) => r.id}
            dense
            caption="409A valuation history"
            onRowClick={(r) => setValuationSheet({ valuation: r })}
            rowLabel={(r) => `Edit the 409A from ${fmtDate(r.effectiveOn)}`}
            empty={<EmptyState compact title="No 409A on file" body="Record the valuation report here before the board grants options." />}
            columns={[
              {
                key: 'eff',
                header: 'Effective',
                cell: (r) => (
                  <>
                    <span className="block whitespace-nowrap">{fmtDate(r.effectiveOn)}</span>
                    {r.provider && <span className="block text-[12px] font-normal text-ink-3">{r.provider}</span>}
                  </>
                ),
              },
              { key: 'fmv', header: 'Price a share', align: 'right', cell: (r) => <Private>{money2(r.fmvPerShare)}</Private> },
              { key: 'until', header: 'Safe harbor until', cell: (r) => <span className="whitespace-nowrap">{fmtDate(r.expiresOn)}</span> },
              {
                key: 'st',
                header: 'Status',
                cell: (r) =>
                  v?.id === r.id ? (
                    <Badge tone={r.expiresOn < date ? 'bad' : 'good'}>{r.expiresOn < date ? 'Expired' : 'Current'}</Badge>
                  ) : (
                    <Badge tone="outline">{r.effectiveOn > date ? 'Upcoming' : 'Superseded'}</Badge>
                  ),
              },
            ]}
          />
          <div className="flex flex-col gap-2 px-5 py-4">
            {warningsToday.length === 0 && v ? (
              <Callout tone="good" title={`In safe harbor until ${fmtDate(v.expiresOn)}`}>
                {daysBetween(date, v.expiresOn)} days left. A priced round or other material event ends it early.
              </Callout>
            ) : (
              warningsToday.map((w) => (
                <Callout key={`${w.kind}-${w.grantId ?? w.roundId ?? w.valuationId ?? ''}`} tone={w.kind === 'expired' || w.kind === 'missing' ? 'bad' : 'warn'}>
                  {w.text}
                </Callout>
              ))
            )}
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
              <CitationChip label={SOURCES.irs409a.label} url={SOURCES.irs409a.url} />
              <span>Options priced at or above a current 409A keep safe harbor. Not legal or tax advice.</span>
            </div>
          </div>
        </Panel>
        <Notice25102o />
      </div>
      <ValuationSheet
        open={!!valuationSheet}
        onClose={() => setValuationSheet(null)}
        valuation={valuationSheet?.valuation}
        effectiveOn={valuationSheet?.effectiveOn}
      />
      <CapTableSheet open={capOpen} onClose={() => setCapOpen(false)} />
    </div>
  )
}

function BoardQueue({ queue, onRecord409A }: { queue: EquityGrant[]; onRecord409A: (effectiveOn?: ISODate) => void }) {
  const db = useDB((s) => s.db)
  const date = today()
  // Every waiting grant is included unless unticked, so new arrivals join the next consent.
  const [excluded, setExcluded] = useState<ID[]>([])
  const [boardDate, setBoardDate] = useState(date)
  const ids = queue.map((g) => g.id).filter((id) => !excluded.includes(id))
  const selected = queue.filter((g) => ids.includes(g.id))
  const fmv = current409A(db, boardDate)?.fmvPerShare
  // Option grants with no strike wait for a 409A in effect on the board date (approveGrants skips them).
  const needs409A = selected.filter((g) => grantNeeds409A(db, g, boardDate))
  const allNeed409A = selected.length > 0 && needs409A.length === selected.length
  const warnings = valuationWarnings(db, boardDate).filter((w) => w.kind !== 'strike' && !(w.kind === 'missing' && needs409A.length))
  const totalShares = selected.reduce((t, g) => t + g.shares, 0)
  const first = (g: EquityGrant) => holderName(db, g).split(' ')[0]

  const copy = async () => {
    const ok = await copyText(consentTableText(db, ids, boardDate))
    toast(ok ? `Consent table copied (${ids.length} ${ids.length === 1 ? 'grant' : 'grants'})` : { text: 'Copying is blocked here', tone: 'bad' })
  }
  const approve = () => {
    const ready = selected.filter((g) => !grantNeeds409A(db, g, boardDate))
    if (!ready.length) return
    const label = `Marked ${ready.length === 1 ? `${first(ready[0])}'s grant` : `${ready.length} grants`} board approved (${fmtDate(boardDate)})`
    let result: ReturnType<typeof approveGrants> | null = null
    useDB.getState().mutate(label, (draft) => {
      result = approveGrants(draft, ids, boardDate, { date })
    })
    const r = result as ReturnType<typeof approveGrants> | null
    if (!r) return
    // Success (with Undo) only for what was approved; the rest says why it was left.
    if (r.approved.length) toast({ text: label, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
    if (r.noStrike.length) {
      const names = r.noStrike.map((id) => queue.find((g) => g.id === id)).filter((g): g is EquityGrant => !!g).map(first)
      const what = names.length === 1 ? `${names[0]}'s option grant was` : `${names.length} option grants (${listJoin(names)}) were`
      toast({ text: `${what} not approved: no 409A is in effect on ${fmtShort(boardDate)}. Record a 409A first.`, tone: 'bad' })
    }
    const more = r.noStrike.length ? r.warnings.slice(1) : r.warnings
    if (r.firstIssuance && r.notice25102oDueOn) {
      toast({ text: `First option grant: file the 25102(o) notice by ${fmtDate(r.notice25102oDueOn)}`, tone: 'neutral' })
    } else if (more.length) {
      toast({ text: more[0], tone: 'neutral' })
    }
  }

  return (
    <Panel
      title="Board consent queue"
      icon="clipboard-check"
      subtitle={queue.length ? `${queue.length} ${queue.length === 1 ? 'grant waits' : 'grants wait'} for board consent` : 'Nothing waiting'}
    >
      {queue.length === 0 ? (
        <EmptyState compact icon="check" title="No grants waiting for the board" body="Accepted offers and refresh grants land here." />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-line">
            <DataTable
              rows={queue}
              rowKey={(g) => g.id}
              dense
              caption="Grants waiting for board consent"
              columns={[
                {
                  key: 'pick',
                  header: <span className="sr-only">Include</span>,
                  cell: (g) => (
                    <Checkbox
                      className="-mx-2 px-2"
                      label={<span className="sr-only">Include {holderName(db, g)}</span>}
                      checked={ids.includes(g.id)}
                      onChange={(on) => setExcluded((s) => (on ? s.filter((x) => x !== g.id) : [...s, g.id]))}
                    />
                  ),
                },
                { key: 'name', header: 'Name', cell: (g) => <span className="font-semibold">{holderName(db, g)}</span> },
                { key: 'shares', header: 'Shares', align: 'right', cell: (g) => <Private>{num(g.shares)}</Private> },
                { key: 'type', header: 'Type', cell: (g) => g.type },
                { key: 'strike', header: 'Strike at board date', align: 'right', cell: () => <Private>{fmv != null ? money2(fmv) : 'No 409A'}</Private> },
                { key: 'start', header: 'Vest start', cell: (g) => <span className="whitespace-nowrap">{fmtDate(g.vestingStart)}</span> },
                { key: 'sched', header: 'Schedule', hideBelow: 'md', cell: (g) => scheduleText(g) },
              ]}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13.5px] font-semibold text-ink-2">Board approval date</span>
            <DateChips
              label="Board approval date"
              value={boardDate}
              onChange={setBoardDate}
              presets={[
                { label: 'Today', date },
                { label: 'Yesterday', date: addDays(date, -1) },
              ]}
            />
          </div>
          {needs409A.length > 0 && (
            <Callout
              tone={allNeed409A ? 'bad' : 'warn'}
              title="Record a 409A first: options are priced at fair market value on the grant date"
              action={
                <Button size="sm" icon="plus" onClick={() => onRecord409A(boardDate)}>
                  Record 409A
                </Button>
              }
            >
              No 409A is in effect on {fmtDate(boardDate)}, so{' '}
              {needs409A.length === 1 ? `${first(needs409A[0])}'s option grant has` : `${needs409A.length} option grants (${listJoin(needs409A.map(first))}) have`} no
              strike price yet.
              {allNeed409A ? ' Mark approved works once a valuation is on file.' : ' Mark approved approves the others and leaves these waiting.'}
            </Callout>
          )}
          {warnings.map((w) => (
            <Callout key={`${w.kind}-${w.roundId ?? w.valuationId ?? ''}`} tone="warn">
              {w.text}
            </Callout>
          ))}
          {boardDate > date && <Callout tone="neutral">The board date is in the future. Mark grants approved once the consent is signed.</Callout>}
          <div className="flex flex-wrap items-center gap-2">
            <Button icon="copy" onClick={copy} disabled={!ids.length}>
              Copy consent table
            </Button>
            <Button variant="primary" size="lg" icon="check" onClick={approve} disabled={!ids.length || allNeed409A}>
              Mark approved
            </Button>
            <span className="text-[13px] text-ink-3">
              {ids.length} selected, <Private>{num(totalShares)}</Private> options. The strike is set to the 409A price on the board date.
            </span>
          </div>
        </div>
      )}
    </Panel>
  )
}

function Notice25102o() {
  const db = useDB((s) => s.db)
  const date = today()
  const first = db.equity.firstIssuanceOn
  const filed = db.equity.filing25102oOn
  const due = first ? addDays(first, 30) : undefined
  const record = () => {
    const label = 'Recorded the 25102(o) notice as filed today'
    useDB.getState().mutate(label, (draft) => {
      draft.equity.filing25102oOn = date
      logActivity(draft, { entityType: 'compliance', entityId: 'first-option-grant', kind: 'filing_recorded', text: label })
    })
    toast({ text: label, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
  }
  return (
    <Panel title="California 25102(o) notice" icon="file">
      <div className="flex flex-col gap-3 text-[14px] text-ink-2">
        {!first ? (
          <p>When the board approves the first option grant, the notice to the DFPI is due within 30 days.</p>
        ) : filed ? (
          <Callout tone="good" title={`Filed ${fmtDate(filed)}`}>
            First option grant on {fmtDate(first)}; the notice was due by {due ? fmtDate(due) : 'within 30 days'}.
          </Callout>
        ) : (
          <Callout
            tone={due && due < date ? 'bad' : 'warn'}
            title={due && due < date ? `Overdue since ${fmtDate(due)}` : `Due by ${due ? fmtDate(due) : 'within 30 days'}`}
            action={
              <Button size="sm" onClick={record}>
                Mark filed today
              </Button>
            }
          >
            First option grant on {fmtDate(first)}. File the notice with the DFPI within 30 days of it.
          </Callout>
        )}
        <p>The notice covers option grants under a written plan and is usually filed once per plan, after its first grant.</p>
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
          <CitationChip label={SOURCES.corp25102o.label} url={SOURCES.corp25102o.url} />
          <span>Not legal advice; confirm with counsel.</span>
        </div>
      </div>
    </Panel>
  )
}
