// Small building blocks shared by the Settings tabs: the commit helper (mutate + activity + Undo
// toast), a panel that shows a summary and switches to an edit form, an edit sheet for list items,
// list rows, a date picker with field-specific chips and a wrapper that blurs amounts while editing.
// The edit forms keep the value they opened with, take in what another computer saves meanwhile
// (mergeIncoming in ./logic), and hand onSave the fields the user changed, so a save writes only those.
import type { Draft } from 'immer'
import type { ReactNode, RefObject } from 'react'
import { Fragment, useEffect, useId, useRef, useState } from 'react'
import type { DB, EntityType } from '@/domain/types'
import { addDays, type ISODate, today } from '@/lib/dates'
import { listJoin } from '@/lib/format'
import { logActivity, useDB } from '@/store/db'
import { usePrefs } from '@/store/prefs'
import { Button, Callout, cx, DateChips, Icon, type IconName, Panel, Private, Sheet, toast } from '@/ui'
import { produce } from 'immer'
import { changedKeys, conflictValueText, mergeIncoming, resolveConflicts } from './logic'

/** What an edit form's Save passes along: the fields the user changed since it opened. */
export type SaveInfo<T> = { changed: Array<keyof T> }

/** Field names for the conflict notice ("Cash on hand and Cash as of"). */
export type FieldLabels<T> = Partial<Record<keyof T, string>>

/**
 * How the conflict notice says a field's stored value, when conflictValueText's plain words do not fit: a
 * function for a value that needs words ('Every two weeks' for 'biweekly', '$1,200,000'), 'private' for
 * text the privacy blur hides (a policy number), or false to name the field only (a number kept masked).
 * Numbers are always under the blur.
 */
export type FieldValues<T> = { [K in keyof T]?: 'private' | false | ((value: T[K]) => string) }

/**
 * The opened and draft copies of an edit form, kept current with the stored value. `set` applies a patch on
 * top of the merged draft; `resolve` settles conflicts; `changed` is what Save should write.
 */
function useEditCopy<T extends object>(current: T, openWith?: T) {
  const [edit, setEdit] = useState<{ opened: T; draft: T } | null>(() =>
    openWith ? { opened: structuredClone(openWith), draft: structuredClone(openWith) } : null,
  )
  const merged = edit ? mergeIncoming(edit.opened, edit.draft, current) : null
  return {
    merged,
    open: (from: T) => setEdit({ opened: structuredClone(from), draft: structuredClone(from) }),
    close: () => setEdit(null),
    set: (patch: Partial<T>) =>
      setEdit((e) => {
        if (!e) return e
        const m = mergeIncoming(e.opened, e.draft, current)
        return { opened: m.opened, draft: { ...m.draft, ...patch } }
      }),
    resolve: (choice: 'theirs' | 'mine') =>
      setEdit((e) => {
        if (!e) return e
        const m = mergeIncoming(e.opened, e.draft, current)
        return resolveConflicts(m, current, m.conflicts, choice)
      }),
    changed: merged ? changedKeys(merged.opened, merged.draft) : [],
  }
}

/**
 * Shown in an edit form when a field the user changed was also saved from another computer. It says what
 * was saved there ('One-line description is now "Close in a day"'), so Use theirs is not a blind choice;
 * a field without a label or a short value is only named.
 */
function ConflictNotice<T>({
  keys,
  labels,
  values,
  current,
  onResolve,
  keepRef,
}: {
  keys: Array<keyof T>
  labels?: FieldLabels<T>
  values?: FieldValues<T>
  /** The stored value, with what the other computer saved. */
  current: T
  onResolve: (choice: 'theirs' | 'mine') => void
  keepRef: RefObject<HTMLButtonElement | null>
}) {
  const said: Array<{ key: keyof T; label: string; text: string; blurred: boolean }> = []
  const named: Array<keyof T> = []
  for (const key of keys) {
    const label = labels?.[key]
    const how = values?.[key]
    const raw = current[key]
    const text =
      !label || how === false ? null : typeof how === 'function' ? (how as (v: unknown) => string)(raw) : conflictValueText(raw)
    if (label && text !== null) said.push({ key, label, text, blurred: how === 'private' || typeof raw === 'number' })
    else named.push(key)
  }
  const names = named.map((k) => labels?.[k]).filter((n): n is string => !!n)
  const others = said.length > 0
  const lead =
    names.length === named.length
      ? listJoin(names)
      : named.length === 1
        ? others
          ? 'Another field you changed'
          : 'A field you changed'
        : `${named.length} ${others ? 'other ' : ''}fields you changed`
  const one = keys.length === 1
  return (
    <Callout tone="warn" title="This changed on another computer while you were editing">
      <p>
        {said.map((s) => (
          <Fragment key={String(s.key)}>
            {s.label} is now {s.blurred ? <Private>{s.text}</Private> : s.text}.{' '}
          </Fragment>
        ))}
        {named.length > 0 && `${lead} ${named.length === 1 ? 'was' : 'were'} also saved there. `}
        Use theirs to take the saved {one ? 'value' : 'values'}, or keep mine to save yours over {one ? 'it' : 'them'}.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onResolve('theirs')}>
          Use theirs
        </Button>
        <Button size="sm" ref={keepRef} onClick={() => onResolve('mine')}>
          Keep mine
        </Button>
      </div>
    </Callout>
  )
}

/**
 * Applies a settings change through the store with an activity row and an Undo toast.
 * Returns false (and says so) when the change would not alter anything.
 */
export function commit(
  label: string,
  recipe: (d: Draft<DB>) => void,
  opts: { entityType?: EntityType; entityId?: string; log?: string | false; quiet?: boolean } = {},
): boolean {
  const before = useDB.getState().db
  if (produce(before, recipe) === before) {
    if (!opts.quiet) toast({ text: 'Nothing changed', tone: 'neutral' })
    return false
  }
  useDB.getState().mutate(label, (d) => {
    recipe(d)
    if (opts.log !== false) {
      logActivity(d, {
        entityType: opts.entityType ?? 'settings',
        entityId: opts.entityId ?? 'settings',
        kind: 'settings_changed',
        text: typeof opts.log === 'string' ? opts.log : label,
      })
    }
  })
  toast({ text: label, action: { label: 'Undo', onClick: () => void useDB.getState().undo() } })
  return true
}

/** Focuses the first form control inside a container when `active` turns true. */
function useFocusFirst(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active || !ref.current) return
    const el = ref.current.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea,button[role=radio],button[role=switch]')
    el?.focus()
  }, [active, ref])
}

const CONFLICT_FIRST = 'Choose Use theirs or Keep mine first.'

/**
 * A panel that shows a summary and switches to an edit form in place. The draft is a copy of `value` taken
 * when Edit opens; fields another computer saves meanwhile come in unless the user changed them too (then a
 * notice asks: Use theirs or Keep mine). Save hands the draft and the changed fields to `onSave`, which
 * should write only those; Cancel throws the draft away.
 */
export function EditablePanel<T extends object>({
  title,
  subtitle,
  icon,
  value,
  view,
  form,
  onSave,
  editLabel,
  saveLabel,
  validate,
  id,
  extraActions,
  fieldLabels,
  fieldValues,
}: {
  title: ReactNode
  subtitle?: ReactNode
  icon?: IconName
  value: T
  view: ReactNode
  form: (draft: T, set: (patch: Partial<T>) => void) => ReactNode
  onSave: (draft: T, info: SaveInfo<T>) => boolean | void
  editLabel: string
  saveLabel: string
  validate?: (draft: T) => string | null
  id?: string
  extraActions?: ReactNode
  fieldLabels?: FieldLabels<T>
  fieldValues?: FieldValues<T>
}) {
  const copy = useEditCopy(value)
  const draft = copy.merged?.draft ?? null
  const conflicts = copy.merged?.conflicts ?? []
  // Problems show once Save is tried, so a fresh form never opens in red.
  const [tried, setTried] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const editBtn = useRef<HTMLButtonElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  const editing = draft !== null
  useFocusFirst(formRef, editing)
  const error = draft !== null && validate ? validate(draft) : null
  const close = () => {
    copy.close()
    setTried(false)
    setTimeout(() => editBtn.current?.focus(), 0)
  }
  return (
    <Panel
      id={id}
      title={title}
      subtitle={subtitle}
      icon={icon}
      actions={
        editing ? undefined : (
          <>
            {extraActions}
            <Button ref={editBtn} icon="edit" onClick={() => copy.open(value)}>
              {editLabel}
            </Button>
          </>
        )
      }
    >
      {draft === null ? (
        view
      ) : (
        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault()
            if (error || conflicts.length) {
              setTried(true)
              if (!error) keepRef.current?.focus()
              return
            }
            // A save that changes nothing still closes the form (commit says "Nothing changed").
            onSave(draft, { changed: copy.changed })
            close()
          }}
          className="flex flex-col gap-4"
        >
          {conflicts.length > 0 && (
            <ConflictNotice keys={conflicts} labels={fieldLabels} values={fieldValues} current={value} onResolve={copy.resolve} keepRef={keepRef} />
          )}
          {form(draft, copy.set)}
          {tried && (error || conflicts.length > 0) && (
            <p role="alert" className="text-[13.5px] font-semibold text-bad">
              {error ?? CONFLICT_FIRST}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" icon="check">
              {saveLabel}
            </Button>
          </div>
        </form>
      )}
    </Panel>
  )
}

/**
 * Side sheet with a form for one list item. Render it with a `key` per item so the draft resets.
 * Enter in a text field saves; Escape or Cancel closes without saving. Pass `current` (the stored item,
 * kept up to date) so changes saved on another computer while the sheet is open come in, as in EditablePanel.
 */
export function EditSheet<T extends object>({
  open,
  title,
  subtitle,
  initial,
  current,
  onClose,
  onSave,
  saveLabel,
  validate,
  children,
  width,
  footerExtra,
  fieldLabels,
  fieldValues,
}: {
  open: boolean
  title: ReactNode
  subtitle?: ReactNode
  initial: T
  current?: T
  onClose: () => void
  onSave: (draft: T, info: SaveInfo<T>) => boolean | void
  saveLabel: string
  validate?: (draft: T) => string | null
  children: (draft: T, set: (patch: Partial<T>) => void) => ReactNode
  width?: number
  footerExtra?: ReactNode
  fieldLabels?: FieldLabels<T>
  fieldValues?: FieldValues<T>
}) {
  // The copy opens with the sheet (a sheet is rendered with a key per item, so each item starts fresh).
  const [opened] = useState<T>(() => structuredClone(initial))
  const copy = useEditCopy(current ?? opened, opened)
  const draft = copy.merged?.draft ?? opened
  const conflicts = copy.merged?.conflicts ?? []
  const formId = `es${useId().replace(/:/g, '')}`
  const formRef = useRef<HTMLFormElement>(null)
  const keepRef = useRef<HTMLButtonElement>(null)
  // Runs after the Sheet's own focus trap (child effects first), so the first field gets focus, not Close.
  useFocusFirst(formRef, open)
  const [tried, setTried] = useState(false)
  const error = validate ? validate(draft) : null
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      width={width}
      footer={
        <>
          {tried && (error || conflicts.length > 0) && (
            <p role="alert" className="mr-auto basis-full text-[13.5px] font-semibold text-bad sm:basis-auto">
              {error ?? CONFLICT_FIRST}
            </p>
          )}
          {footerExtra}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" icon="check">
            {saveLabel}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault()
          if (error || conflicts.length) {
            setTried(true)
            if (!error) keepRef.current?.focus()
            return
          }
          onSave(draft, { changed: copy.changed })
          onClose()
        }}
        className="flex flex-col gap-4"
      >
        {conflicts.length > 0 && (
          <ConflictNotice
            keys={conflicts}
            labels={fieldLabels}
            values={fieldValues}
            current={current ?? opened}
            onResolve={copy.resolve}
            keepRef={keepRef}
          />
        )}
        {children(draft, copy.set)}
      </form>
    </Sheet>
  )
}

/** A divided list of rows with content on the left and actions on the right (stacking on phones). */
export function RowList({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-line">
      {children}
    </ul>
  )
}

export function Row({
  title,
  meta,
  badges,
  actions,
  className,
}: {
  title: ReactNode
  meta?: ReactNode
  badges?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <li className={cx('flex flex-wrap items-center gap-x-4 gap-y-2 py-3', className)}>
      <div className="min-w-0 flex-1 basis-60">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold break-words text-ink">{title}</span>
          {badges}
        </div>
        {meta && <div className="mt-0.5 text-[13.5px] break-words text-ink-3">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </li>
  )
}

/** Chips for dates in the past (founded, closed, as of): Today, 1st of this month, Jan 1, then Pick. */
export function pastPresets(): Array<{ label: string; date: ISODate }> {
  const t = today()
  return [
    { label: 'Today', date: t },
    { label: 'Yesterday', date: addDays(t, -1) },
    { label: '1st of this month', date: `${t.slice(0, 8)}01` },
    { label: `Jan 1, ${t.slice(0, 4)}`, date: `${t.slice(0, 4)}-01-01` },
  ]
}

/** DateChips with a visible label (a group label plus a heading the chips sit under). */
export function DateField({
  label,
  value,
  onChange,
  presets,
  hint,
  min,
}: {
  label: string
  value: ISODate | null | undefined
  onChange: (d: ISODate) => void
  presets?: Array<{ label: string; date: ISODate }>
  hint?: ReactNode
  min?: ISODate
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[13.5px] font-semibold text-ink-2">{label}</span>
      <DateChips label={label} value={value} onChange={onChange} presets={presets} min={min} />
      {hint && <p className="text-[12.5px] text-ink-3">{hint}</p>}
    </div>
  )
}

/** Blurs amounts in edit forms while the privacy blur (B) is on; focusing a field reveals it. */
export function Blurrable({ children }: { children: ReactNode }) {
  const blur = usePrefs((s) => s.privacyBlur)
  return <div className={cx('ft-private-wrap', blur && 'ft-private-wrap--on blur-[5px] focus-within:blur-none')}>{children}</div>
}

/** A short "applies to new X only" note under list editors. */
export function NewOnlyNote({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-[13px] text-ink-3">{children}</p>
}

/**
 * A link that looks like a kit Button (same hooks and sizes: 44px md, 48px lg). For navigation only,
 * never for actions. Like Button, its height is a minimum and a long label wraps inside it.
 */
export function ButtonLink({
  href,
  children,
  icon,
  variant = 'secondary',
  size = 'md',
  className,
  describedBy,
}: {
  href: string
  children: ReactNode
  icon?: IconName
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'md' | 'lg'
  className?: string
  describedBy?: string
}) {
  return (
    <a
      href={href}
      aria-describedby={describedBy}
      className={cx(
        'ft-btn',
        `ft-btn--${variant}`,
        `ft-btn--${size}`,
        'inline-flex max-w-full shrink-0 items-center justify-center text-center leading-tight font-semibold transition-colors select-none',
        size === 'lg' ? 'min-h-12 gap-2 rounded-xl px-5 py-2 text-[15.5px]' : 'min-h-11 gap-2 rounded-lg px-4 py-1.5 text-[14.5px]',
        variant === 'primary'
          ? 'border border-transparent bg-accent text-accent-ink shadow-sm hover:bg-accent-hover'
          : variant === 'ghost'
            ? 'border border-transparent bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink'
            : 'border border-line-strong bg-surface text-ink hover:bg-surface-2',
        className,
      )}
    >
      {icon && <Icon name={icon} size={18} className="ft-btn__icon shrink-0" />}
      {children}
    </a>
  )
}
