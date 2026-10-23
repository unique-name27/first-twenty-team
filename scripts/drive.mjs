// Headless Chrome driver over CDP for QA scenarios (works when the built-in browser pane is busy).
// Usage: OUT_DIR=<scratch dir> PROFILE=<name> node scripts/drive.mjs scenario.mjs [--fresh]
// OUT_DIR holds the screenshots (default: next to this script; keep it outside the repo).
// The Chrome profile (localStorage, cookies, Cache Storage) persists between runs under the same PROFILE
// name. It lives at <temp>/ft-prof/<PROFILE>, a short path on purpose: under a long path (a deep OUT_DIR)
// Chrome's Cache Storage fails, and the app's offline worker then has no copy to keep. PROFILE_DIR=<path>
// puts it somewhere else (a warning says when that path is long). At the end Chrome is closed the way a
// person closes it (CDP Browser.close), and the driver waits for it to exit, so the last seconds of
// localStorage and cookies reach the disk; it is killed only if it does not exit within 15 seconds.
// A scenario exports default async ({ nav, hash, js, sleep, shot, key, logs, takeLogs, viewport, dark }) => {}
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
const scenarioPath = resolve(process.argv[2])
const outDir = process.env.OUT_DIR || here
mkdirSync(outDir, { recursive: true })
const profile = process.env.PROFILE_DIR ? resolve(process.env.PROFILE_DIR) : join(tmpdir(), 'ft-prof', process.env.PROFILE || 'profile')
// Chrome's own files go about 150 characters deeper than this; past Windows' 260 Cache Storage breaks.
if (profile.length > 80) console.warn(`drive: the profile path is ${profile.length} characters long; Chrome's Cache Storage may fail under it (${profile})`)
if (process.argv.includes('--fresh')) rmSync(profile, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })
// Set PORT when running several scenarios in parallel so they never share a Chrome.
const port = Number(process.env.PORT) || 9700 + Math.floor(Math.random() * 90)
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const exited = new Promise((r) => chrome.once('exit', r))

/**
 * Closes Chrome the way a person does (CDP Browser.close), so it writes localStorage and cookies to disk,
 * then waits for the process to exit (up to 15 s; a debugging port that stops answering counts as nearly
 * done). A hard kill first would lose what the last seconds of a scenario saved; it is only the fallback.
 */
async function closeChrome() {
  try {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json()
    const browser = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      browser.addEventListener('open', res)
      browser.addEventListener('error', rej)
    })
    browser.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  } catch {
    /* no answer: the fallback below kills it */
  }
  const deadline = Date.now() + 15_000
  let gone = false
  exited.then(() => (gone = true))
  let portClosedAt = null
  while (!gone && Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })
    } catch {
      // The port closes before the process ends: give it a moment to finish writing.
      portClosedAt ??= Date.now()
      if (Date.now() - portClosedAt > 3000) break
    }
    await sleep(250)
  }
  if (!gone) chrome.kill()
}

let wsUrl
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (page) { wsUrl = page.webSocketDebuggerUrl; break }
  } catch {}
  await sleep(200)
}
if (!wsUrl) { console.error('no chrome'); await closeChrome(); process.exit(1) }
const ws = new WebSocket(wsUrl)
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
let logs = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning' || m.params.type === 'assert'))
    logs.push(`[console.${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 600))
  if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 800))
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('[log] ' + m.params.entry.text + ' ' + (m.params.entry.url ?? ''))
})
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable')
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
const js = async (body) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return 'EVAL ERROR: ' + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)
  return r.result?.result?.value
}
const nav = async (url, wait = 1800) => { await send('Page.navigate', { url }); await sleep(wait) }
const hash = async (h, wait = 700) => { await js(`location.hash = ${JSON.stringify(h)}`); await sleep(wait) }
const KEYS = { Enter: 13, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Escape: 27, Tab: 9, Home: 36, End: 35 }
const key = async (k, mods = 0) => {
  const code = KEYS[k] ?? k.toUpperCase().charCodeAt(0)
  const isChar = k.length === 1 || k === 'Enter'
  const text = k === 'Enter' ? '\r' : k
  await send('Input.dispatchKeyEvent', { type: isChar ? 'keyDown' : 'rawKeyDown', key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: code, ...(isChar && !mods ? { text } : {}), modifiers: mods })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: code, modifiers: mods })
  await sleep(250)
}
const shot = async (name, full = false) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full })
  writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64'))
  return join(outDir, name)
}
const viewport = async (w, h) => {
  if (!w) await send('Emulation.clearDeviceMetricsOverride')
  else await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768 })
  await sleep(300)
}
const dark = async (on) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: on ? 'dark' : 'light' }] })
const takeLogs = () => { const l = logs; logs = []; return l }
try {
  const mod = await import(pathToFileURL(scenarioPath).href + '?t=' + Date.now())
  await mod.default({ send, js, nav, hash, sleep, shot, key, viewport, dark, takeLogs, here })
} catch (e) {
  console.error('SCENARIO ERROR', e)
}
const rest = takeLogs()
if (rest.length) console.log('== remaining logs:\n' + rest.join('\n'))
ws.close()
await closeChrome()
process.exit(0)
