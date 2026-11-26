import { HELP_TOPICS, filterHelpTopics, type HelpTopic } from "@client/help.ts";
import { hiddenCommands } from "@client/commands.ts";
import { rankJump, type JumpRow } from "@client/jump.ts";
import { hasSearchCriteria, parseSearchQuery, type SearchHit, type SearchKind, type SearchResult } from "@client/search.ts";
import type { LoadOlderResult } from "@client/sync.ts";

export function helpDialogComponent(): Record<string, unknown> {
  return {
    query: "",
    index: 0,
    _dialog: null as HTMLDialogElement | null,
    _onOpen: null as (() => void) | null,
    init(this: any): void {
      this._dialog = document.querySelector<HTMLDialogElement>("#help-dialog");
      this._onOpen = (): void => {
        this.query = "";
        this.index = 0;
        void this.$nextTick(() => {
          if (this._dialog && !this._dialog.open) this._dialog.showModal();
          this.$refs.search?.focus();
        });
      };
      window.addEventListener("slirc:help-open", this._onOpen);
    },
    destroy(this: any): void {
      if (this._onOpen) window.removeEventListener("slirc:help-open", this._onOpen);
      this._onOpen = null;
      this._dialog = null;
    },
    filtered(this: any): HelpTopic[] {
      const hidden = Array.isArray(this.helpers) ? hiddenCommands(this.helpers, this.isAdmin === true) : [];
      return filterHelpTopics(HELP_TOPICS, this.query).filter((topic) => !hidden.some((name) => topic.command.startsWith(`/${name}`)));
    },
    onInput(this: any, event: Event): void {
      const target = event.target;
      if (target instanceof HTMLInputElement) this.query = target.value;
      this.index = 0;
    },
    move(this: any, step: number): void {
      const list = this.filtered();
      if (!list.length) return;
      this.index = (this.index + step + list.length) % list.length;
      void this.$nextTick(() => this.$refs.list?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
    },
    keydown(this: any, event: KeyboardEvent): void {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") { event.preventDefault(); this.close(); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); this.move(1); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); this.move(-1); return; }
      if (event.key === "Enter") {
        event.preventDefault();
        const list = this.filtered();
        if (list[this.index]) this.choose(list[this.index]!);
      }
    },
    choose(this: any, topic?: HelpTopic): void {
      const row = topic ?? this.filtered()[this.index];
      if (!row) return;
      this.close();
      window.dispatchEvent(new CustomEvent("slirc:help-pick", { detail: { row } }));
    },
    close(this: any): void {
      this.query = "";
      this.index = 0;
      this._dialog?.close();
    },
  };
}

// Cmd+K palette. The parent hands it the rows at open time; picking one comes back as
// `slirc:jump-pick` because the parent owns routing. Focus stays in the input (a combobox) and
// aria-activedescendant names the highlighted option, so screen readers follow the arrows.
// Closing without a pick puts focus back where it was.
export function jumpDialogComponent(): Record<string, unknown> {
  return {
    query: "",
    index: 0,
    rows: [] as JumpRow[],
    _dialog: null as HTMLDialogElement | null,
    _invoker: null as HTMLElement | null,
    _onOpen: null as ((event: Event) => void) | null,
    _onToggle: null as (() => void) | null,
    init(this: any): void {
      this._dialog = document.querySelector<HTMLDialogElement>("#jump-dialog");
      this._onOpen = (event: Event): void => {
        if (this._dialog?.open) { this.close(); return; }
        const active = document.activeElement as HTMLElement | null;
        this._invoker = active && active !== document.body && typeof active.focus === "function" ? active : null;
        this.rows = (event as CustomEvent<{ rows: JumpRow[] }>).detail.rows;
        this.query = "";
        this.index = 0;
        void this.$nextTick(() => {
          if (this._dialog && !this._dialog.open) this._dialog.showModal();
          this.$refs.search?.focus();
        });
      };
      window.addEventListener("slirc:jump-open", this._onOpen);
    },
    destroy(this: any): void {
      if (this._onOpen) window.removeEventListener("slirc:jump-open", this._onOpen);
      this._onOpen = null;
      this._dialog = null;
      this._invoker = null;
    },
    filtered(this: any): JumpRow[] {
      return rankJump(this.rows, this.query);
    },
    activeId(this: any): string | null {
      return this.filtered()[this.index] ? `jump-option-${this.index}` : null;
    },
    onInput(this: any, event: Event): void {
      const target = event.target;
      if (target instanceof HTMLInputElement) this.query = target.value;
      this.index = 0;
    },
    move(this: any, step: number): void {
      const count = this.filtered().length;
      if (!count) return;
      this.index = (this.index + step + count) % count;
      void this.$nextTick(() => this.$refs.list?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
    },
    keydown(this: any, event: KeyboardEvent): void {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") { event.preventDefault(); this.close(); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); this.move(1); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); this.move(-1); return; }
      if (event.key === "Home" || event.key === "End") {
        const count = this.filtered().length;
        if (!count) return;
        event.preventDefault(); this.index = event.key === "Home" ? 0 : count - 1; this.move(0); return;
      }
      if (event.key === "Enter") { event.preventDefault(); this.choose(); }
    },
    choose(this: any, row?: JumpRow): void {
      const target = row ?? this.filtered()[this.index];
      if (!target) return;
      this._invoker = null;
      this.close();
      window.dispatchEvent(new CustomEvent("slirc:jump-pick", { detail: { row: target } }));
    },
    close(this: any): void {
      const invoker = this._invoker;
      this._invoker = null;
      this.query = "";
      this.index = 0;
      this.rows = [];
      if (this._dialog?.open) this._dialog.close();
      if (invoker?.isConnected) invoker.focus();
    },
  };
}

export interface ChannelSearchOpenDetail {
  conversationId: string;
  label: string;
  isNotes: boolean;
  exhausted: boolean;
  search: (query: string, kind?: SearchKind | null) => Promise<SearchResult>;
  loadOlder: () => Promise<LoadOlderResult>;
}

// Cmd+F (Ctrl+F off Apple) channel search palette over cached messages and Notes.
export function channelSearchDialogComponent(): Record<string, unknown> {
  return {
    conversationId: "",
    label: "",
    isNotes: false,
    exhausted: false,
    query: "",
    kind: null as SearchKind | null,
    hasQuery: false,
    searching: false,
    loadingOlder: false,
    loadError: "",
    hits: [] as SearchHit[],
    total: 0,
    index: 0,
    _seq: 0,
    _dialog: null as HTMLDialogElement | null,
    _invoker: null as HTMLElement | null,
    _onOpen: null as ((event: Event) => void) | null,
    _searchFn: null as ((query: string, kind?: SearchKind | null) => Promise<SearchResult>) | null,
    _loadOlderFn: null as (() => Promise<LoadOlderResult>) | null,
    init(this: any): void {
      this._dialog = document.querySelector<HTMLDialogElement>("#channel-search-dialog");
      this._onOpen = (event: Event): void => {
        if (this._dialog?.open) { this.close(); return; }
        const detail = (event as CustomEvent<ChannelSearchOpenDetail>).detail;
        const active = document.activeElement as HTMLElement | null;
        this._invoker = active && active !== document.body && typeof active.focus === "function" ? active : null;
        this.conversationId = detail.conversationId;
        this.label = detail.label;
        this.isNotes = detail.isNotes;
        this.exhausted = detail.exhausted;
        this._searchFn = detail.search;
        this._loadOlderFn = detail.loadOlder;
        this.query = "";
        this.kind = null;
        this.hasQuery = false;
        this.searching = false;
        this.loadingOlder = false;
        this.loadError = "";
        this.hits = [];
        this.total = 0;
        this.index = 0;
        this._seq += 1;
        void this.$nextTick(() => {
          if (this._dialog && !this._dialog.open) this._dialog.showModal();
          this.$refs.search?.focus();
        });
      };
      window.addEventListener("slirc:channel-search-open", this._onOpen);
    },
    destroy(this: any): void {
      if (this._onOpen) window.removeEventListener("slirc:channel-search-open", this._onOpen);
      this._onOpen = null;
      this._dialog = null;
      this._invoker = null;
      this._searchFn = null;
      this._loadOlderFn = null;
    },
    placeholder(this: any): string {
      return this.label ? `Search in ${this.label}` : "Search messages";
    },
    activeId(this: any): string | null {
      return this.hits[this.index] ? `channel-search-option-${this.index}` : null;
    },
    statusText(this: any): string {
      if (this.loadError) return this.loadError;
      if (this.hasQuery && this.total > 0) {
        const count = this.total > this.hits.length
          ? `Showing ${this.hits.length} of ${this.total} matches`
          : `${this.total} ${this.total === 1 ? "match" : "matches"}`;
        return this.exhausted && !this.isNotes ? `${count} · Start of ${this.label}` : count;
      }
      if (!this.hasQuery) return "";
      if (this.isNotes) return "";
      if (this.exhausted) return `Start of ${this.label}`;
      return "Loaded messages only";
    },
    toggleKind(this: any, kind: SearchKind): void {
      this.kind = this.kind === kind ? null : kind;
      void this.runSearch();
      this.$refs.search?.focus();
    },
    clear(this: any): void {
      this.query = "";
      void this.runSearch();
      this.$refs.search?.focus();
    },
    onInput(this: any, event: Event): void {
      const target = event.target;
      if (target instanceof HTMLInputElement) this.query = target.value;
      void this.runSearch();
    },
    async runSearch(this: any): Promise<void> {
      const seq = ++this._seq;
      const parsed = parseSearchQuery(this.query);
      this.hasQuery = hasSearchCriteria(parsed) || !!this.kind;
      if (!this.hasQuery || !this._searchFn) {
        this.hits = [];
        this.total = 0;
        this.index = 0;
        this.searching = false;
        return;
      }
      this.searching = true;
      try {
        const result = await this._searchFn(this.query, this.kind);
        if (seq !== this._seq || !this._dialog?.open) return;
        this.hits = result.hits;
        this.total = result.total;
        this.index = 0;
      } finally {
        if (seq === this._seq) this.searching = false;
      }
    },
    async loadOlder(this: any): Promise<void> {
      if (this.isNotes || this.exhausted || this.loadingOlder || !this._loadOlderFn) return;
      const targetId = this.conversationId;
      this.loadingOlder = true;
      this.loadError = "";
      try {
        const result = await this._loadOlderFn();
        if (this.conversationId !== targetId || !this._dialog?.open) return;
        if (!result.hasMore) this.exhausted = true;
        if (this.hasQuery) await this.runSearch();
      } catch {
        if (this.conversationId === targetId) this.loadError = "Could not load older messages.";
      } finally {
        if (this.conversationId === targetId) this.loadingOlder = false;
      }
    },
    move(this: any, step: number): void {
      const count = this.hits.length;
      if (!count) return;
      this.index = (this.index + step + count) % count;
      void this.$nextTick(() => this.$refs.list?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
    },
    keydown(this: any, event: KeyboardEvent): void {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") { event.preventDefault(); this.close(); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); this.move(1); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); this.move(-1); return; }
      if (event.key === "Home" || event.key === "End") {
        const count = this.hits.length;
        if (!count) return;
        event.preventDefault(); this.index = event.key === "Home" ? 0 : count - 1; this.move(0); return;
      }
      if (event.key === "Enter") { event.preventDefault(); this.choose(); }
    },
    choose(this: any, row?: SearchHit): void {
      const target = row ?? this.hits[this.index];
      if (!target) return;
      const conversationId = this.conversationId;
      this._invoker = null;
      this.close();
      window.dispatchEvent(new CustomEvent("slirc:channel-search-pick", { detail: { conversationId, focusId: target.focusId } }));
    },
    close(this: any): void {
      const invoker = this._invoker;
      this._invoker = null;
      this._seq += 1;
      this.conversationId = "";
      this.label = "";
      this.isNotes = false;
      this.exhausted = false;
      this.query = "";
      this.kind = null;
      this.hasQuery = false;
      this.searching = false;
      this.loadingOlder = false;
      this.loadError = "";
      this.hits = [];
      this.total = 0;
      this.index = 0;
      this._searchFn = null;
      this._loadOlderFn = null;
      if (this._dialog?.open) this._dialog.close();
      if (invoker?.isConnected) invoker.focus();
    },
  };
}
