import { HELP_TOPICS, filterHelpTopics, type HelpTopic } from "@client/help.ts";
import { hiddenCommands } from "@client/commands.ts";
import { rankJump, type JumpRow } from "@client/jump.ts";

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
