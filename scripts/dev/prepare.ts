// `npm run stack`, step 2 (scripts/dev/stack.mjs runs this through tsx before it starts the API): brings
// the stack's PGlite database up to date, makes sure the dev login from credentials.json exists, and
// loads the Ledgerlark sample company into an empty workspace. It opens the database, does its work and
// closes it again, because PGlite lets only one process at a time open a database folder.
//
//   tsx scripts/dev/prepare.ts --dir .data/dev [--no-seed]
//
// DATABASE_URL (pglite:<dir>/pg) and NODE_ENV come from the environment the stack sets (stack-lib.mjs apiEnv).
// Development only: it refuses anything but a PGlite database.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { upsertAdmin, verifyPassword } from '../../server/src/auth'
import { loadConfig } from '../../server/src/config'
import { openDb } from '../../server/src/db'
import { migrate } from '../../server/src/migrate'
import { replaceWorkspace, workspaceStatus } from '../../server/src/repo'
import { WORKSPACE_ID } from '../../server/src/sqlgen'
import { parseWorkspace } from '../../server/src/validate'
import { newId } from '../../src/lib/id'
import { loadSample } from '../../src/store/db'
import { withWorkspaceId } from '../../src/sync/loadTime'

type Credentials = { email: string; password: string }

function readCredentials(dir: string): Credentials {
  const file = path.join(dir, 'credentials.json')
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Credentials>
  if (typeof parsed.email !== 'string' || typeof parsed.password !== 'string') throw new Error(`${file} has no email and password. Run npm run stack -- --fresh.`)
  return { email: parsed.email, password: parsed.password }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dirAt = args.indexOf('--dir')
  const dir = dirAt >= 0 ? args[dirAt + 1] : undefined
  if (!dir) throw new Error('Usage: tsx scripts/dev/prepare.ts --dir .data/dev [--no-seed]')
  const seed = !args.includes('--no-seed')

  const config = loadConfig()
  if (config.nodeEnv === 'production' || !config.pgliteDir || config.pgliteDir === 'memory') {
    throw new Error('scripts/dev/prepare.ts only works on a development PGlite folder (DATABASE_URL=pglite:<dir>).')
  }
  const credentials = readCredentials(path.resolve(config.rootDir, dir))
  const db = await openDb(config)
  try {
    const { applied } = await migrate(db)
    if (applied.length > 0) console.log(`stack: database ready (${applied.length} migrations applied)`)

    // Made once: an existing login keeps its sessions, so a restart keeps you signed in. Its password is
    // set again only when credentials.json no longer matches it (the file was deleted and made anew).
    const existing = await db.query<{ id: string; password_hash: string }>('SELECT id, password_hash FROM users WHERE email = $1', [credentials.email])
    const row = existing.rows[0]
    let adminId = row?.id ?? null
    if (!row || !(await verifyPassword(credentials.password, row.password_hash))) {
      adminId = (await upsertAdmin(db, credentials.email, credentials.password, WORKSPACE_ID)).id
      console.log(`stack: dev login ${credentials.email} ${row ? 'given the password in credentials.json' : 'created'}`)
    }

    // The sample goes in only while the workspace is empty, as an upload from the app would (with a
    // workspace identity, src/sync/loadTime.ts), dated to this week the way the app shows it.
    if (seed && (await workspaceStatus(db, WORKSPACE_ID)).empty) {
      const sample = withWorkspaceId(loadSample(), () => newId('ws'))
      await replaceWorkspace(db, parseWorkspace({ db: sample }), adminId, WORKSPACE_ID)
      console.log(`stack: loaded the ${sample.company.name} sample company`)
    }
  } finally {
    await db.close()
  }
}

main().catch((err: unknown) => {
  console.error(`stack: setup failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
