import { availableParallelism } from "node:os";
import { DEFAULT_RECONNECT_GRACE_MS } from "@skyteam/shared";

export const env = {
  PORT: Number(process.env.PORT ?? 3001),
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  JWT_SECRET: process.env.JWT_SECRET ?? "dev-insecure-secret-change-me",
  RECONNECT_GRACE_MS: Number(process.env.RECONNECT_GRACE_MS ?? DEFAULT_RECONNECT_GRACE_MS),
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
  /** Pause before each bot action, so a human can follow the NPC's play. */
  NPC_DELAY_MS: Number(process.env.NPC_DELAY_MS ?? 900),
  /** How long the Aviator bot may search for a move. */
  NPC_THINK_MS: Number(process.env.NPC_THINK_MS ?? 600),
  /** Search worker threads (each bot decision fans out to the idle ones). Set it
   *  to the CPUs the container may really use: the default (a spare core each,
   *  at most 4) counts the host's cores, which may exceed a container's quota. */
  NPC_WORKERS: Math.max(1, Number(process.env.NPC_WORKERS) || Math.min(4, availableParallelism() - 1)),
  /** Testing only: shortens every Real-Time round (unset = the game's 60 s). */
  REAL_TIME_SECONDS: process.env.REAL_TIME_SECONDS ? Number(process.env.REAL_TIME_SECONDS) : undefined,
};

if (env.JWT_SECRET === "dev-insecure-secret-change-me") {
  console.warn("[server] WARNING: using the default JWT secret — set JWT_SECRET before deploying.");
}
