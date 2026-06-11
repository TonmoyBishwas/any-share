// Collapse a client IP to a LAN-stable identifier, used as the seed for the room key.
//
// Two devices on the same WiFi must land in the same room to find each other by code.
// IPv4 is already collapsed to one public address per LAN by NAT, so it is used whole.
// IPv6 has no NAT: every device gets its own /128 address, but all devices on one LAN
// share the router's delegated /64 prefix — so we key IPv6 on that /64 instead.
export function networkId(ip: string): string {
  if (!ip.includes(":")) return ip; // IPv4, or the "local-dev" dev sentinel — unchanged

  // IPv6 may be compressed with "::", so expand to 8 hextets before taking the /64.
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = ip.includes("::")
    ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t]
    : ip.split(":");

  // First four hextets = the /64 routing prefix. Normalize each (strip leading zeros)
  // so the same prefix written two ways still maps to one room.
  const prefix = full.slice(0, 4).map((x) => (x || "0").replace(/^0+(?=.)/, "")).join(":");
  return `${prefix}::/64`;
}
