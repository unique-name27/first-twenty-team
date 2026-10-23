// Copies the one-file build to the project root as first-twenty.html (next to "Launch First Twenty.bat").
import { copyFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'dist-single', 'index.html')
if (!existsSync(src)) {
  console.error('dist-single/index.html not found')
  process.exit(1)
}
copyFileSync(src, path.join(root, 'first-twenty.html'))
console.log('Wrote first-twenty.html')
