/**
 * The rulebook's scenario cards, grouped by difficulty colour.
 *
 * A template records what each card prescribes: its airport, difficulty, the
 * modules in play and how many Special Abilities (the ★ badge) the crew picks.
 * The board is the card's Approach Track strip (traffic, Traffic dice, turns —
 * see APPROACH_TRACKS) plus the Altitude Track side for its difficulty
 * (REROLL_ROUNDS); everything else is the base game's.
 *
 * The same airport appears at several difficulties (e.g. green and yellow
 * Heathrow) with different boards, so ids are `<difficulty>-<IATA code>`.
 */

import type { AbilityId } from "./abilities";
import { YUL_MONTREAL, type ApproachSpace, type ModuleId, type Scenario } from "./scenario";

export type Difficulty = "green" | "yellow" | "red" | "black";

/** The four difficulty colours, easiest first, with the rulebook's names. */
export const DIFFICULTIES: readonly { id: Difficulty; label: string }[] = [
  { id: "green", label: "Routine Landing" },
  { id: "yellow", label: "Exceptional Conditions" },
  { id: "red", label: "Elite Pilots Only" },
  { id: "black", label: "Heroic Landing" },
];

export interface ScenarioTemplate {
  /** `<difficulty>-<IATA code>`, e.g. "yellow-LHR". */
  id: string;
  difficulty: Difficulty;
  /** IATA airport code, e.g. "LHR". */
  code: string;
  /** Airport name as printed on the card, e.g. "Heathrow". */
  airport: string;
  city: string;
  /** Modules the card prescribes. */
  modules: ModuleId[];
  /** Special Abilities the crew chooses (the card's ★ badge; 0 = none). */
  abilityCount: 0 | 1 | 2;
  /** One-line summary of the card's situation. */
  note: string;
  /** The playable board. */
  board: Scenario;
}

/** The cards as printed; `board` is built below from the strips. */
const CARDS: readonly Omit<ScenarioTemplate, "board">[] = [
  // Green: Routine Landing ---------------------------------------------------
  { id: "green-YUL", difficulty: "green", code: "YUL", airport: "Montréal-Trudeau", city: "Montréal", modules: [], abilityCount: 0,
    note: "First flight: clear sunrise over the St. Lawrence." },
  { id: "green-LHR", difficulty: "green", code: "LHR", airport: "Heathrow", city: "London", modules: [], abilityCount: 0,
    note: "Night approach over the Thames; traffic at the end of the approach." },
  { id: "green-HND", difficulty: "green", code: "HND", airport: "Haneda", city: "Tokyo", modules: [], abilityCount: 0,
    note: "Wide left turn over Tokyo Bay to line up with the runway." },
  { id: "green-OSL", difficulty: "green", code: "OSL", airport: "Gardermoen", city: "Oslo", modules: ["kerosene"], abilityCount: 0,
    note: "Keep an eye on the kerosene." },
  { id: "green-ATL", difficulty: "green", code: "ATL", airport: "Hartsfield-Jackson", city: "Atlanta", modules: ["intern"], abilityCount: 0,
    note: "A sky packed with traffic and a nervous Intern to train." },
  { id: "green-PRG", difficulty: "green", code: "PRG", airport: "Václav Havel", city: "Prague", modules: ["kerosene"], abilityCount: 2,
    note: "First flight with Special Abilities." },

  // Yellow: Exceptional Conditions -------------------------------------------
  { id: "yellow-LHR", difficulty: "yellow", code: "LHR", airport: "Heathrow", city: "London", modules: ["intern"], abilityCount: 0,
    note: "Fog has filled the sky with holding planes; traffic from the start." },
  { id: "yellow-TGU", difficulty: "yellow", code: "TGU", airport: "Toncontín", city: "Tegucigalpa", modules: ["kerosene"], abilityCount: 2,
    note: "Rapid descent into a bowl of mountains and a tight final turn." },
  { id: "yellow-GIG", difficulty: "yellow", code: "GIG", airport: "Galeão", city: "Rio de Janeiro", modules: ["wind"], abilityCount: 1,
    note: "Silent tower and a strong tail wind; wide turn, control the speed." },
  { id: "yellow-KEF", difficulty: "yellow", code: "KEF", airport: "Keflavík", city: "Reykjavík", modules: ["iceBrakes"], abilityCount: 1,
    note: "Runway covered in fresh snow." },
  { id: "yellow-PRG", difficulty: "yellow", code: "PRG", airport: "Václav Havel", city: "Prague", modules: ["keroseneLeak"], abilityCount: 2,
    note: "A fuel leak on a clear day; manage your speed." },
  { id: "yellow-KUL", difficulty: "yellow", code: "KUL", airport: "Kuala Lumpur", city: "Kuala Lumpur", modules: ["kerosene"], abilityCount: 1,
    note: "Stay in line between electrical storms." },
  { id: "yellow-ATL", difficulty: "yellow", code: "ATL", airport: "Hartsfield-Jackson", city: "Atlanta", modules: ["keroseneLeak"], abilityCount: 1,
    note: "Thanksgiving traffic and a fuel leak." },

  // Red: Elite Pilots Only ---------------------------------------------------
  { id: "red-PBH", difficulty: "red", code: "PBH", airport: "Paro", city: "Paro", modules: ["kerosene", "realTime"], abilityCount: 2,
    note: "A narrow Himalayan valley at over 7,000 feet." },
  { id: "red-HND", difficulty: "red", code: "HND", airport: "Haneda", city: "Tokyo", modules: ["kerosene", "intern"], abilityCount: 1,
    note: "Hanami: a reduced air corridor and packed skies." },
  { id: "red-GIG", difficulty: "red", code: "GIG", airport: "Galeão", city: "Rio de Janeiro", modules: ["wind", "keroseneLeak"], abilityCount: 2,
    note: "Cyclone winds and a narrow air corridor." },
  { id: "red-OSL", difficulty: "red", code: "OSL", airport: "Gardermoen", city: "Oslo", modules: ["keroseneLeak", "iceBrakes"], abilityCount: 2,
    note: "A frozen runway and low kerosene." },
  { id: "red-TGU", difficulty: "red", code: "TGU", airport: "Toncontín", city: "Tegucigalpa", modules: ["kerosene", "wind"], abilityCount: 2,
    note: "Drop down to the left between the mountains." },

  // Black: Heroic Landing ----------------------------------------------------
  { id: "black-KEF", difficulty: "black", code: "KEF", airport: "Keflavík", city: "Reykjavík", modules: ["wind", "iceBrakes"], abilityCount: 2,
    note: "A blizzard; the runway lights barely visible." },
  { id: "black-KUL", difficulty: "black", code: "KUL", airport: "Kuala Lumpur", city: "Kuala Lumpur", modules: ["kerosene", "realTime"], abilityCount: 2,
    note: "Lightning all around, and time is against you." },
  { id: "black-PBH", difficulty: "black", code: "PBH", airport: "Paro", city: "Paro", modules: ["kerosene", "realTime"], abilityCount: 2,
    note: "The most dangerous airport in the world, in clear weather." },
];

// Approach Tracks ------------------------------------------------------------

/** A space with `traffic` Airplane tokens; `dice` Traffic dice; a turn permitting `turn`. */
const sp = (traffic = 0, { dice, turn }: { dice?: number; turn?: number[] } = {}): ApproachSpace => ({
  traffic,
  ...(turn && { axisAllowed: turn }),
  ...(dice && { trafficDice: dice }),
});
/** The airport space (always last). */
const apt = (traffic = 0): ApproachSpace => ({ traffic, airport: true });

/**
 * Each card's Approach Track, keyed by template id, read off the physical
 * scenario strips (2026-10-02 photos). Index 0 is the start space (clouds);
 * its Traffic dice are the box beside the clouds. Turns sit on the edge a
 * space is left by, so they belong to that space; positions are + toward the
 * Pilot (left), − toward the Co-Pilot. The strips don't carry the Altitude
 * Track (rounds, reroll rounds), which is why `board` stays null for now.
 */
export const APPROACH_TRACKS: Readonly<Record<string, readonly ApproachSpace[]>> = {
  // Green
  "green-YUL": YUL_MONTREAL.approachTrack,
  "green-HND": [sp(0, { dice: 2 }), sp(1), sp(1, { turn: [1, 0] }), sp(2), sp(1, { turn: [2, 1] }), sp(0, { turn: [2, 1, 0] }), sp(2), apt(1)],
  "green-OSL": [sp(0, { dice: 2 }), sp(), sp(1), sp(0, { dice: 1 }), sp(1), sp(1), sp(1), apt()],
  "green-PRG": [sp(0, { dice: 1 }), sp(0, { turn: [1, 0] }), sp(1, { dice: 1 }), sp(1, { turn: [-1, -2] }), sp(), sp(1, { dice: 1 }), sp(1), apt(1)],
  "green-ATL": [sp(0, { dice: 4 }), sp(), sp(0, { dice: 1 }), sp(), sp(1, { dice: 1 }), sp(2, { dice: 1 }), sp(1), apt(2)],
  "green-LHR": [sp(0, { dice: 1 }), sp(1), sp(1, { dice: 1 }), sp(2), sp(2, { dice: 1 }), apt(2)],
  // Yellow
  "yellow-KUL": [sp(0, { dice: 2 }), sp(0, { turn: [-1, -2] }), sp(1), sp(1, { dice: 1, turn: [0, -1] }), sp(0, { turn: [-1, -2] }), sp(1), sp(1, { turn: [-1, -2] }), apt(1)],
  "yellow-GIG": [sp(0, { dice: 2 }), sp(), sp(2), sp(1, { dice: 1 }), sp(2, { dice: 1 }), sp(3), apt(1)],
  "yellow-PRG": [sp(), sp(), sp(1), sp(3, { dice: 1 }), sp(), sp(3, { dice: 1 }), sp(2), apt(3)],
  "yellow-ATL": [sp(0, { dice: 1 }), sp(1, { dice: 1 }), sp(0, { turn: [1, 0, -1] }), sp(2, { dice: 2 }), sp(2, { dice: 1 }), sp(1), sp(3, { turn: [-1, -2] }), apt(1)],
  "yellow-KEF": [sp(0, { dice: 2 }), sp(), sp(1, { dice: 1 }), sp(1), sp(1, { dice: 1 }), apt()],
  "yellow-TGU": [sp(0, { dice: 3 }), sp(1, { turn: [2, 1] }), sp(1, { turn: [1, 0] }), sp(1, { turn: [2, 1] }), apt(1)],
  "yellow-LHR": [sp(1, { dice: 2 }), sp(1), sp(1, { dice: 1 }), sp(2, { dice: 1 }), sp(1, { dice: 1 }), apt(2)],
  // Red
  "red-HND": [sp(1, { dice: 3 }), sp(0, { turn: [1, 0] }), sp(1), sp(1, { dice: 1, turn: [2, 1] }), sp(1, { dice: 1, turn: [1, 0] }), sp(2, { dice: 1 }), sp(1, { turn: [2, 1] }), apt(1)],
  "red-OSL": [sp(1, { dice: 3 }), sp(), sp(1, { dice: 1 }), sp(), sp(0, { dice: 1 }), sp(1), sp(0, { dice: 1 }), apt()],
  "red-GIG": [sp(0, { dice: 3 }), sp(1), sp(2, { dice: 1 }), sp(2), sp(1, { dice: 1 }), sp(1), apt(2)],
  "red-PBH": [sp(0, { dice: 3 }), sp(1), sp(1, { turn: [2, 1] }), sp(1, { dice: 1, turn: [2, 1, 0] }), sp(1, { turn: [-1, -2] }), apt(1)],
  "red-TGU": [sp(0, { dice: 3 }), sp(1, { turn: [2, 1] }), sp(1, { dice: 2, turn: [1, 0] }), sp(1, { turn: [2, 1] }), apt(2)],
  // Black
  "black-KUL": [sp(0, { dice: 3 }), sp(0, { turn: [0, -1] }), sp(1, { dice: 1 }), sp(0, { turn: [2] }), sp(1, { turn: [1, 0] }), sp(1, { dice: 1, turn: [0, -1] }), sp(1, { turn: [-1, -2] }), apt(1)],
  "black-PBH": [sp(1, { dice: 3 }), sp(), sp(1, { dice: 1, turn: [2, 1] }), sp(1, { dice: 1, turn: [2, 1] }), sp(1, { dice: 1, turn: [-2] }), apt(1)],
  "black-KEF": [sp(0, { dice: 2 }), sp(0, { turn: [2, 1, 0] }), sp(2, { dice: 1 }), sp(1, { turn: [0, -1, -2] }), sp(1, { turn: [1, 0, -1] }), apt()],
};

/** The Altitude Track's reroll rounds: its green/yellow side has Reroll icons
 *  at 6,000 and 2,000 ft, the red/black side only at 6,000 ft. */
export const REROLL_ROUNDS: Readonly<Record<Difficulty, readonly number[]>> = {
  green: [1, 5],
  yellow: [1, 5],
  red: [1],
  black: [1],
};

export const SCENARIO_TEMPLATES: readonly ScenarioTemplate[] = CARDS.map((card) => ({
  ...card,
  board:
    card.id === "green-YUL"
      ? YUL_MONTREAL
      : {
          ...YUL_MONTREAL,
          name: `${card.code} ${card.airport}`,
          approachTrack: [...APPROACH_TRACKS[card.id]],
          rerollRounds: [...REROLL_ROUNDS[card.difficulty]],
          maxAbilities: card.abilityCount,
        },
}));

// Lobby ----------------------------------------------------------------------

/** Every playable board, keyed by the id a room's setup refers to: "YUL" for
 *  the first game, then each other card by its template id. */
export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  YUL: YUL_MONTREAL,
  ...Object.fromEntries(SCENARIO_TEMPLATES.filter((t) => t.id !== "green-YUL").map((t) => [t.id, t.board])),
};
export type ScenarioId = string;
export const SCENARIO_IDS = Object.keys(SCENARIOS) as [ScenarioId, ...ScenarioId[]];

/** The card a lobby scenario id stands for. */
export function templateFor(id: ScenarioId): ScenarioTemplate | undefined {
  return SCENARIO_TEMPLATES.find((t) => t.id === (id === "YUL" ? "green-YUL" : id));
}

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
