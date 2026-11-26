# Slirc design

Extension reference for the current client: source paths, tokens, component classes, branding, accessibility, and build commands. Slirc is phone-first group chat with IRC underneath. The public page with live examples is [`app/docs/design.md`](./app/docs/design.md).

## Sources

- `app/client/main.ts`, `app/client/runtime.ts`: Alpine components and shared client wiring, bundled as `/client.js`.
- `app/partials/*.html`: markup and shell style overrides. `app/public/index.html` is generated; never edit it directly.
- `app/public/style.css`: tokens, responsive layout, and component styles.
- `app/public/theme.js`: appearance preference, applied before CSS and first paint. Docs pages load it too.
- `app/public/docs/docs.css`, `app/public/docs/docs.js`: docs chrome, with its own dark and light token blocks.
- `app/public/icons/lucide/sprite.svg`: curated Lucide sprite.
- [`app/docs/design.md`](./app/docs/design.md): public design-system reference and component examples. Run `cd app && bun run docs` after editing it.

## Character

Messages run as a compact stream without cards. Messages and composer text use monospace; controls and conversation intros use system UI fonts. Headers, menus, and composer pair tinted panels with blur. Animation marks a change and then stops; nothing decorative loops. Dark uses Catppuccin Mocha; light uses Catppuccin Latte neutrals with Slirc lime. Layout, type, and interactions stay the same between themes, and each light accent keeps the hue of its dark counterpart.

## Appearance and colors

Settings offers System, Light, and Dark. System is the default and follows `prefers-color-scheme`, including changes while the page is open. Explicit choices override the device preference. The choice saves to the signed-in account with `{ accountId, theme }` only; profile drafts stay untouched. `localStorage` under `slirc-theme` supplies first paint and signed-out pages. `/auth/me` supplies the account preference after sign-in. Changes apply immediately; failed saves keep the local choice without an error dialog. Other devices adopt the saved choice on their next load. Blocked storage keeps the current page switchable; invalid or missing values use System. Storage is per origin, so docs.slirc.org follows the device setting while in-app `/docs` follows the saved choice.

`theme.js` sets `data-theme` and `data-theme-preference` on `<html>`, native `color-scheme`, and the browser theme color before the stylesheet loads. Theme selection must not wait for sign-in or Alpine.

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--bg` | `#11111b` | `#eff1f5` | Canvas and inputs |
| `--bg-glow` | Mocha base to canvas | White to Latte base | Restrained radial page background |
| `--panel` | `#181825` | `#e6e9ef` | Tinted chrome, menus, dialogs |
| `--panel-hi` | `#313244` | `#e6e9ef` | Raised controls |
| `--secondary-fill` | `var(--panel-hi)` | `#ccd0da` | Secondary button fill; light uses Surface0 because panel-hi equals panel |
| `--secondary-fill-hover` | Panel-hi mixed 15% toward text | `#bcc0cc` | Secondary button hover and focus; Surface1 in light |
| `--text` | `#cdd6f4` | `#4c4f69` | Main text |
| `--muted` | `#7f849c` | `#65687e` | Secondary labels; light is a contrast-adjusted Latte Subtext0 |
| `--line` | `var(--panel-hi)` | `#ccd0da` | Neutral borders; solid Surface0 in light |
| `--brand-fill` | `#a6e3a1` | `#a6e3a1` | Lime primary buttons and composer Send |
| `--on-brand` | `#11111b` | `#4c4f69` | Text and glyphs on lime fills |
| `--brand` | `#a6e3a1` | `#237719` | Accent ink, focus, presence, success |
| `--accent` | `var(--brand)` | `var(--brand)` | Nick accent alias |
| `--mine` | `#94e2d5` | `#2b726a` | Links, code highlighting, personal state |
| `--danger` | `#f38ba8` | `#af425a` | Errors and destructive actions |
| `--warning` | `#f9e2af` | `#856000` | Pending and verification warnings |
| `--attention` | `#fab387` | `#a34b09` | Agent input-needed state |
| `--shadow` | `#0008` | `#4c4f691a` | Base colour for light shadow tokens |
| `--mention-fill` | Brand at 16% | `#c3e9c3` | Normal mention fill |
| `--mention-ink` | Brand | Main text | Normal mention label |
| `--mention-me-fill` | Links at 22% | `#b8e7b6` | Personal mention fill |
| `--active-fill` | Brand at 13% | `#d9eddc` | Active channel row |
| `--active-ring` | transparent | `#2377192e` | Active row border and active room-mark ring in light |
| `--avatar-fill` | `var(--panel-hi)` | `#ccd0da` | Person avatars without a photo |

Keep lime below roughly ten percent of a typical screen. Keep brand fill and accent ink apart. Pastel lime reads well as a fill under dark text and poorly as small text on a light canvas. Light accent, links, and danger sit at saturation .45 to .65 with about 5:1 contrast on Base and 4.6:1 on Mantle; check contrast before putting them on Surface0 controls. Light mention and active fills are the brand fill mixed into the canvas, so they share its hue.

Links stay underlined in light. Secondary, primary, and destructive buttons are borderless; focus outlines stay distinct and full-strength. Danger menu items tint with `--danger` at 14% on hover or press. Initials on pastel avatar fills keep dark ink in both themes. In light mode timestamps use a lighter weight and keep full opacity, so small text stays readable. Check actual composited surfaces, including disabled controls and glass. The lightbox and embedded media players remain dark viewing areas.

## Tokens

All tokens live in `:root` of `app/public/style.css`, with light overrides in `:root[data-theme="light"]`. Use them for new and edited components; one-off values need a concrete layout or accessibility reason.

- Fonts: `--ui` (system UI stack) for chrome, headings, buttons, menus; `--mono` (JetBrains Mono first, no webfont) for messages, composer, code. Body starts at `1rem/1.45`; messages use about `1.55`.
- Type, six steps, no 13px: `--text-2xs` 11px badges and counts; `--text-xs` 12px timestamps, hints, status, tooltips; `--text-sm` 14px UI body, inputs, menus, button labels; `--text-base` 16px messages; `--text-lg` 20px sheet and dialog heads; `--text-xl` 24px page heads. Exceptions: glyphs sized to fixed containers, 1.75rem and 2rem display sizes, em sizes inside code.
- Spacing: `--space-1` .25rem to `--space-6` 2rem (.25, .5, .75, 1, 1.5, 2).
- Radius, five steps: `--radius-xs` .25rem code and tiny marks; `--radius-sm` .4rem chips; `--radius-md` .55rem buttons, inputs, menu rows; `--radius-lg` .75rem menus, popovers, cards; `--radius-xl` 1rem dialogs and toasts; plus `--radius-pill` and `--radius-round`.
- Motion, five steps: `--dur-micro` .1s, `--dur-fast` .15s, `--dur-base` .2s, `--dur-entrance` .3s, `--dur-reveal` .5s, easing `--ease-standard` `cubic-bezier(.2,.7,.2,1)`. Loops (spinners, pulses) keep their own durations. Component tokens: `--dur-boot-pop` 450ms, `--dur-boot-exit` 150ms, `--dur-reaction` 380ms.
- Shadows: `--shadow-sm`, `--shadow-md`, `--shadow-lg`; black alphas in dark, `var(--shadow)` in light.
- Disabled: `--disabled-opacity` .5.

Use rem for type, gaps, padding, and radii; px for 1–2px borders and focus outlines. Touch targets stay at least `2.75rem` (44px at the default root size); safe-area insets add on top.

## Layout and conversation

Phone bottom navigation contains Home, DMs, and More; it hides while the keyboard is open. It is a borderless glass pill set low, inside the home-indicator inset (`--nav-h` 3.75rem, `--nav-lift`), on `--nav-surface` (`--panel-hi` at 28% in dark, white at 45% in light); the active tab gets a `--nav-active` pill a small step lighter than the bar and a white label. It shows on tab screens and pages under More, and hides inside conversations. Tapping or dragging down the channel list or an open reply thread puts the keyboard away while a composer has focus, and the header stays on screen while it is up. On phone, a message avatar (tap or long press) and the DM header open the person's profile. The composer + is a muted glyph; only Send gets the brand fill. More is three `more-card` groups at the bottom: your profile row (Profile, devices, sign out), the workspace card (switcher, Invitations, Agents, Admin, iPhone app), and Help & docs with the build as its caption. The workspace row shows a `workspace-count` pill with the number of saved workspaces, hidden when only one is saved. Phone Profile ends with Devices, IRC clients, and Sign out; their pages go back to Profile. Pages opened from More or Profile sit just above the tab bar through a flexible spacer on `.profile-screen > .mobile-screen-body::before`, so they need no `mobile-spacer`; long pages scroll. Opening a channel, DM, or thread replaces the tab screen; Back returns to its source. In the iOS app and the Home Screen app, a swipe from the left 20px edge presses the visible back arrow (`reply-thread-back`, `profile-back`, or `header .mobile-back`), so new phone screens with a back arrow use one of those classes. Docs opened from the app or a phone show the sticky `app-back` bar, `--app-back-h` tall, to get back. Selecting a conversation must not open the phone keyboard.

Phone screens scroll up and down only. `.mobile-screen-body`, `.mobile-settings-body`, and on phones `.chat` and `.reply-thread-stream` clip sideways overflow with `overflow-x: clip` and `overscroll-behavior-x: none`. Code blocks and tables scroll inside themselves. Anything wider is cut off, so keep controls inside their container; a hidden file input in a card takes `sr-only`. Docs pages up to 640px clip sideways too and wrap long inline code. Pulling down from the very top of phone Home, DMs, More or a conversation shows `pull-indicator`, a glass chip with the Slirc logo that follows the finger, turns from grey to color past 64px, and on release checks the connection and loads newer messages without a reload. It pops once when caught up and shows a short note only when offline or unreachable; reduced motion only fades. Pulls within 24px of a screen edge or while a composer has focus are left alone.

The iOS app starts on its own picker, `native/www/index.html`. Opening a saved workspace shows the lockup pulsing over Opening <host>…. A workspace gets 5s to answer and 5s more for its client to start; a miss or failed load returns to the picker with that card as `card failed`, a Couldn't reach tag, and a Try again button, and the field stays unfocused so the keyboard leaves Try again visible.

Desktop has a far-left workspace rail (for switching saved workspaces, hiding the active pill when only one workspace is saved), a 15rem conversation rail, and a message column no wider than 860px. Channels in the sidebar support desktop drag-to-reorder with a 30% opacity floating ghost row, plus Alt+Up/Down keyboard reordering. Members can open in a right rail. Thread lists show two rows before searchable overflow. Cmd/Ctrl+K opens the quick switcher (channels, DMs, people); Cmd+Option+O / Ctrl+Alt+O opens Workspaces.

Desktop message rows are a grid: a 4.25rem action column (⋮ and add reaction on hover), a 2.25rem avatar, then nick, time, and body; continuation messages tuck under the body column. Phone uses a 1.5rem avatar, hides desktop nick and time, and has a separate compact mobile time. Long press opens actions; right swipe on a message inserts a readable quote.

System and history events are quieter than messages. Background join/part/mode noise stays collapsed. Dates and new-since-last-visit labels use hairline dividers. Quotes use muted italic text and an accent rule. Code blocks scroll horizontally and use local Glow highlighting.

Channel marks show `#` (`channel-hash`, with `open`) for open channels and `lock-icon` for private ones, in the sidebar, quick switcher, and header. On phone the header mark is a 2.1rem circle at 55% `--panel-hi`, the members button matches it, and a private channel title drops the #.

Threads retain parent and root context. Media labels use caption, title, or provider rather than raw URLs. Reaction chips carry counts and selected state, with one short stamp animation. Reactions offer five quick presets plus an **Add reaction** emoji search grid (including custom emoji). Custom emoji use shortcode alt text and fall back to the shortcode if removed.

## Controls, forms, and media

The composer aligns with the transcript. On phone it is a pill that grows into a card for multiline drafts; on desktop, the Mac app included, it is an 18px rounded rectangle with `--radius-lg` + and Send concentric inside. Send is a lime circle with a dark Lucide glyph in both themes, and + is a muted glyph with no fill; coarse pointers get 44px targets. + attaches photos (JPEG, PNG, WebP, up to 12 MB) and videos (MP4, MOV, WebM). Where the browser has WebCodecs, a large MP4 or MOV is re-encoded on the device to about 720p H.264 at 2.5 Mbps before upload (`app/client/video-compress.ts`, encoder in the lazy `/video-encode.js` bundle), so a pick can be up to 500 MB; the uploaded file must be under 30 MB. While it compresses, the clip shows as `media-chip compressing` with its percent and × to cancel, the screen-reader status says Compressing…, and Send waits. With a reply thread docked on desktop, only the focused composer keeps the brand border and lime Send; the other goes to `--secondary-fill` and muted ink, and with neither focused the thread composer is active. Disabled Send stays visibly disabled. Saving, queued, and sending labels use muted text with the typing-dot animation; reduced motion keeps dots still. Failed and uncertain states use the danger color.

Autocomplete appears above the composer for mentions, emoji, commands, and GIFs, and arrow keys keep selection stable. The command palette is capped at 384px on desktop. Cmd/Ctrl+B, Cmd/Ctrl+I, and Cmd/Ctrl+Alt+C wrap the selection or the word at the caret in Markdown.

Desktop account navigation uses routed links in `account-tabs` instead of profile tab buttons; phone reaches the same pages from More and Profile. Profile lives at `/profile` as page content. Photo changes save immediately; hover and focus overlays show Change, and upload shows Uploading. Other forms save only changed values. Native selects, checkboxes, and file inputs follow the effective color scheme. A Retry inside an error notice takes the notice's danger border and ink instead of the grey secondary fill.

Images, embeds, and lightbox dimensions vary by component and shell override; inspect both the stylesheet and the partial before documenting fixed limits. Players load after a click. Native dialogs handle lightboxes and modal flows. Destructive actions name the object and explain what disappears.

Toasts are `glass-toast` pills above the composer, in two kinds. Connection and delivery errors stay in the transcript banner; command and input feedback, like an unknown command or a missing argument, uses an auto toast.

- **Auto** (default) confirms something that just happened, like a copied link or a set reminder, or answers a command or input the app could not take. It shows even while the banner is up. A lighter layer drains toward the dismiss button over 5s, plus 1s per 30 characters of text up to 9s, and the toast closes when it empties. Hover or keyboard focus pauses the drain. With reduced motion the layer stays still and the toast still closes on time. A newer auto toast replaces the current one.
- **Sticky** (`glass-toast sticky`) is for something that needs the person, like a reminder that fired while they were elsewhere. It has no timer: the same glass as other toasts, a bell, an action button and **Dismiss**, and it stays until one is chosen. It fades in once over 160ms (no movement with reduced motion) and never flashes. It is separate state from auto toasts, so a quick notice never replaces or pushes it away; when both show, sticky sits above auto. Several sticky toasts stack newest first, up to three; after that one row says how many more wait, with **Open** and **Dismiss all**. **Open** goes to the conversation and clears every toast for it. Toasts live in the app shell, so they show on every screen: above the composer in a conversation, at the bottom of the screen (above the phone nav) elsewhere.

## Branding and icons

| Asset | Purpose |
| --- | --- |
| `app/public/logo.svg` | Vector Slirc mark; source of the gradient stops |
| `app/public/logo.webp`, `logo.png` | Raster mark; boot and compact branding |
| `app/public/logo-light.webp` | Light mark: `logo.webp` at 84% lightness and 75% saturation |
| `app/public/wordmark.svg`, `wordmark@2x.png` | White wordmark for dark surfaces |
| `app/public/brand-org-dark.svg`, `brand-org-light.svg` | slirc.org lockup with the gradient mark, for the public playground, slirc.org and the docs. Dark has white lettering, light has #11111B. 1x and @2x PNGs beside each |
| `app/public/brand-app-dark.svg`, `brand-app-light.svg` | slirc.app lockup with the solid blue mark, used when `SLIRC_BRAND=slirc.app` is set (hosted workspaces); self-hosted private workspaces use the neutral Slirc mark by default. The server sets `data-brand` on the shell; style.css swaps by brand and theme |
| `app/public/icons/slirc-light.svg` | Light service bot mark |
| `app/public/icons/bots/*-light.svg` | Pastel Latte helper bot marks: help `#5fd27c`, remind `#fb9a62`, poll `#b48af4` |
| `app/public/icons/ui/nav-{home,dms}-light.svg` | Light mobile nav icons with the deeper stops (`#2ED882`, `#4172DD`) |
| `app/public/icons/` | App, favicon, navigation, and platform assets |

Light swaps each asset in CSS with `content: url()` on the matching `img`, so markup and JS stay theme-agnostic. The mark keeps its green-to-blue gradient in both themes; light lowers lightness and saturation so the edge holds on the pale canvas without turning neon. Keep the aspect ratio, lettering, and mark shape intact, and never invert a whole asset. Give informative logos Slirc alt text; decorative marks beside visible text get empty alt text. Rendered marketing and email prose spells **Slirc** in bold; identifiers and URLs do not.

Controls use [Lucide](https://lucide.dev/), distributed under the [ISC licence](https://lucide.dev/license). The app uses a curated local SVG sprite at `app/public/icons/lucide/sprite.svg`, with `lucideIcon()` in `app/client/presentation.ts`. A name is usable only when its real symbol exists in that sprite. Icons use currentColor, usually a 24×24 viewBox with 2px strokes and round caps and joins. Do not use emoji or text glyphs as control substitutes. Use Lucide for new controls.

## Glass and accessibility

Blur tokens are 3px, 9px, and 18px. Every floating glass surface (menus, flyouts, popovers, palettes, pickers, tooltips, toasts, banners, pills, chips, sheets) uses `--glass-tint`, the panel at 74%, and `--glass-filter`. In dark the filter darkens what it blurs (`saturate(1.2) brightness(.75)`) so a panel always sits below the content it covers; light only blurs. Window chrome (header, docked rooms rail, members panel, composer, mobile nav, phone variants included) uses `--glass-chrome`, the panel at 60%, and dialogs stay near-solid at 96%. An element with a backdrop filter, a filter, or opacity below 1 is a backdrop root, and a blurred child inside it blurs nothing. A glass menu that opens from a blurred surface must render outside it: the composer + menu is teleported to the end of `body`, fixed at `--z-floating`, and placed by `placePlusMenu` in `app/client/popups.ts`. When blur fails to reach the content behind a panel, look for a backdrop root among its ancestors.

The current shell disables transcript and list arrival animations and automatic view transitions that remain in shared CSS, so document effective shell behavior. Boot and reaction animations play once. Reduced motion removes nonessential animation.

Required behavior:

- Visible keyboard focus and labels on icon-only controls.
- Native `<dialog>` for modal flows, never alert/confirm/prompt. Tab cycles visible enabled controls; Escape cancels; close restores the invoker. Focus the sole usable input or a safe initial control. Rerenders must not steal text selection.
- Custom tinted-blur tooltips on hover and keyboard focus, never native hover titles.
- Safe-area insets around fixed phone controls; text selection whenever a fine pointer exists.
- Text, icon, count, or position alongside color for important state.
- Contrast checks on rendered surfaces, not only token pairs. Quiet borders are decorative; focus and control identification cannot depend on them alone.

## Build and docs

Edit partials, never the generated `app/public/index.html`. After editing `app/docs/design.md` or a component, run `cd app && bun run docs` and keep the generated `app/public/docs/` output; `bun test test/docs.test.ts` verifies the built pages. Changes to `docs.css` or `docs.js` need their `?v=` bumped in `app/scripts/build-docs.ts`. Cached app asset changes also need `bun run version` in `app/`; never hand-edit asset hashes. The design page's glass examples sit on `app/public/docs/glass-clouds.webp` (Diana @didsss, Pexels 10064781). Public landing and docs surfaces reuse Slirc branding but are separate from the app shell.
