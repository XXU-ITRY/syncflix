/* ============================================================
   SyncFlix Frontend v7
   - سرعت پخش (همگام با مالک)
   - صدا + PiP + تمام‌صفحه
   - کیفیت HLS + همگام‌سازی دستی + پینگ
   - کلیدهای میان‌بر + نگهداری نشست
   ============================================================ */

const WS_BASE = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
const SESSION_KEY = "syncflix_session";
const VOLUME_KEY = "syncflix_volume";

const state = {
  sessionToken: null,
  roomId: null,
  userId: null,
  displayName: "",
  isOwner: false,
  ws: null,
  wsOpen: false,
  everConnected: false,
  reconnectAttempt: 0,
  outbox: [],
  users: [],
  chat: [],
  inviteToken: null,
  roomLocked: false,
  videoUrl: null,
  subtitleUrl: null,
  playing: false,
  rate: 1,
  serverOffset: 0,
  lastServerTime: 0,
  lastCurrentTime: 0,
  hls: null,
  driftTimer: null,
  programmaticSeekUntil: 0,
  pingSentAt: 0,
  lastPing: 0,
  qualityLevels: [],
};

const subtitleCache = new Map();
const $ = (s) => document.querySelector(s);
const landing = $("#landing");
const roomView = $("#room");
const video = $("#video");
const videoOverlay = $("#videoOverlay");

/* ---------- Utilities ---------- */
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
function updatePingDisplay() {
  const el = $("#pingInfo");
  if (!el) return;
  if (state.lastPing) el.textContent = state.lastPing + " ms";
  else el.textContent = "— ms";
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

/* ---------- Session persistence ---------- */
function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      sessionToken: state.sessionToken,
      roomId: state.roomId,
      userId: state.userId,
      displayName: state.displayName,
    }));
  } catch (e) {}
}
function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
}
function tryRestoreSession() {
  let saved;
  try { saved = sessionStorage.getItem(SESSION_KEY); } catch (e) { return false; }
  if (!saved) return false;
  try {
    const d = JSON.parse(saved);
    if (!d.sessionToken || !d.roomId) return false;
    state.sessionToken = d.sessionToken;
    state.roomId = d.roomId;
    state.userId = d.userId;
    state.displayName = d.displayName || "";
    enterRoom();
    return true;
  } catch (e) {
    clearSession();
    return false;
  }
}

/* ---------- Create & Join ---------- */
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
    saveSession();
    enterRoom();
  } catch (e) { toast(e.message); }
};

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
    saveSession();
    enterRoom();
  } catch (e) { err.textContent = e.message; }
};

(function checkInvite() {
  if (tryRestoreSession()) return;
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
  updatePingDisplay();
}

/* ---------- WebSocket ---------- */
function connectWS() {
  if (state.ws) { try { state.ws.close(); } catch (e) {} }
  setConn("connecting");
  const url = `${WS_BASE}/api/rooms/${state.roomId}/ws?token=${encodeURIComponent(state.sessionToken)}`;
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
    state.wsOpen = true;
    state.everConnected = true;
    state.reconnectAttempt = 0;
    setConn("online");
    flushOutbox();
    send({ type: "sync_request" });
    state.pingSentAt = Date.now();
    send({ type: "ping" });
  };
  ws.onclose = () => {
    state.wsOpen = false;
    setConn("offline");
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.serverTime) noteServerTime(m.serverTime);
    handleMessage(m);
  };
}

function scheduleReconnect() {
  if (!state.sessionToken || !roomView.classList.contains("active")) return;
  if (!state.everConnected && state.reconnectAttempt >= 3) {
    clearSession();
    leaveRoom();
    toast("اتصال برقرار نشد. لطفاً دوباره وارد شوید.");
    return;
  }
  const attempt = Math.min(state.reconnectAttempt++, 6);
  const delay = Math.min(1000 * 2 ** attempt, 30000) + Math.random() * 500;
  setTimeout(connectWS, delay);
}

function send(obj) {
  if (state.ws && state.wsOpen) {
    try { state.ws.send(JSON.stringify(obj)); return true; } catch (e) {}
  }
  if (state.outbox.length < 50) state.outbox.push(obj);
  return false;
}
function flushOutbox() {
  const items = state.outbox.splice(0);
  items.forEach((o) => { try { state.ws.send(JSON.stringify(o)); } catch (e) {} });
}

/* ---------- Time ---------- */
function noteServerTime(t) { if (t) state.serverOffset = t - Date.now(); }
function serverNow() { return Date.now() + state.serverOffset; }
function expectedTime() {
  if (!state.playing) return state.lastCurrentTime;
  return state.lastCurrentTime + (serverNow() - state.lastServerTime) / 1000;
}
function setVideoTime(t) {
  state.programmaticSeekUntil = Date.now() + 600;
  try { video.currentTime = t; } catch (e) {}
}

/* ---------- Server messages ---------- */
function handleMessage(m) {
  switch (m.type) {
    case "state":
      state.users = m.users || [];
      state.chat = m.chat || [];
      state.isOwner = !!m.isOwner;
      state.roomLocked = !!m.locked;
      state.inviteToken = m.inviteToken;
      state.playing = !!m.playing;
      state.rate = m.rate || 1;
      state.lastCurrentTime = m.currentTime || 0;
      state.lastServerTime = serverNow();
      applyRate(state.rate);
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
      setVideoTime(m.currentTime);
      if (state.playing) safePlay();
      break;

    case "rate":
      state.rate = m.rate;
      applyRate(m.rate);
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
      clearSession();
      toast("شما از اتاق حذف شدید.", 5000);
      leaveRoom();
      break;

    case "room_closed":
      clearSession();
      toast("اتاق بسته شد.", 5000);
      leaveRoom();
      break;

    case "pong":
      if (state.pingSentAt) {
        state.lastPing = Date.now() - state.pingSentAt;
        updatePingDisplay();
      }
      break;

    case "error":
      toast(m.message || "خطا");
      break;
  }
}

function applyRate(rate) {
  const r = Math.max(0.25, Math.min(2, Number(rate) || 1));
  try { video.playbackRate = r; } catch (e) {}
  const sel = $("#speedSelect");
  if (sel) sel.value = String(r);
}

/* ---------- Render ---------- */
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

/* ---------- Video ---------- */
function destroyHls() {
  if (state.hls) { try { state.hls.destroy(); } catch (e) {} }
  state.hls = null;
  state.qualityLevels = [];
  const qw = $("#qualityWrap");
  if (qw) qw.classList.add("hidden");
}

function loadVideo(url) {
  destroyHls();
  video.querySelectorAll("track").forEach((t) => t.remove());
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
    hls.on(window.Hls.Events.MANIFEST_PARSED, (_e, data) => {
      videoOverlay.textContent = "";
      state.qualityLevels = (data.levels || []).map((l, i) => ({
        index: i, height: l.height || 0, bitrate: l.bitrate || 0,
      }));
      populateQualitySelect();
      if (state.subtitleUrl) loadSubtitle(state.subtitleUrl);
      syncVideoToState();
    });
    hls.on(window.Hls.Events.LEVEL_SWITCHED, (_e, data) => {
      const sel = $("#qualitySelect");
      if (sel && state.hls && state.hls.autoLevelEnabled) sel.value = "-1";
      else if (sel) sel.value = String(data.level);
    });
    hls.on(window.Hls.Events.ERROR, (_e, d) => {
      if (d.fatal) videoOverlay.textContent = "خطا در HLS.";
    });
  } else if (isHls && video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    video.load();
    video.onloadedmetadata = () => {
      videoOverlay.textContent = "";
      if (state.subtitleUrl) loadSubtitle(state.subtitleUrl);
      syncVideoToState();
    };
  } else {
    video.src = url;
    video.load();
    video.onloadedmetadata = () => {
      videoOverlay.textContent = "";
      if (state.subtitleUrl) loadSubtitle(state.subtitleUrl);
      syncVideoToState();
    };
    video.onerror = () => {
      videoOverlay.textContent = "خطا در بارگذاری ویدئو (CORS یا لینک).";
    };
  }
  applyRate(state.rate);
}

function populateQualitySelect() {
  const sel = $("#qualitySelect");
  const wrap = $("#qualityWrap");
  if (!sel || !wrap) return;
  if (!state.qualityLevels.length) { wrap.classList.add("hidden"); return; }
  const sorted = [...state.qualityLevels].sort((a, b) => b.height - a.height);
  sel.innerHTML = '<option value="-1">خودکار</option>' +
    sorted.map((l) => `<option value="${l.index}">${l.height ? l.height + "p" : "سطح " + l.index}</option>`).join("");
  wrap.classList.remove("hidden");
}

$("#qualitySelect").onchange = (e) => {
  if (!state.hls) return;
  const v = parseInt(e.target.value, 10);
  state.hls.currentLevel = v;
  if (v === -1) state.hls.currentLevel = -1;
};

function syncVideoToState() {
  const target = expectedTime();
  if (Number.isFinite(target) && Math.abs(video.currentTime - target) > 1.5) {
    setVideoTime(target);
  }
  if (state.playing) safePlay();
  else video.pause();
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
    if (Math.abs(drift) > 3) setVideoTime(expectedTime());
  }, 5000);
}

/* ---------- Owner enforcement ---------- */
video.addEventListener("play", () => {
  if (state.isOwner) {
    if (!state.wsOpen) return;
    send({ type: "control", action: "play", currentTime: video.currentTime });
    return;
  }
  if (!state.playing) {
    video.pause();
    toast("فقط مالک می‌تواند پخش را کنترل کند.");
  }
});
video.addEventListener("pause", () => {
  if (Date.now() < state.programmaticSeekUntil) return;
  if (state.isOwner) {
    if (!state.wsOpen || video.seeking) return;
    send({ type: "control", action: "pause", currentTime: video.currentTime });
    return;
  }
  if (state.playing && !video.seeking) setTimeout(() => safePlay(), 0);
});
video.addEventListener("seeking", () => {
  if (Date.now() < state.programmaticSeekUntil) return;
  if (state.isOwner) return;
  setVideoTime(expectedTime());
  toast("فقط مالک می‌تواند زمان را تغییر دهد.");
});
video.addEventListener("seeked", () => {
  if (!state.isOwner || !state.wsOpen) return;
  if (Date.now() < state.programmaticSeekUntil) return;
  send({ type: "control", action: "seek", currentTime: video.currentTime });
});

/* ---------- Player controls ---------- */
$("#btnSync").onclick = () => {
  const t = expectedTime();
  setVideoTime(t);
  if (state.playing && video.paused) safePlay();
  toast("همگام شد.");
};

$("#speedSelect").onchange = (e) => {
  const r = parseFloat(e.target.value);
  if (!state.isOwner) {
    e.target.value = String(state.rate);
    toast("فقط مالک می‌تواند سرعت را تغییر دهد.");
    return;
  }
  try { video.playbackRate = r; } catch (err) {}
  send({ type: "control", action: "rate", rate: r });
};

$("#btnMute").onclick = () => {
  video.muted = !video.muted;
  updateVolumeIcon();
};

$("#volumeSlider").oninput = (e) => {
  const v = parseFloat(e.target.value);
  video.volume = v;
  video.muted = v === 0;
  try { localStorage.setItem(VOLUME_KEY, String(v)); } catch (err) {}
  updateVolumeIcon();
};

function updateVolumeIcon() {
  const muted = video.muted || video.volume === 0;
  const on = document.querySelector(".ic-vol-on");
  const off = document.querySelector(".ic-vol-off");
  if (on) on.classList.toggle("hidden", muted);
  if (off) off.classList.toggle("hidden", !muted);
  const slider = $("#volumeSlider");
  if (slider) slider.value = String(muted ? 0 : video.volume);
}

/* Restore volume */
try {
  const savedVol = localStorage.getItem(VOLUME_KEY);
  if (savedVol !== null) {
    video.volume = Math.max(0, Math.min(1, parseFloat(savedVol)));
    const slider = $("#volumeSlider");
    if (slider) slider.value = String(video.volume);
  }
} catch (e) {}
updateVolumeIcon();

$("#btnPiP").onclick = async () => {
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      await video.requestPictureInPicture();
    }
  } catch (e) {
    toast("PiP پشتیبانی نمی‌شود.");
  }
};

$("#btnFullscreen").onclick = () => {
  const el = document.querySelector(".videoWrap");
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else if (el && el.requestFullscreen) {
    el.requestFullscreen().catch(() => {});
  } else if (video.webkitEnterFullscreen) {
    video.webkitEnterFullscreen();
  }
};

/* ---------- Keyboard ---------- */
document.addEventListener("keydown", (e) => {
  if (!roomView.classList.contains("active")) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  if (e.code === "Space") {
    e.preventDefault();
    if (!state.isOwner) return toast("فقط مالک می‌تواند پخش را کنترل کند.");
    if (video.paused) send({ type: "control", action: "play", currentTime: video.currentTime });
    else send({ type: "control", action: "pause", currentTime: video.currentTime });
  } else if (e.code === "ArrowRight") {
    if (!state.isOwner) return;
    e.preventDefault();
    const t = Math.min(video.duration || Infinity, video.currentTime + 5);
    send({ type: "control", action: "seek", currentTime: t });
  } else if (e.code === "ArrowLeft") {
    if (!state.isOwner) return;
    e.preventDefault();
    const t = Math.max(0, video.currentTime - 5);
    send({ type: "control", action: "seek", currentTime: t });
  } else if (e.code === "KeyF") {
    e.preventDefault();
    $("#btnFullscreen").onclick();
  } else if (e.code === "KeyM") {
    e.preventDefault();
    $("#btnMute").onclick();
  } else if (e.code === "KeyP") {
    e.preventDefault();
    $("#btnPiP").onclick();
  }
});

/* ---------- Subtitle ---------- */
function srtToVtt(srt) {
  return "WEBVTT\n\n" + String(srt)
    .replace(/\r\n/g, "\n")
    .trim()
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
}
async function loadSubtitle(url) {
  state.subtitleUrl = url || null;
  video.querySelectorAll("track").forEach((t) => t.remove());
  if (!url) return;
  try {
    let src;
    if (/\.vtt(\?|$)/i.test(url)) {
      src = url;
    } else if (/\.srt(\?|$)/i.test(url)) {
      if (subtitleCache.has(url)) {
        src = subtitleCache.get(url);
      } else {
        const res = await fetch(url);
        if (!res.ok) throw new Error("fetch failed");
        const srt = await res.text();
        const vtt = srtToVtt(srt);
        src = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
        subtitleCache.set(url, src);
      }
    } else {
      src = url;
    }
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = "زیرنویس";
    track.srclang = "fa";
    track.src = src;
    track.default = true;
    track.addEventListener("load", () => {
      if (track.track) track.track.mode = "showing";
    });
    video.appendChild(track);
    toast("زیرنویس بارگذاری شد.");
  } catch (e) {
    toast("خطا در بارگذاری زیرنویس (CORS یا فرمت نامعتبر).");
  }
}
$("#btnLoadSub").onclick = () => {
  const url = $("#subtitleUrl").value.trim();
  if (!url) { loadSubtitle(null); toast("زیرنویس حذف شد."); return; }
  loadSubtitle(url);
};

/* ---------- Owner panel ---------- */
$("#btnPlay").onclick = () => {
  if (!state.isOwner) return;
  send({ type: "control", action: "play", currentTime: video.currentTime });
};
$("#btnPause").onclick = () => {
  if (!state.isOwner) return;
  send({ type: "control", action: "pause", currentTime: video.currentTime });
};
$("#btnLock").onclick = () => {
  if (!state.isOwner) return;
  send({ type: "lock", locked: !state.roomLocked });
};
$("#btnRotateInvite").onclick = () => {
  if (!state.isOwner) return;
  if (confirm("لینک دعوت قبلی باطل شود؟")) send({ type: "rotate_invite" });
};
$("#btnClearChat").onclick = () => {
  if (!state.isOwner) return;
  if (confirm("همه پیام‌های چت پاک شوند؟")) send({ type: "clear_chat" });
};
$("#btnCloseRoom").onclick = () => {
  if (!state.isOwner) return;
  if (confirm("اتاق برای همه بسته شود؟")) send({ type: "close_room" });
};
$("#btnChangeMovie").onclick = () => {
  if (!state.isOwner) return;
  const url = $("#ownerMovie").value.trim();
  if (!url) return toast("لینک فیلم را وارد کنید.");
  send({ type: "set_movie", videoUrl: url });
};
$("#btnCopyInvite").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("#inviteLink").value);
    toast("کپی شد.");
  } catch (e) {
    $("#inviteLink").select();
    document.execCommand("copy");
    toast("کپی شد.");
  }
};

function updateOwnerUI() {
  $("#ownerPanel").classList.toggle("hidden", !state.isOwner);

  const lockBtn = $("#btnLock");
  if (lockBtn) {
    const icLock = lockBtn.querySelector(".ic-lock");
    const icUnlock = lockBtn.querySelector(".ic-unlock");
    const label = lockBtn.querySelector("span");
    if (state.roomLocked) {
      if (icLock) icLock.classList.add("hidden");
      if (icUnlock) icUnlock.classList.remove("hidden");
      if (label) label.textContent = "بازکردن";
    } else {
      if (icLock) icLock.classList.remove("hidden");
      if (icUnlock) icUnlock.classList.add("hidden");
      if (label) label.textContent = "قفل";
    }
  }

  ["#btnPlay", "#btnPause", "#btnChangeMovie", "#ownerMovie"].forEach((s) => {
    const el = $(s);
    if (el) el.disabled = !state.isOwner;
  });
  const speedSel = $("#speedSelect");
  if (speedSel) speedSel.disabled = !state.isOwner;

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

/* ---------- Chat ---------- */
$("#chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const inp = $("#chatInput");
  const text = inp.value.trim();
  if (!text) return;
  send({ type: "chat", text });
  inp.value = "";
});

/* ---------- Leave ---------- */
function leaveRoom() {
  if (state.driftTimer) clearInterval(state.driftTimer);
  destroyHls();
  if (state.ws) { try { state.ws.close(); } catch (e) {} }
  state.ws = null;
  state.sessionToken = null;
  state.roomId = null;
  state.outbox = [];
  state.subtitleUrl = null;
  state.everConnected = false;
  state.reconnectAttempt = 0;
  showView("landing");
}

$("#btnLeave").onclick = () => {
  if (confirm("از اتاق خارج شوید؟")) {
    clearSession();
    send({ type: "leave" });
    leaveRoom();
  }
};

/* ---------- Heartbeat + ping ---------- */
setInterval(() => {
  if (!state.wsOpen) return;
  state.pingSentAt = Date.now();
  send({ type: "ping" });
}, 25000);
