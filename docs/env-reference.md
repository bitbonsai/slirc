# Environment reference

Every environment variable the Slirc server and the `slirc-agent` package read. Set them in `app.env` from the installer (`slirc env`), or in `~/.config/slirc/env` for a manual setup. Docker and Podman read the file only when the container is created, so recreate the app container after an edit.

The Use column says who should set a variable.

- Self-host. Meant for anyone running an instance.
- Hosted only. Used by the slirc.app service. A self-hosted instance leaves it unset.
- Dev. Local development with `just dev`. Do not set it on a real instance.
- Test. Read by the test suite or test doubles.
- Script. Read by a one-off script under `app/scripts` or `app/src`.

Never put a real secret in a file under version control. Keep secrets in the env file with mode 0600.

## Required

| Variable | Default | Use | What it does |
|---|---|---|---|
| `OWNER_NICK` | none | Self-host | Nick of the owner account. The app refuses to start without it. `ADMIN_NICK` is the older name and still works. |
| `APP_ORIGIN` | none | Self-host | Public URL of the instance, for example `https://chat.example.org`. Sign-in links, invitations and cookies follow it. Links never follow the request Host header. A plain `http://` origin turns off the Secure cookie flag. |
| `APP_HOST` | none | Self-host | Host name used when `APP_ORIGIN` is unset or malformed. It is also the workspace name in the connect commands the Agents page shows. |
| `ERGO_OPER_USER` | none | Self-host | Ergo operator account the app uses to manage channels. The app refuses to start without it. |
| `ERGO_OPER_PASS` | none | Self-host | Password for that operator account. Anything that opens an operator session needs it. |
| `SLIRC_IRC_KEY_FILE` | `/run/slirc-irc-key` | Self-host | File holding the 32 random bytes that derive every IRC password. The app refuses to start when it is missing or shorter than 32 bytes. See `deploy/README.md`. |

## Instance

| Variable | Default | Use | What it does |
|---|---|---|---|
| `SLIRC_MODE` | `private_workspace` | Self-host | `private_workspace` or `public_playground`. Any other value stops the app at boot. A private workspace refuses a nonempty `OPEN_CHANNELS`. |
| `OPEN_CHANNELS` | empty | Self-host | Comma list of public channels. Only valid in `public_playground` mode. |
| `IRC_CHANNEL` | `#untitled` | Self-host | Default channel everyone lands in. It is never deleted. |
| `OPEN_CHAT_ROOM` | `#open-chat` | Self-host | Public channel signed-out visitors can peek at in `public_playground` mode. |
| `HELP_ROOM` | `#help` | Self-host | Channel where the help bot answers without being mentioned. |
| `PORT` | `8080` | Self-host | Port the HTTP server listens on. |
| `DB_PATH` | `/data/chat.sqlite` | Self-host | SQLite file. Profile photos are stored in an `avatars` folder beside it. |
| `TZ` | `UTC` | Self-host | Time zone for reminders when a member has not set one. An invalid zone falls back to UTC. |
| `SLIRC_AGENTS_ENABLED` | on | Self-host | `false` turns off coding agents. The connect routes refuse and the sign-in email stops mentioning agents. |
| `BOT_LIMIT` | `3` | Self-host | Bots one member can create. |
| `SLIRC_EMOJI_BUDGET_BYTES` | `104857600` | Self-host | Total storage for custom emoji, in bytes. A value that is not a positive whole number stops the app at boot. |
| `SLIRC_ROOM_AMBIENCE` | on | Self-host | `false` turns off the welcome helper's daily greeting in the public channel. |
| `SLIRC_BOT_ENABLED` | on | Self-host | `false` turns off the push notification bot. `PUSHBOT_ENABLED` is the older name and still works. |

## Ergo connection

| Variable | Default | Use | What it does |
|---|---|---|---|
| `ERGO_HOST` | `127.0.0.1` | Self-host | Host of the Ergo server. |
| `ERGO_PORT` | `6667` | Self-host | Plain IRC port the app connects to. Keep it inside the container network. |
| `ERGO_API_URL` | `http://10.89.0.2:8089` | Self-host | Ergo HTTP API. |
| `ERGO_API_TOKEN_FILE` | `/run/secrets/ergo-api-token` | Self-host | File holding the Ergo API token. |
| `ERGO_API_TOKEN` | empty | Self-host | Token used when the file cannot be read. |
| `ERGO_WEBIRC_PASS` | none | Self-host | WEBIRC password the `/irc` relay sends so Ergo sees the browser's address. |
| `OPER_PERSISTENT` | on | Test | `0` makes each operator action open and close its own connection. Tests and one-off scripts use it. |
| `ERGO_API_MOCK` | off | Test | `true` skips Ergo API calls and reports success. |

## Network and proxies

| Variable | Default | Use | What it does |
|---|---|---|---|
| `SLIRC_TRUSTED_PROXIES` | empty | Self-host | Exact peer addresses, comma separated, whose `X-Forwarded-For` header is believed. Unset, every visitor behind a proxy shares one rate-limit bucket. See `deploy/README.md`. |
| `SLIRC_IRC_HOST` | empty | Self-host | Public host name of the IRC TLS port. The IRC clients tab shows it. Leave it unset while IRC is loopback only. |
| `SLIRC_IRC_PORT` | `6697` | Self-host | Public IRC TLS port shown on the IRC clients tab. |
| `SLIRC_ALLOWED_CLIENT_ORIGINS` | empty | Self-host | Extra origins, comma separated, that may call `/auth/me`, `/auth/logout` and `/irc` cross-origin with a bearer token. Cookies are never sent cross-origin. `https://app.slirc.org` and `https://*.slirc.app` are always allowed. |

## Email and sign-up

| Variable | Default | Use | What it does |
|---|---|---|---|
| `RESEND_API_KEY` | none | Self-host | Resend key for sign-in emails and invitations. Without it, use `slirc login-link` on the server. |
| `RESEND_FROM` | none | Self-host | From address for those emails. Mail is not sent without it. |
| `MAIL_DAILY_LIMIT` | `100` | Self-host | Daily cap on mail the instance sends. Bulk invitations stop at 75% of it. |
| `MAIL_DAILY_WARN` | `80` | Self-host | Daily mail count that logs a warning. |
| `SIGNUP_DOMAIN_LIMIT` | `30` | Self-host | New sign-ups allowed per receiving mail domain per hour. |
| `EMAIL_INVITE_LIMIT` | `9` | Self-host | Email invitations one member can send in total. Accounts with unlimited invitations are exempt. |
| `BULK_INVITE_GAP_MS` | `500` | Self-host | Pause between mails in a bulk invitation. |

## Helpers and models

| Variable | Default | Use | What it does |
|---|---|---|---|
| `SLIRC_HELPERS` | `help,remind,poll,welcome` | Self-host | Comma list of helpers to run. `links` runs only when listed. An unknown name stops the app at boot. |
| `SLIRC_HELPERS_ENABLED` | on | Self-host | `false` runs no helpers. |
| `SLIRC_HELPER_DAILY_LIMIT` | `100` | Self-host | Model calls the help and remind helpers make for one account in 24 hours, combined. |
| `OPENROUTER_API_KEY` | none | Self-host | Turns on model answers for the help bot and natural-language reminders. |
| `HELP_ANSWER_MODEL` | `anthropic/claude-haiku-5.5` | Self-host | Model that writes help answers. |
| `HELP_CLASSIFIER_MODEL` | `xiaomi/mimo-v2.6-flash` | Self-host | Model that sorts each message first. `jev-latest` when `TYPESAFE_API_KEY` is set. |
| `HELP_MODEL` | `xiaomi/mimo-v2.5` | Self-host | Model for reminders and other helpers. |
| `HELP_DOCS_DIR` | `app/docs` | Self-host | Folder the help bot reads its answers from. |
| `HELP_INPUT_PRICE_PER_MILLION` | model list price | Self-host | Overrides the input price, in dollars per million tokens, used for cost accounting. |
| `HELP_OUTPUT_PRICE_PER_MILLION` | model list price | Self-host | Same for output tokens. |
| `TYPESAFE_API_KEY` | none | Self-host | Sorts messages with TypeSafe's Jev model instead of the OpenRouter classifier. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai/v1` | Self-host | TypeSafe API address. |
| `TYPESAFE_INPUT_PRICE_PER_BILLION` | `42` | Self-host | Jev input price, in dollars per billion tokens, for cost accounting. |
| `GIPHY_API_KEY` | none | Self-host | Turns on `/giphy` search and the welcome helper's greeting gif. |

## Links

| Variable | Default | Use | What it does |
|---|---|---|---|
| `LINKS_CHANNEL` | `#links` | Self-host | Home channel of the links helper. |
| `LINKS_DIGEST_CHANNEL` | none | Self-host | Channel that gets the links digest. No digest without it. |
| `LINKS_TOPICS` | topics already on shared links | Self-host | Comma list of topics a link can be filed under. |
| `LINKS_DAILY_MODEL_CALLS` | `200` | Self-host | Model calls the links helper makes per day. |
| `LINKS_IMAGE_BACKFILL_PER_RUN` | `6` | Self-host | Preview images fetched per run for older links. Capped at 20. |
| `EMBED_ALLOW_PRIVATE` | off | Dev | `true` lets link previews and embeds fetch private network addresses. Never set it on a real instance. |

## Limits and timeouts

| Variable | Default | Use | What it does |
|---|---|---|---|
| `AGENT_SSE_KEEPALIVE_MS` | `15000` | Self-host | Interval of the keepalive on the agent event stream. |
| `BOT_EDIT_TIMEOUT_MS` | `5000` | Self-host | How long a bot message edit waits for Ergo. |
| `REDACT_TIMEOUT_MS` | `5000` | Self-host | How long a message deletion waits for Ergo. |

## Hosted only

| Variable | Default | Use | What it does |
|---|---|---|---|
| `SLIRC_BRAND` | `org` | Hosted only | `slirc.app` (or `app`) shows the blue hosted lockup. `slirc.org` (or `org`) shows the neutral mark. Any other value stops the app at boot. |
| `WAITLIST_API_URL` | none | Hosted only | Address of the waitlist service the admissions page reads applications from. |
| `WAITLIST_INTERNAL_TOKEN` | none | Hosted only | Bearer token for that service. It must be at least 32 characters. |
| `WAITLIST_ORIGIN` | `APP_ORIGIN` | Hosted only | Origin used in the links of admission emails. |
| `TESTFLIGHT_URL` | none | Hosted only | TestFlight link for the iPhone beta. Only `https://testflight.apple.com/join/<code>` is accepted. Unset, the install link stays hidden. |
| `APPLE_APP_IDS` | none | Hosted only | App IDs for Apple universal links, served at `/.well-known/apple-app-site-association`. |

## Development, tests and scripts

| Variable | Default | Use | What it does |
|---|---|---|---|
| `DEV_IRC_NICK` | none | Dev | Signs every request in as this account without a session. Never set it on a reachable instance. |
| `SLIRC_DEV_PROFILE` | none | Dev | `slirc2` marks the isolated local stack. It allows dev CORS, HTTPS dev links and a loopback IRC address. |
| `MAGIC_LINK_LOG` | off | Dev | `true` logs sign-in links and returns them in the response. Only honored with an `http://` origin or the `slirc2` profile. |
| `SLIRC_IRC_LOCAL_DEV` | off | Dev | `true` points the IRC clients tab at `127.0.0.1:6797` and allows its self-signed certificate. |
| `NODE_ENV` | none | Test | `test` skips starting the server and uses a fixed IRC key. `development` allows dev CORS. |
| `SEED_CHANNELS_JSON` | built-in seed | Script | Channels and members the seed creates. |
| `CHAN_FOUNDER_NICK` | `OWNER_NICK` | Script | Owner of the seeded channels. |
| `USERS_JSON` | `{}` | Script | Old static nick and password map from before accounts. Only the migration reads it. |
| `ACCOUNTS` | none | Script | `nick:pass,nick:pass` list for `create-accounts.ts`. |
| `SLIRC_IRC_MIGRATION` | none | Script | Set by `migrate-founder.ts` so it can run while old stored IRC passwords still exist. Do not set it by hand. |
| `SLIRC_BOOT_SEED` | none | Script | Set by `client-seed.ts`. |
| `SLIRC_SEED_PEER` | `eve` | Script | Second account in `profile-thread-seed.ts`. |
| `PRUNE_VERBOSE` | off | Script | Prints every line `history-prune.ts` removes. |

## Agent package

Read by `slirc-agent` and its harnesses, not by the server.

| Variable | Default | Use | What it does |
|---|---|---|---|
| `SLIRC_CONNECT` | none | Self-host | Set by `slirc-agent <workspace>` for the session it launches. Do not set it by hand. |
| `SLIRC_CONNECT_TICKET` | none | Self-host | One-time ticket that goes with `SLIRC_CONNECT`. |
| `SLIRC_RETRY_MS` | `5000` | Self-host | Wait before the agent retries a failed request. |
| `SLIRC_LOST_WARNING_MS` | `30000` | Self-host | Outage length before the agent tells the channel it lost the connection. |
| `SLIRC_TLS_INSECURE` | off | Self-host | `1` skips TLS checks for the agent's IRC connection. Private hosts get this automatically. |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Self-host | Where the Pi harness keeps its state. |
| `HOSTNAME` | `unknown` | Self-host | Machine name shown for a paired Pi session. The shell usually sets it. |
| `SLIRC_AGENT_PROOFS` | off | Test | `true` runs the live agent proof tests. |
| `FAKE_CODEX_QUEUE_FAIL` | none | Test | Makes the fake Codex binary fail a queued request. |
| `XDG_STATE_HOME` | none | Test | Redirects OpenCode state in its plugin test. |

## Read by Compose

`SLIRC_CONFIG_DIR`, `SLIRC_IRC_KEY_PATH`, `SLIRC_APP_IP`, `SLIRC_NETWORK` and `ERGO_IP` are read by the Compose files and `just deploy`, not by the app. `deploy/README.md` describes them.
