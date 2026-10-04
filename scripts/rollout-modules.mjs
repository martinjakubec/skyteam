// The rollout policy alone (full information) per module: landings, why games
// are lost, and which landing checks fail. Usage: npx tsx scripts/rollout-modules.mjs [games=200]
import { newGame, rolloutGame, landingChecks, mulberry32 } from "../packages/shared/src/index.ts";
const N = Number(process.argv[2] ?? 200);
for (const mods of [[], ["kerosene"], ["intern"], ["wind"], ["iceBrakes"], ["kerosene", "intern", "wind", "iceBrakes"]]) {
  let won = 0;
  const why = {}, fails = {};
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const g = rolloutGame(newGame({ scenarioId: "YUL", modules: mods, abilities: [] }, "P", "C", mulberry32(i), 0), mulberry32(100000 + i));
    if (g.outcome?.result === "won") { won++; continue; }
    const r = (g.outcome?.reason ?? "none").replace(/\d+/g, "#").slice(0, 50);
    why[r] = (why[r] ?? 0) + 1;
    if (/^Landing failed/.test(r)) for (const [k, ok] of Object.entries(landingChecks(g))) if (!ok) fails[k] = (fails[k] ?? 0) + 1;
  }
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join("; ");
  console.log(`${(mods.join("+") || "YUL").padEnd(30)} ${won}/${N} won · ${((Date.now() - t0) / N).toFixed(1)} ms/game\n   lost: ${top(why)}\n   landing checks failed: ${top(fails)}`);
}
