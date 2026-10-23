// Errors the API turns into JSON responses. Only `code` and an optional short `detail` (built from
// names the server already knows, never from SQL or stack traces) ever reach the client.

export class HttpError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly detail: string | undefined
  readonly extra: Record<string, unknown> | undefined

  constructor(statusCode: number, code: string, detail?: string, extra?: Record<string, unknown>) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'HttpError'
    this.statusCode = statusCode
    this.code = code
    this.detail = detail
    this.extra = extra
  }
}

export const badRequest = (detail: string) => new HttpError(400, 'bad_request', detail)

/** Raised for invalid server settings; the entry points print the message and exit. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}
