// The Mac app's screen for a workspace that doesn't answer, in place of a native alert. It sits over
// the workspace page and looks like the picker (picker.css). The app passes the address and acts on
// what was picked:
//   window.SlircUnreachable = { host }, set by AppDelegate.swift
//   webkit.messageHandlers.slircPicker.postMessage({ retry } | { switch } | { quit })
//   window.slircUnreachableFailed(), the app's answer when Try Again fails again
// Focus starts on Try Again. Tab and Shift+Tab cycle the buttons, since WebKit's Tab reaches only
// text fields. Enter presses the focused button and Escape opens the picker. The pure part,
// unreachableKey, is tested in app/test/desktop-picker.test.ts.
(() => {
  // What a key does with the buttons in order and the focused one at `at` (-1 for none).
  function unreachableKey(key, shiftKey, at, count) {
    if (key === "Tab") return { focus: at < 0 ? (shiftKey ? count - 1 : 0) : (at + (shiftKey ? -1 : 1) + count) % count };
    if (key === "Enter") return at < 0 ? { post: "retry" } : { press: at };
    if (key === "Escape") return { post: "switch" };
    return null;
  }

  globalThis.slircMacUnreachable = { unreachableKey };
  if (typeof document === "undefined") return;

  const state = { host: "", ...(window.SlircUnreachable || {}) };
  const post = (body) => window.webkit?.messageHandlers?.slircPicker?.postMessage(body);
  const buttons = [...document.querySelectorAll(".choices button")];
  const retry = document.querySelector(".retry");
  if (state.host) document.querySelector("#title").textContent = `Couldn't reach ${state.host}`;

  function act(name) {
    if (name === "retry") {
      for (const button of buttons) button.disabled = true;
      retry.textContent = "Trying…";
    }
    post({ [name]: true });
  }

  window.slircUnreachableFailed = () => {
    for (const button of buttons) button.disabled = false;
    retry.textContent = "Try Again";
    retry.focus();
  };

  for (const button of buttons) button.addEventListener("click", () => act(button.classList.contains("retry") ? "retry" : button.classList.contains("switch") ? "switch" : "quit"));
  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || retry.disabled) return;
    const next = unreachableKey(event.key, event.shiftKey, buttons.indexOf(document.activeElement), buttons.length);
    if (!next) return;
    event.preventDefault();
    if ("focus" in next) buttons[next.focus].focus();
    else if ("press" in next) buttons[next.press].click();
    else act(next.post);
  });

  retry.focus();
})();
