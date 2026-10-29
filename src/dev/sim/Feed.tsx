// What happened in the simulation, newest first, filtered by Headlines, Hiring, People, Pay or Everything. It
// keeps the newest 500 events; a phone shows the last 20 until Show more. A screen reader hears the feed only
// when the simulation pauses (the page's live region), never while it plays.
import { memo, useState } from 'react'
import { fmtShort } from '@/lib/dates'
import { Button, ChipGroup, cx, Panel } from '@/ui'
import { useSim } from './client'
import { FEED_FILTERS, type FeedFilter, feedEvents, fmtSimDay } from './helpers'
import type { FeedEvent } from './panelState'
import { useNarrow } from './Tiles'

const PHONE_ROWS = 20

/** A row; `year` shows on the first row and wherever the year changes. */
const Row = memo(function Row({ e, year }: { e: FeedEvent; year: boolean }) {
  return (
    <li className="flex gap-3 border-b border-line py-2 last:border-b-0">
      <time dateTime={e.day} title={fmtSimDay(e.day)} className="num w-[3.75rem] shrink-0 text-[13px] text-ink-3">
        {fmtShort(e.day)}
        {year && <span className="block text-[11.5px]">{e.day.slice(0, 4)}</span>}
      </time>
      <span className={cx('min-w-0 text-[14px]', e.importance === 1 ? 'text-ink' : 'text-ink-2', e.kind === 'situation_skipped' && 'text-warn')}>
        {e.kind === 'situation_skipped' && <span className="font-semibold">Skipped: </span>}
        {e.text}
      </span>
    </li>
  )
})

export function Feed() {
  const events = useSim((s) => s.events)
  const [filter, setFilter] = useState<FeedFilter>('headlines')
  const [more, setMore] = useState(false)
  const narrow = useNarrow()
  const list = feedEvents(events, filter)
  const shown = narrow && !more ? list.slice(0, PHONE_ROWS) : list
  return (
    <Panel title="What happened" actions={<ChipGroup<FeedFilter> label="Show in the feed" size="sm" value={filter} onChange={setFilter} options={FEED_FILTERS} />} bodyClassName="max-h-[560px] overflow-y-auto">
      {shown.length === 0 ? (
        <p className="py-6 text-center text-[14px] text-ink-3">{events.length === 0 ? 'Nothing yet. Press Play or step a day.' : 'Nothing of this kind yet.'}</p>
      ) : (
        <ol aria-label="Events, newest first">
          {shown.map((e, i) => (
            <Row key={e.seq} e={e} year={i === 0 || shown[i - 1].day.slice(0, 4) !== e.day.slice(0, 4)} />
          ))}
        </ol>
      )}
      {narrow && list.length > PHONE_ROWS && (
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => setMore((v) => !v)}>
          {more ? 'Show fewer' : `Show more (${list.length - PHONE_ROWS})`}
        </Button>
      )}
    </Panel>
  )
}
