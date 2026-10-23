// Small shared pieces for the hiring-process panels (interviews, scorecards, offers, background checks).
import type { Draft } from 'immer'
import { type ReactNode, useEffect, useRef } from 'react'
import type { DB } from '@/domain/types'
import { copyText, downloadFile } from '@/lib/files'
import { useDB } from '@/store/db'
import { Button, cx, Icon, type IconName, Private, toast } from '@/ui'
import { splitMoney } from './logic'

class Refused extends Error {}

/**
 * Runs one store change with a label and shows an Undo toast that names it. The recipe may return a
 * domain result: false or { ok: false, reason } cancels the whole change (nothing is written) and the
 * reason shows in a toast. Thrown errors are shown the same way. Returns the recipe's value, or null
 * when the change was refused.
 */
export function act<R>(label: string, recipe: (d: Draft<DB>) => R, opts: { quiet?: boolean; toastText?: string } = {}): { value: R } | null {
  const before = useDB.getState().db
  let value: R | undefined
  try {
    useDB.getState().mutate(label, (d) => {
      const r = recipe(d)
      if (r === false) throw new Refused('Nothing changed. The record may have moved on; refresh and try again.')
      const res = r as unknown as { ok?: unknown; reason?: string } | null
      if (res && typeof res === 'object' && 'ok' in res && res.ok === false) {
        throw new Refused((res.reason ?? 'That did not go through.').trim())
      }
      value = r
    })
  } catch (e) {
    toast({ text: e instanceof Error ? e.message : String(e), tone: 'bad' })
    return null
  }
  const changed = useDB.getState().db !== before
  if (!opts.quiet) {
    const text = opts.toastText ?? label
    toast(changed ? { text, action: { label: 'Undo', onClick: () => void useDB.getState().undo() } } : { text, tone: 'neutral' })
  }
  return { value: value as R }
}

/** Copies text and confirms with a toast that names what was copied. */
export async function copyWithToast(text: string, what: string): Promise<void> {
  const ok = await copyText(text)
  toast(ok ? { text: `Copied ${what}` } : { text: 'Copy is blocked here. Select the text and copy it with Ctrl+C.', tone: 'bad' })
}

/** Starts a download; when the host blocks downloads, copies the content instead. */
export async function downloadOrCopy(filename: string, content: string, mime: string, what: string): Promise<void> {
  const ok = downloadFile(filename, content, mime)
  if (ok) {
    toast({ text: `Downloaded ${filename}` })
    return
  }
  await copyWithToast(content, `${what} as text (downloads are blocked here)`)
}

export const DICTATION_HINT = 'Optional. To dictate, press Win+H on Windows or use dictation on a Mac.'

/** Free text typed by people (decline notes, scorecard notes) with every dollar amount in <Private>. */
export function MoneyText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      {splitMoney(text).map((p, i) => (p.money ? <Private key={i}>{p.text}</Private> : <span key={i}>{p.text}</span>))}
    </span>
  )
}

/** A labeled block inside a panel: small heading, then content. */
export function Block({ title, actions, children, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('min-w-0', className)}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[14px] font-bold text-ink">{title}</h4>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

/** A quiet one-line note with an icon (used for locks and explanations). */
export function Note({ icon = 'info', children, className }: { icon?: 'info' | 'lock' | 'clock' | 'alert' | 'check'; children: ReactNode; className?: string }) {
  return (
    <p className={cx('flex items-start gap-2 text-[13.5px] text-ink-2', className)}>
      <Icon name={icon} size={16} className="mt-0.5 shrink-0 text-ink-3" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

/** Plain text block with a monospace-free, wrapping preview of a message or file. */
export function TextPreview({ text, label, maxHeight = 260 }: { text: string; label: string; maxHeight?: number }) {
  return (
    <pre
      aria-label={label}
      tabIndex={0}
      className="scroll-thin overflow-auto rounded-xl border border-line bg-surface-2 px-3.5 py-3 font-sans text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      style={{ maxHeight }}
    >
      {text}
    </pre>
  )
}

/**
 * Download and Copy buttons for an interview's two calendar files (the candidate's and the panel's).
 * `cancel` labels them as cancellation files, which take the invite off the calendars that have it.
 */
export function IcsFileButtons({ stem, firstName, candidate, panel, cancel }: { stem: string; firstName: string; candidate: () => string; panel: () => string; cancel?: boolean }) {
  const kind = cancel ? 'cancellation' : 'calendar file'
  const file = (aud: 'candidate' | 'panel') => `${stem}-${aud}${cancel ? '-cancel' : ''}.ics`
  const mime = 'text/calendar;charset=utf-8'
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button icon="download" onClick={() => void downloadOrCopy(file('candidate'), candidate(), mime, `the candidate ${kind}`)}>
          {cancel ? `Download cancellation for ${firstName}` : `Download for ${firstName}`}
        </Button>
        <Button icon="download" onClick={() => void downloadOrCopy(file('panel'), panel(), mime, `the panel ${kind}`)}>
          {cancel ? 'Download cancellation for the panel' : 'Download for the panel'}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" icon="copy" onClick={() => void copyWithToast(candidate(), `the candidate ${kind} as text`)}>
          {cancel ? 'Copy candidate cancellation as text' : 'Copy candidate file as text'}
        </Button>
        <Button variant="ghost" size="sm" icon="copy" onClick={() => void copyWithToast(panel(), `the panel ${kind} as text`)}>
          {cancel ? 'Copy panel cancellation as text' : 'Copy panel file as text'}
        </Button>
      </div>
    </>
  )
}

/**
 * A bordered sub-section for blocks that sit inside the candidate page's application panel (the hiring
 * core wraps them in its own Panel, so these never add a second card shadow).
 */
export function SubPanel({
  title,
  titleId,
  subtitle,
  icon,
  actions,
  children,
  className,
}: {
  title: ReactNode
  /** Gives the heading an id and makes it focusable from script, so focus can land here after an action. */
  titleId?: string
  subtitle?: ReactNode
  icon?: IconName
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cx('ft-subpanel min-w-0 rounded-xl border border-line p-4', className)}>
      <div className="ft-subpanel__head mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-start gap-2">
          {icon && <Icon name={icon} size={17} className="ft-subpanel__icon mt-0.5 shrink-0 text-ink-3" />}
          <div className="min-w-0">
            <h3 id={titleId} tabIndex={titleId ? -1 : undefined} className="ft-subpanel__title text-[14.5px] font-bold text-ink">
              {title}
            </h3>
            {subtitle && <p className="ft-subpanel__subtitle mt-0.5 text-[13px] text-ink-3">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="ft-subpanel__actions flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/**
 * Wraps a chip group (ChipGroup, ChipMulti, RatingPicker) so a failed save can point at it. While
 * `error` is set, the first enabled chip carries aria-invalid and aria-describedby, which is where
 * focusFirstInvalid() lands, and the error shows under the chips. Chip groups have no single form
 * control for Field to mark, so this does it for them.
 */
export function InvalidChips({ id, error, children, className }: { id: string; error?: string | null; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const errorId = `${id}-error`
  useEffect(() => {
    const root = ref.current
    if (!root) return
    for (const el of root.querySelectorAll('[data-invalid-mark]')) {
      el.removeAttribute('aria-invalid')
      el.removeAttribute('data-invalid-mark')
      const rest = (el.getAttribute('aria-describedby') ?? '').split(' ').filter((x) => x && x !== errorId)
      if (rest.length) el.setAttribute('aria-describedby', rest.join(' '))
      else el.removeAttribute('aria-describedby')
    }
    if (!error) return
    const first = root.querySelector<HTMLElement>('[role="radio"]:not(:disabled), [role="checkbox"]:not(:disabled), button:not(:disabled), select, input')
    if (!first) return
    first.setAttribute('aria-invalid', 'true')
    first.setAttribute('data-invalid-mark', '')
    const prev = (first.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
    first.setAttribute('aria-describedby', [...prev, errorId].join(' '))
  })
  return (
    <div ref={ref} id={id} className={cx('flex flex-col gap-1.5', className)}>
      {children}
      {error && (
        <p id={errorId} className="text-[12.5px] font-semibold text-bad">
          {error}
        </p>
      )}
    </div>
  )
}
