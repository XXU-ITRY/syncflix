/* ============================================================
   SyncFlix Frontend v4 — یکپارچه روی Worker
   ============================================================ */

// از همان مبدأ استفاده می‌کنیم:
const WS_BASE = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;

const state = {
  sessionToken: null,
  roomId: null,
  userId: null,
  displayName: "",
  isOwner: false,
  ws: null,
  wsOpen: false,
  reconnectAttempt: 0,
  outbox: [],
  users: [],
  chat: [],
  inviteToken: null,
  roomLocked: false,
  videoUrl: null,
  playing: false,
  serverOffset: 0,
  lastServerTime: 0,
  lastCurrentTime: 0,
  hls: null,
  driftTimer: null,
};

const $ = (s) => document.querySelector(s);
const landing = $("#landing");
const roomView = $("#room");
const video = $("#video");
const videoOverlay = $("#videoOverlay");

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
function showView(name) {
  landing.classList.toggle("active", name === "landing");
  roomView.classList.toggle("active", name === "room");
}
function setConn(status) {
  const el = $("#connStatus");
  el.textContent = status === "online" ? "متصل" : status === "connecting" ? "..." : "قطع";
  el.className = "status " + (status === "online" ? "online" : "offline");
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "خطای سرور");
  return data;
}

/* ساخت اتاق */
$("#btnCreate").onclick = async () => {
  const name = $("#createName").value.trim();
  const movie = $("#createMovie").value.trim();
  if (!name) return toast("نام نمایشی را وارد کنید.");
  try {
    const d = await api("/api/rooms", { displayName: name, videoUrl: movie || null });
    state.sessionToken = d.sessionToken;
    state.roomId = d.roomId;
    state.userId = d.userId;
    state.displayName = name;
    state.isOwner = true;
    state.inviteToken = d.inviteToken;
    enterRoom();
  } catch (e) { toast(e.message); }
};

/* ورود */
$("#btnJoin").onclick = async () => {
  const code = $("#joinCode").value.trim();
  const name = $("#joinName").value.trim();
  const err = $("#joinError");
  err.textContent = "";
  if (!code || !name) { err.textContent = "کد و نام الزامی است."; return; }
  try {
    const d = await api(`/api/rooms/${encodeURIComponent(code)}/join`, { displayName: name });
    state.sessionToken = d.sessionToken;
    state.roomId = code.toLowerCase();
    state.userId = d.userId;
    state.displayName = name;
    state.isOwner = !!d.isOwner;
    state.inviteToken = d.inviteToken;
    enterRoom();
  } catch (e) { err.textContent = e.message; }
};

(function checkInvite() {
  const p = new URLSearchParams(location.search);
  const room = p.get("room");
  if (room) {
    $("#joinCode").value = room;
    toast("کد اتاق از لینک پر شد. نام خود را وارد کنید.");
  }
})();

function enterRoom() {
  showView("room");
  $("#roomCode").textContent = "اتاق: " + state.roomId;
  refreshInviteLink();
  connectWS();
  startDriftCheck();
}

function connectWS() {
  if (state.ws) try { state.ws.close(); } catch {}
  setConn("connecting");

  const url = `${WS_BASE}/api/rooms/${state.roomId}/ws?token=${encodeURIComponent(state.sessionToken)}`;
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
    state.wsOpen = true;
    state.reconnectAttempt = 0;
    setConn("online");
    flushOutbox();
    send({ type: "sync_request" });
  };
  ws.onclose = () => {
    state.wsOpen = false;
    setConn("offline");
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.serverTime) noteServerTime(m.serverTime);
    handleMessage(m);
  };
}

function scheduleReconnect() {
  if (!state.sessionToken || !roomView.classList.contains("active")) return;
  const attempt = Math.min(state.reconnectAttempt++, 6);
  const delay = Math.min(1000 * 2 ** attempt, 30000) + Math.random() * 500;
  setTimeout(connectWS, delay);
}

function send(obj) {
  if (state.ws && state.wsOpen) {
    try { state.ws.send(JSON.stringify(obj)); return true; } catch {}
  }
  if (state.outbox.length < 50) state.outbox.push(obj);
  return false;
}
function flushOutbox() {
  const items = state.outbox.splice(0);
  items.forEach((o) => { try { state.ws.send(JSON.stringify(o)); } catch {} });
}

function noteServerTime(t) { if (t) state.serverOffset = t - Date.now(); }
function serverNow() { return Date.now() + state.serverOffset; }
function expectedTime() {
  if (!state.playing) return state.lastCurrentTime;
  return state.lastCurrentTime + (serverNow() - state.lastServerTime) / 1000;
}

function handleMessage(m) {
  switch (m.type) {
    case "state":
      state.users = m.users || [];
      state.chat = m.chat || [];
      state.isOwner = !!m.isOwner;
      state.roomLocked = !!m.locked;
      state.inviteToken = m.inviteToken;
      state.playing = !!m.playing;
      state.lastCurrentTime = m.currentTime || 0;
      state.lastServerTime = serverNow();
      if (m.videoUrl !== state.videoUrl) {
        state.videoUrl = m.videoUrl;
        loadVideo(state.videoUrl);
      }
      renderUsers();
      renderChat();
      updateOwnerUI();
      syncVideoToState();
      break;
    case "users":
      state.users = m.users || [];
      const me = state.users.find((u) => u.id === state.userId);
      if (me) state.isOwner = me.owner;
      renderUsers();
      updateOwnerUI();
      break;
    case "chat":
      state.chat.push(m.message);
      renderChat();
      break;
    case "chat_clear":
      state.chat = [];
      renderChat();
      break;
    case "play":
      state.playing = true;
      state.lastCurrentTime = m.currentTime;
      state.lastServerTime = serverNow();
      syncVideoToState();
      break;
    case "pause":
      state.playing = false;
      state.lastCurrentTime = m.currentTime;
      state.lastServerTime = serverNow();
      video.pause();
      break;
    case "seek":
      state.lastCurrentTime = m.currentTime;
      state.lastServerTime = serverNow();
      try { video.currentTime = m.currentTime; } catch {}
      if (state.playing) safePlay();
      break;
    case "movie":
      state.videoUrl = m.videoUrl;
      loadVideo(m.videoUrl);
      break;
    case "locked":
      state.roomLocked = !!m.locked;
      updateOwnerUI();
      break;
    case "invite_rotated":
      state.inviteToken = m.inviteToken;
      refreshInviteLink();
      toast("لینک دعوت تغییر کرد.");
      break;
    case "owner_changed":
      toast("مالکیت منتقل شد.");
      break;
    case "kicked":
      toast("شما از اتاق حذف شدید.", 5000);
      leaveRoom();
      break;
    case "room_closed":
      toast("اتاق بسته شد.", 5000);
      leaveRoom();
      break;
    case "pong": break;
    case "error": toast(m.message || "خطا"); break;
  }
}

function renderUsers() {
  const ul = $("#userList");
  ul.innerHTML = "";
  state.users.forEach((u) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span>${escapeHtml(u.name)}</span>
      ${u.owner ? '<span class="ownerBadge">Owner</span>' : ""}
      ${u.online ? "" : '<span class="offlineDot">آفلاین</span>'}
    `;
    if (state.isOwner && u.id !== state.userId) {
      const k = document.createElement("button");
      k.className = "kickBtn";
      k.textContent = "حذف";
      k.onclick = () => {
        if (confirm(`«${u.name}» حذف شود؟`)) send({ type: "kick", userId: u.id });
      };
      li.appendChild(k);
    }
    ul.appendChild(li);
  });
  $("#userCount").textContent = state.users.length;
}

function renderChat() {
  const log = $("#chatLog");
  log.innerHTML = "";
  state.chat.forEach((m) => {
    const d = document.createElement("div");
    d.className = "msg" + (m.userId === state.userId ? " mine" : "");
    d.innerHTML = `
      <div class="meta">${escapeHtml(m.name)} · ${new Date(m.at).toLocaleTimeString("fa-IR")}</div>
      <div class="body">${escapeHtml(m.text)}</div>
    `;
    log.appendChild(d);
  });
  log.scrollTop = log.scrollHeight;
}

function destroyHls() {
  if (state.hls) try { state.hls.destroy(); } catch {}
  state.hls = null;
}

function loadVideo(url) {
  destroyHls();
  video.onloadedmetadata = null;
  video.onerror = null;
  if (!url) {
    video.removeAttribute("src");
    video.load();
    videoOverlay.textContent = "فیلمی انتخاب نشده است.";
    return;
  }
  const isHls = /\.m3u8($|\?)/i.test(url);
  videoOverlay.textContent = "در حال بارگذاری...";

  if (isHls && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ enableWorker: true });
    state.hls = hls;
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      videoOverlay.textContent = "";
      syncVideoToState();
    });
    hls.on(window.Hls.Events.ERROR, (_e, d) => {
      if (d.fatal) videoOverlay.textContent = "خطا در HLS.";
    });
  } else if (isHls && video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url; video.load();
    video.onloadedmetadata = () => { videoOverlay.textContent = ""; syncVideoToState(); };
  } else {
    video.src = url; video.load();
    video.onloadedmetadata = () => { videoOverlay.textContent = ""; syncVideoToState(); };
    video.onerror = () => { videoOverlay.textContent = "خطا در بارگذاری ویدئو (CORS یا لینک)."; };
  }
}

function syncVideoToState() {
  const target = expectedTime();
  if (Number.isFinite(target) && Math.abs(video.currentTime - target) > 1.5) {
    try { video.currentTime = target; } catch {}
  }
  if (state.playing) safePlay(); else video.pause();
}
function safePlay() {
  const p = video.play();
  if (p && p.catch) p.catch(() => {});
}
function startDriftCheck() {
  if (state.driftTimer) clearInterval(state.driftTimer);
  state.driftTimer = setInterval(() => {
    if (!state.playing) return;
    const drift = video.currentTime - expectedTime();
    if (Math.abs(drift) > 3) try { video.currentTime = expectedTime(); } catch {}
  }, 5000);
}

video.addEventListener("play", () => {
  if (!state.isOwner || !state.wsOpen) return;
  send({ type: "control", action: "play", currentTime: video.currentTime });
});
video.addEventListener("pause", () => {
  if (!state.isOwner || !state.wsOpen || video.seeking) return;
  send({ type: "control", action: "pause", currentTime: video.currentTime });
});
video.addEventListener("seeked", () => {
  if (!state.isOwner || !state.wsOpen) return;
  send({ type: "control", action: "seek", currentTime: video.currentTime });
});

$("#btnPlay").onclick = () => send({ type: "control", action: "play", currentTime: video.currentTime });
$("#btnPause").onclick = () => send({ type: "control", action: "pause", currentTime: video.currentTime });
$("#btnLock").onclick = () => send({ type: "lock", locked: !state.roomLocked });
$("#btnRotateInvite").onclick = () => {
  if (confirm("لینک دعوت قبلی باطل شود؟")) send({ type: "rotate_invite" });
};
$("#btnClearChat").onclick = () => {
  if (confirm("همه پیام‌های چت پاک شوند؟")) send({ type: "clear_chat" });
};
$("#btnCloseRoom").onclick = () => {
  if (confirm("اتاق برای همه بسته شود؟")) send({ type: "close_room" });
};
$("#btnChangeMovie").onclick = () => {
  const url = $("#ownerMovie").value.trim();
  if (!url) return toast("لینک فیلم را وارد کنید.");
  send({ type: "set_movie", videoUrl: url });
};
$("#btnCopyInvite").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("#inviteLink").value);
    toast("کپی شد.");
  } catch {
    $("#inviteLink").select();
    document.execCommand("copy");
    toast("کپی شد.");
  }
};

function updateOwnerUI() {
  $("#ownerPanel").classList.toggle("hidden", !state.isOwner);
  $("#btnLock").textContent = state.roomLocked ? "🔓 بازکردن" : "🔒 قفل";
  ["#btnPlay", "#btnPause", "#btnChangeMovie", "#ownerMovie"].forEach((s) => {
    const el = $(s);
    if (el) el.disabled = !state.isOwner;
  });
  refreshInviteLink();
}
function refreshInviteLink() {
  if (!state.inviteToken) {
    $("#inviteLink").value = "لینک دعوت غیرفعال است.";
    return;
  }
  $("#inviteLink").value =
    `${location.origin}/?room=${encodeURIComponent(state.roomId)}&invite=${encodeURIComponent(state.inviteToken)}`;
}

$("#chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const inp = $("#chatInput");
  const text = inp.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  inp.value = "";
});

function leaveRoom() {
  if (state.driftTimer) clearInterval(state.driftTimer);
  destroyHls();
  if (state.ws) try { state.ws.close(); } catch {}
  state.ws = null;
  state.sessionToken = null;
  state.roomId = null;
  state.outbox = [];
  showView("landing");
}

$("#btnLeave").onclick = () => {
  if (confirm("از اتاق خارج شوید؟")) {
    send({ type: "leave" });
    leaveRoom();
  }
};

setInterval(() => { if (state.wsOpen) send({ type: "ping" }); }, 25000);
