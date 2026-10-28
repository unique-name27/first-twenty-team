// Field paths into the record types of src/domain/types.ts, checked by TypeScript: 'title', 'nextStep.dueOn',
// 'tasks[].assigneeId'. A segment ending in [] steps into every item of a list. The integrity checker
// (./integrity.ts) and the server's read model (server/src/readmodel) name fields this way, so a misspelled
// or renamed field fails the typecheck instead of quietly reading nothing.
//
// valuesAt reads a path the way Postgres reads the same path out of a jsonb column: a step into something
// that is not an object gives no value (SQL NULL), a list step into something that is not a list gives no
// items, and textOf turns a value into the text that ->> returns.

type Depth = [never, 0, 1, 2, 3]

/** Dotted paths into T through objects only (never into a list) whose value is V, or V | null | undefined. */
export type PathTo<T, V, D extends number = 3> = [D] extends [never]
  ? never
  : T extends object
    ? {
        [K in keyof T & string]-?:
          | (NonNullable<T[K]> extends V ? K : never)
          | (NonNullable<T[K]> extends readonly unknown[] ? never : NonNullable<T[K]> extends object ? `${K}.${PathTo<NonNullable<T[K]>, V, Depth[D]>}` : never)
      }[keyof T & string]
    : never

/** Paths into T that end at an id (a string), stepping into lists with []: 'panelIds[]', 'interviewPlan[].interviewerIds[]'. */
export type IdPath<T, D extends number = 3> = [D] extends [never]
  ? never
  : {
      [K in keyof T & string]-?: NonNullable<T[K]> extends string
        ? K
        : NonNullable<T[K]> extends readonly (infer E)[]
          ? NonNullable<E> extends string
            ? `${K}[]`
            : NonNullable<E> extends object
              ? `${K}[].${IdPath<NonNullable<E>, Depth[D]>}`
              : never
          : NonNullable<T[K]> extends object
            ? `${K}.${IdPath<NonNullable<T[K]>, Depth[D]>}`
            : never
    }[keyof T & string]

/** The type at a dotted path (objects only), for PathTo paths. */
export type PathValue<T, P extends string> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T
    ? PathValue<NonNullable<T[K]>, Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never

/** The item type of a list type. */
export type ItemOf<L> = NonNullable<L> extends readonly (infer E)[] ? E : never

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Every value at a path. A plain step gives one value per value it starts from (undefined when the field
 * is missing or the parent is not an object), a list step gives the list's items (none when it is not a list).
 */
export function valuesAt(start: unknown, path: string): unknown[] {
  let current: unknown[] = [start]
  for (const segment of path.split('.')) {
    const list = segment.endsWith('[]')
    const name = list ? segment.slice(0, -2) : segment
    const next: unknown[] = []
    for (const v of current) {
      const child = isObject(v) ? v[name] : undefined
      if (!list) next.push(child)
      else if (Array.isArray(child)) next.push(...child)
    }
    current = next
  }
  return current
}

/** The one value at a path that has no list step. */
export function valueAt(start: unknown, path: string): unknown {
  return valuesAt(start, path)[0]
}

/** A value as the text Postgres's ->> gives for it; null for null, undefined and the empty string. */
export function textOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** Days in each month of a common year. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * A 'YYYY-MM-DD' text that names a real day, else null (empty, junk, or a day such as Feb 30). The
 * read model's ft_as_date gives the same answer for every text, so date checks agree in SQL and here.
 */
export function asDate(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const y = Number(v.slice(0, 4))
  const m = Number(v.slice(5, 7))
  const d = Number(v.slice(8, 10))
  if (y < 1 || m < 1 || m > 12) return null
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const last = m === 2 && leap ? 29 : MONTH_DAYS[m - 1]
  return d >= 1 && d <= last ? v : null
}
