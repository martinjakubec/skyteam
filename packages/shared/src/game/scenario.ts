/**
 * Scenario / board configuration for SkyTeam.
 *
 * Everything in this file is *data*: the geometry of a particular airport plus
 * the fixed starting values from the rulebook. Keeping it separate from the
 * reducer means a new airport is a new `Scenario` object — the rules engine
 * doesn't change.
 *
 * ⚠ CONFIRM AGAINST PHYSICAL BOARD: the Approach Track's per-space traffic is
 * printed on the slide-in strip, not in the rulebook text, and is still a
 * placeholder (marked below). The Altitude Track's reroll rounds and the Axis
 * spin threshold have been confirmed.
 */

import type { AbilityId } from "./abilities";

/** A die always shows 1..6. */
export type DieValue = 1 | 2 | 3 | 4 | 5 | 6;

/** The two crew roles. Pilot plays the blue spaces, Co-Pilot the orange ones. */
export type Crew = "pilot" | "copilot";

/**
 * Module identifiers (advanced "Flight Log" play). The base game enables none of
 * these; they are listed here so `Scenario.modules` is typed and the reducer's
 * hook points have a stable vocabulary to dispatch on when they're built.
 */
export const MODULE_IDS = [
  "kerosene",
  "keroseneLeak",
  "intern",
  "wind",
  "iceBrakes",
  "realTime",
  "trafficDie",
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** Display names for the lobby's module picker. */
export const MODULE_LABELS: Record<ModuleId, string> = {
  kerosene: "Kerosene",
  keroseneLeak: "Kerosene Leak",
  intern: "Intern",
  wind: "Wind",
  iceBrakes: "Ice Brakes",
  realTime: "Real Time",
  trafficDie: "Traffic Die",
};

/**
 * Modules the reducer actually implements. The lobby only offers these and the
 * server rejects any other selection; a module joins this list when its rules
 * land in the reducer.
 */
export const IMPLEMENTED_MODULES: readonly ModuleId[] = ["kerosene", "keroseneLeak", "iceBrakes", "intern", "wind", "realTime"];

/**
 * Modules that can't be played together — at most one per group. Kerosene Leak
 * is a variant of the Kerosene track (same track, different burn rule), so a
 * game uses one or the other.
 */
export const EXCLUSIVE_MODULE_GROUPS: readonly (readonly ModuleId[])[] = [["kerosene", "keroseneLeak"]];

/** The modules that can't be combined with `id` (empty if none). */
export function conflictingModules(id: ModuleId): ModuleId[] {
  return EXCLUSIVE_MODULE_GROUPS.filter((g) => g.includes(id)).flatMap((g) => g.filter((m) => m !== id));
}

/**
 * Intern module: tokens dealt face-up in a random row on the Intern board. Each
 * crew trains from its own end (Pilot left, Co-Pilot right); any left at
 * landing loses the game.
 */
export const INTERN_TOKEN_COUNT = 6;

/** Real-Time module: seconds the crew has to place its dice each round. */
export const REAL_TIME_SECONDS = 60;

/** Kerosene module: the marker starts here; reaching 0 (the empty space) loses. */
export const KEROSENE_START = 20;
/** Kerosene burned at the end of a round in which the Kerosene space was left empty. */
export const KEROSENE_IDLE_BURN = 6;

/**
 * Wind module: the 20 spaces of the Wind Ring, clockwise from the white space
 * at the top where the blue Airplane token starts. The value the airplane
 * points at is added to the Engine total. After each Axis phase the token turns
 * one space per pip the Axis is off-centre — to the left (anticlockwise) when
 * tilted toward the Pilot.
 */
export const WIND_RING: readonly number[] = [3, 3, 2, 2, 1, 0, -1, -2, -2, -3, -3, -3, -2, -2, -1, 0, 1, 2, 2, 3];

/** One space on the Approach Track. */
export interface ApproachSpace {
  /** Number of Airplane tokens that start on this space (the "traffic icons"). */
  traffic: number;
  /** The airport sits on exactly one space — the last one. */
  airport?: boolean;
  /**
   * Turns (an Approach Track effect printed on the scenario's board): the Axis
   * positions permitted when the plane advances off this space — from it, or
   * through it on a 2-space advance. Any other tilt loses. Undefined = no turn.
   * Positions as `axis.offset`: + toward the Pilot (banking left), − toward
   * the Co-Pilot (banking right).
   */
  axisAllowed?: number[];
}

export interface Scenario {
  /** Human-readable airport name, e.g. "YUL Montréal-Trudeau". */
  name: string;

  /**
   * The Approach Track, index 0 = the plane's starting Current Position.
   * The plane advances toward higher indices; the airport is the final space.
   *
   * ⚠ CONFIRM AGAINST PHYSICAL BOARD: exact length and per-space traffic.
   */
  approachTrack: ApproachSpace[];

  /** Number of rounds = spaces on the Altitude Track. Base game: 7. */
  rounds: number;

  /** Starting altitude in feet, shown in the Current Altitude screen. */
  startAltitudeFeet: number;
  /** Feet lost per round (one Altitude Track space). */
  feetPerRound: number;

  /**
   * 1-based rounds at the start of which a Reroll token is granted (the rounds
   * whose Altitude space carries a Reroll icon). Round 1 (6,000 ft) always has
   * one per the rulebook; the others depend on the scenario's difficulty
   * (YUL: round 4).
   */
  rerollRounds: number[];

  /**
   * The Axis goes from -axisSpinAt .. +axisSpinAt. Reaching or passing
   * ±axisSpinAt means the plane spins (instant loss). 0 is horizontal. Always
   * 3 on the physical disc; kept as data for completeness.
   */
  axisSpinAt: number;

  /** Speed Gauge: the blue (lower) Aerodynamics marker's starting threshold. */
  aeroBlueStart: number;
  /** Speed Gauge: the orange (upper) Aerodynamics marker's starting threshold. */
  aeroOrangeStart: number;

  /** Advanced modules in play. Base game: empty. Reserved for "Flight Log". */
  modules?: ModuleId[];
  /** How many Special Ability cards this scenario lets the crew choose (the
   *  Flight Log star). Unset = DEFAULT_MAX_ABILITIES. */
  maxAbilities?: number;
  /** The Special Abilities in play (copied from the lobby setup). */
  abilities?: AbilityId[];
}

/**
 * Speed-gauge semantics (see the ENGINES rules): the markers sit *between*
 * integers, so a speed is never exactly equal to a marker. We store the integer
 * to the marker's left as its "threshold":
 *   speed <= blueThreshold              -> advance 0
 *   blueThreshold < speed <= orange     -> advance 1
 *   speed > orangeThreshold             -> advance 2
 */
export const AERO_BLUE_START = 4; // marker between 4 and 5
export const AERO_ORANGE_START = 8; // marker between 8 and 9

/** Each deployed Landing Gear pushes the blue marker forward one step. */
export const LANDING_GEAR_COUNT = 3;
/** Each deployed Flap pushes the orange marker forward one step. */
export const FLAPS_COUNT = 4;

/** Number constraints, by deploy slot, for the value-restricted modules. */
export const LANDING_GEAR_VALUES: DieValue[][] = [
  [1, 2],
  [3, 4],
  [5, 6],
];
/** Flaps must be deployed in order, top to bottom. */
export const FLAPS_VALUES: DieValue[][] = [
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
];
/** Brakes must be deployed in order: a 2, then a 4, then a 6. */
export const BRAKE_VALUES: DieValue[] = [2, 4, 6];
/**
 * Ice Brakes module (replaces the Brakes): steps 2 → 3 → 4 → 5, deployed in
 * order. Each step has a Pilot-only top space and an either-crew bottom space;
 * both must get the step's value in the same round to advance the marker.
 */
export const ICE_BRAKE_VALUES: DieValue[] = [2, 3, 4, 5];

/** Placement targets that have a fixed count of slots. */
export const RADIO_PILOT_SLOTS = 1;
export const RADIO_COPILOT_SLOTS = 2;
export const CONCENTRATION_SLOTS = 2;
export const MAX_COFFEE = 3;
export const DICE_PER_PLAYER = 4;

/**
 * The default base-game scenario.
 *
 * ⚠ The approach-track traffic distribution below is a placeholder consistent
 * with the 12-token supply; replace with the real YUL values once read off the
 * board. The engine treats it as pure data.
 */
export const YUL_MONTREAL: Scenario = {
  name: "YUL Montréal-Trudeau",
  approachTrack: [
    { traffic: 0 }, // 0: starting Current Position
    { traffic: 1 }, // 1
    { traffic: 2 }, // 2
    { traffic: 1 }, // 3
    { traffic: 2 }, // 4
    { traffic: 1 }, // 5
    { traffic: 1 }, // 6
    { traffic: 0, airport: true }, // 7: airport
  ],
  rounds: 7,
  startAltitudeFeet: 6000,
  feetPerRound: 1000,
  rerollRounds: [1, 4], // confirmed: round 1 (rulebook) and round 4 (YUL's difficulty)
  // The plane may sit at most 2 pips off-centre; reaching the 3rd pip (±3) spins out.
  axisSpinAt: 3,
  aeroBlueStart: AERO_BLUE_START,
  aeroOrangeStart: AERO_ORANGE_START,
  maxAbilities: 0, // the green YUL card has no Special Abilities
};

/**
 * TEMPORARY — a YUL board with turns, to try the Turns effect from the lobby
 * until real scenario boards land. Remove with its lobby entry and the
 * "TEMPORARY" rule test once a scenario with turns is playable.
 */
export const YUL_TURNS_TEST: Scenario = {
  ...YUL_MONTREAL,
  name: "YUL Montréal — Turns test",
  approachTrack: [
    { traffic: 0 }, // 0: start
    { traffic: 1, axisAllowed: [1, 2] }, // 1: left turn
    { traffic: 2, axisAllowed: [0, 1] }, // 2: easing out of the left turn
    { traffic: 1 }, // 3
    { traffic: 2, axisAllowed: [-1, -2] }, // 4: right turn
    { traffic: 1, axisAllowed: [-1, 0, 1] }, // 5: gentle
    { traffic: 1 }, // 6
    { traffic: 0, airport: true }, // 7: airport
  ],
};

export const DEFAULT_SCENARIO = YUL_MONTREAL;

/** Every playable airport, keyed by the id a room's setup refers to. */
export const SCENARIOS = {
  YUL: YUL_MONTREAL,
  YUL_TURNS: YUL_TURNS_TEST, // TEMPORARY (see YUL_TURNS_TEST)
} as const satisfies Record<string, Scenario>;
export type ScenarioId = keyof typeof SCENARIOS;
export const SCENARIO_IDS = Object.keys(SCENARIOS) as [ScenarioId, ...ScenarioId[]];

/** What the host picks in the lobby: the airport, advanced modules and Special Abilities. */
export interface GameSetup {
  scenarioId: ScenarioId;
  modules: ModuleId[];
  abilities: AbilityId[];
}

export const DEFAULT_SETUP: GameSetup = { scenarioId: "YUL", modules: [], abilities: [] };

/** The concrete Scenario a game is created from: the airport's board data with
 *  the chosen modules and Special Abilities switched on. */
export function scenarioForSetup(setup: GameSetup): Scenario {
  return { ...SCENARIOS[setup.scenarioId], modules: [...setup.modules], abilities: [...(setup.abilities ?? [])] };
}
