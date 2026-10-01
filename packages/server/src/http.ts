import express from "express";
import cors from "cors";
import { corsOptions } from "./cors";
import { issueToken, verifyToken } from "./identity";
import { createRoom, joinByInvite, RoomError } from "./rooms";

export function createApp() {
  const app = express();
  app.use(cors(corsOptions));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Issue (or echo back) an anonymous identity token.
  app.post("/identity", (req, res) => {
    res.json(resolveIdentity(req.body?.token));
  });

  // Create a room; the caller becomes the host.
  app.post("/rooms", async (req, res) => {
    const me = resolveIdentity(req.body?.token);
    const room = await createRoom(me.playerId);
    res.json({ roomId: room.id, inviteCode: room.inviteCode, token: me.token });
  });

  // Join a room by invite code.
  app.post("/rooms/:code/join", async (req, res) => {
    const me = resolveIdentity(req.body?.token);
    try {
      const room = await joinByInvite(req.params.code, me.playerId);
      res.json({ roomId: room.id, inviteCode: room.inviteCode, token: me.token });
    } catch (e) {
      if (e instanceof RoomError) {
        res.status(404).json({ error: e.message });
        return;
      }
      throw e;
    }
  });

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
