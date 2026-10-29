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
| `npm run sim -- reset full-20` | Replaces the stack's company with a generated one; `advance 30d` moves it forward ("Simulate a company" below) |
| `npm run dev` | The app alone, keeping its data in the browser only (no server) |
| `npm run server:dev` | The API alone, on its own database in `.data/pg` (docs/SERVER.md, "Develop locally") |
| `npm test` | Every test, all four tiers; `npm test -- src/sync` runs the tests in one folder |
| `npm run test:unit` | The unit tests: no database, no server (`src/`, `scripts/`) |
| `npm run test:server` | The server tests: the API on in-memory PGlite (`server/src/`) |
| `npm run test:e2e` | The journey tests: whole paths through the real server and database (`server/src/e2e/`, the `src/sync` round trips; "Journey tests" below) |
| `npm run test:deploy` | The deploy kit's tests (`server/deploy/`): seconds on Linux, about 13 minutes on Windows |
| `npm run test:changed` | Only the tests your changes since `origin/main` touch, in every tier but the deploy kit |
| `npm run test:watch` | Reruns the tests each save touches (every tier but the deploy kit); Ctrl+C stops it |
| `npm run check` | Typecheck and `test:changed`: a quick check while you work |
| `npm run typecheck` | TypeScript for the app and the server |
| `npm run verify` | Typecheck, the unit, server and journey tests, the one-file build. Must pass before a pull request |

## What runs where

| Piece | Where | Notes |
| --- | --- | --- |
| The app (Vite dev server) | http://127.0.0.1:8826 | Reloads on every change. Passes `/api` through to the API, so the app and the API share one address, as on the live server |
| The API (Fastify, `tsx watch`) | http://127.0.0.1:8787 | Restarts when server code changes. Development mode, sign-up open (try making a company), Lark is the scripted fake (no key needed, nothing leaves the computer). It runs `server/src/dev/index.ts`: the same server as production plus the development-only routes `npm run sql` and `npm run sim` ask |
| The database (PGlite) | `.data/dev/pg` | Real Postgres compiled to WebAssembly. Only one process can open it at a time |
| The dev login | `.data/dev/credentials.json` | `dev@example.test` with a random password, made once. The file never leaves your computer or codespace (`.data/` is git-ignored) |
| The dev tools secret | `.data/dev/dev-tools.json` | Made anew each time the stack starts and deleted when it stops. Only `npm run sql` and `npm run sim` read it |
| The simulator's files | `.data/dev/scenarios`, `.data/dev/saves`, `.data/dev/sim-date.json` | Generated companies kept for the next reset, saved copies, and the company's date (`npm run sim`). `--fresh` deletes them with the rest |

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
- the admin's browser can move it through the stages, schedule the intro call, enter the scorecard, draft
  and send the offer (an offer the admin drafts needs no approval), record the acceptance, hire from it,
  complete the onboarding checklist and submit the first pay run that pays the new person, each change made
  by the domain function the screen calls;
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
| `j.act(browser, label, recipe)` | One change, as the app makes it: the browser store's `mutate(label, recipe)`, then a sync. The recipe calls the domain function the screen calls, with the same arguments and label (copy them from the feature, for example `src/features/hiring/actions.ts`). It runs inside `withRunContext` (`src/lib/runContext.ts`): at noon in California on the journey's day, as the browser's Viewing as |
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
- **Take only the steps the screen offers.** Start from what the screen starts with (the schedule sheet's
  first proposed time, the offer builder's defaults), and where a button shows only in some states, check
  it the way the journey checks the offer card's Mark sent with `offerActionPlan`.
- **One fixed clock.** Move it with `j.advanceTo`. What the browsers change (`j.act`, and the changes the app makes
  on load) happens at noon in California on the journey's day (`JOURNEY_TIME_OF_DAY`), and the careers form's
  clock is 19:00 UTC on it, so activity times and approvals are the same on every run. Never assert on a generated
  id (the careers form's are random): compare ids with the records that hold them.
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

## Generated companies

`src/sim` builds whole companies the way people build them in the app, for tests and tools. The app never
imports it (`src/sim/guard.test.ts` checks that). `generateCompany({ scenario, seed, asOf })` starts from a
blank workspace on the founding date and changes it only through actions (`src/sim/actions.ts`): each one is
the domain function a screen calls, with what that screen passes, applied the way the store's `mutate` applies
a change. The whole company is built in one run (`src/lib/runContext.ts`), so ids and timestamps come out the
same every time.

- The founder sets up the org (departments, offices, levels and bands, as Settings and Comp and plan do) and
  their own pay.
- Every later employee arrives through the hiring pipeline: a headcount plan line, a job from it, candidates
  added with Quick add, interviews at the times the schedule sheet proposes, scorecards, an offer (Admin
  approves it when a manager drafted it), the acceptance and Hire. So each one has a candidate, an
  application, an offer, a starting pay row, a grant when the offer has options, an onboarding checklist,
  documents and activity.
- Every morning the app's load-time changes run, each pay run is marked submitted on its run-payroll-by day,
  and checklist tasks are marked done on their due dates.
- Nothing after the as-of date happens: a job whose person would start later is open on that date, with its
  candidates part way through.

It returns `{ db, trace, summary }`: the workspace; the trace, one JSON line per action (`traceToJsonLines`)
with its day, time, actor, Viewing-as, action, args and the ids of the records it created; and a short summary.

| Scenario | What it is |
| --- | --- |
| `ledgerlark` | The sample exactly as `buildSampleDB` builds it, for parity with the app |
| `blank` | Start fresh: a solo founder on the as-of date |
| `seed-8` | 8 people, one job open |
| `cross-15` | 15 employees reached a week before the as-of date; managers draft offers and Admin approves them |
| `full-20` | 20 people, every one hired through the pipeline, no job open |
| `payroll-edge` | Part-time and full-time hourly staff, a hire mid pay period, a leave, a termination inside a pay period |
| `pipeline-heavy` | About 300 candidates, three jobs open |
| `stress` | Thousands of candidates, past the demo limits: for the server only, never loaded into a browser |

Each scenario has its own seed and the as-of date 2026-10-09. Another seed gives another company of the same
shape. Runs past 2026 use the rules the app has (the 2026 law tables); holidays roll over each December.

```ts
import { traceToJsonLines } from '@/sim/actions'
import { generateCompany } from '@/sim/generate'

const { db, trace, summary } = generateCompany({ scenario: 'seed-8' })   // its own seed and as-of date
const another = generateCompany({ scenario: 'seed-8', seed: 42 })         // another company of the same shape
```

`src/sim/generate.test.ts` (unit tier) generates every scenario but `stress` twice and compares the JSON byte for
byte, runs the integrity checks on each (`src/domain/integrity.ts`: no failures, and a generated company not
even a note), checks the size against a browser and the demo limits, and compares each summary with
`src/sim/summaries/<scenario>.txt`. When a change to the app changes a generated company on purpose, write the
new summaries, read their diff and commit them with the change:

```bash
SIM_WRITE_SUMMARIES=1 npx vitest run src/sim/generate.test.ts
```

Generated ids are stable but mean nothing: find records by what they are (the person hired from an
application, the open job), never by id.

### The time machine

`advance(db, { to, seed, policy })` (`src/sim/advance.ts`) lives a workspace's next days, from the company's
date (the clock override, which it then leaves on `to`) through `to`. It works on any workspace: a generated
company, the sample, or one saved from the app. Each day opens the app once, so its load-time changes run
(`applyLoadChanges`: scheduled job and pay changes, hand-offs, lapsed offers; the app has no midnight timer).
Then on business days the people act, through the same actions as the generator, each after the check its
screen makes:

- time off: a sick day on the day, or vacation one to six weeks out, sent only when `checkRequest` shows no
  warning (a sick day before its service wait still goes to Admin); the manager approves it the next
  business day;
- hiring: the founder keeps the plan stocked while the company is under its size and opens each role from its
  plan line about six weeks before its start (`openJobFromPlan`, then Edit details and Mark posted);
  candidates arrive, are reviewed, interviewed and scored, and the hiring manager decides on the scorecards;
  an offer goes out only when `sendBlockerList` is empty, and the candidate accepts, declines or lets it
  expire;
- a merit raise on a work anniversary, as Change job or pay proposes it, unless it leaves the band;
- now and then a resignation (with a backfill) or a protected leave that `leaveEligibility` allows, and a
  return on the expected day;
- each pay period's prep (`payRunPrep`, totals from `payRunTotals`) and Mark submitted on its run-payroll-by
  day;
- on Mondays Admin clears the inbox's one-button items (`inboxItems`, then `applyInboxOp`) and the compliance
  rules are evaluated (`evaluateAll`); in December next year's holidays are added when missing.

`policy` is `'quiet'`, `'normal'` (the default) or `'busy'`, or rates changed from one:
`{ preset: 'busy', attritionPerYear: 0.3 }`. It returns `{ db, trace, report, summary }`: the trace has the
generator's format, the report counts what happened and the summary says it in plain lines. The same
workspace, date, seed and policy give byte-identical output.

```ts
import { setClockOverride } from '@/lib/dates'
import { advance } from '@/sim/advance'
import { generateCompany } from '@/sim/generate'

const { db } = generateCompany({ scenario: 'seed-8', asOf: '2026-10-01' })
setClockOverride('2026-10-01')
const { db: later, summary } = advance(db, { to: '2026-12-30', seed: 1 })   // 90 days at the normal policy
```

`src/sim/advance.test.ts` advances seed-8 and full-20 by 30 and 90 days and checks the integrity, the pay runs,
that time off and hiring happened, and that a second run is byte-identical; `src/sim/advance.rules.test.ts`
covers the presets, dates past 2026, the refusals, a clock in the middle of a pay period, leavers and leave,
and December.

### A simulation that steps

`advance` is one step of a `Simulation` (`src/sim/simulation.ts`). A simulation holds the time machine
(`src/sim/machine.ts`) and one run open between steps, so it can live a day, a week or a month at a time and
still give exactly the JSON one long step gives:

```ts
import { Simulation } from '@/sim/simulation'

const sim = new Simulation(db, { from: '2026-10-01', seed: 1, policy: 'normal' })
sim.step(7)                      // a week: { from, to, lines, notes, events, points }
sim.stepTo('2027-03-31')
sim.rewindTo('2026-12-15')       // back to the end of that day, as if it had never gone past it
sim.setPace({ attritionPerYear: 0.3 })   // from the next day, written down as a pace situation
sim.report()                     // advance's report, so far
```

It keeps a keyframe at the start and at the end of each simulated month (the workspace is an Immer value, so
a keyframe costs little). `rewindTo` restores the nearest keyframe on or before the day and lives forward from
there. Each day it also tells the day as events for a feed (`src/sim/story.ts`: "Priya Shah accepted the offer
for Account executive, starting Mon, Mar 15.", with an importance, an area and a weekly line for the routine)
and takes the day's numbers (`src/sim/metrics.ts`: headcount, people starting, open roles, the pipeline,
offers out, starts and departures, people on leave, the loaded monthly payroll). `reportCompliance: false`
skips the weekly compliance evaluation, which feeds only the report and changes nothing in the workspace.

### Situations

Situations (`src/sim/situations.ts`) are things a simulation lives through, each plain JSON with an `id` and a
date `on`. Each happens on the first business day on or after its date, at 08:20, only through the
simulator's actions, and draws its own random numbers, so adding one never changes what happens before it.

| Kind | What happens |
| --- | --- |
| `hiringPush` | `roles` roles added to the plan (in `departmentId`, or any) and opened and posted that morning |
| `growTo` | The founder keeps enough roles in the plan to reach `headcount` people by `by` |
| `freeze` | No roles planned or opened and no backfills through `until`; `holdOpenJobs` puts open jobs on hold and posts them again after |
| `quit` | Someone resigns (`personId`, or at random), with two weeks' notice or none, and a backfill unless `backfill: false` |
| `layoff` | `count` people at random, a `departmentId` or `personIds`; `noticeDays`, `closeJobs` and `freezeDays` |
| `leave` | A bonding, CFRA or other leave of `weeks` weeks, for someone who qualifies (`personId`, or at random) |
| `raiseRound` | A market raise of `percent` for everyone; `respectBands` holds raises that would leave the band |
| `leaderHire` | A Head of (`lv-m2`) or executive (`lv-x1`) hired through the pipeline; on their first day `reports` move under them |
| `pace` | `changes` to hiring pace, time off, attrition or offer acceptance from that day on |

When the app refuses a step (someone who already left quits again, a leave for someone who does not qualify,
a layoff of more people than there are), the step is skipped with a note and the run goes on. Changing the
situations after some days were lived goes back to the last keyframe before the first change and lives
forward again, so the result equals a fresh run with the new list.

### Play a run

A run file (`src/sim/play.ts`) writes a simulation down so anyone can play it again exactly:

```json
{
  "version": 1,
  "start": { "kind": "scenario", "scenario": "full-20", "seed": 2020, "asOf": "2026-10-23" },
  "seed": 1,
  "pace": { "preset": "normal", "attritionPerYear": 0.2 },
  "situations": [
    { "id": "push", "on": "2027-01-04", "kind": "hiringPush", "roles": 3, "departmentId": "d-eng" },
    { "id": "freeze", "on": "2027-03-01", "kind": "freeze", "until": "2027-04-30", "holdOpenJobs": true }
  ],
  "until": "2027-10-28"
}
```

`start` is a scenario (with its seed and as-of date), `{ "kind": "sample" }` or `{ "kind": "workspace", "date",
"db" }`. `npm run sim -- play run.json` plays it in one step and prints the headlines, the summary and the
integrity lines; a day at a time gives the same company (`src/sim/play.test.ts`). Never put a workspace with
real data in a run file you share.

## Simulate a company

`npm run sim` puts a generated company (above) into the stack, moves it through time and keeps copies of it,
so you can try the app on a company of 8, 15 or 20 people instead of the sample. To watch a company play
forward and set up what happens to it, use the simulator panel in the app instead ("The simulator panel"
below).

| Command | What it does |
| --- | --- |
| `npm run sim -- list` | The scenarios, one line each |
| `npm run sim -- run full-20` | Generates a scenario and prints its summary. `--seed N` and `--as-of YYYY-MM-DD` pick another seed or date; `--to 24m` (or a date) then lives it forward from its as-of date, with `--policy`; `--out co.json` also writes it as a backup that Settings > Data > Import reads. Needs no stack |
| `npm run sim -- reset full-20` | Replaces the stack's company with the scenario, on today's date (below). Takes `--seed`, `--as-of` and `--no-shift` |
| `npm run sim -- advance 30d` | Lives the stack's company through the next 30 days: `12w`, `3m` or a date work too. `--policy quiet`, `normal` (the default) or `busy`; `--seed N` (default 1) |
| `npm run sim -- play run.json` | Plays a run file (above) and prints its headlines and summary. `--to 6m` or a date stops elsewhere; `--events all` lists every event, `--quiet` only counts them; `--out co.json` writes the result; `--load` puts it in the stack, as reset does |
| `npm run sim -- save before-payroll` | Keeps a copy of the stack's company in `.data/dev/saves` |
| `npm run sim -- restore before-payroll` | Puts that copy back |
| `npm run sim -- saves` | Lists the copies |

Add `--offset 10` to work on the stack started with `npm run stack -- --offset 10` (its files are then in
`.data/dev-10`). `stress` is for the server only: `run` writes it, `reset` refuses it. `npm run sim` runs in
California time on every computer (`scripts/dev/sim-zone.ts`): simulated people act at California times of
day, and "today" is California's date, wherever you are.

**How it reaches the stack.** While the stack runs, its API holds the database, so reset, advance, save and
restore ask the API: `GET` and `POST /__dev/workspace`, development-only routes beside the one `npm run sql`
uses, with the same per-run secret and the same checks, for the stack's own company only. advance reads the
company, lives the days in the `npm run sim` process and sends the result back with the history and change
number it read; if the app synced an edit in that second or two, the stack refuses and nothing is replaced,
so run advance again. A replace goes through the same server function as the app's Import, so the app takes
it the way it takes a company another computer sent: on its next sync (within 30 seconds, or when its tab gets focus) it shows the new company with a notice
that the server's workspace was replaced. After an advance or a restore of the same company, the notice says
it was replaced with another copy of it. With no stack running, `npm run sim` takes the stack's lock
(`.data/dev/stack.pid`: `npm run stack` refuses to start meanwhile and says why) and works on a copy of the
database folder, which it swaps in with two renames when the replace is done (`scripts/dev/pg-swap.mjs`). The
folder itself is never written in place, so Ctrl+C (which stops the command before the swap) or a crash at
any point leaves the stack's company as it was; the next `npm run sim` or `npm run stack` clears up the copy
left behind.

**On today's date.** The app shows a company on today's date, so reset generates the scenario as of the last
day on or before today that falls on its as-of date's weekday (scenario plans are written relative to the
as-of date), then lives the 0 to 6 days left with the time machine (normal policy), so the company's date is
today. Because the company is generated for that date, rather than made for another date and moved, every
date rule holds as it does in the app: starts and interviews skip company holidays, plan lines sit in the
quarter of their target start, pay runs follow the real pay periods, and payroll-edge's start, leave and last
day fall inside pay periods. The summary reset prints names the as-of date it used. `--no-shift` loads the
scenario on its own as-of date instead:
the app still shows today, and Settings > Data > Pretend today is shows the as-of date. `ledgerlark` is the
sample as the app loads it, moved by the app's own rule.

**The company's date.** advance starts from the company's date: the day the last reset, advance or restore
left it on, kept in `.data/dev/sim-date.json` for the copy the server holds (edits in the app keep it; any
other company, such as the sample the stack loads or an Import, lives on today's date). After `advance 30d`
the company is 30 days ahead of the app, which still shows it on today's date, so people who started in those
days look like future starts. To see it on its own date, let the app take the new copy, then set Settings >
Data > Pretend today is to that date (the app holds sync while it is on).

**What the time machine does, and what it does not.** Each day it runs the app's load-time changes; on business
days it sends and approves time off, hires through the pipeline, gives anniversary raises, now and then has
someone resign (with a backfill) or start a leave, prepares and marks pay runs submitted, and on Mondays clears
the inbox's one-button items and checks the compliance rules ("The time machine" above has the details). It
never declines time off, terminates anyone, adds contractors, extends offers, enters provider totals, approves
grants at a board meeting or changes Settings > Rules and rates.

**Saves.** `npm run sim -- save <name>` writes `.data/dev/saves/<name>.json`: the company as the server holds
it, and its date. A save with the same name is replaced. restore keeps the saved company's identity, so the
app treats it as another copy of that company, or as another company when the stack holds a different one.

**The cache.** Generated companies are kept in `.data/dev/scenarios`, by scenario, seed, as-of date and a hash
of every source file generation reaches (the generator, the domain rules, the law tables, the name pools), so
a repeat reset in the same week takes about a second and any change to that code generates again. Delete the
folder whenever you like. `npm run stack -- --fresh` deletes the whole data folder, saves and cache included.

**File a bug as scenario, seed and as-of date.** "full-20, seed 2020, as of 2026-10-09: the second pay run of
November leaves out the person on leave." Anyone can rebuild that company exactly, with
`npm run sim -- run full-20 --seed 2020 --as-of 2026-10-09 --out co.json` or `generateCompany` in a test. If
you saw it in the stack, take the as-of date from the summary reset printed, and add the day you ran reset
(it lived the days from that date to today) and each advance in order, with its policy and seed: "full-20,
seed 2020, as of 2026-10-23, reset on 2026-10-28, then advance 30d --policy busy --seed 1". Best of all, write
it as a failing test on a fixed as-of date: a generated company, `advance` if needed, and the check.

`server/src/sim/smoke.test.ts` (server tier, on CI) generates every scenario but `stress`, loads it into the
server as an Import would, advances it 90 days at the normal policy (the last week runs into January 2027)
and loads it again. Then `v_integrity_problems` must be empty,
`v_hire_journey` must have a row for every hire, the server must give back exactly what it was sent, and a
second run must give the same JSON. With `SIM_STRESS=1` it also generates `stress` and loads it once, to prove
the server takes it: `SIM_STRESS=1 npx vitest run server/src/sim/smoke.test.ts -t stress`. That case is left
out of CI until it has been timed (it has never finished on the computers it was written on).

### The simulator panel

A development build of the app (`npm run dev` or `npm run stack`) has a simulator at `#sim`: the
**Simulator (dev)** link under the navigation, in the rail and in the phone menu. It plays a company forward
in fast time, lets you set up situations and change the pace while it plays, and opens the result in the
real screens. A build never has it: `main.tsx` loads `src/dev/sim/register.ts` only behind
`import.meta.env.DEV`, and the guards and CI's build check prove it ("Where it lives" below).

**Start a run.** Pick where it starts: *This company, now* (a copy of the workspace this browser holds, on
the app's today; your company is not touched), *A scenario* with its seed and, if you like, an as-of date
(`stress` is left out: it is too big for a browser), or *The sample*. Then the run's seed, the pace (quiet,
normal or busy) and the day it runs until (a year by default, about three at most). The same start, seed,
pace and situations always play the same run.

**Play it.** Play and Pause, +1 day, +1 week and +1 month, and four speeds: 1 day, 1 week or 1 month a
second, or Max (as fast as the computer goes; two years of full-20 took 5 to 8 seconds in Node on the computer it
was measured on). The
simulation runs in a Web Worker, so the page stays usable while it plays and the app's own clock is never
touched. Leaving the page pauses it. Keys (in the ? sheet under Simulator, off when single-key shortcuts
are off): `k` play or pause, `.` a day, `w` a week, `m` a month, `1` to `4` the speed, `[` back a month.

**The timeline** runs from the start to the end. The ticks are the first of each simulated month: click
one to go back to it. Diamonds are situations (click to edit), shaded bands are hiring freezes, and the
line is today in the run. The slider under it does the same by keyboard: an earlier day goes back to it (a
monthly point, then at most a month of days lived again, under a second), a later day plays there at Max.

**What you see.** Tiles for employees (and people starting), open roles (and jobs on hold), the pipeline,
starts and departures since the run began, people on leave and the loaded monthly payroll; headcount over
time (solid: employees, dashed: with people starting, the 5, 15 and 20 lines, the situations marked); and
a feed of what happened, newest first, filtered by Headlines, Hiring, People, Pay or Everything (the
newest 500 events). A screen reader hears the date and headcount when the simulation pauses, never while
it plays.

**Situations** ("Situations" above for what each kind does). *Add a situation* lists hiring push, grow to a
headcount, hiring freeze, someone quits, layoff, leave, raise round and senior hire. The sheet has fields
for the kind; people and departments come from the simulated company as of the last pause, and "Someone at
random" is the default. When the app refuses a step (someone who already left, a leave they do not
qualify for), the list shows the note under the situation and the run goes on. A situation added, changed
or removed before today in the run lives the days again from the monthly point before it, so what you see
is what a fresh run with the new list gives.

**Pace.** Sliders for hiring pace (0 to 3 times), attrition (0 to 40% a year), time off (0 to 3 times) and
offer acceptance (0 to 100%), playing or paused. A change applies from the next simulated day and is kept
in the run as a pace situation, so a saved run plays the same again.

**Run files.** *Run files* copies or downloads the run as a run file (the same JSON `npm run sim -- play`
reads, "Play a run" above), keeps up to eight small runs in this browser, and plays a run you paste or
open. A run that starts from this company carries the company, so share a bug report instead: *Copy bug
report* gives where it stopped, the last actions and a run file with the company left out. *Download
company* saves the simulated workspace as a backup that Settings, Data, Import reads.

**Open in the app.** Shows the simulated company in the app on its simulated date: Home, People, Hiring,
Comp and plan all show it, with a banner saying it is simulated. Nothing is saved or synced meanwhile, even
when this browser syncs with a server: the panel sets the clock to the simulated date first (on a pretend
date the sync engine sends and queues nothing, `docs/SYNC.md`), waits for a sync already running, holds
the store's saving, and only then swaps the company in. You can click around and edit it; edits stay in
that copy. *Back to my company* puts your company back exactly (the same Undo history, the same changes
waiting to sync, the saved copy never changed), and so does reloading the page. While it is open the
simulator waits; *Back to my company and continue* goes back and plays on (edits made in the app are not
part of the run).

**Keep it.** The banner's *Keep it...* makes the simulated company your company, with a two-step press in
the dialog. It goes back first, then replaces your company the way Import does: one Undo step when this
browser is not connected, or the server's workspace for everyone who signs in when it is. The kept company
gets a new identity (another company, never merged with yours), and the dialog offers to download a copy
of your company first and to pretend today is the simulated date afterwards (Settings, Data). A company
over 4 MB is refused: a browser keeps about 5 MB for a site; download it instead.

**Time zones.** Simulated people act on California time (`src/lib/runContext.ts`). In a browser from about
Central Europe eastwards, a California afternoon is already the next day, so the panel refuses to start and
says so: use `npm run sim -- play` (it runs in California time) or set the browser's location to Los
Angeles in DevTools (Sensors).

**Where it lives.** `src/dev/sim`: `runner.ts` (the loop the worker runs, tested without a Worker),
`sim.worker.ts`, `protocol.ts` (the messages), `client.ts` and `panelState.ts` (the panel's store),
`sandbox.ts` (Open in the app, Back, Keep), `helpers.ts` and the page's components. It reaches the Shell
through `src/app/devSlots.ts` (a page at a route the route table does not have, the banner, the link),
which stays empty in a build. `src/dev/guard.test.ts` holds every import of `src/dev` to
`if (import.meta.env.DEV)`, `src/sim/guard.test.ts` lets only tests, tools and `src/dev` import the
simulator, both read worker URLs (`new URL('...', import.meta.url)`), and CI fails if `first-twenty.html`
holds `ft-dev-simulator` (the panel's marker), `Simulator (dev)` or an error message only `src/sim` has.

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
`npm run stack -- --fresh` makes a new database (it deletes the old one and the dev login). It also deletes
the saves `npm run sim` keeps in the data folder: to keep them, delete only `.data/dev/pg` instead, start the
stack (it makes a new database with the sample company), then `npm run sim -- restore <name>`.

**npm run sql: "Something answers on 127.0.0.1:8787, but .data/dev/dev-tools.json is missing".** A stack
started before `npm run sql` existed, or `npm run server:dev`, holds the port. Stop it and start
`npm run stack` again.

**npm run sql: "The stack's API did not take the request".** The running stack's secret does not match the
one in `.data/dev/dev-tools.json` (usually a stack started before `npm run sql` existed). Restart the stack.

**"npm run sim is writing to this data folder".** `npm run sim` holds the folder while it works on it with
no stack running. Wait a few seconds and start the stack again. If no `npm run sim` is running, the stack
usually removes the file it left behind by itself. On Windows it can only tell that some node process has
that number, so if it still refuses, delete `.data/dev/stack.pid` and try again.

**npm run sql: "No answer from the stack's API".** A statement is still running in the stack's API, which
PGlite cannot interrupt. Wait, or stop the stack with Ctrl+C and start it again.
