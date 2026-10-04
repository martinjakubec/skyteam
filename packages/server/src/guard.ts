/**
 * Abuse protection: what keeps a hostile client from crashing the server or
 * growing its memory without bound. Pure helpers (no Redis, no sockets), so
 * the unit tests can drive them directly.
 */

import type { Ack as AckResult } from "@skyteam/shared";

export type Ack = (res: AckResult) => void;
type Failure = Extract<AckResult, { ok: false }>;
export const SERVER_ERROR: Failure = { ok: false, error: "Server error." };

/**
 * A fixed-window counter per key: at most `limit` hits per `windowMs`. Windows
 * that have ended are swept once a window, so idle keys don't pile up.
 */
export function rateLimiter(limit: number, windowMs: number, now: () => number = Date.now): (key: string) => boolean {
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = now();
  return (key) => {
    const t = now();
    if (t - lastSweep >= windowMs) {
      for (const [k, w] of windows) if (t - w.start >= windowMs) windows.delete(k);
      lastSweep = t;
    }
    const w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      windows.set(key, { start: t, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= limit;
  };
}

/**
 * Wrap a socket event handler so no client can crash the server through it.
 * Clients choose what they send: an event may come without an ack callback (or
 * with something else in its place), and a handler may throw (Redis down, a
 * bug). Either used to reject a promise nobody caught, which ends the process.
 * Here a missing ack becomes a no-op, a throw is logged and answered, and an
 * event over the socket's rate limit is refused without running. `failure`
 * says how to answer a throw (e.g. "storage is down" when Redis is).
 */
export function guard(
  handle: (payload: unknown, ack: Ack) => Promise<void>,
  allow: () => boolean,
  label: string,
  failure: () => Failure = () => SERVER_ERROR,
): (...args: unknown[]) => Promise<void> {
  return async (...args) => {
    const last = args.at(-1);
    const ack: Ack = typeof last === "function" ? (res) => (last as Ack)(res) : () => {};
    // Ack-only events (game:start) put the callback first: they have no payload.
    const payload = typeof args[0] === "function" ? undefined : args[0];
    if (!allow()) return ack({ ok: false, error: "Too many requests — slow down." });
    try {
      await handle(payload, ack);
    } catch (e) {
      console.error(`[socket] ${label} failed:`, e);
      ack(failure()); // ignored if the handler already answered
    }
  };
}

/** Drop cached rooms not saved for `ttlMs`: Redis has expired them too, so the
 *  cache would only keep them alive in memory forever. */
export function evictExpired(cache: Map<string, { updatedAt: number }>, now: number, ttlMs: number): void {
  for (const [id, room] of cache) if (now - room.updatedAt >= ttlMs) cache.delete(id);
}
