import type { GameCommand, PlayerId } from "../protocol";
import { TRAFFIC_DIE_FACES } from "./abilities";
import { scenarioForSetup, type GameSetup } from "./catalog";
import { reduce, reduceInPlace, type ReduceCommand } from "./reducer";
import { DICE_PER_PLAYER, INTERN_TOKEN_COUNT, type DieValue } from "./scenario";
import { createInitialGameState, type GameState } from "./state";

/**
 * Where dice values come from. The reducer is pure, so whoever drives it — the
 * server (secure random numbers) or a tutorial (scripted values) — supplies
 * every roll through one of these.
 */
export interface Dice {
  /** A six-sided die. */
  d6(): DieValue;
  /** A Traffic die face (2, 3, 3, 4, 4, 5). */
  traffic(): DieValue;
}

/** A player's command as the reducer takes it: a reroll and Anticipation are
 *  intents, so their new values are added here. */
export function withEntropy(command: GameCommand, dice: Dice): ReduceCommand {
  if (command.type === "reroll") return { type: "reroll", dieIds: command.dieIds, values: command.dieIds.map(() => dice.d6()) };
  if (command.type === "anticipate") return { type: "anticipate", dieId: command.dieId, value: dice.d6() };
  return command;
}

/** A round's roll: both hands, plus one Traffic die roll per Traffic icon on
 *  the Current Position — stamped with the clock for Real-Time. */
export function roundRoll(game: GameState, dice: Dice, at: number): ReduceCommand {
  const hand = () => Array.from({ length: DICE_PER_PLAYER }, () => dice.d6());
  const trafficDice = game.scenario.approachTrack[game.position]?.trafficDice ?? 0;
  return { type: "roll", pilot: hand(), copilot: hand(), traffic: Array.from({ length: trafficDice }, () => dice.traffic()), at };
}

/**
 * Supply what the reducer asked for after a command: Traffic die rolls
 * (Synchronisation) and, once a round has ended, the next round's dice.
 */
export function settle(game: GameState, dice: Dice, now: () => number): GameState {
  game = settleTraffic(game, dice);
  while (game.phase === "rolling" && !game.outcome) game = reduce(game, roundRoll(game, dice, now()), "").state;
  return game;
}

/** Only the Traffic die rolls: a round that ended stays in `rolling`, its
 *  dice not yet dealt (the live server deals after the crews' debrief). */
export function settleTraffic(game: GameState, dice: Dice): GameState {
  while (game.trafficPending && !game.outcome) game = reduce(game, { type: "rollTraffic", value: dice.traffic() }, "").state;
  return game;
}

/** A source of randomness: a uniform integer in [0, n). The server passes
 *  crypto's randomInt; self-play and tests pass a seeded PRNG. */
export type Rand = (n: number) => number;

/** Dice whose values come from `rand`. */
export function randDice(rand: Rand): Dice {
  return {
    d6: () => (rand(6) + 1) as DieValue,
    traffic: () => TRAFFIC_DIE_FACES[rand(TRAFFIC_DIE_FACES.length)],
  };
}

/** The Intern tokens 1..6 in a random face-up order (Fisher–Yates). */
export function shuffledInternTokens(rand: Rand): DieValue[] {
  const t = Array.from({ length: INTERN_TOKEN_COUNT }, (_, i) => (i + 1) as DieValue);
  for (let i = t.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [t[i], t[j]] = [t[j], t[i]];
  }
  return t;
}

/** Deal a game for a lobby setup and roll round 1 (`at` stamps a Real-Time
 *  clock; `realTimeSeconds` shortens its rounds — test servers only). */
export function newGame(
  setup: GameSetup,
  pilotId: PlayerId,
  copilotId: PlayerId,
  rand: Rand,
  at: number,
  opts: { realTimeSeconds?: number } = {},
): GameState {
  const scenario = { ...scenarioForSetup(setup), ...(opts.realTimeSeconds ? { realTimeSeconds: opts.realTimeSeconds } : {}) };
  const game = createInitialGameState(scenario, pilotId, copilotId, { internTokens: shuffledInternTokens(rand) });
  return reduce(game, roundRoll(game, randDice(rand), at), "").state;
}

/** One player action end to end, as the server performs it: add server values
 *  (rerolls), apply, then supply what the reducer asks for (Traffic dice, the
 *  next round's roll). Throws GameRuleError if the action is illegal. */
export function applyIntent(game: GameState, command: GameCommand, playerId: PlayerId, rand: Rand, now: () => number): GameState {
  const dice = randDice(rand);
  return settle(reduce(game, withEntropy(command, dice), playerId).state, dice, now);
}

/** applyIntent on a state the caller owns: no copies (bot rollouts). */
export function applyIntentInPlace(game: GameState, command: GameCommand, playerId: PlayerId, rand: Rand, now: () => number): GameState {
  const dice = randDice(rand);
  let g = reduceInPlace(game, withEntropy(command, dice), playerId).state;
  while (g.trafficPending && !g.outcome) g = reduceInPlace(g, { type: "rollTraffic", value: dice.traffic() }, "").state;
  while (g.phase === "rolling" && !g.outcome) g = reduceInPlace(g, roundRoll(g, dice, now()), "").state;
  return g;
}
