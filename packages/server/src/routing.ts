import type { Request, RequestHandler, Response } from "express";
import { rateLimiter } from "./guard";

/** Express 4 doesn't catch a rejected async handler (the process would end on
 *  it): pass the error on to the error handler instead. */
export const route =
  (handle: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) =>
    void handle(req, res).catch(next);

/** Refuse a client address past `count` requests to this route per window. */
export function limit(count: number, windowMs = 60_000, error = "Too many requests — try again in a minute."): RequestHandler {
  const allow = rateLimiter(count, windowMs);
  return (req, res, next) => {
    if (allow(req.ip ?? "")) return next();
    res.status(429).json({ error });
  };
}

/** Counts failures per key (e.g. a username) and blocks the key once it has
 *  `max` within the window — whoever is asking, from wherever. */
export function failureLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const failures = new Map<string, { start: number; count: number }>();
  const current = (key: string) => {
    const f = failures.get(key);
    if (f && now() - f.start >= windowMs) failures.delete(key);
    return failures.get(key);
  };
  return {
    blocked: (key: string) => (current(key)?.count ?? 0) >= max,
    fail(key: string) {
      const f = current(key);
      if (f) f.count++;
      else {
        if (failures.size > 50_000) failures.clear(); // a flood of made-up names can't grow this forever
        failures.set(key, { start: now(), count: 1 });
      }
    },
  };
}
