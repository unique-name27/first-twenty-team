import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { cx } from './cx'
import { Icon } from './Icon'

export type Column<T> = {
  key: string
  header: ReactNode
  /** Cell renderer. */
  cell: (row: T) => ReactNode
  /** Value used for sorting; omit to make the column unsortable. */
  sort?: (row: T) => string | number | null | undefined
  align?: 'left' | 'right' | 'center'
  /** Tailwind width class, e.g. 'w-40'. */
  width?: string
  /** Hide below this breakpoint to keep phone tables narrow. */
  hideBelow?: 'sm' | 'md' | 'lg'
}

/**
 * Data table with optional sorting and row click. Wraps in its own horizontal scroller
 * so wide tables never push the page sideways.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  rowHref,
  empty,
  initialSort,
  dense,
  caption,
  rowClassName,
  rowLabel,
}: {
  rows: T[]
  columns: Array<Column<T>>
  rowKey: (row: T) => string
  /**
   * Opens the row (a sheet, a dialog). The whole row takes the click, and the first cell becomes a button
   * (ft-table__rowlink, as a row link is), so the row opens from the keyboard too. Name it with rowLabel.
   */
  onRowClick?: (row: T) => void
  /** The accessible name of the row's button when onRowClick opens it ('Edit the 409A from Mar 20, 2026'). */
  rowLabel?: (row: T) => string
  /** Makes each row a link (preferred over onRowClick for navigation). */
  rowHref?: (row: T) => string
  empty?: ReactNode
  initialSort?: { key: string; dir: 'asc' | 'desc' }
  dense?: boolean
  caption?: string
  rowClassName?: (row: T) => string | undefined
}) {
  const [sort, setSort] = useState(initialSort)
  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col?.sort) return rows
    const get = col.sort
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const va = get(a)
      const vb = get(b)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir
    })
  }, [rows, columns, sort])

  if (rows.length === 0 && empty) return <>{empty}</>

  const hide = (h?: Column<T>['hideBelow']) =>
    h === 'sm' ? 'hidden sm:table-cell' : h === 'md' ? 'hidden md:table-cell' : h === 'lg' ? 'hidden lg:table-cell' : ''
  const pad = dense ? 'px-3 py-2' : 'px-4 py-3'
  const clickable = Boolean(onRowClick || rowHref)

  return (
    <div className="ft-table-wrap scroll-thin relative -mx-px overflow-x-auto">
      <table className={cx('ft-table', dense && 'ft-table--dense', 'w-full border-collapse text-left text-[14px]')}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="ft-table__head">
          <tr className="ft-table__headrow border-b border-line">
            {columns.map((c) => {
              const active = sort?.key === c.key
              const align = c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={cx(
                    'ft-table__th h-10 bg-surface-2/60 text-[12.5px] font-bold whitespace-nowrap text-ink-3',
                    dense ? 'px-3' : 'px-4',
                    align,
                    c.width,
                    hide(c.hideBelow),
                  )}
                >
                  {c.sort ? (
                    <button
                      type="button"
                      className={cx('ft-table__sort inline-flex h-10 items-center gap-1 hover:text-ink', active && 'ft-table__sort--active text-ink')}
                      onClick={() =>
                        setSort((s) =>
                          s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'asc' },
                        )
                      }
                    >
                      {c.header}
                      <Icon
                        name={active && sort?.dir === 'desc' ? 'chevron-down' : 'chevron-up'}
                        size={13}
                        className={active ? 'opacity-100' : 'opacity-30'}
                      />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const href = rowHref?.(row)
            return (
              <tr
                key={rowKey(row)}
                className={cx(
                  'ft-table__row',
                  clickable && 'ft-table__row--link',
                  'border-b border-line last:border-b-0',
                  clickable && 'cursor-pointer hover:bg-surface-2/70',
                  rowClassName?.(row),
                )}
                onClick={
                  clickable
                    ? (e) => {
                        if ((e.target as HTMLElement).closest('a,button,input,select,textarea,label')) return
                        if (href) window.location.hash = href.replace(/^#/, '')
                        else onRowClick?.(row)
                      }
                    : undefined
                }
              >
                {columns.map((c, i) => {
                  const align = c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'
                  const content = c.cell(row)
                  return (
                    <td key={c.key} className={cx('ft-table__cell', pad, 'align-middle text-ink', align, c.width, hide(c.hideBelow))}>
                      {i === 0 && href ? (
                        <a href={href} className="ft-table__rowlink font-semibold text-ink hover:text-accent">
                          {content}
                        </a>
                      ) : i === 0 && onRowClick ? (
                        <button
                          type="button"
                          aria-label={rowLabel?.(row)}
                          onClick={() => onRowClick(row)}
                          className="ft-table__rowlink block min-h-10 w-full text-left font-semibold text-ink hover:text-accent"
                        >
                          {content}
                        </button>
                      ) : (
                        content
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
