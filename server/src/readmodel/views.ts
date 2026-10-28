// The kinds of view the read model has (spec.ts lists them; generate.ts writes their SQL):
// - collection: one row per record of a record collection, typed columns read from its data;
// - list: one row per item of a list inside each record (a checklist's tasks), with the record's id;
// - doc list: one row per item of a list inside a workspace document (the company's pay runs);
// - sql: hand-written SQL over the other views (the journeys, the funnel, headcount, integrity problems).
import type { ItemOf, PathTo, PathValue } from '../../../src/domain/paths'
import type { CollectionKey, DB } from '../../../src/domain/types'
import type { DocKey } from '../../../src/sync/collections'
import { type Column, Fields, type Row } from './columns'

export type CollectionView = { kind: 'collection'; name: string; comment: string; collection: CollectionKey; columns: Column[] }

export type ListView = {
  kind: 'list'
  name: string
  comment: string
  collection: CollectionKey
  /** The list inside each record, a jsonb path. */
  list: string
  /** The column that holds the record's id ('checklist_id'). */
  parentKey: string
  /** The items carry an id of their own (else rows are told apart by position only). */
  itemId: boolean
  parentColumns: Column[]
  columns: Column[]
}

export type DocListView = { kind: 'doc list'; name: string; comment: string; doc: DocKey; list: string; columns: Column[] }

export type SqlView = { kind: 'sql'; name: string; comment: string; sql: string }

export type View = CollectionView | ListView | DocListView | SqlView

/** One row per record; workspace_id and id come first, version and updated_at last. */
export function collectionView<K extends CollectionKey>(name: string, collection: K, comment: string, columns: (f: Fields<Row<K>>) => Column[]): CollectionView {
  return { kind: 'collection', name, comment, collection, columns: columns(new Fields<Row<K>>('r.data', 'r')) }
}

/** One row per item of a list in each record; workspace_id, the record's id, the item's id, then its ordinal (1, 2, ...). */
export function listView<K extends CollectionKey, P extends PathTo<Row<K>, readonly unknown[]>>(
  name: string,
  collection: K,
  list: P,
  comment: string,
  opts: { parentKey: string; itemId: boolean },
  parentColumns: (f: Fields<Row<K>>) => Column[],
  columns: (f: Fields<ItemOf<PathValue<Row<K>, P>>>) => Column[],
): ListView {
  return {
    kind: 'list',
    name,
    comment,
    collection,
    list,
    parentKey: opts.parentKey,
    itemId: opts.itemId,
    parentColumns: parentColumns(new Fields<Row<K>>('r.data', 'r')),
    columns: columns(new Fields<ItemOf<PathValue<Row<K>, P>>>('x.el', 'r')),
  }
}

/** One row per item of a list in a workspace document; workspace_id then its ordinal (1, 2, ...). */
export function docListView<D extends DocKey, P extends PathTo<DB[D], readonly unknown[]>>(
  name: string,
  doc: D,
  list: P,
  comment: string,
  columns: (f: Fields<ItemOf<PathValue<DB[D], P>>>) => Column[],
): DocListView {
  return { kind: 'doc list', name, comment, doc, list, columns: columns(new Fields<ItemOf<PathValue<DB[D], P>>>('x.el', 'd')) }
}

export function sqlView(name: string, comment: string, sql: string): SqlView {
  return { kind: 'sql', name, comment, sql }
}
