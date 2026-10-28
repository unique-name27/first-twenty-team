// The test tiers: one Vitest project each (vite.config.ts), one npm script each (CONTRIBUTING.md, "Tests").
// Every *.test.ts file belongs to exactly one tier; tiers.test.ts fails when a new file belongs to none or
// to two, so no test can quietly stop running.
//
//   unit    npm run test:unit    No database and no server: the app's logic and the scripts.
//   server  npm run test:server  The API on in-memory PGlite, driven with app.inject().
//   e2e     npm run test:e2e     Journeys through the real API: server/src/e2e, and the sync tests that
//                                drive browsers' sync engines against it.
//   deploy  npm run test:deploy  The deploy kit's bash scripts: seconds on Linux, minutes on Windows.
//
// `npm test` runs all four. `npm run verify` runs the first three; the deploy kit has its own CI job.

export type TierName = 'unit' | 'server' | 'e2e' | 'deploy'

export type Tier = {
  name: TierName
  /** Globs from the repo root, as Vitest's `include` takes them. */
  include: string[]
  /** Globs left out of `include` (Vitest's own default excludes are added in vite.config.ts). */
  exclude: string[]
}

/**
 * Tests under src/ that start the real API server (server/src/test/helpers.ts) and sync browsers' engines
 * against it, so they belong with the journeys, not the unit tests. Chosen by what each file does, not by
 * its name: tiers.test.ts checks that a file under src/ or scripts/ reaches into server/src exactly when it
 * is listed here.
 */
export const SERVER_DRIVEN_TESTS = ['src/sync/roundtrip.test.ts', 'src/sync/demo.roundtrip.test.ts']

export const TIERS: Tier[] = [
  { name: 'unit', include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'], exclude: SERVER_DRIVEN_TESTS },
  { name: 'server', include: ['server/src/**/*.test.ts'], exclude: ['server/src/e2e/**'] },
  { name: 'e2e', include: ['server/src/e2e/**/*.test.ts', ...SERVER_DRIVEN_TESTS], exclude: [] },
  { name: 'deploy', include: ['server/deploy/**/*.test.ts'], exclude: [] },
]
