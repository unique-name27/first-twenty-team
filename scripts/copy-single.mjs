// Copies the one-file build to the project root as first-twenty.html (next to "Launch First Twenty.bat").
// A build made with VITE_SIMULATOR=1 also has the simulator's worker, a file of its own: it goes next to
// first-twenty.html as first-twenty-sim-worker.js, and a build without the flag removes an old copy, so that file
// exists only beside a build that has the simulator (server/src/config.ts serves it only then).
import { copyFileSync, existsSync, rmSync } from 'node:fs'
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

const worker = path.join(root, 'dist-single', 'sim.worker.js')
const workerCopy = path.join(root, 'first-twenty-sim-worker.js')
if (existsSync(worker)) {
  copyFileSync(worker, workerCopy)
  console.log('Wrote first-twenty-sim-worker.js (the simulator is in this build)')
} else {
  rmSync(workerCopy, { force: true })
}
