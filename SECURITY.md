# Security policy

First Twenty is open source, and this repo is public. Please report security problems privately, so they
can be fixed before anyone else can use them.

## How to report

Use private vulnerability reporting. On the repo's **Security** tab (it may be labeled "Security and
quality"), open **Advisories** and choose **Report a vulnerability**. The report stays private.

Never report a security problem in a public issue, a pull request, a discussion or a commit message. If
you are not sure whether something is a security problem, report it privately anyway.

## What to include

- What the problem is, and what an attacker could do with it.
- Steps to reproduce it on a local copy (`npm run server:dev`), using demo data only.
- The commit you tested, and the files involved if you know them.
- A suggested fix, if you have one.

Never put real people's data, passwords, keys or tokens in a report.

## What happens next

- The product owner gives the project one hour a week, so each report is acknowledged within seven days.
- The fix is developed in a temporary private fork made from the security advisory. CI does not run in
  that fork, so the fix is tested locally with `npm run verify` and reviewed before an admin merges it.
- The fix is released to the live server, and the advisory is published after that.

## Scope

- In scope: the code in this repo.
- The live demo server: only with the product owner's written permission first, and never with real
  data. A local copy is almost always enough.
- Team members test security only on local copies (`npm run server:dev`), never the live server, and only
  within the written scope the product owner has signed.
