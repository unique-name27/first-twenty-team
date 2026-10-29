// Small helpers the generator and the time machine share: which name pool a role draws from, and the plain
// form of a name for an email address. Kept apart from generate.ts, so the time machine never loads the
// generator, its scenarios or its summaries.
import type { ProfileKey } from '@/data/seed/hiring/pools'

/** The profile (titles, employers, scorecard notes in pools.ts) for a role template. */
export function profileFor(plan: { template: string; title?: string }): ProfileKey {
  if (plan.title === 'Office coordinator') return 'coord'
  const by: Record<string, ProfileKey> = {
    'rt-fullstack': 'eng',
    'rt-ml': 'ml',
    'rt-designer': 'design',
    'rt-pm': 'pm',
    'rt-ae-founding': 'ae',
    'rt-csm': 'csm',
    'rt-solutions': 'solutions',
    'rt-finance': 'acct',
    'rt-ops-people': 'ops',
  }
  return by[plan.template] ?? 'eng'
}

/** Lowercase letters and digits only: 'José Núñez' is 'josenunez'. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '')
}
