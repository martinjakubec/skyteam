import http from "node:http";
import { createApp } from "./http";
import { attachSocket } from "./socket";
import { env } from "./env";
import { warmThinking } from "./think";
import { initGameLogs } from "./gameLog";

const app = createApp();
const server = http.createServer(app);
attachSocket(server);

server.listen(env.PORT, () => {
  console.log(`[server] listening on :${env.PORT}`);
  console.log(`[server] redis:   ${env.REDIS_URL}`);
  console.log(`[server] cors:    ${env.CLIENT_ORIGIN}`);
  console.log(`[server] grace:   ${env.RECONNECT_GRACE_MS}ms`);
  void warmThinking(); // the Aviator bot's search worker takes a few seconds to load
  // Game logs: tables, the code list, and rows queued while Postgres was away.
  void initGameLogs().catch((e) => console.error("[gamelog] start failed:", e));
});

// A last line of defence: handlers, routes and timers catch their own errors,
// but anything that slips through is logged rather than ending every game.
process.on("unhandledRejection", (e) => console.error("[server] unhandled rejection:", e));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[server] ${signal} received, shutting down.`);
    server.close(() => process.exit(0));
  });
}
