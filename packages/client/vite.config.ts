import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// The pages that are always live: the API, rooms, identity, the health check
// and the game's socket. The service worker never answers them from a cache.
const LIVE = /^\/(api|rooms|identity|health|socket\.io)(\/|$)/;

export default defineConfig({
  plugins: [
    react(),
    // The installable app: a manifest, and a service worker that keeps the app
    // shell (index.html and the hashed assets) so it opens at once. A new
    // version waits for the player's Reload (src/pwa/UpdateBar.tsx), never
    // interrupting a game.
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["favicon.ico", "apple-touch-icon-180x180.png"],
      manifest: {
        name: "SkyTeam",
        short_name: "SkyTeam",
        description: "Land the plane together. One Pilot, one Co-Pilot, no talking.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#0b0f17",
        theme_color: "#0b0f17",
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [LIVE],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin === "https://fonts.googleapis.com",
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-css" },
          },
          {
            urlPattern: ({ url }) => url.origin === "https://fonts.gstatic.com",
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts",
              expiration: { maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
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
