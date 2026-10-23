// Seeds a team repo with the project's labels, milestones and starter issues (starter-issues.json),
// using the GitHub CLI. Safe to run again: labels are updated in place, and milestones and issues that
// already exist (same title) are skipped.
//
//   node scripts/team/seed-issues.mjs --repo your-org/first-twenty [--dry-run]
//
// Needs `gh` signed in with access to the repo (gh auth status).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const repo = args[args.indexOf('--repo') + 1]
const dryRun = args.includes('--dry-run')
if (!args.includes('--repo') || !repo || repo.startsWith('--') || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('Usage: node scripts/team/seed-issues.mjs --repo owner/name [--dry-run]')
  process.exit(2)
}

const plan = JSON.parse(readFileSync(new URL('./starter-issues.json', import.meta.url), 'utf8'))

const gh = (ghArgs, input) =>
  execFileSync('gh', ghArgs, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] })

const act = (what, ghArgs, input) => {
  console.log(`${dryRun ? '[dry run] ' : ''}${what}`)
  if (!dryRun) gh(ghArgs, input)
}

for (const l of plan.labels) {
  act(`label: ${l.name}`, ['label', 'create', l.name, '--repo', repo, '--color', l.color, '--description', l.description, '--force'])
}

const milestones = new Set(
  JSON.parse(gh(['api', `repos/${repo}/milestones?state=all&per_page=100`])).map((m) => m.title),
)
for (const m of plan.milestones) {
  if (milestones.has(m.title)) console.log(`milestone exists: ${m.title}`)
  else act(`milestone: ${m.title}`, ['api', `repos/${repo}/milestones`, '-f', `title=${m.title}`])
}

const issues = new Set(
  JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '1000', '--json', 'title'])).map((i) => i.title),
)
for (const i of plan.issues) {
  if (issues.has(i.title)) {
    console.log(`issue exists: ${i.title}`)
    continue
  }
  const labelArgs = i.labels.flatMap((l) => ['--label', l])
  const milestoneArgs = i.milestone ? ['--milestone', i.milestone] : []
  act(`issue: ${i.title}`, ['issue', 'create', '--repo', repo, '--title', i.title, '--body-file', '-', ...labelArgs, ...milestoneArgs], i.body)
}

console.log(dryRun ? 'Dry run finished; nothing was changed.' : 'Done.')
