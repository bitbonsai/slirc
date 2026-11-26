# Self-hosted Docker stack

This directory holds the Docker Compose stack, Caddyfile, and `slirc` management CLI installed by [`install.sh`](../../install.sh). It is independent from `deploy/app.compose.yaml` and `deploy/ergo.compose.yaml`, which remain for rootless Podman setups.

## Install

On a Linux server (`x86_64` or `arm64`) with a domain pointed at it:

```bash
curl -fsSL https://install.slirc.org | sudo bash
```

Non-interactive example:

```bash
curl -fsSL https://install.slirc.org | sudo bash -s -- \
  --non-interactive \
  --domain chat.example.com \
  --owner-email you@example.com \
  --owner-nick you \
  --mode public \
  --channel feedback \
  --giphy-api-key ... \
  --openrouter-api-key ...
```

Run `bash install.sh --help` for every flag and `SLIRC_*` environment variable.

## Architecture and network layout

Three containers share one private bridge network (`10.89.42.0/24` by default, configurable with `--subnet`):

- `slirc-caddy` (`10.89.42.10`): binds host ports `80` and `443`, obtains Let's Encrypt TLS certificates automatically, and forwards traffic to `slirc:8080` with `X-Forwarded-For: {client_ip}`.
- `slirc` (`10.89.42.20`): runs `ghcr.io/bitbonsai/slirc:latest`. Sets `SLIRC_TRUSTED_PROXIES=10.89.42.10` so per-visitor rate limits and `WEBIRC` use each visitor's real IP. Relays browser WebSockets at `/irc` to Ergo over the internal network.
- `slirc-ergo` (`10.89.42.30`): runs `ghcr.io/bitbonsai/slirc-ergo:v2.19.1` with persistent SQLite history (`expire-time: 0s`), `channels.operator-only-creation: true`, and `ban` + `nofakelag` on the `slirc-oper` oper class. Port `6697` binds to `127.0.0.1` by default, or `0.0.0.0` when `--expose-irc` is enabled.

## Directory layout

- `/opt/slirc/`: `compose.yaml`, `.env`, `app.env` (`0600`), `Caddyfile`, `ergo.yaml` (`0600`), `ergo.motd`.
- `/var/lib/slirc/app/`: `chat.sqlite` (accounts, sessions, channel metadata, uploads) and `avatars/`.
- `/var/lib/slirc/ergo/`: `ircd.db`, `ergo_history.db`, and TLS cert copies when `:6697` is enabled.
- `/var/lib/slirc/caddy/`: Caddy certificates and state.
- `/var/lib/slirc/backups/`: timestamped `.tar.gz` backups created by `slirc backup`.
- `/var/lib/slirc-keys/irc-key`: 32-byte HMAC key (`0600`) in a separate `0700` directory outside backups. Keep a copy in your password manager.
- `/usr/local/bin/slirc`: management wrapper installed from `deploy/selfhost/slirc`.
- `/etc/systemd/system/slirc-update.{service,timer}` (or `/etc/cron.daily/slirc-auto-update`): nightly image update check.

## Management commands

```bash
slirc status                    # containers, /healthz, /api/version, updates, and paths
slirc logs [service]            # follow logs (slirc, ergo, caddy, or all)
slirc restart [service|--all]   # restart slirc without dropping Ergo (or named service)
slirc update [--auto]           # pull images, recreate only changed services, rollback on failure
slirc auto-update [on|off|status]
                                     # manage nightly automatic updates
slirc backup [dest]             # consistent SQLite tar.gz backup (excludes irc-key)
slirc env [--compose]           # edit app.env (or .env with --compose) and recreate
slirc login-link [nick]         # mint a one-time 15-minute sign-in link on the server
slirc sync-certs [--quiet]      # copy Caddy's Let's Encrypt cert into Ergo and SIGHUP
slirc uninstall [--purge]       # stop and remove Slirc (keeps data unless confirmed)
```

## Nightly updates and safe restarts

By default the installer enables `slirc-update.timer` (nightly at `03:30` with up to 30 minutes of random jitter, falling back to `/etc/cron.daily/slirc-auto-update` on non-systemd hosts).

Each run executes `slirc update --auto`:

1. Pulls image manifests/layers and compares image IDs against the running containers. If nothing changed, it exits without restarting any container.
2. When `slirc` has a new image, recreates only `slirc` (`--no-deps`) so `slirc-ergo` stays up and IRC connections survive. Caddy holds incoming HTTP requests for up to 20 seconds (`lb_try_duration 20s`).
3. Waits for `slirc` `/healthz` to return 200. If it fails within 60 seconds, rolls back automatically to the previous healthy `slirc` image ID.
4. Recreates `ergo` or `caddy` only when their own image tags move, syncs `:6697` TLS certs if public, and prunes superseded dangling images.

Disable anytime with `slirc auto-update off` (or `--no-auto-update` at install time).

## Restoring a backup

1. Install Slirc on the target server (or stop existing containers with `docker compose --project-directory /opt/slirc -f /opt/slirc/compose.yaml down`).
2. Restore your saved 32-byte key to `/var/lib/slirc-keys/irc-key` (`chmod 600`).
3. Extract the archive into a temporary directory, verify `SHA256SUMS`, and copy files back:
   - `config/*` -> `/opt/slirc/` (`chmod 600 /opt/slirc/app.env /opt/slirc/ergo.yaml`)
   - `app/*` -> `/var/lib/slirc/app/`
   - `ergo/*` -> `/var/lib/slirc/ergo/`
4. Remove any stale `chat.sqlite-wal`, `chat.sqlite-shm`, or `ergo_history.db-wal` files before starting.
5. Start the stack: `docker compose --project-directory /opt/slirc -f /opt/slirc/compose.yaml up -d`, then check `slirc status`.

## Enabling direct IRC TLS (`:6697`) later

1. Open TCP port `6697` in your server firewall.
2. Run `slirc env --compose` and set `ERGO_TLS_BIND=0.0.0.0`.
3. Run `slirc env` and uncomment `SLIRC_IRC_HOST=yourdomain`.
4. Run `slirc sync-certs` to copy Caddy's Let's Encrypt certificate into Ergo and reload it via `SIGHUP`.
5. Add `/etc/cron.daily/slirc-sync-certs` calling `/usr/local/bin/slirc sync-certs --quiet` so renewals stay in sync.

## Running behind Cloudflare or another CDN

When traffic passes through a CDN, `{client_ip}` in Caddy defaults to the CDN edge IP. Add a `servers` block inside the global options at the top of `/opt/slirc/Caddyfile` with your CDN's trusted proxy CIDRs and client IP header (for example `client_ip_headers CF-Connecting-IP`), then reload Caddy (`docker exec slirc-caddy caddy reload --config /etc/caddy/Caddyfile`).

## Testing locally

```bash
./scripts/test-selfhost-install.sh
```

This runs dry-run installs for both `private_workspace` and `public_playground` (`#feedback`) modes in temporary directories, validates `compose.yaml`, `Caddyfile`, and rendered `ergo.yaml` against the real Ergo and Caddy images, verifies idempotent re-runs, and tests `slirc backup`.
