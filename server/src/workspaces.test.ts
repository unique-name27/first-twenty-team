// Companies on one server (workspaces.ts) at the repository level: slugs (never handed out twice, and not
// guessable for demo companies), sign-up, invites, the demo limits (records, bytes, the change log, each
// company's own seqs) and expiry, and the daily housekeeping. HTTP behaviour and tenant isolation:
// tenants.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { blankDB } from '@/data/blank'
import { RECORD_COLLECTIONS, tableName } from '../../src/sync/collections'
import { hashToken, upsertAdmin } from './auth'
import type { Db } from './db'
import { housekeeping } from './housekeeping'
import { afterRestore, applyChanges, changesSince, pruneChangeLogs, replaceWorkspace, snapshot, workspaceStatus } from './repo'
import { WORKSPACE_ID } from './sqlgen'
import { makeTestDb, resetDb } from './test/helpers'
import { LIMITS, parseChanges, parseWorkspace } from './validate'
import {
  acceptInvite,
  careersOn,
  companyName,
  createCompany,
  createInvite,
  deleteDemoWorkspace,
  demoSlug,
  expireDemoWorkspaces,
  findWorkspaceBySlug,
  INVITE_DAYS,
  inviteInfo,
  isValidSlug,
  MAX_INVITE_REFUSALS,
  MAX_LOGINS_PER_WORKSPACE,
  MAX_OPEN_INVITES,
  openInvites,
  PENDING_SIGNUP_HOURS,
  pickSlug,
  PLACEHOLDER_SLUG,
  purgeInvites,
  randomSlugSuffix,
  RESERVED_SLUGS,
  revokeInvite,
  SLUG_SUFFIX_LENGTH,
  slugBase,
  slugCandidate,
  UNUSED_SIGNUP_HOURS,
  workspaceInfo,
} from './workspaces'

describe('slugs', () => {
  it('turn a company name into lowercase a-z, 0-9 and single dashes, at most 40 characters', () => {
    expect(slugBase('Ledgerlark, Inc.')).toBe('ledgerlark-inc')
    expect(slugBase('  --Spaced   out, punctuated!! Co.--  ')).toBe('spaced-out-punctuated-co')
    expect(slugBase('Société Générale')).toBe('societe-generale')
    expect(slugBase('ACME 2026')).toBe('acme-2026')
    expect(slugBase('x'.repeat(39) + ' yz')).toBe('x'.repeat(39))
    expect(slugBase('a'.repeat(60))).toHaveLength(40)
  })

  it("fall back to 'company' when fewer than 3 characters are left", () => {
    for (const name of ['', 'X', 'AB', '!!!', '日本語', '--a--']) expect(slugBase(name), name).toBe('company')
  })

  it('number repeats -2, -3 ..., shortened to fit 40 characters, and skip reserved slugs', () => {
    expect(slugCandidate('acme', 1)).toBe('acme')
    expect(slugCandidate('acme', 2)).toBe('acme-2')
    expect(slugCandidate('a'.repeat(40), 12)).toBe(`${'a'.repeat(37)}-12`)
    // A cut that would end in a dash drops it.
    expect(slugCandidate(`${'a'.repeat(37)}-bc`, 2)).toBe(`${'a'.repeat(37)}-2`)
    expect(pickSlug('acme', new Set(['acme', 'acme-2']))).toBe('acme-3')
    for (const reserved of RESERVED_SLUGS) expect(pickSlug(reserved, new Set()), reserved).toBe(`${reserved}-2`)
    expect(RESERVED_SLUGS).toContain('assets') // the careers pages' own path
  })

  it('give a demo company its base and a random ending, shortened to fit 40 characters', () => {
    const suffix = randomSlugSuffix()
    expect(suffix).toMatch(new RegExp(`^[a-km-np-z2-9]{${SLUG_SUFFIX_LENGTH}}$`))
    expect(new Set(Array.from({ length: 200 }, randomSlugSuffix)).size).toBeGreaterThan(195)
    expect(demoSlug('acme', 'k7m2qx')).toBe('acme-k7m2qx')
    expect(demoSlug('a'.repeat(40), 'k7m2qx')).toBe(`${'a'.repeat(33)}-k7m2qx`)
    expect(demoSlug(`${'a'.repeat(32)}-bc`, 'k7m2qx')).toBe(`${'a'.repeat(32)}-k7m2qx`)
    // Reserved words are only ever a base: with an ending they are no longer reserved.
    for (const reserved of RESERVED_SLUGS) expect(RESERVED_SLUGS).not.toContain(demoSlug(reserved, suffix))
  })

  it('are always valid', () => {
    for (const name of ['Ledgerlark, Inc.', 'X', 'a'.repeat(80), 'Société', '1-2-3', 'assets']) {
      for (let n = 1; n < 12; n++) expect(isValidSlug(slugCandidate(slugBase(name), n)), `${name} ${n}`).toBe(true)
      for (let n = 0; n < 12; n++) expect(isValidSlug(demoSlug(slugBase(name), randomSlugSuffix())), `${name} demo`).toBe(true)
    }
    for (const bad of ['ab', 'Abc', '-abc', 'abc-', 'a b c', 'a'.repeat(41), 'a.b.c', 42]) expect(isValidSlug(bad), String(bad)).toBe(false)
  })
})

describe('company names', () => {
  it('are 2 to 80 characters of printable text, trimmed, with runs of spaces made one', () => {
    expect(companyName('  Acme   Robotics  ')).toBe('Acme Robotics')
    expect(companyName('AB')).toBe('AB')
    expect(companyName('x'.repeat(80))).toHaveLength(80)
    for (const bad of ['A', ' ', 'x'.repeat(81), 'Bad\u0000name', 'Bad\u0007name', 'Bad\u009bname', 42, null]) {
      expect(companyName(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('companies on one server', () => {
  let db: Db
  beforeAll(async () => {
    db = await makeTestDb()
  })
  afterAll(async () => {
    await db.close()
  })
  beforeEach(async () => {
    await resetDb(db)
  })

  const login = (email: string) => ({ email, passwordHash: 'scrypt$test' })
  const company = (name: string) => parseWorkspace({ db: blankDB({ companyName: name, founderFirstName: 'A', founderLastName: 'B', foundedOn: '2026-01-05' }) })
  const job = (id: string, baseVersion: number | null = null) => ({ collection: 'jobs', id, op: 'upsert', data: { id, title: id }, baseVersion })
  async function demo(email: string, name: string) {
    const r = await createCompany(db, login(email), name, 100)
    if (!r.ok) throw new Error(r.reason)
    return r
  }

  it('signs up a demo company: an empty workspace that is not kept, its slug, its careers page on, and its first login, an admin', async () => {
    const r = await demo('Founder@example.com'.toLowerCase(), 'Acme Robotics')
    expect(r.workspace).toEqual({ id: expect.stringMatching(/^w-[0-9a-f]{24}$/), name: 'Acme Robotics', slug: expect.stringMatching(/^acme-robotics-[a-z2-9]{6}$/) })
    expect(r.user).toEqual({ id: expect.any(String), email: 'founder@example.com', role: 'admin', workspaceId: r.workspace.id })
    const row = await db.query<Record<string, unknown>>(`SELECT keep, careers, created_by::text AS created_by, initialized_at FROM workspaces WHERE id = $1`, [r.workspace.id])
    expect(row.rows).toEqual([{ keep: false, careers: true, created_by: r.user.id, initialized_at: null }])
    expect(await careersOn(db, r.workspace.id)).toBe(true)
    // The owner's own workspace keeps its careers page off until an admin turns it on.
    expect(await careersOn(db, WORKSPACE_ID)).toBe(false)
    expect(await workspaceStatus(db, r.workspace.id)).toEqual({ empty: true })
    expect(await findWorkspaceBySlug(db, r.workspace.slug)).toEqual(r.workspace)
    expect(await findWorkspaceBySlug(db, 'acme-robotics')).toBeNull()
    expect(await findWorkspaceBySlug(db, r.workspace.slug.toUpperCase())).toBeNull()
    expect(await findWorkspaceBySlug(db, "acme'; --")).toBeNull()
  })

  it('names a company by its company document once uploaded (the slug stays)', async () => {
    const r = await demo('a@example.com', 'Acme')
    await replaceWorkspace(db, company('Acme Renamed Inc.'), r.user.id, r.workspace.id)
    expect(await workspaceInfo(db, r.workspace.id)).toEqual({ id: r.workspace.id, name: 'Acme Renamed Inc.', slug: r.workspace.slug })
  })

  it("gives each company a slug of its own that says nothing about other companies' names", async () => {
    const names = ['Acme', 'Acme', 'ACME!', 'Assets', 'X', 'Default Workspace']
    const slugs = []
    for (const [i, name] of names.entries()) slugs.push((await demo(`u${i}@example.com`, name)).workspace.slug)
    expect(new Set(slugs).size).toBe(names.length)
    const bases = ['acme', 'acme', 'acme', 'assets', 'company', 'default-workspace']
    slugs.forEach((slug, i) => expect(slug, names[i]).toMatch(new RegExp(`^${bases[i]}-[a-z2-9]{6}$`)))
    // The second Acme's slug has the same shape as the first's: a sign-up cannot tell a name is taken.
    expect(slugs[1].length).toBe(slugs[0].length)
    // Nobody finds a company by guessing its name.
    for (const guess of ['acme', 'acme-2', 'assets-2', 'company']) expect(await findWorkspaceBySlug(db, guess), guess).toBeNull()
  })

  it('never hands out the slug of a company that was deleted, so its old careers links never reach a newcomer', async () => {
    const bravo = await demo('b@bravo.test', 'Bravo Co')
    await replaceWorkspace(db, company('Bravo Co'), bravo.user.id, bravo.workspace.id)
    await db.query(`UPDATE workspaces SET last_active_at = now() - interval '31 days' WHERE id = $1`, [bravo.workspace.id])
    expect(await expireDemoWorkspaces(db, 30)).toBe(1)
    const released = await db.query<{ slug: string }>('SELECT slug FROM released_slugs')
    expect(released.rows).toEqual([{ slug: bravo.workspace.slug }])
    // Whoever signs up next under the same name, however often, never gets it.
    for (let i = 0; i < 20; i++) {
      const again = await demo(`mallory${i}@evil.test`, 'Bravo Co')
      expect(again.workspace.slug).not.toBe(bravo.workspace.slug)
    }
    expect(await findWorkspaceBySlug(db, bravo.workspace.slug)).toBeNull()
    // A deleted company's slug is also skipped by the owner's first upload (a name base, not an ending).
    await db.query(`INSERT INTO released_slugs (slug) VALUES ('owner-co')`)
    await replaceWorkspace(db, company('Owner Co'), null, WORKSPACE_ID)
    expect((await workspaceInfo(db, WORKSPACE_ID))?.slug).toBe('owner-co-2')
  })

  it("names the owner's workspace after its company on the first upload, while it still has the placeholder slug", async () => {
    expect((await workspaceInfo(db, WORKSPACE_ID))?.slug).toBe(PLACEHOLDER_SLUG)
    await replaceWorkspace(db, company('Acme Rockets'), null, WORKSPACE_ID)
    expect((await workspaceInfo(db, WORKSPACE_ID))?.slug).toBe('acme-rockets')
    // Later uploads (Import, Start fresh) and renames keep it: links already shared keep working.
    await replaceWorkspace(db, parseWorkspace({ db: blankDB({ companyName: 'Other Name', founderFirstName: 'A', founderLastName: 'B', foundedOn: '2026-01-05' }), confirmReplace: true }), null, WORKSPACE_ID)
    expect((await workspaceInfo(db, WORKSPACE_ID))?.slug).toBe('acme-rockets')
    // A demo company's first upload never changes its slug.
    const d = await demo('d@example.com', 'Demo')
    await replaceWorkspace(db, company('Totally Different'), d.user.id, d.workspace.id)
    expect((await workspaceInfo(db, d.workspace.id))?.slug).toBe(d.workspace.slug)
  })

  it('refuses an email that has a login anywhere on the server, and creates nothing', async () => {
    await upsertAdmin(db, 'owner@example.com', 'owner-password-1234')
    await demo('taken@example.com', 'First')
    const before = (await db.query('SELECT id FROM workspaces')).rows.length
    expect(await createCompany(db, login('taken@example.com'), 'Second', 100)).toEqual({ ok: false, reason: 'email_taken' })
    expect(await createCompany(db, login('owner@example.com'), 'Third', 100)).toEqual({ ok: false, reason: 'email_taken' })
    expect((await db.query('SELECT id FROM workspaces')).rows).toHaveLength(before)
  })

  it('stops at maxDemoWorkspaces demo companies; kept workspaces do not count', async () => {
    const one = await demo('one@example.com', 'One')
    await demo('two@example.com', 'Two')
    expect(await createCompany(db, login('three@example.com'), 'Three', 2)).toEqual({ ok: false, reason: 'demo_full' })
    expect((await db.query(`SELECT 1 FROM users WHERE email = 'three@example.com'`)).rows).toEqual([])
    // The owner's workspace is kept: two demo companies, two allowed... one more once one goes.
    await db.query(`DELETE FROM workspaces WHERE id = $1`, [one.workspace.id])
    expect((await createCompany(db, login('three@example.com'), 'Three', 2)).ok).toBe(true)
  })

  it('counts a sign-up that never uploaded only for its first hour, so empty sign-ups cannot fill the server', async () => {
    const empty = []
    for (let i = 0; i < 3; i++) empty.push(await demo(`empty${i}@example.com`, `Empty ${i}`))
    expect(await createCompany(db, login('late@example.com'), 'Late', 3)).toEqual({ ok: false, reason: 'demo_full' })
    // An hour on, still not uploaded: they hold no place.
    await db.query(`UPDATE workspaces SET created_at = now() - make_interval(hours => $1::int) - interval '1 minute' WHERE NOT keep`, [PENDING_SIGNUP_HOURS])
    expect((await createCompany(db, login('late@example.com'), 'Late', 3)).ok).toBe(true)
    // Uploaded companies count however old they are.
    for (const e of empty) await replaceWorkspace(db, company('Up'), e.user.id, e.workspace.id)
    expect(await createCompany(db, login('later@example.com'), 'Later', 3)).toEqual({ ok: false, reason: 'demo_full' })
  })

  describe('invites', () => {
    it('make a single-use link stored as a hash, working for INVITE_DAYS, that joins its own company', async () => {
      const r = await demo('admin@acme.test', 'Acme')
      const invite = await createInvite(db, r.workspace.id, r.user.id)
      if (!invite.ok) throw new Error('no invite')
      expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const stored = await db.query<{ token_hash: string; days: number }>(
        `SELECT token_hash, round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days FROM invites`,
      )
      expect(stored.rows).toEqual([{ token_hash: hashToken(invite.token), days: INVITE_DAYS }])
      expect(Date.parse(invite.expiresAt) - Date.now()).toBeGreaterThan((INVITE_DAYS - 1) * 86_400_000)
      expect(await inviteInfo(db, invite.token)).toEqual(r.workspace)

      const joined = await acceptInvite(db, invite.token, login('teammate@acme.test'))
      expect(joined).toEqual({ ok: true, user: expect.objectContaining({ email: 'teammate@acme.test', role: 'admin', workspaceId: r.workspace.id }), workspace: r.workspace })
      // Used: it works no more.
      expect(await inviteInfo(db, invite.token)).toBeNull()
      expect(await acceptInvite(db, invite.token, login('second@acme.test'))).toEqual({ ok: false, reason: 'invalid_invite' })
      const used = await db.query<{ used_by: string }>(`SELECT used_by::text AS used_by FROM invites WHERE used_at IS NOT NULL`)
      expect(used.rows).toEqual([{ used_by: joined.ok ? joined.user.id : '' }])
    })

    it('refuse a malformed, unknown or expired token before looking at the email', async () => {
      const r = await demo('admin@acme.test', 'Acme')
      const invite = await createInvite(db, r.workspace.id, r.user.id)
      if (!invite.ok) throw new Error('no invite')
      for (const token of [undefined, '', 'short', `${invite.token}x`, 'A'.repeat(43), 42]) {
        expect(await inviteInfo(db, token), String(token)).toBeNull()
        // admin@acme.test has a login: a bad token says nothing about that.
        expect(await acceptInvite(db, token, login('admin@acme.test')), String(token)).toEqual({ ok: false, reason: 'invalid_invite' })
      }
      expect(await acceptInvite(db, invite.token, login('admin@acme.test'))).toEqual({ ok: false, reason: 'email_taken' })
      expect(await inviteInfo(db, invite.token)).not.toBeNull() // still unused
      await db.query(`UPDATE invites SET expires_at = now() - interval '1 second'`)
      expect(await inviteInfo(db, invite.token)).toBeNull()
      expect(await acceptInvite(db, invite.token, login('late@acme.test'))).toEqual({ ok: false, reason: 'invalid_invite' })
    })

    it(`keep at most ${MAX_OPEN_INVITES} open per company, and ${MAX_LOGINS_PER_WORKSPACE} logins counting open invites`, async () => {
      const r = await demo('admin@acme.test', 'Acme')
      for (let i = 0; i < MAX_OPEN_INVITES; i++) expect((await createInvite(db, r.workspace.id, r.user.id)).ok).toBe(true)
      const refused = await createInvite(db, r.workspace.id, r.user.id)
      expect(refused).toEqual({ ok: false, reason: 'too_many_invites', retryAfter: expect.any(Number) })
      expect(refused.ok ? 0 : refused.retryAfter).toBeGreaterThan((INVITE_DAYS - 1) * 86_400)
      // Another company is not affected.
      const other = await demo('admin@other.test', 'Other')
      expect((await createInvite(db, other.workspace.id, other.user.id)).ok).toBe(true)
      // Expired ones free their place.
      await db.query(`UPDATE invites SET expires_at = now() - interval '1 second' WHERE workspace_id = $1`, [r.workspace.id])
      expect((await createInvite(db, r.workspace.id, r.user.id)).ok).toBe(true)
      // Logins: fill the company up to the cap, counting the one open invite.
      await db.query(
        `INSERT INTO users (email, password_hash, workspace_id) SELECT 'filler' || g || '@acme.test', 'x', $1 FROM generate_series(1, $2::int) g`,
        [r.workspace.id, MAX_LOGINS_PER_WORKSPACE - 2],
      )
      expect(await createInvite(db, r.workspace.id, r.user.id)).toEqual({ ok: false, reason: 'too_many_logins', retryAfter: expect.any(Number) })
    })

    it(`stop working after ${MAX_INVITE_REFUSALS} tries with emails that have a login, so one link cannot test email after email`, async () => {
      const r = await demo('admin@acme.test', 'Acme')
      await upsertAdmin(db, 'owner@example.com', 'owner-password-1234')
      const invite = await createInvite(db, r.workspace.id, r.user.id)
      if (!invite.ok) throw new Error('no invite')
      const taken = ['admin@acme.test', 'owner@example.com', 'admin@acme.test']
      for (const email of taken.slice(0, MAX_INVITE_REFUSALS)) expect(await acceptInvite(db, invite.token, login(email))).toEqual({ ok: false, reason: 'email_taken' })
      // Used up: even a fresh email (the real teammate) is refused now, as for any used link.
      expect(await inviteInfo(db, invite.token)).toBeNull()
      expect(await acceptInvite(db, invite.token, login('fresh@acme.test'))).toEqual({ ok: false, reason: 'invalid_invite' })
      expect(await openInvites(db, r.workspace.id)).toEqual([])
      // One refusal fewer leaves the link working.
      const second = await createInvite(db, r.workspace.id, r.user.id)
      if (!second.ok) throw new Error('no invite')
      for (let i = 0; i < MAX_INVITE_REFUSALS - 1; i++) expect((await acceptInvite(db, second.token, login('admin@acme.test'))).ok).toBe(false)
      expect((await acceptInvite(db, second.token, login('fresh@acme.test'))).ok).toBe(true)
    })

    it('are listed for their company without tokens, and can be revoked by their company only', async () => {
      const r = await demo('admin@acme.test', 'Acme')
      const other = await demo('admin@other.test', 'Other')
      const a1 = await createInvite(db, r.workspace.id, r.user.id)
      const a2 = await createInvite(db, r.workspace.id, r.user.id)
      const b1 = await createInvite(db, other.workspace.id, other.user.id)
      if (!a1.ok || !a2.ok || !b1.ok) throw new Error('no invite')
      const listed = await openInvites(db, r.workspace.id)
      expect(listed).toEqual([
        { id: expect.stringMatching(/^[0-9a-f-]{36}$/), createdAt: expect.any(String), expiresAt: a1.expiresAt, createdBy: 'admin@acme.test' },
        { id: expect.stringMatching(/^[0-9a-f-]{36}$/), createdAt: expect.any(String), expiresAt: a2.expiresAt, createdBy: 'admin@acme.test' },
      ])
      expect(JSON.stringify(listed)).not.toContain(a1.token)
      expect(JSON.stringify(listed)).not.toContain(hashToken(a1.token))
      const otherId = (await openInvites(db, other.workspace.id))[0].id
      // Another company's invite id, a malformed one, or one already revoked: nothing happens.
      expect(await revokeInvite(db, r.workspace.id, otherId)).toBe(false)
      expect(await inviteInfo(db, b1.token)).not.toBeNull()
      for (const bad of ['', 'x', "1' OR '1'='1", 42, null]) expect(await revokeInvite(db, r.workspace.id, bad), String(bad)).toBe(false)
      expect(await revokeInvite(db, r.workspace.id, listed[0].id)).toBe(true)
      expect(await revokeInvite(db, r.workspace.id, listed[0].id)).toBe(false)
      expect(await inviteInfo(db, a1.token)).toBeNull()
      expect(await acceptInvite(db, a1.token, login('late@acme.test'))).toEqual({ ok: false, reason: 'invalid_invite' })
      expect((await openInvites(db, r.workspace.id)).map((i) => i.id)).toEqual([listed[1].id])
    })

    it('are purged a week after they expire', async () => {
      const r = await demo('admin@acme.test', 'Acme')
      await createInvite(db, r.workspace.id, r.user.id)
      await createInvite(db, r.workspace.id, r.user.id)
      await db.query(`UPDATE invites SET expires_at = now() - interval '8 days' WHERE token_hash = (SELECT min(token_hash) FROM invites)`)
      expect(await purgeInvites(db)).toBe(1)
      expect((await db.query('SELECT 1 FROM invites')).rows).toHaveLength(1)
    })
  })

  describe('demo limits', () => {
    it('cap the records a demo company holds (413 workspace_full), but never a kept workspace', async () => {
      const saved = LIMITS.recordsPerDemoWorkspace
      try {
        const r = await demo('admin@acme.test', 'Acme')
        const upload = company('Acme')
        const records = upload.collections.reduce((n, c) => n + c.ids.length, 0)
        LIMITS.recordsPerDemoWorkspace = records + 2
        const up = await replaceWorkspace(db, upload, r.user.id, r.workspace.id)
        const two = await applyChanges(db, parseChanges({ changes: [job('j-1'), job('j-2')] }), r.user.id, { workspaceId: r.workspace.id })
        expect(two.applied).toHaveLength(2)
        await expect(applyChanges(db, parseChanges({ changes: [job('j-3')] }), r.user.id, { workspaceId: r.workspace.id })).rejects.toMatchObject({
          statusCode: 413,
          code: 'workspace_full',
        })
        // Nothing of a refused push lands, and edits and deletes still work.
        const edited = await applyChanges(db, parseChanges({ changes: [job('j-1', two.applied[0].version)] }), r.user.id, { workspaceId: r.workspace.id })
        expect(edited.applied).toHaveLength(1)
        const deleted = await applyChanges(
          db,
          parseChanges({ changes: [{ collection: 'jobs', id: 'j-2', op: 'delete', baseVersion: two.applied[1].version }] }),
          r.user.id,
          { workspaceId: r.workspace.id },
        )
        expect(deleted.applied).toHaveLength(1)
        expect((await applyChanges(db, parseChanges({ changes: [job('j-3')] }), r.user.id, { workspaceId: r.workspace.id })).applied).toHaveLength(1)
        // Full again. One place free: a push that adds, deletes, then adds again fits, since the delete in
        // the middle gives its place back to the second new record.
        const versions = (await snapshot(db, r.workspace.id))!.versions
        await applyChanges(db, parseChanges({ changes: [{ collection: 'jobs', id: 'j-1', op: 'delete', baseVersion: versions['jobs:j-1'] }] }), r.user.id, {
          workspaceId: r.workspace.id,
        })
        const swapped = await applyChanges(
          db,
          parseChanges({ changes: [job('j-a'), { collection: 'jobs', id: 'j-3', op: 'delete', baseVersion: versions['jobs:j-3'] }, job('j-b')] }),
          r.user.id,
          { workspaceId: r.workspace.id },
        )
        expect(swapped.applied.map((x) => x.id)).toEqual(['j-a', 'j-3', 'j-b'])
        await expect(applyChanges(db, parseChanges({ changes: [job('j-c')] }), r.user.id, { workspaceId: r.workspace.id })).rejects.toMatchObject({
          code: 'workspace_full',
        })
        // An upload over the cap is refused whole.
        LIMITS.recordsPerDemoWorkspace = records - 1
        await expect(replaceWorkspace(db, parseWorkspace({ db: blankDB({ companyName: 'Acme', founderFirstName: 'A', founderLastName: 'B', foundedOn: '2026-01-05' }), confirmReplace: true }), r.user.id, r.workspace.id)).rejects.toMatchObject({ statusCode: 413, code: 'workspace_full' })
        expect((await snapshot(db, r.workspace.id))?.historyId).toBe(up.historyId)
        // The owner's workspace has no such cap.
        await replaceWorkspace(db, company('Owner'), null, WORKSPACE_ID)
        expect((await applyChanges(db, parseChanges({ changes: [job('j-o1'), job('j-o2')] }), null)).applied).toHaveLength(2)
      } finally {
        LIMITS.recordsPerDemoWorkspace = saved
      }
    })

    it('mark a demo company in use on every write, except writes made with markActive: false', async () => {
      const r = await demo('admin@acme.test', 'Acme')
      const age = async () =>
        Number((await db.query<{ age: unknown }>(`SELECT extract(epoch FROM now() - last_active_at) AS age FROM workspaces WHERE id = $1`, [r.workspace.id])).rows[0].age)
      const makeOld = () => db.query(`UPDATE workspaces SET last_active_at = now() - interval '10 days' WHERE id = $1`, [r.workspace.id])
      await makeOld()
      await replaceWorkspace(db, company('Acme'), r.user.id, r.workspace.id)
      expect(await age()).toBeLessThan(60)
      await makeOld()
      await applyChanges(db, parseChanges({ changes: [job('j-careers')] }), null, { workspaceId: r.workspace.id, markActive: false })
      expect(await age()).toBeGreaterThan(9 * 86_400)
      // A push that changes nothing is not a write.
      await applyChanges(db, parseChanges({ changes: [] }), r.user.id, { workspaceId: r.workspace.id })
      expect(await age()).toBeGreaterThan(9 * 86_400)
      await applyChanges(db, parseChanges({ changes: [job('j-1')] }), r.user.id, { workspaceId: r.workspace.id })
      expect(await age()).toBeLessThan(60)
    })

    it('prune a demo company change log past its cap, and only the age limit for a kept workspace', async () => {
      const saved = LIMITS.logRowsPerDemoWorkspace
      try {
        LIMITS.logRowsPerDemoWorkspace = 5
        const r = await demo('admin@acme.test', 'Acme')
        const up = await replaceWorkspace(db, company('Acme'), r.user.id, r.workspace.id)
        await replaceWorkspace(db, company('Owner'), null, WORKSPACE_ID)
        const ownerRows = Number((await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM change_log WHERE workspace_id = $1`, [WORKSPACE_ID])).rows[0].n)
        expect(ownerRows).toBeGreaterThan(5)
        await pruneChangeLogs(db, 120)
        const rows = await db.query<{ workspace_id: string; n: unknown }>('SELECT workspace_id, count(*) AS n FROM change_log GROUP BY workspace_id')
        const counts = Object.fromEntries(rows.rows.map((row) => [row.workspace_id, Number(row.n)]))
        expect(counts).toEqual({ [r.workspace.id]: 5, [WORKSPACE_ID]: ownerRows })
        // A browser whose since is older than what was pruned resyncs.
        expect(await changesSince(db, up.seq - 10, { workspaceId: r.workspace.id })).toEqual({ resync: true })
      } finally {
        LIMITS.logRowsPerDemoWorkspace = saved
      }
    })
  })

  describe('demo bytes and the change log', () => {
    const MB = 1024 * 1024
    /** A job record of about `kb` KB of text that does not compress. */
    const bigJob = (id: string, kb: number, baseVersion: number | null = null) => ({
      collection: 'jobs',
      id,
      op: 'upsert',
      data: { id, title: id, description: Array.from({ length: kb * 100 }, (_, i) => `${i.toString(36)}${Math.random().toString(36).slice(2, 12)}`).join(' ').slice(0, kb * 1024) },
      baseVersion,
    })
    const bytesUsed = async (id: string) => Number((await db.query<{ n: unknown }>('SELECT bytes_used AS n FROM workspaces WHERE id = $1', [id])).rows[0].n)
    const logRows = async (id: string) => Number((await db.query<{ n: unknown }>('SELECT count(*) AS n FROM change_log WHERE workspace_id = $1', [id])).rows[0].n)

    it('keep count of the bytes a company holds, through uploads, edits and deletes', async () => {
      const r = await demo('admin@acme.test', 'Acme')
      await replaceWorkspace(db, company('Acme'), r.user.id, r.workspace.id)
      const measured = async () =>
        Number(
          (
            await db.query<{ n: unknown }>(
              `SELECT ${['workspace_docs', ...RECORD_COLLECTIONS.map(tableName)].map((t) => `(SELECT coalesce(sum(octet_length(data::text)), 0) FROM ${t} WHERE workspace_id = $1)`).join(' + ')} AS n`,
              [r.workspace.id],
            )
          ).rows[0].n,
        )
      expect(await bytesUsed(r.workspace.id)).toBe(await measured())
      const added = await applyChanges(db, parseChanges({ changes: [bigJob('j-1', 20), bigJob('j-2', 10)] }), r.user.id, { workspaceId: r.workspace.id })
      expect(await bytesUsed(r.workspace.id)).toBe(await measured())
      await applyChanges(db, parseChanges({ changes: [bigJob('j-1', 2, added.applied[0].version), { collection: 'jobs', id: 'j-2', op: 'delete', baseVersion: added.applied[1].version }] }), r.user.id, {
        workspaceId: r.workspace.id,
      })
      expect(await bytesUsed(r.workspace.id)).toBe(await measured())
      // A company whose count was lost (NULL) is counted again on its next write.
      await db.query('UPDATE workspaces SET bytes_used = NULL WHERE id = $1', [r.workspace.id])
      await applyChanges(db, parseChanges({ changes: [job('j-3')] }), r.user.id, { workspaceId: r.workspace.id })
      expect(await bytesUsed(r.workspace.id)).toBe(await measured())
    })

    it(`hold a demo company to ${LIMITS.bytesPerDemoWorkspace / MB} MB and ${LIMITS.demoRecordBytes / 1024} KB records, and never a kept workspace`, async () => {
      const saved = LIMITS.bytesPerDemoWorkspace
      try {
        const r = await demo('admin@acme.test', 'Acme')
        await replaceWorkspace(db, company('Acme'), r.user.id, r.workspace.id)
        LIMITS.bytesPerDemoWorkspace = (await bytesUsed(r.workspace.id)) + 150 * 1024
        // Records of 50 KB fit, until the budget is used.
        const first = await applyChanges(db, parseChanges({ changes: [bigJob('j-1', 50), bigJob('j-2', 50)] }), r.user.id, { workspaceId: r.workspace.id })
        expect(first.applied).toHaveLength(2)
        await expect(applyChanges(db, parseChanges({ changes: [bigJob('j-3', 50), bigJob('j-4', 50)] }), r.user.id, { workspaceId: r.workspace.id })).rejects.toMatchObject({
          statusCode: 413,
          code: 'workspace_full',
        })
        expect(await logRows(r.workspace.id)).toBe(Object.keys((await snapshot(db, r.workspace.id))!.versions).length)
        // A record over the demo record size is refused whole, even with room to spare.
        LIMITS.bytesPerDemoWorkspace = saved
        await expect(applyChanges(db, parseChanges({ changes: [bigJob('j-big', LIMITS.demoRecordBytes / 1024 + 1)] }), r.user.id, { workspaceId: r.workspace.id })).rejects.toMatchObject({
          statusCode: 413,
          code: 'too_large',
        })
        const upload = company('Acme')
        const big = parseWorkspace({ db: { ...blankDB({ companyName: 'Acme', founderFirstName: 'A', founderLastName: 'B', foundedOn: '2026-01-05' }), jobs: [bigJob('j-big', 70).data] }, confirmReplace: true })
        await expect(replaceWorkspace(db, big, r.user.id, r.workspace.id)).rejects.toMatchObject({ statusCode: 413, code: 'too_large' })
        // Shrinking always works, even over the budget.
        LIMITS.bytesPerDemoWorkspace = 1
        const versions = (await snapshot(db, r.workspace.id))!.versions
        expect((await applyChanges(db, parseChanges({ changes: [{ collection: 'jobs', id: 'j-1', op: 'delete', baseVersion: versions['jobs:j-1'] }] }), r.user.id, { workspaceId: r.workspace.id })).applied).toHaveLength(1)
        const bigger = parseWorkspace({
          db: { ...blankDB({ companyName: 'Acme', founderFirstName: 'A', founderLastName: 'B', foundedOn: '2026-01-05' }), jobs: [bigJob('j-a', 40).data, bigJob('j-b', 40).data] },
          confirmReplace: true,
        })
        await expect(replaceWorkspace(db, bigger, r.user.id, r.workspace.id)).rejects.toMatchObject({ code: 'workspace_full' })
        expect((await replaceWorkspace(db, { ...upload, confirmReplace: true }, r.user.id, r.workspace.id)).seq).toBeGreaterThan(0)
        // The owner's workspace has neither limit.
        await replaceWorkspace(db, company('Owner'), null, WORKSPACE_ID)
        expect((await applyChanges(db, parseChanges({ changes: [bigJob('j-o1', 70), bigJob('j-o2', 70)] }), null)).applied).toHaveLength(2)
      } finally {
        LIMITS.bytesPerDemoWorkspace = saved
      }
    })

    it('hold the demo companies together to their total, so they cannot fill the disk the owner lives on', async () => {
      const a = await demo('a@a.test', 'Alpha')
      const b = await demo('b@b.test', 'Bravo')
      await replaceWorkspace(db, company('Alpha'), a.user.id, a.workspace.id)
      const total = (await bytesUsed(a.workspace.id)) * 2 + 60 * 1024
      await replaceWorkspace(db, company('Bravo'), b.user.id, b.workspace.id, { demoTotalBytes: total })
      expect((await applyChanges(db, parseChanges({ changes: [bigJob('j-1', 40)] }), a.user.id, { workspaceId: a.workspace.id, demoTotalBytes: total })).applied).toHaveLength(1)
      await expect(applyChanges(db, parseChanges({ changes: [bigJob('j-2', 40)] }), b.user.id, { workspaceId: b.workspace.id, demoTotalBytes: total })).rejects.toMatchObject({
        statusCode: 413,
        code: 'workspace_full',
      })
      // Kept workspaces neither count nor are held to it.
      await replaceWorkspace(db, company('Owner'), null, WORKSPACE_ID, { demoTotalBytes: total })
      expect((await applyChanges(db, parseChanges({ changes: [bigJob('j-o', 40)] }), null, { demoTotalBytes: total })).applied).toHaveLength(1)
    })

    it('keep one copy per record in a demo company change log, however often it is edited', async () => {
      const r = await demo('admin@acme.test', 'Acme')
      await replaceWorkspace(db, company('Acme'), r.user.id, r.workspace.id)
      const before = await logRows(r.workspace.id)
      let version: number | null = null
      for (let i = 0; i < 30; i++) {
        const res = await applyChanges(db, parseChanges({ changes: [{ ...bigJob('j-1', 4, version), data: { id: 'j-1', title: `edit ${i}` } }] }), r.user.id, { workspaceId: r.workspace.id })
        version = res.applied[0].version
      }
      expect(await logRows(r.workspace.id)).toBe(before + 1)
      const rows = await db.query<{ data: { title: string } }>(`SELECT data FROM change_log WHERE workspace_id = $1 AND record_id = 'j-1'`, [r.workspace.id])
      expect(rows.rows.map((x) => x.data.title)).toEqual(['edit 29'])
      // A delete and a re-create leave one row too.
      await applyChanges(db, parseChanges({ changes: [{ collection: 'jobs', id: 'j-1', op: 'delete', baseVersion: version }] }), r.user.id, { workspaceId: r.workspace.id })
      await applyChanges(db, parseChanges({ changes: [job('j-1')] }), r.user.id, { workspaceId: r.workspace.id })
      expect(await logRows(r.workspace.id)).toBe(before + 1)
      // The owner's workspace keeps every copy (its retries can find the copy that landed).
      await replaceWorkspace(db, company('Owner'), null, WORKSPACE_ID)
      const ownerBefore = await logRows(WORKSPACE_ID)
      let v: number | null = null
      for (let i = 0; i < 3; i++) v = (await applyChanges(db, parseChanges({ changes: [{ collection: 'jobs', id: 'j-o', op: 'upsert', data: { id: 'j-o', title: `e${i}` }, baseVersion: v }] }), null)).applied[0].version
      expect(await logRows(WORKSPACE_ID)).toBe(ownerBefore + 3)
    })

    it('prune a demo company change log past its cap in the write that passes it, not a day later', async () => {
      const saved = LIMITS.logRowsPerDemoWorkspace
      try {
        const r = await demo('admin@acme.test', 'Acme')
        const up = await replaceWorkspace(db, company('Acme'), r.user.id, r.workspace.id)
        LIMITS.logRowsPerDemoWorkspace = (await logRows(r.workspace.id)) + 5
        // Creates and deletes: each delete leaves a row of its own.
        for (let i = 0; i < 10; i++) {
          const made = await applyChanges(db, parseChanges({ changes: [job(`j-${i}`)] }), r.user.id, { workspaceId: r.workspace.id })
          await applyChanges(db, parseChanges({ changes: [{ collection: 'jobs', id: `j-${i}`, op: 'delete', baseVersion: made.applied[0].version }] }), r.user.id, { workspaceId: r.workspace.id })
          expect(await logRows(r.workspace.id)).toBeLessThanOrEqual(LIMITS.logRowsPerDemoWorkspace)
        }
        // The pruned rows are marked, so browsers behind them resync; the newest rows still pull.
        expect(Number((await db.query<{ n: unknown }>('SELECT pruned_seq AS n FROM workspaces WHERE id = $1', [r.workspace.id])).rows[0].n)).toBeGreaterThan(0)
        expect(await changesSince(db, up.seq, { workspaceId: r.workspace.id })).toMatchObject({ changes: expect.any(Array) })
      } finally {
        LIMITS.logRowsPerDemoWorkspace = saved
      }
    })

    it('stop a pull page at its byte budget, always with at least one change', async () => {
      const r = await demo('admin@acme.test', 'Acme')
      const up = await replaceWorkspace(db, company('Acme'), r.user.id, r.workspace.id)
      await applyChanges(db, parseChanges({ changes: [bigJob('j-1', 30), bigJob('j-2', 30), bigJob('j-3', 30)] }), r.user.id, { workspaceId: r.workspace.id })
      const page1 = await changesSince(db, up.seq, { workspaceId: r.workspace.id, maxBytes: 40 * 1024 })
      if (!('changes' in page1)) throw new Error('resync')
      expect(page1.changes.map((c) => c.id)).toEqual(['j-1', 'j-2'])
      expect(page1.more).toBe(true)
      expect(page1.seq).toBe(page1.changes[1].seq)
      const page2 = await changesSince(db, page1.seq, { workspaceId: r.workspace.id, maxBytes: 1 })
      if (!('changes' in page2)) throw new Error('resync')
      expect(page2.changes.map((c) => c.id)).toEqual(['j-3'])
      expect(page2.more).toBeUndefined()
    })

    it("count each company's seqs on their own, so no company can count another's writes", async () => {
      const a = await demo('a@a.test', 'Alpha')
      const b = await demo('b@b.test', 'Bravo')
      const upA = await replaceWorkspace(db, company('Alpha'), a.user.id, a.workspace.id)
      const upB = await replaceWorkspace(db, company('Bravo'), b.user.id, b.workspace.id)
      // Both start from nothing: B's upload did not move past A's numbers.
      expect(upB.seq).toBe(upA.seq)
      const one = await applyChanges(db, parseChanges({ changes: [job('j-a1')] }), a.user.id, { workspaceId: a.workspace.id })
      for (let i = 0; i < 37; i++) await applyChanges(db, parseChanges({ changes: [job(`j-b${i}`)] }), b.user.id, { workspaceId: b.workspace.id })
      await replaceWorkspace(db, company('Owner'), null, WORKSPACE_ID)
      const two = await applyChanges(db, parseChanges({ changes: [job('j-a2')] }), a.user.id, { workspaceId: a.workspace.id })
      expect(two.seq).toBe(one.seq + 1)
      expect(two.applied[0].version).toBe(one.applied[0].version + 1)
      expect(await changesSince(db, one.seq, { workspaceId: a.workspace.id })).toMatchObject({ seq: two.seq, changes: [{ id: 'j-a2', seq: one.seq + 1 }] })
    })
  })

  describe('expiry', () => {
    async function filledDemo(email: string, name: string) {
      const r = await demo(email, name)
      await replaceWorkspace(db, company(name), r.user.id, r.workspace.id)
      await applyChanges(db, parseChanges({ changes: [job(`j-${name}`)] }), r.user.id, { workspaceId: r.workspace.id })
      await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [`s-${name}`, r.user.id])
      await db.query(`INSERT INTO trusted_devices (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [`d-${name}`, r.user.id])
      await createInvite(db, r.workspace.id, r.user.id)
      return r
    }
    const rowsOf = async (workspaceId: string) => {
      const out: Record<string, number> = {}
      for (const t of ['change_log', 'workspace_docs', 'invites', 'users', ...RECORD_COLLECTIONS.map(tableName)]) {
        const n = Number((await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM ${t} WHERE workspace_id = $1`, [workspaceId])).rows[0].n)
        if (n > 0) out[t] = n
      }
      return out
    }

    it('deletes a demo company unused for DEMO_EXPIRE_DAYS with everything in it, and nothing else', async () => {
      const idle = await filledDemo('idle@example.com', 'Idle')
      const busy = await filledDemo('busy@example.com', 'Busy')
      await upsertAdmin(db, 'owner@example.com', 'owner-password-1234')
      await replaceWorkspace(db, company('Owner'), null, WORKSPACE_ID)
      await db.query(`UPDATE workspaces SET last_active_at = now() - interval '31 days' WHERE id IN ($1, $2)`, [idle.workspace.id, WORKSPACE_ID])
      const busyBefore = await rowsOf(busy.workspace.id)
      const ownerBefore = await rowsOf(WORKSPACE_ID)
      expect(Object.keys(await rowsOf(idle.workspace.id))).toEqual(expect.arrayContaining(['change_log', 'workspace_docs', 'invites', 'users', 'people', 'jobs']))

      expect(await expireDemoWorkspaces(db, 30)).toBe(1)
      expect(await rowsOf(idle.workspace.id)).toEqual({})
      expect((await db.query('SELECT 1 FROM workspaces WHERE id = $1', [idle.workspace.id])).rows).toEqual([])
      expect((await db.query(`SELECT 1 FROM sessions WHERE token_hash = 's-Idle'`)).rows).toEqual([])
      expect((await db.query(`SELECT 1 FROM trusted_devices WHERE token_hash = 'd-Idle'`)).rows).toEqual([])
      // The busy demo company and the owner's kept workspace (however old) are untouched.
      expect(await rowsOf(busy.workspace.id)).toEqual(busyBefore)
      expect(await rowsOf(WORKSPACE_ID)).toEqual(ownerBefore)
      expect(await findWorkspaceBySlug(db, idle.workspace.slug)).toBeNull()
    })

    it('never deletes when DEMO_EXPIRE_DAYS is 0, never deletes a kept workspace, and keeps one used meanwhile', async () => {
      const idle = await filledDemo('idle@example.com', 'Idle')
      await db.query(`UPDATE workspaces SET last_active_at = now() - interval '400 days'`)
      expect(await expireDemoWorkspaces(db, 0)).toBe(0)
      expect(await deleteDemoWorkspace(db, WORKSPACE_ID)).toBe(false)
      expect((await db.query('SELECT 1 FROM workspaces WHERE id = $1', [WORKSPACE_ID])).rows).toHaveLength(1)
      // A write between the list and the delete keeps it (the delete re-checks under the row lock).
      await applyChanges(db, parseChanges({ changes: [job('j-late')] }), idle.user.id, { workspaceId: idle.workspace.id })
      expect(await deleteDemoWorkspace(db, idle.workspace.id, 30)).toBe(false)
      expect(await rowsOf(idle.workspace.id)).not.toEqual({})
    })

    it(`deletes a sign-up never uploaded ${UNUSED_SIGNUP_HOURS} hours on, and keeps uploaded or signed-in ones`, async () => {
      const unused = await demo('unused@example.com', 'Unused')
      const fresh = await demo('fresh@example.com', 'Fresh')
      const used = await filledDemo('used@example.com', 'Used')
      const old = `now() - make_interval(hours => ${UNUSED_SIGNUP_HOURS}) - interval '1 minute'`
      await db.query(`UPDATE workspaces SET created_at = ${old}, last_active_at = ${old} WHERE id IN ($1, $2)`, [unused.workspace.id, used.workspace.id])
      expect(await expireDemoWorkspaces(db, 30)).toBe(1)
      const left = (await db.query<{ id: string }>('SELECT id FROM workspaces WHERE NOT keep ORDER BY id')).rows.map((r) => r.id)
      expect(left.sort()).toEqual([fresh.workspace.id, used.workspace.id].sort())
      expect((await db.query(`SELECT 1 FROM users WHERE email = 'unused@example.com'`)).rows).toEqual([])
      // Never when demo companies never expire.
      const another = await demo('another@example.com', 'Another')
      await db.query(`UPDATE workspaces SET created_at = ${old}, last_active_at = ${old} WHERE id = $1`, [another.workspace.id])
      expect(await expireDemoWorkspaces(db, 0)).toBe(0)
    })

    it('leaves a deleted company deleted: a write that comes after is refused as signed out', async () => {
      const gone = await filledDemo('gone@example.com', 'Gone')
      expect(await deleteDemoWorkspace(db, gone.workspace.id)).toBe(true)
      await expect(applyChanges(db, parseChanges({ changes: [job('j-x')] }), null, { workspaceId: gone.workspace.id })).rejects.toMatchObject({
        statusCode: 401,
      })
      await expect(replaceWorkspace(db, company('Gone'), null, gone.workspace.id)).rejects.toMatchObject({ statusCode: 401 })
      expect((await db.query('SELECT 1 FROM workspaces WHERE id = $1', [gone.workspace.id])).rows).toEqual([])
      expect(await workspaceStatus(db, gone.workspace.id)).toEqual({ empty: true })
      expect(await changesSince(db, 0, { workspaceId: gone.workspace.id })).toEqual({ resync: true })
    })

    it('runs in the daily housekeeping with sessions, change-log pruning and invites, each step on its own', async () => {
      const idle = await filledDemo('idle@example.com', 'Idle')
      await db.query(`UPDATE workspaces SET last_active_at = now() - interval '31 days' WHERE id = $1`, [idle.workspace.id])
      await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) SELECT 'old', id, now() - interval '1 minute' FROM users WHERE email = 'idle@example.com'`)
      const done = await housekeeping(db, { sessionIdleHours: 12, demoExpireDays: 30 })
      expect(done).toEqual({ sessions: 1, expiredWorkspaces: 1, prunedChanges: 0, invites: 0, assistantUsage: 0 })
      // A failing step does not stop the others; the error comes out at the end.
      const other = await filledDemo('other@example.com', 'Other')
      await db.query(`UPDATE workspaces SET last_active_at = now() - interval '31 days' WHERE id = $1`, [other.workspace.id])
      const broken: Db = {
        ...db,
        query: (async (text: string, params?: unknown[]) => {
          if (/DELETE FROM sessions WHERE expires_at/.test(text)) throw new Error('sessions table locked')
          return db.query(text, params)
        }) as Db['query'],
      }
      await expect(housekeeping(broken, { sessionIdleHours: 12, demoExpireDays: 30 })).rejects.toThrow(/sessions table locked/)
      expect(await findWorkspaceBySlug(db, other.workspace.slug)).toBeNull()
    })
  })

  it('create-admin manages the server-owned workspace only: demo admins stay as they are, and their emails are refused', async () => {
    const owner = await upsertAdmin(db, 'owner@example.com', 'owner-password-1234')
    const d = await demo('demo-admin@example.com', 'Demo')
    const again = await upsertAdmin(db, 'owner@example.com', 'owner-password-5678')
    expect(again).toMatchObject({ id: owner.id, created: false })
    const moved = await upsertAdmin(db, 'ops@example.com', 'owner-password-5678')
    expect(moved).toMatchObject({ id: owner.id, previousEmail: 'owner@example.com' })
    const users = await db.query<{ email: string; workspace_id: string; password_hash: string }>('SELECT email, workspace_id, password_hash FROM users ORDER BY email')
    expect(users.rows.map((u) => [u.email, u.workspace_id])).toEqual([
      ['demo-admin@example.com', d.workspace.id],
      ['ops@example.com', WORKSPACE_ID],
    ])
    expect(users.rows[0].password_hash).toBe('scrypt$test')
    await expect(upsertAdmin(db, 'demo-admin@example.com', 'owner-password-5678')).rejects.toThrow(/Another login already uses/)
    // On a server whose own workspace has no admin yet, a demo login's email is refused too.
    await db.query(`DELETE FROM users WHERE workspace_id = $1`, [WORKSPACE_ID])
    await expect(upsertAdmin(db, 'demo-admin@example.com', 'owner-password-5678')).rejects.toThrow(/Another company on this server already has a login/)
    expect((await db.query<{ workspace_id: string }>(`SELECT workspace_id FROM users WHERE email = 'demo-admin@example.com'`)).rows).toEqual([
      { workspace_id: d.workspace.id },
    ])
  })

  it('after-restore gives every workspace a new history and the new numbering', async () => {
    const d = await demo('demo@example.com', 'Demo')
    const demoUp = await replaceWorkspace(db, company('Demo'), d.user.id, d.workspace.id)
    const ownerUp = await replaceWorkspace(db, company('Owner'), null, WORKSPACE_ID)
    const restored = await afterRestore(db)
    const rows = await db.query<{ id: string; history_id: string; last_seq: unknown; reset_seq: unknown }>(
      'SELECT id, history_id::text AS history_id, last_seq, reset_seq FROM workspaces',
    )
    for (const row of rows.rows) {
      expect(Number(row.last_seq), row.id).toBe(restored.seq)
      expect(Number(row.reset_seq), row.id).toBe(restored.seq)
    }
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.history_id]))
    expect(byId[WORKSPACE_ID]).toBe(restored.historyId)
    expect(byId[WORKSPACE_ID]).not.toBe(ownerUp.historyId)
    expect(byId[d.workspace.id]).not.toBe(demoUp.historyId)
    expect(byId[d.workspace.id]).not.toBe(byId[WORKSPACE_ID])
    expect(await changesSince(db, demoUp.seq, { workspaceId: d.workspace.id })).toEqual({ resync: true })
  })
})
