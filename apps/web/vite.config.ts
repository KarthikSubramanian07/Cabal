import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * In production the Pages worker hands `/api` to the game server through a service binding
 * (src/agent/gateway.ts). Locally, run `pnpm --filter @cabal/server dev` and the same paths
 * are proxied to it, sockets included, so the client never needs a server address.
 */
const api = {
  "/api": { target: process.env.CABAL_SERVER ?? "http://localhost:8787", changeOrigin: true, ws: true },
};

export default defineConfig({
  plugins: [react()],
  build: { target: "esnext" },
  server: { port: 5173, strictPort: true, proxy: api },
  preview: { proxy: api },
});
