// Aviator benchmark over the scenario cards as printed: each card with its own
// modules (no invented combinations), and for a card with Special Abilities,
// ABILITY_SETS random picks of as many abilities as its ★ allows.
//
// Usage (in a node:22 container, from the repo root):
//   node_modules/.bin/tsx scripts/bench-cards.mjs
// Env:
//   DIFFICULTY=green,yellow   cards to play (default green,yellow)
//   CARDS=green-PRG,yellow-KUL   only these cards
//   GAMES=80                  games per setup (seeds 0..GAMES-1)
//   SAMPLES=120               Aviator samples per candidate (fixed: reproducible, load-independent)
//   BUDGET_MS=600             instead: a time budget per decision, as live (load-dependent)
//   CONCURRENCY=16            games running at once (one child process each)
//   ABILITY_SETS=4            ability combinations per card with ★
//   ABILITY_SEED=1            seed for picking them (same seed, same picks)
//   ONLY="green-PRG,mastery"  keep setups containing all these ids (card, module or ability)
//   PROFILES='{"yellow-TGU":{"policy":{…}}}'   try these card profiles over the ones in profiles.ts
//   BOT_DIST=1                play the compiled bot, as the server does
//   TAG=iter1                 kept apart in OUT from runs with another tag (e.g. other profiles)
//   OUT=sim-output/bench-cards.jsonl   one line per finished game; a rerun skips
//                             games already in it (resume after a stop)
// Prints a summary table at the end; `SUMMARY=1` prints it from OUT without playing.
import { fork } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
// BOT_DIST=1: play the compiled packages/shared/dist (what the server runs — about
// 1.5× faster than the TypeScript source through tsx, so more samples in a time
// budget); build it first (npm run build -w @skyteam/shared).
const { ABILITY_IDS, BOT_PROFILES, EVAL_WEIGHTS, POLICY_PARAMS, SEARCH_DEFAULTS, SCENARIO_TEMPLATES, SetSetupPayload, landingChecks, mulberry32, selfPlay } = await import(process.env.BOT_DIST ? "../packages/shared/dist/index.js" : "../packages/shared/src/index.ts");

const env = process.env;
if (env.PROFILES) Object.assign(BOT_PROFILES, JSON.parse(env.PROFILES));
// SEARCH / POLICY / EVAL='{…}' override the defaults for every card (experiments).
if (env.SEARCH) Object.assign(SEARCH_DEFAULTS, JSON.parse(env.SEARCH));
if (env.POLICY) Object.assign(POLICY_PARAMS, JSON.parse(env.POLICY));
if (env.EVAL) Object.assign(EVAL_WEIGHTS, JSON.parse(env.EVAL));

// ---- Worker: plays the games it's sent, one at a time --------------------------
if (process.argv.includes("--worker")) {
  process.on("message", ({ setup, seed, samples, budgetMs }) => {
    const used = {};
    const t0 = Date.now();
    const r = selfPlay(setup, seed, 400, {
      ...(budgetMs ? { budgetMs } : { samples }),
      onMove: (m, crew, before) => {
        // Rerolls: started (a token spent) vs answered; ability moves by type.
        const k = m.type === "reroll" ? (before.pendingReroll === crew ? "rerollAnswer" : "reroll") : m.type;
        if (k !== "placeDie" && k !== "rerollAnswer") used[k] = (used[k] ?? 0) + 1;
      },
    });
    const failed = r.outcome === "lost" && /^Landing failed/.test(r.reason)
      ? Object.entries(landingChecks(r.final)).filter(([, ok]) => !ok).map(([k]) => k) : [];
    // Where it ended: the position (of the airport's) and the airplanes left on the track.
    const end = { pos: r.final.position, airport: r.final.scenario.approachTrack.length - 1, planes: r.final.airplanes.reduce((a, n) => a + n, 0) };
    process.send({ seed, outcome: r.outcome, reason: r.reason, rounds: r.rounds, moves: r.moves, ms: Date.now() - t0, failed, used, end });
  });
  process.send({ ready: true });
} else {
  await main();
}

// ---- Setups ---------------------------------------------------------------------
/** `n` distinct ability sets of size `k`, picked at random (seeded). */
function abilitySets(k, n, rand) {
  const all = [];
  const pick = (start, acc) => {
    if (acc.length === k) return all.push(acc);
    for (let i = start; i < ABILITY_IDS.length; i++) pick(i + 1, [...acc, ABILITY_IDS[i]]);
  };
  pick(0, []);
  for (let i = all.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, n);
}

function setups() {
  const difficulties = (env.DIFFICULTY ?? "green,yellow").split(",");
  const sets = Number(env.ABILITY_SETS ?? 4);
  const rand = mulberry32(Number(env.ABILITY_SEED ?? 1));
  const out = [];
  const cards = env.CARDS?.split(",");
  for (const t of SCENARIO_TEMPLATES.filter((t) => difficulties.includes(t.difficulty) && (!cards || cards.includes(t.id)))) {
    const scenarioId = t.id === "green-YUL" ? "YUL" : t.id;
    const abilityChoices = t.abilityCount > 0 ? abilitySets(t.abilityCount, sets, rand) : [[]];
    for (const abilities of abilityChoices) {
      const setup = { scenarioId, modules: [...t.modules], abilities };
      if (!SetSetupPayload.safeParse(setup).success) throw new Error(`not a lobby setup: ${JSON.stringify(setup)}`);
      out.push({ card: t.id, setup });
    }
  }
  const only = env.ONLY?.split(",");
  return out.filter(({ card, setup }) => !only || only.every((x) => [card, ...setup.modules, ...setup.abilities].includes(x)));
}
function keyOf({ card, setup }) {
  return `${card} ${[...setup.modules, ...setup.abilities.map((a) => `★${a}`)].join("+") || "base"}`;
}

// ---- Main: a pool of CONCURRENCY processes, fed one game at a time ---------------
async function main() {
  const GAMES = Number(env.GAMES ?? 80);
  const SAMPLES = Number(env.SAMPLES ?? 120);
  const BUDGET_MS = Number(env.BUDGET_MS) || undefined;
  const MODE = modeName(BUDGET_MS, SAMPLES);
  const CONCURRENCY = Number(env.CONCURRENCY ?? 16);
  const OUT = env.OUT ?? "sim-output/bench-cards.jsonl";
  const list = setups();
  mkdirSync(dirname(OUT), { recursive: true });
  const done = new Set(
    existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => modeOf(r) === MODE).map((r) => `${r.key}#${r.seed}`) : [],
  );

  console.log(`${list.length} setups × ${GAMES} games, Aviator at ${MODE}, ${CONCURRENCY} at once → ${OUT}`);
  for (const s of list) console.log(`  ${keyOf(s)}`);
  if (env.SUMMARY) return summary(OUT, list, MODE);

  // Interleave the setups (seed-major), so partial results cover every setup.
  const queue = [];
  for (let seed = 0; seed < GAMES; seed++) for (const s of list) if (!done.has(`${keyOf(s)}#${seed}`)) queue.push({ ...s, seed });
  const total = queue.length;
  console.log(`${total} games to play (${list.length * GAMES - total} already in ${OUT})`);
  let finished = 0;
  const t0 = Date.now();

  const self = fileURLToPath(import.meta.url);
  let crashes = 0;
  // One slot of the pool: a child process playing games until the queue is
  // empty. A crashed child's game goes back in the queue and a fresh child
  // takes over (up to 5 crashes in all, then the run stops; rerun to resume).
  const runWorker = () =>
    new Promise((resolve, reject) => {
      const child = fork(self, ["--worker"], { execArgv: ["--import", "tsx"] });
      let job = null;
      const next = () => {
        job = queue.shift() ?? null;
        if (!job) return child.disconnect();
        child.send({ setup: job.setup, seed: job.seed, samples: SAMPLES, budgetMs: BUDGET_MS });
      };
      child.on("message", (msg) => {
        if (msg.ready) return next();
        appendFileSync(OUT, JSON.stringify({ key: keyOf(job), card: job.card, setup: job.setup, mode: MODE, ...msg }) + "\n");
        finished++;
        const mins = (Date.now() - t0) / 60000;
        const eta = (mins / finished) * (total - finished);
        console.log(`[${finished}/${total}] ${keyOf(job)} #${msg.seed}: ${msg.outcome}${msg.reason ? ` (${msg.reason})` : ""} · ${(msg.ms / 1000).toFixed(0)} s · ~${eta.toFixed(0)} min left`);
        next();
      });
      child.on("exit", (code, signal) => {
        if (!job) return resolve();
        console.error(`worker died (${code ?? signal}) on ${keyOf(job)} #${job.seed}; retrying it`);
        queue.unshift(job);
        if (++crashes > 5) return reject(new Error("too many worker crashes"));
        runWorker().then(resolve, reject);
      });
    });
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, runWorker));
  summary(OUT, list, MODE);
}

/** A run's mode: a time budget or a fixed sample count; results of different modes never mix. */
function modeName(budgetMs, samples) {
  return (budgetMs ? `${budgetMs}ms` : `${samples} samples`) + (env.BOT_DIST ? " dist" : "") + (env.TAG ? ` ${env.TAG}` : "");
}
function modeOf(r) {
  return r.mode ?? modeName(r.budgetMs, r.samples);
}

// ---- Summary ---------------------------------------------------------------------
function summary(OUT, list, MODE) {
  const rows = readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => modeOf(r) === MODE);
  const top = (counts, n = 3) => Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v}× ${k}`).join("; ");
  console.log(`\n${"setup".padEnd(58)} landed      avg rnd  other moves / game        top losses`);
  const byCard = new Map();
  for (const s of list) {
    const key = keyOf(s);
    const games = rows.filter((r) => r.key === key);
    if (!games.length) continue;
    const won = games.filter((r) => r.outcome === "won").length;
    const losses = {}, used = {};
    for (const g of games) {
      if (g.outcome !== "won") {
        const why = g.failed?.length ? `landing: ${g.failed.join(", ")}` : g.reason;
        losses[why] = (losses[why] ?? 0) + 1;
      }
      for (const [k, v] of Object.entries(g.used ?? {})) used[k] = (used[k] ?? 0) + v;
    }
    const use = Object.entries(used).map(([k, v]) => `${k} ${(v / games.length).toFixed(1)}`).join(", ");
    const pct = `${((100 * won) / games.length).toFixed(0)}% ${won}/${games.length}`;
    console.log(`${key.padEnd(58)} ${pct.padEnd(11)} ${(games.reduce((a, g) => a + g.rounds, 0) / games.length).toFixed(1).padStart(7)}  ${use.padEnd(25)} ${top(losses)}`);
    const c = byCard.get(s.card) ?? { won: 0, n: 0 };
    byCard.set(s.card, { won: c.won + won, n: c.n + games.length });
  }
  console.log(`\nPer card:`);
  for (const [card, c] of byCard) console.log(`  ${card.padEnd(12)} ${((100 * c.won) / c.n).toFixed(1).padStart(5)}%  (${c.won}/${c.n})`);
  const all = [...byCard.values()].reduce((a, c) => ({ won: a.won + c.won, n: a.n + c.n }), { won: 0, n: 0 });
  console.log(`Overall: ${((100 * all.won) / Math.max(1, all.n)).toFixed(1)}% landed (${all.won}/${all.n})`);
}
