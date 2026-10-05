import type { Scenario } from "../game/scenario";
import { airportIndex, type GameState } from "../game/state";

/**
 * A board's flight plan, worked out from its data alone: where the plane
 * should be after each round's move, which tilts each turn allows, and where
 * Traffic dice are. The bot's pace and turn handling read it, so a card's
 * track — not YUL's one space a round — sets the pace.
 */
export interface FlightPlan {
  airport: number;
  /** target[r]: the position after round r's move (r = 0 … rounds); front-loaded. */
  target: number[];
  /** turn[i]: the tilts allowed for flying off space i, or null. */
  turn: (number[] | null)[];
  /** trafficDice[i]: Traffic dice icons on space i. */
  trafficDice: number[];
}

// Keyed by the scenario object: a sampled world (a structuredClone) simply
// works its plan out again — a handful of spaces, nothing to go stale.
const plans = new WeakMap<Scenario, FlightPlan>();

export function flightPlan(scenario: Scenario): FlightPlan {
  const known = plans.get(scenario);
  if (known) return known;
  const airport = airportIndex(scenario);
  const moving = Math.max(1, scenario.rounds - 1); // the last round lands, it doesn't move
  const target = Array.from({ length: scenario.rounds + 1 }, (_, r) => Math.min(airport, Math.ceil((airport * r) / moving)));
  const plan: FlightPlan = {
    airport,
    target,
    turn: scenario.approachTrack.map((sp) => (sp.axisAllowed?.length ? sp.axisAllowed : null)),
    trafficDice: scenario.approachTrack.map((sp) => sp.trafficDice ?? 0),
  };
  plans.set(scenario, plan);
  return plan;
}

/** Where the plan wants the plane after this round's move. */
export function planTarget(s: GameState): number {
  const plan = flightPlan(s.scenario);
  return plan.target[Math.min(s.round, s.scenario.rounds - 1)] ?? plan.airport;
}

/**
 * The tilt to aim the Axis at when the plane flies `advance` spaces this round:
 * of the tilts every turn space it leaves allows, the one nearest the current
 * tilt. Null when no turn is in the way, on the landing round (land level), or
 * when the turns have no tilt in common (that advance can't be flown).
 */
export function turnTarget(s: GameState, advance: number): number | null {
  if (advance <= 0 || s.round >= s.scenario.rounds) return null;
  const plan = flightPlan(s.scenario);
  let allowed: number[] | null = null;
  for (let step = 0; step < advance; step++) {
    const t = plan.turn[s.position + step];
    if (t) allowed = allowed ? allowed.filter((x) => t.includes(x)) : [...t];
  }
  if (!allowed || allowed.length === 0) return null;
  const off = s.axis.offset;
  return allowed.reduce((best, x) => (Math.abs(x - off) < Math.abs(best - off) ? x : best));
}

/**
 * True when flying `advance` spaces this round can't satisfy the turns on the
 * way. The rules check a turn when the Engines resolve, against the tilt at
 * that moment: `resolvesNow` (this die completes the Engines) or a final Axis
 * means the current tilt is what counts.
 */
export function turnBlocks(s: GameState, advance: number, resolvesNow = false): boolean {
  const plan = flightPlan(s.scenario);
  let any = false;
  for (let step = 0; step < advance; step++) if (plan.turn[s.position + step]) any = true;
  if (!any) return false;
  if (resolvesNow || (s.axis.pilot !== null && s.axis.copilot !== null)) {
    // The tilt is what it is now: every turn flown off must allow it.
    for (let step = 0; step < advance; step++) {
      const t = plan.turn[s.position + step];
      if (t && !t.includes(s.axis.offset)) return true;
    }
    return false;
  }
  return turnTarget(s, advance) === null; // no tilt satisfies them all
}

/**
 * The tilt to hold for a turn coming up: the turn on the space the plane will
 * be on after `advance` spaces (or is on now), nearest the current tilt. Null
 * when that space has no turn, or on the landing round.
 */
export function turnAhead(s: GameState, advance: number): number | null {
  if (s.round >= s.scenario.rounds) return null;
  const plan = flightPlan(s.scenario);
  const t = plan.turn[s.position + Math.max(0, advance)] ?? plan.turn[s.position];
  if (!t) return null;
  const off = s.axis.offset;
  return t.reduce((best, x) => (Math.abs(x - off) < Math.abs(best - off) ? x : best));
}
