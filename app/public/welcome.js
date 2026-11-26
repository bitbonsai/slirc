// Welcome page script. Loaded from a file, not inline, so the page works under the app's CSP.
// Pick the first step before paint: a computer adds a phone, a phone saves Slirc to its Home
// Screen, and the installed app skips that step. iPadOS reports a Mac user agent with touch.
// The iOS app shell counts as installed: Capacitor puts its bridge on every workspace host.
(function () {
  var ua = navigator.userAgent, touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  var device = /Android/.test(ua) ? "android" : /iPhone|iPod|iPad/.test(ua) || touchMac ? "iphone" : "desktop";
  var shell = window.__slircNative || (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (device !== "desktop" && (shell || navigator.standalone || matchMedia("(display-mode: standalone)").matches)) device = "installed";
  document.documentElement.dataset.device = device;
})();

// Only the video for this device loads. With reduced motion it waits for a tap on its controls.
document.addEventListener("DOMContentLoaded", function () {
  var video = document.querySelector('.step[data-for="' + document.documentElement.dataset.device + '"] video');
  if (!video) return;
  video.src = video.dataset.src;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { video.controls = true; video.preload = "metadata"; return; }
  video.autoplay = true;
  var playing = video.play();
  if (playing) playing.catch(function () { video.controls = true; });
});
