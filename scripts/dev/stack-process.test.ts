// The stack's lock (stack-process.mjs): npm run stack and npm run sim both create the pid file only if there
// is none, so two of them starting at the same moment cannot both hold one data folder.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPidFile, readStackPid } from './stack-process.mjs'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ft-stack-pid-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('createPidFile', () => {
  it('writes the file when there is none', () => {
    const file = path.join(dir, 'stack.pid')
    expect(createPidFile(file, { pid: 11, holder: 'npm run sim' })).toBeNull()
    expect(readStackPid(file)).toEqual({ pid: 11, holder: 'npm run sim' })
  })

  it('never overwrites one that is there, and says who holds it', () => {
    const file = path.join(dir, 'stack.pid')
    createPidFile(file, { pid: 11, ports: { app: 8826 } })
    expect(createPidFile(file, { pid: 22, holder: 'npm run sim' })).toEqual({ held: { pid: 11, ports: { app: 8826 } } })
    writeFileSync(file, 'not json')
    expect(createPidFile(file, { pid: 22 })).toEqual({ held: null })
    expect(readFileSync(file, 'utf8')).toBe('not json')
  })
})
