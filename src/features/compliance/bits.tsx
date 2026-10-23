// Small building blocks shared by the compliance tabs and panels.
import type { ReactNode } from 'react'
import { useId, useState } from 'react'
import { recordTrainingCompletion } from '@/domain/compliance/actions'
import { fullName } from '@/domain/people'
import { TRAINING_LABELS } from '@/domain/trainings'
import type { DB, ID, TrainingKind } from '@/domain/types'
import { fmtDate, today } from '@/lib/dates'
import { Button, cx, focusPageStart, Icon, TextInput } from '@/ui'
import { commit } from './mutate'
import { NOT_LEGAL_ADVICE, RULES_LAST_REVIEWED } from '@/domain/compliance'

/** A button that shows and hides a block (keyboard friendly, 44px target, no hover-only behavior). */
export function Disclosure({
  label,
  children,
  defaultOpen = false,
  className,
  size = 'md',
}: {
  label: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
  size?: 'sm' | 'md'
}) {
  const [open, setOpen] = useState(defaultOpen)
  const id = `dc${useId().replace(/:/g, '')}`
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'inline-flex min-h-11 items-center gap-1.5 rounded-lg px-1 font-semibold text-ink-2 hover:text-ink',
          size === 'sm' ? 'text-[13.5px]' : 'text-[14.5px]',
        )}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
        {label}
      </button>
      {open && (
        <div id={id} className="mt-1 pl-6">
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * Keeps keyboard focus in a list when a one-tap action removes its own row (Mark delivered, Mark done,
 * Done today). Call it with the clicked button before the write. The button carries `data-focus-key`
 * (stable across renders) inside a `[data-focus-scope]`; afterwards focus goes to the next keyed control
 * that still exists, else the previous one, else the scope's `[data-focus-fallback]` or first heading,
 * so focus never drops to <body>. No-op outside a scope (a modal's own close handles focus there).
 */
export function keepFocusAfter(trigger: HTMLElement | null): void {
  const scope = trigger?.closest<HTMLElement>('[data-focus-scope]')
  if (!trigger || !scope) return
  const keyOf = (el: Element) => el.getAttribute('data-focus-key') ?? ''
  const items = Array.from(scope.querySelectorAll<HTMLElement>('[data-focus-key]'))
  const i = items.indexOf(trigger)
  const after = i >= 0 ? items.slice(i + 1).map(keyOf) : []
  const before = i > 0 ? items.slice(0, i).reverse().map(keyOf) : []
  const find = (k: string) => (scope.isConnected ? scope : document).querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(k)}"]`)
  let tries = 0
  const go = () => {
    const active = document.activeElement
    // The user (or an overlay) already moved focus somewhere on purpose.
    if (active && active !== document.body && active !== trigger && active.isConnected) return
    if (trigger.isConnected) {
      // The row stayed (React has not re-rendered yet, or the action kept it): try again next frame.
      if (tries++ < 3) requestAnimationFrame(go)
      else if (active !== trigger) trigger.focus()
      return
    }
    const next = [...after, ...before].map(find).find((el): el is HTMLElement => !!el && !(el as HTMLButtonElement).disabled)
    if (next) {
      next.focus()
      return
    }
    const fallback = scope.isConnected
      ? (scope.querySelector<HTMLElement>('[data-focus-fallback]') ??
        scope.querySelector<HTMLElement>('h2, h3') ??
        scope.closest('section')?.querySelector<HTMLElement>('h2, h3'))
      : null
    if (fallback) {
      if (!fallback.hasAttribute('tabindex')) fallback.setAttribute('tabindex', '-1')
      // A heading is not a control: no focus ring (styles.css), but screen readers announce it.
      fallback.setAttribute('data-focus-target', '')
      fallback.focus()
    } else focusPageStart()
  }
  requestAnimationFrame(go)
}

/** 'Not legal advice; confirm with counsel or your PEO.' plus the last-reviewed date. */
export function LegalNote({ reviewedOn = RULES_LAST_REVIEWED, className }: { reviewedOn?: string; className?: string }) {
  return (
    <p className={cx('text-[12.5px] text-ink-3', className)}>
      {NOT_LEGAL_ADVICE} Last reviewed {fmtDate(reviewedOn)}.
    </p>
  )
}

/** Records a training completion today with an optional certificate link, then an Undo toast. */
export function markTrainingDone(db: DB, personId: ID, kind: TrainingKind, certificateLink?: string): void {
  const person = db.people.find((p) => p.id === personId)
  const name = person ? fullName(person) : 'Someone'
  const link = certificateLink?.trim()
  commit(`Marked ${TRAINING_LABELS[kind].toLowerCase()} done for ${name}`, (d) => {
    recordTrainingCompletion(d, personId, kind, today(), link ? { certificateLink: link } : {})
  })
}

/**
 * 'Done today' in one tap, with an optional certificate link one tap away. Used in the training tracker
 * and on person training panels.
 */
export function TrainingDoneControl({
  db,
  personId,
  kind,
  size = 'md',
  label = 'Done today',
  onDone,
  focusKey,
}: {
  db: DB
  personId: ID
  kind: TrainingKind
  size?: 'sm' | 'md' | 'lg'
  label?: string
  onDone?: () => void
  /** Inside a `[data-focus-scope]` list: keeps focus in the list when this row's control goes away (keepFocusAfter). */
  focusKey?: string
}) {
  const [withLink, setWithLink] = useState(false)
  const [link, setLink] = useState('')
  const inputId = `cert${useId().replace(/:/g, '')}`
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size={size}
          icon="check"
          data-focus-key={focusKey}
          onClick={(e) => {
            if (focusKey) keepFocusAfter(e.currentTarget)
            markTrainingDone(db, personId, kind, withLink ? link : undefined)
            setWithLink(false)
            setLink('')
            onDone?.()
          }}
        >
          {label}
        </Button>
        {!withLink && (
          <Button variant="ghost" size={size === 'lg' ? 'md' : size} icon="link" onClick={() => setWithLink(true)}>
            Add certificate link
          </Button>
        )}
      </div>
      {withLink && (
        <div className="flex max-w-md flex-col gap-1.5">
          <label htmlFor={inputId} className="text-[13.5px] font-semibold text-ink-2">
            Certificate link (optional)
          </label>
          <TextInput
            id={inputId}
            type="url"
            inputMode="url"
            placeholder="https://"
            value={link}
            autoFocus
            onChange={(e) => setLink(e.target.value)}
          />
          <p className="text-[12.5px] text-ink-3">Paste where the certificate lives (Drive, the course site). Never upload the file here.</p>
        </div>
      )}
    </div>
  )
}
