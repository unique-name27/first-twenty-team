import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  authCookies,
  checkCredentials,
  clientAddressKey,
  ConcurrencyGate,
  cookieCount,
  DEVICE_TRUST_DAYS,
  findTrustedDevice,
  GateFullError,
  hashPassword,
  hashToken,
  LoginRateLimiter,
  loginEmail,
  MAX_DEVICES_PER_USER,
  MAX_EMAIL_LENGTH,
  normalizeEmail,
  sessionLifetimeMs,
  SHORT_SESSION_HOURS,
  SlidingWindowCounter,
  trustDevice,
  upsertAdmin,
  verifyPassword,
} from './auth'
import type { Db } from './db'
import { codePoint, makeTestDb, resetDb, TRIMMED_SPACES } from './test/helpers'

describe('password hashing', () => {
  it('uses scrypt N=2^15 r=8 p=1 with a 16-byte salt and verifies in constant time', async () => {
    const hash = await hashPassword('test-password-1234')
    const [scheme, N, r, p, salt, key] = hash.split('$')
    expect([scheme, N, r, p]).toEqual(['scrypt', '32768', '8', '1'])
    expect(Buffer.from(salt, 'base64')).toHaveLength(16)
    expect(Buffer.from(key, 'base64')).toHaveLength(64)
    expect(await verifyPassword('test-password-1234', hash)).toBe(true)
    expect(await verifyPassword('test-password-1235', hash)).toBe(false)
    expect(await hashPassword('test-password-1234')).not.toBe(hash)
  })

  it('treats malformed stored hashes as a mismatch', async () => {
    expect(await verifyPassword('x', 'plain-text')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$99999999$8$1$c2FsdA==$a2V5')).toBe(false)
  })
})

describe('session lifetime', () => {
  it('lasts SESSION_MAX_DAYS when remembered and 12 hours otherwise', () => {
    expect(SHORT_SESSION_HOURS).toBe(12)
    expect(sessionLifetimeMs({ sessionMaxDays: 7 }, true)).toBe(7 * 86_400_000)
    expect(sessionLifetimeMs({ sessionMaxDays: 7 }, false)).toBe(12 * 3_600_000)
    expect(sessionLifetimeMs({ sessionMaxDays: 1 }, false)).toBe(12 * 3_600_000)
  })
})

describe('clientAddressKey', () => {
  it('keeps IPv4 addresses whole and groups IPv6 addresses by /64', () => {
    expect(clientAddressKey('203.0.113.9')).toBe('203.0.113.9')
    expect(clientAddressKey('::ffff:203.0.113.9')).toBe('203.0.113.9')
    const a = clientAddressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')
    expect(a).toBe('2001:db8:1:2::/64')
    expect(clientAddressKey('2001:db8:1:2::1')).toBe(a)
    expect(clientAddressKey('2001:0DB8:0001:0002:ffff::9%eth0')).toBe(a)
    expect(clientAddressKey('2001:db8:1:3::1')).not.toBe(a)
    expect(clientAddressKey('::1')).toBe('0:0:0:0::/64')
    expect(clientAddressKey('64:ff9b::192.0.2.33')).toBe('64:ff9b:0:0::/64')
    expect(clientAddressKey('not an address')).toBe('not an address')
  })
})

describe('loginEmail', () => {
  it('normalizes once, so every padded form of an email gives the same string, and refuses one over 254 characters', () => {
    expect(MAX_EMAIL_LENGTH).toBe(254)
    for (const p of TRIMMED_SPACES) {
      const forms = [`${p}admin@example.com`, `admin@example.com${p}`, `${p}${p}ADMIN@Example.com${p}`, `${p.repeat(300)}admin@example.com${p.repeat(300)}`]
      for (const raw of forms) {
        const email = loginEmail(raw)
        expect(email, `${codePoint(p)} ${JSON.stringify(raw.slice(0, 24))}`).toBe('admin@example.com')
        // The lookup normalizes again; that must not change the string the limiter counted.
        expect(normalizeEmail(email!)).toBe(email)
      }
      // The review's probe: padding in the middle and one more character. It is not the admin's email,
      // and it is too long to be anyone's, so no password is checked for it.
      expect(loginEmail(`admin@example.com${p.repeat(240)}x`), codePoint(p)).toBeNull()
    }
    const longest = `${'a'.repeat(242)}@example.com`
    expect(longest).toHaveLength(254)
    expect(loginEmail(`  ${longest}  `)).toBe(longest)
    expect(loginEmail(`${longest}a`)).toBeNull()
    expect(loginEmail('')).toBeNull()
    expect(loginEmail(' \t　﻿')).toBeNull()
    // Lowercasing can lengthen a string (U+0130 becomes two characters), so the limit applies after it.
    expect(loginEmail('İ'.repeat(127))).toHaveLength(254)
    expect(loginEmail('İ'.repeat(128))).toBeNull()
  })
})

describe('SlidingWindowCounter lockouts', () => {
  const MIN = 60_000

  it('never evicts a key that holds a lockout, only the oldest key below the limit', () => {
    const counter = new SlidingWindowCounter(15 * MIN, 3, 2)
    expect(counter.add('locked', 0)).toBe(true)
    expect(counter.add('locked', 1)).toBe(true) // reaches the limit of 2
    counter.add('a', 2)
    counter.add('b', 3)
    counter.add('c', 4) // full: drops a, not the older key that holds a lockout
    expect(counter.size).toBe(3)
    expect(counter.count('locked', 5)).toBe(2)
    expect(counter.retryAfter('locked', 5)).toBeGreaterThan(14 * 60)
    expect(counter.count('a', 5)).toBe(0)
    counter.add('d', 6) // drops b
    counter.add('e', 7) // drops c
    expect(counter.count('locked', 8)).toBe(2)
    expect([counter.count('b', 8), counter.count('c', 8), counter.count('d', 8), counter.count('e', 8)]).toEqual([0, 0, 1, 1])
  })

  it('refuses a new key when every key holds a lockout, records nothing for it, and has room once one ends', () => {
    const counter = new SlidingWindowCounter(15 * MIN, 2, 1)
    expect(counter.add('x', 0)).toBe(true)
    expect(counter.add('y', MIN)).toBe(true)
    // x's lockout began first and ends at 15 minutes.
    expect(counter.secondsUntilRoom('z', 2 * MIN)).toBe(13 * 60)
    expect(counter.add('z', 2 * MIN)).toBe(false)
    expect(counter.count('z', 2 * MIN)).toBe(0)
    expect(counter.size).toBe(2)
    // Keys already kept need no room.
    expect(counter.secondsUntilRoom('x', 2 * MIN)).toBe(0)
    expect(counter.count('x', 2 * MIN)).toBe(1)
    expect(counter.count('y', 2 * MIN)).toBe(1)
    expect(counter.secondsUntilRoom('z', 15 * MIN + 1)).toBe(0)
    expect(counter.add('z', 15 * MIN + 1)).toBe(true)
    expect(counter.count('y', 15 * MIN + 1)).toBe(1)
    expect(counter.count('z', 15 * MIN + 1)).toBe(1)
  })

  it('with forgetLockouts, makes room by forgetting the oldest lockout instead of refusing', () => {
    const counter = new SlidingWindowCounter(15 * MIN, 2, 1, { forgetLockouts: true })
    expect(counter.add('x', 0)).toBe(true)
    expect(counter.add('y', MIN)).toBe(true)
    expect(counter.secondsUntilRoom('z', 2 * MIN)).toBe(0)
    expect(counter.add('z', 2 * MIN)).toBe(true)
    expect(counter.size).toBe(2)
    expect([counter.count('x', 2 * MIN), counter.count('y', 2 * MIN), counter.count('z', 2 * MIN)]).toEqual([0, 1, 1])
  })

  it('lets a key go again once its lockout is taken back or ends', () => {
    const counter = new SlidingWindowCounter(15 * MIN, 2, 2)
    counter.add('k', 0)
    counter.add('k', 1) // lockout
    counter.removeLast('k') // a provisional hit taken back: below the limit again
    expect(counter.retryAfter('k', 2)).toBe(0)
    counter.add('other', 3)
    counter.add('new', 4) // full: k can be dropped now
    expect(counter.count('k', 5)).toBe(0)
    expect(counter.count('new', 5)).toBe(1)
  })
})

describe('LoginRateLimiter', () => {
  const MIN = 60_000

  it('keeps every lockout through any number of throwaway sign-ins (small maxKeys)', () => {
    let now = 0
    const limiter = new LoginRateLimiter({ maxKeys: 20, perEmailFailures: 5, now: () => now })
    // The admin's email reaches its failure cap from five addresses...
    for (let i = 0; i < 5; i++) expect(limiter.begin('admin@example.com', `10.0.0.${i + 1}`).ok).toBe(true)
    expect(limiter.begin('admin@example.com', '10.0.1.1').ok).toBe(false)
    // ...and one address reaches its own limit.
    for (let i = 0; i < 10; i++) expect(limiter.begin(`x${i}@example.com`, '10.0.2.1').ok).toBe(true)
    expect(limiter.begin('someone@example.com', '10.0.2.1').ok).toBe(false)
    // Churn: real sign-ins with throwaway emails and impossible ones, from 2,000 addresses.
    for (let i = 0; i < 1000; i++) {
      now += 100
      limiter.begin(`junk${i}@example.com`, `10.1.${i >> 8}.${i & 255}`)
      limiter.begin(null, `10.2.${i >> 8}.${i & 255}`)
    }
    expect(limiter.count('email:admin@example.com')).toBe(5)
    expect(limiter.begin('admin@example.com', '10.0.3.1').ok).toBe(false)
    expect(limiter.begin('someone@example.com', '10.0.2.1').ok).toBe(false)
    expect(limiter.size).toBeLessThanOrEqual(3 * 20)
  })

  // Re-review: hopeless sign-ins cost no password check, so maxKeys addresses sending 10 each could fill
  // the address limit with lockouts and leave every other address refused.
  it('never lets a flood of cheap sign-ins from many addresses lock everyone else out', () => {
    let now = 0
    const limiter = new LoginRateLimiter({ maxKeys: 200, now: () => now })
    expect(limiter.begin('admin@example.com', '198.51.100.7')).toEqual({ ok: true })
    limiter.succeeded('admin@example.com', '198.51.100.7')
    for (let i = 0; i < 200; i++) {
      now += 10
      for (let j = 0; j < 10; j++) limiter.begin(null, `10.9.${i >> 8}.${i & 255}`)
    }
    now = MIN
    // The admin from home (whose key the flood pushed out) and from a new address both get in.
    expect(limiter.begin('admin@example.com', '198.51.100.7')).toEqual({ ok: true })
    limiter.succeeded('admin@example.com', '198.51.100.7')
    expect(limiter.begin('admin@example.com', '203.0.113.5')).toEqual({ ok: true })
    limiter.succeeded('admin@example.com', '203.0.113.5')
    // The flood never touched the email limits.
    expect(limiter.count('email:admin@example.com')).toBe(0)
    expect(limiter.size).toBeLessThanOrEqual(3 * 200)
  })

  it('charges a sign-in that cannot succeed to the client address only', () => {
    const limiter = new LoginRateLimiter()
    for (let i = 0; i < 10; i++) expect(limiter.begin(null, '10.0.0.1')).toEqual({ ok: true })
    expect(limiter.size).toBe(1)
    expect(limiter.count('ip:10.0.0.1')).toBe(10)
    // It still uses up the address's attempts.
    expect(limiter.begin('admin@example.com', '10.0.0.1').ok).toBe(false)
    expect(limiter.begin(null, '10.0.0.1').ok).toBe(false)
  })

  it('pushes out an address below its limit first, and the oldest address lockout only when every address key holds one', () => {
    let now = 0
    const limiter = new LoginRateLimiter({ maxKeys: 3, perAddress: 2, now: () => now })
    for (const a of ['10.0.0.1', '10.0.0.2']) for (let i = 0; i < 2; i++) expect(limiter.begin(null, a).ok).toBe(true)
    now = MIN
    expect(limiter.begin('admin@example.com', '10.0.0.3').ok).toBe(true)
    now = 2 * MIN
    // Full: the new address pushes out 10.0.0.3 (below its limit), not a lockout.
    expect(limiter.begin(null, '10.0.0.4').ok).toBe(true)
    expect(limiter.count('ip:10.0.0.3')).toBe(0)
    expect(limiter.begin(null, '10.0.0.1').ok).toBe(false)
    expect(limiter.begin(null, '10.0.0.2').ok).toBe(false)
    expect(limiter.begin(null, '10.0.0.4').ok).toBe(true) // its lockout begins
    // Every address key now holds a lockout. A new address forgets the oldest one (10.0.0.1) and gets in.
    expect(limiter.begin('admin@example.com', '10.0.0.5')).toEqual({ ok: true })
    expect(limiter.count('ip:10.0.0.5')).toBe(1)
    expect(limiter.count('ip:10.0.0.1')).toBe(0)
    expect(limiter.begin(null, '10.0.0.2').ok).toBe(false)
    expect(limiter.begin(null, '10.0.0.4').ok).toBe(false)
  })

  it('refuses a sign-in that needs a new email key while every email key holds a lockout, and records nothing for it', () => {
    let now = 0
    const limiter = new LoginRateLimiter({ maxKeys: 3, perAddress: 100, perEmailAddress: 2, now: () => now })
    for (const e of ['a@example.com', 'b@example.com', 'c@example.com']) for (let i = 0; i < 2; i++) expect(limiter.begin(e, '10.0.0.1').ok).toBe(true)
    now = 2 * MIN
    // Every email-and-address key holds a lockout: a new one waits until the oldest ends.
    expect(limiter.begin('admin@example.com', '10.0.0.1')).toEqual({ ok: false, retryAfter: 13 * 60 })
    expect(limiter.count('email:admin@example.com')).toBe(0)
    expect(limiter.count('ip:10.0.0.1')).toBe(6)
    expect(limiter.count('email-ip:a@example.com|10.0.0.1')).toBe(2)
    now = 15 * MIN + 1
    expect(limiter.begin('admin@example.com', '10.0.0.1').ok).toBe(true)
  })

  it('allows 10 attempts per address per 15 minutes, successful ones included, then says when to retry', () => {
    let now = 1_000_000
    const limiter = new LoginRateLimiter({ now: () => now })
    for (let i = 0; i < 10; i++) {
      expect(limiter.begin(`user${i}@example.com`, '10.0.0.1')).toEqual({ ok: true })
      if (i % 2 === 0) limiter.succeeded(`user${i}@example.com`, '10.0.0.1')
      now += 1000
    }
    const blocked = limiter.begin('someone@example.com', '10.0.0.1')
    expect(blocked).toEqual({ ok: false, retryAfter: 15 * 60 - 10 })
    // A refused attempt counts nowhere.
    expect(limiter.count('email:someone@example.com')).toBe(0)
    expect(limiter.begin('someone@example.com', '10.0.0.2')).toEqual({ ok: true })
    now += 15 * MIN
    expect(limiter.begin('someone@example.com', '10.0.0.1')).toEqual({ ok: true })
  })

  it('never lets one address lock an email out for another address', () => {
    const limiter = new LoginRateLimiter()
    for (let i = 0; i < 10; i++) expect(limiter.begin('admin@example.com', '203.0.113.9').ok).toBe(true)
    expect(limiter.begin('admin@example.com', '203.0.113.9').ok).toBe(false)
    expect(limiter.begin('admin@example.com', '198.51.100.7')).toEqual({ ok: true })
  })

  it('caps failures per email across addresses, but successes do not count', () => {
    const limiter = new LoginRateLimiter()
    expect(limiter.limits.perEmailFailures).toBe(100)
    for (let i = 0; i < 50; i++) {
      expect(limiter.begin('admin@example.com', `10.0.${i}.1`).ok).toBe(true)
      limiter.succeeded('admin@example.com', `10.0.${i}.1`)
    }
    expect(limiter.count('email:admin@example.com')).toBe(0)
    for (let i = 0; i < 100; i++) expect(limiter.begin('admin@example.com', `10.1.${i}.1`).ok, String(i)).toBe(true)
    const blocked = limiter.begin('admin@example.com', '10.2.0.1')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.retryAfter).toBeGreaterThan(800)
  })

  it('clears the email-and-address count after a successful sign-in', () => {
    const limiter = new LoginRateLimiter({ perAddress: 100 })
    for (let i = 0; i < 9; i++) limiter.begin('admin@example.com', '10.0.0.1')
    expect(limiter.count('email-ip:admin@example.com|10.0.0.1')).toBe(9)
    limiter.begin('admin@example.com', '10.0.0.1')
    limiter.succeeded('admin@example.com', '10.0.0.1')
    expect(limiter.count('email-ip:admin@example.com|10.0.0.1')).toBe(0)
    expect(limiter.count('email:admin@example.com')).toBe(9)
    expect(limiter.begin('admin@example.com', '10.0.0.1')).toEqual({ ok: true })
  })

  it('takes back the email counts when no password was checked', () => {
    const limiter = new LoginRateLimiter()
    limiter.begin('admin@example.com', '10.0.0.1')
    limiter.cancelled('admin@example.com', '10.0.0.1')
    expect(limiter.count('email:admin@example.com')).toBe(0)
    expect(limiter.count('email-ip:admin@example.com|10.0.0.1')).toBe(0)
    expect(limiter.count('ip:10.0.0.1')).toBe(1)
  })

  it('holds a trusted device to its own limit only, whatever the email and address limits say', () => {
    let now = 0
    const limiter = new LoginRateLimiter({ perEmailFailures: 3, now: () => now })
    for (let i = 0; i < 3; i++) expect(limiter.begin('admin@example.com', `10.0.0.${i + 1}`).ok).toBe(true)
    expect(limiter.begin('admin@example.com', '10.0.1.1').ok).toBe(false)
    // The email's cap is full; its owner's device still gets ten attempts, charged to the device alone.
    for (let i = 0; i < 10; i++) expect(limiter.beginTrusted('device-hash')).toEqual({ ok: true })
    expect(limiter.count('device:device-hash')).toBe(10)
    expect(limiter.count('email:admin@example.com')).toBe(3)
    expect(limiter.beginTrusted('device-hash')).toEqual({ ok: false, retryAfter: 15 * 60 })
    // Another device is not affected; a success clears the count, a cancelled attempt is taken back.
    expect(limiter.beginTrusted('other-device').ok).toBe(true)
    limiter.cancelledTrusted('other-device')
    expect(limiter.count('device:other-device')).toBe(0)
    limiter.succeededTrusted('device-hash')
    expect(limiter.beginTrusted('device-hash').ok).toBe(true)
    now += 16 * MIN
    limiter.sweep()
    expect(limiter.size).toBe(0)
  })

  it('forgets idle keys on sweep and keeps at most maxKeys keys', () => {
    let now = 0
    const limiter = new LoginRateLimiter({ now: () => now })
    limiter.begin('a@example.com', '10.0.0.1')
    expect(limiter.size).toBe(3)
    now += 16 * MIN
    limiter.sweep()
    expect(limiter.size).toBe(0)

    const counter = new SlidingWindowCounter(15 * MIN, 3)
    counter.add('a', 0)
    counter.add('b', 0)
    counter.add('c', 0)
    counter.add('a', 1) // a is now the most recently used
    counter.add('d', 2) // evicts b, the least recently used
    expect(counter.size).toBe(3)
    expect(counter.count('a', 3)).toBe(2)
    expect(counter.count('b', 3)).toBe(0)
    expect(counter.count('d', 3)).toBe(1)
  })
})

describe('ConcurrencyGate', () => {
  it('runs at most limit tasks at once, queues up to maxQueue and refuses the rest', async () => {
    const gate = new ConcurrencyGate(2, 1)
    const releases: Array<() => void> = []
    const task = () => new Promise<string>((resolve) => releases.push(() => resolve('done')))
    const a = gate.run(task)
    const b = gate.run(task)
    expect(gate.full).toBe(false)
    const c = gate.run(task)
    await Promise.resolve()
    expect(gate.running).toBe(2)
    expect(gate.queued).toBe(1)
    expect(gate.full).toBe(true)
    await expect(gate.run(task)).rejects.toBeInstanceOf(GateFullError)
    releases[0]()
    expect(await a).toBe('done')
    await new Promise((r) => setTimeout(r, 0))
    expect(releases).toHaveLength(3) // c started when a finished
    expect(gate.running).toBe(2)
    releases[1]()
    releases[2]()
    expect(await Promise.all([b, c])).toEqual(['done', 'done'])
    expect(gate.running).toBe(0)
    // A failing task frees its slot too.
    await expect(gate.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(gate.running).toBe(0)
  })
})

describe('cookies', () => {
  it('use __Host- names with Path=/ over https, and the plain names limited to /api over http', () => {
    const secure = authCookies(true)
    expect(secure.session).toEqual({ name: '__Host-ft_session', options: { httpOnly: true, sameSite: 'strict', secure: true, path: '/' } })
    expect(secure.device.name).toBe('__Host-ft_device')
    const plain = authCookies(false)
    expect(plain.session).toEqual({ name: 'ft_session', options: { httpOnly: true, sameSite: 'strict', secure: false, path: '/api' } })
    expect(plain.device.name).toBe('ft_device')
  })

  it('counts how often a name appears in a Cookie header', () => {
    expect(cookieCount(undefined, 'ft_session')).toBe(0)
    expect(cookieCount('ft_session=a', 'ft_session')).toBe(1)
    expect(cookieCount('ft_session=a; x=1;ft_session=b', 'ft_session')).toBe(2)
    expect(cookieCount('__Host-ft_session=a; ft_sessionx=b', 'ft_session')).toBe(0)
  })
})

describe('trusted devices', () => {
  let db: Db
  let userId: string
  beforeAll(async () => {
    db = await makeTestDb()
  })
  afterAll(async () => {
    await db.close()
  })
  beforeEach(async () => {
    await resetDb(db)
    userId = (await upsertAdmin(db, 'founder@example.com', 'first-password-123')).id
  })

  it('belong to one login, store only a hash, and expire after DEVICE_TRUST_DAYS', async () => {
    const token = await trustDevice(db, userId)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const rows = await db.query<{ token_hash: string; days: number }>(
      `SELECT token_hash, round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days FROM trusted_devices`,
    )
    expect(rows.rows).toEqual([{ token_hash: hashToken(token), days: DEVICE_TRUST_DAYS }])
    expect(await findTrustedDevice(db, token, 'founder@example.com')).toBe(hashToken(token))
    expect(await findTrustedDevice(db, token, 'someone@example.com')).toBeNull()
    expect(await findTrustedDevice(db, undefined, 'founder@example.com')).toBeNull()
    expect(await findTrustedDevice(db, 'x', 'founder@example.com')).toBeNull()
    await db.query(`UPDATE trusted_devices SET expires_at = now() - interval '1 second'`)
    expect(await findTrustedDevice(db, token, 'founder@example.com')).toBeNull()
  })

  it('replace the token the browser sent, and keep the newest MAX_DEVICES_PER_USER per user', async () => {
    const first = await trustDevice(db, userId)
    const second = await trustDevice(db, userId, first)
    expect(await findTrustedDevice(db, first, 'founder@example.com')).toBeNull()
    expect(await findTrustedDevice(db, second, 'founder@example.com')).not.toBeNull()
    await db.query(`UPDATE trusted_devices SET created_at = now() - interval '1 day'`)
    const tokens: string[] = []
    for (let i = 0; i < MAX_DEVICES_PER_USER; i++) tokens.push(await trustDevice(db, userId))
    expect((await db.query('SELECT 1 FROM trusted_devices')).rows).toHaveLength(MAX_DEVICES_PER_USER)
    expect(await findTrustedDevice(db, second, 'founder@example.com')).toBeNull() // the oldest went
    for (const t of tokens) expect(await findTrustedDevice(db, t, 'founder@example.com')).not.toBeNull()
  })
})

describe('upsertAdmin', () => {
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

  it('creates the admin, stores the email lowercase and never the password', async () => {
    const r = await upsertAdmin(db, ' Founder@Example.com ', 'first-password-123')
    expect(r).toMatchObject({ email: 'founder@example.com', created: true })
    const rows = await db.query<{ email: string; password_hash: string; role: string }>('SELECT email, password_hash, role FROM users')
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({ email: 'founder@example.com', role: 'admin' })
    expect(rows.rows[0].password_hash).toMatch(/^scrypt\$/)
    expect(rows.rows[0].password_hash).not.toContain('first-password-123')
    expect(await checkCredentials(db, 'FOUNDER@example.com', 'first-password-123')).toMatchObject({ email: 'founder@example.com' })
  })

  it('updates the single admin (password or email) and signs out its sessions', async () => {
    const first = await upsertAdmin(db, 'founder@example.com', 'first-password-123')
    await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('h', $1, now() + interval '1 day')`, [first.id])
    const second = await upsertAdmin(db, 'founder@example.com', 'second-password-123')
    expect(second).toMatchObject({ id: first.id, created: false, previousEmail: null })
    expect((await db.query('SELECT 1 FROM sessions')).rows).toHaveLength(0)
    expect(await checkCredentials(db, 'founder@example.com', 'first-password-123')).toBeNull()

    const moved = await upsertAdmin(db, 'ops@example.com', 'third-password-123')
    expect(moved).toMatchObject({ id: first.id, previousEmail: 'founder@example.com' })
    expect((await db.query('SELECT email FROM users')).rows).toEqual([{ email: 'ops@example.com' }])
  })

  it('forgets the admin trusted devices when it changes', async () => {
    const first = await upsertAdmin(db, 'founder@example.com', 'first-password-123')
    const token = await trustDevice(db, first.id)
    expect(await findTrustedDevice(db, token, 'founder@example.com')).toBe(hashToken(token))
    await upsertAdmin(db, 'founder@example.com', 'second-password-123')
    expect(await findTrustedDevice(db, token, 'founder@example.com')).toBeNull()
  })

  it('enforces a 12-character minimum and a valid email', async () => {
    await expect(upsertAdmin(db, 'founder@example.com', 'short')).rejects.toThrow(/at least 12/)
    await expect(upsertAdmin(db, 'not-an-email', 'long-enough-password')).rejects.toThrow(/valid email/)
  })
})
