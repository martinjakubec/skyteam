import type { GameState } from "../game/state";
import { EVAL_WEIGHTS } from "./evaluate";
import { POLICY_PARAMS } from "./rollout";

/** A card's overrides of the bot's defaults (only the keys that differ). */
export interface BotProfile {
  policy?: Partial<typeof POLICY_PARAMS>;
  eval?: Partial<typeof EVAL_WEIGHTS>;
}

/**
 * Per-card tuning, keyed by `Scenario.cardId`. A card with no entry — or a
 * board with no cardId (old rooms, hand-built boards) — plays the defaults.
 * Entries come from `CARD=<id> npm run tune` and are kept only once
 * bench-cards at 600 ms confirms them.
 */
export const BOT_PROFILES: Record<string, BotProfile> = {};

/** The rollout policy's settings for this game: the defaults, with the card's overrides. */
export function policyFor(s: GameState): typeof POLICY_PARAMS {
  const p = s.scenario.cardId ? BOT_PROFILES[s.scenario.cardId]?.policy : undefined;
  return p ? { ...POLICY_PARAMS, ...p } : POLICY_PARAMS;
}

/** The evaluator's weights for this game: the defaults, with the card's overrides. */
export function weightsFor(s: GameState): typeof EVAL_WEIGHTS {
  const w = s.scenario.cardId ? BOT_PROFILES[s.scenario.cardId]?.eval : undefined;
  return w ? { ...EVAL_WEIGHTS, ...w } : EVAL_WEIGHTS;
}
