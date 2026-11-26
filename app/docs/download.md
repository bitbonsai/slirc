---
title: Download and install
crumb: Guides / Download and install
description: Install Slirc on Mac, iPhone, Windows, Android, or Linux, or connect an IRC client.
lead: Install the Slirc app on your Mac, iPhone, or any browser, or connect an IRC client. The same channels everywhere.
---

## Mac

The Mac app is built from the `desktop/` directory in the repository for macOS 14 or later. If your operator distributes a signed DMG, open it and drag Slirc to Applications. On first launch, enter any verified HTTPS Slirc instance address (hosted or self-hosted). Up to six workspaces stay live in one window, and **Switch Workspace…** in the Slirc menu (Option-Cmd-O) or the left workspace rail switches between them.

The Mac app has no notifications yet. If you want them, install Slirc from the browser as below.

## iPhone

The iPhone app is built from the `native/` directory and can be distributed through TestFlight, Apple's app for test builds. When your instance configures `TESTFLIGHT_URL`, signed-in members find the install link under **More → Get the iPhone app** on a phone.

1. Install TestFlight from the App Store.
2. Open the TestFlight link your instance provides.
3. Tap **Install**.
4. Open Slirc and enter any verified HTTPS Slirc instance address (hosted or self-hosted).

The iPhone app has no notifications yet. For notifications, add Slirc to the Home Screen from Safari instead. Open your instance, tap the share button, then **Add to Home Screen**. [Getting started](/docs/getting-started#save-slirc-to-your-home-screen) has a video.

## Windows, Android and Linux

Open your instance in the browser, sign in, and install it as an app. Each instance gets its own window and icon.

- In **Edge**, open the ⋯ menu, then **More tools**, **Apps** and **Install this site as an app**.
- In **Chrome**, open the ⋮ menu, then **Cast, save and share** and **Install page as app**.
- In **Chrome on Android**, open the ⋮ menu, tap **Add to home screen**, then **Install**. An Android app is planned.

Firefox on Linux can't install web apps, so there Slirc stays a browser tab.

## IRC clients

IRC clients like Halloy connect to any Slirc instance over TLS. [Set one up](/docs/clients).

## Install details

### Start at login

To open Slirc when you sign in to your computer, find it in `chrome://apps` or `edge://apps` and turn on start at login.

### Notifications on Windows and Linux

Open the installed Slirc window and turn notifications on in your profile there, as on the [notifications page](/docs/notifications). In a browser tab, Edge only allows them while the tab is open. In the installed app they arrive while the browser runs, even with the Slirc window closed. Edge keeps running in the background on Windows. In Chrome, turn on **Continue running background apps when Google Chrome is closed** under Settings, System.
