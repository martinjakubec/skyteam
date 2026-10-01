import type { PlacementTarget, PlayerId } from "../protocol";
import type { AbilityId } from "./abilities";
import {
  BRAKE_VALUES,
  CONCENTRATION_SLOTS,
  FLAPS_COUNT,
  ICE_BRAKE_VALUES,
  INTERN_TOKEN_COUNT,
  KEROSENE_START,
  LANDING_GEAR_COUNT,
  RADIO_COPILOT_SLOTS,
  type Crew,
  type DieValue,
  type ModuleId,
  type Scenario,
} from "./scenario";

/**
 * Authoritative SkyTeam game state (base game — the YUL scenario by default).
 *
 * This is a faithful model of the physical Control Panel: the two crew, their
 * dice (rolled behind screens — hidden from the other player until placed), and
 * every track/module on the board. The reducer is a pure function of
 * `(state, command)`; the only randomness (dice) is threaded in via commands by
 * the server, never generated here.
 */

export type Phase = "rolling" | "placement" | "won" | "lost";

/** A single die. `value`/`hidden` are redacted for the opposing player's
 *  unplaced dice before the state is sent over the wire (see redactGameStateFor). */
export interface Die {
  id: number;
  value?: DieValue;
  placed: boolean;
  /** True when this die's value has been hidden from the recipient. */
  hidden?: boolean;
}

/** The Axis module: the two dice played this round + the persistent tilt offset.
 *  offset > 0 is tilted toward the Pilot, < 0 toward the Co-Pilot, 0 = level. */
export interface AxisState {
  pilot: DieValue | null;
  copilot: DieValue | null;
  offset: number;
}

/** The Engines module: the two dice played this round. */
export interface EngineState {
  pilot: DieValue | null;
  copilot: DieValue | null;
}

export interface GameState {
  scenario: Scenario;
  pilotId: PlayerId;
  copilotId: PlayerId;

  round: number; // 1..scenario.rounds
  phase: Phase;
  turn: Crew; // whose turn it is to place a die
  placedThisRound: number; // 0..8

  /** Dice rolled this round, per crew. */
  dice: { pilot: Die[]; copilot: Die[] };

  axis: AxisState;
  engines: EngineState;
  /** Sum of the engine dice last time both were placed (for display + the
   *  final-round brake comparison). null until engines resolve in a round. */
  lastSpeed: number | null;

  // --- Approach Track ---
  position: number; // current index on scenario.approachTrack
  airplanes: number[]; // airplane-token count per approach space

  // --- Altitude Track ---
  altitudeFeet: number;

  // --- Speed Gauge (Aerodynamics markers, stored as integer thresholds) ---
  aeroBlue: number;
  aeroOrange: number;

  // --- Persistent module switches (survive across rounds) ---
  gearGreen: boolean[]; // length LANDING_GEAR_COUNT
  flapsGreen: boolean[]; // length FLAPS_COUNT
  brakesDeployed: number; // 0..3 — how far the red Brake marker has advanced

  // --- Per-round space occupancy (reset every round when dice are taken back) ---
  gearSlots: (DieValue | null)[]; // value placed this round (kept visible until reset)
  flapSlots: (DieValue | null)[];
  brakeSlots: boolean[];
  radioPilot: DieValue | null; // the value placed on the Pilot's Radio space
  radioCopilot: (DieValue | null)[]; // per Co-Pilot Radio space; length RADIO_COPILOT_SLOTS
  // The die placed on each Concentration space this round (value + crew, for the
  // seated-die colour). Kept visible until the round resets, like gear/flap slots.
  concentrationSlots: ({ value: DieValue; crew: Crew } | null)[]; // length CONCENTRATION_SLOTS

  // --- Kerosene module (only used when scenario.modules includes "kerosene") ---
  kerosene: number; // KEROSENE_START..0 — 0 means the tank ran dry (loss)
  keroseneSlot: { value: DieValue; crew: Crew } | null; // this round's die, either crew

  // --- Ice Brakes module (replaces the Brakes; reuses brakesDeployed, 0..4) ---
  // This round's dice per step: the Pilot's top space and the either-crew bottom
  // space. Both need the step's value for the marker to pass it.
  iceBrakeSlots: { top: DieValue | null; bottom: { value: DieValue; crew: Crew } | null }[];

  // --- Intern module (empty / unused unless scenario.modules includes "intern") ---
  internTokens: (DieValue | null)[]; // face-up tokens left to right; null = trained
  internSlots: Record<Crew, DieValue | null>; // each crew's training die this round
  // A crew has just trained and must place this token before anything else happens.
  internHeld: { crew: Crew; value: DieValue } | null;
  internPlaced: string[]; // placementKey()s of spaces filled by Intern tokens this round

  coffee: number; // 0..MAX_COFFEE
  rerollTokens: number;
  // A joint reroll is in flight: the active player has rerolled and we are now
  // waiting on this crew to reroll (or decline). null = no reroll pending. While
  // set, every other command is rejected — this is the no-race lock.
  pendingReroll: Crew | null;

  outcome: { result: "won" } | { result: "lost"; reason: string } | null;
  log: string[];
}

/** The Pilot leads odd rounds, the Co-Pilot even rounds (the Altitude arrow). */
export function firstPlayerForRound(round: number): Crew {
  return round % 2 === 1 ? "pilot" : "copilot";
}

/** Index of the airport space on a scenario's Approach Track. */
export function airportIndex(scenario: Scenario): number {
  const i = scenario.approachTrack.findIndex((s) => s.airport);
  return i === -1 ? scenario.approachTrack.length - 1 : i;
}

/**
 * Build the initial state. Dice are left empty and `phase` is "rolling": the
 * server populates the first round's dice with a `roll` command immediately
 * after (entropy lives on the server, not in this pure module).
 */
export function createInitialGameState(
  scenario: Scenario,
  pilotId: PlayerId,
  copilotId: PlayerId,
  /** Server-supplied randomness for setup: the Intern tokens' shuffled order
   *  (defaults to 1..6 in order — deterministic, for tests). */
  setup: { internTokens?: DieValue[] } = {},
): GameState {
  const internOn = scenario.modules?.includes("intern") ?? false;
  return {
    scenario,
    pilotId,
    copilotId,
    round: 1,
    phase: "rolling",
    turn: firstPlayerForRound(1),
    placedThisRound: 0,
    dice: { pilot: [], copilot: [] },
    axis: { pilot: null, copilot: null, offset: 0 },
    engines: { pilot: null, copilot: null },
    lastSpeed: null,
    position: 0,
    airplanes: scenario.approachTrack.map((s) => s.traffic),
    altitudeFeet: scenario.startAltitudeFeet,
    aeroBlue: scenario.aeroBlueStart,
    aeroOrange: scenario.aeroOrangeStart,
    gearGreen: Array(LANDING_GEAR_COUNT).fill(false),
    flapsGreen: Array(FLAPS_COUNT).fill(false),
    brakesDeployed: 0,
    gearSlots: Array(LANDING_GEAR_COUNT).fill(null),
    flapSlots: Array(FLAPS_COUNT).fill(null),
    brakeSlots: Array(BRAKE_VALUES.length).fill(false),
    radioPilot: null,
    radioCopilot: Array(RADIO_COPILOT_SLOTS).fill(null),
    concentrationSlots: Array(CONCENTRATION_SLOTS).fill(null),
    kerosene: KEROSENE_START,
    keroseneSlot: null,
    iceBrakeSlots: emptyIceBrakeSlots(),
    internTokens: internOn
      ? (setup.internTokens ?? (Array.from({ length: INTERN_TOKEN_COUNT }, (_, i) => i + 1) as DieValue[]))
      : [],
    internSlots: { pilot: null, copilot: null },
    internHeld: null,
    internPlaced: [],
    coffee: 0,
    rerollTokens: 0,
    pendingReroll: null,
    outcome: null,
    log: [`Flight to ${scenario.name} — cleared for approach.`],
  };
}

/** One empty `{ top, bottom }` per Ice Brakes step. */
export function emptyIceBrakeSlots(): GameState["iceBrakeSlots"] {
  return ICE_BRAKE_VALUES.map(() => ({ top: null, bottom: null }));
}

/**
 * Stable key for one board space, as filled by `crew`. Axis, Engine and Radio
 * exist once per crew, so the crew is part of their key; every other space is
 * unique on the board. Marks spaces filled by Intern tokens (`internPlaced`).
 */
export function placementKey(crew: Crew, target: PlacementTarget): string {
  const perCrew = target.kind === "axis" || target.kind === "engine" || target.kind === "radio";
  return `${perCrew ? `${crew}:` : ""}${JSON.stringify(target)}`;
}

/** Index of the Intern token `crew` would take next (Pilot: leftmost, Co-Pilot:
 *  rightmost remaining), or -1 when all are trained. */
export function nextInternToken(state: GameState, crew: Crew): number {
  const t = state.internTokens;
  if (crew === "pilot") return t.findIndex((v) => v !== null);
  for (let i = t.length - 1; i >= 0; i--) if (t[i] !== null) return i;
  return -1;
}

/** Whether a Special Ability card is in play for this game. */
export function hasAbility(state: GameState, id: AbilityId): boolean {
  return state.scenario.abilities?.includes(id) ?? false;
}

/** Whether an advanced module is switched on for this game. */
export function hasModule(state: GameState, id: ModuleId): boolean {
  return state.scenario.modules?.includes(id) ?? false;
}

/** Which crew a player is, or null if they are not seated in this game. */
export function crewOf(state: GameState, playerId: PlayerId): Crew | null {
  if (playerId === state.pilotId) return "pilot";
  if (playerId === state.copilotId) return "copilot";
  return null;
}

/** Total airplane tokens still on the Approach Track. */
export function airplanesRemaining(state: GameState): number {
  return state.airplanes.reduce((a, b) => a + b, 0);
}

/**
 * Produce a copy of the state safe to send to `viewerId`: the *other* crew's
 * unplaced dice have their values hidden. (Placed dice are public — they're on
 * the board.) Observers see both crews' hidden dice redacted.
 */
export function redactGameStateFor(state: GameState, viewerId: PlayerId): GameState {
  const viewer = crewOf(state, viewerId);
  const hide = (dice: Die[], crew: Crew): Die[] =>
    dice.map((d) =>
      d.placed || crew === viewer ? d : { id: d.id, placed: false, hidden: true },
    );
  return {
    ...state,
    dice: {
      pilot: hide(state.dice.pilot, "pilot"),
      copilot: hide(state.dice.copilot, "copilot"),
    },
  };
}
