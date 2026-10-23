#!/usr/bin/env bash
# First Twenty: back up the database with pg_dump, keep 14 days, optionally copy each dump to S3.
#
# setup-ec2.sh installs this as /usr/local/sbin/first-twenty-backup and runs it every night at 03:15
# server time with a systemd timer (first-twenty-backup.timer). Run one by hand any time:
#   sudo /usr/local/sbin/first-twenty-backup
#   sudo journalctl -u first-twenty-backup -n 20        what the last nightly run said
#   systemctl status first-twenty-backup --no-pager     "failed" here means last night's backup failed
# Nothing emails you when a backup fails, so look now and then (docs/SERVER.md, "What runs every night").
#
# pg_dump must be the same major version as the database server, or newer: an older pg_dump refuses to
# run ("server version mismatch"). When it is missing or too old, this script says which package to
# install for your server's version.
#
# Prefer cron? Install setup-ec2.sh with --no-backups, copy this script yourself
# (sudo install -m 700 server/deploy/backup.sh /usr/local/sbin/first-twenty-backup), make sure cron runs
# (Amazon Linux 2023 has none by default: sudo dnf install cronie && sudo systemctl enable --now crond)
# and create /etc/cron.d/first-twenty-backup containing this one line:
#   15 3 * * * root /usr/local/sbin/first-twenty-backup >>/var/log/first-twenty-backup.log 2>&1
#
# Settings come from /etc/first-twenty/env; a variable already set in the environment wins:
#   MIGRATION_DATABASE_URL  the schema owner's connection; used when set, so the dump always covers every
#                           table (falls back to DATABASE_URL while it is unset or still CHANGE_ME)
#   DATABASE_URL       the connection the server uses (required)
#   BACKUP_DIR         where dumps go (default /var/backups/first-twenty, root only)
#   BACKUP_KEEP_DAYS   days of dumps to keep (default 14)
#   BACKUP_S3_URI      optional, for example s3://your-bucket-name/first-twenty/ . Needs the aws CLI and
#                      an instance role allowed to s3:PutObject there; never put access keys on the box.
#                      That role cannot read the copies back: restore one by downloading it on your own
#                      computer (docs/SERVER.md, "Restore a backup").
#   PG_DUMP, PG_RESTORE  optional paths to a specific client version, for example
#                      /usr/lib/postgresql/17/bin/pg_dump (default: pg_dump and pg_restore on PATH)
#   FIRST_TWENTY_DIR   the code folder (default /opt/first-twenty); its node_modules/pg is used to ask
#                      the server for its version when psql is not installed
#
# Each run writes first-twenty-YYYYMMDD-HHMMSSZ.dump (pg_dump custom format: compressed, and restorable
# table by table with pg_restore). Old dumps are removed only after a new one succeeded.
# Restore steps: docs/SERVER.md, "Backups and restore".

set -euo pipefail
umask 077

ENV_FILE=${FIRST_TWENTY_ENV:-/etc/first-twenty/env}

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# Reads KEY=value lines the way systemd's EnvironmentFile does and exports the ones not already set.
load_env() {
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    line=${line#"${line%%[![:space:]]*}"}
    case "$line" in '' | '#'* | ';'*) continue ;; esac
    line=${line#export }
    case "$line" in *=*) ;; *) continue ;; esac
    key=${line%%=*}
    key=${key%"${key##*[![:space:]]}"}
    value=${line#*=}
    value=${value#"${value%%[![:space:]]*}"}
    value=${value%"${value##*[![:space:]]}"}
    if [ ${#value} -ge 2 ]; then
      case "$value" in
        \"*\" | \'*\') value=${value:1:${#value}-2} ;;
      esac
    fi
    if [[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && [ -z "${!key+x}" ]; then
      export "$key=$value"
    fi
  done <"$1"
}

if [ -f "$ENV_FILE" ]; then
  [ -r "$ENV_FILE" ] || die "Cannot read $ENV_FILE. Run with sudo."
  load_env "$ENV_FILE"
fi

BACKUP_DIR=${BACKUP_DIR:-/var/backups/first-twenty}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
BACKUP_S3_URI=${BACKUP_S3_URI:-}
PG_DUMP=${PG_DUMP:-pg_dump}
PG_RESTORE=${PG_RESTORE:-pg_restore}
FIRST_TWENTY_DIR=${FIRST_TWENTY_DIR:-/opt/first-twenty}

[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set (expected in $ENV_FILE)."
# The schema owner sees every table, so prefer its connection when it is filled in.
DUMP_URL=$DATABASE_URL
DUMP_VAR=DATABASE_URL
if [ -n "${MIGRATION_DATABASE_URL:-}" ]; then
  case "$MIGRATION_DATABASE_URL" in
    *CHANGE_ME*) log "MIGRATION_DATABASE_URL still has CHANGE_ME, so backing up with DATABASE_URL instead." ;;
    *) DUMP_URL=$MIGRATION_DATABASE_URL; DUMP_VAR=MIGRATION_DATABASE_URL ;;
  esac
fi
case "$DUMP_URL" in
  pglite:*) die "$DUMP_VAR points at PGlite (development). Backups are for a real Postgres database." ;;
  postgres://* | postgresql://*) ;;
  *) die "$DUMP_VAR must start with postgres:// or postgresql://." ;;
esac
case "$DUMP_URL" in *CHANGE_ME*) die "$DUMP_VAR still has the CHANGE_ME placeholder." ;; esac
[[ $BACKUP_KEEP_DAYS =~ ^[1-9][0-9]*$ ]] || die "BACKUP_KEEP_DAYS must be a whole number of days (got \"$BACKUP_KEEP_DAYS\")."
if [ -n "$BACKUP_S3_URI" ]; then
  case "$BACKUP_S3_URI" in s3://?*) ;; *) die "BACKUP_S3_URI must look like s3://bucket-name/folder/." ;; esac
fi

# Split the URL into libpq variables so the password goes through the environment (PGPASSWORD),
# never through the command line where other users could see it in ps.
PARTS=()
if command -v node >/dev/null 2>&1; then
  mapfile -t PARTS < <(
    DUMP_URL=$DUMP_URL node -e '
      const u = new URL(process.env.DUMP_URL)
      const q = u.searchParams
      const d = (s) => decodeURIComponent(s)
      const lines = [
        q.get("host") || u.hostname.replace(/^\[|\]$/g, "") || "127.0.0.1",
        u.port || q.get("port") || "5432",
        d(u.username),
        d(u.password),
        d(u.pathname.replace(/^\//, "")),
        q.get("sslmode") || "",
      ]
      if (lines.some((l) => l.includes("\n"))) process.exit(3)
      process.stdout.write(lines.join("\n") + "\n")
    ' 2>/dev/null || true
  )
fi
if [ "${#PARTS[@]}" -eq 6 ]; then
  export PGHOST=${PARTS[0]} PGPORT=${PARTS[1]} PGUSER=${PARTS[2]} PGDATABASE=${PARTS[4]}
  if [ -n "${PARTS[3]}" ]; then export PGPASSWORD=${PARTS[3]}; fi
  if [ -n "${PARTS[5]}" ]; then export PGSSLMODE=${PARTS[5]}; fi
  CONNECT_ARGS=()
else
  # No node, or a form only libpq understands (such as a Unix socket path): let pg_dump read it.
  log "Passing $DUMP_VAR to pg_dump as is."
  CONNECT_ARGS=(--dbname="$DUMP_URL")
fi
export PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-10}

# The database server's major version (for example 17), or nothing when it cannot be found out. Asks
# with psql when it is installed, else with node and the pg driver from the app's node_modules.
server_major() {
  local num=""
  if command -v psql >/dev/null 2>&1; then
    num=$(psql "${CONNECT_ARGS[@]}" -XAtqc 'SHOW server_version_num' 2>/dev/null || true)
  fi
  if [ -z "$num" ] && [ "${#CONNECT_ARGS[@]}" -eq 0 ] && command -v node >/dev/null 2>&1 &&
    [ -d "$FIRST_TWENTY_DIR/node_modules/pg" ]; then
    # pg reads PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE and PGSSLMODE from the environment.
    num=$(cd "$FIRST_TWENTY_DIR" && node -e '
      const { Client } = require("pg")
      const c = new Client({ connectionTimeoutMillis: 10000 })
      c.connect()
        .then(() => c.query("SHOW server_version_num"))
        .then((r) => { process.stdout.write(String(r.rows[0].server_version_num)); return c.end() })
        .catch(() => process.exit(1))
    ' 2>/dev/null || true)
  fi
  if [[ $num =~ ^[0-9]{5,6}$ ]]; then printf '%s' "$((num / 10000))"; fi
}

# What to install for server major version $1 (or a general hint when it is unknown).
client_hint() {
  if [ -n "$1" ]; then
    printf 'Your database server is Postgres %s, so install the Postgres %s client (the same major version or newer). Amazon Linux: sudo dnf install postgresql%s   Ubuntu: sudo apt-get install postgresql-client-%s (from apt.postgresql.org if your Ubuntu release does not have it).' "$1" "$1" "$1" "$1"
  else
    printf 'Install the Postgres client with the same major version as your database server, or newer (see the server version with: SHOW server_version). Amazon Linux: sudo dnf install postgresql<version>   Ubuntu: sudo apt-get install postgresql-client-<version>.'
  fi
}

if ! command -v "$PG_DUMP" >/dev/null 2>&1; then
  die "pg_dump is not installed ($PG_DUMP not found). $(client_hint "$(server_major)")"
fi
command -v "$PG_RESTORE" >/dev/null 2>&1 || die "pg_restore is not installed ($PG_RESTORE not found; it comes with pg_dump). $(client_hint "$(server_major)")"
# An older pg_dump stops with "server version mismatch"; say what to install instead of failing later.
DUMP_MAJOR=$("$PG_DUMP" --version 2>/dev/null | sed -nE 's/^pg_dump \(PostgreSQL\) ([0-9]+).*/\1/p' || true)
SERVER_MAJOR=$(server_major)
if [[ $DUMP_MAJOR =~ ^[0-9]+$ ]] && [[ $SERVER_MAJOR =~ ^[0-9]+$ ]] && [ "$DUMP_MAJOR" -lt "$SERVER_MAJOR" ]; then
  die "pg_dump $DUMP_MAJOR is older than the database server, so it would refuse to run. $(client_hint "$SERVER_MAJOR")"
fi

install -d -m 0700 "$BACKUP_DIR"

# One backup at a time.
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || die "Another backup is already running."

STAMP=$(date -u +%Y%m%d-%H%M%SZ)
FINAL=$BACKUP_DIR/first-twenty-$STAMP.dump
PARTIAL=$BACKUP_DIR/.first-twenty-$STAMP.dump.partial
trap 'rm -f "$PARTIAL"' EXIT

log "Backing up database ${PGDATABASE:-from $DUMP_VAR} as ${PGUSER:-the role in $DUMP_VAR} to $FINAL"
"$PG_DUMP" "${CONNECT_ARGS[@]}" --format=custom --file="$PARTIAL"
# A dump that pg_restore cannot list is not a backup.
"$PG_RESTORE" --list "$PARTIAL" >/dev/null || die "The new dump failed its check; older backups were kept."
mv "$PARTIAL" "$FINAL"
log "Wrote $(du -h "$FINAL" | cut -f1) to $FINAL"

# Rotation: keep BACKUP_KEEP_DAYS days of dumps. Runs only after today's dump succeeded.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'first-twenty-*.dump' -mtime "+$((BACKUP_KEEP_DAYS - 1))" -print -delete |
  while IFS= read -r old; do log "Removed old backup $old"; done
find "$BACKUP_DIR" -maxdepth 1 -type f -name '.first-twenty-*.partial' -mtime +0 -delete

if [ -n "$BACKUP_S3_URI" ]; then
  command -v aws >/dev/null 2>&1 || die "BACKUP_S3_URI is set but the aws CLI is not installed. The local backup is fine."
  DEST=${BACKUP_S3_URI%/}/$(basename "$FINAL")
  log "Copying to $DEST"
  aws s3 cp "$FINAL" "$DEST" --only-show-errors --sse AES256 ||
    die "Copy to S3 failed (check the instance role and bucket name). The local backup is fine."
  log "Copied to S3. Set a lifecycle rule on the bucket to expire old copies."
fi

log "Backup finished."
