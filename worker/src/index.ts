// any-share signaling Worker.
//
// Only job: accept a WebSocket at /rtc/ws, figure out which *network* the client
// is on (devices behind one router share a public IP), and hand the socket to a
// Durable Object dedicated to that network. All pairing/relay logic lives in RoomDO.
//
// The raw IP is never stored or logged — it is hashed (with a daily-rotating salt)
// into an opaque room key, so different networks are fully isolated from each other
// and code "1234" at one university can never collide with "1234" at another.

import { RoomDO } from "./room";

export { RoomDO };

export interface Env {
  ROOMS: DurableObjectNamespace;
  ROOM_SALT?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/rtc/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/rtc/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade.", { status: 426 });
      }
      const ip = request.headers.get("CF-Connecting-IP") ?? "local-dev";
      const roomKey = await roomKeyForIp(ip, env.ROOM_SALT ?? "any-share");
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomKey));
      return stub.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

// One-way, daily-rotating room key. Same IP + same UTC day => same room.
async function roomKeyForIp(ip: string, salt: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const bytes = new TextEncoder().encode(`${salt}:${day}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
