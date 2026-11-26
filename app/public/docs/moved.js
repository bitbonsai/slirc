// Moved-page stubs: follow the canonical link and keep the fragment. The meta refresh is the fallback.
(function () {
  var link = document.querySelector('link[rel="canonical"]');
  if (link) location.replace(link.getAttribute("href") + location.hash);
})();
