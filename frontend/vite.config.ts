import { defineConfig } from "vite";

// In dev, proxy /rtc to the local Worker (wrangler dev defaults to :8787) so the
// frontend always talks to a same-origin /rtc/ws — identical to production, and
// reachable from a phone on the LAN via the Vite host.
export default defineConfig({
  server: {
    host: true,
    proxy: {
      "/rtc": {
        target: "http://localhost:8787",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
