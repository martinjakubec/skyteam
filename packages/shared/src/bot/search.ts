import type { GameCommand } from "../protocol";
import { applyIntentInPlace, type Rand } from "../game/entropy";
import type { Crew } from "../game/scenario";
import type { GameState } from "../game/state";
import { evaluate } from "./evaluate";
import { legalMoves, playerIdOf } from "./moves";
import { rankMoves } from "./policy";
import { determinize, fastMove, rolloutInPlace, rolloutValue } from "./rollout";

/** The moves the search compares: the Navigator's best few, plus the rollout
 *  policy's own choice — the Navigator scores one step ahead and can miss what
 *  the plan needs (e.g. Flaps falling behind). */
export function searchCandidates(view: GameState, crew: Crew, rand: Rand, shortlist: number, moves = legalMoves(view, crew)): GameCommand[] {
  // Moves that lead to the same game — the same value on the same space (by
  // another die of that value, or Coffee) — are one candidate, not several.
  const valueOf = (id: number) => view.dice[crew].find((d) => d.id === id)?.value ?? 0;
  const key = (m: GameCommand) =>
    m.type === "placeDie" ? `${JSON.stringify(m.target)}=${valueOf(m.dieId) + (m.coffeeDelta ?? 0)}`
    : m.type === "reroll" ? `reroll:${m.dieIds.map(valueOf).sort().join()}`
    : JSON.stringify(m);
  const seen = new Set<string>();
  const ranked: GameCommand[] = [];
  for (const m of rankMoves(view, crew, moves, rand)) {
    if (ranked.length >= shortlist) break;
    if (seen.has(key(m))) continue;
    seen.add(key(m));
    ranked.push(m);
  }
  const own = fastMove(view, crew, rand);
  if (own && !ranked.some((m) => key(m) === key(own))) {
    if (ranked.length < shortlist) ranked.push(own);
    else ranked[shortlist - 1] = own;
  }
  return ranked;
}

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
  const candidates = searchCandidates(view, crew, rand, shortlist, moves);
  const totals = candidates.map(() => 0);
  const counts = candidates.map(() => 0);
  const deadline = Date.now() + budgetMs;
  const now = () => 0;
  const mean = (i: number) => totals[i] / Math.max(1, counts[i]);
  // Successive halving: the same total samples as `maxSamples` each, but once
  // every surviving candidate has `rung` samples, the weaker half drops out
  // (down to two) and the rest share what's left.
  let alive = candidates.map((_, i) => i);
  let budget = maxSamples * candidates.length;
  let rung = 2;
  while (budget > 0 && Date.now() < deadline) {
    for (const i of alive) {
      if (budget <= 0 || Date.now() >= deadline) break;
      // A fresh sampled world, owned here: the candidate and the rollout play on it in place.
      const world = applyIntentInPlace(determinize(view, rand), candidates[i], playerIdOf(view, crew), rand, now);
      const round = world.round;
      totals[i] += horizon === "game"
        ? rolloutValue(rolloutInPlace(world, rand), crew)
        : evaluate(rolloutInPlace(world, rand, 40, (st) => st.round !== round), crew);
      counts[i] += 1;
      budget -= 1;
    }
    if (alive.length > 2 && alive.every((i) => counts[i] >= rung)) {
      alive = [...alive].sort((a, b) => mean(b) - mean(a)).slice(0, Math.max(2, Math.ceil(alive.length / 2)));
      rung *= 2;
    }
  }
  let best = alive[0];
  for (const i of alive) if (counts[i] && mean(i) > mean(best)) best = i;
  return candidates[best];
}
