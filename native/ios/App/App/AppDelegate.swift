import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Set before launch ends, so a tap that launched the app still reaches it.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        DeviceToken.shared.received(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        DeviceToken.shared.failed(error)
    }

    // A push carries { origin, url }: the workspace that sent it and the conversation (apns.ts).
    private static func target(_ notification: UNNotification) -> (origin: URL?, path: String) {
        let info = notification.request.content.userInfo
        let origin = (info["origin"] as? String).flatMap(URL.init(string:)).flatMap { WorkspaceNavigationState.isValidWorkspaceURL($0) ? $0 : nil }
        return (origin, info["url"] as? String ?? "/")
    }

    private var shell: BridgeViewController? {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.windows.first?.rootViewController as? BridgeViewController }.first
    }

    /// A tap that arrives before the scene has its view controller waits here for SceneDelegate.
    var pendingNotification: (origin: URL?, path: String)?

    // In the foreground the banner shows too, except for the conversation already on screen.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let target = Self.target(notification)
        guard let shell = shell else { return completionHandler([.banner, .list, .sound]) }
        shell.isShowing(origin: target.origin, path: target.path) { showing in
            completionHandler(showing ? [] : [.banner, .list, .sound])
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let target = Self.target(response.notification)
        if let shell = shell { shell.openNotification(origin: target.origin, path: target.path) } else { pendingNotification = target }
        completionHandler()
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
