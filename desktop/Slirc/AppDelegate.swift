// Slirc for Mac: a window around the workspace's own web client, loaded from its https address so
// the session cookie, the IRC relay and uploads work as they do in a browser. The app adds what a
// browser tab can't: its own window and menu bar, the window controls over the web header, and
// links that leave the workspace opening in the default browser. See desktop/README.md.
import AppKit
import UserNotifications
import WebKit

@main
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    /// A live page per workspace opened this session, so switching hides one and shows another
    /// instead of loading it again: the socket, the transcript and the drafts stay as they were.
    private var pages: [URL: ShellWebView] = [:]
    /// Those pages, most recently shown first, to pick which one leaves when the pool is full.
    private var order: [URL] = []
    private static let pageLimit = 6
    /// The workspace on screen. The window title, the title bar strip and the first responder
    /// follow it, and it names the page the unreachable screen belongs to.
    private var current: URL?
    private var strip: TitleBarStrip?
    private var picker: PickerView?
    /// The unreachable screen, over its workspace's page until that page loads.
    private var notices: [URL: PickerView] = [:]
    private var titleObservation: NSKeyValueObservation?
    /// Each pooled page's own unread count, which it reports (slircUnread). Every page gets the whole
    /// map as window.SlircUnread, so the workspace rail can show busy workspaces in full.
    private var unread: [URL: Int] = [:]
    private let updates = Updates()
    private var toast: Toast?

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = mainMenu()
        UNUserNotificationCenter.current().delegate = self
        updates.show = { [weak self] message in self?.showToast(message) }
        #if DEBUG
        // Sparkle never offers a Debug build an update, so `-SlircToastDemo YES` shows the ready toast
        // for screenshots. Clicking it does nothing.
        if UserDefaults.standard.bool(forKey: "SlircToastDemo") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                self?.showToast(Toast.Message(text: Toast.readyText, symbol: "checkmark.circle.fill",
                    ready: true, click: nil, close: { [weak self] in self?.showToast(nil) }, action: "Relaunch Now"))
            }
        }
        #endif
        guard let saved = Workspace.saved else { return showPicker(canCancel: false) }
        // As on iOS, a saved address that answers but isn't a workspace is forgotten and the picker
        // shows instead. An unclaimed *.slirc.app name serves the Slirc site, which would otherwise
        // open as if it were one. No answer still opens it, and ends on the unreachable screen.
        Workspace.check(saved) { [weak self] answer in
            if answer == .no {
                Workspace.saved = nil
                self?.showPicker(canCancel: false, message: Workspace.notFound, text: Workspace.label(saved))
            } else {
                self?.open(saved)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // An update waiting on its toast would otherwise install as Slirc quits. Canceling it goes to
    // Sparkle's installer, so the quit waits a moment for that to land.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard updates.cancelPendingInstall() else { return .terminateNow }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    /// The update toast, above the page or the picker the window holds.
    private func showToast(_ message: Toast.Message?) {
        toast?.removeFromSuperview()
        toast = message.map(Toast.init)
        if let toast, let content = window?.contentView { toast.place(in: content) }
    }

    /// Opens a workspace, switching to it at once when its page is already live. `path` is a route
    /// inside it, such as a channel, which moves the page open rather than loading it again.
    private func open(_ origin: URL, path: String = "/") {
        Workspace.saved = origin
        show(origin, path: path)
    }

    /// Shows the workspace's page: the one still in the pool, or a new one, loaded. The page shown
    /// before it is only hidden, so coming back to it is instant and offline history stays put.
    private func show(_ origin: URL, path: String = "/") {
        let window = showWindow()
        guard let content = window.contentView else { return }
        dismissPicker()
        let fresh = pages[origin] == nil
        let page: ShellWebView
        if let pooled = pages[origin] {
            page = pooled
        } else {
            page = ShellWebView(workspace: origin)
            page.onUnreachable = { [weak self] in self?.unreachable(origin) }
            page.onLoaded = { [weak self] in self?.reached(origin) }
            page.onSignedOut = { [weak self] in self?.signedOut(origin) }
            page.onUnread = { [weak self] count in self?.setUnread(origin, count) }
            page.onSwitchWorkspace = { [weak self] in self?.showPicker(canCancel: true) }
            page.onOpenWorkspace = { [weak self] typed in self?.openPicked(typed) }
            pages[origin] = page
            page.frame = content.bounds
            page.autoresizingMask = [.width, .height]
            // Behind the strip, under the window controls, and under the toast.
            if let strip { content.addSubview(page, positioned: .below, relativeTo: strip) } else { content.addSubview(page) }
        }
        current = origin
        order.removeAll { $0 == origin }
        order.insert(origin, at: 0)
        for (key, hidden) in pages { hidden.isHidden = key != origin }
        for (key, notice) in notices { notice.isHidden = key != origin }
        strip?.webView = page
        observeTitle(page)
        if fresh || (path != "/" && page.isLoading) {
            page.load(URLRequest(url: path == "/" ? origin : URL(string: path, relativeTo: origin) ?? origin))
        } else if page.url != nil {
            if path != "/" { go(page, path: path) }
            refreshWorkspaces(page)
        }
        window.makeFirstResponder(notices[origin] ?? page)
        trimPool()
    }

    /// The one window. The pages, the picker and the unreachable screen come and go inside it, so a
    /// workspace switch keeps the window and every page it holds alive.
    private func showWindow() -> NSWindow {
        if let window { return window }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        // The page runs up to the top edge and the window controls float over its header. The
        // empty toolbar makes the title bar 52 pt tall, the height the web client gives its header
        // inside the app (html.mac-shell in app/public/style.css), so the controls centre on it.
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.toolbar = NSToolbar()
        window.toolbarStyle = .unified
        window.title = "Slirc"
        window.minSize = NSSize(width: 720, height: 480)
        window.isReleasedWhenClosed = false
        let content = NSView()
        // The strip sits over the top of the page, under the window controls, and moves the window.
        let strip = TitleBarStrip()
        strip.autoresizingMask = [.width, .minYMargin]
        content.addSubview(strip)
        window.contentView = content
        strip.frame = NSRect(x: 0, y: content.bounds.height - TitleBarStrip.height, width: content.bounds.width, height: TitleBarStrip.height)
        if !window.setFrameUsingName("main") { window.center() }
        window.setFrameAutosaveName("main")
        window.makeKeyAndOrderFront(nil)
        self.window = window
        self.strip = strip
        if let toast { toast.removeFromSuperview(); toast.place(in: content) }
        return window
    }

    /// Mission Control and the Window menu show the page title, and only the page on screen sets it.
    private func observeTitle(_ page: ShellWebView) {
        titleObservation = page.observe(\.title) { [weak window] view, _ in
            if let title = view.title, !title.isEmpty { window?.title = title }
        }
        if let title = page.title, !title.isEmpty { window?.title = title } else { window?.title = "Slirc" }
    }

    /// The workspaces opened on this Mac, for the page's workspace dialog. A pooled page outlives the
    /// list it was built with, so it gets the current one each time it shows.
    private func refreshWorkspaces(_ page: ShellWebView) {
        let known = (try? JSONSerialization.data(withJSONObject: Workspace.known.map(\.absoluteString))).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        page.evaluateJavaScript("window.SlircWorkspaces = Object.freeze(\(known))")
        pushUnread(to: page)
    }

    private func setUnread(_ origin: URL, _ count: Int) {
        guard pages[origin] != nil else { return }
        if count > 0 { unread[origin] = count } else { unread.removeValue(forKey: origin) }
        for page in pages.values { pushUnread(to: page) }
    }

    /// The counts as { "https://host": n }, set on the page and announced with a "slirc-unread" event
    /// (app/client/native-shell.ts watchWorkspaceUnread).
    private func pushUnread(to page: ShellWebView) {
        let counts = Dictionary(uniqueKeysWithValues: unread.map { ($0.key.absoluteString, $0.value) })
        let json = (try? JSONSerialization.data(withJSONObject: counts)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        page.evaluateJavaScript("window.SlircUnread = Object.freeze(\(json)); dispatchEvent(new Event('slirc-unread'))")
    }

    /// Moves a page already loaded to a route inside it, as a click does, so it keeps its socket and
    /// its transcript. The client's router adopts a history entry it has not seen
    /// (app/client/navigation.ts).
    private func go(_ page: ShellWebView, path: String) {
        let argument = (try? JSONSerialization.data(withJSONObject: [path])).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        page.evaluateJavaScript("""
        (() => {
          const [path] = \(argument);
          history.pushState(null, "", path);
          dispatchEvent(new PopStateEvent("popstate", { state: null }));
        })();
        """)
    }

    /// At the cap, the page shown longest ago goes with its unreachable screen. The one on screen
    /// never does.
    private func trimPool() {
        while pages.count > Self.pageLimit, let stale = order.last(where: { $0 != current }) {
            drop(stale)
        }
    }

    /// Takes a page out of the pool. Its web view goes with it, since nothing shows it again.
    private func drop(_ origin: URL) {
        pages.removeValue(forKey: origin)?.removeFromSuperview()
        if unread.removeValue(forKey: origin) != nil { for page in pages.values { pushUnread(to: page) } }
        notices.removeValue(forKey: origin)?.removeFromSuperview()
        order.removeAll { $0 == origin }
        guard current == origin else { return }
        current = nil
        titleObservation = nil
    }

    /// The workspace didn't answer: a page bundled with the picker (Slirc/Picker/unreachable.html)
    /// covers it, with Try Again, Switch Workspace and Quit. Try Again reloads the workspace under
    /// it, and the screen goes once the page loads. A retry that fails again leaves it up.
    private func unreachable(_ origin: URL) {
        if let notice = notices[origin] { return notice.retryFailed() }
        guard let webView = pages[origin], let content = window?.contentView else { return }
        let page = PickerView(state: ["host": Workspace.label(origin)], name: "unreachable")
        page.onMessage = { [weak self, weak webView] body in
            if body["retry"] != nil {
                webView?.load(URLRequest(url: origin))
            } else if body["switch"] != nil {
                self?.showPicker(canCancel: false)
            } else if body["quit"] != nil {
                NSApp.terminate(nil)
            }
        }
        // Over the workspace page, under the title bar strip, so the window still drags.
        page.frame = content.bounds
        page.autoresizingMask = [.width, .height]
        content.addSubview(page, positioned: .above, relativeTo: webView)
        page.isHidden = current != origin
        window?.makeFirstResponder(page)
        notices[origin] = page
        page.loadPage()
    }

    /// The workspace page loaded: the unreachable screen, if it was up, goes.
    private func reached(_ origin: URL) {
        if let page = pages[origin] { pushUnread(to: page) }
        guard let notice = notices.removeValue(forKey: origin) else { return }
        notice.removeFromSuperview()
        if origin == current, let page = pages[origin] { window?.makeFirstResponder(page) }
    }

    /// Signed out, that page's session is over: it leaves the pool with everything it held, and the
    /// picker asks which workspace opens next, as on first launch. Builds from before this message
    /// send the switch request instead, and keep the page.
    private func signedOut(_ origin: URL) {
        showPicker(canCancel: true)
        drop(origin)
    }

    /// Signed in, the page opens its own workspace dialog (window.SlircOpenWorkspaces in
    /// app/client/native-shell.ts). Anywhere else, the sign-in screen, a page still loading, an
    /// error page or a web build without the hook, the app's own picker shows instead.
    @objc private func switchWorkspace(_ sender: Any?) {
        guard let webView = current.flatMap({ pages[$0] }) else { return picker == nil ? showPicker(canCancel: true) : () }
        let script = "typeof window.SlircOpenWorkspaces === 'function' && window.SlircOpenWorkspaces() === true"
        webView.evaluateJavaScript(script) { [weak self] result, _ in
            if result as? Bool == true { self?.window?.makeFirstResponder(webView) } else { self?.showPicker(canCancel: true) }
        }
    }

    /// The workspace picker, a page bundled in the app (Slirc/Picker), for when no signed-in page
    /// can show the web client's workspace dialog. It lists the workspaces opened on this Mac and
    /// takes any other address, which opens once its /api/version answers like Slirc. Each
    /// workspace keeps its own sign-in, since cookies belong to one address. With canCancel and a
    /// saved workspace, Cancel goes back to it; otherwise the picker offers Quit.
    private func showPicker(canCancel: Bool, message: String? = nil, text: String = "") {
        let window = showWindow()
        guard let content = window.contentView else { return }
        let back = canCancel ? Workspace.saved : nil
        let page = PickerView(state: [
            "workspaces": Workspace.known.map(\.absoluteString),
            "selected": Workspace.saved?.absoluteString ?? "",
            "back": back?.absoluteString ?? "",
            "message": message ?? "",
            "text": text,
        ])
        page.onMessage = { [weak self, weak page] body in
            if let typed = body["open"] as? String {
                self?.check(typed) { failure in page?.failed(failure, text: typed) }
            } else if let removed = (body["remove"] as? String).flatMap(URL.init(string:)) {
                Workspace.forget(removed)
            } else if body["cancel"] != nil, let back, Workspace.known.contains(back) {
                self?.open(back)
            } else if body["quit"] != nil || body["cancel"] != nil {
                NSApp.terminate(nil)
            }
        }
        dismissPicker()
        page.frame = content.bounds
        page.autoresizingMask = [.width, .height]
        content.addSubview(page, positioned: .above, relativeTo: strip)
        window.makeFirstResponder(page)
        picker = page
        page.loadPage()
    }

    private func dismissPicker() {
        picker?.removeFromSuperview()
        picker = nil
    }

    /// Checks a typed or picked address and opens it, saved, once it answers like a workspace.
    /// Anything else calls failed with the reason to show.
    private func check(_ typed: String, failed: @escaping (String) -> Void) {
        guard let origin = Workspace.origin(typed) else { return failed(Workspace.notAnAddress) }
        let path = Workspace.path(typed)
        Workspace.check(origin) { [weak self] answer in
            switch answer {
            case .yes:
                self?.open(origin, path: path)
            case .no: failed(Workspace.notFound)
            case .unknown: failed(Workspace.unreachable)
            }
        }
    }

    /// A workspace picked in the page's workspace dialog. It opens the same way as one picked in the
    /// picker: checked first, then saved. An address that fails the check brings up the picker with it.
    private func openPicked(_ typed: String) {
        check(typed) { [weak self] failure in self?.showPicker(canCancel: true, message: failure, text: typed) }
    }

    /// The standard app, Edit, View and Window menus. Without a menu bar there are no key
    /// equivalents, so Cmd-Q, copy and paste, and undo never reach the app or the web view.
    /// Actions with no target go up the responder chain, where the web view handles edit and reload.
    private func mainMenu() -> NSMenu {
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers
            return item
        }
        func menu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
            let submenu = NSMenu(title: title)
            items.forEach(submenu.addItem)
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            holder.submenu = submenu
            return holder
        }
        let switchItem = item("Switch Workspace…", #selector(switchWorkspace(_:)), "o", [.command, .option])
        switchItem.target = self
        let updateItem = item("Check for Updates…", #selector(Updates.checkForUpdates(_:)))
        updateItem.target = updates
        let main = NSMenu()
        main.addItem(menu("Slirc", [
            item("About Slirc", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            updateItem,
            .separator(),
            switchItem,
            .separator(),
            item("Hide Slirc", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit Slirc", #selector(NSApplication.terminate(_:)), "q"),
        ]))
        let edit = menu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        edit.identifier = ShellWebView.editMenu
        main.addItem(edit)
        main.addItem(menu("View", [
            item("Reload", #selector(WKWebView.reload(_:)), "r"),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ]))
        let window = menu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            item("Close", #selector(NSWindow.performClose(_:)), "w"),
        ])
        NSApp.windowsMenu = window.submenu
        main.addItem(window)
        return main
    }
}

/// The saved workspace and the rules for which addresses count as one. They match the iOS picker
/// in native/www/picker.js: any https host that answers /api/version like Slirc may be opened.
enum Workspace {
    private static let devOrigin: URL? = {
        guard let raw = ProcessInfo.processInfo.environment["SLIRC_DEV_ORIGIN"]?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              let url = URL(string: raw),
              url.scheme?.lowercased() == "https",
              url.user == nil,
              url.password == nil,
              let host = url.host, !host.isEmpty else { return nil }
        return url
    }()
    /// What the picker's field shows for a saved origin: its host, or the full address when it has a port.
    static func label(_ origin: URL) -> String { origin.port == nil ? origin.host ?? "" : origin.absoluteString }
    static let notFound = "We couldn't find a workspace at that address. Check the spelling."
    static let notAnAddress = "That isn't a workspace address. Check the spelling."
    static let unreachable = "We couldn't reach that workspace. Check your connection, or enter a different address."
    enum Answer { case yes, no, unknown }

    static var saved: URL? {
        get { UserDefaults.standard.string(forKey: "workspace").flatMap(origin) }
        set {
            // Read the list before replacing "workspace": until the list is written, an earlier
            // build's saved address is only in "workspace", and switching would drop it.
            let list = known, old = saved
            UserDefaults.standard.set(newValue?.absoluteString, forKey: "workspace")
            // nil forgets the saved address, so it leaves the list too.
            let updated = newValue.map { list.contains($0) ? list : list + [$0] } ?? list.filter { $0 != old }
            UserDefaults.standard.set(updated.map(\.absoluteString), forKey: "workspaces")
        }
    }

    /// Takes a workspace off the list. Forgetting the saved one means the next launch asks.
    static func forget(_ origin: URL) {
        let list = known.filter { $0 != origin }
        if saved == origin { UserDefaults.standard.removeObject(forKey: "workspace") }
        UserDefaults.standard.set(list.map(\.absoluteString), forKey: "workspaces")
    }

    /// Every workspace opened on this Mac, in the order first opened. Builds before the list kept
    /// only the saved one, which counts as known.
    static var known: [URL] {
        let list = (UserDefaults.standard.stringArray(forKey: "workspaces") ?? []).compactMap(origin)
        guard let saved = UserDefaults.standard.string(forKey: "workspace").flatMap(origin), !list.contains(saved) else { return list }
        return list + [saved]
    }

    /// "ai-guild", "ai-guild.slirc.app" and "https://ai-guild.slirc.app/x" all mean one origin, and
    /// the answer is always https://<host>. Any other scheme, a port, or userinfo is refused.
    static func origin(_ value: String) -> URL? {
        var text = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // An explicit dev stack set in SLIRC_DEV_ORIGIN is the one address allowed a port.
        if let dev = devOrigin, text == dev.absoluteString.lowercased() { return dev }
        if text.contains("://") {
            guard text.hasPrefix("https://") else { return nil }
            text = String(text.dropFirst("https://".count))
        }
        var host = String(text.split(whereSeparator: { "/?#".contains($0) }).first ?? "")
        if host.hasSuffix(".") { host.removeLast() }
        let label = "[a-z0-9]([a-z0-9-]*[a-z0-9])?"
        guard host.range(of: "^\(label)(\\.\(label))*$", options: .regularExpression) != nil else { return nil }
        if !host.contains(".") { host += ".slirc.app" }
        return URL(string: "https://" + host)
    }

    /// The route a typed address points at, such as a channel, relative to its workspace's origin.
    /// "https://ai-guild.slirc.app/#dev-open" and "ai-guild/#dev-open" both give "/#dev-open". It
    /// follows the same reading as origin(_:), so the path always belongs to the origin loaded.
    static func path(_ value: String) -> String {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard origin(text) != nil, let url = URL(string: text.contains("://") ? text : "https://" + text) else { return "/" }
        return (url.path.isEmpty ? "/" : url.path)
            + (url.query.map { "?" + $0 } ?? "") + (url.fragment.map { "#" + $0 } ?? "")
    }

    /// Every *.slirc.app name answers, because unclaimed ones serve the Slirc site. A workspace is a
    /// host whose /api/version returns its client version as JSON. No answer (offline, a timeout, a
    /// restart in progress) is "unknown", never proof that the workspace is gone.
    static func check(_ origin: URL, done: @escaping (Answer) -> Void) {
        var request = URLRequest(url: origin.appendingPathComponent("api/version"), timeoutInterval: 5)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: .main)
        session.dataTask(with: request) { data, response, error in
            session.finishTasksAndInvalidate()
            guard error == nil, let status = (response as? HTTPURLResponse)?.statusCode else { return done(.unknown) }
            if status >= 500 { return done(.unknown) }
            let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
            let version = body?["version"].map { "\($0)" } ?? ""
            let looksRight = version.range(of: "^[0-9a-f]{6,40}$", options: .regularExpression) != nil
            done(status == 200 && looksRight ? .yes : .no)
        }.resume()
    }

    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }
}

/// The workspace web view. Pages from the workspace's own address stay in it; any other address
/// opens in the default browser. It tags the page with `mac-shell` so the web client can make room
/// for the window controls, and tells the title bar strip whether the pointer is over something
/// clickable, since WKWebView has no `-webkit-app-region`. The page's "Switch workspace" button can
/// also open the workspace picker, its workspace dialog can open a workspace, and Settings can turn on
/// notifications, which the page then hands to the app to show. The page can tell the app nothing else.
final class ShellWebView: WKWebView, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    /// Marks the Edit menu, whose shortcuts go to the page first. See performKeyEquivalent.
    static let editMenu = NSUserInterfaceItemIdentifier("edit")
    var onUnreachable: (() -> Void)?
    var onLoaded: (() -> Void)?
    var onSignedOut: (() -> Void)?
    var onSwitchWorkspace: (() -> Void)?
    var onOpenWorkspace: ((String) -> Void)?
    var onUnread: ((Int) -> Void)?
    /// True while the pointer, inside the title bar strip, is over a button, link or field. The strip
    /// then lets clicks through to the page.
    private(set) var pointerOnControl = false
    private let workspace: URL

    // Runs at the start of every main-frame page. It hides CSS anchor positioning: WebKit places an
    // anchored popup as far below its button as the transcript has scrolled, and the web client
    // checks CSS.supports before using it. As the pointer moves through the top 52 px, the height of
    // the title bar strip, it reports whether the element under it is clickable. That works on every
    // screen, the sign-in screen included, and doesn't depend on the page's markup.
    private static let chromeScript = """
    document.documentElement.classList.add('mac-shell');
    (() => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (...args) => args.join(' ').includes('anchor') ? false : supports(...args);
      const controls = 'button, a, input, select, textarea, label, summary, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="tab"], [role="menuitem"]';
      let last = false;
      document.addEventListener('mousemove', (event) => {
        const t = event.target;
        const onControl = event.clientY < \(TitleBarStrip.height) && t instanceof Element
          && (!!t.closest(controls) || getComputedStyle(t).cursor === 'pointer');
        if (onControl !== last) { last = onControl; window.webkit.messageHandlers.slircShell.postMessage(onControl ? 'control' : 'blank'); }
      }, { capture: true, passive: true });
    })();
    """

    init(workspace: URL) {
        self.workspace = workspace
        let configuration = WKWebViewConfiguration()
        super.init(frame: .zero, configuration: configuration)
        let content = configuration.userContentController
        content.addUserScript(WKUserScript(source: Self.chromeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.add(WeakHandler(self), name: "slircShell")
        // A handler of its own, so the page can tell this build from older ones, which lack it, and
        // show "Switch workspace" only where it works (app/client/native-shell.ts).
        content.add(WeakHandler(self), name: "slircSwitchWorkspace")
        // Notifications: the page asks for permission from Settings and hands over what the server
        // sent its account. Its presence tells the web client this build can show them.
        content.addScriptMessageHandler(WeakReplyHandler(self), contentWorld: .page, name: "slircNotify")
        // The page's own unread count, for the other workspaces' rails.
        content.add(WeakHandler(self), name: "slircUnread")
        // The workspaces opened on this Mac, for the page's workspace dialog. The app refreshes it
        // on every switch, since a pooled page outlives the list it was built with.
        let known = (try? JSONSerialization.data(withJSONObject: Workspace.known.map(\.absoluteString))).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        content.addUserScript(WKUserScript(source: "window.SlircWorkspaces = Object.freeze(\(known));", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        navigationDelegate = self
        uiDelegate = self
        #if DEBUG
        isInspectable = true
        #endif
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    private func isWorkspace(_ url: URL?) -> Bool {
        guard let url,
              url.scheme?.lowercased() == "https",
              url.user == nil,
              url.password == nil,
              let host = url.host?.lowercased(),
              let workspaceHost = workspace.host?.lowercased(),
              !host.isEmpty else { return false }
        return host == workspaceHost && (url.port ?? 443) == (workspace.port ?? 443)
    }

    private func openOutside(_ url: URL?) {
        guard let url, ["http", "https", "mailto"].contains(url.scheme ?? "") else { return }
        NSWorkspace.shared.open(url)
    }

    // MARK: Keyboard

    // App menu shortcuts come before the page. As first responder, WKWebView answers yes to every
    // key equivalent and hands it to the page, and gives it back to the menu bar only if the page
    // reports it unhandled. A focused field, as on the sign-in screen, can report Option-Cmd-O
    // handled, so Switch Workspace never ran. The Slirc, View and Window menus now try the key
    // first. The Edit menu doesn't: copy, paste, select all and undo go to the page, and so does
    // any key no menu item claims.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let appMenus = NSApp.mainMenu?.items.filter { $0.identifier != Self.editMenu }.compactMap(\.submenu) ?? []
        if appMenus.contains(where: { $0.performKeyEquivalent(with: event) }) { return true }
        return super.performKeyEquivalent(with: event)
    }

    // MARK: Messages from the page

    /// Only the workspace's own top-level page may talk to the app.
    private func fromWorkspace(_ message: WKScriptMessage) -> Bool {
        let origin = message.frameInfo.securityOrigin
        let originPort = origin.port == 0 ? 443 : origin.port
        return message.frameInfo.isMainFrame
            && origin.protocol == "https"
            && origin.host.lowercased() == workspace.host?.lowercased()
            && originPort == (workspace.port ?? 443)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // A page can at most make the strip let a click through, which is what a browser tab does
        // with every click anyway, or open the workspace picker, which the menu bar offers too.
        guard fromWorkspace(message) else { return }
        if message.name == "slircSwitchWorkspace" {
            // After the message returns: opening the picker or a workspace covers this view.
            // { open: origin } comes from the page's workspace dialog, { signedOut: true } from
            // signing out, and anything else, null included, shows the picker.
            let picked = (message.body as? [String: Any])?["open"] as? String
            let left = (message.body as? [String: Any])?["signedOut"] != nil
            DispatchQueue.main.async { [weak self] in
                if let picked { self?.onOpenWorkspace?(picked) }
                else if left { self?.onSignedOut?() }
                else { self?.onSwitchWorkspace?() }
            }
            return
        }
        if message.name == "slircUnread" {
            let count = (message.body as? [String: Any])?["count"] as? Int ?? 0
            DispatchQueue.main.async { [weak self] in self?.onUnread?(max(0, count)) }
            return
        }
        guard let state = message.body as? String else { return }
        pointerOnControl = state == "control"
    }

    // MARK: Notifications

    /// slircNotify: { action: "status" } and { action: "request" } answer { permission }, granted,
    /// denied or default, and request shows the system prompt once. { action: "show", title, body,
    /// tag, path } posts a notification; clicking it opens this workspace on path (AppDelegate).
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard fromWorkspace(message) else { return replyHandler(nil, "This page can't use notifications.") }
        let body = message.body as? [String: Any] ?? [:]
        let center = UNUserNotificationCenter.current()
        switch body["action"] as? String {
        case "status":
            Task { @MainActor in replyHandler(["permission": Self.permission(await center.notificationSettings())], nil) }
        case "request":
            Task { @MainActor in
                _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
                replyHandler(["permission": Self.permission(await center.notificationSettings())], nil)
            }
        case "show":
            guard let title = body["title"] as? String, let text = body["body"] as? String else { return replyHandler(nil, "Nothing to show.") }
            let raw = body["path"] as? String ?? "/"
            let path = raw.hasPrefix("/") && !raw.hasPrefix("//") ? raw : "/"
            let note = UNMutableNotificationContent()
            note.title = String(title.prefix(200))
            note.body = String(text.prefix(1000))
            note.sound = .default
            note.threadIdentifier = workspace.absoluteString + path
            note.userInfo = ["origin": workspace.absoluteString, "path": path]
            // The same tag replaces the notification before it, as web push does.
            let tag = body["tag"] as? String ?? ""
            let id = tag.isEmpty ? UUID().uuidString : workspace.absoluteString + " " + tag
            center.add(UNNotificationRequest(identifier: id, content: note, trigger: nil))
            replyHandler([:], nil)
        default:
            replyHandler(nil, "Unknown action.")
        }
    }

    private static func permission(_ settings: UNNotificationSettings) -> String {
        switch settings.authorizationStatus {
        case .authorized, .provisional: return "granted"
        case .denied: return "denied"
        default: return "default"
        }
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Frames inside the page (video and other embeds) load as in a browser. The page itself
        // never leaves the workspace: a link to anywhere else opens in the default browser.
        let mainFrame = action.targetFrame?.isMainFrame ?? true
        if !mainFrame || isWorkspace(action.request.url) || action.request.url?.scheme == "about" {
            return decisionHandler(.allow)
        }
        openOutside(action.request.url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let code = (error as NSError).code
        if code == NSURLErrorCancelled || code == 102 { return } // 102: WebKit's "frame load interrupted"
        onUnreachable?()
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        onLoaded?()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: Browser UI the page asks for

    // target="_blank" links and window.open: the workspace in place, anything else in the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if isWorkspace(action.request.url) { webView.load(action.request) } else { openOutside(action.request.url) }
        return nil
    }

    // <input type="file">, for uploads and the profile photo.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        guard let window else { return completionHandler(nil) }
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }
}

/// The title bar strip: the top 52 pt of the window, the height of the title bar and of the web
/// header inside the app. WKWebView takes every mouse-down, so the window could never be dragged
/// by its title bar. The strip takes presses there instead and starts the drag inside AppKit's own
/// mouse-down, as a real title bar does, unless the pointer is over a control on the page. The
/// window controls sit above it and stay clickable.
final class TitleBarStrip: NSView {
    static let height: CGFloat = 52
    /// The page on screen, whose controls let the click through to it.
    weak var webView: WKWebView?

    init(webView: WKWebView? = nil) {
        self.webView = webView
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard frame.contains(point), (webView as? ShellWebView)?.pointerOnControl != true else { return nil }
        return self
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        guard event.clickCount == 2 else { return window.performDrag(with: event) }
        // Follow System Settings, Desktop & Dock, "Double-click a window's title bar to".
        switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
        case "Minimize": window.miniaturize(nil)
        case "None": break
        default: window.zoom(nil)
        }
    }

    // A right-click on the strip still reaches the page, for its context menu.
    override func rightMouseDown(with event: NSEvent) { webView?.rightMouseDown(with: event) }
}

/// A page bundled in the app (Slirc/Picker): the workspace picker (picker.html, see mac-picker.js)
/// or the unreachable screen (unreachable.html, see mac-unreachable.js). The picker gets the saved
/// workspaces as window.SlircPicker, the unreachable screen its address as window.SlircUnreachable,
/// and both post what was picked to slircPicker. They load nothing from the network: the app checks
/// every address the picker sends.
final class PickerView: WKWebView, WKScriptMessageHandler, WKNavigationDelegate {
    var onMessage: (([String: Any]) -> Void)?
    private let name: String

    init(state: [String: Any], name: String = "picker") {
        self.name = name
        let configuration = WKWebViewConfiguration()
        super.init(frame: .zero, configuration: configuration)
        let json = (try? JSONSerialization.data(withJSONObject: state)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let content = configuration.userContentController
        let global = name == "picker" ? "SlircPicker" : "SlircUnreachable"
        content.addUserScript(WKUserScript(source: "window.\(global) = Object.freeze(\(json));", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.add(WeakHandler(self), name: "slircPicker")
        navigationDelegate = self
        #if DEBUG
        isInspectable = true
        #endif
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func loadPage() {
        guard let page = Bundle.main.url(forResource: name, withExtension: "html")
            ?? Bundle.main.url(forResource: name, withExtension: "html", subdirectory: "Picker") else { return }
        loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }

    /// The app's answer when an address fails its check: the page shows why and keeps the text.
    func failed(_ message: String, text: String) {
        let args = (try? JSONSerialization.data(withJSONObject: [message, text])).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        evaluateJavaScript("window.slircPickerFailed(...\(args))")
    }

    /// The unreachable screen's answer when Try Again fails again: its buttons come back.
    func retryFailed() {
        evaluateJavaScript("window.slircUnreachableFailed()")
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.isFileURL == true,
              let body = message.body as? [String: Any] else { return }
        // After the message returns, since opening a workspace replaces this view.
        DispatchQueue.main.async { [weak self] in self?.onMessage?(body) }
    }

    // The page never leaves itself.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url?.isFileURL == true ? .allow : .cancel)
    }
}

/// The workspace's notifications. While Slirc is the active app they show as banners too, since the
/// page skips the conversation already on screen. A click opens that workspace on the conversation,
/// switching to it if another one is showing.
extension AppDelegate: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let origin = (info["origin"] as? String).flatMap(URL.init(string:))
        let path = info["path"] as? String ?? "/"
        completionHandler()
        Task { @MainActor in
            NSApp.activate(ignoringOtherApps: true)
            guard let origin, Workspace.known.contains(origin) else { return }
            self.open(origin, path: path)
        }
    }
}

/// The reply-capable twin of WeakHandler, for messages the page awaits.
private final class WeakReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: WKScriptMessageHandlerWithReply?
    init(_ target: WKScriptMessageHandlerWithReply) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let target else { return replyHandler(nil, "The page is gone.") }
        target.userContentController(controller, didReceive: message, replyHandler: replyHandler)
    }
}

/// WKUserContentController keeps its handlers alive, so this breaks the cycle with the view.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
