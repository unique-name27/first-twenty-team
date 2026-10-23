// Settings > Data: backup (download or copy), import with a preview of what changes, the storage
// meter, Start fresh as a solo founder (backup first, then 3 screens), Reset to the sample company,
// the "Pretend today is" demo clock, "Data we don't keep" and Graduation (CSV packs for a real HRIS and ATS).
// Connected to a First Twenty server, Import and Start fresh go through replaceWorkspace() (they replace
// the server's workspace for every device, after a clear confirmation) and Reset to sample is blocked:
// the sample never syncs (docs/SYNC.md).
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { links, navigate, replaceRoute, useRoute } from '@/app/router'
import { daysBetween, fmtDate, fmtDateTime, fmtDay, getClockOverride, parseDate, toISODate, today } from '@/lib/dates'
import {
  buildGraduationPack,
  GRADUATION_HEADCOUNT,
  GRADUATION_OUTGROW_AT,
  GRADUATION_PACKS,
  type GraduationCount,
  type GraduationPack,
  graduationCount,
} from '@/domain/graduation'
import { copyText, downloadFile, readFileText } from '@/lib/files'
import { backupJSON, downloadBackupFile, markExported } from '@/store/backup'
import { getDB, loadSample, migrate, STORAGE_KEY, useDB } from '@/store/db'
import { usePrefs } from '@/store/prefs'
import { connect, replaceWorkspace, useSyncStatus } from '@/sync'
import {
  Badge,
  Button,
  Callout,
  ChipGroup,
  ConfirmButton,
  DataTable,
  DateChips,
  Field,
  FormGrid,
  Meter,
  Panel,
  Segmented,
  Sheet,
  TextArea,
  TextInput,
  toast,
} from '@/ui'
import { ButtonLink, DateField, pastPresets, Row, RowList } from './kit'
import {
  buildFreshDB,
  dataWeDontKeep,
  type DBDiff,
  diffDB,
  FOUNDER_TITLES,
  type FreshInput,
  fmtBytes,
  HQ_CITIES,
  normalizeWebsite,
  packFileName,
  parseBackup,
  storageLabel,
  storageUsage,
  suggestedWorkEmail,
  urlProblem,
  workEmailProblem,
} from './logic'
import { focusPanelTitle } from './serverFocus'
import { statusView } from './serverLogic'
import type { DB } from '@/domain/types'

// ---------------------------------------------------------------------------------------------
// Backup helpers (the file itself comes from @/store/backup, shared with the Home inbox)
// ---------------------------------------------------------------------------------------------

export function downloadBackup(): boolean {
  const { ok } = downloadBackupFile()
  toast(
    ok
      ? { text: 'Backup downloaded' }
      : { text: 'This browser blocked the download. Use Copy backup JSON instead.', tone: 'bad' },
  )
  return ok
}

export async function copyBackup(): Promise<boolean> {
  markExported()
  const ok = await copyText(backupJSON())
  toast(ok ? { text: 'Backup JSON copied. Paste it into a file you keep somewhere safe.' } : { text: 'Copy was blocked by the browser.', tone: 'bad' })
  return ok
}

function undoToast(text: string) {
  toast({ text, action: { label: 'Undo', onClick: () => void useDB.getState().undo() } })
}

// ---------------------------------------------------------------------------------------------

export function DataTab() {
  const route = useRoute()
  const wantsFresh = route.segments[2] === 'fresh'
  const wantsGraduation = route.segments[2] === 'graduation'
  const db = useDB((s) => s.db)
  const t = today()
  const count = useMemo(() => graduationCount(db, t), [db, t])
  // Near the end of the road, the export packs move up next to the backup.
  const graduating = count.total >= GRADUATION_HEADCOUNT
  return (
    <div className="flex flex-col gap-5">
      <BackupPanel />
      <ServerLinkPanel />
      {graduating && <GraduationPanel count={count} focus={wantsGraduation} />}
      <ImportPanel />
      <StoragePanel />
      {!graduating && <GraduationPanel count={count} focus={wantsGraduation} />}
      <StartOverPanel openFresh={wantsFresh} />
      <ClockPanel />
      <NotKeptPanel />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

function BackupPanel() {
  const meta = useDB((s) => s.db.meta)
  const connected = useSyncStatus((s) => s.mode === 'server')
  const last = meta.lastExportedOn
  // A UTC timestamp: compare by the local calendar day so an evening backup still reads as today.
  const age = last ? daysBetween(toISODate(parseDate(last)), today()) : null
  const stale = age == null || age > 7
  return (
    <Panel
      title="Backup"
      icon="download"
      subtitle={
        connected
          ? 'This workspace syncs to your server, which keeps nightly backups. A backup here is your own copy: one JSON file with every record; keep it in Drive, Dropbox or iCloud.'
          : 'Everything lives in this browser only. A backup is one JSON file with every record; keep it in Drive, Dropbox or iCloud.'
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-[14.5px] text-ink">
          {last ? (
            <>
              <Badge tone={stale ? 'warn' : 'good'} icon={stale ? 'alert' : 'check'}>
                {age === 0 ? 'Backed up today' : `Last backup ${age} ${age === 1 ? 'day' : 'days'} ago`}
              </Badge>
              <span className="text-ink-3">{fmtDateTime(last)}</span>
            </>
          ) : (
            <Badge tone="warn" icon="alert">
              No backup yet
            </Badge>
          )}
          {stale && <span className="text-[13.5px] text-ink-2">A weekly backup is a good habit; the header chip turns amber after 7 days.</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="lg" icon="download" onClick={() => downloadBackup()}>
            Download backup
          </Button>
          <Button size="lg" icon="copy" onClick={() => void copyBackup()}>
            Copy backup JSON
          </Button>
        </div>
        <p className="text-[13px] text-ink-3">
          Backups include pay and equity. Store them like any other HR record. Display preferences and Viewing as stay on this device and are not included.
        </p>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------

/** Where this browser stands with a First Twenty server, and the way to Settings > Server. */
function ServerLinkPanel() {
  const status = useSyncStatus((s) => s.status)
  const hold = useSyncStatus((s) => s.hold)
  const pending = useSyncStatus((s) => s.pending)
  const rejected = useSyncStatus((s) => s.rejected)
  const storageFull = useSyncStatus((s) => s.storageFull)
  const connected = useSyncStatus((s) => s.mode === 'server')
  const view = statusView({ status, hold, pending, rejected, storageFull })
  return (
    <Panel
      title="Server"
      icon="globe"
      subtitle={
        connected
          ? 'This browser syncs with your First Twenty server. Import and Start fresh replace the server\'s workspace too.'
          : 'Optional: keep this workspace in your own Postgres database and use it from any computer.'
      }
      actions={
        <ButtonLink href={links.settings('server')} icon="globe">
          {connected ? 'Server settings' : 'Set up or sign in'}
        </ButtonLink>
      }
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Badge tone={view.tone} icon={view.icon}>
          {view.word}
        </Badge>
        <span className="min-w-0 text-[14.5px] text-ink">{connected ? view.sentence : 'Everything lives in this browser only.'}</span>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------

type Staged = { db: DB; diff: DBDiff; source: string }

function ImportPanel() {
  const current = useDB((s) => s.db)
  const connected = useSyncStatus((s) => s.mode === 'server')
  // #settings.data.import comes from Settings, Server ("Import a backup" while connecting): bring this
  // panel into view with focus on its first control, and go back there once the import is done.
  const fromServer = useRoute().segments[2] === 'import'
  useEffect(() => {
    if (!fromServer) return
    // After the App's own scroll-to-top and focus handling for the new route, which run in this commit.
    const t = setTimeout(() => {
      const panel = document.getElementById('settings-import')
      panel?.scrollIntoView({ block: 'start' })
      panel?.querySelector<HTMLElement>('[role=radio][aria-checked=true]')?.focus({ preventScroll: true })
    }, 0)
    return () => clearTimeout(t)
  }, [fromServer])
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<{ message: string; n: number } | null>(null)
  const [mode, setMode] = useState<'file' | 'paste'>('file')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [staged, setStaged] = useState<Staged | null>(null)
  const [showAll, setShowAll] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const check = (raw: string, source: string) => {
    const res = parseBackup(raw)
    if (!res.ok) {
      setError(res.reason)
      setStaged(null)
      return
    }
    const db = migrate(res.db)
    setError(null)
    setStaged({ db, diff: diffDB(getDB(), db), source })
  }

  // Keep the preview honest if the workspace changes while a backup is staged.
  const diff = useMemo(() => (staged ? diffDB(current, staged.db) : null), [current, staged])

  const clear = () => {
    setStaged(null)
    setError(null)
    setSendError(null)
    setText('')
    if (fileRef.current) fileRef.current.value = ''
  }

  const replaceNow = async () => {
    if (!staged || sending) return
    const name = staged.db.company.name
    const label = `Imported a backup of ${name}`
    if (!connected) {
      // Not connected: an ordinary replace in this browser (one Undo step), done before this returns.
      void replaceWorkspace(staged.db, label)
      clear()
      if (fromServer) backToServer()
      undoToast(fromServer ? `${label}; next, choose what syncs` : label)
      return
    }
    // Connected: the server's workspace is replaced first, for every device; on failure nothing changes.
    setSending(true)
    setSendError(null)
    const res = await replaceWorkspace(staged.db, label)
    setSending(false)
    if (res.ok) {
      clear()
      if (fromServer) backToServer()
      toast({ text: `${label}. Your server now has it.` })
    } else setSendError({ message: res.message, n: Date.now() })
  }
  /** The import started in Settings, Server: go back there, where the connect step looks again. */
  const backToServer = () => {
    navigate('settings', 'server')
    focusPanelTitle(useSyncStatus.getState().mode === 'server' ? 'server-status' : 'server-connect', 3000)
  }
  // The sample never syncs: while connected it cannot be imported (the same rule as Reset to sample).
  const sampleBlocked = connected && staged?.db.meta.sample === true

  const rows = diff ? diff.rows.filter((r) => showAll || r.added + r.removed + r.changed > 0) : []
  const people = staged?.db.people.length ?? 0
  const candidates = staged?.db.candidates.length ?? 0
  const jobs = staged?.db.jobs.length ?? 0

  return (
    <Panel
      id="settings-import"
      className="scroll-mt-4"
      title="Import a backup"
      icon="upload"
      subtitle={
        connected
          ? "Check what a backup holds before it replaces what is here. Connected to your server, an import replaces the server's workspace too, with no Undo."
          : 'Check what a backup holds before it replaces what is here. You can undo right after.'
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented
          label="How to import"
          value={mode}
          onChange={(v) => {
            setMode(v)
            setError(null)
          }}
          options={[
            { value: 'file', label: 'Pick a file' },
            { value: 'paste', label: 'Paste JSON' },
          ]}
        />
        {mode === 'file' ? (
          <Field label="Backup file" hint="A .json file from Download backup.">
            {(id, hint) => (
              <input
                id={id}
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                aria-describedby={hint}
                className="block w-full rounded-lg border border-line-strong bg-surface p-2 text-[14.5px] text-ink file:mr-3 file:h-10 file:cursor-pointer file:rounded-lg file:border-0 file:bg-surface-2 file:px-4 file:font-semibold file:text-ink hover:file:bg-surface-3"
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  try {
                    check(await readFileText(f), f.name)
                  } catch {
                    setError('That file could not be read. Try again, or open it and paste the text instead.')
                  }
                }}
              />
            )}
          </Field>
        ) : (
          <>
            <Field label="Backup JSON" hint="Paste everything from the first { to the last }.">
              {(id, hint) => (
                <TextArea
                  id={id}
                  aria-describedby={hint}
                  rows={6}
                  className="font-mono text-[12.5px]"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  spellCheck={false}
                />
              )}
            </Field>
            <div>
              <Button icon="search" onClick={() => check(text, 'pasted text')} disabled={!text.trim()}>
                Check backup
              </Button>
            </div>
          </>
        )}
        {error && (
          <Callout tone="bad" title="This backup cannot be used">
            {error}
          </Callout>
        )}
        {staged && diff && (
          <div className="flex flex-col gap-3 rounded-xl border border-line p-4">
            <div>
              <p className="font-semibold text-ink">
                Backup of {staged.db.company.name}
                {staged.db.meta.sample ? ' (sample company)' : ''}
                <span className="font-normal text-ink-3"> from {staged.source}</span>
              </p>
              <p className="text-[14px] text-ink-2">
                {people} {people === 1 ? 'person' : 'people'}, {jobs} {jobs === 1 ? 'job' : 'jobs'} and {candidates}{' '}
                {candidates === 1 ? 'candidate' : 'candidates'}.
                {staged.db.meta.lastExportedOn ? ` Backed up ${fmtDateTime(staged.db.meta.lastExportedOn)}.` : ''}
              </p>
            </div>
            {diff.identical ? (
              <Callout tone="good" title="This backup matches what is here now">
                Nothing would change.
              </Callout>
            ) : (
              <>
                <p className="text-[14px] text-ink">
                  Replacing changes <strong>{diff.totalChanges}</strong> {diff.totalChanges === 1 ? 'thing' : 'things'}
                  {diff.companyFrom !== diff.companyTo ? `, and swaps ${diff.companyFrom} for ${diff.companyTo}` : ''}.
                  {diff.sections.length > 0 && ` Also changes: ${diff.sections.map((s) => s.label.toLowerCase()).join(', ')}.`}
                </p>
                <DataTable
                  caption="What the import changes"
                  dense
                  rows={rows}
                  rowKey={(r) => r.key}
                  columns={[
                    { key: 'label', header: 'Records', cell: (r) => r.label },
                    { key: 'current', header: 'Now', align: 'right', cell: (r) => <span className="num">{r.current}</span> },
                    { key: 'incoming', header: 'In backup', align: 'right', cell: (r) => <span className="num">{r.incoming}</span> },
                    {
                      key: 'change',
                      header: 'Change',
                      cell: (r) =>
                        r.added + r.removed + r.changed === 0 ? (
                          <span className="text-ink-3">Same</span>
                        ) : (
                          <span className="flex flex-wrap gap-1.5">
                            {r.added > 0 && <Badge tone="good">{r.added} added</Badge>}
                            {r.removed > 0 && <Badge tone="warn">{r.removed} removed</Badge>}
                            {r.changed > 0 && <Badge tone="accent">{r.changed} changed</Badge>}
                          </span>
                        ),
                    },
                  ]}
                />
                <div>
                  <Button variant="ghost" onClick={() => setShowAll((s) => !s)} aria-pressed={showAll}>
                    {showAll ? 'Show only changes' : 'Show every record type'}
                  </Button>
                </div>
              </>
            )}
            {connected && !diff.identical && !sampleBlocked && (
              <Callout tone="warn" title="This replaces your server's workspace for every device">
                This browser is connected to your server. Importing sends this backup to the server, and every computer that syncs switches to it.
                There is no Undo, so back up what is here first.
              </Callout>
            )}
            {sampleBlocked && (
              <Callout tone="warn" title="The sample company cannot be imported while connected">
                The sample never syncs. To look at it, disconnect first in{' '}
                <a href={links.settings('server')} className="ft-link font-semibold text-accent underline underline-offset-2">
                  Settings, Server
                </a>
                .
              </Callout>
            )}
            <div role="alert" key={sendError?.n ?? 0} className={sendError ? undefined : 'sr-only'}>
              {sendError && (
                <Callout tone="bad" title="Nothing was imported">
                  {sendError.message}
                </Callout>
              )}
            </div>
            <p role="status" className={sending ? 'text-[13.5px] text-ink-2' : 'sr-only'}>
              {sending ? 'Sending the backup to your server.' : ''}
            </p>
            <div className="flex flex-wrap gap-2 border-t border-line pt-3">
              {connected ? (
                <ConfirmButton
                  variant="primary"
                  icon="upload"
                  disabled={diff.identical || sampleBlocked}
                  aria-disabled={sending ? true : undefined}
                  confirmLabel="Press again to replace the server's workspace"
                  onConfirm={() => void replaceNow()}
                >
                  {sending ? 'Importing' : "Replace the server's workspace with this backup"}
                </ConfirmButton>
              ) : (
                <Button variant="primary" icon="upload" disabled={diff.identical} onClick={() => void replaceNow()}>
                  Replace with this backup
                </Button>
              )}
              <Button icon="download" onClick={() => downloadBackup()}>
                Back up what is here first
              </Button>
              <Button variant="ghost" onClick={clear}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------

function StoragePanel() {
  const db = useDB((s) => s.db)
  const storageOk = useDB((s) => s.storageOk)
  const lastSavedAt = useDB((s) => s.lastSavedAt)
  const { usage, biggest } = useMemo(() => {
    const json = JSON.stringify(db)
    let stored = json.length
    try {
      // Count other keys this app keeps (preferences) too; they share the same quota.
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k !== STORAGE_KEY && k.startsWith('first-twenty')) stored += (localStorage.getItem(k) ?? '').length
      }
    } catch {
      /* storage unavailable; the in-memory size still tells the story */
    }
    // Every collection (an array) and every document (an object, such as settings): the parts that take room.
    const parts = Object.entries(db as unknown as Record<string, unknown>)
      .filter(([, v]) => !!v && typeof v === 'object')
      .map(([k, v]) => ({ key: k, size: JSON.stringify(v).length }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 3)
    return { usage: storageUsage(stored), biggest: parts }
  }, [db])
  return (
    <Panel title="Storage" icon="layers" subtitle="Browsers give each site about 5 MB. The meter warns at 70%.">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[15px] font-semibold text-ink">{usage.text}</span>
          {usage.tone === 'good' ? (
            <Badge tone="good" icon="check">
              Plenty of room
            </Badge>
          ) : usage.tone === 'warn' ? (
            <Badge tone="warn" icon="alert">
              Getting full
            </Badge>
          ) : (
            <Badge tone="bad" icon="alert">
              Almost full
            </Badge>
          )}
        </div>
        <Meter value={usage.used} max={usage.quota} tone={usage.tone} label={`Storage used: ${usage.text}`} />
        <p className="text-[13.5px] text-ink-3">
          Largest: {biggest.map((b) => `${storageLabel(b.key)} (${fmtBytes(b.size)})`).join(', ')}.
        </p>
        {usage.tone !== 'good' && (
          <Callout tone="warn" title="Storage is getting full">
            Download a backup now. Then consider anonymizing old applicant records in Compliance, Records and retention.
          </Callout>
        )}
        {!storageOk ? (
          <Callout tone="bad" title="This browser is not saving changes">
            A private window, full storage or blocked site data can cause this. Download a backup before you close the tab.
          </Callout>
        ) : (
          <p className="text-[13.5px] text-ink-3">
            {lastSavedAt ? `Saved in this browser at ${fmtDateTime(lastSavedAt)}.` : 'Changes save in this browser as you work.'}
          </p>
        )}
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------

function StartOverPanel({ openFresh }: { openFresh: boolean }) {
  const sample = useDB((s) => s.db.meta.sample)
  const company = useDB((s) => s.db.company.name)
  const connected = useSyncStatus((s) => s.mode === 'server')
  const [fresh, setFresh] = useState(openFresh)
  useEffect(() => {
    if (openFresh) setFresh(true)
  }, [openFresh])
  const close = () => {
    setFresh(false)
    if (openFresh) replaceRoute('settings', 'data')
  }
  return (
    <Panel
      title="Start over"
      icon="rotate-ccw"
      subtitle={
        connected
          ? 'Start fresh replaces everything in this browser and on your server, with no Undo. A backup works any time.'
          : 'Both replace everything in this browser. Undo works right after; a backup works any time.'
      }
    >
      <RowList label="Start over options">
        <Row
          title="Start fresh as a solo founder"
          meta={
            connected
              ? 'A one-person company with California defaults. It replaces the workspace on your server for every device too. A backup is offered first, then 3 short screens.'
              : 'A one-person company with California defaults: stages, checklists, time off, holidays and email templates. A backup is offered first, then 3 short screens.'
          }
          actions={
            <Button variant="primary" icon="user" onClick={() => setFresh(true)}>
              Start fresh
            </Button>
          }
        />
        <Row
          title="Reset to the sample company"
          meta={
            connected
              ? 'Off while this browser is connected to your server: the sample never syncs. Disconnect first in Settings, Server, then reset.'
              : sample
                ? 'Puts Ledgerlark back the way it started, with dates moved to this week.'
                : `Replaces ${company} with Ledgerlark, the fictional sample company. Download a backup first.`
          }
          actions={
            connected ? (
              <ButtonLink href={links.settings('server')} icon="globe">
                Open Settings, Server
              </ButtonLink>
            ) : (
            <ConfirmButton
              icon="rotate-ccw"
              confirmLabel="Press again to reset"
              onConfirm={() => {
                useDB.getState().replace(loadSample(), 'Reset to the sample company')
                usePrefs.getState().setViewAs('admin', null)
                undoToast('Reset to the sample company')
              }}
            >
              Reset sample
            </ConfirmButton>
            )
          }
        />
      </RowList>
      {fresh && <StartFreshSheet onClose={close} />}
    </Panel>
  )
}

const STEPS = ['Back up first', 'Company', 'Headquarters', 'You'] as const

/** What Settings, Server knows about the server at this address, for a browser that is not connected. */
export type FreshServer = { signedIn: boolean; empty?: boolean }

/**
 * Start fresh as a solo founder: a backup first, then 3 screens. Connected to a server, the new
 * workspace replaces the server's (replaceWorkspace, no Undo) after the last screen's two-click confirm.
 * Not connected, `server` (from Settings, Server) says a server answers here: signed in to an empty one,
 * the last button also uploads the new company there; otherwise the last screen says the company lives
 * in this browser only, and what comes next. onDone runs after it finished (default: go home).
 */
export function StartFreshSheet({ onClose, onDone, server }: { onClose: () => void; onDone?: () => void; server?: FreshServer | null }) {
  const connected = useSyncStatus((s) => s.mode === 'server')
  // Signed in to a server that is still empty: the new company goes there right after it is made.
  const uploadAfter = !connected && !!server?.signedIn && server.empty === true
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<{ message: string; n: number } | null>(null)
  const [step, setStep] = useState(0)
  const [backedUp, setBackedUp] = useState(false)
  const [f, setF] = useState<FreshInput>({
    companyName: '',
    website: '',
    hqStreet: '',
    hqCity: 'San Jose',
    hqState: 'CA',
    hqZip: '95113',
    firstName: '',
    lastName: '',
    title: 'Founder and CEO',
    workEmail: '',
    startDate: today(),
  })
  const set = (patch: Partial<FreshInput>) => setF((x) => ({ ...x, ...patch }))
  // Optional fields show their problem once the field is left, not while typing.
  const [left, setLeft] = useState<{ website?: boolean; workEmail?: boolean }>({})
  const websiteProblem = urlProblem(normalizeWebsite(f.website))
  const emailProblem = workEmailProblem(f.workEmail)
  const emailSuggestion = !f.workEmail?.trim() ? suggestedWorkEmail(f.firstName, f.website) : null
  const bodyRef = useRef<HTMLFormElement>(null)
  const formId = `fresh${useId().replace(/:/g, '')}`
  useEffect(() => {
    // Move focus to the first field of each screen so keyboard and switch users start in the right place.
    const el = bodyRef.current?.querySelector<HTMLElement>('input,button[role=radio],button')
    el?.focus()
  }, [step])

  const problem =
    step === 1 && !f.companyName.trim()
      ? 'Add the company name.'
      : step === 1 && websiteProblem
        ? `Website: ${websiteProblem} Or leave it blank.`
        : step === 2 && (!f.hqCity.trim() || !/^[A-Za-z]{2}$/.test(f.hqState.trim()) || !/^\d{5}$/.test(f.hqZip.trim()))
          ? 'Add the city, a two-letter state and a 5-digit ZIP.'
          : step === 3 && (!f.firstName.trim() || !f.lastName.trim())
            ? 'Add your first and last name.'
            : step === 3 && emailProblem
              ? emailProblem
              : null

  const confirmId = `${formId}-confirm`
  const finish = async () => {
    if (sending) return
    const db = buildFreshDB(f)
    const name = db.company.name
    const label = `Started fresh as ${name}`
    const after = () => {
      usePrefs.getState().setViewAs('admin', null)
      onClose()
      if (onDone) onDone()
      else navigate('home')
    }
    if (!connected) {
      // Not connected: an ordinary replace in this browser (one Undo step), done before this returns.
      void replaceWorkspace(db, label)
      if (uploadAfter) {
        // Then to the empty server. On failure the company stays in this browser, and Settings, Server
        // still offers Upload.
        setSending(true)
        setSendError(null)
        const res = await connect.uploadLocal()
        setSending(false)
        after()
        toast(
          res.ok
            ? { text: `${label}. Your server now has this workspace.` }
            : { text: `${label} in this browser only. The upload did not work: ${res.message} Upload it from Settings, Server.`, tone: 'bad' },
        )
        return
      }
      after()
      undoToast(label)
      return
    }
    setSending(true)
    setSendError(null)
    const res = await replaceWorkspace(db, label)
    setSending(false)
    if (!res.ok) {
      setSendError({ message: res.message, n: Date.now() })
      return
    }
    after()
    toast({ text: `${label}. Your server now has this workspace.` })
  }

  const legal = f.companyName.trim() ? `${f.companyName.trim()}, Inc.` : 'Your company, Inc.'

  return (
    <Sheet
      open
      onClose={onClose}
      title="Start fresh as a solo founder"
      subtitle={step === 0 ? 'Before you start' : `Step ${step} of 3: ${STEPS[step]}`}
      footer={
        <>
          {step > 0 && (
            <Button variant="ghost" icon="arrow-left" onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
          )}
          {step < 3 ? (
            <Button type="submit" form={formId} variant="primary" size="lg" iconRight="arrow-right" disabled={!!problem}>
              {step === 0 ? (backedUp ? 'Continue' : 'Continue without a backup') : 'Continue'}
            </Button>
          ) : connected ? (
            <ConfirmButton
              id={confirmId}
              variant="primary"
              size="lg"
              icon="check"
              disabled={!!problem}
              aria-disabled={sending ? true : undefined}
              confirmLabel="Press again to replace the server's workspace"
              onConfirm={() => void finish()}
            >
              {sending ? 'Starting fresh' : `Start fresh as ${f.companyName.trim() || 'my company'} on your server`}
            </ConfirmButton>
          ) : uploadAfter ? (
            <Button type="submit" form={formId} variant="primary" size="lg" icon="upload" disabled={!!problem} aria-disabled={sending ? true : undefined}>
              {sending ? 'Starting fresh' : 'Start fresh and upload to your server'}
            </Button>
          ) : (
            <Button type="submit" form={formId} variant="primary" size="lg" icon="check" disabled={!!problem}>
              Start fresh as {f.companyName.trim() || 'my company'}
            </Button>
          )}
        </>
      }
    >
      <form
        id={formId}
        ref={bodyRef}
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          // Enter in any field moves on, like the Continue button.
          e.preventDefault()
          if (problem) return
          if (step < 3) setStep((s) => s + 1)
          // Connected, the last step needs the two-click confirm: Enter lands on it instead of finishing.
          else if (connected) document.getElementById(confirmId)?.focus()
          else void finish()
        }}
        onKeyDown={(e) => {
          // Connected, the last step's button is a two-click confirm (not a submit button), so the browser
          // never submits this form on Enter. Enter in a text field lands on that button instead.
          if (e.key !== 'Enter' || step !== 3 || !connected || e.nativeEvent.isComposing) return
          const t = e.target
          if (!(t instanceof HTMLInputElement) || ['checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(t.type)) return
          e.preventDefault()
          if (!problem) document.getElementById(confirmId)?.focus()
        }}
      >
        <ol className="flex flex-wrap gap-2" aria-label="Progress">
          {STEPS.slice(1).map((s, i) => (
            <li key={s}>
              <Badge tone={step === i + 1 ? 'accent' : step > i + 1 ? 'good' : 'outline'} icon={step > i + 1 ? 'check' : undefined}>
                {i + 1}. {s}
              </Badge>
            </li>
          ))}
        </ol>
        {step === 0 && (
          <>
            {connected ? (
              <Callout tone="bad" title="This replaces everything in this browser and on your server">
                This browser is connected to your server. Starting fresh replaces the server's workspace for every computer that syncs, and there
                is no Undo. Download a backup first; it is the way back.
              </Callout>
            ) : (
              <Callout tone="warn" title="This replaces everything in this browser">
                You will have a one-person company with California defaults. Undo works right after, but a backup is the safe way back.
              </Callout>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                icon="download"
                onClick={() => {
                  if (downloadBackup()) setBackedUp(true)
                }}
              >
                Download backup
              </Button>
              <Button
                icon="copy"
                onClick={async () => {
                  if (await copyBackup()) setBackedUp(true)
                }}
              >
                Copy backup JSON
              </Button>
            </div>
            {backedUp && (
              <p className="flex items-center gap-2 text-[14px] font-semibold text-good">
                <Badge tone="good" icon="check">
                  Backed up
                </Badge>
                Your current data is saved.
              </p>
            )}
          </>
        )}
        {step === 1 && (
          <>
            <Field label="Company name" required hint={`Legal name will be "${legal}". You can change it later in Settings, Company.`}>
              {(id, hint) => (
                <TextInput id={id} aria-describedby={hint} autoComplete="organization" value={f.companyName} onChange={(e) => set({ companyName: e.target.value })} />
              )}
            </Field>
            <Field
              label="Company website (optional)"
              hint="Like example.com. Shows in Settings > Company, and new hires get work emails on its domain."
              error={left.website && websiteProblem ? websiteProblem : undefined}
            >
              {(id, hint) => (
                <TextInput
                  id={id}
                  aria-describedby={hint}
                  inputMode="url"
                  autoComplete="url"
                  value={f.website ?? ''}
                  onChange={(e) => set({ website: e.target.value })}
                  onBlur={() => setLeft((x) => ({ ...x, website: true }))}
                />
              )}
            </Field>
            <p className="text-[14px] text-ink-2">
              Stages, checklists, time off, holidays, levels and email templates start filled in with sensible defaults.
            </p>
          </>
        )}
        {step === 2 && (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13.5px] font-semibold text-ink-2">City</span>
              <ChipGroup
                label="HQ city"
               
                value={HQ_CITIES.some((c) => c.city === f.hqCity) ? f.hqCity : null}
                onChange={(city) => set({ hqCity: city, hqState: 'CA', hqZip: HQ_CITIES.find((c) => c.city === city)?.zip ?? f.hqZip })}
                options={HQ_CITIES.map((c) => ({ value: c.city, label: c.city }))}
              />
            </div>
            <FormGrid>
              <Field label="Street (optional)" hint="The office address, never a home address.">
                {(id, hint) => <TextInput id={id} aria-describedby={hint} value={f.hqStreet ?? ''} onChange={(e) => set({ hqStreet: e.target.value })} />}
              </Field>
              <Field label="City" required>
                {(id) => <TextInput id={id} value={f.hqCity} onChange={(e) => set({ hqCity: e.target.value })} />}
              </Field>
              <Field label="State" required>
                {(id) => <TextInput id={id} maxLength={2} value={f.hqState} onChange={(e) => set({ hqState: e.target.value.toUpperCase() })} />}
              </Field>
              <Field label="ZIP" required>
                {(id) => <TextInput id={id} inputMode="numeric" maxLength={5} value={f.hqZip} onChange={(e) => set({ hqZip: e.target.value })} />}
              </Field>
            </FormGrid>
            <p className="text-[13.5px] text-ink-3">The HQ city sets the local minimum wage and which city rules show up.</p>
          </>
        )}
        {step === 3 && (
          <>
            <FormGrid>
              <Field label="First name" required>
                {(id) => <TextInput id={id} autoComplete="given-name" value={f.firstName} onChange={(e) => set({ firstName: e.target.value })} />}
              </Field>
              <Field label="Last name" required>
                {(id) => <TextInput id={id} autoComplete="family-name" value={f.lastName} onChange={(e) => set({ lastName: e.target.value })} />}
              </Field>
            </FormGrid>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13.5px] font-semibold text-ink-2">Title</span>
              <ChipGroup
                label="Your title"
               
                value={FOUNDER_TITLES.includes(f.title) ? f.title : null}
                onChange={(t) => set({ title: t })}
                options={FOUNDER_TITLES.map((t) => ({ value: t, label: t }))}
              />
              <Field label="Or type your title">
                {(id) => <TextInput id={id} value={f.title} onChange={(e) => set({ title: e.target.value })} />}
              </Field>
            </div>
            <div className="flex flex-col gap-2">
              <Field
                label="Your work email (optional)"
                hint="Interview invites and emails to candidates use it as your address. Leave it blank to add it later on your profile."
                error={left.workEmail && emailProblem ? emailProblem : undefined}
              >
                {(id, hint) => (
                  <TextInput
                    id={id}
                    type="email"
                    aria-describedby={hint}
                    autoComplete="email"
                    value={f.workEmail ?? ''}
                    onChange={(e) => set({ workEmail: e.target.value })}
                    onBlur={() => setLeft((x) => ({ ...x, workEmail: true }))}
                  />
                )}
              </Field>
              {emailSuggestion && (
                <div>
                  <Button size="sm" icon="mail" onClick={() => set({ workEmail: emailSuggestion })}>
                    Use {emailSuggestion}
                  </Button>
                </div>
              )}
            </div>
            <DateField
              label="Your start date (also the founding date)"
              value={f.startDate}
              onChange={(d) => set({ startDate: d })}
              presets={pastPresets()}
              hint="You are employee #1. Anniversaries count from this date."
            />
          </>
        )}
        {problem && step > 0 && <p className="text-[13.5px] text-ink-3">{problem}</p>}
        {step === 3 && connected && !problem && (
          <p className="text-[13.5px] text-ink-2">The last button asks you to press it again, then replaces the workspace on your server.</p>
        )}
        {step === 3 && !connected && server && (
          <p className="text-[13.5px] text-ink-2">
            {uploadAfter
              ? 'Your server is empty: the new company goes there right away, and every change syncs from then on.'
              : !server.signedIn
                ? 'This company lives only in this browser. Next, sign in to your server and upload it, so it is kept there.'
                : server.empty === false
                  ? 'This company lives only in this browser. Your server already has a workspace: choose which one to keep in Settings, Server.'
                  : 'This company lives only in this browser until you upload it in Settings, Server.'}
          </p>
        )}
        <div role="alert" key={sendError?.n ?? 0} className={sendError ? undefined : 'sr-only'}>
          {sendError && (
            <Callout tone="bad" title="Nothing changed">
              {sendError.message}
            </Callout>
          )}
        </div>
        <p role="status" className={sending ? 'text-[13.5px] text-ink-2' : 'sr-only'}>
          {sending ? 'Sending the new workspace to your server.' : ''}
        </p>
      </form>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------------------------

/**
 * Sets the demo clock (null: the real date) and reloads: every page computes "today" when it renders,
 * and scheduled job changes apply on load. Connected to a server, a pretend date puts syncing on hold,
 * and going back rebuilds this browser from the server's copy (docs/SYNC.md, "Demo clock").
 */
export function setDemoClock(date: string | null): void {
  usePrefs.getState().setClock(date)
  setTimeout(() => window.location.reload(), 50)
}

function ClockPanel() {
  const override = usePrefs((s) => s.clockOverride)
  const connected = useSyncStatus((s) => s.mode === 'server')
  // The real calendar date, read directly so it is shown even while the demo clock is on.
  const real = toISODate(new Date())
  const shown = getClockOverride() ?? real
  const [pick, setPick] = useState<string>(override ?? real)
  const year = Number(shown.slice(0, 4))
  const target = pick === real ? null : pick
  const unchanged = pick === (override ?? real)
  // Connected, the first pretend date pauses syncing: a second click confirms it.
  const confirmPause = connected && !override && target !== null
  return (
    <Panel title="Pretend today is" icon="clock" subtitle="For demos and testing: every date in the app uses this day. The page reloads to apply it.">
      <div className="flex flex-col gap-4">
        <p className="text-[14.5px] text-ink">
          {override ? (
            <>
              <Badge tone="warn" icon="clock">
                Demo clock on
              </Badge>{' '}
              The app thinks today is <strong>{fmtDay(override)}, {override.slice(0, 4)}</strong>. The real date is {fmtDate(real)}.
            </>
          ) : (
            <>Using the real date, {fmtDate(real)}.</>
          )}
        </p>
        {connected && (
          <Callout tone="warn" title={override ? 'Syncing is paused while the app pretends' : 'A pretend date pauses syncing'}>
            {override
              ? 'Nothing you change reaches your server until you go back to the real date. Going back takes your server\'s copy again, so what the pretend date applied and any changes made meanwhile are dropped. Download a backup first to keep them.'
              : 'This browser is connected to your server. While a pretend date is on, nothing syncs, so job changes and hand-offs that are not due yet never reach the server. Going back to the real date takes your server\'s copy again and drops changes made while pretending.'}
          </Callout>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13.5px] font-semibold text-ink-2">Pretend date</span>
          <DateChips
            label="Pretend date"
            value={pick}
            onChange={setPick}
            presets={[
              { label: 'Next Mon', date: nextMonday(shown) },
              { label: '+1 month', date: plusMonths(shown, 1) },
              { label: `Dec 15, ${year}`, date: `${year}-12-15` },
              { label: `Jan 4, ${year + 1}`, date: `${year + 1}-01-04` },
            ]}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {confirmPause ? (
            <ConfirmButton variant="primary" icon="clock" confirmLabel="Press again to pause syncing" onConfirm={() => setDemoClock(target)}>
              Pretend today is {fmtDay(pick)}
            </ConfirmButton>
          ) : (
            <Button variant="primary" icon="clock" disabled={unchanged} onClick={() => setDemoClock(target)}>
              Pretend today is {fmtDay(pick)}
            </Button>
          )}
          {override &&
            (connected ? (
              <ConfirmButton icon="rotate-ccw" confirmLabel="Press again to take the server's copy" onConfirm={() => setDemoClock(null)}>
                Reset to real date
              </ConfirmButton>
            ) : (
              <Button icon="rotate-ccw" onClick={() => setDemoClock(null)}>
                Reset to real date
              </Button>
            ))}
          {override && connected && (
            <Button variant="ghost" icon="download" onClick={() => downloadBackup()}>
              Download backup
            </Button>
          )}
        </div>
        <p className="text-[13px] text-ink-3">
          {connected
            ? 'Try a December date to see the yearly review prompts in Rules and rates.'
            : 'Job changes and hand-offs due by the pretend day take effect and are saved, and going back to the real date does not undo them. Download a backup first if you only want a look. Try a December date to see the yearly review prompts in Rules and rates.'}
        </p>
      </div>
    </Panel>
  )
}

function nextMonday(from: string): string {
  const [y, m, d] = from.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const add = (8 - date.getDay()) % 7 || 7
  return toISODate(new Date(y, m - 1, d + add))
}

function plusMonths(from: string, n: number): string {
  const [y, m, d] = from.split('-').map(Number)
  return toISODate(new Date(y, m - 1 + n, d))
}

// ---------------------------------------------------------------------------------------------

function GraduationPanel({ count, focus }: { count: GraduationCount; focus: boolean }) {
  const db = useDB((s) => s.db)
  const hqState = (db.company.hq.state || 'CA').toUpperCase()
  const firstButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!focus) return
    // Deep link from the inbox: bring the panel into view and start keyboard users on its first action.
    document.getElementById('graduation')?.scrollIntoView({ block: 'start' })
    firstButton.current?.focus({ preventScroll: true })
  }, [focus])
  const reached = count.total >= GRADUATION_HEADCOUNT
  const t = today()
  const packs = useMemo(() => GRADUATION_PACKS.map((pack) => ({ pack, ...buildGraduationPack(db, pack.id, t) })), [db, t])
  const download = (pack: GraduationPack, csv: string) => {
    const ok = downloadFile(packFileName(db.company.name, pack.file, t), csv, 'text/csv;charset=utf-8')
    toast(
      ok
        ? { text: `${pack.label} CSV downloaded` }
        : { text: `This browser blocked the download. Use Copy for ${pack.label.toLowerCase()} instead.`, tone: 'bad' },
    )
  }
  const copy = async (pack: GraduationPack, csv: string) => {
    const ok = await copyText(csv)
    toast(
      ok
        ? { text: `${pack.label} CSV copied. Paste it into a spreadsheet or the new system's import.` }
        : { text: 'Copy was blocked by the browser.', tone: 'bad' },
    )
  }
  return (
    <Panel
      id="graduation"
      title="Graduation"
      icon="trend"
      subtitle="CSV packs for moving to a real HRIS and ATS: one row per record, dates as YYYY-MM-DD and plain column names."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[15px] font-semibold text-ink">
              {count.employed} {count.employed === 1 ? 'employee' : 'employees'}
              {count.incoming > 0 ? ` and ${count.incoming} starting or with accepted offers` : ''}: {count.total} in all
            </span>
            {reached ? (
              <Badge tone="warn" icon="alert">
                Time to plan the move
              </Badge>
            ) : (
              <Badge tone="outline">Not yet</Badge>
            )}
          </div>
          <Meter
            value={Math.min(count.total, GRADUATION_OUTGROW_AT)}
            max={GRADUATION_OUTGROW_AT}
            tone={count.total >= GRADUATION_OUTGROW_AT ? 'bad' : reached ? 'warn' : 'accent'}
            label={`${count.total} of about ${GRADUATION_OUTGROW_AT} people`}
          />
        </div>
        <Callout tone={reached ? 'warn' : 'neutral'} title={`Past about ${GRADUATION_OUTGROW_AT} people, a real HRIS and ATS fits better`}>
          <p>
            First Twenty is built for a company's first twenty people. Past about {GRADUATION_OUTGROW_AT}, or with several hires in another
            state, you need what a real system adds: records tied to payroll, real logins and permissions, multi-state compliance and an
            audit trail.
          </p>
          {count.outOfState >= 2 && (
            <p className="mt-1.5 font-semibold text-ink">
              {count.outOfState} people already work outside {hqState} ({count.outOfStateStates.join(', ')}).
            </p>
          )}
          <p className="mt-1.5">These packs are what most systems ask for at import. Keep the JSON backup too; it holds everything.</p>
        </Callout>
        <RowList label="Graduation export packs">
          {packs.map(({ pack, csv, rows }, i) => (
            <Row
              key={pack.id}
              title={pack.label}
              badges={
                <>
                  <Badge tone="outline">
                    {rows} {rows === 1 ? 'row' : 'rows'}
                  </Badge>
                  {pack.sensitive && <Badge tone="outline">{pack.id === 'grants' ? 'Includes equity' : 'Includes pay'}</Badge>}
                </>
              }
              meta={pack.description}
              actions={
                <>
                  <Button
                    ref={i === 0 ? firstButton : undefined}
                    icon="download"
                    disabled={rows === 0}
                    onClick={() => download(pack, csv)}
                    aria-label={`Download ${pack.label.toLowerCase()} CSV`}
                  >
                    Download CSV
                  </Button>
                  <Button
                    variant="ghost"
                    icon="copy"
                    disabled={rows === 0}
                    onClick={() => void copy(pack, csv)}
                    aria-label={`Copy ${pack.label.toLowerCase()} CSV`}
                  >
                    Copy
                  </Button>
                </>
              }
            />
          ))}
        </RowList>
        <p className="text-[13px] text-ink-3">
          Packs include pay and equity. Store them like any other HR record. They hold no Social Security numbers, birth dates, bank details or
          protected characteristics, because this app never keeps those. Candidates' desired pay is left out.
        </p>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------

function NotKeptPanel() {
  const company = useDB((s) => s.db.company)
  const rows = useMemo(() => dataWeDontKeep({ company }), [company])
  return (
    <Panel
      title="Data we don't keep"
      icon="lock"
      subtitle="Browser storage is not a vault. These live with the system of record; this app keeps a status, a date and a link."
    >
      <RowList label="Data we don't keep">
        {rows.map((r) => (
          <Row
            key={r.item}
            title={r.item}
            meta={
              <span className="flex flex-col gap-0.5">
                <span>
                  <span className="font-semibold text-ink-2">Kept here instead:</span> {r.instead}
                </span>
                <span>
                  <span className="font-semibold text-ink-2">System of record:</span> {r.systemOfRecord}
                </span>
              </span>
            }
          />
        ))}
      </RowList>
    </Panel>
  )
}
