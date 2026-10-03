import type { GameCommand } from "../protocol";
import { applyIntent, type Rand } from "../game/entropy";
import type { Crew } from "../game/scenario";
import type { GameState } from "../game/state";
import { evaluate } from "./evaluate";
import { legalMoves, playerIdOf } from "./moves";
import { rankMoves } from "./policy";
import { determinize, rolloutGame, rolloutRound, rolloutValue } from "./rollout";

/**
 * Aviator: determinized Monte Carlo over the Navigator's shortlist. Each sample
 * fills in the dice the bot can't see, plays the candidate, plays the rest of
 * the game out (or, with horizon "round", the round) and scores the result;
 * samples are spread round-robin across candidates until the budget or
 * `maxSamples` per candidate, and the best average wins. It starts from the
 * bot's own view, so it only ever samples what's hidden — never reads it.
 */
export function searchMove(
  view: GameState,
  crew: Crew,
  rand: Rand,
  { budgetMs, shortlist = 6, maxSamples = 400, horizon = "game" }: { budgetMs: number; shortlist?: number; maxSamples?: number; horizon?: "game" | "round" },
): GameCommand | null {
  const moves = legalMoves(view, crew);
  if (moves.length <= 1) return moves[0] ?? null;
  const candidates = rankMoves(view, crew, moves, rand).slice(0, shortlist);
  const totals = candidates.map(() => 0);
  const counts = candidates.map(() => 0);
  const deadline = Date.now() + budgetMs;
  const now = () => 0;
  for (let k = 0; k < maxSamples && Date.now() < deadline; k++) {
    for (let i = 0; i < candidates.length && Date.now() < deadline; i++) {
      const world = determinize(view, rand);
      const played = applyIntent(world, candidates[i], playerIdOf(view, crew), rand, now);
      totals[i] += horizon === "game" ? rolloutValue(rolloutGame(played, rand), crew) : evaluate(rolloutRound(played, rand), crew);
      counts[i] += 1;
    }
  }
  let best = 0;
  for (let i = 1; i < candidates.length; i++) {
    if (counts[i] && totals[i] / counts[i] > totals[best] / Math.max(1, counts[best])) best = i;
  }
  return candidates[best];
}
