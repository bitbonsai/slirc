[group('deployment')]
deploy:
  #!/usr/bin/env bash
  set -euo pipefail
  test -z "$(git status --porcelain)" || { echo "commit or stash changes first" >&2; exit 1; }
  commit="$(git rev-parse HEAD)"
  PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-deploy-app.py
  bun run test
  git push origin main
  ssh {{deploy_host}} "COMMIT=$commit CHECKOUT={{checkout}} CONFIG_DIR={{config_dir}} APP={{deploy_app}} ERGO={{deploy_ergo}} VOLUME={{deploy_app_volume}} API_VOLUME={{deploy_ergo_api_volume}} NETWORK={{deploy_network}} ERGO_IP={{deploy_ergo_ip}} APP_IP={{deploy_app_ip}} ORIGIN={{deploy_origin}} PORT={{deploy_port}} IRC_KEY_PATH={{deploy_irc_key_path}} bash -s" <<'REMOTE'
  set -euo pipefail
  cd "$CHECKOUT"
  git fetch --prune origin main
  git reset --hard "$COMMIT"
  test -f "$CONFIG_DIR/env" || { echo "$CONFIG_DIR/env is missing" >&2; exit 1; }
  test -f "$CONFIG_DIR/ergo.yaml" || { echo "$CONFIG_DIR/ergo.yaml is missing" >&2; exit 1; }
  started_at() { printf '%s' "$1" | sed -n 's/.*"StartedAt": *"\([^"]*\)".*/\1/p'; }
  ergo="$(started_at "$(podman inspect "$ERGO")")"
  podman volume inspect "$API_VOLUME" >/dev/null
  SLIRC_IRC_KEY_PATH="$IRC_KEY_PATH" python3 "$CHECKOUT/scripts/deploy-app.py" --checkout "$CHECKOUT" --config-dir "$CONFIG_DIR" \
    --app "$APP" --ergo "$ERGO" --volume "$VOLUME" --api-volume "$API_VOLUME" \
    --network "$NETWORK" --ergo-host "$ERGO_IP" --app-ip "$APP_IP" --origin "$ORIGIN" --port "$PORT"
  for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 3; done
  curl -fsS "http://127.0.0.1:$PORT/healthz"
  curl -fsS "http://127.0.0.1:$PORT/api/version"
  test "$ergo" = "$(started_at "$(podman inspect "$ERGO")")" || { echo "Ergo restarted" >&2; exit 1; }
  REMOTE

[group('deployment')]
deploy-ergo:
  #!/usr/bin/env bash
  set -euo pipefail
  test -z "$(git status --porcelain)" || { echo "commit or stash changes first" >&2; exit 1; }
  commit="$(git rev-parse HEAD)"
  git push origin main
  ssh {{deploy_host}} "COMMIT=$commit CHECKOUT={{checkout}} CONFIG_DIR={{config_dir}} APP={{deploy_app}} ERGO={{deploy_ergo}} NETWORK={{deploy_network}} ERGO_IP={{deploy_ergo_ip}} ERGO_DATA_VOLUME={{deploy_ergo_data_volume}} API_VOLUME={{deploy_ergo_api_volume}} bash -s" <<'REMOTE'
  set -euo pipefail
  cd "$CHECKOUT"
  git fetch --prune origin main
  git reset --hard "$COMMIT"
  test -f "$CONFIG_DIR/ergo.yaml" || { echo "$CONFIG_DIR/ergo.yaml is missing" >&2; exit 1; }
  started_at() { printf '%s' "$1" | sed -n 's/.*"StartedAt": *"\([^"]*\)".*/\1/p'; }
  app="$(started_at "$(podman inspect "$APP" 2>/dev/null || true)")"
  export SLIRC_CONFIG_DIR="$CONFIG_DIR" SLIRC_ERGO_CONTAINER="$ERGO" SLIRC_NETWORK="$NETWORK" \
    ERGO_IP="$ERGO_IP" SLIRC_ERGO_DATA_VOLUME="$ERGO_DATA_VOLUME" SLIRC_ERGO_API_VOLUME="$API_VOLUME"
  podman-compose --in-pod=false -p "$ERGO" -f "$CHECKOUT/deploy/ergo.compose.yaml" pull
  podman-compose --in-pod=false -p "$ERGO" -f "$CHECKOUT/deploy/ergo.compose.yaml" up -d
  test -z "$app" || test "$app" = "$(started_at "$(podman inspect "$APP")")" || { echo "app restarted" >&2; exit 1; }
  REMOTE

# Without `push` the image goes to an OCI archive under .data/ergo-image/; with `push` it goes to
# ghcr. Pin the printed digest in deploy/ergo.compose.yaml.
# Build stock Ergo (amd64+arm64, provenance) from ergo/Dockerfile and print the digest
[group('deployment')]
build-ergo mode="archive":
  #!/usr/bin/env bash
  set -euo pipefail
  case "{{mode}}" in archive|push) ;; *) echo "usage: just build-ergo [push]" >&2; exit 1;; esac
  arg() { sed -n "s/^ARG $1=//p" ergo/Dockerfile; }
  version="$(arg ERGO_VERSION)"; commit="$(arg ERGO_COMMIT)"
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "ergo/Dockerfile needs ERGO_VERSION and a full ERGO_COMMIT" >&2; exit 1; }
  tagged="$(git ls-remote https://github.com/ergochat/ergo "refs/tags/$version^{}" | cut -f1)"
  test "$tagged" = "$commit" || { echo "$version is $tagged upstream, not $commit" >&2; exit 1; }
  image="ghcr.io/bitbonsai/slirc-ergo:$version-${commit:0:7}"
  mkdir -p .data/ergo-image
  metadata=".data/ergo-image/$version-${commit:0:7}.json"
  if [ "{{mode}}" = push ]; then output=(--push); else output=(--output "type=oci,dest=.data/ergo-image/$version-${commit:0:7}.oci.tar"); fi
  docker buildx build ergo \
    --platform linux/amd64,linux/arm64 \
    --provenance mode=max \
    --label "org.opencontainers.image.source=https://github.com/ergochat/ergo" \
    --label "org.opencontainers.image.revision=$commit" \
    --label "org.opencontainers.image.version=$version" \
    --tag "$image" \
    --metadata-file "$metadata" \
    "${output[@]}"
  digest="$(sed -n 's/.*"containerimage.digest": *"\([^"]*\)".*/\1/p' "$metadata")"
  test -n "$digest" || { echo "no digest in $metadata" >&2; exit 1; }
  echo "$image@$digest"

[group('deployment')]
deploy-landing:
  #!/usr/bin/env bash
  set -euo pipefail
  test -z "$(git status --porcelain)" || { echo "commit or stash changes first" >&2; exit 1; }
  commit="$(git rev-parse HEAD)"
  git push origin main
  ssh {{deploy_host}} "cd {{checkout}} && git fetch --prune origin main && git reset --hard $commit && test -f landing/index.html"

[group('deployment')]
deploy-docs:
  #!/usr/bin/env bash
  set -euo pipefail
  test -z "$(git status --porcelain)" || { echo "commit or stash changes first" >&2; exit 1; }
  bun test app/test/docs.test.ts
  commit="$(git rev-parse HEAD)"
  git push origin main
  ssh {{deploy_host}} "cd {{checkout}} && git fetch --prune origin main && git reset --hard $commit && test -f app/public/docs/index.html"

[group('deployment')]
bootstrap:
  #!/usr/bin/env bash
  set -euo pipefail
  test -z "$(git status --porcelain)" || { echo "commit or stash changes first" >&2; exit 1; }
  commit="$(git rev-parse HEAD)"
  git push origin main
  ssh {{deploy_host}} "COMMIT=$commit CHECKOUT={{checkout}} CONFIG_DIR={{config_dir}} APP={{deploy_app}} ERGO={{deploy_ergo}} NETWORK={{deploy_network}} SUBNET={{deploy_subnet}} ERGO_IP={{deploy_ergo_ip}} APP_IP={{deploy_app_ip}} PORT={{deploy_port}} VOLUME={{deploy_app_volume}} ERGO_DATA_VOLUME={{deploy_ergo_data_volume}} API_VOLUME={{deploy_ergo_api_volume}} IRC_KEY_PATH={{deploy_irc_key_path}} bash -s" <<'REMOTE'
  set -euo pipefail
  cd "$CHECKOUT"
  git fetch --prune origin main
  git reset --hard "$COMMIT"
  test -f "$CONFIG_DIR/env" || { echo "$CONFIG_DIR/env is missing" >&2; exit 1; }
  test -f "$CONFIG_DIR/ergo.yaml" || { echo "$CONFIG_DIR/ergo.yaml is missing" >&2; exit 1; }
  podman network inspect "$NETWORK" >/dev/null 2>&1 || podman network create --subnet "$SUBNET" "$NETWORK"
  for volume in "$ERGO_DATA_VOLUME" "$API_VOLUME" "$VOLUME"; do podman volume inspect "$volume" >/dev/null 2>&1 || podman volume create "$volume"; done
  export SLIRC_CONFIG_DIR="$CONFIG_DIR" SLIRC_NETWORK="$NETWORK" ERGO_IP="$ERGO_IP" \
    SLIRC_ERGO_CONTAINER="$ERGO" SLIRC_ERGO_DATA_VOLUME="$ERGO_DATA_VOLUME" SLIRC_ERGO_API_VOLUME="$API_VOLUME" \
    SLIRC_APP_CONTAINER="$APP" SLIRC_APP_DATA_VOLUME="$VOLUME" SLIRC_APP_PORT="$PORT" SLIRC_APP_IP="$APP_IP"
  podman-compose --in-pod=false -p "$ERGO" -f "$CHECKOUT/deploy/ergo.compose.yaml" up -d
  # Every IRC password derives from this key. Never replace it once accounts exist: see deploy/README.md.
  export SLIRC_IRC_KEY_PATH="${IRC_KEY_PATH:-$HOME/.config/slirc-keys/$APP/irc-key}"
  test -f "$SLIRC_IRC_KEY_PATH" || { echo "create the IRC key first: mkdir -p $(dirname "$SLIRC_IRC_KEY_PATH") && openssl rand -out $SLIRC_IRC_KEY_PATH 32 && chmod 600 $SLIRC_IRC_KEY_PATH" >&2; exit 1; }
  podman-compose --in-pod=false -p "$APP" -f "$CHECKOUT/deploy/app.compose.yaml" -f "$CHECKOUT/deploy/app.fixed-ip.compose.yaml" up -d --build --force-recreate
  REMOTE
