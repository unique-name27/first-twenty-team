// Server-sent events (text/event-stream), the way the assistant's answers arrive (POST /api/assistant/chat,
// docs/SERVER.md "Lark, the assistant"). The part of the format the server uses: `event:` and `data:`
// lines, a blank line ending each event, `:` comments ignored. Pure: text goes in as it arrives, split
// anywhere (even inside a line or between \r and \n), and whole events come out.

export type SSEMessage = { event: string; data: string }

export type SSEParser = {
  /** Feeds the next piece of decoded text. */
  push(chunk: string): void
  /** The stream ended: an event without its closing blank line is dropped, as the format says. */
  end(): void
}

/** Longest line the parser holds before giving up (the 'done' event carries the whole conversation). */
export const MAX_SSE_LINE = 4_000_000

export class SSELineTooLong extends Error {
  constructor() {
    super('An event stream line is longer than the parser accepts.')
  }
}

export function createSSEParser(onMessage: (m: SSEMessage) => void): SSEParser {
  let buffer = ''
  let event = ''
  let data: string[] = []
  let ended = false

  const dispatch = () => {
    // An event with no data line is a keep-alive or a stray field: nothing to deliver.
    if (data.length > 0) onMessage({ event: event || 'message', data: data.join('\n') })
    event = ''
    data = []
  }

  const line = (l: string) => {
    if (l === '') return dispatch()
    if (l.startsWith(':')) return
    const i = l.indexOf(':')
    const field = i === -1 ? l : l.slice(0, i)
    let value = i === -1 ? '' : l.slice(i + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    // id and retry are not used: a broken answer is asked again by the person, never resumed.
  }

  /** Takes every finished line out of the buffer. A \r at the very end waits: a \n may follow it. */
  const drain = (final: boolean) => {
    let start = 0
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer.charCodeAt(i)
      if (c !== 10 && c !== 13) continue
      if (c === 13 && i === buffer.length - 1 && !final) break
      line(buffer.slice(start, i))
      if (c === 13 && buffer.charCodeAt(i + 1) === 10) i++
      start = i + 1
    }
    buffer = buffer.slice(start)
    if (buffer.length > MAX_SSE_LINE) throw new SSELineTooLong()
  }

  return {
    push(chunk) {
      if (ended || chunk === '') return
      buffer += chunk
      drain(false)
    },
    end() {
      if (ended) return
      drain(true)
      ended = true
      buffer = ''
      event = ''
      data = []
    },
  }
}
