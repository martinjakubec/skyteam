import type { GameSetup, GameState, PlayerId, RoomStatus, SeatRole } from "@skyteam/shared";

/** A seat is the durable link between a room and a player. Crucially it is NOT
 *  a socket: a socket can drop and a fresh one re-attach to the same seat —
 *  that is the whole reconnection mechanism. */
export interface Seat {
  playerId: PlayerId;
  role: SeatRole;
  ready: boolean;
  connected: boolean;
}

/** The authoritative room record. Persisted to Redis on every change. */
export interface Room {
  id: string;
  inviteCode: string;
  hostPlayerId: PlayerId;
  status: RoomStatus;
  seats: Seat[];
  observers: PlayerId[];
  /** Airport + modules for the next game; the host edits it in the lobby. */
  setup: GameSetup;
  /** Monotonic game-command counter (also used by clients to detect gaps). */
  version: number;
  game: GameState | null;
  updatedAt: number;
}
