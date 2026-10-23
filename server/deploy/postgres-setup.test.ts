// postgres-setup.sql run in PGlite: the two roles it makes can do what the server and migrations do and
// nothing more, it is safe to re-run, and it upgrades a one-role setup. Split from deploy-kit.test.ts so
// PGlite runs in its own worker: next to that file's hundreds of Git Bash spawns, PGlite's emulated
// initdb on Windows sometimes saw a hangup signal or crashed the worker.
//
// `npm test` runs it (vite.config.ts includes server/deploy/**/*.test.ts). On its own: npx vitest run server/deploy
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { purgeSessions } from '../src/auth'
import { type Db, fromPGlite } from '../src/db'
import { housekeeping } from '../src/housekeeping'
import { migrate, migrationFiles } from '../src/migrate'
import { afterRestore, changesSince, pruneChangeLog } from '../src/repo'
import { createAdmin, CSRF, login, makeApp } from '../src/test/helpers'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8')
const setupSql = read('server/deploy/postgres-setup.sql')

type PGliteArg = Parameters<typeof fromPGlite>[0]
const asDb = (pg: PGlite): Db => fromPGlite(pg as unknown as PGliteArg)

/**
 * Runs a psql script against PGlite, for the parts PGlite can do: statements end with ';', `\gset`
 * stores the first row in variables (booleans as t/f), `\gexec` runs each returned string, `\if`,
 * `\elif`, `\else` and `\endif` branch on variables, `\set` sets one, `:name` interpolates one, and
 * `\connect name` switches to connections[name]. `\password <role>` is recorded, other backslash
 * commands (\echo) are ignored.
 */
async function runPsql(sql: string, connections: Record<string, PGlite>, start: PGlite): Promise<{ passwordPrompts: string[] }> {
  const vars = new Map<string, string>()
  const passwordPrompts: string[] = []
  const branches: Array<{ active: boolean; taken: boolean }> = []
  const active = () => branches.every((b) => b.active)
  let pg = start
  let buffer = ''

  const interpolate = (text: string) =>
    text
      .replace(/:'([A-Za-z_]\w*)'/g, (m, name: string) => (vars.has(name) ? `'${vars.get(name)!.replace(/'/g, "''")}'` : m))
      .replace(/(?<![:\w]):([A-Za-z_]\w*)/g, (m, name: string) => vars.get(name) ?? m)
  const truthy = (value: string) => {
    if (/^(t|true|on|1|yes)$/i.test(value)) return true
    if (/^(f|false|off|0|no)$/i.test(value)) return false
    throw new Error(`not a boolean: ${value}`)
  }
  const cell = (v: unknown) => (v === true ? 't' : v === false ? 'f' : String(v))

  for (const raw of sql.split('\n')) {
    const line = raw.trim()
    if (!buffer && (line === '' || line.startsWith('--'))) continue
    if (!buffer && line.startsWith('\\')) {
      const [cmd, ...rest] = line.split(/\s+/)
      const arg = rest.join(' ')
      if (cmd === '\\if') branches.push({ active: active() && truthy(interpolate(arg)), taken: false })
      else if (cmd === '\\elif') {
        const b = branches[branches.length - 1]
        b.taken ||= b.active
        b.active = !b.taken && truthy(interpolate(arg))
      } else if (cmd === '\\else') {
        const b = branches[branches.length - 1]
        b.taken ||= b.active
        b.active = !b.taken
      } else if (cmd === '\\endif') branches.pop()
      else if (!active()) continue
      else if (cmd === '\\set') vars.set(rest[0], rest.slice(1).join(' '))
      else if (cmd === '\\connect') {
        const target = connections[rest[0]]
        if (!target) throw new Error(`no connection for ${rest[0]}`)
        pg = target
      } else if (cmd === '\\password') passwordPrompts.push(rest[0])
      continue
    }
    if (!active()) continue
    if (line.startsWith('--')) continue
    const meta = /\\(gset|gexec)$/.exec(line)
    if (meta) {
      const query = interpolate(`${buffer} ${line.slice(0, -meta[0].length)}`)
      buffer = ''
      const res = await pg.query<Record<string, unknown>>(query)
      if (meta[1] === 'gset') {
        const row = res.rows[0] ?? {}
        for (const [k, v] of Object.entries(row)) {
          if (v === null) vars.delete(k)
          else vars.set(k, cell(v))
        }
      } else {
        for (const row of res.rows) for (const statement of Object.values(row)) await pg.exec(String(statement))
      }
      continue
    }
    buffer = `${buffer} ${line}`
    if (line.endsWith(';')) {
      await pg.exec(interpolate(buffer))
      buffer = ''
    }
  }
  expect(buffer.trim()).toBe('')
  expect(branches).toEqual([])
  return { passwordPrompts }
}

/** Runs postgres-setup.sql on a one-database PGlite (\connect first_twenty stays on it). */
const runSetup = (pg: PGlite) => runPsql(setupSql, { first_twenty: pg }, pg)

const tableOwners = async (pg: PGlite) =>
  new Set((await pg.query<{ owner: string }>(`SELECT DISTINCT tableowner AS owner FROM pg_tables WHERE schemaname = 'public'`)).rows.map((r) => r.owner))

describe('postgres-setup.sql', () => {
  it('makes an owner role for migrations and a read-and-write role for the server, and is safe to re-run', async () => {
    const pg = await PGlite.create()
    try {
      const first = await runSetup(pg)
      expect(first.passwordPrompts).toEqual(['first_twenty', 'first_twenty_owner'])
      const second = await runSetup(pg) // second run: no errors, nothing duplicated, no prompts
      expect(second.passwordPrompts).toEqual([])

      const roles = await pg.query<Record<string, unknown>>(
        `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname LIKE 'first_twenty%' ORDER BY rolname`,
      )
      const least = { rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }
      expect(roles.rows).toEqual([
        { rolname: 'first_twenty', ...least },
        { rolname: 'first_twenty_owner', ...least },
      ])
      const owner = await pg.query<{ owner: string }>(`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = 'first_twenty'`)
      expect(owner.rows).toEqual([{ owner: 'postgres' }])

      await pg.exec(`CREATE ROLE stranger LOGIN`)
      const privs = await pg.query<Record<string, boolean>>(
        `SELECT has_database_privilege('first_twenty', 'first_twenty', 'CONNECT') AS app_connect,
                has_database_privilege('first_twenty_owner', 'first_twenty', 'CONNECT') AS owner_connect,
                has_database_privilege('stranger', 'first_twenty', 'CONNECT') AS stranger_connect,
                has_database_privilege('first_twenty', 'first_twenty', 'TEMPORARY') AS app_temp,
                has_database_privilege('first_twenty_owner', 'first_twenty', 'CREATE') AS owner_create_schema,
                has_schema_privilege('first_twenty', 'public', 'USAGE') AS app_usage,
                has_schema_privilege('first_twenty', 'public', 'CREATE') AS app_create,
                has_schema_privilege('first_twenty_owner', 'public', 'CREATE') AS owner_create,
                has_schema_privilege('stranger', 'public', 'USAGE') AS stranger_usage`,
      )
      expect(privs.rows[0]).toEqual({
        app_connect: true,
        owner_connect: true,
        stranger_connect: false,
        app_temp: false,
        owner_create_schema: false,
        app_usage: true,
        app_create: false,
        owner_create: true,
        stranger_usage: false,
      })

      // As the owner: every migration applies, and the owner owns every table.
      await pg.exec('SET ROLE first_twenty_owner')
      const dir = path.join(root, 'server', 'sql')
      const result = await migrate(asDb(pg), { dir })
      expect(result.applied).toEqual(migrationFiles(dir))
      expect(result.applied.length).toBeGreaterThan(0)
      await expect(pg.exec('CREATE SCHEMA other')).rejects.toThrow(/permission denied/)
      await expect(pg.exec('CREATE ROLE other')).rejects.toThrow(/permission denied/)
      await expect(pg.exec('DROP SCHEMA public CASCADE')).rejects.toThrow(/must be owner/)
      await pg.exec('RESET ROLE')
      expect(await tableOwners(pg)).toEqual(new Set(['first_twenty_owner']))

      // Another login sees nothing.
      await pg.exec('SET ROLE stranger')
      await expect(pg.query('SELECT * FROM public.users')).rejects.toThrow(/permission denied for schema public/)
      await pg.exec('RESET ROLE')
    } finally {
      await pg.close()
    }
  })

  it('makes a read-only viewer that sees the records but not the credentials, and runs browse.sql', async () => {
    const pg = await PGlite.create()
    try {
      await runSetup(pg)
      await pg.exec('SET ROLE first_twenty_owner')
      await migrate(asDb(pg), { dir: path.join(root, 'server', 'sql') })
      await pg.exec('RESET ROLE')
      const viewerSql = read('server/deploy/viewer-role.sql')
      await runPsql(viewerSql, { first_twenty: pg }, pg)
      await runPsql(viewerSql, { first_twenty: pg }, pg) // safe to re-run

      const role = await pg.query<{ rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolcanlogin: boolean }>(
        `SELECT rolsuper, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = 'first_twenty_viewer'`,
      )
      expect(role.rows[0]).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: true })

      await pg.exec('SET ROLE first_twenty_viewer')
      // Every statement in browse.sql runs (the tables are empty, so this checks names and types).
      const statements = read('server/deploy/browse.sql')
        .split('\n')
        .filter((l) => !l.startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
      expect(statements.length).toBeGreaterThan(8)
      for (const s of statements) await expect(pg.query(s), s.slice(0, 60)).resolves.toBeDefined()
      for (const table of ['users', 'sessions', 'trusted_devices', 'invites']) {
        await expect(pg.query(`SELECT * FROM public.${table}`), table).rejects.toThrow(/permission denied/)
      }
      // Every other table is readable, the companies (workspaces) included: only credentials are kept out.
      const readable = await pg.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND has_table_privilege('first_twenty_viewer', format('%I.%I', schemaname, tablename), 'SELECT')`,
      )
      const all = await pg.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)
      expect(readable.rows.map((r) => r.tablename).sort()).toEqual(
        all.rows.map((r) => r.tablename).filter((t) => !['users', 'sessions', 'trusted_devices', 'invites'].includes(t)).sort(),
      )
      expect(readable.rows.map((r) => r.tablename)).toContain('workspaces')
      await expect(pg.exec(`INSERT INTO people (workspace_id, id, data) VALUES ('w', 'p', '{}')`)).rejects.toThrow(/permission denied/)
      await expect(pg.exec('DELETE FROM change_log')).rejects.toThrow(/permission denied/)
      await expect(pg.exec('CREATE TABLE public.x (a int)')).rejects.toThrow(/permission denied/)
      await pg.exec('RESET ROLE')
    } finally {
      await pg.close()
    }
  })

  it("lets the server's role do everything the server does, and nothing that changes the schema", async () => {
    const pg = await PGlite.create()
    try {
      await runSetup(pg)
      await pg.exec('SET ROLE first_twenty_owner')
      await migrate(asDb(pg), { dir: path.join(root, 'server', 'sql') })
      await pg.exec('RESET ROLE')

      await pg.exec('SET ROLE first_twenty')
      const db = asDb(pg)
      const current = await pg.query<{ u: string }>('SELECT current_user AS u')
      expect(current.rows[0].u).toBe('first_twenty')

      // The whole HTTP flow, as the server runs it.
      await createAdmin(db)
      const app = await makeApp(db)
      try {
        const health = await app.inject({ method: 'GET', url: '/api/health' })
        expect(health.statusCode).toBe(200)
        const headers = { ...CSRF, cookie: await login(app) }
        const company = blankDB({ companyName: 'Roleco', founderFirstName: 'Ada', founderLastName: 'Byte', foundedOn: '2026-01-05' })
        const put = await app.inject({ method: 'PUT', url: '/api/workspace', headers, payload: { db: company } })
        expect(put.statusCode, put.body).toBe(200)
        const snap = await app.inject({ method: 'GET', url: '/api/workspace', headers })
        expect(snap.statusCode, snap.body).toBe(200)
        const person = { ...company.people[0], id: 'p-role-test', firstName: 'Pat' }
        const push = await app.inject({
          method: 'POST',
          url: '/api/changes',
          headers,
          payload: { changes: [{ collection: 'people', id: person.id, op: 'upsert', data: person, baseVersion: null }] },
        })
        expect(push.statusCode, push.body).toBe(200)
        expect((push.json() as { applied: unknown[] }).applied).toHaveLength(1)
        const del = await app.inject({
          method: 'POST',
          url: '/api/changes',
          headers,
          payload: {
            changes: [{ collection: 'people', id: person.id, op: 'delete', baseVersion: (push.json() as { applied: Array<{ version: number }> }).applied[0].version }],
          },
        })
        expect(del.statusCode, del.body).toBe(200)
        const pull = await app.inject({ method: 'GET', url: '/api/changes?since=0', headers })
        expect(pull.statusCode, pull.body).toBe(200)
        const replace = await app.inject({ method: 'PUT', url: '/api/workspace', headers, payload: { db: company, confirmReplace: true } })
        expect(replace.statusCode, replace.body).toBe(200)
        const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers })
        expect(logout.statusCode).toBe(204)
      } finally {
        await app.close()
      }
      // A public demo server: sign-up (an advisory lock, new rows in workspaces and users), an invite
      // and its use, all as the server's role.
      const demo = await makeApp(db, { signupMode: 'open' })
      try {
        const signup = await demo.inject({
          method: 'POST',
          url: '/api/auth/signup',
          headers: CSRF,
          payload: { email: 'demo@example.com', password: 'demo-password-1234', companyName: 'Demo Roleco' },
        })
        expect(signup.statusCode, signup.body).toBe(201)
        const demoCookie = `ft_session=${signup.cookies.find((c) => c.name === 'ft_session')!.value}`
        const demoHeaders = { ...CSRF, cookie: demoCookie }
        const company = blankDB({ companyName: 'Demo Roleco', founderFirstName: 'Di', founderLastName: 'Mo', foundedOn: '2026-01-05' })
        expect((await demo.inject({ method: 'PUT', url: '/api/workspace', headers: demoHeaders, payload: { db: company } })).statusCode).toBe(200)
        const invite = await demo.inject({ method: 'POST', url: '/api/invites', headers: demoHeaders })
        expect(invite.statusCode, invite.body).toBe(201)
        const token = String(invite.json().url).split('#invite.')[1]
        const joined = await demo.inject({
          method: 'POST',
          url: '/api/auth/accept-invite',
          headers: CSRF,
          payload: { token, email: 'teammate@example.com', password: 'demo-password-1234' },
        })
        expect(joined.statusCode, joined.body).toBe(201)
      } finally {
        await demo.close()
      }

      // Daily housekeeping, including deleting a demo company nobody used for DEMO_EXPIRE_DAYS.
      await purgeSessions(db, { sessionIdleHours: 12 })
      await pruneChangeLog(db, 120)
      expect(await changesSince(db, 0)).toBeDefined()
      await pg.exec(`RESET ROLE`)
      await pg.exec(`UPDATE workspaces SET last_active_at = now() - interval '31 days' WHERE NOT keep`)
      await pg.exec('SET ROLE first_twenty')
      expect(await housekeeping(db, { sessionIdleHours: 12, demoExpireDays: 30 })).toMatchObject({ expiredWorkspaces: 1 })
      expect((await pg.query(`SELECT email FROM users`)).rows).toEqual([{ email: 'admin@example.com' }])

      // Nothing that changes the schema...
      for (const statement of [
        'CREATE TABLE extra (id int)',
        'DROP TABLE people',
        'TRUNCATE people',
        'ALTER TABLE people ADD COLUMN extra int',
        'CREATE INDEX extra_idx ON people (updated_at)',
        'CREATE FUNCTION extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
        'CREATE SCHEMA other',
      ]) {
        await expect(pg.exec(statement), statement).rejects.toThrow(/permission denied|must be owner/)
      }
      // ...and no way into the owner's powers. (SET ROLE is checked against the session user, which is
      // the superuser in this test, so membership is checked directly.)
      const member = await pg.query<{ m: boolean }>(`SELECT pg_has_role('first_twenty', 'first_twenty_owner', 'MEMBER') AS m`)
      expect(member.rows[0].m).toBe(false)
      // So migrations (and MIGRATE_ON_START) cannot run as this role...
      await expect(migrate(db, { dir: path.join(root, 'server', 'sql') })).rejects.toThrow(/permission denied/)
      // There is no sequence for this role to use, or for after-restore to move: since migration 005 each
      // workspace counts its own seqs (workspaces.last_seq). after-restore still runs as the owner below,
      // through with-env.sh as docs/SERVER.md says.
      expect(Number((await pg.query<{ n: unknown }>(`SELECT count(*) AS n FROM pg_class WHERE relkind = 'S'`)).rows[0].n)).toBe(0)
      await pg.exec('RESET ROLE')

      await pg.exec('SET ROLE first_twenty_owner')
      const restored = await afterRestore(db)
      expect(restored.seq).toBeGreaterThan(0)
      await pg.exec('RESET ROLE')
    } finally {
      await pg.close()
    }
  })

  it('upgrades a one-role setup: the tables move to the owner and the server role loses CREATE', async () => {
    const pg = await PGlite.create()
    try {
      // The setup made by the earlier postgres-setup.sql: first_twenty created and owned the tables.
      await pg.exec(`CREATE ROLE first_twenty WITH LOGIN NOINHERIT;
        REVOKE ALL ON SCHEMA public FROM PUBLIC;
        GRANT USAGE, CREATE ON SCHEMA public TO first_twenty;`)
      await pg.exec('SET ROLE first_twenty')
      const db = asDb(pg)
      await migrate(db, { dir: path.join(root, 'server', 'sql') })
      await createAdmin(db)
      await pg.exec('RESET ROLE')
      expect(await tableOwners(pg)).toEqual(new Set(['first_twenty']))

      const { passwordPrompts } = await runSetup(pg)
      expect(passwordPrompts).toEqual(['first_twenty_owner']) // the existing role keeps its password

      expect(await tableOwners(pg)).toEqual(new Set(['first_twenty_owner']))
      const create = await pg.query<{ c: boolean }>(`SELECT has_schema_privilege('first_twenty', 'public', 'CREATE') AS c`)
      expect(create.rows[0].c).toBe(false)

      await pg.exec('SET ROLE first_twenty')
      expect((await pg.query('SELECT email FROM users')).rows).toHaveLength(1)
      await pg.query(`UPDATE users SET last_login_at = now()`)
      await expect(pg.exec('DROP TABLE users CASCADE')).rejects.toThrow(/must be owner/)
      await pg.exec('RESET ROLE')

      // A later migration by the owner adds a table; the server role can use it right away.
      await pg.exec('SET ROLE first_twenty_owner')
      await pg.exec('CREATE TABLE later_feature (id bigserial PRIMARY KEY, note text)')
      await pg.exec('RESET ROLE')
      await pg.exec('SET ROLE first_twenty')
      await pg.exec(`INSERT INTO later_feature (note) VALUES ('ok')`)
      expect((await pg.query('SELECT note FROM later_feature')).rows).toEqual([{ note: 'ok' }])
      await pg.exec('RESET ROLE')
    } finally {
      await pg.close()
    }
  })
})
