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
| `npm run dev` | The app at http://127.0.0.1:8826 |
| `npm run server:dev` | The optional server on PGlite (Postgres in WebAssembly, no install) |
| `npm test` | All unit tests (Vitest); `npm test -- src/domain/payrun` runs one folder |
| `npm run typecheck` | TypeScript for the app and the server |
| `npm run verify` | Typecheck, all tests, the one-file build. Must pass before a pull request |

Run Vite only through these scripts (they pass the memory flag it needs); never `npx vite`.

## How to work here

- Never commit to `main` and never force-push a shared branch. Work on a branch named
  `<workstream>/<short-task>`: `s1/password-reset`, `s2/ny-pay-range`, `s3/lark-evals`. `s1`, `s2` and
  `s3` are workstreams 1, 2 and 3; `team` is shared work.
- Team members rotate workstreams every two weeks. Before starting in a workstream, read its handover
  notes in `docs/handover/`.
- One issue, one branch, one pull request. Keep pull requests small enough to review in 15 minutes.
- For anything bigger than a one-file fix, propose a plan first and wait for the team member to approve it.
- Before saying a change is done, run `npm run verify` and report the result honestly, failures included.
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
  A schema change is a new numbered file plus a test.
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
- Server tests run against PGlite; they never need a real database or network.
