// RoomDO — one Durable Object instance per network.
//
// Responsibilities:
//   • give every connected device a random 4-digit code (unique within this room)
//   • NEVER reveal the list of devices to clients (privacy: you can only reach a
//     device whose code you were told out-of-band)
//   • run the pairing handshake (request -> accept/reject) with a shared verify word
//   • relay WebRTC offer/answer/ICE between exactly two paired peers
//   • rate-limit wrong-code guesses to protect the small code space
//
// Uses the WebSocket Hibernation API so idle rooms cost nothing and survive eviction:
// per-connection state lives in the socket's serialized attachment, and we enumerate
// peers with ctx.getWebSockets() rather than an in-memory map.

interface Attachment {
  deviceId: string;
  code: string;
  name: string;
  pairedWith: string | null;
  pendingFrom: string | null; // deviceId of a peer awaiting our accept
  attempts: number;
  lockUntil: number;
}

const VERIFY_WORDS = [
  "fox", "owl", "elm", "jade", "kite", "lime", "moon", "nova", "opal", "pine",
  "reef", "sage", "teal", "vine", "wave", "zinc", "bay", "cove", "dune", "fern",
  "gold", "iris", "lark", "mint", "peak", "rose", "snow", "star", "tide", "wolf",
];

export class RoomDO {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(_request: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    const att: Attachment = {
      deviceId: crypto.randomUUID(),
      code: this.allocateCode(),
      name: "",
      pairedWith: null,
      pendingFrom: null,
      attempts: 0,
      lockUntil: 0,
    };
    server.serializeAttachment(att);
    this.send(server, { type: "welcome", deviceId: att.deviceId, code: att.code });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() as Attachment;

    switch (msg.type) {
      case "hello":
        att.name = sanitizeName(String(msg.name ?? ""));
        ws.serializeAttachment(att);
        break;

      case "pair":
        this.handlePair(ws, att, String(msg.code ?? ""));
        break;

      case "pair-accept":
        this.handleAccept(ws, att);
        break;

      case "pair-reject":
        this.handleReject(ws, att);
        break;

      case "signal":
        // Relay opaque WebRTC payloads to the paired peer only.
        if (att.pairedWith) {
          this.findById(att.pairedWith)?.ws.send(
            JSON.stringify({ type: "signal", data: msg.data })
          );
        }
        break;

      case "unpair":
        this.detach(att);
        ws.serializeAttachment(att);
        break;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.onGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.onGone(ws);
  }

  // --- pairing handlers -------------------------------------------------------

  private handlePair(ws: WebSocket, att: Attachment, code: string): void {
    const now = Date.now();
    if (att.lockUntil > now) {
      this.send(ws, { type: "error", reason: "rate_limited", retryInMs: att.lockUntil - now });
      return;
    }

    const target = this.findByCode(code);
    if (!target || target.ws === ws) {
      att.attempts += 1;
      if (att.attempts >= 5) {
        att.lockUntil = now + 30_000;
        att.attempts = 0;
      }
      ws.serializeAttachment(att);
      this.send(ws, { type: "pair-failed", reason: "no_such_code" });
      return;
    }
    if (target.att.pairedWith || target.att.pendingFrom) {
      this.send(ws, { type: "pair-failed", reason: "busy" });
      return;
    }

    att.attempts = 0;
    ws.serializeAttachment(att);

    const verifyWord = VERIFY_WORDS[Math.floor(Math.random() * VERIFY_WORDS.length)];
    target.att.pendingFrom = att.deviceId;
    target.ws.serializeAttachment(target.att);

    this.send(target.ws, {
      type: "pair-incoming",
      fromName: att.name || "A device",
      verifyWord,
    });
    this.send(ws, { type: "pair-pending", verifyWord });
  }

  private handleAccept(ws: WebSocket, att: Attachment): void {
    const fromId = att.pendingFrom;
    att.pendingFrom = null;
    const peer = fromId ? this.findById(fromId) : null;
    if (!peer) {
      ws.serializeAttachment(att);
      return;
    }
    att.pairedWith = peer.att.deviceId;
    peer.att.pairedWith = att.deviceId;
    ws.serializeAttachment(att);
    peer.ws.serializeAttachment(peer.att);

    // The requester (peer) initiates the WebRTC offer; the accepter responds.
    this.send(peer.ws, { type: "paired", role: "initiator", peerName: att.name || "A device" });
    this.send(ws, { type: "paired", role: "responder", peerName: peer.att.name || "A device" });
  }

  private handleReject(ws: WebSocket, att: Attachment): void {
    const fromId = att.pendingFrom;
    att.pendingFrom = null;
    ws.serializeAttachment(att);
    if (fromId) this.findById(fromId)?.ws.send(JSON.stringify({ type: "pair-rejected" }));
  }

  private onGone(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    if (att.pairedWith) {
      const peer = this.findById(att.pairedWith);
      if (peer) {
        peer.att.pairedWith = null;
        peer.ws.serializeAttachment(peer.att);
        try {
          peer.ws.send(JSON.stringify({ type: "peer-left" }));
        } catch {
          /* peer already gone */
        }
      }
    }
  }

  // --- helpers ----------------------------------------------------------------

  private detach(att: Attachment): void {
    if (!att.pairedWith) return;
    const peer = this.findById(att.pairedWith);
    if (peer) {
      peer.att.pairedWith = null;
      peer.ws.serializeAttachment(peer.att);
      try {
        peer.ws.send(JSON.stringify({ type: "peer-left" }));
      } catch {
        /* ignore */
      }
    }
    att.pairedWith = null;
  }

  private allocateCode(): string {
    const used = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.code) used.add(att.code);
    }
    for (let i = 0; i < 9000; i++) {
      const code = String(1000 + Math.floor(Math.random() * 9000)); // 1000-9999, always 4 digits
      if (!used.has(code)) return code;
    }
    return "0000";
  }

  private findByCode(code: string): { ws: WebSocket; att: Attachment } | null {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.code === code) return { ws, att };
    }
    return null;
  }

  private findById(deviceId: string): { ws: WebSocket; att: Attachment } | null {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.deviceId === deviceId) return { ws, att };
    }
    return null;
  }

  private send(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* socket closing */
    }
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^\p{L}\p{N} _.-]/gu, "").slice(0, 32).trim();
}
