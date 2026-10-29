// The banner the Shell shows while the simulated company is open in the app (through the development banner
// slot, src/app/devSlots.ts), and the dialog that keeps it as the real company. Keep is a two-step press
// inside the dialog: no window.confirm.
import { useState } from 'react'
import { toISODate } from '@/lib/dates'
import { usePrefs } from '@/store/prefs'
import { useSyncStatus } from '@/sync'
import { Button, Checkbox, ConfirmButton, Modal, toast } from '@/ui'
import { sandbox } from './appSandbox'
import { fmtSimDay } from './helpers'

export function SandboxBanner() {
  const view = sandbox.view()
  const [keeping, setKeeping] = useState(false)
  if (!view.open || !view.date) return null
  // 40px hit areas; the negative margins keep the banner as compact as its text (as the app's banners do).
  const action = 'ft-banner__action inline-flex min-h-10 items-center rounded-lg px-2 font-bold underline'
  return (
    <div role="status" className="ft-banner ft-banner--sim mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-warn-soft px-4 py-1.5 text-[13.5px] text-ink sm:py-2.5">
      <span className="min-w-0 flex-[1_1_14rem]">
        Simulated company: <strong>{view.companyName}</strong> on {fmtSimDay(view.date)}. Nothing is saved or synced.
      </span>
      <span className="-my-1.5 -mr-2 ml-auto flex flex-wrap items-center gap-x-1 sm:-my-2.5">
        <a href="#sim" className={action}>
          Simulator
        </a>
        <button type="button" className={action} onClick={() => sandbox.back()}>
          Back to my company
        </button>
        <button type="button" className={action} onClick={() => setKeeping(true)}>
          Keep it...
        </button>
      </span>
      <KeepDialog open={keeping} onClose={() => setKeeping(false)} companyName={view.companyName} originalName={view.originalName} date={view.date} />
    </div>
  )
}

function KeepDialog({ open, onClose, companyName, originalName, date }: { open: boolean; onClose: () => void; companyName: string; originalName: string; date: string }) {
  const [downloadOriginal, setDownloadOriginal] = useState(true)
  const [pretend, setPretend] = useState(false)
  const [busy, setBusy] = useState(false)
  const connected = useSyncStatus((s) => s.mode === 'server')
  // The date the app shows once the real company is back: a Pretend today is date, or the real one (the clock
  // shows the simulated date while the sandbox is open).
  const appToday = usePrefs((s) => s.clockOverride) ?? toISODate(new Date())
  const keep = async () => {
    setBusy(true)
    const done = await sandbox.keep({ downloadOriginal, pretend })
    setBusy(false)
    toast({ text: done.message, tone: done.ok ? 'good' : 'bad' })
    if (done.ok || !sandbox.isOpen()) onClose()
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Keep ${companyName} as your company?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <ConfirmButton variant="primary" confirmLabel="Press again to keep" onConfirm={keep} disabled={busy}>
            Keep it
          </ConfirmButton>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[14px] text-ink-2">
        <p>
          This replaces {originalName} in this browser{connected ? ' and, because this browser syncs, on your server for everyone who signs in' : ''}.
        </p>
        <p>
          Its records run to {fmtSimDay(date)}. The app shows it on today's date ({fmtSimDay(appToday)}), so later records look like they are still to come.
        </p>
        <Checkbox checked={downloadOriginal} onChange={setDownloadOriginal} label={`Download a copy of ${originalName} first`} />
        <Checkbox
          checked={pretend}
          onChange={setPretend}
          label={`Pretend today is ${fmtSimDay(date)} afterwards`}
          description={connected ? 'Syncing pauses while it is on (Settings, Data). The page reloads.' : 'Settings, Data turns it off. The page reloads.'}
        />
      </div>
    </Modal>
  )
}
