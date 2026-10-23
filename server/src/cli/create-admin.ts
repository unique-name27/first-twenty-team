// npm run server:create-admin -- --email you@company.com
// Creates the admin login of the server's own company (workspace 'default'), or changes its email and
// password when it exists (signing out its sessions). Demo companies' logins on the same server are never
// touched, and an email that signs in to one of them is refused. Asks for the password twice without
// echoing it. For automation, set ADMIN_PASSWORD in the environment instead (read once, never logged).
import { isValidEmail, MIN_PASSWORD_LENGTH, normalizeEmail, passwordProblem, upsertAdmin } from '../auth'
import { loadConfig } from '../config'
import { openDb } from '../db'
import { ConfigError } from '../errors'
import { migrate } from '../migrate'

function argValue(name: string): string | undefined {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1]
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1)
  }
  return undefined
}

/** Reads one line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin
  return new Promise((resolve, reject) => {
    process.stdout.write(question)
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const done = (err?: Error) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      process.stdout.write('\n')
      if (err) reject(err)
      else resolve(value)
    }
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done()
        if (ch === '\u0003') return done(new Error('Cancelled.')) // Ctrl+C
        if (ch === '\u0004') return done() // Ctrl+D
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else if (ch >= ' ') value += ch
      }
    }
    stdin.on('data', onData)
  })
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.ADMIN_PASSWORD
  if (fromEnv !== undefined) {
    delete process.env.ADMIN_PASSWORD
    return fromEnv
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      'No terminal to ask for the password. Run this in an interactive terminal (on Windows use PowerShell or ' +
        'Windows Terminal; Git Bash\'s default window does not count), or set ADMIN_PASSWORD for automation.',
    )
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await promptHidden(`New admin password (at least ${MIN_PASSWORD_LENGTH} characters): `)
    const problem = passwordProblem(first)
    if (problem) {
      console.log(problem)
      continue
    }
    const second = await promptHidden('Type it again: ')
    if (first !== second) {
      console.log('The two passwords do not match. Try again.')
      continue
    }
    return first
  }
  throw new Error('No password set.')
}

async function main(): Promise<void> {
  const rawEmail = argValue('--email')
  if (!rawEmail) throw new Error('Usage: npm run server:create-admin -- --email you@company.com')
  const email = normalizeEmail(rawEmail)
  if (!isValidEmail(email)) throw new Error(`"${rawEmail}" is not a valid email address.`)

  const config = loadConfig()
  const password = await readPassword()
  const problem = passwordProblem(password)
  if (problem) throw new Error(problem)

  if (config.pgliteDir && config.pgliteDir !== 'memory') {
    console.log(`Using PGlite at ${config.pgliteDir} (stop "npm run server:dev" first: one process at a time).`)
  }
  const db = await openDb(config)
  try {
    // A fresh development database may not have its tables yet; production runs server:migrate first.
    if (config.pgliteDir) await migrate(db)
    const result = await upsertAdmin(db, email, password)
    if (result.created) console.log(`Admin ${result.email} created.`)
    else if (result.previousEmail) console.log(`Admin changed from ${result.previousEmail} to ${result.email}. Old sessions were signed out.`)
    else console.log(`Password updated for ${result.email}. Old sessions were signed out.`)
  } finally {
    await db.close()
  }
}

main().catch((err) => {
  const message = err instanceof ConfigError || err instanceof Error ? err.message : String(err)
  console.error(
    /relation "users" does not exist/.test(message)
      ? 'The database has no tables yet. Run "npm run server:migrate" first.'
      : /relation "\w+" does not exist/.test(message)
        ? 'The database schema is not up to date. Run "npm run server:migrate" first, then this again.'
        : message,
  )
  process.exit(1)
})
