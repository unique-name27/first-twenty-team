// The assistant's answers as formatted text: a small Markdown renderer of our own, safe by construction.
// parseMarkdown turns the text into a tree of known nodes (paragraphs, headings shown as bold lines, lists,
// quotes, code, simple tables; bold, italic, inline code, links), and <Markdown> renders only those, as
// React text: raw HTML stays visible text and images never load (their alt text shows instead).
//
// Links: an answer is written by a model that read records strangers can type into (careers applications),
// so a planted instruction could try to make it write a link that carries company data in its address, or
// a sign-in page somewhere else. The system prompt forbids that; this renderer enforces it. A link keeps
// its target only when it is an in-app route to a page to read (#person.p-kofi; never an action, a form or
// an invite), including an absolute address into this app itself, or an https address on one of the
// official sources the assistant's lookups return (isOfficialSourceHost: the government and law sites of
// src/data/law.ts and the compliance rules). Any other address shows as text that cannot be followed, with
// the site it named.
//
// Emphasis follows CommonMark's rules for * and _ (flanking runs, an underscore never opens or closes inside
// a word, a closer pairs with the nearest opener that fits), so snake_case, __dunders__ in code-like text and
// stray stars come out as written.
import { Fragment, type ReactNode, useMemo } from 'react'
import { parse as parseRoute } from '@/app/router'
import { isOfficialSourceHost } from '@/domain/assistant'
import { cx, Icon, Private } from '@/ui'

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'br' }
  | { t: 'link'; link: SafeLink; c: Inline[] }

export type ListBlock = { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
export type ListItem = { c: Inline[]; sub?: ListBlock }

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; c: Inline[] }
  | ListBlock
  | { t: 'quote'; c: Block[] }
  | { t: 'pre'; v: string }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' }

/**
 * app: an in-app route, followed in this tab. external: an official source, opened in a new tab.
 * unverified: an https address anywhere else, shown with its site but never followed.
 */
export type SafeLink = { kind: 'app'; href: string } | { kind: 'external'; href: string; host: string } | { kind: 'unverified'; host: string }

/**
 * Pages an answer may link to. A link goes to a page to read, never straight into a form, a sheet that
 * changes something, or a mode that acts on single keys: those route segments are refused below.
 */
const LINK_VIEWS: ReadonlySet<string> = new Set([
  'home',
  'hiring',
  'job',
  'candidate',
  'people',
  'person',
  'checklist',
  'contractor',
  'comp',
  'compliance',
  'me',
  'settings',
  'timeoff',
  'plan',
])
const ACTION_SEGMENTS: ReadonlySet<string> = new Set(['new', 'add', 'new-job', 'edit', 'offboard', 'change', 'fresh', 'import', 'signup', 'request', 'sweep'])

/** An in-app route an answer may link to ('#person.p-kofi'), or null. */
function appLink(h: string): SafeLink | null {
  if (h.length > 200 || !/^#[A-Za-z0-9._~%-]+$/.test(h)) return null
  const route = parseRoute(h)
  if (!LINK_VIEWS.has(route.view)) return null
  if (route.segments.some((s) => ACTION_SEGMENTS.has(s))) return null
  return { kind: 'app', href: h }
}

/** This page's origin ('https://hr.example.com'), or null where there is none (the one-file app, tests). */
function pageOrigin(): string | null {
  try {
    const o = typeof location === 'undefined' ? null : location.origin
    return o && o !== 'null' ? o : null
  } catch {
    return null
  }
}

/**
 * What a link target in an answer may be (see the top of this file): an in-app route to a page; an
 * absolute address into this app (`origin`), held to the same rules through its #route; an official source;
 * or, for any other https address with no user name or password in it, a site named but not followed.
 * Anything else (javascript:, data:, http:, mailto:, a relative path, an invite link, an action route) is
 * refused, and the link renders as its text only.
 */
export function safeLink(raw: string, origin: string | null = pageOrigin()): SafeLink | null {
  let d = raw.trim()
  if (d.startsWith('<') && d.endsWith('>')) d = d.slice(1, -1).trim()
  if (d.startsWith('#')) return appLink(d)
  if (!/^https:\/\//i.test(d) || d.length > 2048) return null
  try {
    const u = new URL(d)
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null
    if (origin && u.origin === origin) return u.hash ? appLink(u.hash) : null
    if (isOfficialSourceHost(u.hostname)) return { kind: 'external', href: u.href, host: u.hostname }
    return { kind: 'unverified', host: u.hostname }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Inline text
// ---------------------------------------------------------------------------------------------

const MAX_DEPTH = 6
const ESCAPABLE = /[\\`*_[\]()#+\-.!|<>~{}]/

/** `[text](target "title")` starting at s[i] === '['. */
function readLink(s: string, i: number): { text: string; dest: string; end: number } | null {
  let depth = 0
  let j = i
  // Link text longer than this is not a link (and the scan stays short on text full of brackets).
  const stop = Math.min(s.length, i + 1000)
  for (; j < stop; j++) {
    const c = s[j]
    if (c === '\\') {
      j++
      continue
    }
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) break
    } else if (c === '\n' && s[j + 1] === '\n') return null
  }
  if (depth !== 0 || s[j + 1] !== '(') return null
  const text = s.slice(i + 1, j)
  let k = j + 2
  let parens = 0
  const stopDest = Math.min(s.length, k + 2100)
  for (; k < stopDest; k++) {
    const c = s[k]
    if (c === '\\') {
      k++
      continue
    }
    if (c === '(') parens++
    else if (c === ')') {
      if (parens === 0) break
      parens--
    } else if (c === '\n') return null
  }
  if (k >= stopDest) return null
  // The target is the first word; a "title" after it is dropped.
  const inner = s.slice(j + 2, k).trim()
  const dest = inner.startsWith('<') ? inner.slice(0, inner.indexOf('>') + 1 || undefined) : (inner.split(/\s+/)[0] ?? '')
  return { text, dest, end: k + 1 }
}

// Whitespace (the start and end of the text count as whitespace) and punctuation, as CommonMark reads them.
const isSpace = (c: string | undefined) => !c || /\s/.test(c)
const isPunct = (c: string | undefined) => !!c && /[\p{P}\p{S}]/u.test(c)

/** A run of `*` or `_`: how many are left to pair, how many there were, and whether it can open or close. */
type Delim = { ch: '*' | '_'; count: number; orig: number; canOpen: boolean; canClose: boolean }

/** The run of `run` delimiters `ch` between `prev` and `next` (CommonMark's left- and right-flanking rules). */
function delimRun(ch: '*' | '_', run: number, prev: string | undefined, next: string | undefined): Delim {
  const left = !isSpace(next) && (!isPunct(next) || isSpace(prev) || isPunct(prev))
  const right = !isSpace(prev) && (!isPunct(prev) || isSpace(next) || isPunct(next))
  // An underscore never opens or closes inside a word (snake_case), only beside punctuation or space.
  const canOpen = ch === '*' ? left : left && (!right || isPunct(prev))
  const canClose = ch === '*' ? right : right && (!left || isPunct(next))
  return { ch, count: run, orig: run, canOpen, canClose }
}

/** The parse so far as a linked list: inline nodes, and delimiter runs not paired yet. */
type Item = { node?: Inline; delim?: Delim; prev: Item | null; next: Item | null }

/** Adjacent text nodes as one. */
function mergeText(nodes: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const n of nodes) {
    const last = out[out.length - 1]
    if (n.t === 'text' && last?.t === 'text') out[out.length - 1] = { t: 'text', v: last.v + n.v }
    else if (n.t !== 'text' || n.v !== '') out.push(n)
  }
  return out
}

/** An item as a node: a run that was never paired is its characters. */
const itemNode = (x: Item): Inline => x.node ?? { t: 'text', v: x.delim!.ch.repeat(x.delim!.count) }

/**
 * Pairs the delimiter runs into emphasis, CommonMark's way: each closer, left to right, takes the nearest
 * opener of the same character that fits (the rule of three included), two characters for strong and one
 * for emphasis (three at once, both). What lies between becomes the new node's children; runs in it that
 * never paired stay as text. A closer that finds no opener marks how far back later ones need to look.
 */
function pairEmphasis(head: Item): void {
  const bottom = new Map<string, Item | null>()
  for (let c: Item | null = head; c; c = c.next) {
    const cd: Delim | undefined = c.delim
    if (!cd || !cd.canClose) continue
    while (cd.count > 0) {
      const key: string = `${cd.ch}${cd.canOpen ? 1 : 0}${cd.orig % 3}`
      const stop: Item | null = bottom.get(key) ?? null
      let o: Item | null = c.prev
      let found: Item | null = null
      for (; o && o !== stop; o = o.prev) {
        const od = o.delim
        if (!od || od.ch !== cd.ch || !od.canOpen || od.count === 0) continue
        const ruleOfThree = (od.canClose || cd.canOpen) && (od.orig + cd.orig) % 3 === 0 && !(od.orig % 3 === 0 && cd.orig % 3 === 0)
        if (!ruleOfThree) {
          found = o
          break
        }
      }
      if (!found) {
        bottom.set(key, c.prev)
        break
      }
      const od = found.delim!
      const use = od.count >= 3 && cd.count >= 3 ? 3 : od.count >= 2 && cd.count >= 2 ? 2 : 1
      const inner: Inline[] = []
      for (let x: Item | null = found.next; x && x !== c; x = x.next) inner.push(itemNode(x))
      const kids = mergeText(inner)
      od.count -= use
      cd.count -= use
      const node: Inline = use === 3 ? { t: 'strong', c: [{ t: 'em', c: kids }] } : use === 2 ? { t: 'strong', c: kids } : { t: 'em', c: kids }
      const item: Item = { node, prev: found, next: c }
      found.next = item
      c.prev = item
    }
  }
}

/** A bare https address in running text, without the punctuation that ends a sentence. */
function readAutolink(s: string, i: number): string | null {
  const m = /^https:\/\/[^\s<>"'`]+/i.exec(s.slice(i, i + 2048))
  if (!m) return null
  let url = m[0]
  while (/[.,;:!?)\]*_]$/.test(url)) {
    if (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break
    url = url.slice(0, -1)
  }
  return url.length > 'https://'.length ? url : null
}

export function parseInline(s: string, depth = 0, inLink = false): Inline[] {
  if (depth > MAX_DEPTH) return s ? [{ t: 'text', v: s }] : []
  // A sentinel head; nodes and delimiter runs are appended after it, then paired (pairEmphasis).
  const head: Item = { prev: null, next: null }
  let tail = head
  const append = (x: Omit<Item, 'prev' | 'next'>) => {
    const item: Item = { ...x, prev: tail, next: null }
    tail.next = item
    tail = item
  }
  let buf = ''
  const flush = () => {
    if (buf) append({ node: { t: 'text', v: buf } })
    buf = ''
  }
  const push = (node: Inline) => {
    flush()
    append({ node })
  }
  // Searches that found no closing backticks: one from a later position cannot find one either, so the
  // parse stays linear on text full of them (an answer is parsed again with every new piece).
  const noClose = new Map<string, number>()
  const closeFrom = (key: string, from: number, find: () => number) => {
    if ((noClose.get(key) ?? Infinity) <= from) return -1
    const at = find()
    if (at === -1) noClose.set(key, Math.min(noClose.get(key) ?? Infinity, from))
    return at
  }
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1])) {
      buf += s[i + 1]
      i += 2
      continue
    }
    if (c === '\n') {
      push({ t: 'br' })
      i++
      continue
    }
    if (c === '`') {
      let n = 1
      while (s[i + n] === '`') n++
      const fence = '`'.repeat(n)
      const close = closeFrom(fence, i + n, () => s.indexOf(fence, i + n))
      if (close !== -1 && s[close + n] !== '`') {
        let code = s.slice(i + n, close).replace(/\n/g, ' ')
        if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1)
        push({ t: 'code', v: code })
        i = close + n
      } else {
        buf += fence
        i += n
      }
      continue
    }
    if (c === '!' && s[i + 1] === '[') {
      // An image never loads: its description stays as plain words.
      const img = readLink(s, i + 1)
      if (img) {
        buf += img.text.replace(/\\(.)/g, '$1')
        i = img.end
        continue
      }
    }
    if (c === '[' && !inLink) {
      const l = readLink(s, i)
      if (l) {
        const children = parseInline(l.text, depth + 1, true)
        const link = safeLink(l.dest)
        if (link) push({ t: 'link', link, c: children })
        else for (const child of children) push(child)
        i = l.end
        continue
      }
    }
    if (c === '*' || c === '_') {
      // A run of delimiters: paired into emphasis once the whole text is read (pairEmphasis).
      let run = 1
      while (s[i + run] === c) run++
      flush()
      append({ delim: delimRun(c, run, s[i - 1], s[i + run]) })
      i += run
      continue
    }
    if (!inLink && c === '<') {
      // <https://...>: an autolink, held to the same rules as any link; the brackets never show.
      const m = /^<(https:\/\/[^\s<>]{1,2048})>/i.exec(s.slice(i, i + 2060))
      if (m) {
        const link = safeLink(m[1])
        if (link && link.kind !== 'unverified') push({ t: 'link', link, c: [{ t: 'text', v: m[1] }] })
        else buf += m[1]
        i += m[0].length
        continue
      }
    }
    if (!inLink && (c === 'h' || c === 'H') && (i === 0 || /[\s(]/.test(s[i - 1]))) {
      // A bare address links itself only when it may be followed; any other stays the text it is.
      const url = readAutolink(s, i)
      const link = url ? safeLink(url) : null
      if (url && link && link.kind !== 'unverified') {
        push({ t: 'link', link, c: [{ t: 'text', v: url }] })
        i += url.length
        continue
      }
    }
    buf += c
    i++
  }
  flush()
  pairEmphasis(head)
  const out: Inline[] = []
  for (let x: Item | null = head.next; x; x = x.next) out.push(itemNode(x))
  return mergeText(out)
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t#]*$/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const indentOf = (s: string) => s.replace(/\t/g, '    ').length

function splitRow(line: string): string[] {
  let l = line.trim()
  if (l.startsWith('|')) l = l.slice(1)
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < l.length; i++) {
    if (l[i] === '\\' && l[i + 1] === '|') {
      cur += '|'
      i++
    } else if (l[i] === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += l[i]
  }
  cells.push(cur.trim())
  return cells
}

function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HR.test(line) || HEADING.test(line) || LIST_ITEM.test(line) || /^\s{0,3}>/.test(line) || (line.includes('|') && !!next && TABLE_RULE.test(next) && next.includes('-'))
}

type RawItem = { indent: number; ordered: boolean; start: number; lines: string[]; sub: RawList | null }
type RawList = { ordered: boolean; start: number; items: RawItem[]; indent: number }

function finishList(l: RawList, depth: number): ListBlock {
  return {
    t: 'list',
    ordered: l.ordered,
    start: l.start,
    items: l.items.map((it) => {
      const item: ListItem = { c: parseInline(it.lines.join('\n'), depth) }
      if (it.sub) item.sub = finishList(it.sub, depth + 1)
      return item
    }),
  }
}

export function parseMarkdown(text: string, depth = 0): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(marker[0].repeat(marker.length))) body.push(lines[i++])
      i++
      blocks.push({ t: 'pre', v: body.join('\n') })
      continue
    }
    if (HR.test(line)) {
      blocks.push({ t: 'hr' })
      i++
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ t: 'h', c: parseInline(heading[1], depth) })
      i++
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}> ?/, ''))
      blocks.push(depth >= 3 ? { t: 'p', c: parseInline(body.join('\n'), depth) } : { t: 'quote', c: parseMarkdown(body.join('\n'), depth + 1) })
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line).map((c) => parseInline(c, depth))
      i += 2
      const rows: Inline[][][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        const cells = splitRow(lines[i]).map((c) => parseInline(c, depth))
        // Every row has the header's number of cells: extra ones are dropped, missing ones are empty.
        rows.push(head.map((_, k) => cells[k] ?? []))
        i++
      }
      blocks.push({ t: 'table', head, rows })
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      const root: RawList = { ordered: /\d/.test(item[2]), start: parseInt(item[2], 10) || 1, items: [], indent: indentOf(item[1]) }
      const stack: RawList[] = [root]
      while (i < lines.length) {
        const l = lines[i]
        const m = LIST_ITEM.exec(l)
        if (m) {
          const indent = indentOf(m[1])
          while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop()
          // A numbered item after bullets (or the other way round) at the outer level starts a new list.
          if (stack.length === 1 && indent < root.indent + 2 && /\d/.test(m[2]) !== root.ordered) break
          let top = stack[stack.length - 1]
          const parent = top.items[top.items.length - 1]
          if (parent && indent >= top.indent + 2 && stack.length < 4) {
            if (!parent.sub) parent.sub = { ordered: /\d/.test(m[2]), start: parseInt(m[2], 10) || 1, items: [], indent }
            stack.push(parent.sub)
            top = parent.sub
          }
          top.items.push({ indent, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10) || 1, lines: [m[3]], sub: null })
          i++
          continue
        }
        if (l.trim() === '') {
          // A blank line ends the list unless another item follows it.
          if (i + 1 < lines.length && LIST_ITEM.exec(lines[i + 1])) {
            i++
            continue
          }
          break
        }
        // A line that starts another kind of block ends the list; any other line continues the item above.
        if (startsBlock(l, lines[i + 1]) && !/^\s+/.test(l)) break
        const top = stack[stack.length - 1]
        const last = top.items[top.items.length - 1]
        last.lines.push(l.trim())
        i++
      }
      blocks.push(finishList(root, depth))
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && (para.length === 0 || !startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++].trim())
    blocks.push({ t: 'p', c: parseInline(para.join('\n'), depth) })
  }
  return blocks
}

// ---------------------------------------------------------------------------------------------
// Plain text (for the screen reader announcement of a finished answer)
// ---------------------------------------------------------------------------------------------

function inlineText(c: Inline[]): string {
  return c.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? ' ' : inlineText(n.c))).join('')
}

function blockText(b: Block): string[] {
  switch (b.t) {
    case 'p':
    case 'h':
      return [inlineText(b.c)]
    case 'list':
      return b.items.flatMap((it) => [inlineText(it.c), ...(it.sub ? blockText(it.sub) : [])])
    case 'quote':
      return b.c.flatMap(blockText)
    case 'pre':
      return [b.v]
    case 'table':
      return [b.head.map(inlineText).join(', '), ...b.rows.map((r) => r.map(inlineText).join(', '))]
    case 'hr':
      return []
  }
}

/** The answer as plain sentences: what a screen reader announces once the answer is finished. */
export function markdownToPlainText(text: string): string {
  return parseMarkdown(text)
    .flatMap(blockText)
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** Dollar amounts in running text ('$185,000', '$1.2M', '$40k'). */
const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:[kKmMbB]\b|million\b|thousand\b|billion\b))?/g

/** Splits text into plain parts and dollar amounts, so the privacy blur (key B) can hide the amounts. */
export function splitMoney(v: string): Array<{ money: boolean; v: string }> {
  const parts: Array<{ money: boolean; v: string }> = []
  let last = 0
  for (const m of v.matchAll(MONEY)) {
    const at = m.index ?? 0
    if (at > last) parts.push({ money: false, v: v.slice(last, at) })
    parts.push({ money: true, v: m[0] })
    last = at + m[0].length
  }
  if (last < v.length) parts.push({ money: false, v: v.slice(last) })
  return parts
}

type RenderCtx = { onAppLink?: () => void }

function Text({ v }: { v: string }) {
  return (
    <>
      {splitMoney(v).map((p, i) => (p.money ? <Private key={i}>{p.v}</Private> : <Fragment key={i}>{p.v}</Fragment>))}
    </>
  )
}

const LINK = 'ft-link font-semibold text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent'
// A 40px hit area without moving the lines around it (as TextLink does).
const HIT = 'box-content -my-3.5 border-y-[14px] border-transparent focus-visible:outline-offset-[calc(var(--focus-offset)_-_14px)]'

function renderInline(nodes: Inline[], ctx: RenderCtx, key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`
    switch (n.t) {
      case 'text':
        return <Text key={k} v={n.v} />
      case 'br':
        return <br key={k} />
      case 'code':
        return (
          <code key={k} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.9em] break-words text-ink">
            {n.v}
          </code>
        )
      case 'strong':
        return (
          <strong key={k} className="font-bold text-ink">
            {renderInline(n.c, ctx, `${k}.`)}
          </strong>
        )
      case 'em':
        return <em key={k}>{renderInline(n.c, ctx, `${k}.`)}</em>
      case 'link':
        if (n.link.kind === 'unverified') {
          // Not one of the official sources: the words stay, the address never becomes something to follow.
          return (
            <Fragment key={k}>
              {renderInline(n.c, ctx, `${k}.`)}
              <span className="ft-assistant__host text-ink-3"> (link to {n.link.host} removed)</span>
            </Fragment>
          )
        }
        if (n.link.kind === 'app') {
          return (
            <a key={k} href={n.link.href} onClick={() => ctx.onAppLink?.()} className={cx(LINK, HIT)} style={{ backgroundClip: 'padding-box' }}>
              {renderInline(n.c, ctx, `${k}.`)}
            </a>
          )
        }
        return (
          <Fragment key={k}>
            <a
              href={n.link.href}
              target="_blank"
              rel="noopener noreferrer"
              title={n.link.href}
              className={cx(LINK, HIT, 'break-words')}
              style={{ backgroundClip: 'padding-box' }}
            >
              {renderInline(n.c, ctx, `${k}.`)}
              <Icon name="external" size={12} className="ml-0.5 inline align-[-1px]" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            {/* Where it really goes, so link text cannot pass off another site as an official one. */}
            {inlineText(n.c) !== n.link.href && inlineText(n.c) !== n.link.host && <span className="ft-assistant__host text-ink-3"> ({n.link.host})</span>}
          </Fragment>
        )
    }
  })
}

function ListView({ list, ctx, k }: { list: ListBlock; ctx: RenderCtx; k: string }) {
  const items = list.items.map((it, i) => (
    <li key={i} className="pl-0.5">
      {renderInline(it.c, ctx, `${k}.${i}.`)}
      {it.sub && <ListView list={it.sub} ctx={ctx} k={`${k}.${i}`} />}
    </li>
  ))
  return list.ordered ? (
    <ol start={list.start === 1 ? undefined : list.start} className="my-2 list-decimal space-y-1 pl-6 first:mt-0 last:mb-0">
      {items}
    </ol>
  ) : (
    <ul className="my-2 list-disc space-y-1 pl-6 first:mt-0 last:mb-0">{items}</ul>
  )
}

function renderBlocks(blocks: Block[], ctx: RenderCtx, key = ''): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}${i}`
    switch (b.t) {
      case 'p':
        return (
          <p key={k} className="my-2 first:mt-0 last:mb-0">
            {renderInline(b.c, ctx, `${k}.`)}
          </p>
        )
      case 'h':
        return (
          <p key={k} className="mt-3 mb-1 font-bold text-ink first:mt-0">
            {renderInline(b.c, ctx, `${k}.`)}
          </p>
        )
      case 'list':
        return <ListView key={k} list={b} ctx={ctx} k={k} />
      case 'quote':
        return (
          <blockquote key={k} className="my-2 border-l-2 border-line-strong pl-3 text-ink-2 first:mt-0 last:mb-0">
            {renderBlocks(b.c, ctx, `${k}.`)}
          </blockquote>
        )
      case 'pre':
        return (
          <pre key={k} className="scroll-thin my-2 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-[13px] leading-relaxed text-ink first:mt-0 last:mb-0">
            <code>{b.v}</code>
          </pre>
        )
      case 'table':
        return (
          <div key={k} className="scroll-thin my-2 max-w-full overflow-x-auto first:mt-0 last:mb-0">
            <table className="ft-assistant__table w-full border-collapse text-left text-[13.5px]">
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} scope="col" className="border-b border-line-strong px-2 py-1.5 font-semibold text-ink">
                      {renderInline(c, ctx, `${k}.h${j}.`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, m) => (
                      <td key={m} className="border-b border-line px-2 py-1.5 align-top">
                        {renderInline(c, ctx, `${k}.${j}.${m}.`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      case 'hr':
        return <hr key={k} className="my-3 border-line" />
    }
  })
}

/**
 * An answer, formatted. onAppLink runs when an in-app link is followed (the sheet closes so the page
 * shows); the browser follows the link itself.
 */
export function Markdown({ text, onAppLink, className }: { text: string; onAppLink?: () => void; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return <div className={cx('ft-markdown min-w-0 break-words', className)}>{renderBlocks(blocks, { onAppLink })}</div>
}
