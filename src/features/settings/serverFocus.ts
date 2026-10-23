// Focus helpers for Settings, Server and the Data tab's links into it: after a step changes what the
// tab shows, focus moves to where the next step starts, never to <body>.

/**
 * Moves focus to a panel's title once it is on screen (after a step changes what the tab shows), so
 * keyboard and screen reader users start at the new step. The title is not a control: no focus ring.
 * It waits up to `waitMs` for the panel (a server check may run first), and gives up if the person
 * moved focus somewhere else meanwhile.
 */
export function focusPanelTitle(panelId: string, waitMs = 700): void {
  focusWhenReady(() => {
    const el = document.querySelector<HTMLElement>(`#${panelId} .ft-panel__title`)
    if (el) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
      el.setAttribute('data-focus-target', '')
    }
    return el
  }, waitMs)
}

/**
 * Focuses what `find` returns as soon as it exists (checked every frame for up to `waitMs`). Skipped
 * when focus moved to another control in the meantime: only a focus that is gone (on the page, its
 * title, or an element that was removed) or still where it was is taken over.
 */
export function focusWhenReady(find: () => HTMLElement | null, waitMs = 700): void {
  if (typeof window === 'undefined') return
  const from = document.activeElement
  const start = Date.now()
  const attempt = () => {
    const el = find()
    if (el) {
      const now = document.activeElement
      const free = !now || now === document.body || now === from || !from?.isConnected || now.matches('#main h1, .ft-panel__title')
      if (free) el.focus()
      return
    }
    if (Date.now() - start < waitMs) requestAnimationFrame(attempt)
  }
  requestAnimationFrame(attempt)
}

/**
 * The sign-in form's next field: the password when the email is already filled in, else the email.
 * Used when someone arrives at Settings, Server to sign in again (from the banner or the header chip).
 */
export function focusSignInField(panelId = 'server-signin'): void {
  focusWhenReady(() => {
    const email = document.querySelector<HTMLInputElement>(`#${panelId} input[name="username"]`)
    if (!email) return null
    return email.value.trim() ? document.querySelector<HTMLInputElement>(`#${panelId} input[name="password"]`) : email
  })
}

/**
 * The demo sign-up form's first field (the company name), for someone who came to create a demo company
 * (#settings.server.signup, from the sample banner).
 */
export function focusSignupField(panelId = 'server-signup'): void {
  focusWhenReady(() => document.querySelector<HTMLInputElement>(`#${panelId} form input:not([type="checkbox"])`))
}

/** Where the next step on Settings, Server starts: the sign-in form, else the first step panel that shows. */
export type ServerStep = { kind: 'signin' } | { kind: 'panel'; id: string } | null

/** The panels a link to Settings, Server leads to, in order (Upload or Use the server's copy, a paused sync, the status). */
const STEP_PANELS = ['server-connect', 'server-hold', 'server-status']

/** Picks the next step from what the page shows (`has` answers whether a selector matches). */
export function serverStep(has: (selector: string) => boolean): ServerStep {
  if (has('#server-signin input[name="username"]')) return { kind: 'signin' }
  const id = STEP_PANELS.find((p) => has(`#${p}`))
  return id ? { kind: 'panel', id } : null
}

/**
 * A link to Settings, Server clicked while that page is already open (a banner's Sign in or Upload it right
 * after Start fresh, the sync chip): following it would do nothing, so focus moves to where the next step
 * starts (focusing brings it into view). Returns true when it handled the click.
 */
export function focusServerStep(): boolean {
  if (typeof document === 'undefined') return false
  const step = serverStep((selector) => document.querySelector(selector) !== null)
  if (!step) return false
  if (step.kind === 'signin') focusSignInField()
  else focusPanelTitle(step.id)
  return true
}

/**
 * Scrolls `el` into view, nearest edge first, without animation when the person asked for less motion.
 * A message that appears below the fold (a phone, a long form) would otherwise go unseen. `reduceMotion`
 * is read from the browser unless given (tests).
 */
export function revealElement(el: Pick<HTMLElement, 'scrollIntoView'> | null, reduceMotion?: boolean): void {
  if (!el || typeof el.scrollIntoView !== 'function') return
  const reduce =
    reduceMotion ?? (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' })
}
