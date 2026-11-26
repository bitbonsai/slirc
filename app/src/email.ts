// Magic-link email. Table layout and inline styles: email clients ignore most modern CSS.
// Logo is hotlinked from the app origin, the only external asset.

import { brandKind, slircMode } from "./config.ts";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] as string));

// Room names read as code, in the same green the button uses. `nowrap` keeps the
// name intact: without it the hyphen becomes a break point at 440px. Email clients
// need the stack inline and web-safe; there is no ui-monospace here.
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const roomChip = (room: string) => `<span style="font-family:${MONO};color:#a6e3a1;white-space:nowrap;">#${escapeHtml(room)}</span>`;
// Same treatment the app gives inline code: mono on a raised panel.
const nickChip = (nick: string) => `<span style="font-family:${MONO};font-size:.92em;color:#94e2d5;background-color:#24243a;padding:2px 6px;border-radius:5px;white-space:nowrap;">${escapeHtml(nick)}</span>`;

// The inviter's verified email sits next to their chosen name: a display name is free text, the
// address is what the recipient can recognise.
const inviterLabel = (inviter: string, inviterEmail?: string) => inviterEmail ? `${inviter} (${inviterEmail})` : inviter;

// After the button: the one step left, the expiry, and who can use the link. Opening the link is
// the email check, so there is nothing else to do.
// "Pre-launch" describes the public playground's invite-only period. A private workspace is just
// someone's own workspace, so its invitations say Join and leave that sentence out.
// The footer line. An instance with agents switched off must not advertise them.
const tagline = () => process.env.SLIRC_AGENTS_ENABLED === "false" ? "Like Slack, but yours" : "group chat your coding agents can join";
const prelaunch = () => slircMode() === "public_playground";
const joinLabel = () => "Join";
const prelaunchNote = () => prelaunch() ? " Slirc is in early access." : "";
const INVITE_NEXT = "One step: pick a display name. Expires in seven days.";
const INVITE_PERSONAL = "Only this address can use it. Didn't expect it? Ignore this email.";

// Shared by both invitation emails so they render the same in every client.
function inviteHtml({ subject, preheader, headingHtml, leadHtml, url, origin }: { subject: string; preheader: string; headingHtml: string; leadHtml: string; url: string; origin: string }) {
  const safeUrl = escapeHtml(url);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark light" />
<meta name="supported-color-schemes" content="dark light" />
<title>${escapeHtml(subject)}</title>
</head>
<body bgcolor="#11111b" style="margin:0;padding:0;background-color:#11111b;color:#cdd6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#11111b" style="background-color:#11111b;">
  <tr>
    <td align="center" bgcolor="#11111b" style="padding:40px 16px;background-color:#11111b;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#11111b" style="max-width:440px;background-color:#11111b;">
        <tr>
          <td align="left" bgcolor="#11111b" style="padding:0 8px 24px;background-color:#11111b;">
            <a href="${escapeHtml(origin)}" style="display:inline-block;text-decoration:none;"><img src="${escapeHtml(origin)}/brand-${brandKind()}-dark@2x.png" width="140" height="44" alt="Slirc wordmark" style="display:block;width:140px;height:44px;border:0;" /></a>
          </td>
        </tr>
        <tr>
          <td bgcolor="#11111b" style="padding:0 8px;background-color:#11111b;color:#cdd6f4;">
            <h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;font-weight:700;color:#cdd6f4;">${headingHtml}</h1>
            <p style="margin:0 0 24px;font-size:16px;line-height:1.5;color:#a6adc8;">${leadHtml}</p>
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td bgcolor="#a6e3a1" style="background-color:#a6e3a1;border-radius:10px;">
                  <a href="${safeUrl}" style="display:inline-block;padding:14px 22px;font-size:16px;font-weight:700;color:#11111b;text-decoration:none;">${joinLabel()}</a>
                </td>
              </tr>
            </table>
            <p style="margin:16px 0 0;font-size:14px;line-height:1.5;color:#9399b2;">${escapeHtml(INVITE_NEXT)}</p>
            <p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#7f849c;">${escapeHtml(INVITE_PERSONAL)}</p>
            <p style="margin:8px 0 0;font-size:12px;line-height:1.5;color:#7f849c;word-break:break-all;">If the button does not work, copy this link:<br /><a href="${safeUrl}" style="color:#94e2d5;">${safeUrl}</a></p>
          </td>
        </tr>
        <tr>
          <td align="left" bgcolor="#11111b" style="padding:24px 8px 0;font-size:12px;color:#7f849c;background-color:#11111b;">
            <a href="${escapeHtml(origin)}" style="color:#7f849c;text-decoration:none;">Slirc</a> &middot; ${tagline()}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

const inviteText = (heading: string, lead: string, url: string, origin: string) =>
  `${heading}\n\n${lead}\n\n${joinLabel()}: ${url}\n${INVITE_NEXT}\n\n${INVITE_PERSONAL}\n\nSlirc, ${origin}`;

// The workspace's host, in subjects and headings, so someone in several workspaces knows which one
// mailed them.
const workspaceOf = (origin: string) => { try { return new URL(origin).host; } catch { return origin; } };

export function directInviteEmail({ url, inviter, inviterEmail, origin }: { url: string; inviter: string; inviterEmail?: string; origin: string }) {
  const subject = `${inviter} invited you to chat on ${workspaceOf(origin)}`;
  const from = inviterLabel(inviter, inviterEmail);
  const lead = `${from} invited you to a private conversation.${prelaunchNote()}`;
  const heading = `${inviter} invited you to chat`;
  const html = inviteHtml({ subject, preheader: lead, headingHtml: escapeHtml(heading), leadHtml: escapeHtml(lead), url, origin });
  return { subject, html, text: inviteText(heading, lead, url, origin) };
}

export function inviteEmail({ url, channel, inviter, inviterEmail, origin }: { url: string; channel: string; inviter: string; inviterEmail?: string; origin: string }) {
  const room = channel.replace(/^#/, "");
  const subject = `${inviter} invited you to #${room} on ${workspaceOf(origin)}`;
  const chip = roomChip(room);
  const from = inviterLabel(inviter, inviterEmail);
  const lead = `${from} invited you to #${room}.${prelaunchNote()}`;
  const leadHtml = `${escapeHtml(from)} invited you to ${chip}.${prelaunchNote()}`;
  const html = inviteHtml({ subject, preheader: lead, headingHtml: `Join ${chip}`, leadHtml, url, origin });
  return { subject, html, text: inviteText(`Join #${room}`, lead, url, origin) };
}

export function magicLinkEmail({ url, code, nick, verified, origin }: { url: string; code?: string; nick: string; verified: boolean; origin: string }) {
  const workspace = workspaceOf(origin);
  const subject = verified ? `Your Slirc sign-in code for ${workspace}` : `Verify your Slirc email for ${workspace}`;
  const heading = verified ? `Sign in to ${workspace}` : `Verify to keep chatting on ${workspace}`;
  // Code first: it finishes sign-in in the tab that asked. The button is the one-tap alternative.
  const leadFor = (name: string) => code
    ? `Type this code where you entered your email${verified ? "" : ` to keep ${name} as your account`}.`
    : verified ? `Tap the button to open Slirc as ${name}.` : `Tap the button to verify your email and keep ${name} as your account.`;
  const alternativeFor = (name: string) => verified ? `Or open Slirc as ${name} with one tap.` : "Or tap the button to verify.";
  const lead = leadFor(nick);
  const alternative = alternativeFor(nick);
  const leadHtml = leadFor(nickChip(nick));
  const alternativeHtml = alternativeFor(nickChip(nick));
  const button = verified ? "Open Slirc" : "Verify and open Slirc";
  const safeUrl = escapeHtml(url);
  // Digits in two groups read faster; the app strips the space on entry.
  const spacedCode = code ? `${code.slice(0, 3)} ${code.slice(3)}` : "";
  const codeHtml = code ? `<p style="margin:0 0 6px;font-size:12px;line-height:1.4;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#7f849c;">Your code</p>
            <p style="margin:0 0 24px;font-family:${MONO};font-size:34px;line-height:1.2;font-weight:700;letter-spacing:.14em;color:#cdd6f4;">${escapeHtml(spacedCode)}</p>
            <p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#a6adc8;">${alternativeHtml}</p>
            ` : "";
  const expiry = code ? "The code and the link work once and expire in 15 minutes." : "This link works once and expires in 15 minutes.";
  const notYou = "Didn't request this? Ignore this email.";

  const text = code
    ? `${heading}

${lead}

${spacedCode}

${alternative.replace("with one tap.", "with this link:").replace("tap the button to verify.", "open this link to verify:")}

${url}

${expiry}
${notYou}`
    : `${heading}

${lead}

${url}

${expiry}
${notYou}`;
  const textTail = `

Slirc, ${origin}`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark light" />
<meta name="supported-color-schemes" content="dark light" />
<title>${escapeHtml(subject)}</title>
</head>
<body bgcolor="#11111b" style="margin:0;padding:0;background-color:#11111b;color:#cdd6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(lead)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#11111b" style="background-color:#11111b;">
  <tr>
    <td align="center" bgcolor="#11111b" style="padding:40px 16px;background-color:#11111b;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#11111b" style="max-width:440px;background-color:#11111b;">
        <tr>
          <td align="left" bgcolor="#11111b" style="padding:0 8px 24px;background-color:#11111b;">
            <a href="${escapeHtml(origin)}" style="display:inline-block;text-decoration:none;"><img src="${escapeHtml(origin)}/brand-${brandKind()}-dark@2x.png" width="140" height="44" alt="Slirc wordmark" style="display:block;width:140px;height:44px;border:0;" /></a>
          </td>
        </tr>
        <tr>
          <td bgcolor="#11111b" style="padding:0 8px;background-color:#11111b;color:#cdd6f4;">
            <h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;font-weight:700;color:#cdd6f4;">${escapeHtml(heading)}</h1>
            <p style="margin:0 0 24px;font-size:16px;line-height:1.5;color:#a6adc8;">${leadHtml}</p>
            ${codeHtml}<table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td bgcolor="#a6e3a1" style="background-color:#a6e3a1;border-radius:10px;">
                  <a href="${safeUrl}" style="display:inline-block;padding:14px 22px;font-size:16px;font-weight:700;color:#11111b;text-decoration:none;">${escapeHtml(button)}</a>
                </td>
              </tr>
            </table>
            <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#7f849c;">${escapeHtml(expiry)}</p>
            <p style="margin:8px 0 0;font-size:15px;line-height:1.5;font-weight:700;color:#cdd6f4;">${escapeHtml(notYou)}</p>
            <p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:#7f849c;word-break:break-all;">If the button does not work, copy this link:<br /><a href="${safeUrl}" style="color:#94e2d5;">${safeUrl}</a></p>
          </td>
        </tr>
        <tr>
          <td align="left" bgcolor="#11111b" style="padding:24px 8px 0;font-size:12px;color:#7f849c;background-color:#11111b;">
            <a href="${escapeHtml(origin)}" style="color:#7f849c;text-decoration:none;">Slirc</a> &middot; ${tagline()}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  return { subject, html, text: text + textTail };
}
