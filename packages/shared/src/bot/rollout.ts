import type { GameCommand, PlacementTarget } from "../protocol";
import { applyIntentInPlace, type Rand } from "../game/entropy";
import { GameRuleError, landingChecks, reduce } from "../game/reducer";
import { BRAKE_VALUES, FLAPS_VALUES, ICE_BRAKE_VALUES, LANDING_GEAR_VALUES, WIND_RING, type Crew, type DieValue } from "../game/scenario";
import { airportIndex, type GameState } from "../game/state";
import { actorFor } from "./actor";
import { evaluate, WIN } from "./evaluate";
import { playerIdOf } from "./moves";
import { chooseMove } from "./policy";

/** Give every hidden die a random value — one plausible world consistent with the view. */
export function determinize(view: GameState, rand: Rand): GameState {
  // Copy everything but the log (it only grows), and give the sampled world a
  // log that drops what's written to it — nobody reads a rollout's log.
  const { log: _log, ...rest } = view;
  const s = structuredClone(rest) as GameState;
  s.log = [];
  Object.defineProperty(s.log, "push", { value: () => 0, enumerable: false });
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

/**
 * The rollout policy's knobs, tunable by scripts/tune.mjs against the policy's
 * own landing rate. Note the trade-off: a policy that crashes less makes longer
 * rollouts, so fewer fit in Aviator's time budget. The tuner's values
 * (2026-10-03: spareSlack 0.5, gearSlack 0, brakeGoal 2, coffeeCost 1 — held-out
 * landings alone 72 → 84/200) cost ~100 ms more per decision and lowered
 * Aviator's landings at the real budget (21/80 → 10/80), so the defaults stay.
 */
export const POLICY_PARAMS = {
  /** A die is spare if the Axis and Engine lose at most this much without it. */
  spareSlack: 1,
  /** Lower the Gear once gear left ≥ rounds to place − gearSlack… */
  gearSlack: 1,
  /** …or once the spaces left ≤ moving rounds after this one + paceSlack. */
  paceSlack: 1,
  /** Behind on switches when switches left ≥ rounds to place − behindSlack. */
  behindSlack: 0,
  /** Brakes the Pilot plans for (2, 4, 6: how many to deploy). */
  brakeGoal: 3,
  /** Cost of one Coffee token spent, against a pip of tilt (Axis) or pace. */
  coffeeCost: 0.5,
  /** Cost per space the move is off the pace it needs. */
  paceWeight: 10,
  /** Airplanes this many spaces ahead (and nearer) may be cleared with any die. */
  clearAnyDieAhead: 1,
};

/**
 * A cheap check of a placement against the rules: false when it's clearly
 * illegal, true when it's surely legal (the common spaces, nothing pending),
 * undefined when unsure — then the rules (reduce) decide. "Surely" is tested
 * against the rules on thousands of positions; rollouts trust it without a copy.
 */
export function placementCheck(s: GameState, crew: Crew, m: Place): boolean | undefined {
  if (s.phase !== "placement" || s.turn !== crew) return false;
  const die = s.dice[crew].find((d) => d.id === m.dieId);
  if (!die || die.placed || die.value === undefined) return false;
  const delta = m.coffeeDelta ?? 0;
  const v = die.value + delta;
  if (Math.abs(delta) > s.coffee || v < 1 || v > 6) return false;
  const t = m.target;
  if (t.kind !== "axis" && t.kind !== "engine" && t.kind !== "intern") {
    const inHand = s.dice[crew].filter((d) => !d.placed).length;
    const open = (s.axis[crew] === null ? 1 : 0) + (s.engines[crew] === null ? 1 : 0);
    if (inHand <= open) return false;
  }
  if ("side" in t && t.side !== undefined && t.side !== crew) return undefined;
  const fits = (() => {
    switch (t.kind) {
      case "axis":
        return s.axis[crew] === null;
      case "engine":
        return s.engines[crew] === null;
      case "radio":
        return crew === "pilot" ? t.slot === 0 && s.radioPilot === null : (t.slot === 0 || t.slot === 1) && s.radioCopilot[t.slot] === null;
      case "concentration":
        return (t.slot === 0 || t.slot === 1) && s.concentrationSlots[t.slot] == null;
      case "landingGear":
        return crew === "pilot" && s.gearSlots[t.slot] === null && (LANDING_GEAR_VALUES[t.slot] ?? []).includes(v as DieValue);
      case "flaps":
        return crew === "copilot" && s.flapSlots[t.slot] === null && (FLAPS_VALUES[t.slot] ?? []).includes(v as DieValue) &&
          (s.flapsGreen[t.slot] || t.slot === s.flapsGreen.findIndex((g) => !g));
      case "brakes":
        return crew === "pilot" && !s.brakeSlots[t.slot] && BRAKE_VALUES[t.slot] === v && t.slot <= s.brakesDeployed &&
          !s.scenario.modules?.includes("iceBrakes");
      default:
        return undefined; // Kerosene, Ice Brakes, the Intern: the rules decide
    }
  })();
  if (fits === false) return false;
  // Anything pending (a reroll, a swap, a held extra) or a paused clock: let the rules decide.
  if (fits === undefined || s.pendingReroll || s.pendingSwap || s.internHeld || s.trafficHeld || s.trafficPending || s.timerRemainingMs !== null) return undefined;
  return true;
}

/** placementCheck that only rules out clear misses. */
export const maybeLegal = (s: GameState, crew: Crew, m: Place): boolean => placementCheck(s, crew, m) !== false;
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
  const P = POLICY_PARAMS;
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

  // In a sampled world the partner's unplaced dice are known: assume it answers
  // with its best one (a hidden die — outside rollouts — counts as any face).
  const partnerDice = s.dice[partner].filter((d) => !d.placed && d.value !== undefined).map((d) => d.value!);
  // Axis: the tilt our die would leave against the partner's.
  const tiltWith = (v: number, theirs: number) => s.axis.offset + (crew === "pilot" ? v - theirs : theirs - v);
  const axisCost = (v: number) => {
    const theirs = s.axis[partner];
    if (theirs !== null) return Math.abs(tiltWith(v, theirs)) * 10;
    if (partnerDice.length) return Math.min(...partnerDice.map((w) => Math.abs(tiltWith(v, w)))) * 10;
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
    return (crashes(adv) ? 1000 : 0) + Math.abs(adv - want) * P.paceWeight;
  };
  const engineCost = (v: number) => {
    const theirs = s.engines[partner];
    if (theirs !== null) return speedCost(v + theirs + wind);
    if (partnerDice.length) return Math.min(...partnerDice.map((w) => speedCost(v + w + wind)));
    return [1, 2, 3, 4, 5, 6].reduce((a, f) => a + speedCost(v + f + wind), 0) / 6;
  };

  const axisOpen = s.axis[crew] === null;
  const engineOpen = s.engines[crew] === null;
  /** The best dice for our open Axis and Engine from `dice`, and how good they are. */
  // Within one choice the costs depend only on the value: work them out once for 1–6.
  const axisByValue = [0, 1, 2, 3, 4, 5, 6].map((v) => (v ? axisCost(v) : Infinity));
  const engineByValue = [0, 1, 2, 3, 4, 5, 6].map((v) => (v ? engineCost(v) : Infinity));
  const coffeeByValue = [0, 1, 2, 3, 4, 5, 6].map((v) => (v ? coffeeOptions(v) : []));
  const picks = (dice: typeof hand) => {
    const best = (byValue: number[], skip?: number) => {
      let pick: { d: (typeof hand)[number]; c: number; k: number } | null = null;
      for (const d of dice) {
        if (d.id === skip) continue;
        for (const c of coffeeByValue[d.value!]) {
          const k = byValue[d.value! + c] + Math.abs(c) * P.coffeeCost;
          if (!pick || k < pick.k) pick = { d, c, k };
        }
      }
      return pick;
    };
    const axis = axisOpen ? best(axisByValue) : null;
    const engine = engineOpen ? best(engineByValue, axis?.d.id) ?? best(engineByValue) : null;
    return { axis, engine, k: (axis?.k ?? 0) + (engine?.k ?? 0) };
  };
  const kept = picks(hand);
  const axisPick = kept.axis;
  const enginePick = kept.engine;
  // A die is spare if the Axis and Engine are served nearly as well without it.
  const spare = hand.filter((d) => picks(hand.filter((x) => x.id !== d.id)).k <= kept.k + P.spareSlack);

  // 1. Answer the partner's Axis / Engine die while it's known.
  if (axisPick && s.axis[partner] !== null) at(axisPick.d.id, { kind: "axis" }, axisPick.c);
  if (enginePick && s.engines[partner] !== null) at(enginePick.d.id, { kind: "engine" }, enginePick.c);
  // 2–3. Clear airplanes in the way; deploy switches with dice that fit (Coffee
  // may make one fit). When the crew is behind on its switches — as many left
  // as rounds to place them in — switches come before distant airplanes.
  const radioSlots: PlacementTarget[] = crew === "pilot" ? [{ kind: "radio", slot: 0 }] : [{ kind: "radio", slot: 0 }, { kind: "radio", slot: 1 }];
  // Free placements only use spare dice — the ones kept for the Axis and Engine
  // stay put (the rules force them onto those once nothing else is left).
  // (An airplane on our space or the next blocks the approach outright: any die may clear it.)
  const clearAirplanes = (from: number, to: number) => {
    for (let ahead = from; ahead <= to; ahead++) {
      if ((s.airplanes[s.position + ahead] ?? 0) === 0) continue;
      for (const d of ahead <= P.clearAnyDieAhead ? [...spare, ...hand] : spare) if (d.value === ahead + 1) for (const t of radioSlots) at(d.id, t);
    }
  };
  const switches = (withCoffee: boolean) => {
    for (const d of spare) {
      for (const c of withCoffee ? coffeeOptions(d.value!) : [0]) {
        const v = d.value! + c;
        if (crew === "pilot") {
          // Each Landing Gear raises the speed needed to fly on: lower them once
          // the approach is on schedule, or when they can't wait any longer.
          if (gearNow) LANDING_GEAR_VALUES.forEach((vals, slot) => !s.gearGreen[slot] && vals.includes(v as DieValue) && at(d.id, { kind: "landingGear", slot }, c));
          if (s.brakesDeployed < BRAKE_VALUES.length && BRAKE_VALUES[s.brakesDeployed] === v) at(d.id, { kind: "brakes", slot: s.brakesDeployed }, c);
        } else {
          const next = s.flapsGreen.findIndex((g) => !g);
          if (next >= 0 && FLAPS_VALUES[next].includes(v as DieValue)) at(d.id, { kind: "flaps", slot: next }, c);
        }
      }
    }
  };
  const switchesLeft =
    crew === "pilot"
      ? s.gearGreen.filter((g) => !g).length + Math.max(0, P.brakeGoal - s.brakesDeployed)
      : s.flapsGreen.filter((g) => !g).length;
  const roundsToPlace = Math.max(1, s.scenario.rounds - s.round + 1);
  const behind = switchesLeft >= roundsToPlace - P.behindSlack;
  const gearLeft = s.gearGreen.filter((g) => !g).length;
  const gearNow = gearLeft >= roundsToPlace - P.gearSlack || remaining <= roundsAfter + P.paceSlack;
  clearAirplanes(0, 1);
  if (behind) switches(true); // Coffee only when behind: it's also what levels the Axis
  clearAirplanes(2, 2);
  if (!behind) switches(false);
  // 4. Our own Axis and Engine with the dice kept for them.
  if (axisPick) at(axisPick.d.id, { kind: "axis" }, axisPick.c);
  if (enginePick) at(enginePick.d.id, { kind: "engine" }, enginePick.c);
  // 5. A spare die anywhere harmless: Concentration, a Radio.
  for (const d of spare) {
    at(d.id, { kind: "concentration", slot: 0 });
    at(d.id, { kind: "concentration", slot: 1 });
    for (const t of radioSlots) at(d.id, t);
  }
  const firstLegal = (list: Place[]): Place | null => {
    for (const cmd of list) {
      const sure = placementCheck(s, crew, cmd);
      if (sure === false) continue;
      if (sure) return cmd;
      try {
        reduce(s, cmd, playerIdOf(s, crew));
        return cmd;
      } catch (e) {
        if (!(e instanceof GameRuleError)) throw e;
      }
    }
    return null;
  };
  const planned = firstLegal(tries);
  if (planned) return planned;
  // 6. Catch-all, only when nothing planned fits: any die on any of the crew's
  // spaces, with Coffee if needed — so an odd die (one that fits only a set
  // switch, say) needs no Navigator.
  tries.length = 0;
  const anySpace: PlacementTarget[] = [
    { kind: "axis" },
    { kind: "engine" },
    ...radioSlots,
    { kind: "concentration", slot: 0 },
    { kind: "concentration", slot: 1 },
    ...[0, 1, 2].map((slot) => ({ kind: "landingGear" as const, slot })),
    ...[0, 1, 2, 3].map((slot) => ({ kind: "flaps" as const, slot })),
    ...[0, 1, 2].map((slot) => ({ kind: "brakes" as const, slot })),
  ];
  for (const d of [...spare, ...hand]) for (const c of coffeeOptions(d.value!)) for (const t of anySpace) at(d.id, t, c);
  const any = firstLegal(tries);
  if (any) return any;
  return chooseMove(s, crew, "navigator", rand); // nothing cheap fits: Navigator over all moves
}

/** Play on until the round changes or the game ends (full information, both crews). */
export function rolloutRound(state: GameState, rand: Rand, maxSteps = 40): GameState {
  const round = state.round;
  return rolloutInPlace(structuredClone(state), rand, maxSteps, (s) => s.round !== round);
}

/** Play on to the end of the game (full information, both crews). */
export function rolloutGame(state: GameState, rand: Rand, maxSteps = 400): GameState {
  return rolloutInPlace(structuredClone(state), rand, maxSteps, () => false);
}

/** A rollout on a world the caller owns (e.g. a fresh sample): moves are
 *  applied to it directly — no copy per move. */
export function rolloutInPlace(state: GameState, rand: Rand, maxSteps = 400, stop: (s: GameState) => boolean = () => false): GameState {
  let s = state;
  const now = () => 0;
  for (let i = 0; i < maxSteps && !s.outcome && !stop(s); i++) {
    const crew = actorFor(s);
    if (!crew) break;
    const move = fastMove(s, crew, rand);
    if (!move) break;
    s = applyIntentInPlace(s, move, playerIdOf(s, crew), rand, now);
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
