# Server and sync: contract

First Twenty stays local-first: it keeps working in the browser with no server, exactly as before. A
company that wants its data in its own database runs the **First Twenty server** next to Postgres on an
EC2 instance. The browser then syncs every change to the server, keeps working offline, and catches up
when the connection returns.

Decisions (from the user, October 2026):

- The API server runs **on the same EC2 instance as Postgres**. Postgres listens on localhost only; port
  5432 is never opened to the internet. The API is reached over HTTPS through Caddy on port 443.
- **Logins protect the data.** The server's own company starts with one admin login
  (`server:create-admin`); an admin can invite teammates with single-use links. Every login has full
  access to its company: Viewing as stays a preview (not security). Server-enforced roles can come later;
  the schema leaves room for them (`users.role`).
- **One server can hold many companies** (October 2026, for demos): with `SIGNUP_MODE=open` anyone can
  create a login and a demo company of their own, and many people use the server at once. Each login
  belongs to exactly one company, and the server takes the company from the session, never from a request
  (see Companies). Demo companies unused for `DEMO_EXPIRE_DAYS` are deleted.
- **One table per record type, holding JSONB**: `people`, `candidates`, `jobs`, ... each with
  `(workspace_id, id, data jsonb, version, updated_at, updated_by)`.

## Pieces

| Piece | Where | Notes |
|---|---|---|
| API server | `server/src/**` (Fastify 5 + `pg`), built into `dist-server/server.mjs` with Vite SSR | Node 22+. Serves `/api/*` and, when `SERVE_APP=true`, the one-file app at `/` and its offline worker at `/sw.js`. |
| SQL migrations | `server/sql/NNN_name.sql`, applied by `npm run server:migrate` | Tracked in `schema_migrations`. Each is listed with its SHA-256 in `server/sql/SHA256SUMS` (`npm run server:gen-sql -- --checksums`), so an applied one cannot change unnoticed. |
| Shared collection list | `src/sync/collections.ts` | The single source of truth for which DB keys are record collections (one table each) and which are single documents. Server and client both import it. A test asserts it matches `src/domain/types.ts`. |
| Browser sync engine | `src/sync/**` | Diff, outbox, API client, pull/push loop, status store. No UI. Also the assistant's client (`src/sync/assistant.ts`, with the event-stream reader `src/sync/sse.ts`): `assistantInfo()` and `assistantChat()`, never synced. |
| Sync UI | Settings > Server (`#settings.server`), a header status chip, sync banners under the header, the rail note, the sample banner | Opened from a file or the claude.ai artifact viewer, Settings > Server only explains the server and makes no request. A browser that is not connected asks once per page load (`checkServer`) whether a server answers here: for the sample on any page served over http(s), and for any other workspace only on a page the server served (`isServedPage()`, the served mark), so the Vite dev server or a file never probes `/api` for it. If one does, the sample banner offers "Sign in to your server" (or, signed in to an empty server, Start fresh, which then uploads, and Import a backup) before Start fresh, the rail note says where to sign in, and a dismissible notice points a workspace of the company's own at the server while it lives in this browser only. A sign-in asks again; connecting or disconnecting updates the answer. `checkServer` asks `GET /api/auth/session`, so a browser that is not signed in logs no 401 on a normal page load, and, signed in and not connected, `GET /api/workspace/status` (`empty`; never the old servers' fallback, which would download the workspace). |
| Offline worker | `server/src/offline.ts` (served at `/sw.js`), registered by `src/main.tsx` | Keeps the latest app page, so a page the server served opens again from the browser's copy while the server cannot be reached (see Opening while offline). |
| Deploy kit | `server/deploy/**` and `docs/SERVER.md` | EC2 setup script, systemd unit, Caddyfile, Postgres role and database SQL, backups, SSH tunnel for development. |
| Dev database | `DATABASE_URL=pglite:./.data/pg` (default when unset in development) | PGlite (real Postgres in WebAssembly) so development and tests need no Postgres install. Production always uses `pg`. |

## Data layout

- **Record collections**: every key of `DB` whose value is an array of `{ id }` records (people, comp,
  grants, contractors, documents, plan, jobs, candidates, applications, interviews, scorecards, offers,
  referrals, emailTemplates, checklistTemplates, checklists, timeOffPolicies, timeOffRequests,
  timeOffAdjustments, holidays, leaveCases, recurring, trainings, policies, acks, recordsRequests, activity,
  departments, locations, families, levels, bands). Table name = snake_case of the key
  (`timeOffRequests` -> `time_off_requests`). Columns: `workspace_id text`, `id text`, `data jsonb not null`,
  `version bigint not null`, `updated_at timestamptz not null`, `updated_by uuid null`;
  primary key `(workspace_id, id)`.
- **Versions** are the change-log `seq` of the write that produced them (migration 002). They never
  repeat within a workspace and only grow per record, across delete and re-create, a full replace and a
  restore, so a stale `baseVersion` can only match the write it was based on. Clients must treat them as
  opaque numbers up to 2^53 (they jump by a billion after a restore). Each workspace counts its own seqs
  (migration 005: `workspaces.last_seq + 1`, taken under the workspace row lock every write holds), so two
  companies' numbers say nothing about each other's writes, and the same number means different writes in
  different workspaces.
- **Documents** (non-array keys): `meta`, `company`, `equity`, `complianceStatus`, `inboxState`,
  `settings` live in `workspace_docs (workspace_id, key, data jsonb, version, updated_at, updated_by)`.
  In the protocol they use the collection name `$doc` and `id` = the key.
- `schemaVersion` is not stored per row; the snapshot sets it.
- **Change log** `change_log (workspace_id, seq, collection, record_id, op, version, data jsonb null, at
  timestamptz, user_id uuid null)`, primary key `(workspace_id, seq)` (migration 005; before it, `seq` was
  one server-wide `bigserial`): every accepted write appends a row. Pulls read it. Rows older than 120 days
  are pruned daily; a client whose `since` is older than the oldest kept row gets `resync: true`. Seqs in a
  pull need not be contiguous: applying a delete removes that record's earlier rows (the delete row stays),
  in a demo company an upsert does too (one row per record), and a full replace removes every earlier row.
- **History id**: `workspaces.history_id uuid` names the current history. A full replace and
  `npm run server:after-restore` (run once after restoring a backup; it also moves the seq a billion
  ahead and sets `reset_seq` there) give it a new value.
- **Auth**: `users (id uuid, email text unique (stored lowercase), password_hash text, role text default
  'admin', created_at, last_login_at, workspace_id text not null)`, `sessions (token_hash text primary key,
  user_id, created_at, last_seen_at, expires_at, ip, user_agent)`, `trusted_devices (token_hash text
  primary key, user_id, created_at, expires_at)` (migration 003), `invites (token_hash text primary key,
  workspace_id, created_by, created_at, expires_at, used_at, used_by)` (migration 004) with `id uuid
  unique` (a handle to list and revoke one by) and `refused` (its `email_taken` answers) from migration 005.
- **Companies** (migrations 004 and 005): `workspaces (id, name, slug unique, keep, careers, bytes_used,
  created_by, last_active_at, ...)`. The server's own workspace is `'default'` (`WORKSPACE_ID`, kept); a
  demo sign-up adds one with a random id (`w-` and 24 hex characters) and `keep = false`. `slug` is the
  company's part of its careers page address: lowercase a-z, 0-9 and `-`, 3 to 40 characters, unique,
  never one of the reserved words (`admin`, `api`, `assets`, `careers`, `jobs`, `static`, `www`). A demo
  company's slug is its name's base and six random characters (`acme-robotics-k7m2qx`); the owner's
  workspace takes its name's base (`-2`, `-3` ... when taken) on its first upload while it still has the
  placeholder `default-workspace`. `released_slugs (slug, released_at)` keeps the slug of every deleted demo
  company, and no slug in it is handed out again. `careers` says whether the careers page is public (demo
  companies start on, kept workspaces off). `bytes_used` is the length of the workspace's record and
  document JSON, kept by every write once known (NULL until a demo company's first write counts it).
  Deleting a workspace deletes its logins and invites (foreign keys), and the expiry deletes its records,
  documents and change log in the same transaction.
- **Assistant use** (migration 006): `assistant_usage (workspace_id, day date, messages int, input_tokens
  bigint, cache_creation_input_tokens bigint, cache_read_input_tokens bigint, output_tokens bigint)`, primary
  key `(workspace_id, day)`, one row per company and UTC day: the messages its logins sent the assistant (the
  daily limits count these) and the tokens Claude read and wrote for them, by kind as the API bills them
  (input at full price, written to the prompt cache, read from it, and output with the thinking in it),
  counted for every turn, a turn that failed part way included. Nothing of what was asked or answered.
  Deleting a workspace deletes its rows (the foreign key cascades, and the expiry deletes them by name).
- **Read model** (migration 007, `server/src/readmodel`): views with typed columns over the record tables
  and `workspace_docs` (`v_people`, `v_hire_journey`, `v_integrity_problems`, ...) for reading with plain
  SQL (docs/DEV.md, "Query the data with SQL"). Read-only and outside sync: no triggers, nothing on the
  write path, and the app never reads them.

## Protocol (`/api`, JSON)

All requests are same-origin (the server serves the app, or the Vite dev server proxies `/api`).
Authentication is a session cookie: random 32 bytes, stored only as a SHA-256 hash, `HttpOnly`,
`SameSite=Strict`, and ended after 12 hours idle (`SESSION_IDLE_HOURS`). Over https it is
`__Host-ft_session` with `Secure` and `Path=/`; that is whenever `PUBLIC_ORIGIN` is https, and for any
request that reached Caddy over https (`X-Forwarded-Proto` from a trusted proxy) in any case. Browsers
refuse a `__Host-` cookie with a `Domain` or another path, so no other host can plant or shadow it, not
even a sibling under a shared parent domain like `*.sslip.io` (not a public suffix); the server never
reads the plain name in that mode. Over plain http (development, an SSH tunnel) it is `ft_session` with
`Path=/api`. When a request carries the session cookie's name twice, a failed session check does not
clear it, since the parser keeps the first, possibly planted, one. How long the session lives at most
depends on **Keep me signed in** (`remember` in the login body, default `false`):

- `remember: false` (or absent): a browser-session cookie (no `Max-Age` or `Expires`, so the browser drops
  it when it closes) and an absolute expiry of 12 hours on the server, even while the session is in use.
- `remember: true`: a cookie with `Max-Age` of `SESSION_MAX_DAYS` (7 days by default) and the same absolute
  expiry on the server.

Servers from before this option ignore `remember` and always give the 7-day cookie, so a client may send
it to any server.

A successful sign-in also sets a **trusted-device** cookie (`__Host-ft_device` over https, `ft_device`
over http, same attributes, `Max-Age` 180 days; only its SHA-256 is stored), replacing the one the browser
sent. It survives sign-out and grants nothing on its own: a later sign-in that carries it for the same
login skips the email and address limits and counts against the device's own limit instead (see the login
row). A user keeps at most 20; `server:create-admin` and `server:after-restore` forget them all.

Every non-GET request must send `X-First-Twenty: 1` (CSRF guard; browsers cannot set it cross-site
without a CORS preflight, which the server refuses). It is also refused when the browser's
`Sec-Fetch-Site` says anything but `same-origin` or `none`: under a shared parent domain, a sibling host's
requests are `same-site` and carry `SameSite=Strict` cookies. Clients that send no `Sec-Fetch-Site` (curl,
scripts) are not affected, and the development origin (`ALLOWED_ORIGIN`) is exempt.

| Method and path | Body | Response |
|---|---|---|
| `GET /api/health` | | `200 {ok: true, db: 'up', version}` or `503 {ok: false, db: 'down'}`. No auth. Never leaks details. |
| `POST /api/auth/login` | `{email, password, remember?: boolean}` (body limit 8 KB) | `200 {user: {id, email, role}, workspace: {id, name, slug}}` + cookie (`workspace`: the login's company; a browser that holds another company's copy refuses to carry on under it) (see `remember` above); `400` when `remember` is not a boolean; `401 {error: 'invalid_credentials'}`; `429 {error: 'rate_limited', retryAfter}` (per 15 minutes: 10 attempts per client address, IPv6 per /64; 10 per email from one address, cleared by a successful sign-in; 100 failures per email from all addresses; a sign-in with a valid trusted-device cookie for this login is held to none of these, only to 10 attempts per device, cleared by a successful sign-in, so failures from many addresses cannot lock its owner out); `429 {error: 'busy', retryAfter}` when too many password checks are waiting. The email is trimmed and lowercased once, and that one string is both the rate-limit key and the lookup (never cut short). A sign-in with no password check (empty email or password, an email over 254 characters after trimming, a password over 1,024 characters, or refused as busy) counts against the client address only. Each limit keeps at most 50,000 keys in memory. The two email limits never drop a key that holds a lockout; when every key of one holds one, a sign-in that needs a new email key gets `429 rate_limited` until the oldest lockout ends (filling them takes password checks, which run two at a time). Every sign-in adds an address key, even one with no password check, so when every address key holds a lockout the oldest one is forgotten instead: cheap sign-ins from many addresses cannot lock everyone else out. |
| `POST /api/auth/logout` | | `204`, session deleted and the cookie cleared (the trusted-device cookie stays). Clients treat `204` and `401` as "no session left"; anything else (no answer, `5xx`) means the session may still be open (see Sign-out below). |
| `GET /api/auth/signup-mode` | | `200 {signupMode: 'open' \| 'closed', demoExpireDays}`. No auth. Servers from before companies answer `404`, which means closed. |
| `POST /api/auth/signup` | `{email, password, companyName, remember?: boolean, website?: ''}` (body limit 8 KB) | Only with `SIGNUP_MODE=open`; otherwise the route does not exist (`404 {error: 'not_found'}`, before any body is read). Creates a company named `companyName` (2 to 80 characters, trimmed, no control characters) with a free slug (its base and six random characters, never one in use or released) and its careers page on, and its first login, an admin; signs in exactly like a sign-in (session and trusted-device cookies, `remember` as there). `201 {user: {id, email, role}, workspace: {id, name, slug}}`. The company starts empty: the app uploads a fresh one next (`PUT /api/workspace`, as for "Upload this browser's workspace"). `400` for a bad field (the email as for sign-in, the password rules of `server:create-admin`: 12 to 1,024 characters), or a `website` that is not empty (a field the app never shows). `409 {error: 'email_taken'}` when the email has a login anywhere on the server (after the same password hashing as a success, so it takes as long). `503 {error: 'demo_full'}` with `DEMO_MAX_WORKSPACES` demo companies (uploaded ones, and sign-ups from the last hour). `429 {error: 'rate_limited', retryAfter}` past 5 tries per client address (IPv6 per /64) or 60 companies created from all addresses per hour (only sign-ups that create a company stay in that count); `429 busy` as for sign-in. |
| `GET /api/auth/me` | | `200 {user, workspace: {id, name, slug}, careersUrl, careersEnabled, signupMode}` or `401`. `name` is the company document's name once uploaded, else the sign-up's `companyName`. `careersUrl` is `CAREERS_ORIGIN + '/' + slug + '/'`, or `null` when the server serves no careers pages; `careersEnabled` says whether that page is public. |
| `PUT /api/workspace/careers` | `{enabled: boolean}` (body limit 1 KB) | An admin of the signed-in login's company turns its careers page on or off: `200 {careersUrl, careersEnabled}`. `403 forbidden` for a login that is not an admin, `400` for a bad body. |
| `POST /api/invites` | none (body limit 1 KB) | An admin of the signed-in login's company: `201 {url, expiresAt}`, where `url` is `PUBLIC_ORIGIN + '/#invite.' + token` (the request's own origin when `PUBLIC_ORIGIN` is unset) and the token is 32 random bytes in base64url (only its SHA-256 is stored). Single use, 7 days. `401` without a session, `403 {error: 'forbidden'}` for a login that is not an admin, `429 {error: 'too_many_invites', retryAfter}` with 20 open (unused, unexpired) links, `429 {error: 'too_many_logins', retryAfter}` when logins and open links reach 50. Works whatever `SIGNUP_MODE` says. |
| `GET /api/invites` | | An admin: `200 {invites: [{id, createdAt, expiresAt, createdBy}]}`, the company's open links (never a token or its hash; `createdBy` is an email or null). |
| `DELETE /api/invites/:id` | | An admin revokes one of the company's open links: `204`, or `404 {error: 'not_found'}` when the company has no such open link (any other company's id is 404 too). |
| `POST /api/invites/lookup` | `{token}` (body limit 1 KB) | `200 {companyName}` for an unused, unexpired invite, else `404 {error: 'invalid_invite'}`. No auth (the token is the secret); 30 lookups per client address per 15 minutes (`429 rate_limited`), shared with `GET /api/invites/:token` and the token check of accept-invite. The app uses this form: the token stays out of every address, which proxies and access logs keep. |
| `GET /api/invites/:token` | | The same, for older apps. The server's log and Caddy's access log cut the token out of the path. |
| `POST /api/auth/accept-invite` | `{token, email, password, remember?: boolean}` (body limit 8 KB) | Creates the login (an admin) in the invite's company, marks the invite used and signs in like a sign-in: `201 {user, workspace}`. The token is checked first, against the lookup limit: `404 {error: 'invalid_invite'}` for a malformed, unknown, used, revoked or expired one, with no password hashing and no account limit spent. `409 email_taken` (the invite stops working after 3 of these), `400` for bad fields, `429 rate_limited` past 5 joins per client address per hour (no server-wide count: a company's 50 logins cap joins), `429 busy` as for sign-in. |
| `GET /api/auth/session` | | `200 {user, workspace}` when signed in (`workspace` as for sign-in), `200 {user: null}` when not: never `401`, which browsers log as a console error, so the app's checks on every page load (`checkServer`, the session probe on focus) use it. A cookie that names no live session is cleared, as on `/api/auth/me`. Servers from before it answer `404`; the client then asks `/api/auth/me` (a `401` there means nobody) for the rest of the page's life. |
| `GET /api/workspace` | | `200 {workspaceId, historyId, seq, db, versions}` where `versions` maps `"collection:id"` to version; `404 {error: 'empty'}` before the first upload (kept for older apps). |
| `GET /api/workspace/status` | | `200 {empty: true}` before the first upload, else `200 {empty: false, workspaceId, historyId, seq}`, with no records read: the app's "is it empty?" looks (the connect step, the `server_empty` hold, `checkServer`) use it, so an empty server is an answer and not a `404` in the console. `401` without a session. Servers from before it answer `404`; the client (`workspaceStatus()`) then asks `GET /api/workspace` instead for the rest of the page's life (its `empty` becomes `{empty: true}`, and a workspace comes along as `snapshot`), or, with `fallback: false` (`checkServer`), answers kind `not_found` without asking. |
| `PUT /api/workspace` | `{db, confirmReplace?: boolean}` | Replaces everything in one transaction and starts a new history. Allowed without `confirmReplace` only when the server is empty. `200 {workspaceId, historyId, seq, versions}` (`workspaceId`: the company that now holds it, which the browser keeps). Used for the first upload, Import and Start fresh. Body limit 10 MB. In a demo company, the demo limits of `POST /api/changes`. |
| `GET /api/changes?since=<seq>&history=<historyId>` | | `200 {historyId, seq, changes: Change[]}` (oldest first, at most 5,000 changes, and stopping at the one that takes the page past 8 MB of record JSON; `more: true` when cut short) or `200 {resync: true}`, also when `history` is given and is not the current history id. `history` is optional. |
| `POST /api/changes` | `{changes: ClientChange[], historyId?}` (at most 2,000) | `200 {historyId, seq, applied: Applied[], conflicts: Conflict[]}`. Applied in one transaction; each change independently accepted or rejected. `409 {error: 'resync'}` (nothing applied) when `historyId` is given and is not the current one: load the snapshot, rebase, then push again. In a demo company (see Companies), nothing applies on `413 {error: 'workspace_full'}` (past its records, its bytes, or what the demo companies may hold together), `413 {error: 'too_large'}` (a record over 64 KB) or `429 {error: 'write_limit', retryAfter}` (writing faster than the demo allows). |
| `GET /api/assistant` | | `200 {enabled, name, model, remainingToday}`: whether the assistant is on here (`ANTHROPIC_API_KEY` set, or `ASSISTANT_FAKE` in development), its name for the login's company (`assistantDisplayName` of the company document, `src/domain/assistant.ts`; before the first upload, from the sign-up's company name), the model (`null` when off) and the messages the company may still send today (`0` when off). `401` without a session. See The assistant below. |
| `POST /api/assistant/chat` | `{history, message}` (body limit 200 KB) | `200 text/event-stream` (see The assistant below). Refused before the stream starts: `503 {error: 'assistant_off'}` when the assistant is off; `400 {error: 'bad_request', detail}` for a body that is not `{history, message}` or a message that is blank or over 2,000 characters; `400 {error: 'bad_history', reason: 'malformed' \| 'too_long', detail}` for a history the server will not send on; `409 {error: 'assistant_busy'}` while this login already has an answer on its way; `409 {error: 'assistant_company_busy'}` while the company's logins have 2 answers on their way; `503 {error: 'assistant_full', retryAfter}` while the server runs 8 chats; `429 {error: 'assistant_quota', scope: 'workspace' \| 'global' \| 'reserve', remainingToday: 0}` when the company's or the server's messages for today (UTC) are used up (`reserve`: the server is down to the last quarter it keeps for companies that have asked fewer than 5 today). |

Types:

```ts
type Change = { seq: number; collection: string; id: string; op: 'upsert' | 'delete'; version: number; data?: unknown }
type ClientChange = { collection: string; id: string; op: 'upsert' | 'delete'; data?: unknown; baseVersion: number | null }
type Applied = { collection: string; id: string; version: number; existing?: true }
type Conflict = { collection: string; id: string; serverVersion: number | null; serverData: unknown | null; byYou?: true; landed?: true }
```

Rules:

- `collection` must be a known record collection or `$doc` (with a known doc key); anything else is
  `400`. Records must have `data.id === id`. Each record is at most 256 KB.
- `baseVersion` is the version the client last saw (`null` = the client believes it is new). The server
  accepts when it matches the current version, or the record does not exist and `baseVersion` is `null`,
  or the record was deleted and `baseVersion` is at least the delete's version (a client that saw the
  delete). A missing document is always recreated. Otherwise it returns a conflict with the server's
  current copy (`serverData` null when the record is gone): an edit made on a copy from before another
  device's delete loses to the delete, like any newer change, and never brings the record back. A client
  re-creates a record it deleted (Undo) as new: it forgets the version after its delete is applied or
  pulled, and sends `baseVersion: null`.
- An upsert whose data already equals the server's copy is applied without a write and marked
  `existing: true` (a retried push whose first attempt landed). A conflict carries `byYou: true` when the
  signed-in user wrote the server's copy (or the delete that removed it), from any device, and
  `landed: true` when the change log holds this exact upsert after `baseVersion` (an earlier attempt of it
  landed; the log forgets a record's upserts when it is deleted, and every row after 120 days). All three
  are additive: older clients ignore them, and older servers never send them.
- **The server wins conflicts.** The client replaces its copy with `serverData` (or removes it when
  `serverData` is null) and tells the user which items were refreshed (`refreshedKeys`, named and linked
  in the notice). The edit that lost leaves no trace: the Undo step that made it goes (when all of that
  step's record changes lost), and so do the activity rows that step logged while they were unsynced
  (still queued, or delivered in the same batch: then the client sends a delete), so neither Undo nor the
  activity log claims an edit that never landed. A step that also changed something that stayed keeps its
  place and its rows. After a reload there is no Undo history to read, so a lost record takes the unsynced
  rows whose `entityId` is that record. Two exceptions, both about pushes whose answers this browser lost
  (see Unanswered pushes): an activity row the server reports `existing` is history (an earlier push of
  its step landed), so it is never deleted and its step stays; and a retry of an attempt that `landed`,
  beaten by a copy the same user wrote (`byYou`), takes that copy quietly, with no notice.
- **Documents merge by field.** A `$doc` record holds unrelated panels (Settings > Company has eight), so
  the client also records which top-level fields it changed while the document is queued, each with a
  fingerprint of its value in the copy the edit was made on (`fieldBases`). On a conflict, when the
  server's copy still has the base value (or already this device's value) in every one of those fields,
  the client takes `serverData`, puts its own fields on top, and sends that on the server's version: both
  edits survive and nothing counts as refreshed. Otherwise (both changed one field, or a document queued
  by an older build without field prints) the server wins as above. Record collections always merge whole.
- Deletes are hard deletes in the record table plus a `delete` change in the log.
- Clients should send the `historyId` they last received with every pull and push. The server checks it
  only when it is sent, so older clients keep working; for them the seq-based versions and the
  `reset_seq` move after a restore still turn stale edits into conflicts.
- Requests that need a session are refused (`401`) before their bodies are read, and so are unknown paths
  and methods (`404 {error: 'not_found'}`). A request whose body has not arrived in full after 3 minutes
  is dropped (Node's `requestTimeout`; Caddy's `read_body` timeout matches it).

## Companies (`server/src/workspaces.ts`, migration 004)

- **The company comes from the session, and only from there.** Every route that needs a session works on
  the workspace of the session's login (`users.workspace_id`): `GET/PUT /api/workspace`,
  `/api/workspace/status`, `GET/POST /api/changes`, `/api/auth/me`, `POST /api/invites`, `/api/assistant`
  and `/api/assistant/chat` (whose lookups read that workspace alone). A workspace id,
  history id or record named in a request never reaches another company: an id names a record in the
  login's own company, and another company's history id is just a history this one does not have
  (`resync`). `server/src/tenants.test.ts` checks this for every registered route and fails when a route
  is added without a check. An invite token is the one way into a company from outside, and it joins
  only the company that made it.
- **Sign-up** (`SIGNUP_MODE=open`) makes a demo company: `keep = false`, its first login an admin, empty
  until the app uploads a fresh company (Settings > Server does that right after sign-up, the same flow as
  Start fresh without the sample). The owner's own workspace (`'default'`, kept) and its admin
  (`server:create-admin`, which only ever touches that workspace's logins) work as before.
- **Demo limits**, so one t3.micro serves many people at once and strangers cannot fill its disk or its
  memory: a demo company holds at most 20,000 records and 16 MB of record and document JSON (`413 {error:
  'workspace_full'}` on the push or upload that would pass either; the client sets such a change aside like
  a record over 256 KB), records of 64 KB at most (`413 too_large`), and the demo companies together at most
  `DEMO_MAX_TOTAL_MB` (`413 workspace_full`); a write that only removes bytes always goes through. Its
  change log holds one row per record (an upsert removes the record's earlier rows) and its newest 50,000
  rows, pruned in the write that passes them and again daily (browsers behind them resync; a retried push
  then finds only the newest copy, so `landed` is rarer there). It writes at most 120 times a minute and 64
  MB an hour (`429 write_limit`, `writeBudget.ts`). The workspace upload keeps its 10 MB limit. Kept
  workspaces have none of these limits.
- **Sign-up and invite limits:** sign-ups count every try per address and only the companies they create
  server-wide; joining with an invite checks the token before any password work and has a per-address
  limit of its own. An email that already has a login is answered as such (`409 email_taken`), as a person
  who mistyped needs; that tells a stranger whether one email has a login, at 5 tries per address an hour,
  and an invite stops working after 3 such answers. This is accepted: the owner's login email is not a
  secret, its password is.
- **Activity and expiry**: `workspaces.last_active_at` moves on every write that changes something (in the
  same transaction) and on every sign-in, sign-up and accepted invite. Applications from a public careers
  page do not count (`applyChanges(..., {markActive: false})`), so strangers cannot keep an abandoned demo
  alive. Once a day, and at startup, the server deletes every demo company with no activity for
  `DEMO_EXPIRE_DAYS` (default 30; 0 never), and every sign-up never uploaded a day after it (while demo
  companies expire at all), each in one transaction: records, documents, change log, invites, logins with
  their sessions and trusted devices, then the workspace, whose slug goes to `released_slugs`. A kept
  workspace is never deleted. A session whose company is gone ends with it (`401`), and so does a write that raced the
  delete: a workspace row is never re-created by a write.
- **Careers hosts** (`CAREERS_HOSTS`): a request whose `Host` is one of them (with or without the trailing
  dot of a fully qualified name) reaches the careers pages (`server/src/careers`) and nothing else; `/`,
  `/sw.js` and every `/api` route answer `404` there, the careers routes answer only there, and no cookie
  is read or set there (the session cookies are `__Host-` cookies of the app's own host anyway). Only
  companies whose careers page is on have one.

## The assistant (`server/src/assistant`, migration 006)

The in-app HR assistant (docs/SERVER.md, "Lark, the assistant"). Its name is `assistantDisplayName(company)`
from `src/domain/assistant.ts`, shared by the app and the server: the company's `assistantName` (trimmed, at
most 40 characters, set in Settings > Company and synced like the rest of the company document), else the
company's name and " Bot" (`Company Bot` for a company with no name). The sample calls it Lark.

- **The server keeps no conversations.** `POST /api/assistant/chat` takes `history`: the array the previous
  `done` event carried, unchanged, or `[]` to start. The browser keeps it per tab (in memory and
  sessionStorage, never synced) and sends it back as it came: the model's thinking blocks are tied to the
  exact conversation that produced them, so a history that was edited, reordered or rebuilt is refused or
  loses that thinking. The server checks it (`history.ts`) and never changes it: at most 40 messages and
  150 KB of JSON (else `bad_history` with `reason: 'too_long'`: start a new conversation), `user` and
  `assistant` roles only, alternating from the user and ending with the assistant, user content of `text`
  and `tool_result` blocks, assistant content of `text`, `thinking`, `redacted_thinking`, `tool_use` (the
  assistant's own tools only) and `fallback` blocks, every tool call answered in the next message, no
  citations, images, documents or `cache_control`. It appends the question and runs: `{role: 'user', content:
  message}`, or, on a conversation's first question and whenever the assistant's name, the company's name or
  today's date (California) changed since the conversation last said them, `{role: 'user', content: [{type:
  'text', text: '<app_context>You are Lark, ... Today is ...</app_context>'}, {type: 'text', text: message}]}`
  (`prompt.ts` `contextNote`; `isAssistantContext` and `questionTexts` in `src/domain/assistant.ts`, which the
  app uses to leave the note out of the question it shows). The system prompt itself is the same bytes for
  every company and day, so nothing before the conversation ever changes under it.
- **The stream.** `200 text/event-stream; charset=utf-8` with `Cache-Control: no-store, no-transform` (so
  proxies never hold events back to compress them), events of exactly one `event:` and one `data:` line of
  JSON, lines starting with `:` as keep-alives (every 15 seconds):

  | Event | Data | When |
  |---|---|---|
  | `delta` | `{text}` | Answer text as it arrives; append in order. |
  | `status` | `{label}` | A lookup started, for example `Looking up people`. |
  | `discard` | `{chars}` | Drop the last `chars` characters of answer text received (as JavaScript counts them): the server asks that model turn again (its tool input could not be parsed), and the new turn streams its own text. A client that skips this event shows the turn's opening twice. |
  | `done` | `{history, remainingToday, truncated?}` | The answer is complete. `history` is the whole conversation the runner ended with (the history sent, the new message, every tool call and result, the answer): keep it in place of the old one. `truncated: true`: the answer stopped at `ASSISTANT_MAX_TOKENS` (thinking counts toward it) before it finished; it is kept, and the app says it was cut off. |
  | `error` | `{error, message, remainingToday?, discardPartial?}` | The message failed; `message` says why in plain words. The history stays as it was before this message, and the text streamed for it is not an answer (drop it; `discardPartial: true`, sent for `refused` and `truncated`, says so explicitly). |

  Every stream ends with exactly one `done` or `error`. Error codes: `refused` (the model declined; a
  server-side fallback model was tried first), `truncated` (a tool call cut off at the length limit),
  `too_many_steps` (more than 8 model requests), `upstream_busy`, `upstream_unavailable` (Claude overloaded or
  down, an error status or an error event inside the stream), `upstream_unreachable`, `upstream_error`,
  `bad_conversation` (the Claude API refused a later question of a conversation: start a new one),
  `assistant_misconfigured` (the key, model, organization or billing is wrong, or the API refused a
  conversation's first question, which nothing in a conversation can cause) and `server_error`. Closing the
  connection stops the request to Claude.
- **Daily limits** (`quota.ts`): `ASSISTANT_DAILY_PER_WORKSPACE` messages per company and
  `ASSISTANT_DAILY_GLOBAL` for the server per UTC day, the last quarter of the server's kept for companies
  that have asked fewer than 5 that day, counted under one advisory lock when a message starts. A message is
  given back only when no request went to the Claude API for it, or the API turned every request away with an
  HTTP error status (or could not be reached) before answering; once a request is out, closing the
  connection does not give it back. Tokens are added when it ends. One chat per login and two per company at
  a time (in memory), and at most 8 on the server.
- **Lookups** (`tools.ts`, `reader.ts`): ten read-only tools (`company_overview`, `find_people`,
  `get_person`, `list_jobs`, `job_pipeline`, `find_candidates`, `list_offers`, `time_off`,
  `compliance_status`, `law_facts`) that load only the collections they need, of the session login's
  workspace only, compute with the app's domain code, and answer with at most 8 KB of JSON whose `link`
  fields are `links.*` routes from `src/app/router.ts`.

## Browser sync engine (`src/sync/**`)

- `connection` state per device (localStorage `first-twenty:sync:v1`): `{v: 1, mode: 'local' | 'server',
  workspaceId, seq, versions, outbox, rejected, lastSyncAt, user, sampleAllowed, hold, unconfirmed,
  bases, fieldBases, schema, storeMark, historyId, signedOutByUser}`. `bases` holds, per queued or refused
  key, a fingerprint of the server's copy the edit was made on (see Server lost its workspace);
  `fieldBases` the same per changed field of a queued document (see Documents merge by field).
  `signedOutByUser` is set by Sign out and cleared by the next sign-in (see Sign-out). `historyId` is the server's history id from the last snapshot, replace or
  pull page (null for connections saved by older builds or servers without history ids; a pull page
  teaches it, a push answer never does). `schema` is a fingerprint of the shared collection list: a build whose list differs
  rebuilds from the server snapshot on start. `storeMark` must equal the counter in
  `first-twenty:sync:mark:v1`, written after the store is saved; when they differ (the tab died between
  the two saves) the engine also rebuilds from the snapshot before pushing. Queued edits survive both.
- **Connecting** offers "Upload this browser's workspace" (empty server, or `confirmReplace`) or "Use the
  server's copy". `inspectServer()` asks `GET /api/workspace/status` first and downloads the workspace only
  when there is one. When the two copies share a name, the one that is newer and holds more records (people,
  jobs, candidates, funding rounds, departments, filled company settings; activity rows only break a tie)
  is marked Recommended, unless the copy it would replace holds records it lacks: then neither is, and the
  step says what each choice would lose. The sample company never syncs implicitly: loading it over a synced workspace puts the
  connection on **hold** (`'sample'`), and undoing back to the synced workspace resumes. Other holds:
  `'server_empty'` (the server lost its workspace, see below), `'replaced'` (the store swapped workspaces
  outside `replaceWorkspace()`) and `'demo_clock'` (see Demo clock). After Upload, Use the server's copy
  and a connected replace, the Undo history is cleared, so no step from before can swap the old workspace
  back over the server.
- **Server lost its workspace** (`'server_empty'`: a push or pull answered `404 empty`, after a database
  reset or a restore from an empty backup): nothing is pushed or pulled, but edits keep queueing (and so do
  changes applied on load), so they count as pending and survive a reload. The engine looks at the server
  again on start, on window focus and on `online` (never on a timer), with `GET /api/workspace/status`
  first, so a server that is still empty logs no `404`. Once another computer has uploaded:
  the same workspace (`isWorkspaceSwap` false) is joined. The base versions of queued and refused edits
  belong to the copy the server lost, so each key is compared by content instead (`bases`): where the
  uploaded record is still the one the edit was made on, the edit stays on top and goes out on the
  server's current version (a document whose uploaded copy changed only other fields keeps this device's
  fields on top, as in Documents merge by field); where it differs (another computer changed it, before
  the reset or during the hold), the server wins as in any conflict, the edit is dropped (with its Undo
  step and unsynced activity rows) and the record counts in `refreshed`. Keys queued by older builds have
  no fingerprint and stay on top. The same comparison runs whenever a rebuild from the snapshot finds this
  same workspace under another history id (another computer re-uploaded it, or imported a backup of it,
  or the server was restored): a browser that never saw the server empty gets `409 resync` on its push
  instead of `404`, and its queued edits are kept or dropped by content exactly the same way. A different workspace is taken whole, as under Replaced
  from another computer. `uploadLocal()` from this hold that gets `409 not_empty` does the same look and
  resolves `{ok: true, message}` (`JOINED_MESSAGE` or `SWITCHED_MESSAGE`). `useServerCopy()` from this hold
  joins the same workspace with the queued edits; for a different one it answers kind `'pending'` while
  edits are queued (`discardPending` then replaces). Settings > Server offers Upload, and after a
  `not_empty` it could not resolve, Use the server's copy and Replace the server's workspace.
- **Demo clock** ('Pretend today is', Settings > Data; `clockOverride` option, the app passes
  `getClockOverride`): a pretend date applies job changes and hand-offs that are not due yet when the
  page loads, marks them applied on that date and saves them, expires sent offers whose date it has
  passed, and activity rows get pretend timestamps.
  None of it may reach the server, so while the clock is on the connection holds (`'demo_clock'`): start
  queues nothing (no baseline diff) and fixes the queued entries with the data saved before that load,
  edits are not queued, nothing is pushed or pulled, and `uploadLocal`, `useServerCopy` and a connected
  `replaceWorkspace` refuse with kind `'demo_clock'` (`CLOCK_MESSAGE`). Decision: the records the pretend
  date touched (comp rows marked applied on a future date, the people they changed, hand-off
  reassignments, offers it expired and the options they released) and edits made while pretending cannot be told apart from real data record by record, so
  none of them is kept; the promotion then takes effect on its real date like any other.
  The way back: the first start on a pretend date saves the workspace as saved before that load, with the
  connection as it was, under `first-twenty:sync:clock:v1`. It is kept apart from the connection, so a tab
  that stayed on the real date and saves its connection cannot erase it, and it is never replaced while it
  exists (a later pretend load already shows pretend data); a tab still pretending saves it again if
  another tab used it up. Going back to the real date reloads the page, and start rebuilds from that copy
  before the store is shown or anything is sent, even offline: the store and connection are as they were
  before the pretend date (queued edits included, on their old base versions, so a newer server copy still
  wins), changes due by the real date are applied and queued, the Undo history is cleared, and the copy is
  removed once the rebuilt store is saved. The next cycle catches up with the server the usual way.
  Without a usable copy (the browser refused to save it, or a hold from an older build), the hold stays
  shown, edits are not queued and `uploadLocal` refuses (`LEAVING_CLOCK_MESSAGE`) until the server's copy
  has replaced the store (edits queued before the clock was set and refused ones go back on top);
  Settings > Server says so. A browser that is not connected keeps what the pretend date applied (nothing
  to rebuild from), which the panel says.
- **Workspace identity**: `meta.workspaceId` (optional, `ws-<random>`) names one workspace. The engine sets
  it when a workspace is created through `replaceWorkspace()` (Start fresh, or Import of a backup without
  one; a backup that has one keeps it) and when a workspace without one is uploaded. It syncs like the rest
  of `meta` and is never set on load (`migrate`), so every copy of a workspace carries the same id.
  `isWorkspaceSwap(prev, next)` compares ids when either side has one (one with and one without counts as
  different), else the creation date and the sample flag (which two workspaces made the same day share).
- **Diff**: after every store change, compare the previous and next `DB` (Immer keeps unchanged
  objects identical): for each collection whose array changed, records added or replaced become upserts and
  records gone become deletes; changed documents become `$doc` upserts. Pure function `diffDB(prev, next)`.
  Changes the store applies on load (effective-dated job changes, hand-offs, then offers past their expiry
  date: `applyLoadChanges` in `src/store/db.ts`, which the engine's `onLoad` uses too, so the two never
  drift apart) are diffed against the saved copy and pushed too; the activity rows they log get
  content-based ids (`act-auto-<hash>`, unless the domain gave them a deterministic id already) so every
  device writes the same row.
- **Outbox**: one entry per `collection:id` holding keys only (`{collection, id, op, rev}`); the data is
  read from the store when the push goes out (entries keep their data, `fixed`, only while a hold shows
  another workspace). Pushed after 800 ms of quiet, or at once with `keepalive` when the page is hidden.
  Failed pushes retry with backoff (2 s doubling to 60 s); the `online` event retries at once. Batches stay
  under 2,000 changes and about 900 KB. Nothing is lost when offline.
- **Unanswered pushes**: before each push the engine notes, per record, the base version and a fingerprint
  of what it sent (`unconfirmed`). If the answer is lost and a later push on the same base conflicts with a
  server copy that matches one of those fingerprints at a newer version, the engine treats it as its own
  write and rebases on it. Versions are workspace-wide seqs, so that write is rarely at base + 1 (another
  record in the batch, the activity row each edit logs, another device): only the order is checked, and
  the fingerprint is the evidence. The test server (`src/sync/testing/fakeServer.ts`) numbers versions the
  same way. The notes are saved with the connection before the push leaves, and every answer is saved as
  soon as it arrives (`commit`), but a browser that dies (a crash, power loss) can lose its latest
  localStorage writes, since browsers write them to disk in batches: it restarts from an older saved
  state, with the store and the connection from the same moment. Its first push is then a retry of moves
  the server already took, followed by newer ones of its own, and the note that it sent them may be among
  the lost writes too. A conflict that says `landed` and `byYou` (the server's log holds this exact upsert,
  and this user wrote its newer copy), with no newer local edit of the record, takes the server's copy
  quietly whether or not a note survived: no notice, and its Undo step and activity rows stay. A conflict
  whose server copy is exactly what was sent counts as applied (newer servers answer `existing`). A noted delete on the same base whose
  record is gone on the server (`serverData` null) means this device's delete landed: an upsert after it
  (Undo) goes out again as new (`baseVersion: null`). An activity row applied as `existing` is never
  deleted as part of an edit that lost (see The server wins conflicts).
- **Refused changes**: a batch the server refuses with `400`/`413` is halved until the bad change is found;
  that change is set aside in `rejected` (still counted as pending; `retryRejected()` puts it back). Each
  keeps its reason: `'too_large'` for a record over 256 KB, which the client sets aside without sending it
  (or the server's `413`). Retrying cannot help those, so `retryRejected()` leaves them, and the UI offers
  Discard instead: `discardRejected(refs?)` drops the refused change and puts the server's copy back (from
  the snapshot, or removes the record when the server never had it) like a pull, with no Undo step; the
  Undo step that made it goes when nothing else is left of it, and so do the activity rows that step
  logged, even ones an earlier batch delivered (the record change never reached the server): queued rows
  leave the outbox, and rows the server has get a delete. With the step gone, its toast closes and the
  header no longer offers its Undo. Known limit: after a reload there is no Undo history, so Discard
  removes only the rows about the record (`entityId`) that are still queued; a row already delivered stays
  on the server (telling it apart from another device's row about the same record would need the history).
  After 3 refusals in a row the engine stops and backs off as a server error.
- **Pull**: every 30 seconds while visible, on window focus and after each push; applies remote changes
  straight into the store with `useDB.setState` (not through `mutate`, so they do not become Undo steps),
  updating `versions` and `seq`. Changes that echo this device's own pushes are skipped by version. A
  deleted record has no version left, so the engine remembers, in memory, the version of each delete it
  had applied until a pull passes it: the echo of its own delete (and anything older) is skipped too.
  Applying it would also remove the record from every Undo snapshot, and Undo of the delete would bring
  nothing back. A record with a queued or refused local change is never overwritten by a pull. `resync: true` rebuilds
  from the snapshot (by content when the history id changed: see Server lost its workspace). The client sends its `historyId` with every pull (`&history=`) and push (body), so
  after a replace or restore a push is refused whole (`409 resync`): the engine loads the snapshot first,
  then pushes what is left.
- **Replaced from another computer**: when a rebuild from the snapshot finds a different workspace (another
  history, or one it cannot compare, and `isWorkspaceSwap` is true), the engine takes the server's
  workspace whole (no merge, Undo history cleared, queued and refused edits dropped from the outbox) and
  keeps what this browser showed in memory. The status gets `replacedRemotely: {companyName, previousName,
  at}`; `getReplacedBackup()` returns the copy for a backup download and `clearReplacedRemotely()` lets it
  go. The header shows a role=alert notice with Download backup, Copy backup and Dismiss. The same
  history (a pruned log) rebases as before, keeping queued edits. The same workspace under another
  history (a restore, an Import of a backup or a re-upload on another computer) rebases by content and
  sets `restoredRemotely: {at}`, so the header can say that the server's copy was replaced by another copy
  of it and changes made after that copy was taken may be gone (`clearRestoredRemotely()` dismisses it). This browser's own
  Import, Start fresh or upload learns the new history id from its answer, so it never sees the notice.
- **Replacing everything** (Import, Start fresh): `replaceWorkspace(db)` sends `PUT /api/workspace` with
  `confirmReplace` and only then sets the store; on failure nothing changes. Not connected, it is
  `useDB.replace`.
- **Opening while offline**: the workspace, the outbox and the connection live in localStorage, so a tab
  that stays open keeps working offline and syncs later. Opening the app again (a new tab, a restart)
  needs the page itself: the server adds a `<meta name="first-twenty-served">` tag to the app page it
  serves (right after `<head>`), and `src/main.tsx` registers the server's worker (`/sw.js`,
  `server/src/offline.ts`) only when that tag is there, so never from a file, the claude.ai artifact
  viewer or the Vite dev server (and browsers allow workers on https and localhost only). The worker
  answers navigations to `/` and `/index.html` from the network first and keeps each good answer (and a
  first copy when it installs); when the network fails, or the server answers `5xx` (Caddy's `502` while
  the server is stopped), it opens the kept page, headers included, so its CSP still matches its scripts.
  Cache Storage is only touched through caught calls (opening the cache, reading the kept page, keeping a
  copy, dropping old caches), so a browser whose store fails (damaged, full disk, quota) still opens the
  page from the network, just without an offline copy; when both fail, the network's own error stands.
  It never handles `/api` or any other request, and holds no workspace data. The app then starts from the
  browser's copy, shows Offline, and syncs when the server is back.
- **Sign-out**: `signOut()` keeps the offline copy and resolves `{ok: true, confirmed, waiting, message}`.
  Connected and signed in, it first sends what is queued while the session still works, starting batches
  for up to 5 seconds (`SIGN_OUT_PUSH_MS`); `waiting` counts what is left, and `message` then adds that
  those changes were not sent yet and sync after the next sign-in in this browser. It sets
  `signedOutByUser`, so Settings keeps saying "You signed out" (not that the session ended) until a
  sign-in clears it, even after edits or a reload. The
  session cookie is `HttpOnly`, so only the server can end it: when `POST /api/auth/logout` gets no `204`
  or `401` (offline, `5xx`), `confirmed` is false and the engine writes `first-twenty:logout-pending`. While
  that key exists the engine never resumes from the cookie (focus, start, `checkServer`, other tabs), the
  connect flows answer `signed_out`, `checkServer` reports `signedIn: false`, and the engine posts the logout
  again on start, on focus, when the page is shown and on `online` until the server answers; a successful
  sign-in removes the key too (the server drops the old session on every sign-in). `disconnect()` does
  the same and resolves `{ok: true, confirmed, message}`; the key outlives the cleared connection, so
  `initSync()` starts the engine for it even in a browser that is local only now.
  `signOut({forgetThisBrowser: true})` sends queued changes first (counting any another tab saved; when
  signed out, the refusal says to sign in to send them first, or remove them anyway), then
  needs the server to end the session: if it cannot, nothing is removed and the result is kind
  `'session_open'` (`SESSION_OPEN_MESSAGE`), unless `keepServerSession` is set (then the data goes, the key
  is written after the wipe, and the session stays valid until this browser reaches the server again).
  Otherwise it removes every `first-twenty:` localStorage key and reloads; if changes are still queued it
  removes nothing and returns kind `'pending'` (unless `discardPending`). Its message
  (`FORGOTTEN_MESSAGE`: signed out and removed, your server keeps everything that reached it; or
  `FORGOTTEN_OPEN_MESSAGE`) goes to `reload(notice)`, which the app leaves in sessionStorage
  (`first-twenty-reload-notice`, not a `first-twenty:` key, so the wipe keeps it); the next page shows it
  once as a toast (`takeReloadNotice()`, in the shell). A browser whose storage refuses shows none.
- **Starting without a 401**: page-load checks never meet a `401`. `start()` on a connection the user
  signed out of (`signedOutByUser`) sends nothing at all: changes queue, status `signed_out`, until a sign-in
  (or another tab's, seen on focus through `GET /api/auth/session`). With a saved user it first asks
  `GET /api/auth/session`, and nothing syncs until that answers (`canSync`): nobody signed in (a session
  cookie that ended with the browser, the 12-hour limit) is status `signed_out` with no authed request;
  offline or a server error starts as before and the cycle reports it. The demo clock and hold branches
  are unchanged (a `server_empty` hold looks at the server once the session holds).
- **Other tabs**: removing this browser's data posts `{type: 'forget'}` on the BroadcastChannel
  `first-twenty`, and every other tab also sees the storage events. A tab whose workspace key is removed
  (only this flow removes it; a `clear()` by another page on a shared origin is ignored, since this tab's
  copy may be the last one) stops its engine without saving again (`dropLocal()`), puts the sample in
  its store, removes what it may have written meanwhile (keeping a pending sign-out) and reloads. A tab
  whose sync key is removed while the workspace stays (Disconnect elsewhere) stops syncing without writing
  its connection back (`disconnectedElsewhere()`). A tab that finds `first-twenty:logout-pending` set when
  it is about to sync treats itself as signed out and helps end the session.
- **Status** (zustand store `useSyncStatus`): `status: 'local' | 'synced' | 'syncing' | 'offline' |
  'signed_out' | 'error'`, plus `mode`, `pending` (raw outbox entries, internal), `pendingEdits` (the same
  as a person counts edits: an activity row is left out when the record it is about waits too, or the
  document its entityType names (`compliance` for `complianceStatus`, `company`, `settings`, `equity`: one
  kit checkbox counts once), and counted when it waits alone, like a note; every count shown to people
  uses it, and `waitingCount()` adds `rejected` for "not reached the server"), `rejected`, `rejectedKeys`
  (`{collection, id, tooLarge}` per refused change), `lastSyncAt`, `lastError`, `nextRetryAt`, `user`,
  `hold`, `refreshed` (items the server's copy replaced, each counted once), `refreshedKeys` (which ones,
  newest last, at most 20; one the server no longer has carries `removed: true` and `copy`, this browser's
  last copy, in memory only, so the notice can say "Your edit to the Research department was dropped: it
  was removed on another computer"),
  `storageFull` (the browser refused to save changes that have not reached the server; the page then warns
  before closing), `logoutPending` (a sign-out the server has not confirmed yet), `signedOutByUser` (see
  Sign-out), `replacedRemotely` and `restoredRemotely` (see above). `hold` is one of
  `'sample' | 'server_empty' | 'replaced' | 'demo_clock'` (status `'local'` while it is set). The UI shows
  it; the engine never renders UI.
- Undo keeps working: undoing produces a store change, which the diff turns into ordinary changes. Remote
  changes are applied to the Undo history too, so Undo only reverts this user's own edits (the echo of
  this device's own delete is not remote: see Pull).
- **Wiring** (done): `src/main.tsx` calls `initSync()` before the first render, and registers the offline
  worker for a page the server served (see Opening while offline); Settings > Data calls
  `replaceWorkspace(db, label)` for Import and Start fresh; Settings > Server (`#settings.server`,
  `src/features/settings/ServerTab.tsx`) uses `connect.*` (`connect.signIn(email, password, {remember})`
  sends Keep me signed in; `remember` defaults to false), `signOut`, `disconnect`, `syncNow`,
  `discardRejected`, shows `res.message` after Sign out and Disconnect, and offers "Remove anyway" (`keepServerSession: true`) after
  kind `'session_open'`. Its hold panel shows the result's `message` when Upload joined or switched, and
  offers Go back to the real date for `'demo_clock'` (once back on the real date with no copy to rebuild
  from, it says this browser waits for the server's copy and that changes made until then are not kept); Settings > Data's Pretend today is says, while
  connected, that a pretend date pauses syncing (a second click confirms) and that going back takes the
  server's copy. The header chip, the sync banners and the rail note (`src/app/Header.tsx`,
  `Shell.tsx`) show `useSyncStatus`. Removing this browser's data calls `stopPersisting()` from
  `@/store/db` first, so the store never writes a workspace back on the way to the reload.
- **Companies and demo servers** (see Companies above; `src/sync/index.ts`, `account.ts`, `demo.ts`):
  `connect.signUp({email, password, companyName, remember?})` and `connect.acceptInvite({token, email,
  password, remember?})` create a login and sign in exactly as `signIn` does, and are refused (kind
  `'pending'`, `CONNECTED_ACCOUNT_MESSAGE`) while this browser syncs with a server, so changes queued for
  one company never go out under another company's login. A sign-in on a browser that syncs with a server
  is held to the same rule: when the login's company (`workspace` in the sign-in answer) is not the one
  the connection names (`workspaceId`, from the snapshot or the upload's answer), the engine ends that
  session again (retried like an unconfirmed sign-out when the server cannot be reached), stays signed out
  with its copy and queued changes as they were, and answers kind `'other_company'` (`otherCompanyMessage`:
  sign in with a login of this company, or Disconnect first). The session check (`checkServer`, the probe
  on focus) never resumes under such a session either, and stops syncing when the session it was syncing
  under turns out to be one. Behind those, a resync whose snapshot names another server workspace than the
  connection's is always a swap (`takeRemoteSwap`), whatever `meta.workspaceId` says: another company can
  carry this one's, and a merge would send this company's queued edits into it. After a sign-up, `connect.uploadNew(db)` puts
  the new company (Start fresh's defaults, named as typed: `demoCompanyDB` in
  `src/features/settings/demoLogic.ts`) on the empty server workspace (`PUT` without `confirmReplace`); the
  store takes it only once the server has it, and it never sends the sample. After joining by invite,
  `connect.useServerCopy()` takes the company's workspace. `demoSignup()` asks `GET
  /api/auth/signup-mode` once per page load (a `404` from an older server counts as closed);
  `useServerAccount(ask)` asks `GET /api/auth/me` once per sign-in for the company name, slug, careers
  page (and whether it is on) and role, and forgets the answer the moment the signed-in user changes;
  `createInvite()`, `listInvites()`, `revokeInvite(id)` and `inviteInfo(token)` (a `POST` with the token in
  its body) wrap the invite routes, and `setCareers(enabled)` the careers switch. Addresses the server
  sends (careers page, invite link) are kept only when they are http(s). The API client adds the error
  kinds `'email_taken'` (409) and `'demo_full'` (503).
- Known limit: two tabs of one browser each run an engine on the same localStorage key; the saved outbox
  is last-writer-wins between them (a Web Locks leader tab would fix it). Removing this browser's data
  stops the other tabs (see Other tabs), but changes another tab queued and never saved are lost with it.

## Security rules

- Never put secrets in the repo or the app bundle. The server reads `DATABASE_URL` and other settings
  from environment variables (`/etc/first-twenty/env` on EC2, `.env` locally; `.env` is git-ignored).
- Passwords are hashed with scrypt (`node:crypto`, N=2^15, r=8, p=1, 16-byte salt); compared in constant
  time. Tests hash at a far cheaper cost (`TEST_SCRYPT_N` in `server/src/config.ts`) to save time; a
  server refuses to start with it unless `NODE_ENV` is test, and no setting can choose it. The admin is
  created from the command line (`npm run server:create-admin -- --email you@company.com`), which asks for
  the password without echoing it. At most two password checks run at once (16 may wait);
  sign-ups and accepted invites hash their passwords through the same gate.
- Sign-ups are limited per client address (every try) and for the whole server (only those that create a
  company), 5 and 60 per hour; joining with an invite checks the token first and is limited per address;
  demo companies are capped (`DEMO_MAX_WORKSPACES`) and held to the demo limits (see Companies). Invite
  tokens, like session and device tokens, are stored as SHA-256 hashes only; the app sends them in request
  bodies, and both the server's request log (`redactPath`) and Caddy's access log cut them out of paths.
- Seqs and versions count per company, so no company can count another's writes from its own numbers.
  Careers pages appear only for companies whose page is on, under slugs nobody can guess and nobody can
  take over after a company is deleted.
- SQL uses parameters only; table names come from the collection whitelist, never from input.
- Security headers on every response (CSP for the served app, the strict careers policy on careers hosts,
  `X-Content-Type-Options`, `Referrer-Policy`, `Frame-Options`); no CORS by default (`ALLOWED_ORIGIN` only
  for development). The app's CSP allows its
  inline scripts by SHA-256 hash (computed from `APP_FILE` at startup, which is then served from memory),
  never `'unsafe-inline'` for scripts, and workers from its own origin only (`worker-src 'self'`). The
  offline worker's script (`/sw.js`, `application/javascript`, `no-cache`) carries its own policy,
  `default-src 'none'; connect-src 'self'`.
- Every `/api` route sits in one Fastify plugin whose hooks (CSRF header, cross-site refusal,
  `Cache-Control: no-store`, which a route may add to but never drop) apply by route match, so
  percent-encoded paths get the same guards. Never
  relax the CSRF header: on a shared parent domain such as `*.sslip.io`, `SameSite` treats every sibling
  host as the same site, so the header (with the `Sec-Fetch-Site` check) is what keeps their pages from
  writing.
- Session and trusted-device cookies are `__Host-` cookies over https (see Protocol). Every https response
  carries HSTS once: the server sends it, and Caddy sets it again in place of the server's copy, so it is
  there even when `PUBLIC_ORIGIN` was left at http.
- Logs never include request bodies, cookies or passwords.
- The assistant's `ANTHROPIC_API_KEY` lives in the settings file and the Claude API client in the server's
  memory only: it is not part of the loaded config, never logged, never in an answer and never sent to a
  browser (the client is built with `authToken: null`, so an `ANTHROPIC_AUTH_TOKEN` in the environment is
  never sent with it). The assistant's lookups only read, the session login's workspace only; the history a
  browser sends back cannot carry a `system` turn, images, documents or other tools. The app's renderer
  follows links in answers only to in-app pages and the official sources the lookups cite. Its logs say who
  asked and how it went, never what was asked. The systemd unit lets the server reach the DNS stub and Anthropic's
  published API addresses besides loopback (docs/SERVER.md).
