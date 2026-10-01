import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on 0.0.0.0 so the dev server is reachable from outside the container
    port: 5173,
    // Vite only accepts localhost/IP Host headers; also allow the hostname other
    // containers use to reach the host (scripts/simulate.sh).
    allowedHosts: ["host.docker.internal"],
    // File events from the Windows host don't propagate into the container over
    // the bind mount (WSL2 / Docker Desktop), so HMR misses edits. Poll instead.
    watch: { usePolling: true, interval: 150 },
  },
  preview: {
    host: true,
    port: 5173,
  },
});
