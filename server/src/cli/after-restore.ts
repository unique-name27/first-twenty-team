// npm run server:after-restore
// Run once after loading a backup into the database (docs/SERVER.md, "Restore a backup", step 6), with
// the server stopped. It starts a new sync history so every browser reloads the server's copy instead of
// trusting what it saw before the restore, moves the change-log numbering past anything a browser saw,
// and signs everyone out (the backup may hold sessions that were ended after it was taken).
import { loadConfig } from '../config'
import { openDb } from '../db'
import { ConfigError } from '../errors'
import { migrate } from '../migrate'
import { afterRestore } from '../repo'

async function main(): Promise<void> {
  const config = loadConfig()
  if (config.pgliteDir && config.pgliteDir !== 'memory') {
    console.log(`Using PGlite at ${config.pgliteDir} (stop "npm run server:dev" first: one process at a time).`)
  }
  const db = await openDb(config)
  try {
    // A development database may predate the latest migrations; production runs server:migrate first.
    if (config.pgliteDir) await migrate(db)
    const result = await afterRestore(db)
    console.log(`New sync history started at change ${result.seq}. Browsers reload the server's copy on their next sync.`)
    console.log(
      result.sessionsEnded > 0
        ? `Signed out ${result.sessionsEnded} session(s): sign in again in each browser.`
        : 'No sessions to sign out: sign in again in each browser.',
    )
    console.log('The admin password is the one in use when the backup was taken. Run server:create-admin to change it.')
  } finally {
    await db.close()
  }
}

main().catch((err) => {
  const message = err instanceof ConfigError || err instanceof Error ? err.message : String(err)
  console.error(
    /relation "\w+" does not exist|column "history_id" does not exist/.test(message)
      ? 'The database schema is not up to date. Run "npm run server:migrate" first, then this again.'
      : /permission denied/.test(message)
        ? 'The database login cannot change the change-log numbering. Run this as the schema owner, on EC2 with ' +
          '"bash server/deploy/with-env.sh npm run server:after-restore" (it uses MIGRATION_DATABASE_URL).'
        : `after-restore failed: ${message}`,
  )
  process.exit(1)
})
