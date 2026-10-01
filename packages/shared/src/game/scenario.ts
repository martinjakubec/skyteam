/**
 * Scenario / board configuration for SkyTeam.
 *
 * Everything in this file is *data*: the geometry of a particular airport plus
 * the fixed starting values from the rulebook. Keeping it separate from the
 * reducer means a new airport is a new `Scenario` object — the rules engine
 * doesn't change.
 *
 * ⚠ CONFIRM AGAINST PHYSICAL BOARD: a few numbers are printed on the physical
 * components (the slide-in Approach Track strip, the Altitude Track, the Axis
 * disc) and are NOT written out in the rulebook text. They are marked below.
 * The defaults are reasonable but should be verified against the real YUL board.
 */

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
  "turns",
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

/** Display names for the lobby's module picker. */
export const MODULE_LABELS: Record<ModuleId, string> = {
  kerosene: "Kerosene",
  keroseneLeak: "Kerosene Leak",
  intern: "Intern",
  wind: "Winds",
  iceBrakes: "Ice Brakes",
  realTime: "Real Time",
  trafficDie: "Traffic Die",
  turns: "Turns",
};

/**
 * Modules the reducer actually implements. The lobby only offers these and the
 * server rejects any other selection; a module joins this list when its rules
 * land in the reducer.
 */
export const IMPLEMENTED_MODULES: readonly ModuleId[] = ["kerosene"];

/** Kerosene module: the marker starts here; reaching 0 (the empty space) loses. */
export const KEROSENE_START = 20;
/** Kerosene burned at the end of a round in which the Kerosene space was left empty. */
export const KEROSENE_IDLE_BURN = 6;

/** One space on the Approach Track. */
export interface ApproachSpace {
  /** Number of Airplane tokens that start on this space (the "traffic icons"). */
  traffic: number;
  /** The airport sits on exactly one space — the last one. */
  airport?: boolean;
  /**
   * Advanced "Turns" effect: axis offsets permitted when advancing onto/through
   * this space. Undefined means no restriction (base game). Reserved for later.
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
   * one per the rulebook.
   *
   * ⚠ CONFIRM AGAINST PHYSICAL BOARD: which other space carries the 2nd token.
   */
  rerollRounds: number[];

  /**
   * The Axis goes from -axisSpinAt .. +axisSpinAt. Reaching or passing
   * ±axisSpinAt means the plane spins (instant loss). 0 is horizontal.
   *
   * ⚠ CONFIRM AGAINST PHYSICAL BOARD: the disc's spin threshold.
   */
  axisSpinAt: number;

  /** Speed Gauge: the blue (lower) Aerodynamics marker's starting threshold. */
  aeroBlueStart: number;
  /** Speed Gauge: the orange (upper) Aerodynamics marker's starting threshold. */
  aeroOrangeStart: number;

  /** Advanced modules in play. Base game: empty. Reserved for "Flight Log". */
  modules?: ModuleId[];
  /** Number of Special Ability cards dealt. Base game: 0. Reserved. */
  specialAbilities?: number;
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
  rerollRounds: [1, 4], // round 1 confirmed by rulebook; 2nd is a placeholder
  // The plane may sit at most 2 pips off-centre; reaching the 3rd pip (±3) spins out.
  axisSpinAt: 3,
  aeroBlueStart: AERO_BLUE_START,
  aeroOrangeStart: AERO_ORANGE_START,
};

export const DEFAULT_SCENARIO = YUL_MONTREAL;

/** Every playable airport, keyed by the id a room's setup refers to. */
export const SCENARIOS = {
  YUL: YUL_MONTREAL,
} as const satisfies Record<string, Scenario>;
export type ScenarioId = keyof typeof SCENARIOS;
export const SCENARIO_IDS = Object.keys(SCENARIOS) as [ScenarioId, ...ScenarioId[]];

/** What the host picks in the lobby: the airport plus any advanced modules. */
export interface GameSetup {
  scenarioId: ScenarioId;
  modules: ModuleId[];
}

export const DEFAULT_SETUP: GameSetup = { scenarioId: "YUL", modules: [] };

/** The concrete Scenario a game is created from: the airport's board data with
 *  the chosen modules switched on. */
export function scenarioForSetup(setup: GameSetup): Scenario {
  return { ...SCENARIOS[setup.scenarioId], modules: [...setup.modules] };
}
