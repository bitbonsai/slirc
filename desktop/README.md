# Slirc for Mac

A Swift app around WKWebView. On first launch, and after signing out, it shows its workspace picker, a page bundled in the app (`Slirc/Picker`) that lists the workspaces opened on this Mac and takes any other address, with app.slirc.org, Slirc's own workspace, one click away. It checks that the address answers `/api/version` like Slirc, and loads that workspace's web client from its own https address. The session cookie, the IRC relay and uploads then work as in a browser. Pages on the workspace's address stay in the app, and every other link opens in the default browser. "Switch Workspace…" in the Slirc menu (Option-Cmd-O) and "Switch workspace" in the profile open the web client's workspace dialog while signed in. On the sign-in screen, and while the page can't show the dialog, they open the picker. Each workspace keeps its own sign-in. A saved address that answers but isn't a workspace is forgotten at launch and the picker shows. Up to six workspaces stay live in one window: switching hides the page on screen and shows the other, so the socket, the transcript and the drafts are there at once. Signing out drops that workspace's page.

The picker draws its rows with the web client's workspace marks. `desktop/picker-assets.ts` copies them from `app/client/workspace-mark.ts` into `Slirc/Picker/workspace-mark.js`, along with the Slirc mark. Run `bun desktop/picker-assets.ts` after changing either; `app/test/desktop-picker.test.ts` fails while the copies are stale.

The app sets the `mac-shell` class on the page. Under that class, `app/public/style.css` shrinks the header to the 52 pt title bar and makes room for the window controls. The page can ask the app for three things, a window drag, a zoom and the workspace picker, and only from the workspace's own top-level page. The app also hides CSS anchor positioning from the page, because WebKit places anchored popups too low in a scrolled transcript.

## Updates

Sparkle 2, added through Swift Package Manager, checks the feed set in `SPARKLE_FEED_URL` every 3 hours (`SUScheduledCheckInterval` is 10800 seconds, where Sparkle defaults to once a day) and on "Check for Updates…" in the Slirc menu. `desktop/Info.plist` holds the Sparkle keys, merged into the generated Info.plist: the feed URL (`$(SPARKLE_FEED_URL)`), automatic checks, the check interval, a signed feed (`SURequireSignedFeed`), verification before extraction, and the EdDSA public key (`$(SPARKLE_PUBLIC_ED_KEY)`). Local builds without a feed URL and public key skip starting Sparkle.

`Slirc/Updates.swift` replaces Sparkle's windows with a toast in the window's top-right corner. A new version downloads in the background, then the toast, a dark HUD pill in both appearances, says "Update ready. Relaunch to get the latest Slirc." in lime, with a "Relaunch Now" button and a bare close x that brightens and grows under the pointer. Text wider than the pill slides sideways and back, pausing under the pointer, with Reduce Motion on too. Only the close x's grow skips its easing then. The update installs only on a click on the toast or its button. Closing the toast, or quitting Slirc, cancels the install, and the next check offers it again. That rule depends on Sparkle's replies: to "ready to install", `.skip` cancels without skipping the version, so the toast answers it that way. When Sparkle reports an install that was already armed, the toast's close button can only defer it, and it installs on the next quit. "Check for Updates…" with nothing new shows "Slirc is up to date". A background check that fails says nothing.

macOS 14 or later.

## Signing and configuration

`Config.xcconfig` holds neutral defaults (`com.example.slirc.desktop`, empty team ID and Sparkle keys) and includes an optional gitignored `Signing.xcconfig`. To build with your own Apple team, bundle ID, or Sparkle feed:

```sh
cd desktop
cp Signing.xcconfig.example Signing.xcconfig
```

Fill in `DEVELOPMENT_TEAM`, `PRODUCT_BUNDLE_IDENTIFIER`, and optionally `SPARKLE_FEED_URL` and `SPARKLE_PUBLIC_ED_KEY` in `Signing.xcconfig`.

## Build and run

```sh
cd desktop
xcodebuild -project Slirc.xcodeproj -scheme Slirc -configuration Debug \
  -derivedDataPath /tmp/slirc-mac-dd -allowProvisioningUpdates build
open /tmp/slirc-mac-dd/Build/Products/Debug/Slirc.app
```

Debug builds sign automatically with an Apple Development certificate, and Web Inspector works (Safari, Develop menu). Or open `Slirc.xcodeproj` in Xcode and press Run.

## Not yet

- Notifications. WKWebView has no web push, so the app needs native APNs push: the push entitlement, a device token endpoint and an APNs sender on the server. A spike on the `mac-push-spike` branch showed APNs alerts arriving while the app is quit.
- `slirc://` and https links that open the app, a dock badge for unread messages, several workspaces side by side, the camera for "Scan to sign in", and saving files with `<a download>`.

## Gotchas

- A Debug build registers its copy in `/tmp/slirc-mac-dd` with Launch Services. If another copy with the same bundle ID is installed, macOS may pick the wrong one. Unregister the extra copy with `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u <path to Slirc.app>`.
- A shortcut in the Slirc, View or Window menu does nothing while the page has focus. WKWebView takes every key equivalent for the page and returns it to the menu bar only when the page reports it unhandled. `ShellWebView.performKeyEquivalent` tries those menus first; only the Edit menu's shortcuts go to the page first.
- The update toast never shows in a Debug build run from `/tmp/slirc-mac-dd` when that build's `CURRENT_PROJECT_VERSION` is at or above the feed's. Sparkle offers only a higher build number.
- `log` is a zsh builtin. Use `/usr/bin/log show` to read the system log.
- Notifications are denied without a prompt. The app's switch in System Settings, Notifications is off, and turning it on fixes it. If notifications are delivered but never appear, and the log shows `NotificationCenter: ... dropping msg 1 app not found`, run `killall NotificationCenter`, and macOS relaunches it.
