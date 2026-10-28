// Test helpers: one in-memory PGlite per test file (migrated once, wiped between tests) and a fresh
// Fastify app per test, driven with app.inject(). Passwords hash at the cheap test cost (config.ts
// TEST_SCRYPT_N), in makeApp's config and in createAdmin.
import { PGlite } from '@electric-sql/pglite'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { RECORD_COLLECTIONS, tableName } from '../../../src/sync/collections'
import { buildApp } from '../app'
import { DEVICE_COOKIE, SECURE_DEVICE_COOKIE, SECURE_SESSION_COOKIE, SESSION_COOKIE, upsertAdmin } from '../auth'
import { type Config, TEST_SCRYPT_N, testConfig } from '../config'
import { type Db, fromPGlite } from '../db'
import { migrate } from '../migrate'
import { WORKSPACE_ID } from '../sqlgen'

// Test-only credentials for the in-memory database (never used anywhere else).
export const ADMIN = { email: 'admin@example.com', password: 'test-password-1234' }
export const CSRF = { 'x-first-twenty': '1' }

/**
 * Characters String.prototype.trim removes, the ones an attacker can pad an email with: space, tab,
 * line breaks, NBSP, U+2000 to U+200A, U+2028, U+2029, U+3000 and U+FEFF.
 */
export const TRIMMED_SPACES = [
  ' ',
  '\t',
  '\n',
  '\r',
  ' ',
  ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)),
  ' ',
  ' ',
  '　',
  '﻿',
]

/** A label for a padding character in test names, like U+3000. */
export const codePoint = (c: string): string => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`

/** Wraps a Db so every user lookup by email (the password check) records the email it looked up. */
export function spyOnEmailLookups(inner: Db, lookups: string[]): Db {
  return {
    ...inner,
    query: (async (text: string, params?: unknown[]) => {
      if (/FROM users WHERE email = \$1/.test(text)) lookups.push(String(params?.[0]))
      return inner.query(text, params)
    }) as Db['query'],
  }
}

export async function makeTestDb(): Promise<Db> {
  const pg = await PGlite.create()
  const db = fromPGlite(pg as unknown as Parameters<typeof fromPGlite>[0])
  await migrate(db)
  return db
}

/** Empties every table and recreates the default workspace row (kept, as migration 004 leaves it). */
export async function resetDb(db: Db): Promise<void> {
  const tables = [
    'change_log',
    'sessions',
    'trusted_devices',
    'invites',
    'assistant_usage',
    'workspace_docs',
    ...RECORD_COLLECTIONS.map(tableName),
    'users',
    'workspaces',
  ]
  await db.exec(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`)
  await db.query(`INSERT INTO workspaces (id, name, slug, keep) VALUES ($1, 'Default workspace', 'default-workspace', true)`, [WORKSPACE_ID])
}

export async function makeApp(db: Db, overrides: Partial<Config> = {}): Promise<FastifyInstance> {
  const app = await buildApp({ db, config: testConfig(overrides), logger: false })
  await app.ready()
  return app
}

/** The test admin, its password hashed at the cheap test cost (config.ts TEST_SCRYPT_N), as makeApp's config hashes. */
export async function createAdmin(db: Db): Promise<string> {
  return (await upsertAdmin(db, ADMIN.email, ADMIN.password, WORKSPACE_ID, TEST_SCRYPT_N)).id
}

/** The session token a response sets, under either cookie name (plain http or https), or null. */
export function sessionCookie(res: LightMyRequestResponse): string | null {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE || x.name === SECURE_SESSION_COOKIE)
  return c && c.value ? c.value : null
}

/** The trusted-device token a response sets, under either cookie name, or null. */
export function deviceCookie(res: LightMyRequestResponse): string | null {
  const c = res.cookies.find((x) => x.name === DEVICE_COOKIE || x.name === SECURE_DEVICE_COOKIE)
  return c && c.value ? c.value : null
}

/** The Cookie header value for the session a response sets. */
function cookieHeader(res: LightMyRequestResponse): string {
  const token = sessionCookie(res)
  if (!token) throw new Error('no session cookie')
  const name = res.cookies.find((x) => x.value === token)!.name
  return `${name}=${token}`
}

/** Signs in as the test admin over plain http; returns the Cookie header value. */
export async function login(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: ADMIN.email, password: ADMIN.password } })
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`)
  return cookieHeader(res)
}

export type SignedUp = { cookie: string; userId: string; workspace: { id: string; name: string; slug: string } }

/**
 * Signs up a demo company (the app needs SIGNUP_MODE=open: makeApp(db, {signupMode: 'open'})) from its
 * own client address, so the account limit never gets in the way; returns its Cookie header and company.
 */
export async function signUp(app: FastifyInstance, email: string, companyName: string, remoteAddress = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`): Promise<SignedUp> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    headers: CSRF,
    payload: { email, password: ADMIN.password, companyName },
    remoteAddress,
  })
  if (res.statusCode !== 201) throw new Error(`sign-up failed: ${res.statusCode} ${res.body}`)
  const body = res.json() as { user: { id: string }; workspace: SignedUp['workspace'] }
  return { cookie: cookieHeader(res), userId: body.user.id, workspace: body.workspace }
}
