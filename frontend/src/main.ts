import "./styles.css";
import { Signaling } from "./signaling";
import { Peer } from "./webrtc";
import { Transfer, humanSize, type CompletedFile, type IncomingFile } from "./transfer";
import { renderQr, pairUrl, QrScanner } from "./qr";

// ---- element helpers -------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const SCREENS = [
  "screen-connecting", "screen-home", "screen-outgoing", "screen-incoming",
  "screen-rtc", "screen-connected", "screen-failed", "screen-left",
];
function show(id: string): void {
  for (const s of SCREENS) $(s).classList.toggle("hidden", s !== id);
}

let toastTimer = 0;
function toast(msg: string): void {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add("hidden"), 3500);
}

// ---- state -----------------------------------------------------------------
let myCode = "";
let peer: Peer | null = null;
let transfer: Transfer | null = null;
let expectingPair = false;
const scanner = new QrScanner();

// ---- signaling -------------------------------------------------------------
const signaling = new Signaling({
  onWelcome(_deviceId, code) {
    myCode = code;
    $("my-code").textContent = code;
    renderQr($("my-qr") as HTMLCanvasElement, pairUrl(code)).catch(() => {});
    signaling.hello(loadName());
    show("screen-home");
    maybeAutoConnectFromUrl();
  },
  onClose() {
    toast("Disconnected from server. Reload to reconnect.");
    show("screen-connecting");
  },
  onPairPending(verifyWord) {
    $("out-verify").textContent = verifyWord;
    show("screen-outgoing");
  },
  onPairIncoming(fromName, verifyWord) {
    $("in-name").textContent = fromName;
    $("in-verify").textContent = verifyWord;
    show("screen-incoming");
  },
  onPaired(role, peerName) {
    if (!expectingPair) return; // we cancelled; ignore a late accept
    expectingPair = false;
    startRtc(role, peerName);
  },
  onPairFailed(reason) {
    expectingPair = false;
    show("screen-home");
    toast(reason === "busy" ? "That device is busy with another transfer." : "No device with that code on this network.");
  },
  onPairRejected() {
    expectingPair = false;
    show("screen-home");
    toast("The other device declined.");
  },
  onPeerLeft() {
    teardownPeer();
    show("screen-left");
  },
  onSignal(data) {
    peer?.handleSignal(data);
  },
  onError(reason, retryInMs) {
    if (reason === "rate_limited") {
      toast(`Too many attempts. Try again in ${Math.ceil((retryInMs ?? 0) / 1000)}s.`);
      show("screen-home");
    }
  },
});

// ---- WebRTC lifecycle ------------------------------------------------------
function startRtc(role: "initiator" | "responder", peerName: string): void {
  show("screen-rtc");
  peer = new Peer({
    onSignal: (d) => signaling.sendSignal(d),
    onChannelOpen: (channel) => onConnected(channel, peerName),
    onFailed: () => {
      teardownPeer();
      show("screen-failed");
    },
  });
  peer.start(role === "initiator").catch(() => {
    teardownPeer();
    show("screen-failed");
  });
}

function onConnected(channel: RTCDataChannel, peerName: string): void {
  $("peer-name").textContent = peerName || "A device";
  $("transfers").innerHTML = "";
  $("received").innerHTML = "";
  transfer = new Transfer(channel, {
    onText: addReceivedText,
    onIncomingProgress: upsertIncoming,
    onIncomingComplete: completeIncoming,
    onOutgoingStart: (id, name, size) => upsertOutgoing(id, name, size, 0),
    onOutgoingProgress: (id, sent, total) => upsertOutgoing(id, undefined, total, sent),
    onOutgoingComplete: (id) => markDone(`out-${id}`),
  });
  show("screen-connected");
}

function teardownPeer(): void {
  peer?.close();
  peer = null;
  transfer = null;
}

// ---- transfer UI -----------------------------------------------------------
function rowBar(li: HTMLElement, sent: number, total: number): void {
  const pct = total ? Math.min(100, Math.round((sent / total) * 100)) : 0;
  (li.querySelector(".bar > span") as HTMLElement).style.width = `${pct}%`;
  (li.querySelector(".meta .pct") as HTMLElement).textContent = `${pct}%`;
}

function ensureRow(listId: string, rowId: string, name: string, size: number): HTMLElement {
  let li = document.getElementById(rowId);
  if (!li) {
    li = document.createElement("li");
    li.id = rowId;
    li.innerHTML =
      `<div class="meta"><span class="nm"></span><span class="pct">0%</span></div>` +
      `<div class="bar"><span></span></div>` +
      `<div class="meta"><span class="sz"></span><span class="act"></span></div>`;
    $(listId).prepend(li);
  }
  (li.querySelector(".nm") as HTMLElement).textContent = name;
  (li.querySelector(".sz") as HTMLElement).textContent = humanSize(size);
  return li;
}

function upsertOutgoing(id: string, name: string | undefined, total: number, sent: number): void {
  const li = ensureRow("transfers", `out-${id}`, name ?? (document.getElementById(`out-${id}`)?.querySelector(".nm")?.textContent ?? "file"), total);
  (li.querySelector(".act") as HTMLElement).textContent = "sending ↑";
  rowBar(li, sent, total);
}

function upsertIncoming(file: IncomingFile): void {
  const li = ensureRow("received", `in-${file.id}`, file.name, file.size);
  (li.querySelector(".act") as HTMLElement).textContent = "receiving ↓";
  rowBar(li, file.received, file.size);
}

function completeIncoming(file: CompletedFile): void {
  const li = ensureRow("received", `in-${file.id}`, file.name, file.blob.size);
  rowBar(li, 1, 1);
  li.querySelector(".bar")!.classList.add("done");
  const url = URL.createObjectURL(file.blob);
  const act = li.querySelector(".act") as HTMLElement;
  act.innerHTML = "";
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.textContent = "Save ⬇";
  act.appendChild(a);
  a.click(); // auto-download; link stays for re-saving
}

function markDone(rowId: string): void {
  const li = document.getElementById(rowId);
  if (!li) return;
  li.querySelector(".bar")!.classList.add("done");
  (li.querySelector(".act") as HTMLElement).textContent = "sent ✓";
}

function addReceivedText(text: string): void {
  const li = document.createElement("li");
  li.innerHTML = `<div class="meta"><span class="nm">Text received</span><span class="act"></span></div>`;
  const pre = document.createElement("div");
  pre.textContent = text;
  pre.style.whiteSpace = "pre-wrap";
  pre.style.wordBreak = "break-word";
  li.appendChild(pre);
  const copy = document.createElement("button");
  copy.className = "ghost";
  copy.textContent = "Copy";
  copy.onclick = () => { navigator.clipboard?.writeText(text); toast("Copied"); };
  (li.querySelector(".act") as HTMLElement).appendChild(copy);
  $("received").prepend(li);
}

// ---- pairing actions -------------------------------------------------------
function connect(code: string): void {
  if (!/^\d{4}$/.test(code)) { toast("Enter a 4-digit code."); return; }
  if (code === myCode) { toast("That's your own code."); return; }
  expectingPair = true;
  signaling.pair(code);
}

// ---- device name -----------------------------------------------------------
function loadName(): string {
  return localStorage.getItem("any-share-name") ?? "";
}

// ---- QR deep-link ----------------------------------------------------------
function maybeAutoConnectFromUrl(): void {
  const code = new URLSearchParams(location.search).get("code");
  if (code && /^\d{4}$/.test(code) && code !== myCode) {
    ($("peer-code") as HTMLInputElement).value = code;
    history.replaceState(null, "", location.pathname);
    setTimeout(() => connect(code), 300);
  }
}

// ---- DOM wiring ------------------------------------------------------------
function wire(): void {
  const nameInput = $("name-input") as HTMLInputElement;
  nameInput.value = loadName();
  nameInput.addEventListener("change", () => {
    localStorage.setItem("any-share-name", nameInput.value);
    signaling.hello(nameInput.value);
  });

  const peerCode = $("peer-code") as HTMLInputElement;
  peerCode.addEventListener("input", () => {
    peerCode.value = peerCode.value.replace(/\D/g, "").slice(0, 4);
  });
  $("connect-btn").addEventListener("click", () => connect(peerCode.value));
  peerCode.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") connect(peerCode.value); });

  // QR scanning
  $("scan-btn").addEventListener("click", async () => {
    $("scanner").classList.remove("hidden");
    try {
      await scanner.start($("scan-video") as HTMLVideoElement, (code) => {
        $("scanner").classList.add("hidden");
        peerCode.value = code;
        connect(code);
      });
    } catch {
      $("scanner").classList.add("hidden");
      toast("Couldn't open the camera.");
    }
  });
  $("scan-stop").addEventListener("click", () => { scanner.stop(); $("scanner").classList.add("hidden"); });

  // pairing prompts
  $("out-cancel").addEventListener("click", () => { expectingPair = false; signaling.unpair(); show("screen-home"); });
  $("accept-btn").addEventListener("click", () => { expectingPair = true; signaling.accept(); show("screen-rtc"); });
  $("reject-btn").addEventListener("click", () => { signaling.reject(); show("screen-home"); });

  // transfer
  const fileInput = $("file-input") as HTMLInputElement;
  $("pick-btn").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.length) transfer?.sendFiles([...fileInput.files]);
    fileInput.value = "";
  });
  const drop = $("drop-zone");
  ["dragover", "dragenter"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("dragover"); }));
  drop.addEventListener("drop", (e) => {
    const files = (e as DragEvent).dataTransfer?.files;
    if (files?.length) transfer?.sendFiles([...files]);
  });

  const textInput = $("text-input") as HTMLTextAreaElement;
  $("send-text-btn").addEventListener("click", () => {
    if (textInput.value.trim()) { transfer?.sendText(textInput.value); toast("Text sent."); textInput.value = ""; }
  });

  $("disconnect-btn").addEventListener("click", () => { signaling.unpair(); teardownPeer(); show("screen-home"); });
  $("failed-back").addEventListener("click", () => { signaling.unpair(); show("screen-home"); });
  $("left-back").addEventListener("click", () => show("screen-home"));
}

wire();

// PWA: register the service worker (enables "install"/Add to Home Screen).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
