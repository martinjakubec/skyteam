import { airportIndex, type GameState } from "../game/state";
import { BRAKE_VALUES, ICE_BRAKE_VALUES, KEROSENE_IDLE_BURN, WIND_RING, type Crew } from "../game/scenario";
import { flightPlan, planTarget, turnTarget } from "./plan";
import { weightsFor } from "./profiles";

export const WIN = 10_000;

/** Kerosene a round the evaluator plans for: a low die, most rounds. */
const KEROSENE_PER_ROUND = 2.5;

/** The evaluator's weights — tunable by `scripts/tune.mjs eval` against the
 *  quick strategy's landing rate. Defaults are the tuned values. */
export const EVAL_WEIGHTS = {
  /** Per airplane within two spaces / further along the path. */
  airplaneNear: 120,
  airplaneFar: 60,
  /** Per pip of tilt (and when one pip from a spin). */
  tilt: 80,
  tiltDanger: 400,
  /** A tilt the current space's Turn forbids. */
  turn: 600,
  /** Per switch (Gear, Flaps) still to deploy. */
  switchTodo: 60,
  /** Per switch beyond a crew's capacity (two a round). */
  switchOverCapacity: 300,
  /** Per Flaps beyond about one a round. */
  flapsPace: 150,
  /** Per Brakes step still to deploy. */
  brakes: 100,
  /** Per open Axis/Engine of the crew's own. */
  openMandatory: 1000,
  /** Kerosene: per point of fuel short of what the rounds left will burn. */
  kerosene: 60,
  /** Credit per Coffee and per Reroll token. */
  coffee: 15,
  reroll: 25,
  /** Per space behind / ahead of the flight plan after this round's move. */
  paceBehind: 40,
  paceAhead: 10,
  /** Per Traffic dice icon on a space the plan says the plane should have left. */
  trafficDiceWait: 60,
  /** Per pip the Axis is likely to miss the tilt a coming turn needs. */
  turnPrep: 100,
};

/**
 * Heuristic value of a state for the crew (co-operative, so the same for both
 * seats). Terms: outcome; approach progress vs rounds left; traffic in the way;
 * tilt, and a tilt the current space's Turn forbids; switches still to deploy
 * vs rounds left; brakes; Kerosene and Intern pressure; small credit for
 * Coffee and Reroll tokens.
 */
export function evaluate(s: GameState, crew: Crew): number {
  if (s.outcome) return s.outcome.result === "won" ? WIN : -WIN;
  const W = weightsFor(s);
  // Rounds still able to move: up to the one before landing, and not this one
  // once its Engines have resolved (the plane has moved this round).
  const moved = s.phase === "placement" && s.engines.pilot !== null && s.engines.copilot !== null;
  const roundsLeft = Math.max(0, s.scenario.rounds - s.round - (moved ? 1 : 0));
  const remaining = airportIndex(s.scenario) - s.position;
  let v = 0;
  v -= paceRisk(s, crew, remaining, roundsLeft, moved, W);
  // Airplanes still on the path (each must be cleared before the plane leaves its space).
  s.airplanes.forEach((n, i) => { if (i >= s.position) v -= n * (i - s.position <= 2 ? W.airplaneNear : W.airplaneFar); });
  // Tilt: 0 is level; ±spinAt is fatal (already an outcome); landing needs 0.
  // Tilt: level is the goal, except before flying off a turn, where it's the
  // tilt the turn allows. One pip from a spin is dangerous unless that's the goal.
  const tiltGoal = s.phase === "placement" && !moved ? turnTarget(s, 1) : null;
  v -= Math.abs(s.axis.offset - (tiltGoal ?? 0)) * W.tilt;
  if (Math.abs(s.axis.offset) >= s.scenario.axisSpinAt - 1 && s.axis.offset !== tiltGoal) v -= Math.abs(s.axis.offset) * (W.tiltDanger - W.tilt);
  if (tiltGoal !== null) v -= turnPrepRisk(s, crew, tiltGoal) * W.turnPrep;
  v -= axisRisk(s, crew);
  // The crew's own Axis and Engine, still open: filling them early keeps them
  // on the search's shortlist (found in Real-Time, where this began: every
  // game lands more — YUL 37 → 56 of 80, Wind 30 → 47, Kerosene Leak 31 → 50).
  if (s.phase === "placement") {
    v -= ((s.axis[crew] === null ? 1 : 0) + (s.engines[crew] === null ? 1 : 0)) * W.openMandatory;
  }
  v -= landingSpeedRisk(s, crew);
  // Turns: flying off this space with a tilt it doesn't allow loses — once
  // this round's tilt is final, and not on the landing round (no movement).
  const allowed = s.scenario.approachTrack[s.position]?.axisAllowed;
  const tiltFinal = s.axis.pilot !== null && s.axis.copilot !== null;
  if (allowed && tiltFinal && !isLanding(s) && !allowed.includes(s.axis.offset)) v -= W.turn;
  // Switches to deploy before landing. Each crew has its own two free dice a
  // round, over the rounds still to move plus this one (switches can be set
  // after the move, and on the landing round). The Co-Pilot's Flaps go in
  // order with set numbers: about one a round is a realistic pace.
  const gearTodo = s.gearGreen.filter((g) => !g).length;
  const flapsTodo = s.flapsGreen.filter((g) => !g).length;
  const placeRounds = roundsLeft + 1;
  v -= (gearTodo + flapsTodo) * W.switchTodo;
  v -= (Math.max(0, gearTodo - 2 * placeRounds) + Math.max(0, flapsTodo - 2 * placeRounds)) * W.switchOverCapacity;
  v -= Math.max(0, flapsTodo - placeRounds) * W.flapsPace;
  const iceOn = s.scenario.modules?.includes("iceBrakes");
  // Every step: two dice average 7, more than any Brakes but the last allow.
  const brakeGoal = iceOn ? ICE_BRAKE_VALUES.length : BRAKE_VALUES.length;
  v -= Math.max(0, brakeGoal - s.brakesDeployed) * (iceOn ? 1.5 * W.brakes : W.brakes);
  // A started Ice Brakes step: one half in, worth part of a step if finished this round.
  const step = iceOn ? s.iceBrakeSlots[s.brakesDeployed] : undefined;
  if (step && s.phase === "placement" && (step.top === null) !== (step.bottom === null)) v += 0.75 * W.brakes;
  if (s.scenario.modules?.includes("kerosene")) {
    // Kerosene: this round's burn is still to come while the space is empty —
    // about a low die if someone can still feed it, the idle 6 if nobody can —
    // then about KEROSENE_PER_ROUND for every round after (the landing one too).
    const free = (c: Crew) => Math.max(0, s.dice[c].filter((d) => !d.placed).length - (s.axis[c] === null ? 1 : 0) - (s.engines[c] === null ? 1 : 0));
    const pending = s.phase === "placement" && s.keroseneSlot == null ? (free("pilot") + free("copilot") > 0 ? KEROSENE_PER_ROUND : KEROSENE_IDLE_BURN) : 0;
    const later = s.scenario.rounds - s.round;
    v -= Math.max(0, later * KEROSENE_PER_ROUND + 1 - (s.kerosene - pending)) * W.kerosene;
  } else if (s.scenario.modules?.includes("keroseneLeak")) {
    v -= Math.max(0, roundsLeft * 4 - s.kerosene) * 50;
  }
  if (s.scenario.modules?.includes("intern")) {
    const untrained = s.internTokens.filter((t) => t !== null).length;
    v -= untrained * 40 + Math.max(0, untrained - 2 * (roundsLeft + 1)) * 400;
  }
  v += s.coffee * W.coffee + s.rerollTokens * W.reroll;
  return v;
}

/** The Axis tilt once `crew` puts `mine` against the other crew's `theirs`. */
const tiltWith = (s: GameState, crew: Crew, mine: number, theirs: number) => s.axis.offset + (crew === "pilot" ? mine - theirs : theirs - mine);

const isLanding = (s: GameState) => s.round >= s.scenario.rounds;
/** A tilt that loses: a spin, or on the landing round anything but level. */
const fatalTilt = (s: GameState, t: number) => (isLanding(s) ? t !== 0 : Math.abs(t) >= s.scenario.axisSpinAt);

/** Spin risk of an Axis die whose partner die is hidden: any face alike. */
function hiddenPartnerRisk(s: GameState, tiltFor: (face: number) => number): number {
  const faces = [1, 2, 3, 4, 5, 6];
  const fatal = faces.filter((f) => fatalTilt(s, tiltFor(f))).length;
  return (fatal / 6) * 2000 + (faces.reduce((a, f) => a + Math.abs(tiltFor(f)), 0) / 6) * 40;
}

/** The crew's own unplaced dice, with every value Coffee could make of them. */
function reachableValues(s: GameState, crew: Crew): number[] {
  const hand = s.dice[crew].filter((d) => !d.placed && d.value !== undefined).map((d) => d.value!);
  return hand.flatMap((v) => Array.from({ length: 2 * s.coffee + 1 }, (_, i) => v - s.coffee + i)).filter((v) => v >= 1 && v <= 6);
}

/**
 * Landing round: the Engine dice must not add up to more than the last Brakes
 * deployed. Same shape as the Axis risk: the crew's own open Engine is scored
 * by its best die (certain against a die already down, averaged against a
 * hidden one); its die down and the other's to come, the hidden one.
 */
function landingSpeedRisk(s: GameState, crew: Crew): number {
  if (s.phase !== "placement" || !isLanding(s)) return 0;
  const steps = s.scenario.modules?.includes("iceBrakes") ? ICE_BRAKE_VALUES : BRAKE_VALUES;
  const limit = s.brakesDeployed > 0 ? steps[s.brakesDeployed - 1] : 0;
  const wind = s.scenario.modules?.includes("wind") ? WIND_RING[s.windPosition] : 0;
  const tooFast = (a: number, b: number) => a + b + wind > limit;
  const hidden = (mine: number) => ([1, 2, 3, 4, 5, 6].filter((f) => tooFast(mine, f)).length / 6) * 2000;
  const other: Crew = crew === "pilot" ? "copilot" : "pilot";
  const theirs = s.engines[other];
  if (s.engines[crew] === null) {
    const values = reachableValues(s, crew);
    if (!values.length) return 0;
    return Math.min(...values.map((v) => (theirs !== null ? (tooFast(v, theirs) ? 5000 : 0) : hidden(v))));
  }
  if (theirs === null) return hidden(s.engines[crew]!);
  // Both down: as fatal as before placing (a further Brakes step may still come).
  return tooFast(s.engines[crew]!, theirs) ? 5000 : 0;
}

/**
 * What the Axis still risks this round, from `crew`'s view. Its own open Axis:
 * the safest die it still holds, with Coffee (certain against a die already
 * down, averaged against a hidden one) — so spending that die elsewhere costs.
 * Its own die down and the other's to come: that hidden die, any face alike.
 * The two agree, so placing the Axis die now or keeping it scores the same.
 */
function axisRisk(s: GameState, crew: Crew): number {
  if (s.phase !== "placement") return 0;
  const other: Crew = crew === "pilot" ? "copilot" : "pilot";
  const theirs = s.axis[other];
  if (s.axis[crew] === null) {
    const reachable = reachableValues(s, crew);
    const risk = (v: number) =>
      theirs !== null
        ? fatalTilt(s, tiltWith(s, crew, v, theirs)) ? 5000 : 0
        : hiddenPartnerRisk(s, (f) => tiltWith(s, crew, v, f));
    return reachable.length ? Math.min(...reachable.map(risk)) : 0;
  }
  if (theirs === null) return hiddenPartnerRisk(s, (f) => tiltWith(s, other, f, s.axis[crew]!));
  // Both down: on the landing round a tilt is as fatal as before placing.
  return isLanding(s) && s.axis.offset !== 0 ? 5000 : 0;
}

/** Pips the Axis is expected to end off `goal` this round (0 once it's final). */
function turnPrepRisk(s: GameState, crew: Crew, goal: number): number {
  const other: Crew = crew === "pilot" ? "copilot" : "pilot";
  const mine = s.axis[crew], theirs = s.axis[other];
  if (mine !== null && theirs !== null) return 0;
  const faces = [1, 2, 3, 4, 5, 6];
  const off = (m: number, t: number) => Math.abs(tiltWith(s, crew, m, t) - goal);
  if (mine === null) {
    const values = reachableValues(s, crew);
    if (!values.length) return 0;
    return Math.min(...values.map((v) => (theirs !== null ? off(v, theirs) : faces.reduce((a, f) => a + off(v, f), 0) / 6)));
  }
  return faces.reduce((a, f) => a + off(mine, f), 0) / 6;
}

/**
 * Pace against the flight plan once the plane is at `pos` after this round's
 * move: behind costs more than ahead, waiting on Traffic dice past the plan
 * costs their airplanes, and more spaces than two a round can cover is fatal.
 */
function paceCost(s: GameState, pos: number, roundsLeftAfter: number, W: typeof EVAL_WEIGHTS): number {
  const plan = flightPlan(s.scenario);
  const remaining = plan.airport - pos;
  const gap = planTarget(s) - pos;
  let cost = (remaining > 2 * roundsLeftAfter ? 3000 : 0) + Math.max(0, gap) * W.paceBehind + Math.max(0, -gap) * W.paceAhead;
  if (gap > 0) cost += (plan.trafficDice[pos] ?? 0) * W.trafficDiceWait;
  return cost;
}

/**
 * Approach pace. Once this round's move is made (or on the landing round,
 * which can't move) it's the position as it stands. Before it, it's the move
 * the Engines are expected to make: the crew's best Engine die against the
 * other crew's (certain when that's down, averaged when it's hidden) — leaving
 * a space with an airplane on it, or overshooting, is fatal. So keeping the
 * dice the pace needs scores the same as placing them now.
 */
function paceRisk(s: GameState, crew: Crew, remaining: number, roundsLeft: number, moved: boolean, W: typeof EVAL_WEIGHTS): number {
  if (moved || s.phase !== "placement" || isLanding(s)) return paceCost(s, s.position, roundsLeft, W);
  const after = roundsLeft - 1;
  const wind = s.scenario.modules?.includes("wind") ? WIND_RING[s.windPosition] : 0;
  const tiltFinal = s.axis.pilot !== null && s.axis.copilot !== null;
  // `now`: this die completes the Engines, so the move (and any turn) happens
  // with the tilt as it stands, final or not.
  const afterMove = (speed: number, now = false) => {
    const adv = speed <= s.aeroBlue ? 0 : speed > s.aeroOrange ? 2 : 1;
    for (let step = 0; step < adv; step++) {
      const from = s.position + step;
      if ((s.airplanes[from] ?? 0) > 0 || step >= remaining) return 5000; // collision / overshoot
      // Every space flown off (incl. the one flown through) must allow the
      // tilt — the current one, checked when the Engines resolve.
      const turn = s.scenario.approachTrack[from]?.axisAllowed;
      if ((tiltFinal || now) && turn && !turn.includes(s.axis.offset)) return 5000;
    }
    return paceCost(s, s.position + adv, after, W);
  };
  const hidden = (mine: number) => [1, 2, 3, 4, 5, 6].reduce((a, f) => a + afterMove(mine + f + wind), 0) / 6;
  const other: Crew = crew === "pilot" ? "copilot" : "pilot";
  const theirs = s.engines[other];
  if (s.engines[crew] === null) {
    const values = reachableValues(s, crew);
    if (!values.length) return paceCost(s, s.position, roundsLeft, W);
    return Math.min(...values.map((v) => (theirs !== null ? afterMove(v + theirs + wind, true) : hidden(v))));
  }
  return hidden(s.engines[crew]!);
}
