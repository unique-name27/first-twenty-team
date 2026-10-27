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
# Caddy. If a step fails it stops there; the server keeps running the version it already loaded. When a
# migration ran and the new server is not healthy, it prints the way back, with the file name of the
# backup it took just before migrating. A backup that wrote its local dump but then failed (the copy to
# S3) does not stop the deploy: that dump is the way back, and the script warns. HEALTH_URL and
# HEALTH_WAIT_SECONDS (default 30) change the health check, for example:
#   HEALTH_WAIT_SECONDS=90 bash server/deploy/deploy.sh
#
# Rolled back with git checkout <commit>? Run git switch main (or your branch) before the next plain
# deploy: until then git pull has no branch to update, and this script stops and says so.
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

# What differs between the live server and the staging copy.
UNIT_FILE=first-twenty.service
DEFAULT_PORT=8787
LOCK_FILE="${TMPDIR:-/tmp}/first-twenty-deploy.lock"
case "$INSTANCE" in
  live) ;;
  staging)
    SERVICE=first-twenty-staging
    BACKUP_SERVICE=""
    ENV_FILE=${FIRST_TWENTY_ENV:-/etc/first-twenty-staging/env}
    UNIT_FILE=first-twenty-staging.service
    MIGRATE_SERVICE=first-twenty-staging-migrate.service
    DEFAULT_PORT=8788
    LOCK_FILE="${TMPDIR:-/tmp}/first-twenty-staging-deploy.lock"
    IGNORE_SCRIPTS=true
    ;;
  *) die "--instance must be live or staging, not $INSTANCE." ;;
esac

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

# One deploy at a time. first-twenty-autoupdate (auto-update.sh) takes this lock itself before it checks out
# the code, and says so with FT_DEPLOY_LOCK_HELD=1.
if [ "${FT_DEPLOY_LOCK_HELD:-}" != 1 ]; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "Another deploy is already running."
fi

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

# Prints how to get back on a branch when HEAD is detached (after a rollback with git checkout <commit>),
# and nothing when a branch is checked out. git pull cannot update a detached HEAD.
detached_head_hint() {
  git symbolic-ref -q HEAD >/dev/null 2>&1 && return 0
  local branch
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

# Prints the way back after a deploy whose new server is not healthy. With a backup taken before
# migrating, that means the previous code and the database as it was just before (docs/SERVER.md,
# "Restore a backup", with this deploy's dump filled in).
rollback_hint() {
  local code
  if [ "$INSTANCE" = staging ]; then
    printf '\nStaging keeps no backups and holds demo data only. To go back, pause automatic deploys\n'
    printf '(sudo touch /etc/first-twenty-staging/autodeploy.paused), then as the first-twenty-staging user:\n'
    printf '  git checkout --detach %s && bash server/deploy/deploy.sh --instance staging --no-pull\n' "${BEFORE:-<previous commit>}"
    return 0
  fi
  if [ -n "$BEFORE" ]; then
    code="git checkout $BEFORE"
  else
    code="(put the previous code back, for example: tar -xzf <previous archive> -C $APP_DIR)"
  fi
  if [ -z "$BACKUP_FILE" ]; then
    if [ "$MIGRATED" = true ]; then
      printf '\nMigrations ran without a fresh backup (--skip-backup). To go back, restore your newest backup as\n'
      printf 'in docs/SERVER.md, "Restore a backup", after putting the previous code back with: %s\n' "$code"
    elif [ -n "$BEFORE" ]; then
      printf '\nTo go back: git checkout %s && bash server/deploy/deploy.sh --no-pull\n' "$BEFORE"
      printf '(and git switch %s before the next plain deploy). No migrations ran in this deploy, so the database needs no restore.\n' "${BRANCH:-main}"
    else
      printf '\nTo go back: %s, then bash server/deploy/deploy.sh --no-pull.\n' "$code"
      printf 'No migrations ran in this deploy, so the database needs no restore.\n'
    fi
    return 0
  fi
  cat <<EOF

Migrations ran in this deploy, so the previous code may not work with the database as it is now.
To go back to the previous version and the database as it was just before this deploy, run these in
$APP_DIR (docs/SERVER.md, "Restore a backup", explains each step):

  sudo systemctl stop $SERVICE
  $code
  npm ci && npm run build:all
  sudo -u postgres psql -c 'ALTER DATABASE first_twenty RENAME TO first_twenty_before_restore'
  sudo -u postgres psql -v ON_ERROR_STOP=1 < server/deploy/postgres-setup.sql
  sudo install -m 600 -o postgres -g postgres $BACKUP_FILE /var/tmp/ft-restore.dump
  sudo -u postgres pg_restore --dbname=first_twenty --no-owner --no-acl --role=first_twenty_owner \\
    --single-transaction --exit-on-error /var/tmp/ft-restore.dump
  sudo rm /var/tmp/ft-restore.dump
  bash server/deploy/with-env.sh npm run server:migrate
  bash server/deploy/with-env.sh npm run server:after-restore
  sudo systemctl start $SERVICE
EOF
  if [ -n "$BEFORE" ]; then
    printf '\nThen run git switch %s before the next plain deploy.\n' "${BRANCH:-main}"
  fi
}

# ------------------------------------------------------------------------------------------------
step "Getting the code"
BEFORE=""
BRANCH=""
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  BEFORE=$(git rev-parse --short HEAD 2>/dev/null || true)
  BRANCH=$(git symbolic-ref -q --short HEAD 2>/dev/null || true)
fi
# first-twenty-autoupdate checks out the new commit before it runs this script, so it passes the commit
# that ran before, for the way back.
if [[ ${FT_PREVIOUS_COMMIT:-} =~ ^[0-9a-f]{7,40}$ ]]; then
  BEFORE=${FT_PREVIOUS_COMMIT:0:12}
fi
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
  fi

  step "Applying database migrations (npm run server:migrate)"
  if ! bash "$SCRIPT_DIR/with-env.sh" npm run server:migrate; then
    die "Migrations failed (output above). Each migration runs in its own transaction, so the one that failed left nothing behind. The server is still running the version it already loaded.${BACKUP_FILE:+ The backup from just before is $BACKUP_FILE (docs/SERVER.md, \"Restore a backup\").}"
  fi
  [ "$PENDING" = 0 ] || MIGRATED=true
fi

# ------------------------------------------------------------------------------------------------
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
printf '\nDeploy finished.\n'
