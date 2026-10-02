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
  type Scenario,
} from "@skyteam/shared";
import type { Move, Tutorial } from "./types";

export const PILOT_ID = "tutorial-pilot";
export const COPILOT_ID = "tutorial-copilot";
const idOf = (crew: Crew) => (crew === "pilot" ? PILOT_ID : COPILOT_ID);

/** How many scripted values of each kind have been handed out. */
export interface DiceCursor {
  d6: number;
  traffic: number;
}

export interface ScriptedDice extends Dice {
  used(): DiceCursor;
}

/** Dice that hand out a tutorial's scripted values in order (from `from`, to
 *  replay a step), then random ones. */
export function scriptedDice(script: Tutorial["script"] = {}, from: DiceCursor = { d6: 0, traffic: 0 }): ScriptedDice {
  const at = { ...from };
  const d6 = script.d6 ?? [];
  const traffic = script.traffic ?? [];
  return {
    d6: () => d6[at.d6++] ?? ((1 + Math.floor(Math.random() * 6)) as DieValue),
    traffic: () => traffic[at.traffic++] ?? TRAFFIC_DIE_FACES[Math.floor(Math.random() * TRAFFIC_DIE_FACES.length)],
    used: () => ({ ...at }),
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

/** Play one move through the real rules (throws GameRuleError if illegal).
 *  A Real-Time clock held at the start (see `start`) begins with the first move. */
export function apply(s: GameState, move: Move, dice: Dice, now: () => number = Date.now): GameState {
  const m = move(s);
  if (m === "timeUp") return settle(reduce(s, { type: "timeUp" }, "").state, dice, now);
  if (s.timerRemainingMs !== null) s = reduce(s, { type: "resumeTimer", at: now() }, "").state;
  return settle(reduce(s, withEntropy(m.command, dice), idOf(m.crew)).state, dice, now);
}

/** A short, traffic-free track so tutorial moves never collide or overshoot. */
const TRACK = [{ traffic: 0 }, { traffic: 0 }, { traffic: 0 }, { traffic: 0 }, { traffic: 0, airport: true }];

export interface StartOptions {
  /** The board to play on; a short traffic-free track by default. */
  scenario?: Scenario;
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
  const board = o.scenario ?? { ...YUL_MONTREAL, name: "Tutorial", approachTrack: TRACK };
  const scenario = { ...board, modules: o.modules ?? [], abilities: o.abilities ?? [], maxAbilities: 2 };
  let s = createInitialGameState(scenario, PILOT_ID, COPILOT_ID, { internTokens: [3, 1, 5, 6, 2, 4] });
  s = reduce(s, { type: "roll", pilot: o.pilot, copilot: o.copilot, at: Date.now() }, "").state;
  const dice = scriptedDice();
  for (const m of o.moves ?? []) s = apply(s, m, dice);
  o.tweak?.(s);
  // Real Time: hold the countdown until the player's first move, so reading
  // the description doesn't use up the round.
  if (s.timerEndsAt !== null) {
    s.timerRemainingMs = s.timerEndsAt - Date.now();
    s.timerEndsAt = null;
  }
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
/** A die on the first free Radio or Concentration space (which one doesn't matter). */
export const free = (crew: Crew, value: number, kind: "radio" | "concentration"): Move => (s) => {
  const slot =
    kind === "concentration"
      ? s.concentrationSlots.findIndex((c) => c == null)
      : crew === "pilot" ? 0 : s.radioCopilot.findIndex((r) => r === null);
  return place(crew, value, kind === "radio" ? radio(crew, slot) : conc(slot))(s);
};
/** Reroll the unplaced dice of these values (none = decline an offered reroll). */
export const reroll = (crew: Crew, values: number[]): Move => (s) => {
  const ids: number[] = [];
  for (const v of values) {
    const die = s.dice[crew].find((d) => !d.placed && d.value === v && !ids.includes(d.id));
    if (!die) throw new Error(`Tutorial script: no unplaced ${v} for the ${crew} to reroll.`);
    ids.push(die.id);
  }
  return { crew, command: { type: "reroll", dieIds: ids } };
};

export const axis = (side: Crew): PlacementTarget => ({ kind: "axis", side });
export const engine = (side: Crew): PlacementTarget => ({ kind: "engine", side });
export const radio = (side: Crew, slot = 0): PlacementTarget => ({ kind: "radio", slot, side });
export const conc = (slot: number): PlacementTarget => ({ kind: "concentration", slot });
