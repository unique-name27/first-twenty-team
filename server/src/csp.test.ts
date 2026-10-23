import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appCsp, inlineScriptHashes, inlineScripts } from './csp'
import { findRootDir } from './config'

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64')

describe('inline script hashes', () => {
  it('hashes the text of inline scripts only, in order, as the browser reads it', () => {
    const html = '<head><script>a()</script><script src="x.js"></script><SCRIPT type="module">b()</SCRIPT ></head>'
    expect(inlineScripts(html)).toEqual(['a()', 'b()'])
    expect(inlineScriptHashes(html)).toEqual([sha('a()'), sha('b()')])
  })

  it('normalizes CRLF line breaks like the HTML parser does', () => {
    expect(inlineScripts('<script>\r\nx()\r\n</script>')).toEqual(['\nx()\n'])
  })

  it('skips scripts inside HTML comments and drops duplicate hashes', () => {
    const html = '<!-- <script>old()</script> --><script>a()</script><script>a()</script>'
    expect(inlineScripts(html)).toEqual(['a()', 'a()'])
    expect(inlineScriptHashes(html)).toEqual([sha('a()')])
  })

  it('follows the tokenizer: inside <!-- ... <script the first </script> does not end the element', () => {
    const body = 'var s = "<!--<script>"; var t = "</script>"; var u = "-->";'
    expect(inlineScripts(`<script>${body}</script><p>after</p>`)).toEqual([body])
    // Without the nested <script, the escaped state still ends at </script>.
    expect(inlineScripts('<script>a("<!--")</script><script>b()</script>')).toEqual(['a("<!--")', 'b()'])
    // "-->" leaves the escaped state.
    expect(inlineScripts('<script><!-- x --></script><script>c()</script>')).toEqual(['<!-- x -->', 'c()'])
  })

  it('builds a policy without unsafe-inline for scripts', () => {
    const csp = appCsp(['abc=', 'def='])
    expect(csp).toContain("script-src 'self' 'sha256-abc=' 'sha256-def='")
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(appCsp([])).toContain("script-src 'self';")
    // Workers (the offline worker, /sw.js) only from the server itself.
    expect(csp).toContain("worker-src 'self'")
  })

  it('finds every inline script of the built app, when it has been built', () => {
    const file = path.join(findRootDir(), 'first-twenty.html')
    if (!existsSync(file)) return
    const html = readFileSync(file, 'utf8')
    const scripts = inlineScripts(html)
    const openTags = (html.match(/<script\b[^>]*>/gi) ?? []).filter((t) => !/\ssrc\s*=/i.test(t)).length
    expect(scripts.length).toBeGreaterThan(0)
    expect(scripts.length).toBeLessThanOrEqual(openTags)
    // Each one ends right before a closing tag.
    let at = 0
    for (const s of scripts) {
      const i = html.indexOf(s, at)
      expect(i).toBeGreaterThan(-1)
      expect(html.slice(i + s.length, i + s.length + 9).toLowerCase()).toBe('</script>')
      at = i + s.length
    }
  })
})
