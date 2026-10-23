# Looks: the visual skin system

First Twenty ships several complete visual styles ("looks"). The user can switch in the Display menu
(header) at any time; the choice is a per-device preference. Every screen must work in every look.

| id | Name | Brief | Light/dark |
|---|---|---|---|
| `sleek` | Sleek (default) | Swiss precision: the International Typographic Style set as a payroll register. White ground and true-black ink (warm charcoal in dark), one grotesk (Archivo) with tabular figures, a thick-and-thin rule over every page head, sections marked by a 2px ink rule and an uppercase micro-label instead of boxes, a hairline down the gutter between main and side columns, square corners (2px on controls), flush-left alignment, big semi-condensed numerals for the headcount (on a ruled tally scale) and the employee numbers, one ultramarine accent for action and place, chosen values in inverse ink, status as a square marker and a word. Replaced the Geist, Vercel-style default on 2026-10-11. | Light and dark |
| `web90s` | 1990s web | A 1997 company intranet built in Netscape Composer: gray beveled chrome, Times New Roman, blue underlined links, bordered tables, a visitor counter, "best viewed at 800x600". Period-true, still easy to use. | Fixed palette |
| `comic` | Comic book | A Silver Age print comic: newsprint, thick black ink outlines, Ben-Day halftone dots, CMYK primaries, caption boxes, speech-bubble notices, hand-lettered headlines. | Fixed palette |
| `trading` | Trading desk | A professional trading terminal for running the company's people like a portfolio: near-black workspace, panels docked as square bordered windows with amber title bars, IBM Plex Mono figures in order-book tables, cyan for links and selection, green and red only for good and bad (always with a word), a ticker tape of real figures, a headcount quote with a sparkline, a quick-links bar in the function-key style (keycaps only for keys that work, such as Search; no F numbers, which the browser owns). Replaced the green-bar ledger look on 2026-10-10. | Fixed palette (dark) |

## Why this exists

The first design read as AI-generated: soft rounded cards with drop shadows everywhere, pastel pill
badges, an icon in a tinted circle on every empty state, a sparkle icon, generic SaaS blue. No look may
fall back on those defaults.

**Banned in every look (AI tells):** gradient blobs or purple-to-blue gradients, glassmorphism/backdrop
blur as decoration, sparkle or magic-wand icons, emoji as decoration, an icon inside a tinted circle as
the default empty-state or stat decoration, every container rounded 12-16px with a soft shadow, pastel
pill badges on everything, Inter or Space Grotesk, centered marketing-style headers inside an app,
evenly spaced identical cards used where a table or list reads better.

## Architecture (contract)

### Selection

- `usePrefs().look`: `'sleek' | 'web90s' | 'comic' | 'trading'`, default `'sleek'` (`src/store/prefs.ts`).
- Renamed looks: a saved id in `RENAMED_LOOKS` (`src/themes/ids.ts`) loads as its new id (`savedLook()`), so a
  device that had the old green-bar `'ledger'` opens in `'trading'`. `index.html`'s pre-paint script keeps the same
  map so the first paint matches; `src/themes/looks.test.ts` checks both.
- `src/app/App.tsx` sets `<html data-look="...">`. Light/dark (`data-theme` and `prefers-color-scheme`)
  only applies to looks with `supportsDark: true` (sleek). For fixed-palette looks the Theme control in the
  Display menu is disabled with the note "This look has its own colors".
- `src/themes/registry.ts` exports `LOOKS: Record<LookId, LookInfo>` with `id, name, blurb, supportsDark`,
  and optional decor components (below). The Display menu shows one preview card per look; each card
  renders a small real UI sample inside a wrapper with its own `data-look` attribute, so the preview is the
  actual skin.

### Files

- `src/styles.css`: Tailwind setup, container breakpoints, resets, the `@theme inline` mapping and the
  imports of every look stylesheet. No look-specific values here.
- `src/themes/sleek.css`, `web90s.css`, `comic.css`, `trading.css`: one file per look, **every selector
  scoped under `[data-look="<id>"]`** (not `:root`, so preview cards can carry a look). `sleek.css` also
  defines its tokens on `:where(:root)` (zero specificity) as the default when no attribute is set, and its dark values under
  `@media (prefers-color-scheme: dark) { [data-look="sleek"]:not([data-theme="light"]) { ... } }` and
  `[data-look="sleek"][data-theme="dark"]`.
- `src/themes/<id>/decor.tsx` (optional): look-specific React decorations registered in the registry.
- `src/themes/fonts.ts`: font imports (Latin subsets only, to keep the one-file build small).

### Tokens every look must define (complete set; a look that skips one inherits the wrong value)

Colors: `--paper --surface --surface-2 --surface-3 --ink --ink-2 --ink-3 --line --line-strong
--control-border --accent --accent-hover --accent-ink --accent-soft --accent-soft-ink --good --good-soft
--warn --warn-soft --bad --bad-soft --focus --scrim --cat-1 ... --cat-6`, and `color-scheme`.

Type: `--font-display --font-body --font-mono --font-size-base --line-height-base --heading-weight
--heading-transform --heading-tracking --eyebrow-transform --eyebrow-tracking`.

Shape and depth: `--r-sm --r-md --r-lg --r-xl --r-2xl --r-pill --border-w --border-w-strong --shadow-sm
--shadow --shadow-lg --focus-width --focus-style --focus-offset`.

Tailwind utilities read these through `@theme inline` (`rounded-lg` -> `--r-lg`, `shadow-card` ->
`--shadow`, `font-display` -> `--font-display`, `bg-surface` -> `--surface`, ...), and `.rounded-full`
reads `--r-pill`. So the 300+ existing `rounded-*`, `shadow-*`, `border`, `bg-*`, `text-*` utilities in
the screens follow the look without screen changes.

### Hook classes (stable styling API)

Kit components and the shell carry stable `ft-*` class names so a look can restyle them in depth. Looks
target these (and the semantic utilities above); they never target hashed or incidental classes.

| Component | Hooks |
|---|---|
| Button | `ft-btn` + `ft-btn--primary / --secondary / --ghost / --danger / --quiet` + `ft-btn--sm / --md / --lg` |
| IconButton | `ft-iconbtn` (+ variant modifiers as above) |
| TextLink, in-app links | `ft-link` |
| Badge | `ft-badge` + `ft-badge--neutral / --accent / --good / --warn / --bad / --outline` |
| Dot, Kbd | `ft-dot`, `ft-kbd` |
| Avatar, AvatarStack | `ft-avatar`, `ft-avatarstack` |
| PageHeader | `ft-pagehead`, `ft-pagehead__eyebrow`, `ft-pagehead__title`, `ft-pagehead__subtitle`, `ft-pagehead__actions`, `ft-pagehead__back` |
| Panel | `ft-panel`, `ft-panel__head`, `ft-panel__title`, `ft-panel__subtitle`, `ft-panel__actions`, `ft-panel__body` |
| DescriptionList | `ft-dl`, `ft-dl__term`, `ft-dl__value` |
| EmptyState | `ft-empty`, `ft-empty__icon`, `ft-empty__title`, `ft-empty__body` |
| Stat, Meter | `ft-stat`, `ft-stat__label`, `ft-stat__value`, `ft-meter`, `ft-meter__bar` |
| Callout | `ft-callout` + `ft-callout--accent / --good / --warn / --bad / --neutral` |
| SectionLabel | `ft-sectionlabel` |
| Field | `ft-field`, `ft-field__label`, `ft-field__hint`, `ft-field__error` |
| Inputs | `ft-input` (text, number, money, date, datetime, search), `ft-select`, `ft-textarea`, `ft-checkbox`, `ft-switch` (+ `ft-switch--on`), `ft-segmented`, `ft-segmented__item` (+ `ft-segmented__item--on`) |
| Chips | `ft-chips`, `ft-chip` (+ `ft-chip--on`), `ft-cite` (citation chip) |
| Tabs | `ft-tabs`, `ft-tab` (+ `ft-tab--active`) |
| DataTable | `ft-table-wrap`, `ft-table`, `ft-table__head`, `ft-table__row` |
| Sheet, Modal, Menu | `ft-sheet`, `ft-sheet__head`, `ft-sheet__body`, `ft-sheet__foot`, `ft-modal`, `ft-modal__head`, `ft-modal__body`, `ft-modal__foot`, `ft-menu`, `ft-menuitem`, `ft-scrim` |
| Toast | `ft-toaster`, `ft-toast` (+ `ft-toast--good / --neutral / --bad`) |
| Tally, charts | `ft-tally`, `ft-chart` |
| Ask sheet (the assistant) | `ft-askbtn` (the header button, also `ft-btn ft-btn--ghost`), `ft-assistant`, `ft-assistant__intro`, `ft-assistant__log`, `ft-assistant__turn` (+ `ft-assistant__turn--user / --assistant`), `ft-assistant__who`, `ft-assistant__status`, `ft-assistant__composer`, `ft-assistant__notice`, `ft-assistant__rename`, `ft-assistant__host` (the site after an outside link, or after an address shown as text), `ft-assistant__cutoff` (the note under an answer that was cut off), `ft-assistant__table`, `ft-markdown` (an answer's text); the suggestions reuse `ft-chips` / `ft-chip`. The composer's Stop button carries the `stop` icon, outside the destructive-verb icons (x, trash, log-out) that the looks draw as red words, so it keeps its framed secondary style |
| Shell | `ft-app`, `ft-rail`, `ft-brand`, `ft-headcount`, `ft-nav`, `ft-navitem` (+ `ft-navitem--active`), `ft-viewas`, `ft-topbar` (phone), `ft-main`, `ft-header`, `ft-search`, `ft-banner` (+ `ft-banner--sample / --preview / --storage / --sync`), `ft-syncchip` (+ `ft-syncchip--synced / --syncing / --offline / --signed-out / --attention / --paused / --compact`), `ft-palette` |

### Decor slots (optional, per look)

`LookInfo.decor` may provide React components that the shell renders when that look is active:

- `Banner`: a thin strip at the top of the main column (for example a scrolling notice, a report header).
- `Footer`: at the bottom of the main column (for example "Best viewed at 800x600" and a visitor counter).
- `Headcount({ count, incoming })`: replaces the tally meter in the rail (for example an odometer counter).

Decor must stay out of the way: never cover content, never steal focus, respect reduced motion, and carry
no information that is not also shown normally.

## Engine notes for look authors

What the engine does today (built 2026-10-10), so a look can be written in its own files only:
`src/themes/<id>.css` and, if wanted, `src/themes/<id>/decor.tsx`. Do not edit shared code for a look.

- **Cascade.** Look files are imported unlayered (from `src/styles.css`), so a rule such as
  `[data-look="comic"] .ft-panel { border-radius: 0 }` beats any Tailwind utility on that element without
  `!important`. Only `!`-suffixed utilities (`rounded-xl!`) beat a look; there are a few in screens. Restyle
  appearance (color, border, radius, shadow, font, background, text-transform); avoid layout properties
  (width, display, position, margin, padding, gap) on hooks unless you checked every screen at 375px and 150%.
- **Token mapping.** `rounded` (bare) -> `--r-sm`; `rounded-sm/md/lg/xl/2xl` -> `--r-*`; `rounded-full` ->
  `--r-pill`; bare `border`, `border-b`, `divide-y` widths -> `--border-w`; `shadow` (bare) and `shadow-sm` ->
  `--shadow-sm`; `shadow-card` -> `--shadow`; `shadow-pop` -> `--shadow-lg`. `--border-w-strong` is not mapped
  to a utility: use it in your own hook rules (panel outlines, buttons). Focus ring: `outline: --focus-width
  --focus-style --focus` with `--focus-offset`; elements without their own rounding get `--r-md` while focused.
- **Type tokens.** `body` reads `--font-body`, `--font-size-base`, `--line-height-base`. `h1`-`h4` read
  `--font-display`, `--heading-weight`, `--heading-transform`, `--heading-tracking`; a heading with `font-bold`
  (the kit's and most screens') also takes `--heading-weight`, so a one-weight display face is never
  faux-bolded. `.eyebrow` reads `--eyebrow-transform` and `--eyebrow-tracking`. Kit text sizes are px utilities
  (`text-[14.5px]`), so `--font-size-base` only moves inherited text.
- **Fonts.** `src/themes/fonts.css` loads Latin woff2 only: "Archivo Variable" (sleek: weight 100-900 and width
  62-125% in one file, shipped in `src/themes/sleek/fonts/` with its OFL license), "Geist Variable" 100-900
  (trading's reading text; the Geist Mono face went with the old sleek), "Bangers" 400, "Comic Neue" 400 and 700, "IBM Plex Mono" 400 and 600. The 1990s
  look uses system fonts (Times New Roman, Arial, Courier New); sleek's key caps use the system mono (Cascadia
  Mono, Consolas). Need another weight? Add a face there; never import a package index.
- **Light and dark.** Only sleek has dark tokens. A fixed-palette file must never mention `data-theme` or
  `prefers-color-scheme`; the App drops the `data-theme` it set when a fixed look is active, and the Theme
  control is disabled with "This look has its own colors".
- **Page texture.** The page background is `--paper` on `html` and `body`. Texture (halftone dots, ruled
  lines) goes on `[data-look="x"] body` and on `.ft-lookpreview[data-look="x"]` (the Display menu
  card) so the card shows it too. Keep text contrast against the darkest part of any texture.
- **Preview card.** `.ft-lookpreview[data-look="x"]` renders the real kit at half scale: a `Panel` titled
  "Open roles" with a good `Badge`, a primary and a secondary `Button` (size sm) and a dense two-row
  `DataTable`. The card frame (`.ft-lookcard`, `--on`, `__name`, `__blurb`, `__check`) is drawn in the active
  look, not the previewed one.
- **Decor.** Export components from `src/themes/<id>/decor.tsx` (`export const decor: LookDecor = { Footer }`),
  already registered in `src/themes/registry.ts`. The shell wraps Banner and Footer in `.ft-decor.ft-decor--banner`
  / `--footer` inside `.ft-main__inner` (above the header, below the page); Headcount replaces only the tally
  inside `.ft-headcount__meter` (the number and label stay). Mark decorative markup `aria-hidden`.
- **Privacy blur.** Blurred values carry `.ft-private.ft-private--on` (text) or `.ft-input--blurred` (fields).
  You may restyle them (the trading desk draws a hatched mask) but they must still hide the value.
- **Name and blurb** of each look live in `src/themes/registry.ts` (shown on the card and as "Look: <name>"
  in Ctrl K). Keyframes in a look file are named `ft-<id>-...`.
- **Checks.** `npx vitest run src/themes` fails when a token is missing, a rule is not scoped to its own
  `[data-look]`, a fixed look mentions dark mode, or keyframes are not prefixed.

**Hooks beyond the table above** (same naming pattern; use them freely):

| Component | Extra hooks |
|---|---|
| Button, IconButton | `ft-iconbtn--sm / --md / --lg`, `ft-iconbtn--on` (pressed toggles, e.g. privacy blur) |
| Badge, Dot, Avatar | `ft-dot--<tone>`, `ft-avatar--more` (the +N in a stack) |
| PageHeader, Panel | `ft-pagehead__main`, `ft-panel__icon`, `ft-panel__body--padded` (a body with the kit's own padding, so a look can change it without touching `padded={false}` bodies) |
| Stat, Meter | `ft-stat__sub`, `ft-meter--accent / --good / --warn / --bad` |
| Callout | `ft-callout__icon`, `ft-callout__content`, `ft-callout__title`, `ft-callout__body`, `ft-callout__action` |
| Field and inputs | `ft-field__required`, `ft-select-wrap`, `ft-select__chevron`, `ft-checkbox-row` (`ft-checkbox` is the box itself), `ft-switch-row`, `ft-switch__track`, `ft-switch__thumb`, `ft-segmented--sm / --md`, `ft-searchbox`, `ft-searchbox__icon`, `ft-input--blurred` |
| Chips | `ft-chips--multi`, `ft-chip--multi`, `ft-datechips`, `ft-cite-link` (the 40px link around `ft-cite`) |
| Tabs | `ft-tabs-wrap` (the scroller), `ft-tab__count`, `ft-tab__indicator` (the active underline) |
| DataTable | `ft-table--dense`, `ft-table__headrow`, `ft-table__th`, `ft-table__sort` (+ `--active`), `ft-table__cell`, `ft-table__row--link`, `ft-table__rowlink` (the first cell's link, or a `button` when the row opens a sheet: `onRowClick`) |
| Sheet, Modal, Menu | `ft-sheet__title`, `ft-sheet__subtitle`, `ft-sheet__close`, `ft-modal__title`, `ft-modal__close`, `ft-menu__divider`, `ft-menuitem--danger` |
| Toast | `ft-toast__icon`, `ft-toast__text`, `ft-toast__action`, `ft-toast__dismiss`, `ft-toast__link` (a toast's link to where the change landed, also `ft-link`: a look that colors `ft-link` must recolor it inside its toast too); each toast carries `data-toast-id`; `ft-toaster` carries `data-edge="bottom"` or `"top"`. While a sheet or dialog is open the stack keeps off it where the window has room (below or above a dialog, or beside a sheet, with an inline `right` that narrows the strip); with no room (a phone) it sits above the dialog's footer, and it moves to the top of the window when at the bottom it would cover the focused control. A newer Undo toast replaces the older Undo toasts |
| Charts | `ft-chart--step / --bars / --segments / --spark`, `ft-chart__track`, `ft-chart__bar`, `ft-chart__legend`, `ft-chart__tip`, `ft-chart__data`; on a step chart's end marker `ft-chart__end` (group), `ft-chart__enddot`, `ft-chart__endlabel` (the value) and `ft-chart__endtag`, a box behind the value that stays invisible (`fill="none"`) unless a look fills it, with the series color in `--ft-series`; `ft-chart__reflabel` (a threshold line's number) and `ft-chart__today` (the Today label) |
| Money | `ft-private`, `ft-private--on` |
| Shell | `ft-brand__mark`, `ft-brand__name`, `ft-brand__meta`, `ft-headcount--compact`, `ft-headcount__value / __label / __incoming / __meter`, `ft-navitem__icon`, `ft-viewas__title`, `ft-viewas__roles` (also `ft-segmented`), `ft-rail--sheet` (the phone menu panel, also `ft-rail`), `ft-rail__note`, `ft-topbar__count`, `ft-main__inner`, `ft-header__actions`, `ft-newmenu` (also `ft-btn ft-btn--primary`), `ft-undo` (also `ft-btn ft-btn--ghost`), `ft-backup` (+ `--stale`), `ft-banner__action`, `ft-banner__icon / __text / __actions / __dismiss`, `ft-banner--sync-storage / -replaced / -restored / -signed-out / -offline / -rejected / -paused / -refreshed`, `ft-syncchip__icon / __label / __count`, `ft-decor` (+ `--banner / --footer`), `ft-palette__head / __input / __list / __group / __item (+ --active) / __icon` |
| Display menu | `ft-lookpicker`, `ft-lookcard` (+ `--on`), `ft-lookcard__name / __blurb / __check`, `ft-lookpreview` |

**Screen hooks** (added 2026-10-10 so looks stop matching utility classes; prefer these over the interim
utility selectors still in the look files, and replace those when you next touch them):

| Where | Hooks |
|---|---|
| Kit extras | `ft-btn__icon` (+ `--right`) on Button and button-like link icons; every `Icon` svg carries `data-icon="<name>"`; `ft-avatar--muted`, and each avatar sets `--ft-avatar-hue: var(--cat-N)` inline; the DateChips "Pick" chip is `ft-chip--pick` (single choice, no longer `--multi`) |
| Button-like links | Hand-built links that look like buttons carry `ft-btn ft-btn--<variant> ft-btn--<size>` (Inbox navigate action, Me `ButtonLink`, Open your first job, Start a job from this kit, hire, close-out, schedule, reject and contractor links, background vendor link). SOC 2 fix actions add `ft-btn--urgent` (secondary in the bad tone) |
| Counts and tags | `ft-count` (a pill or badge that holds only a number: calendar panel counts, board and list column counts, Inbox group counts, kit step numbers); `ft-tag` (+ `--source` for SourceChip, `--removable` for candidate tags) |
| Person page header | `ft-personhead` on the header, with `ft-pagehead__back`, `ft-pagehead__title` and `ft-pagehead__actions` inside; `ft-empno` on every employee number (`#5`) |
| Org chart | `ft-orgnode` (+ `--person / --planned / --contractor / --active`) on the row box, `ft-orgnode__elbow` on the connector; the treeitem sets `--ft-level`, `--ft-indent` and `--ft-indent-step` (its indent minus its parent's) |
| First twenty wall | `ft-seat` (+ `--current / --alumni / --incoming / --planned / --open`), `ft-seat__num` (the `#N`), `ft-seat__name`, `ft-seat__date`, `ft-seat__pos` (seat number on planned and open seats) |
| Pipeline | `ft-board` (board scroller), `ft-board__col`, `ft-boardcard` (+ `--selected`), `ft-boardcard__next` (+ `--overdue`); List view: `ft-boardlist` (the region), `ft-boardlist__rows` (one stage's cards), `ft-boardcard--row` (a card shown as a list row) |
| Candidate | `ft-stepper`, `ft-stepper__step` (+ `--current / --done`); sections inside the candidate panel (SubPanel: Interviews and scorecards, Offer, Background check, Contingencies; and the Next step box): `ft-subpanel`, `ft-subpanel__head`, `ft-subpanel__icon`, `ft-subpanel__title`, `ft-subpanel__subtitle`, `ft-subpanel__actions` |
| Inbox | `ft-inboxrow` (+ `--bad` on overdue legal rows, which draw the red marker) |
| Lists and marks | `ft-navlist`, `ft-navlist__item` (+ `--on`) (interview kits); `ft-checkmark` (+ `--done / --open / --na`) (checklist task marks, background check step numbers); `ft-why` (a checklist task's "Why this matters" toggle) |
| Tables and tiles | `ft-matrix` (debrief and training cross tables); `ft-datetile` (+ `--bad / --warn`), `ft-datetile__weekday`, `ft-datetile__day` (compliance calendar); the calendar's Course and Source pills carry `ft-cite-link` / `ft-cite`; SOC 2 gap rows `ft-row--gap` |
| Chart axes | `ft-chart__xtick` on every time-axis label of the step chart and the vesting chart, with `ft-chart__xtick--odd` on every other step-chart label (so a narrow look can thin the axis); the vesting chart's Today label also carries `ft-chart__today` |
| Charts | Option pool bar: `ft-chart ft-chart--segments ft-poolbar` on the wrapper, `ft-chart__track`, `ft-chart__bar ft-poolbar__seg` with `data-seg="granted / awaiting / reserved / available"` (the legend swatches carry `ft-poolbar__seg` and `data-seg` too), `ft-poolbar__legend`. Vesting chart: `ft-chart ft-chart--step` on its wrapper and `ft-chart__tip` |
| Small figures | `ft-ministat`, `ft-ministat__label`, `ft-ministat__value` (comp mini figures, pool legend, time-off summary facts, Me balance tiles which add `ft-ministat--tile`); `ft-scenario` (+ `--on`) (Cost scenario cards); `ft-cliff` (Upcoming cliffs cards) |
| Privacy | `PrivateBlock` (band meter) carries `ft-private ft-private--block` (+ `ft-private--on` while blurred); the Settings blur wrapper is `ft-private-wrap` (+ `--on`) |
| Page columns | The main/side grids of Home, the candidate page and the person overview carry `ft-split` (+ `ft-split--home / --candidate / --person`) and their side column `ft-split__side` (added 2026-10-11 so a look can rule the gutter; Home's side wrapper is `display: contents` below 900px) |

A look that matches hand-built markup with `:not([class*="ft-"])` must list the hook above for the same
element, or the element drops out of that rule.

### Sleek (default) conventions

What `src/themes/sleek.css` does beyond recoloring, so a screen change can be checked against it:

- **Rules, in three weights.** A page head (`ft-pagehead`, `ft-personhead`) opens under a thick-and-thin rule (3px
  ink, 2px paper, 1px ink). `ft-panel`, `ft-stat`, board columns, the rail's headcount and Viewing as are open on
  the paper under a 2px `--sleek-rule` (ink); a panel with no title is a sub-section and takes 1px. Rows, ledgers
  and sub-sections are divided by 1px `--line`. Sub-panels (`ft-subpanel`) are a 1px ink rule and a 20px title at
  full width (every heading is set at 100% width; the condensed width is for numerals only); sections inside a sheet or dialog (`section > h3`, Offer: Base pay, Equity, Exempt check)
  are a 1px ink rule over an uppercase micro label. A tab strip stands on a full-width 1px ink rule; when a Panel
  follows straight on, the two rules collapse into the panel's own. On Home, the candidate page and the person
  overview a 1px rule runs down the middle of the 40px gutter between the main and side columns
  (`ft-split__side::before`). Menus and the palette open like a section: a 1px ink frame with a 3px ink top.
  A section that holds several labeled groups (Requests: Waiting for you, then Waiting on a manager) puts each
  later group label under the same 1px rule as its rows.
- **Boxes become sections.** Hand-built bordered cards and gray wells (`rounded-xl border border-line`,
  `rounded-xl bg-surface-2`, list items drawn as wells such as Settings, Hiring's default pipeline) lose their frame
  and fill and sit flush under a 1px rule; a list of wells becomes a ruled list (a leading figure gets a 32px
  column). Document previews (scroll boxes) keep a square 1px frame. The Levels and bands matrix is one ruled table:
  1px rules between cells, a band is a whole-cell button with no frame, an empty cell is an underlined "Add band"
  that fills the cell. Elements with an `ft-*` hook are styled only by their own rules.
- **Frames mean "you can click this".** Buttons, chips, citations (`ft-cite`), segmented cells, fields and
  removable tags are framed; nothing static is. A status is a square marker and a colored word; a colorless state
  (neutral and outline badges: Draft, Declined, Legal deadline, Alumni, Local only) is a hollow square marker and
  an ink-2 word; a count badge (`ft-count`) or a badge inside a button is a plain figure or word. Where a candidate
  came from (`ft-tag--source`) is plain words in uppercase micro type. A status in a table cell keeps its words
  together: one line up to 10rem ("On file", "Strong yes"), two lines past that, never "On / file"; a register that
  no longer fits scrolls with its hard edge instead of squeezing.
- **Case.** Uppercase with tracking is kept for section labels, table column heads, the page kicker, sheet section
  labels and source kickers. Ledger terms, field labels, figure labels, section-head links and the debrief matrix's
  interviewer heads are sentence case.
- **One accent, for action and place.** The primary button, the 4px bar that marks where you are (active nav
  item, active tab, the current stage, the current step of a sheet flow, the palette's current row, the current
  interview kit, the current candidate in Sweep's track, the selected board card) and the focus ring. Place is always a bar plus bold words, never a fill: the current stage is a 4px
  accent bar over its bold name on the paper, so it never passes for the primary button. A chosen value (segment,
  single chip, date pick, a pressed choice button with `aria-pressed`, a switch that is on, the chosen look card and
  cost scenario, checkboxes) is inverse ink (`--sleek-pick`). A multi chip that is on gets a 1px ink frame and an
  accent check; off is the gray frame with no check (so a row of filters that are all on by default stays quieter
  than the page's rules). Links are ink with a persistent underline (never color alone); a link the screens tint
  with `hover:text-accent` stays ink when pointed at and firms a 2px underline instead. `--accent` is re-scoped to ink
  inside `.ft-chart`, the compliance ruler, the band meters (`ft-private--block`) and plain data bars, so data is
  never blue. The light theme has no blue wash on the selected card, the palette row or the calendar.
- **Buttons in four steps.** Primary is the accent fill; secondary a 1px ink frame at 500 weight; ghost (tertiary
  verbs such as Move to, Cancel) a 1px `--line-strong` frame visible at rest; a link is underlined words. Quiet
  verbs are underlined words with a 40px target: Reject on a board card, Duplicate beside Edit. Destructive verbs
  that are not a dialog's own confirm (a secondary or ghost button carrying the `trash`, `log-out` or `x` icon and
  no key shortcut: Remove, Reject, Offboard) are red underlined words that take a red frame when pointed at and
  fill red when pressed. Icon-only ghost buttons stay frameless. Labeled buttons lose their decorative leading icon
  (chevrons, trailing arrows, the disclosure chevron of a summary and callout status icons stay).
- **Targets.** Every link that stands alone (a name in a list, a table or a ledger, a job title, the job head's plan
  link, a person's manager, "Open the card") is a 40px target: a transparent `::after` 40px tall centered on the
  words, so nothing moves. A table's row link reaches 44px and is a block (an inline link around the name and
  title blocks drew no focus ring); a row head's link that wraps is one box (`inline-block`). A phone number on a line
  of its own (`p > a[href^="tel:"]:only-child`, an emergency contact) takes the 40px target too. Links inside a
  sentence keep the words' own box (the WCAG inline exception). The meta words under an Inbox title, and the job
  and company line under a list row's name, let clicks through to the 40px
  title above. Segmented cells are 41px so a strip that wraps still gives each cell 40px; sort heads are at least
  40px wide. Key caps (`ft-kbd`) are keys, not buttons: 22px, a 1px gray frame with a 2px foot, ink-2 letters, no
  hover.
- **States.** Hover tints with `--sleek-hover` (ink 4.5%) and gives framed controls an ink border; a nav item
  previews its place mark (a 4px gray bar); pressed (`:active`) inverts frames, darkens fills and drops the control
  1px. Focus is a square 2px ring 2px off the box (`border-radius: 0` while `:focus-visible`): accent on the paper,
  ink on anything filled with the accent or red (primary, danger, New) and on board cards, paper inside the inverse
  toast; the Inbox title's ring hugs its words so it stays inside the column. Disabled is a dashed border with
  `--ink-3` words and no fade (switches too); a field with `aria-invalid` gets a 2px red frame. A switch that is off
  is an empty outlined track with a gray knob on the left; on is the inverse-ink track with a paper knob.
- **Overlays.** No shadows anywhere. Sheets, dialogs and menus are framed in ink; the toast is inverse ink (paper
  words, a paper-underlined link to the change, a paper-framed Undo, inverted key caps, a 40px close).
- **Avatars** are square monogram tiles, dropped wherever words follow them (the name or the `#number` already
  says who it is); avatar stacks stay. The person page leads with the employee number at title size, and the
  First twenty wall is a grid of seats, each a 2px rule over a 30px `#n` (planned seats show their number in
  ink-3 under a dashed rule).
- **Layout touches** (checked at 375px and 150% text):
  - Inbox: the row is a two-column grid when its list is at least 560px wide (title and meta left, actions right,
    about 60px a row). The title button is a 40px box (9px of padding taken back by negative margins; the meta words
    under it let clicks through) sitting exactly on the column, and the overdue red bar hangs 8px into the gutter,
    so every row shares one left edge with the section label.
  - Board: lanes show in whole numbers (as many 200px lanes as the board holds share its width exactly;
    `--sleek-lanes` is set per board width), scrolling snaps lane by lane, and while lanes run past the edge two
    real controls sit over them: "Earlier stages" flush left and "More stages" flush right, 40px ghost buttons in
    uppercase micro type. They are CSS scroll buttons (`::scroll-button(left / right)` on `.ft-board`, anchored to
    it with `anchor-name: --sleek-board`): focusable, Enter, Space and a click scroll about a board's width, and
    each turns dashed (disabled) at its end. Browsers without scroll buttons and scroll-state queries show neither
    the buttons nor the 48px row reserved for them. Cards
    that are not selected put Advance with a chevron (Move to) as one framed split button and Reject as underlined
    words; the selected card is framed in 2px of ink with the 4px accent bar on its left and keeps the full-width
    accent Advance with its A and R key caps.
  - The stage stepper and a sheet's step list (Start fresh, `ol[aria-label="Progress"]`) are progress tracks: a 2px
    gray bar upcoming, a 4px ink bar and a check done, the 4px accent bar and bold current, Hired dashed. A stage you
    can move to is underlined words (2px when pointed at), as every unframed control is; the current stage and Hired
    are not buttons and carry no line. The candidate page also has a labeled "Advance to <stage>" button. A stepper
    that still wraps on a wide page keeps a 10px row gap, so a bar never reads as the underline of the row above;
    under 30rem of app column it is a vertical track, one 40px row per stage with its bar on the left (like the
    rail's place mark).
  - Sweep's track has one segment per candidate (read from `aria-valuemax` with typed `attr()`), in the stepper's
    grammar: done solid ink, current the accent, the ones to come a 2px gray bar at the segment's foot (filled
    always means done or here). Other meters tick every tenth.
  - Segmented strips are as wide as their cells (never stretched into an empty box); each cell carries its own 1px
    ink frame, overlapped by 1px, so a strip that wraps reads as a block of cells.
  - Ledgers (`ft-dl`): a 132px term column; a two- or three-up ledger only goes side by side where each column gets
    22rem (so at 1280px the person overview and the candidate's offer are one column and values never split).
  - Tables: 8px each side of a column; column heads wrap to two lines and sit on the bottom rule. Inside a section
    the first column runs flush, so the scroller reaches 4px further left and is padded back by as much: a focus ring
    on a row link or sort head there keeps its left side. A scroller that
    still runs on (tables, matrices, the board, a phone's tab strips) ends on a hard 1px ink edge on the side that
    continues (a scroll-driven animation on the scroller itself); tab strips drop the kit's soft fade for it and
    keep 16px of scroll padding beside the active tab.
  - Matrices (`ft-matrix`: the debrief, training): 8px each side of a column, each interviewer or course column at
    least 128px with the name on one line and the interview under it in ink-2, ratings never break, no gray head
    band. The frozen first column is 132px (112px under 24rem of app column) with a 1px `--line-strong` rule on its
    right, so the scroller's ink edge is drawn on the right only. A matrix with more columns than fit scrolls.
  - Time off calendar: no tinted cells; weekend and out-of-month dates in ink-3, a holiday as its bold name, who is
    out as ink words with a 3px bar in its status color (dashed amber pending), today in inverse ink. The chosen day's
    accent frame is an inset 2px shadow, so keyboard focus adds the usual ring 2px outside it (the cell is lifted so the
    next row never covers the ring).
  - Compliance milestones: a rule that is years away is not faded (its "Not yet" marker says so; the kit's 80%
    fade took its ink-3 line under 4.5:1).
  - Compliance calendar dates are unframed two-line type (a micro-caps weekday over the bold date).
  - Band meters put the min and max labels under the band's own edges. The offer letter preview is set in Archivo.
  - People cost is a ruled three-column table; the comp table's band caption sits beside its meter; Cost and runway
    scenarios are ruled columns with right-aligned figures; the directory's two chip groups share one row.
  - Small values (`ft-ministat__value`) are words by default (16px, 600, full width: job titles, managers, "Exempt
    (computer professional)", holiday names, "2 requests"). A row that opens on an amount (people cost, a person's
    equity), the option pool counts and the Me balance tiles take the 20px semi-condensed figure style.
  - Home, This week: Who's out and the agenda share one 112px date column in bold ink-2, entries 16px after it, with
    one 1px rule between them; under the sm breakpoint both set the date over its entries.
  - Panel heads: a label with no subtitle keeps its action on its own line even in a narrow side column (Runway's
    Edit assumptions, Me's See vesting); actions that do wrap sit flush left under the label.
  - Hiring metrics: a drill-down figure's words sit flush with its label (its 8px of padding hangs into the gutter;
    flush right at the end of a funnel row or a figure column). The funnel bars are square.
  - Checklist task marks are 18px squares: a solid ink box with a paper check when done, an empty 1px ink box when
    open. Two-sided rows whose name is a 40px link (Cost and runway, Contractors) sit on one baseline.
  - Lists inside an unpadded section (Time off, Requests) run flush with its label (their groups are direct
    children of the section: a wrapper `div` drops out of the flush rule), and the palette's "No matches"
    sits flush left in ink-2 like every other empty state.
  - Phone (the top bar showing): the header row under the top bar sits 8px under it and 12px above the page.
  - Phone at 150% text (app column under 20rem): the top bar drops the brand mark and the "Seed, San Jose" line so
    the company name fits; under 30rem the Tonight line hangs its warning icon beside the first words.
- **Scrollbars.** `html` reserves its gutter (`scrollbar-gutter: stable`), so pages that do not scroll never shift.
  The page bar has a square 12px-wide thumb, inner scrollers an 8px square thumb in `--line-strong` (no arrow
  buttons); a tab strip that runs past a phone's edge scrolls without a bar. While a sheet, a dialog or the palette
  is open the page behind holds still (one scrollbar) and keeps its gutter, so nothing moves sideways when Ctrl K,
  Display or ? opens and closes; beside a dialog or the palette the empty gutter takes the scrimmed paper tone
  (`--sleek-scrim-mix`, the scrim's alpha), so the dimmed window has no bright strip. Only the gutter: body is one
  window tall, so a fixed paper layer (`body::before`, under everything) covers the canvas below the first screen of
  a scrolled page, and the scrim lands on one tone everywhere (no darker band past the fold).
- **The rail.** The headcount is a 48px semi-condensed figure over the tally, redrawn by `sleek/decor.tsx` as an
  instrument scale: groups of five strokes on a 1px baseline with a tick per seat and long ticks numbered 5, 10,
  15, 20 (12px); the ticks at 5, 15 and 20 (where the law changes) reach through the rule and their numbers are
  bold.
- **Header.** The search is a ruled field (words on a 1px ink baseline); the backup status is a square marker and
  an underlined word, no chip.
- **Type scale.** 12 (labels, column heads, key caps, chart axes; the floor for any figure), 13 (meta, ledger terms,
  rail meta; the floor for any sentence or secondary line), 14 (body), 15 (Inbox titles, nav), 16 (small values set
  as words), 20 (sheet titles, sub-panel titles, small figures), 24/30 (page titles, phone/wider), 48 (the
  headcount). Utility sizes under the
  floor (`text-[11px]` and the like) are raised in this look, and gray (`text-ink-3`) words are never bold. Weights
  go through tokens (`--sleek-w-regular / -medium / -semi / -bold`: 400/500/600/700, thinned to 370/460/560/660 in
  dark so light text does not bloom). Figures are tabular lining numerals everywhere (set on `body`); big figures
  use Archivo's width axis at 84% (`--sleek-figure-stretch`).
- **Dark** is designed, not inverted: warm charcoal paper `#141413`, `#3a3a37` row rules, near-white section
  rules, a mid ultramarine fill `#2766d2` (hue 218) with white words for the primary action, and a light tint of
  the same blue `#86b3ff` for the focus ring and checks.

## Rules every look keeps

- Accessibility does not change between looks: targets stay 40-48px, every focus state is clearly visible
  (at least 3:1 against what is around it), text contrast at least 4.5:1 for body and secondary text
  (`--ink`, `--ink-2`, `--ink-3` on `--paper`, `--surface`, `--surface-2`), status is always a word plus a
  color, motion respects reduced motion (and nothing flashes more than 3 times a second), 150% text and
  375px width work with no horizontal page scroll.
- Charts keep working: categorical `--cat-*` colors must pass the dataviz validator for the look's surface
  (`node <dataviz skill>/scripts/validate_palette.js "<hexes>" --mode light --surface "<hex>"`).
- Copy stays the same across looks (sentence case, no em dashes). A look changes how things look, not what
  they say. Decor may add period flavor text ("Best viewed at 800x600") but never changes labels.
- Privacy blur (`<Private>`) must still hide values in every look.
