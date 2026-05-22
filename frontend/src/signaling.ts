// Thin client over the signaling WebSocket. It only carries tiny control messages
// (codes, pairing, and opaque WebRTC offer/answer/ICE) — never file data.

export interface SignalingEvents {
  onOpen?: () => void;
  onClose?: () => void;
  onWelcome?: (deviceId: string, code: string) => void;
  onPairPending?: (verifyWord: string) => void;
  onPairIncoming?: (fromName: string, verifyWord: string) => void;
  onPaired?: (role: "initiator" | "responder", peerName: string) => void;
  onPairFailed?: (reason: string) => void;
  onPairRejected?: () => void;
  onPeerLeft?: () => void;
  onSignal?: (data: unknown) => void;
  onError?: (reason: string, retryInMs?: number) => void;
}

export function signalingUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // Same-origin /rtc/ws (Vite proxies this to the Worker in dev; a Worker route serves it in prod).
  const override = (import.meta as any).env?.VITE_SIGNAL_URL as string | undefined;
  return override || `${proto}://${location.host}/rtc/ws`;
}

export class Signaling {
  private ws: WebSocket;
  private events: SignalingEvents;

  constructor(events: SignalingEvents) {
    this.events = events;
    this.ws = new WebSocket(signalingUrl());
    this.ws.onopen = () => this.events.onOpen?.();
    this.ws.onclose = () => this.events.onClose?.();
    this.ws.onmessage = (e) => this.handle(e.data);
  }

  private handle(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome": return void this.events.onWelcome?.(msg.deviceId, msg.code);
      case "pair-pending": return void this.events.onPairPending?.(msg.verifyWord);
      case "pair-incoming": return void this.events.onPairIncoming?.(msg.fromName, msg.verifyWord);
      case "paired": return void this.events.onPaired?.(msg.role, msg.peerName);
      case "pair-failed": return void this.events.onPairFailed?.(msg.reason);
      case "pair-rejected": return void this.events.onPairRejected?.();
      case "peer-left": return void this.events.onPeerLeft?.();
      case "signal": return void this.events.onSignal?.(msg.data);
      case "error": return void this.events.onError?.(msg.reason, msg.retryInMs);
    }
  }

  private send(payload: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  hello(name: string): void { this.send({ type: "hello", name }); }
  pair(code: string): void { this.send({ type: "pair", code }); }
  accept(): void { this.send({ type: "pair-accept" }); }
  reject(): void { this.send({ type: "pair-reject" }); }
  sendSignal(data: unknown): void { this.send({ type: "signal", data }); }
  unpair(): void { this.send({ type: "unpair" }); }
  close(): void { try { this.ws.close(); } catch { /* ignore */ } }
}
