title: Run your own Slirc
crumb: Connect / Self-hosting
description: Install Slirc on your own Linux server with one command, automatic HTTPS, nightly updates, and the slirc CLI, or set up rootless Podman manually.
lead: Self-host Slirc on a fresh Linux server with one command. Three containers run on a private Docker network: Caddy handles HTTPS, Bun serves the app, and Ergo runs IRC underneath.

<video class="doc-video" src="/media/self-host-install.mp4" poster="/media/self-host-install-poster.png" width="1236" height="870" controls muted playsinline preload="metadata" aria-label="Installing Slirc on a fresh Debian 12 server with curl -fsSL https://install.slirc.org | sudo bash"></video>

The [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license) lets you run Slirc for your own group. Hosting it for others requires permission from the author.

## Quick install

### What you need

- A Linux server (`x86_64` or `arm64`). A 2 vCPU, 4 GB box runs Slirc with room to spare.
- A domain with an `A` or `AAAA` DNS record pointed at the server, and ports `80` and `443` reachable from the internet.
- Optional API keys (all skippable during setup and easy to add later via `slirc env`): [Resend](https://resend.com/) for sign-in emails and invites, [GIPHY](https://developers.giphy.com/) for `/giphy` search, and [OpenRouter](https://openrouter.ai/) for AI answers in `@help` and natural-language `@remind`.

### Run the installer

SSH into your server and run:

```bash
curl -fsSL https://install.slirc.org | sudo bash
```

You can also fetch the script straight from GitHub (`https://raw.githubusercontent.com/bitbonsai/slirc/main/install.sh`).

The installer installs Docker Engine and the Compose plugin if they are missing, asks four short questions, generates every secret and config file, pulls the multi-arch images (`ghcr.io/bitbonsai/slirc:latest`, `ghcr.io/bitbonsai/slirc-ergo:v2.19.1`, and `caddy:2-alpine`), starts the stack, and enables nightly updates:

1. **Domain:** checks that DNS resolves to the server (warns if not, and lets you continue anyway).
2. **Owner email and nickname:** creates the initial admin account.
3. **Workspace mode and default channel:** private workspace (invite-only `#general`, default) or public peek (visitors can read your default public channel such as `#general` or `#feedback` and sign up).
4. **Optional integrations, direct IRC, and updates:** press Enter to skip any of Resend (`RESEND_API_KEY` + `RESEND_FROM`), GIPHY (`GIPHY_API_KEY`), and OpenRouter (`OPENROUTER_API_KEY` + `@help` model, default `anthropic/claude-haiku-5.5`). Then pick whether to expose direct IRC TLS on port `6697` (default loopback only) and whether to keep nightly automatic updates on (default yes).

### What gets installed

- `/opt/slirc/`: `compose.yaml`, `.env`, `app.env` (mode `0600`), `Caddyfile`, `ergo.yaml` (mode `0600`), and `ergo.motd`.
- `/var/lib/slirc/`: persistent app SQLite database and uploads (`app/`), Ergo account and history databases (`ergo/`), Caddy certificates (`caddy/`), and backup archives (`backups/`).
- `/var/lib/slirc-keys/irc-key`: 32 random bytes (mode `0600`) that derive every IRC password via HMAC. It stays outside `/var/lib/slirc` so backups never hold anything that logs in to IRC. Copy it into your password manager once, separately from backups, and never replace it while people use the server.
- `/usr/local/bin/slirc`: management CLI for status, logs, restarts, updates, backups, and env edits.
- `slirc-update.timer` (systemd, or `/etc/cron.daily/slirc-auto-update`): checks nightly around `03:30` for new container images.

Re-running the installer is safe: existing keys, databases, `app.env`, and `ergo.yaml` are preserved.

### First sign-in

- **If you entered a Resend key:** open `https://yourdomain`, enter your owner email, and sign in with the 6-digit code or link Resend delivers.
- **If you skipped Resend:** run `slirc login-link` on the server to print a one-time 15-minute sign-in link for the owner account. When you are ready for email sign-ins and team invitations, run `slirc env`, uncomment `RESEND_API_KEY` and `RESEND_FROM`, and save.

Your owner account is an admin and can create channels and invite people. In `private_workspace` mode, other people join by invitation. In `public_playground` mode, visitors can read your default public channel (such as `#general` or `#feedback`) and sign up from the sign-in form while the day's mail count stays under `MAIL_DAILY_LIMIT` (`SIGNUP_DOMAIN_LIMIT`, default 30, caps new signups per receiving domain per hour). See [Getting started](/docs/getting-started).

### Automatic updates and safe restarts

Like ONCE, a self-hosted Slirc instance checks for new images once every 24 hours via `slirc-update.timer` (`slirc update --auto`):

- When no image digest has changed, nothing restarts.
- When only the `slirc` app image has changed, `slirc update` recreates only the `slirc` container (`--no-deps`), leaving Ergo running so IRC sessions stay connected. Caddy retries in-flight HTTP requests for up to 20 seconds while the new container comes up.
- After swapping in the new app container, `slirc update` polls `/healthz`. If the new image fails health checks within 60 seconds, it rolls back automatically to the previous healthy image ID.
- Superseded untagged layers are pruned after a clean update so disk usage stays flat.

Turn nightly updates off or check the next scheduled run at any time:

```bash
slirc auto-update status
slirc auto-update off
slirc auto-update on
```

### Day-to-day management

`slirc` elevates automatically with `sudo` when run as a non-root user so secrets under `/opt/slirc` stay mode `0600`.

```bash
slirc status                # containers, /healthz, version, updates, and paths
slirc logs [service]        # follow logs (slirc, ergo, caddy, or all)
slirc restart [service]     # restart app without dropping Ergo (or --all)
slirc update                # pull images, recreate changed services, rollback on failure
slirc auto-update status    # inspect or toggle nightly automatic updates
slirc backup [dest]         # create a consistent tar.gz backup (excludes irc-key)
slirc env [--compose]       # edit app.env (or .env with --compose) and recreate
slirc login-link [nick]     # mint a one-time 15-minute sign-in link on the server
slirc sync-certs            # sync Caddy's TLS cert to Ergo (for public :6697)
slirc uninstall             # stop and remove Slirc (asks before deleting data)
```

`slirc backup` takes transactionally consistent SQLite snapshots (`chat.sqlite` and `ergo_history.db`), verifies them with `PRAGMA integrity_check`, includes `ircd.db`, avatars, and config, and leaves `/var/lib/slirc-keys/irc-key` out of the archive. Copy archives off the server on a schedule.

To restore a backup on a new server, place your saved `irc-key` at `/var/lib/slirc-keys/irc-key` (mode `0600`), stop the stack, extract `config/*` to `/opt/slirc/`, `app/*` to `/var/lib/slirc/app/`, and `ergo/*` to `/var/lib/slirc/ergo/`, remove any leftover `-wal`/`-shm` files, and start the stack again with `docker compose --project-directory /opt/slirc -f /opt/slirc/compose.yaml up -d`.

If you enabled direct IRC TLS on port `6697`, the installer sets `SLIRC_IRC_HOST` in `app.env` so the in-app **IRC clients** tab fills in your server address, and adds `/etc/cron.daily/slirc-sync-certs` so renewed Let's Encrypt certificates reload into Ergo via `SIGHUP` without dropping connections. To turn `:6697` on later, set `ERGO_TLS_BIND=0.0.0.0` via `slirc env --compose`, uncomment `SLIRC_IRC_HOST` via `slirc env`, and run `slirc sync-certs`.

### Non-interactive and automated installs

Pass flags (or matching `SLIRC_*` environment variables) for scripted or CI installs:

```bash
curl -fsSL https://install.slirc.org | sudo bash -s -- \
  --non-interactive \
  --domain chat.example.com \
  --owner-email you@example.com \
  --owner-nick you \
  --mode public \
  --channel feedback \
  --resend-api-key re_... \
  --resend-from 'Slirc <slirc@chat.example.com>' \
  --giphy-api-key ... \
  --openrouter-api-key ... \
  --help-model anthropic/claude-haiku-5.5
```

Add `--expose-irc` to publish port `6697` on `0.0.0.0`, `--no-auto-update` to disable nightly updates, `--skip-dns-check` to skip the DNS lookup, or `--dry-run` to render configuration into temporary directories without installing Docker or starting containers.

## Optional environment variables

Add or change any of these in `/opt/slirc/app.env` using `slirc env` (or `~/.config/slirc/env` in manual setups). Because Docker and Podman read env files only when a container is created, recreate the app container after any edit (`slirc env` does this automatically).

- `GIPHY_API_KEY`: enables [GIPHY search](https://developers.giphy.com/docs/api/) and the `welcome` helper's daily greeting gif in your public channel.
- `OPENROUTER_API_KEY`: enables the [help bot and natural-language reminders](/docs/bots) through [OpenRouter](https://openrouter.ai). Model names are OpenRouter ids; older bare names such as `mimo-v2.5` still work.
- `HELP_ANSWER_MODEL`: model that writes help answers (default `anthropic/claude-haiku-5.5`).
- `HELP_CLASSIFIER_MODEL`: cheaper model that first sorts each message into a Slirc question, small talk, or off topic (default `xiaomi/mimo-v2.6-flash`).
- `TYPESAFE_API_KEY`: sorts messages with [TypeSafe](https://typesafe.ai)'s Jev instead (classifier defaults to `jev-latest`; `TYPESAFE_BASE_URL` and `TYPESAFE_INPUT_PRICE_PER_BILLION` are optional).
- `HELP_MODEL`: model for reminders and other helpers (default `xiaomi/mimo-v2.5`).
- `SLIRC_HELPER_DAILY_LIMIT`: caps model calls that the help bot and natural-language reminders make for one account in 24 hours, combined (default `100`). Past the limit, help asks you to try again tomorrow and reminders still accept short forms such as `in 20m stretch`, `tomorrow 9:00 pick up cake`, `list`, and `cancel 3`.
- `SLIRC_HELPERS`: comma list of helpers to run, such as `help,remind`. Unset runs `help`, `remind`, `poll`, and `welcome`; `links` runs only when listed; an unknown name stops the app at start. Set `SLIRC_HELPERS_ENABLED=false` to run none.
- `SLIRC_AGENTS_ENABLED=false`: turns off coding-agent pairing on the instance.
- `OPEN_CHAT_ROOM`: sets which public channel signed-out visitors can peek at in `public_playground` mode (default `#open-chat`, for example `#feedback`).
- `SLIRC_BRAND`: optional brand override (`slirc.app` for the blue hosted lockup); unset uses the neutral Slirc mark.
- `SLIRC_EMOJI_BUDGET_BYTES`: caps total custom emoji storage in bytes (default `104857600`, 100 MB); each member can add 50 custom emoji per 24 hours.
- `TESTFLIGHT_URL`: public iPhone TestFlight link in the form `https://testflight.apple.com/join/<code>`. Signed-in, verified members see **Get the iPhone app** in More on a phone and in **Devices -> Add your phone** on desktop. Unset, or any other URL, hides it.
- `MAIL_DAILY_WARN` (default `80`) and `MAIL_DAILY_LIMIT` (default `100`): logs a warning and caps daily Resend volume for the instance. Bulk email invites stop at 75% of `MAIL_DAILY_LIMIT` so sign-in emails keep going through. When several instances share one Resend key, split the account's daily limit between them. Run `bun scripts/mail-count.ts` in the app container to print today, the last 7 days, and the month so far.

## History retention

The supplied Ergo config uses `history.restrictions.expire-time: 0s`: persistent messages stay stored until someone explicitly deletes them. Existing installations must update their mounted `ergo.yaml` separately; changing the example file does not alter a running server. Ergo applies this setting on `SIGHUP` without restarting. Disabling expiry does not restore messages purged under an earlier policy. Monitor disk usage and keep backups.

## Advanced / manual setup (rootless Podman, host Caddy, and just)

If you prefer rootless Podman, host-level Caddy, and source builds pushed from your own machine with `just`, the repo keeps its original two-container Compose files untouched under `deploy/`.

### Prerequisites

- A Linux server with [rootless Podman](https://podman.io/docs/installation), [`podman-compose`](https://github.com/containers/podman-compose), [Git](https://git-scm.com/), and [just](https://just.systems/). The [Ergo](https://ergo.chat/) image `ghcr.io/bitbonsai/slirc-ergo:v2.19.1` ships for ARM64 and x86_64 under one tag.
- A domain pointed at the server and [Caddy](https://caddyserver.com/docs/install) on the host for TLS.
- Your own machine with Git and just for deploys. Deploys push a committed tree and reset the server checkout to that exact commit.

### 1. Clone and set your host

On your machine:

```bash
git clone https://github.com/bitbonsai/slirc
cd slirc
```

Open `justfile` and set the SSH host, checkout path, and config directory at the top to your own values.

### 2. Config on the server

Keep secrets outside git in `~/.config/slirc` (mode `0700`), with `env` and `ergo.yaml` at mode `0600`:

```bash
ssh yourserver
mkdir -p ~/.config/slirc && chmod 700 ~/.config/slirc
```

Create `~/.config/slirc/env`:

```bash
APP_HOST=app.yourdomain
APP_ORIGIN=https://app.yourdomain
OWNER_NICK=yournick
USERS_JSON={"yournick":"you@example.com"}
ERGO_OPER_USER=slirc-org
ERGO_OPER_PASS=another-long-random-password
SLIRC_MODE=private_workspace
IRC_CHANNEL=#general
OPEN_CHANNELS=
SLIRC_TRUSTED_PROXIES=10.89.0.14
RESEND_API_KEY=re_...
RESEND_FROM=Slirc <slirc@yourdomain>
VAPID_CONTACT=mailto:you@example.com
```

Create the 32-byte IRC password key outside `~/.config/slirc` and copy it to your password manager:

```bash
mkdir -p ~/.config/slirc-keys/org && chmod 700 ~/.config/slirc-keys
openssl rand -out ~/.config/slirc-keys/org/irc-key 32 && chmod 600 ~/.config/slirc-keys/org/irc-key
```

Copy `ergo/ergo.example.yaml` to `~/.config/slirc/ergo.yaml`:

```bash
scp ergo/ergo.example.yaml yourserver:~/.config/slirc/ergo.yaml
```

Edit `network.name` and `server.name` to your domain, ensure `channels.operator-only-creation: true` and `ip-limits.exempted` covers `10.0.0.0/8`, and replace the `slirc-org` oper password hash using:

```bash
podman run --rm -it ghcr.io/bitbonsai/slirc-ergo:v2.19.1 ergo genpasswd
```

### 3. Host Caddy

Copy `caddy/example.caddy` to your Caddy sites directory and replace the domain and paths with yours. The app block forwards each visitor's IP cleanly:

```caddyfile
app.yourdomain {
	handle {
		reverse_proxy 127.0.0.1:9010 {
			lb_try_duration 20s
			header_up X-Forwarded-For {client_ip}
		}
	}
}
```

Port `9010` binds to localhost only. Browsers reach IRC through the app's `/irc` relay, so Ergo needs no WebSocket listener. Reload Caddy.

### 4. Bootstrap and deploy

Back on your machine, with a clean tree:

```bash
just bootstrap
just status
just logs app
```

Day to day:

```bash
just deploy          # tests, then rebuild and recreate the app; Ergo keeps running
just deploy-ergo     # recreate Ergo; the app keeps running
just deploy-docs     # publish the docs site, if you serve one
just logs ergo
```

Before upgrading manually, rehearse app schema migrations on a consistent snapshot:

```bash
cd app
bun scripts/rehearse-migration.ts /private/backups/app.sqlite
```

## When something is off

- **"Reconnecting..." in the browser after a burst of joins.** The container network subnet is missing from `ip-limits.exempted` in `ergo.yaml`. Add it and reload Ergo with `SIGHUP`.
- **`owner credentials are missing` on start.** `OWNER_NICK` is missing as a key in `USERS_JSON`.
- **`IRC key file /run/slirc-irc-key is missing` on start.** Restore or create the 32-byte key file at `/var/lib/slirc-keys/irc-key` (or `SLIRC_IRC_KEY_PATH` in manual setups).
- **Sign-in links never arrive.** Check `RESEND_FROM` is a verified sender on your Resend account, then run `slirc logs slirc` (or `just logs app`) for the send error. You can always sign in as the owner with `slirc login-link`.
- **Caddy fails to issue a certificate.** Confirm your domain's `A`/`AAAA` record resolves to the server and ports `80` and `443` are open in your firewall (`ufw` or cloud security group), then check `slirc logs caddy`.
- **Ergo logs `read ircd.yaml: is a directory`.** `ergo.yaml` was missing when the container started and the bind mount created a directory in its place. Remove that directory, restore `ergo.yaml`, and recreate Ergo.
