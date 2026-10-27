// Types for stack-lib.mjs (plain JavaScript so `node scripts/dev/stack.mjs` runs without a build step),
// for vite.config.ts and the tests. Keep in step with stack-lib.mjs.
type Env = Record<string, string | undefined>

export const APP_PORT: number
export const API_PORT: number
export const MAX_OFFSET: number
export const DEV_EMAIL: string
export const USAGE: string
export const DEV_FS_DENY: string[]

export type StackArgs = { fresh: boolean; offset: number; seed: boolean; help: boolean }

export function parseArgs(argv: readonly string[]): StackArgs
export function stackPorts(offset: number): { app: number; api: number }
export function devDirName(offset: number): string
export function codespaceOrigin(env: Env, port: number): string | null
export function appOrigin(env: Env, port: number): string
export function codespaceAllowedHosts(env: Env): string[]
export function apiPortFromEnv(env: Env): number
export function isStackCommandLine(cmdline: string): boolean
export function apiEnv(base: Env, stack: { apiPort: number; appPort: number; devDir: string }): Env
