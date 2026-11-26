# Deploy configuration

`deploy/app.compose.yaml` and `deploy/ergo.compose.yaml` are shared by every instance. Instance
values live in the env file at `${SLIRC_CONFIG_DIR}/env` (default `./config`); running multiple
instances on one host overrides `SLIRC_CONFIG_DIR`, the container/volume/network names and ports.

Compose `environment` beats `env_file`, so the deploy files set no mode or channel keys. Setting
`SLIRC_MODE`, `IRC_CHANNEL` or `OPEN_CHANNELS` there would override the instance env file for every
instance using the Compose project.

## Mode

`SLIRC_MODE` takes exactly one of two values:

- `private_workspace` (default when unset) – no open channels. A nonempty `OPEN_CHANNELS` is a
  startup error rather than a silent override.
- `public_playground` – open channels come from the explicit `OPEN_CHANNELS` list.

Unset is the safe default. An explicit value must match exactly; empty or misspelled values stop
the app on boot.

## Instance env

A private workspace:

```text
SLIRC_MODE=private_workspace
IRC_CHANNEL=#general
OPEN_CHANNELS=
```

A public instance:

```text
SLIRC_MODE=public_playground
IRC_CHANNEL=#untitled
OPEN_CHANNELS=#open-chat,#help
```

Open channel names are trimmed, lowercased and blanks dropped. Private membership, history and
channel visibility do not change with the mode.

## IRC key

The app stores no IRC passwords. Each is HMAC-SHA256 of an account's id and counter under a key
(`app/src/irc-key.ts`), so the database and its backups hold nothing that logs in to IRC. The key
is 32 random bytes kept outside the backed-up config folder (for example
`~/.config/slirc-keys/<instance>/irc-key`, mode 600). Compose mounts the file read-only at
`/run/slirc-irc-key` from `SLIRC_IRC_KEY_PATH`, which has no default: set it in your deploy
environment (`.env` for `just deploy` or per-instance env). Keep one copy of the key in a password
manager, never next to the database.

Losing or replacing a key breaks every password client and managed bot on that instance until they
paste a new password. Clearing `irc_password_gen` does not recover it; restore the key.

The stored passwords left the database in two releases. The first moved every row to a derived
password on boot; the second drops the old columns, and refuses to start while any row still holds
a stored password. An instance that skipped the first must run it and boot once before taking the
second.

## Proxy address and rate limits

Sign-in and join limits count per client address. The app believes a forwarded address only from a
peer listed in `SLIRC_TRUSTED_PROXIES` (exact addresses, comma-separated, in the instance env), and
then only the last `X-Forwarded-For` hop, the one the proxy appended. Unset, every visitor behind
the proxy shares one address and one bucket.

On a rootless podman host, the requests Caddy forwards to the published loopback port reach the
app from the app container's own address, and podman hands that out afresh on every recreate.
Pin it with `deploy/app.fixed-ip.compose.yaml` and trust the same address. `SLIRC_APP_IP` is read
by Compose, like `ERGO_IP`, so it goes in the deploy command's environment, not the env file:

```sh
SLIRC_APP_IP=10.89.0.14 SLIRC_CONFIG_DIR=... podman-compose --in-pod=false -p <project> \
  -f deploy/app.compose.yaml -f deploy/app.fixed-ip.compose.yaml up -d --build
```

```text
SLIRC_TRUSTED_PROXIES=10.89.0.14
```

Pick a free address in the app network's subnet, never `ERGO_IP`. `just deploy` pins the app at
`SLIRC_APP_IP` (default `10.89.0.14`) on `SLIRC_NETWORK` (default `slirc`). This trusts anything
that reaches the app through its published loopback port: any process on the host can then set
`X-Forwarded-For` and choose its own rate-limit address. Containers that connect to the app on its
network arrive from their own addresses and stay untrusted. Behind Cloudflare, the hop Caddy
appends is a Cloudflare address unless Caddy is set to trust Cloudflare and read its client header,
so buckets are per Cloudflare edge rather than per visitor.

## Upgrade note for public instances

Any public instance upgrading from an older Compose setup needs `SLIRC_MODE=public_playground` in
its operator env outside the checkout alongside `OPEN_CHANNELS` and `IRC_CHANNEL`. Previously the
shared Compose file supplied those channels; now it does not, and an env with `OPEN_CHANNELS` but
no mode fails on boot. Private instances keep `SLIRC_MODE=private_workspace` with an empty
`OPEN_CHANNELS`.

## Ergo

`deploy/ergo.compose.yaml` injects no admission policy. `accounts.require-sasl` belongs in the
mounted `ergo.yaml`, which stays authoritative for the instance. The example YAML admits guests
and exempts `10.0.0.0/8`; restricting admission is separate work.
Every instance's `ergo.yaml` must set `channels.operator-only-creation: true`: only the app's oper
creates channels, so nobody on IRC can sit in a `#dm-` or thread channel before it exists. The file is
a single-file bind mount, so edit it in place (not `sed -i`, which swaps the inode the container still
reads) and send Ergo `SIGHUP` to reload it.
