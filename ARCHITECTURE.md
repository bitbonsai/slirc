# Architecture

Slirc is a chat app on top of an IRC server. This file says how the pieces fit and where new code goes. It describes the code as it is. Setup and commands are in [CONTRIBUTING.md](./CONTRIBUTING.md) and the [README](./README.md).

## The pieces

A browser (or a native shell around one) talks HTTP and a WebSocket to the app. The app is a Bun process running the Hono web framework. It relays IRC lines to Ergo, the IRC server, and keeps its own metadata in SQLite.

- **Ergo** owns accounts, channels, membership, modes, messages and history. Threads are channels. Reactions are IRCv3 events that Ergo stores. The app never keeps a second copy of conversations.
- **SQLite** holds what IRC has no place for: sessions, invitations, pairing codes, profiles, push subscriptions, link metadata, reminders and similar. `app/src/db.ts` opens it and creates the tables. A SQLite row alone does not make a real room; Ergo must have it too.
- **The app** (`app/src`) serves the shell, the HTTP API and the `/irc` relay. It signs people in, checks who may do what, and talks to Ergo as an operator for server management.
- **The client** (`app/client`) is TypeScript bundled by Bun and driven by Alpine.js, a small browser UI library. It keeps account-scoped state in IndexedDB.
- **slirc-agent** (`app/agent`) is a separate npm package that connects a coding agent session to a workspace.
- **Native shells** (`native/`, `desktop/`) wrap the same web client.

Rules about identity, membership, drafts and media are in [AGENTS.md](./AGENTS.md#data-and-protocol-invariants). Read them before changing sync or access code.

## Server

`app/src/main.ts` starts the process. `app/src/server.ts` builds the Hono app. It stays small on purpose. It sets up middleware such as CORS for multi-instance clients, cache headers and the content security policy. It mounts one sub-app per area with `app.route(...)` and serves static files and the versioned shell.

- **`app/src/routes/*.ts`** has one Hono sub-app per area, such as `channels.ts`, `agents.ts`, `auth.ts`, `uploads.ts` and `invitations.ts`. A route file parses the request, calls domain modules and shapes the response.
- **`app/src/http/*.ts`** has helpers shared by several route files. `session.ts` resolves the session and current user and checks origins. `assets.ts` builds the client bundle and adds content hashes to asset URLs. `authz.ts`, `media.ts`, `mail.ts` and the others each cover one concern. Nothing here mounts a route.
- **Domain modules** sit directly in `app/src`. They hold the rules and do not know about HTTP. Examples are `rooms.ts`, `grants.ts`, `accounts.ts`, `links.ts`, `pairing.ts` and `irc.ts`. Route files import them; they do not import route files.
- **`app/src/config.ts`** reads environment variables for the settings it covers. Many other modules still read `process.env` directly, because some values are captured at import time. [docs/env-reference.md](./docs/env-reference.md) lists every variable.

The relay (`relay.ts`) owns the browser's IRC connection, including the IRC login (SASL) credentials, Origin and cookie checks and proxy hops. IRC passwords are derived from a key file and are never stored (`irc-key.ts`).

## Client

`app/client/main.ts` is the browser entry. It registers Alpine directives and components. `app/client/runtime.ts` creates the client and wires the pieces together. It holds no feature logic of its own.

- **`client/core/`** holds the parts every feature depends on: the runtime state object (`runtime-state.ts`), boot, the IRC connection lifecycle, outbox sync, routing, the session and account reset, and window events.
- **`client/features/`** holds one factory per feature, such as `unread.ts`, `drafts.ts`, `reactions.ts` and `slash-commands.ts`. A factory takes typed dependencies, usually a `Pick` of the runtime state and a `Pick` of the UI state, and returns the functions that feature needs. `runtime.ts` builds each factory and passes the results on.
- **`client/*.ts`** (the top level) holds the lower layers and the page-sized components. Lower layers include the protocol (`protocol.ts`, `sync.ts`, `outbox.ts`, `db.ts`, `store.ts`, `model.ts`). Components include `settings-page.ts`, `agents-page.ts` and `conversation-rows.ts`. Messages render through `message-view.ts`.
- **`app/partials/`** holds the markup, as small HTML files. `app/scripts/assemble-html.ts` replaces each `<!-- include: name -->` marker in `partials/index.html` with `partials/name.html` and writes `app/public/index.html`. The browser gets one document. Partials never load at runtime.
- **`app/shared/`** holds code both sides import, such as the IRC parser, multiline and reaction encoding, history helpers, the harness data, the matcher and `escapeHtml`.

Alpine's `Alpine.data("x", () => client.x)` hands every mount the same object, so each name is mounted once in the shell.

## Styles

`app/styles/*.css` are numbered by load order and cover one area each, from `01-boot.css` to `27-thread-panel.css`. `assemble-html.ts` joins them in filename order into `app/public/style.css`. The first file holds the boot block that paints before the stylesheet loads, and the build fails if that block is damaged. Visual rules are in [design.md](./design.md).

## Generated files

These are committed and rebuilt from sources. Edit the source and run the command.

- `app/public/index.html` and `app/public/style.css` come from `app/partials` and `app/styles` through `bun run assemble` in `app/`.
- `app/public/docs/` comes from `app/docs/*.md` through `bun run docs`. The in-app help bot answers from these docs.
- `app/agent/dist/` comes from `app/agent/src` through `bun run build` in `app/agent`.

## The agent package

`app/agent` publishes as `slirc-agent`. It imports from `app/shared/` and nothing else in `app/`. The reason is the app's container image, which carries `agent/package.json` only. A server import from `../agent` would crash on start. Each harness (Pi, Claude Code, Codex, OpenCode) is a module under `app/agent/src/harnesses/<id>/`. The server reads the data half from `app/shared/harnesses.ts`. To add one, see [app/agent/HARNESSES.md](./app/agent/HARNESSES.md).

## Ergo and deployment

`ergo/` builds the Ergo image and holds an example config. `deploy/` and `deploy/selfhost/` hold the Compose files and the self-host installer. `scripts/just/` has the dev and deploy recipes. [deploy/selfhost/README.md](./deploy/selfhost/README.md) covers the self-host layout, and [docs/agent-notes.md](./docs/agent-notes.md) covers operations.

## Native shells

`native/` is an iOS app built with Capacitor. `desktop/` is a Swift app around a web view for the Mac. Both bundle only a workspace picker. After a workspace is chosen they load its own web client from its address, so the PWA and the shells run the same code. Native features are added behind `__slircNative` with a web fallback. See [desktop/README.md](./desktop/README.md).

## Tests

Tests live in `app/test`, `app/agent/test`, `app/agent/src/harnesses` and `native/test`. Each file runs in its own process because files share SQLite and ports. `app/test/support/browser-shims.ts` lets tests run the real client runtime in Bun. `app/test/size-guards.test.ts` holds one table of line limits for `runtime.ts`, `server.ts`, the route files, `client/core`, `client/features` and the stylesheets, so the splits stay split.
## Where new code goes

- **A new route.** Add a Hono sub-app in `app/src/routes/<area>.ts` and mount it in `server.ts` with `app.route`. Put rules in a domain module in `app/src`. Put helpers that two route files need in `app/src/http/`. If an existing area covers it, add to that file.
- **A new feature slice in the client.** Add `app/client/features/<name>.ts` exporting a factory with typed dependencies, build it in `runtime.ts`, and add a test against the browser shims. Logic that every feature needs goes in `client/core/`. A whole page gets a component at the top level of `client/` and a partial.
- **Markup.** Add or edit a partial in `app/partials/`, include it from `index.html`, and run `bun run assemble`.
- **A stylesheet.** Add a numbered file to `app/styles/` for a new area, or extend the file for the area you are changing. Run `bun run assemble`.
- **Code both the app and the agent need.** Put it in `app/shared/`.
- **A guide page.** Add `app/docs/<name>.md`, add it to the navigation in `app/scripts/build-docs.ts`, then run `bun run docs`.
