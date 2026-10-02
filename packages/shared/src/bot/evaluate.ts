import { airportIndex, type GameState } from "../game/state";
import { ICE_BRAKE_VALUES, type Crew } from "../game/scenario";

export const WIN = 10_000;

/**
 * Heuristic value of a state for the crew (co-operative, so the same for both
 * seats). Terms: outcome; approach progress vs rounds left; traffic in the way;
 * tilt, and a tilt the current space's Turn forbids; switches still to deploy
 * vs rounds left; brakes; Kerosene and Intern pressure; small credit for
 * Coffee and Reroll tokens.
 */
export function evaluate(s: GameState, _crew: Crew): number {
  if (s.outcome) return s.outcome.result === "won" ? WIN : -WIN;
  const roundsLeft = s.scenario.rounds - s.round; // rounds still able to move (the final round can't)
  const remaining = airportIndex(s.scenario) - s.position;
  let v = 0;
  // Must cover `remaining` spaces in `roundsLeft` rounds, ≤2 per round.
  if (remaining > 2 * roundsLeft) v -= 3000;
  v -= Math.abs(remaining - roundsLeft) * 40;
  // Airplanes still on the path (each must be cleared before the plane leaves its space).
  s.airplanes.forEach((n, i) => { if (i >= s.position) v -= n * (i - s.position <= 2 ? 120 : 60); });
  // Tilt: 0 is level; ±spinAt is fatal (already an outcome); landing needs 0.
  v -= Math.abs(s.axis.offset) * (Math.abs(s.axis.offset) >= s.scenario.axisSpinAt - 1 ? 400 : 80);
  // Turns: flying off this space with a tilt it doesn't allow loses.
  const allowed = s.scenario.approachTrack[s.position]?.axisAllowed;
  if (allowed && !allowed.includes(s.axis.offset)) v -= 600;
  // Switches to deploy before landing.
  const todo = s.gearGreen.filter((g) => !g).length + s.flapsGreen.filter((g) => !g).length;
  v -= todo * 60 + Math.max(0, todo - 2 * roundsLeft) * 300;
  const iceOn = s.scenario.modules?.includes("iceBrakes");
  const brakeGoal = iceOn ? ICE_BRAKE_VALUES.length : 1;
  v -= Math.max(0, brakeGoal - s.brakesDeployed) * (iceOn ? 150 : 100);
  if (s.scenario.modules?.some((m) => m === "kerosene" || m === "keroseneLeak")) {
    v -= Math.max(0, roundsLeft * 4 - s.kerosene) * 50;
  }
  if (s.scenario.modules?.includes("intern")) {
    const untrained = s.internTokens.filter((t) => t !== null).length;
    v -= untrained * 40 + Math.max(0, untrained - 2 * (roundsLeft + 1)) * 400;
  }
  v += s.coffee * 15 + s.rerollTokens * 25;
  return v;
}
