#!/usr/bin/env bash
# First Twenty: update the server on EC2 to the latest code.
#
# Run it on the instance as the login that owns the code (ubuntu or ec2-user), not with sudo, in the
# folder the service runs (/opt/first-twenty). It refuses to run from any other copy of the code:
#   cd /opt/first-twenty
#   bash server/deploy/deploy.sh                               git pull, then everything below
#   bash server/deploy/deploy.sh --no-pull                     the code is already in place
#   bash server/deploy/deploy.sh --archive ~/first-twenty.tgz  unpack a code archive first (no git needed)
#   bash server/deploy/deploy.sh --skip-backup                 migrate without a fresh backup (not advised)
#   bash server/deploy/deploy.sh --ignore-scripts              npm ci without package install scripts
#
# Steps: get the code, npm ci, npm run build:all, check for pending migrations, back up the database
# when there are any (sudo systemctl start first-twenty-backup), npm run server:migrate (with the
# settings from /etc/first-twenty/env), restart the service, then check /api/health locally and through
# Caddy. If a step fails it stops there; the server keeps running the version it already loaded. A step
# that fails before the restart also puts the folder back as that version left it: the build it had
# (kept with hard links in .deploy-prev until the deploy is done) and the commit that ran before. When a
# migration ran and the new server is not healthy, it prints the way back, with the file name of the
# backup it took just before migrating. A backup that wrote its local dump but then failed (the copy to
# S3) does not stop the deploy: that dump is the way back, and the script warns. HEALTH_URL and
# HEALTH_WAIT_SECONDS (default 30) change the health check, for example:
#   HEALTH_WAIT_SECONDS=90 bash server/deploy/deploy.sh
#
# With automatic deploys set up (first-twenty-autoupdate), the folder always sits on a detached commit.
# Deploy a commit by hand there by pausing the channel, then: git fetch origin, git checkout --detach
# <commit>, bash server/deploy/deploy.sh --no-pull, first-twenty-autoupdate live --record-deployed (the
# script prints these steps when it stops). Without automatic deploys, after a rollback with git checkout
# <commit>, run git switch main (or your branch) before the next plain deploy: until then git pull has no
# branch to update, and this script stops and says so. Started by hand, it first waits while the other
# channel's updater is building (one build at a time on this instance).
#
# Staging (--instance staging; docs/SERVER.md, "Automatic deploys from GitHub") is the copy in
# /opt/first-twenty-staging, deployed by first-twenty-autoupdate as the first-twenty-staging user:
#   cd /opt/first-twenty-staging && bash server/deploy/deploy.sh --instance staging --no-pull
# It restarts first-twenty-staging, takes no backup and installs with --ignore-scripts. That user may run
# exactly two commands with sudo (setup-auto-deploy.sh allows them): starting first-twenty-staging-migrate,
# which migrates with the owner password only root can read, and restarting first-twenty-staging. It cannot
# read /etc/first-twenty-staging/env either, so the port, address and app file it checks come from
# FT_PORT (default 8788), FT_PUBLIC_ORIGIN and FT_APP_FILE.
#
# Copying code without git, from your computer (Git Bash or PowerShell, in the project folder):
#   git archive --format=tar.gz -o first-twenty.tgz HEAD
#   scp -i your-key.pem first-twenty.tgz ubuntu@your-domain:~
#   ssh -i your-key.pem ubuntu@your-domain "cd /opt/first-twenty && bash server/deploy/deploy.sh --archive ~/first-twenty.tgz"
# (git archive packs only committed files.) With rsync on both ends you can push the folder instead:
#   rsync -az --delete --exclude node_modules --exclude .git --exclude .env --exclude .data \
#     ./ ubuntu@your-domain:/opt/first-twenty/   and then run deploy.sh --no-pull

set -euo pipefail
umask 022

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
APP_DIR=$(cd "$SCRIPT_DIR/../.." && pwd -P)
SERVICE=first-twenty
BACKUP_SERVICE=first-twenty-backup
ENV_FILE=${FIRST_TWENTY_ENV:-/etc/first-twenty/env}

PULL=true
ARCHIVE=""
SKIP_BACKUP=false
INSTANCE=live
IGNORE_SCRIPTS=false

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --no-pull) PULL=false; shift ;;
    --archive)
      [ -n "${2:-}" ] || die "--archive needs the path to a .tgz file."
      ARCHIVE=$2
      shift 2
      ;;
    --archive=*) ARCHIVE=${1#*=}; shift ;;
    --skip-backup) SKIP_BACKUP=true; shift ;;
    --ignore-scripts) IGNORE_SCRIPTS=true; shift ;;
    --instance)
      [ -n "${2:-}" ] || die "--instance needs live or staging."
      INSTANCE=$2
      shift 2
      ;;
    --instance=*) INSTANCE=${1#*=}; shift ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1. Run with --help for usage." ;;
  esac
done

# What differs between the live server and the staging copy. AUTODEPLOY_STATE is the updater's state file
# (auto-update.sh): when it exists, this folder is deployed automatically, and the hints below give the
# steps for a deploy by hand there. OTHER_UPDATER is the other channel's updater, which a deploy started
# by hand waits for.
UNIT_FILE=first-twenty.service
DEFAULT_PORT=8787
LOCK_FILE="${TMPDIR:-/tmp}/first-twenty-deploy.lock"
AUTODEPLOY_STATE=${FT_AUTODEPLOY_STATE:-/var/lib/first-twenty-autoupdate/state}
PAUSE_FILE=/etc/first-twenty/autodeploy.paused
OTHER_UPDATER=first-twenty-autoupdate-staging.service
case "$INSTANCE" in
  live) ;;
  staging)
    SERVICE=first-twenty-staging
    BACKUP_SERVICE=""
    ENV_FILE=${FIRST_TWENTY_ENV:-/etc/first-twenty-staging/env}
    UNIT_FILE=first-twenty-staging.service
    MIGRATE_SERVICE=first-twenty-staging-migrate.service
    DEFAULT_PORT=8788
    # In the staging user's own folder, not /tmp: the updater's unit has a private /tmp, and a deploy
    # started by hand must take the same lock as the updater (auto-update.sh takes it before checking out).
    LOCK_FILE=${FT_STAGING_LOCK:-/var/lib/first-twenty-staging/deploy.lock}
    IGNORE_SCRIPTS=true
    AUTODEPLOY_STATE=${FT_AUTODEPLOY_STATE:-/var/lib/first-twenty-staging/autoupdate/state}
    PAUSE_FILE=/etc/first-twenty-staging/autodeploy.paused
    OTHER_UPDATER=first-twenty-autoupdate-live.service
    ;;
  *) die "--instance must be live or staging, not $INSTANCE." ;;
esac

# What npm ci and npm run build:all replace, and the running server reads when it starts: node_modules
# (the server bundle loads fastify, pg and the other runtime packages from there), dist-server (server.mjs,
# its chunks and the migrations) and the app file, which scripts/copy-single.mjs copies from dist-single.
# Before npm ci they are kept in .deploy-prev (gitignored), so a failure before the restart can put them
# back. Hard links make that copy cheap, and they are safe here because nothing writes into the old files:
# npm ci deletes everything in node_modules before it installs, and Vite empties dist-server and
# dist-single (emptyOutDir) before it writes new files. first-twenty.html is the exception: copyFileSync
# overwrites it in place, which would change a hard-linked copy too, so it is copied for real.
PREV_DIR=$APP_DIR/.deploy-prev
BUILD_PATHS=(node_modules dist-server dist-single first-twenty.html)

# The folder the installed service runs its code from (WorkingDirectory= in its unit), or nothing when
# the unit is not installed or systemd cannot say. systemctl marks a folder that may be missing with "!".
service_code_dir() {
  local load dir
  command -v systemctl >/dev/null 2>&1 || return 0
  load=$(systemctl show -p LoadState --value "$SERVICE" 2>/dev/null || true)
  [ "$load" = loaded ] || return 0
  dir=$(systemctl show -p WorkingDirectory --value "$SERVICE" 2>/dev/null || true)
  printf '%s' "${dir#!}"
}

[ "$(id -u)" -ne 0 ] || die "Run deploy.sh as the login that owns $APP_DIR (for example ubuntu), not with sudo."
[ -f "$APP_DIR/package.json" ] || die "$APP_DIR does not look like the First Twenty code."

# Building and migrating in another copy of the code (say the setup clone in ~/first-twenty) would
# change the production database and then restart the service on the old code it still runs.
CODE_DIR=$(service_code_dir)
if [ -z "$CODE_DIR" ]; then
  info "The $SERVICE service is not installed yet, so its code folder was not checked (setup-ec2.sh installs it)."
else
  CODE_REAL=$(cd "$CODE_DIR" 2>/dev/null && pwd -P) || CODE_REAL=$CODE_DIR
  [ "$CODE_REAL" = "$APP_DIR" ] ||
    die "This copy of the code is in $APP_DIR, but the $SERVICE service runs the code in $CODE_DIR. Deploying from here would migrate the database and then restart the old code. Run it there instead: cd $CODE_DIR && bash server/deploy/deploy.sh"
fi

command -v npm >/dev/null 2>&1 || die "npm is not installed. Run server/deploy/setup-ec2.sh first."
command -v curl >/dev/null 2>&1 || die "curl is not installed."
cd "$APP_DIR"

# A few key=value lines for first-twenty-autoupdate, added to the file it names with FT_DEPLOY_REPORT (in
# its state folder, which it starts): phase=before-restart, then phase=restarted just before the restart;
# dump=<file> once the backup before migrating is taken; restored=1 when a failure before the restart put
# this folder back. Each line is written as soon as it is true, so a run that is stopped halfway still says
# how far it got. Nothing is written without FT_DEPLOY_REPORT, and a write that fails never stops a deploy.
report() {
  [ -n "${FT_DEPLOY_REPORT:-}" ] || return 0
  printf '%s=%s\n' "$1" "$2" >>"$FT_DEPLOY_REPORT" 2>/dev/null || true
}

# The migrations this deploy applied before it stopped, as server:migrate printed them, and what that
# means for the way back. Staging migrates through a unit whose output only the journal has.
migrations_note() {
  local applied=""
  [ "$MIGRATE_RAN" = true ] || return 0
  if [ "$INSTANCE" = staging ]; then
    printf ' Migrations may have been applied (sudo journalctl -u %s -n 50 lists them); staging keeps no backups.' "${MIGRATE_SERVICE%.service}"
    return 0
  fi
  [ ! -f "$PREV_DIR/migrate.out" ] ||
    applied=$(sed -n 's/^Applied \([0-9][0-9][0-9]_[a-z0-9_]*\.sql\)$/\1/p' "$PREV_DIR/migrate.out" | tr '\n' ' ')
  applied=${applied% }
  [ -n "$applied" ] || return 0
  if [ -n "$BACKUP_FILE" ]; then
    printf ' Migrations applied in this run stay applied: %s. The backup from just before them is %s (docs/SERVER.md, "Restore a backup").' "$applied" "$BACKUP_FILE"
  else
    printf ' Migrations applied in this run stay applied: %s, without a fresh backup (--skip-backup).' "$applied"
  fi
}

# The EXIT trap until the restart. On a failure before it (set -e or die alike), this puts the folder back
# as the running server left it: the build from .deploy-prev and the commit that ran before (BEFORE).
# Otherwise a restart that nobody started (a reboot, a crash, needrestart after a Node.js update) would
# start half-built code, or new code against a database that was not migrated for it.
put_back() {
  local rc=$? ok=true did=false p head before_sha note where
  [ "$rc" -ne 0 ] || exit 0
  set +e
  # Read before the copy (which holds the migrate output) goes.
  note="$(migrations_note)${FT_PRIOR_BACKUP:+ An earlier try of this commit took $FT_PRIOR_BACKUP before its migrations.}"
  case "$SNAPSHOT" in
    done)
      for p in "${BUILD_PATHS[@]}"; do
        rm -rf "${APP_DIR:?}/$p" || ok=false
        if [ -e "$PREV_DIR/$p" ] || [ -L "$PREV_DIR/$p" ]; then mv "$PREV_DIR/$p" "$APP_DIR/$p" || ok=false; fi
      done
      did=true
      ;;
    # Stopped while the copy was being made, before npm ci: the build in place was never touched.
    started) rm -rf "$PREV_DIR" ;;
  esac
  if [ -n "$BEFORE" ] && [ -d .git ]; then
    head=$(git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null)
    before_sha=$(git rev-parse -q --verify "$BEFORE^{commit}" 2>/dev/null)
    if [ -n "$before_sha" ] && [ "$head" != "$before_sha" ]; then
      if git -c advice.detachedHead=false checkout --quiet --detach "$BEFORE"; then
        did=true
        # A deploy by hand that pulled onto a branch: the branch keeps the new commits for the next try.
        [ -z "$BRANCH" ] || note="$note To try again: git switch $BRANCH && bash server/deploy/deploy.sh"
      else
        ok=false
      fi
    fi
  fi
  if [ "$ok" != true ]; then
    printf '\nNothing was restarted, but %s could not be put back as it was (see above): the build from before is in %s, and the commit that ran before is %s. Put it back before the server restarts.\n' \
      "$APP_DIR" "$PREV_DIR" "${BEFORE:-unknown}" >&2
  elif [ "$did" = true ]; then
    rm -rf "$PREV_DIR"
    if [ -n "$ARCHIVE" ]; then
      where="the build in $APP_DIR was put back as it was (the files unpacked from $ARCHIVE stay)"
    elif [ -n "$BEFORE" ]; then
      where="$APP_DIR is back at $BEFORE with the build it had"
    else
      where="the build in $APP_DIR was put back as it was"
    fi
    printf '\nNothing was restarted: the server still runs the version it already loaded, and %s.%s\n' "$where" "$note" >&2
  fi
  # Code unpacked from an archive stays, so the folder is not back as it was.
  [ "$ok" != true ] || [ -n "$ARCHIVE" ] || report restored 1
  exit "$rc"
}

# One deploy at a time. first-twenty-autoupdate (auto-update.sh) takes this lock itself before it checks out
# the code, and says so with FT_DEPLOY_LOCK_HELD=1.
if [ "${FT_DEPLOY_LOCK_HELD:-}" != 1 ]; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "Another deploy is already running."
fi

# The commit that runs now, for the way back. first-twenty-autoupdate checks out the new commit before it
# runs this script, so it passes the commit that ran before.
BEFORE=""
BRANCH=""
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  BEFORE=$(git rev-parse --short HEAD 2>/dev/null || true)
  BRANCH=$(git symbolic-ref -q --short HEAD 2>/dev/null || true)
fi
if [[ ${FT_PREVIOUS_COMMIT:-} =~ ^[0-9a-f]{7,40}$ ]]; then
  BEFORE=${FT_PREVIOUS_COMMIT:0:12}
fi
SNAPSHOT=none
MIGRATE_RAN=false
BACKUP_FILE=""
report phase before-restart
trap put_back EXIT

if [ "$INSTANCE" = staging ]; then
  echo "Deploying First Twenty staging in $APP_DIR"
  # sudo -l asks only whether a command is allowed, so a missing sudoers rule stops the deploy before the build.
  sudo -n -l systemctl restart "$SERVICE.service" >/dev/null 2>&1 ||
    die "This user may not restart $SERVICE with sudo. Install the rule with: sudo bash server/deploy/setup-auto-deploy.sh --staging-only"
else
  echo "Deploying First Twenty in $APP_DIR"
  # sudo true, not sudo -v: on Ubuntu EC2 the login has a NOPASSWD rule and the sudo group rule without one,
  # and sudo -v asks for a password unless every rule has NOPASSWD (sudoers verifypw=all), so it fails there.
  sudo true || die "This needs sudo for reading the settings and restarting the service."
fi

# Reads one value from the root-only settings file. Only settings that are not secret are read with it:
# PORT, PUBLIC_ORIGIN, APP_FILE and BACKUP_DIR. Staging cannot read its settings file, so it reads FT_PORT,
# FT_PUBLIC_ORIGIN and FT_APP_FILE from its own environment instead (first-twenty-autoupdate-staging.service
# sets them).
env_value() {
  if [ "$INSTANCE" = staging ]; then
    local name="FT_$1"
    printf '%s' "${!name:-}"
    return 0
  fi
  sudo sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"?([^\"]*)\"?[[:space:]]*$/\1/p" "$ENV_FILE" 2>/dev/null | tail -n 1
}

# Succeeds when the .tgz archive $1 has package.json at its top level; returns 2 if tar cannot read it.
# The listing is captured first and searched afterwards. Piping tar into grep -q would let grep stop at
# the first match; tar then dies of SIGPIPE on its next write, and pipefail turns that into a failure.
archive_has_package_json() {
  local listing
  listing=$(tar -tzf "$1" 2>/dev/null) || return 2
  grep -Eq '^(\./)?package\.json$' <<<"$listing"
}

# Whether first-twenty-autoupdate deploys this folder (its state file exists). Its checkout is then always
# a detached commit, and a branch there (if any) is not the code it deploys.
auto_deployed() { [ -f "${AUTODEPLOY_STATE:-}" ]; }

# The steps for deploying commit $1 by hand where first-twenty-autoupdate deploys: pause the channel, check
# the commit out, build it, and record it, so the updater neither deploys over it nor counts it as failed.
manual_deploy_steps() {
  if [ "${INSTANCE:-live}" = staging ]; then
    printf 'sudo touch %s, then as the first-twenty-staging user: git checkout --detach %s && bash server/deploy/deploy.sh --instance staging --no-pull && first-twenty-autoupdate staging --record-deployed' \
      "$PAUSE_FILE" "$1"
  else
    printf 'sudo touch %s, then: git checkout --detach %s && bash server/deploy/deploy.sh --no-pull && first-twenty-autoupdate live --record-deployed' \
      "$PAUSE_FILE" "$1"
  fi
}

# Prints how to get back on a branch when HEAD is detached (after a rollback with git checkout <commit>),
# and nothing when a branch is checked out. git pull cannot update a detached HEAD. Where
# first-twenty-autoupdate deploys, the checkout is always detached and a local branch may hold older code,
# so it prints the steps for a deploy by hand instead of git switch.
detached_head_hint() {
  git symbolic-ref -q HEAD >/dev/null 2>&1 && return 0
  local branch
  if [ -f "${AUTODEPLOY_STATE:-}" ]; then
    printf 'This folder is deployed automatically from GitHub, so it sits on a fixed commit (%s) that git pull cannot update. To deploy a commit by hand: git fetch origin, then %s; remove the pause file once it is healthy. To rebuild this exact commit instead: bash server/deploy/deploy.sh --no-pull' \
      "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" "$(manual_deploy_steps '<commit>')"
    return 0
  fi
  branch=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)
  branch=${branch#origin/}
  printf 'You are on a rolled-back commit (%s), not on a branch, so git pull has nothing to update. Run: git switch %s   then deploy again. To rebuild this exact commit instead: bash server/deploy/deploy.sh --no-pull' \
    "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" "${branch:-main}"
}

# The file name of the newest finished dump in $BACKUP_DIR (names sort by time), or nothing. The folder
# is root-only, hence sudo.
newest_dump() {
  local paths
  paths=$(sudo find "$BACKUP_DIR" -maxdepth 1 -type f -name 'first-twenty-*.dump' 2>/dev/null) || true
  printf '%s\n' "$paths" | sed -n 's#.*/##p' | sort | tail -n 1
}

# The commands that put the previous code ($1, a command) and the database from dump $2 back, in the
# order docs/SERVER.md, "Restore a backup", explains.
restore_steps() {
  cat <<EOF

  sudo systemctl stop $SERVICE
  $1
  npm ci && npm run build:all
  sudo -u postgres psql -c 'ALTER DATABASE first_twenty RENAME TO first_twenty_before_restore'
  sudo -u postgres psql -v ON_ERROR_STOP=1 < server/deploy/postgres-setup.sql
  sudo install -m 600 -o postgres -g postgres $2 /var/tmp/ft-restore.dump
  sudo -u postgres pg_restore --dbname=first_twenty --no-owner --no-acl --role=first_twenty_owner \\
    --single-transaction --exit-on-error /var/tmp/ft-restore.dump
  sudo rm /var/tmp/ft-restore.dump
  bash server/deploy/with-env.sh npm run server:migrate
  bash server/deploy/with-env.sh npm run server:after-restore
  sudo systemctl start $SERVICE
EOF
}

# Prints the way back after a deploy whose new server is not healthy. With a backup taken before
# migrating, that means the previous code and the database as it was just before (docs/SERVER.md,
# "Restore a backup", with the dump filled in). An earlier try of the same commit may have migrated
# already: first-twenty-autoupdate then passes the dump that try took as FT_PRIOR_BACKUP, and whenever this
# commit adds migration files that the previous one lacks, the hint never says the database needs no restore.
rollback_hint() {
  local code dump added="" auto=false
  ! auto_deployed || auto=true
  if [ "$INSTANCE" = staging ]; then
    printf '\nStaging keeps no backups and holds demo data only. To go back, pause automatic deploys\n'
    printf '(sudo touch %s), then as the first-twenty-staging user:\n' "$PAUSE_FILE"
    printf '  git checkout --detach %s && bash server/deploy/deploy.sh --instance staging --no-pull%s\n' "${BEFORE:-<previous commit>}" \
      "$([ "$auto" = false ] || printf ' && first-twenty-autoupdate staging --record-deployed')"
    return 0
  fi
  if [ -n "$BEFORE" ] && [ "$auto" = true ]; then
    code="git checkout --detach $BEFORE"
  elif [ -n "$BEFORE" ]; then
    code="git checkout $BEFORE"
  else
    code="(put the previous code back, for example: tar -xzf <previous archive> -C $APP_DIR)"
  fi
  # The dump from before the first try of this commit comes first: a later try's own dump already holds
  # the migrations the first one applied.
  dump=${FT_PRIOR_BACKUP:-$BACKUP_FILE}
  if [ -n "$BEFORE" ]; then
    added=$(git diff --name-only --diff-filter=A "$BEFORE" HEAD -- server/sql/ 2>/dev/null | sed 's#.*/##' | tr '\n' ' ' || true)
    added=${added% }
  fi
  if [ -z "$dump" ] && [ "$MIGRATED" = true ]; then
    printf '\nMigrations ran without a fresh backup (--skip-backup). To go back, restore your newest backup as\n'
    printf 'in docs/SERVER.md, "Restore a backup", after putting the previous code back with: %s\n' "$code"
    return 0
  fi
  if [ -z "$dump" ] && [ -z "$added" ]; then
    if [ -n "$BEFORE" ] && [ "$auto" = true ]; then
      printf '\nTo go back: %s\n' "$(manual_deploy_steps "$BEFORE")"
      printf 'No migrations ran in this deploy, so the database needs no restore.\n'
    elif [ -n "$BEFORE" ]; then
      printf '\nTo go back: git checkout %s && bash server/deploy/deploy.sh --no-pull\n' "$BEFORE"
      printf '(and git switch %s before the next plain deploy). No migrations ran in this deploy, so the database needs no restore.\n' "${BRANCH:-main}"
    else
      printf '\nTo go back: %s, then bash server/deploy/deploy.sh --no-pull.\n' "$code"
      printf 'No migrations ran in this deploy, so the database needs no restore.\n'
    fi
    return 0
  fi
  if [ -n "$dump" ]; then
    printf '\nMigrations ran for this commit, so the previous code may not work with the database as it is now.\n'
    printf 'To go back to the previous version and the database as it was just before them, run these in\n'
    printf '%s (docs/SERVER.md, "Restore a backup", explains each step):\n' "$APP_DIR"
    [ -z "${FT_PRIOR_BACKUP:-}" ] ||
      printf '(%s was taken before an earlier try of this commit ran its migrations, so it is the dump to restore.)\n' "$FT_PRIOR_BACKUP"
  else
    # No dump from this run or an earlier try it knows of, yet this commit adds migrations: an earlier try
    # (or a deploy by hand) may have applied them.
    printf '\nThis commit adds migrations that %s does not have (%s). None ran in this deploy, but an earlier\n' "$BEFORE" "$added"
    printf 'try may have applied them, so the database may need a restore. Check what is applied with:\n'
    printf '  bash server/deploy/with-env.sh npm run server:migrate -- --status\n'
    printf 'If they are, restore the dump taken before the first try. Find it in the log ("Backed up to"):\n'
    printf "  sudo journalctl -u first-twenty-autoupdate-live --since -7d | grep 'Backed up to'\n"
    printf 'or with sudo ls -lt /var/backups/first-twenty (named by the time deploy.sh ran, in UTC), then run\n'
    printf 'these in %s (docs/SERVER.md, "Restore a backup", explains each step):\n' "$APP_DIR"
    dump="<the dump taken before the first try>"
  fi
  [ "$auto" = false ] || printf '\n  sudo touch %s' "$PAUSE_FILE"
  restore_steps "$code" "$dump"
  if [ -n "$BEFORE" ] && [ "$auto" = true ]; then
    printf '\nThen record it: first-twenty-autoupdate live --record-deployed (remove the pause file once a fixed release is out).\n'
  elif [ -n "$BEFORE" ]; then
    printf '\nThen run git switch %s before the next plain deploy.\n' "${BRANCH:-main}"
  fi
}

# ------------------------------------------------------------------------------------------------
# A deploy started by hand waits while the other channel's updater builds: the instance has about 1 GB of
# memory, so one build at a time. Both updater units are oneshot services, which stay "activating" for
# their whole run (auto-update.sh checks the same way). The updater itself already waited.
other_updater_busy() {
  local state
  command -v systemctl >/dev/null 2>&1 || return 1
  state=$(systemctl show -p ActiveState --value "$OTHER_UPDATER" 2>/dev/null || true)
  case "$state" in activating | active | reloading | deactivating) return 0 ;; *) return 1 ;; esac
}
if [ "${FT_DEPLOY_LOCK_HELD:-}" != 1 ]; then
  OTHER_WAIT=${FT_OTHER_WAIT_SECONDS:-1200}
  [[ $OTHER_WAIT =~ ^[0-9]+$ ]] || OTHER_WAIT=1200
  waited=0
  while other_updater_busy; do
    if [ "$waited" -ge "$OTHER_WAIT" ]; then
      warn "${OTHER_UPDATER%.service} is still running after $waited seconds; building anyway."
      break
    fi
    [ "$waited" -gt 0 ] ||
      info "Waiting for ${OTHER_UPDATER%.service} to finish first (one build at a time). To stop it instead: sudo systemctl stop ${OTHER_UPDATER%.service}"
    sleep 15
    waited=$((waited + 15))
  done
fi

# ------------------------------------------------------------------------------------------------
step "Getting the code"
if [ -n "$ARCHIVE" ]; then
  [ -f "$ARCHIVE" ] || die "Archive not found: $ARCHIVE"
  rc=0
  archive_has_package_json "$ARCHIVE" || rc=$?
  [ "$rc" -ne 2 ] || die "Cannot read $ARCHIVE as a .tgz archive. Make it with: git archive --format=tar.gz -o first-twenty.tgz HEAD"
  [ "$rc" -eq 0 ] ||
    die "$ARCHIVE does not contain package.json at its top level. Make it with: git archive --format=tar.gz -o first-twenty.tgz HEAD"
  tar -xzf "$ARCHIVE" -C "$APP_DIR"
  info "Unpacked $ARCHIVE over $APP_DIR (files removed from the project since last time stay until you delete them)."
elif [ "$PULL" = true ] && [ -d .git ] && [ -n "$(git remote 2>/dev/null)" ]; then
  HINT=$(detached_head_hint)
  [ -z "$HINT" ] || die "$HINT"
  git pull --ff-only || die "git pull failed. If you changed files on the server, see: git status"
  AFTER=$(git rev-parse --short HEAD)
  if [ "$BEFORE" = "$AFTER" ]; then
    info "Already at $AFTER (no new commits). Rebuilding anyway."
  else
    info "Updated $BEFORE -> $AFTER"
  fi
elif [ "$PULL" = true ]; then
  info "No git remote here, so nothing to pull. Copy new code with --archive or rsync (see the top of this file)."
else
  info "Using the code already in $APP_DIR (--no-pull)."
fi

# ------------------------------------------------------------------------------------------------
step "Installing dependencies (npm ci)"
AVAIL_KB=$(awk '/^(MemAvailable|SwapFree):/ {sum += $2} END {print sum + 0}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$AVAIL_KB" -gt 0 ] && [ "$AVAIL_KB" -lt 1500000 ]; then
  warn "Less than 1.5 GB of memory and swap is free; the build may fail. Re-running setup-ec2.sh adds a 2 GB"
  warn "swap file on an instance with under 2 GB of memory (or pass --swap 2G)."
fi
# The build the server runs now, kept until the restart (see BUILD_PATHS). A copy left by an earlier deploy
# that failed after its restart is out of date by now.
rm -rf "$PREV_DIR"
SNAPSHOT=started
mkdir "$PREV_DIR"
for p in "${BUILD_PATHS[@]}"; do
  if [ "$p" = first-twenty.html ]; then
    [ ! -e "$p" ] || cp -p "$p" "$PREV_DIR/"
  elif [ -e "$p" ] || [ -L "$p" ]; then
    cp -al "$p" "$PREV_DIR/"
  fi
done
SNAPSHOT=done
info "Kept the current build in $PREV_DIR, to put back if a step before the restart fails."
if [ "$IGNORE_SCRIPTS" = true ]; then
  # The only install script in package-lock.json is esbuild's (for tsx, a development tool), and the build
  # does not need it: Vite, Tailwind and Lightning CSS find their native builds without install scripts.
  npm ci --ignore-scripts --no-audit --no-fund
else
  npm ci --no-audit --no-fund
fi

# ------------------------------------------------------------------------------------------------
step "Building the app and the server (npm run build:all)"
npm run build:all
[ -f dist-server/server.mjs ] || die "The build finished but dist-server/server.mjs is missing."
APP_FILE=$(env_value APP_FILE)
APP_FILE=${APP_FILE:-first-twenty.html}
case "$APP_FILE" in /*) APP_PATH=$APP_FILE ;; *) APP_PATH=$APP_DIR/$APP_FILE ;; esac
[ -f "$APP_PATH" ] || warn "APP_FILE ($APP_FILE) was not found after the build; the server cannot serve the app at /."

# ------------------------------------------------------------------------------------------------
BACKUP_FILE=""
BACKUP_RAN=true
MIGRATED=false
if [ "$INSTANCE" = staging ]; then
  # Staging holds demo data only and keeps no backups. The migration unit reads the owner password from the
  # root-only settings file and runs dist-server/migrate.mjs as this user; start waits until it has finished.
  step "Applying database migrations (sudo systemctl start $MIGRATE_SERVICE)"
  MIGRATE_RAN=true
  sudo -n systemctl start "$MIGRATE_SERVICE" ||
    die "Migrations failed, so the server was not restarted and still runs the version it already loaded. See why with: sudo journalctl -u ${MIGRATE_SERVICE%.service} -n 50"
else
  # Migrations only move forward, so a database that a migration changed can go back only by restoring a
  # dump. The nightly one can be most of a day old, so take one now whenever a migration is about to run.
  step "Checking for database migrations (npm run server:migrate -- --status)"
  STATUS=$(bash "$SCRIPT_DIR/with-env.sh" npm run server:migrate -- --status) ||
    die "Could not read the migration status (see above). Nothing was migrated, and the server is still running the version it already loaded."
  printf '%s\n' "$STATUS" | sed -nE 's/^(Applied|Pending) \(/    &/p'
  PENDING=$(printf '%s\n' "$STATUS" | sed -nE 's/^Pending \(([0-9]+)\).*/\1/p' | tail -n 1)

  if [ "$PENDING" = 0 ]; then
    info "No migrations to apply, so no backup is needed first."
  elif [ "$SKIP_BACKUP" = true ]; then
    warn "Migrating without a fresh backup (--skip-backup). Going back would mean restoring an older dump."
  else
    [ -n "$PENDING" ] || info "Could not tell whether migrations are pending, so taking a backup to be safe."
    step "Backing up the database before migrating (sudo systemctl start $BACKUP_SERVICE)"
    BACKUP_DIR=$(env_value BACKUP_DIR)
    BACKUP_DIR=${BACKUP_DIR:-/var/backups/first-twenty}
    LAST_DUMP=$(newest_dump)
    # A oneshot service: systemctl start waits until the backup has finished.
    sudo systemctl start "$BACKUP_SERVICE" || BACKUP_RAN=false
    NEW_DUMP=$(newest_dump)
    if [ -z "$NEW_DUMP" ] || [ "$NEW_DUMP" = "$LAST_DUMP" ]; then
      [ "$BACKUP_RAN" = true ] ||
        die "The backup failed, so nothing was migrated and the server is still running the version it already loaded. See why with: sudo journalctl -u $BACKUP_SERVICE -n 30   (Set up with --no-backups? Take a backup your own way, then deploy again with --skip-backup.)"
      die "The backup finished but no new dump appeared in $BACKUP_DIR, so nothing was migrated. See: sudo journalctl -u $BACKUP_SERVICE -n 30"
    fi
    BACKUP_FILE=$BACKUP_DIR/$NEW_DUMP
    if [ "$BACKUP_RAN" != true ]; then
      # backup.sh gives a dump its final name only after pg_restore has read it back, so this one is good:
      # what failed came after it, which in backup.sh is the copy to S3. The local dump is the way back.
      warn "The backup service reported an error after it wrote and checked $BACKUP_FILE, most likely in the copy to S3. That local dump is the way back, so the deploy goes on. See why with: sudo journalctl -u $BACKUP_SERVICE -n 30"
    fi
    info "Backed up to $BACKUP_FILE"
    report dump "$BACKUP_FILE"
  fi

  step "Applying database migrations (npm run server:migrate)"
  MIGRATE_RAN=true
  # tee keeps a copy of the output, so a failure can name the migrations that were applied before it.
  if ! bash "$SCRIPT_DIR/with-env.sh" npm run server:migrate | tee "$PREV_DIR/migrate.out"; then
    die "Migrations failed (output above). Each migration runs in its own transaction, so the one that failed left nothing behind. The server is still running the version it already loaded.${BACKUP_FILE:+ The backup from just before is $BACKUP_FILE (docs/SERVER.md, \"Restore a backup\").}"
  fi
  [ "$PENDING" = 0 ] || MIGRATED=true
fi

# ------------------------------------------------------------------------------------------------
# From here on the new code runs, so a failure no longer puts the old build back; the way back is printed
# instead (rollback_hint). first-twenty-autoupdate never retries a live deploy that got this far.
trap - EXIT
report phase restarted
step "Restarting $SERVICE"
if [ "$INSTANCE" = staging ]; then
  # Installed unit files are readable by everyone, so this comparison needs no sudo.
  if ! cmp -s "$SCRIPT_DIR/$UNIT_FILE" "/etc/systemd/system/$SERVICE.service"; then
    warn "The systemd unit in server/deploy differs from the installed one. Apply it with"
    warn "  sudo bash server/deploy/setup-auto-deploy.sh --staging-only   (safe to re-run)"
  fi
  # Exactly the command the sudoers rule allows, .service included.
  sudo -n systemctl restart "$SERVICE.service"
else
  # Only the unit file itself is compared: drop-ins (first-twenty.service.d, such as the memory protection
  # setup-auto-deploy.sh writes) are files of their own and never count as a difference.
  if ! sudo cmp -s "$SCRIPT_DIR/$UNIT_FILE" "/etc/systemd/system/$SERVICE.service"; then
    warn "The systemd unit in server/deploy differs from the installed one. Apply it with"
    warn "  sudo bash server/deploy/setup-ec2.sh your-domain   (safe to re-run; it only updates what changed)"
  fi
  sudo systemctl restart "$SERVICE"
fi

PORT=$(env_value PORT)
PORT=${PORT:-$DEFAULT_PORT}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:$PORT/api/health}
HEALTH_WAIT=${HEALTH_WAIT_SECONDS:-30}
[[ $HEALTH_WAIT =~ ^[1-9][0-9]*$ ]] || HEALTH_WAIT=30
step "Checking $HEALTH_URL"
ok=false
for _ in $(seq 1 "$HEALTH_WAIT"); do
  if body=$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null) && printf '%s' "$body" | grep -q '"ok":[[:space:]]*true'; then
    ok=true
    break
  fi
  sleep 1
done
if [ "$ok" != true ]; then
  if [ "$INSTANCE" = staging ]; then
    # The staging user cannot read the journal.
    printf '\nERROR: The server did not report healthy within %s seconds. See its log with: sudo journalctl -u %s -n 40\n' "$HEALTH_WAIT" "$SERVICE" >&2
    rollback_hint >&2
    exit 1
  fi
  sudo journalctl -u "$SERVICE" -n 40 --no-pager || true
  printf '\nERROR: The server did not report healthy within %s seconds (recent logs above).\n' "$HEALTH_WAIT" >&2
  rollback_hint >&2
  exit 1
fi
info "Healthy: $body"

# Only an https PUBLIC_ORIGIN is the address people open through Caddy. Anything else (unset, the
# placeholder, or http://localhost:8787 from testing through an SSH tunnel) would reach Node directly and
# prove nothing about Caddy, so it gets a warning instead.
PUBLIC_ORIGIN=$(env_value PUBLIC_ORIGIN)
case "${PUBLIC_ORIGIN%/}" in
  https://hr.example.com | https://hr.example.com:*)
    warn "PUBLIC_ORIGIN is still the placeholder $PUBLIC_ORIGIN. Set it to https://your-domain in $ENV_FILE,"
    warn "then: sudo systemctl restart $SERVICE"
    ;;
  https://*)
    if curl -fsS --max-time 10 "${PUBLIC_ORIGIN%/}/api/health" >/dev/null 2>&1; then
      info "Reachable through Caddy at ${PUBLIC_ORIGIN%/}/api/health"
    else
      warn "The server is healthy locally but ${PUBLIC_ORIGIN%/}/api/health did not answer."
      warn "Check Caddy (sudo journalctl -u caddy -n 50), DNS and the security group (ports 80 and 443)."
    fi
    ;;
  *)
    warn "PUBLIC_ORIGIN is ${PUBLIC_ORIGIN:-not set}, not https://your-domain, so only requests that arrive through"
    warn "Caddy over https get Secure cookies and HSTS, and Caddy was not checked. Once the site is public, set"
    warn "PUBLIC_ORIGIN=https://your-domain in $ENV_FILE, then: sudo systemctl restart $SERVICE"
    ;;
esac

if [ -n "$BACKUP_FILE" ]; then
  info "The backup from just before the migration stays in $BACKUP_FILE (rotated with the nightly ones)."
  [ "$BACKUP_RAN" = true ] || warn "That backup did not finish cleanly (most likely its copy to S3). See: sudo journalctl -u $BACKUP_SERVICE -n 30"
fi
rm -rf "$PREV_DIR"
printf '\nDeploy finished.\n'
