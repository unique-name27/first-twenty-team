// npm run server:migrate             applies pending server/sql migrations, in order, each in a transaction
// npm run server:migrate -- --status lists applied and pending migrations without changing anything
import { loadConfig } from '../config'
import { openDb } from '../db'
import { ConfigError } from '../errors'
import { appliedMigrations, migrate, pendingMigrations } from '../migrate'

async function main(): Promise<void> {
  const config = loadConfig()
  if (config.pgliteDir && config.pgliteDir !== 'memory') {
    console.log(`Using PGlite at ${config.pgliteDir} (stop "npm run server:dev" first: one process at a time).`)
  }
  const db = await openDb(config)
  try {
    if (process.argv.includes('--status')) {
      const applied = await appliedMigrations(db)
      const pending = await pendingMigrations(db)
      console.log(`Applied (${applied.length}): ${applied.join(', ') || 'none'}`)
      console.log(`Pending (${pending.length}): ${pending.join(', ') || 'none'}`)
      return
    }
    const { applied } = await migrate(db, { log: (m) => console.log(m) })
    console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : 'Nothing to do: the schema is up to date.')
  } finally {
    await db.close()
  }
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : `Migration failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
