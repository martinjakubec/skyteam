import {
  TRAFFIC_DIE_FACES,
  YUL_MONTREAL,
  createInitialGameState,
  reduce,
  settle,
  withEntropy,
  type AbilityId,
  type Crew,
  type Dice,
  type DieValue,
  type GameState,
  type ModuleId,
  type PlacementTarget,
} from "@skyteam/shared";
import type { Move, Tutorial } from "./types";

export const PILOT_ID = "tutorial-pilot";
export const COPILOT_ID = "tutorial-copilot";
const idOf = (crew: Crew) => (crew === "pilot" ? PILOT_ID : COPILOT_ID);

/** Dice that hand out a tutorial's scripted values in order, then random ones. */
export function scriptedDice(script: Tutorial["script"] = {}): Dice {
  const d6 = [...(script.d6 ?? [])];
  const traffic = [...(script.traffic ?? [])];
  return {
    d6: () => d6.shift() ?? ((1 + Math.floor(Math.random() * 6)) as DieValue),
    traffic: () => traffic.shift() ?? TRAFFIC_DIE_FACES[Math.floor(Math.random() * TRAFFIC_DIE_FACES.length)],
  };
}

/** Who must act now — the tutorial player plays both crews, as this one. */
export function actingCrew(s: GameState): Crew {
  if (s.pendingReroll) return s.pendingReroll;
  if (s.pendingSwap) return s.pendingSwap.from === "pilot" ? "copilot" : "pilot";
  if (s.internHeld) return s.internHeld.crew;
  if (s.trafficHeld) return "copilot";
  return s.turn;
}

/** Play one move through the real rules (throws GameRuleError if illegal). */
export function apply(s: GameState, move: Move, dice: Dice, now: () => number = Date.now): GameState {
  const m = move(s);
  if (m === "timeUp") return settle(reduce(s, { type: "timeUp" }, "").state, dice, now);
  return settle(reduce(s, withEntropy(m.command, dice), idOf(m.crew)).state, dice, now);
}

/** A short, traffic-free track so tutorial moves never collide or overshoot. */
const TRACK = [{ traffic: 0 }, { traffic: 0 }, { traffic: 0 }, { traffic: 0 }, { traffic: 0, airport: true }];

export interface StartOptions {
  modules?: ModuleId[];
  abilities?: AbilityId[];
  /** Round 1's hands. */
  pilot: DieValue[];
  copilot: DieValue[];
  /** Moves played before the tutorial starts (dice the lesson doesn't need). */
  moves?: Move[];
  /** Last adjustments, e.g. a spent Reroll token. */
  tweak?: (s: GameState) => void;
}

/** A tutorial's starting position: round 1 rolled with fixed hands. */
export function start(o: StartOptions): GameState {
  const scenario = { ...YUL_MONTREAL, name: "Tutorial", approachTrack: TRACK, modules: o.modules ?? [], abilities: o.abilities ?? [], maxAbilities: 2 };
  let s = createInitialGameState(scenario, PILOT_ID, COPILOT_ID, { internTokens: [3, 1, 5, 6, 2, 4] });
  s = reduce(s, { type: "roll", pilot: o.pilot, copilot: o.copilot, at: Date.now() }, "").state;
  const dice = scriptedDice();
  for (const m of o.moves ?? []) s = apply(s, m, dice);
  o.tweak?.(s);
  return s;
}

// --- Move builders -----------------------------------------------------------

function dieOf(s: GameState, crew: Crew, value: number): number {
  const die = s.dice[crew].find((d) => !d.placed && d.value === value);
  if (!die) throw new Error(`Tutorial script: no unplaced ${value} for the ${crew}.`);
  return die.id;
}

export const place = (crew: Crew, value: number, target: PlacementTarget, coffeeDelta?: number): Move => (s) => ({
  crew,
  command: { type: "placeDie", dieId: dieOf(s, crew, value), target, ...(coffeeDelta ? { coffeeDelta } : {}) },
});
export const placeIntern = (crew: Crew, target: PlacementTarget): Move => () => ({ crew, command: { type: "placeIntern", target } });
export const placeTraffic = (target: PlacementTarget): Move => () => ({ crew: "copilot", command: { type: "placeTraffic", target } });
export const swap = (crew: Crew, value: number): Move => (s) => ({ crew, command: { type: "swap", dieId: dieOf(s, crew, value) } });
export const adapt = (crew: Crew, value: number): Move => (s) => ({ crew, command: { type: "adapt", dieId: dieOf(s, crew, value) } });
export const anticipate = (crew: Crew, value: number): Move => (s) => ({ crew, command: { type: "anticipate", dieId: dieOf(s, crew, value) } });
export const timeUp: Move = () => "timeUp";

export const axis = (side: Crew): PlacementTarget => ({ kind: "axis", side });
export const engine = (side: Crew): PlacementTarget => ({ kind: "engine", side });
export const radio = (side: Crew, slot = 0): PlacementTarget => ({ kind: "radio", slot, side });
export const conc = (slot: number): PlacementTarget => ({ kind: "concentration", slot });
