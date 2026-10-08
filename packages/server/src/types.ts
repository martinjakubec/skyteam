import type { SeedState } from "./seededRand";
import type { BotLevel, ChatMessage, Debrief, DieValue, Crew, GameSetup, GameState, PlayerId, RoomStatus, SeatRole } from "@skyteam/shared";

/** A seat is the durable link between a room and a player. Crucially it is NOT
 *  a socket: a socket can drop and a fresh one re-attach to the same seat —
 *  that is the whole reconnection mechanism. */
export interface Seat {
  playerId: PlayerId;
  role: SeatRole;
  ready: boolean;
  connected: boolean;
  /** An NPC seat: always connected and ready. */
  bot?: BotLevel;
  /** The name the player chose (empty or absent = none). Lobby-only to change. */
  name?: string;
  /** The account the player was signed in with when they last joined (absent:
   *  a guest). Their games link to it; its username is the seat's name until
   *  they choose one. */
  accountId?: string;
  username?: string;
}

/** The authoritative room record. Persisted to Redis on every change. */
export interface Room {
  id: string;
  inviteCode: string;
  hostPlayerId: PlayerId;
  status: RoomStatus;
  seats: Seat[];
  /** Which crew the host flies (the guest flies the other). */
  hostCrew: Crew;
  observers: PlayerId[];
  /** Airport + modules for the next game; the host edits it in the lobby. */
  setup: GameSetup;
  /** Monotonic game-command counter (also used by clients to detect gaps). */
  version: number;
  game: GameState | null;
  /** Shown in the lobby, e.g. who ended the last game. Cleared on the next start. */
  notice?: string | null;
  /** The lobby's flight log, oldest first, capped at MAX_CHAT_HISTORY. */
  chat: ChatMessage[];
  /** Between rounds: the next dice wait for both crews' Ready (see openDebrief). */
  debrief?: Debrief | null;
  /** The game in progress, as its log so far (see gameLog.ts). Written and
   *  cleared when the game ends or is left. */
  gameLog?: { id: string; startedAt: number; setup: GameSetup; internTokens: DieValue[]; moves: string; seed?: string | null; seededFrom?: string | null } | null;
  /** The game's secret seed and how far each of its dice streams has drawn
   *  (seededRand.ts). Never sent to a client. Absent for a game an older build began. */
  seedState?: SeedState | null;
  /** Flying an earlier game's dice: every game here uses its seed, and is
   *  logged as seeded from it. The setup stays the original's. */
  sameDice?: { gameId: string; seed: string } | null;
  /** The game that ended last (won or lost) and was logged — its replay's id. */
  lastGameId?: string | null;
  updatedAt: number;
}
