import type { GameCommand } from "../protocol";
import { reduce, type ReduceCommand } from "../game/reducer";
import type { Crew, DieValue } from "../game/scenario";
import type { GameState } from "../game/state";
import type { Rand } from "../game/entropy";
import { evaluate } from "./evaluate";
import type { BotLevel } from "./levels";
import { legalMoves, playerIdOf } from "./moves";
import { searchMove } from "./search";

/** Score a move by the state it leads to. Random outcomes (rerolls) are scored
 *  with the dice unchanged — neutral, so Navigator never rerolls on purpose
 *  (Phase 3's search values them properly). */
function scoreMove(view: GameState, crew: Crew, move: GameCommand): number {
  const cmd: ReduceCommand =
    move.type === "reroll" ? { ...move, values: move.dieIds.map((id) => view.dice[crew].find((d) => d.id === id)!.value as DieValue) }
    : move.type === "anticipate" ? { ...move, value: view.dice[crew].find((d) => d.id === move.dieId)!.value as DieValue }
    : move;
  const next = reduce(view, cmd, playerIdOf(view, crew)).state;
  return evaluate(next, crew) + reserveBonus(view, crew, move);
}

/** Keep the dice the crew will need: the lowest for an open Engine and the most
 *  level-friendly for an open Axis (spending them elsewhere is penalised). */
function reserveBonus(view: GameState, crew: Crew, move: GameCommand): number {
  if (move.type !== "placeDie" || move.target.kind === "axis" || move.target.kind === "engine") return 0;
  const hand = view.dice[crew].filter((d) => !d.placed);
  const die = hand.find((d) => d.id === move.dieId)!;
  let penalty = 0;
  if (view.engines[crew] === null && die === hand.reduce((m, d) => (d.value! < m.value! ? d : m))) penalty += 60;
  const ideal = crew === "pilot" ? 3.5 - view.axis.offset : 3.5 + view.axis.offset;
  if (view.axis[crew] === null && die === hand.reduce((m, d) => (Math.abs(d.value! - ideal) < Math.abs(m.value! - ideal) ? d : m))) penalty += 40;
  return -penalty;
}

/** The moves, best first by their one-step score; equal scores in random order. */
export function rankMoves(view: GameState, crew: Crew, moves: GameCommand[], rand: Rand): GameCommand[] {
  const shuffled = [...moves];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const scored = shuffled.map((m) => ({ m, s: scoreMove(view, crew, m) }));
  return scored.sort((a, b) => b.s - a.s).map(({ m }) => m); // stable: ties keep the shuffle
}

/** How often a Cadet plays a lesser move, and how far down it reaches. */
const CADET_SLIP_PERCENT = 35;
const CADET_SLIP_DEPTH = 3; // 2nd–4th best

/**
 * Pick the bot's next command from its own view (null when nothing is legal):
 * - Navigator: the best one-step score (ties broken at random).
 * - Cadet: the same, but now and then one of the next few moves instead.
 * - Aviator: Monte Carlo search over the dice it can't see, within `budgetMs`.
 */
export function chooseMove(view: GameState, crew: Crew, level: BotLevel, rand: Rand, opts?: { budgetMs?: number }): GameCommand | null {
  const moves = legalMoves(view, crew);
  if (moves.length === 0) return null;
  if (level === "aviator") return searchMove(view, crew, rand, { budgetMs: opts?.budgetMs ?? 600 });
  const ranked = rankMoves(view, crew, moves, rand);
  if (level === "cadet" && rand(100) < CADET_SLIP_PERCENT) return ranked[Math.min(ranked.length - 1, 1 + rand(CADET_SLIP_DEPTH))];
  return ranked[0];
}
