// Ledgerlark sample: hiring. See docs/SAMPLE.md. Plan slots, historical filled jobs for hires 2-17,
// the open jobs and pipelines, offers, interviews and scorecards, and the two incoming hires (Lucas
// Ferreira, Mei Tanaka) run through the real Hire flow. Runs last in the composer (index.ts).
// The builder lives in ./hiring/build.ts; data in ./hiring/catalog.ts and ./hiring/pools.ts.
// Module rule: no module-level runtime constants (the seed can run while the store is loading).
import type { Draft } from 'immer'
import { SAMPLE_ROLE_TEMPLATES } from '@/data/roleTemplates'
import type { DB } from '@/domain/types'
import { buildHiring } from './hiring/build'

export function applyHiring(d: Draft<DB>): void {
  // Ledgerlark's own role templates (its product's roles and interview loops) replace the company-neutral
  // starters blankDB put in; the jobs below are built from them.
  d.settings.roleTemplates = structuredClone(SAMPLE_ROLE_TEMPLATES)
  buildHiring(d)
}
