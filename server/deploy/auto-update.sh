#!/usr/bin/env bash
# First Twenty: automatic deploys that the server pulls from the public GitHub repo.
#
# setup-auto-deploy.sh installs this file as /usr/local/bin/first-twenty-autoupdate, and two systemd timers
# run it every 5 minutes (docs/SERVER.md, "Automatic deploys from GitHub"):
#
#   first-twenty-autoupdate staging   as first-twenty-staging: the newest commit on main, once its "verify"
#                                     check passed, to the staging copy in /opt/first-twenty-staging
#   first-twenty-autoupdate live      as the login that owns /opt/first-twenty: the newest GitHub release,
#                                     when the product owner published it, it is not a draft or prerelease,
#                                     its commit is on main and that commit's "verify" check passed
#   first-twenty-autoupdate live --record-deployed
#                                     records the commit checked out in /opt/first-twenty as the one that
#                                     is live (after a deploy or rollback by hand); staging takes it too
#
# Each run stops at once when its channel is paused (/etc/first-twenty-staging/autodeploy.paused or
# /etc/first-twenty/autodeploy.paused exists). Otherwise it asks GitHub what is newest and, when that is a
# commit it has not deployed, whose check passed and that has not failed 3 deploys already, checks it out
# (detached, fetched by its exact commit) and runs deploy.sh from it: for live, the usual backup before
# migrations, health checks and the way back on failure. A commit that fails is tried again on the next
# runs, 3 times in all; a newer commit or release starts over.
#
# GitHub's API is called without a token, which allows 60 requests an hour from this instance's address.
# Each run sends the ETag of the last answer (If-None-Match), so an unchanged answer is a short 304; it
# asks for check runs only for a commit whose result it does not know yet (and, after a failed check, at
# most every 30 minutes, in case CI was re-run); and when GitHub says the limit is used up it waits for the
# reset. A normal run sends one request, a few more when something changed. git fetches over HTTPS, which
# that limit does not count. Nothing secret is read, stored or logged.
#
# State lives in "state" in the channel's state folder (key=value lines): the deployed commit, commits that
# failed and how often, ETags. Deleting it is safe: live then counts the checked-out commit as deployed,
# and staging deploys main again.
#
# Settings, from the environment (the systemd units set the ones that differ from these defaults):
#   FT_REPO            owner/name of the GitHub repo (default unique-name27/first-twenty-team)
#   FT_RELEASE_AUTHOR  the only GitHub login whose releases go live (default unique-name27)
#   FT_CHECK_NAME      the CI check that must have passed (default verify)
#   FT_CHECK_APP       the GitHub App that must have reported it (default github-actions)
#   FT_MAX_TRIES       deploys of one commit before giving up on it (default 3)
#   FT_APP_DIR, FT_STATE_DIR, FT_PAUSE_FILE, FT_GIT_URL, FT_NODE   other folders and commands (for tests)

set -euo pipefail

REPO=${FT_REPO:-unique-name27/first-twenty-team}
RELEASE_AUTHOR=${FT_RELEASE_AUTHOR:-unique-name27}
CHECK_NAME=${FT_CHECK_NAME:-verify}
CHECK_APP=${FT_CHECK_APP:-github-actions}
MAX_TRIES=${FT_MAX_TRIES:-3}
API=${FT_GITHUB_API:-https://api.github.com}
GIT_URL=${FT_GIT_URL:-https://github.com/$REPO.git}
NODE=${FT_NODE:-node}
# After a failed check, ask again at most this often (a re-run in CI can still turn it green).
FAILED_RECHECK_SECONDS=1800
# How long live waits for a staging build to finish before it builds itself (the instance has 1 GB of memory).
OTHER_WAIT_SECONDS=${FT_OTHER_WAIT_SECONDS:-1800}

CHANNEL=""
RECORD=false

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '%s: %s\n' "${CHANNEL:-autoupdate}" "$*"; }
usage() { sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    staging | live)
      [ -z "$CHANNEL" ] || die "Say one channel: staging or live."
      CHANNEL=$1
      ;;
    --record-deployed) RECORD=true ;;
    -h | --help) usage; exit 0 ;;
    *) die "Unknown argument: $1. Run with --help for usage." ;;
  esac
  shift
done
[ -n "$CHANNEL" ] || die "Say which channel to update: first-twenty-autoupdate staging (or live). Run with --help for usage."

case "$CHANNEL" in
  staging)
    APP_DIR=${FT_APP_DIR:-/opt/first-twenty-staging}
    STATE_DIR=${FT_STATE_DIR:-/var/lib/first-twenty-staging/autoupdate}
    PAUSE_FILE=${FT_PAUSE_FILE:-/etc/first-twenty-staging/autodeploy.paused}
    OTHER_UNIT=first-twenty-autoupdate-live.service
    DEPLOY_ARGS=(--instance staging --no-pull)
    DEPLOY_LOCK="${TMPDIR:-/tmp}/first-twenty-staging-deploy.lock"
    ;;
  live)
    APP_DIR=${FT_APP_DIR:-/opt/first-twenty}
    STATE_DIR=${FT_STATE_DIR:-/var/lib/first-twenty-autoupdate}
    PAUSE_FILE=${FT_PAUSE_FILE:-/etc/first-twenty/autodeploy.paused}
    OTHER_UNIT=first-twenty-autoupdate-staging.service
    DEPLOY_ARGS=(--no-pull)
    # The lock deploy.sh takes, so a deploy started by hand and this one never overlap.
    DEPLOY_LOCK="${TMPDIR:-/tmp}/first-twenty-deploy.lock"
    ;;
esac

[[ $REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "FT_REPO must look like owner/name, not $REPO."
[[ $RELEASE_AUTHOR =~ ^[A-Za-z0-9-]+$ ]] || die "FT_RELEASE_AUTHOR must be a GitHub login, not $RELEASE_AUTHOR."
[[ $MAX_TRIES =~ ^[1-9][0-9]*$ ]] || die "FT_MAX_TRIES must be a whole number above 0."
[ "$(id -u)" -ne 0 ] || die "Run this as the $CHANNEL deploy user, not root (the systemd unit does; by hand: sudo -u <user> first-twenty-autoupdate $CHANNEL)."
[ -d "$STATE_DIR" ] && [ -w "$STATE_DIR" ] || die "$STATE_DIR is missing or not writable for $(id -un). Run: sudo bash server/deploy/setup-auto-deploy.sh"
[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout. Run: sudo bash server/deploy/setup-auto-deploy.sh"
command -v git >/dev/null 2>&1 || die "git is not installed."
command -v curl >/dev/null 2>&1 || die "curl is not installed."
command -v "$NODE" >/dev/null 2>&1 || die "node is not installed (it reads GitHub's answers)."

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# One run at a time: the timer never starts a second one, but a run started by hand could overlap it.
exec 8>"$STATE_DIR/lock"
if ! flock -n 8; then
  log "another run is still going; skipping this one."
  exit 0
fi

# ------------------------------------------------------------------------------------------------
# State: key=value lines, read without evaluating anything.
# ------------------------------------------------------------------------------------------------

STATE_FILE=$STATE_DIR/state
declare -A STATE=()
if [ -f "$STATE_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; *=*) ;; *) continue ;; esac
    key=${line%%=*}
    [[ $key =~ ^[a-z_]+$ ]] && STATE[$key]=${line#*=}
  done <"$STATE_FILE"
fi

save_state() {
  local key tmp="$STATE_FILE.tmp"
  {
    echo "# First Twenty $CHANNEL auto-deploy state, written by first-twenty-autoupdate. Safe to delete."
    for key in $(printf '%s\n' "${!STATE[@]}" | sort); do
      printf '%s=%s\n' "$key" "${STATE[$key]}"
    done
  } >"$tmp"
  mv -f "$tmp" "$STATE_FILE"
}

is_sha() { [[ ${1:-} =~ ^[0-9a-f]{40}$ ]]; }
short() { printf '%s' "${1:0:7}"; }
now() { date +%s; }

# Failed deploys per commit: "failed=<sha>:<count> ...", the 5 most recent.
fail_count() {
  local entry
  for entry in ${STATE[failed]:-}; do
    if [ "${entry%%:*}" = "$1" ]; then
      printf '%s' "${entry#*:}"
      return 0
    fi
  done
  printf 0
}
set_fail_count() {
  local entry list=""
  for entry in ${STATE[failed]:-}; do
    [ "${entry%%:*}" = "$1" ] || list="$list $entry"
  done
  [ "$2" -eq 0 ] || list="$list $1:$2"
  # shellcheck disable=SC2086
  list=$(printf '%s\n' $list | tail -n 5 | tr '\n' ' ')
  STATE[failed]=${list% }
}

# The commit that is deployed on this channel: the one recorded. Without a record, live counts the commit
# checked out in /opt/first-twenty (it has run there for a while), and staging counts none, so a fresh
# staging clone gets built and started on the first run.
deployed_sha() {
  if is_sha "${STATE[deployed_sha]:-}"; then
    printf '%s' "${STATE[deployed_sha]}"
  elif [ "$CHANNEL" = live ]; then
    git -C "$APP_DIR" rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null || true
  fi
}

# ------------------------------------------------------------------------------------------------
# --record-deployed
# ------------------------------------------------------------------------------------------------

if [ "$RECORD" = true ]; then
  head=$(git -C "$APP_DIR" rev-parse -q --verify 'HEAD^{commit}') || die "Cannot read the commit checked out in $APP_DIR."
  STATE[deployed_sha]=$head
  STATE[deployed_at]=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  set_fail_count "$head" 0
  save_state
  log "recorded $(short "$head") (checked out in $APP_DIR) as deployed."
  exit 0
fi

# ------------------------------------------------------------------------------------------------
# The pause switch
# ------------------------------------------------------------------------------------------------

# /etc/first-twenty is open only to root and the service's group, so the live login asks sudo (which it
# needs for deploy.sh anyway). If nobody can tell, nothing is deployed.
if [ -x "$(dirname "$PAUSE_FILE")" ]; then
  [ ! -e "$PAUSE_FILE" ] || { log "paused ($PAUSE_FILE exists); nothing checked. Remove that file to resume."; exit 0; }
elif sudo -n true 2>/dev/null; then
  ! sudo -n test -e "$PAUSE_FILE" || { log "paused ($PAUSE_FILE exists); nothing checked. Remove that file to resume."; exit 0; }
else
  log "cannot tell whether $PAUSE_FILE exists (no access to its folder, no sudo), so nothing is deployed."
  exit 1
fi

# ------------------------------------------------------------------------------------------------
# GitHub
# ------------------------------------------------------------------------------------------------

if [[ ${STATE[rate_reset]:-} =~ ^[0-9]+$ ]] && [ "${STATE[rate_reset]}" -gt "$(now)" ]; then
  log "GitHub's hourly limit for requests without a token is used up until $(date -u -d "@${STATE[rate_reset]}" +%H:%M:%SZ 2>/dev/null || echo "${STATE[rate_reset]}"); waiting."
  exit 0
fi

# The value of HTTP header $1 in header dump $2 (the last response, after any redirect), without the CR.
header_value() {
  { sed -n -E "s/^$1:[[:space:]]*//Ip" "$2" 2>/dev/null || true; } | tr -d '\r' | tail -n 1
}

# gh_get <name> <path> <accept> [etag]: one GET to the API. Sets GH_STATUS (000 when the request did not
# get an answer) and GH_ETAG; the body is in $WORK/<name>. Remembers when the hourly limit runs out.
gh_get() {
  local name=$1 url="$API$2" accept=$3 etag=${4:-} hdr="$WORK/$1.headers" remaining reset
  local args=(-sS --proto '=https' --tlsv1.2 --max-time 20 -H "Accept: $accept" -H 'X-GitHub-Api-Version: 2022-11-28'
    -H 'User-Agent: first-twenty-autoupdate' -D "$hdr" -o "$WORK/$name" -w '%{http_code}')
  [ -z "$etag" ] || args+=(-H "If-None-Match: $etag")
  : >"$hdr"
  GH_STATUS=$(curl "${args[@]}" "$url" 2>"$WORK/$name.err") || GH_STATUS=000
  [[ $GH_STATUS =~ ^[0-9]{3}$ ]] || GH_STATUS=000
  GH_ETAG=$(header_value etag "$hdr")
  remaining=$(header_value x-ratelimit-remaining "$hdr")
  reset=$(header_value x-ratelimit-reset "$hdr")
  if [ "$remaining" = 0 ] && [[ $reset =~ ^[0-9]+$ ]]; then
    STATE[rate_reset]=$reset
  fi
}

# Logs why a GitHub request gave no usable answer, and ends the run (nothing changed, so not a failure).
gh_gave_up() {
  case "$GH_STATUS" in
    000) log "could not reach GitHub for $1 ($(head -c 200 "$WORK/$2.err" 2>/dev/null | tr '\n' ' ')); trying again next run." ;;
    403 | 429) log "GitHub refused the request for $1 (HTTP $GH_STATUS, most likely the hourly limit); trying again later." ;;
    *) log "GitHub answered HTTP $GH_STATUS for $1; trying again next run." ;;
  esac
  save_state
  exit 0
}

# check_state <sha>: sets CHECK to success, pending:<status> or failure:<conclusion> for check
# FT_CHECK_NAME on that commit, as reported by FT_CHECK_APP (the newest such check run counts). Called
# directly, never in $( ), so what it learns stays in STATE.
check_state() {
  local sha=$1 etag=""
  if [ "${STATE[checks_sha]:-}" = "$sha" ]; then
    case "${STATE[checks_state]:-}" in
      success)
        CHECK=success
        return 0
        ;;
      failure:*)
        if [[ ${STATE[checks_at]:-} =~ ^[0-9]+$ ]] && [ $(($(now) - ${STATE[checks_at]})) -lt "$FAILED_RECHECK_SECONDS" ]; then
          CHECK=${STATE[checks_state]}
          return 0
        fi
        ;;
    esac
    etag=${STATE[checks_etag]:-}
  fi
  gh_get checks "/repos/$REPO/commits/$sha/check-runs?check_name=$CHECK_NAME&filter=latest" 'application/vnd.github+json' "$etag"
  case "$GH_STATUS" in
    200)
      CHECK=$("$NODE" -e '
const [name, app, sha] = process.argv.slice(1)
const data = JSON.parse(require("fs").readFileSync(0, "utf8"))
const runs = (data.check_runs || [])
  .filter((r) => r.name === name && r.head_sha === sha && (!app || (r.app && r.app.slug === app)))
  .sort((a, b) => b.id - a.id)
const run = runs[0]
if (!run) console.log("pending:not-started")
else if (run.status !== "completed") console.log("pending:" + String(run.status).replace(/[^a-z_]/g, ""))
else if (run.conclusion === "success") console.log("success")
else console.log("failure:" + String(run.conclusion).replace(/[^a-z_]/g, ""))
' "$CHECK_NAME" "$CHECK_APP" "$sha" <"$WORK/checks")
      STATE[checks_sha]=$sha
      STATE[checks_state]=$CHECK
      STATE[checks_etag]=$GH_ETAG
      ;;
    304) CHECK=${STATE[checks_state]:-pending:unknown} ;;
    *) gh_gave_up "the $CHECK_NAME check of $(short "$sha")" checks ;;
  esac
  STATE[checks_at]=$(now)
}

# ------------------------------------------------------------------------------------------------
# What is newest
# ------------------------------------------------------------------------------------------------

DEPLOYED=$(deployed_sha)
TARGET=""
TARGET_TAG=""
WHAT=""

if [ "$CHANNEL" = staging ]; then
  # The sha media type answers with the commit id alone (40 characters), and 304 when it equals the ETag.
  etag=""
  ! is_sha "${STATE[head_sha]:-}" || etag=${STATE[head_etag]:-}
  gh_get head "/repos/$REPO/commits/main" 'application/vnd.github.sha' "$etag"
  case "$GH_STATUS" in
    200)
      head=$(tr -d '[:space:]' <"$WORK/head")
      is_sha "$head" || { log "GitHub's answer for main is not a commit id; trying again next run."; exit 0; }
      STATE[head_sha]=$head
      STATE[head_etag]=$GH_ETAG
      ;;
    304) head=${STATE[head_sha]} ;;
    *) gh_gave_up "main" head ;;
  esac
  TARGET=$head
  WHAT="main at $(short "$head")"
else
  etag=""
  [ -z "${STATE[release_id]:-}" ] || etag=${STATE[release_etag]:-}
  gh_get release "/repos/$REPO/releases/latest" 'application/vnd.github+json' "$etag"
  case "$GH_STATUS" in
    200)
      release_etag=$GH_ETAG
      release=$("$NODE" -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"))
const clean = (v) => String(v ?? "").replace(/[\r\n=]/g, " ").slice(0, 200)
console.log(["id=" + clean(r.id), "tag=" + clean(r.tag_name), "draft=" + clean(r.draft),
  "prerelease=" + clean(r.prerelease), "author=" + clean(r.author && r.author.login)].join("\n"))
' <"$WORK/release")
      rel_id=$(printf '%s\n' "$release" | sed -n 's/^id=//p')
      rel_tag=$(printf '%s\n' "$release" | sed -n 's/^tag=//p')
      rel_draft=$(printf '%s\n' "$release" | sed -n 's/^draft=//p')
      rel_pre=$(printf '%s\n' "$release" | sed -n 's/^prerelease=//p')
      rel_author=$(printf '%s\n' "$release" | sed -n 's/^author=//p')
      STATE[release_etag]=""
      STATE[release_sha]=""
      STATE[release_id]=$rel_id
      STATE[release_tag]=$rel_tag
      if [ "$rel_author" != "$RELEASE_AUTHOR" ]; then
        STATE[release_skip]="it was published by ${rel_author:-nobody we know}, and only $RELEASE_AUTHOR's releases go live"
      elif [ "$rel_draft" != false ] || [ "$rel_pre" != false ]; then
        STATE[release_skip]="it is a draft or a prerelease"
      elif ! [[ $rel_tag =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] || ! git check-ref-format "refs/tags/$rel_tag"; then
        STATE[release_skip]="its tag name is not one this script accepts (letters, digits, dots, dashes and underscores, like v2026.11.04)"
      else
        STATE[release_skip]=""
        # The commit the tag points at, as a 40-character id.
        gh_get tag "/repos/$REPO/commits/$rel_tag" 'application/vnd.github.sha'
        [ "$GH_STATUS" = 200 ] || gh_gave_up "the commit of tag $rel_tag" tag
        rel_sha=$(tr -d '[:space:]' <"$WORK/tag")
        is_sha "$rel_sha" || { log "GitHub's answer for tag $rel_tag is not a commit id; trying again next run."; exit 0; }
        STATE[release_sha]=$rel_sha
      fi
      # Store the ETag last, so an answer that was not fully handled is asked for again next time.
      STATE[release_etag]=$release_etag
      ;;
    304) ;;
    404)
      log "no release has been published on $REPO yet; nothing to deploy."
      save_state
      exit 0
      ;;
    *) gh_gave_up "the latest release" release ;;
  esac
  if [ -n "${STATE[release_skip]:-}" ]; then
    log "the latest release (${STATE[release_tag]:-?}) is not deployed: ${STATE[release_skip]}."
    save_state
    exit 0
  fi
  TARGET=${STATE[release_sha]:-}
  TARGET_TAG=${STATE[release_tag]:-}
  is_sha "$TARGET" || { log "the latest release has no commit on record yet; trying again next run."; STATE[release_etag]=""; save_state; exit 0; }
  WHAT="release $TARGET_TAG ($(short "$TARGET"))"
fi

if [ "$TARGET" = "$DEPLOYED" ]; then
  log "$WHAT is already deployed; nothing to do."
  save_state
  exit 0
fi

if [ "${STATE[skip_sha]:-}" = "$TARGET" ]; then
  log "$WHAT is not deployed: ${STATE[skip_why]:-see the earlier runs}."
  save_state
  exit 0
fi

TRIES=$(fail_count "$TARGET")
if [ "$TRIES" -ge "$MAX_TRIES" ]; then
  if [ "$CHANNEL" = staging ]; then
    log "$WHAT failed to deploy $TRIES times; not trying again until a newer commit is on main."
  else
    log "$WHAT failed to deploy $TRIES times; not trying again until a newer release is published (or record a fix by hand with: first-twenty-autoupdate live --record-deployed)."
  fi
  save_state
  exit 0
fi

CHECK=""
check_state "$TARGET"
case "$CHECK" in
  success) ;;
  pending:*)
    log "$WHAT: the $CHECK_NAME check has not finished (${CHECK#pending:}); waiting."
    save_state
    exit 0
    ;;
  *)
    log "$WHAT is not deployed: its $CHECK_NAME check did not pass (${CHECK#failure:})."
    save_state
    exit 0
    ;;
esac

# ------------------------------------------------------------------------------------------------
# Deploy
# ------------------------------------------------------------------------------------------------

# The instance has about 1 GB of memory: one build at a time. Staging waits for its next run; live waits
# for the staging build to finish.
other_busy() { command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$OTHER_UNIT" 2>/dev/null; }
if [ "$CHANNEL" = staging ]; then
  if other_busy; then
    log "the live channel is running; deploying $WHAT on a later run."
    save_state
    exit 0
  fi
else
  waited=0
  while other_busy; do
    if [ "$waited" -ge "$OTHER_WAIT_SECONDS" ]; then
      log "staging is still deploying after $((waited / 60)) minutes; deploying $WHAT on a later run."
      save_state
      exit 0
    fi
    [ "$waited" -gt 0 ] || log "waiting for the staging deploy to finish first (one build at a time)."
    sleep 15
    waited=$((waited + 15))
  done
fi

# Fetched by exact refs from the public repo over HTTPS (no credentials), whatever origin says, then
# checked out detached: the live checkout's older history may differ, so git pull is never used.
refspecs=("+refs/heads/main:refs/remotes/origin/main")
[ -z "$TARGET_TAG" ] || refspecs+=("+refs/tags/$TARGET_TAG:refs/tags/$TARGET_TAG")
if ! GIT_TERMINAL_PROMPT=0 git -C "$APP_DIR" fetch --quiet --no-tags "$GIT_URL" "${refspecs[@]}"; then
  log "git fetch from $GIT_URL failed (see above); trying again next run."
  save_state
  exit 0
fi
if ! git -C "$APP_DIR" cat-file -e "$TARGET^{commit}" 2>/dev/null; then
  log "$WHAT is not in what git fetched; trying again next run."
  STATE[release_etag]=""
  save_state
  exit 0
fi
if [ -n "$TARGET_TAG" ] && [ "$(git -C "$APP_DIR" rev-parse -q --verify "refs/tags/$TARGET_TAG^{commit}" || true)" != "$TARGET" ]; then
  log "tag $TARGET_TAG no longer points at $(short "$TARGET"); reading the release again next run."
  STATE[release_etag]=""
  save_state
  exit 0
fi
# Only reviewed work goes out: every commit on main came through a pull request with CI and an approval.
if ! git -C "$APP_DIR" merge-base --is-ancestor "$TARGET" refs/remotes/origin/main; then
  STATE[skip_sha]=$TARGET
  STATE[skip_why]="its commit is not on main"
  log "$WHAT is not deployed: ${STATE[skip_why]}."
  save_state
  exit 0
fi
# Never go backwards: a release older than what runs now (say after a newer deploy by hand) is skipped.
if [ -n "$DEPLOYED" ] && git -C "$APP_DIR" merge-base --is-ancestor "$TARGET" "$DEPLOYED" 2>/dev/null; then
  STATE[skip_sha]=$TARGET
  STATE[skip_why]="the deployed commit $(short "$DEPLOYED") already contains it"
  log "$WHAT is not deployed: ${STATE[skip_why]}."
  save_state
  exit 0
fi
if [ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=no)" ]; then
  log "$APP_DIR has changes that are not committed, so $WHAT was not checked out. See: git -C $APP_DIR status"
  save_state
  exit 1
fi

exec 9>"$DEPLOY_LOCK"
if ! flock -n 9; then
  log "a deploy started by hand is running; deploying $WHAT on a later run."
  save_state
  exit 0
fi

TRY=$((TRIES + 1))
# The way back that deploy.sh prints: the deployed commit, else whatever was checked out before.
PREVIOUS=${DEPLOYED:-$(git -C "$APP_DIR" rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null || true)}
log "deploying $WHAT (try $TRY of $MAX_TRIES; deployed now: $(short "${DEPLOYED:-none}"))."
git -C "$APP_DIR" -c advice.detachedHead=false checkout --quiet --detach "$TARGET"
rc=0
(cd "$APP_DIR" && FT_DEPLOY_LOCK_HELD=1 FT_PREVIOUS_COMMIT="$PREVIOUS" bash server/deploy/deploy.sh "${DEPLOY_ARGS[@]}") || rc=$?
exec 9>&-

if [ "$rc" -eq 0 ]; then
  STATE[deployed_sha]=$TARGET
  STATE[deployed_at]=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  set_fail_count "$TARGET" 0
  save_state
  log "deployed $WHAT."
  if ! cmp -s "${BASH_SOURCE[0]}" "$APP_DIR/server/deploy/auto-update.sh"; then
    log "NOTE: this version changes server/deploy/auto-update.sh. Install it with: sudo bash $APP_DIR/server/deploy/setup-auto-deploy.sh"
  fi
  exit 0
fi

set_fail_count "$TARGET" "$TRY"
save_state
if [ "$TRY" -ge "$MAX_TRIES" ]; then
  log "deploy of $WHAT failed (try $TRY of $MAX_TRIES, output above); giving up on it until something newer appears."
else
  log "deploy of $WHAT failed (try $TRY of $MAX_TRIES, output above); trying again next run."
fi
if [ "$CHANNEL" = live ]; then
  log "To stop the retries and roll back: sudo touch $PAUSE_FILE, then follow the steps deploy.sh printed above."
fi
exit 1
