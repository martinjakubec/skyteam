import { nanoid } from "nanoid";
import { DEFAULT_SETUP, MAX_PLAYERS, type BotLevel, type Crew } from "@skyteam/shared";
import type { Room } from "./types";
import { getRoom, getRoomIdByInvite, saveRoom } from "./store";

export class RoomError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "RoomError";
  }
}

/** Create a fresh room with the creator seated as host. */
export async function createRoom(hostPlayerId: string): Promise<Room> {
  const room: Room = {
    id: nanoid(),
    inviteCode: nanoid(8),
    hostPlayerId,
    status: "lobby",
    seats: [{ playerId: hostPlayerId, role: "host", ready: false, connected: false }],
    hostCrew: "pilot",
    observers: [],
    setup: structuredClone(DEFAULT_SETUP),
    version: 0,
    game: null,
    updatedAt: Date.now(),
  };
  await saveRoom(room);
  return room;
}

/** A solo room: the caller (host) flies `crew`; a bot at `level` flies the
 *  other seat and is always connected and ready. */
export async function createSoloRoom(hostPlayerId: string, crew: Crew, level: BotLevel): Promise<Room> {
  const room = await createRoom(hostPlayerId);
  room.hostCrew = crew;
  room.seats.push({ playerId: `bot:${nanoid()}`, role: "guest", ready: true, connected: true, bot: level });
  await saveRoom(room);
  return room;
}

/**
 * Join a room via its invite code. Idempotent: re-joining returns the existing
 * room. If both player seats are taken (or the game has already started), the
 * joiner becomes an observer — this is the seam spectators will use later.
 */
export async function joinByInvite(code: string, playerId: string): Promise<Room> {
  const roomId = await getRoomIdByInvite(code);
  const room = roomId ? await getRoom(roomId) : null;
  if (!room) throw new RoomError("not_found", "Room not found or expired.");

  const alreadyIn =
    room.seats.some((s) => s.playerId === playerId) || room.observers.includes(playerId);
  if (alreadyIn) return room;

  if (room.status === "lobby" && room.seats.length < MAX_PLAYERS) {
    room.seats.push({ playerId, role: "guest", ready: false, connected: false });
  } else {
    room.observers.push(playerId);
  }
  await saveRoom(room);
  return room;
}
