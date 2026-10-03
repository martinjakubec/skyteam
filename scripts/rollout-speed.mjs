// Microbenchmark: full-game rollouts per second from round 1 (the cost that
// bounds Aviator's samples), and the time of one Aviator decision.
import { newGame, rolloutGame, determinize, redactGameStateFor, mulberry32, DEFAULT_SETUP, searchMove } from "../packages/shared/src/index.ts";
const views = Array.from({ length: 20 }, (_, i) => redactGameStateFor(newGame(DEFAULT_SETUP, "P", "C", mulberry32(i), 0), "P"));
for (let i = 0; i < 50; i++) rolloutGame(determinize(views[i % 20], mulberry32(i)), mulberry32(i + 1)); // warm up
let n = 0;
const t0 = performance.now();
while (performance.now() - t0 < 3000) { const v = views[n % 20]; rolloutGame(determinize(v, mulberry32(n)), mulberry32(n + 7)); n++; }
const perSec = (n / (performance.now() - t0)) * 1000;
console.log(`full-game rollouts: ${perSec.toFixed(0)}/s (${(1000 / perSec).toFixed(2)} ms each)`);
const t1 = performance.now();
for (let i = 0; i < 5; i++) searchMove(views[i], "pilot", mulberry32(i), { budgetMs: Infinity, maxSamples: 30 });
console.log(`Aviator decision at 30 samples: ${((performance.now() - t1) / 5).toFixed(0)} ms`);
