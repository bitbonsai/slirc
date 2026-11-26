import { type Message } from "@client/model.ts";
import { embedImageUrl, textSegments, youtubeId } from "@client/render.ts";
import { isCompactPlayer, playerAspect, playerHostKind, type EmbedMeta } from "@client/embed.ts";
import { directImageMedia, inlineMedia, type InlineMedia } from "@client/media.ts";
import { collapsedMediaFromStorage, lightboxEscapeAction } from "@client/presentation.ts";
import { type OpenPopup } from "@client/popups.ts";
import { type ClientSession, type ClientState } from "@client/client-state.ts";

export function createMediaView(reactive: <T extends object>(value: T) => T, { core, nextTick, openPopup, session, origin, autoCollapsed = () => false }: {
  core: Pick<ClientState, 'embeds'>;
  nextTick: (callback?: () => void) => Promise<void>;
  session: ClientSession;
  openPopup: OpenPopup;
  origin: string;
  autoCollapsed?: (message: Message) => boolean; // collapsed by default until the user opens it
}) {
  const local = reactive({
    lightbox: null as null | { kind: "image" | "player"; src: string; url: string; alt?: string; aspect?: number; compact?: boolean; title?: string; site?: string; author?: string },
    lightboxMax: false,
    lightboxZoom: false, // an image at its natural size, panned by scrolling or dragging
    mediaDims: {} as Record<string, { width: number; height: number }>,
    collapsedMedia: {} as Record<string, true>,
    expandedMedia: {} as Record<string, true>, // opened over autoCollapsed, this session only
    mediaErrors: {} as Record<string, true>,
  });
  function reset(): void { closeLightbox(); local.mediaDims = {}; askedDims.clear(); local.collapsedMedia = {}; local.expandedMedia = {}; local.mediaErrors = {}; }
  function messageMedia(text: string): InlineMedia[] {
    const media = inlineMedia(text, origin);
    // A URL the server confirmed serves an image becomes an ordinary inline photo. Only the
    // validated `kind: "image"` marker qualifies; a webpage with an og:image stays a card.
    const seen = new Set(media.map((item) => item.href));
    for (const segment of textSegments(text)) {
      if (!segment.href) continue;
      const direct = directImageMedia(segment.href, core.embeds[segment.href]?.kind);
      if (direct && !seen.has(direct.href)) { media.push(direct); seen.add(direct.href); }
    }
    return media.map((item) => {
      const meta = core.embeds[item.url || item.href];
      if (meta?.width && meta.height) return { ...item, width: meta.width, height: meta.height };
      // An upload's own size, known from the server before its bytes arrive.
      const stored = local.mediaDims[item.href];
      return stored ? { ...item, width: stored.width, height: stored.height } : item;
    });
  }

  function isMediaCollapsed(message: Message): boolean {
    return local.collapsedMedia[message.id] === true || (!local.expandedMedia[message.id] && autoCollapsed(message));
  }

  function setMediaCollapsed(message: Message, collapsed: boolean): void {
    // <details> also fires toggle when the default flips under it; that is not a user choice.
    if (isMediaCollapsed(message) === collapsed) return;
    const expanded = { ...local.expandedMedia };
    if (collapsed) delete expanded[message.id];
    else expanded[message.id] = true;
    local.expandedMedia = expanded;
    if (isMediaCollapsed(message) === collapsed) return;
    const next = { ...local.collapsedMedia };
    if (collapsed) next[message.id] = true;
    else delete next[message.id];
    local.collapsedMedia = next;
    const scope = session.scope();
    if (!scope) return;
    const key = `slirc2-collapsed-media:${scope.accountId}`;
    try {
      const ids = Object.keys(next);
      if (ids.length) localStorage.setItem(key, JSON.stringify(ids));
      else localStorage.removeItem(key);
    } catch { /* private browsing can deny storage; details still work for this render */ }
  }

  function loadCollapsedMedia(accountId: string): Record<string, true> {
    try { return collapsedMediaFromStorage(localStorage.getItem(`slirc2-collapsed-media:${accountId}`)); }
    catch { return {}; }
  }

  function playerCard(href: string): { src: string; title: string; site: string; author: string; url: string; aspect: number; compact: boolean; kind: "audio" | "video"; thumb: string } | null {
    const yt = youtubeId(href);
    if (yt) {
      return { src: `https://www.youtube-nocookie.com/embed/${yt}?autoplay=1`, title: "YouTube", site: "YouTube", author: "", url: href, aspect: 16 / 9, compact: false, kind: "video", thumb: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` };
    }
    const meta = core.embeds[href] as EmbedMeta | undefined;
    if (!meta?.player) return null;
    return {
      src: meta.player.src,
      title: meta.title || meta.site || "Play",
      site: meta.site || "",
      author: meta.author || "",
      url: meta.url || href,
      aspect: playerAspect(meta.player),
      compact: isCompactPlayer(meta.player),
      kind: playerHostKind(meta.player.src),
      thumb: meta.image ? embedImageUrl(meta.image) : "",
    };
  }

  function openLightbox(media: InlineMedia): void {
    openPopup();
    local.lightbox = { kind: "image", src: media.href, url: media.href, alt: media.alt };
    local.lightboxMax = false;
    local.lightboxZoom = false;
    const dialog = document.querySelector<HTMLDialogElement>("#media-lightbox");
    void nextTick(() => { if (dialog && !dialog.open) dialog.showModal(); });
  }

  function openPlayer(href: string): void {
    const card = playerCard(href);
    if (!card) return;
    openPopup();
    local.lightbox = { kind: "player", src: card.src, url: card.url, aspect: card.aspect, compact: card.compact, title: card.title, site: card.site, author: card.author };
    local.lightboxMax = false;
    local.lightboxZoom = false;
    const dialog = document.querySelector<HTMLDialogElement>("#media-lightbox");
    void nextTick(() => { if (dialog && !dialog.open) dialog.showModal(); });
  }

  // Escape steps back one level: real size to fit, fill to normal, then close.
  function escapeLightbox(): void {
    if (lightboxEscapeAction(local.lightboxMax || local.lightboxZoom) === "restore") {
      if (local.lightboxZoom) local.lightboxZoom = false; else local.lightboxMax = false;
      return;
    }
    closeLightbox();
  }

  // A drag that panned the picture ends in a click; that click must not also zoom out.
  let dragged = false;
  let panning: AbortController | null = null;

  // Clicking the picture (or the zoom button) toggles real size. Zooming in keeps the clicked point
  // under the pointer; the button zooms around the centre.
  function toggleLightboxZoom(event?: MouseEvent): void {
    if (dragged) { dragged = false; return; }
    if (local.lightbox?.kind !== "image") return;
    local.lightboxZoom = !local.lightboxZoom;
    if (!local.lightboxZoom) return;
    const img = (event?.currentTarget as HTMLImageElement | null | undefined) ?? document.querySelector<HTMLImageElement>("#media-lightbox .lightbox-media img");
    if (!img?.getBoundingClientRect) return;
    const before = img.getBoundingClientRect();
    const fx = event ? (event.clientX - before.left) / before.width : .5;
    const fy = event ? (event.clientY - before.top) / before.height : .5;
    void nextTick(() => {
      const box = img.parentElement;
      if (!box) return;
      const frame = box.getBoundingClientRect();
      const px = event ? event.clientX - frame.left : box.clientWidth / 2;
      const py = event ? event.clientY - frame.top : box.clientHeight / 2;
      box.scrollLeft = img.offsetLeft + fx * img.offsetWidth - px;
      box.scrollTop = img.offsetTop + fy * img.offsetHeight - py;
    });
  }

  // Mouse drag pans a zoomed picture. Touch already pans by scrolling and pinches natively.
  function startLightboxPan(event: PointerEvent): void {
    if (!local.lightboxZoom || event.pointerType !== "mouse" || event.button !== 0) return;
    const box = event.currentTarget as HTMLElement;
    const start = { x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop };
    dragged = false;
    panning?.abort();
    panning = new AbortController();
    const { signal } = panning;
    box.classList.add("panning");
    addEventListener("pointermove", (move: PointerEvent) => {
      const dx = move.clientX - start.x, dy = move.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
      box.scrollLeft = start.left - dx;
      box.scrollTop = start.top - dy;
    }, { signal });
    const stop = () => { box.classList.remove("panning"); panning?.abort(); panning = null; };
    addEventListener("pointerup", stop, { signal });
    addEventListener("pointercancel", stop, { signal });
  }

  function closeLightbox(): void {
    // The media contents are conditionally rendered, so clearing the state removes the iframe/img
    // entirely; there is no lingering element to reset.
    document.querySelector<HTMLDialogElement>("#media-lightbox")?.close();
    local.lightbox = null;
    local.lightboxMax = false;
    local.lightboxZoom = false;
    panning?.abort();
    panning = null;
    dragged = false;
  }

  // A failed external image keeps a visible link to the original URL, since the body no longer
  // prints it; this is the only recovery path once the photo cannot render.
  function recordMediaError(href: string): void {
    if (!href || local.mediaErrors[href]) return;
    local.mediaErrors = { ...local.mediaErrors, [href]: true };
  }

  function isMediaError(href: string): boolean {
    return local.mediaErrors[href] === true;
  }

  function recordMediaDims(href: string, width: number, height: number): void {
    if (!href || !width || !height) return;
    const existing = local.mediaDims[href];
    if (existing?.width === width && existing?.height === height) return;
    local.mediaDims = { ...local.mediaDims, [href]: { width, height } };
  }

  // A picture that finished loading fades in over the box reserved for it.
  function markLoaded(img: HTMLImageElement | null): void {
    img?.classList.add("thumb-loaded");
  }

  // The sizes of the uploads a conversation shows, asked once per upload id. The transcript calls
  // this with the rows it is about to paint, so each photo's box is already the right shape when
  // its bytes arrive and the list does not jump under the reader.
  const askedDims = new Set<string>();
  async function loadUploadDims(messages: readonly Message[]): Promise<void> {
    const wanted = new Map<string, string>(); // upload id -> the href its row renders
    for (const message of messages) {
      for (const media of inlineMedia(String(message.text ?? ""), origin)) {
        const id = media.uploadId;
        if (!id || askedDims.has(id) || local.mediaDims[media.href]) continue;
        wanted.set(id, media.href);
      }
    }
    const ids = [...wanted.keys()].slice(0, 100);
    if (!ids.length) return;
    for (const id of ids) askedDims.add(id);
    try {
      const response = await fetch(`/api/uploads/dims?ids=${encodeURIComponent(ids.join(","))}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`upload dims failed (${response.status})`);
      const found = await response.json() as Record<string, { width?: number; height?: number }>;
      const known = { ...local.mediaDims };
      for (const id of ids) {
        const dims = found?.[id];
        const href = wanted.get(id);
        if (href && dims?.width && dims.height) known[href] = { width: dims.width, height: dims.height };
      }
      local.mediaDims = known;
    } catch { /* the photo still loads; only its box is not reserved on this attempt */ }
  }

  function mediaAspectStyle(href: string, width?: number, height?: number): string {
    const dims = width && height ? { width, height } : local.mediaDims[href];
    return dims?.width && dims?.height
      ? `width: min(22rem, ${dims.width}px, ${300 * dims.width / dims.height}px, 100%); aspect-ratio: ${dims.width} / ${dims.height};`
      : "";
  }

  return Object.assign(local, {
    messageMedia,
    isMediaCollapsed,
    setMediaCollapsed,
    loadCollapsedMedia,
    playerCard,
    openLightbox,
    openPlayer,
    escapeLightbox,
    closeLightbox,
    toggleLightboxZoom,
    startLightboxPan,
    recordMediaDims,
    recordMediaError,
    isMediaError,
    mediaAspectStyle,
    markLoaded,
    loadUploadDims,
    reset,
    destroy: reset,
  });
}
