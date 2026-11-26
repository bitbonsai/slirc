// Registers the service worker. A file rather than an inline script so the shell runs under the app's CSP.
(function () { try { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {}); } catch (e) {} })();
