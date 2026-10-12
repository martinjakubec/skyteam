// A reroll's old → new faces: kept for the crew that rolled, and only sent to them.
import { expect, test } from "vitest";
import { DEFAULT_SETUP, mulberry32, newGame, normalizeGameState, reduce, redactGameStateFor } from "../packages/shared/src/index.ts";

const P = "p1", C = "p2";
/** Round 1 of the default card, which grants a Reroll token; the Pilot leads. */
const dealt = () => newGame(DEFAULT_SETUP, P, C, mulberry32(7), 0);
const faces = (game, crew, ids) => ids.map((id) => game.dice[crew].find((d) => d.id === id).value);

test("a joint reroll notes each crew's own dice, old → new, against its log line", () => {
  let g = dealt();
  expect(g.rerollTokens).toBe(1);
  expect(g.rerolls).toEqual({ pilot: [], copilot: [] });

  const pFrom = faces(g, "pilot", [2, 0]);
  g = reduce(g, { type: "reroll", dieIds: [2, 0], values: [6, 6] }, P).state;
  expect(g.rerolls.pilot).toEqual([{ logIndex: g.log.length - 1, dieIds: [2, 0], from: pFrom, to: [6, 6] }]);
  expect(g.log[g.rerolls.pilot[0].logIndex]).toBe("Pilot spent a Reroll token (2 dice).");

  const cFrom = faces(g, "copilot", [1]);
  g = reduce(g, { type: "reroll", dieIds: [1], values: [cFrom[0]] }, C).state; // lands on its old face
  expect(g.rerolls.copilot).toEqual([{ logIndex: g.log.length - 1, dieIds: [1], from: cFrom, to: cFrom }]);
  expect(g.log[g.rerolls.copilot[0].logIndex]).toBe("Co-Pilot rerolled 1 die.");
});

test("declining notes nothing", () => {
  let g = dealt();
  g = reduce(g, { type: "reroll", dieIds: [0], values: [3] }, P).state;
  g = reduce(g, { type: "reroll", dieIds: [], values: [] }, C).state;
  expect(g.rerolls.copilot).toEqual([]);
});

test("each crew is sent only its own reroll notes; spectators none", () => {
  let g = dealt();
  g = reduce(g, { type: "reroll", dieIds: [0], values: [3] }, P).state;
  g = reduce(g, { type: "reroll", dieIds: [1, 2], values: [4, 5] }, C).state;
  expect(redactGameStateFor(g, P).rerolls).toEqual({ pilot: g.rerolls.pilot, copilot: [] });
  expect(redactGameStateFor(g, C).rerolls).toEqual({ pilot: [], copilot: g.rerolls.copilot });
  expect(redactGameStateFor(g, "observer").rerolls).toEqual({ pilot: [], copilot: [] });
});

test("Anticipation's reroll is noted too", () => {
  let g = newGame({ ...DEFAULT_SETUP, abilities: ["anticipation"] }, P, C, mulberry32(7), 0);
  const was = faces(g, "pilot", [3]);
  g = reduce(g, { type: "anticipate", dieId: 3, value: 2 }, P).state;
  expect(g.rerolls.pilot).toEqual([{ logIndex: g.log.length - 1, dieIds: [3], from: was, to: [2] }]);
});

test("a game saved before reroll notes gets empty ones", () => {
  const g = dealt();
  delete g.rerolls;
  expect(normalizeGameState(g).rerolls).toEqual({ pilot: [], copilot: [] });
});
