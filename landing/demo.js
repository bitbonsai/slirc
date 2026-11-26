/* Slirc landing demos. One scripted conversation, rendered through the app's own markup:
   a phone frame, a desktop frame, and the same room as Halloy shows it. No dependencies. */
(() => {
  "use strict";

  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ROOM = "a-team";
  const TOPIC = "Slirc, made in the open";
  const TOPICS = { [ROOM]: TOPIC, watercooler: "Everything that is not work" };
  const THREAD = "#t-3fa921";
  const UPLOAD = "https://app.slirc.org/uploads/Qk3pXz9vL2mN8rT1wY5aBc?type=image";
  const PHOTO = "/img/demo-photo.jpg";
  const VIEWER = "bitbonsai";

  const PEOPLE = {
    bitbonsai: { avatar: "/img/mauricio.png", name: "Wolff", sub: "@bitbonsai", admin: true },
    ricardo: { avatar: "/img/ricardo.jpg", name: "Ricardo", sub: "@ricardo" },
    lewis: { avatar: "/img/lewis.jpg", name: "Lewis", sub: "@lewis" },
    "pi-bitbonsai": { kind: "agent", avatar: "/img/ui/pi.svg", sub: "mac-mini" },
    remind: { kind: "bot", name: "remind", avatar: "/img/ui/remind.svg", sub: "Bot" },
    maya: { name: "Maya", sub: "" },
    jonas: { name: "Jonas", sub: "" },
  };

  // Same hash as app.js nickColor(), so demo colours match the live app.
  const COLORS = ["#f5c2e7", "#cba6f7", "#eba0ac", "#fab387", "#f9e2af", "#a6e3a1", "#94e2d5", "#89dceb", "#74c7ec", "#89b4fa", "#b4befe"];
  const nickColor = (nick) => {
    const hash = [...nick.toLowerCase()].reduce((v, c) => (Math.imul(31, v) + c.charCodeAt(0)) | 0, 0);
    return COLORS[(hash >>> 0) % COLORS.length];
  };

  const t = (v) => ({ t: "text", v });
  const code = (v) => ({ t: "code", v });
  const mention = (v) => ({ t: "mention", v });
  const link = (v, label = v) => ({ t: "link", v, label });
  const gif = (query, v) => ({ t: "gif", query, v });

  // #watercooler, already there when someone clicks the rail. Static, with a YouTube card and reactions.
  const YT = { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Rick Astley - Never Gonna Give You Up (Official Video)", site: "YouTube", thumb: "/img/yt-rick.jpg" };
  const WATER = [
    { type: "msg", room: "watercooler", id: "w2", nick: "maya", time: "08:12", segs: [t("friday playlist. starting strong "), link(YT.url)], embed: YT },
    { type: "react", id: "w2", emoji: "😂", by: "lewis", count: 3 },
    { type: "react", id: "w2", emoji: "💩", by: "ricardo", count: 1 },
    { type: "msg", room: "watercooler", id: "w3", nick: "ricardo", time: "08:13", segs: [t("no 🙈")] },
    { type: "msg", room: "watercooler", id: "w6", nick: "lewis", time: "08:34", segs: [t("still hearing that song")] },
    { type: "react", id: "w6", emoji: "😂", by: "maya", count: 2 },
    { type: "react", id: "w6", emoji: "🦄", by: "jonas", count: 1 },
  ];
  const MEMBERS = { [ROOM]: ["bitbonsai", "ricardo", "lewis", "pi-bitbonsai"], watercooler: ["bitbonsai", "ricardo", "lewis", "maya", "jonas", "pi-bitbonsai"] };

  // Already in the room when the visitor arrives.
  const SEED = [
    { type: "msg", id: "s1", nick: "bitbonsai", time: "08:51", segs: [t("morning folks ☀️")] },
    { type: "msg", id: "s2", nick: "lewis", time: "08:53", segs: [t("G'day!")] },
  ];

  // The conversation, in ms from start.
  const SCRIPT = [
    { at: 400, type: "msg", id: "m1", nick: "ricardo", time: "09:12", segs: [t("Pebble 8B just dropped, runs on a laptop 👀")] },
    { at: 2200, type: "msg", id: "m2", nick: "lewis", time: "09:13", segs: [t("would it run on my Mac mini? M4, 16 GB")] },
    { at: 3600, type: "react", id: "m1", emoji: "👀", by: "lewis" },
    { at: 5800, type: "typing", text: "@pi-bitbonsai can you try Pebble on our mac-mini?" },
    { at: 8000, type: "msg", id: "m3", nick: "bitbonsai", time: "09:15", segs: [mention("@pi-bitbonsai"), t(" can you try Pebble on our mac-mini?")] },
    { at: 8500, type: "status", id: "m3", label: "Queued" },
    { at: 9500, type: "status", id: "m3", label: "Working" },
    { at: 13000, type: "status", id: "m3", label: "" },
    { at: 13000, type: "msg", id: "m4", nick: "pi-bitbonsai", time: "09:16", segs: [t("Same M4, 16 GB here: 38 tokens/s, using 6 GB. Lewis's will be fine.")] },
    { at: 14600, type: "react", id: "m4", emoji: "🔥", by: "ricardo" },
    { at: 15400, type: "react", id: "m4", emoji: "🔥", by: "lewis", count: 2 },
    { at: 16800, type: "msg", id: "m5", nick: "lewis", time: "09:17", segs: [t("thanks "), mention("@pi-bitbonsai")] },
    { at: 17800, type: "react", id: "m5", emoji: "🙏", by: "pi-bitbonsai" },
    { at: 19000, type: "msg", id: "m6", nick: "bitbonsai", time: "09:17", segs: [mention("@remind"), t(" Saturday 10:00 set up Pebble on lewis's Mac mini")] },
    { at: 19300, type: "member", nick: "remind" },
    { at: 20100, type: "react", id: "m6", emoji: "👀", by: "remind" },
    { at: 21300, type: "msg", id: "m7", nick: "remind", time: "09:17", segs: [t("Reminder Saturday at 10:00: set up Pebble on lewis's Mac mini.")] },
    { at: 24000, type: "unread", room: "watercooler", count: 3 },
    { at: 29000, type: "end" },
  ];

  const el = (tag, cls, html) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  };
  // A new row pushes a flex-end list up in one layout step. Hold the list where it was with a
  // translate offset of the row's height, then let the CSS transition carry it back to 0. A row
  // that lands mid-slide adds its height to the current offset, so a burst reads as one motion.
  const slide = (list, d) => {
    if (REDUCED || !(d > 0) || list.classList.contains("fading")) return;
    const current = parseFloat(getComputedStyle(list).translate.split(" ")[1]) || 0;
    list.style.transition = "none";
    list.style.translate = `0 ${current + d}px`;
    void list.offsetHeight;
    list.style.transition = "";
    list.style.translate = "";
  };
  // Run a change that may grow a flex-end list (a row, a reaction chip, a thread link), then slide
  // by exactly the height it added. Changes inside a hidden room add nothing and do not move.
  const grow = (list, change) => {
    const before = list.offsetHeight;
    change();
    slide(list, list.offsetHeight - before);
  };
  const svg = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    thread: svg('<path d="M20 4v7a4 4 0 0 1-4 4H4"/><path d="m9 10-5 5 5 5"/>'),
    chevron: svg('<path d="m6 9 6 6 6-6"/>'),
    back: svg('<path d="m15 18-6-6 6-6"/>'),
    right: svg('<path d="m9 6 6 6-6 6"/>'),
    admin: '<svg class="admin-badge" viewBox="0 0 24 24" role="img" aria-label="Administrator"><path d="M16.051 12.616a1 1 0 0 1 1.909.024l.737 1.452a1 1 0 0 0 .737.535l1.634.256a1 1 0 0 1 .588 1.806l-1.172 1.168a1 1 0 0 0-.282.866l.259 1.613a1 1 0 0 1-1.541 1.134l-1.465-.75a1 1 0 0 0-.912 0l-1.465.75a1 1 0 0 1-1.539-1.133l.258-1.613a1 1 0 0 0-.282-.866l-1.156-1.153a1 1 0 0 1 .572-1.822l1.633-.256a1 1 0 0 0 .737-.535z"/><path d="M8 15H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/></svg>',
  };
  const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function avatar(nick, cls) {
    const p = PEOPLE[nick] || {};
    const wrap = el("span", cls);
    if (p.avatar) {
      const img = el("img");
      img.src = p.avatar;
      img.alt = "";
      wrap.append(img);
    }
    const fallback = el("span", null, nick.slice(0, 1).toUpperCase());
    fallback.style.cssText = `background: ${nickColor(nick)}; color: #11111b`;
    if (p.avatar) fallback.hidden = true;
    wrap.append(fallback);
    return wrap;
  }

  function segsHtml(segs) {
    return segs.map((s) => {
      if (s.t === "code") return `<span class="body-seg"><code>${escape(s.v)}</code></span>`;
      if (s.t === "mention") return `<span class="body-seg"><button type="button" class="mention">${escape(s.v)}</button></span>`;
      if (s.t === "link") return `<span class="body-seg"><a class="message-link" href="${escape(s.v)}" target="_blank" rel="noopener">${s.label === s.v ? escape(s.label) : `<strong>${escape(s.label)}</strong>`}</a></span>`;
      if (s.t === "gif") return `<span class="body-seg"><span>[Giphy: ${escape(s.query)}]</span><img src="${escape(s.v)}" alt=""></span>`;
      return `<span class="body-seg"><span>${escape(s.v)}</span></span>`;
    }).join("");
  }

  function photoNode() {
    const details = el("details", "image-preview");
    details.open = true;
    details.innerHTML = `<summary aria-label="Toggle image"><svg class="image-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></summary>`;
    const img = el("img");
    img.alt = "";
    img.src = PHOTO;
    img.addEventListener("error", () => img.replaceWith(el("div", "demo-photo")));
    details.append(img);
    return details;
  }

  function embedNode(card) {
    const wrap = el("div", "embed-card");
    const thumb = el("div", "embed-thumb embed-player");
    thumb.setAttribute("role", "button");
    thumb.tabIndex = -1;
    thumb.setAttribute("aria-label", `Play ${card.title}`);
    thumb.innerHTML = `<img src="${card.thumb}" alt="" loading="lazy"><span class="embed-player-copy"><strong>${escape(card.title)}</strong><small>${card.site}</small></span><span class="embed-play" aria-hidden="true"></span>`;
    thumb.addEventListener("click", () => window.open(card.url, "_blank", "noopener"));
    wrap.append(thumb);
    return wrap;
  }

  /* ---- PWA frame (phone or desktop). live = the rail's rooms respond to clicks. ---- */
  function mountPwa(frame, layout, live = false) {
    frame.classList.add("frame", `frame--${layout}`);
    if (live) frame.classList.add("frame--live");
    frame.setAttribute("aria-label", `Slirc on ${layout}, #${ROOM}`);
    const phone = layout === "phone";
    frame.innerHTML = `
      ${phone ? '<div class="iphone-status" aria-hidden="true"><span class="iphone-time">9:41</span><span class="iphone-island"></span><span class="iphone-icons"><img src="/img/ui/iphone-signal.svg" alt=""><img src="/img/ui/iphone-wifi.svg" alt=""><img src="/img/ui/iphone-battery.svg" alt=""></span></div>' : ""}
      <header>
        <button type="button" class="mobile-back" aria-label="Back">${ICON.back}</button>
        <a class="header-logo" href="https://app.slirc.org/" tabindex="-1"><img class="header-mark" src="/img/ui/logo.svg" alt=""></a>
        <div class="room-heading"><div class="room-heading-main">
          <button type="button" class="room-title"><span class="room-mark channel" aria-hidden="true" data-mark><span class="lock-icon"></span></span><span class="room-title-text"><span>${ROOM}</span><small class="room-subtitle">${TOPIC}</small></span></button>
        </div></div>
        <div class="header-dms"></div>
        <button type="button" class="members-toggle active" aria-label="Members"><span class="members-icon"></span></button>
      </header>
      <aside class="rooms-sheet" aria-hidden="true">
        <div class="section-row"><button type="button" class="section-title">${svg('<path d="m9 6 6 6-6 6"/>')}<span>Channels</span></button><button type="button" class="section-add"><img src="/img/ui/plus.svg" alt=""></button></div>
        <div class="channel-row"><button type="button" class="room active" data-room="${ROOM}"><span class="room-mark channel"><span class="lock-icon"></span></span><span><span class="room-name">${ROOM}</span></span><span class="unread-badge" hidden></span></button></div>
        <div class="channel-row nested-thread" data-thread hidden><button type="button" class="room thread-room"><span class="room-mark">${ICON.thread}</span><span><span class="thread-name"></span></span></button></div>
        <div class="channel-row"><button type="button" class="room" data-room="watercooler"><span class="room-mark channel">#</span><span><span class="room-name">watercooler</span></span><span class="unread-badge">2</span></button></div>
        <div class="channel-row"><button type="button" class="room"><span class="room-mark channel">#</span><span><span class="room-name">help</span></span></button></div>
        <div class="section-row"><button type="button" class="section-title">${svg('<path d="m9 6 6 6-6 6"/>')}<span>Direct messages</span></button></div>
        <div class="channel-row" data-dm="ricardo"></div>
        <div class="channel-row" data-dm="lewis"></div>
        <div class="panel-footer"><div class="profile-card"><button type="button" class="profile-main"><span class="profile-avatar" data-avatar="bitbonsai"></span><div class="profile-copy"><strong><span>Wolff</span>${ICON.admin}</strong><small>@bitbonsai</small></div></button></div></div>
      </aside>
      <main class="chat"><div class="messages history-settled"><div class="date-divider">Today</div></div></main>
      <div class="composer" role="group" aria-label="Message composer">
        <div class="composer-editor"><div class="composer-input">Message #${ROOM} or / for commands</div></div>
        <label class="composer-plus" aria-hidden="true"><img src="/img/ui/plus.svg" alt=""></label>
        <button type="button" class="composer-send" aria-label="Send message"><img src="/img/ui/send.svg" alt=""></button>
      </div>
      <aside class="members-panel" aria-hidden="true">
        <div class="members-head"><strong>Members</strong><small>4 members</small></div>
        <div class="members-group"><p class="members-label"><span>Online</span><span>4</span></p><div class="member-list"></div></div>
      </aside>
      <nav class="mobile-nav" aria-hidden="true">
        <button type="button" class="active"><img class="menu-icon" src="/img/ui/nav-home.svg" alt=""><span class="nav-label">Home</span></button>
        <button type="button"><img class="menu-icon" src="/img/ui/nav-dms.svg" alt=""><span class="nav-label">DMs</span></button>
        <button type="button"><img class="menu-icon" src="/img/ui/nav-more.svg" alt=""><span class="nav-label">More</span></button>
      </nav>`;

    frame.querySelector("[data-avatar]").replaceWith(avatar("bitbonsai", "profile-avatar"));
    for (const nick of ["ricardo", "lewis"]) {
      const row = frame.querySelector(`[data-dm="${nick}"]`);
      const btn = el("button", "room");
      btn.type = "button";
      btn.append(avatar(nick, "room-mark person"), el("span", null, `<span class="room-name">${PEOPLE[nick]?.name || nick}</span>`));
      row.append(btn);
    }
    const list = frame.querySelector(".member-list");
    const joined = new Set();
    const memberRow = (nick) => {
      const p = PEOPLE[nick];
      const row = el("button", "member-row online");
      row.type = "button";
      row.append(avatar(nick, "room-mark person"));
      const copy = el("span", "member-copy");
      copy.innerHTML = `<span class="member-nick"><span>${p.name || nick}</span>${p.admin ? ICON.admin : ""}${p.kind ? `<span class="agent-mark" aria-hidden="true">${p.kind}</span>` : ""}</span>${p.sub ? `<small>${p.sub}</small>` : ""}`;
      row.append(copy);
      return row;
    };
    const fillMembers = (room) => {
      const members = [...MEMBERS[room], ...(room === ROOM ? joined : [])];
      list.replaceChildren(...members.map(memberRow));
      frame.querySelector(".members-head small").textContent = `${members.length} members`;
      frame.querySelector(".members-label span:last-child").textContent = members.length;
    };
    fillMembers(ROOM);

    const messages = frame.querySelector(".messages");
    const composer = frame.querySelector(".composer");
    const input = frame.querySelector(".composer-input");
    const byId = new Map();
    const lastByRoom = {};
    const unread = { [ROOM]: 0, watercooler: 2 };
    let current = ROOM;
    let typingTimer = 0;
    let draft = null;
    const showDraft = () => {
      if (current === ROOM && draft) { input.classList.add("typing"); input.textContent = draft; }
      else { input.classList.remove("typing"); input.textContent = `Message #${current} or / for commands`; }
    };
    showDraft();

    const badge = (room) => {
      const b = frame.querySelector(`.room[data-room="${room}"] .unread-badge`);
      if (!b) return;
      b.textContent = unread[room];
      b.hidden = unread[room] === 0;
    };
    const showRoom = (room) => {
      current = room;
      unread[room] = 0;
      badge(room);
      messages.querySelectorAll(".message-entry").forEach((n) => { n.hidden = n.dataset.room !== room; });
      frame.querySelectorAll(".room[data-room]").forEach((b) => b.classList.toggle("active", b.dataset.room === room));
      frame.querySelector(".room-title-text > span").textContent = room;
      frame.querySelector("[data-mark]").innerHTML = room === ROOM ? '<span class="lock-icon"></span>' : "#";
      fillMembers(room);
      frame.querySelector(".room-subtitle").textContent = TOPICS[room] || "";
      clearTimeout(typingTimer);
      showDraft();
      const pill = composer.querySelector(".bot-thinking");
      if (pill) pill.hidden = room !== ROOM;
      const thread = frame.querySelector("[data-thread]");
      thread.hidden = room !== ROOM || !thread.dataset.ready;
    };
    if (live) {
      frame.querySelectorAll(".room[data-room]").forEach((b) => b.addEventListener("click", () => showRoom(b.dataset.room)));
    }

    const api = {
      reset() {
        joined.clear();
        fillMembers(current);
        messages.querySelectorAll('.message-entry:not([data-room="watercooler"])').forEach((n) => n.remove());
        for (const key of [...byId.keys()]) if (!key.startsWith("w")) byId.delete(key);
        lastByRoom[ROOM] = null;
        api.thinking(null);
        api.typing(null);
        const thread = frame.querySelector("[data-thread]");
        thread.hidden = true;
        delete thread.dataset.ready;
      },
      member(nick) {
        joined.add(nick);
        if (current !== ROOM) return;
        fillMembers(current);
        list.lastElementChild?.classList.add("arrive");
      },
      add(m) {
        const room = m.room || ROOM;
        const entry = el("div", "message-entry");
        entry.dataset.room = room;
        entry.hidden = room !== current;
        if (room !== current && live) { unread[room] += 1; badge(room); }
        const msg = el("div", "msg" + (lastByRoom[room] === m.nick ? " cont" : ""));
        const p = PEOPLE[m.nick] || {};
        msg.innerHTML = `<button type="button" class="message-add" aria-hidden="true"></button><span class="time">${m.time}</span><button type="button" class="nick" style="color: ${nickColor(m.nick)}"><span>${m.nick}</span>${p.kind ? `<small>${p.kind}</small>` : ""}</button>`;
        msg.append(avatar(m.nick, "message-avatar"));
        msg.insertAdjacentHTML("beforeend", `<span class="mobile-time">${m.time}</span>`);
        const body = el("span", "body");
        const copy = el("span", "message-copy", segsHtml(m.segs));
        if (m.photo) copy.append(photoNode());
        body.append(copy);
        if (m.embed) body.append(embedNode(m.embed));
        msg.append(body);
        entry.append(msg);
        grow(messages, () => messages.append(entry));
        byId.set(m.id, { msg, body, nick: m.nick });
        lastByRoom[room] = m.nick;
      },
      fade(on) {
        messages.classList.toggle("fading", on && current === ROOM);
      },
      unread(room, count) {
        if (!live) return;
        if (room === current) return;
        unread[room] = count;
        badge(room);
      },
      react(id, emoji, by, count = 1) {
        const m = byId.get(id);
        if (!m) return;
        // Chips pop in on their own (stamp); a list slide on top reads as double motion.
        let chips = m.body.querySelector(".reaction-chips");
        if (!chips) { chips = el("span", "reaction-chips"); m.body.append(chips); }
        // A second reaction with the same emoji bumps its chip instead of adding another.
        const same = [...chips.children].find((c) => c.firstElementChild?.textContent === emoji);
        if (same) { same.querySelector("small").textContent = count; return; }
        const chip = el("button", "reaction-chip stamp" + (by === VIEWER ? " mine" : ""), `<span>${emoji}</span><small>${count}</small>`);
        chip.type = "button";
        chip.title = by;
        chips.append(chip);
      },
      thread(id, count, by) {
        const m = byId.get(id);
        if (!m) return;
        const faces = by.map((nick) => {
          const a = PEOPLE[nick]?.avatar;
          return a ? `<img src="${a}" alt="" title="${nick}">` : `<span style="background:${nickColor(nick)}">${nick[0].toUpperCase()}</span>`;
        }).join("");
        const label = `${count} ${count === 1 ? "reply" : "replies"}` + (phone ? "" : " · Open thread");
        grow(messages, () => {
          let link = m.body.querySelector(".thread-link");
          if (!link) {
            link = el("button", "thread-link");
            link.type = "button";
            m.body.append(link);
          }
          link.innerHTML = `${ICON.thread}<span class="thread-avatars">${faces}</span><span>${label}</span>`;
        });
        const row = frame.querySelector("[data-thread]");
        row.dataset.ready = "1";
        row.hidden = current !== ROOM;
        row.querySelector(".thread-name").textContent = m.body.querySelector(".body-seg span")?.textContent || "thread";
      },
      // The label the app shows under your own message while your agent has it: Queued, then Working.
      status(id, label) {
        const m = byId.get(id);
        if (!m) return;
        let node = m.body.querySelector(".agent-request-status");
        if (!label) { node?.remove(); return; }
        if (!node) { node = el("span", "agent-request-status"); node.setAttribute("role", "status"); m.body.querySelector(".message-copy").append(node); }
        node.textContent = label;
      },
      thinking(nick) {
        composer.querySelector(".bot-thinking")?.remove();
        if (!nick) return;
        composer.prepend(el("div", "bot-thinking", `<span class="thinking-label">${nick} is thinking</span><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>`));
      },
      typing(text) {
        clearTimeout(typingTimer);
        draft = text || null;
        if (!text || current !== ROOM) { showDraft(); return; }
        input.classList.add("typing");
        if (REDUCED) { input.textContent = text; return; }
        let i = 0;
        input.textContent = "";
        const step = () => {
          i += 1;
          input.textContent = text.slice(0, i);
          if (i < text.length) typingTimer = setTimeout(step, 45 + Math.random() * 40);
        };
        step();
      },
    };
    return api;
  }

  /* ---- IRC frame: the room as Halloy shows it ---- */
  function mountIrc(frame) {
    frame.classList.add("frame", "frame--irc");
    frame.setAttribute("aria-label", `The same #${ROOM} in Halloy, an IRC client`);
    frame.innerHTML = `
      <aside class="irc-side" aria-hidden="true">
        <div class="irc-server">app.slirc.org</div>
        <span class="irc-buffer active">#${ROOM}</span>
        <span class="irc-buffer" data-thread hidden>${THREAD}</span>
        <span class="irc-buffer">#watercooler</span>
        <span class="irc-buffer">#help</span>
        <span class="irc-buffer">#dm-bitbonsai-ricardo</span>
      </aside>
      <div class="irc-main">
        <div class="irc-title"><span>#${ROOM}</span><small>${TOPIC}</small></div>
        <div class="irc-lines"><div class="irc-rows"></div></div>
        <div class="irc-input" aria-hidden="true"></div>
      </div>`;
    const lines = frame.querySelector(".irc-lines");
    const rows = lines.firstElementChild;
    const byId = new Map();
    const line = (time, nick, html, cls = "") => {
      const row = el("div", `irc-line ${cls}`.trim());
      row.innerHTML = `<time>${time}</time><b style="color:${nickColor(nick)}">${nick}</b><span>${html}</span>`;
      grow(rows, () => rows.append(row));
      return row;
    };
    const plain = (segs) => segs.map((s) => escape(s.t === "gif" ? `[Giphy: ${s.query}] ${s.v}` : s.t === "link" && s.label !== s.v ? `${s.label} (${s.v})` : s.v)).join("");
    return {
      reset() { rows.innerHTML = ""; byId.clear(); frame.querySelector("[data-thread]").hidden = true; },
      fade(on) { lines.classList.toggle("fading", on); },
      add(m) {
        if (m.room && m.room !== ROOM) return;
        line(m.time, m.nick, plain(m.segs));
        // An upload is a second line in the same multiline message: a bare URL.
        if (m.photo) line(m.time, m.nick, `<a href="${UPLOAD}">${UPLOAD}</a>`);
        byId.set(m.id, m);
      },
      react() {}, // Reactions never reach IRC.
      thinking() {},
      typing() {},
      thread(id, count, by) {
        if (count !== 1) return;
        const m = byId.get(id);
        const title = plain(m.segs).slice(0, 60);
        const url = `https://app.slirc.org/?room=%23${ROOM}&msg=k3f9`;
        line(m.time, by[0], `↳ thread ${THREAD} — ${title} — <a href="${url}">${url}</a>`);
        frame.querySelector("[data-thread]").hidden = false;
      },
    };
  }

  /* ---- Timeline ---- */
  function apply(renderers, ev) {
    for (const r of renderers) {
      if (ev.type === "msg") r.add(ev);
      else if (ev.type === "member") r.member?.(ev.nick);
      else if (ev.type === "react") r.react(ev.id, ev.emoji, ev.by, ev.count);
      else if (ev.type === "unread") r.unread?.(ev.room, ev.count);
      else if (ev.type === "thread") r.thread(ev.id, ev.count, ev.by);
      else if (ev.type === "thinking") r.thinking(ev.nick);
      else if (ev.type === "status") r.status?.(ev.id, ev.label);
      else if (ev.type === "typing") r.typing(ev.text);
    }
    if (ev.type === "msg") for (const r of renderers) r.typing(null);
  }

  function applyAll(renderers) {
    for (const ev of SEED) apply(renderers, ev);
    for (const ev of SCRIPT) if (ev.type !== "typing" && ev.type !== "thinking") apply(renderers, ev);
  }

  function play(frame, renderers) {
    if (REDUCED) { applyAll(renderers); return; }
    let timer = 0;
    let index = 0;
    let started = 0;
    let elapsed = 0;
    let visible = false;

    const start = () => {
      for (const r of renderers) r.reset();
      for (const ev of SEED) apply(renderers, ev);
      index = 0;
      elapsed = 0;
      for (const r of renderers) r.fade?.(false);
      schedule();
    };
    const schedule = () => {
      clearTimeout(timer);
      if (!visible) return;
      const ev = SCRIPT[index];
      if (!ev) return;
      started = performance.now() - elapsed;
      timer = setTimeout(fire, Math.max(0, ev.at - elapsed));
    };
    const fire = () => {
      const ev = SCRIPT[index];
      elapsed = ev.at;
      index += 1;
      if (ev.type === "end") {
        for (const r of renderers) r.fade?.(true);
        timer = setTimeout(start, 900);
        return;
      }
      apply(renderers, ev);
      schedule();
    };
    new IntersectionObserver(([entry]) => {
      const now = entry.isIntersecting;
      if (now && !visible) { visible = true; schedule(); }
      else if (!now && visible) { visible = false; elapsed += performance.now() - started; clearTimeout(timer); }
    }, { threshold: 0.2 }).observe(frame);
    for (const r of renderers) r.reset();
    for (const ev of SEED) apply(renderers, ev);
  }

  /* ---- Fit 56rem frames into narrower containers ---- */
  const NARROW = matchMedia("(max-width: 759px)");
  function fit(frame, natural) {
    const parent = frame.parentElement;
    const update = () => {
      const n = natural();
      frame.style.setProperty("--frame-scale", n ? Math.min(1, parent.clientWidth / n).toFixed(3) : "1");
    };
    new ResizeObserver(update).observe(parent);
    update();
  }

  /* ---- Agent beat: the pairing command runs, then the agent shows up in the members list ---- */
  function mountAgent(root) {
    const list = root.querySelector(".member-list");
    const count = root.querySelector("[data-count]");
    const online = root.querySelector("[data-online]");
    const term = (name) => root.querySelector(`[data-term="${name}"]`);
    const memberRow = (nick) => {
      const p = PEOPLE[nick];
      const row = el("button", "member-row online");
      row.type = "button";
      row.append(avatar(nick, "room-mark person"));
      const copy = el("span", "member-copy");
      copy.innerHTML = `<span class="member-nick"><span>${p.name || nick}</span>${p.admin ? ICON.admin : ""}${p.kind === "agent" ? '<span class="agent-mark" aria-hidden="true">agent</span>' : ""}</span>${p.sub ? `<small>${p.sub}</small>` : ""}`;
      row.append(copy);
      return row;
    };
    for (const nick of ["bitbonsai", "ricardo", "lewis"]) list.append(memberRow(nick));

    const CMD = "/slirc";
    const log = term("log");
    const steps = ["sent", "tool", "out", "say", "done"];
    const show = (name) => { term(name).hidden = false; };
    const arrive = () => {
      if (list.querySelector('[data-nick="pi-bitbonsai"]')) return;
      const row = memberRow("pi-bitbonsai");
      row.dataset.nick = "pi-bitbonsai";
      row.classList.add("arrive");
      list.append(row);
      count.textContent = "4 members";
      online.textContent = "4";
    };
    const leave = () => {
      list.querySelector('[data-nick="pi-bitbonsai"]')?.remove();
      count.textContent = "3 members";
      online.textContent = "3";
    };
    if (REDUCED) { steps.forEach(show); arrive(); return; }

    let timers = [];
    const after = (ms, fn) => timers.push(setTimeout(fn, ms));
    const type = (node, text, done) => {
      let i = 0;
      const step = () => {
        i += 1;
        node.textContent = text.slice(0, i);
        if (i < text.length) after(38 + Math.random() * 34, step);
        else after(400, done);
      };
      step();
    };
    const run = () => {
      steps.forEach((n) => { term(n).hidden = true; });
      log.classList.remove("fading");
      term("cmd").textContent = "";
      after(600, () => type(term("cmd"), CMD, () => {
        term("cmd").textContent = "";
        show("sent");
        after(700, () => show("tool"));
        after(1000, arrive);
        after(2600, () => show("out"));
        after(4200, () => show("say"));
        after(5000, () => show("done"));
        after(9500, () => { log.classList.add("fading"); leave(); });
        after(10200, run);
      }));
    };
    let visible = false;
    new IntersectionObserver(([entry]) => {
      const now = entry.isIntersecting;
      if (now && !visible) { visible = true; run(); }
      else if (!now && visible) { visible = false; timers.forEach(clearTimeout); timers = []; }
    }, { threshold: 0.4 }).observe(root);
  }

  /* ---- Busy Halloy buffer for the IRC chapter ---- */
  const BUSY = [
    { time: "08:41", event: "join", nick: "maya" },
    { time: "08:41", nick: "maya", text: "here. reading from Halloy on the train" },
    { time: "08:42", nick: "lewis", text: "the reconnect fix landed on main" },
    { time: "08:43", nick: "bitbonsai", text: "@lewis what changed in reconnect.ts since yesterday" },
    { time: "08:43", nick: "lewis", text: "the retry waits up to 30 seconds now. Both reconnect tests pass." },
    { time: "08:44", nick: "lewis", text: "phone screenshot after the fix" },
    { time: "08:44", nick: "lewis", link: "https://app.slirc.org/uploads/n8Rt1wY5aBcQk3pXz9vL2m?type=image" },
    { time: "08:45", nick: "ricardo", text: "\u21b3 thread #t-9c21ab \u2014 the reconnect fix landed on main \u2014 ", link: `https://app.slirc.org/?room=%23${ROOM}&msg=7ab2` },
    { time: "08:46", event: "join", nick: "jonas" },
    { time: "08:46", nick: "jonas", text: "hi from WeeChat. history came through, nice" },
    { time: "08:47", nick: "maya", text: "same room, whatever client" },
    { time: "08:48", nick: "bitbonsai", text: "that is the point" },
  ];

  function mountBusy(frame) {
    frame.classList.add("frame", "frame--irc", "frame--busy");
    frame.innerHTML = `
      <aside class="irc-side" aria-hidden="true">
        <div class="irc-server">app.slirc.org</div>
        <span class="irc-buffer active">#${ROOM}</span>
        <span class="irc-buffer">#t-9c21ab</span>
        <span class="irc-buffer">#watercooler</span>
        <span class="irc-buffer">#help</span>
        <span class="irc-buffer">#dm-bitbonsai-lewis</span>
      </aside>
      <div class="irc-main">
        <div class="irc-title"><span>#${ROOM}</span><small>${TOPIC}</small></div>
        <div class="irc-lines"><div class="irc-rows"></div></div>
        <div class="irc-input" aria-hidden="true"></div>
      </div>`;
    const rows = frame.querySelector(".irc-rows");
    const render = (m) => {
      const row = el("div", "irc-line" + (m.event ? " event" : ""));
      let html;
      if (m.event === "join") html = `<time>${m.time}</time><b>→</b><span>${m.nick} joined #${ROOM}</span>`;
      else if (m.event === "part") html = `<time>${m.time}</time><b>←</b><span>${m.nick} left #${ROOM}</span>`;
      else html = `<time>${m.time}</time><b style="color:${nickColor(m.nick)}">${m.nick}</b><span>${escape(m.text || "")}${m.link ? `<a href="${m.link}">${m.link}</a>` : ""}</span>`;
      row.innerHTML = html;
      rows.append(row);
      while (rows.children.length > 40) rows.firstChild.remove();
      slide(rows, row.offsetHeight);
    };
    if (REDUCED) { BUSY.forEach(render); return; }
    let i = 0;
    let timer = 0;
    let visible = false;
    const tick = () => {
      if (!visible) return;
      if (i >= BUSY.length) {
        timer = setTimeout(() => {
          frame.classList.add("fading");
          timer = setTimeout(() => { rows.innerHTML = ""; frame.classList.remove("fading"); i = 0; tick(); }, 800);
        }, 5000);
        return;
      }
      render(BUSY[i]);
      i += 1;
      timer = setTimeout(tick, 900 + Math.random() * 900);
    };
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      clearTimeout(timer);
      if (visible) timer = setTimeout(tick, 300);
    }, { threshold: 0.3 }).observe(frame);
  }

  /* ---- Mount points ---- */
  const busy = document.querySelector("[data-demo=irc-busy]");
  if (busy) mountBusy(busy);

  const agent = document.querySelector("[data-demo=agent]");
  if (agent) mountAgent(agent);

  const hero = document.querySelector("[data-demo=hero]");
  if (hero) {
    const layout = matchMedia("(max-width: 759px)").matches ? "phone" : "desktop";
    const live = layout === "desktop";
    const r = mountPwa(hero, layout, live);
    if (live) { fit(hero, () => 64 * 16); for (const ev of WATER) apply([r], ev); r.unread("watercooler", 2); }
    play(hero, [r]);
  }

  const sw = document.querySelector("[data-demo=switcher]");
  if (sw) {
    const panel = (name) => sw.querySelector(`[role="tabpanel"][data-view="${name}"]`);
    const frames = { phone: panel("phone"), desktop: panel("desktop"), irc: panel("irc") };
    const renderers = [mountPwa(frames.phone, "phone"), mountPwa(frames.desktop, "desktop"), mountIrc(frames.irc)];
    fit(frames.desktop, () => (NARROW.matches ? 44 : 64) * 16);
    fit(frames.irc, () => (NARROW.matches ? 0 : 64 * 16));
    applyAll(renderers);

    const tabs = [...sw.querySelectorAll('[role="tab"]')];
    const stage = sw.querySelector(".stage");
    const fitStage = () => { stage.style.height = `${frames[sw.dataset.view].getBoundingClientRect().height}px`; };
    const initial = NARROW.matches ? "desktop" : "phone";
    const select = (name, focus) => {
      const first = !sw.dataset.view;
      sw.dataset.view = name;
      tabs.forEach((tab) => {
        const on = tab.dataset.view === name;
        tab.setAttribute("aria-selected", on);
        tab.tabIndex = on ? 0 : -1;
        if (on && focus) tab.focus();
      });
      const order = ["phone", "desktop", "irc"];
      const top = order.indexOf(name);
      Object.entries(frames).forEach(([k, f]) => {
        f.dataset.depth = (order.indexOf(k) - top + 3) % 3;
        f.classList.toggle("is-active", k === name);
        f.setAttribute("aria-hidden", k !== name);
      });
      fitStage();
      if (!first && name !== initial) sw.classList.add("switched");
    };
    new ResizeObserver(fitStage).observe(stage);
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => select(tab.dataset.view));
      tab.addEventListener("keydown", (e) => {
        const i = tabs.indexOf(tab);
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          select(tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length].dataset.view, true);
        }
      });
    });
    select(initial);
    addEventListener("load", fitStage);
  }
})();

/* Guide dialogs: the link opens a short answer in place; without JS it goes to the docs. */
(() => {
  for (const link of document.querySelectorAll("[data-dialog]")) {
    const dlg = document.getElementById(link.dataset.dialog);
    if (!dlg || typeof dlg.showModal !== "function") continue;
    link.addEventListener("click", (e) => { e.preventDefault(); dlg.showModal(); });
    for (const close of dlg.querySelectorAll("[data-close]")) close.addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  }
})();

/* Phone menu: a blurred full-page overlay; the hamburger becomes an X. */
(() => {
  const btn = document.querySelector(".menu-btn");
  const menu = document.getElementById("menu");
  if (!btn || !menu) return;
  const set = (open) => {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    document.body.style.overflow = open ? "hidden" : "";
  };
  btn.addEventListener("click", () => set(menu.hidden));
  menu.addEventListener("click", (e) => { if (e.target === menu || e.target.closest("a")) set(false); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) set(false); });
})();
