// Exposes the syntax highlighter to docs.js. A file rather than an inline module so docs pages run under the app's CSP.
import { glow } from "/vendor/nueglow.js";
window.__glow = glow;
