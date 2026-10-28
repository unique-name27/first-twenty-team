// HTTP tests for the API server, in-memory PGlite + app.inject(): wrong passwords, the sign-in rate
// limits, trusted devices and the password-check gate (docs/SYNC.md, Security rules).
import { describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { ConcurrencyGate, hashToken, LoginRateLimiter, MAX_PASSWORD_LENGTH, upsertAdmin } from './auth'
import { testConfig } from './config'
import { app, db, useApp } from './test/api'
import { ADMIN, codePoint, createAdmin, CSRF, deviceCookie, spyOnEmailLookups, TRIMMED_SPACES } from './test/helpers'

useApp()

describe('login', () => {
  it('refuses a wrong password or an unknown email with the same answer', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: ADMIN.email, password: 'not-the-password' } })
    expect(wrong.statusCode).toBe(401)
    expect(wrong.json()).toEqual({ error: 'invalid_credentials' })
    expect(wrong.headers['set-cookie']).toBeUndefined()
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: 'nobody@example.com', password: ADMIN.password } })
    expect(unknown.statusCode).toBe(401)
    expect(unknown.json()).toEqual({ error: 'invalid_credentials' })
    const malformed = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: 1 } })
    expect(malformed.statusCode).toBe(400)
  })

  it('rate limits after 10 attempts per IP, even with the right password', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: `user${i}@example.com`, password: 'wrong-password' } })
      expect(res.statusCode).toBe(401)
    }
    const blocked = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: ADMIN })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json()).toEqual({ error: 'rate_limited', retryAfter: expect.any(Number) })
    expect(blocked.json().retryAfter).toBeGreaterThan(800)
    expect(Number(blocked.headers['retry-after'])).toBe(blocked.json().retryAfter)
    // Another IP is not affected.
    const elsewhere = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: ADMIN, remoteAddress: '10.0.0.9' })
    expect(elsewhere.statusCode).toBe(200)
  })

  it('does not let one address lock the admin out from another address', async () => {
    // 10 wrong passwords for the admin from one address (as Caddy forwards it)...
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { ...CSRF, 'x-forwarded-for': '203.0.113.9' },
        payload: { email: ADMIN.email, password: 'wrong-password' },
      })
      expect(res.statusCode).toBe(401)
    }
    const sameAddress = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'x-forwarded-for': '203.0.113.9' }, payload: ADMIN })
    expect(sameAddress.statusCode).toBe(429)
    // ...and the right password from anywhere else still signs in.
    const elsewhere = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { ...CSRF, 'x-forwarded-for': '198.51.100.7' }, payload: ADMIN })
    expect(elsewhere.statusCode).toBe(200)
  })

  it('caps failed attempts per email across addresses, and only failures count', async () => {
    const limiter = new LoginRateLimiter({ perEmailFailures: 4 })
    const capped = await buildApp({ db, config: testConfig(), logger: false, limiter })
    const attempt = (password: string, remoteAddress: string) =>
      capped.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: ADMIN.email, password }, remoteAddress })
    for (let i = 0; i < 6; i++) expect((await attempt(ADMIN.password, `10.0.0.${i + 1}`)).statusCode).toBe(200)
    for (let i = 0; i < 4; i++) expect((await attempt('wrong-password', `10.0.1.${i + 1}`)).statusCode).toBe(401)
    const blocked = await attempt(ADMIN.password, '10.0.2.1')
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json()).toEqual({ error: 'rate_limited', retryAfter: expect.any(Number) })
    await capped.close()
  })

  it('lets a trusted device sign in while guesses from many addresses hold the per-email cap', async () => {
    const limiter = new LoginRateLimiter()
    const capped = await buildApp({ db, config: testConfig(), logger: false, limiter })
    const attempt = (password: string, remoteAddress: string, cookie?: string, email = ADMIN.email) =>
      capped.inject({ method: 'POST', url: '/api/auth/login', headers: cookie ? { ...CSRF, cookie } : CSRF, payload: { email, password }, remoteAddress })
    // The owner signed in from home yesterday; the browser kept its device cookie.
    const home = await attempt(ADMIN.password, '198.51.100.7')
    expect(home.statusCode).toBe(200)
    const device = `ft_device=${deviceCookie(home)}`
    // Then 100 wrong passwords from 10 addresses, each under its own limit, fill the email's cap.
    for (let i = 0; i < 100; i++) expect((await attempt('wrong-password', `203.0.113.${(i % 10) + 1}`)).statusCode, String(i)).toBe(401)
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(100)
    // A browser without the device cookie is refused, from home too...
    expect((await attempt(ADMIN.password, '198.51.100.7')).statusCode).toBe(429)
    expect((await attempt(ADMIN.password, '192.0.2.44')).statusCode).toBe(429)
    // ...and the owner's browser still gets in, from home or a new address, however the email is typed.
    const again = await attempt(ADMIN.password, '192.0.2.45', device, ` ${ADMIN.email.toUpperCase()}`)
    expect(again.statusCode).toBe(200)
    // Each sign-in replaces the device token; the old one no longer counts.
    const next = `ft_device=${deviceCookie(again)}`
    expect(next).not.toBe(device)
    expect((await attempt(ADMIN.password, '198.51.100.7', device)).statusCode).toBe(429)
    expect((await attempt(ADMIN.password, '198.51.100.7', next)).statusCode).toBe(200)
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(100)
    await capped.close()
  })

  it('gives a trusted device a limit of its own, kept apart from the email and address limits', async () => {
    const limiter = new LoginRateLimiter()
    const app2 = await buildApp({ db, config: testConfig(), logger: false, limiter })
    const attempt = (password: string, remoteAddress: string, cookie?: string) =>
      app2.inject({ method: 'POST', url: '/api/auth/login', headers: cookie ? { ...CSRF, cookie } : CSRF, payload: { email: ADMIN.email, password }, remoteAddress })
    const device = `ft_device=${deviceCookie(await attempt(ADMIN.password, '198.51.100.7'))}`
    // The home address used up its own attempts on other emails; the device is not held to them.
    for (let i = 0; i < 9; i++) {
      const res = await app2.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: `x${i}@example.com`, password: 'wrong-password' }, remoteAddress: '198.51.100.7' })
      expect(res.statusCode).toBe(401)
    }
    expect((await attempt(ADMIN.password, '198.51.100.7')).statusCode).toBe(429)
    // Ten wrong passwords from the device count against the device only, and then it waits too.
    for (let i = 0; i < 10; i++) expect((await attempt('wrong-password', '198.51.100.7', device)).statusCode).toBe(401)
    const hash = hashToken(device.slice('ft_device='.length))
    expect(limiter.count(`device:${hash}`)).toBe(10)
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(0)
    const waits = await attempt(ADMIN.password, '198.51.100.8', device)
    expect(waits.statusCode).toBe(429)
    expect(waits.json()).toEqual({ error: 'rate_limited', retryAfter: expect.any(Number) })
    await app2.close()
  })

  it('trusts a device only for the login that signed in on it, and forgets devices when the admin changes', async () => {
    const limiter = new LoginRateLimiter({ perEmailFailures: 2 })
    const capped = await buildApp({ db, config: testConfig(), logger: false, limiter })
    const attempt = (email: string, password: string, remoteAddress: string, cookie?: string) =>
      capped.inject({ method: 'POST', url: '/api/auth/login', headers: cookie ? { ...CSRF, cookie } : CSRF, payload: { email, password }, remoteAddress })
    const device = `ft_device=${deviceCookie(await attempt(ADMIN.email, ADMIN.password, '198.51.100.7'))}`
    // Another email with its cap full: the admin's device does not get past that one.
    for (let i = 0; i < 2; i++) expect((await attempt('other@example.com', 'wrong-password', `203.0.113.${i + 1}`)).statusCode).toBe(401)
    expect((await attempt('other@example.com', 'wrong-password', '198.51.100.7', device)).statusCode).toBe(429)
    // A malformed or made-up device token is just ignored.
    for (let i = 0; i < 2; i++) expect((await attempt(ADMIN.email, 'wrong-password', `203.0.113.${i + 10}`)).statusCode).toBe(401)
    expect((await attempt(ADMIN.email, ADMIN.password, '198.51.100.9', 'ft_device=x')).statusCode).toBe(429)
    expect((await attempt(ADMIN.email, ADMIN.password, '198.51.100.9', `ft_device=${'A'.repeat(43)}`)).statusCode).toBe(429)
    // server:create-admin (a new password, or a new email to escape a lockout) forgets every device.
    await createAdmin(db)
    expect((await db.query('SELECT 1 FROM trusted_devices')).rows).toEqual([])
    expect((await attempt(ADMIN.email, ADMIN.password, '198.51.100.7', device)).statusCode).toBe(429)
    await capped.close()
  })

  it('charges every password check against the admin to the admin limiter key, however the email is padded', async () => {
    const limiter = new LoginRateLimiter({ perEmailFailures: 10_000 })
    const lookups: string[] = []
    const spied = await buildApp({ db: spyOnEmailLookups(db, lookups), config: testConfig(), logger: false, limiter })
    let n = 0
    const attempt = (email: string) =>
      spied.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email, password: 'wrong-password' }, remoteAddress: `10.20.${n >> 8}.${n++ & 255}` })
    let adminForms = 0
    for (const p of TRIMMED_SPACES) {
      const sameAsAdmin = [`${p}${p}${ADMIN.email.toUpperCase()}${p}`, `${ADMIN.email}${p.repeat(300)}`]
      // The review's probe: padding in the middle, then one more character, over 254 in all.
      const probe = `${ADMIN.email}${p.repeat(240)}x`
      for (const email of [...sameAsAdmin, probe]) expect((await attempt(email)).statusCode, codePoint(p)).toBe(401)
      adminForms += sameAsAdmin.length
    }
    // At exactly 254 characters it is someone else's email, checked and counted as itself; so is one
    // ending in a zero-width space, which trim keeps.
    const others = [' ', '　'].map((p) => `${ADMIN.email}${p.repeat(254 - ADMIN.email.length - 1)}x`)
    others.push(`${ADMIN.email}​`)
    for (const email of others) expect((await attempt(email)).statusCode).toBe(401)

    // Every check against the admin's row was counted under the admin's key...
    expect(lookups.filter((e) => e === ADMIN.email)).toHaveLength(adminForms)
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(adminForms)
    // ...every other check under the very string it looked up...
    for (const e of new Set(lookups)) expect(limiter.count(`email:${e}`), JSON.stringify(e.slice(-8))).toBe(lookups.filter((x) => x === e).length)
    // ...and no email over 254 characters reached a password check.
    expect(lookups.every((e) => e.length <= 254)).toBe(true)
    expect(lookups).toHaveLength(adminForms + others.length)
    await spied.close()
  })

  it('keeps the per-email cap when the email is padded past 254 characters', async () => {
    const limiter = new LoginRateLimiter({ perEmailFailures: 4 })
    const capped = await buildApp({ db, config: testConfig(), logger: false, limiter })
    let n = 0
    const attempt = (email: string, password: string) =>
      capped.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email, password }, remoteAddress: `10.30.${n >> 8}.${n++ & 255}` })
    for (let i = 0; i < 4; i++) expect((await attempt(ADMIN.email, 'wrong-password')).statusCode).toBe(401)
    for (const p of TRIMMED_SPACES) {
      // Trimming first and slicing to 254 after cut the x off, and the lookup trimmed the rest away.
      expect((await attempt(`${ADMIN.email}${p.repeat(240)}x`, ADMIN.password)).statusCode, codePoint(p)).toBe(401)
      expect((await attempt(`${p}${ADMIN.email}${p}`, ADMIN.password)).statusCode, codePoint(p)).toBe(429)
    }
    expect((await attempt(ADMIN.email, ADMIN.password)).statusCode).toBe(429)
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(4)
    await capped.close()
  })

  it('charges sign-ins that cannot succeed to the client address only, without a password check', async () => {
    const limiter = new LoginRateLimiter()
    const lookups: string[] = []
    const spied = await buildApp({ db: spyOnEmailLookups(db, lookups), config: testConfig(), logger: false, limiter })
    const hopeless = [
      { email: ADMIN.email, password: '' },
      { email: ADMIN.email, password: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) },
      { email: '', password: ADMIN.password },
      { email: ' \t　﻿', password: ADMIN.password },
      { email: `${'a'.repeat(243)}@example.com`, password: ADMIN.password },
    ]
    for (let i = 0; i < 10; i++) {
      const res = await spied.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: hopeless[i % hopeless.length], remoteAddress: '10.40.0.1' })
      expect(res.statusCode, String(i)).toBe(401)
      expect(res.json()).toEqual({ error: 'invalid_credentials' })
    }
    expect(lookups).toEqual([])
    expect(limiter.size).toBe(1)
    expect(limiter.count('ip:10.40.0.1')).toBe(10)
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(0)
    // They still use up the address's own attempts.
    const blocked = await spied.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: ADMIN, remoteAddress: '10.40.0.1' })
    expect(blocked.statusCode).toBe(429)
    await spied.close()
  })

  it('lets the admin sign in after cheap sign-ins from many addresses filled the address limit with lockouts', async () => {
    const limiter = new LoginRateLimiter({ maxKeys: 20 })
    const flooded = await buildApp({ db, config: testConfig(), logger: false, limiter })
    const login = (payload: { email: string; password: string }, remoteAddress: string) =>
      flooded.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload, remoteAddress })
    expect((await login(ADMIN, '198.51.100.7')).statusCode).toBe(200)
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 10; j++) expect((await login({ email: `x${i}@example.com`, password: '' }, `10.50.0.${i}`)).statusCode).toBe(401)
    }
    expect((await login({ email: 'x0@example.com', password: '' }, '10.50.0.0')).statusCode).toBe(429)
    // From home (its key was pushed out by the flood) and from an address the limiter never saw.
    expect((await login(ADMIN, '198.51.100.7')).statusCode).toBe(200)
    expect((await login(ADMIN, '203.0.113.5')).statusCode).toBe(200)
    await flooded.close()
  })

  it('does not let sign-ins refused as busy push the admin failure count out of the limiter', async () => {
    const limiter = new LoginRateLimiter({ maxKeys: 8, perEmailFailures: 3 })
    const gate = new ConcurrencyGate(1, 0)
    const busy = await buildApp({ db, config: testConfig(), logger: false, limiter, passwordGate: gate })
    const attempt = (email: string, password: string, remoteAddress: string) =>
      busy.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email, password }, remoteAddress })
    for (let i = 0; i < 2; i++) expect((await attempt(ADMIN.email, 'wrong-password', `10.50.0.${i + 1}`)).statusCode).toBe(401)
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(2)
    // Hold the only password-check slot, then flood the server with throwaway emails.
    let release: () => void = () => {}
    const held = gate.run(() => new Promise<void>((resolve) => (release = resolve)))
    for (let i = 0; i < 40; i++) {
      const res = await attempt(`junk${i}@example.com`, 'wrong-password', `10.51.0.${i + 1}`)
      expect(res.statusCode).toBe(429)
      expect(res.json()).toEqual({ error: 'busy', retryAfter: 5 })
    }
    release()
    await held
    expect(limiter.count(`email:${ADMIN.email}`)).toBe(2)
    // Each refused sign-in counted against its address only.
    expect(limiter.count('email:junk39@example.com')).toBe(0)
    expect(limiter.count('email-ip:junk39@example.com|10.51.0.40')).toBe(0)
    expect(limiter.count('ip:10.51.0.40')).toBe(1)
    // One more failure reaches the cap.
    expect((await attempt(ADMIN.email, 'wrong-password', '10.50.0.3')).statusCode).toBe(401)
    expect((await attempt(ADMIN.email, ADMIN.password, '10.50.0.4')).statusCode).toBe(429)
    await busy.close()
  })

  it('counts IPv6 clients per /64, so rotating addresses does not get around the limit', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: CSRF,
        payload: { email: `user${i}@example.com`, password: 'wrong-password' },
        remoteAddress: `2001:db8:1:2::${(i + 1).toString(16)}`,
      })
      expect(res.statusCode).toBe(401)
    }
    const rotated = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: ADMIN, remoteAddress: '2001:db8:1:2:ffff:1:2:3' })
    expect(rotated.statusCode).toBe(429)
    const otherNetwork = await app.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: ADMIN, remoteAddress: '2001:db8:1:3::1' })
    expect(otherNetwork.statusCode).toBe(200)
  })

  it('refuses sign-ins while too many password checks are waiting', async () => {
    // Hashed at the real cost, the first check still holds the only slot when the other two arrive (a
    // check at the test cost might finish first).
    await upsertAdmin(db, ADMIN.email, ADMIN.password)
    const gate = new ConcurrencyGate(1, 0)
    const busy = await buildApp({ db, config: testConfig(), logger: false, passwordGate: gate })
    const attempt = (i: number) =>
      busy.inject({ method: 'POST', url: '/api/auth/login', headers: CSRF, payload: { email: ADMIN.email, password: 'wrong-password' }, remoteAddress: `10.0.3.${i}` })
    const results = await Promise.all([attempt(1), attempt(2), attempt(3)])
    const codes = results.map((r) => r.statusCode)
    expect(codes).toContain(401)
    expect(codes).toContain(429)
    const refused = results.find((r) => r.statusCode === 429)!
    expect(refused.json()).toEqual({ error: 'busy', retryAfter: 5 })
    expect(refused.headers['retry-after']).toBe('5')
    await busy.close()
  })
})
