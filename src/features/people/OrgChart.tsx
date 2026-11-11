// Org chart: a top-down tree of boxes built from managerId, people without a manager on top and each
// manager's reports in a row below them, joined by lines. It stays a keyboard-navigable tree
// (role=tree, nested role=group): Up and Down move through the people in reading order, Right and Left
// expand or collapse, Home and End jump, Enter opens the profile. Planned roles from the headcount plan
// show as dashed boxes; incoming people are marked 'Starts Oct 19'. The chart scrolls sideways inside
// its own frame when it is wider than the screen; the page never does.
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { links, navigate } from '@/app/router'
import { useViewer } from '@/app/useViewer'
import { fullName, onLeave } from '@/domain/people'
import type { PlanSlot } from '@/domain/types'
import { fmtQuarter, fmtShort, today } from '@/lib/dates'
import { useDB } from '@/store/db'
import { Badge, Button, cx, Icon, Kbd, Switch } from '@/ui'
import { allOrgIds, buildOrgTree, type OrgNode, visibleOrgNodes } from './helpers'
import { EmpNo } from './parts'

const SLOT_STATUS: Record<PlanSlot['status'], string> = {
  planned: 'Planned',
  open: 'Hiring now',
  offer: 'Offer stage',
  filled: 'Filled',
  cut: 'Cut',
}

function countDescendants(n: OrgNode): number {
  return n.children.reduce((t, c) => t + 1 + countDescendants(c), 0)
}

/** The line weight shared by every connector, so the bars and the stems meet. */
const LINK = 'ft-orgchart__link pointer-events-none border-line-strong'

export function OrgChart() {
  const db = useDB((s) => s.db)
  const viewer = useViewer()
  const t = today()
  const canPlan = viewer.role !== 'employee'
  const [showPlanned, setShowPlanned] = useState(true)
  const [showContractors, setShowContractors] = useState(false)
  const roots = useMemo(
    () => buildOrgTree(db, t, { planned: canPlan && showPlanned, contractors: showContractors }),
    [db, t, canPlan, showPlanned, showContractors],
  )
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const expanded = useMemo(() => new Set(allOrgIds(roots).filter((id) => !collapsed.has(id))), [roots, collapsed])
  const visible = useMemo(() => visibleOrgNodes(roots, expanded), [roots, expanded])
  const [focusId, setFocusId] = useState<string | null>(null)
  const active = visible.some((v) => v.node.id === focusId) ? focusId : (visible[0]?.node.id ?? null)
  const refs = useRef(new Map<string, HTMLLIElement>())

  const focus = (id: string | undefined) => {
    if (!id) return
    setFocusId(id)
    refs.current.get(id)?.focus()
  }
  const toggle = (id: string, open?: boolean) =>
    setCollapsed((s) => {
      const next = new Set(s)
      const isOpen = !s.has(id)
      const want = open ?? !isOpen
      if (want) next.delete(id)
      else next.add(id)
      return next
    })

  const openNode = (n: OrgNode) => {
    if (n.kind === 'person' && n.person) navigate('person', n.person.id)
    else if ((n.kind === 'contractor' || n.kind === 'advisor') && n.contractor) navigate('contractor', n.contractor.id)
    else if (n.kind === 'planned' && n.slot) {
      const jobId = n.slot.jobId
      const job = jobId ? db.jobs.find((j) => j.id === jobId) : undefined
      if (job && (viewer.role === 'admin' || job.hiringManagerId === viewer.personId)) navigate('job', job.id)
      else if (viewer.role === 'admin') navigate('comp', 'plan')
    }
  }

  const onKey = (e: React.KeyboardEvent, n: OrgNode) => {
    // Nested treeitems: a key on a report must not also act on every manager above it.
    if (e.target !== e.currentTarget) return
    const i = visible.findIndex((v) => v.node.id === n.id)
    const row = visible[i]
    const hasKids = n.children.length > 0
    const isOpen = expanded.has(n.id)
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focus(visible[i + 1]?.node.id)
        break
      case 'ArrowUp':
        e.preventDefault()
        focus(visible[i - 1]?.node.id)
        break
      case 'Home':
        e.preventDefault()
        focus(visible[0]?.node.id)
        break
      case 'End':
        e.preventDefault()
        focus(visible[visible.length - 1]?.node.id)
        break
      case 'ArrowRight':
        e.preventDefault()
        if (hasKids && !isOpen) toggle(n.id, true)
        else if (hasKids) focus(n.children[0]?.id)
        break
      case 'ArrowLeft':
        e.preventDefault()
        if (hasKids && isOpen) toggle(n.id, false)
        else if (row?.parentId) focus(row.parentId)
        break
      case 'Enter':
        e.preventDefault()
        openNode(n)
        break
      case ' ':
        e.preventDefault()
        if (hasKids) toggle(n.id)
        break
    }
  }

  const labelOf = (n: OrgNode) => {
    const p = n.person
    const incoming = !!p && p.startDate > t
    const leave = p ? onLeave(db, p.id, t) : undefined
    return n.kind === 'person' && p
      ? `#${p.hireNumber} ${fullName(p)}, ${p.title}${incoming ? `, starts ${fmtShort(p.startDate)}` : ''}${leave ? ', on leave' : ''}`
      : n.kind === 'planned' && n.slot
        ? `Planned role: ${n.slot.title}, ${fmtQuarter(n.slot.quarter)}, ${SLOT_STATUS[n.slotStatus ?? 'planned']}`
        : n.contractor
          ? `${n.kind === 'advisor' ? 'Advisor' : 'Contractor'}: ${n.contractor.entityName || n.contractor.name}`
          : n.id
  }

  /** One box: the person's number and name, their title, then any badges. */
  const box = (n: OrgNode, hasKids: boolean, isOpen: boolean): ReactNode => {
    const p = n.person
    const incoming = !!p && p.startDate > t
    const leave = p ? onLeave(db, p.id, t) : undefined
    const badges =
      n.kind === 'person' && p ? (
        incoming || leave ? (
          <>
            {incoming && (
              <Badge tone="accent" icon="calendar">
                Starts {fmtShort(p.startDate)}
              </Badge>
            )}
            {leave && <Badge tone="neutral">On leave</Badge>}
          </>
        ) : null
      ) : n.kind === 'planned' && n.slot ? (
        <Badge tone={n.slotStatus === 'open' ? 'accent' : 'outline'}>{SLOT_STATUS[n.slotStatus ?? 'planned']}</Badge>
      ) : n.contractor ? (
        <Badge tone="outline">{n.kind === 'advisor' ? 'Advisor' : 'Contractor'}</Badge>
      ) : null
    return (
      <div
        className={cx(
          'ft-orgnode',
          n.kind === 'planned' ? 'ft-orgnode--planned' : n.kind === 'person' ? 'ft-orgnode--person' : 'ft-orgnode--contractor',
          active === n.id && 'ft-orgnode--active',
          'flex w-48 flex-col items-stretch rounded-md text-center transition-colors',
          n.kind === 'planned'
            ? 'border-2 border-dashed border-line-strong bg-surface'
            : n.kind === 'person'
              ? 'border border-line-strong bg-surface hover:border-ink-3'
              : 'border border-dotted border-line-strong bg-surface-2 hover:border-ink-3',
          active === n.id && 'border-accent',
        )}
      >
        <span className="flex flex-col items-center gap-0.5 px-3 py-2.5">
          {n.kind === 'person' && p ? (
            <>
              <span className="flex flex-wrap items-baseline justify-center gap-x-1.5">
                <EmpNo n={p.hireNumber} />
                <span className="font-semibold text-ink">{fullName(p)}</span>
              </span>
              <span className="text-[13px] text-ink-3">{p.title}</span>
            </>
          ) : n.kind === 'planned' && n.slot ? (
            <>
              <span className="font-semibold text-ink-2">{n.slot.title}</span>
              <span className="text-[13px] text-ink-3">
                Planned for {fmtQuarter(n.slot.quarter)}
                {n.slot.isBackfill ? ', backfill' : ''}
              </span>
            </>
          ) : n.contractor ? (
            <>
              <span className="font-semibold text-ink">{n.contractor.entityName || n.contractor.name}</span>
              <span className="line-clamp-2 text-[13px] text-ink-3">{n.contractor.scope}</span>
            </>
          ) : null}
          {badges && <span className="mt-1 flex flex-wrap justify-center gap-1.5">{badges}</span>}
        </span>
        {hasKids && (
          // The mouse way to open or close a team; the keyboard uses Right and Left on the box itself.
          <span
            aria-hidden
            onClick={(e) => {
              e.stopPropagation()
              setFocusId(n.id)
              toggle(n.id)
            }}
            className="ft-orgnode__toggle flex min-h-10 items-center justify-center gap-1 border-t border-line text-[13px] text-ink-3 hover:bg-surface-2 hover:text-ink"
            title={isOpen ? 'Collapse' : 'Expand'}
          >
            <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={16} />
            {countDescendants(n)} below
          </span>
        )}
      </div>
    )
  }

  /** A row of siblings. Below the top row, each one hangs from a shared bar under its manager. */
  const branch = (list: OrgNode[], level: number, parentId: string | null): ReactNode =>
    list.map((n, idx) => {
      const hasKids = n.children.length > 0
      const isOpen = expanded.has(n.id)
      const label = labelOf(n)
      return (
        <li
          key={n.id}
          ref={(el) => {
            if (el) refs.current.set(n.id, el)
            else refs.current.delete(n.id)
          }}
          role="treeitem"
          aria-level={level}
          aria-setsize={list.length}
          aria-posinset={idx + 1}
          aria-expanded={hasKids ? isOpen : undefined}
          aria-selected={active === n.id}
          aria-label={hasKids ? `${label}, ${countDescendants(n)} below` : label}
          tabIndex={active === n.id ? 0 : -1}
          onKeyDown={(e) => onKey(e, n)}
          onFocus={(e) => {
            if (e.target === e.currentTarget) setFocusId(n.id)
          }}
          onClick={(e) => {
            // Only the box opens a profile: a click in the space around a team does nothing.
            if (!(e.target as Element).closest('.ft-orgnode') || (e.target as Element).closest('[role="treeitem"]') !== e.currentTarget) return
            setFocusId(n.id)
            openNode(n)
          }}
          className={cx('ft-orgchart__item relative flex cursor-pointer flex-col items-center px-2', parentId && 'pt-5')}
        >
          {parentId && (
            <>
              {idx > 0 && <span aria-hidden className={cx(LINK, 'absolute top-0 left-0 w-1/2 border-t-2')} />}
              {idx < list.length - 1 && <span aria-hidden className={cx(LINK, 'absolute top-0 right-0 w-1/2 border-t-2')} />}
              <span aria-hidden className={cx(LINK, 'absolute top-0 left-[calc(50%-1px)] h-5 border-l-2')} />
            </>
          )}
          {box(n, hasKids, isOpen)}
          {hasKids && isOpen && (
            <>
              <span aria-hidden className={cx(LINK, 'block h-5 border-l-2')} />
              <ul role="group" className="flex items-start">
                {branch(n.children, level + 1, n.id)}
              </ul>
            </>
          )}
        </li>
      )
    })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13.5px] text-ink-3">
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> move, <Kbd>→</Kbd> <Kbd>←</Kbd> expand or collapse, <Kbd>Enter</Kbd> opens the profile.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" icon="plus" onClick={() => setCollapsed(new Set())}>
            Expand all
          </Button>
          <Button variant="ghost" size="sm" icon="minus" onClick={() => setCollapsed(new Set(allOrgIds(roots)))}>
            Collapse all
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-6">
        {canPlan && <Switch checked={showPlanned} onChange={setShowPlanned} label="Show planned roles" />}
        <Switch checked={showContractors} onChange={setShowContractors} label="Show contractors and advisors" />
      </div>
      {/* Wider than the screen, the chart scrolls sideways in here; w-max with min-w-full centers a narrow one. */}
      <div className="ft-orgchart overflow-x-auto pb-2">
        <ul role="tree" aria-label="Org chart" className="mx-auto flex w-max min-w-full items-start justify-center gap-6 py-1">
          {branch(roots, 1, null)}
        </ul>
      </div>
      {visible.length === 0 && <p className="text-[14px] text-ink-3">No one to show yet.</p>}
      <p className="text-[13px] text-ink-3">
        Built from each person's manager. Change a manager with Change job or pay on their profile.{' '}
        {viewer.role === 'admin' && (
          <a href={links.comp('plan')} className="-my-2.5 inline-flex min-h-10 items-center font-semibold text-accent hover:underline">
            Planned roles come from the headcount plan.
          </a>
        )}
      </p>
    </div>
  )
}
