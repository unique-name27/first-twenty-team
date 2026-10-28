// Development only: POST /__dev/sql, the API side of `npm run sql` (scripts/dev/sql.ts, docs/DEV.md). While
// the stack runs, its API holds the PGlite database (one process per folder), so npm run sql asks it here.
// Only the development entry (server/src/dev/index.ts, which npm run stack starts) registers this route;
// server/src/index.ts and app.ts never import this folder (structure.test.ts checks).
//
// It answers only a request that arrives on a loopback socket and carries the secret npm run stack made
// for this run (Authorization: Bearer <secret>; the stack writes it to <data folder>/dev-tools.json, which
// the Vite dev server never serves). Anything else gets the same 404 as a path that does not exist, before
// the body is read. The path is outside /api, so the Vite dev server never passes a request on to it.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../db'
import { isPlainObject } from '../validate'
import { RefusedError, runReadOnly, type SqlParam, type SqlRequest, sqlProblem } from './readonly'

export const DEV_SQL_PATH = '/__dev/sql'
/** One statement and its values: far more than anyone types. */
export const DEV_SQL_BODY_LIMIT = 64 * 1024
/** The stack's secret is 32 random bytes in base64url (43 characters); anything much shorter is refused. */
export const MIN_SECRET_LENGTH = 32

/** True for a socket address on this computer: 127.0.0.0/8 or ::1, also written as an IPv4-mapped IPv6 address. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const a = address.toLowerCase()
  return a === '::1' || /^(::ffff:)?127(\.\d{1,3}){3}$/.test(a)
}

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest()

/**
 * Whether an Authorization header carries the secret whose SHA-256 is `expected`. Both sides are hashed
 * first, so they have the same length and the comparison takes the same time whatever was sent.
 */
export function bearerMatches(header: string | undefined, expected: Buffer): boolean {
  const m = /^Bearer (\S+)$/.exec(header ?? '')
  const same = timingSafeEqual(digest(m ? m[1] : ''), expected)
  return same && m !== null
}

/** The request body as a SqlRequest, or a RefusedError saying what is wrong with it. */
export function parseSqlRequest(body: unknown): SqlRequest {
  if (!isPlainObject(body) || typeof body.sql !== 'string') throw new RefusedError('Send {"sql": "SELECT ..."}.')
  const params = body.params ?? []
  if (!Array.isArray(params) || !params.every((p): p is SqlParam => p === null || ['string', 'number', 'boolean'].includes(typeof p))) {
    throw new RefusedError('params must be a list of text, numbers, true/false or null.')
  }
  if (body.today !== undefined && typeof body.today !== 'string') throw new RefusedError('today must be a date like 2026-10-09.')
  return { sql: body.sql, params, ...(body.today !== undefined ? { today: body.today as string } : {}) }
}

/** Registers POST /__dev/sql on `app` (before it listens), answering with `db`, for holders of `secret` only. */
export async function registerDevRoutes(app: FastifyInstance, deps: { db: Db; secret: string }): Promise<void> {
  if (deps.secret.length < MIN_SECRET_LENGTH) throw new Error(`The dev tools secret must be at least ${MIN_SECRET_LENGTH} characters.`)
  const expected = digest(deps.secret)

  app.post(
    DEV_SQL_PATH,
    {
      bodyLimit: DEV_SQL_BODY_LIMIT,
      // The raw socket's address, not request.ip: a proxy's X-Forwarded-For never counts here.
      onRequest: async (request, reply) => {
        if (!isLoopbackAddress(request.socket.remoteAddress) || !bearerMatches(request.headers.authorization, expected)) {
          return reply.code(404).send({ error: 'not_found' })
        }
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      try {
        return await runReadOnly(deps.db, parseSqlRequest(request.body))
      } catch (err) {
        // A refusal, or the database's own message (a typo, a missing column): what a developer needs here.
        const problem = sqlProblem(err)
        if (!problem) throw err
        const { kind, message, ...where } = problem
        return reply.code(400).send({ error: kind, detail: message, ...where })
      }
    },
  )
}
