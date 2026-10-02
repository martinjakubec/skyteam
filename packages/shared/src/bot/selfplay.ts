import type { GameSetup } from "../game/catalog";
import { applyIntent, newGame } from "../game/entropy";
import type { Crew } from "../game/scenario";
import { redactGameStateFor } from "../game/state";
import { actorFor } from "./actor";
import type { BotLevel } from "./levels";
import { chooseMove } from "./policy";
import { mulberry32 } from "./rng";

export interface SelfPlayResult { outcome: "won" | "lost" | "stuck"; reason: string; rounds: number; moves: number }

/** One full bot-vs-bot game: each seat decides from its own redacted view; the
 *  seeded random source supplies every roll exactly as the server would. The
 *  clock stands still, so Real-Time never runs out (the bot acts instantly). */
export function selfPlay(setup: GameSetup, levels: Record<Crew, BotLevel>, seed: number, maxMoves = 400): SelfPlayResult {
  const rand = mulberry32(seed);
  const now = () => 0;
  let g = newGame(setup, "P", "C", rand, now());
  let moves = 0;
  for (; moves < maxMoves; moves++) {
    const crew = actorFor(g);
    if (!crew) break;
    const id = crew === "pilot" ? "P" : "C";
    const move = chooseMove(redactGameStateFor(g, id), crew, levels[crew], rand);
    if (!move) return { outcome: "stuck", reason: `no legal move for the ${crew} (round ${g.round})`, rounds: g.round, moves };
    g = applyIntent(g, move, id, rand, now);
  }
  if (!g.outcome) return { outcome: "stuck", reason: `no outcome after ${moves} moves`, rounds: g.round, moves };
  return { outcome: g.outcome.result, reason: g.outcome.result === "lost" ? g.outcome.reason : "", rounds: g.round, moves };
}
