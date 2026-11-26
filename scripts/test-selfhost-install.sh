#!/usr/bin/env bash
# Automated test suite for the Slirc self-host installer and management CLI.
# Runs offline in temporary directories without mutating host state or starting services.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ERGO_IMAGE="${ERGO_IMAGE:-ghcr.io/bitbonsai/slirc-ergo:v2.19.1}"

pass() { printf '  PASS: %s\n' "$*"; }
fail() { printf '  FAIL: %s\n' "$*" >&2; exit 1; }

file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

file_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

printf 'Testing Slirc self-host installer (%s)\n' "$ROOT"

# 1. Syntax & landing copy check
bash -n "$ROOT/install.sh" "$ROOT/deploy/selfhost/slirc" "$ROOT/scripts/test-selfhost-install.sh"
pass "bash -n syntax check"

if command -v shellcheck >/dev/null 2>&1 && shellcheck --version >/dev/null 2>&1; then
  shellcheck "$ROOT/install.sh" "$ROOT/deploy/selfhost/slirc" "$ROOT/scripts/test-selfhost-install.sh"
  pass "shellcheck clean"
fi

cmp -s "$ROOT/install.sh" "$ROOT/landing/install" || fail "landing/install differs from install.sh"
cmp -s "$ROOT/install.sh" "$ROOT/landing/install.sh" || fail "landing/install.sh differs from install.sh"
pass "install.sh, landing/install, and landing/install.sh are identical"

# 2. Compose & Caddyfile invariants
! grep -v '^[[:space:]]*#' "$ROOT/deploy/selfhost/compose.yaml" | grep -q '8067' || fail "compose.yaml must not expose Ergo WebSocket 8067"
! grep -v '^[[:space:]]*#' "$ROOT/deploy/selfhost/compose.yaml" | grep -qE 'SLIRC_MODE|OPEN_CHANNELS|IRC_CHANNEL|ERGO__ACCOUNTS__REQUIRE_SASL' \
  || fail "compose.yaml must not override mode, channels, or require-sasl in environment:"
! grep -v '^[[:space:]]*#' "$ROOT/deploy/selfhost/Caddyfile" | grep -q '/webirc' || fail "Caddyfile must not proxy /webirc"
grep -q 'header_up X-Forwarded-For {client_ip}' "$ROOT/deploy/selfhost/Caddyfile" || fail "Caddyfile must set X-Forwarded-For {client_ip}"
pass "compose.yaml and Caddyfile security invariants"

# 3. Private workspace dry-run install
PRIV="$WORK/private"
"$ROOT/install.sh" \
  --non-interactive \
  --dry-run \
  --skip-dns-check \
  --source-dir "$ROOT" \
  --domain chat.example.test \
  --owner-email Ada@Example.Test \
  --install-dir "$PRIV/opt" \
  --data-dir "$PRIV/data" \
  --keys-dir "$PRIV/keys" \
  --bin-path "$PRIV/bin/slirc" >/dev/null

[[ -f "$PRIV/keys/irc-key" ]] || fail "irc-key not created"
[[ "$(wc -c < "$PRIV/keys/irc-key" | tr -d '[:space:]')" -eq 32 ]] || fail "irc-key must be 32 bytes"
[[ "$(file_mode "$PRIV/keys")" == "700" ]] || fail "keys dir must be mode 700"
[[ "$(file_mode "$PRIV/keys/irc-key")" == "600" ]] || fail "irc-key must be mode 600"
[[ "$(file_mode "$PRIV/opt/app.env")" == "600" ]] || fail "app.env must be mode 600"
[[ "$(file_mode "$PRIV/opt/ergo.yaml")" == "600" ]] || fail "ergo.yaml must be mode 600"
[[ -x "$PRIV/bin/slirc" ]] || fail "slirc CLI must be executable"

grep -qx 'APP_HOST=chat.example.test' "$PRIV/opt/app.env" || fail "missing APP_HOST"
grep -qx 'APP_ORIGIN=https://chat.example.test' "$PRIV/opt/app.env" || fail "missing APP_ORIGIN"
grep -qx 'OWNER_NICK=ada' "$PRIV/opt/app.env" || fail "derived OWNER_NICK mismatch"
grep -qx 'USERS_JSON={"ada":"ada@example.test"}' "$PRIV/opt/app.env" || fail "USERS_JSON mismatch"
grep -qx 'SLIRC_MODE=private_workspace' "$PRIV/opt/app.env" || fail "SLIRC_MODE mismatch"
grep -qx 'OPEN_CHANNELS=' "$PRIV/opt/app.env" || fail "OPEN_CHANNELS must be empty in private mode"
grep -qx 'SLIRC_TRUSTED_PROXIES=10.89.42.10' "$PRIV/opt/app.env" || fail "SLIRC_TRUSTED_PROXIES must pin Caddy IP"
grep -qx 'ERGO_TLS_BIND=127.0.0.1' "$PRIV/opt/.env" || fail "ERGO_TLS_BIND must default to loopback"

grep -q '    name: chat$' "$PRIV/opt/ergo.yaml" || fail "ergo.yaml network.name mismatch"
grep -q '    name: chat.example.test$' "$PRIV/opt/ergo.yaml" || fail "ergo.yaml server.name mismatch"
grep -q '    operator-only-creation: true$' "$PRIV/opt/ergo.yaml" || fail "ergo.yaml must set operator-only-creation: true"
grep -q '            - "ban"' "$PRIV/opt/ergo.yaml" || fail "ergo.yaml missing ban oper capability"
grep -q '            - "nofakelag"' "$PRIV/opt/ergo.yaml" || fail "ergo.yaml missing nofakelag oper capability"
grep -q '            - "10.89.42.0/24"' "$PRIV/opt/ergo.yaml" || fail "ergo.yaml missing subnet in ip-limits.exempted"
grep -q '                - "10.89.42.0/24"' "$PRIV/opt/ergo.yaml" || fail "ergo.yaml missing subnet in webirc.hosts"
grep -q '    slirc-oper:' "$PRIV/opt/ergo.yaml" || fail "ergo.yaml missing slirc-oper"
! grep -q 'slirc-org' "$PRIV/opt/ergo.yaml" || fail "ergo.yaml still contains slirc-org"
! grep -q 'chat.example.com' "$PRIV/opt/ergo.yaml" || fail "ergo.yaml still contains chat.example.com"
! grep -q '    admin:' "$PRIV/opt/ergo.yaml" || fail "ergo.yaml still contains unused default admin oper"
! grep -q 'pAOhFDyMq5Wa9NCvhoPXOeAge73nnL5SQ8iePfXSbKaHiCTW3igxK' "$PRIV/opt/ergo.yaml" || fail "ergo.yaml still has dev oper hash"
! grep -q 'abcdef0123456789abcdef0123456789abcdef0123456789abcde' "$PRIV/opt/ergo.yaml" || fail "ergo.yaml still has placeholder webirc hash"
awk '/^    require-sasl:/{f=1} f && /enabled: true/{ok=1; exit} f && /^    [a-z]/ && !/require-sasl:/{exit} END{exit !ok}' "$PRIV/opt/ergo.yaml" \
  || fail "private ergo.yaml must enable require-sasl"
pass "private workspace dry-run config generation"

# 4. Public peek + custom #feedback channel + exposed IRC + Resend/Giphy/OpenRouter + custom subnet
PUB="$WORK/public"
"$ROOT/install.sh" \
  --non-interactive \
  --dry-run \
  --skip-dns-check \
  --source-dir "$ROOT" \
  --domain open.example.test \
  --owner-email ben@example.test \
  --owner-nick ben_admin \
  --mode public \
  --channel feedback \
  --expose-irc \
  --no-auto-update \
  --resend-api-key re_test_123 \
  --resend-from 'Slirc <hello@open.example.test>' \
  --giphy-api-key giphy_test_key \
  --openrouter-api-key or_test_key \
  --help-model anthropic/claude-haiku-5.5 \
  --subnet 10.99.7.0/24 \
  --install-dir "$PUB/opt" \
  --data-dir "$PUB/data" \
  --keys-dir "$PUB/keys" \
  --bin-path "$PUB/bin/slirc" >/dev/null

grep -qx 'SLIRC_MODE=public_playground' "$PUB/opt/app.env" || fail "public SLIRC_MODE mismatch"
grep -qx 'IRC_CHANNEL=#feedback' "$PUB/opt/app.env" || fail "public IRC_CHANNEL mismatch"
grep -qx 'OPEN_CHANNELS=#feedback,#help' "$PUB/opt/app.env" || fail "public OPEN_CHANNELS mismatch"
grep -qx 'OPEN_CHAT_ROOM=#feedback' "$PUB/opt/app.env" || fail "public OPEN_CHAT_ROOM mismatch"
grep -qx 'RESEND_API_KEY=re_test_123' "$PUB/opt/app.env" || fail "RESEND_API_KEY mismatch"
grep -qx 'RESEND_FROM=Slirc <hello@open.example.test>' "$PUB/opt/app.env" || fail "RESEND_FROM mismatch"
grep -qx 'GIPHY_API_KEY=giphy_test_key' "$PUB/opt/app.env" || fail "GIPHY_API_KEY mismatch"
grep -qx 'OPENROUTER_API_KEY=or_test_key' "$PUB/opt/app.env" || fail "OPENROUTER_API_KEY mismatch"
grep -qx 'HELP_ANSWER_MODEL=anthropic/claude-haiku-5.5' "$PUB/opt/app.env" || fail "HELP_ANSWER_MODEL mismatch"
grep -qx 'SLIRC_TRUSTED_PROXIES=10.99.7.10' "$PUB/opt/app.env" || fail "custom subnet Caddy IP mismatch"
grep -qx 'SLIRC_IRC_HOST=open.example.test' "$PUB/opt/app.env" || fail "SLIRC_IRC_HOST must be set with --expose-irc"
grep -qx 'ERGO_TLS_BIND=0.0.0.0' "$PUB/opt/.env" || fail "ERGO_TLS_BIND must be 0.0.0.0 with --expose-irc"
grep -q '#feedback' "$PUB/opt/ergo.motd" || fail "public ergo.motd should mention #feedback"
awk '/^    require-sasl:/{f=1} f && /enabled: false/{ok=1; exit} f && /^    [a-z]/ && !/require-sasl:/{exit} END{exit !ok}' "$PUB/opt/ergo.yaml" \
  || fail "public ergo.yaml must leave require-sasl disabled"
pass "public peek (#feedback) + exposed IRC + Resend/Giphy/OpenRouter dry-run config generation"

# 5. Idempotency check: re-run must preserve keys, app.env, ergo.yaml, and existing DBs
printf 'existing-app-db' > "$PRIV/data/app/chat.sqlite"
printf 'existing-ergo-db' > "$PRIV/data/ergo/ircd.db"
key_before="$(file_hash "$PRIV/keys/irc-key")"
env_before="$(file_hash "$PRIV/opt/app.env")"
ergo_before="$(file_hash "$PRIV/opt/ergo.yaml")"
appdb_before="$(file_hash "$PRIV/data/app/chat.sqlite")"
ergodb_before="$(file_hash "$PRIV/data/ergo/ircd.db")"

"$ROOT/install.sh" \
  --non-interactive \
  --dry-run \
  --skip-dns-check \
  --source-dir "$ROOT" \
  --domain chat.example.test \
  --owner-email ada@example.test \
  --install-dir "$PRIV/opt" \
  --data-dir "$PRIV/data" \
  --keys-dir "$PRIV/keys" \
  --bin-path "$PRIV/bin/slirc" >/dev/null

[[ "$(file_hash "$PRIV/keys/irc-key")" == "$key_before" ]] || fail "re-run overwrote irc-key"
[[ "$(file_hash "$PRIV/opt/app.env")" == "$env_before" ]] || fail "re-run overwrote app.env"
[[ "$(file_hash "$PRIV/opt/ergo.yaml")" == "$ergo_before" ]] || fail "re-run overwrote ergo.yaml"
[[ "$(file_hash "$PRIV/data/app/chat.sqlite")" == "$appdb_before" ]] || fail "re-run touched chat.sqlite"
[[ "$(file_hash "$PRIV/data/ergo/ircd.db")" == "$ergodb_before" ]] || fail "re-run touched ircd.db"
pass "idempotent re-run preserves keys, config, and databases"

# 6. Docker Compose rendering + live Ergo config smoke test (when Docker is running)
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker compose --project-directory "$PRIV/opt" -f "$PRIV/opt/compose.yaml" config >/dev/null
  docker compose --project-directory "$PUB/opt" -f "$PUB/opt/compose.yaml" config >/dev/null
  pass "docker compose config validates both private and public stacks"

  for case_dir in "$PRIV" "$PUB"; do
    smoke_dir="$case_dir/ergo-smoke"
    mkdir -p "$smoke_dir"
    cp "$case_dir/opt/ergo.yaml" "$smoke_dir/ircd.yaml"
    cp "$case_dir/opt/ergo.motd" "$smoke_dir/ergo.motd"
    docker run --rm \
      -v "$smoke_dir:/ircd" \
      --entrypoint /bin/sh \
      "$ERGO_IMAGE" \
      -c '/ircd-bin/ergo mkcerts --conf /ircd/ircd.yaml --quiet && /ircd-bin/ergo run --conf /ircd/ircd.yaml --smoke --quiet' >/dev/null
  done
  pass "Ergo --smoke validates rendered private and public ergo.yaml"

  docker run --rm \
    -e APP_HOST=chat.example.test \
    -e ACME_EMAIL=ada@example.test \
    -v "$PRIV/opt/Caddyfile:/etc/caddy/Caddyfile:ro" \
    caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1
  pass "caddy validate accepts Caddyfile"
else
  printf '  SKIP: Docker daemon unavailable; skipped compose config and Ergo --smoke checks\n'
fi

# 7. Backup test: consistent SQLite snapshots, excludes irc-key
if command -v python3 >/dev/null 2>&1; then
  rm -f "$PRIV/data/app/chat.sqlite"
  python3 - "$PRIV/data/app/chat.sqlite" "$PRIV/data/ergo/ergo_history.db" <<'PY'
import sqlite3, sys
for path in sys.argv[1:]:
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)")
    conn.execute("INSERT INTO items (body) VALUES ('hello slirc')")
    conn.commit()
    conn.close()
PY
  mkdir -p "$PRIV/data/app/avatars"
  printf 'avatar-bytes' > "$PRIV/data/app/avatars/ada"

  backup_tar="$WORK/test-backup.tar.gz"
  SLIRC_INSTALL_DIR="$PRIV/opt" "$PRIV/bin/slirc" backup "$backup_tar" >/dev/null

  [[ -f "$backup_tar" ]] || fail "backup archive not created"
  [[ "$(file_mode "$backup_tar")" == "600" ]] || fail "backup archive must be mode 600"
  tar_list="$(tar -tzf "$backup_tar")"
  grep -q 'app/chat.sqlite' <<<"$tar_list" || fail "backup missing app/chat.sqlite"
  grep -q 'app/avatars/ada' <<<"$tar_list" || fail "backup missing app/avatars/ada"
  grep -q 'ergo/ergo_history.db' <<<"$tar_list" || fail "backup missing ergo/ergo_history.db"
  grep -q 'ergo/ircd.db' <<<"$tar_list" || fail "backup missing ergo/ircd.db"
  grep -q 'config/app.env' <<<"$tar_list" || fail "backup missing config/app.env"
  grep -q 'SHA256SUMS' <<<"$tar_list" || fail "backup missing SHA256SUMS"
  ! grep -q 'irc-key' <<<"$tar_list" || fail "backup must NEVER include irc-key"

  extract="$WORK/extracted"
  mkdir -p "$extract"
  tar -xzf "$backup_tar" -C "$extract"
  python3 - "$extract/app/chat.sqlite" "$extract/ergo/ergo_history.db" <<'PY'
import sqlite3, sys
for path in sys.argv[1:]:
    conn = sqlite3.connect(path)
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert conn.execute("SELECT body FROM items").fetchone()[0] == "hello slirc"
    conn.close()
PY
  pass "slirc backup produces valid SQLite snapshots and excludes irc-key"
fi

# 9. Default-path --dry-run uses a temp directory without needing root
default_dry_out="$(
  TMPDIR="$WORK" bash "$ROOT/install.sh" \
    --dry-run \
    --non-interactive \
    --skip-dns-check \
    --source-dir "$ROOT" \
    --domain dry.example.com \
    --owner-email dry@example.com
)"
grep -q 'slirc-dry-run\.' <<<"$default_dry_out" || fail "--dry-run should auto-route to a temporary directory"
pass "default-path --dry-run writes to a temp directory without root"

# 10. Invalid RESEND_FROM is rejected
if TMPDIR="$WORK" bash "$ROOT/install.sh" \
  --dry-run --non-interactive --skip-dns-check --source-dir "$ROOT" \
  --domain dry.example.com --owner-email dry@example.com \
  --resend-api-key re_test --resend-from 'not-an-email' >/dev/null 2>&1; then
  fail "expected invalid --resend-from to be rejected"
fi
pass "invalid RESEND_FROM rejected"

printf 'All self-host installer tests passed.\n'
