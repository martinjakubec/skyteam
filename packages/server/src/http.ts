import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from "express";
import cors from "cors";
import { corsOptions } from "./cors";
import { env } from "./env";
import { rateLimiter } from "./guard";
import { issueToken, verifyToken } from "./identity";
import { SoloRoomRequest } from "@skyteam/shared";
import { createRoom, joinByInvite, RoomError } from "./rooms";
import { searchWorkers } from "./think";

/** Requests one client address may make per minute, per route. Generous for
 *  people (a few rooms an evening, even a whole LAN party behind one address),
 *  tight for a script creating rooms by the thousand. */
const ROOMS_PER_MINUTE = 20;
const JOINS_PER_MINUTE = 60;
const IDENTITIES_PER_MINUTE = 60;

/** Refuse a client address past `perMinute` requests to this route. */
function limit(perMinute: number): RequestHandler {
  const allow = rateLimiter(perMinute, 60_000);
  return (req, res, next) => {
    if (allow(req.ip ?? "")) return next();
    res.status(429).json({ error: "Too many requests — try again in a minute." });
  };
}

/** Express 4 doesn't catch a rejected async handler (the process would end on
 *  it): pass the error on to the error handler instead. */
const route =
  (handle: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) =>
    void handle(req, res).catch(next);

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error("[http] request failed:", err);
  if (!res.headersSent) res.status(500).json({ error: "Server error." });
};

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Behind proxies (production: Caddy, then the client's nginx), the client's
  // address is that many hops back in X-Forwarded-For; the rate limits need it.
  app.set("trust proxy", env.TRUST_PROXY);
  app.use(cors(corsOptions));
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, botWorkers: searchWorkers() });
  });

  // Issue (or echo back) an anonymous identity token.
  app.post("/identity", limit(IDENTITIES_PER_MINUTE), (req, res) => {
    res.json(resolveIdentity(req.body?.token));
  });

  // Create a room; the caller becomes the host. With `solo`, a bot takes the other seat.
  app.post("/rooms", limit(ROOMS_PER_MINUTE), route(async (req, res) => {
    const me = resolveIdentity(req.body?.token);
    let solo: SoloRoomRequest | undefined;
    if (req.body?.solo !== undefined) {
      // A solo request that doesn't parse is refused, not quietly turned into a multiplayer room.
      const parsed = SoloRoomRequest.safeParse(req.body.solo);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid solo game: pick a seat (pilot or copilot) and a bot level." });
        return;
      }
      solo = parsed.data;
    }
    const room = await createRoom(me.playerId, solo);
    res.json({ roomId: room.id, inviteCode: room.inviteCode, token: me.token });
  }));

  // Join a room by invite code.
  app.post("/rooms/:code/join", limit(JOINS_PER_MINUTE), route(async (req, res) => {
    const me = resolveIdentity(req.body?.token);
    try {
      const room = await joinByInvite(req.params.code, me.playerId);
      res.json({ roomId: room.id, inviteCode: room.inviteCode, token: me.token });
    } catch (e) {
      if (e instanceof RoomError) {
        res.status(e.code === "full" ? 409 : 404).json({ error: e.message });
        return;
      }
      throw e;
    }
  }));

  app.use(onError);
  return app;
}

/** Reuse the caller's identity if their token is valid, otherwise mint a new one. */
function resolveIdentity(token: unknown): { playerId: string; token: string } {
  if (typeof token === "string") {
    const playerId = verifyToken(token);
    if (playerId) return { playerId, token };
  }
  return issueToken();
}
