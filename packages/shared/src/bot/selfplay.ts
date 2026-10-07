import type { GameSetup } from "../game/catalog";
import type { GameCommand } from "../protocol";
import type { Crew } from "../game/scenario";
import { newGame, randDice, settle, withEntropy, type Rand } from "../game/entropy";
import { reduce } from "../game/reducer";
import { redactGameStateFor, type GameState } from "../game/state";
import { actorFor } from "./actor";
import { chooseMove, quickMove } from "./policy";
import { mulberry32 } from "./rng";

export interface SelfPlayResult {
  outcome: "won" | "lost" | "stuck";
  reason: string;
  rounds: number;
  moves: number;
  /** Each round's roll ("pilot dice|copilot dice"), for comparing runs. */
  rolls: string[];
  /** The final state (for the landing checklist in benchmarks). */
  final: GameState;
}

/**
 * One full bot-vs-bot game (Aviator, or its quick strategy for fast coverage
 * runs): each seat decides from its own redacted view.
 * Randomness is split so runs compare fairly: every round's dice (its roll,
 * Traffic dice and rerolls) come from a stream keyed by the seed and the round
 * alone, and the bots draw from a stream of their own — so two runs with the
 * same seed see the same rolls round by round, whatever the bots did. The
 * clock stands still, so Real-Time never runs out (the bots act instantly).
 */
export function selfPlay(
  setup: GameSetup,
  seed: number,
  maxMoves = 400,
  opts?: { budgetMs?: number; samples?: number; strategy?: "aviator" | "quick"; onMove?: (move: GameCommand, crew: Crew, before: GameState) => void },
): SelfPlayResult {
  const streams = new Map<number, Rand>();
  const stream = (round: number): Rand => {
    if (!streams.has(round)) streams.set(round, mulberry32((seed * 1009 + round * 7919) >>> 0));
    return streams.get(round)!;
  };
  const roundDice = (round: number) => randDice(stream(round));
  const botRand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const now = () => 0;
  const rolls: string[] = [];
  const recordRoll = (g: GameState) => {
    if (rolls.length < g.round) rolls.push(`${g.dice.pilot.map((d) => d.value).join("")}|${g.dice.copilot.map((d) => d.value).join("")}`);
  };

  let g = newGame(setup, "P", "C", stream(1), 0);
  recordRoll(g);
  let moves = 0;
  for (; moves < maxMoves; moves++) {
    const crew = actorFor(g);
    if (!crew) break;
    const id = crew === "pilot" ? "P" : "C";
    const view = redactGameStateFor(g, id);
    const move = opts?.strategy === "quick" ? quickMove(view, crew, botRand) : chooseMove(view, crew, botRand, { ...opts, now: now() });
    if (!move) return { outcome: "stuck", reason: `no legal move for the ${crew} (round ${g.round})`, rounds: g.round, moves, rolls, final: g };
    opts?.onMove?.(move, crew, g);
    // A reroll's new values come from this round's stream; once a round ends
    // (g.round has moved on), settle rolls the next one from its own stream.
    g = reduce(g, withEntropy(move, roundDice(g.round)), id).state;
    g = settle(g, roundDice(g.round), now);
    recordRoll(g);
  }
  if (!g.outcome) return { outcome: "stuck", reason: `no outcome after ${moves} moves`, rounds: g.round, moves, rolls, final: g };
  return { outcome: g.outcome.result, reason: g.outcome.result === "lost" ? g.outcome.reason : "", rounds: g.round, moves, rolls, final: g };
}
