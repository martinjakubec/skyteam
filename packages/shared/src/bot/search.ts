import { GameRuleError } from "../game/reducer";
import type { GameCommand } from "../protocol";
import { applyIntentInPlace, type Rand } from "../game/entropy";
import type { Crew } from "../game/scenario";
import type { GameState } from "../game/state";
import { evaluate } from "./evaluate";
import { legalMoves, playerIdOf } from "./moves";
import { rankMoves } from "./policy";
import { determinize, fastMove, rolloutInPlace, rolloutValue } from "./rollout";
import { mulberry32 } from "./rng";

/** The moves the search compares: the quick strategy's best few, plus the rollout
 *  policy's own choice — the quick strategy scores one step ahead and can miss what
 *  the plan needs (e.g. Flaps falling behind). */
/**
 * Real-Time: the round can end any second, and an open Axis or Engine then
 * loses the game — while the crew's own are open, only those are worth
 * searching (rollouts don't model the clock, so they'd happily wait).
 */
export function realTimeFirst(view: GameState, crew: Crew, moves: GameCommand[]): GameCommand[] {
  if (!view.scenario.modules?.includes("realTime") || view.phase !== "placement") return moves;
  if (view.axis[crew] !== null && view.engines[crew] !== null) return moves;
  const first = moves.filter((m) => m.type === "placeDie" && (m.target.kind === "axis" || m.target.kind === "engine"));
  return first.length > 0 ? first : moves;
}

export function searchCandidates(view: GameState, crew: Crew, rand: Rand, shortlist: number, moves = legalMoves(view, crew), dedupe = true): GameCommand[] {
  // Moves that lead to the same game — a die of the same value, the same
  // Coffee spent, on the same space (however the space is spelled: a target
  // with or without the crew's own side) — are one move, not several.
  const valueOf = (id: number) => view.dice[crew].find((d) => d.id === id)?.value ?? 0;
  const space = (t: Record<string, unknown>) => `${t.kind}:${t.slot ?? ""}:${t.space ?? ""}:${t.side ?? crew}`;
  const key = (m: GameCommand) =>
    m.type === "placeDie" ? `${space(m.target)}=${valueOf(m.dieId)}${m.coffeeDelta ? `${m.coffeeDelta > 0 ? "+" : ""}${m.coffeeDelta}` : ""}`
    : m.type === "reroll" ? `reroll:${m.dieIds.map(valueOf).sort().join()}`
    : JSON.stringify(m);
  const seen = new Set<string>();
  const ranked: GameCommand[] = [];
  for (const m of rankMoves(view, crew, moves, rand)) {
    if (ranked.length >= shortlist) break;
    const k = dedupe ? key(m) : JSON.stringify(m);
    if (seen.has(k)) continue;
    seen.add(k);
    ranked.push(m);
  }
  const own = fastMove(view, crew, rand);
  if (own && moves.some((m) => key(m) === key(own)) && !ranked.some((m) => key(m) === key(own))) {
    if (ranked.length < shortlist) ranked.push(own);
    else ranked[shortlist - 1] = own;
  }
  return ranked;
}

/** One search's results: the candidates and, for each, its summed rollout value and sample count. */
export interface SearchStats {
  candidates: GameCommand[];
  totals: number[];
  counts: number[];
  /** Samples skipped because the rules refused a move in them (should stay 0). */
  errors?: number;
}

export interface SearchOptions {
  budgetMs: number;
  shortlist?: number;
  /** Samples per candidate (the total budget is this × candidates; halving moves it around). */
  maxSamples?: number;
  horizon?: "game" | "round";
  /** Seed for picking the candidates: workers searching in parallel pass the
   *  same one, so their results line up and can be merged. */
  candidateSeed?: number;
  /** Drop the weaker half of the candidates as samples come in. */
  halving?: boolean;
  /** Count moves that lead to the same game (same value, same space) once. */
  dedupe?: boolean;
  /** Search these candidates instead of picking them (tests). */
  candidates?: GameCommand[];
}

/**
 * Search settings for experiments (bench: SEARCH='{…}'); options passed to a
 * search win. Both off: measured on 160 YUL games at 120 samples, halving and
 * de-duplication cut landings from 54% to 19% — dropping candidates after a
 * few noisy samples (or merging away the policy's own move) loses good moves.
 */
export const SEARCH_DEFAULTS: { halving: boolean; dedupe: boolean } = { halving: false, dedupe: false };

/**
 * Aviator's search, without the final pick: determinized Monte Carlo over the
 * candidates. Each sample fills in the dice the bot can't see, plays the
 * candidate, plays the rest of the game out (or, with horizon "round", the
 * round) and scores the result. Successive halving: once every surviving
 * candidate has `rung` samples, the weaker half drops out (down to two) and the
 * rest share what's left. It starts from the bot's own view, so it only ever
 * samples what's hidden — never reads it.
 */
export function searchStats(
  view: GameState,
  crew: Crew,
  rand: Rand,
  { budgetMs, shortlist = 6, maxSamples = 400, horizon = "game", candidateSeed, halving = SEARCH_DEFAULTS.halving, dedupe = SEARCH_DEFAULTS.dedupe, candidates: given }: SearchOptions,
): SearchStats {
  const moves = given ?? realTimeFirst(view, crew, legalMoves(view, crew));
  if (moves.length <= 1) return { candidates: moves, totals: moves.map(() => 0), counts: moves.map(() => 1) };
  const candidates = given ?? searchCandidates(view, crew, candidateSeed === undefined ? rand : mulberry32(candidateSeed), shortlist, moves, dedupe);
  const totals = candidates.map(() => 0);
  const counts = candidates.map(() => 0);
  const deadline = Date.now() + budgetMs;
  const now = () => 0;
  const mean = (i: number) => totals[i] / Math.max(1, counts[i]);
  let alive = candidates.map((_, i) => i);
  let budget = maxSamples * candidates.length;
  let errors = 0;
  let rung = 2;
  while (budget > 0 && Date.now() < deadline) {
    for (const i of alive) {
      if (budget <= 0 || Date.now() >= deadline) break;
      budget -= 1;
      // A fresh sampled world, owned here: the candidate and the rollout play on
      // it in place. A move the rules refuse in it (a gap in placementCheck, or a
      // bug) skips this one sample and is counted — the search goes on.
      let value: number;
      try {
        const world = applyIntentInPlace(determinize(view, rand), candidates[i], playerIdOf(view, crew), rand, now);
        const round = world.round;
        value = horizon === "game"
          ? rolloutValue(rolloutInPlace(world, rand), crew)
          : evaluate(rolloutInPlace(world, rand, 40, (st) => st.round !== round), crew);
      } catch (e) {
        if (!(e instanceof GameRuleError)) throw e;
        errors += 1;
        continue;
      }
      totals[i] += value;
      counts[i] += 1;
    }
    if (halving && alive.length > 2 && alive.every((i) => counts[i] >= rung)) {
      alive = [...alive].sort((a, b) => mean(b) - mean(a)).slice(0, Math.max(2, Math.ceil(alive.length / 2)));
      rung *= 2;
    }
  }
  return { candidates, totals, counts, errors };
}

/**
 * The move to play from one or more searches of the same candidates (workers
 * in parallel): their samples are summed, and the best average wins among the
 * candidates sampled enough to trust — at least a quarter as often as the
 * most-sampled (halving drops the weak ones early, after a few samples).
 */
export function pickBest(stats: SearchStats[]): GameCommand | null {
  const first = stats.find((st) => st.candidates.length > 0);
  if (!first) return null;
  const key = JSON.stringify(first.candidates);
  const same = stats.filter((st) => JSON.stringify(st.candidates) === key);
  const totals = first.candidates.map((_, i) => same.reduce((a, st) => a + st.totals[i], 0));
  const counts = first.candidates.map((_, i) => same.reduce((a, st) => a + st.counts[i], 0));
  // Nothing sampled (no time at all): the best-ranked candidate.
  if (counts.every((n) => n === 0)) return first.candidates[0];
  const enough = Math.max(1, Math.max(...counts) / 4);
  let best = -1;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] < enough) continue;
    if (best < 0 || totals[i] / counts[i] > totals[best] / counts[best]) best = i;
  }
  return first.candidates[best];
}

/** Aviator's move: one search, then the pick. */
export function searchMove(view: GameState, crew: Crew, rand: Rand, opts: SearchOptions): GameCommand | null {
  return pickBest([searchStats(view, crew, rand, opts)]);
}
