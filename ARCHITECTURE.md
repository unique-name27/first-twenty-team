# First Twenty: architecture and build contract

First Twenty is a lightweight applicant tracking system (ATS) and people system (HCM) for a company growing
from a solo founder to about 20 employees. It runs entirely in the browser: no server, no accounts, data
in `localStorage`, and `npm run build` produces one self-contained `first-twenty.html`.

The sample company is **Ledgerlark, Inc.** (fictional), a seed-stage financial AI startup in downtown
San Jose, California, that builds AI agents for month-end close, reconciliation and audit prep.

Read this file before changing code. `docs/SPEC.md` holds the product spec (what to build);
`docs/LAW.md` holds the verified legal facts the compliance features rely on.

## Stack

- Vite 8, React 19, TypeScript 7 (strict), Tailwind 4 (token mapping in `src/styles.css`, values per look in `src/themes`), Zustand 5 + Immer, date-fns 4.
- `vite-plugin-singlefile` for the one-file build. No other runtime dependencies. Charts are hand-drawn SVG (`src/ui/charts.tsx`).
- Vitest for unit tests (`src/**/*.test.ts`, node environment, pure logic only; the optional server's tests live in `server/src` and `server/deploy`).
- Do not add dependencies without a strong reason. Never use the React Compiler (Node 24 crashes in it here).
- Scripts: `npm run dev` (port 8826), `npm run typecheck`, `npm test` (all four test tiers, CONTRIBUTING.md "Tests"), `npm run build`, `npm run verify` (typecheck, every test tier but the deploy kit, the build).
- Run vite only through the npm scripts (they pass `--max-semi-space-size=64`); never `npx vite`.

## Folder map and ownership

```
src/
  app/        shell: App, Shell (rail, top bar), router, nav, routes, CommandPalette, useViewer
  ui/         shared UI kit (Button, Badge, Avatar, Field controls, Panel, Sheet, Modal, Tabs, DataTable,
              charts, Tally, Toast). Import from '@/ui'. Add new shared primitives here, not in features.
  lib/        dates (today(), business days, formatting), format (money, pct, plural), id (newId)
  domain/     types.ts (THE data contract) + pure logic, one file or folder per area, each with tests
              (payrun/: pay calendar, schedule checks, pay run prep, CSV exports and Mark submitted, imported from '@/domain/payrun')
  store/      db.ts (the one store: useDB, mutate, undo, persistence), prefs.ts (per-device prefs)
  themes/     looks (visual skins): registry.ts, one <id>.css per look, optional <id>/decor.tsx, fonts.ts
  data/       law.ts (verified 2026 constants), defaults.ts, blank.ts (solo-founder start), seed/ (sample)
  features/   one folder per section: home, hiring, people, timeoff (panels), comp, compliance, me, settings;
              assistant (the Ask sheet, header button and its own Markdown renderer; no route)
  sync/       optional server sync engine (no UI): collections.ts (shared with the server), diff, outbox,
              API client, status store, the assistant's client (assistant.ts, sse.ts). Public API in index.ts.
              sync/testing holds helpers for tests only (testing/guard.test.ts keeps the app from importing
              them, server/src/dev/structure.test.ts the server). Contract: docs/SYNC.md
  careers/    careers pages (no React): render.ts (the HTML for the static demo site, scripts/careers, and
              the server's live pages), application.ts (the live apply form), careers.css
  dev/        development only, never in a build: the npm run stack auto sign-in (autoconnect.ts), imported
              by main.tsx behind import.meta.env.DEV (guard.test.ts checks it). Guide: docs/DEV.md
scripts/dev/  npm run stack: the dev stack runner, its database setup and the Vite dev sign-in endpoint;
              npm run sql: read-only SQL on the stack's database
server/       optional API server (Fastify + Postgres, PGlite in development and tests), SQL migrations,
              EC2 deploy kit (server/deploy). Built separately: npm run server:build. Guide: docs/SERVER.md
              server/src/dev is development only: the entry npm run stack starts (the same server plus
              the route npm run sql asks); production code never imports it (structure.test.ts checks it).
              The read model (server/src/readmodel) generates SQL views for reading the data with plain
              SQL, v_integrity_problems among them (the checks of src/domain/integrity.ts). Guide: docs/DEV.md
              Journey tests (server/src/e2e) walk whole paths, careers form to first pay run, through
              the real server, database and sync engines (kit.ts; docs/DEV.md, "Journey tests").
              One login belongs to one company (workspace); SIGNUP_MODE=open makes it a public demo where
              anyone can create a company (held to the demo limits), and CAREERS_HOSTS serves the careers
              page of every company that has it on.
```

The server is optional: with no server the app stays fully local. A feature never calls `/api` directly;
it uses the helpers exported from `@/sync`.

A feature folder owns its pages and components. It may import from `@/ui`, `@/lib`, `@/domain`,
`@/store`, `@/data`, `@/app/router`, `@/app/useViewer`, and the shared panels other features export
(listed under "Cross-feature panels"). It never edits another feature's files.

## Data and state

- `src/domain/types.ts` is the contract. Add optional fields freely; never rename or remove fields
  without updating every user. Money is whole USD per year (`salary`), or `hourlyRate` for hourly pay.
  Calendar dates are `'YYYY-MM-DD'` strings; timestamps are full ISO strings.
- Read with selectors: `const jobs = useDB((s) => s.db.jobs)`. Derive in components with `useMemo`,
  or better, in a pure domain function that takes `db` and returns data (testable).
- Write only through `useDB.getState().mutate(label, (draft) => { ... })`. The label names the change
  in plain words ("Moved Priya Nair to Onsite"); it becomes the Undo toast text. Inside a recipe use
  `logActivity(draft, {...})`, `upsert`, `removeById`, `findById` from `@/store/db`.
- After a user action, show `toast({ text: label, action: { label: 'Undo', onClick: () => useDB.getState().undo() } })`.
  Show it right after the `mutate`: the toast binds its Undo to that history entry (each entry has an `id`;
  `useDB.getState().undoEntry(id)` undoes it only while it is the newest). An older toast never undoes a
  newer change ("A newer change came after this one"), and a toast for a change that did nothing gets no Undo.
  Undo toasts stay 12 seconds, pause while hovered or focused, and mention Ctrl Z (registered in the ? sheet).
  Prefer Undo over confirmation. For destructive actions that cannot be undone sensibly, use `ConfirmButton`.
  Never call `window.confirm`, `alert` or `prompt`.
- "Today" is always `today()` from `@/lib/dates` (it honors the demo clock). Never `new Date()` for dates.
- Never slice a timestamp to get its day (`at.slice(0, 10)` is the UTC date, tomorrow after 5 PM in California):
  use `localDateOf(ts)` for display and comparisons with `today()`, or `pacificDateOf(ts)` for company-time records.
  `daysBetween`, `isBefore`, `isWithin` and `fmtRelative` already accept timestamps.
- Ids: `newId('c')` etc. Prefixes: p person, c candidate, a application, j job, i interview, s scorecard,
  o offer, g grant, cr comp record, ck checklist, t task, tr time off request, ps plan slot, k contractor.

## Routing

Hash routes, built with `href(...)`/`links.*` from `@/app/router`; never hand-write `#` strings.
Segments are joined with `.`: `#hiring.jobs`, `#job.j-ml-staff`, `#candidate.c-104`, `#person.p-founder.equity`.
The App keys each page on its view plus record id (`#person.<id>`), so tab switches and route-driven sheets
(`.change`, `.offboard`, `#hiring.add`, `#me.timeoff.request`) keep the page mounted: focus, filters and scroll
survive, and a sheet's focus returns to its trigger. Reset a sheet's form when it opens (an effect on `open`).
The App also sets `document.title` per route and moves focus to the page title when a route change removes the
focused element.
Page components receive `{ route }` and read `route.segments`. Tabs that should be deep-linkable use
`Tabs` with `href` per tab.

## Viewing as (roles)

`useViewer()` returns `{ role: 'admin' | 'manager' | 'employee', person }` (manager = "Hiring manager" in the UI). It is a preview, not security:
the UI must say so where it matters and never pretend otherwise. Access helpers live in
`src/domain/access.ts`; every page checks them instead of inventing its own rules.

## Design rules

- **Looks.** The app ships several complete visual styles (Sleek, 1990s web, Comic book, Trading desk),
  picked in the Display menu. `docs/LOOKS.md` is the contract: read it before any UI work. Every screen must
  work in every look, so new UI is built only from the tokens and the kit, never from one look's colors,
  fonts, radii or shadows. Never put look-specific values in `src/styles.css` or a component.
- Use the tokens: `bg-paper` (page), `bg-surface` (panels), `bg-surface-2` (subtle fills), `text-ink`,
  `text-ink-2` (secondary), `text-ink-3` (muted), `border-line`, `text-accent`/`bg-accent`,
  semantic `good`/`warn`/`bad` (+ `-soft` fills). Categorical chart colors `cat-1..6` in fixed order.
  Shape and depth come from the look too: `rounded`, `rounded-sm` to `rounded-2xl`, `rounded-full`, `border`,
  `shadow-sm`, `shadow-card`, `shadow-pop`. Never hard-code a color, radius (`rounded-[10px]`) or shadow:
  it would look right in one look only.
- Hook classes: kit components and the shell carry stable `ft-*` class names (`ft-btn ft-btn--primary`,
  `ft-panel__title`, `ft-table__row`, ...; full list in `docs/LOOKS.md`) that looks restyle. New shared
  components get hooks in the same pattern; a hand-built control that looks like a kit one carries the kit's
  hooks (a custom primary button adds `ft-btn ft-btn--primary`). Never remove or rename a hook.
- Type: `font-display` for page and panel titles only, the body font everywhere else, `font-mono` for ids and
  keyboard hints; each look sets the faces. Use `num`/`tabular` class on aligned numbers.
- Layout: page = `PageHeader` + content. Group content in `Panel`s; do not wrap every element in a card.
  Grids collapse to one column at phone width. No horizontal page scroll at 375px, at 100% or 150% text size.
- Breakpoints follow the space the layout really has. Text size zooms the page and media queries ignore zoom,
  so `sm:`/`md:`/`lg:`/`xl:` (and `max-*`) are redefined in `src/styles.css` as container queries on `body`
  (named `app`), 20px below Tailwind's defaults to allow for the window scrollbar. Use them as usual. In JS,
  measure the element (a `ResizeObserver`, as `src/ui/charts.tsx` does) instead of `matchMedia('(min-width: ...)')`, which reads
  the window and ignores text size. Dense rows inside one panel can use `@container` + `@[640px]:` variants.
- Buttons and badges grow taller instead of overflowing: their heights are minimums, and a label longer than
  the space it has wraps inside the control. Do not add `whitespace-nowrap` or fixed heights to them.
- State is shown in form, not color alone: `Badge` with a word, plus an icon where it helps.
- Charts: follow the dataviz rules already built into `src/ui/charts.tsx` (thin marks, legends for 2+ series,
  direct labels sparingly, text in ink tokens). Small numbers: show counts first; show a rate only when n >= 5.

## Accessibility (a build gate: the primary user has a motor disability)

- Every action is reachable by keyboard and has a visible focus ring. No drag-only or hover-only actions.
  The ring (`:focus-visible` in `styles.css`) is unlayered so no utility removes it; its offset and rounding sit
  in the base layer, so `focus-visible:outline-offset-[-3px]` insets it where a scroll strip would clip it.
- Hit targets at least 40px tall (the kit's default sizes do this). Large primary buttons for frequent actions.
- Prefer picklists, chips and defaults over typing. Date fields offer quick chips (Today, Next Mon, +1 week).
- Every form control has a label and a stable `id`. Icon-only buttons need `label`. `Field required` / `error`
  put `aria-required` / `aria-invalid` on the control; after a failed submit call `focusFirstInvalid()` from `@/ui`.
- Groups of radio or tab buttons use `rovingKeyDown` and `rovingTabIndex` from `@/ui` (one Tab stop, arrows,
  Home and End). `Tabs` with `href` render as a `<nav>` of links with `aria-current`; with `onChange`, as a tablist.
- Overlays: `Sheet` and `Modal` focus `[data-autofocus]`, else the first control in the body (never Close), trap Tab,
  and give focus back on close (to the trigger, its re-rendered twin, `returnFocus`, or the page title). `Menu`
  renders in a portal (never clipped by scroll containers), returns focus to its trigger on Escape, pick or Tab.
  Escape closes only the topmost overlay (`useEscape` keeps a stack): a menu or dialog over a sheet closes alone.
  A component that handles Escape itself calls `preventDefault()` (and `stopPropagation()` in a React handler),
  so the overlay under it stays open.
- Controls that remove themselves (the header Undo after the last change, a toast's Undo or Dismiss) move focus
  to a stable neighbor or back where it came from first (`restoreFocus` from `@/ui`), never to `<body>`.
  `restoreFocus` focuses the original element where it is (no scroll), but scrolls a replacement or the
  fallback into view, so focus never lands on something off-screen.
- Input and switch borders use `border-control` (the `--control-border` token, 3:1 on surfaces), not `border-line-strong`.
- Respect `prefers-reduced-motion` (handled globally in CSS); never animate content into view from opacity 0.

## Copy rules

- Sentence case everywhere ("Add candidate", not "Add Candidate"). No em dashes in UI text.
- Plain, specific, active voice. Buttons say what happens ("Send offer"); toasts confirm it ("Offer sent").
- Errors say what went wrong and how to fix it. No apologies, no jokes.
- Legal guidance is phrased as guidance with a source link and "Not legal advice" where rules are shown.

## Privacy rules (hard)

- Never collect protected characteristics: gender, race, ethnicity, age, date of birth, disability,
  veteran status, religion, marital status, pronouns. Anniversaries replace birthdays.
- Never store SSNs, bank details, ID documents, I-9 forms or background check reports. Track status + date.
- No salary history anywhere: candidates have `desiredPay` only (Labor Code 432.3).
- Criminal history cannot be recorded before a conditional offer (Fair Chance Act).
- Form fields follow the privacy blur too: `MoneyInput` always, `NumberInput` for `$` rates, share or option
  counts and percent-of-base (pass `sensitive` when the heuristics cannot tell, such as a bare share count).
- Non-admin views never show other people's pay or equity (see access.ts). Every amount renders through
  `<Money>`/`<Private>` so the privacy blur (key B) hides it for screen sharing.
- No AI scoring or ranking of candidates. People decide; the app organizes.

## Legal rules by work state

- California-only checklist tasks carry `when: { outsideCA: false }` (notices, CA final pay, SDI/PFL, CFRA, 2810.5,
  IIPP); people working elsewhere get the new-state card and `off-state-final-pay` instead. `leaveEligibility`,
  the offer `exemptCheck` and `offerLetter` read the work state (location state or home state).
- A statutory deadline counted in business days (I-9 section 2) skips weekends and federal holidays only
  (`federalHolidays` in `@/lib/dates`), never company days off. Company targets (the 5-business-day CFRA
  designation notice, the 30-day WVPP training target) are `statutory: false`.
- A rule card cannot read Done while per-person legal deadlines under it are overdue (`RuleResult.followUps`).

## Tests

Pure logic in `src/domain/**` gets unit tests next to it (`*.test.ts`). Use fixed dates, never the real clock
(`setClockOverride` from `@/lib/dates` when a function reads `today()`). UI is verified in the browser.

## Routes (who owns what)

| Route | Page | Owner |
|---|---|---|
| `#home` | Home (Tonight header, inbox, threshold card, growth chart, this week, hiring pulse, checklists in flight, people cost; First hire kit at headcount 1). Employees land on Me instead. | features/home (+ `src/domain/inbox.ts`) |
| `#hiring[.jobs\|.candidates\|.offers\|.kits]` | Hiring tabs. `#hiring.add[.<jobId>]` opens quick add; `#hiring.new-job[.<planSlotId>]` opens the new job sheet. Synced with a server that serves careers pages, the header links to the company's page (`useServerAccount` from `@/sync`). | features/hiring |
| `#job.<id>[.board\|.list\|.sweep\|.edit\|.posting]` | Job pipeline (list default under 768px), Sweep mode, edit, posting text (`.edit.posting` edits, then returns to the posting) | features/hiring |
| `#candidate.<id>[.offer.<applicationId>]` | Candidate profile; `.offer.<applicationId>` (`links.candidateOffer`) puts focus on that application's offer next action | features/hiring |
| `#people[.directory\|.org\|.wall\|.checklists\|.timeoff\|.contractors]` | People tabs. `#people.new` adds a person; `#people.contractors.new` adds a contractor or advisor. The Time off tab renders `TimeOffTab` from features/timeoff. | features/people |
| `#person.<id>[.overview\|.job\|.equity\|.timeoff\|.checklists\|.emergency\|.activity\|.offboard\|.change]` | Person profile; `.offboard` and `.change` open those sheets | features/people |
| `#checklist.<id>` | One checklist | features/people |
| `#contractor.<id>` | Contractor or advisor | features/people |
| `#comp[.plan\|.bands\|.table\|.equity\|.cost\|.payruns[.<period start>]]` | Comp and plan (admin). `#comp.payruns.<YYYY-MM-DD>` (`links.payRun`) opens Pay runs on the pay period starting that day (default: the next payroll to run, `nextPayRunDue`): pay run prep for the payroll provider or PEO (docs/SPEC.md PAY RUN PREP; logic in `src/domain/payrun`). Its marks and provider totals (`company.payRuns`) and settings (`company.payroll`, edited in Settings > Link-outs) are fields of the company document, which syncs by field: no record collection or SQL migration. | features/comp |
| `#compliance[.milestones[.<ruleId>]\|.calendar\|.training\|.notices\|.soc2\|.records]` | Compliance (admin) | features/compliance |
| `#me[.summary\|.job\|.equity\|.timeoff\|.tasks\|.profile\|.roles]` | Me; `#me.timeoff.request` opens the request sheet | features/me |
| `#settings[.company\|.org\|.hiring\|.templates\|.timeoff\|.rules\|.links\|.data\|.server]` | Settings (admin). `#settings.data.fresh` and `#settings.server.fresh` open Start fresh; `#settings.data.import` focuses Import; `#settings.server` connects to the optional server (docs/SYNC.md); on a demo server (anyone may sign up) it also offers Create a demo company, and `#settings.server.signup` puts focus there. Signed in, it shows the company on the server, invite links and its careers page. | features/settings |
| `#invite.<token>` | Join a company with an invite link from Settings, Server: a new login in that company, then its workspace into this browser. Any role (no section); the token is the record id, never the tab title. | features/settings (`InvitePage`) |
| (no route) Ask sheet | The in-app HR assistant (`assistantDisplayName`: the company's `assistantName`, else "<company> Bot"; the sample's is Lark). Header button and H (Admin view only), or Ctrl K ("Ask Lark", or any search sent as a question); the sheet's pencil renames it, as does Settings > Company. Answers stream from the server (docs/SERVER.md "Lark, the assistant") through `assistantChat` in `@/sync`; the conversation lives in this tab (memory and sessionStorage, tied to the login and to the server workspace history it was about, so Start fresh or an Import drops it; never synced) and goes back to the server exactly as it came. Links in answers go only to in-app page routes (an absolute address into the app included, through the same route rules) and to the official sources the assistant's lookups cite (`officialSourceHosts` in `src/domain/assistant.ts`); any other address shows as text that cannot be followed (`safeLink` in features/assistant/markdown.tsx). | features/assistant |

Aliases: `#timeoff` -> `#people.timeoff`, `#plan` -> `#comp.plan`. Always build links with `links.*`
from `src/app/router.ts`. The App shell checks section access (`canSeeSection`) before rendering a page.

## Cross-feature panels (import these; do not rebuild them)

Each is exported from the owning feature's `index.tsx` (stubs exist until that feature is built).

- `@/features/timeoff`: `TimeOffTab`, `PersonTimeOffPanel({personId, hideRequest?})`, `RequestTimeOffSheet({open,onClose,personId})`, `WhosOutStrip({from,to})`
- `@/features/comp`: `PersonJobPayPanel({personId})`, `PersonEquityPanel({personId})`, `ChangeJobSheet({personId,open,onClose})`, `PeopleCostCard()`
- `@/features/compliance`: `NextThresholdCard()`, `PersonTrainingPanel({personId})`, `ThresholdPreview({startDate, extra?})`
- `@/features/people`: `PersonChecklistsPanel({personId, onlyMine?})`, `ChecklistsInFlight()`, `OffboardSheet({personId,open,onClose})`
- `@/features/hiring/offers`: `CandidateOffer({applicationId})`, `CandidateBackground({applicationId})`, `OffersTab()`
- `@/features/hiring/interviews`: `CandidateInterviews({applicationId})`, `ScorecardsOwedList({personId})`, `HiringPulse()`, `OpenRolesList()`, `InterviewKitsTab()`
- `@/features/home`: `Inbox({personId?, compact?})` (also used by Me for "My tasks")

## Shell services

- Global header (`src/app/Header.tsx`): search (Ctrl K or /), + New menu (N), Ask <assistant> (H, `AskButton` from
  `@/features/assistant`), backup chip, privacy blur (B),
  Display (look, text size 100-150%, theme for looks with light and dark, reduced motion, single-key shortcuts on/off), shortcut sheet (?).
- Shortcuts: register with `useShortcut(keys, handler, {description, group})` from `src/app/shortcuts.ts`.
  Never add raw keydown listeners for shortcuts. Single keys respect the user's "shortcuts off" setting.
  `enabled: false` turns a key off and takes it off the ? sheet; add `listed: true` for a key that works only
  while focus is in one place (the pipeline board's A, R, S, Enter and arrows), so the sheet still lists it
  after the sheet itself takes focus.
- Backups: `downloadBackupFile`, `backupJSON`, `markExported` and `backupFileName` from `src/store/backup.ts`.
  Every backup (Settings > Data, Settings > Server, the Home inbox) is the same `<company>-backup-<date>.json`,
  and the backup time is stamped without an Undo step; never record it through `mutate`.
- Money and other sensitive numbers: render through `<Money value>` / `<MoneyRange>` / `<Private>` from `@/ui`
  so the privacy blur hides them. Equity share counts and option values also go in `<Private>`.
- Files: `copyText`, `downloadFile`, `toCSV`, `printHTML`, `escapeHTML` from `src/lib/files.ts`.
  Every download or print also offers Copy (some hosts block downloads and pop-ups). Calendar files: `buildICS` from `src/lib/ics.ts`.
- Inbox items are computed by `src/domain/inbox.ts` (owned by features/home); only snoozes/dismissals are stored
  (`db.inboxState`). Statutory items cannot be snoozed past their due date and are the only red ones.
