import { redactGameStateFor, type ParticipantKind, type PlayerId, type RoomSnapshot } from "@skyteam/shared";
import type { Room } from "./types";

/** Build the view of a room tailored to a specific recipient (their "you"). */
export function toSnapshot(room: Room, viewerId: PlayerId): RoomSnapshot {
  const seat = room.seats.find((s) => s.playerId === viewerId);
  const kind: ParticipantKind = seat ? "player" : "observer";
  return {
    roomId: room.id,
    inviteCode: room.inviteCode,
    status: room.status,
    hostPlayerId: room.hostPlayerId,
    seats: room.seats.map((s) => ({
      playerId: s.playerId,
      role: s.role,
      ready: s.ready,
      connection: s.connected ? "connected" : "disconnected",
      ...(s.bot ? { bot: s.bot } : {}),
    })),
    hostCrew: room.hostCrew ?? "pilot",
    observerCount: room.observers.length,
    setup: room.setup,
    version: room.version,
    game: room.game ? redactGameStateFor(room.game, viewerId) : null,
    notice: room.notice ?? null,
    you: { playerId: viewerId, kind, role: seat?.role },
    serverTime: Date.now(),
  };
}
