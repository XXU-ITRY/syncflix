import { json, randomId, rateLimit } from "./helpers.js";
import { RoomDO } from "./room.js";

export { RoomDO };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- فقط مسیرهای /api/* را هندل می‌کنیم ---
    if (url.pathname.startsWith("/api/")) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      if (!rateLimit(`ip:${ip}`, 120, 60_000)) {
        return json({ error: "درخواست زیاد." }, 429);
      }

      try {
        // ساخت اتاق
        if (url.pathname === "/api/rooms" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const displayName = String(body.displayName || "").trim().slice(0, 24);
          if (!displayName) return json({ error: "نام الزامی است." }, 400);

          const roomId = randomId(12).toLowerCase();
          const inviteToken = randomId(12);
          const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));

          const res = await stub.fetch("https://do/init", {
            method: "POST",
            body: JSON.stringify({
              ownerName: displayName,
              videoUrl: body.videoUrl || null,
              inviteToken,
            }),
          });
          if (!res.ok) {
            const e = await res.json().catch(() => ({}));
            return json({ error: e.error || "خطا در ساخت اتاق" }, 500);
          }
          const d = await res.json();
          return json({
            roomId, inviteToken, userId: d.userId, sessionToken: d.sessionToken,
          }, 201);
        }

        // ورود
        const joinM = url.pathname.match(/^\/api\/rooms\/([a-z0-9]+)\/join$/);
        if (joinM && request.method === "POST") {
          const roomId = joinM[1].toLowerCase();
          const body = await request.json().catch(() => ({}));
          const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
          const res = await stub.fetch("https://do/join", {
            method: "POST",
            body: JSON.stringify({
              displayName: body.displayName,
              inviteToken: body.inviteToken || null,
            }),
          });
          const d = await res.json().catch(() => ({}));
          return json(d, res.status);
        }

        // WebSocket
        const wsM = url.pathname.match(/^\/api\/rooms\/([a-z0-9]+)\/ws$/);
        if (wsM) {
          const roomId = wsM[1].toLowerCase();
          const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
          return stub.fetch(request);
        }

        return json({ error: "not found" }, 404);
      } catch (e) {
        return json({ error: "خطای سرور" }, 500);
      }
    }

    // --- بقیه مسیرها → فایل‌های استاتیک از public/ ---
    return env.ASSETS.fetch(request);
  },
};
