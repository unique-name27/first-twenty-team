// Starts the First Twenty server (serve.ts). The production build (vite.server.config.ts) bundles this
// file, and `npm run server:dev` runs it. `npm run stack` starts server/src/dev/index.ts instead: the same
// server plus development-only routes. Never import server/src/dev here or in app.ts
// (server/src/dev/structure.test.ts checks).
import { startServer } from './serve'

startServer()
