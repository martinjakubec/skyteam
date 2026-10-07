import { nanoid } from "nanoid";
import { DEFAULT_SETUP, MAX_PLAYERS, type BotLevel, type Crew } from "@skyteam/shared";
import type { Room } from "./types";
import { getRoom, getRoomIdByInvite, saveRoom } from "./store";

/** Spectators one room takes. Each is kept in the room's record, which is saved
 *  on every move, so an unbounded list would let anyone slow a game down. */
export const MAX_OBSERVERS = 20;

export class RoomError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "RoomError";
  }
}

/** Create a fresh room with the creator seated as host. With `solo`, the host
 *  flies `crew` and a bot at `level` flies the other seat (always connected
 *  and ready). */
export async function createRoom(hostPlayerId: string, solo?: { crew: Crew; level: BotLevel }): Promise<Room> {
  const room: Room = {
    id: nanoid(),
    inviteCode: nanoid(8),
    hostPlayerId,
    status: "lobby",
    seats: [
      { playerId: hostPlayerId, role: "host", ready: false, connected: false },
      ...(solo ? [{ playerId: `bot:${nanoid()}`, role: "guest" as const, ready: true, connected: true, bot: solo.level }] : []),
    ],
    hostCrew: solo?.crew ?? "pilot",
    observers: [],
    setup: structuredClone(DEFAULT_SETUP),
    version: 0,
    game: null,
    chat: [],
    updatedAt: Date.now(),
  };
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
  } else if (room.observers.length < MAX_OBSERVERS) {
    room.observers.push(playerId);
  } else {
    throw new RoomError("full", "This room is full: it can't take more spectators.");
  }
  await saveRoom(room);
  return room;
}
