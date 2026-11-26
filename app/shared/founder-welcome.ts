// One approved owner welcome. Server queues the job; the owner's own signed-in browser sends
// it. Keep this the single source so the server, client and tests cannot drift.
export function founderWelcomeText(owner: { nick?: string; name?: string } = {}): string {
  const nick = (owner.nick || "").trim();
  const name = (owner.name || "").trim();
  const intro = name && nick && name.toLowerCase() !== nick.toLowerCase()
    ? `I'm ${name} (@${nick}), the owner of this instance.`
    : nick
      ? `I'm @${nick}, the owner of this instance.`
      : name
        ? `I'm ${name}, the owner of this instance.`
        : "I run this Slirc instance.";
  return `Hey, welcome to Slirc! ${intro} If anything feels confusing or broken, or you have an idea, leave feedback in #help or reply here. I read both. Thanks for trying it!`;
}
