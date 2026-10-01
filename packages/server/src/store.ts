import Redis from "ioredis";
import { DEFAULT_SETUP, ROOM_TTL_SECONDS, normalizeGameState } from "@skyteam/shared";
import { env } from "./env";
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
export const redis = new Redis(env.REDIS_URL, { lazyConnect: false });

redis.on("error", (err) => console.error("[redis] error:", err.message));

const cache = new Map<string, Room>();

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
  const cached = cache.get(id);
  if (cached) return cached;
  const raw = await redis.get(roomKey(id));
  if (!raw) return null;
  const room = JSON.parse(raw) as Room;
  // Rooms persisted before game setup existed have none; give them the default.
  room.setup ??= structuredClone(DEFAULT_SETUP);
  room.setup.abilities ??= []; // rooms saved before Special Abilities existed
  // A game saved by an older build lacks newer state fields: fill them in.
  if (room.game) normalizeGameState(room.game);
  cache.set(id, room);
  return room;
}

export async function getRoomIdByInvite(code: string): Promise<string | null> {
  return redis.get(inviteKey(code));
}
