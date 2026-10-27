#!/usr/bin/env bash
# First Twenty: set up automatic deploys from GitHub on the EC2 instance (docs/SERVER.md, "Automatic
# deploys from GitHub"). Run it once with sudo; it is safe to run again (every step checks first).
#
# Run it from a fresh copy of the team repo's main, then delete that copy:
#   git clone --depth 1 https://github.com/unique-name27/first-twenty-team.git ~/ft-setup
#   sudo bash ~/ft-setup/server/deploy/setup-auto-deploy.sh --dry-run    print every step, change nothing
#   sudo bash ~/ft-setup/server/deploy/setup-auto-deploy.sh
#   rm -rf ~/ft-setup
#
# Staging (skipped with --live-only), next to the live server and apart from it:
#   - the first-twenty-staging system user (no login, no sudo beyond the two commands below)
#   - the first_twenty_staging database and its two roles, made by postgres-setup.sql with the staging
#     names, with passwords it generates and writes only to /etc/first-twenty-staging/env (root only);
#     pg_hba.conf lines keep the staging roles in that database, from this instance only (backed up first)
#   - /etc/first-twenty-staging/env: port 8788, open sign-up with demo limits, no assistant, no careers
#   - /opt/first-twenty-staging: a clone of the team repo, owned by first-twenty-staging
#   - first-twenty-staging.service, first-twenty-staging-migrate.service, and
#     first-twenty-autoupdate-staging.service and .timer (every 5 minutes)
#   - /etc/sudoers.d/first-twenty-staging: first-twenty-staging may start first-twenty-staging-migrate and
#     restart first-twenty-staging, nothing else (checked with visudo first)
#   - /etc/caddy/first-twenty.d/staging.caddy for the staging domain, and the line that imports it in
#     /etc/caddy/Caddyfile (backed up first, checked with caddy validate before Caddy reloads)
#   - Caddy's admin API moved from 127.0.0.1:2019, where staging's code could reach it and change the live
#     sites, to the Unix socket /var/lib/caddy/admin.sock that only Caddy and root can open (the admin line
#     in the Caddyfile's global options, as in server/deploy/Caddyfile). Staging is not started otherwise.
#
# Live (skipped with --staging-only):
#   - switches the origin of /opt/first-twenty to the public team repo over HTTPS, keeping the old address
#     as the remote previous-origin
#   - records the commit /opt/first-twenty has checked out as deployed, so nothing happens until the
#     product owner publishes a newer release
#   - first-twenty-autoupdate-live.service and .timer (every 5 minutes), run as the login that owns
#     /opt/first-twenty
#
# Both: installs server/deploy/auto-update.sh as /usr/local/bin/first-twenty-autoupdate (run this setup
# again after an update that changes it; the updater says so in its log).
#
# Options:
#   --staging-domain NAME   the staging site's host name (default staging-77-112-161-54.sslip.io); its DNS
#                           must point at this instance (an sslip.io name does by itself)
#   --deploy-user NAME      the login that owns /opt/first-twenty and deploys it (default: its owner)
#   --release-author LOGIN  the only GitHub login whose releases go live (default unique-name27)
#   --repo OWNER/NAME       the GitHub repo to deploy from (default unique-name27/first-twenty-team)
#   --staging-only          set up staging only
#   --live-only             set up the live channel only
#   --dry-run               print every step, change nothing
#   -h, --help              show this help
#
# It never touches the live database, its roles, /etc/first-twenty/env or the live Caddy sites (the admin
# line changes where Caddy listens for configuration, not what it serves).

set -euo pipefail

DEFAULT_REPO=unique-name27/first-twenty-team
REPO=$DEFAULT_REPO
STAGING_DOMAIN=staging-77-112-161-54.sslip.io
RELEASE_AUTHOR=unique-name27
DEPLOY_USER=""
DO_STAGING=true
DO_LIVE=true
DRY_RUN=false

STAGING_USER=first-twenty-staging
STAGING_DIR=/opt/first-twenty-staging
STAGING_HOME=/var/lib/first-twenty-staging
STAGING_STATE=$STAGING_HOME/autoupdate
STAGING_ENV_DIR=/etc/first-twenty-staging
STAGING_ENV=$STAGING_ENV_DIR/env
STAGING_DB=first_twenty_staging
STAGING_ROLE=first_twenty_staging
STAGING_OWNER=first_twenty_staging_owner
STAGING_PORT=8788
LIVE_DIR=${FT_LIVE_DIR:-/opt/first-twenty}
LIVE_ENV=/etc/first-twenty/env
LIVE_STATE=/var/lib/first-twenty-autoupdate
UPDATER=/usr/local/bin/first-twenty-autoupdate
SUDOERS=/etc/sudoers.d/first-twenty-staging
UNIT_DIR=/etc/systemd/system
CADDY_MAIN=${FT_CADDY_MAIN:-/etc/caddy/Caddyfile}
# Caddy's admin API, which can change every site, on a Unix socket in the caddy user's own folder instead of
# 127.0.0.1:2019 (server/deploy/Caddyfile has the same line). Connecting to a Unix socket takes write
# permission on it, and Caddy gives that to its own user only, so nothing but Caddy and root can connect
# (setup checks the socket's mode after the reload).
CADDY_ADMIN_SOCKET=/var/lib/caddy/admin.sock
CADDY_ADMIN_DIR=${FT_CADDY_ADMIN_DIR:-/var/lib/caddy}
ADMIN_LINE="admin unix/$CADDY_ADMIN_SOCKET"
CADDY_DIR=/etc/caddy/first-twenty.d
CADDY_SITE=$CADDY_DIR/staging.caddy
CADDY_LOG=/var/log/caddy/first-twenty-staging-access.log
IMPORT_LINE="import $CADDY_DIR/*.caddy"
STAMP=$(date +%Y%m%d-%H%M%S)

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'; }

need_value() {
  [ -n "${2:-}" ] && [ "${2#-}" = "$2" ] || die "$1 needs a value. Run with --help for usage."
}

while [ $# -gt 0 ]; do
  case "$1" in
    --staging-domain) need_value "$1" "${2:-}"; STAGING_DOMAIN=$2; shift 2 ;;
    --staging-domain=*) STAGING_DOMAIN=${1#*=}; shift ;;
    --deploy-user) need_value "$1" "${2:-}"; DEPLOY_USER=$2; shift 2 ;;
    --deploy-user=*) DEPLOY_USER=${1#*=}; shift ;;
    --release-author) need_value "$1" "${2:-}"; RELEASE_AUTHOR=$2; shift 2 ;;
    --release-author=*) RELEASE_AUTHOR=${1#*=}; shift ;;
    --repo) need_value "$1" "${2:-}"; REPO=$2; shift 2 ;;
    --repo=*) REPO=${1#*=}; shift ;;
    --staging-only) DO_LIVE=false; shift ;;
    --live-only) DO_STAGING=false; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "Unknown option: $1. Run with --help for usage." ;;
  esac
done

GIT_URL=https://github.com/$REPO.git

# ------------------------------------------------------------------------------------------------
# Helpers. Everything that changes the instance goes through run, run_as or put, which only print what
# they would do under --dry-run. Reading (id, stat, git remote, psql SELECT) happens either way.
# ------------------------------------------------------------------------------------------------

run() {
  if [ "$DRY_RUN" = true ]; then
    info "would run: $*"
  else
    "$@"
  fi
}

# Runs a command as another user, from / (so a folder only root can enter is never the working folder).
as_user() {
  local user=$1
  shift
  (cd / && runuser -u "$user" -- "$@")
}

run_as() {
  local user=$1
  shift
  if [ "$DRY_RUN" = true ]; then
    info "would run as $user: $*"
  else
    as_user "$user" "$@"
  fi
}

# put <path> <mode> <owner:group>: writes standard input to the file (through a temporary file next to
# it, so the file is never half written). The content never appears on a command line or in the output.
put() {
  local path=$1 mode=$2 owner=$3 tmp
  if [ "$DRY_RUN" = true ]; then
    cat >/dev/null
    info "would write $path (mode $mode, $owner)"
    return 0
  fi
  tmp=$(mktemp "$(dirname "$path")/.first-twenty-setup.XXXXXX")
  cat >"$tmp"
  chown "$owner" "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$path"
}

# put_if_changed <path> <mode> <owner:group>: like put, but leaves a file with the same content alone.
put_if_changed() {
  local new
  new=$(mktemp)
  cat >"$new"
  if [ -f "$1" ] && cmp -s "$new" "$1"; then
    info "$1 is up to date."
  else
    put "$1" "$2" "$3" <"$new"
    [ "$DRY_RUN" = true ] || info "Wrote $1."
  fi
  rm -f "$new"
}

is_domain() {
  printf '%s' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
}

# A long random password of hex digits, so it needs no escaping in a URL or in SQL.
new_password() {
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

pg_value() {
  (cd / && runuser -u postgres -- psql -XAtqc "$1")
}

# Prints whether the staging database, its server role and its owner role exist, as "t|t|t" (f where one
# is missing), or nothing when Postgres cannot be asked. Reads the catalog only.
staging_objects() {
  command -v psql >/dev/null 2>&1 && id -u postgres >/dev/null 2>&1 || return 0
  pg_value "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$STAGING_DB'), EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$STAGING_ROLE'), EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$STAGING_OWNER')" 2>/dev/null || true
}

# postgres-setup.sql with the staging names: the same roles, limits, grants and lockdown as live, for
# first_twenty_staging. The \password prompts are left out (setup sets generated passwords instead).
staging_sql() {
  sed -E \
    -e '/^[\\]if :(role|owner)_is_new$/,/^[\\]endif$/d' \
    -e "s/\\bfirst_twenty_owner\\b/$STAGING_OWNER/g" \
    -e "s/\\bfirst_twenty\\b/$STAGING_ROLE/g" \
    "$SCRIPT_DIR/postgres-setup.sql"
}

# Sets both staging passwords, sent on standard input, never on a command line. The session settings
# keep the statements out of the server log and pg_stat_statements; Postgres stores only a SCRAM hash.
set_staging_passwords() {
  (cd / && runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d postgres) >/dev/null <<SQL
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_error_statement = 'panic';
SET pg_stat_statements.track_utility = off;
ALTER ROLE $STAGING_ROLE PASSWORD '$1';
ALTER ROLE $STAGING_OWNER PASSWORD '$2';
SQL
}

# The staging settings file, for the two passwords $1 (server role) and $2 (owner role).
staging_env() {
  cat <<EOF
# First Twenty staging settings, written by setup-auto-deploy.sh (docs/SERVER.md, "Automatic deploys from
# GitHub"). Root only: systemd reads it for first-twenty-staging and first-twenty-staging-migrate. Setup
# keeps it as it is on later runs; delete it and run setup again to get new database passwords. Every
# setting is explained in .env.example. Keep comments on their own lines.
HOST=127.0.0.1
PORT=$STAGING_PORT
DATABASE_URL=postgres://$STAGING_ROLE:$1@127.0.0.1:5432/$STAGING_DB
MIGRATION_DATABASE_URL=postgres://$STAGING_OWNER:$2@127.0.0.1:5432/$STAGING_DB
PGSSLMODE=disable
PUBLIC_ORIGIN=https://$STAGING_DOMAIN
SERVE_APP=true
APP_FILE=first-twenty.html
MIGRATE_ON_START=false
SESSION_IDLE_HOURS=12
SESSION_MAX_DAYS=7
# A public demo: anyone may sign up and make a demo company. Demo data only, never real people's.
SIGNUP_MODE=open
DEMO_MAX_WORKSPACES=50
DEMO_EXPIRE_DAYS=7
DEMO_MAX_TOTAL_MB=256
# No ANTHROPIC_API_KEY (the assistant is off) and no CAREERS_HOSTS (careers pages are off).
EOF
}

# The pg_hba.conf lines for the staging roles: their own database, from 127.0.0.1 or ::1, and nothing else
# (the first matching line wins, so they go at the top; they match the staging roles only). Code from main
# runs on staging and can learn these roles' passwords, so the reject lines cover every way in: any
# database over the Unix socket, and any other database or address over TCP, in case Postgres ever
# listens beyond localhost.
hba_block() {
  cat <<EOF
# BEGIN first-twenty-staging (setup-auto-deploy.sh): the staging roles reach $STAGING_DB only, from this instance.
host    $STAGING_DB  $STAGING_ROLE,$STAGING_OWNER  127.0.0.1/32  scram-sha-256
host    $STAGING_DB  $STAGING_ROLE,$STAGING_OWNER  ::1/128       scram-sha-256
local   all  $STAGING_ROLE,$STAGING_OWNER  reject
host    all  $STAGING_ROLE,$STAGING_OWNER  0.0.0.0/0     reject
host    all  $STAGING_ROLE,$STAGING_OWNER  ::/0          reject
# END first-twenty-staging
EOF
}

# pg_hba.conf file $1 with the staging block in place of the one between the BEGIN and END lines, or at
# the top when it has none.
hba_with_block() {
  if grep -q '^# BEGIN first-twenty-staging' "$1"; then
    HBA_BLOCK=$(hba_block) awk '
      /^# BEGIN first-twenty-staging/ { print ENVIRON["HBA_BLOCK"]; skip = 1; next }
      skip && /^# END first-twenty-staging/ { skip = 0; next }
      !skip { print }
    ' "$1"
  else
    hba_block
    cat "$1"
  fi
}

# The sudoers rule: exactly two commands, with exactly these arguments.
sudoers_rule() {
  cat <<EOF
# Written by First Twenty setup-auto-deploy.sh (docs/SERVER.md, "Automatic deploys from GitHub").
# The staging deploy user may run exactly these two commands as root, and nothing else.
$STAGING_USER ALL=(root) NOPASSWD: $SYSTEMCTL start first-twenty-staging-migrate.service, $SYSTEMCTL restart first-twenty-staging.service
EOF
}

render_staging_unit() {
  sed -e "s#^Environment=FT_PUBLIC_ORIGIN=.*#Environment=FT_PUBLIC_ORIGIN=https://$STAGING_DOMAIN#" "$SCRIPT_DIR/first-twenty-autoupdate-staging.service"
  [ "$REPO" = "$DEFAULT_REPO" ] || printf 'Environment=FT_REPO=%s\n' "$REPO"
}

render_live_unit() {
  sed -e "s/^User=.*/User=$DEPLOY_USER/" -e "s/^Group=.*/Group=$DEPLOY_GROUP/" \
    -e "s/^Environment=FT_RELEASE_AUTHOR=.*/Environment=FT_RELEASE_AUTHOR=$RELEASE_AUTHOR/" \
    "$SCRIPT_DIR/first-twenty-autoupdate-live.service"
  [ "$REPO" = "$DEFAULT_REPO" ] || printf 'Environment=FT_REPO=%s\n' "$REPO"
}

render_caddy_site() {
  sed -e "s/^staging\.example\.com {/${STAGING_DOMAIN} {/" -e "s/^http:\/\/staging\.example\.com {/http:\/\/${STAGING_DOMAIN} {/" \
    "$SCRIPT_DIR/staging.caddy"
}

# ------------------------------------------------------------------------------------------------
# Checks
# ------------------------------------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "Run this with sudo: sudo bash $0 (add --dry-run to only print the steps)"
[ "$DO_STAGING" = true ] || [ "$DO_LIVE" = true ] || die "Pass --staging-only or --live-only, not both."
[[ $REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo must look like owner/name, not $REPO."
[[ $RELEASE_AUTHOR =~ ^[A-Za-z0-9-]+$ ]] || die "--release-author must be a GitHub login, not $RELEASE_AUTHOR."
STAGING_DOMAIN=$(printf '%s' "$STAGING_DOMAIN" | tr '[:upper:]' '[:lower:]')
STAGING_DOMAIN=${STAGING_DOMAIN#https://}
STAGING_DOMAIN=${STAGING_DOMAIN%/}
is_domain "$STAGING_DOMAIN" || die "\"$STAGING_DOMAIN\" does not look like a host name for --staging-domain."

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
for f in auto-update.sh postgres-setup.sql first-twenty-staging.service first-twenty-staging-migrate.service \
  first-twenty-autoupdate-staging.service first-twenty-autoupdate-staging.timer \
  first-twenty-autoupdate-live.service first-twenty-autoupdate-live.timer staging.caddy; do
  [ -f "$SCRIPT_DIR/$f" ] || die "Cannot find server/deploy/$f next to this script. Run it from a copy of the team repo."
done

for c in git runuser systemctl install; do
  command -v "$c" >/dev/null 2>&1 || die "$c is missing. Run server/deploy/setup-ec2.sh first."
done
command -v node >/dev/null 2>&1 || die "Node.js is missing. Run server/deploy/setup-ec2.sh first."
SYSTEMCTL=$(command -v systemctl)

if [ "$DO_STAGING" = true ]; then
  for c in psql caddy visudo useradd curl stat; do
    command -v "$c" >/dev/null 2>&1 || die "$c is missing; staging needs it (Postgres, Caddy and sudo come with setup-ec2.sh)."
  done
  id -u caddy >/dev/null 2>&1 || die "The caddy user is missing. Run server/deploy/setup-ec2.sh first."
  # The live site and careers hosts must stay the live server's.
  if [ -f "$LIVE_ENV" ]; then
    live_hosts=$(sed -n -E 's#^[[:space:]]*(PUBLIC_ORIGIN|CAREERS_HOSTS)[[:space:]]*=[[:space:]]*"?([^"]*)"?[[:space:]]*$#\2#p' "$LIVE_ENV" |
      sed -e 's#https\?://##g' -e 's#/##g' | tr ',' ' ' | tr '[:upper:]' '[:lower:]')
    for h in $live_hosts; do
      [ "$h" != "$STAGING_DOMAIN" ] || die "--staging-domain $STAGING_DOMAIN is a live host name (in $LIVE_ENV). Pick another, like staging-77-112-161-54.sslip.io."
    done
  fi
fi

if [ "$DO_LIVE" = true ]; then
  [ -d "$LIVE_DIR/.git" ] || die "$LIVE_DIR is not a git checkout, so the live channel cannot fetch releases into it. Pass --staging-only to set up staging alone."
  [ -n "$DEPLOY_USER" ] || DEPLOY_USER=$(stat -c %U "$LIVE_DIR")
  id -u "$DEPLOY_USER" >/dev/null 2>&1 || die "User $DEPLOY_USER does not exist."
  [ "$DEPLOY_USER" != root ] || die "$LIVE_DIR belongs to root. Pass --deploy-user with the login that deploys it (for example ubuntu)."
  DEPLOY_GROUP=$(id -gn "$DEPLOY_USER")
fi

echo "First Twenty automatic deploys"
[ "$DRY_RUN" = false ] || info "Dry run: nothing is changed; each step says what it would do."
info "Repo:        $GIT_URL"
[ "$DO_STAGING" = false ] || info "Staging:     https://$STAGING_DOMAIN from main, as $STAGING_USER in $STAGING_DIR"
[ "$DO_LIVE" = false ] || info "Live:        releases by $RELEASE_AUTHOR, as $DEPLOY_USER in $LIVE_DIR"

# ------------------------------------------------------------------------------------------------
# The updater
# ------------------------------------------------------------------------------------------------

step "Installing the updater as $UPDATER"
put_if_changed "$UPDATER" 0755 root:root <"$SCRIPT_DIR/auto-update.sh"

# ------------------------------------------------------------------------------------------------
# Staging
# ------------------------------------------------------------------------------------------------

setup_staging() {
  local objects need_passwords app_pw owner_pw hba hba_new errors

  step "Staging: the $STAGING_USER system user"
  if id -u "$STAGING_USER" >/dev/null 2>&1; then
    info "User $STAGING_USER already exists."
  else
    run useradd --system --user-group --home-dir "$STAGING_HOME" --no-create-home \
      --shell "$(command -v nologin || echo /usr/sbin/nologin)" --comment "First Twenty staging" "$STAGING_USER"
  fi

  step "Staging: folders"
  run install -d -m 0750 -o "$STAGING_USER" -g "$STAGING_USER" "$STAGING_HOME" "$STAGING_STATE" "$STAGING_DIR"
  # Open for reading the folder (so first-twenty-staging can see the pause switch), not the settings file.
  run install -d -m 0755 -o root -g root "$STAGING_ENV_DIR"

  step "Staging: the $STAGING_DB database and its roles"
  objects=$(staging_objects)
  [ -n "$objects" ] || die "Cannot ask Postgres as the postgres user (is it running on this instance?)."
  case "$objects" in
    't|t|t') info "The database and both roles exist; postgres-setup.sql (staging names) checks their settings and grants again." ;;
    *) info "Creating what is missing with postgres-setup.sql, staging names ($STAGING_ROLE, $STAGING_OWNER)." ;;
  esac
  if [ "$DRY_RUN" = true ]; then
    info "would run: postgres-setup.sql with the staging names, as the postgres user"
  else
    staging_sql | (cd / && runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d postgres) >/dev/null
  fi
  need_passwords=false
  [ -f "$STAGING_ENV" ] || need_passwords=true
  case "$objects" in *'|f|'* | *'|f') need_passwords=true ;; esac
  if [ "$need_passwords" = true ]; then
    if [ "$DRY_RUN" = true ]; then
      info "would generate two passwords, set them on $STAGING_ROLE and $STAGING_OWNER, and write them only into $STAGING_ENV"
    else
      app_pw=$(new_password)
      owner_pw=$(new_password)
      set_staging_passwords "$app_pw" "$owner_pw"
      info "Set new generated passwords on both roles."
    fi
  else
    info "Kept the passwords in $STAGING_ENV."
  fi

  hba=$(pg_value 'SHOW hba_file' 2>/dev/null || true)
  hba_new=$(mktemp)
  if [ -z "$hba" ] || [ ! -f "$hba" ]; then
    # Without these lines a staging password (which code on staging can read) would open other databases.
    rm -f "$hba_new"
    die "Could not find pg_hba.conf (SHOW hba_file), so the staging roles cannot be limited to $STAGING_DB. Nothing on staging runs yet; fix that and run this again."
  fi
  hba_with_block "$hba" >"$hba_new"
  if cmp -s "$hba_new" "$hba"; then
    info "$hba already has the staging lines."
  elif [ "$DRY_RUN" = true ]; then
    info "would back up $hba to $hba.bak-$STAMP and put at its top (in place of any older staging lines):"
    hba_block | sed 's/^/      /'
    info "would check the file (pg_hba_file_rules) and reload Postgres"
  else
    cp -p "$hba" "$hba.bak-$STAMP"
    # Written in place, so the file keeps its owner and mode.
    cat "$hba_new" >"$hba"
    errors=$(pg_value 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL' || echo unknown)
    if [ "$errors" != 0 ]; then
      cat "$hba.bak-$STAMP" >"$hba"
      rm -f "$hba_new"
      die "Postgres rejected the new pg_hba.conf lines, so the file was put back as it was ($hba.bak-$STAMP)."
    fi
    pg_value 'SELECT pg_reload_conf()' >/dev/null
    info "Put the staging lines in $hba (previous copy: $hba.bak-$STAMP) and reloaded Postgres."
  fi
  rm -f "$hba_new"

  step "Staging: settings in $STAGING_ENV"
  if [ "$need_passwords" = true ]; then
    if [ -f "$STAGING_ENV" ]; then
      run cp -p "$STAGING_ENV" "$STAGING_ENV.bak-$STAMP"
      info "The roles were new, so the old settings file (now $STAGING_ENV.bak-$STAMP) had passwords that no longer work."
    fi
    staging_env "${app_pw:-}" "${owner_pw:-}" | put "$STAGING_ENV" 0600 root:root
    [ "$DRY_RUN" = true ] || info "Wrote $STAGING_ENV (root only): port $STAGING_PORT, https://$STAGING_DOMAIN, open sign-up with demo limits, no assistant, no careers pages."
  else
    info "Kept the existing $STAGING_ENV (not overwritten)."
    if ! grep -qx "PUBLIC_ORIGIN=https://$STAGING_DOMAIN" "$STAGING_ENV"; then
      warn "PUBLIC_ORIGIN in $STAGING_ENV is not https://$STAGING_DOMAIN (did --staging-domain change?). Set it with:"
      warn "  sudo sed -i 's#^PUBLIC_ORIGIN=.*#PUBLIC_ORIGIN=https://$STAGING_DOMAIN#' $STAGING_ENV && sudo systemctl restart first-twenty-staging"
    fi
  fi
  unset app_pw owner_pw

  step "Staging: the code in $STAGING_DIR"
  if [ -d "$STAGING_DIR/.git" ]; then
    info "Already a clone of $(as_user "$STAGING_USER" git -C "$STAGING_DIR" remote get-url origin 2>/dev/null || echo 'an unknown repo')."
  elif [ -d "$STAGING_DIR" ] && [ -n "$(ls -A "$STAGING_DIR" 2>/dev/null)" ]; then
    die "$STAGING_DIR has files but is not a git checkout. Move them away, then run this again."
  else
    run_as "$STAGING_USER" git clone --quiet "$GIT_URL" "$STAGING_DIR"
  fi

  step "Staging: systemd units"
  put_if_changed "$UNIT_DIR/first-twenty-staging.service" 0644 root:root <"$SCRIPT_DIR/first-twenty-staging.service"
  put_if_changed "$UNIT_DIR/first-twenty-staging-migrate.service" 0644 root:root <"$SCRIPT_DIR/first-twenty-staging-migrate.service"
  render_staging_unit | put_if_changed "$UNIT_DIR/first-twenty-autoupdate-staging.service" 0644 root:root
  put_if_changed "$UNIT_DIR/first-twenty-autoupdate-staging.timer" 0644 root:root <"$SCRIPT_DIR/first-twenty-autoupdate-staging.timer"
  run systemctl daemon-reload
  # Enabled for boot, started by the first deploy (there is nothing built to run yet).
  run systemctl enable --quiet first-twenty-staging.service

  step "Staging: the sudo rule in $SUDOERS"
  if [ "$DRY_RUN" = true ]; then
    info "would write $SUDOERS (mode 0440, checked with visudo first):"
    sudoers_rule | sed 's/^/      /'
  else
    local rule
    rule=$(mktemp)
    sudoers_rule >"$rule"
    visudo -cqf "$rule" >/dev/null || { rm -f "$rule"; die "visudo rejected the sudo rule, so it was not installed."; }
    put_if_changed "$SUDOERS" 0440 root:root <"$rule"
    rm -f "$rule"
  fi

  step "Staging: the Caddy site https://$STAGING_DOMAIN"
  setup_caddy

  step "Staging: automatic deploys every 5 minutes"
  run systemctl enable --now --quiet first-twenty-autoupdate-staging.timer
  # The first deploy starts now rather than at the next tick; --no-block returns at once.
  run systemctl start --no-block first-twenty-autoupdate-staging.service
}

# The admin line in the global options block of Caddyfile $1 (the block Caddy reads only when it is the
# first thing in the file, before any site), or nothing when there is none.
caddy_admin_setting() {
  awk '
    !code {
      t = $0
      sub(/^[ \t]+/, "", t)
      if (t == "" || substr(t, 1, 1) == "#") next
      code = 1
      if ($0 != "{") exit
      inblock = 1
      next
    }
    inblock && $0 == "}" { exit }
    inblock {
      t = $0
      sub(/^[ \t]+/, "", t)
      if (t ~ /^admin([ \t]|$)/) { print t; exit }
    }
  ' "$1"
}

# Caddyfile $1 with ADMIN_LINE at the top of its global options block, or in a new global options block
# at the top when it has none.
caddy_with_admin() {
  ADMIN_LINE=$ADMIN_LINE awk '
    !done {
      t = $0
      sub(/^[ \t]+/, "", t)
      if (t == "" || substr(t, 1, 1) == "#") { print; next }
      if ($0 == "{") { print; print "\t" ENVIRON["ADMIN_LINE"]; done = 1; next }
      print "{"
      print "\t" ENVIRON["ADMIN_LINE"]
      print "}"
      print ""
      print
      done = 1
      next
    }
    { print }
  ' "$1"
}

# Whether Caddy's admin API answers on its default TCP address, where any process on the instance can
# reach it (staging's code included).
caddy_admin_on_tcp() {
  curl -s -o /dev/null --max-time 3 http://127.0.0.1:2019/config/ 2>/dev/null ||
    curl -s -g -o /dev/null --max-time 3 'http://[::1]:2019/config/' 2>/dev/null
}

# Reloads Caddy from the main Caddyfile. systemctl reload uses the admin address written in that file, so
# the first time the file moves the admin API to its Unix socket, the running Caddy still listens on
# localhost:2019, and caddy reload is told that address instead.
caddy_reload() {
  systemctl reload caddy 2>/dev/null && return 0
  caddy_admin_on_tcp || return 1
  runuser -u caddy -- caddy reload --config "$CADDY_MAIN" --adapter caddyfile --address localhost:2019
}

# Writes the staging site, adds the import line to the main Caddyfile when it is missing, moves Caddy's
# admin API to a Unix socket that only root and Caddy can open (the admin global option) when it is not
# there yet, checks the result with caddy validate (as the caddy user, as setup-ec2.sh does) and reloads
# Caddy. Anything that does not validate or reload is put back as it was. Staging runs code from main
# before the product owner releases it, and Caddy's admin API on 127.0.0.1:2019 could change the live
# sites, so setup stops before staging's first deploy unless the admin API has left that address.
setup_caddy() {
  local site_new main_new="" site_backup="" site_written=false import_re admin need_admin=false need_import=false socket_mode
  run install -d -m 0755 "$CADDY_DIR"
  run install -d -m 0750 -o caddy -g caddy /var/log/caddy
  if [ ! -f "$CADDY_LOG" ]; then
    run install -m 0640 -o caddy -g caddy /dev/null "$CADDY_LOG"
  fi
  import_re="^[[:space:]]*import[[:space:]]+$(printf '%s' "$CADDY_DIR" | sed 's/[.]/\\./g')/\\*\\.caddy[[:space:]]*$"

  [ -f "$CADDY_MAIN" ] || die "$CADDY_MAIN is missing. Run server/deploy/setup-ec2.sh first."
  [ -d "$CADDY_ADMIN_DIR" ] && [ "$(stat -c %U "$CADDY_ADMIN_DIR")" = caddy ] ||
    die "$CADDY_ADMIN_DIR (the caddy user's own folder, for the admin socket) is missing or not owned by caddy."
  admin=$(caddy_admin_setting "$CADDY_MAIN")
  # The line setup writes, or the same with socket permissions (|0200) added by hand.
  case "$admin" in
    "" | "$ADMIN_LINE" | "$ADMIN_LINE|"*) ;;
    *) die "$CADDY_MAIN sets Caddy's admin API itself (\"$admin\"). Staging needs it on a Unix socket only root and Caddy can open: make that line \"$ADMIN_LINE\" (or remove it), then run this again." ;;
  esac
  [ -n "$admin" ] || need_admin=true
  grep -Eq "$import_re" "$CADDY_MAIN" || need_import=true

  if [ "$DRY_RUN" = true ]; then
    if [ -f "$CADDY_SITE" ] && render_caddy_site | cmp -s - "$CADDY_SITE"; then
      info "$CADDY_SITE is up to date."
    else
      info "would write $CADDY_SITE for $STAGING_DOMAIN (proxy to 127.0.0.1:$STAGING_PORT)"
    fi
    if [ "$need_admin" = true ] || [ "$need_import" = true ]; then
      info "would back up $CADDY_MAIN to $CADDY_MAIN.bak-$STAMP, then:"
      [ "$need_admin" = false ] || info "  add to its global options block: $ADMIN_LINE   (Caddy's admin API on a Unix socket only root and Caddy can open)"
      [ "$need_import" = false ] || info "  add: $IMPORT_LINE"
    else
      info "$CADDY_MAIN already imports $CADDY_DIR and keeps the admin API on $CADDY_ADMIN_SOCKET."
    fi
    info "would check the result with caddy validate, then reload Caddy (with --address localhost:2019 the first time) and check that nothing answers on 127.0.0.1:2019"
    return 0
  fi

  site_new=$(mktemp "$CADDY_DIR/.staging.XXXXXX")
  render_caddy_site >"$site_new"
  chmod 0644 "$site_new"
  if [ -f "$CADDY_SITE" ] && cmp -s "$site_new" "$CADDY_SITE"; then
    rm -f "$site_new"
    site_new=""
    info "$CADDY_SITE is up to date."
  else
    if [ -f "$CADDY_SITE" ]; then
      site_backup="$CADDY_DIR/.staging.caddy.bak-$STAMP"
      cp -p "$CADDY_SITE" "$site_backup"
    fi
    mv -f "$site_new" "$CADDY_SITE"
    site_written=true
  fi
  if [ "$need_admin" = true ] || [ "$need_import" = true ]; then
    main_new="$(dirname "$CADDY_MAIN")/.first-twenty.Caddyfile.staging"
    {
      if [ "$need_admin" = true ]; then caddy_with_admin "$CADDY_MAIN"; else cat "$CADDY_MAIN"; fi
      [ "$need_import" = false ] ||
        printf '\n# Sites kept in files of their own, such as the First Twenty staging site (setup-auto-deploy.sh).\n%s\n' "$IMPORT_LINE"
    } >"$main_new"
    chmod 0644 "$main_new"
  fi

  # Puts the staging site and the main Caddyfile back as they were before this run.
  caddy_put_back() {
    if [ -n "$site_backup" ]; then
      mv -f "$site_backup" "$CADDY_SITE"
    elif [ "$site_written" = true ]; then
      rm -f "$CADDY_SITE"
    fi
    if [ -n "$main_new" ]; then
      rm -f "$main_new"
      [ ! -f "$CADDY_MAIN.bak-$STAMP" ] || cp -p "$CADDY_MAIN.bak-$STAMP" "$CADDY_MAIN"
    fi
  }

  if ! runuser -u caddy -- caddy validate --adapter caddyfile --config "${main_new:-$CADDY_MAIN}" >/dev/null 2>&1; then
    runuser -u caddy -- caddy validate --adapter caddyfile --config "${main_new:-$CADDY_MAIN}" || true
    caddy_put_back
    die "The Caddy configuration with the staging site did not validate (details above), so Caddy was left exactly as it was."
  fi
  if [ -n "$main_new" ]; then
    cp -p "$CADDY_MAIN" "$CADDY_MAIN.bak-$STAMP"
    mv -f "$main_new" "$CADDY_MAIN"
    [ "$need_admin" = false ] || info "Moved Caddy's admin API to $CADDY_ADMIN_SOCKET in $CADDY_MAIN (previous copy: $CADDY_MAIN.bak-$STAMP)."
    [ "$need_import" = false ] || info "Added \"$IMPORT_LINE\" to $CADDY_MAIN (previous copy: $CADDY_MAIN.bak-$STAMP)."
  fi
  if [ -n "$site_backup" ]; then
    info "Updated $CADDY_SITE (previous copy: $site_backup)."
  elif [ "$site_written" = true ]; then
    info "Wrote $CADDY_SITE."
  fi
  if ! caddy_reload; then
    # A reload that fails leaves Caddy running the configuration it had, so the files go back to match it.
    caddy_put_back
    die "Caddy did not take the new configuration, so it still runs the one it had and the files were put back. See: sudo journalctl -u caddy -n 50"
  fi
  if caddy_admin_on_tcp; then
    die "Caddy reloaded, but its admin API still answers on 127.0.0.1:2019, where code on staging could change the live sites. Staging was not started. See: sudo journalctl -u caddy -n 50"
  fi
  if [ -S "$CADDY_ADMIN_SOCKET" ]; then
    socket_mode=$(stat -c %a "$CADDY_ADMIN_SOCKET")
    # Anyone with write permission on the socket can use the admin API.
    if (((8#$socket_mode & 8#002) != 0)); then
      die "Caddy's admin socket $CADDY_ADMIN_SOCKET can be opened by every user (mode $socket_mode), so staging was not started. Add |0200 to the admin line in $CADDY_MAIN (admin unix/$CADDY_ADMIN_SOCKET|0200), reload Caddy (sudo systemctl reload caddy), then run this again."
    fi
  else
    warn "Caddy's admin socket $CADDY_ADMIN_SOCKET did not appear. 127.0.0.1:2019 is closed, so staging is safe from it, but sudo systemctl reload caddy may fail. See: sudo journalctl -u caddy -n 50"
  fi
  info "Caddy validated and reloaded; the live sites are unchanged, and its admin API is on $CADDY_ADMIN_SOCKET only."
}

# ------------------------------------------------------------------------------------------------
# Live
# ------------------------------------------------------------------------------------------------

setup_live() {
  local origin head keep

  step "Live: $LIVE_DIR fetches from $GIT_URL"
  origin=$(as_user "$DEPLOY_USER" git -C "$LIVE_DIR" remote get-url origin 2>/dev/null || true)
  if [ "$origin" = "$GIT_URL" ]; then
    info "origin is already $GIT_URL."
  elif [ -n "$origin" ]; then
    info "origin is $origin today; the team repo has its own history, so releases are fetched by exact commit and checked out detached."
    # The old address stays as a remote of its own, which no branch follows: a later git pull on the old
    # branch then fails (the histories differ) instead of bringing old code back.
    keep=previous-origin
    if as_user "$DEPLOY_USER" git -C "$LIVE_DIR" remote get-url "$keep" >/dev/null 2>&1; then keep=previous-origin-$STAMP; fi
    run_as "$DEPLOY_USER" git -C "$LIVE_DIR" remote add "$keep" "$origin"
    [ "$DRY_RUN" = true ] || info "The old address is kept as the remote \"$keep\" (git -C $LIVE_DIR remote -v)."
    run_as "$DEPLOY_USER" git -C "$LIVE_DIR" remote set-url origin "$GIT_URL"
  else
    run_as "$DEPLOY_USER" git -C "$LIVE_DIR" remote add origin "$GIT_URL"
  fi
  # Code copied over the checkout (deploy.sh --archive, rsync) shows up as changed files, and the live
  # channel never checks a release out over changes.
  if [ -n "$(as_user "$DEPLOY_USER" git -C "$LIVE_DIR" status --porcelain --untracked-files=no 2>/dev/null || true)" ]; then
    warn "$LIVE_DIR has changes to tracked files that are not committed (code copied with --archive or rsync"
    warn "leaves them), and the live channel will not check out a release over them. Look with:"
    warn "  git -C $LIVE_DIR status"
    warn "Once you are sure nothing there is needed (a release brings all the code), drop them with:"
    warn "  git -C $LIVE_DIR checkout -- ."
  fi

  step "Live: the updater's state in $LIVE_STATE"
  run install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" "$LIVE_STATE"
  head=$(as_user "$DEPLOY_USER" git -C "$LIVE_DIR" rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null || true)
  if [ -f "$LIVE_STATE/state" ] && grep -q '^deployed_sha=[0-9a-f]\{40\}$' "$LIVE_STATE/state"; then
    info "Kept the deployed commit already on record ($(sed -n 's/^deployed_sha=\(.\{7\}\).*/\1/p' "$LIVE_STATE/state"))."
  elif [ "$DRY_RUN" = true ]; then
    info "would record ${head:0:7} (checked out in $LIVE_DIR now) as deployed, so only a newer release deploys"
  else
    as_user "$DEPLOY_USER" "$UPDATER" live --record-deployed
  fi

  step "Live: systemd units (as $DEPLOY_USER)"
  render_live_unit | put_if_changed "$UNIT_DIR/first-twenty-autoupdate-live.service" 0644 root:root
  put_if_changed "$UNIT_DIR/first-twenty-autoupdate-live.timer" 0644 root:root <"$SCRIPT_DIR/first-twenty-autoupdate-live.timer"
  run systemctl daemon-reload
  run systemctl enable --now --quiet first-twenty-autoupdate-live.timer
}

[ "$DO_STAGING" = false ] || setup_staging
[ "$DO_LIVE" = false ] || setup_live

# ------------------------------------------------------------------------------------------------
# What happens now
# ------------------------------------------------------------------------------------------------

if [ "$DRY_RUN" = true ]; then
  printf '\nDry run finished: nothing was changed. Run it again without --dry-run to set this up.\n'
  exit 0
fi

printf '\nAutomatic deploys are set up.\n'
if [ "$DO_STAGING" = true ]; then
  cat <<EOF

Staging: the first deploy of main has started (a few minutes on this instance). Follow it with
  sudo journalctl -u first-twenty-autoupdate-staging -f
then open https://$STAGING_DOMAIN. From now on every merge to main that passes CI is there within minutes.
Pause it with: sudo touch $STAGING_ENV_DIR/autodeploy.paused   (rm the file to resume)
EOF
fi
if [ "$DO_LIVE" = true ]; then
  cat <<EOF

Live: nothing changes until $RELEASE_AUTHOR publishes a newer release on GitHub (Releases > Draft a new
release, a new tag on main, Publish release). Within 5 minutes of that, once the release's commit has
passed CI, the server backs up the database (when migrations are pending) and deploys it. Logs:
  sudo journalctl -u first-twenty-autoupdate-live -n 100
Pause it with: sudo touch /etc/first-twenty/autodeploy.paused   (rm the file to resume)
EOF
fi
