// Seeded dice: every live game draws from a secret seed, in named streams (the
// Intern order, each round's deal, each round's other rolls), so the same seed
// gives the same Intern order and the same deal every round — whatever the
// players did — and a restarted server carries on mid-stream.
import { expect, test } from "vitest";

const { newSeed, newSeedState, seededRand } = await import("../packages/server/src/seededRand.ts");

const draws = (state, label, count, n = 6) => {
  const rand = seededRand(state, () => label);
  return Array.from({ length: count }, () => rand(n));
};

test("a seed is 32 hex characters, and never the same twice", () => {
  const seeds = new Set(Array.from({ length: 200 }, newSeed));
  expect(seeds.size).toBe(200);
  for (const s of seeds) expect(s).toMatch(/^[0-9a-f]{32}$/);
});

test("the same seed and stream give the same draws; another seed doesn't", () => {
  const seed = newSeed();
  expect(draws(newSeedState(seed), "d1", 50)).toEqual(draws(newSeedState(seed), "d1", 50));
  expect(draws(newSeedState(seed), "d1", 50)).not.toEqual(draws(newSeedState(newSeed()), "d1", 50));
  expect(draws(newSeedState(seed), "d1", 50)).not.toEqual(draws(newSeedState(seed), "d2", 50));
});

test("draws stay in range and are about uniform", () => {
  const counts = [0, 0, 0, 0, 0, 0];
  for (const v of draws(newSeedState(newSeed()), "p1", 60_000)) counts[v]++;
  for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(300);
  for (const v of draws(newSeedState(newSeed()), "p1", 1000, 7)) expect(v >= 0 && v < 7).toBe(true);
});

test("a stream doesn't care how much the others drew: round 2's deal is round 2's deal", () => {
  const seed = newSeed();
  const a = newSeedState(seed);
  draws(a, "p1", 3); // round 1: few rerolls
  const b = newSeedState(seed);
  draws(b, "p1", 40); // round 1: many rerolls
  expect(draws(a, "d2", 8)).toEqual(draws(b, "d2", 8));
});

test("the state survives JSON (the room record in Redis): a restart carries on mid-stream", () => {
  const seed = newSeed();
  const live = newSeedState(seed);
  draws(live, "p3", 5);
  const restarted = JSON.parse(JSON.stringify(live));
  expect(draws(restarted, "p3", 10)).toEqual(draws(live, "p3", 10));
});

test("the label is read at each draw, so one Rand can follow the game's round", () => {
  const seed = newSeed();
  let round = 1;
  const rand = seededRand(newSeedState(seed), () => `p${round}`);
  const first = [rand(6), rand(6)];
  round = 2;
  const second = [rand(6), rand(6)];
  expect(first).toEqual(draws(newSeedState(seed), "p1", 2));
  expect(second).toEqual(draws(newSeedState(seed), "p2", 2));
});
