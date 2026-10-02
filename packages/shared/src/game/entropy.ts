import type { GameCommand } from "../protocol";
import { reduce, type ReduceCommand } from "./reducer";
import { DICE_PER_PLAYER, type DieValue } from "./scenario";
import type { GameState } from "./state";

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
  while (game.trafficPending && !game.outcome) game = reduce(game, { type: "rollTraffic", value: dice.traffic() }, "").state;
  while (game.phase === "rolling" && !game.outcome) game = reduce(game, roundRoll(game, dice, now()), "").state;
  return game;
}
