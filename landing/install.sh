#!/usr/bin/env bash
# One-command self-host installer for Slirc.
#
# Interactive:
#   curl -fsSL https://install.slirc.org | sudo bash
#
# Non-interactive:
#   curl -fsSL https://install.slirc.org | sudo bash -s -- \
#     --non-interactive \
#     --domain chat.example.com \
#     --owner-email you@example.com \
#     --owner-nick you
set -euo pipefail

SLIRC_REF="${SLIRC_REF:-main}"
SLIRC_RAW_BASE="${SLIRC_RAW_BASE:-https://install.slirc.org}"
SLIRC_IMAGE="${SLIRC_IMAGE:-ghcr.io/bitbonsai/slirc:latest}"
ERGO_IMAGE="${ERGO_IMAGE:-ghcr.io/bitbonsai/slirc-ergo:v2.19.1}"
CADDY_IMAGE="${CADDY_IMAGE:-caddy:2-alpine}"
ERGO_OPER_USER="${ERGO_OPER_USER:-slirc-oper}"
DEFAULT_HELP_MODEL="anthropic/claude-haiku-5.5"

INSTALL_DIR="${SLIRC_INSTALL_DIR:-/opt/slirc}"
DATA_DIR="${SLIRC_DATA_DIR:-/var/lib/slirc}"
KEYS_DIR="${SLIRC_KEYS_DIR:-/var/lib/slirc-keys}"
BIN_PATH="${SLIRC_BIN_PATH:-/usr/local/bin/slirc}"
CRON_CERT_SYNC="${SLIRC_CRON_CERT_SYNC:-/etc/cron.daily/slirc-sync-certs}"
SOURCE_DIR="${SLIRC_SOURCE_DIR:-}"
SUBNET="${SLIRC_SUBNET:-10.89.42.0/24}"
TZ_VALUE="${TZ:-UTC}"

DOMAIN="${SLIRC_DOMAIN:-}"
OWNER_EMAIL="${SLIRC_OWNER_EMAIL:-}"
OWNER_NICK="${SLIRC_OWNER_NICK:-}"
MODE="${SLIRC_MODE:-}"
CHANNEL="${SLIRC_CHANNEL:-}"
RESEND_API_KEY="${SLIRC_RESEND_API_KEY:-}"
RESEND_FROM="${SLIRC_RESEND_FROM:-}"
GIPHY_API_KEY="${SLIRC_GIPHY_API_KEY:-}"
OPENROUTER_API_KEY="${SLIRC_OPENROUTER_API_KEY:-}"
HELP_ANSWER_MODEL="${SLIRC_HELP_ANSWER_MODEL:-}"
EXPOSE_IRC="${SLIRC_EXPOSE_IRC:-}"
AUTO_UPDATE="${SLIRC_AUTO_UPDATE:-}"
SKIP_DNS_CHECK="${SLIRC_SKIP_DNS_CHECK:-false}"
NON_INTERACTIVE="${SLIRC_NON_INTERACTIVE:-false}"
DRY_RUN="${SLIRC_DRY_RUN:-false}"
DRY_RUN_NO_DOCKER="${SLIRC_DRY_RUN_NO_DOCKER:-false}"

# Auto-detect local repo checkout when invoked directly from disk.
if [[ -z "$SOURCE_DIR" && -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  _script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$_script_dir/deploy/selfhost/compose.yaml" && -f "$_script_dir/ergo/ergo.example.yaml" ]]; then
    SOURCE_DIR="$_script_dir"
  elif [[ -f "$_script_dir/../deploy/selfhost/compose.yaml" && -f "$_script_dir/../ergo/ergo.example.yaml" ]]; then
    SOURCE_DIR="$(cd "$_script_dir/.." && pwd)"
  fi
  unset _script_dir
fi

usage() {
  cat <<'EOF'
Install and start a self-hosted Slirc instance with Docker Compose and automatic HTTPS.

Usage:
  curl -fsSL https://install.slirc.org | sudo bash
  sudo bash install.sh [options]

Options:
  --domain <host>              Domain name pointed at this server (e.g. chat.example.com)
  --owner-email <email>        Owner admin email address
  --owner-nick <nick>          Owner nickname (default: derived from email)
  --mode <mode>                private (private_workspace, default) or public (public_playground)
  --channel <name>             Default channel name (default: #general; e.g. #general or #feedback)
  --resend-api-key <key>       Optional Resend API key for sign-in and invite emails
  --resend-from <from>         Sender header (default: "Slirc <slirc@<domain>>")
  --giphy-api-key <key>        Optional GIPHY API key for /giphy search and welcome gifs
  --openrouter-api-key <key>   Optional OpenRouter API key for @help and @remind AI
  --help-model <model>         Optional OpenRouter model for @help (default: anthropic/claude-haiku-5.5)
  --expose-irc                 Expose direct IRC TLS on port 6697 (syncs Caddy cert)
  --no-expose-irc              Keep IRC port 6697 on loopback only (default)
  --auto-update                Enable nightly automatic updates (default)
  --no-auto-update             Disable nightly automatic updates
  --skip-dns-check             Skip DNS A/AAAA pre-check
  --non-interactive, -y        Do not prompt; require --domain and --owner-email
  --dry-run                    Generate config only; do not install Docker or start containers
  --install-dir <dir>          Config and Compose directory (default: /opt/slirc)
  --data-dir <dir>             Persistent data directory (default: /var/lib/slirc)
  --keys-dir <dir>             Separate IRC key directory (default: /var/lib/slirc-keys)
  --bin-path <path>            Management CLI path (default: /usr/local/bin/slirc)
  --source-dir <dir>           Read templates from a local Slirc checkout instead of GitHub
  --subnet <cidr>              Docker bridge /24 subnet (default: 10.89.42.0/24)
  --ref <ref>                  Git branch or tag to fetch templates from (default: main)
  -h, --help                   Show this help

Environment variables:
  SLIRC_DOMAIN, SLIRC_OWNER_EMAIL, SLIRC_OWNER_NICK, SLIRC_MODE, SLIRC_CHANNEL,
  SLIRC_RESEND_API_KEY, SLIRC_RESEND_FROM, SLIRC_GIPHY_API_KEY,
  SLIRC_OPENROUTER_API_KEY, SLIRC_HELP_ANSWER_MODEL, SLIRC_EXPOSE_IRC,
  SLIRC_AUTO_UPDATE, SLIRC_SKIP_DNS_CHECK, SLIRC_NON_INTERACTIVE, SLIRC_DRY_RUN
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain) DOMAIN="${2:?--domain requires a value}"; shift 2 ;;
      --owner-email) OWNER_EMAIL="${2:?--owner-email requires a value}"; shift 2 ;;
      --owner-nick) OWNER_NICK="${2:?--owner-nick requires a value}"; shift 2 ;;
      --mode) MODE="${2:?--mode requires a value}"; shift 2 ;;
      --channel) CHANNEL="${2:?--channel requires a value}"; shift 2 ;;
      --resend-api-key) RESEND_API_KEY="${2:?--resend-api-key requires a value}"; shift 2 ;;
      --resend-from) RESEND_FROM="${2:?--resend-from requires a value}"; shift 2 ;;
      --giphy-api-key) GIPHY_API_KEY="${2:?--giphy-api-key requires a value}"; shift 2 ;;
      --openrouter-api-key) OPENROUTER_API_KEY="${2:?--openrouter-api-key requires a value}"; shift 2 ;;
      --help-model) HELP_ANSWER_MODEL="${2:?--help-model requires a value}"; shift 2 ;;
      --expose-irc) EXPOSE_IRC="true"; shift ;;
      --no-expose-irc) EXPOSE_IRC="false"; shift ;;
      --auto-update) AUTO_UPDATE="true"; shift ;;
      --no-auto-update) AUTO_UPDATE="false"; shift ;;
      --skip-dns-check) SKIP_DNS_CHECK="true"; shift ;;
      --non-interactive|-y) NON_INTERACTIVE="true"; shift ;;
      --dry-run) DRY_RUN="true"; shift ;;
      --install-dir) INSTALL_DIR="${2:?--install-dir requires a value}"; shift 2 ;;
      --data-dir) DATA_DIR="${2:?--data-dir requires a value}"; shift 2 ;;
      --keys-dir) KEYS_DIR="${2:?--keys-dir requires a value}"; shift 2 ;;
      --bin-path) BIN_PATH="${2:?--bin-path requires a value}"; shift 2 ;;
      --source-dir) SOURCE_DIR="${2:?--source-dir requires a value}"; shift 2 ;;
      --subnet) SUBNET="${2:?--subnet requires a value}"; shift 2 ;;
      --ref)
        SLIRC_REF="${2:?--ref requires a value}"
        SLIRC_RAW_BASE="https://raw.githubusercontent.com/bitbonsai/slirc/${SLIRC_REF}"
        shift 2
        ;;
      -h|--help) usage; exit 0 ;;
      *) printf 'error: unknown option: %s\n' "$1" >&2; exit 1 ;;
    esac
  done
}

C_RESET=""
C_BOLD=""
C_DIM=""
C_CYAN=""
C_BCYAN=""
C_GREEN=""
C_BGREEN=""
C_BYELLOW=""
C_BRED=""
C_WHITE=""

setup_colors() {
  if [[ -z "${NO_COLOR:-}" && ( -t 1 || -n "${FORCE_COLOR:-}" ) ]]; then
    C_RESET=$'\033[0m'
    C_BOLD=$'\033[1m'
    C_DIM=$'\033[2m'
    C_CYAN=$'\033[36m'
    C_BCYAN=$'\033[1;36m'
    C_GREEN=$'\033[32m'
    C_BGREEN=$'\033[1;32m'
    C_BYELLOW=$'\033[1;33m'
    C_BRED=$'\033[1;31m'
    C_WHITE=$'\033[1;37m'
  fi
}

divider() {
  printf '%s────────────────────────────────────────────────────────────────────%s\n' "$C_DIM" "$C_RESET"
}

print_banner() {
  printf '\n'
  printf '%s' "$C_BCYAN"
  cat <<'BANNER'
  ___ _ _
 / __| (_)_ _ __
 \__ \ | | '_/ _|
 |___/_|_|_| \__|
BANNER
  printf '%s' "$C_RESET"
  printf '%sSelf-host installer%s %s· Caddy (HTTPS), Slirc & Ergo IRC -> %s%s\n' \
    "$C_WHITE" "$C_RESET" "$C_DIM" "$INSTALL_DIR" "$C_RESET"
  divider
}

print_ready_banner() {
  printf '\n'
  printf '%s' "$C_BGREEN"
  cat <<'READY'
░░      ░░░  ░░░░░░░░        ░░       ░░░░      ░░
▒  ▒▒▒▒▒▒▒▒  ▒▒▒▒▒▒▒▒▒▒▒  ▒▒▒▒▒  ▒▒▒▒  ▒▒  ▒▒▒▒  ▒
▓▓      ▓▓▓  ▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓       ▓▓▓  ▓▓▓▓▓▓▓
███████  ██  ███████████  █████  ███  ███  ████  █
██      ███        ██        ██  ████  ███      ██
READY
  printf '%s' "$C_RESET"
}

info() { printf '%s\n' "$*"; }
ok() { printf '  %s✓%s %s\n' "$C_BGREEN" "$C_RESET" "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$C_BCYAN" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
warn() { printf '%swarning:%s %s\n' "$C_BYELLOW" "$C_RESET" "$*" >&2; }
die() { printf '%serror:%s %s\n' "$C_BRED" "$C_RESET" "$*" >&2; exit 1; }

can_prompt() {
  [[ "$NON_INTERACTIVE" != "true" && -r /dev/tty ]]
}

prompt_line() {
  local prompt="$1"
  local default="${2:-}"
  local reply=""
  if ! can_prompt; then
    printf '%s' "$default"
    return 0
  fi
  if [[ -n "$default" ]]; then
    printf '%s %s[%s]%s: ' "$prompt" "$C_DIM" "$default" "$C_RESET" > /dev/tty
  else
    printf '%s: ' "$prompt" > /dev/tty
  fi
  IFS= read -r reply < /dev/tty || reply=""
  if [[ -z "$reply" ]]; then
    printf '%s' "$default"
  else
    printf '%s' "$reply"
  fi
}

prompt_yes_no() {
  local prompt="$1"
  local default="${2:-n}"
  local hint="[y/N]"
  [[ "$default" == "y" ]] && hint="[Y/n]"
  if ! can_prompt; then
    [[ "$default" == "y" ]]
    return $?
  fi
  local reply=""
  printf '%s %s%s%s: ' "$prompt" "$C_DIM" "$hint" "$C_RESET" > /dev/tty
  IFS= read -r reply < /dev/tty || reply=""
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

validate_domain() {
  local d="$1"
  [[ ${#d} -le 253 ]] || return 1
  [[ "$d" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]
}

validate_email() {
  local e="$1"
  local re='^[^[:space:]@"'\''\\<>]+@[^[:space:]@"'\''\\<>]+\.[^[:space:]@"'\''\\<>]{2,}$'
  [[ "$e" =~ $re ]]
}

validate_resend_from() {
  local raw="$1"
  local re='^([^<>]+)<([^<>]+)>$'
  [[ -n "$raw" && "$raw" != *$'\n'* && "$raw" != *$'\r'* ]] || return 1
  if [[ "$raw" =~ $re ]]; then
    local name="${BASH_REMATCH[1]}"
    local addr="${BASH_REMATCH[2]}"
    name="$(printf '%s' "$name" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [[ -n "$name" ]] || return 1
    validate_email "$addr"
    return $?
  fi
  validate_email "$raw"
}

validate_nick() {
  local n="$1"
  [[ "$n" =~ ^[a-z0-9_-]{1,32}$ ]]
}

normalize_channel() {
  local raw
  raw="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  raw="${raw#\#}"
  [[ "$raw" =~ ^[a-z0-9][a-z0-9_-]{0,48}$ ]] || return 1
  printf '#%s' "$raw"
}

derive_nick() {
  local email="$1"
  local local_part nick
  local_part="${email%%@*}"
  local_part="${local_part%%+*}"
  nick="$(printf '%s' "$local_part" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-' | sed 's/^[^a-z]*//' | cut -c1-20)"
  printf '%s' "${nick:-owner}"
}

normalize_mode() {
  local raw
  raw="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$raw" in
    ""|"1"|private|private_workspace) printf 'private_workspace' ;;
    "2"|public|public_playground) printf 'public_playground' ;;
    *) return 1 ;;
  esac
}

normalize_bool() {
  local raw default_val="$2"
  raw="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  case "$raw" in
    "") printf '%s' "$default_val" ;;
    true|1|yes|y) printf 'true' ;;
    false|0|no|n) printf 'false' ;;
    *) return 1 ;;
  esac
}

validate_subnet() {
  [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.0/24$ ]] || return 1
  local a="${BASH_REMATCH[1]}" b="${BASH_REMATCH[2]}" c="${BASH_REMATCH[3]}"
  (( a <= 255 && b <= 255 && c <= 255 ))
}

check_system() {
  if [[ "$DRY_RUN" == "true" ]]; then
    command -v openssl >/dev/null 2>&1 || die "openssl is required"
    if [[ "$INSTALL_DIR" == "/opt/slirc" && "$DATA_DIR" == "/var/lib/slirc" && "$KEYS_DIR" == "/var/lib/slirc-keys" && "$BIN_PATH" == "/usr/local/bin/slirc" ]]; then
      local dry_root
      dry_root="$(mktemp -d "${TMPDIR:-/tmp}/slirc-dry-run.XXXXXX")"
      INSTALL_DIR="$dry_root/opt/slirc"
      DATA_DIR="$dry_root/var/lib/slirc"
      KEYS_DIR="$dry_root/var/lib/slirc-keys"
      BIN_PATH="$dry_root/usr/local/bin/slirc"
      CRON_CERT_SYNC="$dry_root/etc/cron.daily/slirc-sync-certs"
    fi
    return 0
  fi

  [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "Run as root (for example: curl -fsSL https://install.slirc.org | sudo bash)"

  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  [[ "$os" == "Linux" ]] || die "Slirc self-host installer supports Linux servers (detected $os)"
  case "$arch" in
    x86_64|amd64|aarch64|arm64) ;;
    *) die "Unsupported architecture: $arch (expected x86_64 or arm64)" ;;
  esac

  if ! command -v curl >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1; then
    step "Installing prerequisites (curl, openssl, ca-certificates)"
    if command -v apt-get >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl openssl ca-certificates
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q curl openssl ca-certificates
    elif command -v yum >/dev/null 2>&1; then
      yum install -y -q curl openssl ca-certificates
    elif command -v apk >/dev/null 2>&1; then
      apk add --no-cache curl openssl ca-certificates
    elif command -v pacman >/dev/null 2>&1; then
      pacman -Sy --noconfirm --needed curl openssl ca-certificates
    elif command -v zypper >/dev/null 2>&1; then
      zypper --non-interactive install -y curl openssl ca-certificates
    else
      die "curl and openssl are required before running this installer"
    fi
  fi
}

check_ports() {
  [[ "$DRY_RUN" == "true" ]] && return 0
  command -v ss >/dev/null 2>&1 || return 0

  local busy=""
  local port line
  for port in 80 443; do
    line="$(ss -H -ltnp "sport = :$port" 2>/dev/null || true)"
    if [[ -n "$line" ]] && ! printf '%s' "$line" | grep -q 'docker-proxy'; then
      busy="${busy}  port ${port}: ${line}"$'\n'
    fi
  done

  if [[ -n "$busy" ]]; then
    warn "Another process is already listening on port 80 or 443:"
    printf '%s' "$busy" >&2
    warn "Caddy needs ports 80 and 443 for automatic HTTPS certificates."
    if can_prompt; then
      prompt_yes_no "Continue anyway?" n || die "Aborted. Stop the service using ports 80/443 and re-run."
    fi
  fi
}

SERVER_IPV4=""
SERVER_IPV6=""
SERVER_IPS_DETECTED="false"

detect_server_ips() {
  [[ "$SERVER_IPS_DETECTED" == "true" ]] && return 0
  SERVER_IPS_DETECTED="true"
  [[ "$SKIP_DNS_CHECK" == "true" ]] && return 0
  SERVER_IPV4="$(curl -fsS -4 --max-time 4 https://api.ipify.org 2>/dev/null || curl -fsS -4 --max-time 4 https://ifconfig.me 2>/dev/null || true)"
  SERVER_IPV6="$(curl -fsS -6 --max-time 4 https://api64.ipify.org 2>/dev/null || true)"
}

print_dns_records() {
  local target="${1:-<your-domain>}"
  if [[ -n "$SERVER_IPV4" ]]; then
    printf '  %sA record:%s    %s %s->%s %s%s%s\n' "$C_CYAN" "$C_RESET" "$target" "$C_DIM" "$C_RESET" "$C_WHITE" "$SERVER_IPV4" "$C_RESET"
  fi
  if [[ -n "$SERVER_IPV6" ]]; then
    printf '  %sAAAA record:%s %s %s->%s %s%s%s %s(optional)%s\n' "$C_CYAN" "$C_RESET" "$target" "$C_DIM" "$C_RESET" "$C_WHITE" "$SERVER_IPV6" "$C_RESET" "$C_DIM" "$C_RESET"
  fi
  if [[ -z "$SERVER_IPV4" && -z "$SERVER_IPV6" ]]; then
    info "  Point an A (and optional AAAA) record for ${target} to this server's public IP."
  fi
}

check_dns() {
  [[ "$SKIP_DNS_CHECK" == "true" ]] && return 0
  local domain="$1"
  local resolved="" server_ips="" ip matched=""

  if command -v getent >/dev/null 2>&1; then
    resolved="$(getent ahosts "$domain" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  elif command -v dig >/dev/null 2>&1; then
    resolved="$( { dig +short A "$domain"; dig +short AAAA "$domain"; } 2>/dev/null | grep -E '^[0-9a-fA-F:.]+$' | sort -u || true )"
  fi

  detect_server_ips
  server_ips="$(printf '%s\n%s\n' "$SERVER_IPV4" "$SERVER_IPV6" | awk 'NF' | sort -u)"

  if [[ -z "$resolved" ]]; then
    warn "DNS lookup for $domain returned no A or AAAA records yet."
    print_dns_records "$domain"
    return 1
  fi

  if [[ -n "$server_ips" ]]; then
    for ip in $resolved; do
      if printf '%s\n' "$server_ips" | grep -qxF "$ip"; then
        matched="$ip"
        break
      fi
    done
    if [[ -n "$matched" ]]; then
      ok "DNS verified: ${C_WHITE}${domain}${C_RESET} ${C_DIM}->${C_RESET} ${C_BGREEN}${matched}${C_RESET}"
      return 0
    fi
    warn "$domain resolves to ($(printf '%s' "$resolved" | tr '\n' ' ' | sed 's/ $//')), which does not match this server ($(printf '%s' "$server_ips" | tr '\n' ' ' | sed 's/ $//'))."
    warn "Caddy needs $domain pointed at this server to issue a Let's Encrypt certificate:"
    print_dns_records "$domain"
    return 1
  fi

  ok "DNS resolves: ${domain} -> $(printf '%s' "$resolved" | tr '\n' ' ' | sed 's/ $//')"
  return 0
}

collect_inputs() {
  print_banner

  if can_prompt; then
    detect_server_ips
    printf '\n%sDNS setup:%s point your domain to this server before Caddy requests HTTPS %s(ports 80 and 443 open)%s:\n' \
      "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"
    print_dns_records "<your-domain>"
    info ""
  fi

  # 1. Domain
  while true; do
    if [[ -z "$DOMAIN" ]]; then
      can_prompt || die "Missing required --domain (or SLIRC_DOMAIN) in non-interactive mode"
      DOMAIN="$(prompt_line "${C_BCYAN}1.${C_RESET} ${C_BOLD}Domain${C_RESET} ${C_DIM}(e.g. chat.example.com)${C_RESET}")"
    fi
    DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed 's#^https\?://##; s#/.*$##; s/[:[:space:]].*$//')"
    if ! validate_domain "$DOMAIN"; then
      warn "Invalid domain: $DOMAIN"
      can_prompt || die "Invalid domain: $DOMAIN"
      DOMAIN=""
      continue
    fi
    while ! check_dns "$DOMAIN"; do
      if ! can_prompt; then
        break
      fi
      local dns_action=""
      dns_action="$(prompt_line "   ${C_DIM}[Enter] Re-check DNS, [c] continue anyway, [n] change domain${C_RESET}" "retry")"
      case "$(printf '%s' "$dns_action" | tr '[:upper:]' '[:lower:]')" in
        ""|r|retry) continue ;;
        c|continue) break ;;
        n|new|change)
          DOMAIN=""
          break
          ;;
        *)
          warn "Enter nothing to retry, 'c' to continue anyway, or 'n' to change domain."
          ;;
      esac
    done
    [[ -n "$DOMAIN" ]] && break
  done

  # 2. Owner email & nick
  while true; do
    if [[ -z "$OWNER_EMAIL" ]]; then
      can_prompt || die "Missing required --owner-email (or SLIRC_OWNER_EMAIL) in non-interactive mode"
      OWNER_EMAIL="$(prompt_line "${C_BCYAN}2.${C_RESET} ${C_BOLD}Owner email${C_RESET}")"
    fi
    OWNER_EMAIL="$(printf '%s' "$OWNER_EMAIL" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    if validate_email "$OWNER_EMAIL"; then
      break
    fi
    warn "Invalid email address: $OWNER_EMAIL"
    can_prompt || die "Invalid email address: $OWNER_EMAIL"
    OWNER_EMAIL=""
  done

  local default_nick
  default_nick="$(derive_nick "$OWNER_EMAIL")"
  while true; do
    if [[ -z "$OWNER_NICK" ]]; then
      if can_prompt; then
        OWNER_NICK="$(prompt_line "   Owner nickname" "$default_nick")"
      else
        OWNER_NICK="$default_nick"
      fi
    fi
    OWNER_NICK="$(printf '%s' "$OWNER_NICK" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
    if validate_nick "$OWNER_NICK"; then
      break
    fi
    warn "Nickname must be 1-32 lowercase letters, numbers, _ or -: $OWNER_NICK"
    can_prompt || die "Invalid owner nickname: $OWNER_NICK"
    OWNER_NICK=""
  done

  # 3. Workspace mode & default channel
  if [[ -z "$MODE" ]]; then
    if can_prompt; then
      info ""
      printf '%s3.%s %sWorkspace mode%s\n' "$C_BCYAN" "$C_RESET" "$C_BOLD" "$C_RESET"
      printf '   %s[1]%s Private workspace %s(invite-only, default)%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
      printf '   %s[2]%s Public peek %s(visitors can read your default channel and sign up)%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
      local mode_choice
      mode_choice="$(prompt_line "   Choose mode" "1")"
      MODE="$(normalize_mode "$mode_choice")" || die "Invalid mode choice: $mode_choice"
    else
      MODE="private_workspace"
    fi
  else
    MODE="$(normalize_mode "$MODE")" || die "Invalid --mode: $MODE (use private or public)"
  fi

  while true; do
    if [[ -z "$CHANNEL" ]]; then
      if can_prompt && [[ "$MODE" == "public_playground" ]]; then
        CHANNEL="$(prompt_line "   Default public channel ${C_DIM}(e.g. #general or #feedback)${C_RESET}" "#general")"
      else
        CHANNEL="#general"
      fi
    fi
    if CHANNEL="$(normalize_channel "$CHANNEL")"; then
      break
    fi
    warn "Channel name must use lowercase letters, numbers, _ or - (e.g. #general or #feedback)."
    can_prompt || die "Invalid --channel: $CHANNEL"
    CHANNEL=""
  done

  # 4. Optional integrations, direct IRC, and nightly auto-updates
  if can_prompt; then
    info ""
    printf '%s4.%s %sOptional integrations%s %s(press Enter to skip, or add later with '\''slirc env'\'')%s\n' \
      "$C_BCYAN" "$C_RESET" "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"
  fi
  if [[ -z "$RESEND_API_KEY" ]] && can_prompt; then
    RESEND_API_KEY="$(prompt_line "   Resend API key ${C_DIM}(sign-in emails & invites)${C_RESET}")"
  fi
  if [[ -n "$RESEND_API_KEY" ]]; then
    local default_from="Slirc <slirc@${DOMAIN}>"
    while true; do
      if [[ -z "$RESEND_FROM" ]]; then
        if can_prompt; then
          RESEND_FROM="$(prompt_line "   Sender address ${C_DIM}(RESEND_FROM)${C_RESET}" "$default_from")"
        else
          RESEND_FROM="$default_from"
        fi
      fi
      if validate_resend_from "$RESEND_FROM"; then
        break
      fi
      warn "Invalid sender address: $RESEND_FROM (use 'user@domain.com' or 'Name <user@domain.com>')"
      can_prompt || die "Invalid --resend-from: $RESEND_FROM"
      RESEND_FROM=""
    done
  fi

  if [[ -z "$GIPHY_API_KEY" ]] && can_prompt; then
    GIPHY_API_KEY="$(prompt_line "   GIPHY API key ${C_DIM}(/giphy GIF search)${C_RESET}")"
  fi

  if [[ -z "$OPENROUTER_API_KEY" ]] && can_prompt; then
    OPENROUTER_API_KEY="$(prompt_line "   OpenRouter API key ${C_DIM}(@help bot & @remind AI)${C_RESET}")"
  fi
  if [[ -n "$OPENROUTER_API_KEY" && -z "$HELP_ANSWER_MODEL" ]] && can_prompt; then
    HELP_ANSWER_MODEL="$(prompt_line "   Model for @help answers" "$DEFAULT_HELP_MODEL")"
  fi

  if [[ -z "$EXPOSE_IRC" ]]; then
    if can_prompt; then
      if prompt_yes_no "   Expose direct IRC TLS on port 6697?" n; then
        EXPOSE_IRC="true"
      else
        EXPOSE_IRC="false"
      fi
    else
      EXPOSE_IRC="false"
    fi
  fi
  EXPOSE_IRC="$(normalize_bool "$EXPOSE_IRC" "false")" || die "Invalid SLIRC_EXPOSE_IRC value: $EXPOSE_IRC"

  if [[ -z "$AUTO_UPDATE" ]]; then
    if can_prompt; then
      if prompt_yes_no "   Enable nightly automatic updates?" y; then
        AUTO_UPDATE="true"
      else
        AUTO_UPDATE="false"
      fi
    else
      AUTO_UPDATE="true"
    fi
  fi
  AUTO_UPDATE="$(normalize_bool "$AUTO_UPDATE" "true")" || die "Invalid SLIRC_AUTO_UPDATE value: $AUTO_UPDATE"
}

ensure_docker() {
  [[ "$DRY_RUN" == "true" ]] && return 0

  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    step "Using existing Docker ($(docker --version | awk '{print $3}' | tr -d ','))"
  else
    step "Installing Docker Engine and Compose plugin"
    if ! curl -fsSL https://get.docker.com | sh; then
      die "Automatic Docker install failed on this distro. Install Docker Engine with the Compose plugin, then re-run this installer."
    fi
  fi

  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi

  docker info >/dev/null 2>&1 || die "Docker daemon is not reachable"
  docker compose version >/dev/null 2>&1 || die "Docker Compose plugin ('docker compose') is not available"
}

fetch_asset() {
  local rel_path="$1"
  local dest="$2"
  if [[ -n "$SOURCE_DIR" ]]; then
    [[ -f "$SOURCE_DIR/$rel_path" ]] || die "Missing local template: $SOURCE_DIR/$rel_path"
    cp "$SOURCE_DIR/$rel_path" "$dest"
  else
    curl -fsSL "${SLIRC_RAW_BASE}/${rel_path}" -o "$dest" || die "Failed to download ${SLIRC_RAW_BASE}/${rel_path}"
  fi
}

hash_ergo_password() {
  local password="$1"
  if [[ "$DRY_RUN" == "true" ]]; then
    if [[ "$DRY_RUN_NO_DOCKER" == "true" ]] || ! docker info >/dev/null 2>&1; then
      # shellcheck disable=SC2016
      printf '%s' '$2a$04$dryrun000000000000000uW7G4p1sN9kL2mQ5vR8tY0zA3cF6hJ9K'
      return 0
    fi
  fi
  local hashed
  hashed="$(printf '%s\n%s\n' "$password" "$password" | docker run --rm -i --entrypoint /ircd-bin/ergo "$ERGO_IMAGE" genpasswd | tail -n 1)"
  [[ "$hashed" == \$2* ]] || die "ergo genpasswd did not return a valid bcrypt hash"
  printf '%s' "$hashed"
}

read_env_key() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 0
  awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

render_ergo_yaml() {
  local template="$1"
  local dest="$2"
  local domain="$3"
  local oper_user="$4"
  local oper_hash="$5"
  local webirc_hash="$6"
  local subnet="$7"
  local mode="$8"

  local net_name
  net_name="$(printf '%s' "${domain%%.*}" | tr -cd 'A-Za-z0-9-')"
  [[ -n "$net_name" ]] || net_name="Slirc"

  local tmp
  tmp="$(mktemp)"

  awk \
    -v domain="$domain" \
    -v net_name="$net_name" \
    -v oper_user="$oper_user" \
    -v oper_hash="$oper_hash" \
    -v webirc_hash="$webirc_hash" \
    -v subnet="$subnet" \
    -v mode="$mode" '
    function replace_once(str, needle, repl,    idx) {
      idx = index(str, needle)
      if (idx == 0) return str
      return substr(str, 1, idx - 1) repl substr(str, idx + length(needle))
    }
    BEGIN {
      in_require_sasl = 0
      in_admin_oper = 0
      seen_net = 0
      seen_server = 0
      seen_origin = 0
      seen_webirc_pass = 0
      seen_webirc_host = 0
      seen_ip_exempt = 0
      seen_require_sasl = 0
      seen_op_only = 0
      seen_oper_class = 0
      seen_oper_block = 0
      seen_oper_pass = 0
    }
    {
      line = $0

      # Replace the accounts.require-sasl block cleanly according to mode.
      if (in_require_sasl) {
        if (line ~ /^    [a-zA-Z0-9_-]+:/ || line ~ /^#/) {
          in_require_sasl = 0
        } else {
          next
        }
      }
      if (line == "    require-sasl:") {
        seen_require_sasl = 1
        in_require_sasl = 1
        print "    require-sasl:"
        if (mode == "private_workspace") {
          print "        # private workspace: every client must authenticate with SASL"
          print "        enabled: true"
        } else {
          print "        # public peek: guests may connect to read the public channel"
          print "        enabled: false"
          print "        exempted:"
          print "            - \"localhost\""
          print "            - \"" subnet "\""
        }
        print ""
        next
      }

      # Drop the unused default admin oper block (with its placeholder password hash).
      if (in_admin_oper) {
        if (line ~ /^    [a-zA-Z0-9_-]+:/ || line ~ /^[a-zA-Z0-9_-]+:/ || line ~ /^# logging/) {
          in_admin_oper = 0
        } else {
          next
        }
      }
      if (line == "    admin:") {
        in_admin_oper = 1
        next
      }

      if (!seen_net && line == "    name: Slirc") {
        line = "    name: " net_name
        seen_net = 1
      } else if (!seen_server && line == "    name: chat.example.com") {
        line = "    name: " domain
        seen_server = 1
      } else if (index(line, "https://chat.example.com") > 0) {
        line = replace_once(line, "https://chat.example.com", "https://" domain)
        seen_origin = 1
      } else if (index(line, "$2a$04$abcdef0123456789abcdef0123456789abcdef0123456789abcde") > 0) {
        line = replace_once(line, "$2a$04$abcdef0123456789abcdef0123456789abcdef0123456789abcde", webirc_hash)
        seen_webirc_pass = 1
      } else if (line == "                - \"10.89.0.0/24\"") {
        line = "                - \"" subnet "\""
        seen_webirc_host = 1
      } else if (!seen_ip_exempt && line == "            - \"10.0.0.0/8\"") {
        print "            - \"" subnet "\""
        seen_ip_exempt = 1
        next
      } else if (line == "    operator-only-creation: false" || line == "    operator-only-creation: true") {
        line = "    operator-only-creation: true"
        seen_op_only = 1
      } else if (line == "    \"slirc-org\":") {
        line = "    \"" oper_user "\":"
        seen_oper_class = 1
      } else if (line == "        title: Slirc.org App") {
        line = "        title: " domain " App"
      } else if (line == "    slirc-org:") {
        line = "    " oper_user ":"
        seen_oper_block = 1
      } else if (line == "        class: \"slirc-org\"") {
        line = "        class: \"" oper_user "\""
      } else if (index(line, "$2a$04$pAOhFDyMq5Wa9NCvhoPXOeAge73nnL5SQ8iePfXSbKaHiCTW3igxK") > 0) {
        line = replace_once(line, "$2a$04$pAOhFDyMq5Wa9NCvhoPXOeAge73nnL5SQ8iePfXSbKaHiCTW3igxK", oper_hash)
        seen_oper_pass = 1
      }

      print line
    }
    END {
      if (!seen_net) { print "missing network.name in template" > "/dev/stderr"; exit 1 }
      if (!seen_server) { print "missing server.name in template" > "/dev/stderr"; exit 1 }
      if (!seen_origin) { print "missing websockets.allowed-origins in template" > "/dev/stderr"; exit 1 }
      if (!seen_webirc_pass || !seen_webirc_host) { print "missing webirc block in template" > "/dev/stderr"; exit 1 }
      if (!seen_ip_exempt) { print "missing ip-limits.exempted in template" > "/dev/stderr"; exit 1 }
      if (!seen_require_sasl) { print "missing accounts.require-sasl in template" > "/dev/stderr"; exit 1 }
      if (!seen_op_only) { print "missing channels.operator-only-creation in template" > "/dev/stderr"; exit 1 }
      if (!seen_oper_class || !seen_oper_block || !seen_oper_pass) { print "missing slirc-org oper config in template" > "/dev/stderr"; exit 1 }
    }
  ' "$template" > "$tmp"

  # Verify critical capabilities survived rendering.
  grep -qE '^[[:space:]]+-[[:space:]]+"ban"' "$tmp" || { rm -f "$tmp"; die "Rendered ergo.yaml missing oper capability: ban"; }
  grep -qE '^[[:space:]]+-[[:space:]]+"nofakelag"' "$tmp" || { rm -f "$tmp"; die "Rendered ergo.yaml missing oper capability: nofakelag"; }
  grep -qE '^[[:space:]]+operator-only-creation:[[:space:]]+true$' "$tmp" || { rm -f "$tmp"; die "Rendered ergo.yaml missing channels.operator-only-creation: true"; }

  # Write in place so any existing single-file bind-mount keeps its inode.
  if [[ -f "$dest" ]]; then
    cat "$tmp" > "$dest"
    rm -f "$tmp"
  else
    mv "$tmp" "$dest"
  fi
  chmod 600 "$dest"
}

render_motd() {
  local template="$1"
  local dest="$2"
  local domain="$3"
  local mode="$4"
  local channel="$5"

  if [[ "$mode" == "private_workspace" ]]; then
    cat > "$dest" <<EOF
Slirc (${domain})
=================================

Welcome to ${domain}. This is a private Slirc workspace.
Connect with your Slirc account via SASL.
EOF
  else
    sed -e "s#https://chat.example.com#https://${domain}#g" \
        -e "s/#open-chat/${channel}/g" "$template" > "$dest"
  fi
  chmod 644 "$dest"
}

write_configuration() {
  step "Preparing directories and configuration"

  local subnet_prefix="${SUBNET%.0/24}"
  local caddy_ip="${subnet_prefix}.10"
  local app_ip="${subnet_prefix}.20"
  local ergo_ip="${subnet_prefix}.30"
  local ergo_tls_bind="127.0.0.1"
  [[ "$EXPOSE_IRC" == "true" ]] && ergo_tls_bind="0.0.0.0"

  install -d -m 755 "$INSTALL_DIR" "$DATA_DIR" "$DATA_DIR/app" "$DATA_DIR/ergo" "$DATA_DIR/caddy/data" "$DATA_DIR/caddy/config" "$DATA_DIR/backups"
  install -d -m 700 "$KEYS_DIR"

  # 1. IRC password derivation key (never overwritten once created).
  local key_file="$KEYS_DIR/irc-key"
  local key_created="false"
  if [[ -f "$key_file" ]] && [[ "$(wc -c < "$key_file" | tr -d '[:space:]')" -ge 32 ]]; then
    chmod 600 "$key_file"
    info "  Preserving existing IRC key at $key_file"
  else
    openssl rand -out "$key_file" 32
    chmod 600 "$key_file"
    key_created="true"
    ok "Generated 32-byte IRC key at $key_file"
  fi

  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  fetch_asset "deploy/selfhost/compose.yaml" "$tmpdir/compose.yaml"
  fetch_asset "deploy/selfhost/Caddyfile" "$tmpdir/Caddyfile"
  fetch_asset "deploy/selfhost/slirc" "$tmpdir/slirc"
  fetch_asset "ergo/ergo.example.yaml" "$tmpdir/ergo.example.yaml"
  fetch_asset "ergo/ergo.motd" "$tmpdir/ergo.motd"

  install -m 644 "$tmpdir/compose.yaml" "$INSTALL_DIR/compose.yaml"
  install -m 644 "$tmpdir/Caddyfile" "$INSTALL_DIR/Caddyfile"
  render_motd "$tmpdir/ergo.motd" "$INSTALL_DIR/ergo.motd" "$DOMAIN" "$MODE" "$CHANNEL"

  # 2. Compose interpolation .env (no secrets).
  cat > "$INSTALL_DIR/.env" <<EOF
SLIRC_DOMAIN=${DOMAIN}
SLIRC_ACME_EMAIL=${OWNER_EMAIL}
SLIRC_IMAGE=${SLIRC_IMAGE}
ERGO_IMAGE=${ERGO_IMAGE}
CADDY_IMAGE=${CADDY_IMAGE}
SLIRC_SUBNET=${SUBNET}
CADDY_IP=${caddy_ip}
APP_IP=${app_ip}
ERGO_IP=${ergo_ip}
ERGO_TLS_BIND=${ergo_tls_bind}
SLIRC_DATA_DIR=${DATA_DIR}
SLIRC_KEYS_DIR=${KEYS_DIR}
TZ=${TZ_VALUE}
EOF
  chmod 644 "$INSTALL_DIR/.env"

  # 3. app.env + ergo.yaml (idempotent: never clobber an existing working config).
  local app_env="$INSTALL_DIR/app.env"
  local ergo_yaml="$INSTALL_DIR/ergo.yaml"

  if [[ -f "$app_env" && -f "$ergo_yaml" ]]; then
    info "  Preserving existing $app_env and $ergo_yaml (edit with: slirc env)"
  else
    local oper_pass webirc_pass
    oper_pass="$(read_env_key "$app_env" ERGO_OPER_PASS)"
    webirc_pass="$(read_env_key "$app_env" ERGO_WEBIRC_PASS)"
    [[ -n "$oper_pass" ]] || oper_pass="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
    [[ -n "$webirc_pass" ]] || webirc_pass="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"

    if [[ ! -f "$app_env" ]]; then
      local open_channels seed_channels helpers
      if [[ "$MODE" == "public_playground" ]]; then
        if [[ "$CHANNEL" == "#help" ]]; then
          open_channels="#help"
          seed_channels='{"#help":{"private":false,"members":[]}}'
        else
          open_channels="${CHANNEL},#help"
          seed_channels="{\"${CHANNEL}\":{\"private\":false,\"members\":[]},\"#help\":{\"private\":false,\"members\":[]}}"
        fi
        helpers="help,remind,poll,welcome"
      else
        open_channels=""
        seed_channels="{\"${CHANNEL}\":{\"private\":true,\"members\":[]}}"
        helpers="help,remind,poll"
      fi

      (
        umask 077
        {
          printf 'APP_HOST=%s\n' "$DOMAIN"
          printf 'APP_ORIGIN=https://%s\n' "$DOMAIN"
          printf 'OWNER_NICK=%s\n' "$OWNER_NICK"
          printf 'USERS_JSON={"%s":"%s"}\n' "$OWNER_NICK" "$OWNER_EMAIL"
          printf 'ERGO_OPER_USER=%s\n' "$ERGO_OPER_USER"
          printf 'ERGO_OPER_PASS=%s\n' "$oper_pass"
          printf 'ERGO_WEBIRC_PASS=%s\n' "$webirc_pass"
          printf 'SLIRC_TRUSTED_PROXIES=%s\n' "$caddy_ip"
          printf 'SLIRC_MODE=%s\n' "$MODE"
          printf 'IRC_CHANNEL=%s\n' "$CHANNEL"
          printf 'OPEN_CHANNELS=%s\n' "$open_channels"
          if [[ "$MODE" == "public_playground" ]]; then
            printf 'OPEN_CHAT_ROOM=%s\n' "$CHANNEL"
          fi
          printf 'SEED_CHANNELS_JSON=%s\n' "$seed_channels"
          printf 'SLIRC_HELPERS=%s\n' "$helpers"
          printf 'VAPID_CONTACT=mailto:%s\n' "$OWNER_EMAIL"
          if [[ "$EXPOSE_IRC" == "true" ]]; then
            printf 'SLIRC_IRC_HOST=%s\n' "$DOMAIN"
          else
            printf '# Uncomment after exposing port 6697 in .env (ERGO_TLS_BIND=0.0.0.0):\n'
            printf '# SLIRC_IRC_HOST=%s\n' "$DOMAIN"
          fi
          if [[ -n "$RESEND_API_KEY" ]]; then
            printf 'RESEND_API_KEY=%s\n' "$RESEND_API_KEY"
            printf 'RESEND_FROM=%s\n' "${RESEND_FROM:-Slirc <slirc@${DOMAIN}>}"
          else
            printf '# Email delivery via Resend (run: sudo slirc env)\n'
            printf '# RESEND_API_KEY=re_...\n'
            printf '# RESEND_FROM=Slirc <slirc@%s>\n' "$DOMAIN"
          fi
          if [[ -n "$GIPHY_API_KEY" ]]; then
            printf 'GIPHY_API_KEY=%s\n' "$GIPHY_API_KEY"
          else
            printf '# GIF search (/giphy) and daily welcome gif:\n'
            printf '# GIPHY_API_KEY=\n'
          fi
          if [[ -n "$OPENROUTER_API_KEY" ]]; then
            printf 'OPENROUTER_API_KEY=%s\n' "$OPENROUTER_API_KEY"
            printf 'HELP_ANSWER_MODEL=%s\n' "${HELP_ANSWER_MODEL:-$DEFAULT_HELP_MODEL}"
          else
            printf '# AI helpers (@help bot & natural-language @remind via OpenRouter):\n'
            printf '# OPENROUTER_API_KEY=\n'
            printf '# HELP_ANSWER_MODEL=%s\n' "$DEFAULT_HELP_MODEL"
            printf '# HELP_CLASSIFIER_MODEL=xiaomi/mimo-v2.6-flash\n'
            printf '# HELP_MODEL=xiaomi/mimo-v2.5\n'
          fi
        } > "$app_env"
      )
      chmod 600 "$app_env"
      ok "Wrote $app_env"
    fi

    if [[ ! -f "$ergo_yaml" ]]; then
      step "Hashing Ergo operator credentials"
      local oper_hash webirc_hash
      oper_hash="$(hash_ergo_password "$oper_pass")"
      webirc_hash="$(hash_ergo_password "$webirc_pass")"
      render_ergo_yaml "$tmpdir/ergo.example.yaml" "$ergo_yaml" "$DOMAIN" "$ERGO_OPER_USER" "$oper_hash" "$webirc_hash" "$SUBNET" "$MODE"
      ok "Rendered $ergo_yaml"
    fi
  fi

  # 4. Install management wrapper CLI.
  install -d -m 755 "$(dirname "$BIN_PATH")"
  install -m 755 "$tmpdir/slirc" "$BIN_PATH"
  ok "Installed CLI at $BIN_PATH"

  rm -rf "$tmpdir"
  trap - EXIT

  if [[ "$key_created" == "true" ]]; then
    KEY_REMINDER="Save ${key_file} in your password manager now (never store it alongside database backups)."
  else
    KEY_REMINDER="IRC key preserved at ${key_file} (keep a separate copy in your password manager)."
  fi
}

start_stack() {
  [[ "$DRY_RUN" == "true" ]] && return 0

  step "Pulling container images"
  docker compose --project-directory "$INSTALL_DIR" -f "$INSTALL_DIR/compose.yaml" pull

  step "Starting Caddy, Ergo, and Slirc"
  docker compose --project-directory "$INSTALL_DIR" -f "$INSTALL_DIR/compose.yaml" up -d

  step "Waiting for Slirc to become healthy"
  local i
  for i in $(seq 1 45); do
    if docker exec slirc bun -e 'const r = await fetch("http://127.0.0.1:8080/healthz"); if (!r.ok) process.exit(1);' >/dev/null 2>&1; then
      ok "Slirc is healthy."
      break
    fi
    if [[ "$i" -eq 45 ]]; then
      warn "Slirc did not pass /healthz within 90s. Inspect logs with: slirc logs slirc"
    fi
    sleep 2
  done

  if [[ "$EXPOSE_IRC" == "true" ]]; then
    step "Syncing TLS certificate for direct IRC (:6697)"
    local synced=0
    for i in $(seq 1 15); do
      if SLIRC_INSTALL_DIR="$INSTALL_DIR" "$BIN_PATH" sync-certs --quiet >/dev/null 2>&1; then
        synced=1
        ok "Synced Let's Encrypt certificate to Ergo."
        break
      fi
      sleep 2
    done
    if [[ $synced -eq 0 ]]; then
      warn "Caddy has not finished issuing a certificate for $DOMAIN yet. Once DNS is live, run: sudo slirc sync-certs"
    fi

    if [[ -d "$(dirname "$CRON_CERT_SYNC")" ]]; then
      cat > "$CRON_CERT_SYNC" <<EOF
#!/bin/sh
SLIRC_INSTALL_DIR="${INSTALL_DIR}" "${BIN_PATH}" sync-certs --quiet >/dev/null 2>&1 || true
EOF
      chmod 755 "$CRON_CERT_SYNC"
    fi
  fi

  if [[ "$AUTO_UPDATE" == "true" ]]; then
    step "Configuring nightly automatic updates"
    SLIRC_INSTALL_DIR="$INSTALL_DIR" "$BIN_PATH" auto-update on
  fi
}

print_summary() {
  info ""
  if [[ "$DRY_RUN" == "true" ]]; then
    divider
    printf '%s✓ Dry run complete.%s Generated files:\n' "$C_BGREEN" "$C_RESET"
    printf '  %sConfig:%s  %s\n' "$C_DIM" "$C_RESET" "$INSTALL_DIR"
    printf '  %sData:%s    %s\n' "$C_DIM" "$C_RESET" "$DATA_DIR"
    printf '  %sIRC key:%s %s/irc-key\n' "$C_DIM" "$C_RESET" "$KEYS_DIR"
    printf '  %sCLI:%s     %s\n' "$C_DIM" "$C_RESET" "$BIN_PATH"
    return 0
  fi

  print_ready_banner
  divider
  printf '%s✓ Slirc is ready at%s %shttps://%s%s\n' "$C_BGREEN" "$C_RESET" "$C_BCYAN" "$DOMAIN" "$C_RESET"
  info ""
  printf '  %sOwner:%s   %s%s%s %s(%s)%s\n' "$C_DIM" "$C_RESET" "$C_WHITE" "$OWNER_NICK" "$C_RESET" "$C_DIM" "$OWNER_EMAIL" "$C_RESET"
  printf '  %sMode:%s    %s%s%s %s(%s)%s\n' "$C_DIM" "$C_RESET" "$C_WHITE" "$MODE" "$C_RESET" "$C_DIM" "$CHANNEL" "$C_RESET"
  if [[ "$EXPOSE_IRC" == "true" ]]; then
    printf '  %sIRC TLS:%s %s%s:6697%s %s(public)%s\n' "$C_DIM" "$C_RESET" "$C_WHITE" "$DOMAIN" "$C_RESET" "$C_DIM" "$C_RESET"
  else
    printf '  %sIRC TLS:%s %s127.0.0.1:6697%s %s(loopback only)%s\n' "$C_DIM" "$C_RESET" "$C_WHITE" "$C_RESET" "$C_DIM" "$C_RESET"
  fi
  if [[ "$AUTO_UPDATE" == "true" ]]; then
    printf '  %sUpdates:%s %snightly automatic updates enabled%s %s(slirc auto-update off)%s\n' "$C_DIM" "$C_RESET" "$C_GREEN" "$C_RESET" "$C_DIM" "$C_RESET"
  else
    printf '  %sUpdates:%s manual %s(slirc update)%s\n' "$C_DIM" "$C_RESET" "$C_DIM" "$C_RESET"
  fi
  info ""
  printf '%sIMPORTANT:%s %s\n' "$C_BYELLOW" "$C_RESET" "$KEY_REMINDER"
  info ""
  if [[ -n "$RESEND_API_KEY" ]]; then
    printf '%sNext step:%s\n' "$C_BOLD" "$C_RESET"
    printf '  Open %shttps://%s%s and sign in with %s%s%s.\n' "$C_BCYAN" "$DOMAIN" "$C_RESET" "$C_WHITE" "$OWNER_EMAIL" "$C_RESET"
  else
    printf '%sNext steps%s %s(email delivery not configured yet)%s:\n' "$C_BOLD" "$C_RESET" "$C_DIM" "$C_RESET"
    printf '  1. Mint a one-time owner sign-in link right now:  %sslirc login-link%s\n' "$C_CYAN" "$C_RESET"
    printf '  2. Add Resend later for email sign-ins & invites: %sslirc env%s\n' "$C_CYAN" "$C_RESET"
  fi
  info ""
  printf '%sManage your instance:%s\n' "$C_BOLD" "$C_RESET"
  printf '  %sslirc status%s       %sCheck containers, health, version, and auto-updates%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
  printf '  %sslirc logs%s         %sFollow logs (or: slirc logs slirc)%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
  printf '  %sslirc restart%s      %sRestart app without dropping Ergo IRC sessions%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
  printf '  %sslirc update%s       %sPull latest images, recreate changed services, rollback on failure%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
  printf '  %sslirc backup%s       %sCreate a consistent tar.gz backup (excludes irc-key)%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
  printf '  %sslirc env%s          %sEdit app.env and recreate containers%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
  printf '  %sslirc uninstall%s    %sRemove Slirc (with confirmation)%s\n' "$C_CYAN" "$C_RESET" "$C_DIM" "$C_RESET"
  divider
}

main() {
  setup_colors
  parse_args "$@"
  validate_subnet "$SUBNET" || die "Invalid --subnet: $SUBNET (expected an IPv4 /24 such as 10.89.42.0/24)"
  check_system
  collect_inputs
  check_ports
  ensure_docker
  write_configuration
  start_stack
  print_summary
}

main "$@"
