import { json, corsHeaders, randomId, rateLimit } from "./helpers.js";
import { RoomDO } from "./room.js";

export { RoomDO };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!rateLimit(`ip:${ip}`, 120, 60_000)) {
      return json({ error: "درخواست زیاد." }, 429, cors);
    }

    try {
      // ساخت اتاق
      if (url.pathname === "/api/rooms" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const displayName = String(body.displayName || "").trim().slice(0, 24);
        if (!displayName) return json({ error: "نام الزامی است." }, 400, cors);

        const roomId = randomId(12).toLowerCase();
        const inviteToken = randomId(12);
        const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));

        const res = await stub.fetch(new Request("https://do/init", {
          method: "POST",
          body: JSON.stringify({ ownerName: displayName, videoUrl: body.videoUrl || null, inviteToken }),
        }));
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          return json({ error: e.error || "خطای ساخت اتاق" }, 500, cors);
        }
        const d = await res.json();
        return json({
          roomId, inviteToken, userId: d.userId, sessionToken: d.sessionToken,
        }, 201, cors);
      }

      // ورود
      const joinM = url.pathname.match(/^\/api\/rooms\/([a-z0-9]+)\/join$/);
      if (joinM && request.method === "POST") {
        const roomId = joinM[1].toLowerCase();
        const body = await request.json().catch(() => ({}));
        const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
        const res = await stub.fetch(new Request("https://do/join", {
          method: "POST",
          body: JSON.stringify({
            displayName: body.displayName,
            inviteToken: body.inviteToken || null,
          }),
        }));
        const d = await res.json().catch(() => ({}));
        return json(d, res.status, cors);
      }

      // WebSocket
      const wsM = url.pathname.match(/^\/api\/rooms\/([a-z0-9]+)\/ws$/);
      if (wsM) {
        const roomId = wsM[1].toLowerCase();
        const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
        return stub.fetch(request);
      }

      return json({ error: "not found" }, 404, cors);
    } catch (e) {
      return json({ error: "خطای سرور" }, 500, cors);
    }
  },
};