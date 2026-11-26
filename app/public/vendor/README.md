# Vendored Alpine.js

Pinned: `alpinejs@3.17.1` `dist/module.esm.js`

Source: https://cdn.jsdelivr.net/npm/alpinejs@3.17.1/dist/module.esm.js

Served locally from `/vendor/alpine.js` and imported as an ES module by
`client/main.ts` (which calls `Alpine.start()`). No CDN at runtime.

To bump: download the new pinned build over `alpine.js`, update this file,
and bump the shell cache version in `sw.js`.

# Vendored Nueglow

Pinned: `nue-glow@0.2.5` `index.js`

Source: https://github.com/nuejs/nue/tree/master/packages/nueglow (MIT)

Served locally from `/vendor/nueglow.js` and imported as an ES module by
`client/presentation.ts`. Emits semantic HTML (`<b>`, `<em>`, `<sup>`, …) instead of a
theme; `.fence` CSS in `style.css` maps those tags to the app palette.

To bump: download the pinned `index.js` over `nueglow.js`, update this file,
and bump the shell cache version in `sw.js`.

# Vendored qrcode-generator

Pinned: `qrcode-generator@1.4.4` (Kazuhiko Arase, MIT)

Source: https://github.com/kazuhikoarase/qrcode-generator

Served locally from `/vendor/qrcode.js`, loaded as a classic script from
`partials/index.html` so it attaches to `window.qrcode` (it is UMD, not an ES module).
Used by the invite page to render join links as QR codes.

To bump: download the new pinned min.js over `qrcode.js`, update this file,
and bump the shell cache version in `sw.js`.

# Vendored jsQR

Pinned: `jsqr@1.4.0` `dist/jsQR.js` (Cosmo Wolfe, Apache-2.0, license in `jsqr.LICENSE.txt`)

Source: https://github.com/cozmo/jsQR

Served locally from `/vendor/jsqr.js`. It is not part of the shell: the phone's
"Scan to sign in" screen adds the script tag the first time the scanner opens,
and it attaches to `window.jsQR` (UMD). iOS Safari has no `BarcodeDetector`,
so this decodes the camera frames.

To bump: put the new pinned `dist/jsQR.js` under the one-line header comment
and update this file.

# Vendored MiniSearch

Pinned: `minisearch@7.2.0` `dist/es/index.js`, minified with `bun build --minify --format esm` (Luca Ongaro, MIT)

Source: https://github.com/lucaong/minisearch

Served locally from `/vendor/minisearch.js` and imported as an ES module by
`/docs/search.js`, the docs search box. It indexes `/docs/search.json` in the
browser.

To bump: `npm pack minisearch@<version>`, minify `dist/es/index.js` the same
way under the one-line header comment, and update this file.
