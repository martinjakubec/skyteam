import type { GameCommand, PlacementTarget } from "../protocol";
import { applyIntentInPlace, type Rand } from "../game/entropy";
import { GameRuleError, landingChecks, reduce } from "../game/reducer";
import { BRAKE_VALUES, FLAPS_VALUES, ICE_BRAKE_VALUES, KEROSENE_IDLE_BURN, LANDING_GEAR_VALUES, WIND_RING, type Crew, type DieValue } from "../game/scenario";
import { airportIndex, nextInternToken, type GameState } from "../game/state";
import { actorFor } from "./actor";
import { evaluate, WIN } from "./evaluate";
import { playerIdOf } from "./moves";
import { quickMove } from "./policy";

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

/** The switch spaces (a die that fits a set one goes there with no effect). */
const SWITCH_SPACES: PlacementTarget[] = [
  ...[0, 1, 2].map((slot) => ({ kind: "landingGear" as const, slot })),
  ...[0, 1, 2, 3].map((slot) => ({ kind: "flaps" as const, slot })),
  ...[0, 1, 2].map((slot) => ({ kind: "brakes" as const, slot })),
];
const ICE_BRAKE_SPACES: PlacementTarget[] = [0, 1, 2, 3].flatMap((slot) =>
  (["top", "bottom"] as const).map((space) => ({ kind: "iceBrakes" as const, slot, space })),
);

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
  /** Kerosene: the highest die fed to it at once ("share": this round's share
   *  of the fuel left); otherwise only the crew's last free die feeds it. */
  keroseneEarly: 2 as number | "share",
  /** Kerosene Leak: cost per point of fuel the Engine dice would leak. */
  leakWeight: 4,
  /** In a sampled world, plan the Axis/Engine against the partner's (sampled)
   *  hand. Off (default): only against what a player could know — the partner's
   *  dice already down, else any face — as real partners can't see each other's
   *  dice. Measured: off lands more (59% vs 54% of 160 YUL games, far fewer crashes). */
  peek: false,
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
 * anything legal. Prompts (held extras, reroll/swap answers) go to the quick strategy.
 */
export function fastMove(s: GameState, crew: Crew, rand: Rand): GameCommand | null {
  const P = POLICY_PARAMS;
  const held = s.internHeld?.crew === crew ? s.internHeld.value : null;
  if ((s.internHeld && held === null) || s.trafficHeld || s.pendingSwap) return quickMove(s, crew, rand);
  if (s.pendingReroll) return { type: "reroll", dieIds: [] }; // keep our dice
  const hand = s.dice[crew].filter((d) => !d.placed && d.value !== undefined);
  if (!hand.length && held === null) return null;
  const mods = s.scenario.modules ?? [];
  const ice = mods.includes("iceBrakes");
  const landing = s.round >= s.scenario.rounds;
  const partner = other(crew);
  const tries: Place[] = [];
  const at = (dieId: number, target: PlacementTarget, coffeeDelta = 0) =>
    tries.push({ type: "placeDie", dieId, target, ...(coffeeDelta ? { coffeeDelta } : {}) });
  const coffeeOptions = (v: number) =>
    Array.from({ length: 2 * s.coffee + 1 }, (_, i) => i - s.coffee).filter((d) => v + d >= 1 && v + d <= 6).sort((a, b) => Math.abs(a) - Math.abs(b));

  // In a sampled world the partner's unplaced dice are known: assume it answers
  // with its best one (a hidden die — outside rollouts — counts as any face).
  const partnerDice = P.peek ? s.dice[partner].filter((d) => !d.placed && d.value !== undefined).map((d) => d.value!) : [];
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
  const steps = ice ? ICE_BRAKE_VALUES : BRAKE_VALUES;
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
  // Kerosene Leak: the Engine dice drain |difference| + 1 a round — matching them saves fuel.
  const leakOn = mods.includes("keroseneLeak");
  const pairCost = (v: number, w: number) => speedCost(v + w + wind) + (leakOn ? (Math.abs(v - w) + 1) * P.leakWeight : 0);
  const engineCost = (v: number) => {
    const theirs = s.engines[partner];
    if (theirs !== null) return pairCost(v, theirs);
    if (partnerDice.length) return Math.min(...partnerDice.map((w) => pairCost(v, w)));
    return [1, 2, 3, 4, 5, 6].reduce((a, f) => a + pairCost(v, f), 0) / 6;
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
  /** The switches a die of value `v` would deploy now. */
  const switchTargets = (v: number): PlacementTarget[] => {
    // Ice Brakes first: eight dice of set values, two each in one round.
    const out: PlacementTarget[] = iceTargets(v);
    if (crew === "pilot") {
      // Each Landing Gear raises the speed needed to fly on: lower them once
      // the approach is on schedule, or when they can't wait any longer.
      if (gearNow) LANDING_GEAR_VALUES.forEach((vals, slot) => !s.gearGreen[slot] && vals.includes(v as DieValue) && out.push({ kind: "landingGear", slot }));
      if (!ice && s.brakesDeployed < BRAKE_VALUES.length && BRAKE_VALUES[s.brakesDeployed] === v) out.push({ kind: "brakes", slot: s.brakesDeployed });
    } else {
      const next = s.flapsGreen.findIndex((g) => !g);
      if (next >= 0 && FLAPS_VALUES[next].includes(v as DieValue)) out.push({ kind: "flaps", slot: next });
    }
    return out;
  };
  /** Ice Brakes: start the next step only with a fair chance to finish it this
   *  round (a lone half is cleared at the round's end) — finishing one is iceFinish. */
  function iceTargets(v: number): PlacementTarget[] {
    const out: PlacementTarget[] = [];
    const step = s.brakesDeployed;
    if (ice && step < ICE_BRAKE_VALUES.length && ICE_BRAKE_VALUES[step] === v && iceStartable) {
      if (crew === "pilot" && s.iceBrakeSlots[step].top === null) out.push({ kind: "iceBrakes", slot: step, space: "top" });
      if (s.iceBrakeSlots[step].bottom === null) out.push({ kind: "iceBrakes", slot: step, space: "bottom" });
    }
    return out;
  }
  // Ice Brakes, the next step: started (one half filled) — finish it, Coffee and all;
  // not started — start it holding both dice (Pilot), or while the partner still
  // has dice enough to answer.
  const iceStep = ice && s.brakesDeployed < ICE_BRAKE_VALUES.length ? s.iceBrakeSlots[s.brakesDeployed] : null;
  const iceNeed = ice ? ICE_BRAKE_VALUES[s.brakesDeployed] : 0;
  const iceHalf = iceStep !== null && (iceStep.top === null) !== (iceStep.bottom === null);
  const partnerLeft = s.dice[partner].filter((d) => !d.placed).length;
  const iceStartable =
    iceStep !== null && iceStep.top === null && iceStep.bottom === null &&
    ((crew === "pilot" && spare.filter((d) => d.value === iceNeed).length >= 2) || partnerLeft >= 2);
  const iceFinish = () => {
    if (!iceHalf) return;
    const space = iceStep!.top === null ? "top" : "bottom";
    if (space === "top" && crew !== "pilot") return;
    for (const d of spare) for (const c of coffeeOptions(d.value!)) if (d.value! + c === iceNeed) at(d.id, { kind: "iceBrakes", slot: s.brakesDeployed, space }, c);
  };
  const switches = (withCoffee: boolean) => {
    for (const d of spare) {
      for (const c of withCoffee ? coffeeOptions(d.value!) : [0]) for (const t of switchTargets(d.value! + c)) at(d.id, t, c);
    }
  };
  const iceLeft = ice ? ICE_BRAKE_VALUES.length - s.brakesDeployed : 0;
  const switchesLeft =
    crew === "pilot"
      ? s.gearGreen.filter((g) => !g).length + (ice ? iceLeft : Math.max(0, P.brakeGoal - s.brakesDeployed))
      : s.flapsGreen.filter((g) => !g).length + iceLeft;
  const roundsToPlace = Math.max(1, s.scenario.rounds - s.round + 1);
  const behind = switchesLeft >= roundsToPlace - P.behindSlack;
  const gearLeft = s.gearGreen.filter((g) => !g).length;
  const gearNow = gearLeft >= roundsToPlace - P.gearSlack || remaining <= roundsAfter + P.paceSlack;
  // Kerosene: one die a round burns its value; an empty space burns 6 at the
  // round's end. A low spare die goes there early; late in the round any die
  // under 6 beats the idle burn — never one that would empty the tank.
  const keroOpen = mods.includes("kerosene") && s.keroseneSlot == null;
  const keroSafe = (v: number) => keroOpen && v < KEROSENE_IDLE_BURN && v < s.kerosene;
  const kerosene = (max: number, keepSwitchDice = false) => {
    const pool = keepSwitchDice ? spare.filter((x) => switchTargets(x.value!).length === 0) : spare;
    const d = pool.reduce<(typeof hand)[number] | null>((m, x) => (!m || x.value! < m.value! ? x : m), null);
    if (!d) return;
    if (d.value! <= max && keroSafe(d.value!)) return at(d.id, { kind: "kerosene" });
    // Coffee may bring it down to burn less.
    const c = -Math.min(s.coffee, d.value! - 1);
    if (c < 0 && d.value! + c <= max && keroSafe(d.value! + c)) at(d.id, { kind: "kerosene" }, c);
  };
  // Intern: every token must be trained by the landing. Training takes a die of
  // another value than the next token and hands over the token, placed at once.
  const internNext = mods.includes("intern") && s.internSlots[crew] === null ? nextInternToken(s, crew) : -1;
  const train = () => {
    if (internNext < 0) return;
    const token = s.internTokens[internNext];
    for (const d of spare) if (d.value !== token) at(d.id, { kind: "intern", side: crew });
  };
  // A low die feeds Kerosene at once (keroseneEarly); failing that, the crew's
  // last free die does (anything under the idle 6).
  const freeDice = hand.length - (axisOpen ? 1 : 0) - (engineOpen ? 1 : 0);
  const keroShare = Math.max(1, Math.floor((s.kerosene - 1) / roundsToPlace));
  if (held !== null) return internMove(held);
  clearAirplanes(0, 1);
  iceFinish();
  // (Early on, not a die a switch could use: the low dice are also the first Flaps and Gear.)
  kerosene(freeDice <= 1 ? KEROSENE_IDLE_BURN - 1 : P.keroseneEarly === "share" ? keroShare : P.keroseneEarly, freeDice > 1);
  if (behind) switches(true); // Coffee only when behind: it's also what levels the Axis
  clearAirplanes(2, 2);
  if (!behind) switches(false);
  train();
  // 4. Our own Axis and Engine with the dice kept for them.
  if (axisPick) at(axisPick.d.id, { kind: "axis" }, axisPick.c);
  if (enginePick) at(enginePick.d.id, { kind: "engine" }, enginePick.c);
  // 5. A spare die anywhere harmless: Kerosene (under the idle burn), Concentration, a Radio.
  kerosene(KEROSENE_IDLE_BURN - 1);
  for (const d of spare) {
    at(d.id, { kind: "concentration", slot: 0 });
    at(d.id, { kind: "concentration", slot: 1 });
    for (const t of radioSlots) at(d.id, t);
  }
  /** Where the Intern's token goes: like a die — answer the partner's Axis or
   *  Engine, clear an airplane, deploy a switch, Kerosene, our own Axis or
   *  Engine if it serves them as well as the die kept for them — else anywhere. */
  function internMove(v: number): GameCommand | null {
    const targets: PlacementTarget[] = [];
    if (axisOpen && s.axis[partner] !== null && axisByValue[v] <= (axisPick?.k ?? Infinity)) targets.push({ kind: "axis" });
    if (engineOpen && s.engines[partner] !== null && engineByValue[v] <= (enginePick?.k ?? Infinity)) targets.push({ kind: "engine" });
    const ahead = v - 1;
    if (ahead <= 2 && (s.airplanes[s.position + ahead] ?? 0) > 0) targets.push(...radioSlots);
    targets.push(...switchTargets(v));
    if (keroSafe(v) && v <= 3) targets.push({ kind: "kerosene" });
    if (axisOpen && axisByValue[v] <= (axisPick?.k ?? Infinity)) targets.push({ kind: "axis" });
    if (engineOpen && engineByValue[v] <= (enginePick?.k ?? Infinity)) targets.push({ kind: "engine" });
    if (keroSafe(v)) targets.push({ kind: "kerosene" });
    targets.push(...radioSlots, { kind: "axis" }, { kind: "engine" }, ...SWITCH_SPACES, ...(ice ? ICE_BRAKE_SPACES : []));
    for (const target of targets) {
      const cmd: GameCommand = { type: "placeIntern", target };
      try {
        reduce(s, cmd, playerIdOf(s, crew));
        return cmd;
      } catch (e) {
        if (!(e instanceof GameRuleError)) throw e;
      }
    }
    return quickMove(s, crew, rand);
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
  // switch, say) needs no quick strategy.
  tries.length = 0;
  const anySpace: PlacementTarget[] = [
    { kind: "axis" },
    { kind: "engine" },
    ...radioSlots,
    { kind: "concentration", slot: 0 },
    { kind: "concentration", slot: 1 },
    ...SWITCH_SPACES,
    ...(ice ? ICE_BRAKE_SPACES : []),
  ];
  for (const d of [...spare, ...hand]) {
    for (const c of coffeeOptions(d.value!)) {
      for (const t of anySpace) at(d.id, t, c);
      if (keroSafe(d.value! + c)) at(d.id, { kind: "kerosene" }, c);
    }
  }
  const any = firstLegal(tries);
  if (any) return any;
  return quickMove(s, crew, rand); // nothing cheap fits: the quick strategy over all moves
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
/** Credit toward a module's landing check short of meeting it: Ice Brakes
 *  steps deployed, Intern tokens trained (each a share of one check's 400). */
function moduleProgress(s: GameState): number {
  let v = 0;
  const mods = s.scenario.modules ?? [];
  if (mods.includes("iceBrakes") && s.brakesDeployed < ICE_BRAKE_VALUES.length) v += (s.brakesDeployed / ICE_BRAKE_VALUES.length) * 300;
  if (mods.includes("intern")) {
    const left = s.internTokens.filter((t) => t !== null).length;
    if (left > 0) v += (1 - left / s.internTokens.length) * 300;
  }
  return v;
}

export function rolloutValue(s: GameState, crew: Crew): number {
  if (!s.outcome) return evaluate(s, crew);
  if (s.outcome.result === "won") return WIN;
  if (s.outcome.reason.startsWith("Landing failed")) {
    const met = Object.values(landingChecks(s)).filter(Boolean).length;
    return -WIN / 2 + met * 400 + moduleProgress(s);
  }
  return -WIN + s.round * 300;
}
