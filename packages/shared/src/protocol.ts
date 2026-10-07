import { z } from "zod";
import type { GameState } from "./game/state";
import { normalizeBotLevel, type BotLevel } from "./bot/levels";
import type { Crew } from "./game/scenario";
import { EXCLUSIVE_MODULE_GROUPS, IMPLEMENTED_MODULES, MODULE_IDS } from "./game/scenario";
import { SCENARIO_IDS, SCENARIOS, type GameSetup } from "./game/catalog";
import { ABILITY_IDS, DEFAULT_MAX_ABILITIES } from "./game/abilities";

// ---------------------------------------------------------------------------
// Identity & enums
// ---------------------------------------------------------------------------

/** Stable, anonymous identity for a human. Survives reconnects; can later be
 *  bound to a real account without touching the rest of the protocol. */
export type PlayerId = string;

export const SeatRole = z.enum(["host", "guest"]);
export type SeatRole = z.infer<typeof SeatRole>;

/** Players occupy seats and may act. Observers only receive broadcasts.
 *  (Spectators are not surfaced in the v1 UI but the model supports them.) */
export const ParticipantKind = z.enum(["player", "observer"]);
export type ParticipantKind = z.infer<typeof ParticipantKind>;

export const ConnectionState = z.enum(["connected", "disconnected"]);
export type ConnectionState = z.infer<typeof ConnectionState>;

export const RoomStatus = z.enum(["lobby", "ready", "in_progress", "finished", "abandoned"]);
export type RoomStatus = z.infer<typeof RoomStatus>;

// ---------------------------------------------------------------------------
// Game commands — the actions a client may send. These are *intents*: the
// server resolves dice values (it owns randomness), so e.g. a die's value is
// read from authoritative state by id, and a reroll's new values are generated
// server-side. See packages/shared/src/game/reducer.ts for the rules.
// ---------------------------------------------------------------------------

/** Where on the Control Panel a die is being placed. Per-crew/number legality
 *  is enforced by the reducer; this only bounds the slot indices. */
/** Which crew's copy of a per-crew space (Axis, Engine, Radio, Intern training).
 *  Omitted = the placer's own; only the Traffic die (Synchronisation) may name
 *  the other crew's. */
const Side = z.enum(["pilot", "copilot"]).optional();

export const PlacementTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("axis"), side: Side }),
  z.object({ kind: z.literal("engine"), side: Side }),
  z.object({ kind: z.literal("radio"), slot: z.number().int().min(0).max(1), side: Side }),
  z.object({ kind: z.literal("landingGear"), slot: z.number().int().min(0).max(2) }),
  z.object({ kind: z.literal("flaps"), slot: z.number().int().min(0).max(3) }),
  z.object({ kind: z.literal("brakes"), slot: z.number().int().min(0).max(2) }),
  z.object({ kind: z.literal("concentration"), slot: z.number().int().min(0).max(1) }),
  // Kerosene module: a single space either crew may use.
  z.object({ kind: z.literal("kerosene") }),
  // Ice Brakes module: step 0..3 (values 2..5); top = Pilot only, bottom = either crew.
  z.object({ kind: z.literal("iceBrakes"), slot: z.number().int().min(0).max(3), space: z.enum(["top", "bottom"]) }),
  // Intern module: a crew's training space (the placer's own unless `side`).
  z.object({ kind: z.literal("intern"), side: Side }),
]);
export type PlacementTarget = z.infer<typeof PlacementTarget>;

export const GameCommand = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("placeDie"),
    /** Index (0..3) of the die in the player's own hand. */
    dieId: z.number().int().min(0).max(3),
    target: PlacementTarget,
    /** Net Coffee modifier applied to the die's value (±1 per token spent). */
    coffeeDelta: z.number().int().min(-5).max(5).optional(),
  }),
  z.object({
    /** Intern module: place the token you just trained, like a die of its
     *  number (any normal space except Concentration / the Intern board; no
     *  Coffee). Your turn passes once it's placed. */
    type: z.literal("placeIntern"),
    target: PlacementTarget,
  }),
  z.object({
    /** Synchronisation (Special Ability): the Co-Pilot places the rolled Traffic
     *  die on any empty space, regardless of colour (`side` picks the crew for
     *  per-crew spaces). An extra action — it doesn't use up a turn. */
    type: z.literal("placeTraffic"),
    target: PlacementTarget,
  }),
  z.object({
    /** Adaptation (Special Ability): once per game, turn one of your unplaced
     *  dice to its opposite face. Allowed on either player's turn. */
    type: z.literal("adapt"),
    dieId: z.number().int().min(0).max(3),
  }),
  z.object({
    /** Anticipation (Special Ability): each round, before their first die, the
     *  First Player may reroll one die. The server supplies the new value. */
    type: z.literal("anticipate"),
    dieId: z.number().int().min(0).max(3),
  }),
  z.object({
    /** Working Together (Special Ability): the active player offers one of their
     *  unplaced dice (once per round); the other player must answer with one of
     *  theirs; the two values swap. */
    type: z.literal("swap"),
    dieId: z.number().int().min(0).max(3),
  }),
  z.object({
    type: z.literal("reroll"),
    /** Indices of the player's own dice to reroll. The active player initiates a
     *  joint reroll (≥1 die, spends one token); the other player is then prompted
     *  and may reroll any number, including zero (decline). */
    dieIds: z.array(z.number().int().min(0).max(3)).min(0).max(4),
  }),
]);
export type GameCommand = z.infer<typeof GameCommand>;

// ---------------------------------------------------------------------------
// Client -> Server message payloads (validated at the boundary with zod)
// ---------------------------------------------------------------------------

export const JoinRoomPayload = z.object({
  roomId: z.string().min(1),
  token: z.string().min(1),
  /** Last game version the client has applied; lets the server detect gaps. */
  lastVersion: z.number().int().nonnegative().optional(),
  /** The name the player last chose (kept in their browser). Taken as their
   *  seat's name while the room is in its lobby; ignored once a game runs. */
  name: z.string().optional(),
});
export type JoinRoomPayload = z.infer<typeof JoinRoomPayload>;

export const MAX_NAME_LENGTH = 20;

/** A player's chosen name: trimmed, inner whitespace collapsed, at most
 *  MAX_NAME_LENGTH characters. Empty means "no name". */
export const PlayerName = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, " "))
  .pipe(z.string().max(MAX_NAME_LENGTH, `A name is at most ${MAX_NAME_LENGTH} characters.`));

/** Rename yourself — lobby only. */
export const SetNamePayload = z.object({ name: PlayerName });
export type SetNamePayload = z.infer<typeof SetNamePayload>;

export const MAX_CHAT_LENGTH = 200;
/** Flight log messages a room keeps (older ones are dropped). */
export const MAX_CHAT_HISTORY = 50;

/** A flight log message: trimmed, inner whitespace collapsed, 1..MAX_CHAT_LENGTH characters. */
export const ChatText = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, "Type a message first.")
      .max(MAX_CHAT_LENGTH, `A message is at most ${MAX_CHAT_LENGTH} characters.`),
  );

/** Post to the room's flight log — seated players, in the lobby. */
export const ChatSendPayload = z.object({ text: ChatText });
export type ChatSendPayload = z.infer<typeof ChatSendPayload>;

export const SetReadyPayload = z.object({ ready: z.boolean() });
export type SetReadyPayload = z.infer<typeof SetReadyPayload>;

/** Host-only lobby setting: which airport, modules and Special Abilities the
 *  next game uses. Only implemented modules are accepted, each at most once,
 *  never two from the same exclusive group (e.g. Kerosene + Kerosene Leak);
 *  abilities are unique and capped by the scenario. */
export const SetSetupPayload = z.object({
  scenarioId: z.enum(SCENARIO_IDS),
  modules: z
    .array(z.enum(MODULE_IDS))
    .max(MODULE_IDS.length)
    .refine((m) => new Set(m).size === m.length, "Duplicate module.")
    .refine((m) => m.every((id) => IMPLEMENTED_MODULES.includes(id)), "That module is not available yet.")
    .refine(
      (m) => EXCLUSIVE_MODULE_GROUPS.every((group) => group.filter((id) => m.includes(id)).length <= 1),
      "Those modules can't be played together.",
    ),
  abilities: z
    .array(z.enum(ABILITY_IDS))
    .refine((a) => new Set(a).size === a.length, "Duplicate ability.")
    .default([]),
}).superRefine((setup, ctx) => {
  const max = SCENARIOS[setup.scenarioId].maxAbilities ?? DEFAULT_MAX_ABILITIES;
  if (setup.abilities.length > max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `This scenario allows at most ${max} Special Abilities.` });
  }
}) satisfies z.ZodType<GameSetup, z.ZodTypeDef, unknown>;
export type SetSetupPayload = z.infer<typeof SetSetupPayload>;

/** Body of a solo-room request: the seat the player flies. The bot is Aviator;
 *  older clients still send a level, and the retired ones play as Aviator. */
export const SoloRoomRequest = z.object({
  crew: z.enum(["pilot", "copilot"]),
  level: z.enum(["cadet", "navigator", "aviator"]).optional().transform(normalizeBotLevel),
});
export type SoloRoomRequest = z.infer<typeof SoloRoomRequest>;

export const GameCommandPayload = z.object({
  /** Client-generated id so retries (e.g. after a reconnect) are idempotent. */
  commandId: z.string().min(1),
  command: GameCommand,
});
export type GameCommandPayload = z.infer<typeof GameCommandPayload>;

// ---------------------------------------------------------------------------
// Server -> Client views
// ---------------------------------------------------------------------------

export interface SeatView {
  playerId: PlayerId;
  role: SeatRole;
  ready: boolean;
  connection: ConnectionState;
  /** An NPC seat (solo play): its difficulty. */
  bot?: BotLevel;
  /** The name the player chose, if any (see `crewNames` for display). */
  name?: string;
}

/** One line of the lobby's flight log. `crew` is the sender's seat (it tints
 *  the line blue for the Pilot, orange for the Co-Pilot). */
export interface ChatMessage {
  id: string;
  playerId: PlayerId;
  crew: Crew;
  text: string;
  /** When the server took it (epoch ms). */
  at: number;
}

/** A full, self-contained view of a room tailored to one recipient. Sent on
 *  join, on every lobby change, and on reconnect (full resync). */
export interface RoomSnapshot {
  roomId: string;
  inviteCode: string;
  status: RoomStatus;
  hostPlayerId: PlayerId;
  seats: SeatView[];
  /** Which crew the host flies (the guest flies the other). */
  hostCrew: Crew;
  observerCount: number;
  /** Airport + modules the next game will be created with (host sets it in the lobby). */
  setup: GameSetup;
  /** Monotonic counter incremented on every applied game command. */
  version: number;
  game: GameState | null;
  /** A lobby message about the room, e.g. "The Co-Pilot ended the game." */
  notice: string | null;
  /** The flight log so far, oldest first (at most MAX_CHAT_HISTORY). */
  chat: ChatMessage[];
  /** Who the recipient is, so the UI knows which seat is "me". */
  you: { playerId: PlayerId; kind: ParticipantKind; role?: SeatRole };
  /** The server's clock when this was sent (epoch ms), so a client can map a
   *  Real-Time deadline onto its own clock. */
  serverTime: number;
}

/** Incremental notification that a command was applied. Includes the full game
 *  state for simplicity (deltas are an optimization for later). */
export interface GameEventMsg {
  version: number;
  command: GameCommand;
  byPlayerId: PlayerId;
  game: GameState;
  /** The server's clock when this was sent (see RoomSnapshot.serverTime). */
  serverTime: number;
}

// ---------------------------------------------------------------------------
// Socket.IO ack envelope + typed event maps
// ---------------------------------------------------------------------------

/** The server can't reach its storage (Redis), so it can't save anything: it
 *  refuses every request until storage is back, and the client shows a 500 page. */
export const UNAVAILABLE = "unavailable" as const;
export type Ack = { ok: true } | { ok: false; error: string; code?: typeof UNAVAILABLE };

export interface ServerToClientEvents {
  "room:state": (snapshot: RoomSnapshot) => void;
  "game:event": (msg: GameEventMsg) => void;
  /** A new flight log line, sent to everyone in the room. */
  "chat:message": (msg: ChatMessage) => void;
}

export interface ClientToServerEvents {
  "room:join": (payload: JoinRoomPayload, ack: (res: Ack) => void) => void;
  "seat:ready": (payload: SetReadyPayload, ack: (res: Ack) => void) => void;
  "seat:name": (payload: SetNamePayload, ack: (res: Ack) => void) => void;
  "room:setup": (payload: SetSetupPayload, ack: (res: Ack) => void) => void;
  "chat:send": (payload: ChatSendPayload, ack: (res: Ack) => void) => void;
  "game:start": (ack: (res: Ack) => void) => void;
  "game:reset": (ack: (res: Ack) => void) => void;
  /** End the game for both players and return the room to its lobby. */
  "game:exit": (ack: (res: Ack) => void) => void;
  "game:command": (payload: GameCommandPayload, ack: (res: Ack) => void) => void;
}

/** Per-connection state the server attaches to each socket. */
export interface SocketData {
  playerId?: PlayerId;
  roomId?: string;
}
