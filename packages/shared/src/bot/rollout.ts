import type { GameCommand, PlacementTarget } from "../protocol";
import { applyIntent, type Rand } from "../game/entropy";
import { GameRuleError, landingChecks, reduce } from "../game/reducer";
import { BRAKE_VALUES, FLAPS_VALUES, ICE_BRAKE_VALUES, LANDING_GEAR_VALUES, WIND_RING, type Crew, type DieValue } from "../game/scenario";
import { airportIndex, type GameState } from "../game/state";
import { actorFor } from "./actor";
import { evaluate, WIN } from "./evaluate";
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

type Place = Extract<GameCommand, { type: "placeDie" }>;
const other = (c: Crew): Crew => (c === "pilot" ? "copilot" : "pilot");
const advanceFor = (s: GameState, speed: number) => (speed <= s.aeroBlue ? 0 : speed > s.aeroOrange ? 2 : 1);

/**
 * Cheap, plan-aware rollout policy (full information: a sampled world). It
 * lists placements in priority order and plays the first the rules accept:
 * answer the partner's Axis and Engine dice (level the plane; the speed the
 * approach needs, or on the landing round one the Brakes hold); clear the
 * airplane in the way; deploy Flaps, Landing Gear and Brakes with dice that
 * fit; then its own Axis and Engine with the dice best kept for them; then
 * anything legal. Prompts (held extras, reroll/swap answers) go to Navigator.
 */
export function fastMove(s: GameState, crew: Crew, rand: Rand): GameCommand | null {
  if (s.internHeld || s.trafficHeld || s.pendingSwap) return chooseMove(s, crew, "navigator", rand);
  if (s.pendingReroll) return { type: "reroll", dieIds: [] }; // keep our dice
  const hand = s.dice[crew].filter((d) => !d.placed && d.value !== undefined);
  if (!hand.length) return null;
  const landing = s.round >= s.scenario.rounds;
  const partner = other(crew);
  const tries: Place[] = [];
  const at = (dieId: number, target: PlacementTarget, coffeeDelta = 0) =>
    tries.push({ type: "placeDie", dieId, target, ...(coffeeDelta ? { coffeeDelta } : {}) });
  const coffeeOptions = (v: number) =>
    Array.from({ length: 2 * s.coffee + 1 }, (_, i) => i - s.coffee).filter((d) => v + d >= 1 && v + d <= 6).sort((a, b) => Math.abs(a) - Math.abs(b));

  // Axis: the tilt our die would leave (against the partner's die, or the middle if it's hidden).
  const tiltWith = (v: number, theirs: number) => s.axis.offset + (crew === "pilot" ? v - theirs : theirs - v);
  const axisCost = (v: number) => {
    const theirs = s.axis[partner];
    if (theirs !== null) return Math.abs(tiltWith(v, theirs)) * 10;
    return Math.abs(tiltWith(v, 3.5));
  };
  // Engines: how far the speed lands from what the approach needs this round.
  const remaining = airportIndex(s.scenario) - s.position;
  const roundsAfter = Math.max(0, s.scenario.rounds - s.round - 1);
  // Pace: spread the spaces left over this round and the moving rounds after it.
  const want = Math.max(0, Math.min(2, remaining, Math.ceil(remaining / (roundsAfter + 1))));
  const wind = s.scenario.modules?.includes("wind") ? WIND_RING[s.windPosition] : 0;
  const steps = s.scenario.modules?.includes("iceBrakes") ? ICE_BRAKE_VALUES : BRAKE_VALUES;
  const brakeLimit = s.brakesDeployed > 0 ? steps[s.brakesDeployed - 1] : 0;
  // Flying off (or through) a space with an airplane, or past the airport, loses.
  const crashes = (adv: number) => {
    for (let step = 0; step < adv; step++) if ((s.airplanes[s.position + step] ?? 0) > 0 || step >= remaining) return true;
    return false;
  };
  const speedCost = (speed: number) => {
    if (landing) return speed > brakeLimit ? 10 + speed : speed / 10;
    const adv = advanceFor(s, speed);
    return (crashes(adv) ? 1000 : 0) + Math.abs(adv - want) * 10;
  };
  const engineCost = (v: number) => {
    const theirs = s.engines[partner];
    if (theirs !== null) return speedCost(v + theirs + wind);
    return [1, 2, 3, 4, 5, 6].reduce((a, f) => a + speedCost(v + f + wind), 0) / 6;
  };

  const axisOpen = s.axis[crew] === null;
  const engineOpen = s.engines[crew] === null;
  /** The best dice for our open Axis and Engine from `dice`, and how good they are. */
  const picks = (dice: typeof hand) => {
    const best = (cost: (v: number) => number, skip?: number) =>
      dice.filter((d) => d.id !== skip).flatMap((d) => coffeeOptions(d.value!).map((c) => ({ d, c, k: cost(d.value! + c) + Math.abs(c) * 0.5 }))).sort((a, b) => a.k - b.k)[0] ?? null;
    const axis = axisOpen ? best(axisCost) : null;
    const engine = engineOpen ? best(engineCost, axis?.d.id) ?? best(engineCost) : null;
    return { axis, engine, k: (axis?.k ?? 0) + (engine?.k ?? 0) };
  };
  const kept = picks(hand);
  const axisPick = kept.axis;
  const enginePick = kept.engine;
  // A die is spare if the Axis and Engine are served nearly as well without it.
  const spare = hand.filter((d) => picks(hand.filter((x) => x.id !== d.id)).k <= kept.k + 1);

  // 1. Answer the partner's Axis / Engine die while it's known.
  if (axisPick && s.axis[partner] !== null) at(axisPick.d.id, { kind: "axis" }, axisPick.c);
  if (enginePick && s.engines[partner] !== null) at(enginePick.d.id, { kind: "engine" }, enginePick.c);
  // 2. Clear the nearest airplane in the way (a die of N clears N−1 spaces ahead).
  const radioSlots: PlacementTarget[] = crew === "pilot" ? [{ kind: "radio", slot: 0 }] : [{ kind: "radio", slot: 0 }, { kind: "radio", slot: 1 }];
  // Free placements only use spare dice — the ones kept for the Axis and Engine
  // stay put (the rules force them onto those once nothing else is left).
  // (An airplane on our space or the next blocks the approach outright: any die may clear it.)
  for (let ahead = 0; ahead <= 2; ahead++) {
    if ((s.airplanes[s.position + ahead] ?? 0) === 0) continue;
    for (const d of ahead <= 1 ? [...spare, ...hand] : spare) if (d.value === ahead + 1) for (const t of radioSlots) at(d.id, t);
  }
  // 3. Switches with dice that fit (only undeployed ones; the rules keep the order).
  for (const d of spare) {
    if (crew === "pilot") {
      LANDING_GEAR_VALUES.forEach((vals, slot) => !s.gearGreen[slot] && vals.includes(d.value!) && at(d.id, { kind: "landingGear", slot }));
      if (s.brakesDeployed < BRAKE_VALUES.length && BRAKE_VALUES[s.brakesDeployed] === d.value) at(d.id, { kind: "brakes", slot: s.brakesDeployed });
    } else {
      const next = s.flapsGreen.findIndex((g) => !g);
      if (next >= 0 && FLAPS_VALUES[next].includes(d.value!)) at(d.id, { kind: "flaps", slot: next });
    }
  }
  // 4. Our own Axis and Engine with the dice kept for them.
  if (axisPick) at(axisPick.d.id, { kind: "axis" }, axisPick.c);
  if (enginePick) at(enginePick.d.id, { kind: "engine" }, enginePick.c);
  // 5. A spare die anywhere harmless: Concentration, a Radio.
  for (const d of spare) {
    at(d.id, { kind: "concentration", slot: 0 });
    at(d.id, { kind: "concentration", slot: 1 });
    for (const t of radioSlots) at(d.id, t);
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
  return rollout(state, rand, maxSteps, (s) => s.round !== state.round);
}

/** Play on to the end of the game (full information, both crews). */
export function rolloutGame(state: GameState, rand: Rand, maxSteps = 400): GameState {
  return rollout(state, rand, maxSteps, () => false);
}

function rollout(state: GameState, rand: Rand, maxSteps: number, stop: (s: GameState) => boolean): GameState {
  let s = state;
  const now = () => 0;
  for (let i = 0; i < maxSteps && !s.outcome && !stop(s); i++) {
    const crew = actorFor(s);
    if (!crew) break;
    const move = fastMove(s, crew, rand);
    if (!move) break;
    s = applyIntent(s, move, playerIdOf(s, crew), rand, now);
  }
  return s;
}

/**
 * How good a rolled-out end is. A landing is a win. A failed landing earns
 * credit for each landing condition met — near-misses teach the search what
 * to fix. A crash scores lowest, less so the later it happened. A rollout cut
 * short falls back to the evaluator.
 */
export function rolloutValue(s: GameState, crew: Crew): number {
  if (!s.outcome) return evaluate(s, crew);
  if (s.outcome.result === "won") return WIN;
  if (s.outcome.reason.startsWith("Landing failed")) {
    const met = Object.values(landingChecks(s)).filter(Boolean).length;
    return -WIN / 2 + met * 400;
  }
  return -WIN + s.round * 300;
}
