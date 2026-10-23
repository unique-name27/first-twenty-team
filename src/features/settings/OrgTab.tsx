// Settings > Departments, locations and levels. Locations carry the SB 553 inputs (open to the public,
// typical peak on site). Pay bands live in Comp and plan, which is their one home.
import { useMemo, useState } from 'react'
import { links } from '@/app/router'
import { getRule, NOT_LEGAL_ADVICE, SITE_THRESHOLD, siteCounts } from '@/domain/compliance'
import { employedOn, fullName, incomingOn, personNameById } from '@/domain/people'
import type { Department, JobFamily, Level, Location } from '@/domain/types'
import { today } from '@/lib/dates'
import { money2 } from '@/lib/format'
import { newId } from '@/lib/id'
import { useDB } from '@/store/db'
import {
  Badge,
  Button,
  Callout,
  ChipGroup,
  CitationChip,
  Field,
  FormGrid,
  NumberInput,
  Panel,
  Segmented,
  Select,
  Switch,
  TextArea,
  TextInput,
  TextLink,
  toast,
} from '@/ui'
import { commit, EditSheet, Row, RowList } from './kit'
import { hintWithCount, localMinWage, SHORT_TEXT_MAX_CHARS, usageOf, type UsageKind } from './logic'

const TRACK_LABELS: Record<Level['track'], string> = { ic: 'Individual contributor', manager: 'Manager', executive: 'Executive' }
const FAMILY_TRACKS: Array<{ value: JobFamily['track']; label: string }> = [
  { value: 'engineering', label: 'Engineering' },
  { value: 'product_design', label: 'Product and design' },
  { value: 'gtm', label: 'Go to market' },
  { value: 'finance_ops', label: 'Finance and ops' },
  { value: 'executive', label: 'Executive' },
]

/** Removes a list item unless something still points at it; says what does. */
function removeGuarded(kind: UsageKind, id: string, name: string, remove: () => void) {
  const db = useDB.getState().db
  const use = usageOf(db, kind, id)
  if (use.count > 0) {
    toast({ text: `${name} is still used by ${use.text}. Move them first, then remove it.`, tone: 'bad' })
    return
  }
  remove()
}

export function OrgTab() {
  return (
    <div className="flex flex-col gap-5">
      <DepartmentsPanel />
      <LocationsPanel />
      <LevelsPanel />
      <FamiliesPanel />
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

function DepartmentsPanel() {
  const db = useDB((s) => s.db)
  const [editing, setEditing] = useState<Department | null>(null)
  const people = useMemo(() => employedOn(db, today()), [db])
  const incoming = useMemo(() => incomingOn(db, today()), [db])
  const isNew = editing ? !db.departments.some((d) => d.id === editing.id) : false
  return (
    <Panel
      title="Departments"
      subtitle="Each person and job belongs to one."
      icon="users"
      actions={
        <Button icon="plus" onClick={() => setEditing({ id: newId('d'), name: '', headId: null })}>
          Add department
        </Button>
      }
    >
      <RowList label="Departments">
        {db.departments.map((d) => {
          const n = people.filter((p) => p.departmentId === d.id).length
          const starting = incoming.filter((p) => p.departmentId === d.id).length
          return (
            <Row
              key={d.id}
              title={d.name}
              meta={`${n === 1 ? '1 person' : `${n} people`}${starting ? `, ${starting} starting soon` : ''}${d.headId ? ` · Head: ${personNameById(db, d.headId)}` : ' · No head set'}`}
              actions={
                <>
                  <Button icon="edit" onClick={() => setEditing(d)} aria-label={`Edit ${d.name}`}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    icon="trash"
                    aria-label={`Remove ${d.name}`}
                    onClick={() =>
                      removeGuarded('department', d.id, d.name, () =>
                        commit(`Removed the ${d.name} department`, (draft) => {
                          draft.departments = draft.departments.filter((x) => x.id !== d.id)
                        }),
                      )
                    }
                  >
                    Remove
                  </Button>
                </>
              }
            />
          )
        })}
      </RowList>
      {editing && (
        <EditSheet<Department>
          key={editing.id}
          open
          title={isNew ? 'Add a department' : `Edit ${editing.name}`}
          initial={editing}
          onClose={() => setEditing(null)}
          saveLabel={isNew ? 'Add department' : 'Save department'}
          validate={(d) =>
            !d.name.trim()
              ? 'Name the department.'
              : db.departments.some((x) => x.id !== d.id && x.name.toLowerCase() === d.name.trim().toLowerCase())
                ? 'A department with that name already exists.'
                : null
          }
          onSave={(d) =>
            commit(isNew ? `Added the ${d.name.trim()} department` : `Updated the ${d.name.trim()} department`, (draft) => {
              const row: Department = { id: d.id, name: d.name.trim(), headId: d.headId || null }
              const i = draft.departments.findIndex((x) => x.id === d.id)
              if (i >= 0) draft.departments[i] = row
              else draft.departments.push(row)
            })
          }
        >
          {(d, set) => (
            <>
              <Field label="Name" required>
                {(id) => <TextInput id={id} value={d.name} onChange={(e) => set({ name: e.target.value })} />}
              </Field>
              <Field label="Department head" hint="Optional. Used on the org chart and plan.">
                {(id, hint) => (
                  <Select
                    id={id}
                    aria-describedby={hint}
                    value={d.headId ?? ''}
                    placeholder="No head yet"
                    onChange={(v) => set({ headId: v || null })}
                    options={people.map((p) => ({ value: p.id, label: fullName(p) }))}
                  />
                )}
              </Field>
            </>
          )}
        </EditSheet>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------

type LocDraft = Omit<Location, 'typicalMaxOnSite' | 'minWageHourly'> & {
  typicalMaxOnSite: number | null
  minWageHourly: number | null
}

function toDraft(l: Location): LocDraft {
  return { ...l, typicalMaxOnSite: l.typicalMaxOnSite ?? null, minWageHourly: l.minWageHourly }
}

function LocationsPanel() {
  const db = useDB((s) => s.db)
  const [editing, setEditing] = useState<LocDraft | null>(null)
  const sites = useMemo(() => siteCounts(db, today()), [db])
  const wvpp = getRule('wvpp')
  const isNew = editing ? !db.locations.some((l) => l.id === editing.id) : false
  const site = editing ? sites.find((s) => s.location?.id === editing.id) : undefined
  return (
    <Panel
      title="Locations"
      subtitle="Offices and remote states. Minimum wages here feed the non-exempt checks."
      icon="pin"
      actions={
        <Button
          icon="plus"
          onClick={() =>
            setEditing({ id: newId('loc'), name: '', kind: 'remote', state: 'CA', minWageHourly: db.settings.law.caMinWageHourly, typicalMaxOnSite: null })
          }
        >
          Add location
        </Button>
      }
    >
      <Callout tone="neutral" icon="shield" title="Why we ask about people on site (SB 553)">
        <p>
          A written workplace violence prevention plan applies to a workplace unless fewer than {SITE_THRESHOLD} employees are ever
          there at the same time and it is closed to the public. Remote staff working from a place they choose do not count. For a
          hybrid office, count everyone on your busiest office day.
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-2">
          {wvpp && <CitationChip label={wvpp.citation.label} url={wvpp.citation.url} />}
          <span className="text-[13px] text-ink-3">{NOT_LEGAL_ADVICE}</span>
        </p>
      </Callout>
      <RowList label="Locations">
        {db.locations.map((l) => {
          const s = sites.find((x) => x.location?.id === l.id)
          const applies = s ? s.count >= SITE_THRESHOLD || s.publicAccess : false
          return (
            <Row
              key={l.id}
              title={l.name}
              badges={
                <>
                  <Badge tone={l.kind === 'hq' ? 'accent' : 'neutral'}>{l.kind === 'hq' ? 'Office' : 'Remote'}</Badge>
                  {s && (applies ? <Badge tone="warn" icon="alert">SB 553 plan likely applies</Badge> : <Badge tone="good">Under 10 on site</Badge>)}
                </>
              }
              meta={
                <>
                  {[l.city, l.state].filter(Boolean).join(', ')} · Minimum wage {money2(l.minWageHourly)} an hour
                  {l.kind === 'hq' && s && (
                    <>
                      {' '}
                      · {s.fromSettings ? `Typical peak on site ${s.setting}` : 'Peak on site not set'} · {s.assigned} assigned onsite or hybrid
                      {l.publicAccess ? ' · Open to the public' : ''}
                    </>
                  )}
                  {s?.staleSetting && (
                    <span className="block font-semibold text-warn">
                      The peak on site is lower than the {s.assigned} people assigned there. Check it.
                    </span>
                  )}
                </>
              }
              actions={
                <>
                  <Button icon="edit" onClick={() => setEditing(toDraft(l))} aria-label={`Edit ${l.name}`}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    icon="trash"
                    aria-label={`Remove ${l.name}`}
                    onClick={() =>
                      removeGuarded('location', l.id, l.name, () =>
                        commit(`Removed the ${l.name} location`, (draft) => {
                          draft.locations = draft.locations.filter((x) => x.id !== l.id)
                        }),
                      )
                    }
                  >
                    Remove
                  </Button>
                </>
              }
            />
          )
        })}
      </RowList>
      {editing && (
        <EditSheet<LocDraft>
          key={editing.id}
          open
          title={isNew ? 'Add a location' : `Edit ${editing.name}`}
          initial={editing}
          onClose={() => setEditing(null)}
          saveLabel={isNew ? 'Add location' : 'Save location'}
          validate={(d) =>
            !d.name.trim()
              ? 'Name the location, like "San Jose HQ" or "Remote (Texas)".'
              : !/^[A-Za-z]{2}$/.test(d.state.trim())
                ? 'Use the two-letter state code.'
                : d.minWageHourly == null || d.minWageHourly <= 0
                  ? 'Add the minimum wage that applies there.'
                  : null
          }
          onSave={(d) =>
            commit(isNew ? `Added the ${d.name.trim()} location` : `Updated the ${d.name.trim()} location`, (draft) => {
              const row: Location = {
                id: d.id,
                name: d.name.trim(),
                kind: d.kind,
                state: d.state.trim().toUpperCase(),
                minWageHourly: d.minWageHourly ?? 0,
              }
              if (d.city?.trim()) row.city = d.city.trim()
              if (d.minWageNote?.trim()) row.minWageNote = d.minWageNote.trim()
              if (d.kind === 'hq') {
                row.publicAccess = !!d.publicAccess
                if (d.typicalMaxOnSite != null) row.typicalMaxOnSite = Math.max(0, Math.round(d.typicalMaxOnSite))
              }
              const i = draft.locations.findIndex((x) => x.id === d.id)
              if (i >= 0) draft.locations[i] = row
              else draft.locations.push(row)
            })
          }
        >
          {(d, set) => {
            const local = localMinWage(d.city)
            return (
              <>
                <Field label="Name" required>
                  {(id) => <TextInput id={id} value={d.name} onChange={(e) => set({ name: e.target.value })} />}
                </Field>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13.5px] font-semibold text-ink-2">Kind</span>
                  <Segmented
                    label="Kind"
                    value={d.kind}
                    onChange={(v) => set({ kind: v })}
                    options={[
                      { value: 'hq', label: 'Office' },
                      { value: 'remote', label: 'Remote' },
                    ]}
                  />
                </div>
                <FormGrid>
                  <Field label="City" hint={d.kind === 'remote' ? 'Optional for remote.' : undefined}>
                    {(id, hint) => (
                      <TextInput id={id} aria-describedby={hint} value={d.city ?? ''} onChange={(e) => set({ city: e.target.value })} />
                    )}
                  </Field>
                  <Field label="State" required>
                    {(id) => (
                      <TextInput id={id} maxLength={2} value={d.state} onChange={(e) => set({ state: e.target.value.toUpperCase() })} />
                    )}
                  </Field>
                </FormGrid>
                <Field
                  label="Minimum wage, hourly"
                  required
                  hint={`California is ${money2(db.settings.law.caMinWageHourly)} in ${db.settings.law.year}; many Bay Area cities are higher.`}
                >
                  {(id, hint) => (
                    <div className="flex flex-col gap-2">
                      <NumberInput
                        id={id}
                        aria-describedby={hint}
                        prefix="$"
                        step="0.01"
                        min={0}
                        value={d.minWageHourly}
                        onChange={(v) => set({ minWageHourly: v })}
                      />
                      <div className="flex flex-wrap gap-2">
                        {local && local !== d.minWageHourly && (
                          <Button onClick={() => set({ minWageHourly: local, minWageNote: `City of ${d.city?.trim()} minimum wage` })}>
                            Use {d.city?.trim()} rate {money2(local)}
                          </Button>
                        )}
                        {d.state.toUpperCase() === 'CA' && d.minWageHourly !== db.settings.law.caMinWageHourly && (
                          <Button
                           
                            variant="ghost"
                            onClick={() => set({ minWageHourly: db.settings.law.caMinWageHourly, minWageNote: 'California minimum wage' })}
                          >
                            Use California rate {money2(db.settings.law.caMinWageHourly)}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </Field>
                <Field label="Minimum wage note">
                  {(id) => <TextInput id={id} value={d.minWageNote ?? ''} onChange={(e) => set({ minWageNote: e.target.value })} />}
                </Field>
                {d.kind === 'hq' && (
                  <>
                    <Switch
                      label="Open to the public"
                      description="Customers or visitors walk in. A public workplace needs the SB 553 plan at any size."
                      checked={!!d.publicAccess}
                      onChange={(v) => set({ publicAccess: v })}
                    />
                    <Field
                      label="Typical peak on site at once"
                      hint={
                        site
                          ? `${site.assigned} employees are assigned here onsite or hybrid${site.onsiteOnly ? `, ${site.onsiteOnly} onsite only` : ''}. Leave blank to count all of them.`
                          : 'People here at the same time on your busiest day. Leave blank to count everyone assigned here.'
                      }
                    >
                      {(id, hint) => (
                        <div className="flex flex-col gap-2">
                          <ChipGroup
                            label="Typical peak on site choices"
                           
                            value={d.typicalMaxOnSite != null ? String(d.typicalMaxOnSite) : null}
                            onChange={(v) => set({ typicalMaxOnSite: Number(v) })}
                            options={[1, 5, 9, 10, 12, 15, 20].map((n) => ({ value: String(n), label: String(n) }))}
                          />
                          <NumberInput
                            id={id}
                            aria-describedby={hint}
                            min={0}
                            step="1"
                            value={d.typicalMaxOnSite}
                            onChange={(v) => set({ typicalMaxOnSite: v })}
                          />
                        </div>
                      )}
                    </Field>
                    {d.typicalMaxOnSite != null && (
                      <p className="text-[13.5px] text-ink-2">
                        {d.publicAccess || (d.typicalMaxOnSite ?? 0) >= SITE_THRESHOLD
                          ? 'With these answers, a workplace violence prevention plan likely applies here.'
                          : `With these answers, this office stays under ${SITE_THRESHOLD} on site and closed to the public.`}
                      </p>
                    )}
                  </>
                )}
              </>
            )
          }}
        </EditSheet>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------

type LevelDraft = Omit<Level, 'order'> & { order: number | null }

function LevelsPanel() {
  const levels = useDB((s) => s.db.levels)
  const [editing, setEditing] = useState<LevelDraft | null>(null)
  const sorted = useMemo(
    () => [...levels].sort((a, b) => (a.track === b.track ? a.order - b.order : a.track.localeCompare(b.track))),
    [levels],
  )
  const isNew = editing ? !levels.some((l) => l.id === editing.id) : false
  return (
    <Panel
      title="Levels"
      subtitle={
        <>
          The ladder offers and bands use. Band amounts live in{' '}
          <TextLink href={links.comp('bands')}>Comp and plan, Levels and bands</TextLink>.
        </>
      }
      icon="layers"
      actions={
        <Button icon="plus" onClick={() => setEditing({ id: newId('lv'), code: '', name: '', track: 'ic', order: null })}>
          Add level
        </Button>
      }
    >
      <RowList label="Levels">
        {sorted.map((l) => (
          <Row
            key={l.id}
            title={
              <>
                <span className="font-mono">{l.code}</span> {l.name}
              </>
            }
            badges={<Badge>{TRACK_LABELS[l.track]}</Badge>}
            meta={l.description}
            actions={
              <>
                <Button icon="edit" onClick={() => setEditing(l)} aria-label={`Edit ${l.code} ${l.name}`}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  icon="trash"
                  aria-label={`Remove ${l.code} ${l.name}`}
                  onClick={() =>
                    removeGuarded('level', l.id, `${l.code} ${l.name}`, () =>
                      commit(`Removed level ${l.code}`, (draft) => {
                        draft.levels = draft.levels.filter((x) => x.id !== l.id)
                      }),
                    )
                  }
                >
                  Remove
                </Button>
              </>
            }
          />
        ))}
      </RowList>
      {editing && (
        <EditSheet<LevelDraft>
          key={editing.id}
          open
          title={isNew ? 'Add a level' : `Edit ${editing.code} ${editing.name}`}
          initial={editing}
          onClose={() => setEditing(null)}
          saveLabel={isNew ? 'Add level' : 'Save level'}
          validate={(d) =>
            !d.code.trim()
              ? 'Add a short code, like L3 or M1.'
              : !d.name.trim()
                ? 'Name the level, like Senior.'
                : levels.some((x) => x.id !== d.id && x.code.toLowerCase() === d.code.trim().toLowerCase())
                  ? 'Another level already uses that code.'
                  : d.order == null
                    ? 'Pick a seniority from 1 to 9.'
                    : null
          }
          onSave={(d) =>
            commit(isNew ? `Added level ${d.code.trim()}` : `Updated level ${d.code.trim()}`, (draft) => {
              const row: Level = { id: d.id, code: d.code.trim(), name: d.name.trim(), track: d.track, order: d.order ?? 1 }
              if (d.description?.trim()) row.description = d.description.trim()
              const i = draft.levels.findIndex((x) => x.id === d.id)
              if (i >= 0) draft.levels[i] = row
              else draft.levels.push(row)
            })
          }
        >
          {(d, set) => (
            <>
              <FormGrid>
                <Field label="Code" required hint="Short, like L3 or M1.">
                  {(id, hint) => (
                    <TextInput id={id} aria-describedby={hint} className="font-mono" value={d.code} onChange={(e) => set({ code: e.target.value })} />
                  )}
                </Field>
                <Field label="Name" required>
                  {(id) => <TextInput id={id} value={d.name} onChange={(e) => set({ name: e.target.value })} />}
                </Field>
              </FormGrid>
              <div className="flex flex-col gap-1.5">
                <span className="text-[13.5px] font-semibold text-ink-2">Track</span>
                <Segmented
                  label="Track"
                  value={d.track}
                  onChange={(v) => set({ track: v })}
                  options={[
                    { value: 'ic', label: 'Individual contributor' },
                    { value: 'manager', label: 'Manager' },
                    { value: 'executive', label: 'Executive' },
                  ]}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[13.5px] font-semibold text-ink-2">Seniority (1 is most junior)</span>
                <ChipGroup
                  label="Seniority"
                 
                  value={d.order != null ? String(d.order) : null}
                  onChange={(v) => set({ order: Number(v) })}
                  options={[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ value: String(n), label: String(n) }))}
                />
              </div>
              <Field
                label="What this level means"
                hint={hintWithCount('One or two sentences. Helps keep offers consistent.', d.description, SHORT_TEXT_MAX_CHARS)}
              >
                {(id, hint) => (
                  <TextArea
                    id={id}
                    aria-describedby={hint}
                    rows={3}
                    maxLength={SHORT_TEXT_MAX_CHARS}
                    value={d.description ?? ''}
                    onChange={(e) => set({ description: e.target.value })}
                  />
                )}
              </Field>
            </>
          )}
        </EditSheet>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------

function FamiliesPanel() {
  const families = useDB((s) => s.db.families)
  const [editing, setEditing] = useState<JobFamily | null>(null)
  const isNew = editing ? !families.some((f) => f.id === editing.id) : false
  const trackLabel = (t: JobFamily['track']) => FAMILY_TRACKS.find((x) => x.value === t)?.label ?? t
  return (
    <Panel
      title="Job families"
      subtitle="Bands are set per family and level, so ML roles can carry their premium."
      icon="briefcase"
      actions={
        <Button icon="plus" onClick={() => setEditing({ id: newId('f'), name: '', track: 'engineering' })}>
          Add job family
        </Button>
      }
    >
      <RowList label="Job families">
        {families.map((f) => (
          <Row
            key={f.id}
            title={f.name}
            badges={<Badge>{trackLabel(f.track)}</Badge>}
            actions={
              <>
                <Button icon="edit" onClick={() => setEditing(f)} aria-label={`Edit ${f.name}`}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  icon="trash"
                  aria-label={`Remove ${f.name}`}
                  onClick={() =>
                    removeGuarded('family', f.id, f.name, () =>
                      commit(`Removed the ${f.name} job family`, (draft) => {
                        draft.families = draft.families.filter((x) => x.id !== f.id)
                      }),
                    )
                  }
                >
                  Remove
                </Button>
              </>
            }
          />
        ))}
      </RowList>
      {editing && (
        <EditSheet<JobFamily>
          key={editing.id}
          open
          title={isNew ? 'Add a job family' : `Edit ${editing.name}`}
          initial={editing}
          onClose={() => setEditing(null)}
          saveLabel={isNew ? 'Add job family' : 'Save job family'}
          validate={(d) =>
            !d.name.trim()
              ? 'Name the job family.'
              : families.some((x) => x.id !== d.id && x.name.toLowerCase() === d.name.trim().toLowerCase())
                ? 'A job family with that name already exists.'
                : null
          }
          onSave={(d) =>
            commit(isNew ? `Added the ${d.name.trim()} job family` : `Updated the ${d.name.trim()} job family`, (draft) => {
              const row: JobFamily = { id: d.id, name: d.name.trim(), track: d.track }
              const i = draft.families.findIndex((x) => x.id === d.id)
              if (i >= 0) draft.families[i] = row
              else draft.families.push(row)
            })
          }
        >
          {(d, set) => (
            <>
              <Field label="Name" required>
                {(id) => <TextInput id={id} value={d.name} onChange={(e) => set({ name: e.target.value })} />}
              </Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-[13.5px] font-semibold text-ink-2">Track</span>
                <ChipGroup label="Track" value={d.track} onChange={(v) => set({ track: v })} options={FAMILY_TRACKS} />
              </div>
            </>
          )}
        </EditSheet>
      )}
    </Panel>
  )
}
