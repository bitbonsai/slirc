// Row logic the phone lists and the desktop rail share. Mounted with x-data="conversationRows" on the
// rail's list and on the phone's Home and DMs screens. Each mount gets its own copy, and `this` reaches
// the client scope (direct, channel, isMuted and the open* handlers), the way the tab bar does.
type Item = { kind?: string; nick?: string; channel?: string; wireTarget?: string; conversationId?: string };
type Thread = { title: string; label: string; unread: number };
type Class = (string | false)[];

export type RowsScope = {
  direct: boolean;
  channel: string;
  isMuted(target: string): boolean;
  isStarred(id: string): boolean;
  conversationIdForDm(channel: string): string;
  avatarStatusLabel(nick: string): string;
  openDirect(nick: string): void;
  openRoom(target: string): void;
};

const roomActive = (s: RowsScope, target: string): boolean => !s.direct && s.channel === target;
const directActive = (s: RowsScope, nick: string): boolean => s.direct && s.channel === nick;
const dmId = (s: RowsScope, item: Item): string => s.conversationIdForDm(item.channel!);
const dmMuted = (s: RowsScope, item: Item): boolean => s.isMuted("dm:" + dmId(s, item));

export function conversationRowsComponent() {
  return {
    // A starred row is a DM or a room; each opens through its own handler.
    openStarred(this: RowsScope, item: Item): void {
      if (item.kind === "dm") this.openDirect(item.nick!);
      else this.openRoom(item.wireTarget!);
    },
    // The conversation id of a direct-message row, which the list items carry only as a channel.
    dmId(this: RowsScope, item: Item): string {
      return dmId(this, item);
    },
    rowTip(this: RowsScope, nick: string): string {
      return nick + " · " + this.avatarStatusLabel(nick);
    },
    // The aria-label of a phone row's star button.
    starLabel(this: RowsScope, id: string, noun: string): string {
      return (this.isStarred(id) ? "Unstar " : "Star ") + noun;
    },
    threadLabel(thread: Thread): string {
      return "Open thread: " + thread.title + ", " + thread.label + (thread.unread ? ", " + thread.unread + " unread" : "");
    },

    // Desktop rail: the open row is lit and a muted row is dimmed.
    starredClass(this: RowsScope, item: Item): Class {
      const dm = item.kind === "dm";
      const active = dm ? directActive(this, item.nick!) : roomActive(this, item.wireTarget!);
      return [active && "active", this.isMuted(dm ? "dm:" + item.conversationId : item.wireTarget!) && "muted-room"];
    },
    channelClass(this: RowsScope, item: Item): Class {
      return [roomActive(this, item.wireTarget!) && "active", this.isMuted(item.wireTarget!) && "muted-room"];
    },
    groupClass(this: RowsScope, item: Item): Class {
      return [roomActive(this, item.wireTarget!) && "active"];
    },
    dmClass(this: RowsScope, item: Item): Class {
      return [directActive(this, item.nick!) && "active", dmMuted(this, item) && "muted-room"];
    },

    // Phone lists light no row. Only starred DMs and DM rows dim when muted.
    starredPhoneClass(this: RowsScope, item: Item): string | false {
      return item.kind === "dm" && this.isMuted("dm:" + item.conversationId) && "muted-room";
    },
    dmPhoneClass(this: RowsScope, item: Item): string | false {
      return dmMuted(this, item) && "muted-room";
    },
  };
}
