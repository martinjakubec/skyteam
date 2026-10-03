// Bot win-rate benchmark: bot-vs-bot self-play over every setup.
// Usage: npm run bench -- [games=30] [quick|samples] [ALL]   — Aviator's quick strategy (default) or
//          Aviator searching that many samples per candidate
//        npm run bench -- [games=40] landing [samples=20 | 600ms]   — YUL landings, with the checklist
//          (MODULES="kerosene,intern" (env) flies YUL with those modules; QUICK=1 adds the quick strategy)
//   default: every card, every module combination, each ability (representativeSetups)
//   ALL:     every module combination × every ability set, plus every card (slow)
//   ONLY="intern,kerosene" (env) keeps setups containing all those ids
//   (scenario id, module or ability).
import { selfPlay, representativeSetups, allSetups, SetSetupPayload, landingChecks, POLICY_PARAMS, SEARCH_DEFAULTS } from "../packages/shared/src/index.ts";
// POLICY='{"peek":false}' / SEARCH='{"halving":false}' (env) override rollout or search settings for this run.
if (process.env.POLICY) Object.assign(POLICY_PARAMS, JSON.parse(process.env.POLICY));
if (process.env.SEARCH) Object.assign(SEARCH_DEFAULTS, JSON.parse(process.env.SEARCH));
const N = Number(process.argv[2] ?? 30);

// landing: how often Aviator lands YUL (optionally with modules), and which
// landing condition fails when it doesn't. A fixed number of samples per
// candidate keeps runs reproducible; the average time per decision says
// whether that fits the live 600 ms budget.
if (process.argv.includes("landing")) {
  // A number = samples per candidate (reproducible); "600ms" = a time budget per decision (as live).
  const arg = process.argv[process.argv.indexOf("landing") + 1] ?? "20";
  const budgetMs = arg.endsWith("ms") ? Number(arg.slice(0, -2)) : undefined;
  const samples = budgetMs ? undefined : Number(arg) || 20;
  const setup = { scenarioId: "YUL", modules: process.env.MODULES ? process.env.MODULES.split(",") : [], abilities: [] };
  if (!SetSetupPayload.safeParse(setup).success) throw new Error(`not a lobby setup: ${JSON.stringify(setup)}`);
  for (const lv of process.env.QUICK ? ["quick", "aviator"] : ["aviator"]) {
    let won = 0, rounds = 0, moves = 0, midFlight = 0;
    const fails = {};
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      const r = selfPlay(setup, i, 400, lv === "aviator" ? (budgetMs ? { budgetMs } : { samples }) : { strategy: "quick" });
      rounds += r.rounds;
      moves += r.moves;
      if (r.outcome === "won") won++;
      else if (/^Landing failed/.test(r.reason)) {
        for (const [k, ok] of Object.entries(landingChecks(r.final))) if (!ok) fails[k] = (fails[k] ?? 0) + 1;
      } else midFlight++;
    }
    const ms = (Date.now() - t0) / Math.max(1, moves);
    const checklist = Object.entries(fails).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
    const name = `${lv}${setup.modules.length ? ` +${setup.modules.join("+")}` : ""}`;
    console.log(`${name.padEnd(10)} ${((100 * won) / N).toFixed(1).padStart(5)}% landed (${won}/${N}) · avg round ${(rounds / N).toFixed(2)} · lost mid-flight ${midFlight} · ${ms.toFixed(0)} ms/decision${lv === "aviator" ? (budgetMs ? ` (${budgetMs} ms budget)` : ` (${samples} samples)`) : ""}`);
    console.log(`           failed landing conditions: ${checklist || "—"}`);
  }
  process.exit(0);
}

const samples = Number(process.argv[3]) || undefined; // undefined: the quick strategy
const level = samples ? `Aviator, ${samples} samples` : "quick strategy";
const ONLY = process.env.ONLY?.split(",");
const ids = (s) => [s.scenarioId, ...s.modules, ...s.abilities];
const setups = (process.argv.includes("ALL") ? allSetups() : representativeSetups()).filter((s) => !ONLY || ONLY.every((x) => ids(s).includes(x)));
let wins = 0, games = 0;
for (const s of setups) {
  const reasons = new Map(); let w = 0, rounds = 0;
  for (let i = 0; i < N; i++) {
    const r = selfPlay(s, i, 400, samples ? { samples } : { strategy: "quick" });
    if (r.outcome === "won") w++; else reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
    rounds += r.rounds;
  }
  wins += w; games += N;
  const top = [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${v}× ${k}`).join("; ");
  const name = `${s.scenarioId}: ${[...s.modules, ...s.abilities].join("+") || "base"}`;
  console.log(`${name.padEnd(56)} ${((100 * w) / N).toFixed(1).padStart(5)}%  avg round ${(rounds / N).toFixed(1)}  ${top}`);
}
console.log(`\nOverall: ${((100 * wins) / games).toFixed(1)}% won over ${games} games (${level})`);
