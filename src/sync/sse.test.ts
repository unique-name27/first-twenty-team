// The event stream parser behind the assistant's answers: events split anywhere still arrive whole.
import { describe, expect, it } from 'vitest'
import { createSSEParser, MAX_SSE_LINE, type SSEMessage, SSELineTooLong } from './sse'

function parseAll(chunks: string[], end = true): SSEMessage[] {
  const out: SSEMessage[] = []
  const p = createSSEParser((m) => out.push(m))
  for (const c of chunks) p.push(c)
  if (end) p.end()
  return out
}

describe('createSSEParser', () => {
  it('reads named events with JSON data', () => {
    const text = 'event: delta\ndata: {"text":"Hi"}\n\nevent: done\ndata: {"history":[]}\n\n'
    expect(parseAll([text])).toEqual([
      { event: 'delta', data: '{"text":"Hi"}' },
      { event: 'done', data: '{"history":[]}' },
    ])
  })

  it('puts events split across chunks back together, wherever the split falls', () => {
    const text = 'event: delta\ndata: {"text":"Kofi starts Monday"}\n\nevent: status\ndata: {"label":"Looking up people"}\n\n'
    const whole = parseAll([text])
    for (let i = 1; i < text.length; i++) {
      expect(parseAll([text.slice(0, i), text.slice(i)])).toEqual(whole)
    }
    // One character at a time too.
    expect(parseAll(text.split(''))).toEqual(whole)
  })

  it('accepts \\r\\n and \\r line endings, even with \\r and \\n in different chunks', () => {
    expect(parseAll(['event: delta\r\ndata: {"text":"a"}\r\n\r\n'])).toEqual([{ event: 'delta', data: '{"text":"a"}' }])
    expect(parseAll(['event: delta\rdata: x\r\r'])).toEqual([{ event: 'delta', data: 'x' }])
    expect(parseAll(['event: delta\r', '\ndata: x\r', '\n\r', '\n'])).toEqual([{ event: 'delta', data: 'x' }])
  })

  it('joins several data lines with newlines and defaults the event name to message', () => {
    expect(parseAll(['data: one\ndata: two\n\n'])).toEqual([{ event: 'message', data: 'one\ntwo' }])
  })

  it('ignores comments, unknown fields and events without data', () => {
    expect(parseAll([': keep-alive\n\nid: 7\nretry: 100\nevent: status\n\nevent: delta\ndata:x\n\n'])).toEqual([{ event: 'delta', data: 'x' }])
  })

  it('removes only one space after the colon', () => {
    expect(parseAll(['data:  two spaces\n\n'])).toEqual([{ event: 'message', data: ' two spaces' }])
  })

  it('drops an event the stream ended in the middle of', () => {
    expect(parseAll(['event: delta\ndata: {"text":"a"}\n\nevent: done\ndata: {"hist'])).toEqual([{ event: 'delta', data: '{"text":"a"}' }])
    expect(parseAll(['event: done\ndata: {}\n'])).toEqual([])
  })

  it('ignores anything pushed after end', () => {
    const out: SSEMessage[] = []
    const p = createSSEParser((m) => out.push(m))
    p.end()
    p.push('data: late\n\n')
    expect(out).toEqual([])
  })

  it('refuses a line longer than it holds', () => {
    const p = createSSEParser(() => undefined)
    expect(() => p.push(`data: ${'x'.repeat(MAX_SSE_LINE + 1)}`)).toThrow(SSELineTooLong)
  })
})
