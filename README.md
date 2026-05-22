# any-share

Share files, media, and text **directly between devices on the same wifi** — no app
install, no account, nothing uploaded to a server. Built for locked-down places like
university lab PCs where you can't install software.

Open `any-share.site` on two devices, read your **4-digit code** to the other person (or
show your QR), they type it in, you tap **Accept**, and the browsers open a direct,
**end-to-end-encrypted WebRTC** connection. Files stream peer-to-peer over your wifi.

- **Private by design** — you never see a list of devices on the network. The only way to
  reach someone is to be told their code. Devices are grouped per-network (by a hashed
  public IP), so code `1234` at one place can never collide with `1234` somewhere else.
- **Free to run** — only cost is the domain. Frontend on Cloudflare Pages; signaling on a
  Cloudflare Durable Object (WebSocket Hibernation), both on the free plan.

## ⚠️ Local-only mode and "client isolation"

This build is **strict local-only**: WebRTC uses `iceServers: []`, so connections use only
LAN/mDNS candidates and **bytes never leave the wifi**. The trade-off: many university/lab
networks enable **client isolation**, which blocks device-to-device traffic even on the same
wifi. There, the app shows a clear *"couldn't connect on this network"* screen instead of
hanging. Most home/hotspot wifi works fine.

To make it work **everywhere** (including isolated networks) while staying private and free,
you can later turn on Cloudflare's encrypted **TURN relay** (1,000 GB/month free). The hook is
already in place — see [Enabling the relay](#optional-enabling-the-relay-later).

## How it works

```
Browser A ──WS──┐                                  ┌──WS── Browser B
                ▼                                  ▼
        Cloudflare Worker  (room = hash(CF-Connecting-IP))
                     │ routes the socket to →
        Durable Object "RoomDO"  (one per network)
          • gives each device a unique 4-digit code
          • runs the pair → accept handshake (+ shared verify word)
          • relays WebRTC offer/answer/ICE between the two paired peers only
                     │
   A and B then open a DIRECT WebRTC DataChannel ───────────►
   (local-only: bytes stay on the wifi, encrypted end-to-end)
```

## Project layout

```
worker/      Cloudflare Worker + Durable Object — signaling only (tiny control messages)
  src/index.ts   WS upgrade, room = hash(CF-Connecting-IP), route to RoomDO
  src/room.ts    RoomDO: code assignment, pairing, signal relay, rate-limiting
frontend/    Vite + TypeScript single-page PWA — Cloudflare Pages
  src/signaling.ts  WebSocket client
  src/webrtc.ts     RTCPeerConnection + DataChannel; getIceServers() seam
  src/transfer.ts   chunked file transfer (backpressure) + text
  src/qr.ts         QR generate + camera scan (BarcodeDetector, jsQR fallback)
  src/main.ts       UI + orchestration
```

## Local development

```bash
# terminal 1 — signaling Worker (http://127.0.0.1:8787)
cd worker && npm install && npm run dev

# terminal 2 — frontend (http://127.0.0.1:5173, proxies /rtc to the Worker)
cd frontend && npm install && npm run dev
```

Open `http://127.0.0.1:5173` in two tabs/devices. (On `localhost` both tabs are a "secure
context", so WebRTC works. For phone testing, deploy first — HTTPS is required off-localhost.)

## Deploy to Cloudflare (only the domain costs money)

1. **Buy a domain** at any cheap registrar (Porkbun, Namecheap, …).
2. **Add it to Cloudflare** (free plan) and point the registrar's nameservers at Cloudflare.
3. **Deploy the frontend** to Cloudflare Pages with custom domain `any-share.site`:
   ```bash
   cd frontend && npm run build
   npx wrangler pages deploy dist --project-name any-share
   ```
   Then in the Cloudflare dashboard add the custom domain to the Pages project.
4. **Deploy the signaling Worker** and put it under the same domain:
   - In `worker/wrangler.toml`, uncomment the `routes` block (`any-share.site/rtc/*`).
   ```bash
   cd worker && npx wrangler deploy
   ```
   The Worker route is more specific than Pages, so `/rtc/*` hits the Worker and everything
   else is served by Pages — all under one domain. The frontend already talks to
   `wss://any-share.site/rtc/ws`. Done — $0/month.

> Optional hardening: `npx wrangler secret put ROOM_SALT` (any random string) so room keys
> are salted with a value only you know.

## Security notes

- HTTPS everywhere (Cloudflare auto-TLS); WebRTC DataChannels are DTLS-encrypted end-to-end.
- The server only ever sees tiny signaling metadata — **never** your files or text.
- Public IPs are hashed (with a daily-rotating salt) into opaque room keys and never logged.
- Codes are per-network, single-use for pairing, with rate-limited wrong-code attempts; a
  receiver must explicitly Accept and both sides see a matching verify word.

## Optional: enabling the relay later

To work on client-isolated networks, return real ICE servers from `getIceServers()` in
`frontend/src/webrtc.ts`:

1. Enable **Cloudflare Realtime → TURN** and create a TURN key (free up to 1,000 GB/mo).
2. Add a Worker route, e.g. `GET /rtc/turn-credentials`, that mints **short-lived** TURN
   credentials with your TURN key + API token (Cloudflare provides a one-call REST endpoint).
3. Have `getIceServers()` fetch that endpoint and return the `iceServers` array.

That single change flips the app from strict-local-only to local-first-with-relay-fallback,
keeping transfers private (still E2E encrypted) and free at student scale.
