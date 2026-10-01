import {
  airplanesRemaining,
  airportIndex,
  crewOf,
  emptyIceBrakeSlots,
  firstPlayerForRound,
  hasAbility,
  hasModule,
  nextInternToken,
  placementKey,
  type GameState,
} from "./state";
import {
  BRAKE_VALUES,
  CONCENTRATION_SLOTS,
  DICE_PER_PLAYER,
  FLAPS_VALUES,
  ICE_BRAKE_VALUES,
  KEROSENE_IDLE_BURN,
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
  | { type: "placeDie"; dieId: number; target: PlacementTarget; coffeeDelta?: number }
  | { type: "placeIntern"; target: PlacementTarget }
  | { type: "adapt"; dieId: number }
  | { type: "anticipate"; dieId: number; value: DieValue }
  | { type: "swap"; dieId: number }
  | { type: "rollTraffic"; value: DieValue }
  | { type: "placeTraffic"; target: PlacementTarget };

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
    case "placeIntern":
      return handlePlaceIntern(draft, command, byPlayerId);
    case "adapt":
      return handleAdapt(draft, command, byPlayerId);
    case "anticipate":
      return handleAnticipate(draft, command, byPlayerId);
    case "swap":
      return handleSwap(draft, command, byPlayerId);
    case "rollTraffic":
      return handleRollTraffic(draft, command);
    case "placeTraffic":
      return handlePlaceTraffic(draft, command, byPlayerId);
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
  s.keroseneSlot = null;
  // A half-filled Ice Brakes step's die is simply cleared: spent, no advance.
  s.iceBrakeSlots = emptyIceBrakeSlots();
  s.internSlots = { pilot: null, copilot: null };
  s.internHeld = null;
  s.internPlaced = [];
  s.anticipated = false;
  s.pendingSwap = null;
  s.swappedThisRound = false;
  s.syncDone = false;
  s.trafficPending = false;
  s.trafficHeld = null;
  s.trafficPlaced = [];
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
  if (s.internHeld) throw new GameRuleError("Place the Intern token first.");
  requireIdle(s);
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
  s.rerollSpent += 1;
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
  if (s.internHeld) throw new GameRuleError("Place the Intern token first.");
  requireIdle(s);
  const crew = requireCrew(s, byPlayerId);
  if (s.turn !== crew) throw new GameRuleError("It is not your turn.");

  requireOwnSide(cmd.target, crew);
  const die = s.dice[crew].find((d) => d.id === cmd.dieId);
  if (!die || die.value === undefined) throw new GameRuleError("No such die.");
  if (die.placed) throw new GameRuleError("That die has already been placed.");

  // Mandatory spots: every round a crew must seat one die on its Axis and one on
  // its Engine. Those dice are reserved — a non-mandatory placement is illegal
  // when the dice still in hand (this one included) are all needed to fill the
  // crew's still-open mandatory spots, otherwise a mandatory spot could be
  // stranded. Mirrors the client's placement gating. Intern training is exempt:
  // it swaps the die for a token that can fill a mandatory spot itself.
  if (cmd.target.kind !== "axis" && cmd.target.kind !== "engine" && cmd.target.kind !== "intern") {
    if (unplacedDice(s, crew) <= openMandatory(s, crew)) {
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

  checkSynchronisation(s);
  return afterPlacement(s, "Die placed.");
}

/**
 * Wrap up a placement. A mid-round effect (spin / collision / overshoot) may
 * have ended the game. Otherwise, while an extra is pending — an Intern token
 * to place, a Traffic die to roll or place — the turn waits (`s.turn` doesn't
 * change meanwhile). Then the round ends if every die is down, else the turn
 * passes.
 */
function afterPlacement(s: GameState, description: string): ReduceResult {
  if (s.outcome) {
    s.phase = "lost";
    return { state: s, description: lossText(s) };
  }
  if (s.internHeld || s.trafficPending || s.trafficHeld) return { state: s, description };
  if (s.placedThisRound >= DICE_PER_PLAYER * 2) {
    endOfRound(s);
    return { state: s, description: endText(s) };
  }
  s.turn = other(s.turn);
  return { state: s, description };
}

/**
 * Intern module: place the token just trained, as a die of its number for the
 * crew that trained it. Any normal space except Concentration (and the Intern
 * board); no Coffee. Then the turn passes (from `s.turn`) — or the round ends,
 * if that was the last die's training.
 */
function handlePlaceIntern(s: GameState, cmd: { target: PlacementTarget }, byPlayerId: PlayerId): ReduceResult {
  if (s.phase !== "placement") throw new GameRuleError("The game is not awaiting dice.");
  const crew = requireCrew(s, byPlayerId);
  requireIdle(s);
  const held = s.internHeld;
  if (!held || held.crew !== crew) throw new GameRuleError("You have no Intern token to place.");
  requireOwnSide(cmd.target, crew);
  checkInternTarget(s, crew, cmd.target);

  applyPlacement(s, crew, held.value, cmd.target);
  s.internPlaced.push(placementKey(crew, cmd.target));
  s.internHeld = null;
  s.log.push(`${crewLabel(crew)}'s Intern placed a ${held.value}.`);

  checkSynchronisation(s);
  return afterPlacement(s, "Intern token placed.");
}

/** Where an Intern token may go: not Concentration or the Intern board, and —
 *  like a die — not a free space while the crew's remaining dice are all needed
 *  for its open Axis/Engine spots. */
function checkInternTarget(s: GameState, crew: Crew, target: PlacementTarget): void {
  if (target.kind === "concentration") throw new GameRuleError("An Intern token can't go on Concentration.");
  if (target.kind === "intern") throw new GameRuleError("An Intern token can't go on the Intern board.");
  if (target.kind !== "axis" && target.kind !== "engine" && unplacedDice(s, crew) < openMandatory(s, crew)) {
    throw new GameRuleError("Your Intern token must go on the Axis or Engine.");
  }
}

/**
 * Intern module: training. Any die of a different value than the crew's next
 * token goes on the crew's own training space (once per round); the crew takes
 * that token and must place it at once. Training is refused if the token would
 * have nowhere legal to go, so the game can never get stuck on it. `fromHand`
 * is false when the Traffic die (Synchronisation) does the training: no die
 * leaves the crew's hand then.
 */
function trainIntern(s: GameState, crew: Crew, value: DieValue, fromHand = true): void {
  if (!hasModule(s, "intern")) throw new GameRuleError("The Intern module is not in play.");
  if (s.internSlots[crew] !== null) throw new GameRuleError("You have already trained the Intern this round.");
  const i = nextInternToken(s, crew);
  if (i === -1) throw new GameRuleError("The Intern is fully trained.");
  const token = s.internTokens[i]!;
  if (value === token) throw new GameRuleError(`The training die must differ from the next token (${token}).`);

  s.internSlots[crew] = value;
  s.internTokens[i] = null;
  if (!dieHasSpace(s, crew, token, { inHandAdjust: fromHand ? -1 : 0 })) {
    throw new GameRuleError(`The Intern's ${token} would have nowhere to go.`);
  }
  s.internHeld = { crew, value: token };
  s.log.push(`${crewLabel(crew)} trained the Intern (took a ${token}).`);
}

/** Every space a crew could in principle fill, for the "nowhere to go" check. */
const ALL_TARGETS: PlacementTarget[] = [
  { kind: "axis" },
  { kind: "engine" },
  ...[0, 1].map((slot) => ({ kind: "radio" as const, slot })),
  ...[0, 1, 2].map((slot) => ({ kind: "landingGear" as const, slot })),
  ...[0, 1, 2, 3].map((slot) => ({ kind: "flaps" as const, slot })),
  ...[0, 1, 2].map((slot) => ({ kind: "brakes" as const, slot })),
  { kind: "kerosene" },
  ...[0, 1, 2, 3].flatMap((slot) => (["top", "bottom"] as const).map((space) => ({ kind: "iceBrakes" as const, slot, space }))),
];

/** Every space the Traffic die could fill: any colour (both crews' per-crew
 *  spaces), plus Concentration and the Intern board. */
const TRAFFIC_TARGETS: PlacementTarget[] = [
  ...(["pilot", "copilot"] as const).flatMap((side) => [
    { kind: "axis" as const, side },
    { kind: "engine" as const, side },
    ...[0, 1].map((slot) => ({ kind: "radio" as const, slot, side })),
    { kind: "intern" as const, side },
  ]),
  ...ALL_TARGETS.filter((t) => t.kind !== "axis" && t.kind !== "engine" && t.kind !== "radio"),
  ...[0, 1].map((slot) => ({ kind: "concentration" as const, slot })),
];

/**
 * Whether a die of `value` has at least one legal space, tried on a copy of the
 * state. A crew's own extra (Intern token) also respects its Axis/Engine
 * reservation; `inHandAdjust` corrects the dice-in-hand count (-1 while the
 * training die is still unplaced in `s`). `anyColour` checks the Traffic die,
 * which goes on any empty space for the space's owner and isn't reserved.
 */
function dieHasSpace(
  s: GameState,
  crew: Crew,
  value: DieValue,
  { inHandAdjust = 0, anyColour = false }: { inHandAdjust?: number; anyColour?: boolean } = {},
): boolean {
  return (anyColour ? TRAFFIC_TARGETS : ALL_TARGETS).some((target) => {
    const trial = structuredClone(s);
    if (!anyColour) {
      const inHand = unplacedDice(trial, crew) + inHandAdjust;
      if (target.kind !== "axis" && target.kind !== "engine" && inHand < openMandatory(trial, crew)) return false;
    }
    try {
      placeAs(trial, anyColour ? spaceOwner(target, crew) : crew, value, target, !anyColour);
      return true;
    } catch (e) {
      if (e instanceof GameRuleError) return false;
      throw e;
    }
  });
}

/** Which crew a space belongs to, for a die placed "regardless of colour". */
function spaceOwner(target: PlacementTarget, placer: Crew): Crew {
  switch (target.kind) {
    case "axis":
    case "engine":
    case "radio":
    case "intern":
      return target.side ?? placer;
    case "landingGear":
    case "brakes":
      return "pilot";
    case "flaps":
      return "copilot";
    case "iceBrakes":
      return target.space === "top" ? "pilot" : placer;
    default:
      return placer; // shared spaces: Concentration, Kerosene
  }
}

/** applyPlacement, except that the Intern board is trained by an extra die
 *  (Traffic die) without spending a die from the owner's hand. */
function placeAs(s: GameState, owner: Crew, value: DieValue, target: PlacementTarget, fromHand: boolean): void {
  if (target.kind === "intern") return trainIntern(s, owner, value, fromHand);
  applyPlacement(s, owner, value, target);
}

/** A crew's own die or token may only name its own side of a per-crew space. */
function requireOwnSide(target: PlacementTarget, crew: Crew): void {
  if ("side" in target && target.side && target.side !== crew) {
    throw new GameRuleError("That space belongs to the other crew.");
  }
}

/**
 * Synchronisation (Special Ability): once per round, as soon as there's a die
 * on Landing Gear and one on Flaps, the Traffic die must be rolled. The server
 * answers `trafficPending` with a rollTraffic command.
 */
function checkSynchronisation(s: GameState): void {
  if (!hasAbility(s, "synchronisation") || s.syncDone) return;
  if (s.gearSlots.some((v) => v !== null) && s.flapSlots.some((v) => v !== null)) {
    s.syncDone = true;
    s.trafficPending = true;
    s.log.push("Synchronisation: Gear and Flaps are in — rolling the Traffic die.");
  }
}

/** Server-supplied Traffic die roll. With no legal space at all it's discarded,
 *  so the game can't get stuck on it. */
function handleRollTraffic(s: GameState, cmd: { value: DieValue }): ReduceResult {
  if (!s.trafficPending) throw new GameRuleError("There is no Traffic die to roll.");
  s.trafficPending = false;
  if (!dieHasSpace(s, "copilot", cmd.value, { anyColour: true })) {
    s.log.push(`Synchronisation: the Traffic die (${cmd.value}) has nowhere to go.`);
    return afterPlacement(s, "Traffic die discarded.");
  }
  s.trafficHeld = { value: cmd.value };
  s.log.push(`Synchronisation: Traffic die rolled ${cmd.value} — the Co-Pilot places it.`);
  return { state: s, description: "Traffic die rolled." };
}

/** The Co-Pilot places the Traffic die on any empty space, regardless of colour,
 *  where it acts as a normal die for that space's crew. An extra action. */
function handlePlaceTraffic(s: GameState, cmd: { target: PlacementTarget }, byPlayerId: PlayerId): ReduceResult {
  if (s.phase !== "placement") throw new GameRuleError("The game is not awaiting dice.");
  const crew = requireCrew(s, byPlayerId);
  const held = s.trafficHeld;
  if (!held) throw new GameRuleError("There is no Traffic die to place.");
  if (crew !== "copilot") throw new GameRuleError("Placing the Traffic die is the Co-Pilot's duty.");
  const owner = spaceOwner(cmd.target, crew);
  placeAs(s, owner, held.value, cmd.target, false);
  s.trafficPlaced.push(placementKey(owner, cmd.target));
  s.trafficHeld = null;
  s.log.push(`The Co-Pilot placed the Traffic die (${held.value}).`);
  return afterPlacement(s, "Traffic die placed.");
}

// --- Special Abilities ------------------------------------------------------

/** Adaptation: once per game, a player turns one unplaced die to its opposite
 *  face (1↔6, 2↔5, 3↔4) — on either player's turn. */
function handleAdapt(s: GameState, cmd: { dieId: number }, byPlayerId: PlayerId): ReduceResult {
  if (s.phase !== "placement") throw new GameRuleError("You can only adapt a die during placement.");
  if (!hasAbility(s, "adaptation")) throw new GameRuleError("Adaptation is not in play.");
  if (s.pendingReroll !== null || s.internHeld) throw new GameRuleError("Finish the current action first.");
  requireIdle(s);
  const crew = requireCrew(s, byPlayerId);
  if (s.adaptationUsed[crew]) throw new GameRuleError("You have already used Adaptation.");
  const die = s.dice[crew].find((d) => d.id === cmd.dieId);
  if (!die || die.value === undefined || die.placed) throw new GameRuleError("Pick one of your unplaced dice.");
  die.value = (7 - die.value) as DieValue;
  s.adaptationUsed[crew] = true;
  s.log.push(`${crewLabel(crew)} used Adaptation.`);
  return { state: s, description: "Die turned over." };
}

/** Anticipation: each round, before placing their first die, the First Player
 *  may reroll one of their dice (value supplied by the server). */
function handleAnticipate(s: GameState, cmd: { dieId: number; value: DieValue }, byPlayerId: PlayerId): ReduceResult {
  if (s.phase !== "placement") throw new GameRuleError("You can only anticipate during placement.");
  if (!hasAbility(s, "anticipation")) throw new GameRuleError("Anticipation is not in play.");
  if (s.pendingReroll !== null || s.internHeld) throw new GameRuleError("Finish the current action first.");
  requireIdle(s);
  const crew = requireCrew(s, byPlayerId);
  if (crew !== firstPlayerForRound(s.round)) throw new GameRuleError("Only the First Player can anticipate.");
  if (s.anticipated) throw new GameRuleError("Anticipation is already used this round.");
  if (s.dice[crew].some((d) => d.placed)) throw new GameRuleError("Only before your first die.");
  const die = s.dice[crew].find((d) => d.id === cmd.dieId);
  if (!die || die.placed) throw new GameRuleError("No such die.");
  die.value = cmd.value;
  s.anticipated = true;
  s.log.push(`${crewLabel(crew)} used Anticipation (rerolled one die).`);
  return { state: s, description: "Die rerolled." };
}

/**
 * Working Together (once per round): the active player offers one unplaced die;
 * the other player must answer with one of theirs; the two values swap and both
 * dice stay in their owners' hands. A two-step handshake like the joint reroll:
 * `pendingSwap` locks every other action until the answer arrives.
 */
function handleSwap(s: GameState, cmd: { dieId: number }, byPlayerId: PlayerId): ReduceResult {
  if (s.phase !== "placement") throw new GameRuleError("You can only work together during placement.");
  if (!hasAbility(s, "workingTogether")) throw new GameRuleError("Working Together is not in play.");
  const crew = requireCrew(s, byPlayerId);
  const die = s.dice[crew].find((d) => d.id === cmd.dieId);
  if (!die || die.value === undefined || die.placed) throw new GameRuleError("Pick one of your unplaced dice.");

  if (s.pendingSwap === null) {
    if (s.turn !== crew) throw new GameRuleError("Only the active player can start Working Together.");
    if (s.swappedThisRound) throw new GameRuleError("Working Together is already used this round.");
    if (s.pendingReroll !== null || s.internHeld) throw new GameRuleError("Finish the current action first.");
    requireNoTraffic(s);
    if (s.dice[other(crew)].every((d) => d.placed)) throw new GameRuleError("The other player has no dice to swap.");
    s.pendingSwap = { from: crew, dieId: die.id };
    s.swappedThisRound = true;
    s.log.push(`${crewLabel(crew)} asks to work together.`);
    return { state: s, description: "Swap offered." };
  }
  if (crew === s.pendingSwap.from) throw new GameRuleError("Waiting for the other player to answer.");
  const offered = s.dice[s.pendingSwap.from].find((d) => d.id === s.pendingSwap!.dieId)!;
  [offered.value, die.value] = [die.value, offered.value];
  s.pendingSwap = null;
  s.log.push("Working Together: two dice swapped values.");
  return { state: s, description: "Dice swapped." };
}

/** While a Working Together offer awaits its answer, or a Traffic die waits to
 *  be rolled or placed, nothing else may happen. */
function requireIdle(s: GameState): void {
  if (s.pendingSwap) throw new GameRuleError("A Working Together swap is in progress.");
  requireNoTraffic(s);
}

function requireNoTraffic(s: GameState): void {
  if (s.trafficPending || s.trafficHeld) throw new GameRuleError("The Co-Pilot must place the Traffic die first.");
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
    case "kerosene":
      return placeKerosene(s, crew, value);
    case "iceBrakes":
      return placeIceBrakes(s, crew, value, target.slot, target.space);
    case "intern":
      return trainIntern(s, crew, value);
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
  // Control (Special Ability): matching Axis dice earn a Coffee (capped).
  if (hasAbility(s, "control") && p === c && s.coffee < MAX_COFFEE) {
    s.coffee += 1;
    s.log.push("Control: matching Axis dice — gained a Coffee.");
  }
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

  // Mastery (Special Ability): matching Engine dice regain a spent Reroll token.
  if (hasAbility(s, "mastery") && s.engines.pilot === s.engines.copilot && s.rerollSpent > 0) {
    s.rerollSpent -= 1;
    s.rerollTokens += 1;
    s.log.push("Mastery: matching Engine dice — regained a Reroll token.");
  }

  // Kerosene Leak: the Engine dice drain the tank by their difference + 1, the
  // moment both are seated — every round, the landing round included. A dry
  // tank loses before the plane moves (or lands).
  if (hasModule(s, "keroseneLeak")) {
    const leak = Math.abs(s.engines.pilot! - s.engines.copilot!) + 1;
    burnKerosene(s, leak, `Kerosene leak: Engines ${s.engines.pilot} vs ${s.engines.copilot} lost ${leak}`);
    if (s.outcome) return;
  }

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
  if (hasModule(s, "iceBrakes")) throw new GameRuleError("The Ice Brakes replace the Brakes.");
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
  // `!= null` (not `!== null`) so an empty cell serialised as undefined counts as
  // free — matches the client, which also treats null/undefined as empty.
  if (s.concentrationSlots[slot] != null) throw new GameRuleError("That Concentration space is taken.");
  s.concentrationSlots[slot] = { value, crew };
  if (s.coffee < MAX_COFFEE) {
    s.coffee += 1;
    s.log.push(`Concentration: gained a Coffee token (${s.coffee}/${MAX_COFFEE}).`);
  } else {
    s.log.push("Concentration: Coffee already full.");
  }
}

/**
 * Ice Brakes module: steps 2 → 3 → 4 → 5, only the next one open. Each has a
 * Pilot-only top space and an either-crew bottom space, filled in any order;
 * once both hold the step's value (same round), the marker passes the step —
 * which opens the next one, so several can complete in one round.
 */
function placeIceBrakes(s: GameState, crew: Crew, value: DieValue, slot: number, space: "top" | "bottom"): void {
  if (!hasModule(s, "iceBrakes")) throw new GameRuleError("The Ice Brakes module is not in play.");
  requireSlot(slot, ICE_BRAKE_VALUES.length);
  if (slot !== s.brakesDeployed) throw new GameRuleError("Ice Brakes must be deployed in order.");
  const need = ICE_BRAKE_VALUES[slot];
  if (value !== need) throw new GameRuleError(`Ice Brakes ${need} needs a ${need}.`);
  const step = s.iceBrakeSlots[slot];
  if (space === "top") {
    if (crew !== "pilot") throw new GameRuleError("Only the Pilot can use the top Ice Brakes space.");
    if (step.top !== null) throw new GameRuleError("That Ice Brakes space is taken.");
    step.top = value;
  } else {
    if (step.bottom !== null) throw new GameRuleError("That Ice Brakes space is taken.");
    step.bottom = { value, crew };
  }
  if (step.top !== null && step.bottom !== null) {
    s.brakesDeployed += 1;
    s.log.push(`Ice Brakes set to ${need}.`);
  }
}

/** Kerosene module: either crew may seat one die per round; the marker drops by
 *  its value straight away, and hitting the empty space loses at once. */
function placeKerosene(s: GameState, crew: Crew, value: DieValue): void {
  if (!hasModule(s, "kerosene")) throw new GameRuleError("The Kerosene module is not in play.");
  if (s.keroseneSlot != null) throw new GameRuleError("The Kerosene space is taken.");
  s.keroseneSlot = { value, crew };
  burnKerosene(s, value, `${crewLabel(crew)} burned ${value} Kerosene`);
}

function burnKerosene(s: GameState, amount: number, what: string): void {
  s.kerosene = Math.max(0, s.kerosene - amount);
  s.log.push(`${what} (${s.kerosene} left).`);
  if (s.kerosene <= 0) lose(s, "Ran out of kerosene!");
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

  // Kerosene: an empty Kerosene space still burns fuel — even in the final
  // round, so a dry tank beats the landing check.
  if (hasModule(s, "kerosene") && s.keroseneSlot == null) {
    burnKerosene(s, KEROSENE_IDLE_BURN, `Kerosene space left empty: burned ${KEROSENE_IDLE_BURN}`);
    if (s.outcome) {
      s.phase = "lost";
      return;
    }
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

  // Ice Brakes: the marker must be past the 5 (every step done) to land at all.
  const ice = hasModule(s, "iceBrakes");
  if (ice && s.brakesDeployed < ICE_BRAKE_VALUES.length) reasons.push("ice brakes not fully deployed");
  if (hasModule(s, "intern") && s.internTokens.some((t) => t !== null)) reasons.push("intern not fully trained");
  const brakeSteps = ice ? ICE_BRAKE_VALUES : BRAKE_VALUES;
  const brakeValue = s.brakesDeployed > 0 ? brakeSteps[s.brakesDeployed - 1] : 0;
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

/** Dice still in a crew's hand this round. */
function unplacedDice(s: GameState, crew: Crew): number {
  return s.dice[crew].filter((d) => !d.placed).length;
}

/** The crew's Axis + Engine spots still to fill this round (0..2). */
function openMandatory(s: GameState, crew: Crew): number {
  return (s.axis[crew] === null ? 1 : 0) + (s.engines[crew] === null ? 1 : 0);
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
