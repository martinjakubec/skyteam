// Profile: where a rollout's time goes now, and a decision's fixed overhead.
import { newGame, determinize, redactGameStateFor, mulberry32, DEFAULT_SETUP, fastMove, applyIntentInPlace, actorFor, playerIdOf, legalMoves, rankMoves, searchCandidates } from "../packages/shared/src/index.ts";
const views = Array.from({ length: 20 }, (_, i) => redactGameStateFor(newGame(DEFAULT_SETUP, "P", "C", mulberry32(i), 0), "P"));
let det = 0, choose = 0, apply = 0, steps = 0;
for (let i = 0; i < 200; i++) {
  let t = performance.now(); let s = determinize(views[i % 20], mulberry32(i)); det += performance.now() - t;
  const rand = mulberry32(100 + i);
  while (!s.outcome) {
    const crew = actorFor(s); if (!crew) break;
    t = performance.now(); const m = fastMove(s, crew, rand); choose += performance.now() - t;
    t = performance.now(); s = applyIntentInPlace(s, m, playerIdOf(s, crew), rand, () => 0); apply += performance.now() - t;
    steps++;
  }
}
console.log(`200 rollouts, ${steps} moves: determinize ${det.toFixed(0)} ms · choose ${choose.toFixed(0)} ms · apply ${apply.toFixed(0)} ms`);
let t = performance.now(); for (let i = 0; i < 20; i++) legalMoves(views[i], "pilot"); const lm = (performance.now() - t) / 20;
t = performance.now(); for (let i = 0; i < 20; i++) rankMoves(views[i], "pilot", legalMoves(views[i], "pilot"), mulberry32(i)); const rk = (performance.now() - t) / 20 - lm;
t = performance.now(); for (let i = 0; i < 20; i++) searchCandidates(views[i], "pilot", mulberry32(i), 6); const sc = (performance.now() - t) / 20;
console.log(`per decision: legalMoves ${lm.toFixed(1)} ms · rankMoves ${rk.toFixed(1)} ms · searchCandidates total ${sc.toFixed(1)} ms`);
