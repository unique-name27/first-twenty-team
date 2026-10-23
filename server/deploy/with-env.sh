#!/usr/bin/env bash
# First Twenty: run one command with the server's settings from /etc/first-twenty/env.
#
# The settings file is readable only by root (systemd reads it for the service), so this script uses
# sudo to read it, then runs your command as you, not as root, with your own PATH. Values travel in the
# environment, never on the command line, so they do not show up in ps or your shell history.
#
# Usage, from /opt/first-twenty:
#   bash server/deploy/with-env.sh npm run server:migrate
#   bash server/deploy/with-env.sh npm run server:create-admin -- --email you@company.com
#
#   bash server/deploy/with-env.sh npm run server:after-restore
#
# Schema work runs as the owner: for `npm run server:migrate` and `npm run server:after-restore`,
# DATABASE_URL is replaced by MIGRATION_DATABASE_URL (the first_twenty_owner role) when that is set.
# Every other command gets the server's own DATABASE_URL and never sees MIGRATION_DATABASE_URL.
#
# FIRST_TWENTY_ENV=/path/to/file points it at another settings file (for example a staging copy).

set -euo pipefail

ENV_FILE=${FIRST_TWENTY_ENV:-/etc/first-twenty/env}
SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }

[ $# -gt 0 ] || die "Say which command to run, for example: bash $0 npm run server:migrate"

if [ "$(id -u)" -ne 0 ]; then
  # Re-run through sudo to read the root-only file. SUDO_USER tells us who to run the command as, and
  # FT_CALLER_PATH carries your PATH across: sudo's secure_path would otherwise hide commands such as an
  # npm that lives in /usr/local/bin.
  exec sudo FIRST_TWENTY_ENV="$ENV_FILE" FT_CALLER_PATH="$PATH" bash "$SELF" "$@"
fi

[ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist. Run server/deploy/setup-ec2.sh first."

# Reads KEY=value lines the way systemd's EnvironmentFile does (comments and blank lines skipped,
# matching outer quotes removed) and exports them. Nothing is evaluated by the shell.
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
    if [[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      export "$key=$value"
    fi
  done <"$1"
}

load_env "$ENV_FILE"
export NODE_ENV=${NODE_ENV:-production}

# Prints the npm script when the command is one that changes the schema or the sync counters
# (npm run server:migrate, with or without -- --status, and npm run server:after-restore).
owner_command() {
  local arg
  for arg in "$@"; do
    case "$arg" in server:migrate | server:after-restore) printf '%s' "$arg"; return 0 ;; esac
  done
  return 1
}

if OWNER_CMD=$(owner_command "$@"); then
  if [ -n "${MIGRATION_DATABASE_URL:-}" ]; then
    case "$MIGRATION_DATABASE_URL" in
      *CHANGE_ME*) die "MIGRATION_DATABASE_URL in $ENV_FILE still has the CHANGE_ME placeholder. Put the first_twenty_owner password in it (docs/SERVER.md, step 3)." ;;
    esac
    export DATABASE_URL=$MIGRATION_DATABASE_URL
    note "Running $OWNER_CMD as the schema owner (MIGRATION_DATABASE_URL)."
  else
    note "NOTE: MIGRATION_DATABASE_URL is not set in $ENV_FILE, so $OWNER_CMD runs as the server's own role."
    note "      That works only on a setup from before the two-role split (docs/SERVER.md, \"Two database roles\")."
  fi
fi
unset MIGRATION_DATABASE_URL

# Only the value this command will use matters; a CHANGE_ME in a comment of the file does not.
case "${DATABASE_URL:-}" in
  *CHANGE_ME*) note "WARNING: DATABASE_URL in $ENV_FILE still contains CHANGE_ME. Put the real database password in it first." ;;
esac

# The command runs with the caller's PATH (or, when started as root directly, root's PATH plus
# /usr/local/bin, where setup-ec2.sh may link npm).
CMD_PATH=${FT_CALLER_PATH:-$PATH}
unset FT_CALLER_PATH
case ":$CMD_PATH:" in *:/usr/local/bin:*) ;; *) CMD_PATH=$CMD_PATH:/usr/local/bin ;; esac

RUN_AS=${SUDO_USER:-}
if [ -n "$RUN_AS" ] && [ "$RUN_AS" != "root" ]; then
  # runuser keeps these exported variables and the terminal, so password prompts stay hidden. env sets
  # PATH before it looks the command up.
  exec runuser -u "$RUN_AS" -- env PATH="$CMD_PATH" "$@"
fi
export PATH=$CMD_PATH
exec "$@"
