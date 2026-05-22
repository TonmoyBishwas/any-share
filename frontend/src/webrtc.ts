// WebRTC peer connection wrapper.
//
// STRICT LOCAL-ONLY: getIceServers() returns [] so the browser gathers only
// host/mDNS candidates — the connection (and all file bytes) stays on the LAN and
// never leaves the wifi. If the network blocks direct connections (client
// isolation), ICE fails and we surface that clearly via onFailed.

export function getIceServers(): RTCIceServer[] {
  // To enable the free Cloudflare TURN relay later (works on isolated networks),
  // fetch short-lived credentials from a Worker endpoint and return them here.
  return [];
}

export interface PeerEvents {
  onSignal: (data: unknown) => void;
  onChannelOpen: (channel: RTCDataChannel) => void;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  onFailed: () => void;
}

export class Peer {
  readonly pc: RTCPeerConnection;
  private events: PeerEvents;
  private channel: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private failTimer: number | null = null;
  private done = false;

  constructor(events: PeerEvents) {
    this.events = events;
    this.pc = new RTCPeerConnection({ iceServers: getIceServers() });

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.events.onSignal({ candidate: e.candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      this.events.onStateChange?.(s);
      if (s === "failed") this.fail();
    };
    this.pc.ondatachannel = (e) => this.setupChannel(e.channel);
  }

  async start(initiator: boolean): Promise<void> {
    if (initiator) {
      this.setupChannel(this.pc.createDataChannel("any-share", { ordered: true }));
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.events.onSignal({ sdp: this.pc.localDescription });
    }
    // If no DataChannel opens within 15s, treat the network as blocking direct P2P.
    this.failTimer = window.setTimeout(() => {
      if (this.pc.connectionState !== "connected") this.fail();
    }, 15_000);
  }

  async handleSignal(data: any): Promise<void> {
    if (data?.sdp) {
      await this.pc.setRemoteDescription(data.sdp);
      this.remoteSet = true;
      for (const c of this.pendingCandidates.splice(0)) {
        try { await this.pc.addIceCandidate(c); } catch { /* ignore */ }
      }
      if (data.sdp.type === "offer") {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.events.onSignal({ sdp: this.pc.localDescription });
      }
    } else if (data?.candidate) {
      if (this.remoteSet) {
        try { await this.pc.addIceCandidate(data.candidate); } catch { /* ignore */ }
      } else {
        this.pendingCandidates.push(data.candidate);
      }
    }
  }

  private setupChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      if (this.failTimer) window.clearTimeout(this.failTimer);
      this.events.onChannelOpen(channel);
    };
  }

  private fail(): void {
    if (this.done) return;
    this.done = true;
    if (this.failTimer) window.clearTimeout(this.failTimer);
    this.events.onFailed();
  }

  close(): void {
    this.done = true;
    if (this.failTimer) window.clearTimeout(this.failTimer);
    try { this.channel?.close(); } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
  }
}
