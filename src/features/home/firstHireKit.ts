// First hire kit: what California expects from employer #1 (docs/SPEC.md, SOLO FOUNDER TO FIRST HIRE).
// Shown on Home while W-2 headcount is 1, including while the first hire is pre-start. Each item has a why and an official link; done
// toggles live in db.complianceStatus (rule ids for items that are compliance rules, 'kit-*' keys for the
// rest) so the Compliance section and Home never disagree. Pure apart from the draft mutation helper.
import type { Draft } from 'immer'
import { links } from '@/app/router'
import { evaluateRule, RULE_BY_ID } from '@/domain/compliance'
import { setRuleActionDone, setRuleStatus } from '@/domain/compliance/actions'
import { fullName, incomingOn } from '@/domain/people'
import type { DB, Person } from '@/domain/types'
import { fmtDay, type ISODate } from '@/lib/dates'
import { logActivity } from '@/store/draft'

export type KitItem = {
  key: string
  /** Compliance rule id when the item is a rule (done = the rule is done). */
  ruleId?: string
  title: string
  why: string
  /** Official source or where to do it. */
  link: { label: string; url: string }
  /** Where in the app the item gets done ('Open Comp and plan > Equity'). */
  go?: { label: string; href: string }
  done: boolean
  doneOn?: ISODate
  /** Done because the data already shows it (a payroll link, a 409A on file). Cannot be unticked here. */
  onFile?: string
  /** When an open item is needed by, once a first hire is on the way ('Before Sam Rivera starts Mon Oct 26'). */
  neededBy?: string
  /** The rule's own due date on an open item ('Due about Tue, Nov 17 (estimated)'), so it never turns up overdue later. */
  due?: { text: string; estimated: boolean }
}

/** Items that must be in place before the first non-owner employee starts work. */
const BEFORE_FIRST_START = new Set(['workers-comp', 'kit-payroll', 'kit-templates'])

/** The first hire on the way while the founder is still the only employee (start date after the date). */
export function firstHireStarting(db: DB, date: ISODate): Person | undefined {
  return incomingOn(db, date).find((p) => !p.isFounder)
}

type KitDef = {
  key: string
  ruleId?: string
  /**
   * The rule steps this item stands for: it is done once they are (recorded on the Compliance card or
   * found in Settings), even while later steps of the rule stay open.
   */
  actionIds?: string[]
  /** What the saved data that completes those steps is, for the 'on file' badge. */
  onFileText?: string
  title: string
  why: string
  link?: { label: string; url: string }
  go?: { label: string; href: string }
  /** Detects completion from data. */
  onFile?: (db: DB) => string | undefined
}

const BPC_16600 = {
  label: 'Business and Professions Code 16600',
  url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=BPC&sectionNum=16600.',
}

const KIT: KitDef[] = [
  {
    key: 'edd-registration',
    ruleId: 'edd-registration',
    actionIds: ['register'],
    onFileText: 'EDD account number saved in Settings',
    title: 'Register with EDD as an employer (DE 1)',
    why: 'File the DE 1 within 15 days of first paying more than $100 in wages in a quarter, even if the only W-2 employee is you.',
  },
  {
    key: 'workers-comp',
    ruleId: 'workers-comp',
    actionIds: ['bind-policy'],
    onFileText: 'Policy number saved in Settings',
    title: "Get workers' comp insurance",
    why: 'Required before your first non-owner employee starts work. Owner-officers can usually exclude themselves.',
  },
  {
    key: 'iipp',
    ruleId: 'iipp',
    title: 'Write your Injury and Illness Prevention Program (IIPP)',
    why: 'Every California employer needs a written IIPP that names the person who runs it.',
  },
  {
    key: 'paid-sick-leave',
    ruleId: 'paid-sick-leave',
    title: 'Set a paid sick leave policy',
    why: 'California requires at least 40 hours or 5 days a year from the first employee. The default here front-loads 40 hours each January 1 and at hire.',
  },
  {
    key: 'posters-federal',
    ruleId: 'posters-federal',
    title: 'Put up the federal workplace posters',
    why: 'Post the federal notices where staff can see them and share electronic copies with anyone remote.',
  },
  {
    key: 'posters-california',
    ruleId: 'posters-california',
    title: 'Put up the California workplace posters',
    why: 'The state notices change most Januaries, so check them each year.',
  },
  {
    key: 'posters-san-jose',
    ruleId: 'posters-san-jose',
    title: 'Put up the San Jose minimum wage bulletin',
    why: 'San Jose requires its own minimum wage notice at workplaces in the city.',
  },
  {
    key: 'kit-payroll',
    title: 'Choose a payroll provider or PEO',
    why: 'It runs payroll, withholds and files taxes, and files the DE 34 new hire report. Save its link in Settings so tasks can point to it.',
    onFile: (db) => (db.company.payrollProvider.url?.trim() || db.company.linkOuts.payroll?.trim() ? 'Link saved in Settings' : undefined),
  },
  {
    key: 'kit-templates',
    title: 'Have counsel review your offer letter and PIIA templates',
    why: 'California voids noncompetes, offer letters should use California law and venue (Labor Code 925), and the PIIA needs the Labor Code 2870 notice.',
    link: BPC_16600,
  },
  {
    key: 'kit-409a',
    title: 'Set up the option pool and get your first 409A',
    why: 'The board approves the pool, and a 409A valuation sets the strike price before the first grant. The California 25102(o) notice is due within 30 days of the first grant.',
    // Start fresh fills in placeholder cap table numbers: the item is done once they are confirmed and a 409A is recorded.
    link: { label: 'Corporations Code 25102(o)', url: 'https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=25102.&lawCode=CORP' },
    go: { label: 'Open Comp and plan > Equity', href: links.comp('equity') },
    onFile: (db) => (db.equity.valuations.length && db.equity.capTableConfirmedOn ? '409A and cap table on file' : undefined),
  },
]

/** The kit for a workspace on a date. Items whose rule does not apply here (no San Jose site) are left out. */
export function firstHireKit(db: DB, date: ISODate): KitItem[] {
  const out: KitItem[] = []
  const starting = firstHireStarting(db, date)
  for (const def of KIT) {
    const rule = def.ruleId ? RULE_BY_ID[def.ruleId] : undefined
    let done = false
    let doneOn: ISODate | undefined
    let onFile: string | undefined
    let link = def.link
    let due: KitItem['due']
    if (rule) {
      const res = evaluateRule(db, rule, date)
      if (res.state === 'not_applicable' && res.status?.status !== 'not_applicable') continue
      const steps = def.actionIds ?? []
      const stepsDone = steps.length > 0 && steps.every((id) => !!res.actionsDone[id])
      done = res.state === 'done' || res.status?.status === 'done' || res.status?.status === 'not_applicable' || stepsDone
      doneOn = res.status?.doneOn ?? (stepsDone ? steps.map((id) => res.actionsDone[id]).sort().pop() : undefined)
      // Saved data (an EDD account number, a policy number) did it: the box cannot be unticked here.
      if (stepsDone && res.status?.status !== 'done' && steps.every((id) => res.onFile.includes(id))) onFile = def.onFileText
      // The DE 1 clock shows on the kit item while it is open, so it never first appears as overdue.
      if (!done && res.dueOn) {
        // A filing due on a weekend or company holiday names the business day before to file by, as the DE 34 does.
        const fileBy = res.fileBy && res.dueOn >= date ? `, file by ${fmtDay(res.fileBy)}` : ''
        due = res.dueEstimated
          ? { text: `Due about ${fmtDay(res.dueOn)} (estimated)`, estimated: true }
          : { text: `${res.dueOn < date ? 'Was due' : 'Due'} ${fmtDay(res.dueOn)}${fileBy}`, estimated: false }
      }
      link = link ?? { label: rule.citation.label, url: rule.citation.url }
    } else {
      const status = db.complianceStatus[def.key]
      onFile = def.onFile?.(db)
      done = !!onFile || status?.status === 'done'
      doneOn = status?.doneOn
    }
    out.push({
      key: def.key,
      ...(def.ruleId ? { ruleId: def.ruleId } : {}),
      title: def.title,
      why: def.why,
      link: link ?? { label: 'Official source', url: 'https://www.dir.ca.gov/' },
      ...(def.go ? { go: def.go } : {}),
      done,
      ...(doneOn ? { doneOn } : {}),
      ...(onFile ? { onFile } : {}),
      ...(starting && !done && BEFORE_FIRST_START.has(def.key) ? { neededBy: `Before ${fullName(starting)} starts ${fmtDay(starting.startDate)}` } : {}),
      ...(due ? { due } : {}),
    })
  }
  return out
}

export function kitProgress(items: KitItem[]): { done: number; total: number } {
  return { done: items.filter((i) => i.done).length, total: items.length }
}

/**
 * Ticks or unticks a kit item. Rule items use the compliance status so the Compliance cards agree; an item
 * that stands for some steps of its rule (workers' comp: bind the policy) ticks those steps, not the rule.
 */
export function setKitItemDone(draft: Draft<DB>, item: Pick<KitItem, 'key' | 'ruleId' | 'title'>, done: boolean, date: ISODate): void {
  if (item.ruleId) {
    const steps = KIT.find((d) => d.key === item.key)?.actionIds ?? []
    if (!steps.length) {
      setRuleStatus(draft, item.ruleId, done ? 'done' : null, date)
      return
    }
    const recorded = draft.complianceStatus[item.ruleId]?.actionsDone ?? {}
    for (const id of steps) {
      if (done ? !recorded[id] : !!recorded[id]) setRuleActionDone(draft, item.ruleId, id, done ? date : null)
    }
    if (!done && draft.complianceStatus[item.ruleId]?.status === 'done') setRuleStatus(draft, item.ruleId, null, date)
    return
  }
  if (done) draft.complianceStatus[item.key] = { ...(draft.complianceStatus[item.key] ?? {}), status: 'done', doneOn: date }
  else delete draft.complianceStatus[item.key]
  logActivity(draft, {
    entityType: 'compliance',
    entityId: item.key,
    kind: 'kit_item',
    text: done ? `Marked done: ${item.title}` : `Reopened: ${item.title}`,
  })
}
