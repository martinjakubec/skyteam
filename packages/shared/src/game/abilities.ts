import type { DieValue } from "./scenario";

/**
 * Special Ability cards. The host chooses them in the lobby, up to the
 * scenario's limit (`Scenario.maxAbilities`, default DEFAULT_MAX_ABILITIES).
 */
export const ABILITY_IDS = [
  "workingTogether",
  "synchronisation",
  "mastery",
  "control",
  "anticipation",
  "adaptation",
] as const;
export type AbilityId = (typeof ABILITY_IDS)[number];

export const ABILITY_LABELS: Record<AbilityId, string> = {
  workingTogether: "Working Together",
  synchronisation: "Synchronisation",
  mastery: "Mastery",
  control: "Control",
  anticipation: "Anticipation",
  adaptation: "Adaptation",
};

/** Card text, shown as tooltips. */
export const ABILITY_TEXT: Record<AbilityId, string> = {
  workingTogether:
    "Once per round, the active player puts a die on this card; the other player must too. Swap the two values and take the dice back.",
  synchronisation:
    "Once at least one die is on Landing Gear and one on Flaps, roll the Traffic die. The Co-Pilot places it on any empty space, regardless of colour.",
  mastery: "Two Engine dice of the same value: gain a Reroll token (if one is available).",
  control: "Two Axis dice of the same value: gain a Coffee token.",
  anticipation: "Each round, before placing their first die, the First Player may reroll one of their dice.",
  adaptation: "Once per game, each player may turn one unplaced die to its opposite face.",
};

/** The Traffic die (used by Synchronisation): faces 2, 3, 3, 4, 4, 5. */
export const TRAFFIC_DIE_FACES: readonly DieValue[] = [2, 3, 3, 4, 4, 5];

/** Cap on chosen abilities when a scenario doesn't state its own (YUL for now). */
export const DEFAULT_MAX_ABILITIES = 2;
