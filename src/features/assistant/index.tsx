// The in-app HR assistant (Lark in the sample; "<company> Bot" until a company names it): the header's Ask
// button, its keyboard shortcut, and the Ask sheet. The answers come from the company's server
// (docs/SERVER.md, "Lark, the assistant"); a copy with no server says so and points at the live demo.
//
//   <AskButton />           the header button (Admin view only), the H shortcut and the sheet it opens
//   openAssistant(prefill?) opens the sheet from anywhere (Ctrl K's "Ask Lark"), with a question typed in
//   useAssistantName()      what the company calls the assistant
import { useEffect, useRef } from 'react'
import { useShortcut } from '@/app/shortcuts'
import { useViewer } from '@/app/useViewer'
import { Icon } from '@/ui'
import { AssistantSheet } from './AssistantSheet'
import { assistant, openAssistant, useAssistant, useAssistantName } from './instance'

export { openAssistant, useAssistantName } from './instance'

/**
 * Ask <name>: the header button and the H shortcut. Admin view only: the assistant reads every record,
 * pay included, and the Hiring manager and Employee previews never show other people's pay.
 */
export function AskButton() {
  const viewer = useViewer()
  const name = useAssistantName()
  const open = useAssistant((s) => s.open)
  const ref = useRef<HTMLButtonElement>(null)
  const admin = viewer.role === 'admin'
  useShortcut('h', () => openAssistant(), { description: `Ask ${name}`, group: 'Anywhere', enabled: admin })
  // Switching to a preview closes the sheet (it would otherwise come back on its own with Admin).
  useEffect(() => {
    if (!admin && open) assistant.actions.closeSheet()
  }, [admin, open])
  if (!admin) return null
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => openAssistant()}
        aria-haspopup="dialog"
        aria-label={`Ask ${name}`}
        title={`Ask ${name} (H)`}
        className="ft-btn ft-btn--ghost ft-btn--md ft-askbtn inline-flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[14px] font-semibold text-ink-2 hover:bg-surface-2 hover:text-ink"
      >
        <Icon name="message" size={18} className="shrink-0" />
        <span className="hidden max-w-[11rem] truncate xl:inline">Ask {name}</span>
      </button>
      <AssistantSheet returnFocus={() => ref.current} />
    </>
  )
}
