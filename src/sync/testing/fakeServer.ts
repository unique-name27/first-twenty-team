// An in-memory First Twenty server for sync tests: implements the SyncApi contract from docs/SYNC.md
// (versions, conflicts, change log with seq, resync after pruning, history ids, one admin session) without
// HTTP. As a demo server (signupOpen) it also signs up new logins and takes invites, for one company at a
// time: the workspace it holds is the signed-in login's. switchCompany makes it another company's server
// (another login, its own workspace id), for tests of a browser that holds one company's copy.
// Versions work like server/src/repo.ts: every accepted write (and every row of a full replace) takes the
// next workspace-wide seq as its version, so a record's next version is rarely its old one plus 1.
// Test-only: nothing in the app imports it.
import type { DB } from '@/domain/types'
import type {
  AcceptInviteInput,
  ApiFailure,
  ApiResult,
  PushOptions,
  SignupInput,
  SyncApi,
  WorkspaceStatusOptions,
  WorkspaceStatusResult,
} from '../api'
import { DOC_COLLECTION, DOC_KEYS, isDocKey, isRecordCollection, RECORD_COLLECTIONS } from '../collections'
import {
  type AccountResponse,
  type Applied,
  type CareersSwitchResponse,
  type Change,
  type ChangesResponse,
  type ClientChange,
  type Conflict,
  type HealthResponse,
  type InviteInfo,
  type InviteResponse,
  type LoginResponse,
  type MeResponse,
  type OpenInvite,
  type PostChangesResponse,
  type PutWorkspaceResponse,
  recordKey,
  type ServerWorkspace,
  type SessionResponse,
  type SignupModeResponse,
  type SyncUser,
  type WorkspaceSnapshot,
} from '../protocol'

/** by: the user who wrote it (null: unknown, like a row from before users). */
type Row = { collection: string; id: string; version: number; data: unknown; by: string | null }

const wire = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

export const TEST_ADMIN_EMAIL = 'admin@example.test'
/** A test-only value; the fake server has no real accounts. */
export const TEST_ADMIN_PASSWORD = 'test-only-not-a-secret'
/** The user serverUpsert and serverDelete write as unless told otherwise: someone other than the admin. */
export const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002'

export class FakeServer implements SyncApi {
  online = true
  signedIn = true
  hasWorkspace = false
  /** Most changes per GET /api/changes page. */
  pageSize = 5000
  /** The newest seq. Every accepted write takes the next one, and it is also that write's version. */
  seq = 0
  /** Log rows at or below this seq were pruned: a client asking from before it must resync. */
  minSeq = 0
  /** Names the current history; a full replace starts a new one. */
  historyId = 'history-1'
  /** False acts like a server from before history ids: none sent, none checked. */
  historyIds = true
  /**
   * False acts like a server from before GET /api/workspace/status: workspaceStatus answers as the app's
   * client does then (it asks getWorkspace instead, or says not_found without the fallback).
   */
  statusRoute = true
  private histories = 1
  rows = new Map<string, Row>()
  lastVersion = new Map<string, number>()
  lastOp = new Map<string, 'upsert' | 'delete'>()
  /** Who wrote each record's newest change (its upsert or its delete). */
  lastBy = new Map<string, string | null>()
  log: Change[] = []
  /** Every call, in order, and when it was made (Date.now(), fake timers in tests). */
  calls: string[] = []
  callTimes: number[] = []
  /** Every POST /api/changes body, in order. */
  pushes: ClientChange[][] = []
  /** The history id each pull and push carried, in order (null: none). */
  sentHistory: Array<string | null> = []
  keepalivePushes = 0
  /** Forced failures, used up one per call. */
  failures: ApiFailure[] = []
  /** Record ids the server refuses (the whole POST answers 400 while one is in it). */
  refuseIds = new Set<string>()
  /** Hooks that run while a request is "on the wire" (to simulate edits made meanwhile). */
  onGetChanges: (() => void) | null = null
  onGetWorkspace: (() => void) | null = null
  /** The signed-in login (the admin, until a sign-up or an accepted invite signs someone else in). */
  user: SyncUser = { id: '00000000-0000-4000-8000-000000000001', email: TEST_ADMIN_EMAIL, role: 'admin' }
  /** A demo server: anyone may sign up (signupMode 'open'). */
  signupOpen = false
  /** What GET /api/auth/signup-mode says about demo expiry (undefined: nothing). */
  demoExpireDays: number | undefined = undefined
  /** The signed-in login's company, as GET /api/auth/me names it (null: a server from before companies). */
  workspace: ServerWorkspace | null = null
  /** The careers origin (CAREERS_ORIGIN); me() then names the company's careers page. */
  careersOrigin: string | null = null
  /** Whether the company's careers page is on (PUT /api/workspace/careers). */
  careersEnabled = true
  /** Emails with a login, besides the admin's. */
  logins = new Set<string>()
  /** Invite tokens -> the company each joins, its handle, and whether it was used (or revoked). */
  invites = new Map<string, { id: string; companyName: string; used: boolean }>()
  /** Logins of other companies (switchCompany): email -> the login and its company, password TEST_ADMIN_PASSWORD. */
  otherLogins = new Map<string, { user: SyncUser; workspace: ServerWorkspace }>()
  private accounts = 1

  private gate<T>(name: string, auth: boolean, fn: () => ApiResult<T>): Promise<ApiResult<T>> {
    this.calls.push(name)
    this.callTimes.push(Date.now())
    if (!this.online) return Promise.resolve({ ok: false, kind: 'offline', status: null, error: null })
    const forced = this.failures.shift()
    if (forced) return Promise.resolve(forced)
    if (auth && !this.signedIn) return Promise.resolve({ ok: false, kind: 'signed_out', status: 401, error: 'unauthorized' })
    return Promise.resolve(fn())
  }

  health(): Promise<ApiResult<HealthResponse>> {
    return this.gate('health', false, () => ({ ok: true, status: 200, data: { ok: true, db: 'up', version: 'test' } }))
  }

  login(email: string, password: string): Promise<ApiResult<LoginResponse>> {
    return this.gate<LoginResponse>('login', false, () => {
      const other = this.otherLogins.get(email.toLowerCase())
      if ((email.toLowerCase() !== TEST_ADMIN_EMAIL && !other) || password !== TEST_ADMIN_PASSWORD) {
        return { ok: false, kind: 'invalid_credentials', status: 401, error: 'invalid_credentials' }
      }
      this.signedIn = true
      // A login of the other company signs in to that company (the session's login decides, as on the real server).
      if (other) {
        this.user = { ...other.user }
        this.workspace = { ...other.workspace }
      }
      return { ok: true, status: 200, data: this.workspace ? { user: { ...this.user }, workspace: { ...this.workspace } } : { user: { ...this.user } } }
    })
  }

  /**
   * Makes this the server of another company from now on: its login (signed in, as after a sign-in on
   * another tab), its workspace id, and `db` as its workspace (a fresh history). The login is also
   * remembered for login() with TEST_ADMIN_PASSWORD.
   */
  switchCompany(workspace: ServerWorkspace, user: SyncUser, db: DB | null): void {
    this.otherLogins.set(user.email, { user: { ...user }, workspace: { ...workspace } })
    this.user = { ...user }
    this.workspace = { ...workspace }
    this.signedIn = true
    if (db) {
      this.loseWorkspace()
      const src = wire(db) as unknown as Record<string, unknown>
      for (const k of DOC_KEYS) if (src[k] !== undefined) this.write(DOC_COLLECTION, k, src[k], user.id)
      for (const c of RECORD_COLLECTIONS) for (const r of (src[c] as Array<{ id: string }>) ?? []) this.write(c, r.id, r, user.id)
      this.minSeq = this.seq
      this.hasWorkspace = true
      this.newHistory()
    }
  }

  /** The workspace id the server answers with: the signed-in login's company, or 'default' (one company). */
  private workspaceId(): string {
    return this.workspace?.id ?? 'default'
  }

  logout(): Promise<ApiResult<null>> {
    return this.gate('logout', false, () => {
      this.signedIn = false
      return { ok: true, status: 204, data: null }
    })
  }

  me(): Promise<ApiResult<MeResponse>> {
    return this.gate<MeResponse>('me', true, () => {
      const data: MeResponse = { user: { ...this.user } }
      if (this.workspace) {
        data.workspace = { ...this.workspace }
        data.careersUrl = this.careersOrigin ? `${this.careersOrigin}/${this.workspace.slug}/` : null
        data.careersEnabled = this.careersEnabled
        data.signupMode = this.signupOpen ? 'open' : 'closed'
      }
      return { ok: true, status: 200, data }
    })
  }

  signupMode(): Promise<ApiResult<SignupModeResponse>> {
    return this.gate<SignupModeResponse>('signupMode', false, () => {
      const data: SignupModeResponse = { signupMode: this.signupOpen ? 'open' : 'closed' }
      if (this.demoExpireDays !== undefined) data.demoExpireDays = this.demoExpireDays
      return { ok: true, status: 200, data }
    })
  }

  /** Signs a new login in: the fake keeps one company, so this login's company is the one it holds. */
  private newLogin(email: string, role: string): SyncUser {
    this.accounts += 1
    this.logins.add(email)
    this.user = { id: `00000000-0000-4000-8000-${String(100 + this.accounts).padStart(12, '0')}`, email, role }
    this.signedIn = true
    return { ...this.user }
  }

  private taken(email: string): boolean {
    return email === TEST_ADMIN_EMAIL || this.logins.has(email)
  }

  signup(input: SignupInput): Promise<ApiResult<AccountResponse>> {
    return this.gate<AccountResponse>('signup', false, () => {
      if (!this.signupOpen) return { ok: false, kind: 'not_found', status: 404, error: 'not_found' }
      const email = input.email.trim().toLowerCase()
      if (this.taken(email)) return { ok: false, kind: 'email_taken', status: 409, error: 'email_taken' }
      const name = input.companyName.trim()
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'company'
      const user = this.newLogin(email, 'admin')
      this.workspace = { id: `ws-${this.accounts}`, name, slug }
      return { ok: true, status: 201, data: { user, workspace: { ...this.workspace } } }
    })
  }

  createInvite(): Promise<ApiResult<InviteResponse>> {
    return this.gate<InviteResponse>('createInvite', true, () => {
      if (this.user.role !== 'admin') return { ok: false, kind: 'forbidden', status: 403, error: 'forbidden' }
      const token = `test-invite-${this.invites.size + 1}-abcdefghijklmnop`
      this.invites.set(token, { id: `invite-${this.invites.size + 1}`, companyName: this.workspace?.name ?? 'Acme', used: false })
      return { ok: true, status: 201, data: { url: `https://demo.example.test/#invite.${token}`, expiresAt: '2026-10-17T17:00:00.000Z' } }
    })
  }

  listInvites(): Promise<ApiResult<OpenInvite[]>> {
    return this.gate<OpenInvite[]>('listInvites', true, () => {
      if (this.user.role !== 'admin') return { ok: false, kind: 'forbidden', status: 403, error: 'forbidden' }
      const open = [...this.invites.values()].filter((i) => !i.used)
      return { ok: true, status: 200, data: open.map((i) => ({ id: i.id, createdAt: '2026-10-10T17:00:00.000Z', expiresAt: '2026-10-17T17:00:00.000Z', createdBy: this.user.email })) }
    })
  }

  revokeInvite(id: string): Promise<ApiResult<null>> {
    return this.gate<null>('revokeInvite', true, () => {
      if (this.user.role !== 'admin') return { ok: false, kind: 'forbidden', status: 403, error: 'forbidden' }
      const invite = [...this.invites.values()].find((i) => i.id === id && !i.used)
      if (!invite) return { ok: false, kind: 'not_found', status: 404, error: 'not_found' }
      invite.used = true
      return { ok: true, status: 204, data: null }
    })
  }

  setCareers(enabled: boolean): Promise<ApiResult<CareersSwitchResponse>> {
    return this.gate<CareersSwitchResponse>('setCareers', true, () => {
      if (this.user.role !== 'admin') return { ok: false, kind: 'forbidden', status: 403, error: 'forbidden' }
      this.careersEnabled = enabled
      const careersUrl = this.careersOrigin && this.workspace ? `${this.careersOrigin}/${this.workspace.slug}/` : null
      return { ok: true, status: 200, data: { careersUrl, careersEnabled: enabled } }
    })
  }

  inviteInfo(token: string): Promise<ApiResult<InviteInfo>> {
    return this.gate<InviteInfo>('inviteInfo', false, () => {
      const invite = this.invites.get(token)
      return invite && !invite.used
        ? { ok: true, status: 200, data: { companyName: invite.companyName } }
        : { ok: false, kind: 'not_found', status: 404, error: 'not_found' }
    })
  }

  acceptInvite(input: AcceptInviteInput): Promise<ApiResult<AccountResponse>> {
    return this.gate<AccountResponse>('acceptInvite', false, () => {
      const invite = this.invites.get(input.token)
      if (!invite || invite.used) return { ok: false, kind: 'not_found', status: 404, error: 'not_found' }
      const email = input.email.trim().toLowerCase()
      if (this.taken(email)) return { ok: false, kind: 'email_taken', status: 409, error: 'email_taken' }
      invite.used = true
      const user = this.newLogin(email, 'admin')
      return { ok: true, status: 201, data: { user, workspace: this.workspace ? { ...this.workspace } : null } }
    })
  }

  session(): Promise<ApiResult<SessionResponse>> {
    return this.gate<SessionResponse>('session', false, () => {
      if (!this.signedIn) return { ok: true, status: 200, data: { user: null } }
      return { ok: true, status: 200, data: this.workspace ? { user: { ...this.user }, workspace: { ...this.workspace } } : { user: { ...this.user } } }
    })
  }

  getWorkspace(): Promise<ApiResult<WorkspaceSnapshot>> {
    return this.gate<WorkspaceSnapshot>('getWorkspace', true, () => {
      this.onGetWorkspace?.()
      if (!this.hasWorkspace) return { ok: false, kind: 'empty', status: 404, error: 'empty' }
      const snap: WorkspaceSnapshot = { workspaceId: this.workspaceId(), seq: this.seq, db: this.snapshot(), versions: this.versions() }
      if (this.historyIds) snap.historyId = this.historyId
      return { ok: true, status: 200, data: snap }
    })
  }

  async workspaceStatus(opts?: WorkspaceStatusOptions): Promise<ApiResult<WorkspaceStatusResult>> {
    if (!this.statusRoute) {
      this.calls.push('workspaceStatus')
      this.callTimes.push(Date.now())
      if (opts?.fallback === false) return { ok: false, kind: 'not_found', status: 404, error: 'not_found' }
      const snap = await this.getWorkspace()
      if (snap.ok) return { ok: true, status: 200, data: { empty: false, workspaceId: snap.data.workspaceId, seq: snap.data.seq, snapshot: snap.data } }
      return snap.kind === 'empty' ? { ok: true, status: 404, data: { empty: true } } : snap
    }
    return this.gate<WorkspaceStatusResult>('workspaceStatus', true, () =>
      this.hasWorkspace
        ? { ok: true, status: 200, data: { empty: false, workspaceId: this.workspaceId(), seq: this.seq, ...this.history() } }
        : { ok: true, status: 200, data: { empty: true } },
    )
  }

  putWorkspace(db: DB, confirmReplace?: boolean): Promise<ApiResult<PutWorkspaceResponse>> {
    return this.gate<PutWorkspaceResponse>('putWorkspace', true, () => {
      if (this.hasWorkspace && !confirmReplace) return { ok: false, kind: 'not_empty', status: 409, error: 'not_empty' }
      const src = wire(db) as unknown as Record<string, unknown>
      // Like the real server, a replace forgets the old rows and their log, and every row it writes takes
      // the next seq (documents first, then each collection in order): versions keep growing.
      this.rows.clear()
      this.lastVersion.clear()
      this.lastOp.clear()
      this.lastBy.clear()
      for (const k of DOC_KEYS) if (src[k] !== undefined) this.write(DOC_COLLECTION, k, src[k], this.user.id)
      for (const c of RECORD_COLLECTIONS) {
        for (const r of (src[c] as Array<{ id: string }>) ?? []) this.write(c, r.id, r, this.user.id)
      }
      // A replace starts a new log: every other client has to resync.
      this.minSeq = this.seq
      this.log = []
      this.hasWorkspace = true
      this.newHistory()
      // Servers from before companies do not name the workspace; this fake does once it holds a company.
      return { ok: true, status: 200, data: { ...(this.workspace ? { workspaceId: this.workspace.id } : {}), ...this.history(), seq: this.seq, versions: this.versions() } }
    })
  }

  getChanges(since: number, historyId?: string | null): Promise<ApiResult<ChangesResponse>> {
    return this.gate<ChangesResponse>('getChanges', true, () => {
      this.onGetChanges?.()
      this.sentHistory.push(historyId ?? null)
      if (this.historyIds && historyId && historyId !== this.historyId) return { ok: true, status: 200, data: { resync: true } }
      if (!this.hasWorkspace || since < this.minSeq || since > this.seq) return { ok: true, status: 200, data: { resync: true } }
      const after = this.log.filter((c) => c.seq > since)
      const page = after.slice(0, this.pageSize)
      const more = after.length > page.length
      return { ok: true, status: 200, data: { ...this.history(), seq: more ? page[page.length - 1].seq : this.seq, changes: wire(page), more } }
    })
  }

  postChanges(changes: ClientChange[], opts?: PushOptions): Promise<ApiResult<PostChangesResponse>> {
    return this.gate<PostChangesResponse>('postChanges', true, () => {
      this.pushes.push(wire(changes))
      this.sentHistory.push(opts?.historyId ?? null)
      if (opts?.keepalive) this.keepalivePushes++
      if (this.historyIds && opts?.historyId && opts.historyId !== this.historyId) return { ok: false, kind: 'resync', status: 409, error: 'resync' }
      if (!this.hasWorkspace) return { ok: false, kind: 'empty', status: 404, error: 'empty' }
      for (const ch of changes) {
        const knownCollection = isRecordCollection(ch.collection) || (ch.collection === DOC_COLLECTION && isDocKey(ch.id))
        const badRecord =
          ch.op === 'upsert' && isRecordCollection(ch.collection) && (ch.data as { id?: unknown } | null)?.id !== ch.id
        if (!knownCollection || badRecord || this.refuseIds.has(ch.id)) {
          return { ok: false, kind: 'bad_request', status: 400, error: 'invalid_change' }
        }
      }
      const applied: Applied[] = []
      const conflicts: Conflict[] = []
      // The same rules as server/src/repo.ts applyChanges.
      const byYou = (by: string | null | undefined) => (by === this.user.id ? { byYou: true as const } : {})
      // This exact upsert is in the log after its base (the real server forgets a record's rows on delete).
      const landed = (ch: ClientChange) => {
        if (ch.op !== 'upsert') return {}
        const json = JSON.stringify(ch.data)
        let found = false
        for (const c of this.log) {
          if (c.collection !== ch.collection || c.id !== ch.id) continue
          if (c.op === 'delete') found = false
          else if (c.seq > (ch.baseVersion ?? 0) && JSON.stringify(c.data) === json) found = true
        }
        return found ? { landed: true as const } : {}
      }
      for (const ch of changes) {
        const key = recordKey(ch.collection, ch.id)
        const row = this.rows.get(key)
        if (row) {
          if (ch.baseVersion !== row.version) {
            if (ch.op === 'upsert' && JSON.stringify(row.data) === JSON.stringify(ch.data)) {
              applied.push({ collection: ch.collection, id: ch.id, version: row.version, existing: true })
            } else {
              conflicts.push({ collection: ch.collection, id: ch.id, serverVersion: row.version, serverData: wire(row.data), ...byYou(row.by), ...landed(ch) })
            }
            continue
          }
        } else {
          if (ch.op === 'delete') {
            // Already gone: the client's intent holds.
            applied.push({ collection: ch.collection, id: ch.id, version: this.lastVersion.get(key) ?? 0 })
            continue
          }
          // A record comes back only from a client that believes it is new or saw the delete.
          const deleted = this.lastOp.get(key) === 'delete'
          const sawDelete = deleted && ch.baseVersion !== null && ch.baseVersion >= (this.lastVersion.get(key) ?? 0)
          if (ch.baseVersion !== null && !sawDelete && ch.collection !== DOC_COLLECTION) {
            conflicts.push({ collection: ch.collection, id: ch.id, serverVersion: null, serverData: null, ...(deleted ? byYou(this.lastBy.get(key)) : {}) })
            continue
          }
        }
        const version = this.commit(ch.collection, ch.id, ch.op, ch.data, this.user.id)
        applied.push({ collection: ch.collection, id: ch.id, version })
      }
      return { ok: true, status: 200, data: { ...this.history(), seq: this.seq, applied, conflicts } }
    })
  }

  // ------------------------------------------------------------------------------------------
  // Test controls: another device writing, pruning the log, reading the server's state.
  // ------------------------------------------------------------------------------------------

  /**
   * Another device saves a record (always accepted). `by`: who wrote it, another user unless told (pass
   * server.user.id for the admin on another computer).
   */
  serverUpsert(collection: string, id: string, data: unknown, by: string | null = OTHER_USER_ID): number {
    return this.commit(collection, id, 'upsert', data, by)
  }

  serverDelete(collection: string, id: string, by: string | null = OTHER_USER_ID): number {
    return this.commit(collection, id, 'delete', undefined, by)
  }

  /**
   * The next `n` POST /api/changes commit on the server, but the answer never reaches the browser (a
   * timeout, a dropped mobile connection, a page frozen after a keepalive flush).
   */
  loseResponses(n = 1): void {
    let left = n
    const real = FakeServer.prototype.postChanges.bind(this)
    this.postChanges = async (changes, opts) => {
      const res = await real(changes, opts)
      if (left <= 0) return res
      left -= 1
      return { ok: false, kind: 'offline', status: null, error: null }
    }
  }

  /** The server lost its workspace (its database was reset or rebuilt, or restored from an empty backup). */
  loseWorkspace(): void {
    this.hasWorkspace = false
    this.rows.clear()
    this.lastVersion.clear()
    this.lastOp.clear()
    this.lastBy.clear()
    this.log = []
    this.minSeq = this.seq
  }

  /** A restore (npm run server:after-restore): same rows, a new history, every client resyncs. */
  restore(): void {
    this.seq += 1
    this.minSeq = this.seq
    this.log = []
    this.newHistory()
  }

  private newHistory(): void {
    this.histories += 1
    this.historyId = `history-${this.histories}`
  }

  private history(): { historyId?: string } {
    return this.historyIds ? { historyId: this.historyId } : {}
  }

  /** Drops every log row so far: clients behind the current seq get resync. */
  prune(): void {
    this.minSeq = this.seq
    this.log = []
  }

  snapshot(): DB {
    const db: Record<string, unknown> = { schemaVersion: 1 }
    for (const c of RECORD_COLLECTIONS) db[c] = []
    for (const row of this.rows.values()) {
      if (row.collection === DOC_COLLECTION) db[row.id] = wire(row.data)
      // A collection a newer build added (serverUpsert lets tests write one).
      else ((db[row.collection] ??= []) as unknown[]).push(wire(row.data))
    }
    return db as unknown as DB
  }

  versions(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [key, row] of this.rows) out[key] = row.version
    return out
  }

  record(collection: string, id: string): unknown {
    return wire(this.rows.get(recordKey(collection, id))?.data)
  }

  callCount(name: string): number {
    return this.calls.filter((c) => c === name).length
  }

  /** When each call of this kind was made. */
  timesOf(name: string): number[] {
    return this.callTimes.filter((_t, i) => this.calls[i] === name)
  }

  /** Stores a row at the next seq, which is its version. */
  private write(collection: string, id: string, data: unknown, by: string | null): number {
    const key = recordKey(collection, id)
    const version = ++this.seq
    this.lastVersion.set(key, version)
    this.lastBy.set(key, by)
    this.rows.set(key, { collection, id, version, data: wire(data), by })
    return version
  }

  private commit(collection: string, id: string, op: 'upsert' | 'delete', data: unknown, by: string | null): number {
    const key = recordKey(collection, id)
    let version: number
    this.lastOp.set(key, op)
    this.lastBy.set(key, by)
    if (op === 'upsert') version = this.write(collection, id, data, by)
    else {
      version = ++this.seq
      this.lastVersion.set(key, version)
      this.rows.delete(key)
    }
    this.log.push(op === 'upsert' ? { seq: version, collection, id, op, version, data: wire(data) } : { seq: version, collection, id, op, version })
    this.hasWorkspace = true
    return version
  }
}

/** One device's own connection to a shared server, so one device can go offline while another stays on. */
export type DeviceLink = SyncApi & { online: boolean }

export function deviceLink(server: SyncApi): DeviceLink {
  const offline = <T>(): Promise<ApiResult<T>> => Promise.resolve({ ok: false, kind: 'offline', status: null, error: null })
  const link: DeviceLink = {
    online: true,
    health: () => (link.online ? server.health() : offline()),
    login: (email, password, opts) => (link.online ? server.login(email, password, opts) : offline()),
    logout: () => (link.online ? server.logout() : offline()),
    me: () => (link.online ? server.me() : offline()),
    signupMode: () => (link.online ? server.signupMode() : offline()),
    signup: (input) => (link.online ? server.signup(input) : offline()),
    createInvite: () => (link.online ? server.createInvite() : offline()),
    listInvites: () => (link.online ? server.listInvites() : offline()),
    revokeInvite: (id) => (link.online ? server.revokeInvite(id) : offline()),
    inviteInfo: (token) => (link.online ? server.inviteInfo(token) : offline()),
    setCareers: (enabled) => (link.online ? server.setCareers(enabled) : offline()),
    acceptInvite: (input) => (link.online ? server.acceptInvite(input) : offline()),
    session: () => (link.online ? server.session() : offline()),
    getWorkspace: () => (link.online ? server.getWorkspace() : offline()),
    workspaceStatus: (opts) => (link.online ? server.workspaceStatus(opts) : offline()),
    putWorkspace: (db, confirmReplace) => (link.online ? server.putWorkspace(db, confirmReplace) : offline()),
    getChanges: (since, historyId) => (link.online ? server.getChanges(since, historyId) : offline()),
    postChanges: (changes, opts) => (link.online ? server.postChanges(changes, opts) : offline()),
  }
  return link
}
