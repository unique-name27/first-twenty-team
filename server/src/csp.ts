// Content-Security-Policy for the served one-file app. The app inlines its scripts, so instead of
// 'unsafe-inline' the policy lists the SHA-256 of each inline <script> exactly as a browser reads it:
// any other inline script or event handler (for example from injected HTML) does not run.
import { createHash } from 'node:crypto'

/** For JSON responses and anything that is not the app. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'"

/**
 * For every answer on a careers host (CAREERS_HOSTS): its own stylesheet, script and fonts, images from
 * itself or data: URLs, forms posting back to itself, and nothing else. app.ts sets it on careers-host
 * answers that carry no policy of their own.
 */
export const CAREERS_CSP =
  "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

/**
 * The app's policy: inline scripts only by hash; styles may be inline (the app sets style attributes);
 * workers only from this server (the offline worker, /sw.js).
 */
export function appCsp(scriptHashes: readonly string[]): string {
  const scripts = ["'self'", ...scriptHashes.map((h) => `'sha256-${h}'`)]
  return [
    "default-src 'self'",
    `script-src ${scripts.join(' ')}`,
    "script-src-attr 'none'",
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r'
const isAlpha = (c: string | undefined) => c !== undefined && /[A-Za-z]/.test(c)

/** `text` has a tag name "script" at `i`, followed by whitespace, "/" or ">" (case-insensitive). */
function scriptNameAt(text: string, i: number): boolean {
  return text.slice(i, i + 6).toLowerCase() === 'script' && (isSpace(text[i + 6]) || text[i + 6] === '/' || text[i + 6] === '>')
}

/**
 * Where a script element's text ends, following the HTML tokenizer's script data states: normally at
 * the first `</script`, but inside `<!--` ... a nested `<script` the first `</script` does not end it.
 * Returns the index of the closing `<` (or the text length when there is none).
 */
export function scriptTextEnd(text: string, from: number): number {
  type State = 'data' | 'escaped' | 'double'
  let state: State = 'data'
  let dashes = 0 // consecutive '-' just read in the escaped states
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (state === 'data') {
      if (c !== '<') continue
      if (text[i + 1] === '/' && scriptNameAt(text, i + 2)) return i
      if (text.startsWith('!--', i + 1)) {
        state = 'escaped'
        i += 3
        dashes = 2
      }
      continue
    }
    if (c === '-') {
      dashes++
      continue
    }
    if (c === '>' && dashes >= 2) {
      state = 'data'
      dashes = 0
      continue
    }
    dashes = 0
    if (c !== '<') continue
    if (state === 'escaped') {
      if (text[i + 1] === '/' && scriptNameAt(text, i + 2)) return i
      if (isAlpha(text[i + 1]) && scriptNameAt(text, i + 1)) state = 'double'
    } else if (text[i + 1] === '/' && scriptNameAt(text, i + 2)) {
      state = 'escaped'
      i += 7
    }
  }
  return text.length
}

/** The text of every inline <script> (no src attribute), as the browser hashes it (newlines normalized). */
export function inlineScripts(html: string): string[] {
  const text = html.replace(/\r\n?/g, '\n')
  const out: string[] = []
  // An HTML comment, or a script start tag (attributes without '>' in them, as the build writes them).
  const next = /<!--|<script\b([^>]*)>/gi
  for (let m = next.exec(text); m; m = next.exec(text)) {
    if (m[0] === '<!--') {
      const close = text.indexOf('-->', m.index + 4)
      next.lastIndex = close === -1 ? text.length : close + 3
      continue
    }
    const start = m.index + m[0].length
    const end = scriptTextEnd(text, start)
    if (!/(^|\s)src\s*=/i.test(m[1])) out.push(text.slice(start, end))
    next.lastIndex = end
  }
  return out
}

/** Base64 SHA-256 of each inline script, in document order, without duplicates. */
export function inlineScriptHashes(html: string): string[] {
  const hashes = inlineScripts(html).map((s) => createHash('sha256').update(s, 'utf8').digest('base64'))
  return [...new Set(hashes)]
}
