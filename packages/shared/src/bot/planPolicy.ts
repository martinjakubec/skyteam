import type { GameCommand, PlacementTarget } from "../protocol";
import { GameRuleError, reduce } from "../game/reducer";
import { BRAKE_VALUES, FLAPS_VALUES, LANDING_GEAR_VALUES, MAX_COFFEE, WIND_RING, type Crew } from "../game/scenario";
import { type GameState } from "../game/state";
import { playerIdOf } from "./moves";
import { flightPlan, planTarget, turnBlocks, turnTarget } from "./plan";

/**
 * A card's scripted plan: the crew decides where all its dice go this round
 * before placing any of them, instead of grabbing the best-looking spot die by
 * die (which leaves the last dice forced into a collision or an unlevel
 * landing). Every assignment of the crew's own dice — Axis, Engine and the
 * free spaces (Radio, switches, Concentration), Coffee included — is scored
 * against the board's flight plan, and the die the best assignment says to
 * place first is played. Sees only what its seat sees: the partner's unplaced
 * dice count as any face.
 *
 * Returns null when it has nothing to say (prompts, held extras, modules it
 * doesn't plan for); the caller falls back to the general policy.
 */
export interface PlanWeights {
  /** Clearing an airplane (any distance), and extra for the current space when the plan moves. */
  clear: number;
  clearHere: number;
  /** A switch down; ×urgent once the crew has as many left as dice to place them with. */
  gear: number;
  flaps: number;
  brakes: number;
  urgent: number;
  /** Switches count as urgent once the crew has this many fewer rounds left than switches… */
  switchSlack: number;
  /** A Coffee gained (Concentration) / spent. */
  coffeeGain: number;
  coffeeSpend: number;
  /** Per pip of expected tilt; a likely spin or unlevel landing. */
  tilt: number;
  fatal: number;
  /** Per space short of / beyond the move the plan wants this round. */
  behind: number;
  ahead: number;
  /** Per pip the first Engine die is off half the speed the plan wants. */
  engineMid: number;
  /** Also drive the rollouts (slower: fewer samples). Otherwise the plan's move is a search candidate. */
  rollouts?: boolean;
  /** Points added to the plan's move's rollout average when the search picks (breaks near-ties). */
  searchBias?: number;
}

export const PLAN_WEIGHTS: PlanWeights = {
  clear: 120,
  clearHere: 200,
  gear: 70,
  flaps: 80,
  brakes: 80,
  urgent: 3,
  switchSlack: 1,
  coffeeGain: 15,
  coffeeSpend: 6,
  tilt: 40,
  fatal: 5000,
  behind: 60,
  ahead: 30,
  engineMid: 15,
};

const FACES = [1, 2, 3, 4, 5, 6];
/** A partner's die still to come: they pick the better of two they might hold. */
function partnerBest(value: (face: number) => number): number {
  let sum = 0;
  for (const a of FACES) for (const b of FACES) sum += Math.max(value(a), value(b));
  return sum / 36;
}
type Die = { id: number; value: number };
/** A free space a die can take: where, and with which value it does something. */
type Extra = { target: PlacementTarget; kind: "radio" | "gear" | "flaps" | "brakes" | "concentration"; slot: number };

interface Assignment {
  axis?: { die: Die; delta: number };
  engine?: { die: Die; delta: number };
  extras: { die: Die; delta: number; extra: Extra }[];
  score: number;
}

export function planMove(s: GameState, crew: Crew, W: PlanWeights = PLAN_WEIGHTS): GameCommand | null {
  if (s.phase !== "placement" || s.turn !== crew) return null;
  if (s.pendingReroll || s.pendingSwap || s.internHeld || s.trafficHeld || s.trafficPending) return null;
  const mods = s.scenario.modules ?? [];
  if (mods.some((m) => m !== "wind")) return null; // Kerosene, Ice Brakes, Intern…: not planned for (yet)
  const hand: Die[] = s.dice[crew].filter((d) => !d.placed && d.value !== undefined).map((d) => ({ id: d.id, value: d.value! }));
  if (hand.length === 0) return null;
  const best = bestAssignment(s, crew, hand, W);
  if (!best) return null;
  return firstPlacement(s, crew, best);
}

const other = (c: Crew): Crew => (c === "pilot" ? "copilot" : "pilot");

function bestAssignment(s: GameState, crew: Crew, hand: Die[], W: PlanWeights): Assignment | null {
  const axisOpen = s.axis[crew] === null;
  const engineOpen = s.engines[crew] === null;
  let best: Assignment | null = null;
  // Each die: Axis, Engine, or a free space. Hands are at most 4 dice: try every split.
  const roles = (axisOpen ? 1 : 0) + (engineOpen ? 1 : 0);
  if (hand.length < roles) return null;
  const n = hand.length;
  for (let ai = axisOpen ? 0 : -1; ai < (axisOpen ? n : 0); ai++) {
    for (let ei = engineOpen ? 0 : -1; ei < (engineOpen ? n : 0); ei++) {
      if (ai >= 0 && ai === ei) continue;
      const rest = hand.filter((_, i) => i !== ai && i !== ei);
      for (const a of choose(s, crew, ai >= 0 ? hand[ai] : undefined, ei >= 0 ? hand[ei] : undefined, rest, W)) {
        if (!best || a.score > best.score) best = a;
      }
    }
  }
  return best;
}

/** The best ways to use Axis die `ax`, Engine die `en` and the rest: Coffee on the Axis/Engine tried, extras greedy. */
function* choose(s: GameState, crew: Crew, ax: Die | undefined, en: Die | undefined, rest: Die[], W: PlanWeights): Generator<Assignment> {
  const coffee = s.coffee;
  const deltas = (d: Die | undefined) => (d ? FACES.map((_, i) => i - coffee).filter((x) => Math.abs(x) <= coffee && d.value + x >= 1 && d.value + x <= 6) : [0]);
  for (const da of deltas(ax)) {
    for (const de of deltas(en)) {
      const spent = Math.abs(da) + Math.abs(de);
      if (spent > coffee) continue;
      // On the landing round the Coffee left is kept for the Axis (it has to end level).
      const landing = s.round >= s.scenario.rounds;
      const extras = assignExtras(s, crew, rest, landing && s.axis[crew] === null ? 0 : coffee - spent, W);
      const plannedClears = new Map<number, number>();
      for (const x of extras.list) if (x.extra.kind === "radio") {
        const at = s.position + (x.die.value + x.delta) - 1;
        if ((s.airplanes[at] ?? 0) > 0) plannedClears.set(at, (plannedClears.get(at) ?? 0) + 1);
      }
      const brakesAfter = s.brakesDeployed + extras.list.filter((x) => x.extra.kind === "brakes").length;
      const score =
        extras.score - spent * W.coffeeSpend +
        (ax ? axisScore(s, crew, ax.value + da, W) : 0) +
        (en ? engineScore(s, crew, en.value + de, plannedClears, brakesAfter, ax ? ax.value + da : null, W) : 0);
      yield {
        axis: ax ? { die: ax, delta: da } : undefined,
        engine: en ? { die: en, delta: de } : undefined,
        extras: extras.list,
        score,
      };
    }
  }
}

/** Free spaces for the extra dice, chosen greedily (highest value first), with Coffee left over. */
function assignExtras(s: GameState, crew: Crew, dice: Die[], coffeeLeft: number, W: PlanWeights) {
  const list: Assignment["extras"] = [];
  let score = 0;
  const planes = [...s.airplanes];
  let radios = crew === "pilot" ? (s.radioPilot === null ? 1 : 0) : s.radioCopilot.filter((r) => r === null).length;
  let conc = s.concentrationSlots.filter((c) => c == null).length;
  const gear = [...s.gearGreen];
  const flaps = [...s.flapsGreen];
  let brakes = s.brakesDeployed;
  let coffee = s.coffee;
  const roundsToPlace = Math.max(1, s.scenario.rounds - s.round + 1);
  const switchesLeft = () => (crew === "pilot" ? gear.filter((g) => !g).length + (BRAKE_VALUES.length - brakes) : flaps.filter((f) => !f).length);
  // Switches need set values, in order for the Flaps: about one a round is the
  // pace that gets them all down — urgent once the crew falls behind it.
  const urgency = () => (switchesLeft() >= roundsToPlace - W.switchSlack ? W.urgent : 1);
  const want = moveWanted(s);
  const left = [...dice];
  // Greedy by worth: each step places the die-and-space pair worth the most now
  // (so a 2 that clears the next space beats a 5 that clears a far one for the
  // single Pilot Radio).
  while (left.length > 0) {
    let pick: { die: Die; delta: number; extra: Extra; gain: number } | null = null;
    const net = (x: { delta: number; gain: number }) => x.gain - Math.abs(x.delta) * W.coffeeSpend;
    for (const die of left) {
    const consider = (delta: number, extra: Extra, gain: number) => {
      if (!pick || net({ delta, gain }) > net(pick)) pick = { die, delta, extra, gain };
    };
    for (let delta = -coffeeLeft; delta <= coffeeLeft; delta++) {
      const v = die.value + delta;
      if (v < 1 || v > 6) continue;
      if (radios > 0) {
        const at = s.position + v - 1;
        // The spaces this round's move and the next fly off must be clear in time.
        const here = at - s.position <= want;
        consider(delta, { target: { kind: "radio", slot: radioSlot(s, crew, list) }, kind: "radio", slot: 0 }, (planes[at] ?? 0) > 0 ? W.clear + (here ? W.clearHere : 0) : -2);
      }
      if (crew === "pilot") {
        const g = LANDING_GEAR_VALUES.findIndex((vals, i) => !gear[i] && vals.includes(v as never));
        if (g >= 0) consider(delta, { target: { kind: "landingGear", slot: g }, kind: "gear", slot: g }, W.gear * urgency());
        if (brakes < BRAKE_VALUES.length && BRAKE_VALUES[brakes] === v) consider(delta, { target: { kind: "brakes", slot: brakes }, kind: "brakes", slot: brakes }, W.brakes * urgency());
      } else {
        const f = flaps.findIndex((g) => !g);
        if (f >= 0 && FLAPS_VALUES[f].includes(v as never)) consider(delta, { target: { kind: "flaps", slot: f }, kind: "flaps", slot: f }, W.flaps * urgency());
      }
      if (delta === 0 && conc > 0) consider(0, { target: { kind: "concentration", slot: concSlot(s, list) }, kind: "concentration", slot: 0 }, coffee < MAX_COFFEE ? W.coffeeGain : 0);
    }
    }
    if (!pick) break; // nowhere useful: left for the rules to decide (the caller falls back)
    const p = pick as { die: Die; delta: number; extra: Extra; gain: number };
    const die = p.die;
    left.splice(left.indexOf(die), 1);
    list.push({ die, delta: p.delta, extra: p.extra });
    score += p.gain - Math.abs(p.delta) * W.coffeeSpend;
    coffeeLeft -= Math.abs(p.delta);
    coffee -= Math.abs(p.delta);
    const v = die.value + p.delta;
    if (p.extra.kind === "radio") {
      radios -= 1;
      const at = s.position + v - 1;
      if ((planes[at] ?? 0) > 0) planes[at] -= 1;
    } else if (p.extra.kind === "gear") gear[p.extra.slot] = true;
    else if (p.extra.kind === "flaps") flaps[p.extra.slot] = true;
    else if (p.extra.kind === "brakes") brakes += 1;
    else if (p.extra.kind === "concentration") { conc -= 1; coffee = Math.min(MAX_COFFEE, coffee + 1); }
  }
  return { list, score };
}

const radioSlot = (s: GameState, crew: Crew, used: Assignment["extras"]) => {
  if (crew === "pilot") return 0;
  const taken = used.filter((x) => x.extra.kind === "radio").length;
  const free = [0, 1].filter((i) => s.radioCopilot[i] === null);
  return free[taken] ?? free[0] ?? 0;
};
const concSlot = (s: GameState, used: Assignment["extras"]) => {
  const taken = used.filter((x) => x.extra.kind === "concentration").length;
  const free = [0, 1].filter((i) => s.concentrationSlots[i] == null);
  return free[taken] ?? free[0] ?? 0;
};

/** Spaces the plan wants the plane to fly this round (0 on the landing round). */
function moveWanted(s: GameState): number {
  if (s.round >= s.scenario.rounds) return 0;
  const plan = flightPlan(s.scenario);
  const remaining = plan.airport - s.position;
  const roundsAfter = Math.max(0, s.scenario.rounds - s.round - 1);
  return Math.max(0, Math.min(2, remaining, Math.max(planTarget(s) - s.position, Math.ceil(remaining / (roundsAfter + 1)))));
}

/** The Axis die `v` for this crew: expected tilt against the partner's die (known, or any face). */
function axisScore(s: GameState, crew: Crew, v: number, W: PlanWeights): number {
  const theirs = s.axis[other(crew)];
  const landing = s.round >= s.scenario.rounds;
  const goal = landing ? 0 : turnTarget(s, moveWanted(s)) ?? 0;
  const tiltWith = (t: number) => s.axis.offset + (crew === "pilot" ? v - t : t - v);
  const cost = (tilt: number) =>
    (Math.abs(tilt) >= s.scenario.axisSpinAt || (landing && tilt !== 0) ? W.fatal : 0) + Math.abs(tilt - goal) * W.tilt;
  if (theirs !== null) return -cost(tiltWith(theirs));
  return partnerBest((f) => -cost(tiltWith(f)));
}

/**
 * The Engine die `v`: where the speed takes the plane against the plan — a
 * collision (an airplane on a space flown off, after this crew's planned
 * clears), an overshoot or a missed turn is fatal; on the landing round the
 * speed must stay within the Brakes this crew will have.
 */
function engineScore(s: GameState, crew: Crew, v: number, cleared: Map<number, number>, brakesAfter: number, axisV: number | null, W: PlanWeights): number {
  const theirs = s.engines[other(crew)];
  const wind = s.scenario.modules?.includes("wind") ? WIND_RING[s.windPosition] : 0;
  const landing = s.round >= s.scenario.rounds;
  const want = moveWanted(s);
  const plan = flightPlan(s.scenario);
  const outcome = (t: number, now: boolean) => {
    const speed = v + t + wind;
    if (landing) return speed <= (brakesAfter > 0 ? BRAKE_VALUES[brakesAfter - 1] : 0) ? 0 : -W.fatal;
    const adv = speed <= s.aeroBlue ? 0 : speed > s.aeroOrange ? 2 : 1;
    for (let step = 0; step < adv; step++) {
      const at = s.position + step;
      const left = (s.airplanes[at] ?? 0) - (cleared.get(at) ?? 0);
      if (left > 0 || at >= plan.airport) return -W.fatal;
    }
    if (adv > 0 && turnBlocks(s, adv, now && axisV === null)) return -W.fatal;
    return adv < want ? -(want - adv) * W.behind : -(adv - want) * W.ahead;
  };
  if (theirs !== null) return outcome(theirs, true);
  // First Engine die: about half the speed the plan wants, so the partner can
  // complete it (each crew assuming the other will cover leaves the plane stalled).
  const target = landing ? Math.min(brakesAfter > 0 ? BRAKE_VALUES[brakesAfter - 1] : 2, s.aeroBlue) : want === 0 ? s.aeroBlue : want === 1 ? (s.aeroBlue + 1 + s.aeroOrange) / 2 : s.aeroOrange + 2;
  return partnerBest((f) => outcome(f, false)) - Math.abs(v + wind / 2 - target / 2) * W.engineMid;
}

/**
 * Which die to place now. Answer the partner's known Axis / Engine die; clear
 * the current space before anything can move the plane; then the other free
 * dice; the crew's own Axis, and its Engine last.
 */
function firstPlacement(s: GameState, crew: Crew, a: Assignment): GameCommand | null {
  const partner = other(crew);
  type Place = Extract<GameCommand, { type: "placeDie" }>;
  const tries: Place[] = [];
  const place = (die: Die, target: PlacementTarget, delta: number): Place => ({ type: "placeDie", dieId: die.id, target, ...(delta ? { coffeeDelta: delta } : {}) });
  if (a.axis && s.axis[partner] !== null) tries.push(place(a.axis.die, { kind: "axis" }, a.axis.delta));
  const here = a.extras.filter((x) => x.extra.kind === "radio" && x.die.value + x.delta === 1);
  for (const x of here) tries.push(place(x.die, x.extra.target, x.delta));
  if (a.engine && s.engines[partner] !== null && here.length === 0) tries.push(place(a.engine.die, { kind: "engine" }, a.engine.delta));
  for (const x of a.extras) if (!here.includes(x)) tries.push(place(x.die, x.extra.target, x.delta));
  if (a.axis) tries.push(place(a.axis.die, { kind: "axis" }, a.axis.delta));
  if (a.engine) tries.push(place(a.engine.die, { kind: "engine" }, a.engine.delta));
  for (const cmd of tries) {
    try {
      reduce(s, cmd, playerIdOf(s, crew));
      return cmd;
    } catch (e) {
      if (!(e instanceof GameRuleError)) throw e;
    }
  }
  return null;
}
