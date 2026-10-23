// Clipboard, file download, CSV and print helpers shared by every feature.
// Downloads and print may be blocked in some embedded hosts; every caller should also offer
// "Copy" so the content is never stuck behind a file.

/** Copies text; resolves true on success. Falls back to a hidden textarea + execCommand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** Starts a file download. Returns false when the browser or host blocks it. */
type DownloadsNS = { save: (r: { filename: string; data: string | Blob }) => Promise<{ status: string }> }
type ArtifactHost = { use: (name: 'downloads') => Promise<DownloadsNS | null> }

/** File types the claude.ai artifact viewer lets a page save (its downloads allowlist). */
const ARTIFACT_SAVE_EXTENSIONS = new Set(['txt', 'json', 'md', 'csv', 'html', 'pdf', 'svg', 'png', 'zip', 'xlsx', 'docx'])

function artifactHost(): ArtifactHost | null {
  if (typeof window === 'undefined') return null
  const c = (window as unknown as { claude?: ArtifactHost }).claude
  return c && typeof c.use === 'function' ? c : null
}

export function downloadFile(filename: string, content: string | Blob, mime = 'text/plain;charset=utf-8'): boolean {
  // Inside the claude.ai artifact viewer, plain download links do nothing: offer the file through
  // the viewer's downloads capability (the viewer confirms). Types it does not allow (.ics) return
  // false so the caller shows its Copy fallback.
  const host = artifactHost()
  if (host) {
    const ext = filename.split('.').pop()?.toLowerCase() ?? ''
    if (!ARTIFACT_SAVE_EXTENSIONS.has(ext)) return false
    void host
      .use('downloads')
      .then((d) => d?.save({ filename, data: content }))
      .catch(() => {
        /* declined or unavailable: the caller's Copy option still works */
      })
    return true
  }
  try {
    const blob = typeof content === 'string' ? new Blob([content], { type: mime }) : content
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    return true
  } catch {
    return false
  }
}

function csvCell(v: unknown): string {
  if (v == null) return ''
  const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Builds CSV text from rows and an ordered column list. */
export function toCSV<T>(rows: T[], columns: Array<{ header: string; value: (row: T) => unknown }>): string {
  const head = columns.map((c) => csvCell(c.header)).join(',')
  const body = rows.map((r) => columns.map((c) => csvCell(c.value(r))).join(','))
  return [head, ...body].join('\r\n')
}

/** Safe filename stem from a label: "Offer letter - Mei Tanaka" -> "offer-letter-mei-tanaka" */
export function slug(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .slice(0, 80)
}

/**
 * Opens a print view of the given HTML in a new window (offer letters, notices, board packets).
 * Returns false when pop-ups or printing are blocked; callers then offer Copy or Download instead.
 */
export function printHTML(title: string, bodyHTML: string): boolean {
  try {
    const w = window.open('', '_blank', 'noopener=no,width=820,height=1000')
    if (!w) return false
    w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHTML(title)}</title>
<style>
  body{font-family:Georgia,'Times New Roman',serif;color:#111;max-width:7in;margin:0.8in auto;line-height:1.55;font-size:12pt}
  h1,h2,h3{font-family:Arial,Helvetica,sans-serif}
  h1{font-size:18pt;margin:0 0 .3in} h2{font-size:13pt;margin:.3in 0 .1in}
  table{border-collapse:collapse;width:100%;margin:.1in 0} td,th{border:1px solid #bbb;padding:4pt 6pt;text-align:left;font-size:11pt}
  .muted{color:#555;font-size:10pt} .sig{margin-top:.6in;display:flex;gap:.6in} .sig div{flex:1;border-top:1px solid #333;padding-top:4pt;font-size:10pt}
  @media print{body{margin:0.6in}}
</style></head><body>${bodyHTML}</body></html>`)
    w.document.close()
    w.focus()
    setTimeout(() => {
      try {
        w.print()
      } catch {
        /* printing blocked; the window still shows the document */
      }
    }, 250)
    return true
  } catch {
    return false
  }
}

export function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/** Reads a user-picked file as text. */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ''))
    r.onerror = () => reject(r.error)
    r.readAsText(file)
  })
}
