// npm run server:gen-sql            prints CREATE TABLE statements for record collections that no
//                                   migration in server/sql creates yet (paste them into a new 00N_*.sql)
// npm run server:gen-sql -- --init  rewrites server/sql/001_init.sql from scratch (only before the first
//                                   deploy: an applied migration must never change)
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RECORD_COLLECTIONS, tableName } from '../../../src/sync/collections'
import { migrationFiles, migrationsDir } from '../migrate'
import { initSql, recordTableSql, tablesCreatedBy } from '../sqlgen'

const dir = migrationsDir()

if (process.argv.includes('--init')) {
  const file = path.join(dir, '001_init.sql')
  writeFileSync(file, initSql())
  console.log(`Wrote ${file} (${RECORD_COLLECTIONS.length} record tables).`)
} else {
  const existing = new Set(migrationFiles(dir).flatMap((f) => tablesCreatedBy(readFileSync(path.join(dir, f), 'utf8'))))
  const missing = RECORD_COLLECTIONS.filter((c) => !existing.has(tableName(c)))
  if (missing.length === 0) {
    console.log('-- Every record collection already has a table.')
  } else {
    console.log(`-- ${missing.length} record collection(s) without a table. Save as server/sql/00N_add_${tableName(missing[0])}.sql:\n`)
    console.log(missing.map((c) => recordTableSql(c)).join('\n\n'))
  }
}
