title: IRC clients
crumb: Connect / IRC clients
description: IRC clients that can connect to Slirc and how PWA features appear outside the web app.
lead: Slirc remains IRC underneath, so the conversation does not depend on one client.

Everything Slirc shows in the app is also on the IRC server. This page is for people who want a terminal or desktop client next to the PWA, or instead of it.

## Client shortlist

| Client | Platforms | Interface | Source | Good fit for |
| --- | --- | --- | --- | --- |
| [Senpai](https://sr.ht/~taiite/senpai/) | Linux, macOS | terminal | open | a focused keyboard-driven client |
| [Halloy](https://halloy.chat/) | Linux, macOS, Windows | desktop | open | a modern cross-platform GUI |
| [Textual](https://www.codeux.com/textual/) | macOS, iOS | native | commercial | a polished Apple client |
| [Revolution IRC](https://github.com/MCMrARM/revolution-irc) | Android | native | open | lightweight mobile IRC |
| [WeeChat](https://weechat.org/) | Linux, macOS, BSD | terminal | open | scripting and deep customization |

These clients support registered IRC accounts through SASL. Exact history and media presentation varies by client.

## How Slirc features appear

- Channels remain ordinary IRC conversations. PWA direct messages appear as private `#dm-*` channels in terminal clients, so offline messages persist without fake presence.
- Email invitations only deliver the link. Whoever accepts is a normal account with normal channel access, so `/list`, auto-join and history behave as in any other room.
- Thread replies arrive in the same channel or DM with an IRCv3 `+reply` tag.
- Images, videos, GIFs, and previews remain readable URLs.
- Topics use the standard IRC topic.
- Edits and reactions use IRCv3 metadata. Halloy renders reactions under their message; clients without reaction support ignore them.

## How to connect

<div class="config-builder" data-irc-config>
  <label><span>Nick</span><input type="text" value="yournick" maxlength="32" autocomplete="nickname" data-irc-nick /></label>
  <label><span>Server name</span><input type="text" value="slirc" maxlength="32" spellcheck="false" data-irc-server /></label>
  <small>Server name is the local label in your IRC client. The connection still goes to {{host}}.</small>
</div>

The commands and config below update as you type. Values stay in this browser. The in-app **IRC clients** tab fills in a workspace-specific server name (such as `slirc-yourteam`) for Halloy and WeeChat so multiple workspaces do not collide.

### Connect with a password

1. Open **More → Profile → IRC clients** on a phone, or **Profile → IRC** on desktop.
2. Choose **Use a password** and name the device, for example `Halloy on MacBook`.
3. Save the password when it appears. Slirc shows it once.
4. Copy the setup block for your client.

Clients connect to `{{host}}` on port `6697` with TLS and SASL PLAIN. Adding or removing a password device rotates the account password, and so does **New password**, which makes one without adding a device. Older password clients must use the newest password before they can reconnect.

For Halloy, add this to `config.toml`:

```toml
[servers.{{server}}]
server = "{{host}}"
port = 6697
use_tls = true
nickname = "{{nick}}"
username = "{{nick}}"

[servers.{{server}}.sasl.plain]
username = "{{nick}}"
password = "the password Slirc showed you"
```

#### Local development endpoint

A local development instance advertises its own IRC endpoint instead of `{{host}}`, such as `127.0.0.1:6797`, and the generated blocks use that host and port. A loopback address only works on the machine running the stack; another computer cannot reach it.

That local Ergo uses a self-signed certificate, so the generated Halloy block adds `dangerously_accept_invalid_certs = true` with a warning comment. It accepts only this local certificate and must not be copied into a production config. Other clients get the same host and port but no certificate bypass; they need their own way to trust the local certificate, or the TLS handshake fails.

#### Quiet server events in Halloy

Halloy shows IRC joins, leaves, mode changes, and kicks in channel history. To keep Slirc conversations focused, add this optional block. It only hides these events for the server name above; ordinary messages remain visible.

```toml
[buffer.server_messages.change_mode]
exclude = { servers = ["{{server}}"] }

[buffer.server_messages.join]
exclude = { servers = ["{{server}}"] }

[buffer.server_messages.part]
exclude = { servers = ["{{server}}"] }

[buffer.server_messages.quit]
exclude = { servers = ["{{server}}"] }

[buffer.server_messages.kick]
exclude = { servers = ["{{server}}"] }
```

### Connect with a certificate

A certificate gives each client its own credential. Revoking one certificate does not interrupt other clients.

Generate an ECDSA P-256 key and self-signed certificate:

```sh
nick={{nick}}; server={{server}}; openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 -subj "/CN=$nick" -keyout "$server-$nick.key" -out "$server-$nick.crt" && cat "$server-$nick.key" "$server-$nick.crt" > "$server-$nick.pem" && chmod 600 "$server-$nick.key" "$server-$nick.pem" && openssl x509 -in "$server-$nick.crt" -noout -fingerprint -sha256
```

Keep `.key` and `.pem` private. Anyone with either file can sign in as you. Open **Profile → IRC → Use a certificate**, name the device, and paste the SHA-256 fingerprint printed by OpenSSL.

#### Halloy

Add this to Halloy's `config.toml`, using absolute paths:

```toml
[servers.{{server}}]
server = "{{host}}"
port = 6697
use_tls = true
nickname = "{{nick}}"
username = "{{nick}}"

[servers.{{server}}.sasl.external]
cert = "/path/to/{{server}}-{{nick}}.crt"
key = "/path/to/{{server}}-{{nick}}.key"
```

#### WeeChat

Copy the combined PEM to WeeChat's private certificate directory, then configure server:

```text
/server add {{server}} {{host}}/6697 -tls
/set irc.server.{{server}}.nicks "{{nick}}"
/set irc.server.{{server}}.tls_cert "%h/tls/{{server}}-{{nick}}.pem"
/set irc.server.{{server}}.sasl_mechanism external
/connect {{server}}
```

Older WeeChat releases call `tls_cert` `ssl_cert` and use `-ssl` instead of `-tls`.

#### Textual

Convert certificate to PKCS #12, import it into macOS Keychain, then select identity certificate in Textual's server settings and choose SASL EXTERNAL:

```sh
openssl pkcs12 -export -inkey {{server}}-{{nick}}.key -in {{server}}-{{nick}}.crt -out {{server}}-{{nick}}.p12
```

Textual on iOS must receive identity through iOS certificate/profile management before it appears in server settings. Textual versions without SASL EXTERNAL must use password setup above.

#### Senpai

Senpai currently supports SASL PLAIN only and has no client-certificate setting. Use **Use a password** in Slirc for Senpai. Do not add PEM paths to Senpai config; current releases ignore them.

Never enter your magic-link URL into an IRC client. Magic links sign in to web app. IRC clients use password or certificate from device setup.
