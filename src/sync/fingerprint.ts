// Short, stable fingerprints of JSON values. Two values that deepEqual (JSON semantics: key order and
// keys holding undefined do not matter) get the same fingerprint, so a copy that went through Postgres
// JSONB (which reorders keys) still matches what this browser sent. Not cryptographic: it only has to
// tell this device's own earlier write apart from a different one. Pure.

/** JSON with object keys sorted at every level; undefined members are left out, as JSON.stringify does. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJSON(v))).join(',')}]`
  const obj = value as Record<string, unknown>
  const parts: string[] = []
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k]
    if (v === undefined || typeof v === 'function') continue
    parts.push(`${JSON.stringify(k)}:${canonicalJSON(v)}`)
  }
  return `{${parts.join(',')}}`
}

/** cyrb53: a fast 53-bit string hash with good spread. */
function cyrb53(s: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** "<length>.<hash>" of the canonical JSON, both base 36. */
export function fingerprint(value: unknown): string {
  const s = canonicalJSON(value)
  return `${s.length.toString(36)}.${cyrb53(s).toString(36)}`
}
