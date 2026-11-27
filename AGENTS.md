# Slirc

Self-hosted chat backed by Ergo IRC. Bun + Hono bridge the browser to IRC; SQLite stores app metadata; the Alpine client uses account-scoped IndexedDB.

Small things, made well. Favor the smallest change that makes correct behavior unsurprising. Reuse existing code and browser features before adding machinery. Keep conversations readable in ordinary IRC clients.

## Start here

- **Current client:** `app/public/index.html`, TypeScript in `app/client/`, served as `/client.js`. Trace the entrypoint and shell selection in `app/src/server.ts` before editing. Shared styles live in `app/styles/*.css`, assembled into the served `app/public/style.css` by `bun run assemble`; edit the parts, never the generated file.
- **One client:** current client is the default in every environment; no `SLIRC_CLIENT` flags. Legacy shell, bundle and boot document are removed. `/sw.js` retires old shell caches without touching IndexedDB, drafts or sessions. Keep shared utilities still imported by current code.
- **Local testing:** `just dev` serves the app on loopback port `9110` (or an HTTPS URL configured via `SLIRC_DEV_ORIGIN`). Canonical routes include `/profile`, `/dm/:nick`, `/dms`, and `/more`.
- **Visual rules:** `design.md`.
- **Troubleshooting:** read only the relevant section of [docs/agent-notes.md](docs/agent-notes.md), not the whole file for every task.

## Safety boundaries

1. No deployment, production mutation, history reset, account reset, or browser-storage wipe without explicit authorization. A local reset does not authorize a production reset. Preserve unrelated edits, drafts, credentials and sessions.
2. Never run bare `podman compose up` against a production host. Authorized app deployments use `just deploy`, which preserves Ergo uptime. Ergo restarts require explicit authorization; use the dedicated deployment recipe, not an incidental app operation.
3. Never commit secrets. Production env and config live outside the checkout at `~/.config/slirc/env` and `~/.config/slirc/ergo.yaml`, mode 0600. Never print credentials or magic links in reports.
4. Never `pkill -f`, or kill a PID selected by name/path. Use only a PID captured at spawn, or a port owner from `ss -H -ltnp` after confirming its cwd. Do not stop another agent's runtime.
5. Inspect host, container mounts, profile and data paths before ops. Local and production can use identical container names. Do not delete volumes or run direct SQLite history surgery against a writing Ergo.
6. Caddy is unmanaged. Do not take over its config. `sudo caddy validate` can create root-owned log files; correct ownership before an authorized reload.
7. Use **Worktrunk (`wt`)**, never raw `git worktree` commands. A worker tab does not require a worktree. Preserve dirty trees and unmerged branch tips during cleanup.

## Gotchas

- `just deploy` fails on macOS: `test-deploy-app.py` canonical-path check trips on `/tmp`→`/private/tmp`. Deploy from Linux. Deploy runs the full test suite then `git push`: a stale test expectation blocks it.
- Dev `/auth/request` is limited to 10 requests per hour per peer. Dev also returns the magic link in the JSON body: never paste that output.
- Ergo always-on default: rehash refuses, and `deploy-ergo` (`up -d`) does not restart an unchanged container. Changing the default requires an explicit Ergo container restart.
- Headless browsers never report `pointer: coarse`; phone sheet/touch UI needs a real device.
- One `bun test` over all of `app/test` gives hundreds of false failures (shared modules, ports, env). Run one file per process: root `bun run test` or a `for f in test/*.test.ts` loop. The two live agent proofs and the Codex runtime test skip unless `SLIRC_AGENT_PROOFS=true` (`bun run test:agent-proofs`). `bun run test` stops at first failing file: check `grep -c '^Ran '` equals file count. New worktree, or main after merging a branch that added deps: `bun install` in `app/` and `app/agent/` first ("Cannot find package 'zod'").
- Scripts importing `app/src` open `/data/chat.sqlite` by default, which fails outside the container. Set `DB_PATH=/tmp/x.sqlite`. `helper-bot.ts` also needs `ERGO_OPER_USER` set (any value) to import.
- The app container reads `~/.config/slirc/env` only at creation time: a new key needs container recreation (`just deploy`). Without a model API key in dev, helpers fall back to usage and keyword answers.
- Ergo advertises `extended-monitor`, not `draft/extended-monitor`; asking the draft name rejects the whole CAP REQ. MONITOR sends no initial AWAY and `WHO a,b` returns nothing: use USERHOST (10 nicks max).
- Help bot answers only from `app/docs`: stale docs give wrong answers, fix the docs. Any docs edit changes docsVersion and drops every cached help answer.
- Visual rules live in root `design.md` and `app/docs/design.md`: token/rule changes update both. Generated `app/public/docs` conflicts on merges: rerun `cd app && bun run docs`, never hand-merge.
- `Alpine.data("x", () => client.x)` returns one shared object: second `x-data="x"` mount throws "Cannot redefine property: $nextTick", shell never loads. `client-alpine-singletons.test.ts` guards.
- `landing/demo.js` is cached 4h by browsers: bump `?v=` in `landing/index.html` whenever it changes.
- Cloudflare gives `.js`/`.css` a 4h browser cache whatever the app sends. The shell's scripts, stylesheet, manifest and SVG refs get `?v=<content hash>` at serve time (`versionShell` in `server.ts`); a new first-party file loaded by the client by address (like the icon sprite) needs its version passed the same way, or returning members run new HTML with the old file.
- `prepack` in `app/agent` rebuilds `dist/` on publish: pull first and reset or commit `app/agent/dist` cleanly. `npm view` lags 1-2 minutes after publish.
- Harnesses live in `app/agent/src/harnesses/<id>/` behind one interface; `app/shared/harnesses.ts` holds the data half (names, released, session commands) that the server, Agents page and docs read; `agent/src/harnesses/index.ts` lists the modules the CLI runs. Adding one: `app/agent/HARNESSES.md`.
- `app/agent/dist` is tracked: after any `app/agent/src` change run `bun run build` there and commit dist.
- `pkill -f <pattern>` over SSH can kill the SSH command itself (exit 255). Use a captured spawn PID or verified port owner, never a name-selected PID.
- Rootless podman: Caddy's requests reach the app from the app container's own address. `SLIRC_TRUSTED_PROXIES` needs that address pinned (see `deploy/README.md`).
- `app/.dockerignore` drops `agent/` except `agent/package.json` (the server reads the published version from it). Anything the server shares with the agent lives in `app/shared/`; a new server import from `../agent` crash-loops prod "Cannot find module" (16 Nov 2026). `scripts/deploy-app.py` `bun build`s main.ts inside the image before downtime.
- Mac app loads Sparkle via `@rpath`: needs `LD_RUNPATH_SEARCH_PATHS = @executable_path/../Frameworks`. Xcode Debug runs hide its absence; Release quits with "Library missing".
- WebKit (Safari, Mac app) skips `:focus-visible` on script focus after a mouse click, and Tab reaches only text fields. Arrow-key rows carry `.kb-focus`; `client/dialog-keys.ts` handles Tab/arrows in dialogs.
- Pi writes a new session file only after first message: anything resolving it at `/slirc` time must not require it to exist.
- Ergo fakelag: 5-line burst then 2/s, JOIN has no budget. One JOIN line per room held history 8 s behind on reconnect. Send comma-list JOINs.
- npm refuses package name `slirc` (too close to `sirv`); CLI stays `slirc-agent`. npx serves a cached old version: docs and page use `npx slirc-agent ...`, the CLI checks its version against the server.
- IRC passwords are never stored: HMAC of `account_id` and `irc_password_gen` under the key at `SLIRC_IRC_KEY_PATH` (`app/src/irc-key.ts`). Rotating means bumping the counter (`rotateIrcPassword`). A new or lost key breaks every password client and managed bot on that instance; keys live in `~/.config/slirc-keys/<slug>/`, outside the backed-up config.
- `display:flex` on a text line drops spaces between text and inline elements (`Code <code>` rendered `Code1234`). Use block text.

## Local commands

Install tooling with `bun install` at root; app dependencies with `cd app && bun install`.

Slirc 2 is the only local dev stack; no profile selection:

```sh
just dev-status
just dev-logs app
just dev          # start/recreate only when needed
just dev-seed     # writes labelled local fixtures
```

- Local dev uses `slirc2-app`, `slirc2-ergo`, network `slirc2`, app port 9110, and generated config under `.data/dev-slirc2/config/`. The HTTPS test URL fronts this stack. Existing named volumes are reused; production remains separate.
- Recipes in `scripts/just/dev.just` are authoritative. The app gets an internal local-only marker for auth and fixture guards; callers do not set `SLIRC_DEV_PROFILE`. Full `just dev` can recreate Ergo when config changes; use app-only recreation when Ergo uptime must be preserved.
- Seed is idempotent: Ada/Ben/Eve, private `#dev-test`, public `#dev-open`, and owner-visible DMs. Use disposable fixtures, not shared real conversations. Never send mocked Giphy/provider URLs into IRC history.
- Public files reload directly; the client bundle rebuilds per request in dev and caches per process in production. Do not restart services merely to refresh HTML.
- Do not clear IndexedDB to make a regression pass. Server history and each browser's cache are separate; deleting an agent browser's cache does not clear the user's browser.

## Work one small task at a time

The daily agent implements small tasks directly. Delegation is optional, not a requirement to spawn another agent using the same model.

1. Identify the active path, smallest fix and observable acceptance case. Do not improvise a different requirement.
2. Keep one writer per file. Finish the agreed task; put later requests in the queue instead of repeatedly restarting the batch.
3. Run focused checks, report what passed and what remains unverified, then let the user test. Commit only when authorized. Do not hold completed work for the entire backlog.
4. If the same case fails after one targeted correction, stop guessing. Report the reproduction, attempted fix, evidence and exact blocker. Ask for stronger help when needed.

## Feature architecture

- Use named `Alpine.data` components for cohesive features. Components own local UI state, refs and lifecycle; remove listeners/observers on teardown. Reuse an existing component for a small change, not one new component per control.
- Messaging, identity, authorization, persistence and outbox remain in shared core modules behind narrow interfaces. Do not copy their state into UI components or keep adding unrelated feature state to one central controller.
- Keep markup declarative (`x-for`, `x-show`, `x-text`). Do not generate feature HTML strings; trusted icon markup is an exception.
- Source: feature-sized HTML partials in `app/partials/` assembled **at build time** into `app/public/index.html` (`bun run assemble`; `bun run version` chains it), with Bun-bundled TypeScript. Edit partials, never the generated `index.html`. Do not fetch partials from the browser or migrate frameworks.
- Splitting files improves maintainability, not automatically performance. Use `x-if` for expensive closed panels, `x-show` for cheap frequent toggles. Add lazy loading or virtualization only for measured need.
- Browser first. Native-shell work shares the PWA markup and logic; native capabilities are additive behind `__slircNative` with web fallbacks.

## Acceptance and checks

- Cross-worktree Bun caches can retain old absolute import paths. Use `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` when tests resolve modules into an old checkout; each checkout needs app and agent dependencies installed.
- Non-trivial logic gets a focused behavior test. **One Bun test file per process:** `cd app && bun test test/<file>.test.ts`. Running all app tests in one process shares SQLite/module state and creates false failures. No repo-wide checks unless asked.
- When browser testing is authorized, verify actual visible controls after boot, not just state or template strings. Check the requested interaction and relevant keyboard, cancel/error, permission and persistence cases. Use a named local browser session; do not share an active session with another worker.
- Headless width emulation is not a real phone check. Report device checks honestly. Do not claim a performance win without before/after measurements.
- Review the scoped diff for accidental complexity and unrelated edits. Test failure is not acceptance; neither is an unverified worker claim.
- After cached asset changes, run `bun run version` **in `app/`** and retain generated changes. Never hand-edit asset hashes. The client bundle has its own `/api/version` hash.
- When described behavior changes, update `app/docs/*.md`, run `cd app && bun run docs`, and include generated `app/public/docs/` output. Caddy's docs copy updates from the checkout; the app's image copy updates only through `just deploy`. New guide pages also need build navigation and docs-test entries.
- Edit first; in a subsequent command verify the diff, then stage/commit. Do not combine file writes with staging/shipping. Never stage secrets or runtime data.

## Data and protocol invariants

- Ergo owns identity, membership, modes and conversation history. SQLite metadata alone does not create a real room. Use existing oper/grant helpers; never authenticate server management as a human account.
- Private membership has two halves: SQLite `channel_members` and Ergo `+si`/`+I`. Thread access requires parent access **and** child readability; public parent does not imply public child. Bots are admin-managed; personal agents remain owner-scoped.
- Provision/register threads before opening them. Keep membership/self-op checks. Never delete a `thread-provision:<parent>:<root>` reservation to force a retry. Use `deleteChannelTree()` for room/DM teardown so child threads are removed first.
- Client account scope uses immutable account ID. Any tab can enqueue, but only the Web Lock owner sends after authorized conversation recovery. Preserve uncertain-send handling and newer draft revisions; proxies/object identity cannot prove draft ownership.
- Composer DOM is a view; drafts and IRC keep Markdown. Paste HTML as text, and escape code before Glow renders it.
- Empty/incomplete history is not deletion evidence. Ergo does not replay REDACT in history. Confirmed deletion clears content/media references and retains only non-content tombstones needed to stop resurrection. Do not equate locally hiding a row with server deletion.
- Reactions are IRCv3 events persisted by Ergo, not a new SQLite reaction API. Preserve multiline batches and `+slirc/cid` correlation; see protocol notes before changing sync.
- `/irc` relay owns SASL credentials, cookie/Origin checks and trusted proxy-hop handling. `ircPassword` must not return from `/auth/me` or reach browser state. Keep plaintext IRC inside the container network.
- Upload/private-media reads enforce current membership, including thread parents, and private no-store caching. Preserve input/decode limits and immutable account checks. Never weaken embed SSRF checks or redirect validation to fix a broken image.
- Verified members can discover/message admins without shared rooms; human admins can discover/message all verified humans. This grants no private-room access; personal agents remain owner-scoped.
- Public help hides participant presence. Helpers are labelled bots; never restore scripted fake humans. Test fixtures are local-only and visibly labelled.
- Badge autosave sends only `badge` and immutable `accountId` to `PATCH /profile`; omitted fields stay unchanged. Never save unrelated profile drafts on badge selection. Offline/unknown IRC presence overrides chosen badges.

## Interaction defaults

- Match `design.md`: compact typography, lime accent, monospace messages and platform UI controls. Use the `style.css` tokens (`--text-*`, `--radius-*`, `--space-*`, `--dur-*`, `--shadow-*`, `--glass-*`) instead of literal values, and give every new colour a light value. Copy is brief and human, not protocol jargon.
- Use Slack vocabulary in user-facing prose: channels, DMs and threads; call rooms channels. Preserve technical room terms and identifiers in code. Bold `Slirc` in rendered email or marketing prose, not subjects, commands, identifiers or URLs.
- Use the `--dur-*` steps (.1–.3s) for transitions; respect reduced motion. No continuously repainting animation.
- Use app-styled native `<dialog>`, not browser alert/confirm/prompt. Tab/Shift+Tab stays inside visible enabled controls. If one usable input exists, focus it after show; otherwise use a safe initial control. Escape cancels; closing restores the invoker. Do not steal focus during rerenders or force phone keyboard on room selection.
- Use custom blurred tooltips for hover and keyboard focus, not native `title`. A low-alpha panel tint is needed for readable Chromium blur; transparent blur alone can fail.
- Keep message-segment markup free of inserted whitespace: `pre-wrap` exposes source newlines. Lucide icons need real sprite symbols; missing names render empty.

## Operations and documentation

Only deploy when asked. `just deploy` recreates the app, checks health and verifies Ergo's start time did not change; verify `/api/version` afterward. Persistent Ergo history uses `expire-time: 0s` (no automatic expiry). `deploy-ergo` is separate and preserves app uptime. Every deploy needs a clean committed tree. Before infrastructure work, read [operations notes](docs/agent-notes.md#operations).

Keep this file short: current entrypoints, safety, contracts and workflow. Put detailed traps in [agent notes](docs/agent-notes.md) and shipped design in `design.md`. Rewrite current facts instead of appending session logs. If an instruction conflicts with the task, explain the conflict and get sign-off before breaking it.
