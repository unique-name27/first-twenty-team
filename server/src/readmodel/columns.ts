// Building blocks for the read model's SQL (spec.ts says what the views show; generate.ts writes them).
// Fields<T> reads typed paths out of a jsonb expression, so every field a view names is checked against
// src/domain/types.ts by TypeScript. Every value goes through a guarded cast (ft_as_date, ft_as_num, ...),
// which gives NULL for text that is not a value of that type instead of failing the whole query.
import type { ItemOf, PathTo, PathValue } from '../../../src/domain/paths'
import type { CollectionKey, DB } from '../../../src/domain/types'
import { isRecordCollection, tableName } from '../../../src/sync/collections'

export type Row<K extends CollectionKey> = DB[K][number]

export type SqlType = 'text' | 'date' | 'timestamptz' | 'numeric' | 'integer' | 'boolean'

/** One output column: its name, its type and the SQL expression that computes it. */
export type Column = { name: string; type: SqlType; sql: string }

/** A SQL string literal. */
export function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** 'nextStep.dueOn' -> 'next_step_due_on'. */
export function snake(path: string): string {
  return path.replace(/\./g, '_').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

/** The table of a record collection. */
export function table(c: CollectionKey): string {
  if (!isRecordCollection(c)) throw new Error(`${c} is not a record collection`)
  return tableName(c)
}

/** The value at a dotted path as text (->> or #>>). */
export function textAt(base: string, path: string): string {
  const parts = path.split('.')
  return parts.length === 1 ? `${base} ->> ${lit(path)}` : `${base} #>> ${lit(`{${parts.join(',')}}`)}`
}

/** The value at a dotted path as jsonb (-> or #>). */
export function jsonAt(base: string, path: string): string {
  const parts = path.split('.')
  return parts.length === 1 ? `${base} -> ${lit(path)}` : `${base} #> ${lit(`{${parts.join(',')}}`)}`
}

/** Field names of T, for SQL written by hand: F<Person>()('startDate') is the literal 'startDate'. */
export function F<T>() {
  return (path: PathTo<T, unknown>): string => lit(path)
}

type Where<T> = Partial<Record<PathTo<T, unknown>, string | boolean | readonly string[]>>

function whereSql<T>(base: string, where: Where<T>): string {
  const parts = Object.entries(where as Record<string, string | boolean | readonly string[]>).map(([field, value]) => {
    const v = textAt(base, field)
    if (typeof value === 'boolean') return `${v} = ${lit(String(value))}`
    if (typeof value === 'string') return `${v} = ${lit(value)}`
    return `${v} IN (${value.map(lit).join(', ')})`
  })
  return parts.length ? parts.join(' AND ') : 'true'
}

/**
 * Typed columns read from `base`, a jsonb expression holding a T (r.data, or x.el for a list item).
 * `row` is the alias of the table row it came from, whose workspace_id lookups use.
 */
export class Fields<T> {
  constructor(
    readonly base: string,
    readonly row: string,
  ) {}

  /** Text; the empty string reads as NULL (the app stores '' for "not set" in a few places). */
  text(path: PathTo<T, string>, name: string = snake(path)): Column {
    return { name, type: 'text', sql: `NULLIF(${textAt(this.base, path)}, '')` }
  }

  date(path: PathTo<T, string>, name: string = snake(path)): Column {
    return { name, type: 'date', sql: `ft_as_date(${textAt(this.base, path)})` }
  }

  timestamp(path: PathTo<T, string>, name: string = snake(path)): Column {
    return { name, type: 'timestamptz', sql: `ft_as_timestamptz(${textAt(this.base, path)})` }
  }

  num(path: PathTo<T, number>, name: string = snake(path)): Column {
    return { name, type: 'numeric', sql: `ft_as_num(${textAt(this.base, path)})` }
  }

  int(path: PathTo<T, number>, name: string = snake(path)): Column {
    return { name, type: 'integer', sql: `ft_as_int(${textAt(this.base, path)})` }
  }

  bool(path: PathTo<T, boolean>, name: string = snake(path)): Column {
    return { name, type: 'boolean', sql: `ft_as_bool(${textAt(this.base, path)})` }
  }

  /** How many items a list holds (0 when it is missing or not a list). */
  count(path: PathTo<T, readonly unknown[]>, name: string): Column {
    return { name, type: 'integer', sql: `jsonb_array_length(ft_array(${jsonAt(this.base, path)}))` }
  }

  /** How many items of a list match every condition (booleans compare as 'true' and 'false'). */
  countWhere<P extends PathTo<T, readonly unknown[]>>(path: P, where: Where<ItemOf<PathValue<T, P>>>, name: string): Column {
    return {
      name,
      type: 'integer',
      sql: `(SELECT count(*)::int FROM jsonb_array_elements(ft_array(${jsonAt(this.base, path)})) AS i(el) WHERE ${whereSql('i.el', where)})`,
    }
  }

  /** The earliest date among the items of a list that match every condition. */
  earliestWhere<P extends PathTo<T, readonly unknown[]>>(path: P, date: PathTo<ItemOf<PathValue<T, P>>, string>, where: Where<ItemOf<PathValue<T, P>>>, name: string): Column {
    return {
      name,
      type: 'date',
      sql: `(SELECT min(ft_as_date(${textAt('i.el', date)})) FROM jsonb_array_elements(ft_array(${jsonAt(this.base, path)})) AS i(el) WHERE ${whereSql('i.el', where)})`,
    }
  }

  /** A list of strings as one text, comma separated ('keep warm, silver medalist'); NULL when empty. */
  joined(path: PathTo<T, readonly string[]>, name: string = snake(path)): Column {
    return {
      name,
      type: 'text',
      sql: `NULLIF(array_to_string(ARRAY(SELECT jsonb_array_elements_text(ft_array(${jsonAt(this.base, path)}))), ', '), '')`,
    }
  }

  /** A field of the record another field names, in the same workspace: the department's name. */
  lookup<K extends CollectionKey>(path: PathTo<T, string>, target: K, field: PathTo<Row<K>, string>, name: string): Column {
    return {
      name,
      type: 'text',
      sql: `(SELECT NULLIF(${textAt('t.data', field)}, '') FROM ${table(target)} t WHERE t.workspace_id = ${this.row}.workspace_id AND t.id = ${textAt(this.base, path)})`,
    }
  }

  /** The SQL that reads a path as text, for expressions written by hand. */
  textSql(path: PathTo<T, string>): string {
    return textAt(this.base, path)
  }

  /** A column computed by hand-written SQL (build it from textSql and the other columns' sql). */
  sql(name: string, type: SqlType, sql: string): Column {
    return { name, type, sql }
  }
}
