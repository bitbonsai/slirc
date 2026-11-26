// Image lightbox for blog posts, copied from mauriciowolff.com (public/lightbox.js),
// images only. Styles live in blog.css so a strict style-src CSP still works.
// Click or Enter opens; click anywhere or Esc closes; focus returns to the image.

const SELECTOR = "article img:not(.avatar)";

for (const image of document.querySelectorAll(SELECTOR)) {
  image.classList.add("lightboxable");
  image.tabIndex = 0;
}

// Animated close: play the reverse animation before closing the dialog.
function closeAnimated(dialog) {
  if (dialog.classList.contains("closing")) return;
  dialog.classList.add("closing");
  dialog.addEventListener("animationend", () => dialog.close(), { once: true });
  // Reduced motion: no animation fires, so close straight away.
  setTimeout(() => dialog.open && dialog.close(), 400);
}

function openImageDialog(source) {
  const dialog = document.createElement("dialog");
  dialog.className = "image-lightbox";
  dialog.setAttribute("aria-label", source.alt || "Image");
  const image = document.createElement("img");
  image.src = source.currentSrc || source.src;
  image.alt = source.alt;
  image.width = source.naturalWidth;
  image.height = source.naturalHeight;
  dialog.appendChild(image);
  dialog.addEventListener("click", () => closeAnimated(dialog));
  // Esc closes natively; play the same animation instead.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAnimated(dialog);
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    document.documentElement.style.overflow = "";
    source.focus({ preventScroll: true });
  });
  document.body.appendChild(dialog);
  // Lock the page behind the dialog so touch and wheel scrolling stay put.
  document.documentElement.style.overflow = "hidden";
  dialog.showModal();
}

document.addEventListener("click", (event) => {
  const image = event.target.closest(SELECTOR);
  if (!image) return;
  event.preventDefault();
  openImageDialog(image);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const image = event.target.closest?.(SELECTOR);
  if (!image) return;
  event.preventDefault();
  openImageDialog(image);
});
