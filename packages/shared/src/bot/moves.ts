import type { GameCommand, PlacementTarget, PlayerId } from "../protocol";
import { GameRuleError, reduce, type ReduceCommand } from "../game/reducer";
import type { Crew, DieValue } from "../game/scenario";
import type { GameState } from "../game/state";

export const playerIdOf = (view: GameState, crew: Crew): PlayerId => (crew === "pilot" ? view.pilotId : view.copilotId);

/** Every space, both sides, for trying candidates on the reducer. */
function allTargets(): PlacementTarget[] {
  const sides = ["pilot", "copilot"] as const;
  return [
    ...sides.flatMap((side) => [
      { kind: "axis" as const, side },
      { kind: "engine" as const, side },
      ...[0, 1].map((slot) => ({ kind: "radio" as const, slot, side })),
      { kind: "intern" as const, side },
    ]),
    ...[0, 1, 2].map((slot) => ({ kind: "landingGear" as const, slot })),
    ...[0, 1, 2, 3].map((slot) => ({ kind: "flaps" as const, slot })),
    ...[0, 1, 2].map((slot) => ({ kind: "brakes" as const, slot })),
    ...[0, 1].map((slot) => ({ kind: "concentration" as const, slot })),
    { kind: "kerosene" as const },
    ...[0, 1, 2, 3].flatMap((slot) => (["top", "bottom"] as const).map((space) => ({ kind: "iceBrakes" as const, slot, space }))),
  ];
}
const TARGETS = allTargets();

/** The reduce form of a wire command, with placeholder values where the server
 *  would add randomness (legality never depends on them). */
function asReduce(cmd: GameCommand): ReduceCommand {
  if (cmd.type === "reroll") return { ...cmd, values: cmd.dieIds.map(() => 1 as DieValue) };
  if (cmd.type === "anticipate") return { ...cmd, value: 1 };
  return cmd;
}

const legal = (view: GameState, crew: Crew, cmd: GameCommand): boolean => {
  try {
    reduce(view, asReduce(cmd), playerIdOf(view, crew));
    return true;
  } catch (e) {
    if (e instanceof GameRuleError) return false;
    throw e;
  }
};

/**
 * Every command `crew` may send now, found by trying candidates on the pure
 * reducer against the bot's own redacted view (rules live only there). Coffee
 * variants and reroll subsets are included; a Reroll response is any subset of
 * the crew's unplaced dice (including none).
 */
export function legalMoves(view: GameState, crew: Crew): GameCommand[] {
  const out: GameCommand[] = [];
  const hand = view.dice[crew].filter((d) => !d.placed);
  const add = (cmd: GameCommand) => legal(view, crew, cmd) && out.push(cmd);

  for (const target of TARGETS) add({ type: "placeTraffic", target }); // Synchronisation: any colour
  for (const target of TARGETS) if (!("side" in target) || target.side === crew) add({ type: "placeIntern", target });
  // A crew's own dice and tokens only ever go on its own side of per-crew spaces.
  const own = TARGETS.filter((t) => !("side" in t) || t.side === crew);
  for (const d of hand) {
    for (let coffee = -view.coffee; coffee <= view.coffee; coffee++) {
      for (const target of own) add({ type: "placeDie", dieId: d.id, target, ...(coffee ? { coffeeDelta: coffee } : {}) });
    }
    add({ type: "adapt", dieId: d.id });
    add({ type: "anticipate", dieId: d.id });
    add({ type: "swap", dieId: d.id });
  }
  // Rerolls: every subset of the unplaced dice (initiation needs ≥1; a response may be empty).
  for (let mask = 0; mask < 1 << hand.length; mask++) {
    add({ type: "reroll", dieIds: hand.filter((_, i) => mask & (1 << i)).map((d) => d.id) });
  }
  return out;
}
