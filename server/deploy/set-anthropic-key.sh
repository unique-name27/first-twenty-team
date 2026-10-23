#!/usr/bin/env bash
# First Twenty: turn on the assistant (docs/SERVER.md, "Lark, the assistant") by saving an Anthropic API
# key in /etc/first-twenty/env, then restart the server.
#
# Run it on the instance, in an interactive terminal (ssh -t):
#   sudo bash server/deploy/set-anthropic-key.sh            asks for the key and turns the assistant on
#   sudo bash server/deploy/set-anthropic-key.sh --stdin    reads the key from standard input instead (for a
#                                                           helper that pipes it from the clipboard over ssh)
#   sudo bash server/deploy/set-anthropic-key.sh --remove   deletes the key and turns the assistant off
#
# The key is read without echo, written only to the settings file (root, mode 600, through a temporary file
# in the same folder, so the file is never half written), and never printed, logged or put on a command
# line. Run it again to replace the key.
set -euo pipefail

ENV_FILE=${FIRST_TWENTY_ENV:-/etc/first-twenty/env}
SERVICE=first-twenty
KEY_LINE='^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY[[:space:]]*='

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run it with sudo: sudo bash $0"
[ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist. Run server/deploy/setup-ec2.sh first."

# Writes the settings file without any ANTHROPIC_API_KEY line, plus the line in $1 when given.
rewrite() {
  local tmp
  tmp=$(mktemp "${ENV_FILE}.XXXXXX")
  grep -Ev "$KEY_LINE" "$ENV_FILE" >"$tmp" || true
  if [ -n "${1:-}" ]; then printf '%s\n' "$1" >>"$tmp"; fi
  chown --reference="$ENV_FILE" "$tmp"
  chmod 0600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# The assistant state the server logged when it last started ("off", "fake" or the model), or nothing.
assistant_state() {
  journalctl -u "$SERVICE" -n 40 --no-pager -o cat 2>/dev/null | grep -o '"assistant":"[^"]*"' | tail -n 1 || true
}

restart() {
  systemctl restart "$SERVICE"
  for _ in $(seq 1 20); do
    systemctl is-active --quiet "$SERVICE" && break
    sleep 1
  done
  systemctl is-active --quiet "$SERVICE" || die "$SERVICE did not start again. See: sudo journalctl -u $SERVICE -n 50"
}

if [ "${1:-}" = "--remove" ]; then
  rewrite ""
  restart
  echo "Removed the key. The server restarted and reports $(assistant_state)."
  exit 0
fi
umask 077
if [ "${1:-}" = "--stdin" ]; then
  IFS= read -r key || true
elif [ $# -eq 0 ]; then
  [ -t 0 ] || die "Run this in an interactive terminal (ssh -t) so the key can be typed without showing it, or pipe it in with --stdin."
  printf 'Paste your Anthropic API key (it will not show), then press Enter: '
  IFS= read -rs key
  echo
else
  die "Unknown argument: $1 (use --stdin to pipe the key in, or --remove to turn the assistant off)."
fi
key=${key//[[:space:]]/}
[[ $key =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]] || die "That does not look like an Anthropic API key (they start with sk-ant-). Nothing was changed."

rewrite "ANTHROPIC_API_KEY=$key"
unset key
restart
echo "Saved. The server restarted and reports $(assistant_state)."
