// The development server, which `npm run stack` starts (scripts/dev/stack.mjs) in place of
// server/src/index.ts: the same server (serve.ts), plus the development-only routes in this folder
// (routes.ts: POST /__dev/sql for npm run sql). Nothing in production starts or bundles it:
// vite.server.config.ts builds server/src/index.ts, and neither that file nor app.ts imports this folder
// (structure.test.ts checks both).
//
// The routes need DEV_TOOLS=1, which config.ts refuses in production, and DEV_TOOLS_SECRET, the secret the
// stack made for this run and also wrote to <data folder>/dev-tools.json for npm run sql. Without them it
// runs as server/src/index.ts would, and says why.
import { ConfigError } from '../errors'
import { startServer } from '../serve'
import { MIN_SECRET_LENGTH, registerDevRoutes } from './routes'

startServer({
  checkConfig(config) {
    if (config.nodeEnv === 'production') throw new ConfigError('server/src/dev/index.ts is the development server. Production runs server/src/index.ts.')
  },
  async beforeListen(app, { db, config }) {
    const secret = process.env.DEV_TOOLS_SECRET?.trim() ?? ''
    if (!config.devTools) console.warn('[first-twenty] DEV_TOOLS is not set, so the dev routes are off (npm run stack sets it).')
    else if (secret.length < MIN_SECRET_LENGTH) console.warn('[first-twenty] DEV_TOOLS_SECRET is missing or short, so the dev routes are off (npm run stack sets it).')
    else await registerDevRoutes(app, { db, secret })
  },
})
