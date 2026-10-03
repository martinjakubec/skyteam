// Bot win-rate benchmark: bot-vs-bot self-play over every setup.
// Usage: npm run bench -- [games=30] [level=navigator] [ALL]
//        npm run bench -- [games=20] compare   — Cadet vs Navigator vs Aviator
//        npm run bench -- [games=40] landing [samples=20]   — YUL landings, with the checklist
//          (LEVELS=navigator,cadet to pick the levels; default navigator,aviator)
//   default: every card, every module combination, each ability (representativeSetups)
//   ALL:     every module combination × every ability set, plus every card (slow)
//   ONLY="intern,kerosene" (env) keeps setups containing all those ids
//   (scenario id, module or ability).
import { selfPlay, representativeSetups, allSetups, SetSetupPayload, landingChecks } from "../packages/shared/src/index.ts";
const N = Number(process.argv[2] ?? 30);

// landing: how often each level lands YUL, and which landing condition fails
// when it doesn't. Aviator takes a fixed number of samples per candidate (so
// runs are reproducible); its average time per decision says whether that
// fits the live 600 ms budget.
if (process.argv.includes("landing")) {
  const samples = Number(process.argv[process.argv.indexOf("landing") + 1] ?? 20) || 20;
  const setup = { scenarioId: "YUL", modules: [], abilities: [] };
  for (const lv of process.env.LEVELS?.split(",") ?? ["navigator", "aviator"]) {
    let won = 0, rounds = 0, moves = 0, midFlight = 0;
    const fails = {};
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      const r = selfPlay(setup, { pilot: lv, copilot: lv }, i, 400, lv === "aviator" ? { samples } : undefined);
      rounds += r.rounds;
      moves += r.moves;
      if (r.outcome === "won") won++;
      else if (/^Landing failed/.test(r.reason)) {
        for (const [k, ok] of Object.entries(landingChecks(r.final))) if (!ok) fails[k] = (fails[k] ?? 0) + 1;
      } else midFlight++;
    }
    const ms = (Date.now() - t0) / Math.max(1, moves);
    const checklist = Object.entries(fails).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
    console.log(`${lv.padEnd(10)} ${((100 * won) / N).toFixed(1).padStart(5)}% landed (${won}/${N}) · avg round ${(rounds / N).toFixed(2)} · lost mid-flight ${midFlight} · ${ms.toFixed(0)} ms/decision${lv === "aviator" ? ` (${samples} samples)` : ""}`);
    console.log(`           failed landing conditions: ${checklist || "—"}`);
  }
  process.exit(0);
}

// compare: the three levels on the same small set, from the same seeds (the
// levels use the random stream differently, so games soon diverge). Win
// rates are low, so the tier verdict uses the average progress score: rounds
// survived, +1 for a landing. Aviator searches 50 ms a move here (600 ms live).
if (process.argv.includes("compare")) {
  const SET = [
    { scenarioId: "YUL", modules: [], abilities: [] },
    { scenarioId: "green-HND", modules: [], abilities: [] },
    { scenarioId: "green-OSL", modules: ["kerosene"], abilities: [] },
    { scenarioId: "yellow-KEF", modules: ["iceBrakes"], abilities: ["adaptation"] },
    { scenarioId: "yellow-GIG", modules: ["wind"], abilities: ["anticipation"] },
    { scenarioId: "green-ATL", modules: ["intern"], abilities: [] },
  ];
  for (const s of SET) if (!SetSetupPayload.safeParse(s).success) throw new Error(`not a lobby setup: ${JSON.stringify(s)}`);
  const rows = ["cadet", "navigator", "aviator"].map((lv) => {
    let w = 0, score = 0, n = 0;
    const t0 = Date.now();
    for (const s of SET) for (let i = 0; i < N; i++) {
      const r = selfPlay(s, { pilot: lv, copilot: lv }, i, 400, { budgetMs: 50 });
      if (r.outcome === "won") w++;
      score += r.rounds + (r.outcome === "won" ? 1 : 0);
      n++;
    }
    return { lv, win: (100 * w) / n, score: score / n, secs: (Date.now() - t0) / 1000 };
  });
  rows.forEach(({ lv, win, score, secs }) => console.log(`${lv.padEnd(10)} ${win.toFixed(1).padStart(5)}% won · progress ${score.toFixed(2)} · ${secs.toFixed(0)} s`));
  const ok = rows[2].score >= rows[1].score && rows[1].score >= rows[0].score;
  console.log(ok ? "tiers OK: Aviator ≥ Navigator ≥ Cadet" : "TIERS OUT OF ORDER");
  process.exit(ok ? 0 : 1);
}
const level = process.argv[3] ?? "navigator";
const ONLY = process.env.ONLY?.split(",");
const ids = (s) => [s.scenarioId, ...s.modules, ...s.abilities];
const setups = (process.argv.includes("ALL") ? allSetups() : representativeSetups()).filter((s) => !ONLY || ONLY.every((x) => ids(s).includes(x)));
let wins = 0, games = 0;
for (const s of setups) {
  const reasons = new Map(); let w = 0, rounds = 0;
  for (let i = 0; i < N; i++) {
    const r = selfPlay(s, { pilot: level, copilot: level }, i);
    if (r.outcome === "won") w++; else reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
    rounds += r.rounds;
  }
  wins += w; games += N;
  const top = [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${v}× ${k}`).join("; ");
  const name = `${s.scenarioId}: ${[...s.modules, ...s.abilities].join("+") || "base"}`;
  console.log(`${name.padEnd(56)} ${((100 * w) / N).toFixed(1).padStart(5)}%  avg round ${(rounds / N).toFixed(1)}  ${top}`);
}
console.log(`\nOverall: ${((100 * wins) / games).toFixed(1)}% won over ${games} games (${level})`);
