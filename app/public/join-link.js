// Join link page script. Loaded from a file, not inline, so the page works under the app's CSP.
(function () {
  var form = document.getElementById("join-form");
  if (!form) return;
  var token = location.pathname.split("/").pop();
  var email = document.getElementById("join-email"), send = document.getElementById("join-send"), error = document.getElementById("join-error");
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var value = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) { error.textContent = "Enter a valid email address."; error.hidden = false; email.focus(); return; }
    error.hidden = true; send.disabled = true; send.classList.add("busy"); send.setAttribute("aria-busy", "true");
    fetch("/api/join-links/" + encodeURIComponent(token) + "/request", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Slirc-Join": "1" },
      body: JSON.stringify({ email: value })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) throw new Error(body.error || "Could not send the email. Try again.");
        form.hidden = true;
        document.getElementById("join-sent").hidden = false;
        if (body.devLink) { document.getElementById("join-dev-link").href = body.devLink; document.getElementById("join-dev").hidden = false; }
      });
    }).catch(function (problem) {
      error.textContent = problem.message; error.hidden = false;
    }).finally(function () {
      send.disabled = false; send.classList.remove("busy"); send.removeAttribute("aria-busy");
    });
  });
})();
