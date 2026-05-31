// QR pairing: generate a QR of a link to this site that prefills your code, and
// scan one with the camera. Uses the native BarcodeDetector where available
// (Chrome/Android) and falls back to jsQR (e.g. iOS Safari).

import QRCode from "qrcode";
import jsQR from "jsqr";

export function pairUrl(code: string): string {
  return `${location.origin}/?code=${code}`;
}

export async function renderQr(canvas: HTMLCanvasElement, text: string): Promise<void> {
  await QRCode.toCanvas(canvas, text, { width: 180, margin: 1, color: { dark: "#1a1a1a", light: "#ffffff" } });
}

// Pull a 4-digit code out of a scanned value, whether it's a bare code or a pair URL.
export function codeFromScan(value: string): string | null {
  const m = value.match(/(?:[?&]code=)?(\d{4})\b/);
  return m ? m[1] : null;
}

export class QrScanner {
  private stream: MediaStream | null = null;
  private raf = 0;
  private detector: any = null;

  async start(video: HTMLVideoElement, onResult: (code: string) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = this.stream;
    await video.play();

    if ("BarcodeDetector" in window) {
      this.detector = new (window as any).BarcodeDetector({ formats: ["qr_code"] });
    }
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

    const tick = async () => {
      if (video.readyState >= video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        let raw: string | null = null;
        if (this.detector) {
          const codes = await this.detector.detect(canvas);
          if (codes.length) raw = codes[0].rawValue;
        } else {
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const r = jsQR(img.data, img.width, img.height);
          if (r) raw = r.data;
        }
        if (raw) {
          const code = codeFromScan(raw);
          if (code) { this.stop(); onResult(code); return; }
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
