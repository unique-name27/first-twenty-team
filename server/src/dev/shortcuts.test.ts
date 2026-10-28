// npm run sql's shortcuts (scripts/dev/sql-lib.ts) on the sample company, through the same read-only path
// the dev route and the no-stack reader use (readonly.ts). It lives here, not beside sql-lib.ts, because it
// needs a database: tests under scripts/ never load server code (scripts/test/tiers.ts).
import '@/store/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSampleDB } from '@/data/seed'
import { DEFAULT_WORKSPACE, formatTable, parseSqlArgs, requestFor, SHORTCUTS, type ShortcutName } from '../../../scripts/dev/sql-lib'
import type { Db } from '../db'
import { replaceWorkspace } from '../repo'
import { makeTestDb } from '../test/helpers'
import { parseWorkspace } from '../validate'
import { runReadOnly } from './readonly'
import { checkStatement } from './statement'

describe('the shortcuts', () => {
  it('are each one statement that reads, for one company ($1)', () => {
    for (const [name, s] of Object.entries(SHORTCUTS)) expect(checkStatement(s.sql), name).toMatchObject({ ok: true, kind: 'cursor', placeholders: 1 })
  })

  describe('on the sample company', () => {
    const ANCHOR = '2026-10-09'
    let db: Db
    beforeAll(async () => {
      db = await makeTestDb()
      await replaceWorkspace(db, parseWorkspace({ db: buildSampleDB(), confirmReplace: true }), null, DEFAULT_WORKSPACE)
    })
    afterAll(async () => {
      await db.close()
    })

    const run = (name: ShortcutName) => runReadOnly(db, requestFor(parseSqlArgs([name, '--today', ANCHOR]), DEFAULT_WORKSPACE))

    it('all run, and the sample has rows for each but integrity, which is clean', async () => {
      for (const name of Object.keys(SHORTCUTS) as ShortcutName[]) {
        const answer = await run(name)
        expect(answer.truncated, name).toBe(false)
        if (name === 'integrity') expect(answer.rows, name).toEqual([])
        else expect(answer.rows.length, name).toBeGreaterThan(0)
      }
    })

    it('read hires as one row per hire, with the columns the table prints', async () => {
      const hires = await run('hires')
      expect(hires.columns.map((c) => c.name)).toEqual(['employee_no', 'person_name', 'job_title', 'source', 'applied_on', 'offer_accepted_on', 'start_date', 'days_to_hire', 'tasks_done', 'tasks', 'first_payday'])
      expect(hires.rows).toHaveLength(16)
      expect(formatTable(hires).split('\n')).toHaveLength(18)
    })

    it('read nothing of another company', async () => {
      const other = await runReadOnly(db, requestFor(parseSqlArgs(['people']), 'no-such-company'))
      expect(other.rows).toEqual([])
    })
  })
})
