# Slirc troubleshooting notes

Read only the section needed for the task. Root [AGENTS.md](../AGENTS.md) owns current workflow and safety boundaries. These notes include legacy-client and default-stack details; confirm the active client, host and profile before using a command. Nothing here authorizes deployment, a reset or a restart.

## Operations

### Profiles and boot failures

- `scripts/just/dev.just` uses one local stack: `slirc2-app`, `slirc2-ergo`, `172.30.16.0/24`, and config under the checkout's `.data/dev-slirc2/config/`. No caller-side profile flag. Existing data volumes keep their names; legacy local containers are not removed. Inspect bind mounts; editing repository `ergo/ergo.yaml` may not edit the mounted file. Changing checkouts requires an app mount switch; preserve Ergo's existing config bind and start time when doing app-only work.
- Config needs `OWNER_NICK` as a key in `USERS_JSON`. Otherwise startup fails with "owner credentials are missing". IRC passwords derive from the key file at `SLIRC_IRC_KEY_PATH` (`app/src/irc-key.ts`); local dev makes its own in `.data/dev-slirc2/config/irc-key`. Never copy it into production.
- A missing file bind mount can become a directory. For `read ircd.yaml: is a directory`, inspect both host config path and volume path before restoring a known-good file. Do not delete whole volumes. Conflicting old Docker containers and stale network leases have also blocked startup; diagnose exact port/container ownership before cleanup.
- An HTTPS dev URL needs `SLIRC_DEV_ORIGIN=https://<your-host>.ts.net:8443` in this checkout's gitignored `.env` (Just loads it). The backend stays HTTP on 9110; an HTTP `APP_ORIGIN` behind the HTTPS proxy makes `/irc` reject the browser's Origin even when `/healthz` passes. Keep the Origin check; correct the config and recreate only the app.
- Rootless `podman restart` can lose the app's port forwarder while `podman port` still reports it. Check actual listener and health; an authorized `just dev` with the correct profile can recreate the app. Do not restart Ergo to fix an app port.
- macOS bind mounts may not trigger Bun's watcher. Restart only the selected local app when required, not a different Compose stack. Public files and the dev client bundle do not need an app restart.
- Ergo environment map overrides replace whole maps: overriding only an oper password can drop its class. Use the configured local file instead.
- Every relayed browser shares the app container's source IP. Preserve appropriate connection limits and local-subnet exemptions; otherwise bursts of app, oper and helper connections look like a reconnect bug.

### Production

- Production config lives outside the checkout at `~/.config/slirc/env` and `~/.config/slirc/ergo.yaml`, both mode 0600. Back up config outside the checkout before authorized edits. YAML has similar headers: insert oper definitions under the actual `oper-classes:` and `opers:` mappings.
- Keep `accounts.authentication-enabled: true`. Direct TLS on 6697 terminates in Ergo for SASL EXTERNAL client certificates; its WebSocket listener does not request client certificates.
- Current documented limits are `max-connections: 512`, `max-connections-per-duration: 512`, `max-concurrent-connections: 512`, `max-connections-per-window: 256`, plus `10.0.0.0/8` exemption. Verify mounted config before changing it. Rehash with the Ergo API does not restart Ergo; changing always-on defaults does require a planned restart.
- `ERGO_WEBIRC_PASS` is optional plaintext relay configuration matching a hash in Ergo's `webirc` block. Never commit either private credential. Relay trust uses the last trusted forwarded hop, not arbitrary browser input.
- Service accounts must opt out of always-on. Reattaching an always-on oper account can leave OPER unanswered and cause startup loops. Preserve `NS SET ALWAYS-ON false` for the oper and helpers.
- App and Ergo Compose projects are separate (`deploy/app.compose.yaml`, `deploy/ergo.compose.yaml`, `--in-pod=false`), with Ergo on a fixed IP on the Podman network and named data/API volumes. Never apply bare Compose to a production host.
- Persistent history retention is `history.restrictions.expire-time: 0s` (no automatic expiry). The old example used `1w`; deployed configurations must be changed separately and rehashed. Preserve the bind-mounted config inode when editing. SQLite backups must use the backup API rather than copying a writing database without its WAL.
- `just deploy` uses force recreation; rebuilding without recreation has previously left a stale app passing health. Allow roughly 60 seconds for health, check `/api/version`, and compare Ergo start time. The app swap can briefly return a Caddy 502.
- DM readiness upgrades run inside `just deploy` after a clean committed tree and the existing checks. `scripts/deploy-app.py` receives explicit production targets from that recipe and verifies origin, database mount, network, Ergo address/config mount and Compose labels. It builds the commit-tagged image and checks that the migration script is inside `/app/src/` before stopping the app. It uses the external env file; never copy credentials into the checkout or command arguments. Keep this maintenance window exclusive: do not manually start another app writer.
- The DM upgrade disables the old app's restart policy, stops its captured container ID, and checks for other running containers with write access to the app volume. Ergo stays running. The migration holds a SQLite write transaction while read-only channel probes verify every NULL legacy mapping (registration, founder, +si, and both +I entries). Before commit, the host rechecks stopped writers and Ergo uptime through a temporary checkpoint mount. Only readiness flags change; existing pair/channel IDs, memberships and history stay intact. Explicit reservations (`0`) stay reserved. Any unresolved mapping aborts the transaction and rollout; the retained old app and its previous restart policy resume. Do not convert failed rows to `0`, delete them, or repair permissions automatically; report the named channel for an explicit disposition.
- Allow up to 8 seconds per legacy mapping, plus at most 30 seconds for the host checkpoint, app shutdown (up to 30 seconds), and the existing roughly 60-second health window. Image building happens before the pause. No legacy rows means no IRC probes. Both the image entrypoint and server refuse startup while NULL mappings remain; `/auth/me` performs no legacy migration or IRC proof.
- On ordinary proof failure the script removes its migration container and resumes the same old app automatically. After an interrupted SSH session or host failure, inspect the printed old-container ID, restart policy, image, mounts and any migration container before recovery. Stop/remove only that migration container if it is still running, then restore the recorded policy with `podman update --restart=<recorded-policy> <old-id>` and resume with `podman start <old-id>`. Never run two app writers during verification. A failure after Compose replacement or during health checks requires an operator rollback using the printed previous image and the same app-only Compose file/env/mounts; do not restart Ergo or revert SQLite data. Verify `/healthz`, `/api/version`, and Ergo start time after recovery. A later `just deploy` rechecks all remaining NULL rows, including any created by the resumed old app.
- `just deploy-ergo` is a separately authorized restart and checks app uptime. `deploy-landing` and `deploy-docs` update the checkout served by Caddy, not the app process. All recipes require a clean committed tree.
- Production oper setup must precede features that use it. Use configured `ERGO_OPER_USER`/`ERGO_OPER_PASS`, the least required oper capabilities, and verify OPER. HistServ deletion of other users' items additionally needs `history`; never substitute human IRC credentials.
- Keep the production Ergo image on the pinned multi-architecture digest. The isolated profile can use a different local image; do not confuse that with a production pin change.
- `npm publish` for `app/agent` rebuilds tracked `dist/slirc-agent.js`; account for that output before deployment. Never sync env by printing secrets in an agent transcript.

## IRC, rooms and delivery

- `createChannel` must confirm ChanServ REGISTER. First joiner can acquire op before an API call, leaving a channel public if registration is merely assumed. Oper INVITE still requires membership; TOPIC/MODE respect channel privileges.
- Thread creation waits for channel-scoped NAMES proving self op, then registration/private grants, a second NAMES and ownership transfer. The second NAMES can take several seconds because of Ergo fakelag. Do not restore a self-op fallback for an unknown channel.
- Repeated JOIN under Ergo multiclient may be silent. A 353 containing the configured self nick proves membership; 366 alone does not. Owner sync must recover a follower's newly authorized DM/thread before sending.
- UI may label DMs with a display nick while IRC uses `#dm-*`. Keep the conversion at the boundary, using the current client's mapping helpers. Server thread metadata retains the wire parent. Never infer access from the channel name.
- Parent conversation deletion unregisters child `#t-*` channels first through `deleteChannelTree()`. Legacy unregistered children can legitimately return "That channel is not registered". Deleting a root message and deleting a whole parent conversation are different operations.
- A renamed IRC channel does not inherit history. Ergo has no channel rename that carries CHATHISTORY.
- `CHATHISTORY BETWEEN` excludes both endpoints; pad by 1 ms where needed. Unjoined targets can fail `INVALID_TARGET`. Empty/incomplete batches are not proof of deletion. REDACT is not replayed in history, so retain confirmed non-content tombstones.
- Multiline `+slirc/cid` belongs on the `BATCH +id draft/multiline` opener. Put `@batch=<id>` on every inner PRIVMSG; otherwise Ergo stores separate lines and combined outbox messages never confirm.
- Reactions use TAGMSG with reply identifiers and `+draft/react` / `+draft/unreact`. The client negotiates event playback so reactions return in history; it ignores unrelated historical JOIN/PART/MODE events. Do not introduce a second authoritative reactions table.
- `CAP LS 302` may span multiple lines. Request capabilities once after the final LS line, or SASL can fail with invalid base64.
- HistServ supports DELETE, not a general history reset command. `app/scripts/history-prune.ts prune '#room'` removes configured oper events; `clear '#room'` removes all scanned items and requires explicit reset authorization. QUIT IDs are shared across channel histories, so more than one pass can be needed. Verify result, not merely command exit. Avoid producing new JOIN/QUIT chatter while checking cleanup.
- `account_details.lastSeen == null` means connected or never connected. Use ISON for online presence.

## Identity, helpers and media

- Membership changes must update both SQLite and Ergo. Invite acceptance uses the same grant and conversation helpers as the PWA, not SQLite-only inserts. Verified members can create invite links; durable membership requires verification after provisional access.
- `#help` is public read-only for guests, but private-presence: Ergo `+M` blocks guest writing and `+u` hides membership events. Client must hide its member list/count too.
- `help` and `remind` are labelled instance bots, with owner NULL and real service accounts so they can write under `+M`. They join only assigned rooms and wait for JOIN confirmation before draining the outbox. `help` answers every message in its help room; elsewhere helpers require mention or DM. Reminders live in SQLite.
- Public ambience is the labelled `welcome` helper, not simulated humans. Daily Giphy posting stamps the day before sending to avoid duplicates after restart. Retired ambient-human accounts must stay retired; old environment flags are not permission to enable them.
- The founder welcome is client-driven. The server resolves the verified human admin by configured owner nick, stores a per-account opt-in, and queues one job per newly verified human through the normal auth path only; it never sends as the human and never scans existing members. The founder's own signed-in browser claims each job (atomic `pending -> claimed`), opens the real DM, and sends through the durable outbox. A confirmed echo acks the job; a refused send drops the local row and releases the claim; an uncertain send keeps the claim and is never auto-retried. Cross-device duplicate prevention is the server claim, not the browser Web Lock. Do not add a server-side human SASL send or RELAYMSG spoof to "fix" a slow drain.
- Help answers are grounded in `app/docs`, with a docs-only fallback. Every helper model goes through OpenRouter chat completions with `OPENROUTER_API_KEY`; ids are OpenRouter's `vendor/model`, and bare legacy ids (`mimo-v2.5`, `claude-haiku-5-5`) are mapped by `openRouterId`. Verify a new id against `GET https://openrouter.ai/api/v1/models` rather than assuming it exists.
- Resident agent listener answers only the owner's IRC account tag and replies in the room where mentioned. It joins authorized rooms from the agent API. DMs arrive through joined `#dm-*` channels, not arbitrary direct nick messages. There should be one resident inbox per machine; duplicate listeners can answer twice. Existing docs claiming automatic thread movement may describe intent rather than implementation.
- Device linking must distinguish code lookup from explicit approval. Bind approval to the exact returned request; invalidate stale async results after account/code changes. Denying a request can temporarily block that IP; don't restart services merely to bypass a denial.
- Profile resets on account switch but preserves same-account unsaved edits during reconnect. Ignore stale `/auth/me` responses after newer saves. Six-digit inputs need `InputEvent.data` handling so replacing a digit does not keep an old caret-end value.
- Uploads are SQLite blobs. Stills normalize through `Bun.Image` to WebP, max 1600px/4 MiB; original limits 12 MiB/50 MP. Preserve body/decode concurrency limits and timeout. Private media requires current conversation and thread-parent membership, including ranges, and private no-store responses. GIF uploads are rejected; Giphy is separate. Unsupported Linux HEIC/AVIF needs conversion or a clear error.
- Never turn off private-IP/loopback checks to fix embeds. Follow redirects with revalidation and guard the connection's actual DNS lookup. Bun's DNS API requires `{ all: true }` when expecting an array. Image-proxy error responses use no-store; a previously cached error may still need a changed URL or explicit reload. Capture real response status and decode the image before calling a fix done.
- Notification preference is per person, not device. Reconstruct multiline before notifying so one message produces one notification.
- Gravatar misses cache for seven days; email changes invalidate the cache, direct manual SQLite edits do not necessarily do so.

## Alpine and browser traps

- Alpine proxies make raw object identity unreliable. Use revisions/counters or keep handles outside reactive state. IndexedDB cannot clone Alpine proxies; serialize plain records before writes.
- Memoized getters must read reactive sources on cache hits too, or dependency tracking stops updates. Likewise `capsOk && ui.phase` can track nothing at boot; read reactive state before nonreactive guards.
- `x-effect` tracks everything called functions read. A search-refresh effect that reads selection index can reset arrow-key selection on every move. Track only query/scope dependencies.
- `:style="active ? style : ''"` can remove `x-show`'s `display:none`. Inactive popup style must preserve hiding. Check that only one popup is visible.
- `$refs` in `x-if` exist only after mount. Open first, then `$nextTick`. Focus while the boot shell is hidden is ignored; focus after reveal.
- Slow uploads can outlive reactive media objects. Capture account, destination and draft revisions; consume matching text/media atomically, preserving newer edits and cancellation.
- Message body source whitespace is real under `pre-wrap`; extra line breaks between segment siblings produce doubled spaces. Use a DOM Range when measuring glyph gaps; element bounds can omit trailing spaces.
- Chromium may compute backdrop-filter without visibly blurring a fully transparent surface. Add low-alpha tint. Message entrance animation fill can isolate blur inside the row; disable it while the row's popup is open.
- Lucide names can silently render empty. Check the SVG symbol and icon-name index, then run asset versioning rather than hand-edit hashes.
- Do not identify embed thread titles solely from URL text. Use resolved provider/title metadata. Giphy media should not also get a redundant generic OG card.
- Native `<dialog>` provides top-layer behavior; custom tooltips for controls inside it must be in that layer too. Check actual focus containment/restoration, not just event registration.
- Browser checks need rendered visible controls and completed boot, not cached rows alone. Fixed elements have null `offsetParent`; use computed visibility and geometry instead.
- Client root shell and `/client.js` set their own `Cache-Control: no-cache`; the dev-wide `no-store` middleware does not survive the route. Assert `no-cache` in route tests.
- Bun caches `tsconfig.json` resolution in the running process. Adding `@client/*` paths can leave dev `/client.js` returning 503 while a fresh CLI build passes. After checking the profile and mounts, restart only the local app container. Ordinary client/HTML edits still rebuild without a restart; never restart Ergo for this.
- Browser sessions and consumed magic links expire. Local dev `/auth/request` can provide a dev link; keep auth local and do not expose tokens. No agent-browser session can mutate a different user's browser IndexedDB without attachment.
- Synthetic reconnect checks must start held requests after pagehide/pageshow setup, since pagehide clears state. WebSocket wrappers must preserve static OPEN/CLOSED constants.

## Phone and legacy PWA

These details often concern the legacy JavaScript client. Verify applicability before porting behavior to the TypeScript client.

- Headless device width does not enable `(pointer: coarse)`. Dev `?phone=1` widens CSS queries and selects phone JS paths; `?phone=0` clears it. This is a layout aid, not a real touch/Safari test.
- Safari standalone with status-bar `black-translucent` can leave a bottom dead zone. Use `black`; Apple meta changes may require removing and re-adding the home-screen app.
- Keyboard sizing uses visualViewport and `--kb`. Do not restore `interactive-widget=resizes-content` without testing the bottom gap. Phone Profile scroll belongs to the screen body, not a nested dialog card.
- Snapshot crossfades have flashed white on real devices despite passing headless checks. Fade the actual pane, replace rows at opacity zero, then reveal after Alpine renders. Avoid replaying animations during browser history traversal; respect `hasUAVisualTransition` and reduced motion.
- Duplicate visible `view-transition-name` values abort transitions. Keep only one header displayed. Safari can fire popstate on load or return from another app; guests must not stack room history entries. Use one popstate handler and preserve hierarchical Back.
- Pull-to-refresh must be excluded inside dialogs. Nonpassive touchmove plus preventDefault keeps Safari overscroll from stealing it; overscroll-behavior alone may not be enough.
- Plain HTTP has no service worker in this app; waiting forever on `navigator.serviceWorker.ready` hangs. Use a timeout/fallback. Web Locks and randomUUID also need an appropriate secure context.
- Legacy SW caches the URL `/index.html`, even though the server now maps it to legacy HTML when that client is selected. Do not make filename cleanup serve the wrong shell to old boot handoffs.
- Asset version tooling covers both shells and dependencies. Safari can refill a new cache with stale HTTP-cached assets unless install fetch uses `cache: "reload"`; HTML and SW responses need appropriate revalidation. Never reload over pending work just to apply an update.
- Historical boot delays were dominated by Alpine walking hidden DOM and animation layer churn. Keep boot classes on the intended root, spinner outside Alpine traversal, and expensive closed panels unmounted. Measure before adding more loading machinery.

## Landing and guides

- `cc-*`, `cookie*` and `consent*` classes can trigger content blockers. Landing terminal demo uses `tty-*`.
- Sticky nav drifts on iOS when body uses overflow-x hidden; the narrow layout uses a fixed nav with reserved space.
- Cloudflare can cache 404s and impose long asset TTLs. After an authorized deploy adding/renaming assets, purge affected URLs rather than claiming a server change cleared the edge.
- Animation fill can defeat an opacity transition on the same element. Fade the parent when appropriate.
- `app/docs` is source; `app/public/docs` is built output. A new page requires PAGES/NAV in `app/scripts/build-docs.ts` and PATHS in `app/test/docs.test.ts`. Frontmatter lead is plain text; put Markdown links/code in the body.
- Keep channel-specific onboarding in the PWA, not repeated MOTD/history messages. MOTD is mounted into Ergo; changing mount configuration differs from editing mounted content and may require a separately authorized service operation.
