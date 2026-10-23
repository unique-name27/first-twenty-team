// Print my summary (printHTML) and Copy summary, offered together because some hosts block pop-ups or
// the clipboard. With the privacy blur on, pay amounts and share counts are left out.
import type { DB, Person } from '@/domain/types'
import { nowISO, today } from '@/lib/dates'
import { copyText, printHTML } from '@/lib/files'
import { usePrefs } from '@/store/prefs'
import { Button, toast } from '@/ui'
import { summaryHTML, summaryModel, summaryText } from './summary'

export function SummaryExportButtons({ db, person }: { db: DB; person: Person }) {
  const hideAmounts = usePrefs((s) => s.privacyBlur)
  const print = () => {
    const m = summaryModel(db, person.id, today(), nowISO())
    if (!m) return
    const ok = printHTML(`My summary: ${m.name}`, summaryHTML(m, { hideAmounts }))
    if (!ok) toast({ text: 'Pop-ups are blocked here, so the print view could not open. Use Copy summary instead.', tone: 'bad' })
    else toast({ text: hideAmounts ? 'Opened the print view without pay amounts (privacy blur is on)' : 'Opened the print view of your summary' })
  }
  const copy = async () => {
    const m = summaryModel(db, person.id, today(), nowISO())
    if (!m) return
    const ok = await copyText(summaryText(m, { hideAmounts }))
    toast(
      ok
        ? { text: hideAmounts ? 'Copied your summary without pay amounts' : 'Copied your summary' }
        : { text: 'Copy is blocked here. Use Print my summary instead.', tone: 'bad' },
    )
  }
  return (
    <>
      <Button icon="printer" onClick={print}>
        Print my summary
      </Button>
      <Button icon="copy" onClick={() => void copy()}>
        Copy summary
      </Button>
    </>
  )
}
