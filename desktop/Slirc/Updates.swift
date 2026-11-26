// Sparkle updates with a toast in place of Sparkle's windows. Sparkle checks the appcast once a day
// and on "Check for Updates…". A new version downloads in the background, then a dark HUD toast
// in the window's top-right corner says it is ready, in lime. It installs only when that toast or its
// "Relaunch Now" is clicked:
// closing the toast, or quitting Slirc, cancels the install, and the next check offers it again.
// Replies matter here. To showReady(toInstallAndRelaunch:), .skip cancels the install without
// skipping the version. To showUpdateFound, .skip would skip the version for good, so the toast
// never answers it that way.
// See desktop/README.md, Updates.
import AppKit
import Sparkle

@MainActor
final class Updates: NSObject, SPUUserDriver {
    private var updater: SPUUpdater?
    /// Puts a toast in the window, or clears it with nil.
    var show: (Toast.Message?) -> Void = { _ in }
    /// The reply Sparkle waits for while the update toast is up.
    private var readyReply: ((SPUUserUpdateChoice) -> Void)?
    /// What closing the toast or quitting answers to readyReply. See the note at the top.
    private var decline: SPUUserUpdateChoice = .skip
    private var userInitiated = false

    override init() {
        super.init()
        let info = Bundle.main.infoDictionary
        let feed = (info?["SUFeedURL"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let key = (info?["SUPublicEDKey"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !feed.isEmpty, !key.isEmpty else { return }
        let updater = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: self, delegate: nil)
        do {
            try updater.start()
            self.updater = updater
        } catch {
            NSLog("Sparkle did not start: %@", error.localizedDescription)
        }
    }

    @objc func checkForUpdates(_ sender: Any?) {
        guard let updater else {
            note("Updates are not configured in this build", symbol: "exclamationmark.circle.fill")
            return
        }
        userInitiated = true
        updater.checkForUpdates()
    }

    /// Called on quit. An update nobody clicked must not install when Slirc quits, so the waiting
    /// install is canceled first. Returns false when there was nothing to cancel.
    func cancelPendingInstall() -> Bool {
        guard let reply = readyReply else { return false }
        readyReply = nil
        reply(decline)
        return true
    }

    private func ready(_ reply: @escaping (SPUUserUpdateChoice) -> Void, decline: SPUUserUpdateChoice) {
        readyReply = reply
        self.decline = decline
        show(Toast.Message(text: Toast.readyText, symbol: "checkmark.circle.fill", ready: true,
            click: { [weak self] in self?.answer(.install) },
            close: { [weak self] in self?.answer(nil) }, action: "Relaunch Now"))
    }

    /// nil is the toast's close button.
    private func answer(_ choice: SPUUserUpdateChoice?) {
        show(nil)
        let reply = readyReply
        readyReply = nil
        reply?(choice ?? decline)
    }

    private func note(_ text: String, symbol: String) {
        show(Toast.Message(text: text, symbol: symbol, ready: false, click: nil, close: { [weak self] in self?.show(nil) }))
    }

    // MARK: SPUUserDriver

    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
        // SUEnableAutomaticChecks in Info.plist answers this already, so Sparkle shouldn't ask.
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, sendSystemProfile: false))
    }

    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {}

    func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        if appcastItem.isInformationOnlyUpdate { return reply(.dismiss) }
        // An install that was armed already goes straight to the update toast. The toast's own
        // replies never leave one armed, so this should be rare. Declining it has to be .dismiss,
        // which keeps the version on offer but still installs on quit. Anything else starts or resumes the download.
        if state.stage == .installing { return ready(reply, decline: .dismiss) }
        if userInitiated { note("Downloading Slirc \(appcastItem.displayVersionString)…", symbol: "arrow.down.circle.fill") }
        reply(.install)
    }

    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: any Error) {}

    func showUpdateNotFoundWithError(_ error: any Error, acknowledgement: @escaping () -> Void) {
        if userInitiated { note("Slirc is up to date", symbol: "checkmark.circle.fill") }
        userInitiated = false
        acknowledgement()
    }

    func showUpdaterError(_ error: any Error, acknowledgement: @escaping () -> Void) {
        // A background check that fails, offline say, stays quiet.
        if userInitiated { note("Couldn't check for updates", symbol: "exclamationmark.circle.fill") }
        userInitiated = false
        acknowledgement()
    }

    func showDownloadInitiated(cancellation: @escaping () -> Void) {}
    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {}
    func showDownloadDidReceiveData(ofLength length: UInt64) {}
    func showDownloadDidStartExtractingUpdate() {}
    func showExtractionReceivedProgress(_ progress: Double) {}

    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        userInitiated = false
        ready(reply, decline: .skip)
    }

    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {}

    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) { acknowledgement() }

    func showUpdateInFocus() {
        if let reply = readyReply { ready(reply, decline: decline) }
    }

    func dismissUpdateInstallation() {
        userInitiated = false
        // Sparkle ends every check with this. A note stays until it times out; the update toast
        // goes, since its install is over.
        if readyReply != nil { readyReply = nil; show(nil) }
    }
}

/// A dark HUD pill in the window's top-right corner, under the title bar, like Rex's: an icon, a line of
/// text, an optional lime button and a bare close x. Dark in both appearances. While an update is
/// ready the icon and text are lime, the web client's --brand, and the pill or its button restarts.
/// Text wider than its slot slides sideways and back, pausing under the pointer, with Reduce Motion
/// on too, since the text would not fit otherwise. The tooltip holds the full text. Notes go after a few seconds.
final class Toast: NSView {
    struct Message {
        let text: String
        let symbol: String
        let ready: Bool
        let click: (() -> Void)?
        let close: () -> Void
        /// The lime button's title, "Relaunch Now" on the update toast.
        var action: String? = nil
    }

    /// #a6e3a1, var(--brand) in app/public/style.css.
    static let lime = NSColor(srgbRed: 166 / 255, green: 227 / 255, blue: 161 / 255, alpha: 1)
    /// The update toast's text. It installs on relaunch, and closing the toast cancels that.
    static let readyText = "Update ready. Relaunch to get the latest Slirc."
    /// The widest the text gets before it scrolls.
    static let textWidth: CGFloat = 230
    private static let marqueeKey = "marquee"
    /// The overflow the running marquee slides by, so a layout pass with the same width leaves it alone.
    private var marqueeOverflow: CGFloat = 0

    let message: Message
    private var timer: Timer?
    private let backdrop = NSVisualEffectView()
    private let clip = MarqueeClip()
    private let label: NSTextField

    init(_ message: Message) {
        self.message = message
        label = NSTextField(labelWithString: message.text)
        super.init(frame: .zero)
        appearance = NSAppearance(named: .darkAqua)
        wantsLayer = true
        backdrop.material = .hudWindow
        backdrop.blendingMode = .withinWindow
        backdrop.state = .active
        backdrop.wantsLayer = true
        backdrop.layer?.masksToBounds = true
        backdrop.translatesAutoresizingMaskIntoConstraints = false
        addSubview(backdrop)
        layer?.borderColor = NSColor(white: 1, alpha: 0.12).cgColor
        layer?.borderWidth = 1
        shadow = NSShadow()
        layer?.shadowOpacity = 0.25
        layer?.shadowRadius = 8
        layer?.shadowOffset = CGSize(width: 0, height: -2)

        let tint = message.ready ? Toast.lime : .white
        let icon = NSImageView(image: NSImage(systemSymbolName: message.symbol, accessibilityDescription: nil) ?? NSImage())
        icon.symbolConfiguration = .init(pointSize: 15, weight: .semibold)
        icon.contentTintColor = tint
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.textColor = tint
        label.toolTip = message.text
        label.lineBreakMode = .byClipping
        label.wantsLayer = true
        label.translatesAutoresizingMaskIntoConstraints = false
        clip.wantsLayer = true
        clip.layer?.masksToBounds = true
        clip.translatesAutoresizingMaskIntoConstraints = false
        clip.addSubview(label)
        // The slot gets its width in its own layout pass, after the toast's, so the marquee starts there.
        clip.onLayout = { [weak self] in self?.startMarquee() }

        var views: [NSView] = [icon, clip]
        if let action = message.action {
            let button = NSButton(title: action, target: self, action: #selector(actionTapped))
            button.isBordered = false
            button.wantsLayer = true
            button.layer?.backgroundColor = Toast.lime.withAlphaComponent(0.18).cgColor
            button.layer?.cornerRadius = 11
            button.attributedTitle = NSAttributedString(string: action, attributes: [
                .foregroundColor: Toast.lime, .font: NSFont.systemFont(ofSize: 12, weight: .semibold)])
            button.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                button.heightAnchor.constraint(equalToConstant: 22),
                button.widthAnchor.constraint(equalToConstant: button.intrinsicContentSize.width + 20),
            ])
            views.append(button)
        }
        let close = CloseButton(image: NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close") ?? NSImage(),
                                target: self, action: #selector(closeTapped))
        close.isBordered = false
        close.symbolConfiguration = .init(pointSize: 10, weight: .bold)
        close.contentTintColor = CloseButton.rest
        close.translatesAutoresizingMaskIntoConstraints = false
        views.append(close)
        let row = NSStackView(views: views)
        row.spacing = 8
        row.setCustomSpacing(6, after: views[views.count - 2])
        row.edgeInsets = NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 6)
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        let textWidth = clip.widthAnchor.constraint(equalToConstant: min(label.intrinsicContentSize.width, Toast.textWidth))
        NSLayoutConstraint.activate([
            backdrop.leadingAnchor.constraint(equalTo: leadingAnchor),
            backdrop.trailingAnchor.constraint(equalTo: trailingAnchor),
            backdrop.topAnchor.constraint(equalTo: topAnchor),
            backdrop.bottomAnchor.constraint(equalTo: bottomAnchor),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(equalToConstant: 34),
            close.widthAnchor.constraint(equalToConstant: 22),
            close.heightAnchor.constraint(equalToConstant: 22),
            textWidth,
            clip.heightAnchor.constraint(equalTo: label.heightAnchor),
            label.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            label.centerYAnchor.constraint(equalTo: clip.centerYAnchor),
            label.widthAnchor.constraint(equalToConstant: label.intrinsicContentSize.width),
        ])
        if !message.ready {
            timer = .scheduledTimer(withTimeInterval: 4, repeats: false) { _ in message.close() }
        }
    }

    fileprivate static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    /// Slides the text by its overflow and back, holding at each end; text that fits stays still.
    /// Runs after every layout of the text's slot. It needs the slot's real width, which the toast's own
    /// layout pass doesn't have yet, and restarts only when the overflow changes.
    private func startMarquee() {
        guard let layer = label.layer, clip.bounds.width > 0 else { return }
        let overflow = label.intrinsicContentSize.width - clip.bounds.width
        if abs(overflow - marqueeOverflow) < 0.5, layer.animation(forKey: Toast.marqueeKey) != nil { return }
        layer.removeAnimation(forKey: Toast.marqueeKey)
        marqueeOverflow = overflow
        guard overflow > 1 else { return }
        let slide = CAKeyframeAnimation(keyPath: "transform.translation.x")
        slide.values = [0, 0, -overflow, -overflow]
        slide.keyTimes = [0, 0.15, 0.85, 1]
        slide.timingFunctions = [.init(name: .linear), .init(name: .easeInEaseOut), .init(name: .linear)]
        slide.duration = max(4, Double(overflow) / 25 / 0.7)
        slide.autoreverses = true
        slide.repeatCount = .infinity
        slide.beginTime = CACurrentMediaTime() + 1
        slide.isRemovedOnCompletion = false
        layer.add(slide, forKey: Toast.marqueeKey)
    }

    /// Freezes or resumes the marquee where it is, under the pointer.
    private func pause(_ paused: Bool) {
        guard let layer = label.layer, layer.animation(forKey: Toast.marqueeKey) != nil else { return }
        if paused, layer.speed != 0 {
            let now = layer.convertTime(CACurrentMediaTime(), from: nil)
            layer.speed = 0
            layer.timeOffset = now
        } else if !paused, layer.speed == 0 {
            let stopped = layer.timeOffset
            layer.speed = 1
            layer.timeOffset = 0
            layer.beginTime = 0
            layer.beginTime = layer.convertTime(CACurrentMediaTime(), from: nil) - stopped
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { pause(true) }
    override func mouseExited(with event: NSEvent) { pause(false) }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layout() {
        super.layout()
        let radius = bounds.height / 2
        layer?.cornerRadius = radius
        backdrop.layer?.cornerRadius = radius
        // The layer itself is clear, so the shadow needs the pill's outline.
        layer?.shadowPath = CGPath(roundedRect: bounds, cornerWidth: radius, cornerHeight: radius, transform: nil)
    }

    override func removeFromSuperview() {
        timer?.invalidate()
        super.removeFromSuperview()
    }

    override func resetCursorRects() {
        if message.click != nil { addCursorRect(bounds, cursor: .pointingHand) }
    }

    override func mouseDown(with event: NSEvent) { message.click?() }

    @objc private func closeTapped() { message.close() }

    @objc private func actionTapped() { message.click?() }

    /// Pins the toast to the top-right of `content`, below the title bar strip.
    func place(in content: NSView) {
        translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(self)
        NSLayoutConstraint.activate([
            topAnchor.constraint(equalTo: content.topAnchor, constant: TitleBarStrip.height + 8),
            trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
        ])
    }
}

/// The toast text's slot. It clips the text and reports each layout, once it has its width.
private final class MarqueeClip: NSView {
    var onLayout: (() -> Void)?

    override func layout() {
        super.layout()
        onLayout?()
    }
}

/// The toast's bare close x. Under the pointer it brightens to white and grows a little, eased
/// unless Reduce Motion is on.
private final class CloseButton: NSButton {
    static let rest = NSColor(white: 1, alpha: 0.55)

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { hover(true) }
    override func mouseExited(with event: NSEvent) { hover(false) }

    private func hover(_ on: Bool) {
        contentTintColor = on ? .white : CloseButton.rest
        wantsLayer = true
        guard let layer else { return }
        // Scale about the centre: the layer's anchor is its corner.
        let scale: CGFloat = on ? 1.2 : 1
        let transform = CATransform3DConcat(CATransform3DConcat(
            CATransform3DMakeTranslation(-bounds.midX, -bounds.midY, 0), CATransform3DMakeScale(scale, scale, 1)),
            CATransform3DMakeTranslation(bounds.midX, bounds.midY, 0))
        CATransaction.begin()
        CATransaction.setDisableActions(Toast.reduceMotion)
        CATransaction.setAnimationDuration(0.12)
        layer.transform = transform
        CATransaction.commit()
    }
}
