# First Twenty: notes for Claude Code

First Twenty is an applicant tracking system and people system for small companies, from the first hire
to about 20 employees. Three team members build it with the product owner. Each team member
works through Claude Code, and every change reaches `main` through a reviewed pull request.

Read before changing code:

- `ARCHITECTURE.md`: the build contract (stack, folders, data rules, design, accessibility, privacy, copy).
- `docs/SPEC.md`: what to build. `docs/LAW.md`: the verified legal facts. `docs/LOOKS.md`: before any UI work.
- `docs/SYNC.md` and `docs/SERVER.md`: before touching `src/sync` or `server/`.
- `CONTRIBUTING.md`: the team workflow this file assumes.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install dependencies (Node 22 or newer) |
| `npm run stack` | The app, the server on its own PGlite database with the sample company, signed in (`docs/DEV.md`); `-- --fresh` starts over, `-- --offset 10` runs a second one |
| `npm run sql` | Reads the stack's database with SQL and never changes it: `npm run sql -- hires`, or one SELECT in quotes (`docs/DEV.md`) |
| `npm run dev` | The app alone at http://127.0.0.1:8826 |
| `npm run server:dev` | The optional server on PGlite (Postgres in WebAssembly, no install) |
| `npm test` | Every test, all four tiers (Vitest); `npm test -- src/domain/payrun` runs one folder |
| `npm run test:unit` | The unit tests: no database, no server (`src/`, `scripts/`) |
| `npm run test:server` | The server tests: the API on in-memory PGlite (`server/src/`) |
| `npm run test:e2e` | The journeys through the real API (`server/src/e2e/`, the `src/sync` round trips) |
| `npm run test:deploy` | The deploy kit's tests (`server/deploy/`): seconds on Linux, about 13 minutes on Windows |
| `npm run test:changed` | Only the tests your changes since `origin/main` touch, in every tier but the deploy kit |
| `npm run test:watch` | Reruns the tests each save touches (every tier but the deploy kit) |
| `npm run check` | Typecheck and `test:changed`: a quick check while you work |
| `npm run typecheck` | TypeScript for the app and the server |
| `npm run verify` | Typecheck, the unit, server and journey tests, the one-file build. Must pass before a pull request. The deploy kit's tests run in a CI job of their own and in `npm run test:deploy` |

Run Vite only through these scripts (they pass the memory flag it needs); never `npx vite`. `npm run stack`
keeps running until stopped: start it in the background and stop it when you are done.

A development build has a simulator panel at `#sim` (`docs/DEV.md`, "The simulator panel"). It lives in
`src/dev/sim` and never ships: keep it out of `src/app/routes.tsx` and of anything a build imports.

## How to work here

- Never commit to `main` and never force-push a shared branch. Work on a branch named
  `<workstream>/<short-task>`: `s1/password-reset`, `s2/ny-pay-range`, `s3/lark-evals`. `s1`, `s2` and
  `s3` are workstreams 1, 2 and 3; `team` is shared work.
- Team members rotate workstreams every two weeks. Before starting in a workstream, read its handover
  notes in `docs/handover/`.
- One issue, one branch, one pull request. Keep pull requests small enough to review in 15 minutes.
- For anything bigger than a one-file fix, propose a plan first and wait for the team member to approve it.
- Before saying a change is done, run `npm run verify` and report the result honestly, failures included.
  After a change under `server/deploy/`, run `npm run test:deploy` too.
  For UI changes, also check the page in the browser at 375px wide, by keyboard only, and in every look.
- Write the pull request description from `.github/pull_request_template.md`, and say what Claude did
  in the "How Claude helped" section.
- Keep the `Co-Authored-By: Claude` line in commit messages. The history should show where AI helped.
- If a request conflicts with a rule below, stop and say so instead of working around it.

## Hard rules

- **The repo is public and open source.** Never commit, paste or write in an issue or pull request anything
  private: real people's data, notes from founder sessions, secrets, server details. Security findings go
  through `SECURITY.md` (private vulnerability reporting), never a public issue, pull request or commit message.
- **Demo data only.** Never put a real person's name, email, pay, or any real company's data into code,
  tests, fixtures, issues, commit messages or prompts. Use the sample company Ledgerlark (`docs/SAMPLE.md`)
  or invented data.
- **Legal facts never come from memory, Claude's included.** Every rule, threshold, rate or deadline the app
  shows comes from an official source (statute, regulation, agency page). Record it in `docs/LAW.md` with the
  link and the date it was checked; constants live in `src/data/law.ts`. If the source cannot be opened,
  stop and say so.
- **Never edit an applied SQL migration** (`server/sql/001` to `006`, and any migration already on `main`).
  A schema change is a new numbered file plus a test; `npm run server:gen-sql -- --checksums` lists it in
  `server/sql/SHA256SUMS`, which a test checks so an applied migration cannot change unnoticed.
- **No secrets.** Never read, print or commit `.env` files, keys, tokens or passwords. The live server's
  settings are not in this repo, and nobody but the product owner deploys.
- **Privacy rules in ARCHITECTURE.md are hard**: no protected characteristics, no SSNs or bank details,
  no salary history, no AI scoring or ranking of candidates.
- **Roles are not enforced by the server yet.** `useViewer()` is a preview. Never describe a role check in
  the browser as security; the security workstream is moving these checks to the server.
- **No new dependencies** without saying why in the pull request; the product owner decides.
- **`server/deploy/` changes need the product owner's review.** It is the live server's install and deploy kit.
- **Security testing runs only against local copies** (`npm run server:dev`), never the live server, and
  only within the written scope the product owner has signed.

## Tests

- Pure logic gets a `*.test.ts` next to it. Use fixed dates (`setClockOverride` from `@/lib/dates`),
  never the real clock.
- A bug fix starts with a test that fails without the fix.
- Server tests run against PGlite; they never need a real database or network. `server/src/test/` holds
  their shared setup (`useApp`, `useCareers`, `saveRows`); passwords there hash at a cheap test-only cost.
- Every test file belongs to exactly one tier (`scripts/test/tiers.ts`); a file outside the tier folders
  fails `scripts/test/tiers.test.ts`. A test under `src/` that starts the real server belongs in the e2e tier.
- Every test run is in UTC (`vite.config.ts`), as on CI.
- `npm run check` picks tests by their imports, so it misses files read from disk: after a change to
  `server/sql/`, run `npm run test:server` and `npm run test:e2e` too.
