import { json, randomId, now } from "./helpers.js";

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.sockets = new Map();
    this.room = null;
    this._chatRate = new Map();

    try {
      this.state.getWebSockets().forEach((ws) => {
        const att = ws.deserializeAttachment();
        if (att?.userId) {
          this.sockets.set(att.userId, ws);
          if (att.token) this.sessions.set(att.token, { userId: att.userId });
        }
      });
    } catch {}
  }

  async ensureLoaded() {
    if (this.room) return;
    this.room = (await this.state.storage.get("room")) || null;
  }

  async save() {
    if (this.room) await this.state.storage.put("room", this.room);
  }

  async fetch(request) {
    await this.ensureLoaded();
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") return this.handleWS(request, url);
    if (url.pathname.endsWith("/init")) return this.handleInit(request);
    if (url.pathname.endsWith("/join")) return this.handleJoin(request);
    return json({ error: "not found" }, 404);
  }

  async handleInit(request) {
    await this.ensureLoaded();
    if (this.room) return json({ error: "room exists" }, 409);
    const body = await request.json();
    const ownerId = randomId(8);
    const ownerToken = randomId(24);
    this.room = {
      createdAt: now(),
      lastActivity: now(),
      locked: false,
      closed: false,
      videoUrl: body.videoUrl || null,
      inviteToken: body.inviteToken || randomId(12),
      ownerId,
      users: [{
        id: ownerId,
        name: String(body.ownerName || "Owner").slice(0, 24),
        owner: true, online: false, kicked: false, blocked: false,
      }],
      chat: [],
      playback: { playing: false, currentTime: 0, updatedAt: now() },
    };
    this.sessions.set(ownerToken, { userId: ownerId });
    await this.save();
    await this.scheduleCleanup();
    return json({ ok: true, userId: ownerId, sessionToken: ownerToken });
  }

  async handleJoin(request) {
    await this.ensureLoaded();
    const body = await request.json();
    if (!this.room) return json({ error: "اتاق پیدا نشد." }, 404);
    if (this.room.closed) return json({ error: "اتاق بسته است." }, 410);
    if (this.room.locked) return json({ error: "اتاق قفل است." }, 403);
    if (body.inviteToken && body.inviteToken !== this.room.inviteToken) {
      return json({ error: "لینک دعوت نامعتبر است." }, 403);
    }
    const name = String(body.displayName || "").trim().slice(0, 24);
    if (!name) return json({ error: "نام الزامی است." }, 400);
    const blocked = this.room.users.find((u) => u.name === name && u.blocked);
    if (blocked) return json({ error: "ورود شما مسدود شده است." }, 403);

    const userId = randomId(8);
    this.room.users.push({
      id: userId, name, owner: false, online: false, kicked: false, blocked: false,
    });
    const token = randomId(24);
    this.sessions.set(token, { userId });
    this.room.lastActivity = now();
    await this.save();
    return json({
      ok: true, userId, sessionToken: token,
      isOwner: false, inviteToken: this.room.inviteToken,
    });
  }

  async handleWS(request, url) {
    await this.ensureLoaded();
    const token = url.searchParams.get("token");
    if (!token) return new Response("missing token", { status: 401 });
    if (!this.room) return new Response("room not found", { status: 404 });
    if (this.room.closed) return new Response("room closed", { status: 410 });

    const sess = this.sessions.get(token);
    if (!sess) return new Response("invalid session", { status: 401 });
    const user = this.room.users.find((u) => u.id === sess.userId);
    if (!user || user.kicked || user.blocked) return new Response("blocked", { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ userId: user.id, token });
    this.sockets.set(user.id, server);
    user.online = true;
    this.room.lastActivity = now();
    await this.save();

    this.sendTo(server, { type: "state", serverTime: now(), ...this.publicState(user.id) });
    this.broadcast({ type: "users", users: this.publicUsers() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    await this.ensureLoaded();
    let m; try { m = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment();
    if (!att) return;
    const user = this.room?.users.find((u) => u.id === att.userId);
    if (!user || user.kicked || user.blocked) {
      try { ws.close(1008, "kicked"); } catch {}
      return;
    }
    const isOwner = user.id === this.room.ownerId;
    this.room.lastActivity = now();

    switch (m.type) {
      case "ping":
        this.sendTo(ws, { type: "pong", serverTime: now() });
        break;
      case "chat":
        this.handleChat(user, m);
        break;
      case "control":
        if (!isOwner) return this.sendTo(ws, { type: "error", message: "فقط مالک." });
        this.handleControl(m);
        break;
      case "set_movie":
        if (!isOwner) return;
        this.room.videoUrl = String(m.videoUrl || "").slice(0, 2000);
        await this.save();
        this.broadcast({ type: "movie", videoUrl: this.room.videoUrl });
        break;
      case "kick":
        if (!isOwner) return;
        await this.kick(m.userId);
        break;
      case "lock":
        if (!isOwner) return;
        this.room.locked = !!m.locked;
        await this.save();
        this.broadcast({ type: "locked", locked: this.room.locked });
        break;
      case "rotate_invite":
        if (!isOwner) return;
        this.room.inviteToken = randomId(12);
        await this.save();
        this.broadcast({ type: "invite_rotated", inviteToken: this.room.inviteToken });
        break;
      case "clear_chat":
        if (!isOwner) return;
        this.room.chat = [];
        await this.save();
        this.broadcast({ type: "chat_clear" });
        break;
      case "transfer_owner":
        if (!isOwner) return;
        await this.transferOwner(m.userId);
        break;
      case "close_room":
        if (!isOwner) return;
        this.room.closed = true;
        await this.save();
        this.broadcast({ type: "room_closed" });
        this.closeAll();
        break;
      case "leave":
        await this.removeUser(user.id);
        break;
      case "sync_request":
        this.sendTo(ws, { type: "state", serverTime: now(), ...this.publicState(user.id) });
        break;
    }
  }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    if (!att) return;
    const user = this.room?.users.find((u) => u.id === att.userId);
    if (user) {
      user.online = false;
      this.sockets.delete(user.id);
      this.room.lastActivity = now();
      await this.save();
      this.broadcast({ type: "users", users: this.publicUsers() });
    }
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }

  handleChat(user, m) {
    const text = String(m.text || "").trim().slice(0, 500);
    if (!text) return;
    const t = now();
    let r = this._chatRate.get(user.id);
    if (!r || t - r.start > 10000) r = { start: t, count: 0 };
    r.count++;
    this._chatRate.set(user.id, r);
    if (r.count > 20) return;

    const msg = { id: randomId(6), userId: user.id, name: user.name, text, at: t };
    this.room.chat.push(msg);
    if (this.room.chat.length > 200) this.room.chat.shift();
    this.save();
    this.broadcast({ type: "chat", message: msg });
  }

  handleControl(m) {
    const ct = Math.max(0, Number(m.currentTime) || 0);
    if (m.action === "play") {
      this.room.playback = { playing: true, currentTime: ct, updatedAt: now() };
      this.broadcast({ type: "play", currentTime: ct, serverTime: now() });
    } else if (m.action === "pause") {
      this.room.playback = { playing: false, currentTime: ct, updatedAt: now() };
      this.broadcast({ type: "pause", currentTime: ct, serverTime: now() });
    } else if (m.action === "seek") {
      this.room.playback.currentTime = ct;
      this.room.playback.updatedAt = now();
      this.broadcast({ type: "seek", currentTime: ct, serverTime: now() });
    }
    this.save();
  }

  async kick(targetId) {
    const u = this.room.users.find((x) => x.id === targetId);
    if (!u || u.owner) return;
    u.kicked = true; u.blocked = true; u.online = false;
    for (const [tok, s] of this.sessions) {
      if (s.userId === targetId) this.sessions.delete(tok);
    }
    const sock = this.sockets.get(targetId);
    if (sock) {
      this.sendTo(sock, { type: "kicked" });
      try { sock.close(1008, "kicked"); } catch {}
      this.sockets.delete(targetId);
    }
    await this.save();
    this.broadcast({ type: "users", users: this.publicUsers() });
  }

  async transferOwner(targetId) {
    const n = this.room.users.find((u) => u.id === targetId);
    if (!n || n.kicked || n.blocked) return;
    const old = this.room.users.find((u) => u.id === this.room.ownerId);
    if (old) old.owner = false;
    n.owner = true;
    this.room.ownerId = n.id;
    await this.save();
    this.broadcast({ type: "users", users: this.publicUsers() });
    this.broadcast({ type: "owner_changed" });
  }

  async removeUser(userId) {
    const i = this.room.users.findIndex((u) => u.id === userId);
    if (i >= 0) {
      this.room.users.splice(i, 1);
      this.sockets.delete(userId);
      await this.save();
      this.broadcast({ type: "users", users: this.publicUsers() });
    }
  }

  async scheduleCleanup() {
    const next = now() + 6 * 60 * 60 * 1000;
    const cur = await this.state.storage.getAlarm();
    if (!cur || next < cur) await this.state.storage.setAlarm(next);
  }

  async alarm() {
    await this.ensureLoaded();
    if (!this.room) return;
    const idle = now() - (this.room.lastActivity || this.room.createdAt || 0);
    const noOne = this.room.users.every((u) => !u.online);
    if (noOne && idle > 6 * 60 * 60 * 1000) {
      await this.state.storage.deleteAll();
      this.room = null;
      return;
    }
    await this.scheduleCleanup();
  }

  publicUsers() {
    return this.room.users.map((u) => ({
      id: u.id, name: u.name, owner: u.id === this.room.ownerId, online: !!u.online,
    }));
  }

  publicState(userId) {
    const me = this.room.users.find((u) => u.id === userId);
    return {
      isOwner: userId === this.room.ownerId,
      users: this.publicUsers(),
      chat: this.room.chat,
      locked: this.room.locked,
      videoUrl: this.room.videoUrl,
      inviteToken: userId === this.room.ownerId ? this.room.inviteToken : null,
      playing: this.room.playback.playing,
      currentTime: this.room.playback.currentTime,
      serverTime: now(),
      me: me ? { id: me.id, name: me.name } : null,
    };
  }

  sendTo(ws, o) { try { ws.send(JSON.stringify(o)); } catch {} }
  broadcast(o) {
    const d = JSON.stringify(o);
    for (const ws of this.sockets.values()) try { ws.send(d); } catch {}
  }
  closeAll() {
    for (const ws of this.sockets.values()) try { ws.close(1001, "closed"); } catch {}
    this.sockets.clear();
  }
}