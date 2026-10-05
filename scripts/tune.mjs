// Tune the Aviator's rollout policy (POLICY_PARAMS) by coordinate descent on
// its own landing rate: the policy plays whole YUL games alone (both seats,
// full information — what a rollout is). One parameter at a time, each
// candidate value is tried on the training seeds and kept only if it lands
// more games; the result is then checked on held-out seeds.
//
// Usage: npm run tune -- [games=200] [passes=2] [eval]
//   eval: tune the evaluator's weights (EVAL_WEIGHTS) on the quick strategy's own
//   self-play landings instead (each weight tried at ×0.5 and ×2).
//   CARD=yellow-TGU (env): tune on that card with its printed modules (ability
//   cards rotate through the abilities), and print the result as its profile.
//   SCORE=graded (env): score games by how close they come, not only landings —
//   a landing 10, a failed landing a point per landing condition met, a crash
//   its round / 7. For cards the policy rarely lands, where landings alone
//   give the tuner nothing to climb.
import { newGame, rolloutGame, selfPlay, mulberry32, landingChecks, POLICY_PARAMS, EVAL_WEIGHTS, SCENARIO_TEMPLATES, ABILITY_IDS, BOT_PROFILES } from "../packages/shared/src/index.ts";

const GRADED = process.env.SCORE === "graded";
/** A finished game's score: 1 a landing (landings only), or graded as above. */
function score(g) {
  if (g.outcome?.result === "won") return GRADED ? 10 : 1;
  if (!GRADED) return 0;
  if (/^Landing failed/.test(g.outcome?.reason ?? "")) return Object.values(landingChecks(g)).filter(Boolean).length;
  return g.round / 7;
}

const CARD = process.env.CARD;
const card = CARD && SCENARIO_TEMPLATES.find((t) => t.id === CARD);
if (CARD && !card) throw new Error(`no card ${CARD}`);
if (card) delete BOT_PROFILES[card.id]; // tune from the defaults, not an older profile
const setupFor = (i) => card
  ? { scenarioId: card.id === "green-YUL" ? "YUL" : card.id, modules: [...card.modules], abilities: Array.from({ length: card.abilityCount }, (_, k) => ABILITY_IDS[(i + k) % ABILITY_IDS.length]) }
  : { scenarioId: "YUL", modules: [], abilities: [] };

const N = Number(process.argv[2] ?? 200);
const PASSES = Number(process.argv[3] ?? 2);
const EVAL = process.argv.includes("eval");
const TARGET = EVAL ? EVAL_WEIGHTS : POLICY_PARAMS;
const POLICY_CANDIDATES = {
  spareSlack: [0.5, 1, 2, 3],
  gearSlack: [0, 1, 2],
  paceSlack: [0, 1, 2],
  behindSlack: [-1, 0, 1],
  brakeGoal: [2, 3],
  coffeeCost: [0.25, 0.5, 1, 2],
  paceWeight: [5, 10, 20],
  clearAnyDieAhead: [0, 1, 2],
  clearAheadMax: [1, 2, 3, 5],
  trafficPressure: [1, 1.5, 2, 3],
};

const CANDIDATES = EVAL
  ? Object.fromEntries(Object.entries(EVAL_WEIGHTS).map(([k, v]) => [k, [v / 2, v * 2]]))
  : POLICY_CANDIDATES;

/** Landings out of N games from seed `from`. */
function landings(from) {
  let total = 0;
  for (let i = from; i < from + N; i++) {
    total += score(EVAL
      ? selfPlay(setupFor(i), i, 400, { strategy: "quick" }).final
      : rolloutGame(newGame(setupFor(i), "P", "C", mulberry32(i), 0), mulberry32(100000 + i)));
  }
  return Math.round(total * 10) / 10;
}

const start = { ...TARGET };
let best = landings(0);
console.log(`start: ${best}/${N} on training seeds`, JSON.stringify(start));
for (let pass = 1; pass <= PASSES; pass++) {
  let improved = false;
  for (const [key, values] of Object.entries(CANDIDATES)) {
    const keep = TARGET[key];
    let bestValue = keep;
    for (const v of values) {
      if (v === keep) continue;
      TARGET[key] = v;
      const score = landings(0);
      if (score > best) [best, bestValue, improved] = [score, v, true];
    }
    TARGET[key] = bestValue;
    console.log(`pass ${pass} · ${key} = ${bestValue} → ${best}/${N}`);
  }
  if (!improved) break;
}
const tuned = { ...TARGET };
const heldTuned = landings(N);
Object.assign(TARGET, start);
const heldStart = landings(N);
console.log(`\ntuned: ${JSON.stringify(tuned)}`);
console.log(`held-out seeds: start ${heldStart}/${N} → tuned ${heldTuned}/${N}`);
if (card) {
  const diff = Object.fromEntries(Object.entries(tuned).filter(([k, v]) => start[k] !== v));
  console.log(`\nBOT_PROFILES["${card.id}"] = { ${EVAL ? "eval" : "policy"}: ${JSON.stringify(diff)} };`);
}
