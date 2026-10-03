// Count the rollout policy's quick-strategy fallbacks (each lists every legal move) and their cost.
import { newGame, determinize, redactGameStateFor, mulberry32, DEFAULT_SETUP, fastMove, applyIntentInPlace, actorFor, playerIdOf } from "../packages/shared/src/index.ts";
const views = Array.from({ length: 20 }, (_, i) => redactGameStateFor(newGame(DEFAULT_SETUP, "P", "C", mulberry32(i), 0), "P"));
let slow = 0, slowMs = 0, all = 0, allMs = 0; const why = {};
for (let i = 0; i < 200; i++) {
  let s = determinize(views[i % 20], mulberry32(i)); const rand = mulberry32(100 + i);
  while (!s.outcome) {
    const crew = actorFor(s); if (!crew) break;
    const t = performance.now(); const m = fastMove(s, crew, rand); const dt = performance.now() - t;
    all++; allMs += dt;
    if (dt > 1) { slow++; slowMs += dt; const k = s.pendingReroll ? "reroll answer" : s.pendingSwap ? "swap" : s.internHeld ? "intern" : s.trafficHeld ? "traffic" : `nothing cheap fit (${m?.type}${m?.target ? " " + m.target.kind : ""})`; why[k] = (why[k] ?? 0) + 1; }
    s = applyIntentInPlace(s, m, playerIdOf(s, crew), rand, () => 0);
  }
}
console.log(`choices ${all} (${allMs.toFixed(0)} ms) · slow (>1 ms) ${slow} (${slowMs.toFixed(0)} ms)`, why);
