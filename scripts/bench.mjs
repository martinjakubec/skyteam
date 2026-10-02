// Bot win-rate benchmark: bot-vs-bot self-play over every setup.
// Usage: npm run bench -- [games=30] [level=navigator] [ALL]
//   default: every card, every module combination, each ability (representativeSetups)
//   ALL:     every module combination × every ability set, plus every card (slow)
//   ONLY="intern,kerosene" (env) keeps setups containing all those ids
//   (scenario id, module or ability).
import { selfPlay, representativeSetups, allSetups } from "../packages/shared/src/index.ts";
const N = Number(process.argv[2] ?? 30);
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
