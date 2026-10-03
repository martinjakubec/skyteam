import type { GameCommand, PlacementTarget } from "../protocol";
import { applyIntent, type Rand } from "../game/entropy";
import { GameRuleError, reduce } from "../game/reducer";
import type { Crew, DieValue } from "../game/scenario";
import type { GameState } from "../game/state";
import { actorFor } from "./actor";
import { playerIdOf } from "./moves";
import { chooseMove } from "./policy";

/** Give every hidden die a random value — one plausible world consistent with the view. */
export function determinize(view: GameState, rand: Rand): GameState {
  const s = structuredClone(view);
  for (const crew of ["pilot", "copilot"] as const) {
    for (const d of s.dice[crew]) {
      if (d.hidden) {
        d.value = (rand(6) + 1) as DieValue;
        delete d.hidden;
      }
    }
  }
  return s;
}

/** Cheap rollout policy: try a fixed priority list (lowest die first; Engine,
 *  Axis, Radio, switches, Concentration) and take the first legal one. Prompts
 *  (held extras, reroll/swap answers) and anything unusual fall back to Navigator. */
export function fastMove(s: GameState, crew: Crew, rand: Rand): GameCommand | null {
  if (s.internHeld || s.trafficHeld || s.pendingSwap || s.pendingReroll) return chooseMove(s, crew, "navigator", rand);
  const hand = s.dice[crew].filter((d) => !d.placed).sort((a, b) => a.value! - b.value!);
  const tries: Extract<GameCommand, { type: "placeDie" }>[] = [];
  for (const d of hand) {
    const at = (target: PlacementTarget) => tries.push({ type: "placeDie", dieId: d.id, target });
    at({ kind: "engine" });
    at({ kind: "axis" });
    at({ kind: "radio", slot: 0 });
    for (const slot of [0, 1, 2]) at({ kind: "landingGear", slot });
    for (const slot of [0, 1, 2, 3]) at({ kind: "flaps", slot });
    for (const slot of [0, 1, 2]) at({ kind: "brakes", slot });
    at({ kind: "concentration", slot: 0 });
    at({ kind: "concentration", slot: 1 });
    at({ kind: "radio", slot: 1 });
  }
  for (const cmd of tries) {
    try {
      reduce(s, cmd, playerIdOf(s, crew));
      return cmd;
    } catch (e) {
      if (!(e instanceof GameRuleError)) throw e;
    }
  }
  return chooseMove(s, crew, "navigator", rand); // nothing cheap fits: Navigator over all moves
}

/** Play on until the round changes or the game ends (full information, both crews). */
export function rolloutRound(state: GameState, rand: Rand, maxSteps = 40): GameState {
  let s = state;
  const round = s.round;
  const now = () => 0;
  for (let i = 0; i < maxSteps && !s.outcome && s.round === round; i++) {
    const crew = actorFor(s);
    if (!crew) break;
    const move = fastMove(s, crew, rand);
    if (!move) break;
    s = applyIntent(s, move, playerIdOf(s, crew), rand, now);
  }
  return s;
}
