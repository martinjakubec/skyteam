// Tune the Aviator's rollout policy (POLICY_PARAMS) by coordinate descent on
// its own landing rate: the policy plays whole YUL games alone (both seats,
// full information — what a rollout is). One parameter at a time, each
// candidate value is tried on the training seeds and kept only if it lands
// more games; the result is then checked on held-out seeds.
//
// Usage: npm run tune -- [games=200] [passes=2]
import { newGame, rolloutGame, mulberry32, DEFAULT_SETUP, POLICY_PARAMS } from "../packages/shared/src/index.ts";

const N = Number(process.argv[2] ?? 200);
const PASSES = Number(process.argv[3] ?? 2);
const CANDIDATES = {
  spareSlack: [0.5, 1, 2, 3],
  gearSlack: [0, 1, 2],
  paceSlack: [0, 1, 2],
  behindSlack: [-1, 0, 1],
  brakeGoal: [2, 3],
  coffeeCost: [0.25, 0.5, 1, 2],
  paceWeight: [5, 10, 20],
  clearAnyDieAhead: [0, 1, 2],
};

/** Landings out of N games from seed `from`. */
function landings(from) {
  let won = 0;
  for (let i = from; i < from + N; i++) {
    const end = rolloutGame(newGame(DEFAULT_SETUP, "P", "C", mulberry32(i), 0), mulberry32(100000 + i));
    if (end.outcome?.result === "won") won++;
  }
  return won;
}

const start = { ...POLICY_PARAMS };
let best = landings(0);
console.log(`start: ${best}/${N} on training seeds`, JSON.stringify(start));
for (let pass = 1; pass <= PASSES; pass++) {
  let improved = false;
  for (const [key, values] of Object.entries(CANDIDATES)) {
    const keep = POLICY_PARAMS[key];
    let bestValue = keep;
    for (const v of values) {
      if (v === keep) continue;
      POLICY_PARAMS[key] = v;
      const score = landings(0);
      if (score > best) [best, bestValue, improved] = [score, v, true];
    }
    POLICY_PARAMS[key] = bestValue;
    console.log(`pass ${pass} · ${key} = ${bestValue} → ${best}/${N}`);
  }
  if (!improved) break;
}
const tuned = { ...POLICY_PARAMS };
const heldTuned = landings(N);
Object.assign(POLICY_PARAMS, start);
const heldStart = landings(N);
console.log(`\ntuned: ${JSON.stringify(tuned)}`);
console.log(`held-out seeds: start ${heldStart}/${N} → tuned ${heldTuned}/${N}`);
