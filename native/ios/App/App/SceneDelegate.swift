import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = BridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        // A link that launched the app arrives here rather than in the two methods below.
        if let url = connectionOptions.userActivities.first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb })?.webpageURL ?? connectionOptions.urlContexts.first?.url {
            openLink(url)
        }
        // A notification tap that launched the app.
        if let app = UIApplication.shared.delegate as? AppDelegate, let target = app.pendingNotification {
            app.pendingNotification = nil
            (window?.rootViewController as? BridgeViewController)?.openNotification(origin: target.origin, path: target.path)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
        if let url = URLContexts.first?.url { openLink(url) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
        if userActivity.activityType == NSUserActivityTypeBrowsingWeb, let url = userActivity.webpageURL { openLink(url) }
    }

    private func openLink(_ url: URL) {
        (window?.rootViewController as? BridgeViewController)?.open(link: url)
    }
}
