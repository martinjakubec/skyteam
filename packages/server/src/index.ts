import http from "node:http";
import { createApp } from "./http";
import { attachSocket } from "./socket";
import { env } from "./env";

const app = createApp();
const server = http.createServer(app);
attachSocket(server);

server.listen(env.PORT, () => {
  console.log(`[server] listening on :${env.PORT}`);
  console.log(`[server] redis:   ${env.REDIS_URL}`);
  console.log(`[server] cors:    ${env.CLIENT_ORIGIN}`);
  console.log(`[server] grace:   ${env.RECONNECT_GRACE_MS}ms`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[server] ${signal} received, shutting down.`);
    server.close(() => process.exit(0));
  });
}
