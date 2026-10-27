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
   browser tab opens the app at `https://<your-codespace-name>-8826.app.github.dev`.
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
| `npm run dev` | The app alone, keeping its data in the browser only (no server) |
| `npm run server:dev` | The API alone, on its own database in `.data/pg` (docs/SERVER.md, "Develop locally") |
| `npm test -- src/sync` | The unit tests in one folder |
| `npm run typecheck` | TypeScript for the app and the server |
| `npm run verify` | Typecheck, all tests, the one-file build. Must pass before a pull request |

## What runs where

| Piece | Where | Notes |
| --- | --- | --- |
| The app (Vite dev server) | http://127.0.0.1:8826 | Reloads on every change. Passes `/api` through to the API, so the app and the API share one address, as on the live server |
| The API (Fastify, `tsx watch`) | http://127.0.0.1:8787 | Restarts when server code changes. Development mode, sign-up open (try making a company), Lark is the scripted fake (no key needed, nothing leaves the computer) |
| The database (PGlite) | `.data/dev/pg` | Real Postgres compiled to WebAssembly. Only one process can open it at a time |
| The dev login | `.data/dev/credentials.json` | `dev@example.test` with a random password, made once. The file never leaves your computer or codespace (`.data/` is git-ignored) |

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
