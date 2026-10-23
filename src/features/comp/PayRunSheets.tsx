// Dialogs for Comp and plan > Pay runs: the provider's totals for a pay period (actuals for Cost and runway), the
// ADP RUN import settings, and payroll IDs. Each save is one undoable change; amounts never go in toasts or activity.
import { useState } from 'react'
import { clearPayRunTotals, type PayPeriod, type PayRunRow, periodLabel, providerPhrase, setPayRunTotals, totalsProblem } from '@/domain/payrun'
import type { PayRunRecord } from '@/domain/types'
import { fmtDate, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Button, ConfirmButton, Field, focusFirstInvalid, FormGrid, Modal, NumberInput, Sheet, TextInput, toast } from '@/ui'

function undoToast(text: string) {
  toast({ text, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
}

// ---------------------------------------------------------------------------------------------
// Provider totals
// ---------------------------------------------------------------------------------------------

/** Enter (or correct) the gross pay and employer taxes from the provider's payroll register for one period. */
export function TotalsModal({ open, onClose, period, record }: { open: boolean; onClose: () => void; period: PayPeriod; record?: PayRunRecord }) {
  const provider = useDB((s) => providerPhrase(s.db.company))
  return (
    <Modal open={open} onClose={onClose} title={`Totals from ${provider}: ${periodLabel(period)}`}>
      {/* Mounted only while open, so each opening starts from what is saved. */}
      <TotalsForm period={period} record={record} provider={provider} onClose={onClose} />
    </Modal>
  )
}

function TotalsForm({ period, record, provider, onClose }: { period: PayPeriod; record?: PayRunRecord; provider: string; onClose: () => void }) {
  const [gross, setGross] = useState<number | null>(record?.totals?.gross ?? null)
  const [taxes, setTaxes] = useState<number | null>(record?.totals?.employerTaxes ?? null)
  const [tried, setTried] = useState(false)
  const problem = totalsProblem(gross, taxes)
  const grossError = tried && problem && !(gross != null && gross > 0) ? problem : undefined
  const taxError = tried && problem && !grossError ? problem : undefined

  const save = () => {
    if (problem) {
      setTried(true)
      toast({ text: problem, tone: 'bad' })
      focusFirstInvalid()
      return
    }
    const label = `Saved ${provider}'s totals for the ${periodLabel(period)} payroll`
    let ok = false
    useDB.getState().mutate(label, (draft) => {
      ok = setPayRunTotals(draft, period, { gross: gross as number, employerTaxes: taxes as number }, { date: today() }).ok
    })
    if (ok) undoToast(label)
    onClose()
  }

  const remove = () => {
    const label = `Removed the totals for the ${periodLabel(period)} payroll`
    useDB.getState().mutate(label, (draft) => {
      clearPayRunTotals(draft, period)
    })
    undoToast(label)
    onClose()
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <p className="text-[14px] text-ink-2">
        From the payroll register or summary report for the {fmtDate(period.payday)} payday. Cost and runway then uses these for past paydays instead of its estimate.
      </p>
      <FormGrid>
        <Field label="Gross pay" required error={grossError} hint="Total gross wages, before any withholding.">
          {(id, d) => <NumberInput id={id} aria-describedby={d} prefix="$" step="0.01" min={0} value={gross} onChange={setGross} sensitive data-autofocus />}
        </Field>
        <Field label="Employer taxes" required error={taxError} hint="The employer's share only: Social Security, Medicare, FUTA, state unemployment.">
          {(id, d) => <NumberInput id={id} aria-describedby={d} prefix="$" step="0.01" min={0} value={taxes} onChange={setTaxes} sensitive />}
        </Field>
      </FormGrid>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <div>
          {record?.totals && (
            <ConfirmButton icon="trash" variant="ghost" onConfirm={remove} confirmLabel="Press again to remove these totals">
              Remove totals
            </ConfirmButton>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" size="lg" icon="check">
            Save totals
          </Button>
        </div>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------------------------
// ADP RUN settings
// ---------------------------------------------------------------------------------------------

type AdpDraft = { companyCode: string; bonusCode: string; vacationCode: string; sickCode: string }

/** The company code (IID) and the company's own earnings codes, from ADP's Earnings Codes Report. */
export function AdpSettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="ADP RUN import settings" subtitle="From RUN: your company code and the Earnings Codes Report. RUN's own import template is the source of truth.">
      <AdpForm onClose={onClose} />
    </Sheet>
  )
}

function AdpForm({ onClose }: { onClose: () => void }) {
  const saved = useDB((s) => s.db.company.payroll?.adp) ?? {}
  const [d, setD] = useState<AdpDraft>({
    companyCode: saved.companyCode ?? '',
    bonusCode: saved.bonusCode ?? 'BON',
    vacationCode: saved.vacationCode ?? 'VAC',
    sickCode: saved.sickCode ?? '',
  })
  const set = (p: Partial<AdpDraft>) => setD((x) => ({ ...x, ...p }))
  const code = (v: string) => v.trim().toUpperCase().slice(0, 15)

  const save = () => {
    const label = 'Updated the ADP RUN import settings'
    useDB.getState().mutate(label, (draft) => {
      const next = { companyCode: d.companyCode.trim().slice(0, 15), bonusCode: code(d.bonusCode), vacationCode: code(d.vacationCode), sickCode: code(d.sickCode) }
      const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as AdpDraft
      draft.company.payroll = { ...(draft.company.payroll ?? {}), adp: clean }
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
      <Field label="Company code (IID)" hint="The code RUN uses for your company, or branch code plus ADP code. Every row carries it.">
        {(id, h) => <TextInput id={id} aria-describedby={h} autoComplete="off" value={d.companyCode} onChange={(e) => set({ companyCode: e.target.value })} />}
      </Field>
      <FormGrid>
        <Field label="Bonus earnings code" hint="ADP's sample uses BON.">
          {(id, h) => <TextInput id={id} aria-describedby={h} autoComplete="off" value={d.bonusCode} onChange={(e) => set({ bonusCode: e.target.value })} />}
        </Field>
        <Field label="Vacation earnings code" hint="ADP's sample uses VAC.">
          {(id, h) => <TextInput id={id} aria-describedby={h} autoComplete="off" value={d.vacationCode} onChange={(e) => set({ vacationCode: e.target.value })} />}
        </Field>
        <Field label="Sick earnings code" hint="Company-specific. Sick hours stay out of the file until it is set.">
          {(id, h) => <TextInput id={id} aria-describedby={h} autoComplete="off" value={d.sickCode} onChange={(e) => set({ sickCode: e.target.value })} />}
        </Field>
      </FormGrid>
      <div className="sticky -bottom-4 z-10 -mx-5 flex flex-wrap justify-end gap-2 border-t border-line bg-surface px-5 pt-3 pb-4">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" size="lg" icon="check">
          Save settings
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------------------------
// Payroll IDs
// ---------------------------------------------------------------------------------------------

/** The provider's employee IDs (ADP Employee ID or time clock ID) for the people on this payroll. */
export function PayrollIdsSheet({ open, onClose, rows }: { open: boolean; onClose: () => void; rows: PayRunRow[] }) {
  return (
    <Sheet open={open} onClose={onClose} title="Payroll IDs" subtitle="Each person's ID in your payroll provider, as its import matches people. Optional for the generic CSV.">
      <IdsForm rows={rows} onClose={onClose} />
    </Sheet>
  )
}

function IdsForm({ rows, onClose }: { rows: PayRunRow[]; onClose: () => void }) {
  const people = useDB((s) => s.db.people)
  const [ids, setIds] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((r) => [r.personId, people.find((p) => p.id === r.personId)?.payrollId ?? ''])),
  )

  const save = () => {
    const label = 'Updated payroll IDs'
    let changed = 0
    useDB.getState().mutate(label, (draft) => {
      for (const [personId, raw] of Object.entries(ids)) {
        const p = draft.people.find((x) => x.id === personId)
        if (!p) continue
        const v = raw.trim().slice(0, 40)
        if ((p.payrollId ?? '') === v) continue
        changed += 1
        if (v) p.payrollId = v
        else delete p.payrollId
      }
    })
    if (changed) undoToast(label)
    else toast({ text: 'Nothing changed', tone: 'neutral' })
    onClose()
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4 pb-2"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      {rows.map((r) => (
        <Field key={r.personId} label={`${r.name} (employee ${r.employeeNumber})`}>
          {(id) => <TextInput id={id} autoComplete="off" value={ids[r.personId] ?? ''} onChange={(e) => setIds((x) => ({ ...x, [r.personId]: e.target.value }))} />}
        </Field>
      ))}
      <div className="sticky -bottom-4 z-10 -mx-5 flex flex-wrap justify-end gap-2 border-t border-line bg-surface px-5 pt-3 pb-4">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" size="lg" icon="check">
          Save IDs
        </Button>
      </div>
    </form>
  )
}
