// The simulator panel's footer: Open in the app, run files (save, copy, download, load by pasting or from a
// file, and a short list kept in this browser), Download company and Copy bug report, with the size of the
// simulated company and its integrity count.
import { useRef, useState } from 'react'
import { copyText, downloadFile } from '@/lib/files'
import { Button, Field, Panel, Sheet, TextArea, TextInput, toast } from '@/ui'
import { sandbox } from './appSandbox'
import { simulator, useSim } from './client'
import { BROWSER_LIMIT, browserStorage, bugReport, fmtSimDay, fmtSize, loadSavedRuns, readRunText, removeSavedRun, runFile, type SavedRun, saveRun, simFileName } from './helpers'

export function Footer({ locked }: { locked: boolean }) {
  const phase = useSim((s) => s.phase)
  const size = useSim((s) => s.size)
  const integrity = useSim((s) => s.integrity)
  const date = useSim((s) => s.date)
  const working = useSim((s) => s.working)
  const [files, setFiles] = useState(false)
  const [opening, setOpening] = useState(false)
  const ready = phase === 'ready'
  const openInApp = async () => {
    simulator.pause()
    setOpening(true)
    try {
      const snap = await simulator.snapshot()
      const done = await sandbox.open(snap)
      toast({ text: done.message, tone: done.ok ? 'neutral' : 'bad' })
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : String(e), tone: 'bad' })
    } finally {
      setOpening(false)
    }
  }
  const downloadCompany = async () => {
    try {
      const snap = await simulator.snapshot()
      const ok = downloadFile(simFileName('company', snap.companyName, snap.date), JSON.stringify(snap.db, null, 2), 'application/json;charset=utf-8')
      toast(ok ? { text: 'Company downloaded. Settings, Data, Import reads it.' } : { text: 'This browser blocked the download.', tone: 'bad' })
    } catch (e) {
      toast({ text: e instanceof Error ? e.message : String(e), tone: 'bad' })
    }
  }
  const copyReport = async () => {
    const s = useSim.getState()
    if (!s.start || !s.run) return
    const ok = await copyText(bugReport({ start: s.start, run: s.run, situations: s.situations, label: s.label, date: s.date, error: s.error }))
    toast(ok ? { text: 'Bug report copied. A run from this company leaves the company out.' } : { text: 'Copy was blocked by the browser.', tone: 'bad' })
  }
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon="external" onClick={openInApp} disabled={!ready || locked || working || opening}>
          {opening ? 'Opening...' : 'Open in the app'}
        </Button>
        <Button icon="file" onClick={() => setFiles(true)}>
          Run files
        </Button>
        <Button icon="download" onClick={downloadCompany} disabled={!ready || working}>
          Download company
        </Button>
        <Button icon="copy" variant="ghost" onClick={copyReport} disabled={!ready}>
          Copy bug report
        </Button>
      </div>
      {ready && size !== null && (
        <p className="mt-3 text-[13px] text-ink-3">
          Size {fmtSize(size)} of about {fmtSize(BROWSER_LIMIT)} a browser keeps.{' '}
          {integrity === 0 ? 'Integrity: no problems.' : `Integrity: ${integrity} ${integrity === 1 ? 'problem' : 'problems'} on ${date ? fmtSimDay(date) : 'the start day'}.`}
        </p>
      )}
      <RunFilesSheet open={files} onClose={() => setFiles(false)} />
    </Panel>
  )
}

function RunFilesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const start = useSim((s) => s.start)
  const run = useSim((s) => s.run)
  const situations = useSim((s) => s.situations)
  const label = useSim((s) => s.label)
  const date = useSim((s) => s.date)
  const [name, setName] = useState('')
  const [pasted, setPasted] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [saved, setSaved] = useState<SavedRun[]>(() => loadSavedRuns(browserStorage()))
  const fileInput = useRef<HTMLInputElement>(null)
  const current = start && run ? runFile(start, run, situations) : null
  const fromCompany = start?.kind === 'workspace'
  const startRun = (r: unknown) => {
    simulator.start(r as Parameters<typeof simulator.start>[0])
    setProblem(null)
    onClose()
  }
  const load = (text: string) => {
    const read = readRunText(text)
    if (!read.ok) return setProblem(read.message)
    startRun(read.run)
  }
  return (
    <Sheet open={open} onClose={onClose} title="Run files" subtitle="A run file plays the same run again, here or with npm run sim -- play.">
      <section aria-labelledby="sim-files-this" className="flex flex-col gap-3">
        <h3 id="sim-files-this" className="text-[15px] font-bold text-ink">
          This run
        </h3>
        {!current ? (
          <p className="text-[14px] text-ink-3">Start a run first.</p>
        ) : (
          <>
            {fromCompany && (
              <p className="text-[13.5px] text-ink-3">
                It starts from this company, so the file includes the company and is not kept in this browser. Share a bug report instead: it leaves the company out.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                icon="copy"
                onClick={async () => toast((await copyText(JSON.stringify(current, null, 2))) ? { text: 'Run file copied.' } : { text: 'Copy was blocked by the browser.', tone: 'bad' })}
              >
                Copy run file
              </Button>
              <Button
                size="sm"
                icon="download"
                onClick={() =>
                  toast(
                    downloadFile(simFileName('run', label.split(':')[0] || 'run', date ?? 'start'), JSON.stringify(current, null, 2), 'application/json;charset=utf-8')
                      ? { text: 'Run file downloaded.' }
                      : { text: 'This browser blocked the download. Copy it instead.', tone: 'bad' },
                  )
                }
              >
                Download run file
              </Button>
            </div>
            {!fromCompany && (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  const done = saveRun(browserStorage(), name, current, new Date().toISOString())
                  if (!done.ok) return toast({ text: done.message, tone: 'bad' })
                  setSaved(done.list)
                  setName('')
                  toast({ text: 'Kept in this browser.' })
                }}
              >
                <Field label="Name" className="min-w-0 flex-[1_1_12rem]">
                  {(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Freeze in March" />}
                </Field>
                <Button type="submit" size="sm" icon="check">
                  Keep in this browser
                </Button>
              </form>
            )}
          </>
        )}
      </section>
      <section aria-labelledby="sim-files-load" className="mt-6 flex flex-col gap-3 border-t border-line pt-4">
        <h3 id="sim-files-load" className="text-[15px] font-bold text-ink">
          Play a run
        </h3>
        <Field label="Paste a run file" error={problem ?? undefined}>
          {(id, describedBy) => <TextArea id={id} aria-describedby={describedBy} rows={5} className="num text-[13px]" value={pasted} onChange={(e) => setPasted(e.target.value)} />}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" icon="play" onClick={() => load(pasted)}>
            Play the pasted run
          </Button>
          <Button size="sm" icon="upload" onClick={() => fileInput.current?.click()}>
            Open a run file
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            tabIndex={-1}
            aria-label="Run file"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) load(await file.text())
            }}
          />
        </div>
        {saved.length > 0 && (
          <div>
            <h4 className="ft-field__label text-[13.5px] font-semibold text-ink-2">Kept in this browser</h4>
            <ul className="mt-1">
              {saved.map((r) => (
                <li key={r.name} className="flex flex-wrap items-center gap-2 border-b border-line py-2 last:border-b-0">
                  <span className="min-w-0 flex-[1_1_10rem] text-[14px] text-ink">{r.name}</span>
                  <Button size="sm" variant="ghost" icon="play" onClick={() => startRun(r.run)} aria-label={`Play ${r.name}`}>
                    Play
                  </Button>
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => setSaved(removeSavedRun(browserStorage(), r.name))} aria-label={`Remove ${r.name}`}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </Sheet>
  )
}
