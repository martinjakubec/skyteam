import type { GameState } from "../game/state";
import { EVAL_WEIGHTS } from "./evaluate";
import { POLICY_PARAMS } from "./rollout";
import { SEARCH_DEFAULTS } from "./search";
import { PLAN_WEIGHTS, type PlanWeights } from "./planPolicy";

/** A card's overrides of the bot's defaults (only the keys that differ). */
export interface BotProfile {
  policy?: Partial<typeof POLICY_PARAMS>;
  eval?: Partial<typeof EVAL_WEIGHTS>;
  /** Search settings: fewer candidates means more samples for each in the same time. */
  search?: { shortlist?: number; radioCandidate?: boolean };
  /** Play the card's scripted plan (planPolicy.ts) in the rollouts, with these weights over the defaults. */
  plan?: Partial<PlanWeights> | true;
}

/**
 * Per-card tuning, keyed by `Scenario.cardId`. A card with no entry — or a
 * board with no cardId (old rooms, hand-built boards) — plays the defaults.
 * Entries come from `CARD=<id> npm run tune` and are kept only once
 * bench-cards at 600 ms confirms them.
 */
export const BOT_PROFILES: Record<string, BotProfile> = {
  // green LHR (2026-10-06): 58.0% of 400 seeds at 600 ms (compiled), was 41.3%.
  // The plan's move is searched and breaks near-ties; a short shortlist buys samples.
  "green-LHR": {
    plan: { engineMid: 40, searchBias: 400 },
    search: { shortlist: 3, radioCandidate: true },
    policy: { switchCredit: 200, clearPlannedAny: true },
  },
  // green HND (2026-10-06): 26.8% of 400 seeds at 600 ms (compiled), was 13.5% — below
  // the 50% fallback after 4 attempts. Turns: rollouts pick Axis and Engine dice as a pair.
  "green-HND": {
    plan: { engineMid: 40, searchBias: 400 },
    search: { shortlist: 3, radioCandidate: true },
    policy: { switchCredit: 200, clearPlannedAny: true, jointPicks: true },
  },
  // green OSL (2026-10-06): 49.0% of 400 seeds at 600 ms (compiled), was 34.3% —
  // just under the 50% fallback after 4 attempts. The plan feeds the Kerosene.
  "green-OSL": {
    plan: { engineMid: 40, searchBias: 400 },
    search: { radioCandidate: true },
    policy: { switchCredit: 200, clearPlannedAny: true, jointPicks: true },
  },
  // green ATL (2026-10-06): 46.3% of 400 seeds at 600 ms (compiled), was 19.8% —
  // under the 50% fallback after 4 attempts. The plan trains the Intern.
  "green-ATL": {
    plan: { engineMid: 40, searchBias: 400 },
    search: { shortlist: 3, radioCandidate: true },
    policy: { switchCredit: 200, clearPlannedAny: true, jointPicks: true, clearAheadMax: 5 },
  },
  // green PRG (2026-10-06): 29.3% of 420 games (all 15 ability pairs) at 600 ms, was 19.3% —
  // under the 50% fallback after 4 attempts.
  "green-PRG": {
    plan: { engineMid: 40, searchBias: 400 },
    search: { shortlist: 3, radioCandidate: true },
    policy: { switchCredit: 200, clearPlannedAny: true, jointPicks: true },
  },
  // yellow LHR (2026-10-06): 34.3% of 400 seeds at 600 ms (compiled), was 8.5% —
  // above the 30% fallback. Heavy traffic: the plan weighs clearing high.
  "yellow-LHR": {
    plan: { engineMid: 40, searchBias: 400, clear: 250, clearHere: 400 },
    search: { shortlist: 3, radioCandidate: true },
    policy: { switchCredit: 200, clearPlannedAny: true, jointPicks: true, clearAheadMax: 5 },
  },
};

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

/** The search's settings for this game: its card's shortlist (else 6) and Radio candidate. */
export function searchFor(s: GameState): { shortlist: number; radioCandidate: boolean } {
  const c = s.scenario.cardId ? BOT_PROFILES[s.scenario.cardId]?.search : undefined;
  return { shortlist: c?.shortlist ?? 6, radioCandidate: c?.radioCandidate ?? SEARCH_DEFAULTS.radioCandidate };
}

/** The card's scripted-plan weights, or null when the card has no plan. */
export function planFor(s: GameState): PlanWeights | null {
  const p = s.scenario.cardId ? BOT_PROFILES[s.scenario.cardId]?.plan : undefined;
  return p ? { ...PLAN_WEIGHTS, ...(p === true ? {} : p) } : null;
}
