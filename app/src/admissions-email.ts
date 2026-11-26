import { brandKind } from "./config.ts";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] as string));
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const shell = (origin: string, subject: string, preheader: string, content: string, footer: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<meta name="supported-color-schemes" content="dark" />
<title>${escapeHtml(subject)}</title>

</head>
<body class="page" style="margin:0;padding:0;background:#11111b;color:#cdd6f4;font-family:${SANS};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" class="page" width="100%" cellpadding="0" cellspacing="0" bgcolor="#11111b" style="background:#11111b;">
  <tr>
    <td align="center" style="padding:40px 16px 48px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
        <tr>
          <td align="left" style="padding:0 8px 28px;">
            <img src="${escapeHtml(origin)}/brand-${brandKind()}-dark@2x.png" width="180" alt="Slirc" style="display:block;width:180px;height:auto;" />
          </td>
        </tr>
${content}
        <tr>
          <td class="foot" align="left" style="padding:32px 8px 0;font-size:12px;line-height:1.6;color:#9399b2;">
            ${footer}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

export function admissionEmail({ token, origin, appOrigin, owner }: {
  token: string; origin: string; appOrigin: string; owner?: { nick?: string; name?: string };
}) {
  const subject = "Your Slirc access is ready";
  const root = new URL("/admission", appOrigin).href;
  const link = (destination: "help" | "founder") => `${root}#token=${encodeURIComponent(token)}&destination=${destination}`;
  const helpUrl = link("help");
  const founderUrl = link("founder");
  const safeHelpUrl = escapeHtml(helpUrl);
  const safeFounderUrl = escapeHtml(founderUrl);
  const ownerNick = (owner?.nick || "").trim();
  const ownerName = (owner?.name || "").trim();
  const preheader = "Chat with your people. Bring a friend.";
  const dmHtml = ownerNick
    ? `Try it with a friend and tell me what feels confusing. You can <a href="${safeFounderUrl}" style="color:#62f6a7;text-decoration:underline;">DM me inside Slirc</a> at <strong>@${escapeHtml(ownerNick)}</strong>.`
    : `Try it with a friend and tell us what feels confusing. You can <a href="${safeFounderUrl}" style="color:#62f6a7;text-decoration:underline;">DM the instance admin inside Slirc</a>.`;
  const dmText = ownerNick
    ? `Try it with a friend and tell me what feels confusing. You can DM me inside Slirc at @${ownerNick}: ${founderUrl}`
    : `Try it with a friend and tell us what feels confusing. You can DM the instance admin inside Slirc: ${founderUrl}`;
  const signoffHtml = ownerNick || ownerName
    ? `\n            <p class="lead" style="margin:0;font-size:16px;line-height:1.65;color:#bac2de;">See you there,${ownerName ? `<br><strong>${escapeHtml(ownerName)}</strong>` : ""}${ownerNick ? `<br><span style="font-size:13px;color:#9399b2;">@${escapeHtml(ownerNick)}</span>` : ""}</p>`
    : "";
  const signoffText = ownerNick || ownerName
    ? `\n\nSee you there,${ownerName ? `\n${ownerName}` : ""}${ownerNick ? `\n@${ownerNick}` : ""}`
    : "";
  const content = `
        <tr>
          <td style="padding:0 8px;">
            <h1 class="h1" style="margin:0 0 18px;font-size:36px;line-height:1.1;letter-spacing:-1px;font-weight:700;color:#cdd6f4;">You're in.</h1>
            <p class="lead" style="margin:0 0 24px;font-size:17px;line-height:1.6;color:#bac2de;">Welcome to <strong>Slirc</strong>. A place to chat with your people, in channels or one-to-one.</p>
            <h2 class="h1" style="margin:0 0 8px;font-size:19px;line-height:1.3;font-weight:700;color:#cdd6f4;">Make a channel. Bring a friend.</h2>
            <p class="lead" style="margin:0 0 24px;font-size:16px;line-height:1.65;color:#bac2de;">Create an open channel or keep it invite-only. Start a DM. Share messages, photos, GIFs and video links. Invite friends by email from inside <strong>Slirc</strong>.</p>
            <p class="lead" style="margin:0 0 24px;font-size:16px;line-height:1.65;color:#bac2de;">Choose a display name and sign in by email. Help will meet you inside with a short introduction.</p>
            <p class="lead" style="margin:0 0 28px;font-size:16px;line-height:1.65;color:#bac2de;">${dmHtml}</p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px;"><tr><td bgcolor="#62f6a7" style="background:#62f6a7;border-radius:10px;"><a href="${safeHelpUrl}" style="display:inline-block;padding:14px 24px;font-size:16px;font-weight:700;color:#11111b;text-decoration:none;">Join Slirc</a></td></tr></table>${signoffHtml}
          </td>
        </tr>`;
  const footer = "Your personal invitation expires in seven days.<br>Invite friends from inside Slirc rather than forwarding this link.";
  const text = `You're in.\n\nWelcome to Slirc. A place to chat with your people, in channels or one-to-one.\n\nMake a channel. Bring a friend.\nCreate an open channel or keep it invite-only. Start a DM. Share messages, photos, GIFs and video links. Invite friends by email from inside Slirc.\n\nChoose a display name and sign in by email. Help will meet you inside with a short introduction.\n\n${dmText}\n\nJoin Slirc: ${helpUrl}${signoffText}\n\nYour personal invitation expires in seven days.\nInvite friends from inside Slirc rather than forwarding this link.`;
  return { subject, html: shell(origin, subject, preheader, content, footer), text };
}
