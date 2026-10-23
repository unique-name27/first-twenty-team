// Chip pickers: the app prefers one tap over typing. ChipGroup picks one option;
// DateChips offers Today / Tomorrow / Next Mon / +1 week / +2 weeks / Pick (native date input).
import type { ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { addDays, fmtDate, fmtDayAnyYear, isUsableDate, isWeekday, parseDate, toISODate, today } from '@/lib/dates'
import { cx } from './cx'
import { Icon, type IconName } from './Icon'
import { rovingKeyDown, rovingTabIndex } from './roving'

export type ChipOption<V extends string> = { value: V; label: ReactNode; icon?: IconName; hint?: string; disabled?: boolean }

/** Single-select chips (radio group). Large targets, keyboard friendly. */
export function ChipGroup<V extends string>({
  value,
  onChange,
  options,
  label,
  className,
  size = 'md',
}: {
  value: V | null | undefined
  onChange: (v: V) => void
  options: Array<ChipOption<V>>
  label: string
  className?: string
  size?: 'sm' | 'md'
}) {
  const states = options.map((o) => ({ on: o.value === value, disabled: o.disabled }))
  // Arrows move focus only; Space or Enter picks. Some chip groups act on press (reject reasons),
  // so moving through them must never pick one.
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={(e) => rovingKeyDown(e)} className={cx('ft-chips flex flex-wrap gap-2', className)}>
      {options.map((o, i) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={rovingTabIndex(i, states)}
            disabled={o.disabled}
            title={o.hint}
            onClick={() => onChange(o.value)}
            className={cx(
              'ft-chip',
              on && 'ft-chip--on',
              // At least 40px wide too: a one-character label ('5' hours) would leave a 34px target.
              'inline-flex min-w-10 items-center justify-center gap-1.5 rounded-full border font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              size === 'sm' ? 'h-10 px-3 text-[13px]' : 'h-11 px-4 text-[14px]',
              on
                ? 'border-accent bg-accent text-accent-ink'
                : 'border-line-strong bg-surface text-ink-2 hover:border-ink-3 hover:text-ink',
            )}
          >
            {o.icon && <Icon name={o.icon} size={size === 'sm' ? 14 : 16} />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Multi-select chips (checkbox semantics). */
export function ChipMulti<V extends string>({
  values,
  onChange,
  options,
  label,
  className,
}: {
  values: V[]
  onChange: (v: V[]) => void
  options: Array<ChipOption<V>>
  label: string
  className?: string
}) {
  return (
    <div role="group" aria-label={label} className={cx('ft-chips ft-chips--multi flex flex-wrap gap-2', className)}>
      {options.map((o) => {
        const on = values.includes(o.value)
        return (
          <button
            key={o.value}
            type="button"
            role="checkbox"
            aria-checked={on}
            disabled={o.disabled}
            onClick={() => onChange(on ? values.filter((v) => v !== o.value) : [...values, o.value])}
            className={cx(
              'ft-chip ft-chip--multi',
              on && 'ft-chip--on',
              'inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-full border px-3.5 text-[13.5px] font-semibold transition-colors',
              on ? 'border-accent bg-accent-soft text-accent-soft-ink' : 'border-line-strong bg-surface text-ink-2 hover:text-ink',
            )}
          >
            {on && <Icon name="check" size={14} strokeWidth={2.4} />}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function nextMonday(from: string): string {
  const d = parseDate(from)
  const add = ((8 - d.getDay()) % 7) || 7
  return toISODate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + add))
}

/**
 * The default date chips. With `weekdaysOnly`, a chip that lands on a weekend moves to Monday and is
 * labeled with that date ("Mon, Oct 12", with the year when it is not this year's), and chips that land
 * on the same day are merged (keeping the one whose words still fit), so on a Saturday "Today" never
 * quietly picks Monday.
 */
export function defaultDateChips(t: string, weekdaysOnly: boolean): Array<{ label: string; date: string }> {
  const raw = [
    { label: 'Today', date: t },
    { label: 'Tomorrow', date: addDays(t, 1) },
    { label: 'Next Mon', date: nextMonday(t) },
    { label: '+1 week', date: addDays(t, 7) },
    { label: '+2 weeks', date: addDays(t, 14) },
  ]
  if (!weekdaysOnly) return raw
  const out: Array<{ label: string; date: string; exact: boolean }> = []
  for (const c of raw) {
    let d = c.date
    while (!isWeekday(d)) d = addDays(d, 1)
    const exact = d === c.date
    const chip = { label: exact ? c.label : fmtDayAnyYear(d, t), date: d, exact }
    const dup = out.findIndex((x) => x.date === d)
    if (dup === -1) out.push(chip)
    else if (!out[dup].exact && exact) out[dup] = chip
  }
  return out.map(({ label, date }) => ({ label, date }))
}

/**
 * Why a date typed in a DateChips field cannot be used, or null when it can (or the field is empty). A
 * browser's year box takes up to 6 digits, and passes on '20266-03-16' as readily as '2026-03-16'.
 */
export function pickedDateProblem(text: string, min?: string, max?: string): string | null {
  if (!text) return null
  if (!isUsableDate(text)) return 'Enter a date with a 4-digit year'
  if (min && text < min) return `Enter a date on or after ${fmtDate(min)}`
  if (max && text > max) return `Enter a date on or before ${fmtDate(max)}`
  return null
}

/**
 * Date picker that leads with chips. `presets` can replace the defaults. A typed date reaches onChange
 * only when it is usable (pickedDateProblem); otherwise the field keeps what was typed and says what to fix.
 */
export function DateChips({
  value,
  onChange,
  label,
  presets,
  min,
  max,
  weekdaysOnly,
  id: idProp,
}: {
  value: string | null | undefined
  onChange: (d: string) => void
  label: string
  presets?: Array<{ label: string; date: string }>
  min?: string
  /** Latest date allowed (for dates in the past, such as logging an interview that already happened). */
  max?: string
  /** Snap chip choices that land on a weekend forward to Monday. */
  weekdaysOnly?: boolean
  id?: string
}) {
  const auto = useId()
  const id = idProp ?? `dc${auto.replace(/:/g, '')}`
  const t = today()
  const chips = presets ?? defaultDateChips(t, !!weekdaysOnly)
  const matched = chips.some((c) => c.date === value)
  const [picking, setPicking] = useState(!!value && !matched)
  // What the date field holds: the value, or what was typed while it cannot be used. It follows the value
  // whenever that changes (a chip, or a form reset).
  const [draft, setDraft] = useState(value ?? '')
  const [shownValue, setShownValue] = useState(value)
  if (value !== shownValue) {
    setShownValue(value)
    setDraft(value ?? '')
  }
  // A year typed digit by digit reads 0002, 0020, 0202 on its way to 2026: while the field has focus,
  // such a date is not called wrong yet (a 5-digit year or a date out of range is, at once).
  const [left, setLeft] = useState(false)
  const problem = pickedDateProblem(draft, min, max)
  const shownProblem = problem && (left || !draft.startsWith('0')) ? problem : null
  const problemId = `${id}-problem`
  const pickRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Pick moves focus into the date field it reveals (not on first render, where it may already be open).
  const focusInput = useRef(false)
  useEffect(() => {
    if (!picking || !focusInput.current) return
    focusInput.current = false
    inputRef.current?.focus()
  }, [picking])
  // aria-invalid is shared with Field (which sets it for a save error), so it is set by hand, as NumberInput does.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    if (shownProblem) el.setAttribute('aria-invalid', 'true')
    else if (!document.getElementById(`${el.id}-hint`)?.classList.contains('ft-field__error')) el.removeAttribute('aria-invalid')
  }, [shownProblem, picking])
  return (
    <div role="group" aria-label={label} className="ft-datechips flex flex-col gap-2">
      <div className="ft-chips flex flex-wrap gap-2">
        {chips.map((c) => {
          const on = c.date === value && !picking
          const disabled = (!!min && c.date < min) || (!!max && c.date > max)
          return (
            <button
              key={c.label}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              title={fmtDayAnyYear(c.date, t)}
              onClick={() => {
                setPicking(false)
                setDraft(c.date)
                onChange(c.date)
              }}
              className={cx(
                'ft-chip',
                on && 'ft-chip--on',
                'inline-flex h-10 items-center rounded-full border px-3.5 text-[13.5px] font-semibold transition-colors disabled:opacity-40',
                on ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong bg-surface text-ink-2 hover:text-ink',
              )}
            >
              {c.label}
            </button>
          )
        })}
        <button
          ref={pickRef}
          type="button"
          aria-pressed={picking}
          onClick={() => {
            if (picking) inputRef.current?.focus()
            else {
              focusInput.current = true
              setPicking(true)
            }
          }}
          className={cx(
            // One choice among the date chips (not a multi-select), so it is chosen in the same style as they are.
            'ft-chip ft-chip--pick',
            picking && 'ft-chip--on',
            'inline-flex h-10 items-center gap-1.5 rounded-full border px-3.5 text-[13.5px] font-semibold transition-colors',
            picking ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong bg-surface text-ink-2 hover:text-ink',
          )}
        >
          <Icon name="calendar" size={15} />
          Pick
        </button>
      </div>
      {picking && (
        <input
          ref={inputRef}
          id={id}
          type="date"
          aria-label={`${label}: pick a date`}
          aria-describedby={shownProblem ? problemId : undefined}
          data-range-error={shownProblem ? '' : undefined}
          min={min}
          max={max}
          value={draft}
          onChange={(e) => {
            const typed = e.target.value
            setDraft(typed)
            if (typed && !pickedDateProblem(typed, min, max)) onChange(typed)
          }}
          onFocus={() => setLeft(false)}
          onBlur={() => setLeft(true)}
          onKeyDown={(e) => {
            // Escape steps back to Pick (and folds the field away when no picked date would be hidden),
            // instead of closing the sheet or dialog around it. A typed date that cannot be used is dropped.
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            if (problem) setDraft(value ?? '')
            if (!value || matched) setPicking(false)
            pickRef.current?.focus()
          }}
          className="ft-input num h-11 w-full max-w-[220px] rounded-lg border border-control bg-surface px-3 text-[14.5px] text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
        />
      )}
      {picking && shownProblem && (
        <p id={problemId} className="ft-field__error text-[12.5px] font-semibold text-bad">
          {shownProblem}
        </p>
      )}
      {value && (
        <span className="text-[12.5px] text-ink-3">
          {/* While the field holds a date it cannot use, the date picked before stays (and Save keeps it). */}
          {picking && shownProblem ? `Still set to ${fmtDayAnyYear(value, t)}` : fmtDayAnyYear(value, t)}
        </span>
      )}
    </div>
  )
}

/**
 * A short "Why am I seeing this?" / citation chip that opens the official source. The pill looks
 * small, but the link's hit area is 40px tall (negative margins keep rows compact).
 */
export function CitationChip({ label, url }: { label: string; url?: string }) {
  // A minimum height, not a fixed one: with large text on a phone a long label wraps inside the pill.
  const pill =
    'ft-cite inline-flex min-h-7 max-w-full items-center gap-1 rounded-xl border border-line-strong px-2.5 py-0.5 text-[12px] leading-tight font-semibold text-ink-2'
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="ft-cite-link group -my-1.5 inline-flex min-h-10 max-w-full items-center rounded-xl"
      title={`Open the source: ${label}`}
    >
      <span className={cx(pill, 'group-hover:border-ink-3 group-hover:text-ink')}>
        <Icon name="scale" size={13} className="shrink-0" />
        <span className="min-w-0">{label}</span>
        <Icon name="external" size={11} className="shrink-0" />
      </span>
    </a>
  ) : (
    <span className={pill}>
      <Icon name="scale" size={13} className="shrink-0" />
      <span className="min-w-0">{label}</span>
    </span>
  )
}
