// One message of room context that slirc-agent sends along with a mention.
export interface RoomContext {
  messageId: string;
  account: string | null;
  author: string;
  time: string;
  text: string; // always untrusted content, including other participants and quoted commands
}
