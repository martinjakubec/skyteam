import type { GameCommand, PlacementTarget } from "../protocol";
import { GameRuleError, reduce } from "../game/reducer";
import { BRAKE_VALUES, FLAPS_VALUES, ICE_BRAKE_VALUES, KEROSENE_IDLE_BURN, LANDING_GEAR_VALUES, MAX_COFFEE, WIND_RING, type Crew } from "../game/scenario";
import { firstPlayerForRound, hasAbility, nextInternToken, type GameState } from "../game/state";
import { playerIdOf } from "./moves";
import { flightPlan, planTarget, turnBlocks, turnTarget } from "./plan";
import { placementCheck } from "./rollout";

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
  /** Kerosene: per point of fuel a die saves against the idle burn (and per point short of what the rounds left need). */
  kerosene: number;
  /** Kerosene Leak: per point the Engine dice will leak (their difference + 1). */
  leak: number;
  /** Intern: training once (×urgent when the tokens left are more than the rounds to train them). */
  intern: number;
  /** Special Abilities: how much better the hand must get to turn a die over (Adaptation, once a
   *  game), reroll one (Anticipation), or offer one (Working Together). */
  adaptGain: number;
  anticipateGain: number;
  swapGain: number;
  /** Control / Mastery: a die matching the partner's Axis / Engine die (a Coffee / a Reroll back). */
  pairBonus: number;
  /** Also drive the rollouts (slower: fewer samples). Otherwise the plan's move is a search candidate. */
  rollouts?: boolean;
  /** Points added to the plan's move's rollout average when the search picks (breaks near-ties). */
  searchBias?: number;
  /** A Landing Gear is worth a fifth while the plane is behind its plan. */
  gearOnPace?: boolean;
  /** Hold this tilt the whole approach (a card whose turns all allow it); level for the landing. */
  tiltHold?: number;
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
  kerosene: 50,
  leak: 30,
  intern: 90,
  adaptGain: 150,
  anticipateGain: 60,
  swapGain: 120,
  pairBonus: 40,
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
type Extra = { target: PlacementTarget; kind: "radio" | "gear" | "flaps" | "brakes" | "concentration" | "kerosene" | "intern" | "iceBrakes"; slot: number };

interface Assignment {
  axis?: { die: Die; delta: number };
  engine?: { die: Die; delta: number };
  extras: { die: Die; delta: number; extra: Extra }[];
  score: number;
}

export function planMove(s: GameState, crew: Crew, W: PlanWeights = PLAN_WEIGHTS): GameCommand | null {
  if (s.phase !== "placement") return null;
  // Synchronisation: the Co-Pilot places the held Traffic die where it counts most.
  if (s.trafficHeld) return crew === "copilot" ? placeTraffic(s, W) : null;
  // Working Together: answer the partner's offer with the die we'll miss least.
  if (s.pendingSwap) return s.pendingSwap.from !== crew ? answerSwap(s, crew, W) : null;
  if (s.turn !== crew) return null;
  if (s.pendingReroll || s.internHeld || s.trafficPending) return null;
  // (Every module of the base Flight Log is planned for: Real-Time only adds a clock.)
  const hand: Die[] = s.dice[crew].filter((d) => !d.placed && d.value !== undefined).map((d) => ({ id: d.id, value: d.value! }));
  if (hand.length === 0) return null;
  const best = bestAssignment(s, crew, hand, W);
  if (!best) return null;
  return abilityMove(s, crew, hand, best.score, W) ?? firstPlacement(s, crew, best);
}

/** A hand's worth: its best assignment's score (−∞ when nothing fits). */
const handScore = (s: GameState, crew: Crew, hand: Die[], W: PlanWeights) => bestAssignment(s, crew, hand, W)?.score ?? -Infinity;
const withValue = (hand: Die[], i: number, value: number): Die[] => hand.map((d, j) => (j === i ? { id: d.id, value } : d));
/** The expected worth of the hand with die i rerolled (any face). */
const rerolled = (s: GameState, crew: Crew, hand: Die[], i: number, W: PlanWeights) =>
  FACES.reduce((a, f) => a + handScore(s, crew, withValue(hand, i, f), W), 0) / 6;

/**
 * Special Abilities the crew can play before placing a die: Adaptation turns a
 * die over when that makes the hand clearly better (once a game: worth saving),
 * Anticipation rerolls the die whose expected replacement beats keeping it,
 * Working Together offers a die likewise (the partner's answer is any face).
 */
function abilityMove(s: GameState, crew: Crew, hand: Die[], now: number, W: PlanWeights): GameCommand | null {
  const legal = (cmd: GameCommand) => {
    try {
      reduce(s, cmd.type === "anticipate" ? { ...cmd, value: 1 } : (cmd as never), playerIdOf(s, crew));
      return true;
    } catch (e) {
      if (!(e instanceof GameRuleError)) throw e;
      return false;
    }
  };
  const bestDie = (gainOf: (i: number) => number) => {
    let bi = -1, bg = -Infinity;
    for (let i = 0; i < hand.length; i++) {
      const g = gainOf(i);
      if (g > bg) [bi, bg] = [i, g];
    }
    return { i: bi, gain: bg };
  };
  if (hasAbility(s, "adaptation") && !s.adaptationUsed[crew]) {
    const b = bestDie((i) => handScore(s, crew, withValue(hand, i, 7 - hand[i].value), W) - now);
    const cmd: GameCommand = { type: "adapt", dieId: hand[b.i]?.id ?? -1 };
    if (b.gain > W.adaptGain && legal(cmd)) return cmd;
  }
  if (hasAbility(s, "anticipation") && !s.anticipated && crew === firstPlayerForRound(s.round) && !s.dice[crew].some((d) => d.placed)) {
    const b = bestDie((i) => rerolled(s, crew, hand, i, W) - now);
    const cmd = { type: "anticipate", dieId: hand[b.i]?.id ?? -1 } as GameCommand;
    if (b.gain > W.anticipateGain && legal(cmd)) return cmd;
  }
  if (hasAbility(s, "workingTogether") && !s.swappedThisRound && s.dice[other(crew)].some((d) => !d.placed)) {
    const b = bestDie((i) => rerolled(s, crew, hand, i, W) - now);
    const cmd: GameCommand = { type: "swap", dieId: hand[b.i]?.id ?? -1 };
    if (b.gain > W.swapGain && legal(cmd)) return cmd;
  }
  return null;
}

/** Working Together, answering: give the die whose loss (for the offered value) hurts least. */
function answerSwap(s: GameState, crew: Crew, W: PlanWeights): GameCommand | null {
  const offer = s.pendingSwap!;
  const offered = s.dice[offer.from].find((d) => d.id === offer.dieId)?.value;
  const hand: Die[] = s.dice[crew].filter((d) => !d.placed && d.value !== undefined).map((d) => ({ id: d.id, value: d.value! }));
  if (hand.length === 0) return null;
  let best: Die | null = null, bestScore = -Infinity;
  for (let i = 0; i < hand.length; i++) {
    const score = offered !== undefined ? handScore(s, crew, withValue(hand, i, offered), W) : rerolled(s, crew, hand, i, W);
    if (score > bestScore) [best, bestScore] = [hand[i], score];
  }
  return best ? { type: "swap", dieId: best.id } : null;
}

/** Synchronisation: the held Traffic die goes on the empty space (either colour) where it does most. */
function placeTraffic(s: GameState, W: PlanWeights): GameCommand | null {
  const v = s.trafficHeld!.value;
  const want = moveWanted(s);
  const options: { target: PlacementTarget; gain: number }[] = [];
  const at = s.position + v - 1;
  const clears = (s.airplanes[at] ?? 0) > 0 ? W.clear + (at - s.position <= want ? W.clearHere : 0) : -2;
  for (const side of ["pilot", "copilot"] as const) for (const slot of side === "pilot" ? [0] : [0, 1]) options.push({ target: { kind: "radio", slot, side }, gain: clears });
  LANDING_GEAR_VALUES.forEach((vals, slot) => !s.gearGreen[slot] && vals.includes(v as never) && options.push({ target: { kind: "landingGear", slot }, gain: W.gear }));
  const f = s.flapsGreen.findIndex((g) => !g);
  if (f >= 0 && FLAPS_VALUES[f].includes(v as never)) options.push({ target: { kind: "flaps", slot: f }, gain: W.flaps });
  if (s.brakesDeployed < BRAKE_VALUES.length && BRAKE_VALUES[s.brakesDeployed] === v) options.push({ target: { kind: "brakes", slot: s.brakesDeployed }, gain: W.brakes });
  if ((s.scenario.modules ?? []).includes("kerosene") && s.keroseneSlot == null && v < s.kerosene) options.push({ target: { kind: "kerosene" }, gain: (KEROSENE_IDLE_BURN - v) * W.kerosene });
  for (const slot of [0, 1]) options.push({ target: { kind: "concentration", slot }, gain: s.coffee < MAX_COFFEE ? W.coffeeGain : 0 });
  options.sort((a, b) => b.gain - a.gain);
  for (const o of options) {
    const cmd: GameCommand = { type: "placeTraffic", target: o.target };
    try {
      reduce(s, cmd, playerIdOf(s, "copilot"));
      return cmd;
    } catch (e) {
      if (!(e instanceof GameRuleError)) throw e;
    }
  }
  return null;
}

const other = (c: Crew): Crew => (c === "pilot" ? "copilot" : "pilot");

function bestAssignment(s: GameState, crew: Crew, hand: Die[], W: PlanWeights): Assignment | null {
  const axisOpen = s.axis[crew] === null;
  const engineOpen = s.engines[crew] === null;
  // Each die: Axis, Engine, or a free space. Hands are at most 4 dice: try every split.
  const roles = (axisOpen ? 1 : 0) + (engineOpen ? 1 : 0);
  if (hand.length < roles) return null;
  const n = hand.length;
  const want = moveWanted(s);
  const landing = s.round >= s.scenario.rounds;
  const coffee = s.coffee;
  // Within one decision the same pieces recur across splits: work each out once.
  const axisCache = new Map<number, number>();
  const engineCache = new Map<string, number>();
  const extrasCache = new Map<string, Extras>();
  const deltasOf = (d: Die): number[] => {
    const out: number[] = [];
    for (let x = -coffee; x <= coffee; x++) if (d.value + x >= 1 && d.value + x <= 6) out.push(x);
    return out;
  };
  const deltas = hand.map(deltasOf);
  let best: { score: number; ai: number; ei: number; da: number; de: number; extras: Extras } | null = null;
  for (let ai = axisOpen ? 0 : -1; ai < (axisOpen ? n : 0); ai++) {
    for (let ei = engineOpen ? 0 : -1; ei < (engineOpen ? n : 0); ei++) {
      if (ai >= 0 && ai === ei) continue;
      const rest = hand.filter((_, i) => i !== ai && i !== ei);
      const das = ai >= 0 ? deltas[ai] : [0];
      const des = ei >= 0 ? deltas[ei] : [0];
      for (const da of das) {
        for (const de of des) {
          const spent = Math.abs(da) + Math.abs(de);
          if (spent > coffee) continue;
          // On the landing round the Coffee left is kept for the Axis (it has to end level).
          const coffeeForExtras = landing && axisOpen ? 0 : coffee - spent;
          const extrasKey = `${ai},${ei}|${coffeeForExtras}`;
          let extras = extrasCache.get(extrasKey);
          if (!extras) extrasCache.set(extrasKey, (extras = assignExtras(s, crew, rest, coffeeForExtras, W, want)));
          let score = extras.score - spent * W.coffeeSpend;
          if (ai >= 0) {
            const av = hand[ai].value + da;
            let c = axisCache.get(av);
            if (c === undefined) axisCache.set(av, (c = axisScore(s, crew, av, W, want)));
            score += c;
          }
          if (ei >= 0) {
            const ev = hand[ei].value + de;
            // (The Axis value matters: with Wind, it turns the ring before the Engines.)
            const key = `${ev}|${extrasKey}|${ai >= 0 ? hand[ai].value + da : "-"}`;
            let c = engineCache.get(key);
            if (c === undefined) engineCache.set(key, (c = engineScore(s, crew, ev, extras.cleared, extras.brakesAfter, ai >= 0 ? hand[ai].value + da : null, W, want)));
            score += c;
          }
          if (!best || score > best.score) best = { score, ai, ei, da, de, extras };
        }
      }
    }
  }
  if (!best) return null;
  return {
    axis: best.ai >= 0 ? { die: hand[best.ai], delta: best.da } : undefined,
    engine: best.ei >= 0 ? { die: hand[best.ei], delta: best.de } : undefined,
    extras: best.extras.list,
    score: best.score,
  };
}

type Extras = { list: Assignment["extras"]; score: number; cleared: Map<number, number>; brakesAfter: number };

/** Free spaces for the extra dice, chosen greedily (highest value first), with Coffee left over. */
function assignExtras(s: GameState, crew: Crew, dice: Die[], coffeeLeft: number, W: PlanWeights, want: number): Extras {
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
  let keroOpen = (s.scenario.modules ?? []).includes("kerosene") && s.keroseneSlot == null;
  const ice = (s.scenario.modules ?? []).includes("iceBrakes");
  let iceStep = s.brakesDeployed;
  let iceTop: number | null = s.iceBrakeSlots[iceStep]?.top ?? null;
  let iceBottom: number | null = s.iceBrakeSlots[iceStep]?.bottom?.value ?? null;
  const internNext = (s.scenario.modules ?? []).includes("intern") && s.internSlots[crew] === null ? nextInternToken(s, crew) : -1;
  let internOpen = internNext >= 0;
  const internToken = internNext >= 0 ? s.internTokens[internNext]! : 0;
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
        // gearOnPace: a Gear while behind the plan costs every later move (blue + 1).
        const gearW = W.gearOnPace && s.position < planTarget(s) - 1 && urgency() === 1 ? W.gear * 0.2 : W.gear * urgency();
        if (g >= 0) consider(delta, { target: { kind: "landingGear", slot: g }, kind: "gear", slot: g }, gearW);
        if (!ice && brakes < BRAKE_VALUES.length && BRAKE_VALUES[brakes] === v) consider(delta, { target: { kind: "brakes", slot: brakes }, kind: "brakes", slot: brakes }, W.brakes * urgency());
      } else {
        const f = flaps.findIndex((g) => !g);
        if (f >= 0 && FLAPS_VALUES[f].includes(v as never)) consider(delta, { target: { kind: "flaps", slot: f }, kind: "flaps", slot: f }, W.flaps * urgency());
      }
      if (keroOpen) {
        // Kerosene: a die burns its value instead of the idle 6 — never the tank's last drop,
        // and not so much that the rounds left (about 2 each) run dry.
        const after = s.kerosene - v;
        const need = 2 * (roundsToPlace - 1) + 1;
        const gain = after <= 0 ? -W.fatal : (KEROSENE_IDLE_BURN - v) * W.kerosene - Math.max(0, need - after) * W.kerosene;
        consider(delta, { target: { kind: "kerosene" }, kind: "kerosene", slot: 0 }, gain);
      }
      if (ice && iceStep < ICE_BRAKE_VALUES.length && ICE_BRAKE_VALUES[iceStep] === v) {
        // Ice Brakes: two dice of the step's value in one round (Pilot on top). Finishing a
        // started step is worth a whole step; starting one, part of it (the other half may not come).
        const half = (iceTop === null) !== (iceBottom === null);
        const gain = W.brakes * urgency() * (half ? 2 : 0.6);
        if (crew === "pilot" && iceTop === null) consider(delta, { target: { kind: "iceBrakes", slot: iceStep, space: "top" }, kind: "iceBrakes", slot: iceStep }, gain);
        if (iceBottom === null) consider(delta, { target: { kind: "iceBrakes", slot: iceStep, space: "bottom" }, kind: "iceBrakes", slot: iceStep }, gain);
      }
      if (internOpen && v !== internToken) {
        // Intern: training hands over the next token, placed at once like a die of
        // its number — worth the training, plus an airplane it would then clear.
        const tokenAt = s.position + internToken - 1;
        const tokenClears = (planes[tokenAt] ?? 0) > 0 ? W.clear : 0;
        const tokensLeft = s.internTokens.filter((t) => t !== null).length;
        const internUrgent = tokensLeft >= roundsToPlace ? W.urgent : 1;
        consider(delta, { target: { kind: "intern", side: crew }, kind: "intern", slot: 0 }, W.intern * internUrgent + tokenClears);
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
    else if (p.extra.kind === "kerosene") keroOpen = false;
    else if (p.extra.kind === "intern") internOpen = false;
    else if (p.extra.kind === "iceBrakes") {
      if ((p.extra.target as { space: string }).space === "top") iceTop = v; else iceBottom = v;
      if (iceTop !== null && iceBottom !== null) { brakes += 1; iceStep += 1; iceTop = s.iceBrakeSlots[iceStep]?.top ?? null; iceBottom = s.iceBrakeSlots[iceStep]?.bottom?.value ?? null; }
    }
  }
  // What these dice clear (before the Engines resolve) and the Brakes they set, for the Engine's score.
  const cleared = new Map<number, number>();
  for (const x of list) if (x.extra.kind === "radio") {
    const at = s.position + (x.die.value + x.delta) - 1;
    if ((s.airplanes[at] ?? 0) > 0) cleared.set(at, (cleared.get(at) ?? 0) + 1);
  }
  const brakesAfter = brakes;
  return { list, score, cleared, brakesAfter };
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
function axisScore(s: GameState, crew: Crew, v: number, W: PlanWeights, want: number): number {
  const theirs = s.axis[other(crew)];
  const landing = s.round >= s.scenario.rounds;
  const goal = landing ? 0 : W.tiltHold ?? turnTarget(s, want) ?? 0;
  const tiltWith = (t: number) => s.axis.offset + (crew === "pilot" ? v - t : t - v);
  const cost = (tilt: number) =>
    (Math.abs(tilt) >= s.scenario.axisSpinAt || (landing && tilt !== 0) ? W.fatal : 0) + Math.abs(tilt - goal) * (W.tiltHold !== undefined && !landing ? 3 * W.tilt : W.tilt);
  // Control: a matching Axis die gains a Coffee.
  if (theirs !== null) return -cost(tiltWith(theirs)) + (hasAbility(s, "control") && s.coffee < MAX_COFFEE && v === theirs ? W.pairBonus : 0);
  return partnerBest((f) => -cost(tiltWith(f)));
}

/**
 * The Engine die `v`: where the speed takes the plane against the plan — a
 * collision (an airplane on a space flown off, after this crew's planned
 * clears), an overshoot or a missed turn is fatal; on the landing round the
 * speed must stay within the Brakes this crew will have.
 */
/**
 * The Wind the Engines will meet when this crew's Axis die `axisV` (placed
 * before its Engine die) completes the Axis: the ring turns one space per pip
 * of the new tilt first. Otherwise the Wind as it stands.
 */
export function engineWindFor(s: GameState, crew: Crew, axisV: number | null): number {
  if (!s.scenario.modules?.includes("wind")) return 0;
  const theirs = s.axis[other(crew)];
  if (axisV === null || theirs === null || s.axis[crew] !== null) return WIND_RING[s.windPosition];
  const tilt = s.axis.offset + (crew === "pilot" ? axisV - theirs : theirs - axisV);
  const n = WIND_RING.length;
  return WIND_RING[(((s.windPosition - tilt) % n) + n) % n];
}

function engineScore(s: GameState, crew: Crew, v: number, cleared: Map<number, number>, brakesAfter: number, axisV: number | null, W: PlanWeights, want: number): number {
  const theirs = s.engines[other(crew)];
  const wind = engineWindFor(s, crew, axisV);
  const landing = s.round >= s.scenario.rounds;
  const plan = flightPlan(s.scenario);
  const outcome = (t: number, now: boolean) => {
    const speed = v + t + wind;
    const steps = (s.scenario.modules ?? []).includes("iceBrakes") ? ICE_BRAKE_VALUES : BRAKE_VALUES;
    // Kerosene Leak: the Engine dice drain their difference + 1 as soon as both are down.
    const leak = (s.scenario.modules ?? []).includes("keroseneLeak") ? Math.abs(v - t) + 1 : 0;
    if (leak && leak >= s.kerosene) return -W.fatal;
    const leakCost = leak * W.leak;
    if (landing) return (speed <= (brakesAfter > 0 ? steps[brakesAfter - 1] : 0) ? 0 : -W.fatal) - leakCost;
    const adv = speed <= s.aeroBlue ? 0 : speed > s.aeroOrange ? 2 : 1;
    for (let step = 0; step < adv; step++) {
      const at = s.position + step;
      const left = (s.airplanes[at] ?? 0) - (cleared.get(at) ?? 0);
      if (left > 0 || at >= plan.airport) return -W.fatal;
    }
    // Our Axis die fixes the tilt before the move only if the partner's is already down.
    if (adv > 0 && turnBlocks(s, adv, now && !(axisV !== null && s.axis[other(crew)] !== null))) return -W.fatal;
    return (adv < want ? -(want - adv) * W.behind : -(adv - want) * W.ahead) - leakCost;
  };
  // Mastery: a matching Engine die wins back a spent Reroll.
  if (theirs !== null) return outcome(theirs, true) + (hasAbility(s, "mastery") && s.rerollSpent > 0 && v === theirs ? W.pairBonus : 0);
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
  // Completing the Engines moves the plane now, and a turn is checked against the tilt at that
  // moment: while a turn is in play and the Axis isn't final, that die waits until last.
  const turnInPlay = flightPlan(s.scenario).turn.slice(s.position, s.position + 2).some(Boolean);
  const axisFinal = s.axis.pilot !== null && s.axis.copilot !== null;
  const engineNow = a.engine && s.engines[partner] !== null && here.length === 0 && (!turnInPlay || axisFinal);
  if (engineNow) tries.push(place(a.engine!.die, { kind: "engine" }, a.engine!.delta));
  for (const x of a.extras) if (!here.includes(x)) tries.push(place(x.die, x.extra.target, x.delta));
  if (a.axis) tries.push(place(a.axis.die, { kind: "axis" }, a.axis.delta));
  if (a.engine) tries.push(place(a.engine.die, { kind: "engine" }, a.engine.delta));
  for (const cmd of tries) {
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
}
