// Types for stack-process.mjs (plain JavaScript, used by scripts/dev/stack.mjs before anything is
// compiled), for scripts/dev/sql.ts. Keep in step with stack-process.mjs.
export function readStackPid(pidFile: string): { pid: number; startedAt?: string } | null
export function isStackProcess(pid: number): boolean
