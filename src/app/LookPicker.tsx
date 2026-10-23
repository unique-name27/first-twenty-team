// The Look section of the Display menu: one card per look (docs/LOOKS.md). Each card shows a small
// sample of the real kit inside a wrapper that carries that look's data-look, so it is the actual skin.
import { useId } from 'react'
import { usePrefs } from '@/store/prefs'
import { LOOK_LIST, LOOKS, type LookId } from '@/themes/registry'
import { Badge, buttonClass, cx, DataTable, Icon, Panel, rovingKeyDown, rovingTabIndex } from '@/ui'

type SampleRow = { id: string; name: string; stage: string }
const SAMPLE_ROWS: SampleRow[] = [
  { id: 'r1', name: 'Priya Nair', stage: 'Onsite' },
  { id: 'r2', name: 'Marcus Lee', stage: 'Offer' },
]

/**
 * A fixed mini mockup (title, two buttons, a badge, a two-row table) in the given look. Drawn at full
 * size and scaled to half, hidden from assistive tech and inert (it is a picture of the look).
 */
export function LookPreview({ look, className }: { look: LookId; className?: string }) {
  const theme = usePrefs((s) => s.theme)
  // A look with light and dark follows the app's Theme setting, so the card matches what you would get.
  const forced = LOOKS[look].supportsDark && theme !== 'system' ? theme : undefined
  return (
    <div
      aria-hidden
      inert
      data-look={look}
      data-theme={forced}
      className={cx('ft-lookpreview pointer-events-none relative h-[140px] overflow-hidden select-none', className)}
    >
      <div className="absolute top-0 left-0 w-[200%] origin-top-left scale-50 p-4">
        <Panel title="Open roles" actions={<Badge tone="good" icon="check">On track</Badge>}>
          {/* Spans with the Button's hooks, not buttons: the card itself is the control (no nested buttons). */}
          <div className="mb-3 flex gap-2">
            <span className={buttonClass('primary', 'sm')}>
              <Icon name="plus" size={16} className="ft-btn__icon shrink-0" />
              Add candidate
            </span>
            <span className={buttonClass('secondary', 'sm')}>Export</span>
          </div>
          <DataTable<SampleRow>
            dense
            rows={SAMPLE_ROWS}
            rowKey={(r) => r.id}
            columns={[
              { key: 'name', header: 'Name', cell: (r) => r.name },
              { key: 'stage', header: 'Stage', cell: (r) => r.stage },
            ]}
          />
        </Panel>
      </div>
    </div>
  )
}

/** Radio group of look cards: one Tab stop, arrows move and pick, Space or Enter picks. */
export function LookPicker() {
  const look = usePrefs((s) => s.look)
  const setLook = usePrefs((s) => s.setLook)
  const uid = useId().replace(/:/g, '')
  const states = LOOK_LIST.map((l) => ({ on: l.id === look }))
  return (
    <div
      role="radiogroup"
      aria-label="Look"
      onKeyDown={(e) => rovingKeyDown(e, { select: true })}
      className="ft-lookpicker grid grid-cols-1 gap-2.5 sm:grid-cols-2"
    >
      {LOOK_LIST.map((l, i) => {
        const on = l.id === look
        const nameId = `look-${uid}-${l.id}-name`
        const blurbId = `look-${uid}-${l.id}-blurb`
        return (
          <div
            key={l.id}
            role="radio"
            aria-checked={on}
            aria-labelledby={nameId}
            aria-describedby={blurbId}
            tabIndex={rovingTabIndex(i, states)}
            onClick={() => setLook(l.id)}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault()
                setLook(l.id)
              }
            }}
            className={cx(
              'ft-lookcard',
              on && 'ft-lookcard--on',
              '@container min-h-11 min-w-0 cursor-pointer overflow-hidden rounded-xl border bg-surface text-left transition-colors',
              on ? 'border-accent ring-2 ring-accent' : 'border-line-strong hover:border-ink-3',
            )}
          >
            {/* A wide single card (a phone at 100% text) puts the preview beside the words, so the four
                cards fit without a long scroll; narrower cards stack them. */}
            <div className="flex h-full flex-col @[18rem]:@max-[30rem]:flex-row">
              <LookPreview
                look={l.id}
                className="border-b border-line @[18rem]:@max-[30rem]:h-auto @[18rem]:@max-[30rem]:min-h-[104px] @[18rem]:@max-[30rem]:w-[46%] @[18rem]:@max-[30rem]:shrink-0 @[18rem]:@max-[30rem]:border-r @[18rem]:@max-[30rem]:border-b-0"
              />
              <div className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div id={nameId} className="ft-lookcard__name text-[14.5px] leading-snug font-bold text-ink">
                    {l.name}
                  </div>
                  <div id={blurbId} className="ft-lookcard__blurb mt-0.5 text-[12.5px] leading-snug text-ink-3">
                    {l.blurb}
                  </div>
                </div>
                {on && <Icon name="check" size={18} strokeWidth={2.6} className="ft-lookcard__check mt-0.5 shrink-0 text-accent" />}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
