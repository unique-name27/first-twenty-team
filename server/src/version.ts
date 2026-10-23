// The server's version for GET /api/health: baked in by vite.server.config.ts at build time, read from
// package.json when running from source (tsx, vitest).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { findRootDir } from './config'

declare const __FT_SERVER_VERSION__: string | undefined

let cached: string | null = null

export function serverVersion(): string {
  if (cached) return cached
  if (typeof __FT_SERVER_VERSION__ === 'string') return (cached = __FT_SERVER_VERSION__)
  try {
    const pkg = JSON.parse(readFileSync(path.join(findRootDir(), 'package.json'), 'utf8')) as { version?: string }
    cached = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    cached = '0.0.0'
  }
  return cached
}
