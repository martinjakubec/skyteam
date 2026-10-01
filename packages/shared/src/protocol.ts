import { z } from "zod";
import type { GameState } from "./game/state";
import { EXCLUSIVE_MODULE_GROUPS, IMPLEMENTED_MODULES, MODULE_IDS, SCENARIO_IDS, SCENARIOS, type GameSetup } from "./game/scenario";
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
export const PlacementTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("axis") }),
  z.object({ kind: z.literal("engine") }),
  z.object({ kind: z.literal("radio"), slot: z.number().int().min(0).max(1) }),
  z.object({ kind: z.literal("landingGear"), slot: z.number().int().min(0).max(2) }),
  z.object({ kind: z.literal("flaps"), slot: z.number().int().min(0).max(3) }),
  z.object({ kind: z.literal("brakes"), slot: z.number().int().min(0).max(2) }),
  z.object({ kind: z.literal("concentration"), slot: z.number().int().min(0).max(1) }),
  // Kerosene module: a single space either crew may use.
  z.object({ kind: z.literal("kerosene") }),
  // Ice Brakes module: step 0..3 (values 2..5); top = Pilot only, bottom = either crew.
  z.object({ kind: z.literal("iceBrakes"), slot: z.number().int().min(0).max(3), space: z.enum(["top", "bottom"]) }),
  // Intern module: the placing crew's own training space.
  z.object({ kind: z.literal("intern") }),
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
});
export type JoinRoomPayload = z.infer<typeof JoinRoomPayload>;

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
}

/** A full, self-contained view of a room tailored to one recipient. Sent on
 *  join, on every lobby change, and on reconnect (full resync). */
export interface RoomSnapshot {
  roomId: string;
  inviteCode: string;
  status: RoomStatus;
  hostPlayerId: PlayerId;
  seats: SeatView[];
  observerCount: number;
  /** Airport + modules the next game will be created with (host sets it in the lobby). */
  setup: GameSetup;
  /** Monotonic counter incremented on every applied game command. */
  version: number;
  game: GameState | null;
  /** Who the recipient is, so the UI knows which seat is "me". */
  you: { playerId: PlayerId; kind: ParticipantKind; role?: SeatRole };
}

/** Incremental notification that a command was applied. Includes the full game
 *  state for simplicity (deltas are an optimization for later). */
export interface GameEventMsg {
  version: number;
  command: GameCommand;
  byPlayerId: PlayerId;
  game: GameState;
}

// ---------------------------------------------------------------------------
// Socket.IO ack envelope + typed event maps
// ---------------------------------------------------------------------------

export type Ack = { ok: true } | { ok: false; error: string };

export interface ServerToClientEvents {
  "room:state": (snapshot: RoomSnapshot) => void;
  "game:event": (msg: GameEventMsg) => void;
}

export interface ClientToServerEvents {
  "room:join": (payload: JoinRoomPayload, ack: (res: Ack) => void) => void;
  "seat:ready": (payload: SetReadyPayload, ack: (res: Ack) => void) => void;
  "room:setup": (payload: SetSetupPayload, ack: (res: Ack) => void) => void;
  "game:start": (ack: (res: Ack) => void) => void;
  "game:reset": (ack: (res: Ack) => void) => void;
  "game:command": (payload: GameCommandPayload, ack: (res: Ack) => void) => void;
}

/** Per-connection state the server attaches to each socket. */
export interface SocketData {
  playerId?: PlayerId;
  roomId?: string;
}
