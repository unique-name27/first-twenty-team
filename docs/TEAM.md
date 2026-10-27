# Setting up the team repo

The product owner's checklist for moving First Twenty into a shared, public repo for the team. The eight-week
project plan, roles and workflow live in the plan document; how to contribute is in `CONTRIBUTING.md`; how
to report a security problem is in `SECURITY.md`.

The shape: a GitHub organization owns one public, open-source repo, seeded from a clean snapshot of this
one (no old history), with the advisor as a co-owner. The live server then pulls from that repo, so there
is one source of truth. Replace `ORG` below with the organization's name.

Everything in the repo, its issues and its pull requests is public. That means no real people's data, no
names or details from founder usability sessions, no secrets, and no server addresses beyond the public
demo URLs already in the code.

GitHub Free covers what a public repo needs. Protected branches are available on public repos with GitHub
Free ([about protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)).
GitHub Actions, which runs CI, is free for public repos that use standard GitHub-hosted runners
([GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).

## 1. Create the organization

On GitHub: your profile menu > Your organizations > New organization > Free. Add the advisor as an owner.

## 2. Before going public

The repo is public from the moment it is created, so finish these first.

1. **Check the license is in place.** First Twenty is open source under the Apache License 2.0. Anyone
   may use, change, share and sell First Twenty, as long as they keep the license notice. The `LICENSE`
   file and the `"license": "Apache-2.0"` field in `package.json` are already in this repo, so the
   snapshot carries them. Confirm both are on the commit you will snapshot.
2. **Re-run the scan for secrets and personal data** on the commit you will snapshot. From this repo:

   ```bash
   git grep -nIE "BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk-ant-|amazonaws\.com|@(gmail|yahoo|outlook|hotmail)\.com" -- . ':!package-lock.json'
   ```

   Also search for the server's current and old IP addresses (with dots, and with dashes as in sslip.io
   host names), your own name and your email. Every hit must be a placeholder, a test string, invented
   data or the public demo address already in the code. The check on 2026-10-13 found one old server
   address in two tests in `server/deploy/deploy-kit.test.ts`; swap it for an invented one, as the other
   tests there do, before the snapshot.
3. **Consider the personal-email fixtures.** A few tests use invented names at gmail.com and yahoo.com
   addresses (`src/domain/hiring/parse.test.ts`, `src/domain/lifecycle.test.ts`). Example addresses
   (`example.com`) are safer in public. Some tests rely on gmail.com being a personal-email domain, so
   change them only with care, and run `npm run verify` afterwards.

## 3. Create the public repo and push the snapshot

From this repo, with a clean working tree. The new repo starts empty. The snapshot brings the `LICENSE`
file with it.

```bash
gh repo create ORG/first-twenty --public --description "ATS + HCM for a company's first twenty people"
git clone https://github.com/ORG/first-twenty.git ../first-twenty-team
git archive HEAD | tar -x -C ../first-twenty-team
cd ../first-twenty-team
git add -A
git -c user.name="unique-name27" -c user.email="73970734+unique-name27@users.noreply.github.com" commit -m "First Twenty: the starting point for the team"
git branch -M main
git push -u origin main
```

`git branch -M main` names the branch `main`, since an empty clone may start on `master`. The snapshot is
the new repo's first commit. None of this repo's history goes public.

Then set how pull requests merge (squash only, branches deleted after merge):

```bash
gh repo edit ORG/first-twenty --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false --delete-branch-on-merge
```

## 4. Turn on the security features and protect main

1. **Private vulnerability reporting.** The repo > Settings > Advanced Security > Private vulnerability
   reporting > Enable ([configuring private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository)).
   Reporters then see "Report a vulnerability" on the Security tab's Advisories page, which is where
   `SECURITY.md` sends them.
2. **Secret scanning** runs automatically for free on public repos
   ([about secret scanning](https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning)).
   Confirm it is on under Settings > Advanced Security. Its alerts appear on the Security tab. If it ever
   flags a real secret, rotate the secret first, then remove it.
3. **Protect main.** Protection on `main` is free for public repos (see the link above). The rule requires
   the CI check named `verify`, one approval, resolved conversations, and no force pushes. The product
   owner gives the project one hour a week, so CODEOWNERS names them only on the protected paths
   (migrations, the deploy kit, dependencies, CLAUDE.md, `.claude/`, `.github/`, the dev container and
   `scripts/dev/`); a pull request touching
   those also needs their approval. Admins can still merge in an emergency.

```bash
gh api -X PUT repos/ORG/first-twenty/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["verify"] },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": true,
    "dismiss_stale_reviews": true
  },
  "required_conversation_resolution": true,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

## 5. Invite the team

- Advisor: organization owner (step 1).
- Team members: add each as a collaborator with write access:
  `gh api -X PUT repos/ORG/first-twenty/collaborators/THEIR-USERNAME -f permission=push`

## 6. Labels, milestones and starter issues

```bash
node scripts/team/seed-issues.mjs --repo ORG/first-twenty --dry-run
node scripts/team/seed-issues.mjs --repo ORG/first-twenty
```

It creates the workstream labels, five milestones and 17 starter issues from `scripts/team/starter-issues.json`.
The milestones are first pull requests merged (week 1), the release 1 review (week 2), the release 2
review (week 4), the release 3 review (week 6) and the final review (week 8). The issues cover the core
work (must ship) and the stretch work, labeled `stretch`. Then make the board: the organization's Projects
tab > New project > Board, and add the repo's open issues.

The issues are public too. During the eight-week project, people outside the team may open issues; outside
pull requests are welcome after week 8 (see `CONTRIBUTING.md`).

Team members rotate through the workstreams every two weeks, then spend weeks 7 and 8 finishing their
rotation 3 workstream (see `CONTRIBUTING.md`). Each workstream's handover notes live in `docs/handover/`.

## 7. Point the live server at the team repo

The repo is public, so the server pulls from it over HTTPS with no deploy key, and SSH stays open to the
product owner's address only. On the server (SSH access stays with the product owner), from a fresh copy of
`main`:

```bash
git clone --depth 1 https://github.com/ORG/first-twenty.git ~/ft-setup
sudo bash ~/ft-setup/server/deploy/setup-auto-deploy.sh --dry-run --repo ORG/first-twenty
sudo bash ~/ft-setup/server/deploy/setup-auto-deploy.sh --repo ORG/first-twenty
rm -rf ~/ft-setup
```

Read what `--dry-run` prints before the real run. The installer switches the origin of `/opt/first-twenty`
to the team repo over HTTPS (keeping the old address as the remote `previous-origin`) and records the commit
that runs there now as deployed, so nothing changes on the live server until the product owner publishes a
release. It also moves Caddy's admin API to a Unix socket, so code on staging cannot change the live sites. It also sets up staging: a copy of the app at
`https://staging-77-112-161-54.sslip.io` (`--staging-domain` picks another name) that follows `main`, with
its own user, database and settings. `docs/SERVER.md`, "Automatic deploys from GitHub", explains each piece,
the pause switch and how to roll back.

From then on:

- **Merged work** appears on staging within minutes, once CI passes on `main`.
- **The product owner releases** by publishing a GitHub release (Releases > Draft a new release, a new tag
  on `main`, Publish release). The live server deploys it within 5 minutes of its commit passing CI, with a
  database backup first when migrations are pending.

The snapshot has a new history, so the server fetches each release by its exact commit and checks it out
detached; it never runs `git pull`. Archive the old private repo once the server has deployed a release from
the new one.
