# Develop First Twenty

One command runs the whole app for development: `npm run stack`. It starts the API with its own local
database, loads the Ledgerlark sample company into it, starts the app, and signs your browser in. It works
the same in GitHub Codespaces and on your own computer (Windows, macOS, Linux).

## Open in GitHub Codespaces (start here)

A codespace is a computer in the cloud with this repo, Node 22, Claude Code and the GitHub CLI already set
up. You only need a browser and your GitHub account.

1. On the repo page, choose **Code > Codespaces > Create codespace on main**, or open
   https://codespaces.new/unique-name27/first-twenty-team. Keep the smallest machine (2 cores): it is enough.
2. The first start takes a few minutes: GitHub builds the codespace, then runs `npm ci`, then
   `npm run stack` in a terminal. Watch that terminal: when it says **First Twenty is running**, a new
   browser tab opens the app (the first time only; later, open it from the **Ports** panel) at `https://<your-codespace-name>-8826.app.github.dev`.
3. The app opens signed in to the sample company as `dev@example.test`, syncing with the codespace's own
   database. Edit code in the editor; the app reloads by itself, and the API restarts when server code changes.

Every time you open the codespace again, `npm run stack` starts again in a terminal. A codespace stops by
itself after a while without activity, and keeps your files and database until you delete it. Codespaces
on a personal account come with a free monthly allowance; stop or delete codespaces you no longer use
(github.com/codespaces).

Good to know:

- **The app opens in a browser tab, not in the editor's preview pane.** The preview pane shows the page
  inside the editor, which counts as another site, and the app's sign-in cookie (SameSite=Strict, like on
  the live server) is not sent there. If no tab opened, use the **Ports** panel: the globe icon next to
  "First Twenty (dev)" opens it.
- **Keep the ports private** (the default). Only you, signed in to GitHub, can open them. A public port
  would show the dev login's password to anyone with the address.

## On your own computer

1. Install [Git](https://git-scm.com/downloads) and [Node.js](https://nodejs.org/en/download) 22 or newer.
2. Clone the repo, then run `npm ci` and `npm run stack` in the repo folder. On Windows use PowerShell or
   Windows Terminal.
3. Open http://127.0.0.1:8826 (the terminal prints the address). The app signs itself in.

With Docker and VS Code's Dev Containers extension you can also open the repo in the same container a
codespace uses (`.devcontainer/devcontainer.json`).

## Commands

| Command | What it does |
| --- | --- |
| `npm run stack` | The API, the database, the sample company and the app, signed in. Ctrl+C stops it |
| `npm run stack -- --fresh` | Deletes the stack's database and dev login first, and starts over |
| `npm run stack -- --offset 10` | A second stack beside the first: ports 8836 and 8797, its own database |
| `npm run stack -- --no-seed` | A new database without the sample company (an empty server, as a new founder sees it) |
| `npm run sql -- hires` | Reads the stack's database with SQL, never changing it ("Query the data with SQL" below) |
| `npm run dev` | The app alone, keeping its data in the browser only (no server) |
| `npm run server:dev` | The API alone, on its own database in `.data/pg` (docs/SERVER.md, "Develop locally") |
| `npm test -- src/sync` | The unit tests in one folder |
| `npm run test:e2e` | The journey tests: whole paths through the real server and database ("Journey tests" below) |
| `npm run typecheck` | TypeScript for the app and the server |
| `npm run verify` | Typecheck, all tests, the one-file build. Must pass before a pull request |

## What runs where

| Piece | Where | Notes |
| --- | --- | --- |
| The app (Vite dev server) | http://127.0.0.1:8826 | Reloads on every change. Passes `/api` through to the API, so the app and the API share one address, as on the live server |
| The API (Fastify, `tsx watch`) | http://127.0.0.1:8787 | Restarts when server code changes. Development mode, sign-up open (try making a company), Lark is the scripted fake (no key needed, nothing leaves the computer). It runs `server/src/dev/index.ts`: the same server as production plus the development-only route `npm run sql` asks |
| The database (PGlite) | `.data/dev/pg` | Real Postgres compiled to WebAssembly. Only one process can open it at a time |
| The dev login | `.data/dev/credentials.json` | `dev@example.test` with a random password, made once. The file never leaves your computer or codespace (`.data/` is git-ignored) |
| The `npm run sql` secret | `.data/dev/dev-tools.json` | Made anew each time the stack starts and deleted when it stops. Only `npm run sql` reads it |

In a codespace, GitHub forwards port 8826 to `https://<your-codespace-name>-8826.app.github.dev`. The stack
tells Vite to accept that address and gives the API `PUBLIC_ORIGIN` set to it, so invite links point there
and the sign-in cookies are Secure `__Host-` cookies, exactly as on the live server. Locally,
`PUBLIC_ORIGIN` is `http://127.0.0.1:8826` and the cookies are plain ones.

The stack uses its own settings for the API whatever your `.env` says about the database or the mode, so
it never touches a database a `.env` points at. Set `LOG_LEVEL=info` before `npm run stack` to see a log
line for every request (the default, `warn`, shows only problems).

## How the automatic sign-in works

It is development only, and it signs in the normal way:

1. `npm run stack` makes the dev login once and writes it to `.data/dev/credentials.json`.
2. The Vite dev server answers `GET /__dev/credentials` with that login, only to the app's own pages (it
   refuses requests from any other site). Only the dev server has this; a build never does. Vite never
   serves the `.data` folder itself (`server.fs.deny` in `vite.config.ts`), so the file cannot be read
   around that check.
3. `src/dev/autoconnect.ts` runs in development builds only (`src/dev/guard.test.ts` checks that). It
   signs in with the password through `POST /api/auth/login`, then takes the server's copy of the
   workspace, the same two steps as Settings, Server. The API has no shortcut for it.

When it runs:

- On load, once per stack database, when this browser holds the sample company. After `--fresh` it signs in
  again by itself. It leaves invite links (`#invite.` addresses) alone, so you can open one in a private
  window and join as someone new. To try signing up in a private window, sign out once after the
  automatic sign-in: it does not sign that window in again.
- Always when the address ends in `#dev.signin`, for example http://127.0.0.1:8826/#dev.signin. Use it after
  signing out, or when this browser holds a workspace of its own: the automatic sign-in never replaces
  that, and says so instead.

To sign in by hand (Settings, Server), the password is in `.data/dev/credentials.json`.

## Query the data with SQL

The server keeps each record whole, as JSON, in one table per collection (docs/SYNC.md). The read model
(migration 007) adds views over those tables with one typed column per field, named in snake_case, so
plain SQL reads them:

| View | One row per |
| --- | --- |
| `v_people`, `v_comp`, `v_jobs`, `v_candidates`, `v_applications`, `v_offers`, `v_checklists`, `v_grants`, `v_time_off_requests`, `v_documents`, `v_activity` | record of that collection |
| `v_checklist_tasks` | checklist task |
| `v_application_stages` | stage move of an application |
| `v_pay_runs` | pay period on record: marked submitted, or with the provider's totals (from the company document) |
| `v_current_job` | person: today's title, department, pay and state (incoming, active, on leave, former) |
| `v_hire_journey` | hire: job, application, accepted offer, person, starting pay, onboarding checklist, the pay run that holds the start date |
| `v_pipeline_funnel` | job and stage: applications there now, and every one that ever entered it |
| `v_headcount_by_month` | month: headcount on its last day, starts and last days |
| `v_integrity_problems` | problem found by the checks in `src/domain/integrity.ts` (empty when the data is consistent) |

Every view starts with `workspace_id`; the stack's sample company is `default`. Ready-made queries are in
`server/deploy/browse.sql`. The views that depend on today use today's date in Pacific time, the app's own
day, whatever time zone the database runs in: in a SQL client, run `SET first_twenty.today = '2026-10-09'`
first to read them as of the sample's anchor day (with `npm run sql`, add `--today 2026-10-09`).

### npm run sql

`npm run sql` reads the stack's database from the terminal and prints a table. It never changes anything.

```bash
npm run sql -- hires                       # one row per hire, from the job to the first payday
npm run sql -- integrity                   # the integrity problems (empty is good)
npm run sql -- "SELECT full_name, title, salary FROM v_current_job WHERE workspace_id = 'default'"
npm run sql -- 'SELECT full_name FROM v_people WHERE workspace_id = $1'   # $1 is the company
npm run sql -- people --workspace acme-robotics   # another company, by id or slug
npm run sql -- headcount --today 2026-10-09 --json
npm run sql -- --help                      # every shortcut and option
```

The shortcuts are `people`, `headcount`, `hires`, `funnel`, `payruns` and `integrity`, each for the sample
company unless `--workspace` names another. In a statement of your own, `$1` stands for that company; put
such a statement in single quotes, or bash and PowerShell read `$1` as one of their own variables. Add
`--json` for JSON instead of a table, and `--offset 10` for a stack started with `--offset 10`.

How it reads the database:

- **While `npm run stack` runs**, the stack's API holds the database (PGlite allows one process per
  folder), so `npm run sql` asks the API on 127.0.0.1, with a secret the stack makes each time it starts
  (`.data/dev/dev-tools.json`). The secret is what keeps the route private: in a codespace, a forwarded
  port also reaches the API from 127.0.0.1, so keep port 8787 private there (the default) and never share
  the secret. Without it the API answers 404. Only the development server has the route: production never
  includes it.
- **With no stack running**, it copies `.data/dev/pg` to a temporary folder, reads the copy and deletes it
  (PGlite writes to a folder it opens, even to read). The stack stays the only process that writes the
  folder, so starting the stack meanwhile, or running two at once, is safe.
- It never reads `DATABASE_URL` or a `.env` file, so it never connects to any other database.

The limits: one statement at a time, starting with `SELECT`, `WITH`, `VALUES`, `TABLE`, `EXPLAIN` or `SHOW`.
It runs in a read-only transaction that is always rolled back; `BEGIN`, `COMMIT`, `ROLLBACK`, `SET` and other
statements that would start, end or change that transaction are refused. At most 500 rows come back (add a
`WHERE` or a `LIMIT` for the rest), and a statement may run for 5 seconds. PGlite cannot stop a statement
that is already running, so: with no stack, `npm run sql` stops it after 5 seconds; through the stack, the
API finishes it first, and `npm run sql` stops waiting after 8 seconds. If the stack seems stuck after
that, stop it with Ctrl+C and start it again.

To change the read model, edit `server/src/readmodel/spec.ts` (every field is a typed path into
`src/domain/types.ts`, so a typo fails `npm run typecheck`), then run
`npm run server:gen-sql -- --read-model --write`. It saves the whole read model as the next migration,
`server/sql/NNN_read_model.sql`, which drops the views and creates them again, so no applied migration
changes, and lists it in `server/sql/SHA256SUMS`. `server/src/readmodel/readmodel.test.ts` fails until the
newest one matches. While that file is your branch's own and not on main yet, `--replace` instead of
`--write` rewrites it; it refuses a file that is on main. Changing a check in
`src/domain/integrity.ts` changes `v_integrity_problems` the same way.

## Journey tests

A journey test walks one path through the app the way people take it, against the real server and
database, in one test file: no browser window, no network, no running stack. `server/src/e2e/journey.test.ts`
takes a candidate from Ledgerlark's careers page to their first paycheck and proves that:

- the careers form works through the real route, with its real checks and limits (a typo comes back to
  the candidate, a second click stores nothing more), and the application reaches the admin's browser by sync;
- the admin's browser can move it through the stages, schedule the intro call, enter the scorecard, draft,
  approve and send the offer, record the acceptance, hire from it, complete the onboarding checklist and
  submit the first pay run that pays the new person, each change made by the domain function the screen calls;
- the server holds all of it: `v_hire_journey` has one complete row for the hire, `v_integrity_problems` is
  empty (and `src/domain/integrity.ts` agrees on the browser's copy), and `change_log` has every write in
  order, under the login that sent it;
- a second login, invited the normal way, sees the new person and the pay run, and its copy matches the admin's.

It takes about 4 seconds. The server runs as the rows-only role production uses (the migrations run as the
schema owner, as `server/deploy/deploy.sh` runs them), so a change that needs more rights fails here first.

### Run them

```bash
npm run test:e2e                                  # every journey test (server/src/e2e)
npx vitest run server/src/e2e/journey.test.ts     # one file
```

`npm test`, `npm run verify` and CI run them too. Run them before a pull request that changes hiring,
onboarding, payroll or sync (CONTRIBUTING.md).

### Write one

Add a `*.test.ts` file in `server/src/e2e` and start it from the kit, `server/src/e2e/kit.ts`:

| Part | What it does |
| --- | --- |
| `startJourney()` | A fresh server for the file: an in-memory database, the real app with the careers pages on, and the admin's browser connected to the uploaded Ledgerlark sample. The day is 2026-10-09 (the sample's own day) unless `start` says another |
| `j.step(name, fn)` | Runs one part of the story under a name. When it fails, the failure dump is printed and the error names the step |
| `j.act(browser, label, recipe)` | One change, as the app makes it: the browser store's `mutate(label, recipe)`, then a sync. The recipe calls the domain function the screen calls, with the same arguments and label (copy them from the feature, for example `src/features/hiring/actions.ts`) |
| `j.apply({ job, fields })` | Sends the careers form the way a candidate's browser does: the list page, the job's page, its form. Gives back the status, the page and whether it was sent |
| `j.advanceTo(date)` | Moves the day forward with the app's clock override (`setClockOverride`), which every date in the domain reads. Never backwards |
| `j.sql(text, params)` | A read-only query as the server's role, with the read model's today on the journey's day |
| `j.connect(name)` and `j.invite(name, email)` | Another computer of the admin, or a second login joined with an invite link. Each browser has its own store, storage and cookie jar |
| `browser.db()`, `browser.sync()`, `browser.viewerId()` | A browser's copy of the workspace, a sync now, and the person it acts as (Viewing as; set `browser.viewAs` to change it) |

```ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import { advanceApplication } from '@/domain/hiring'
import { today } from '@/lib/dates'
import { type Journey, startJourney } from './kit'

let j: Journey
beforeAll(async () => {
  j = await startJourney()
}, 60_000)
afterAll(() => j?.close())

it('takes a careers application to the intro call', async () => {
  const email = 'rosa.alvarez@example.test'
  await j.step('a candidate applies on the careers page', async () => {
    const res = await j.apply({
      job: 'Account executive, mid-market',
      fields: { name: 'Rosa Alvarez', email, answer: 'I took a mid-market territory from zero to a full pipeline in two quarters.' },
    })
    expect(res.sent).toBe(true)
  })
  await j.step('the admin moves it to the intro call', async () => {
    j.advanceTo('2026-10-12')
    await j.admin.sync()
    const db = j.admin.db()
    const app = db.applications.find((a) => db.candidates.find((c) => c.id === a.candidateId)?.email === email)!
    await j.act(j.admin, 'Moved Rosa Alvarez to Intro call', (d) => advanceApplication(d, app.id, { date: today(), actorId: j.admin.viewerId() }))
    expect(await j.sql(`SELECT stage_id FROM v_applications WHERE workspace_id = 'default' AND id = $1`, [app.id])).toEqual([{ stage_id: 'intro' }])
  })
})
```

The rules that keep a journey honest:

- **Change data only the way people do**: `j.act` with a domain function, or the careers form. Never write a
  record by hand, in a browser's store or in SQL. A refused change (the recipe returns `false` or
  `{ ok: false, reason }`, as the app's own `act()` reads it) or a change that changes nothing fails the step.
- **One fixed clock.** Move it with `j.advanceTo`. Never assert on a time of day (activity times and approvals
  keep the real time of day on the journey's date) or on a generated id: compare ids with the records that hold them.
- **Check what the server holds** with `j.sql` over the read model's views ("Query the data with SQL" above),
  and the browser's copy where that is the point.
- **Keep it quick**: one `startJourney` per file, in `beforeAll`, and as many steps as the story needs.

### Read the failure dump

When a step fails, the test prints the failure dump once, above the error, and the error starts with
`Journey step "<name>" failed:`. It looks like this (shortened):

```
Journey failure dump

Steps (the day, then what happened):
  2026-10-09  admin connected and uploaded Ledgerlark; careers page on at https://careers.journey.test/ledgerlark/ (1414 ms)
  2026-10-09  step: a candidate applies on the careers page
  2026-10-09  candidate: applied for Senior full-stack engineer on the careers page
  2026-10-12  admin: Moved Noor Lindqvist to Intro call
  2026-11-10  admin: Marked the Nov 1-15 payroll submitted to your PEO
  2026-11-10  step: the read model shows one complete hire
  2026-11-10  FAILED: the read model shows one complete hire

v_hire_journey, the 8 newest hires (a null is a missing step):
  {"application_id":"a-b85edea8a9","candidate_name":"Noor Lindqvist","job_id":"j-fullstack",...,"first_payday":"2026-11-13"}

v_integrity_problems:
  (none)

change_log, the last 25 writes (user: who pushed it; none for the careers form):
  {"seq":1478,"collection":"$doc","record_id":"company","op":"upsert","user":"admin@example.com"}
```

- **Steps**: what happened, in order, each line starting with the journey's day. A line like
  `admin: Moved Noor Lindqvist to Intro call` is one change a browser made and synced, named with the app's
  own label (the one its Undo toast shows). The last line names the step that failed.
- **v_hire_journey**: one row per hire, newest first. A null shows the step that is missing: no `offer_id`,
  no accepted offer; no `person_id`, the hire was never recorded; no `hire_comp_id` or
  `onboarding_checklist_id`, the hire is incomplete; no `first_payday`, no submitted pay run holds the start date yet.
- **v_integrity_problems**: what `src/domain/integrity.ts` finds wrong in the server's copy, by code and record.
- **change_log**: the newest writes the server took, newest first, with the login that sent each. A change
  that is not there never reached the server: the error then says which browser refused it or is not synced.

## Claude Code in a codespace

Claude Code is installed in every codespace. Open a new terminal (the stack keeps the first one busy) and
run `claude` in the repo folder.

- **Sign in with your Claude account** (Pro, Max, Team or Enterprise): choose that login, open the link
  Claude Code prints, sign in, and paste the code it shows back into the terminal. You stay signed in while
  the codespace exists; a new or rebuilt codespace asks again.
- **Optional: an API key.** If you use a Claude Console API key instead, save it as a Codespaces secret
  named `ANTHROPIC_API_KEY` (github.com: Settings > Codespaces > Secrets > New secret, and give it access to
  this repo). Claude Code finds it in every codespace you open. You do not need one if you sign in with
  your account. The stack never passes the key to the app: Lark stays the scripted fake. To try Lark with
  the real model, see docs/SERVER.md, "Develop with it".

The team's shared Claude Code settings are in `.claude/settings.json`; CLAUDE.md has the rules Claude
follows here.

## Troubleshooting

**"port 8826 (the app) is already in use".** Something else listens there: `npm run dev`,
`npm run server:dev` or another stack. Stop it (Ctrl+C in its terminal), or run a second stack beside it
with `npm run stack -- --offset 10`. To see what holds a port: `netstat -ano | findstr :8826` on Windows,
`lsof -i :8826` on macOS and Linux.

**"a stack is already running on this data folder".** PGlite lets only one process open a database
folder, so the stack refuses to start a second time on the same one. Stop the running stack with Ctrl+C in
its terminal. In a codespace, look through the terminal list: opening the codespace in a second window
starts `npm run stack` there too, and that one stops with this message, which is fine. The stack notices
a `.data/dev/stack.pid` left behind by a restart and removes it by itself; if it still refuses and no
stack is running, delete that file and try again. Never run
`npm run server:migrate` or `server:create-admin` against `.data/dev` while the stack runs.

**Start over.** `npm run stack -- --fresh` deletes `.data/dev` (the database and the dev login) and makes
new ones. Open the app again and it signs in to the new database by itself.

**The app did not sign in.** Look for a message at the bottom of the screen. If this browser holds a
workspace of its own, open `#dev.signin` to replace it with the server's copy. If you signed out, the same
address signs you in again.

**"Blocked request. This host is not allowed".** Vite accepts the codespace's address only when it runs
inside the codespace with its settings. Stop it and start it with `npm run stack` there.

**The codespace's tab shows an error page.** The stack may still be starting (the first start runs
`npm ci` first). Wait for **First Twenty is running** in the terminal, then reload.

**Database setup failed.** The terminal shows why. `npm run stack -- --fresh` starts over with a new database.

**"could not open the database: Aborted()".** The stack was stopped hard (its process was killed, or the
computer stopped) while PGlite was writing, and the folder is damaged. Stop the stack with Ctrl+C next time.
`npm run stack -- --fresh` makes a new database (it deletes the old one and the dev login).

**npm run sql: "Something answers on 127.0.0.1:8787, but .data/dev/dev-tools.json is missing".** A stack
started before `npm run sql` existed, or `npm run server:dev`, holds the port. Stop it and start
`npm run stack` again.

**npm run sql: "The stack's API did not take the request".** The running stack's secret does not match the
one in `.data/dev/dev-tools.json` (usually a stack started before `npm run sql` existed). Restart the stack.

**npm run sql: "No answer from the stack's API".** A statement is still running in the stack's API, which
PGlite cannot interrupt. Wait, or stop the stack with Ctrl+C and start it again.
