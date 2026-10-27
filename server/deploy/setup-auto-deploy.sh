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
#     pg_hba.conf lines keep the staging roles in that database (backed up first)
#   - /etc/first-twenty-staging/env: port 8788, open sign-up with demo limits, no assistant, no careers
#   - /opt/first-twenty-staging: a clone of the team repo, owned by first-twenty-staging
#   - first-twenty-staging.service, first-twenty-staging-migrate.service, and
#     first-twenty-autoupdate-staging.service and .timer (every 5 minutes)
#   - /etc/sudoers.d/first-twenty-staging: first-twenty-staging may start first-twenty-staging-migrate and
#     restart first-twenty-staging, nothing else (checked with visudo first)
#   - /etc/caddy/first-twenty.d/staging.caddy for the staging domain, and the line that imports it in
#     /etc/caddy/Caddyfile (backed up first, checked with caddy validate before Caddy reloads)
#
# Live (skipped with --staging-only):
#   - switches the origin of /opt/first-twenty to the public team repo over HTTPS
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
# It never touches the live database, its roles, /etc/first-twenty/env or the live Caddy sites.

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
CADDY_MAIN=/etc/caddy/Caddyfile
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

# The pg_hba.conf lines for the staging roles: their own database, and nothing else (the first matching
# line wins, so they go at the top; they match the staging roles only).
hba_block() {
  cat <<EOF
# BEGIN first-twenty-staging (setup-auto-deploy.sh): the staging roles reach $STAGING_DB only.
host    $STAGING_DB  $STAGING_ROLE,$STAGING_OWNER  127.0.0.1/32  scram-sha-256
host    $STAGING_DB  $STAGING_ROLE,$STAGING_OWNER  ::1/128       scram-sha-256
host    all  $STAGING_ROLE,$STAGING_OWNER  127.0.0.1/32  reject
host    all  $STAGING_ROLE,$STAGING_OWNER  ::1/128       reject
# END first-twenty-staging
EOF
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
  for c in psql caddy visudo useradd; do
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
  local objects need_passwords app_pw owner_pw hba errors

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
  if [ -z "$hba" ] || [ ! -f "$hba" ]; then
    warn "Could not find pg_hba.conf, so the staging roles were not limited to $STAGING_DB there. Add these lines at the top of it by hand:"
    hba_block | sed 's/^/      /' >&2
  elif grep -q '^# BEGIN first-twenty-staging' "$hba"; then
    info "$hba already has the staging lines."
  elif [ "$DRY_RUN" = true ]; then
    info "would back up $hba to $hba.bak-$STAMP and add at its top:"
    hba_block | sed 's/^/      /'
    info "would check the file (pg_hba_file_rules) and reload Postgres"
  else
    cp -p "$hba" "$hba.bak-$STAMP"
    { hba_block; cat "$hba.bak-$STAMP"; } >"$hba"
    errors=$(pg_value 'SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL' || echo unknown)
    if [ "$errors" != 0 ]; then
      cp -p "$hba.bak-$STAMP" "$hba"
      die "Postgres rejected the new pg_hba.conf lines, so the file was put back as it was ($hba.bak-$STAMP)."
    fi
    pg_value 'SELECT pg_reload_conf()' >/dev/null
    info "Added the staging lines to $hba (previous copy: $hba.bak-$STAMP) and reloaded Postgres."
  fi

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

# Writes the staging site, adds the import line to the main Caddyfile when it is missing, checks the result
# with caddy validate (as the caddy user, as setup-ec2.sh does) and reloads Caddy. Anything that does not
# validate is put back as it was.
setup_caddy() {
  local site_new main_new="" site_backup="" site_written=false import_re
  run install -d -m 0755 "$CADDY_DIR"
  run install -d -m 0750 -o caddy -g caddy /var/log/caddy
  if [ ! -f "$CADDY_LOG" ]; then
    run install -m 0640 -o caddy -g caddy /dev/null "$CADDY_LOG"
  fi
  import_re="^[[:space:]]*import[[:space:]]+$(printf '%s' "$CADDY_DIR" | sed 's/[.]/\\./g')/\\*\\.caddy[[:space:]]*$"

  if [ "$DRY_RUN" = true ]; then
    if [ -f "$CADDY_SITE" ] && render_caddy_site | cmp -s - "$CADDY_SITE"; then
      info "$CADDY_SITE is up to date."
    else
      info "would write $CADDY_SITE for $STAGING_DOMAIN (proxy to 127.0.0.1:$STAGING_PORT)"
    fi
    if [ -f "$CADDY_MAIN" ] && grep -Eq "$import_re" "$CADDY_MAIN"; then
      info "$CADDY_MAIN already imports $CADDY_DIR."
    else
      info "would back up $CADDY_MAIN to $CADDY_MAIN.bak-$STAMP and add: $IMPORT_LINE"
    fi
    info "would check the result with caddy validate, then: systemctl reload caddy"
    return 0
  fi

  [ -f "$CADDY_MAIN" ] || die "$CADDY_MAIN is missing. Run server/deploy/setup-ec2.sh first."
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
  if ! grep -Eq "$import_re" "$CADDY_MAIN"; then
    main_new=/etc/caddy/.first-twenty.Caddyfile.import
    {
      cat "$CADDY_MAIN"
      printf '\n# Sites kept in files of their own, such as the First Twenty staging site (setup-auto-deploy.sh).\n%s\n' "$IMPORT_LINE"
    } >"$main_new"
    chmod 0644 "$main_new"
  fi

  if ! runuser -u caddy -- caddy validate --adapter caddyfile --config "${main_new:-$CADDY_MAIN}" >/dev/null 2>&1; then
    runuser -u caddy -- caddy validate --adapter caddyfile --config "${main_new:-$CADDY_MAIN}" || true
    [ -z "$main_new" ] || rm -f "$main_new"
    if [ -n "$site_backup" ]; then
      mv -f "$site_backup" "$CADDY_SITE"
    elif [ "$site_written" = true ]; then
      rm -f "$CADDY_SITE"
    fi
    die "The Caddy configuration with the staging site did not validate (details above), so Caddy was left exactly as it was."
  fi
  if [ -n "$main_new" ]; then
    cp -p "$CADDY_MAIN" "$CADDY_MAIN.bak-$STAMP"
    mv -f "$main_new" "$CADDY_MAIN"
    info "Added \"$IMPORT_LINE\" to $CADDY_MAIN (previous copy: $CADDY_MAIN.bak-$STAMP)."
  fi
  if [ -n "$site_backup" ]; then
    info "Updated $CADDY_SITE (previous copy: $site_backup)."
  elif [ "$site_written" = true ]; then
    info "Wrote $CADDY_SITE."
  fi
  systemctl reload caddy || die "Caddy rejected the new configuration on reload. See: sudo journalctl -u caddy -n 50"
  info "Caddy validated and reloaded; the live sites are unchanged."
}

# ------------------------------------------------------------------------------------------------
# Live
# ------------------------------------------------------------------------------------------------

setup_live() {
  local origin head

  step "Live: $LIVE_DIR fetches from $GIT_URL"
  origin=$(as_user "$DEPLOY_USER" git -C "$LIVE_DIR" remote get-url origin 2>/dev/null || true)
  if [ "$origin" = "$GIT_URL" ]; then
    info "origin is already $GIT_URL."
  elif [ -n "$origin" ]; then
    info "origin is $origin today; the team repo has its own history, so releases are fetched by exact commit and checked out detached."
    run_as "$DEPLOY_USER" git -C "$LIVE_DIR" remote set-url origin "$GIT_URL"
  else
    run_as "$DEPLOY_USER" git -C "$LIVE_DIR" remote add origin "$GIT_URL"
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
