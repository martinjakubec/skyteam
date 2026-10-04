import Redis from "ioredis";
import { DEFAULT_SETUP, ROOM_TTL_SECONDS, UNAVAILABLE, SCENARIOS, normalizeBotLevel, normalizeGameState } from "@skyteam/shared";
import { env } from "./env";
import { evictExpired } from "./guard";
import { singleFlight } from "./singleFlight";
import type { Room } from "./types";

/**
 * Room persistence.
 *
 * Redis is the durable source of truth (your "durable state" requirement): the
 * room survives a server restart/crash and can be rehydrated. An in-memory Map
 * acts as a write-through cache so hot rooms avoid a round-trip on every read.
 *
 * The `invite:<code>` key maps a shareable invite code to the internal room id,
 * keeping the public link decoupled from the (non-guessable) room id.
 */
// No offline queue: while Redis is down, commands fail at once instead of
// waiting (requests used to hang until it came back). ioredis keeps
// reconnecting on its own, and requests work again as soon as it's back.
export const redis = new Redis(env.REDIS_URL, { lazyConnect: false, enableOfflineQueue: false });

/** Whether Redis is connected. While it isn't, nothing can be saved: the server
 *  refuses requests with UNAVAILABLE_ERROR (a 500) rather than lose changes. */
export const storageUp = () => redis.status === "ready";
export const UNAVAILABLE_ERROR = {
  ok: false,
  error: "The game server can't reach its storage right now.",
  code: UNAVAILABLE,
} as const;

redis.on("error", (err) => console.error("[redis] error:", err.message));

const cache = new Map<string, Room>();
// Rooms nobody has saved for the TTL have expired in Redis: forget them here too.
setInterval(() => evictExpired(cache, Date.now(), ROOM_TTL_SECONDS * 1000), 60_000).unref();

const roomKey = (id: string) => `room:${id}`;
const inviteKey = (code: string) => `invite:${code}`;

export async function saveRoom(room: Room): Promise<void> {
  room.updatedAt = Date.now();
  cache.set(room.id, room);
  await redis
    .multi()
    .set(roomKey(room.id), JSON.stringify(room), "EX", ROOM_TTL_SECONDS)
    .set(inviteKey(room.inviteCode), room.id, "EX", ROOM_TTL_SECONDS)
    .exec();
}

export async function getRoom(id: string): Promise<Room | null> {
  return cache.get(id) ?? loadRoom(id);
}

/** Read a room that isn't cached. Concurrent reads of the same room share one
 *  load, so every handler works on the one cached object. */
const loadRoom = singleFlight(async (id: string): Promise<Room | null> => {
  const raw = await redis.get(roomKey(id));
  if (!raw) return null;
  const room = JSON.parse(raw) as Room;
  // Rooms persisted before game setup existed have none; give them the default.
  room.setup ??= structuredClone(DEFAULT_SETUP);
  room.setup.abilities ??= []; // rooms saved before Special Abilities existed
  room.hostCrew ??= "pilot"; // rooms saved before seats chose their crew
  for (const seat of room.seats) if (seat.bot) seat.bot = normalizeBotLevel(seat.bot); // retired levels fly as Aviator
  // An airport that's since been removed (e.g. the old Turns test board).
  if (!SCENARIOS[room.setup.scenarioId]) room.setup = structuredClone(DEFAULT_SETUP);
  // A game saved by an older build lacks newer state fields: fill them in.
  if (room.game) normalizeGameState(room.game);
  // Saved while we read (the room was just created): keep that object.
  const current = cache.get(id);
  if (current) return current;
  cache.set(id, room);
  return room;
});

export async function getRoomIdByInvite(code: string): Promise<string | null> {
  return redis.get(inviteKey(code));
}
