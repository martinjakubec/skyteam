import { DEFAULT_RECONNECT_GRACE_MS } from "@skyteam/shared";

export const env = {
  PORT: Number(process.env.PORT ?? 3001),
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  JWT_SECRET: process.env.JWT_SECRET ?? "dev-insecure-secret-change-me",
  RECONNECT_GRACE_MS: Number(process.env.RECONNECT_GRACE_MS ?? DEFAULT_RECONNECT_GRACE_MS),
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
  /** Pause before each bot action, so a human can follow the NPC's play. */
  NPC_DELAY_MS: Number(process.env.NPC_DELAY_MS ?? 900),
};

if (env.JWT_SECRET === "dev-insecure-secret-change-me") {
  console.warn("[server] WARNING: using the default JWT secret — set JWT_SECRET before deploying.");
}
