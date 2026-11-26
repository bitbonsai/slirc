# One local dev stack: slirc2. Existing names, ports and data volumes stay unchanged.
_dev_app_project := "slirc2"
_dev_ergo_project := "slirc2-ergo"
_dev_network := "slirc2"
_dev_subnet := "172.30.16.0/24"
_dev_ergo_ip := "172.30.16.2"
_dev_app_container := "slirc2-app"
_dev_ergo_container := "slirc2-ergo"
_dev_landing_container := "slirc2-landing"
_dev_app_volume := "slirc2-data"
_dev_ergo_data_volume := "slirc2-ergo-data"
_dev_ergo_api_volume := "slirc2-ergo-api"
_dev_app_port := "9110"
_dev_landing_port := "9109"
_dev_irc_tls_bind := "127.0.0.1"
_dev_irc_tls_port := "6797"
# Loopback gives desktop browsers a secure context for Web Locks.
_dev_loopback_binding := "- \"127.0.0.1:" + _dev_app_port + ":8080\""
_dev_ergo_image := env_var_or_default("SLIRC_ERGO_IMAGE", "ghcr.io/bitbonsai/slirc-ergo:v2.19.1-63c743a")
_dev_seed_script := "scripts/client-seed.ts"
_dev_status_filter := "^slirc2-(app|ergo|landing)$"
_dev_base := justfile_directory() / ".data" / "dev-slirc2"
_dev_ergo_override := _dev_base / "ergo.override.yaml"
_dev_app_override := _dev_base / "app.override.yaml"
_dev_config_dir := env_var_or_default("SLIRC_CONFIG_DIR", _dev_base / "config")

[group('development')]
dev:
  #!/usr/bin/env bash
  set -euo pipefail
  admin_users="$(bun -e '
    const email = process.env.SLIRC_DEV_ADMIN_EMAIL?.trim().toLowerCase();
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      console.error("Set SLIRC_DEV_ADMIN_EMAIL to your email in .env before running just dev.");
      process.exit(1);
    }
    console.log(JSON.stringify({admin: email, eve: "eve@example.test"}));
  ')"
  config_dir="{{_dev_config_dir}}"
  case "$config_dir" in
    "$HOME/.config/slirc"|"$HOME/.config/slirc/"*) echo "refusing to generate local dev config inside ~/.config/slirc" >&2; exit 1;;
  esac
  mkdir -p "$config_dir" "$(dirname "{{_dev_ergo_override}}")"
  if [ ! -f "$config_dir/ergo.yaml" ]; then
    cp ergo/ergo.example.yaml "$config_dir/ergo.yaml"
    # Exempt the local subnet from connection limits and SASL requirements.
    # perl, not sed -i: BSD sed on macOS rejects GNU's -i and \n in the replacement.
    perl -pi -e 's#^( *)- "10\.0\.0\.0/8"$#$1- "10.0.0.0/8"\n$1- "{{_dev_subnet}}"#' "$config_dir/ergo.yaml"
  fi
  if [ ! -f "$config_dir/env" ]; then
    printf '%s\n' \
      'OWNER_NICK=admin' \
      "USERS_JSON=$admin_users" \
      'SEED_CHANNELS_JSON={"#dev-test":{"private":true,"members":["admin","eve"]}}' \
      'ERGO_OPER_USER=slirc-org' \
      'ERGO_OPER_PASS=slirc-dev-oper' \
      'SLIRC_BOT_ENABLED=false' \
      'SLIRC_HELPERS_ENABLED=true' \
      'SLIRC_ROOM_AMBIENCE=false' \
      'TZ=Europe/Amsterdam' > "$config_dir/env"
  fi
  # Every IRC password derives from this key (app/src/irc-key.ts). A new key resets them all.
  [ -f "$config_dir/irc-key" ] || openssl rand -out "$config_dir/irc-key" 32
  chmod 600 "$config_dir/ergo.yaml" "$config_dir/env" "$config_dir/irc-key"
  tailscale_ip="$(tailscale ip -4)"
  test -n "$tailscale_ip" || { echo "Tailscale has no IPv4 address" >&2; exit 1; }
  test "$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["BackendState"])')" = "Running" || { echo "Tailscale is not running" >&2; exit 1; }
  if [ "$(uname -s)" = Darwin ]; then
    podman info >/dev/null 2>&1 || podman machine start
  fi
  podman info >/dev/null
  podman image exists "{{_dev_ergo_image}}" || podman pull "{{_dev_ergo_image}}" || {
    # The image is public. A stale ghcr.io login makes ghcr answer 403, so retry anonymously.
    anon_auth="$(mktemp)"
    echo '{"auths":{}}' > "$anon_auth"
    podman pull --authfile "$anon_auth" "{{_dev_ergo_image}}"
    rm -f "$anon_auth"
  }
  loopback_binding='{{_dev_loopback_binding}}'
  if [ "$(uname -s)" = Darwin ]; then
    # podman machine binds every host IP as 0.0.0.0 inside its VM, so the loopback and
    # Tailscale bindings collide there ("rootlessport conflict"). The Tailscale one stays.
    loopback_binding=""
  fi
  app_origin="${SLIRC_DEV_ORIGIN:-http://$tailscale_ip:{{_dev_app_port}}}"
  app_host="${app_origin#*://}"
  podman network inspect "{{_dev_network}}" >/dev/null 2>&1 || podman network create --subnet "{{_dev_subnet}}" "{{_dev_network}}"
  for volume in "{{_dev_ergo_data_volume}}" "{{_dev_ergo_api_volume}}" "{{_dev_app_volume}}"; do podman volume inspect "$volume" >/dev/null 2>&1 || podman volume create "$volume"; done
  cat > "{{_dev_ergo_override}}" <<YAML
  services:
    ergo:
      image: {{_dev_ergo_image}}
  YAML
  # Model keys from .env (just loads it) reach the app by name only: a bare key makes
  # podman-compose pass the value from its own environment, so it never lands in this file.
  model_env=""
  for key in OPENROUTER_API_KEY TYPESAFE_API_KEY; do
    if [ -n "${!key:-}" ]; then model_env+="      $key:"$'\n'; fi
  done
  cat > "{{_dev_app_override}}" <<YAML
  services:
    app:
      environment:
        ERGO_HOST: {{_dev_ergo_ip}}
        ERGO_API_URL: http://{{_dev_ergo_ip}}:8089
        APP_ORIGIN: $app_origin
        APP_HOST: $app_host
        # Override existing generated config too; .env is the source for the seed admin email.
        USERS_JSON: |-
          $admin_users
        # Internal local-only marker for auth and fixture guards, not a stack selector.
        SLIRC_DEV_PROFILE: "slirc2"
        # Helpers (help, remind, poll, welcome) run locally so their flows can be tested; overrides older generated env.
        SLIRC_HELPERS_ENABLED: "true"
        # Mode marker for the one fixture open room below. Private #dev-test and its
        # membership are unaffected; this is source configuration, not a stack label.
        SLIRC_MODE: "public_playground"
        OPEN_CHANNELS: "#dev-open"
        MAGIC_LINK_LOG: "true"
  ${model_env}
        # The local stack is on a Tailscale address, which the embed SSRF guard blocks.
        EMBED_ALLOW_PRIVATE: "true"
        TZ: ${TZ:-Europe/Amsterdam}
      ports: !override
        - "$tailscale_ip:{{_dev_app_port}}:8080"
        $loopback_binding
      volumes: !override
        - "$PWD/app:/app"
        - slirc-data:/data
        - slirc-ergo-api:/run/secrets:ro
        - "$config_dir/irc-key:/run/slirc-irc-key:ro"
      command: ["sh", "-c", "until bun src/migrate-founder.ts; do sleep 1; done; (bun {{_dev_seed_script}} || echo 'seed failed' >&2) & exec bun --watch src/main.ts"]
    landing:
      image: docker.io/library/caddy:2-alpine
      container_name: {{_dev_landing_container}}
      ports:
        - "$tailscale_ip:{{_dev_landing_port}}:80"
      volumes:
        - "$PWD/landing:/usr/share/caddy:ro"
      networks:
        - slirc
      restart: unless-stopped
  YAML
  SLIRC_CONFIG_DIR="$config_dir" \
  SLIRC_NETWORK="{{_dev_network}}" \
  SLIRC_ERGO_CONTAINER="{{_dev_ergo_container}}" \
  SLIRC_ERGO_DATA_VOLUME="{{_dev_ergo_data_volume}}" \
  SLIRC_ERGO_API_VOLUME="{{_dev_ergo_api_volume}}" \
  ERGO_IP="{{_dev_ergo_ip}}" \
  ERGO_TLS_BIND="{{_dev_irc_tls_bind}}" \
  ERGO_TLS_PORT="{{_dev_irc_tls_port}}" \
  podman-compose --in-pod=false -p "{{_dev_ergo_project}}" -f deploy/ergo.compose.yaml -f "{{_dev_ergo_override}}" up -d
  SLIRC_CONFIG_DIR="$config_dir" \
  SLIRC_NETWORK="{{_dev_network}}" \
  SLIRC_APP_CONTAINER="{{_dev_app_container}}" \
  SLIRC_APP_DATA_VOLUME="{{_dev_app_volume}}" \
  SLIRC_ERGO_API_VOLUME="{{_dev_ergo_api_volume}}" \
  SLIRC_IRC_KEY_PATH="$config_dir/irc-key" \
  podman-compose --in-pod=false -p "{{_dev_app_project}}" -f deploy/app.compose.yaml -f "{{_dev_app_override}}" up -d --build --force-recreate
  for _ in $(seq 1 20); do
    curl -fsS "http://$tailscale_ip:{{_dev_app_port}}/healthz" >/dev/null 2>&1 && curl -fsS "http://$tailscale_ip:{{_dev_landing_port}}/" >/dev/null 2>&1 && break
    sleep 3
  done
  curl -fsS "http://$tailscale_ip:{{_dev_app_port}}/healthz"
  curl -fsS "http://$tailscale_ip:{{_dev_landing_port}}/" >/dev/null
  echo
  echo "Slirc is available at $app_origin"
  echo "Landing is available at http://$tailscale_ip:{{_dev_landing_port}}"

[group('development')]
dev-seed force="":
  # Fake people and varied messages (embed cards, inline images, markdown, a mention)
  # for local UI work. Resumable: whoever posted already is skipped.
  podman exec {{_dev_app_container}} bun scripts/dev-seed.ts {{force}}

[group('development')]
reset:
  # Destructive: local slirc2 dev data only (app SQLite, Ergo history, API token).
  # The guard in scripts/dev-reset.ts refuses a production hostname, production
  # container/network names, a mismatched SLIRC_DEV_PROFILE or unexpected mounts
  # before anything stops, then removes only slirc2-data, slirc2-ergo-data and
  # slirc2-ergo-api and recreates the stack. Run `just dev` first so it can verify.
  bun app/scripts/dev-reset.ts

[group('development')]
dev-reset: reset

[group('development')]
dev-restart:
  podman restart {{_dev_app_container}}
  podman inspect {{_dev_app_container}} | sed -n 's/.*"Status": *"\([^"]*\)".*/\1/p; s/.*"StartedAt": *"\([^"]*\)".*/\1/p'

[group('development')]
dev-status:
  podman ps --filter name='{{_dev_status_filter}}'
  curl -fsS "http://$(tailscale ip -4):{{_dev_app_port}}/healthz"

[group('development')]
dev-logs service='app':
  case '{{service}}' in app) container={{_dev_app_container}};; ergo) container={{_dev_ergo_container}};; *) echo 'usage: just dev-logs app|ergo' >&2; exit 1;; esac
  podman logs -f "$container"

[group('development')]
dev-down:
  #!/usr/bin/env bash
  set -euo pipefail
  SLIRC_CONFIG_DIR="{{_dev_config_dir}}" \
  SLIRC_NETWORK="{{_dev_network}}" \
  SLIRC_APP_CONTAINER="{{_dev_app_container}}" \
  SLIRC_APP_DATA_VOLUME="{{_dev_app_volume}}" \
  SLIRC_ERGO_API_VOLUME="{{_dev_ergo_api_volume}}" \
  SLIRC_IRC_KEY_PATH="{{_dev_config_dir}}/irc-key" \
  podman-compose --in-pod=false -p "{{_dev_app_project}}" -f deploy/app.compose.yaml -f "{{_dev_app_override}}" down
  SLIRC_CONFIG_DIR="{{_dev_config_dir}}" \
  SLIRC_NETWORK="{{_dev_network}}" \
  SLIRC_ERGO_CONTAINER="{{_dev_ergo_container}}" \
  SLIRC_ERGO_DATA_VOLUME="{{_dev_ergo_data_volume}}" \
  SLIRC_ERGO_API_VOLUME="{{_dev_ergo_api_volume}}" \
  ERGO_IP="{{_dev_ergo_ip}}" \
  podman-compose --in-pod=false -p "{{_dev_ergo_project}}" -f deploy/ergo.compose.yaml -f "{{_dev_ergo_override}}" down
