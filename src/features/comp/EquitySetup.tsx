// Equity setup sheets for Comp and plan > Equity: record or correct a 409A valuation, and edit the cap table
// numbers (authorized, fully diluted, founder and pool shares). The writes are the pure functions in
// src/domain/equity.ts (addValuation, updateValuation, removeValuation, updateCapTable); the cap table tool
// stays the source of truth, so these are the founder's planning copy.
import { useState } from 'react'
import {
  addValuation,
  type CapTable,
  type CapTableField,
  capTableErrors,
  capTableIsPlaceholder,
  confirmCapTable,
  defaultSafeHarborEnd,
  poolSummary,
  removeValuation,
  updateCapTable,
  updateValuation,
  valuationErrors,
} from '@/domain/equity'
import type { Valuation409A } from '@/domain/types'
import { addDays, fmtDate, type ISODate, today } from '@/lib/dates'
import { num } from '@/lib/format'
import { useDB } from '@/store/db'
import { Button, Callout, ChipGroup, ConfirmButton, DateChips, Field, focusFirstInvalid, FormGrid, NumberInput, Private, Sheet, TextArea, TextInput, toast } from '@/ui'
import { NOTE_MAX_CHARS, noteCountText } from './helpers'

function undoToast(text: string) {
  toast({ text, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
}

/** A labeled DateChips group that can carry an error (focusFirstInvalid lands on the group). */
function DateGroup({
  id,
  label,
  value,
  onChange,
  presets,
  hint,
  error,
}: {
  id: string
  label: string
  value: ISODate
  onChange: (d: ISODate) => void
  presets: Array<{ label: string; date: ISODate }>
  hint?: string
  error?: string
}) {
  return (
    <div
      id={id}
      tabIndex={error ? -1 : undefined}
      aria-invalid={error ? true : undefined}
      aria-describedby={hint || error ? `${id}-hint` : undefined}
      className="flex min-w-0 flex-col gap-1.5 outline-none"
    >
      <span className="text-[13.5px] font-semibold text-ink-2">
        {label}
        <span className="ft-field__required ml-0.5 text-bad" aria-hidden>
          *
        </span>
      </span>
      <DateChips label={label} value={value} onChange={onChange} presets={presets} />
      {(hint || error) && (
        <p id={`${id}-hint`} className={error ? 'ft-field__error text-[12.5px] font-semibold text-bad' : 'ft-field__hint text-[12.5px] text-ink-3'}>
          {error || hint}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// 409A valuation
// ---------------------------------------------------------------------------------------------

/**
 * Record a 409A (no `valuation`) or correct one on file. `effectiveOn` sets the starting effective date for a
 * new one (the board consent queue passes its board date, so the valuation is in effect for that consent).
 */
export function ValuationSheet({
  open,
  onClose,
  valuation,
  effectiveOn,
}: {
  open: boolean
  onClose: () => void
  valuation?: Valuation409A
  effectiveOn?: ISODate
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={valuation ? `Edit the 409A from ${fmtDate(valuation.effectiveOn)}` : 'Record a 409A valuation'}
      subtitle="From the valuation report. The board prices options at this fair market value on the grant date."
    >
      {/* Mounted only while open, so every opening starts from the record (or a blank form). */}
      <ValuationForm valuation={valuation} startOn={effectiveOn} onClose={onClose} />
    </Sheet>
  )
}

function ValuationForm({ valuation, startOn, onClose }: { valuation?: Valuation409A; startOn?: ISODate; onClose: () => void }) {
  const valuations = useDB((s) => s.db.equity.valuations)
  const date = today()
  const first = valuation?.effectiveOn ?? startOn ?? date
  const [effectiveOn, setEffectiveOn] = useState<ISODate>(first)
  const [fmv, setFmv] = useState<number | null>(valuation?.fmvPerShare ?? null)
  const [provider, setProvider] = useState(valuation?.provider ?? '')
  const [expiresOn, setExpiresOn] = useState<ISODate>(valuation?.expiresOn ?? defaultSafeHarborEnd(first))
  // Safe harbor follows the effective date (12 months later) until it is set by hand.
  const [expiryTouched, setExpiryTouched] = useState(!!valuation && valuation.expiresOn !== defaultSafeHarborEnd(valuation.effectiveOn))
  const [note, setNote] = useState(valuation?.note ?? '')
  const [tried, setTried] = useState(false)
  const others = valuations.filter((v) => v.id !== valuation?.id)
  const errors = valuationErrors({ effectiveOn, fmvPerShare: fmv, provider, expiresOn }, others)
  const shown = tried ? errors : {}
  const providers = [...new Set(valuations.map((v) => v.provider.trim()).filter(Boolean))].slice(0, 4)
  const noteCount = noteCountText(note)

  const pickEffective = (d: ISODate) => {
    setEffectiveOn(d)
    if (!expiryTouched) setExpiresOn(defaultSafeHarborEnd(d))
  }

  const save = () => {
    if (Object.keys(errors).length) {
      setTried(true)
      toast({ text: Object.values(errors).join(' '), tone: 'bad' })
      focusFirstInvalid()
      return
    }
    const input = { effectiveOn, fmvPerShare: fmv as number, provider, expiresOn, ...(note.trim() ? { note } : {}) }
    // The price stays out of the label: toasts are not covered by the privacy blur.
    const label = valuation ? `Updated the 409A from ${fmtDate(effectiveOn)}` : `Recorded a 409A effective ${fmtDate(effectiveOn)}`
    let changed = true
    useDB.getState().mutate(label, (draft) => {
      if (valuation) changed = updateValuation(draft, valuation.id, input)
      else addValuation(draft, input)
    })
    if (changed) undoToast(label)
    else toast({ text: 'Nothing changed', tone: 'neutral' })
    onClose()
  }

  const remove = () => {
    if (!valuation) return
    const label = `Removed the 409A from ${fmtDate(valuation.effectiveOn)}`
    useDB.getState().mutate(label, (draft) => {
      removeValuation(draft, valuation.id)
    })
    undoToast(label)
    onClose()
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-5 pb-2"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <DateGroup
        id="v409a-effective"
        label="Effective date"
        value={effectiveOn}
        onChange={pickEffective}
        presets={[
          { label: 'Today', date },
          { label: 'Yesterday', date: addDays(date, -1) },
          { label: '1st of this month', date: `${date.slice(0, 8)}01` },
        ]}
        hint="The valuation date on the report."
        error={shown.effectiveOn}
      />
      <FormGrid>
        <Field label="Price a share" required error={shown.fmvPerShare} hint="Fair market value of one common share, to the cent or finer.">
          {(id, d) => <NumberInput id={id} aria-describedby={d} value={fmv} onChange={setFmv} prefix="$" step="0.01" min={0} sensitive />}
        </Field>
        <Field label="Provider" required error={shown.provider} hint="The firm that did the valuation.">
          {(id, d) => <TextInput id={id} aria-describedby={d} autoComplete="organization" value={provider} onChange={(e) => setProvider(e.target.value)} />}
        </Field>
      </FormGrid>
      {providers.length > 0 && (
        <div className="-mt-3 flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold text-ink-3">Providers on file</span>
          <ChipGroup label="Providers on file" value={providers.includes(provider.trim()) ? provider.trim() : null} onChange={setProvider} options={providers.map((p) => ({ value: p, label: p }))} />
        </div>
      )}
      <DateGroup
        id="v409a-until"
        label="Safe harbor until"
        value={expiresOn}
        onChange={(d) => {
          setExpiresOn(d)
          setExpiryTouched(true)
        }}
        presets={[{ label: '12 months after the effective date', date: defaultSafeHarborEnd(effectiveOn) }]}
        hint="Usually 12 months. A priced round or other material event ends it sooner."
        error={shown.expiresOn}
      />
      <Field label="Note (optional)" hint={`Report name, the round it followed, anything the board should know.${noteCount ? ` ${noteCount}.` : ''}`}>
        {(id, d) => <TextArea id={id} aria-describedby={d} rows={2} maxLength={NOTE_MAX_CHARS} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      <div className="sticky -bottom-4 z-10 -mx-5 flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface px-5 pt-3 pb-4">
        <div className="flex flex-wrap gap-2">
          {valuation && (
            <ConfirmButton icon="trash" variant="ghost" onConfirm={remove} confirmLabel="Press again to remove this 409A">
              Remove
            </ConfirmButton>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" size="lg" icon="check">
            {valuation ? 'Save 409A' : 'Record 409A'}
          </Button>
        </div>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------------------------
// Cap table
// ---------------------------------------------------------------------------------------------

const CAP_FIELDS: Array<{ key: CapTableField; label: string; hint: string }> = [
  { key: 'authorizedShares', label: 'Authorized shares', hint: 'The most the charter lets the company issue.' },
  { key: 'fullyDilutedShares', label: 'Fully diluted shares', hint: 'Everything issued plus the whole option pool. Grant percentages divide by this.' },
  { key: 'founderShares', label: 'Founder shares', hint: 'Common stock held by the founders.' },
  { key: 'poolShares', label: 'Option pool', hint: 'Shares the board set aside for grants when the plan was adopted.' },
]

/**
 * Edit the cap table numbers. Pool increases stay as recorded and are listed for reference. While the numbers
 * are still the Start fresh placeholders, 'These numbers are right' confirms them as they are.
 */
export function CapTableSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Edit cap table" subtitle="Copy these from your cap table tool or the board-approved plan.">
      <CapTableForm onClose={onClose} />
    </Sheet>
  )
}

function CapTableForm({ onClose }: { onClose: () => void }) {
  const db = useDB((s) => s.db)
  const date = today()
  const e = db.equity
  const [draft, setDraft] = useState<{ [K in CapTableField]: number | null }>({
    authorizedShares: e.authorizedShares,
    fullyDilutedShares: e.fullyDilutedShares,
    founderShares: e.founderShares,
    poolShares: e.poolShares,
  })
  const [tried, setTried] = useState(false)
  const pool = poolSummary(db, date)
  const errors = capTableErrors(draft, pool.increases)
  const shown = tried ? errors : {}
  // Shares already granted, waiting for the board or held back by offers.
  const used = pool.poolShares - pool.available
  const newPool = (draft.poolShares ?? 0) + pool.increases
  const increases = [...e.poolIncreases].sort((a, b) => a.date.localeCompare(b.date))
  const placeholder = capTableIsPlaceholder(db)
  const edited = CAP_FIELDS.some((f) => draft[f.key] !== e[f.key])

  const save = () => {
    if (Object.keys(errors).length) {
      setTried(true)
      toast({ text: Object.values(errors).join(' '), tone: 'bad' })
      focusFirstInvalid()
      return
    }
    // Saving the placeholder numbers unchanged confirms them.
    const label = edited ? 'Updated the cap table' : 'Confirmed the cap table'
    let changed = false
    useDB.getState().mutate(label, (d) => {
      changed = updateCapTable(d, draft as CapTable, date)
    })
    if (changed) undoToast(label)
    else toast({ text: 'Nothing changed', tone: 'neutral' })
    onClose()
  }

  const confirm = () => {
    const label = 'Confirmed the cap table'
    useDB.getState().mutate(label, (d) => {
      confirmCapTable(d, date)
    })
    undoToast(label)
    onClose()
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-5 pb-2"
      onSubmit={(ev) => {
        ev.preventDefault()
        save()
      }}
    >
      {placeholder && (
        <Callout tone="warn" title="Placeholder numbers: check these against your cap table tool">
          Start fresh filled these in as an example. Until you change them or confirm them, offer letters give the share count only, without
          the percent of fully diluted shares.
        </Callout>
      )}
      <FormGrid>
        {CAP_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} required error={shown[f.key]} hint={f.hint}>
            {(id, d) => (
              <NumberInput
                id={id}
                aria-describedby={d}
                value={draft[f.key]}
                onChange={(v) => setDraft((x) => ({ ...x, [f.key]: v }))}
                suffix="shares"
                step={1000}
                min={0}
                sensitive
              />
            )}
          </Field>
        ))}
      </FormGrid>
      <p className="-mt-2 text-[13px] text-ink-3">Founder shares plus the option pool have to fit within fully diluted, and fully diluted within authorized.</p>
      {increases.length > 0 && (
        <div className="rounded-xl border border-line px-4 py-3 text-[14px] text-ink-2">
          <p className="font-semibold text-ink">Pool increases on record</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {increases.map((i) => (
              <li key={i.id}>
                <Private>+{num(i.shares)}</Private> on {fmtDate(i.date)}
                {i.note ? ` (${i.note})` : ''}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[13px] text-ink-3">They stay as they are and add to the option pool from their dates.</p>
        </div>
      )}
      {!errors.poolShares && newPool < used && (
        <Callout tone="warn" title="Smaller than what is already used">
          Grants and offers already use <Private>{num(used)}</Private> shares, more than this pool of <Private>{num(newPool)}</Private>. The
          pool would show as overcommitted.
        </Callout>
      )}
      <div className="sticky -bottom-4 z-10 -mx-5 flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface px-5 pt-3 pb-4">
        <div className="flex flex-wrap gap-2">
          {/* Confirms the numbers on file; once a number is edited, Save cap table does it. */}
          {placeholder && !edited && (
            <Button icon="check" onClick={confirm}>
              These numbers are right
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" size="lg" icon="check">
            Save cap table
          </Button>
        </div>
      </div>
    </form>
  )
}
