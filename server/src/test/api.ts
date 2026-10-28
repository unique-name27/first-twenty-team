// What the API server's HTTP tests share (server/src/app*.test.ts): one in-memory database per test file,
// wiped before each test, with the test admin in it and a fresh app over it. A test file calls useApp()
// once at its top, then uses db and app (both are ready before each test) and the helpers below.
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { blankDB } from '@/data/blank'
import type { DB } from '@/domain/types'
import type { Db } from '../db'
import { createAdmin, CSRF, login, makeApp, makeTestDb, resetDb } from './helpers'

/** The test file's database. */
export let db: Db
/** This test's app over db, made after the test admin. */
export let app: FastifyInstance

/** Sets up db and app for every test in the file. */
export function useApp(): void {
  beforeAll(async () => {
    db = await makeTestDb()
  })
  afterAll(async () => {
    await db.close()
  })
  beforeEach(async () => {
    await resetDb(db)
    await createAdmin(db)
    app = await makeApp(db)
  })
}

export const small = (): DB => blankDB({ companyName: 'Testco', founderFirstName: 'Ada', founderLastName: 'Byte', foundedOn: '2026-01-05' })

/** Headers for a request as the signed-in test admin. */
export async function authed(): Promise<Record<string, string>> {
  return { ...CSRF, cookie: await login(app) }
}

export async function upload(headers: Record<string, string>, data: DB = small(), confirmReplace?: boolean) {
  return app.inject({ method: 'PUT', url: '/api/workspace', headers, payload: confirmReplace === undefined ? { db: data } : { db: data, confirmReplace } })
}

export async function push(headers: Record<string, string>, changes: unknown[]) {
  return app.inject({ method: 'POST', url: '/api/changes', headers, payload: { changes } })
}

export const normalize = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The Set-Cookie line a response sends for cookie `name`, or '' when it sends none. */
export function rawCookie(res: LightMyRequestResponse, name: string): string {
  const header = res.headers['set-cookie']
  const lines = Array.isArray(header) ? header : header === undefined ? [] : [String(header)]
  return lines.find((l) => l.startsWith(`${name}=`)) ?? ''
}
