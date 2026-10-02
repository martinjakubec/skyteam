import type { GameCommand } from "../protocol";
import { reduce, type ReduceCommand } from "../game/reducer";
import type { Crew, DieValue } from "../game/scenario";
import type { GameState } from "../game/state";
import type { Rand } from "../game/entropy";
import { evaluate } from "./evaluate";
import type { BotLevel } from "./levels";
import { legalMoves, playerIdOf } from "./moves";

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

/**
 * Pick the bot's next command from its own view. Navigator: best one-step
 * score (ties broken at random). Cadet/Aviator alias Navigator until Phase 3.
 * Returns null when nothing is legal.
 */
export function chooseMove(view: GameState, crew: Crew, _level: BotLevel, rand: Rand): GameCommand | null {
  const moves = legalMoves(view, crew);
  if (moves.length === 0) return null;
  let best: GameCommand[] = [];
  let bestScore = -Infinity;
  for (const m of moves) {
    const s = scoreMove(view, crew, m);
    if (s > bestScore + 1e-9) { best = [m]; bestScore = s; }
    else if (Math.abs(s - bestScore) <= 1e-9) best.push(m);
  }
  return best[rand(best.length)];
}
