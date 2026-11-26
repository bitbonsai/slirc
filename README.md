<p align="center">
  <img src="./app/public/logo.png" alt="Slirc" width="112" height="112">
</p>

<h1 align="center">Slirc</h1>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?style=flat-square&logo=bun&logoColor=11111b" alt="Bun">
  <img src="https://img.shields.io/badge/protocol-IRC-94e2d5?style=flat-square" alt="IRC">
  <img src="https://img.shields.io/badge/server-Ergo-a6e3a1?style=flat-square" alt="Ergo IRC">
  <img src="https://img.shields.io/badge/PWA-installable-89b4fa?style=flat-square&logo=pwa&logoColor=11111b" alt="Installable PWA">
  <img src="https://img.shields.io/badge/hosting-self--hosted-fab387?style=flat-square" alt="Self-hosted">
</p>

Self-hosted Slack alternative built on IRC. Slirc brings channels, threads, reactions, media, notifications, and a polished PWA to Ergo without hiding the open protocol underneath.

Connect Claude Code, Codex, Pi, or OpenCode with one paste and talk to it from your phone.

See it move at [slirc.org](https://slirc.org): the same room on a phone, on a desktop, and in Halloy.

## What makes Slirc different

### Familiar chat

Slirc keeps the useful parts of modern team chat: workspace and secret channels, direct messages, private DM threads, reactions, uploads, previews, profiles, persistent drafts, and push notifications.

### IRC underneath

Ergo owns accounts, rooms, permissions, messages, and history. Threads are channels; DM threads are private rooms shared with both people. Uploads are URLs. Conversations remain readable in ordinary IRC clients such as Senpai.

### Your server and data

The complete stack runs on hardware you control. There is no hosted workspace lock-in, artificial history window, or required desktop client.

### Built for phones

The PWA installs from the browser and treats mobile performance as the standard. Clear unread state, reachable controls, and 44px touch targets matter more than desktop ornament.

### Lean stack

A few understandable tools cover the job. Features earn their place through regular use and must still make sense over IRC.

## Stack

- **Bun, TypeScript, and Hono:** app runtime and HTTP API
- **Ergo IRC:** accounts, channels, messages, and history
- **SQLite:** app metadata
- **Alpine.js:** vendored UI behavior
- **slirc-agent:** CLI (Node or Bun) with harnesses for Pi, Claude Code, Codex, and OpenCode that connects a coding session to Slirc: `npx slirc-agent@latest <workspace>`, then `/slirc` in the session. Harnesses are modules; see `app/agent/HARNESSES.md`
- **Just + rootless Podman:** local stack and self-hosted deployment

## Development

### Prerequisites

Install [Bun](https://bun.sh/docs/installation), Just, Podman, `podman-compose`, and [Tailscale](https://tailscale.com/download). The dev recipes call Podman and `podman-compose` directly; Docker alone is not enough. Bash, curl, and Python 3 must also be available.

On Arch Linux:

```bash
sudo pacman -S just podman podman-compose tailscale python curl
sudo systemctl enable --now tailscaled
sudo tailscale up
```

On macOS, install Bun and Tailscale separately, then:

```bash
brew install just podman podman-compose
podman machine init
```

Initialize the Podman machine only once; `just dev` starts it when needed. On Linux, configure rootless Podman for your user. Check `podman info`, `podman-compose --version`, and `tailscale status` before starting; Tailscale must be connected.

### Start the stack

Set the seed admin email in the checkout's gitignored `.env` before starting:

```dotenv
SLIRC_DEV_ADMIN_EMAIL=you@your-domain.com
```

This binds the local `admin` account to your email, including when generated config already exists. There is no default admin email. It does not merge existing accounts: if your email already belongs to another local account, resolve that conflict before restarting. Other fixture users keep test addresses. The dev stack has no first-user signup, so this email is how you sign in.

```bash
bun install
cd app && bun install && cd ..
just dev
bun run test
```

`just dev` starts the local `slirc2` stack without profile selection. It reuses the existing named data volumes, generates local config under `.data/dev-slirc2/config/`, bind-mounts this checkout's app, and runs Bun watch mode. The app serves plain HTTP on loopback and Tailscale port `9110`; the landing page uses Tailscale port `9109`. Use HTTPS for browser testing from another device: remote plain HTTP lacks secure-context APIs such as Web Locks.

### Browser on another device

Connect both devices to the same Tailscale network. On the dev host, check existing proxies, then add an HTTPS listener for Slirc:

```bash
tailscale serve status
tailscale serve --bg --https=8443 http://127.0.0.1:9110
```

This uses port `8443` without replacing an existing service on `443`. Choose an unused port if `8443` already serves something else. Tailscale Serve may ask you to enable HTTPS certificates; follow its prompt. Serve stays private to your Tailscale network; no Funnel is needed.

Set this in the checkout's gitignored `.env` on the dev host before starting, using the hostname shown by `tailscale serve status`:

```dotenv
SLIRC_DEV_ORIGIN=https://<your-host>.ts.net:8443
```

Run `just dev` on the dev host, then open `https://<your-host>.ts.net:8443` on your other device. The origin must match the browser URL, including its port, or the IRC WebSocket connection is rejected. `https://<your-host>.ts.net:9110` does not work: port `9110` speaks HTTP, not TLS.

Without an HTTPS proxy, use an SSH tunnel instead. Start the stack with `SLIRC_DEV_ORIGIN=http://localhost:9110 just dev`, then run this on the other machine and leave it open:

```bash
ssh -N -L 9110:127.0.0.1:9110 <dev-host>
```

Open `http://localhost:9110` in the browser. Browsers treat localhost as a secure context.

UI edits reload directly. Use `just dev-status` and `just dev-logs app` to inspect the stack, `just dev-restart` to restart only the app, and `just dev-down` to stop the local stack. Full `just dev` may recreate Ergo if its configuration changes. Production config under `~/.config/slirc/` is separate and is not used by local dev. `bun run test` runs one process per test file; a single `bun test app` shares the in-memory database across files and fails.

## Running your own

Install Slirc on a Linux server (`x86_64` or `arm64`) with one command:

```bash
curl -fsSL https://install.slirc.org | sudo bash
```

This installs Docker if needed, configures Caddy for automatic HTTPS, generates every secret and Ergo config, pulls the multi-arch container images, enables nightly automatic updates with rollback, and installs the `slirc` CLI (`status`, `logs`, `restart`, `update`, `auto-update`, `backup`, `env`, `login-link`, `uninstall`). See [docs.slirc.org/setup](https://docs.slirc.org/docs/setup) for the full walkthrough and [`deploy/selfhost/README.md`](./deploy/selfhost/README.md) for architecture, backup/restore, and non-interactive flags. Manual rootless Podman setups using `deploy/` and `just bootstrap` remain documented under Advanced setup.

A `welcome` helper sits in `#open-chat` and posts a G'day gif there once a day when `GIPHY_API_KEY` is set. `SLIRC_HELPERS` picks which helpers run, for example `SLIRC_HELPERS=help,remind`; unset runs all four. `SLIRC_HELPERS_ENABLED=false` turns them all off.

## License

[Elastic License 2.0](./LICENSE). Use it, change it, and host it for your own group. The license reserves offering Slirc to others as a hosted service.

The `slirc-agent` package in `app/agent/` is MIT licensed under [its own LICENSE](./app/agent/LICENSE).

## Docs

- [Design](./design.md): shipped visual language, interaction, motion, and accessibility
- [About Slirc](https://docs.slirc.org/docs/about): where the idea came from
- [Public docs](https://docs.slirc.org/): product guides generated from `app/docs/*.md`

Anyone can read `#open-chat` and `#help`. Posting requires an account. Secret rooms require an invitation.
