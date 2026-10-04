import { availableParallelism } from "node:os";
import { DEFAULT_RECONNECT_GRACE_MS } from "@skyteam/shared";

const DEV_JWT_SECRET = "dev-insecure-secret-change-me";

export const env = {
  PORT: Number(process.env.PORT ?? 3001),
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  JWT_SECRET: process.env.JWT_SECRET ?? DEV_JWT_SECRET,
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
  /** How many reverse proxies sit in front of the server (production: Caddy and
   *  the client's nginx = 2), so the client's own address can be read from
   *  X-Forwarded-For for the rate limits. 0 = none: the socket's address is it. */
  TRUST_PROXY: Number(process.env.TRUST_PROXY ?? 0),
  /** Testing only: shortens every Real-Time round (unset = the game's 60 s). */
  REAL_TIME_SECONDS: process.env.REAL_TIME_SECONDS ? Number(process.env.REAL_TIME_SECONDS) : undefined,
};

/** Secrets that ship with the repo: fine for development, never for production. */
const KNOWN_SECRETS = [DEV_JWT_SECRET, "change-me-to-a-long-random-string"];
const MIN_SECRET_LENGTH = 32;

/**
 * What makes these settings unsafe to run in production (NODE_ENV=production),
 * or nothing outside it. Anyone who knows the JWT secret can mint a token for
 * any playerId and take over their seat; a wildcard origin lets any site drive
 * the server from its visitors' browsers.
 */
export function productionProblems(vars: Record<string, string | undefined>): string[] {
  if (vars.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  const secret = vars.JWT_SECRET;
  if (!secret || KNOWN_SECRETS.includes(secret) || secret.length < MIN_SECRET_LENGTH) {
    problems.push(`JWT_SECRET must be a random string of at least ${MIN_SECRET_LENGTH} characters (e.g. openssl rand -hex 32).`);
  }
  const origin = vars.CLIENT_ORIGIN;
  if (!origin) problems.push("CLIENT_ORIGIN must name the site's origin (e.g. https://skyteam.example).");
  else if (origin.split(",").some((o) => o.trim() === "*")) problems.push("CLIENT_ORIGIN must not be \"*\" in production.");
  return problems;
}

const problems = productionProblems(process.env);
if (problems.length > 0) {
  for (const p of problems) console.error(`[server] ${p}`);
  throw new Error("Refusing to start in production with unsafe settings (see above).");
}
if (env.JWT_SECRET === DEV_JWT_SECRET) {
  console.warn("[server] WARNING: using the default JWT secret — set JWT_SECRET before deploying.");
}
