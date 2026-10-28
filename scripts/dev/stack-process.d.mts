// Types for stack-process.mjs (plain JavaScript, used by scripts/dev/stack.mjs before anything is
// compiled), for scripts/dev/sql.ts and scripts/dev/sim.ts. Keep in step with stack-process.mjs.
export function readStackPid(pidFile: string): { pid: number; startedAt?: string; holder?: string } | null
export function isStackProcess(pid: number): boolean
