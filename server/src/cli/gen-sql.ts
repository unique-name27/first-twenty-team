// npm run server:gen-sql            prints CREATE TABLE statements for record collections that no
//                                   migration in server/sql creates yet (paste them into a new 00N_*.sql)
// npm run server:gen-sql -- --init  rewrites server/sql/001_init.sql from scratch (only before the first
//                                   deploy: an applied migration must never change)
// npm run server:gen-sql -- --read-model            prints the read model's SQL (server/src/readmodel/spec.ts)
// npm run server:gen-sql -- --read-model --write    saves it as the next migration, NNN_read_model.sql,
//                                                   when it differs from the newest read-model migration
// npm run server:gen-sql -- --read-model --replace  rewrites the newest NNN_read_model.sql instead (only
//                                                   one your branch added that is not on main yet)
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RECORD_COLLECTIONS, tableName } from '../../../src/sync/collections'
import { migrationFiles, migrationsDir } from '../migrate'
import { isCurrent, newestReadModelFile, nextReadModelFile, readModelSql } from '../readmodel/generate'
import { initSql, recordTableSql, tablesCreatedBy } from '../sqlgen'

const dir = migrationsDir()
const args = process.argv.slice(2)

if (args.includes('--read-model')) {
  const newest = newestReadModelFile(dir)
  if (args.includes('--write')) {
    if (newest && isCurrent(dir, newest)) {
      console.log(`server/sql/${newest} already matches the read model; nothing to write.`)
    } else {
      const file = nextReadModelFile(dir)
      writeFileSync(path.join(dir, file), readModelSql())
      console.log(`Wrote server/sql/${file}. Commit it with the change to the read model.`)
    }
  } else if (args.includes('--replace')) {
    if (!newest) throw new Error('No NNN_read_model.sql to replace yet: use --write.')
    writeFileSync(path.join(dir, newest), readModelSql())
    console.log(`Rewrote server/sql/${newest}. Only do this for a migration that is not on main yet.`)
  } else {
    process.stdout.write(readModelSql())
  }
} else if (args.includes('--init')) {
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
