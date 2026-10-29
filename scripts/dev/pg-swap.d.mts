// Types for pg-swap.mjs (plain JavaScript, used by scripts/dev/stack.mjs before anything is compiled), for
// scripts/dev/sim.ts. Keep in step with pg-swap.mjs.
export function workFolder(dir: string, pid: number): string
export function copyToWork(dir: string, pid: number): string
export function swapIn(dir: string, pid: number): void
export function discardWork(dir: string, pid: number): void
export function recoverSimFolders(dir: string): string[]
