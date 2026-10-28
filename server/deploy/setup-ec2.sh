#!/usr/bin/env bash
# First Twenty: one-time setup for an EC2 instance that already runs Postgres.
# Supports Amazon Linux 2023 and Ubuntu 22.04 / 24.04. Safe to run again: every step checks first.
#
# What it does:
#   - installs Node.js 22 LTS, git and Caddy (from the official Caddy repository; on Ubuntu, from
#     Ubuntu's own caddy package when that repository cannot be used)
#   - on Ubuntu, lets unattended-upgrades install Node.js updates too, and reboot at 04:30 when an update
#     needs it (/etc/apt/apt.conf.d/51first-twenty, written once)
#   - creates the firsttwenty system user that runs the server
#   - puts the code in /opt/first-twenty (copied from wherever you unpacked or cloned it)
#   - creates /etc/first-twenty/env from .env.example if it is missing (mode 600, root:firsttwenty)
#   - installs the systemd unit, the Caddyfile for your domain (and a site per careers domain) and the
#     nightly backup timer
#   - enables the services, starts what can start, and prints the next steps
#
# What it does not do: install, upgrade or reconfigure Postgres if Postgres already exists on this
# instance. Pass --install-postgres on a fresh box that has no Postgres yet.
#
# Usage (from the folder you cloned or unpacked):
#   sudo bash server/deploy/setup-ec2.sh hr.example.com
#   sudo bash server/deploy/setup-ec2.sh --domain hr.example.com --email you@example.com
#   sudo bash server/deploy/setup-ec2.sh hr.example.com --careers-domain careers.example.com
#
# Options:
#   --domain NAME        the domain people will open (its DNS A record points at this instance)
#   --careers-domain NAME
#                        a host name for the companies' careers pages (its DNS A record points at this
#                        instance too); repeat it for more. Each gets a Caddy site of its own, and a new
#                        settings file gets CAREERS_HOSTS. Without it, a re-run keeps the careers hosts
#                        that CAREERS_HOSTS in the settings file names (docs/SERVER.md, "Careers pages")
#   --email ADDRESS      optional contact email for certificate expiry notices
#   --deploy-user NAME   the login that owns the code and runs deploy.sh (default: the user who ran sudo,
#                        else ec2-user or ubuntu)
#   --install-postgres   install Postgres from the OS packages, only when none exists yet (it stops
#                        when the release's package is older than Postgres 15, as on Ubuntu 22.04)
#   --swap SIZE          add a swap file of this size (for example 1G or 2G) if the instance has no swap.
#                        Without it, an instance with under 2 GB of memory (a t3.micro has about 900 MB)
#                        gets a 2G swap file, so it can build. Either way the disk must keep 1 GB free
#                        on top of the swap file, because Postgres writes to the same disk.
#   --no-swap            never add a swap file
#   --no-backups         skip the nightly backup timer
#   -h, --help           show this help
#
# It never creates, changes or drops a database or a role. It only reads whether the first_twenty
# database and its two roles exist, to tell you whether postgres-setup.sql still needs to run.
#
# Environment overrides: NODE_MAJOR (default 22), PG_MAJOR (Amazon Linux --install-postgres, default 16).

set -euo pipefail

APP_DIR=/opt/first-twenty
ENV_DIR=/etc/first-twenty
ENV_FILE=$ENV_DIR/env
APP_USER=firsttwenty
SERVICE=first-twenty
STATE_DIR=/var/lib/first-twenty
BACKUP_DIR=/var/backups/first-twenty
NODE_MAJOR=${NODE_MAJOR:-22}
PG_MAJOR=${PG_MAJOR:-16}
# The oldest Postgres the migrations run on (007's views read with the reader's own rights, new in 15).
MIN_PG_MAJOR=15
SWAPFILE=/swapfile
FSTAB=/etc/fstab
# Disk space a swap file must leave free: the root disk also holds Postgres and every database on it.
SWAP_MARGIN_BYTES=$((1024 * 1024 * 1024))

DOMAIN=""
ACME_EMAIL=""
DEPLOY_USER=""
INSTALL_POSTGRES=false
SWAP_SIZE=""
SWAP_AUTO=false
NO_SWAP=false
ENABLE_BACKUPS=true
# The command that sets PUBLIC_ORIGIN, when a settings file setup kept does not have https://$DOMAIN.
ORIGIN_FIX=""
# Careers host names (--careers-domain), space-separated, and the command that sets CAREERS_HOSTS when a
# settings file setup kept names other ones.
CAREERS_DOMAINS=""
CAREERS_FIX=""
UNATTENDED_CONF=/etc/apt/apt.conf.d/51first-twenty

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'
}

need_value() {
  [ -n "${2:-}" ] && [ "${2#-}" = "$2" ] || die "$1 needs a value. Run with --help for usage."
}

normalize_domain() {
  # Prints $1 as a host name: lowercase, without a leading https:// or http:// or a trailing slash.
  local d
  d=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  d=${d#https://}
  d=${d#http://}
  printf '%s' "${d%/}"
}

is_domain() {
  # True when $1 is a host name Caddy can get a certificate for: dot-separated labels, a top-level domain.
  printf '%s' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
}

add_careers_domain() {
  # Adds host name $1 (normalized) to CAREERS_DOMAINS once, or stops when it is not a host name.
  local d
  d=$(normalize_domain "$1")
  is_domain "$d" || die "\"$1\" does not look like a host name for --careers-domain (expected something like careers.example.com)."
  case " $CAREERS_DOMAINS " in
    *" $d "*) ;;
    *) CAREERS_DOMAINS="${CAREERS_DOMAINS:+$CAREERS_DOMAINS }$d" ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) need_value "$1" "${2:-}"; DOMAIN=$2; shift 2 ;;
    --domain=*) DOMAIN=${1#*=}; shift ;;
    --careers-domain) need_value "$1" "${2:-}"; add_careers_domain "$2"; shift 2 ;;
    --careers-domain=*) add_careers_domain "${1#*=}"; shift ;;
    --email) need_value "$1" "${2:-}"; ACME_EMAIL=$2; shift 2 ;;
    --email=*) ACME_EMAIL=${1#*=}; shift ;;
    --deploy-user) need_value "$1" "${2:-}"; DEPLOY_USER=$2; shift 2 ;;
    --deploy-user=*) DEPLOY_USER=${1#*=}; shift ;;
    --install-postgres) INSTALL_POSTGRES=true; shift ;;
    --swap) need_value "$1" "${2:-}"; SWAP_SIZE=$2; shift 2 ;;
    --swap=*) SWAP_SIZE=${1#*=}; shift ;;
    --no-swap) NO_SWAP=true; shift ;;
    --no-backups) ENABLE_BACKUPS=false; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) die "Unknown option: $1. Run with --help for usage." ;;
    *)
      [ -z "$DOMAIN" ] || die "Unexpected argument: $1 (the domain is already $DOMAIN)."
      DOMAIN=$1
      shift
      ;;
  esac
done

# ------------------------------------------------------------------------------------------------
# Checks
# ------------------------------------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "Run this with sudo: sudo bash $0 your-domain.com"

[ -n "$DOMAIN" ] || die "Pass your domain, for example: sudo bash $0 hr.example.com"
DOMAIN=$(normalize_domain "$DOMAIN")
if ! is_domain "$DOMAIN"; then
  die "\"$DOMAIN\" does not look like a domain name (expected something like hr.example.com)."
fi
# The server answers only careers pages on a careers host, so the app's own domain can never be one.
for d in $CAREERS_DOMAINS; do
  [ "$d" != "$DOMAIN" ] || die "--careers-domain $d is the app's own domain. Careers pages need a host name of their own, like careers.example.com."
done
if [ -n "$ACME_EMAIL" ] && ! printf '%s' "$ACME_EMAIL" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
  die "\"$ACME_EMAIL\" does not look like an email address."
fi
if [ -n "$SWAP_SIZE" ] && ! printf '%s' "$SWAP_SIZE" | grep -Eq '^[1-9][0-9]*[MG]$'; then
  die "--swap expects a size like 2G or 1024M."
fi
if [ -n "$SWAP_SIZE" ] && [ "$NO_SWAP" = true ]; then
  die "Pass --swap SIZE or --no-swap, not both."
fi
if [ "$DOMAIN" = "hr.example.com" ]; then
  warn "hr.example.com is the placeholder. Caddy cannot get a certificate for it."
fi

[ -r /etc/os-release ] || die "Cannot read /etc/os-release, so the OS is unknown."
# shellcheck disable=SC1091
. /etc/os-release
OS_ID=${ID:-unknown}
OS_VERSION=${VERSION_ID:-}
case "$OS_ID" in
  amzn)
    [ "${OS_VERSION%%.*}" = "2023" ] || die "Amazon Linux $OS_VERSION is not supported. Use Amazon Linux 2023."
    PKG=dnf
    ;;
  ubuntu)
    case "$OS_VERSION" in
      22.04 | 24.04) ;;
      *) warn "Ubuntu $OS_VERSION is untested (22.04 and 24.04 are). Continuing." ;;
    esac
    PKG=apt
    ;;
  *) die "Unsupported OS: ${PRETTY_NAME:-$OS_ID}. Use Amazon Linux 2023 or Ubuntu 22.04 / 24.04." ;;
esac

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SRC_DIR=$(cd "$SCRIPT_DIR/../.." && pwd -P)
[ -f "$SRC_DIR/package.json" ] && [ -f "$SRC_DIR/server/deploy/first-twenty.service" ] ||
  die "Run this script from inside the First Twenty code (server/deploy/setup-ec2.sh)."

if [ -z "$DEPLOY_USER" ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    DEPLOY_USER=$SUDO_USER
  elif id -u ec2-user >/dev/null 2>&1; then
    DEPLOY_USER=ec2-user
  elif id -u ubuntu >/dev/null 2>&1; then
    DEPLOY_USER=ubuntu
  else
    die "Cannot tell which login should own the code. Pass --deploy-user NAME."
  fi
fi
id -u "$DEPLOY_USER" >/dev/null 2>&1 || die "User $DEPLOY_USER does not exist."
[ "$DEPLOY_USER" != "root" ] || die "Pick a normal login as --deploy-user, not root."
[ "$DEPLOY_USER" != "$APP_USER" ] || die "--deploy-user must differ from $APP_USER (the service user)."

echo "First Twenty setup"
info "OS:          ${PRETTY_NAME:-$OS_ID $OS_VERSION}"
info "Domain:      $DOMAIN"
info "Code:        $APP_DIR (owned by $DEPLOY_USER)"
info "Settings:    $ENV_FILE"

# ------------------------------------------------------------------------------------------------
# Package helpers
# ------------------------------------------------------------------------------------------------

APT_UPDATED=false
apt_update() {
  if [ "$APT_UPDATED" = false ] || [ "${1:-}" = "force" ]; then
    apt-get update -y -q
    APT_UPDATED=true
  fi
}
apt_install() {
  apt_update
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "$@"
}
dnf_install() {
  dnf install -y -q "$@"
}

deploy_file() {
  # Prints the path of server/deploy/$1, preferring the copy in $APP_DIR.
  if [ -f "$APP_DIR/server/deploy/$1" ]; then
    echo "$APP_DIR/server/deploy/$1"
  elif [ -f "$SRC_DIR/server/deploy/$1" ]; then
    echo "$SRC_DIR/server/deploy/$1"
  else
    die "Cannot find server/deploy/$1."
  fi
}

fetch() {
  curl --proto '=https' --tlsv1.2 -fsSL "$@"
}

env_has_placeholder() {
  # True when the active NAME=... line in file $2 (not a comment) still holds CHANGE_ME.
  grep -Eq "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=.*CHANGE_ME" "$2"
}

env_setting() {
  # The value of the active NAME=... line in file $2 (the last one, as systemd reads them), unquoted.
  { sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*[\"']?([^\"']*)[\"']?[[:space:]]*$/\2/p" "$2" 2>/dev/null || true; } | tail -n 1
}

public_origin_fix() {
  # The commands that make PUBLIC_ORIGIN in settings file $1 https://$DOMAIN and apply it, or nothing when
  # it already is (a trailing slash or capitals are fine). Setup never rewrites a settings file it kept.
  local current
  current=$(env_setting PUBLIC_ORIGIN "$1" | tr '[:upper:]' '[:lower:]')
  [ "${current%/}" != "https://$DOMAIN" ] || return 0
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?PUBLIC_ORIGIN[[:space:]]*=' "$1"; then
    printf "sudo sed -i -E 's#^[[:space:]]*(export[[:space:]]+)?PUBLIC_ORIGIN[[:space:]]*=.*#PUBLIC_ORIGIN=https://%s#' %s && sudo systemctl restart %s" \
      "$DOMAIN" "$1" "$SERVICE"
  else
    printf "echo 'PUBLIC_ORIGIN=https://%s' | sudo tee -a %s >/dev/null && sudo systemctl restart %s" "$DOMAIN" "$1" "$SERVICE"
  fi
}

careers_from_settings() {
  # The host names in CAREERS_HOSTS of settings file $1, lowercase and space-separated, or nothing.
  env_setting CAREERS_HOSTS "$1" | tr ',' ' ' | tr '[:upper:]' '[:lower:]' | awk '{ $1 = $1; print }'
}

host_set() {
  # $1 (host names separated by commas or spaces) as one sorted, de-duplicated line, for comparing lists.
  printf '%s\n' "$1" | tr ', ' '\n\n' | sed '/^$/d' | sort -u | tr '\n' ' '
}

set_careers_hosts() {
  # Sets CAREERS_HOSTS in settings file $1 (one setup just made from .env.example, where the line is
  # commented out) to the careers domains, separated by commas: turns that line on, or adds one.
  local list
  list=$(printf '%s' "$CAREERS_DOMAINS" | tr ' ' ',')
  if grep -Eq '^#?[[:space:]]*CAREERS_HOSTS=' "$1"; then
    sed -i -E "s|^#?[[:space:]]*CAREERS_HOSTS=.*|CAREERS_HOSTS=${list}|" "$1"
  else
    echo "CAREERS_HOSTS=${list}" >>"$1"
  fi
}

careers_hosts_fix() {
  # The commands that make CAREERS_HOSTS in settings file $1 name the careers domains and apply it, or
  # nothing when it already does (in any order or case) or there are none. Setup never rewrites a
  # settings file it kept.
  local want
  [ -n "$CAREERS_DOMAINS" ] || return 0
  want=$(printf '%s' "$CAREERS_DOMAINS" | tr ' ' ',')
  [ "$(host_set "$(careers_from_settings "$1")")" != "$(host_set "$CAREERS_DOMAINS")" ] || return 0
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?CAREERS_HOSTS[[:space:]]*=' "$1"; then
    printf "sudo sed -i -E 's#^[[:space:]]*(export[[:space:]]+)?CAREERS_HOSTS[[:space:]]*=.*#CAREERS_HOSTS=%s#' %s && sudo systemctl restart %s" \
      "$want" "$1" "$SERVICE"
  else
    printf "echo 'CAREERS_HOSTS=%s' | sudo tee -a %s >/dev/null && sudo systemctl restart %s" "$want" "$1" "$SERVICE"
  fi
}

apt_postgres_major() {
  # The major version the OS postgresql package would install (14 on Ubuntu 22.04, 16 on 24.04), or
  # nothing when apt cannot say.
  apt-cache policy postgresql 2>/dev/null | sed -n -E 's/^[[:space:]]*Candidate:[[:space:]]*([0-9]+).*/\1/p' || true
}

local_server_major() {
  # The major version of the Postgres running on this instance (for example 16), or nothing.
  local num=""
  if command -v psql >/dev/null 2>&1 && id -u postgres >/dev/null 2>&1; then
    num=$(cd / && runuser -u postgres -- psql -XAtqc 'SHOW server_version_num' 2>/dev/null || true)
  fi
  if [[ $num =~ ^[0-9]{5,6}$ ]]; then printf '%s' "$((num / 10000))"; fi
}

first_twenty_objects() {
  # Whether the first_twenty database, the first_twenty role and the first_twenty_owner role exist on
  # this instance's Postgres, as "t|t|t" (or f in each place), or nothing when it cannot ask. It only
  # reads the catalog: setup never creates, changes or drops a database or role.
  command -v psql >/dev/null 2>&1 && id -u postgres >/dev/null 2>&1 || return 0
  (cd / && runuser -u postgres -- psql -XAtqc "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'first_twenty'), EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'first_twenty'), EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'first_twenty_owner')" 2>/dev/null) || true
}

node_major_at() {
  # Prints the major version of the node binary at $1, or 0.
  if [ -x "$1" ]; then
    "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
  else
    echo 0
  fi
}

# ------------------------------------------------------------------------------------------------
# Careers hosts: --careers-domain, else the ones a settings file from an earlier run names
# ------------------------------------------------------------------------------------------------

# Re-running setup rewrites the Caddyfile, so a re-run without --careers-domain keeps the careers sites
# that CAREERS_HOSTS asks for instead of dropping them.
if [ -z "$CAREERS_DOMAINS" ] && [ -f "$ENV_FILE" ]; then
  for d in $(careers_from_settings "$ENV_FILE"); do
    if is_domain "$d" && [ "$d" != "$DOMAIN" ]; then
      add_careers_domain "$d"
    else
      warn "Skipped \"$d\" in CAREERS_HOSTS of $ENV_FILE: it is not a host name setup can make a careers site for."
    fi
  done
  [ -z "$CAREERS_DOMAINS" ] || info "Careers:     $CAREERS_DOMAINS (from CAREERS_HOSTS in $ENV_FILE)"
elif [ -n "$CAREERS_DOMAINS" ]; then
  info "Careers:     $CAREERS_DOMAINS"
fi

# ------------------------------------------------------------------------------------------------
# 1. Base packages
# ------------------------------------------------------------------------------------------------

step "Installing base packages (git, curl, tar)"
if [ "$PKG" = apt ]; then
  apt_install ca-certificates curl gnupg git tar
else
  # Amazon Linux ships curl-minimal, which provides curl; installing the full curl package conflicts with it.
  dnf_install git tar
  command -v curl >/dev/null 2>&1 || dnf_install curl-minimal
fi
info "git $(git --version | awk '{print $3}')"

# ------------------------------------------------------------------------------------------------
# 2. Swap (2G by default under 2 GB of memory; --swap SIZE picks another size, --no-swap skips it)
# ------------------------------------------------------------------------------------------------

# True on an instance with under 2 GB of memory (MemTotal is a little under the nominal size).
low_memory() { [ "${MEM_KB:-0}" -lt 1800000 ]; }

# Without --swap or --no-swap, picks a 2G swap file for an instance with under 2 GB of memory, which is
# too little to run npm ci and the build. setup_swap still checks that the disk has room for it.
choose_swap() {
  if [ -n "$SWAP_SIZE" ] || [ "$NO_SWAP" = true ]; then return 0; fi
  if low_memory; then
    SWAP_SIZE=2G
    SWAP_AUTO=true
  fi
}

# Bytes in a size such as 2G or 1024M.
swap_bytes() {
  local n=${1%[MG]}
  case "$1" in
    *G) echo $((n * 1024 * 1024 * 1024)) ;;
    *) echo $((n * 1024 * 1024)) ;;
  esac
}

# A byte count as GB with one decimal, for messages.
human_size() { awk -v b="$1" 'BEGIN { printf "%.1f GB", b / 1073741824 }'; }

# Bytes free (for a non-root user, which is what Postgres is) on the filesystem holding folder $1.
free_bytes() {
  df --output=avail -B1 "$1" 2>/dev/null | awk 'NR == 2 { print $1 }'
}

# Succeeds when the disk holding $SWAPFILE has room for a swap file of size $1 and still keeps 1 GB
# free for Postgres and everything else on it. Otherwise prints why and fails.
swap_fits() {
  local dir need avail
  dir=$(dirname "$SWAPFILE")
  need=$(($(swap_bytes "$1") + SWAP_MARGIN_BYTES))
  avail=$(free_bytes "$dir" || true)
  if ! [[ $avail =~ ^[0-9]+$ ]]; then
    printf 'Could not read the free disk space on %s (df --output=avail failed), so no swap file was made.' "$dir"
    return 1
  fi
  if [ "$avail" -lt "$need" ]; then
    printf 'There is not enough free disk space for a %s swap file: %s has %s free, and the swap file needs %s plus 1 GB left over for Postgres and the other databases on this disk. Free some space, or pass a smaller size (--swap 1G or --swap 512M) or --no-swap.' \
      "$1" "$dir" "$(human_size "$avail")" "$(human_size "$(swap_bytes "$1")")"
    return 1
  fi
}

# True when file $1 holds a swap signature (written by mkswap), so swapon can use it.
has_swap_signature() {
  if command -v blkid >/dev/null 2>&1 && [ "$(blkid -p -o value -s TYPE "$1" 2>/dev/null || true)" = swap ]; then
    return 0
  fi
  if command -v file >/dev/null 2>&1; then
    case "$(file -b "$1" 2>/dev/null || true)" in *swap\ file*) return 0 ;; esac
  fi
  return 1
}

# Runs on exit while make_swapfile is part way through: an unfinished swap file only takes up disk space.
remove_partial_swapfile() {
  swapoff "$SWAPFILE" 2>/dev/null || true
  rm -f "$SWAPFILE"
  printf '\nERROR: Making the swap file stopped part way (see above), so the unfinished %s was removed; it would only take up disk space.\n' "$SWAPFILE" >&2
}

# Makes the swap file and turns it on. Any failure (and Ctrl+C) removes the file again. Called as a plain
# command, never in an if or ||, so set -e stops it at the first failing step.
make_swapfile() {
  trap remove_partial_swapfile EXIT
  trap 'exit 130' INT TERM HUP
  if ! fallocate -l "$SWAP_SIZE" "$SWAPFILE" 2>/dev/null; then
    # fallocate is not supported on every filesystem; dd writes the whole file. swap_fits checked the room.
    rm -f "$SWAPFILE"
    dd if=/dev/zero of="$SWAPFILE" bs=1M count="$(($(swap_bytes "$SWAP_SIZE") / 1048576))" status=none
  fi
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE" >/dev/null
  swapon "$SWAPFILE"
  trap - EXIT INT TERM HUP
}

# Turns the swap file on at boot too.
ensure_fstab() {
  if ! awk -v f="$SWAPFILE" '$1 == f { found = 1 } END { exit !found }' "$FSTAB" 2>/dev/null; then
    echo "$SWAPFILE none swap sw 0 0" >>"$FSTAB"
  fi
}

setup_swap() {
  local active why
  if [ "$SWAP_AUTO" = true ]; then
    step "Adding a $SWAP_SIZE swap file (this instance has under 2 GB of memory; --no-swap skips this)"
  else
    step "Adding a $SWAP_SIZE swap file"
  fi
  active=$(swapon --show=NAME --noheadings 2>/dev/null || true)
  if [ -n "$active" ]; then
    info "Swap is already on ($(printf '%s' "$active" | tr '\n' ' ' | sed 's/ $//')); nothing to do."
    if printf '%s\n' "$active" | grep -Fx "$SWAPFILE" >/dev/null; then ensure_fstab; fi
    return 0
  fi
  if [ -e "$SWAPFILE" ] || [ -L "$SWAPFILE" ]; then
    if [ -L "$SWAPFILE" ] || [ ! -f "$SWAPFILE" ]; then
      die "$SWAPFILE exists but is not a regular file. Move it out of the way, then run this script again."
    fi
    if has_swap_signature "$SWAPFILE"; then
      info "$SWAPFILE is a swap file that is not on yet; turning it on."
      chmod 600 "$SWAPFILE"
      swapon "$SWAPFILE"
      ensure_fstab
      return 0
    fi
    # Left over from a run that stopped part way; swapon would refuse it.
    info "$SWAPFILE exists but was never made into swap (left over from an earlier run); removing it."
    rm -f "$SWAPFILE"
  fi
  if ! why=$(swap_fits "$SWAP_SIZE"); then
    if [ "$SWAP_AUTO" = true ]; then
      warn "Skipped the swap file. $why"
      warn "The build may run out of memory without it."
      return 0
    fi
    die "$why"
  fi
  make_swapfile
  ensure_fstab
  info "Swap file $SWAPFILE ($SWAP_SIZE) is on, and turns on again at boot."
}

MEM_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
choose_swap
if [ -n "$SWAP_SIZE" ]; then
  setup_swap
elif low_memory && [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
  warn "This instance has under 2 GB of memory and no swap (--no-swap). The build may run out of memory."
  warn "Re-run this script without --no-swap (or with --swap 1G) before you build."
fi

# ------------------------------------------------------------------------------------------------
# 3. Node.js
# ------------------------------------------------------------------------------------------------

step "Installing Node.js $NODE_MAJOR LTS"
if [ "$(node_major_at /usr/bin/node)" -ge "$NODE_MAJOR" ]; then
  info "Node $(/usr/bin/node --version) is already installed at /usr/bin/node."
elif [ "$PKG" = apt ]; then
  install -d -m 0755 /etc/apt/keyrings
  fetch https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  # Prefer NodeSource's nodejs over Ubuntu's older one.
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' >/etc/apt/preferences.d/nodesource
  apt_update force
  apt_install nodejs
else
  # Amazon Linux 2023 packages several Node versions side by side (nodejs20, nodejs22, ...).
  dnf_install "nodejs${NODE_MAJOR}"
  dnf_install "nodejs${NODE_MAJOR}-npm" 2>/dev/null || true
  if [ -x "/usr/bin/node-${NODE_MAJOR}" ] && command -v alternatives >/dev/null 2>&1; then
    alternatives --set node "/usr/bin/node-${NODE_MAJOR}" 2>/dev/null || true
  fi
fi
if ! command -v npm >/dev/null 2>&1 && [ -x "/usr/bin/npm-${NODE_MAJOR}" ]; then
  # /usr/local/bin is outside sudo's secure_path on Amazon Linux; with-env.sh passes your PATH through.
  ln -sf "/usr/bin/npm-${NODE_MAJOR}" /usr/local/bin/npm
  if [ -x "/usr/bin/npx-${NODE_MAJOR}" ]; then
    ln -sf "/usr/bin/npx-${NODE_MAJOR}" /usr/local/bin/npx
  fi
fi
if [ "$(node_major_at /usr/bin/node)" -lt "$NODE_MAJOR" ]; then
  die "/usr/bin/node is not Node $NODE_MAJOR or newer. On Amazon Linux try: sudo alternatives --config node"
fi
command -v npm >/dev/null 2>&1 || die "npm is missing after installing Node. Install it, then run this script again."
info "Node $(/usr/bin/node --version), npm $(npm --version)"

# ------------------------------------------------------------------------------------------------
# 3b. Automatic updates (Ubuntu): Node.js from NodeSource too, and a reboot when an update needs one
# ------------------------------------------------------------------------------------------------

# The apt settings for unattended-upgrades (on by default on Ubuntu). Without them it skips NodeSource,
# so the internet-facing server would keep whatever Node.js was current at setup, and it never reboots,
# so a patched kernel waits until someone reboots by hand.
unattended_upgrades_conf() {
  cat <<'EOF'
// Written by First Twenty setup-ec2.sh because it was missing. Edit freely: setup never overwrites it.
// docs/SERVER.md, "Keep it patched", says what it does.
//
// Node.js comes from NodeSource, which unattended-upgrades skips unless it is listed. This adds to the
// Ubuntu origins in 50unattended-upgrades; the node_<major>.x repository only ships that major version.
Unattended-Upgrade::Origins-Pattern {
	"site=deb.nodesource.com";
};
// Reboot when an update needs it (a new kernel, for example) at 04:30, after the 03:15 backup.
// Postgres, the First Twenty server and Caddy are enabled services: they start again on their own.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
}

if [ "$PKG" = apt ]; then
  step "Automatic updates (unattended-upgrades), Node.js included"
  apt_install unattended-upgrades
  if [ -f "$UNATTENDED_CONF" ]; then
    info "Kept the existing $UNATTENDED_CONF (not overwritten)."
  else
    unattended_upgrades_conf >"$UNATTENDED_CONF"
    chmod 0644 "$UNATTENDED_CONF"
    info "Wrote $UNATTENDED_CONF: Node.js updates from NodeSource install on their own, and the instance"
    info "reboots at 04:30 when an update needs it."
  fi
  AUTO_UPGRADE=""
  eval "$(apt-config shell AUTO_UPGRADE APT::Periodic::Unattended-Upgrade 2>/dev/null || true)"
  case "$AUTO_UPGRADE" in
    "" | 0) warn "Automatic updates are off on this instance. Turn them on with: sudo dpkg-reconfigure -plow unattended-upgrades" ;;
  esac
fi

# ------------------------------------------------------------------------------------------------
# 4. Caddy
# ------------------------------------------------------------------------------------------------

CADDY_LIST=/etc/apt/sources.list.d/caddy-stable.list
CADDY_KEYRING=/usr/share/keyrings/caddy-stable-archive-keyring.gpg
# The Caddy release installed when Caddy's apt repository cannot be used, and the oldest Caddy setup
# leaves in place on Ubuntu. 2.11.4 has the fixes for every Caddy advisory that touches this Caddyfile
# (github.com/caddyserver/caddy/security/advisories). Raise it here, or with CADDY_VERSION=..., to update.
CADDY_VERSION=${CADDY_VERSION:-2.11.4}

# The version of the caddy command, such as 2.6.2, or nothing.
caddy_version() {
  command -v caddy >/dev/null 2>&1 || return 0
  caddy version 2>/dev/null | awk 'NR == 1 { sub(/^v/, "", $1); print $1 }'
}

# Installs the official Caddy .deb for CADDY_VERSION from the project's GitHub release, after checking it
# against the SHA-512 in that release's checksum file. Fails (and installs nothing) when either download
# fails or the checksum does not match. --force-confold keeps an existing /etc/caddy/Caddyfile.
install_caddy_release() {
  local arch dir deb sums base
  arch=$(dpkg --print-architecture)
  case "$arch" in
    amd64 | arm64) ;;
    *)
      warn "Caddy publishes no .deb for $arch."
      return 1
      ;;
  esac
  dir=$(mktemp -d)
  deb="caddy_${CADDY_VERSION}_linux_${arch}.deb"
  sums="caddy_${CADDY_VERSION}_checksums.txt"
  base="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}"
  if fetch "$base/$deb" -o "$dir/$deb" && fetch "$base/$sums" -o "$dir/$sums"; then
    awk -v f="$deb" '$2 == f || $2 == "*" f' "$dir/$sums" >"$dir/expected.sha512"
    if [ -s "$dir/expected.sha512" ] && (cd "$dir" && sha512sum -c --status expected.sha512); then
      if DEBIAN_FRONTEND=noninteractive dpkg -i --force-confold "$dir/$deb"; then
        rm -rf "$dir"
        info "Installed Caddy $CADDY_VERSION from its GitHub release (SHA-512 checked)."
        return 0
      fi
    else
      warn "$deb does not match the SHA-512 in $sums, so it was not installed."
    fi
  fi
  rm -rf "$dir"
  return 1
}

# Installs Caddy from Caddy's own apt repository (the newest Caddy, updated by apt), else the official
# release package for CADDY_VERSION, else Ubuntu's caddy package (2.6 on 24.04, missing years of Caddy
# fixes; a last resort). The repository is hosted on Cloudsmith, which has refused downloads with "402
# Payment Required". A repository that cannot be read is removed again, because it would make every
# later apt-get update on this instance fail.
install_caddy_apt() {
  if fetch https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o "$CADDY_KEYRING" &&
    fetch https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o "$CADDY_LIST" &&
    chmod o+r "$CADDY_KEYRING" "$CADDY_LIST" &&
    apt-get update -y -q; then
    APT_UPDATED=true
    if apt_install caddy; then return 0; fi
  fi
  warn "Caddy's own package repository could not be used (see above), so it was removed again."
  rm -f "$CADDY_LIST" "$CADDY_KEYRING"
  apt_update force
  warn "Installing the Caddy $CADDY_VERSION release package instead. apt does not update it: raise"
  warn "CADDY_VERSION in this script and run it again to update (docs/SERVER.md, \"Keep it patched\")."
  if install_caddy_release; then return 0; fi
  warn "The Caddy release package could not be installed either. Installing Ubuntu's caddy package."
  if [ -z "$(apt-cache policy caddy 2>/dev/null | awk '$1 == "Candidate:" && $2 != "(none)" { print $2 }')" ]; then
    die "Ubuntu $OS_VERSION has no caddy package either. Install Caddy by hand (https://caddyserver.com/docs/install), then run this script again."
  fi
  apt_install caddy
}

step "Installing Caddy (HTTPS and reverse proxy)"
CADDY_HAVE=$(caddy_version)
if [ -n "$CADDY_HAVE" ] && [ "$PKG" = apt ] && dpkg --compare-versions "$CADDY_HAVE" lt "$CADDY_VERSION"; then
  # Typically Ubuntu's 2.6 from an earlier run of this script, when the release package could not be had.
  info "Caddy $CADDY_HAVE is older than $CADDY_VERSION; replacing it with the Caddy $CADDY_VERSION release package."
  install_caddy_release || warn "Kept Caddy $CADDY_HAVE: the $CADDY_VERSION release package could not be installed (see above)."
elif [ -n "$CADDY_HAVE" ]; then
  info "Caddy $CADDY_HAVE is already installed."
elif [ "$PKG" = apt ]; then
  install_caddy_apt
else
  # The Caddy project publishes RPMs through Fedora COPR. Amazon Linux 2023 uses the EL9 build.
  dnf_install dnf-plugins-core
  if ! dnf -y -q copr enable @caddy/caddy "epel-9-$(uname -m)" >/dev/null 2>&1; then
    info "dnf copr is unavailable; adding the Caddy COPR repository file directly."
    cat >/etc/yum.repos.d/caddy-copr.repo <<EOF
[copr:copr.fedorainfracloud.org:group_caddy:caddy]
name=Copr repo for caddy owned by @caddy
baseurl=https://download.copr.fedorainfracloud.org/results/@caddy/caddy/epel-9-\$basearch/
type=rpm-md
gpgcheck=1
gpgkey=https://download.copr.fedorainfracloud.org/results/@caddy/caddy/pubkey.gpg
repo_gpgcheck=0
enabled=1
enabled_metadata=1
EOF
  fi
  dnf_install caddy
fi
command -v caddy >/dev/null 2>&1 || die "Caddy did not install."
id -u caddy >/dev/null 2>&1 || die "The caddy user is missing; the Caddy package did not finish installing."

# ------------------------------------------------------------------------------------------------
# 5. Postgres (only checked; installed only with --install-postgres on a box without it)
# ------------------------------------------------------------------------------------------------

postgres_present() {
  command -v postgres >/dev/null 2>&1 && return 0
  command -v pg_ctl >/dev/null 2>&1 && return 0
  ls /usr/lib/postgresql/*/bin/postgres >/dev/null 2>&1 && return 0
  # grep without -q reads all of its input, so the command before the pipe never dies of SIGPIPE.
  systemctl list-unit-files --no-legend 'postgresql*' 2>/dev/null | grep postgresql >/dev/null && return 0
  ss -ltnH 2>/dev/null | grep -E '[:.]5432[[:space:]]' >/dev/null && return 0
  return 1
}

step "Checking for Postgres"
DB_STATE=""
if postgres_present; then
  info "Postgres is already on this instance. Leaving it exactly as it is."
  if [ "$INSTALL_POSTGRES" = true ]; then
    info "(--install-postgres ignored because Postgres exists.)"
  fi
  PG_HERE=$(local_server_major)
  if [ -n "$PG_HERE" ] && [ "$PG_HERE" -lt "$MIN_PG_MAJOR" ]; then
    warn "This Postgres is version $PG_HERE; First Twenty needs $MIN_PG_MAJOR or newer. The first deploy stops at"
    warn "migration 007 and changes nothing until Postgres is upgraded (docs/SERVER.md, \"Before you start\")."
  fi
  DB_STATE=$(first_twenty_objects)
  case "$DB_STATE" in
    't|t|t') info "The first_twenty database and its two roles already exist; setup leaves them (and every other database) as they are." ;;
    *t*) info "Part of the First Twenty database setup exists; postgres-setup.sql adds what is missing without changing the rest." ;;
  esac
elif [ "$INSTALL_POSTGRES" = true ]; then
  if [ "$PKG" = apt ]; then
    apt_update
    PG_CANDIDATE=$(apt_postgres_major)
    if [ -n "$PG_CANDIDATE" ] && [ "$PG_CANDIDATE" -lt "$MIN_PG_MAJOR" ]; then
      die "This release's postgresql package is Postgres $PG_CANDIDATE; First Twenty needs $MIN_PG_MAJOR or newer. Use Ubuntu 24.04, or install Postgres $MIN_PG_MAJOR or newer from apt.postgresql.org first (docs/SERVER.md, \"Before you start\"), then run setup again without --install-postgres."
    fi
    info "Installing the Ubuntu postgresql package (listens on localhost, scram-sha-256 passwords)."
    apt_install postgresql
    systemctl enable --now postgresql
  else
    info "Installing postgresql${PG_MAJOR}-server."
    dnf_install "postgresql${PG_MAJOR}-server"
    if [ ! -f /var/lib/pgsql/data/PG_VERSION ]; then
      postgresql-setup --initdb
      HBA=/var/lib/pgsql/data/pg_hba.conf
      # Amazon Linux's fresh cluster uses "ident" for local TCP, which rejects passwords. Switch those
      # two lines to scram-sha-256 (this runs only on the cluster this script just created).
      sed -i -E 's#^(host[[:space:]]+all[[:space:]]+all[[:space:]]+(127\.0\.0\.1/32|::1/128)[[:space:]]+)ident[[:space:]]*$#\1scram-sha-256#' "$HBA"
      info "New cluster created; localhost TCP logins use scram-sha-256 passwords."
    fi
    systemctl enable --now postgresql
  fi
  info "Postgres is running and listens on localhost only (the default)."
else
  warn "No Postgres found on this instance. Re-run with --install-postgres for a fresh box,"
  warn "or point DATABASE_URL in $ENV_FILE at your database."
fi
if [ "$ENABLE_BACKUPS" = true ] && ! command -v pg_dump >/dev/null 2>&1; then
  # pg_dump must be the server's major version or newer; an older one refuses to run.
  SERVER_MAJOR=$(local_server_major)
  warn "pg_dump is not installed, so nightly backups will fail until you install the Postgres client."
  if [ -n "$SERVER_MAJOR" ]; then
    warn "Your Postgres is version $SERVER_MAJOR. Amazon Linux: sudo dnf install postgresql${SERVER_MAJOR}"
    warn "Ubuntu: sudo apt-get install postgresql-client-${SERVER_MAJOR} (from apt.postgresql.org if your release lacks it)"
  else
    warn "Install the same major version as your Postgres server, or newer. See the server's version with"
    warn "  sudo -u postgres psql -tAc 'SHOW server_version'   (Docker: docker exec <container> psql -U postgres -tAc 'SHOW server_version')"
    warn "then: Amazon Linux: sudo dnf install postgresql<version>   Ubuntu: sudo apt-get install postgresql-client-<version>"
  fi
fi

# ------------------------------------------------------------------------------------------------
# 6. Service user and folders
# ------------------------------------------------------------------------------------------------

step "Creating the $APP_USER system user"
if id -u "$APP_USER" >/dev/null 2>&1; then
  info "User $APP_USER already exists."
else
  NOLOGIN=$(command -v nologin || echo /usr/sbin/nologin)
  useradd --system --user-group --home-dir "$STATE_DIR" --no-create-home --shell "$NOLOGIN" \
    --comment "First Twenty API server" "$APP_USER"
  info "Created system user $APP_USER (no login shell)."
fi
install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$STATE_DIR"

step "Putting the code in $APP_DIR"
APP_REAL=""
[ -d "$APP_DIR" ] && APP_REAL=$(cd "$APP_DIR" && pwd -P)
if [ "$APP_REAL" = "$SRC_DIR" ]; then
  info "The code is already in $APP_DIR."
elif [ -d "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
  info "$APP_DIR already has code; leaving it as is (update it with: bash server/deploy/deploy.sh)."
else
  install -d -m 0750 "$APP_DIR"
  # Copy everything (including .git, so git pull keeps working) except installs, builds and local data.
  tar -C "$SRC_DIR" \
    --exclude=./node_modules --exclude=./.data --exclude=./.env \
    --exclude=./dist --exclude=./dist-single --exclude=./dist-server --exclude=./first-twenty.html \
    -cf - . | tar -C "$APP_DIR" -xf -
  info "Copied $SRC_DIR to $APP_DIR."
fi
# The deploy user owns the code (git pull, npm ci, build); the service reads it through its group.
chown -R "$DEPLOY_USER:$APP_USER" "$APP_DIR"
chmod 0750 "$APP_DIR"
chmod -R g+rX "$APP_DIR"
# New files and folders inherit the firsttwenty group.
find "$APP_DIR" -path "$APP_DIR/node_modules" -prune -o -type d -exec chmod g+s {} +
info "$APP_DIR is owned by $DEPLOY_USER, readable by the $APP_USER group, and read-only to the service."

# ------------------------------------------------------------------------------------------------
# 7. Settings file
# ------------------------------------------------------------------------------------------------

step "Creating $ENV_FILE"
install -d -m 0750 -o root -g "$APP_USER" "$ENV_DIR"
EXAMPLE=$APP_DIR/.env.example
[ -f "$EXAMPLE" ] || EXAMPLE=$SRC_DIR/.env.example
if [ -f "$ENV_FILE" ]; then
  info "Kept the existing $ENV_FILE (not overwritten)."
  ORIGIN_FIX=$(public_origin_fix "$ENV_FILE")
  if [ -n "$ORIGIN_FIX" ]; then
    warn "PUBLIC_ORIGIN in $ENV_FILE is not https://$DOMAIN, and setup does not change a settings file it kept."
    warn "Until it is, only requests that arrive through Caddy over https get Secure cookies and HSTS. Set it with:"
    warn "  $ORIGIN_FIX"
  fi
  CAREERS_FIX=$(careers_hosts_fix "$ENV_FILE")
  if [ -n "$CAREERS_FIX" ]; then
    warn "CAREERS_HOSTS in $ENV_FILE does not name $CAREERS_DOMAINS, and setup does not change a settings file it kept."
    warn "Until it does, the server answers 404 on the careers sites Caddy now has. Set it with:"
    warn "  $CAREERS_FIX"
  fi
else
  [ -f "$EXAMPLE" ] || die "Cannot find .env.example to start $ENV_FILE from."
  install -m 0600 -o root -g "$APP_USER" "$EXAMPLE" "$ENV_FILE"
  sed -i -E "s#^PUBLIC_ORIGIN=.*#PUBLIC_ORIGIN=https://${DOMAIN}#" "$ENV_FILE"
  info "Created from .env.example with PUBLIC_ORIGIN=https://$DOMAIN."
  if [ -n "$CAREERS_DOMAINS" ]; then
    set_careers_hosts "$ENV_FILE"
    info "Set CAREERS_HOSTS=$(printf '%s' "$CAREERS_DOMAINS" | tr ' ' ',')."
  fi
fi
chown root:"$APP_USER" "$ENV_FILE"
chmod 0600 "$ENV_FILE"
# Only the active lines count: the comments in the file mention CHANGE_ME too.
for var in DATABASE_URL MIGRATION_DATABASE_URL; do
  if env_has_placeholder "$var" "$ENV_FILE"; then
    info "Still to do: replace CHANGE_ME in $var (sudo nano $ENV_FILE)."
  fi
done
if ! grep -Eq '^[[:space:]]*MIGRATION_DATABASE_URL[[:space:]]*=' "$ENV_FILE"; then
  info "Still to do: add MIGRATION_DATABASE_URL for the first_twenty_owner role, so migrations do not run"
  info "as the server's own role (docs/SERVER.md, \"Two database roles\")."
fi

# ------------------------------------------------------------------------------------------------
# 8. systemd unit
# ------------------------------------------------------------------------------------------------

step "Installing the $SERVICE systemd unit"
UNIT_SRC=$(deploy_file first-twenty.service)
if cmp -s "$UNIT_SRC" "/etc/systemd/system/$SERVICE.service"; then
  info "Unit is up to date."
else
  install -m 0644 "$UNIT_SRC" "/etc/systemd/system/$SERVICE.service"
  info "Installed /etc/systemd/system/$SERVICE.service."
fi
systemctl daemon-reload
systemctl enable --quiet "$SERVICE"
info "Enabled: it starts on boot."

# ------------------------------------------------------------------------------------------------
# 9. Caddy site
# ------------------------------------------------------------------------------------------------

step "Configuring Caddy for https://$DOMAIN${CAREERS_DOMAINS:+ and careers pages on $CAREERS_DOMAINS}"
CADDY_SRC=$(deploy_file Caddyfile)
MARKER="# Managed by First Twenty setup-ec2.sh. Re-running the script rewrites this file."
CADDYFILE=/etc/caddy/Caddyfile
NEW=/etc/caddy/.first-twenty.Caddyfile.new

# Prints the Caddyfile for $DOMAIN: the marker line, then server/deploy/Caddyfile ($1) with the domain in
# both app site blocks, the careers site template (between its BEGIN and END lines) once per name in
# CAREERS_DOMAINS and never as the template itself, and the tls lines on when --email was given. With
# "site-only" as $2 it leaves out the global options block (from a line "{" to a line "}"), which Caddy
# accepts only at the top of the main Caddyfile, never in a file that one imports.
render_caddyfile() {
  local careers domain
  careers=$(sed -n -e '/^# BEGIN careers site$/,/^# END careers site$/p' "$1" | sed -e '/^# BEGIN careers site$/d' -e '/^# END careers site$/d')
  {
    echo "$MARKER"
    if [ "${2:-}" = site-only ]; then sed -e '/^{$/,/^}$/d' "$1"; else cat "$1"; fi |
      sed -e '/^# BEGIN careers site$/,/^# END careers site$/d' -e "s/^hr\.example\.com {/${DOMAIN} {/" -e "s/^http:\/\/hr\.example\.com {/http:\/\/${DOMAIN} {/"
    for domain in ${CAREERS_DOMAINS:-}; do
      printf '%s\n' "$careers" | sed -e "s/^careers\.example\.com {/${domain} {/" -e "s/^http:\/\/careers\.example\.com {/http:\/\/${domain} {/"
    done
  } |
    if [ -n "$ACME_EMAIL" ]; then
      sed -e "s|^\([[:space:]]*\)# tls you@example\.com|\1tls ${ACME_EMAIL}|"
    else
      cat
    fi
}

install -d -m 0755 /etc/caddy
# Caddy runs as the caddy user; create its log folder and file so a root-run check cannot claim them.
install -d -m 0750 -o caddy -g caddy /var/log/caddy
touch /var/log/caddy/first-twenty-access.log
chown caddy:caddy /var/log/caddy/first-twenty-access.log
chmod 0640 /var/log/caddy/first-twenty-access.log

TARGET=$CADDYFILE
if [ -f "$CADDYFILE" ] && ! grep -qF "$MARKER" "$CADDYFILE" &&
  ! grep -q 'The Caddyfile is an easy way to configure your Caddy web server' "$CADDYFILE"; then
  # Someone already wrote their own Caddyfile. Do not touch it; add our site as a separate file.
  TARGET=/etc/caddy/first-twenty.caddy
fi

if [ "$TARGET" = "$CADDYFILE" ]; then
  render_caddyfile "$CADDY_SRC" >"$NEW"
else
  render_caddyfile "$CADDY_SRC" site-only >"$NEW"
fi
# The admin line puts Caddy's admin API on a Unix socket. Caddy before 2.7 cannot be reloaded through one
# (its client sends a request newer Go refuses), so there the line stays out and the admin API stays on
# localhost:2019 until Caddy is updated.
CADDY_NOW=$(caddy_version)
if [ -n "$CADDY_NOW" ] && [ "$(printf '%s\n' 2.7.0 "$CADDY_NOW" | sort -V | head -n 1)" != 2.7.0 ]; then
  sed -i '/^[[:space:]]*admin unix\/\//d' "$NEW"
  warn "Caddy $CADDY_NOW is older than 2.7, so its admin API stays on localhost:2019 (automatic deploys' staging needs 2.7 or newer)."
fi
chmod 0644 "$NEW"

if ! runuser -u caddy -- caddy validate --adapter caddyfile --config "$NEW" >/dev/null 2>&1; then
  runuser -u caddy -- caddy validate --adapter caddyfile --config "$NEW" || true
  rm -f "$NEW"
  die "The generated Caddyfile did not validate (details above)."
fi

if cmp -s "$NEW" "$TARGET"; then
  rm -f "$NEW"
  info "$TARGET is up to date."
else
  if [ -f "$TARGET" ]; then
    cp -p "$TARGET" "$TARGET.bak-$(date +%Y%m%d-%H%M%S)"
    info "Backed up the previous $TARGET."
  fi
  mv "$NEW" "$TARGET"
  info "Wrote $TARGET."
fi

if [ "$TARGET" != "$CADDYFILE" ]; then
  if ! grep -Eq "^[[:space:]]*import[[:space:]]+$TARGET" "$CADDYFILE"; then
    warn "$CADDYFILE has your own sites, so it was left alone. Add this line to it, then reload Caddy:"
    warn "  import $TARGET"
    warn "  sudo systemctl reload caddy"
  fi
  warn "Caddy reads global options only from the top of $CADDYFILE, so $TARGET leaves out the read"
  warn "timeouts that keep slow clients from holding connections open. Copy the first { ... } block of"
  warn "$CADDY_SRC to the top of $CADDYFILE (or into the global options block it already has)."
fi

# Caddy's own unit has no Restart=, so a crash or an out-of-memory kill of the public proxy would leave
# the site down until someone logged in. The same rule as first-twenty.service: always start it again.
CADDY_DROPIN=/etc/systemd/system/caddy.service.d/10-first-twenty.conf
caddy_dropin() {
  cat <<'EOF'
# Written by First Twenty setup-ec2.sh when missing; it is never overwritten. Caddy's own unit has no
# Restart=, so without this a crash would leave the site down until someone started Caddy by hand.
[Unit]
StartLimitIntervalSec=0

[Service]
Restart=on-failure
RestartSec=5
EOF
}
if [ -f "$CADDY_DROPIN" ]; then
  info "Kept the existing $CADDY_DROPIN (not overwritten)."
else
  install -d -m 0755 "$(dirname "$CADDY_DROPIN")"
  caddy_dropin >"$CADDY_DROPIN"
  chmod 0644 "$CADDY_DROPIN"
  systemctl daemon-reload
  info "Wrote $CADDY_DROPIN: systemd starts Caddy again 5 seconds after any crash."
fi

systemctl enable --quiet caddy
if systemctl is-active --quiet caddy; then
  # systemctl reload sends the new config to the admin address written in it. The first time it has the
  # admin line (the Unix socket), the running Caddy still listens on localhost:2019, so caddy reload is
  # told that address instead. A failed reload leaves Caddy running the config it had.
  if ! systemctl reload caddy 2>/dev/null; then
    curl -s -o /dev/null --max-time 3 http://127.0.0.1:2019/config/ &&
      runuser -u caddy -- caddy reload --config "$CADDYFILE" --adapter caddyfile --address localhost:2019 ||
      die "Caddy rejected the new config. See: sudo journalctl -u caddy -n 50"
  fi
  info "Caddy reloaded."
else
  systemctl start caddy || die "Caddy did not start. See: sudo journalctl -u caddy -n 50"
  info "Caddy started."
fi

# ------------------------------------------------------------------------------------------------
# 10. Nightly backups
# ------------------------------------------------------------------------------------------------

if [ "$ENABLE_BACKUPS" = true ]; then
  step "Installing nightly backups (03:15 server time, 14 days kept)"
  install -m 0700 -o root -g root "$(deploy_file backup.sh)" /usr/local/sbin/first-twenty-backup
  install -d -m 0700 -o root -g root "$BACKUP_DIR"
  install -m 0644 "$(deploy_file first-twenty-backup.service)" /etc/systemd/system/first-twenty-backup.service
  install -m 0644 "$(deploy_file first-twenty-backup.timer)" /etc/systemd/system/first-twenty-backup.timer
  systemctl daemon-reload
  systemctl enable --quiet --now first-twenty-backup.timer
  info "Timer on. Run one now with: sudo systemctl start first-twenty-backup"
else
  step "Skipping nightly backups (--no-backups)"
fi

# ------------------------------------------------------------------------------------------------
# 11. Start the server if it is ready
# ------------------------------------------------------------------------------------------------

step "Starting $SERVICE"
if [ ! -f "$APP_DIR/dist-server/server.mjs" ]; then
  info "Not started yet: the server is not built. Step 4 below builds it."
elif env_has_placeholder DATABASE_URL "$ENV_FILE"; then
  info "Not started yet: DATABASE_URL in $ENV_FILE still has CHANGE_ME in it."
else
  systemctl restart "$SERVICE"
  sleep 2
  if systemctl is-active --quiet "$SERVICE"; then
    info "$SERVICE is running."
  else
    warn "$SERVICE did not stay up. See: sudo journalctl -u $SERVICE -n 50"
  fi
fi

# ------------------------------------------------------------------------------------------------
# Friendly checks
# ------------------------------------------------------------------------------------------------

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep '^Status: active' >/dev/null; then
  if ! ufw status 2>/dev/null | grep -E '^(443|80,443|443/tcp|80,443/tcp)[[:space:]]' >/dev/null; then
    warn "ufw is on. Allow HTTPS with: sudo ufw allow 80,443/tcp"
  fi
fi

PUBLIC_IP=""
TOKEN=$(curl -fsS -m 2 -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)
if [ -n "$TOKEN" ]; then
  PUBLIC_IP=$(curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $TOKEN" \
    http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
fi
if [ -n "$PUBLIC_IP" ]; then
  # The app's domain and every careers domain need their own certificate, so each must point here.
  for name in "$DOMAIN" $CAREERS_DOMAINS; do
    DNS_IPS=$(getent ahostsv4 "$name" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
    if [ -z "$DNS_IPS" ]; then
      warn "$name does not resolve yet. Point its A record at $PUBLIC_IP; Caddy retries on its own."
    elif ! printf ' %s ' "$DNS_IPS" | grep -q " $PUBLIC_IP "; then
      warn "$name points at $DNS_IPS but this instance's public IP is $PUBLIC_IP."
      warn "Caddy cannot get a certificate until the A record points here (use an Elastic IP)."
    fi
  done
fi

# Prints what is left to do. DB_STATE is what first_twenty_objects found ("t|t|t" when the database and
# both roles already exist).
next_steps() {
  if [ "$DB_STATE" = 't|t|t' ]; then
    cat <<EOF

Setup finished. Next steps (docs/SERVER.md walks through each one):

  1. The first_twenty database and both roles already exist, and setup left them as they were, so skip
     creating them. To give both roles new passwords that live only in $ENV_FILE, follow
     docs/SERVER.md, "If your database and roles already exist".

  2. Put both passwords in the settings file (DATABASE_URL gets the first_twenty password,
     MIGRATION_DATABASE_URL the first_twenty_owner password):
       sudo nano $ENV_FILE

  3. Log in as $DEPLOY_USER and build:
       cd $APP_DIR && npm ci && npm run build:all

  4. Check the tables (migrations already applied are skipped; only new ones run), and create your admin
     login if you have none yet (the password is asked for, not echoed):
       bash server/deploy/with-env.sh npm run server:migrate -- --status
       bash server/deploy/with-env.sh npm run server:migrate
       bash server/deploy/with-env.sh npm run server:create-admin -- --email you@company.com
     For the login email, pick one that is published nowhere (docs/SERVER.md, step 4 says why).
EOF
  else
    cat <<EOF

Setup finished. Next steps (docs/SERVER.md walks through each one):

  1. Create the database roles, if you have not yet (it asks for two passwords, once each):
       cd $APP_DIR && sudo -u postgres psql -v ON_ERROR_STOP=1 < server/deploy/postgres-setup.sql

  2. Put both passwords in the settings file (replace CHANGE_ME in DATABASE_URL with the first_twenty
     password, and in MIGRATION_DATABASE_URL with the first_twenty_owner password):
       sudo nano $ENV_FILE

  3. Log in as $DEPLOY_USER and build:
       cd $APP_DIR && npm ci && npm run build:all

  4. Create the tables and your admin login (the password is asked for, not echoed):
       bash server/deploy/with-env.sh npm run server:migrate
       bash server/deploy/with-env.sh npm run server:create-admin -- --email you@company.com
     For the login email, pick one that is published nowhere (docs/SERVER.md, step 4 says why).
EOF
  fi
  cat <<EOF

  5. Start the server and check it:
       sudo systemctl restart $SERVICE
       curl https://$DOMAIN/api/health

  6. Open https://$DOMAIN, then Settings > Data > Server, sign in and upload your workspace.
EOF
  if [ -n "${CAREERS_DOMAINS:-}" ]; then
    cat <<EOF

  7. Careers pages: each company's is at https://${CAREERS_DOMAINS%% *}/<its slug>/ (Settings > Server shows
     the link). Check the careers site answers:
       curl -I https://${CAREERS_DOMAINS%% *}/
EOF
  fi
  if [ -n "${ORIGIN_FIX:-}" ]; then
    cat <<EOF

  Before step 5: PUBLIC_ORIGIN in $ENV_FILE is not https://$DOMAIN yet. Set it with:
       $ORIGIN_FIX
EOF
  fi
  if [ -n "${CAREERS_FIX:-}" ]; then
    cat <<EOF

  Before step 5: CAREERS_HOSTS in $ENV_FILE does not name ${CAREERS_DOMAINS:-} yet. Set it with:
       $CAREERS_FIX
EOF
  fi
  cat <<EOF

Later updates, always from $APP_DIR (deploy.sh refuses to run from another copy of the code):
  cd $APP_DIR && bash server/deploy/deploy.sh
EOF
}

next_steps
