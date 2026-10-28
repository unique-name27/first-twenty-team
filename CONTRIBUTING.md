# Contributing to First Twenty

This repo is built by a small product team over eight weeks. The work is split into three workstreams,
and the three team members rotate through them every two weeks, so by week 6 each has led all three.
Weeks 7 and 8 finish the work. An advisor joins the release reviews, 30 minutes every second week. The
product owner gives the project one hour a week, the Wednesday session: setting priorities, reviewing the
protected paths in `.github/CODEOWNERS` and releasing to the live server by publishing a GitHub release.
Everyone writes code with [Claude Code](https://code.claude.com/docs/en/setup), and every change reaches
`main` through a pull request that passes CI and a review.

## This repo is public

First Twenty is open source. Everything here is visible to anyone: the code, the commit history, issues,
pull requests and every comment. Use demo data only. Never write names or details from founder usability
sessions in the repo, an issue or a pull request. Never commit or paste secrets. Security problems go
through [`SECURITY.md`](SECURITY.md), never a public issue or pull request.

**Outside contributions:** during the eight-week project, people outside the team may open issues. Pull
requests from outside the team are welcome after week 8.

**License:** First Twenty is open source under the [Apache License 2.0](LICENSE). Anyone may use, change,
share and sell it, as long as they keep the license notice. Under section 5 of the license, anything you
submit to the project is under Apache-2.0 too, unless you explicitly say otherwise.

## Set up (week 1)

`docs/DEV.md` has the details and the troubleshooting.

1. **Open a codespace** (nothing to install): on the repo page choose Code > Codespaces > Create codespace
   on main, or open https://codespaces.new/unique-name27/first-twenty-team. It comes with Node 22, Claude
   Code and the GitHub CLI, installs the dependencies and runs `npm run stack`, which starts the API with
   its own database and the app, and opens the app in a new tab, signed in to the sample company.
   **Or work on your own computer:** install [Git](https://git-scm.com/downloads), [Node.js](https://nodejs.org/en/download)
   22 or newer and Claude Code (macOS, Linux, WSL: `curl -fsSL https://claude.ai/install.sh | bash`;
   Windows PowerShell: `irm https://claude.ai/install.ps1 | iex`). Clone the repo, then run `npm ci` and
   `npm run stack`, and open http://127.0.0.1:8826.
2. Sign in to Claude Code: run `claude` in the repo folder (in a codespace, in a new terminal) and follow
   the prompts. It needs a Claude Pro, Max, Team, Enterprise or Console account.
3. Run `npm run verify`. Every test should pass. If one fails on a clean clone or a new codespace, open an
   issue: that is a bug in the repo, not in your setup.
4. Walk the demo path with the sample company in the app `npm run stack` opened: open a job, move a
   candidate to an offer, hire them, check the onboarding checklist, prepare a pay run. Then make a demo
   company on the live server and try the careers page and Lark there. Staging,
   https://staging-77-112-161-54.sslip.io, runs the newest `main` with open sign-up for demo companies
   (no Lark and no careers pages there).
5. Read `README.md`, `ARCHITECTURE.md` and `CLAUDE.md`. Then ask Claude Code for a tour of the code your
   workstream touches, and check what it tells you against the code.

## The seven steps

1. **Pick an issue** from the project board and assign it to yourself. If "Done when" is unclear, ask in
   the issue before starting.
2. **Branch from `main`**: `git switch main && git pull && git switch -c s1/password-reset`.
   Use your workstream's prefix:
   - `s1/`: workstream 1, security and team logins
   - `s2/`: workstream 2, HR depth and integrations
   - `s3/`: workstream 3, product, access and AI
   - `team/`: shared work
3. **Plan with Claude Code first.** Describe the issue and ask for a plan before any code (plan mode:
   Shift+Tab). Push back on the plan until you agree with it.
4. **Build and check locally.** Let Claude write the code and its tests, read every change it makes, then run
   `npm run verify` (while you work, `npm run check` is quicker: see "Tests" below). For UI, try it in the
   browser at 375px wide and by keyboard only.
5. **Open a pull request** and fill in the template. Link the issue (`Closes #12`). Open it as a draft early
   if you want feedback before it is finished.
6. **CI and review.** GitHub Actions runs four jobs side by side (typecheck and both builds, the unit tests,
   the server tests and journeys, the deploy kit's tests), and its `verify` check passes only when all four
   did. One teammate reviews and approves. A change to a protected path (database migrations, the deploy
   kit, dependencies, CLAUDE.md, `.claude/`, `.github/`, SECURITY.md, `.devcontainer/`, `scripts/dev/`)
   also waits for the product owner, who reviews those in the Wednesday session. Answer every comment, by a
   change or a reply.
7. **Merge.** Use "Squash and merge" once CI is green and the approvals are in. Merged work appears on
   staging at https://staging-77-112-161-54.sslip.io within minutes, once CI passes on `main`: check it
   there. The product owner releases to the live server by publishing a GitHub release, once a week at the
   end of the Wednesday session, and the server deploys it on its own (`docs/SERVER.md`, "Automatic deploys
   from GitHub").

## Tests

The tests come in four tiers, one npm script each. `npm test` runs all four.

| Command | What it runs |
| --- | --- |
| `npm run test:unit` | The unit tests: no database, no server (`src/`, `scripts/`). Most tests are here |
| `npm run test:server` | The server tests: the API on in-memory PGlite (`server/src/`) |
| `npm run test:e2e` | The journeys through the real API (`server/src/e2e/`, the `src/sync` round trips) |
| `npm run test:deploy` | The deploy kit's tests (`server/deploy/`): seconds on Linux, about 13 minutes on Windows |
| `npm run test:changed` | Only the tests your changes since `origin/main` touch, every tier but the deploy kit (a change to `package.json` or `vite.config.ts` runs them all) |
| `npm run test:watch` | Reruns the tests each save touches, every tier but the deploy kit |
| `npm run check` | Typecheck and `test:changed` |

`npm run verify` runs typecheck, the unit, server and journey tests and the app build. It leaves out the deploy
kit's tests: CI runs them in a job of their own, and `npm run test:deploy` runs them on your computer. Run that
too when you change anything in `server/deploy/`.

`test:changed` and `test:watch` pick the tests that import what you changed, so they miss a file the tests
only read from disk. After changing a SQL migration in `server/sql/`, run `npm run test:server` and
`npm run test:e2e`; after changing `.github/workflows/ci.yml`, run `npm run test:unit`.

A new test file goes next to the code it tests, and its folder decides its tier. A file that fits no tier fails
`scripts/test/tiers.test.ts`, so no test can quietly stop running. Every test run is in UTC, as on CI.

## Rotations

The project runs eight weeks. Week 1 starts at the kickoff. Team members rotate through the workstreams
every two weeks. By week 6 each has led all three and worked across the whole tool.

- Rotation 1: weeks 1 and 2
- Rotation 2: weeks 3 and 4
- Rotation 3: weeks 5 and 6
- Finish: weeks 7 and 8. Each team member stays on their rotation 3 workstream to test, fix and document.

| Workstream | Weeks 1-2 | Weeks 3-4 | Weeks 5-6 | Weeks 7-8 (finish) |
| --- | --- | --- | --- | --- |
| 1 · Security and team logins | Team member 1 | Team member 3 | Team member 2 | Team member 2 |
| 2 · HR depth and integrations | Team member 2 | Team member 1 | Team member 3 | Team member 3 |
| 3 · Product, access and AI | Team member 3 | Team member 2 | Team member 1 | Team member 1 |

- **First days of a rotation:** the incoming lead reads the handover notes and writes a half-page plan for
  the workstream. The plan is reviewed in the Wednesday session. In rotation 1 there are no notes yet, so
  the plan starts from the workstream's starter issues.
- **Last days of a rotation:** the lead demos the workstream at the release review and writes handover
  notes for the next lead.
- **First pull request:** the previous lead reviews the new lead's first pull request in that workstream.

Handover notes live in `docs/handover/`: `workstream-1.md`, `workstream-2.md` and `workstream-3.md`.

First pull requests are merged by the end of week 1. The release reviews are in weeks 2, 4 and 6, and the
final review is in week 8. Each review replaces that week's Wednesday session, and the advisor joins it.

No new feature starts after week 6. Stretch goals fill spare time before then. Weeks 7 and 8 go to
testing, fixes and documentation.

If a team member leaves, the workstream they lead pauses at its last merge. The next rotation's lead picks
it up. From week 5 on there is no next rotation, so it stays paused. Nobody else's work depends on it.

## Reviewing a teammate's pull request

Review within two days. Check out the branch and run it; reading the diff is not enough. Look for:

- Does it do what the issue's "Done when" says, and nothing unrelated?
- Are there tests, and would they fail without the change?
- Any real data, secrets, or legal facts without an official source?
- Does the UI follow `ARCHITECTURE.md` (tokens, keyboard, 375px, copy rules)?
- Could the author explain any part of it if asked? If something is unclear, ask.

Approve when you would be comfortable owning the code yourself. "Request changes" is normal, not a judgment.

## Ground rules

- **Demo data only**: the sample company or invented data, never real people or real companies.
- **Every legal rule has an official source** in `docs/LAW.md`, with the date it was checked.
- **Every change has tests**, and `npm run verify` passes before review.
- **No secrets** in code, issues, chat or Claude sessions.
- **Nobody pushes to `main`**, and only the product owner releases (by publishing a GitHub release).
- **You own what you merge.** Using Claude is expected; not understanding your own pull request is not.
  At each release review, each team member walks through two of their merged pull requests.

## Getting help

Stuck for more than an hour? Post in the issue what you tried and what happened, then bring it to the
Wednesday team session. Asking early is part of the job.
