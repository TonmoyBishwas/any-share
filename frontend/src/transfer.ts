// File + text transfer over the open RTCDataChannel.
//
// Wire protocol on the channel:
//   • JSON strings for control: {kind:"text"} | {kind:"file-start"} | {kind:"file-end"}
//   • ArrayBuffer messages: raw chunks belonging to the current incoming file
// The channel is ordered + reliable and we send one file at a time, so a binary
// chunk always belongs to the most recent file-start. Backpressure is applied via
// bufferedAmount so we never blow up memory on large files.

const CHUNK = 64 * 1024;
const BUFFER_HIGH = 8 * 1024 * 1024;
const BUFFER_LOW = 1 * 1024 * 1024;

export interface IncomingFile { id: string; name: string; size: number; received: number; }
export interface CompletedFile { id: string; name: string; mime: string; blob: Blob; }

export interface TransferEvents {
  onText: (text: string) => void;
  onIncomingProgress: (file: IncomingFile) => void;
  onIncomingComplete: (file: CompletedFile) => void;
  onOutgoingStart: (id: string, name: string, size: number) => void;
  onOutgoingProgress: (id: string, sent: number, total: number) => void;
  onOutgoingComplete: (id: string) => void;
}

export class Transfer {
  private channel: RTCDataChannel;
  private events: TransferEvents;
  private incoming: { meta: IncomingFile; mime: string; chunks: ArrayBuffer[] } | null = null;

  constructor(channel: RTCDataChannel, events: TransferEvents) {
    this.channel = channel;
    this.events = events;
    channel.bufferedAmountLowThreshold = BUFFER_LOW;
    channel.onmessage = (e) => this.onMessage(e.data);
  }

  sendText(text: string): void {
    if (text.trim()) this.channel.send(JSON.stringify({ kind: "text", text }));
  }

  async sendFiles(files: File[]): Promise<void> {
    for (const file of files) await this.sendFile(file);
  }

  private async sendFile(file: File): Promise<void> {
    const id = crypto.randomUUID();
    const mime = file.type || "application/octet-stream";
    this.channel.send(JSON.stringify({ kind: "file-start", id, name: file.name, size: file.size, mime }));
    this.events.onOutgoingStart(id, file.name, file.size);

    let offset = 0;
    while (offset < file.size) {
      if (this.channel.bufferedAmount > BUFFER_HIGH) await this.drain();
      const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
      this.channel.send(buf);
      offset += buf.byteLength;
      this.events.onOutgoingProgress(id, offset, file.size);
    }
    this.channel.send(JSON.stringify({ kind: "file-end", id }));
    this.events.onOutgoingComplete(id);
  }

  private drain(): Promise<void> {
    return new Promise((resolve) => {
      const handler = () => { this.channel.removeEventListener("bufferedamountlow", handler); resolve(); };
      this.channel.addEventListener("bufferedamountlow", handler);
    });
  }

  private onMessage(data: string | ArrayBuffer): void {
    if (typeof data === "string") {
      let msg: any;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.kind === "text") {
        this.events.onText(msg.text);
      } else if (msg.kind === "file-start") {
        this.incoming = {
          meta: { id: msg.id, name: msg.name, size: msg.size, received: 0 },
          mime: msg.mime,
          chunks: [],
        };
        this.events.onIncomingProgress({ ...this.incoming.meta });
      } else if (msg.kind === "file-end") {
        if (this.incoming) {
          const { meta, mime, chunks } = this.incoming;
          this.events.onIncomingComplete({ id: meta.id, name: meta.name, mime, blob: new Blob(chunks, { type: mime }) });
          this.incoming = null;
        }
      }
    } else if (this.incoming) {
      this.incoming.chunks.push(data);
      this.incoming.meta.received += data.byteLength;
      this.events.onIncomingProgress({ ...this.incoming.meta });
    }
  }
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}
