/**
 * The rulebook's scenario cards, grouped by difficulty colour.
 *
 * A template records what each card prescribes: its airport, difficulty, the
 * modules in play and how many Special Abilities (the ★ badge) the crew picks.
 * The board itself — approach-track traffic, turns, the Traffic die, the number
 * of rounds and the reroll rounds — is printed on the physical cards and is
 * filled in per airport as it's read off; until then `board` is null and the
 * scenario isn't playable.
 *
 * The same airport appears at several difficulties (e.g. green and yellow
 * Heathrow) with different boards, so ids are `<difficulty>-<IATA code>`.
 */

import { YUL_MONTREAL, type ModuleId, type Scenario } from "./scenario";

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
  /** Board data, or null while it hasn't been entered yet. */
  board: Scenario | null;
}

export const SCENARIO_TEMPLATES: readonly ScenarioTemplate[] = [
  // Green: Routine Landing ---------------------------------------------------
  { id: "green-YUL", difficulty: "green", code: "YUL", airport: "Montréal-Trudeau", city: "Montréal", modules: [], abilityCount: 0,
    note: "First flight: clear sunrise over the St. Lawrence.", board: YUL_MONTREAL },
  { id: "green-LHR", difficulty: "green", code: "LHR", airport: "Heathrow", city: "London", modules: [], abilityCount: 0,
    note: "Night approach over the Thames; traffic at the end of the approach.", board: null },
  { id: "green-HND", difficulty: "green", code: "HND", airport: "Haneda", city: "Tokyo", modules: [], abilityCount: 0,
    note: "Wide left turn over Tokyo Bay to line up with the runway.", board: null },
  { id: "green-OSL", difficulty: "green", code: "OSL", airport: "Gardermoen", city: "Oslo", modules: ["kerosene"], abilityCount: 0,
    note: "Keep an eye on the kerosene.", board: null },
  { id: "green-ATL", difficulty: "green", code: "ATL", airport: "Hartsfield-Jackson", city: "Atlanta", modules: ["intern"], abilityCount: 0,
    note: "A sky packed with traffic and a nervous Intern to train.", board: null },
  { id: "green-PRG", difficulty: "green", code: "PRG", airport: "Václav Havel", city: "Prague", modules: ["kerosene"], abilityCount: 2,
    note: "First flight with Special Abilities.", board: null },

  // Yellow: Exceptional Conditions -------------------------------------------
  { id: "yellow-LHR", difficulty: "yellow", code: "LHR", airport: "Heathrow", city: "London", modules: ["intern"], abilityCount: 0,
    note: "Fog has filled the sky with holding planes; traffic from the start.", board: null },
  { id: "yellow-TGU", difficulty: "yellow", code: "TGU", airport: "Toncontín", city: "Tegucigalpa", modules: ["kerosene"], abilityCount: 2,
    note: "Rapid descent into a bowl of mountains and a tight final turn.", board: null },
  { id: "yellow-GIG", difficulty: "yellow", code: "GIG", airport: "Galeão", city: "Rio de Janeiro", modules: ["wind"], abilityCount: 1,
    note: "Silent tower and a strong tail wind; wide turn, control the speed.", board: null },
  { id: "yellow-KEF", difficulty: "yellow", code: "KEF", airport: "Keflavík", city: "Reykjavík", modules: ["iceBrakes"], abilityCount: 1,
    note: "Runway covered in fresh snow.", board: null },
  { id: "yellow-PRG", difficulty: "yellow", code: "PRG", airport: "Václav Havel", city: "Prague", modules: ["keroseneLeak"], abilityCount: 2,
    note: "A fuel leak on a clear day; manage your speed.", board: null },
  { id: "yellow-KUL", difficulty: "yellow", code: "KUL", airport: "Kuala Lumpur", city: "Kuala Lumpur", modules: ["kerosene"], abilityCount: 1,
    note: "Stay in line between electrical storms.", board: null },
  { id: "yellow-ATL", difficulty: "yellow", code: "ATL", airport: "Hartsfield-Jackson", city: "Atlanta", modules: ["keroseneLeak"], abilityCount: 1,
    note: "Thanksgiving traffic and a fuel leak.", board: null },

  // Red: Elite Pilots Only ---------------------------------------------------
  { id: "red-PBH", difficulty: "red", code: "PBH", airport: "Paro", city: "Paro", modules: ["kerosene", "realTime"], abilityCount: 2,
    note: "A narrow Himalayan valley at over 7,000 feet.", board: null },
  { id: "red-HND", difficulty: "red", code: "HND", airport: "Haneda", city: "Tokyo", modules: ["kerosene", "intern"], abilityCount: 1,
    note: "Hanami: a reduced air corridor and packed skies.", board: null },
  { id: "red-GIG", difficulty: "red", code: "GIG", airport: "Galeão", city: "Rio de Janeiro", modules: ["wind", "keroseneLeak"], abilityCount: 2,
    note: "Cyclone winds and a narrow air corridor.", board: null },
  { id: "red-OSL", difficulty: "red", code: "OSL", airport: "Gardermoen", city: "Oslo", modules: ["keroseneLeak", "iceBrakes"], abilityCount: 2,
    note: "A frozen runway and low kerosene.", board: null },
  { id: "red-TGU", difficulty: "red", code: "TGU", airport: "Toncontín", city: "Tegucigalpa", modules: ["kerosene", "wind"], abilityCount: 2,
    note: "Drop down to the left between the mountains.", board: null },

  // Black: Heroic Landing ----------------------------------------------------
  { id: "black-KEF", difficulty: "black", code: "KEF", airport: "Keflavík", city: "Reykjavík", modules: ["wind", "iceBrakes"], abilityCount: 2,
    note: "A blizzard; the runway lights barely visible.", board: null },
  { id: "black-KUL", difficulty: "black", code: "KUL", airport: "Kuala Lumpur", city: "Kuala Lumpur", modules: ["kerosene", "realTime"], abilityCount: 2,
    note: "Lightning all around, and time is against you.", board: null },
  { id: "black-PBH", difficulty: "black", code: "PBH", airport: "Paro", city: "Paro", modules: ["kerosene", "realTime"], abilityCount: 2,
    note: "The most dangerous airport in the world, in clear weather.", board: null },
];
