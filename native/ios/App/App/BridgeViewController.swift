import Capacitor
import WebKit

// The bridge is Capacitor's channel from page JavaScript to native plugins. The bundled picker,
// served from the app's own origin, may call every plugin. A workspace page is a remote site, so
// it may call only the methods listed here, written "PluginId.method". Frames inside a page may
// call nothing. Workspace pages still get `window.Capacitor`, so the web client can tell it runs
// in the shell.
let workspaceBridgeMethods: Set<String> = [
    "SlircShell.switchWorkspace",
    "SlircShell.workspaces",
]

// Tracks the verified workspace origin currently loaded in the WebView. Only the bundled picker
// may set it (via SlircShell.openWorkspace); SlircShellPlugin.shouldOverrideLoad allows main-frame
// navigation only within this origin, and BridgeGuard limits workspace bridge calls to it.
final class WorkspaceNavigationState {
    private(set) var activeOrigin: URL?

    func setActive(_ url: URL) {
        activeOrigin = url
    }

    func clear() {
        activeOrigin = nil
    }

    static func isValidWorkspaceURL(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https",
              url.user == nil,
              url.password == nil,
              let host = url.host?.lowercased(),
              !host.isEmpty else { return false }
        if let port = url.port, port != 443 { return false }
        return true
    }

    func isActiveOrigin(_ url: URL) -> Bool {
        guard let active = activeOrigin,
              Self.isValidWorkspaceURL(url),
              let host = url.host?.lowercased(),
              let activeHost = active.host?.lowercased() else { return false }
        return host == activeHost && (url.port ?? 443) == (active.port ?? 443)
    }

    func matchesSecurityOrigin(_ origin: WKSecurityOrigin) -> Bool {
        guard let active = activeOrigin,
              origin.protocol == "https",
              let activeHost = active.host?.lowercased() else { return false }
        let activePort = active.port ?? 443
        let originPort = origin.port == 0 ? 443 : origin.port
        return origin.host.lowercased() == activeHost && originPort == activePort
    }
}

class BridgeViewController: CAPBridgeViewController {
    private var bridgeGuard: BridgeGuard?
    private var loadGuard: CancelledLoadGuard?
    private let workspaceState = WorkspaceNavigationState()
    private lazy var loadWatch = WorkspaceLoadWatch(workspaceState: workspaceState) { [weak self] origin in
        self?.showUnreachable(origin)
    }

    // The launch screen's background shows behind and between pages, so a page change never flashes
    // the web view's default white or black.
    override func viewDidLoad() {
        super.viewDidLoad()
        guard let background = UIColor(named: "LaunchBackground") else { return }
        view.backgroundColor = background
        webView?.backgroundColor = background
        webView?.scrollView.backgroundColor = background
        webView?.underPageBackgroundColor = background
    }

    // Runs inside loadView, before the first page loads. Capacitor builds its own message handler
    // there, so the guard takes that handler's place and passes on what it allows.
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let bridge = bridge as? CapacitorBridge, let webView = webView else { return }
        let handler = bridge.webViewDelegationHandler
        let bridgeGuard = BridgeGuard(handler: handler, localURL: bridge.config.localURL, workspaceState: workspaceState)
        handler.contentController.removeScriptMessageHandler(forName: BridgeGuard.handlerName)
        handler.contentController.add(bridgeGuard, name: BridgeGuard.handlerName)
        webView.uiDelegate = bridgeGuard
        self.bridgeGuard = bridgeGuard
        let loadGuard = CancelledLoadGuard(handler: handler, loadWatch: loadWatch)
        webView.navigationDelegate = loadGuard
        self.loadGuard = loadGuard
        bridge.registerPluginInstance(SlircShellPlugin(workspaceState: workspaceState, loadWatch: loadWatch))
        handler.contentController.addUserScript(WKUserScript(source: noFocusZoomScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        hideFormAccessoryBar(in: webView)
        handler.contentController.addUserScript(WKUserScript(source: shellInfoScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    // A link the app was opened with: an https Universal Link, or slirc://<host>/<path>. It goes to
    // the picker as ?link=, and picker.js decides whether to open it with the same host checks as a
    // typed address, so a new workspace gets saved too.
    func open(link: URL) {
        loadViewIfNeeded()
        showPicker(query: "link", value: link.absoluteString)
    }

    // A workspace that failed to load, or loaded without its client starting, goes back to the
    // picker as ?unreachable=<origin>. The picker lists the saved workspaces with that one marked
    // "Couldn't reach" and offers Try again.
    func showUnreachable(_ origin: String) {
        showPicker(query: "unreachable", value: origin)
    }

    private func showPicker(query: String, value: String) {
        loadWatch.stop()
        workspaceState.clear()
        guard let bridge = bridge, var picker = URLComponents(url: bridge.config.localURL, resolvingAgainstBaseURL: false),
              let value = value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { return }
        picker.path = "/index.html"
        picker.percentEncodedQuery = query + "=" + value
        if let url = picker.url { _ = bridge.webView?.load(URLRequest(url: url)) }
    }
}

// A workspace that hangs, such as a shut-down server whose name still resolves, would otherwise
// leave the web view on a blank page for a minute or more, and a page that loads but never starts
// the client would leave it there for good. The watch starts when the picker opens a workspace.
// The workspace must answer within timeout seconds, and then the client must start within timeout
// seconds more: the web client removes the "booting" class from <html> once its first
// account check answers. A failed load (see CancelledLoadGuard) or a missed deadline stops the
// load and calls onFailure with the workspace origin, which shows the picker.
final class WorkspaceLoadWatch {
    static let timeout: TimeInterval = 5
    static let readyScript = "!!document.querySelector('[data-client-root]') && !document.documentElement.classList.contains('booting')"
    private let workspaceState: WorkspaceNavigationState
    private let onFailure: (String) -> Void
    private weak var webView: WKWebView?
    private var watching: String?
    private var loaded = false
    private var generation = 0

    init(workspaceState: WorkspaceNavigationState, onFailure: @escaping (String) -> Void) {
        self.workspaceState = workspaceState
        self.onFailure = onFailure
    }

    static func origin(of url: URL) -> String? {
        guard WorkspaceNavigationState.isValidWorkspaceURL(url), let host = url.host?.lowercased() else { return nil }
        return "https://" + host
    }

    func start(_ url: URL, in webView: WKWebView?) {
        stop()
        guard let origin = Self.origin(of: url) else { return }
        self.webView = webView
        watching = origin
        let current = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.timeout) { [weak self] in
            guard let self = self, self.generation == current, !self.loaded else { return }
            CAPLog.print("⚡️  Workspace did not answer in time")
            self.fail()
        }
    }

    func stop() {
        generation += 1
        watching = nil
        loaded = false
    }

    // The workspace answered and its page is loading: give the client its own deadline to start.
    func didCommit(_ webView: WKWebView) {
        guard watching != nil, !loaded, let url = webView.url, workspaceState.isActiveOrigin(url) else { return }
        loaded = true
        let current = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.timeout) { [weak self, weak webView] in
            guard let self = self, self.generation == current, let webView = webView else { return }
            webView.evaluateJavaScript(Self.readyScript) { [weak self] result, _ in
                guard let self = self, self.generation == current else { return }
                if result as? Bool == true {
                    self.stop()
                } else {
                    CAPLog.print("⚡️  Workspace client did not start in time")
                    self.fail()
                }
            }
        }
    }

    // A real load failure. Returns false when no workspace is open, so Capacitor's own error page
    // handles it.
    func didFail() -> Bool {
        guard let origin = watching ?? workspaceState.activeOrigin.flatMap(Self.origin(of:)) else { return false }
        fail(origin)
        return true
    }

    private func fail(_ known: String? = nil) {
        guard let origin = known ?? watching else { return }
        stop()
        // Stopping reports the load as cancelled, which CancelledLoadGuard ignores.
        webView?.stopLoading()
        onFailure(origin)
    }
}

// iOS zooms the page into any form field with text under 16px and leaves it zoomed, which pushes
// the page past the right edge. Several web client fields are 14px. A viewport capped at scale 1
// stops that zoom on every page the shell shows. It adds a user script and leaves the bridge alone.
let noFocusZoomScript = """
(() => {
  const meta = document.querySelector("meta[name=viewport]");
  if (meta && !/maximum-scale/.test(meta.content)) meta.content += ", maximum-scale=1";
})();
"""

// Tells pages the app's version and build number, which the web client shows under About. It is a
// plain value set by native code, so pages learn it without a bridge call.
func shellInfoScript() -> String {
    let info = Bundle.main.infoDictionary ?? [:]
    let values = ["version": info["CFBundleShortVersionString"] as? String ?? "", "build": info["CFBundleVersion"] as? String ?? ""]
    let json = (try? JSONSerialization.data(withJSONObject: values)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    return "window.SlircShellInfo = Object.freeze(\(json));"
}

// Hides the bar with up, down and Done that iOS shows above the keyboard for web form fields. The
// web view's content view supplies that bar as its inputAccessoryView, so it gets a subclass that
// supplies none. Capacitor's Keyboard plugin does the same. The change is native, so it covers
// workspace pages without letting them call anything.
func hideFormAccessoryBar(in webView: WKWebView) {
    guard let content = webView.scrollView.subviews.first(where: { NSStringFromClass(type(of: $0)).hasPrefix("WKContent") }) else { return }
    let base: AnyClass = type(of: content)
    let name = NSStringFromClass(base) + "_SlircNoAccessoryBar"
    var subclass: AnyClass? = NSClassFromString(name)
    if subclass == nil, let made = objc_allocateClassPair(base, name, 0) {
        let selector = #selector(getter: UIResponder.inputAccessoryView)
        let none: @convention(block) (AnyObject) -> AnyObject? = { _ in nil }
        if let method = class_getInstanceMethod(UIResponder.self, selector) {
            class_addMethod(made, selector, imp_implementationWithBlock(none), method_getTypeEncoding(method))
        }
        objc_registerClassPair(made)
        subclass = made
    }
    if let subclass = subclass { object_setClass(content, subclass) }
}

// The shell's own calls for the picker and workspace pages. openWorkspace is callable only from
// the bundled picker (not in workspaceBridgeMethods): it records the verified workspace origin and
// loads it. switchWorkspace returns the web view to the picker, which lists the saved workspaces.
// With a link, such as another workspace's pairing link, the picker gets it as ?link= and opens it
// under its usual host checks, saving that workspace. The web client shows "Switch workspace" only
// when this plugin is there.
@objc(SlircShellPlugin)
class SlircShellPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "SlircShellPlugin"
    let jsName = "SlircShell"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openWorkspace", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "switchWorkspace", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "workspaces", returnType: CAPPluginReturnPromise),
    ]
    private let workspaceState: WorkspaceNavigationState
    private let loadWatch: WorkspaceLoadWatch

    init(workspaceState: WorkspaceNavigationState, loadWatch: WorkspaceLoadWatch) {
        self.workspaceState = workspaceState
        self.loadWatch = loadWatch
        super.init()
    }

    // Keeps main-frame navigation within the active verified workspace's origin inside the WebView.
    // Returning false tells Capacitor's WebViewDelegationHandler to allow the load; returning nil
    // lets it fall through to its default policy (allow local picker / subframes, open external
    // top-level links in Safari).
    override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url else { return nil }
        let toplevel = navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == true
        if toplevel && workspaceState.isActiveOrigin(url) {
            return NSNumber(value: false)
        }
        return nil
    }

    // Callable only from the bundled picker (BridgeGuard refuses it from remote pages). Records
    // the verified workspace origin so shouldOverrideLoad keeps same-origin navigation in-app.
    @objc func openWorkspace(_ call: CAPPluginCall) {
        guard let bridge = bridge,
              let raw = call.getString("url"),
              let url = URL(string: raw),
              WorkspaceNavigationState.isValidWorkspaceURL(url) else {
            call.reject("Invalid workspace address.")
            return
        }
        workspaceState.setActive(url)
        call.resolve()
        DispatchQueue.main.async { [loadWatch] in
            loadWatch.start(url, in: bridge.webView)
            _ = bridge.webView?.load(URLRequest(url: url))
        }
    }

    // The picker's saved workspaces, for the web client's workspace dialog. The picker keeps them
    // through the Preferences plugin, which stores "workspaces" as a JSON array of origins under
    // CapacitorStorage.workspaces. Read only: adding and removing stay in the picker.
    @objc func workspaces(_ call: CAPPluginCall) {
        let raw = UserDefaults.standard.string(forKey: "CapacitorStorage.workspaces") ?? "[]"
        let list = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String] ?? []
        call.resolve(["workspaces": list])
    }

    @objc func switchWorkspace(_ call: CAPPluginCall) {
        guard let bridge = bridge, var picker = URLComponents(url: bridge.config.localURL, resolvingAgainstBaseURL: false) else {
            call.reject("The picker is unavailable.")
            return
        }
        loadWatch.stop()
        workspaceState.clear()
        picker.path = "/index.html"
        if let link = call.getString("link"), let value = link.addingPercentEncoding(withAllowedCharacters: .alphanumerics) {
            picker.percentEncodedQuery = "link=" + value
        } else {
            picker.query = "pick=1"
        }
        call.resolve()
        DispatchQueue.main.async {
            if let url = picker.url { _ = bridge.webView?.load(URLRequest(url: url)) }
        }
    }
}

// Capacitor takes page calls over two channels: the "bridge" script message handler, and
// synchronous prompt() calls for its cookie and HTTP patches. The cookie one can set a cookie for
// any domain. The guard checks which frame sent each message and passes allowed ones to
// Capacitor's handler. Every other UI delegate call, such as the camera permission, goes to that
// handler unchanged.
final class BridgeGuard: NSObject, WKScriptMessageHandler, WKUIDelegate {
    static let handlerName = "bridge"
    private weak var handler: WebViewDelegationHandler?
    private let localURL: URL
    private let workspaceState: WorkspaceNavigationState

    init(handler: WebViewDelegationHandler, localURL: URL, workspaceState: WorkspaceNavigationState) {
        self.handler = handler
        self.localURL = localURL
        self.workspaceState = workspaceState
    }

    private func isLocal(_ frame: WKFrameInfo) -> Bool {
        let origin = frame.securityOrigin
        return frame.isMainFrame && origin.protocol == localURL.scheme && origin.host == localURL.host
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let handler = handler else { return }
        let body = message.body as? [String: Any] ?? [:]
        let type = body["type"] as? String
        let call = "\(body["pluginId"] as? String ?? "").\(body["methodName"] as? String ?? "")"
        let fromWorkspace = message.frameInfo.isMainFrame && workspaceState.matchesSecurityOrigin(message.frameInfo.securityOrigin)
        // js.error only writes a page error to the Xcode log.
        if isLocal(message.frameInfo) || (fromWorkspace && (type == "js.error" || (type == "message" && workspaceBridgeMethods.contains(call)))) {
            handler.userContentController(controller, didReceive: message)
            return
        }
        CAPLog.print("⚡️  Refused \(call) from \(message.frameInfo.securityOrigin.host)")
        refuse(message, body: body)
    }

    // Rejects the call's promise so page code sees an error instead of waiting forever. Calls
    // without a callback, such as console forwarding, get no answer: an answer with no callback
    // is logged with console.warn, which would send another refused call.
    private func refuse(_ message: WKScriptMessage, body: [String: Any]) {
        guard message.frameInfo.isMainFrame,
              let callbackId = body["callbackId"] as? String, callbackId != "-1",
              let result = try? JSONSerialization.data(withJSONObject: [
                  "callbackId": callbackId,
                  "pluginId": body["pluginId"] as? String ?? "",
                  "methodName": body["methodName"] as? String ?? "",
                  "success": false,
                  "error": ["message": "This page can't use that feature of the app.", "code": "UNAVAILABLE"],
              ]),
              let json = String(data: result, encoding: .utf8) else { return }
        message.webView?.evaluateJavaScript("window.Capacitor?.fromNative?.(\(json))", in: message.frameInfo, in: .page)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        if !isLocal(frame), let data = prompt.data(using: .utf8),
           let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           (payload["type"] as? String)?.hasPrefix("Capacitor") == true {
            // No answer reads as "off", so the page keeps the web view's own cookies and fetch.
            completionHandler(nil)
            return
        }
        guard let handler = handler else { return completionHandler(nil) }
        handler.webView(webView, runJavaScriptTextInputPanelWithPrompt: prompt, defaultText: defaultText, initiatedByFrame: frame, completionHandler: completionHandler)
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (handler?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        handler
    }
}

// A failed navigation while a workspace is open goes to WorkspaceLoadWatch, which shows the picker
// with that workspace marked "Couldn't reach". Other failures reach Capacitor, which loads its
// errorPath (unreachable.html, which opens the picker with "couldn't reach your workspace"). WebKit also reports a cancelled load as a failure: a page
// restored from the back/forward cache, such as history.go(-1) from the docs back to the app, ends
// with NSURLErrorCancelled, and so does a load that a newer navigation replaced. Neither means the
// workspace is unreachable, so the guard drops those two calls and passes every other navigation
// delegate call to Capacitor's handler.
final class CancelledLoadGuard: NSObject, WKNavigationDelegate {
    private weak var handler: WebViewDelegationHandler?
    private let loadWatch: WorkspaceLoadWatch

    init(handler: WebViewDelegationHandler, loadWatch: WorkspaceLoadWatch) {
        self.handler = handler
        self.loadWatch = loadWatch
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        loadWatch.didCommit(webView)
    }

    static func isCancelled(_ error: Error) -> Bool {
        let error = error as NSError
        return error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if Self.isCancelled(error) {
            CAPLog.print("⚡️  Ignored a cancelled load")
            return
        }
        CAPLog.print("⚡️  Load failed: " + error.localizedDescription)
        if loadWatch.didFail() { return }
        handler?.webView(webView, didFail: navigation, withError: error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if Self.isCancelled(error) {
            CAPLog.print("⚡️  Ignored a cancelled provisional load")
            return
        }
        CAPLog.print("⚡️  Provisional load failed: " + error.localizedDescription)
        if loadWatch.didFail() { return }
        handler?.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (handler?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        handler
    }
}
