// Levels and bands (docs/SPEC.md, LEVELS AND BANDS): a matrix of job families x levels with min, mid and
// max, the equity guideline and variable or OTE split. Editing a band happens in a sheet and is logged.
import { useMemo, useState } from 'react'
import { outOfBand } from '@/domain/pay'
import type { Band, FLSA, ID, JobFamily, Level } from '@/domain/types'
import { today } from '@/lib/dates'
import { money, moneyShort } from '@/lib/format'
import { logActivity, useDB } from '@/store/db'
import { Badge, Button, Callout, Field, focusFirstInvalid, FormGrid, MoneyInput, NumberInput, Panel, Private, Segmented, Sheet, toast } from '@/ui'
import { bandErrors, type BandDraft, bandFieldErrors, equityGuidelineLabel, mlPremium, peopleInBand, premiumRangeText, sortLevels, variableLabel } from './helpers'

const TRACK_LABEL: Record<JobFamily['track'], string> = {
  engineering: 'Engineering',
  product_design: 'Product and design',
  gtm: 'Go to market',
  finance_ops: 'Finance and operations',
  executive: 'Executive',
}
const TRACK_ORDER: Array<JobFamily['track']> = ['engineering', 'product_design', 'gtm', 'finance_ops', 'executive']

type Target = { familyId: ID; levelId: ID }

export function BandsTab() {
  const db = useDB((s) => s.db)
  const date = today()
  const [editing, setEditing] = useState<Target | null>(null)
  const levels = useMemo(() => sortLevels(db.levels).filter((l) => db.bands.some((b) => b.levelId === l.id)), [db.levels, db.bands])
  const families = useMemo(
    () => [...db.families].sort((a, b) => TRACK_ORDER.indexOf(a.track) - TRACK_ORDER.indexOf(b.track)),
    [db.families],
  )
  const premium = mlPremium(db)
  const oob = outOfBand(db, date)
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const b of db.bands) m.set(b.id, peopleInBand(db, b, date).length)
    return m
  }, [db, date])

  return (
    <div className="flex flex-col gap-5">
      <Panel>
        <div className="flex flex-col gap-2 text-[14.5px] text-ink-2">
          <p className="text-ink">
            One band set, anchored to San Jose. Base pay in US dollars; equity guidelines as a share of{' '}
            <Private>{db.equity.fullyDilutedShares.toLocaleString('en-US')}</Private> fully diluted shares.
          </p>
          {premium && (
            <p>
              AI premium: machine learning midpoints run <Private>{premiumRangeText(premium.min, premium.max)}</Private> software engineering
              at the same level.
            </p>
          )}
          <p>
            {oob.length === 0 ? (
              <Badge tone="good" icon="check">
                Everyone is inside their band
              </Badge>
            ) : (
              <Badge tone="warn" icon="alert">
                {oob.length} {oob.length === 1 ? 'person sits' : 'people sit'} outside their band
              </Badge>
            )}
          </p>
        </div>
      </Panel>

      <Panel title="Bands by family and level" icon="layers" subtitle="Select a cell to edit it. Empty cells can get a band." padded={false}>
        <div className="scroll-thin relative overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13.5px]">
            <caption className="sr-only">Pay bands: job families by level</caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="sticky left-0 z-10 h-10 min-w-[150px] bg-surface px-4 text-[12.5px] font-bold text-ink-3">
                  Family
                </th>
                {levels.map((l) => (
                  <th key={l.id} scope="col" className="h-10 min-w-[150px] bg-surface-2/60 px-3 text-[12.5px] font-bold whitespace-nowrap text-ink-3">
                    {l.code} {l.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TRACK_ORDER.filter((t) => families.some((f) => f.track === t)).map((track) => (
                <TrackRows key={track} track={track} families={families.filter((f) => f.track === track)} levels={levels} counts={counts} onEdit={setEditing} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <BandSheet target={editing} onClose={() => setEditing(null)} />
    </div>
  )
}

function TrackRows({
  track,
  families,
  levels,
  counts,
  onEdit,
}: {
  track: JobFamily['track']
  families: JobFamily[]
  levels: Level[]
  counts: Map<string, number>
  onEdit: (t: Target) => void
}) {
  const bands = useDB((s) => s.db.bands)
  return (
    <>
      <tr>
        <th colSpan={levels.length + 1} scope="colgroup" className="bg-surface px-4 pt-3 pb-1 text-left">
          <span className="eyebrow">{TRACK_LABEL[track]}</span>
        </th>
      </tr>
      {families.map((f) => (
        <tr key={f.id} className="border-b border-line align-top last:border-b-0">
          <th scope="row" className="sticky left-0 z-10 bg-surface px-4 py-2 text-[14px] font-semibold text-ink">
            {f.name}
          </th>
          {levels.map((l) => {
            const b = bands.find((x) => x.familyId === f.id && x.levelId === l.id)
            return (
              <td key={l.id} className="px-1.5 py-1.5">
                {b ? (
                  <button
                    type="button"
                    onClick={() => onEdit({ familyId: f.id, levelId: l.id })}
                    aria-label={`Edit the ${f.name} ${l.code} band`}
                    className="flex min-h-11 w-full flex-col items-start rounded-lg border border-line px-2.5 py-2 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
                  >
                    <Private className="font-bold text-ink">
                      {moneyShort(b.min)}-{moneyShort(b.max)}
                    </Private>
                    <span className="text-[12px] text-ink-3">
                      mid <Private>{moneyShort(b.mid)}</Private>
                    </span>
                    <span className="mt-1 text-[12px] text-ink-2">{equityGuidelineLabel(b)}</span>
                    {b.variablePct ? <span className="text-[12px] text-ink-2">{variableLabel(b.variablePct)}</span> : null}
                    <span className="mt-1 flex flex-wrap gap-1">
                      {b.flsaDefault === 'non_exempt' && <Badge tone="outline">Non-exempt</Badge>}
                      {(counts.get(b.id) ?? 0) > 0 && (
                        <Badge tone="neutral">
                          {counts.get(b.id)} {counts.get(b.id) === 1 ? 'person' : 'people'}
                        </Badge>
                      )}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onEdit({ familyId: f.id, levelId: l.id })}
                    aria-label={`Add a ${f.name} ${l.code} band`}
                    className="flex min-h-11 w-full items-center justify-center rounded-lg border border-dashed border-line px-2 text-[12.5px] font-semibold text-ink-3 hover:border-line-strong hover:text-ink"
                  >
                    Add band
                  </button>
                )}
              </td>
            )
          })}
        </tr>
      ))}
    </>
  )
}

function BandSheet({ target, onClose }: { target: Target | null; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const family = target ? db.families.find((f) => f.id === target.familyId) : undefined
  const level = target ? db.levels.find((l) => l.id === target.levelId) : undefined
  const band = target ? db.bands.find((b) => b.familyId === target.familyId && b.levelId === target.levelId) : undefined
  return (
    <Sheet
      open={!!target}
      onClose={onClose}
      title={band ? 'Edit band' : 'Add band'}
      subtitle={family && level ? `${family.name}, ${level.code} ${level.name}` : undefined}
    >
      {target && family && level && <BandForm key={`${target.familyId}:${target.levelId}`} family={family} level={level} band={band} onClose={onClose} />}
    </Sheet>
  )
}

function BandForm({ family, level, band, onClose }: { family: JobFamily; level: Level; band?: Band; onClose: () => void }) {
  const db = useDB((s) => s.db)
  const date = today()
  // Percent in the form, fraction in the data; rounding keeps 0.15% equal to the stored 0.0015.
  const toPct = (f: number | undefined) => (f == null ? null : Math.round(f * 100000) / 1000)
  const fromPct = (p: number | null) => Math.round((p ?? 0) * 1000) / 100000
  const [d, setD] = useState<BandDraft>({
    min: band?.min ?? null,
    mid: band?.mid ?? null,
    max: band?.max ?? null,
    equityMinPct: toPct(band?.equityMinPct ?? 0),
    equityMaxPct: toPct(band?.equityMaxPct ?? 0),
    variablePct: toPct(band?.variablePct ?? 0),
  })
  const [flsa, setFlsa] = useState<FLSA>(band?.flsaDefault ?? 'exempt')
  const set = (k: keyof BandDraft) => (v: number | null) => setD((x) => ({ ...x, [k]: v }))
  const errors = bandErrors(d)
  // Field errors show after the first failed save.
  const [tried, setTried] = useState(false)
  const fieldErrors = tried ? bandFieldErrors(d) : {}
  const people = peopleInBand(db, { familyId: family.id, levelId: level.id }, date)
  const outside = errors.length || d.min == null || d.max == null ? [] : people.filter((p) => p.fteBase < (d.min as number) || p.fteBase > (d.max as number))
  const label = `${band ? 'Changed' : 'Added'} the ${family.name} ${level.code} band`

  const save = () => {
    if (errors.length || d.min == null || d.mid == null || d.max == null) {
      setTried(true)
      toast({ text: errors.join(' ') || 'Enter a minimum, midpoint and maximum.', tone: 'bad' })
      focusFirstInvalid()
      return
    }
    const next: Band = {
      id: band?.id ?? `b-${family.id.replace(/^f-/, '')}-${level.id.replace(/^lv-/, '')}`,
      familyId: family.id,
      levelId: level.id,
      min: d.min,
      mid: d.mid,
      max: d.max,
      equityMinPct: fromPct(d.equityMinPct),
      equityMaxPct: fromPct(d.equityMaxPct),
      flsaDefault: flsa,
    }
    if (d.variablePct) next.variablePct = fromPct(d.variablePct)
    const changed: string[] = []
    if (band) {
      if (band.min !== next.min || band.mid !== next.mid || band.max !== next.max) changed.push('pay range')
      if (band.equityMinPct !== next.equityMinPct || band.equityMaxPct !== next.equityMaxPct) changed.push('equity guideline')
      if ((band.variablePct ?? 0) !== (next.variablePct ?? 0)) changed.push('variable target')
      if ((band.flsaDefault ?? 'exempt') !== flsa) changed.push('FLSA default')
      if (!changed.length) {
        onClose()
        return
      }
    }
    // Activity rows can be seen outside Admin, so they name what changed, not the amounts.
    const text = changed.length ? `${label} (${changed.join(', ')})` : label
    useDB.getState().mutate(label, (draft) => {
      const i = draft.bands.findIndex((b) => b.id === next.id || (b.familyId === next.familyId && b.levelId === next.levelId))
      if (i >= 0) draft.bands[i] = next
      else draft.bands.push(next)
      logActivity(draft, { entityType: 'settings', entityId: next.id, kind: 'band_changed', text })
    })
    toast({ text, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })
    onClose()
  }

  return (
    <div className="flex flex-col gap-5 pb-2">
      <FormGrid className="sm:grid-cols-3">
        <Field label="Minimum" required error={fieldErrors.min}>
          {(id, h) => <MoneyInput id={id} aria-describedby={h} value={d.min} onChange={set('min')} />}
        </Field>
        <Field label="Midpoint" required error={fieldErrors.mid}>
          {(id, h) => <MoneyInput id={id} aria-describedby={h} value={d.mid} onChange={set('mid')} />}
        </Field>
        <Field label="Maximum" required error={fieldErrors.max}>
          {(id, h) => <MoneyInput id={id} aria-describedby={h} value={d.max} onChange={set('max')} />}
        </Field>
      </FormGrid>
      {d.min != null && d.max != null && (
        <div>
          <Button size="sm" onClick={() => setD((x) => ({ ...x, mid: Math.round(((x.min ?? 0) + (x.max ?? 0)) / 2 / 500) * 500 }))}>
            Set midpoint halfway
          </Button>
        </div>
      )}
      <FormGrid>
        <Field label="Equity guideline, low" hint="Percent of fully diluted shares" error={fieldErrors.equityMinPct}>
          {(id, h) => <NumberInput id={id} aria-describedby={h} value={d.equityMinPct} onChange={set('equityMinPct')} step={0.01} min={0} suffix="%" />}
        </Field>
        <Field label="Equity guideline, high" error={fieldErrors.equityMaxPct}>
          {(id, h) => <NumberInput id={id} aria-describedby={h} value={d.equityMaxPct} onChange={set('equityMaxPct')} step={0.01} min={0} suffix="%" />}
        </Field>
        <Field label="Variable at target" hint="Percent of base. 100% means a 50/50 OTE." error={fieldErrors.variablePct}>
          {(id, h) => <NumberInput id={id} aria-describedby={h} value={d.variablePct} onChange={set('variablePct')} step={1} min={0} suffix="%" />}
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13.5px] font-semibold text-ink-2">FLSA default</span>
          <Segmented
            label="FLSA default"
            value={flsa}
            onChange={setFlsa}
            options={[
              { value: 'exempt', label: 'Exempt' },
              { value: 'non_exempt', label: 'Non-exempt' },
            ]}
          />
        </div>
      </FormGrid>
      {d.equityMinPct != null && d.equityMaxPct != null && db.equity.fullyDilutedShares > 0 && (
        <p className="text-[13px] text-ink-3">
          That is about{' '}
          <Private>
            {Math.round((db.equity.fullyDilutedShares * (d.equityMinPct ?? 0)) / 100).toLocaleString('en-US')} to{' '}
            {Math.round((db.equity.fullyDilutedShares * (d.equityMaxPct ?? 0)) / 100).toLocaleString('en-US')}
          </Private>{' '}
          options.
        </p>
      )}
      {errors.length > 0 && (
        <Callout tone="warn" title="Check the band">
          {errors[0]}
        </Callout>
      )}
      <div className="rounded-xl bg-surface-2 px-4 py-3 text-[13.5px] text-ink-2">
        <p className="font-semibold text-ink">
          {people.length === 0 ? 'Nobody is in this band yet.' : `${people.length} ${people.length === 1 ? 'person is' : 'people are'} in this band.`}
        </p>
        {outside.length > 0 && (
          <p className="mt-1 text-warn">
            With these numbers, {outside.map((p) => p.name).join(', ')} would sit outside the band and need an exception reason.
          </p>
        )}
        <p className="mt-1">Open jobs keep their posted range until you edit them. The change is logged in Activity.</p>
        {band && (
          <p className="mt-1 text-ink-3">
            Was <Private>{money(band.min)} to {money(band.max)}</Private>.
          </p>
        )}
      </div>
      <div className="sticky -bottom-4 z-10 -mx-5 flex flex-wrap justify-end gap-2 border-t border-line bg-surface px-5 pt-3 pb-4">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="lg" icon="check" onClick={save}>
          {band ? 'Save band' : 'Add band'}
        </Button>
      </div>
    </div>
  )
}
