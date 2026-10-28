// The SQL of v_integrity_problems: the checks of src/domain/integrity.ts, one SELECT per rule, as rows
// (workspace_id, code, severity, collection, record_id, field, other_id). The rule lists become SQL here
// by the same reading of paths as src/domain/paths.ts; the checks written as code there (CUSTOM_CHECKS)
// are written as SQL below, under the same names. readmodel.test.ts plants every kind of problem and
// compares this view with integrityProblems, so a check changed on one side only fails a test.
import {
  CUSTOM_CHECKS,
  type CustomCheck,
  DATE_RULES,
  type DateRule,
  LINK_RULES,
  type LinkRule,
  LIST_RULES,
  type ListRule,
  REFERENCE_RULES,
  type RefRule,
  UNIQUE_RULES,
  type UniqueRule,
  type When,
} from '../../../src/domain/integrity'
import type { Application, Checklist, CollectionKey, CompRecord, EquitySetup, Interview, Job, Offer, Person } from '../../../src/domain/types'
import { F, lit, table, textAt } from './columns'

type Compiled = { joins: string[]; value: string }

/**
 * A path read from `base` (a jsonb expression): the lateral joins its list steps need and the text of
 * its value, NULL when empty. A list step on something that is not a list gives no rows (ft_array).
 */
function compilePath(base: string, path: string, alias: string): Compiled {
  const segments = path.split('.')
  const joins: string[] = []
  let current = base
  let value = ''
  segments.forEach((segment, i) => {
    const list = segment.endsWith('[]')
    const name = list ? segment.slice(0, -2) : segment
    const last = i === segments.length - 1
    if (list) {
      const a = `${alias}${i}`
      joins.push(`jsonb_array_elements(ft_array(${current} -> ${lit(name)})) AS ${a}(el)`)
      current = `${a}.el`
      if (last) value = `NULLIF(${current} #>> '{}', '')`
    } else if (last) {
      value = `NULLIF(${current} ->> ${lit(name)}, '')`
    } else {
      current = `(${current} -> ${lit(name)})`
    }
  })
  return { joins, value }
}

/** A path without list steps, as text, NULL when empty. */
function scalar(base: string, path: string): string {
  return `NULLIF(${textAt(base, path)}, '')`
}

function laterals(joins: string[]): string {
  return joins.map((j) => `\n   CROSS JOIN LATERAL ${j}`).join('')
}

/** A FROM clause over lateral joins, for an EXISTS subquery ('' when there are none). */
function fromJoins(joins: string[]): string {
  return joins.length ? ` FROM ${joins.join(' CROSS JOIN LATERAL ')}` : ''
}

function when(base: string, w: When | undefined): string {
  return w ? `\n     AND ${scalar(base, w.field)} IN (${w.in.map(lit).join(', ')})` : ''
}

function select(ws: string, code: string, severity: string, collection: string, recordId: string, field: string, otherId: string): string {
  return `  SELECT ${ws}, ${lit(code)}, ${lit(severity)}, ${lit(collection)}, ${recordId}, ${lit(field)}, ${otherId}`
}

const exists = (collection: CollectionKey, id: string) => `EXISTS (SELECT 1 FROM ${table(collection)} t WHERE t.workspace_id = r.workspace_id AND t.id = ${id})`

function refSql(rule: RefRule): string[] {
  const p = compilePath('r.data', rule.path, 'e')
  const from = `\n    FROM ${table(rule.from)} r${laterals(p.joins)}\n   CROSS JOIN LATERAL (SELECT ${p.value} AS v) x`
  const missing = `NOT (${rule.to.map((t) => exists(t, 'x.v')).join(' OR ')})`
  const out = [
    `${select('r.workspace_id', 'broken_reference', rule.severity, rule.from, 'r.id', rule.path, 'x.v')}${from}\n   WHERE ${
      rule.required ? `(x.v IS NULL OR ${missing})` : `x.v IS NOT NULL AND ${missing}`
    }${when('r.data', rule.when)}`,
  ]
  if (rule.notSelf) {
    out.push(`${select('r.workspace_id', 'self_reference', rule.severity, rule.from, 'r.id', rule.path, 'x.v')}${from}\n   WHERE x.v = r.id${when('r.data', rule.when)}`)
  }
  return out
}

function listSql(rule: ListRule): string {
  const p = compilePath('r.data', rule.path, 'e')
  const parentBase = rule.parent ? 'p.data' : 'r.data'
  const join = rule.parent ? `\n    JOIN ${table(rule.parent.target)} p ON p.workspace_id = r.workspace_id AND p.id = ${scalar('r.data', rule.parent.via)}` : ''
  const l = compilePath(parentBase, rule.list, 'l')
  return `${select('r.workspace_id', rule.code, rule.severity, rule.from, 'r.id', rule.path, 'x.v')}
    FROM ${table(rule.from)} r${join}${laterals(p.joins)}
   CROSS JOIN LATERAL (SELECT ${p.value} AS v) x
   WHERE x.v IS NOT NULL
     AND NOT EXISTS (SELECT 1${fromJoins(l.joins)} WHERE ${l.value} = x.v)`
}

function linkSql(rule: LinkRule): string {
  return `${select('r.workspace_id', 'mismatched_link', rule.severity, rule.from, 'r.id', `${rule.via}.${rule.theirs}`, 't.id')}
    FROM ${table(rule.from)} r
    JOIN ${table(rule.target)} t ON t.workspace_id = r.workspace_id AND t.id = ${scalar('r.data', rule.via)}
   WHERE ${scalar('r.data', rule.mine)} IS DISTINCT FROM ${scalar('t.data', rule.theirs)}`
}

function dateSql(rule: DateRule): string {
  const unless = rule.unlessSame
    ? `\n     AND NOT coalesce(ft_as_date(${textAt('r.data', rule.unlessSame[0])}) = ft_as_date(${textAt('r.data', rule.unlessSame[1])}), false)`
    : ''
  return `${select('r.workspace_id', 'date_order', rule.severity, rule.from, 'r.id', `${rule.first}>${rule.then}`, 'NULL')}
    FROM ${table(rule.from)} r
   WHERE ft_as_date(${textAt('r.data', rule.first)}) > ft_as_date(${textAt('r.data', rule.then)})${unless}`
}

function uniqueSql(rule: UniqueRule): string {
  const v = scalar('r.data', rule.path)
  return `${select('d.workspace_id', 'duplicate_value', rule.severity, rule.from, 'd.id', rule.path, 'd.first_id')}
    FROM (SELECT r.workspace_id, r.id, first_value(r.id) OVER (PARTITION BY r.workspace_id, x.v ORDER BY r.id COLLATE "C") AS first_id
            FROM ${table(rule.from)} r
           CROSS JOIN LATERAL (SELECT ${rule.lower ? `lower(${v})` : v} AS v) x
           WHERE x.v IS NOT NULL${when('r.data', rule.when).replace(/\n {5}/, '\n             ')}) d
   WHERE d.id <> d.first_id`
}

const A = F<Application>()
const C = F<CompRecord>()
const K = F<Checklist>()
const I = F<Interview>()
const J = F<Job>()
const O = F<Offer>()
const P = F<Person>()
const E = F<EquitySetup>()

/** The checks src/domain/integrity.ts writes as code, as SQL. */
const CUSTOM_SQL: Record<CustomCheck, string[]> = {
  stage_history: [
    `${select('r.workspace_id', 'stage_history_mismatch', 'failure', 'applications', 'r.id', 'stageId', `NULLIF((ft_array(r.data -> ${A('history')}) -> -1) ->> 'stageId', '')`)}
    FROM applications r
   WHERE jsonb_array_length(ft_array(r.data -> ${A('history')})) > 0
     AND NULLIF((ft_array(r.data -> ${A('history')}) -> -1) ->> 'stageId', '') IS DISTINCT FROM NULLIF(r.data ->> ${A('stageId')}, '')`,
  ],
  history_order: [
    `${select('r.workspace_id', 'history_out_of_order', 'failure', 'applications', 'r.id', 'history[].at', 'NULL')}
    FROM applications r
   CROSS JOIN LATERAL (SELECT ft_as_date(h.el ->> 'at') AS at, lag(ft_as_date(h.el ->> 'at')) OVER (ORDER BY h.n) AS prev
                         FROM jsonb_array_elements(ft_array(r.data -> ${A('history')})) WITH ORDINALITY AS h(el, n)) s
   WHERE s.at < s.prev`,
  ],
  hire: [
    `${select('a.workspace_id', 'hire_missing_offer', 'note', 'applications', 'a.id', 'offers', 'NULL')}
    FROM applications a
   WHERE a.data ->> ${A('status')} = 'hired'
     AND NOT EXISTS (SELECT 1 FROM offers o WHERE o.workspace_id = a.workspace_id AND o.data ->> ${O('applicationId')} = a.id AND o.data ->> ${O('status')} = 'accepted')`,
    `${select('a.workspace_id', 'hire_missing_person', 'failure', 'applications', 'a.id', 'people', 'NULL')}
    FROM applications a
   WHERE a.data ->> ${A('status')} = 'hired'
     AND NOT EXISTS (SELECT 1 FROM people p WHERE p.workspace_id = a.workspace_id AND p.data ->> ${P('fromApplicationId')} = a.id)`,
    `${select('a.workspace_id', 'hire_missing_comp', 'failure', 'applications', 'a.id', 'comp', 'p.id')}
    FROM applications a
    JOIN people p ON p.workspace_id = a.workspace_id AND p.data ->> ${P('fromApplicationId')} = a.id
   WHERE a.data ->> ${A('status')} = 'hired'
     AND NOT EXISTS (SELECT 1 FROM comp c WHERE c.workspace_id = p.workspace_id AND c.data ->> ${C('personId')} = p.id AND c.data ->> ${C('reason')} = 'hire')`,
    `${select('a.workspace_id', 'hire_missing_checklist', 'note', 'applications', 'a.id', 'checklists', 'p.id')}
    FROM applications a
    JOIN people p ON p.workspace_id = a.workspace_id AND p.data ->> ${P('fromApplicationId')} = a.id
   WHERE a.data ->> ${A('status')} = 'hired'
     AND NOT EXISTS (SELECT 1 FROM checklists c WHERE c.workspace_id = p.workspace_id AND c.data ->> ${K('personId')} = p.id AND c.data ->> ${K('kind')} = 'onboarding')`,
  ],
  interview_step: [
    `${select('i.workspace_id', 'unknown_step', 'note', 'interviews', 'i.id', 'stepId', `NULLIF(i.data ->> ${I('stepId')}, '')`)}
    FROM interviews i
    JOIN applications a ON a.workspace_id = i.workspace_id AND a.id = NULLIF(i.data ->> ${I('applicationId')}, '')
    JOIN jobs j ON j.workspace_id = a.workspace_id AND j.id = NULLIF(a.data ->> ${A('jobId')}, '')
   WHERE NULLIF(i.data ->> ${I('stepId')}, '') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(ft_array(j.data -> ${J('interviewPlan')})) AS s(el) WHERE s.el ->> 'id' = i.data ->> ${I('stepId')})`,
  ],
  compliance_owner: [
    `${select('d.workspace_id', 'broken_reference', 'failure', 'complianceStatus', 'e.key', 'ownerId', `NULLIF(e.value ->> 'ownerId', '')`)}
    FROM workspace_docs d
   CROSS JOIN LATERAL jsonb_each(ft_object(d.data)) AS e(key, value)
   WHERE d.key = 'complianceStatus'
     AND NULLIF(e.value ->> 'ownerId', '') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM people p WHERE p.workspace_id = d.workspace_id AND p.id = NULLIF(e.value ->> 'ownerId', ''))`,
  ],
  activity_equity: [
    `${select('r.workspace_id', 'broken_reference', 'note', 'activity', 'r.id', 'entityId', 'x.v')}
    FROM activity r
   CROSS JOIN LATERAL (SELECT NULLIF(r.data ->> 'entityId', '') AS v) x
   WHERE r.data ->> 'entityType' = 'equity'
     AND (x.v IS NULL OR (x.v <> 'equity' AND NOT ${exists('grants', 'x.v')} AND NOT ${exists('people', 'x.v')} AND NOT ${exists('contractors', 'x.v')}
          AND NOT EXISTS (SELECT 1 FROM workspace_docs d CROSS JOIN LATERAL jsonb_array_elements(ft_array(d.data -> ${E('valuations')}) || ft_array(d.data -> ${E('poolIncreases')})) AS s(el)
                           WHERE d.workspace_id = r.workspace_id AND d.key = 'equity' AND s.el ->> 'id' = x.v)))`,
  ],
  manager_leaving: [
    `${select('p.workspace_id', 'manager_leaving', 'note', 'people', 'p.id', 'managerId', 'm.id')}
    FROM people p
    JOIN people m ON m.workspace_id = p.workspace_id AND m.id = NULLIF(p.data ->> ${P('managerId')}, '') AND m.id <> p.id
   WHERE ft_as_date(m.data ->> ${P('endDate')}) IS NOT NULL
     AND (ft_as_date(p.data ->> ${P('endDate')}) IS NULL OR ft_as_date(p.data ->> ${P('endDate')}) > ft_as_date(m.data ->> ${P('endDate')}))`,
  ],
}

/** The body of v_integrity_problems. */
export function integrityViewSql(): string {
  for (const name of CUSTOM_CHECKS) if (!CUSTOM_SQL[name]?.length) throw new Error(`No SQL for the integrity check ${name} (server/src/readmodel/integritySql.ts)`)
  const parts = [
    ...REFERENCE_RULES.flatMap(refSql),
    ...LIST_RULES.map(listSql),
    ...LINK_RULES.map(linkSql),
    ...DATE_RULES.map(dateSql),
    ...UNIQUE_RULES.map(uniqueSql),
    ...CUSTOM_CHECKS.flatMap((name) => CUSTOM_SQL[name]),
  ]
  // UNION (not UNION ALL) reports each problem once, as integrityProblems does.
  return `SELECT p.workspace_id, p.code, p.severity, p.collection, p.record_id, p.field, p.other_id
  FROM (
${parts.join('\n  UNION\n')}
  ) AS p (workspace_id, code, severity, collection, record_id, field, other_id)`
}
