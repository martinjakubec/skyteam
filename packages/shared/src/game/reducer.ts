import {
  airplanesRemaining,
  airportIndex,
  crewOf,
  firstPlayerForRound,
  type GameState,
} from "./state";
import {
  BRAKE_VALUES,
  CONCENTRATION_SLOTS,
  DICE_PER_PLAYER,
  FLAPS_VALUES,
  LANDING_GEAR_VALUES,
  MAX_COFFEE,
  RADIO_COPILOT_SLOTS,
  RADIO_PILOT_SLOTS,
  type Crew,
  type DieValue,
} from "./scenario";
import type { PlacementTarget, PlayerId } from "../protocol";

export interface ReduceResult {
  /** The new state. The input `state` is never mutated. */
  state: GameState;
  /** Human-readable summary of what happened (handy for logs / debugging). */
  description: string;
}

/** Thrown when a command is illegal given the current state. */
export class GameRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameRuleError";
  }
}

/**
 * The reducer's command set. `placeDie` matches the wire `GameCommand`; `roll`
 * and `reroll` carry server-generated dice values (the server owns randomness).
 */
export type ReduceCommand =
  | { type: "roll"; pilot: DieValue[]; copilot: DieValue[] }
  | { type: "reroll"; dieIds: number[]; values: DieValue[] }
  | { type: "placeDie"; dieId: number; target: PlacementTarget; coffeeDelta?: number };

/**
 * The single, authoritative game-rules function. Pure: the input `state` is
 * deep-cloned and never mutated, and no randomness/clock is read — dice values
 * arrive via the command. Modules (advanced play) will hook into the named
 * resolve* / endOfRound steps below.
 */
export function reduce(state: GameState, command: ReduceCommand, byPlayerId: PlayerId): ReduceResult {
  const draft: GameState = structuredClone(state);

  switch (command.type) {
    case "roll":
      return handleRoll(draft, command);
    case "reroll":
      return handleReroll(draft, command, byPlayerId);
    case "placeDie":
      return handlePlaceDie(draft, command, byPlayerId);
    default:
      return assertNever(command);
  }
}

// --- roll -------------------------------------------------------------------

function handleRoll(
  s: GameState,
  cmd: { pilot: DieValue[]; copilot: DieValue[] },
): ReduceResult {
  if (s.phase !== "rolling") throw new GameRuleError("Not awaiting a roll.");
  if (cmd.pilot.length !== DICE_PER_PLAYER || cmd.copilot.length !== DICE_PER_PLAYER) {
    throw new GameRuleError("A roll must provide four dice per crew.");
  }

  s.dice = {
    pilot: cmd.pilot.map((value, id) => ({ id, value, placed: false })),
    copilot: cmd.copilot.map((value, id) => ({ id, value, placed: false })),
  };

  // Fresh round: clear per-round slots; persistent tracks (offset, switches,
  // brakes, coffee, airplanes, position) carry over.
  s.axis.pilot = null;
  s.axis.copilot = null;
  s.engines = { pilot: null, copilot: null };
  s.lastSpeed = null;
  s.gearSlots = s.gearSlots.map(() => null);
  s.flapSlots = s.flapSlots.map(() => null);
  s.brakeSlots = s.brakeSlots.map(() => false);
  s.radioPilot = null;
  s.radioCopilot = s.radioCopilot.map(() => null);
  s.concentrationSlots = s.concentrationSlots.map(() => null);
  s.pendingReroll = null;
  s.placedThisRound = 0;
  s.turn = firstPlayerForRound(s.round);
  s.altitudeFeet = s.scenario.startAltitudeFeet - (s.round - 1) * s.scenario.feetPerRound;
  s.phase = "placement";

  if (s.scenario.rerollRounds.includes(s.round)) {
    s.rerollTokens += 1;
  }

  s.log.push(`Round ${s.round}: dice rolled (${altitudeLabel(s)}). ${crewLabel(s.turn)} leads.`);
  return { state: s, description: `Round ${s.round} begins.` };
}

// --- reroll -----------------------------------------------------------------

/**
 * A Reroll token buys one *joint* reroll: the active player picks which of their
 * dice to reroll, then the other player is prompted to reroll any number of theirs
 * (including none). It runs as a two-step handshake so the two players never act
 * at once: the initiation sets `pendingReroll` to the other crew, and only that
 * crew's response (this same command) clears it. Both steps carry the same shape;
 * `pendingReroll` decides which one this is.
 */
function handleReroll(
  s: GameState,
  cmd: { dieIds: number[]; values: DieValue[] },
  byPlayerId: PlayerId,
): ReduceResult {
  if (s.phase !== "placement") throw new GameRuleError("You can only reroll during placement.");
  if (cmd.dieIds.length !== cmd.values.length) throw new GameRuleError("Invalid reroll.");
  const crew = requireCrew(s, byPlayerId);

  if (s.pendingReroll === null) return initiateReroll(s, crew, cmd);
  if (s.pendingReroll !== crew)
    throw new GameRuleError("Waiting for the other player to finish rerolling.");
  return respondReroll(s, crew, cmd);
}

/** Step 1 — the active player spends the token and rerolls at least one die. */
function initiateReroll(s: GameState, crew: Crew, cmd: { dieIds: number[]; values: DieValue[] }): ReduceResult {
  if (s.turn !== crew) throw new GameRuleError("Only the active player can start a reroll.");
  if (s.rerollTokens <= 0) throw new GameRuleError("No Reroll tokens available.");
  if (cmd.dieIds.length === 0) throw new GameRuleError("Select at least one die to reroll.");

  applyReroll(s, crew, cmd);
  s.rerollTokens -= 1;
  s.log.push(`${crewLabel(crew)} spent a Reroll token (${cmd.dieIds.length} dice).`);

  // Hand the (free) reroll to the other crew. If they have no dice left to
  // reroll, there is nothing to prompt — resolve the event immediately.
  const responder = other(crew);
  if (s.dice[responder].every((d) => d.placed)) {
    s.log.push(`${crewLabel(responder)} has no dice to reroll.`);
    return { state: s, description: "Dice rerolled." };
  }
  s.pendingReroll = responder;
  return { state: s, description: "Dice rerolled — other player may reroll." };
}

/** Step 2 — the prompted player rerolls any number of their dice (0 = decline). */
function respondReroll(s: GameState, crew: Crew, cmd: { dieIds: number[]; values: DieValue[] }): ReduceResult {
  applyReroll(s, crew, cmd);
  s.pendingReroll = null;
  s.log.push(
    cmd.dieIds.length > 0
      ? `${crewLabel(crew)} rerolled ${cmd.dieIds.length} dice.`
      : `${crewLabel(crew)} declined to reroll.`,
  );
  return { state: s, description: "Reroll complete." };
}

/** Overwrite the named dice in a crew's hand with the server-supplied values. */
function applyReroll(s: GameState, crew: Crew, cmd: { dieIds: number[]; values: DieValue[] }): void {
  const hand = s.dice[crew];
  cmd.dieIds.forEach((id, i) => {
    const die = hand.find((d) => d.id === id);
    if (!die) throw new GameRuleError("No such die.");
    if (die.placed) throw new GameRuleError("Cannot reroll a die already placed.");
    die.value = cmd.values[i];
  });
}

// --- placeDie ---------------------------------------------------------------

function handlePlaceDie(
  s: GameState,
  cmd: { dieId: number; target: PlacementTarget; coffeeDelta?: number },
  byPlayerId: PlayerId,
): ReduceResult {
  if (s.phase !== "placement") throw new GameRuleError("The game is not awaiting dice.");
  if (s.pendingReroll !== null) throw new GameRuleError("A reroll is in progress.");
  const crew = requireCrew(s, byPlayerId);
  if (s.turn !== crew) throw new GameRuleError("It is not your turn.");

  const die = s.dice[crew].find((d) => d.id === cmd.dieId);
  if (!die || die.value === undefined) throw new GameRuleError("No such die.");
  if (die.placed) throw new GameRuleError("That die has already been placed.");

  // Mandatory spots: every round a crew must seat one die on its Axis and one on
  // its Engine. Those dice are reserved — a non-mandatory placement is illegal
  // when the dice still in hand (this one included) are all needed to fill the
  // crew's still-open mandatory spots, otherwise a mandatory spot could be
  // stranded. Mirrors the client's placement gating.
  if (cmd.target.kind !== "axis" && cmd.target.kind !== "engine") {
    const openMandatory = (s.axis[crew] === null ? 1 : 0) + (s.engines[crew] === null ? 1 : 0);
    const diceLeft = s.dice[crew].filter((d) => !d.placed).length;
    if (diceLeft <= openMandatory) {
      throw new GameRuleError("Your remaining dice must go on the Axis and Engine.");
    }
  }

  // Apply any Coffee modifier to get the effective value.
  const delta = cmd.coffeeDelta ?? 0;
  const spend = Math.abs(delta);
  if (spend > s.coffee) throw new GameRuleError("Not enough Coffee tokens.");
  const value = (die.value + delta) as number;
  if (value < 1 || value > 6) throw new GameRuleError("Coffee cannot push a die outside 1–6.");

  applyPlacement(s, crew, value as DieValue, cmd.target);

  // Commit the die + coffee spend now that placement succeeded.
  die.placed = true;
  s.coffee -= spend;
  if (delta !== 0) s.log.push(`${crewLabel(crew)} used ${spend} Coffee (die → ${value}).`);
  s.placedThisRound += 1;

  // A mid-round effect (spin / collision / overshoot) may have ended the game.
  if (s.outcome) {
    s.phase = "lost";
    return { state: s, description: lossText(s) };
  }

  if (s.placedThisRound >= DICE_PER_PLAYER * 2) {
    endOfRound(s);
    return { state: s, description: endText(s) };
  }

  s.turn = other(crew);
  return { state: s, description: "Die placed." };
}

// --- placement dispatch -----------------------------------------------------

function applyPlacement(s: GameState, crew: Crew, value: DieValue, target: PlacementTarget): void {
  switch (target.kind) {
    case "axis":
      return placeAxis(s, crew, value);
    case "engine":
      return placeEngine(s, crew, value);
    case "radio":
      return placeRadio(s, crew, value, target.slot);
    case "landingGear":
      return placeLandingGear(s, crew, value, target.slot);
    case "flaps":
      return placeFlaps(s, crew, value, target.slot);
    case "brakes":
      return placeBrakes(s, crew, value, target.slot);
    case "concentration":
      return placeConcentration(s, crew, value, target.slot);
    default:
      return assertNever(target);
  }
}

function placeAxis(s: GameState, crew: Crew, value: DieValue): void {
  if (s.axis[crew] !== null) throw new GameRuleError("Your Axis die is already placed.");
  s.axis[crew] = value;
  if (s.axis.pilot !== null && s.axis.copilot !== null) resolveAxis(s);
}

/** Tilt by the difference, toward the higher die; spinning out = loss. */
function resolveAxis(s: GameState): void {
  const p = s.axis.pilot!;
  const c = s.axis.copilot!;
  if (p !== c) {
    s.axis.offset += p > c ? p - c : -(c - p); // + toward Pilot, − toward Co-Pilot
  }
  s.log.push(`Axis: ${p} vs ${c} → tilt ${s.axis.offset >= 0 ? "+" : ""}${s.axis.offset}.`);
  if (Math.abs(s.axis.offset) >= s.scenario.axisSpinAt) {
    lose(s, "The plane went into a spin!");
  }
}

function placeEngine(s: GameState, crew: Crew, value: DieValue): void {
  if (s.engines[crew] !== null) throw new GameRuleError("Your Engine die is already placed.");
  s.engines[crew] = value;
  if (s.engines.pilot !== null && s.engines.copilot !== null) resolveEngines(s);
}

/** Sum the engine dice → speed → advance the Approach Track (or, in the final
 *  round, just record the speed for the brake comparison). */
function resolveEngines(s: GameState): void {
  const speed = s.engines.pilot! + s.engines.copilot!;
  s.lastSpeed = speed;

  if (isFinalRound(s)) {
    s.log.push(`Final approach speed: ${speed}.`);
    return; // no movement on the landing round
  }

  const advance = speed <= s.aeroBlue ? 0 : speed > s.aeroOrange ? 2 : 1;
  s.log.push(`Engines: speed ${speed} → advance ${advance}.`);
  if (advance === 0) return;

  // Move one space at a time. The plane collides with traffic on any space it
  // leaves or flies through — i.e. every space it passes over except the one it
  // finally lands on. Moving past the airport overshoots.
  const airport = airportIndex(s.scenario);
  for (let step = 0; step < advance; step++) {
    if (s.airplanes[s.position] > 0) {
      return lose(s, "Collision with traffic!");
    }
    if (s.position === airport) {
      return lose(s, "Overshot the airport!");
    }
    s.position += 1;
  }
}

function placeRadio(s: GameState, crew: Crew, value: DieValue, slot: number): void {
  if (crew === "pilot") {
    if (slot !== 0 || RADIO_PILOT_SLOTS !== 1) throw new GameRuleError("Invalid Radio space.");
    if (s.radioPilot !== null) throw new GameRuleError("That Radio space is taken.");
    s.radioPilot = value;
  } else {
    if (slot < 0 || slot >= RADIO_COPILOT_SLOTS) throw new GameRuleError("Invalid Radio space.");
    if (s.radioCopilot[slot] !== null) throw new GameRuleError("That Radio space is taken.");
    s.radioCopilot[slot] = value;
  }
  // Value N clears one airplane N−1 spaces ahead (N=1 → current position).
  const target = s.position + (value - 1);
  if (target < s.airplanes.length && s.airplanes[target] > 0) {
    s.airplanes[target] -= 1;
    s.log.push(`Radio: cleared an airplane on space ${target}.`);
  } else {
    s.log.push(`Radio: nothing to clear on space ${target}.`);
  }
}

function placeLandingGear(s: GameState, crew: Crew, value: DieValue, slot: number): void {
  if (crew !== "pilot") throw new GameRuleError("Only the Pilot deploys the Landing Gear.");
  requireSlot(slot, LANDING_GEAR_VALUES.length);
  // Once a section is deployed (green) it stays down for the rest of the game —
  // re-placing would silently waste the die. gearSlots resets each round, so the
  // permanent gearGreen flag is what makes a section unavailable.
  if (s.gearSlots[slot] !== null || s.gearGreen[slot]) throw new GameRuleError("That Landing Gear is already deployed.");
  if (!LANDING_GEAR_VALUES[slot].includes(value)) {
    throw new GameRuleError(`Landing Gear ${slot + 1} needs ${LANDING_GEAR_VALUES[slot].join(" or ")}.`);
  }
  s.gearSlots[slot] = value;
  if (!s.gearGreen[slot]) {
    s.gearGreen[slot] = true;
    s.aeroBlue += 1;
    s.log.push(`Landing Gear ${slot + 1} deployed.`);
  }
}

function placeFlaps(s: GameState, crew: Crew, value: DieValue, slot: number): void {
  if (crew !== "copilot") throw new GameRuleError("Only the Co-Pilot deploys the Flaps.");
  requireSlot(slot, FLAPS_VALUES.length);
  if (s.flapSlots[slot] !== null || s.flapsGreen[slot]) throw new GameRuleError("Those Flaps are already deployed.");
  if (!FLAPS_VALUES[slot].includes(value)) {
    throw new GameRuleError(`Flaps ${slot + 1} needs ${FLAPS_VALUES[slot].join(" or ")}.`);
  }
  const nextToDeploy = s.flapsGreen.findIndex((g) => !g);
  if (!s.flapsGreen[slot] && slot !== nextToDeploy) {
    throw new GameRuleError("Flaps must be deployed in order.");
  }
  s.flapSlots[slot] = value;
  if (!s.flapsGreen[slot]) {
    s.flapsGreen[slot] = true;
    s.aeroOrange += 1;
    s.log.push(`Flaps ${slot + 1} deployed.`);
  }
}

function placeBrakes(s: GameState, crew: Crew, value: DieValue, slot: number): void {
  if (crew !== "pilot") throw new GameRuleError("Only the Pilot deploys the Brakes.");
  requireSlot(slot, BRAKE_VALUES.length);
  if (s.brakeSlots[slot]) throw new GameRuleError("That Brakes space is taken.");
  if (value !== BRAKE_VALUES[slot]) {
    throw new GameRuleError(`Brakes ${slot + 1} needs a ${BRAKE_VALUES[slot]}.`);
  }
  // Only the next undeployed brake (slot === brakesDeployed) is legal: a higher
  // slot is out of order, a lower one is already deployed (and would waste the die).
  if (slot !== s.brakesDeployed) throw new GameRuleError("Brakes must be deployed in order.");
  s.brakeSlots[slot] = true;
  if (slot === s.brakesDeployed) {
    s.brakesDeployed += 1;
    s.log.push(`Brakes set to ${BRAKE_VALUES[slot]}.`);
  }
}

function placeConcentration(s: GameState, crew: Crew, value: DieValue, slot: number): void {
  requireSlot(slot, CONCENTRATION_SLOTS);
  if (s.concentrationSlots[slot] !== null) throw new GameRuleError("That Concentration space is taken.");
  s.concentrationSlots[slot] = { value, crew };
  if (s.coffee < MAX_COFFEE) {
    s.coffee += 1;
    s.log.push(`Concentration: gained a Coffee token (${s.coffee}/${MAX_COFFEE}).`);
  } else {
    s.log.push("Concentration: Coffee already full.");
  }
}

// --- end of round / landing -------------------------------------------------

function endOfRound(s: GameState): void {
  // Mandatory: one die of each crew on both the Axis and the Engines.
  const mandatoryMet =
    s.axis.pilot !== null &&
    s.axis.copilot !== null &&
    s.engines.pilot !== null &&
    s.engines.copilot !== null;
  if (!mandatoryMet) {
    lose(s, "A mandatory Axis or Engine die was missing at the end of the round.");
    s.phase = "lost";
    return;
  }

  if (isFinalRound(s)) {
    evaluateLanding(s);
    return;
  }

  // Descend and begin the next round (the server will issue the roll).
  s.round += 1;
  s.altitudeFeet = s.scenario.startAltitudeFeet - (s.round - 1) * s.scenario.feetPerRound;
  s.phase = "rolling";
  s.log.push(`End of round — descending to ${altitudeLabel(s)}.`);
}

/** The landing round: the last Altitude space. */
function isFinalRound(s: GameState): boolean {
  return s.round >= s.scenario.rounds;
}

function evaluateLanding(s: GameState): void {
  const reasons: string[] = [];

  if (s.position !== airportIndex(s.scenario)) reasons.push("did not reach the airport in time");
  if (airplanesRemaining(s) > 0) reasons.push("airplanes still on the approach path");
  if (!s.gearGreen.every(Boolean)) reasons.push("landing gear not fully deployed");
  if (!s.flapsGreen.every(Boolean)) reasons.push("flaps not fully deployed");
  if (s.axis.offset !== 0) reasons.push("plane not level");

  const brakeValue = s.brakesDeployed > 0 ? BRAKE_VALUES[s.brakesDeployed - 1] : 0;
  const speed = s.lastSpeed ?? (s.engines.pilot ?? 0) + (s.engines.copilot ?? 0);
  if (!(s.brakesDeployed > 0 && speed <= brakeValue)) reasons.push("speed too high for the brakes");

  if (reasons.length === 0) {
    s.phase = "won";
    s.outcome = { result: "won" };
    s.log.push("🛬 Smooth landing — the passengers applaud!");
  } else {
    lose(s, `Landing failed: ${reasons.join("; ")}.`);
    s.phase = "lost";
  }
}

// --- helpers ----------------------------------------------------------------

function lose(s: GameState, reason: string): void {
  if (s.outcome) return; // keep the first cause
  s.outcome = { result: "lost", reason };
  s.log.push(`💥 ${reason}`);
}

function requireCrew(s: GameState, playerId: PlayerId): Crew {
  const crew = crewOf(s, playerId);
  if (!crew) throw new GameRuleError("You are not a crew member in this game.");
  return crew;
}

function requireSlot(slot: number, count: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= count) {
    throw new GameRuleError("Invalid space.");
  }
}

function other(crew: Crew): Crew {
  return crew === "pilot" ? "copilot" : "pilot";
}

function crewLabel(crew: Crew): string {
  return crew === "pilot" ? "Pilot" : "Co-Pilot";
}

function altitudeLabel(s: GameState): string {
  return `${s.altitudeFeet.toLocaleString()} ft`;
}

function endText(s: GameState): string {
  if (s.phase === "won") return "Landed!";
  if (s.phase === "lost") return lossText(s);
  return "Round complete.";
}

function lossText(s: GameState): string {
  return s.outcome && s.outcome.result === "lost" ? s.outcome.reason : "Game over.";
}

function assertNever(x: never): never {
  throw new GameRuleError(`Unhandled: ${JSON.stringify(x)}`);
}
