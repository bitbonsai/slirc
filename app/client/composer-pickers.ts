import { foldIdentifier } from "@client/model.ts";
import { inviteCandidates, inviteToken, mentionCandidates, mentionToken } from "@client/mentions.ts";
import { agentInviteMatches, agentLabel, mentionableNick, ownAgentNicks } from "@client/agent-roster.ts";
import { hiddenCommands, slashSuggestions, type SlashCommand } from "@client/commands.ts";
import { hasMoreRight } from "@client/presentation.ts";
import { type OpenPopup } from "@client/popups.ts";

export function giphyPickerComponent(): Record<string, unknown> {
  return {
    moreRight: false,
    index: 0,
    giphyResults: [] as unknown[],
    _observer: null as ResizeObserver | null,
    _onResize: null as (() => void) | null,
    _onScroll: null as (() => void) | null,
    _onMove: null as ((event: Event) => void) | null,
    _onReset: null as ((event: Event) => void) | null,
    _onPick: null as (() => void) | null,
    _results: null as HTMLElement | null,
    init(this: any): void {
      this._results = this.$refs.results ?? document.querySelector(".giphy-results");
      this._onResize = () => this.sync();
      this._onScroll = () => this.sync();
      this._onMove = (event: Event) => this.move(((event as CustomEvent<{ delta?: number }>).detail?.delta ?? 0));
      this._onReset = (event: Event) => this.reset((event as CustomEvent<{ results?: unknown[] }>).detail?.results);
      this._onPick = () => this.pick();
      window.addEventListener("resize", this._onResize);
      window.addEventListener("slirc:giphy-move", this._onMove);
      window.addEventListener("slirc:giphy-reset", this._onReset);
      window.addEventListener("slirc:giphy-pick", this._onPick);
      if (this._results) {
        this._results.addEventListener("scroll", this._onScroll, { passive: true });
        this._observer = new ResizeObserver(() => this.sync());
        this._observer.observe(this._results);
      }
      this.sync();
    },
    destroy(this: any): void {
      if (this._onResize) window.removeEventListener("resize", this._onResize);
      if (this._onMove) window.removeEventListener("slirc:giphy-move", this._onMove);
      if (this._onReset) window.removeEventListener("slirc:giphy-reset", this._onReset);
      if (this._onPick) window.removeEventListener("slirc:giphy-pick", this._onPick);
      if (this._results && this._onScroll) this._results.removeEventListener("scroll", this._onScroll);
      this._observer?.disconnect();
      this._observer = null;
      this._onResize = null;
      this._onScroll = null;
      this._onMove = null;
      this._onReset = null;
      this._onPick = null;
      this._results = null;
    },
    // The fade is shown only while the one horizontal row still has content off-screen right.
    sync(this: any): void {
      const el: HTMLElement | null = this._results ?? this.$refs.results ?? null;
      this.moreRight = !!el && el.getClientRects().length > 0 && hasMoreRight(el.scrollLeft, el.scrollWidth, el.clientWidth);
    },
    // Selection wraps, then keeps the highlighted row reachable without moving the shared list.
    move(this: any, delta: number): void {
      const list: unknown[] = Array.isArray(this.giphyResults) ? this.giphyResults : [];
      if (!list.length) return;
      this.index = (this.index + delta + list.length) % list.length;
      void this.$nextTick(() => {
        this.$refs.results?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    },
    reset(this: any, results?: unknown[]): void {
      this.index = 0;
      if (Array.isArray(results)) this.giphyResults = results;
    },
    // Picking hands the chosen row back through a narrow event; the parent owns the durable send.
    pick(this: any): void {
      const list: unknown[] = Array.isArray(this.giphyResults) ? this.giphyResults : [];
      const item = list[this.index];
      if (item) window.dispatchEvent(new CustomEvent("slirc:giphy-send", { detail: item }));
    },
  };
}

export function slashHelpPanelComponent(openPopup?: OpenPopup): Record<string, unknown> {
  return {
    index: 0,
    dismissed: false,
    _onMove: null as ((event: Event) => void) | null,
    _onDismiss: null as (() => void) | null,
    _onReset: null as (() => void) | null,
    _onChoose: null as (() => void) | null,
    init(this: any): void {
      this._onMove = (event: Event) => this.move(((event as CustomEvent<{ delta?: number }>).detail?.delta ?? 0));
      this._onDismiss = () => this.dismiss();
      this._onReset = () => this.reset();
      this._onChoose = () => this.choose();
      window.addEventListener("slirc:slash-move", this._onMove);
      window.addEventListener("slirc:slash-dismiss", this._onDismiss);
      window.addEventListener("slirc:slash-reset", this._onReset);
      window.addEventListener("slirc:slash-choose", this._onChoose);
    },
    destroy(this: any): void {
      if (this._onMove) window.removeEventListener("slirc:slash-move", this._onMove);
      if (this._onDismiss) window.removeEventListener("slirc:slash-dismiss", this._onDismiss);
      if (this._onReset) window.removeEventListener("slirc:slash-reset", this._onReset);
      if (this._onChoose) window.removeEventListener("slirc:slash-choose", this._onChoose);
      this._onMove = null;
      this._onDismiss = null;
      this._onReset = null;
      this._onChoose = null;
    },
    matches(this: any): SlashCommand[] {
      if (this.dismissed) return [];
      return slashSuggestions(String(this.composer ?? ""), Array.isArray(this.helpers) ? hiddenCommands(this.helpers, this.isAdmin === true) : []);
    },
    move(this: any, delta: number): void {
      const list = this.matches();
      if (!list.length) return;
      this.index = (this.index + delta + list.length) % list.length;
      void this.$nextTick(() => this.scrollActive());
    },
    reset(this: any): void {
      this.index = 0;
      this.dismissed = false;
    },
    dismiss(this: any): void {
      this.dismissed = true;
    },
    choose(this: any, command?: SlashCommand): void {
      const target = command ?? this.matches()[this.index];
      if (!target) return;
      this.reset();
      window.dispatchEvent(new CustomEvent("slirc:slash-run", { detail: { name: target.name } }));
    },
    scrollActive(this: any): void {
      this.$refs.list?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    },
    // Coordination only: the composer reads whether the list is open for its ArrowUp behavior.
    sync(this: any): void {
      const open = this.matches().length > 0;
      if (open && this._onDismiss) openPopup?.(this._onDismiss);
      window.dispatchEvent(new CustomEvent("slirc:slash-open", { detail: { open } }));
    },
  };
}

// `/invite ev` searches people instead: whoever you invite is usually not in the room yet, so the
// list comes from the server's people search, with its discoverability rule.
export const INVITE_SEARCH_DELAY_MS = 200;

export function mentionPickerComponent(openPopup?: OpenPopup): Record<string, unknown> {
  return {
    index: 0,
    dismissed: false,
    inviteResults: [] as string[],
    inviteFor: null as string | null,
    _inviteAsked: "",
    _inviteTimer: null as ReturnType<typeof setTimeout> | null,
    _inviteAbort: null as AbortController | null,
    _onMove: null as ((event: Event) => void) | null,
    _onDismiss: null as (() => void) | null,
    _onReset: null as (() => void) | null,
    _onChoose: null as (() => void) | null,
    init(this: any): void {
      this._onMove = (event: Event) => this.move(((event as CustomEvent<{ delta?: number }>).detail?.delta ?? 0));
      this._onDismiss = () => this.dismiss();
      this._onReset = () => this.reset();
      this._onChoose = () => this.choose();
      window.addEventListener("slirc:mention-move", this._onMove);
      window.addEventListener("slirc:mention-dismiss", this._onDismiss);
      window.addEventListener("slirc:mention-reset", this._onReset);
      window.addEventListener("slirc:mention-choose", this._onChoose);
    },
    destroy(this: any): void {
      if (this._onMove) window.removeEventListener("slirc:mention-move", this._onMove);
      if (this._onDismiss) window.removeEventListener("slirc:mention-dismiss", this._onDismiss);
      if (this._onReset) window.removeEventListener("slirc:mention-reset", this._onReset);
      if (this._onChoose) window.removeEventListener("slirc:mention-choose", this._onChoose);
      this._onMove = null;
      this._onDismiss = null;
      this._onReset = null;
      this._onChoose = null;
      this.stopInviteSearch();
    },
    matches(this: any): string[] {
      if (this.dismissed) return [];
      const invite = inviteToken(String(this.composer ?? ""));
      if (invite !== null) {
        if (!invite) return [];
        // People search never lists agents, so your own come first, straight from the local roster.
        const agents = agentInviteMatches(this.agentProfiles, String(this.account ?? ""), invite);
        // Until the fresh answer lands, keep the last list narrowed to nicks that still fit.
        const fits = this.inviteFor === null ? [] : this.inviteFor === invite ? this.inviteResults : this.inviteResults.filter((nick: string) => foldIdentifier(nick).includes(foldIdentifier(invite)));
        return inviteCandidates([...agents, ...fits].filter((nick, i, all) => all.findIndex((other) => foldIdentifier(other) === foldIdentifier(nick)) === i),
          [String(this.account ?? ""), ...(Array.isArray(this.roomMembers) ? this.roomMembers : [])]);
      }
      const token = mentionToken(String(this.composer ?? ""), this.emoji?.caret ?? undefined);
      if (!token) return [];
      const members: string[] = Array.isArray(this.roomMembers) ? [...this.roomMembers] : [];
      // Open channels hide their roster, so fall back to people who have spoken in the room. A room
      // with a roster doesn't need it, and its history still names agents that were removed.
      if (Array.isArray(this.messages) && (this.roomMembersPublic || !members.length)) {
        for (const message of this.messages) if (message?.authorNick) members.push(message.authorNick);
      }
      // Direct peers are a relationship I already have, safe to mention from any conversation.
      // Members of other channels are deliberately never included, so a secret channel never leaks.
      if (Array.isArray(this.directs)) {
        for (const direct of this.directs) if (direct?.nick) members.push(direct.nick);
      }
      // So are your own agents, DM or not.
      members.push(...ownAgentNicks(this.agentProfiles, String(this.account ?? "")));
      const self = foldIdentifier(String(this.account ?? ""));
      const without = (list: unknown): string[] => (Array.isArray(list) ? list : []).filter((nick) => foldIdentifier(String(nick)) !== self);
      const attached = (nick: string) => typeof this.agentAttached === "function" && this.agentAttached(nick) === true;
      return mentionCandidates(token.query, without(members), without(this.contacts), (nick) => mentionableNick(this.agentProfiles, nick, attached));
    },
    // An agent shows under its current display name; the nick is what the pick inserts.
    label(this: any, nick: string): string {
      return agentLabel(this.agentProfiles, nick);
    },
    move(this: any, delta: number): void {
      const list = this.matches();
      if (!list.length) return;
      this.index = (this.index + delta + list.length) % list.length;
      void this.$nextTick(() => this.scrollActive());
    },
    reset(this: any): void {
      this.index = 0;
      this.dismissed = false;
    },
    dismiss(this: any): void {
      this.dismissed = true;
    },
    choose(this: any, nick?: string): void {
      const target = nick ?? this.matches()[this.index];
      if (!target) return;
      this.reset();
      window.dispatchEvent(new CustomEvent("slirc:mention-pick", { detail: { nick: target } }));
    },
    scrollActive(this: any): void {
      this.$refs.list?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    },
    stopInviteSearch(this: any): void {
      if (this._inviteTimer) clearTimeout(this._inviteTimer);
      this._inviteTimer = null;
      this._inviteAbort?.abort();
      this._inviteAbort = null;
    },
    // Debounced; a newer query aborts the older request, and only the latest answer is kept.
    searchInvite(this: any, query: string): void {
      this.stopInviteSearch();
      this._inviteTimer = setTimeout(async () => {
        this._inviteTimer = null;
        const abort = new AbortController();
        this._inviteAbort = abort;
        try {
          const response = await fetch(`/api/people?q=${encodeURIComponent(query)}&limit=8`, { credentials: "same-origin", signal: abort.signal });
          const body = response.ok ? await response.json() : {};
          if (abort.signal.aborted) return;
          this.inviteResults = Array.isArray(body.people) ? body.people.map((person: { nick?: unknown }) => person?.nick).filter((nick: unknown): nick is string => typeof nick === "string" && !!nick) : [];
          this.inviteFor = query;
          this.index = 0;
          this.sync();
        } catch { /* aborted or offline: the list just stays as it was */ }
        finally { if (this._inviteAbort === abort) this._inviteAbort = null; }
      }, INVITE_SEARCH_DELAY_MS);
    },
    sync(this: any): void {
      // Escape (or another popup opening) hides the list for the current token only; once that token
      // is gone, the next `@` or `/invite` opens it again.
      const text = String(this.composer ?? "");
      if (this.dismissed && !inviteToken(text) && (!mentionToken(text, this.emoji?.caret ?? undefined) || inviteToken(text) === "")) this.reset();
      const invite = this.dismissed ? null : inviteToken(String(this.composer ?? ""));
      if (!invite) { this._inviteAsked = ""; this.stopInviteSearch(); }
      else if (invite !== this._inviteAsked) { this._inviteAsked = invite; if (invite !== this.inviteFor) this.searchInvite(invite); }
      const open = this.matches().length > 0;
      if (open && this._onDismiss) openPopup?.(this._onDismiss);
      window.dispatchEvent(new CustomEvent("slirc:mention-open", { detail: { open } }));
    },
  };
}
