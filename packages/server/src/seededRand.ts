import { createHmac, randomBytes } from "node:crypto";
import type { Rand } from "@skyteam/shared";

/**
 * Seeded dice for live games. Every game gets a secret 128-bit seed; its rolls
 * come from named streams — "i" (the Intern order), "d<r>" (round r's deal),
 * "p<r>" (everything else rolled in round r: rerolls, Traffic dice). The k-th
 * draw of a stream is HMAC-SHA256(seed, "<stream>:<k>:<attempt>"), read as
 * 32-bit words with rejection so every value is equally likely.
 *
 * So one seed gives the same Intern order and the same deal every round,
 * whatever the players did in between — which is what flying "the same dice"
 * again means. The seed never leaves the server while a game runs (dice would
 * be predictable); it's written to the game's log row when the game ends.
 */

export interface SeedState {
  seed: string;
  /** Draws taken so far, per stream (kept in the room record, so a restarted
   *  server carries on where it was). */
  draws: Record<string, number>;
}

export const newSeed = (): string => randomBytes(16).toString("hex");

export const newSeedState = (seed: string = newSeed()): SeedState => ({ seed, draws: {} });

/** A Rand drawing from the stream `label()` names at each draw. */
export function seededRand(state: SeedState, label: () => string): Rand {
  const key = Buffer.from(state.seed, "hex");
  return (n) => {
    const stream = label();
    const k = state.draws[stream] ?? 0;
    state.draws[stream] = k + 1;
    const limit = Math.floor(0x1_0000_0000 / n) * n; // below it, x % n is unbiased
    for (let attempt = 0; ; attempt++) {
      const mac = createHmac("sha256", key).update(`${stream}:${k}:${attempt}`).digest();
      for (let i = 0; i < mac.length; i += 4) {
        const x = mac.readUInt32BE(i);
        if (x < limit) return x % n;
      }
    }
  };
}
