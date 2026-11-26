import { foldDay, foldLabel, lastHereIndex, quotedPost, readerBlocks, topicOptions, type Facet, type PostData, type ReaderBlock, type TopicOption } from "@client/links-query.ts";
import { absorbTokens, activeFilters, addressIn, dayHeading, decodeQuery, displaySummary, displayTitle, dropLastFilter, emptyFacets, emptyQuery, encodeQuery, filterCount, filterGroups, filterIsOn, hasFilters, isEmptyQuery, placeholderFor, postAuthor, requestParams, toggleFilter, type FilterGroup, type FilterKind, type LinkFacets, type LinkQueryState } from "@client/links-query.ts";

// The Links view of a channel: a search field on top, the saved links under day headings, and a
// column of filters beside them. It owns its own state and asks the server for everything; what
// a member may see is decided there, never here.
export interface LinkItem {
  id: number; url: string; title: string; summary: string; author: string; source: string; topics: string[]; origins: string[];
  firstSharedAt: number; lastSharedAt: number; shareCount: number; sharedBy: string; private: string | null; canRemove: boolean; image?: boolean; imageKind?: "image" | "avatar" | null; post?: PostData | null; copy?: boolean; gone?: boolean;
}
// One day of the list as it is drawn. `lastHere` is the id of the row the "You were last here"
// line sits above, or "end" when it belongs after the day's rows.
export interface LinkDay { heading: string; key: string; rows: LinkItem[]; hidden: number; more: string; isNew: boolean; lastHere: number | "end" | null }
const ADDRESS_PARAM = "links";

export interface LinksViewDeps {
  core: { channel: string; direct: boolean; activeThread: unknown; linksHome: string; linksChannels: string[]; authenticated: boolean };
  /** True while a non-chat screen (Profile, Devices and the like) covers the conversation. */
  routed: () => boolean;
  /** Posts a message to the channel on screen. The helper there collects the link. */
  post: (text: string) => Promise<void>;
  nextTick: (callback: () => void) => void;
  /** Where the member stopped reading this channel, as a time, read when the view opens. */
  readMarker?: () => Promise<number | undefined>;
  /** False on a phone, where focusing the field raises the keyboard. */
  desktop?: () => boolean;
  fetcher?: typeof fetch;
  /** Reads and writes the `links` query on the address without adding history entries. */
  address?: { read: () => string; write: (value: string) => void };
  now?: () => number;
}

function browserAddress(): NonNullable<LinksViewDeps["address"]> {
  return {
    read: () => new URLSearchParams(location.search).get(ADDRESS_PARAM) || "",
    write: (value) => {
      const url = new URL(location.href);
      if (value) url.searchParams.set(ADDRESS_PARAM, value); else url.searchParams.delete(ADDRESS_PARAM);
      const next = `${url.pathname}${url.search}${url.hash}`;
      if (next !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(history.state, "", next);
    },
  };
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// Rows under day headings when the list is newest first. A search orders by relevance, so its
// rows come as one group with no heading. `folding` folds busy days; `marker` is where the
// member stopped reading, for the "new" mark on days and the "You were last here" line.
export function groupByDay(rows: LinkItem[], searching: boolean, now: number, options: { folding?: boolean; expanded?: Record<string, boolean>; marker?: number } = {}): LinkDay[] {
  const plain = (heading: string, list: LinkItem[]): LinkDay => ({ heading, key: `${heading}:${list[0]?.id ?? 0}`, rows: list, hidden: 0, more: "", isNew: false, lastHere: null });
  if (searching) return rows.length ? [plain("", rows)] : [];
  const days: { heading: string; rows: LinkItem[] }[] = [];
  // One heading per UTC day, worked out once: formatting a date for every row is slow.
  const headings = new Map<number, string>();
  for (const row of rows) {
    const day = Math.floor(row.firstSharedAt / 86_400_000);
    let heading = headings.get(day);
    if (heading === undefined) { heading = dayHeading(row.firstSharedAt, now); headings.set(day, heading); }
    const last = days[days.length - 1];
    if (last && last.heading === heading) last.rows.push(row); else days.push({ heading, rows: [row] });
  }
  const boundary = lastHereIndex(rows, options.marker);
  const boundaryId = boundary > 0 ? rows[boundary]!.id : 0;
  return days.map((day) => {
    const key = `${day.heading}:${day.rows[0]!.id}`;
    const fold = foldDay(day.rows, !!options.folding, !!options.expanded?.[key]);
    const at = day.rows.findIndex((row) => row.id === boundaryId);
    // The line sits above its row; when that row is behind the fold it goes after the control.
    const lastHere = !boundaryId || at < 0 ? null : at < fold.shown.length ? boundaryId : "end";
    return {
      heading: day.heading, key, rows: fold.shown, hidden: fold.hidden, more: fold.hidden ? foldLabel(fold.hidden, day.rows[0]!.firstSharedAt, now) : "",
      isNew: boundary > 0 && day.rows[0]!.firstSharedAt > (options.marker ?? 0), lastHere,
    };
  });
}

// A day that draws the same as before keeps its object, so Alpine leaves its rows alone and a
// new page costs only the days it adds.
const sameDay = (a: LinkDay, b: LinkDay) => a.heading === b.heading && a.hidden === b.hidden && a.more === b.more && a.isNew === b.isNew
  && a.lastHere === b.lastHere && a.rows.length === b.rows.length && a.rows.every((row, index) => row === b.rows[index]);
export function keepUnchanged(previous: LinkDay[], next: LinkDay[]): LinkDay[] {
  const before = new Map(previous.map((day) => [day.key, day]));
  return next.map((day) => {
    const old = before.get(day.key);
    return old && sameDay(old, day) ? old : day;
  });
}

// Scrolling loads 50 rows at a time up to this many. Past it a button asks for more, so a long
// scroll never piles the whole library onto the page.
export const AUTO_ROWS = 500;

export function createLinksView(reactive: <T extends object>(value: T) => T, deps: LinksViewDeps) {
  const fetcher = deps.fetcher ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const address = deps.address ?? browserAddress();
  const now = deps.now ?? Date.now;
  // The view a member chose for a channel, for the page's lifetime. The home channel starts on Links.
  const chosen = new Map<string, boolean>();
  let generation = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let refreshers: ReturnType<typeof setTimeout>[] = [];
  let lookupFor = "";

  const local = reactive({
    on: false,
    query: emptyQuery() as LinkQueryState,
    rows: [] as LinkItem[],
    days: [] as LinkDay[],
    total: 0,
    more: false,
    // Rows scrolling may load before the button takes over.
    limit: AUTO_ROWS,
    loading: false,
    loaded: false,
    error: "",
    facets: emptyFacets() as LinkFacets,
    groups: [] as FilterGroup[],
    // Days whose fold is open, and where the member stopped reading when the view opened.
    openDays: {} as Record<string, boolean>,
    lastHere: 0,
    // Groups whose "Show all" is open.
    expanded: {} as Record<string, boolean>,
    libraryTotal: 0,
    // A URL in the field: null while unknown, a row when that link is already saved.
    known: null as LinkItem | null,
    adding: false,
    note: "",
    // The filter sheet on a phone.
    sheet: false,
    // Editing one row's topics: the row, what is typed, and the highlighted option.
    editing: 0,
    topicText: "",
    topicIndex: 0,
    topicError: "",
    allTopics: [] as Facet[],
    // The reader view: one link's saved copy, as blocks of plain text.
    reader: null as null | { id: number; url: string; host: string; title: string; byline: string; saved: string; gone: boolean; image: boolean; imageStyle: string; blocks: ReaderBlock[] },
    readerLoading: false,
    readerError: "",
    removeTarget: null as LinkItem | null,
    removeError: "",
    removing: false,
  });

  const channel = () => String(deps.core.channel || "").toLowerCase();
  const home = () => String(deps.core.linksHome || "").toLowerCase();
  // The home channel lists everything the member may see; any other channel lists its own.
  const scopeChannel = () => (channel() === home() ? "" : channel());
  const searching = () => !!local.query.text.trim() && !addressIn(local.query.text);

  function available(): boolean {
    return deps.core.authenticated && !deps.routed() && !deps.core.direct && !deps.core.activeThread
      && !!channel() && deps.core.linksChannels.includes(channel());
  }

  function regroup(): void {
    // Days fold, and the last-here line shows, only in the plain newest-first list.
    const plain = isEmptyQuery(local.query);
    local.days = keepUnchanged(local.days, groupByDay(local.rows, searching(), now(), { folding: plain, expanded: local.openDays, marker: plain ? local.lastHere || undefined : undefined }));
  }
  const autoMore = () => local.more && !local.loading && local.on && local.rows.length < local.limit;
  function setRows(rows: LinkItem[]): void {
    local.rows = rows;
    regroup();
    // Folded days can leave the screen short of a full page; fetch on until it scrolls.
    deps.nextTick(() => {
      const el = typeof document === "undefined" ? null : document.querySelector<HTMLElement>("#links-view");
      if (el && autoMore() && el.scrollHeight - el.clientHeight < 600) void loadMore();
    });
  }
  function openDay(day: LinkDay): void {
    local.openDays = { ...local.openDays, [day.key]: true };
    regroup();
  }

  async function getJson<T>(path: string): Promise<T> {
    const response = await fetcher(path, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(response.status === 429 ? "Slow down a little, then try again." : "Could not load links.");
    return await response.json() as T;
  }

  // One load per query: the list and the counts beside it. A reply for an older query, or for a
  // channel that is no longer on screen, is dropped. The filter column changes only here, so
  // its entries never move while a list is loading.
  async function load(): Promise<void> {
    const mine = ++generation;
    const forChannel = channel();
    const params = requestParams(local.query, scopeChannel());
    local.limit = AUTO_ROWS;
    local.loading = true;
    local.error = "";
    try {
      const [list, facets] = await Promise.all([
        getJson<{ rows: LinkItem[]; total: number; more: boolean }>(`/api/links?${params}`),
        getJson<LinkFacets>(`/api/links/facets?${params}`),
      ]);
      if (mine !== generation || forChannel !== channel() || !local.on) return;
      setRows(list.rows);
      local.total = list.total;
      local.more = list.more;
      local.facets = facets;
      local.groups = filterGroups(facets);
      if (isEmptyQuery(local.query)) local.libraryTotal = list.total;
      local.loaded = true;
    } catch (error) {
      if (mine !== generation) return;
      local.error = error instanceof Error ? error.message : "Could not load links.";
    } finally {
      if (mine === generation) local.loading = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (!local.more || local.loading || !local.on) return;
    const mine = generation;
    const params = requestParams(local.query, scopeChannel());
    params.set("offset", String(local.rows.length));
    local.loading = true;
    try {
      const list = await getJson<{ rows: LinkItem[]; total: number; more: boolean }>(`/api/links?${params}`);
      if (mine !== generation) return;
      const seen = new Set(local.rows.map((row) => row.id));
      setRows([...local.rows, ...list.rows.filter((row) => !seen.has(row.id))]);
      local.more = list.more;
    } catch { /* The next scroll tries again. */ }
    finally { if (mine === generation) local.loading = false; }
  }

  function onScroll(event: Event): void {
    const el = event.target as HTMLElement;
    if (autoMore() && el.scrollHeight - el.scrollTop - el.clientHeight < 600) void loadMore();
  }

  // The button past the cap: the next page now, and another stretch of scrolling after it. Focus
  // moves to the first new row, since the button itself goes away.
  async function showOlder(): Promise<void> {
    const from = local.rows.length;
    const button = typeof document === "undefined" ? null : document.activeElement;
    local.limit = from + AUTO_ROWS;
    await loadMore();
    const first = local.rows[from];
    if (!first || !button?.classList?.contains("links-older")) return;
    deps.nextTick(() => document.querySelector<HTMLElement>(`[data-link-row="${first.id}"] :is(.link-title, .link-handle)`)?.focus());
  }

  function publish(): void {
    address.write(local.on ? encodeQuery(local.query) : "");
  }

  function changed(immediate = false): void {
    publish();
    clearTimeout(debounce);
    const url = addressIn(local.query.text);
    if (url) { void lookup(url); return; }
    local.known = null;
    lookupFor = "";
    if (immediate) void load(); else debounce = setTimeout(() => void load(), 160);
  }

  async function lookup(url: string): Promise<void> {
    if (lookupFor === url) return;
    lookupFor = url;
    local.known = null;
    try {
      const body = await getJson<{ link: LinkItem | null }>(`/api/links/lookup?url=${encodeURIComponent(url)}`);
      if (lookupFor === url) local.known = body.link;
    } catch { /* Unknown is fine: Enter still adds it. */ }
  }

  function onInput(event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    local.note = "";
    local.query = absorbTokens({ ...local.query, text }, local.facets);
    changed();
  }

  function setQuery(next: LinkQueryState): void {
    local.query = next;
    changed(true);
  }

  // What the field holds: an address to add, one that is already saved, or words.
  function mode(): "add" | "saved" | "search" {
    if (addressIn(local.query.text)) return local.known ? "saved" : "add";
    return "search";
  }

  // From the filter column, a token under the field, or anything clickable in a row.
  function toggle(kind: FilterKind, value: string): void {
    if (!value) return;
    local.note = "";
    setQuery(toggleFilter(local.query, kind, value));
  }
  function filterBy(kind: FilterKind, value: string): void {
    if (value && !filterIsOn(local.query, kind, value)) toggle(kind, value);
  }

  function clear(): void {
    local.note = "";
    setQuery(emptyQuery());
    focusInput();
  }

  // On a phone a tap must not raise the keyboard; only a deliberate focus does.
  function focusInput(deliberate = false): void {
    if (!deliberate && deps.desktop && !deps.desktop()) return;
    deps.nextTick(() => document.querySelector<HTMLInputElement>("#links-search-input")?.focus({ preventScroll: true }));
  }

  // Enter adds a URL and does nothing more for words: the list already shows them.
  async function submit(): Promise<void> {
    const url = addressIn(local.query.text);
    if (!url) { clearTimeout(debounce); void load(); return; }
    if (local.known) { showKnown(); return; }
    if (local.adding) return;
    local.adding = true;
    try {
      await deps.post(local.query.text.trim());
      local.query = { ...local.query, text: "" };
      lookupFor = "";
      local.known = null;
      local.note = "Saving that link…";
      publish();
      // The helper reads the channel and saves the link; look for the row a few times.
      const before = local.libraryTotal;
      for (const timer of refreshers) clearTimeout(timer);
      refreshers = [900, 2500, 6000].map((delay) => setTimeout(async () => {
        if (!local.on || !local.note) return;
        await load();
        if (local.libraryTotal > before || (!isEmptyQuery(local.query) && delay === 6000)) { local.note = ""; for (const timer of refreshers) clearTimeout(timer); }
        else if (delay === 6000) local.note = "Sent. It shows here once links has read it.";
      }, delay));
    } catch (error) {
      local.note = error instanceof Error ? error.message : "Could not send that. Try again.";
    } finally {
      local.adding = false;
    }
  }

  // "Already saved": show that row and nothing else.
  function showKnown(): void {
    const row = local.known;
    if (!row) return;
    generation++;
    clearTimeout(debounce);
    local.query = emptyQuery();
    lookupFor = "";
    local.known = null;
    local.rows = [row];
    local.days = [{ heading: "Already saved", key: `saved:${row.id}`, rows: [row], hidden: 0, more: "", isNew: false, lastHere: null }];
    local.total = 1;
    local.more = false;
    local.loading = false;
    publish();
  }

  function onInputKeydown(event: KeyboardEvent): void {
    if (event.key === "Backspace" && !local.query.text && hasFilters(local.query)) {
      event.preventDefault();
      setQuery(dropLastFilter(local.query));
    } else if (event.key === "Escape" && local.query.text) {
      event.preventDefault();
      setQuery({ ...local.query, text: "" });
    }
  }

  function openSheet(): void {
    local.sheet = true;
    deps.nextTick(() => document.querySelector<HTMLElement>("#links-filters .links-sheet-close")?.focus());
  }
  function closeSheet(): void {
    if (!local.sheet) return;
    local.sheet = false;
    deps.nextTick(() => document.querySelector<HTMLElement>("#links-filters-button")?.focus());
  }

  // Topics on a row. Clicking a topic filters; editing happens only here, through the "+" on
  // the row and the remove controls it reveals.
  let outside: ((event: Event) => void) | null = null;
  function stopOutside(): void {
    if (outside) document.removeEventListener("pointerdown", outside, true);
    outside = null;
  }
  async function loadTopics(): Promise<void> {
    try { local.allTopics = (await getJson<{ topics: Facet[] }>("/api/links/topics")).topics; } catch { /* The list on hand still works. */ }
  }
  function openTopics(row: LinkItem): void {
    stopOutside();
    local.editing = row.id;
    local.topicText = "";
    local.topicIndex = 0;
    local.topicError = "";
    if (!local.allTopics.length) local.allTopics = local.facets.topics;
    void loadTopics();
    deps.nextTick(() => {
      document.querySelector<HTMLInputElement>("#links-topic-input")?.focus({ preventScroll: true });
      // A press anywhere outside the row closes the editor. Added after this click has passed.
      outside = (event) => {
        const target = event.target as Element | null;
        if (!target?.closest?.(`[data-link-row="${row.id}"]`)) closeTopics(false);
      };
      setTimeout(() => { if (outside && typeof document !== "undefined") document.addEventListener("pointerdown", outside, true); }, 0);
    });
  }
  function closeTopics(refocus = true): void {
    const id = local.editing;
    if (!id) return;
    stopOutside();
    local.editing = 0;
    local.topicText = "";
    local.topicError = "";
    if (refocus) deps.nextTick(() => document.querySelector<HTMLElement>(`[data-link-topics="${id}"]`)?.focus());
  }
  function editedRow(): LinkItem | undefined {
    return local.rows.find((row) => row.id === local.editing);
  }
  function currentOptions(): TopicOption[] {
    return topicOptions(local.allTopics, editedRow()?.topics ?? [], local.topicText);
  }
  // The row and the counts beside the list update in place: no list reload, no scroll jump.
  async function changeTopic(row: LinkItem, action: "add" | "remove", topic: string): Promise<void> {
    local.topicError = "";
    try {
      const response = await fetcher(`/api/links/${row.id}/topics`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Slirc-Links": "1" }, body: JSON.stringify({ [action]: topic }),
      });
      const body = await response.json().catch(() => ({})) as { link?: LinkItem; error?: string };
      if (!response.ok || !body.link) throw new Error(body.error || "That did not work. Try again in a moment.");
      const updated = body.link;
      local.rows = local.rows.map((item) => (item.id === updated.id ? updated : item));
      regroup();
      local.topicText = "";
      local.topicIndex = 0;
      void loadTopics();
      void refreshCounts();
    } catch (error) {
      local.topicError = error instanceof Error ? error.message : "That did not work.";
    }
  }
  async function refreshCounts(): Promise<void> {
    const mine = generation;
    try {
      const facets = await getJson<LinkFacets>(`/api/links/facets?${requestParams(local.query, scopeChannel())}`);
      if (mine !== generation || !local.on) return;
      local.facets = facets;
      local.groups = filterGroups(facets);
    } catch { /* The next load brings them. */ }
  }
  function pickTopic(option: TopicOption): void {
    const row = editedRow();
    if (row) void changeTopic(row, "add", option.value);
    deps.nextTick(() => document.querySelector<HTMLInputElement>("#links-topic-input")?.focus({ preventScroll: true }));
  }
  function removeTopic(row: LinkItem, topic: string): void {
    void changeTopic(row, "remove", topic);
  }
  function onTopicInput(event: Event): void {
    local.topicText = (event.target as HTMLInputElement).value;
    local.topicIndex = 0;
    local.topicError = "";
  }
  function onTopicKeydown(event: KeyboardEvent): void {
    const options = currentOptions();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length) local.topicIndex = (local.topicIndex + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[Math.min(local.topicIndex, options.length - 1)];
      if (option) pickTopic(option);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeTopics();
    }
  }

  // The saved copy of one link, in a plain reader view. A safety net for when the original is gone.
  let readerFrom = 0;
  async function openReader(row: LinkItem): Promise<void> {
    readerFrom = row.id;
    local.reader = null;
    local.readerError = "";
    local.readerLoading = true;
    deps.nextTick(() => document.querySelector<HTMLDialogElement>("#links-reader")?.showModal());
    try {
      const response = await fetcher(`/api/links/${row.id}/copy`, { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(response.status === 404 ? "There is no saved copy of this link." : "Could not open the saved copy.");
      const body = await response.json() as { id: number; url: string; title: string; byline: string; text: string; savedAt: number; image: boolean; gone: boolean; imageWidth: number | null; imageHeight: number | null };
      if (readerFrom !== row.id) return;
      local.reader = {
        id: body.id, url: body.url, host: hostOf(body.url), title: displayTitle({ title: body.title, url: body.url }), byline: body.byline, gone: body.gone, image: body.image,
        // The stored size reserves the picture's box. A preview saved before sizes were kept is
        // shown whole rather than cropped to a made-up ratio; this reader is not the transcript.
        imageStyle: body.imageWidth && body.imageHeight ? `aspect-ratio: ${body.imageWidth} / ${body.imageHeight};` : "",
        saved: new Date(body.savedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }), blocks: readerBlocks(String(body.text || "")),
      };
    } catch (error) {
      if (readerFrom === row.id) local.readerError = error instanceof Error ? error.message : "Could not open the saved copy.";
    } finally {
      if (readerFrom === row.id) local.readerLoading = false;
    }
  }
  function closeReader(): void {
    const id = readerFrom;
    readerFrom = 0;
    document.querySelector<HTMLDialogElement>("#links-reader")?.close();
    local.reader = null;
    local.readerLoading = false;
    if (id) deps.nextTick(() => document.querySelector<HTMLElement>(`[data-link-row="${id}"] [data-link-copy]`)?.focus());
  }
  // A row whose original is gone opens its saved copy from its main link.
  function mainClick(row: LinkItem, event: Event): void {
    if (!row.gone || !row.copy) return;
    event.preventDefault();
    void openReader(row);
  }

  function askRemove(row: LinkItem): void {
    local.removeTarget = row;
    local.removeError = "";
    deps.nextTick(() => document.querySelector<HTMLDialogElement>("#links-remove-dialog")?.showModal());
  }

  function cancelRemove(): void {
    const id = local.removeTarget?.id;
    document.querySelector<HTMLDialogElement>("#links-remove-dialog")?.close();
    local.removeTarget = null;
    // Closing hands focus back to the row's own button.
    if (id) deps.nextTick(() => document.querySelector<HTMLElement>(`[data-link-remove="${id}"]`)?.focus());
  }

  async function confirmRemove(): Promise<void> {
    const row = local.removeTarget;
    if (!row || local.removing) return;
    local.removing = true;
    local.removeError = "";
    try {
      const response = await fetcher(`/api/links/${row.id}/remove`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Slirc-Links": "1" }, body: "{}",
      });
      if (!response.ok && response.status !== 404) throw new Error(response.status === 403 ? "Only the person who added it or an admin can remove this." : "That did not work. Try again in a moment.");
      setRows(local.rows.filter((item) => item.id !== row.id));
      local.total = Math.max(0, local.total - 1);
      if (local.libraryTotal) local.libraryTotal -= 1;
      document.querySelector<HTMLDialogElement>("#links-remove-dialog")?.close();
      local.removeTarget = null;
      focusInput();
    } catch (error) {
      local.removeError = error instanceof Error ? error.message : "That did not work.";
    } finally {
      local.removing = false;
    }
  }

  function reset(): void {
    generation++;
    clearTimeout(debounce);
    for (const timer of refreshers) clearTimeout(timer);
    refreshers = [];
    local.query = emptyQuery();
    local.rows = [];
    local.days = [];
    local.total = 0;
    local.more = false;
    local.limit = AUTO_ROWS;
    local.loaded = false;
    local.loading = false;
    local.error = "";
    local.note = "";
    local.known = null;
    local.sheet = false;
    stopOutside();
    local.editing = 0;
    local.topicText = "";
    local.allTopics = [];
    lookupFor = "";
    local.facets = emptyFacets();
    local.groups = [];
    local.expanded = {};
    local.openDays = {};
    local.lastHere = 0;
    local.libraryTotal = 0;
  }

  function enter(initial?: LinkQueryState): void {
    reset();
    local.on = true;
    if (initial) local.query = initial;
    publish();
    // The read position as it stands now, before opening the channel moves it.
    const forChannel = channel();
    void deps.readMarker?.().then((marker) => {
      if (!marker || !local.on || forChannel !== channel()) return;
      local.lastHere = marker;
      if (local.rows.length) regroup();
    }).catch(() => {});
    void load();
    // The whole library's size, for the field's placeholder, when the view opens already filtered.
    if (initial && !isEmptyQuery(initial)) {
      const scope = scopeChannel();
      void getJson<{ total: number }>(`/api/links?limit=1${scope ? `&channel=${encodeURIComponent(scope)}` : ""}`)
        .then((list) => { if (local.on && forChannel === channel()) local.libraryTotal = list.total; }).catch(() => {});
    }
  }

  function leave(): void {
    if (!local.on) return;
    local.on = false;
    reset();
    address.write("");
  }

  // Called whenever the conversation on screen, or the list of channels with the helper, changes.
  let shownFor = "";
  function sync(): void {
    if (!available()) { shownFor = ""; leave(); return; }
    const key = channel();
    const want = chosen.get(key) ?? (key === home());
    if (want && (!local.on || shownFor !== key)) {
      shownFor = key;
      const fromAddress = address.read();
      enter(fromAddress ? decodeQuery(fromAddress) : undefined);
    } else if (!want) {
      shownFor = key;
      leave();
    }
    takePending();
  }

  function show(view: "links" | "messages"): void {
    if (!available()) return;
    chosen.set(channel(), view === "links");
    shownFor = "";
    sync();
    if (view === "links") focusInput();
  }

  // `/links words` from anywhere: the home channel opens with those words already in the field.
  let pendingWords: string | null = null;
  function openWith(words: string): void {
    chosen.set(home(), true);
    pendingWords = words;
    takePending();
  }
  function takePending(): void {
    if (pendingWords === null || !available() || channel() !== home()) return;
    const words = pendingWords;
    pendingWords = null;
    shownFor = home();
    enter(decodeQuery(words));
    focusInput();
  }

  return Object.assign(local, {
    available, sync, show, openWith, onInput, onInputKeydown, onScroll, submit, toggle, filterBy, clear,
    openTopics, closeTopics, pickTopic, removeTopic, onTopicInput, onTopicKeydown, topicOptions: currentOptions,
    mode, loadMore, showOlder, askRemove, cancelRemove, confirmRemove, showKnown, openSheet, closeSheet, reload: () => load(),
    placeholder: () => placeholderFor(local.libraryTotal, local.loaded),
    hasFilters: () => hasFilters(local.query),
    filterCount: () => filterCount(local.query),
    tokens: () => activeFilters(local.query),
    isOn: (kind: FilterKind, value: string) => filterIsOn(local.query, kind, value),
    isEmpty: () => isEmptyQuery(local.query),
    shown: (group: FilterGroup) => (local.expanded[group.id] ? group.entries : group.entries.slice(0, group.short)),
    expand: (group: FilterGroup) => { local.expanded = { ...local.expanded, [group.id]: !local.expanded[group.id] }; },
    openDay, post: quotedPost, openReader, closeReader, mainClick,
    // A saved preview that finished loading fades in over the box its stored size reserved.
    markLoaded: (img: HTMLImageElement | null) => img?.classList.add("thumb-loaded"),
    host: hostOf,
    title: displayTitle,
    summary: displaySummary,
    author: postAuthor,
    isHome: () => channel() === home(),
    count: (value: number) => value.toLocaleString("en-US"),
    capped: () => local.more && !local.loading && local.rows.length >= local.limit,
    olderLabel: () => (searching() ? "Show more results" : "Show older links"),
    status: () => (local.loaded ? `${local.total.toLocaleString("en-US")} ${local.total === 1 ? "link" : "links"}` : ""),
  });
}

export type LinksView = ReturnType<typeof createLinksView>;
