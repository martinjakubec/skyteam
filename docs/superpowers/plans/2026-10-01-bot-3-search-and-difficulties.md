# Bot Phase 3 — Search and the Three Difficulties Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revised 2026-10-03** against the code after Phases 1 and 2. Changes from the 2026-10-01 draft: the dice code is `packages/shared/src/game/entropy.ts` (`withEntropy`, `settle(game, dice, now)`, `applyIntent(game, command, playerId, rand, now)`, `newGame(…, rand, at)`), not `engine.ts`/`resolveIntent`; the Phase 1 baseline is about 1% of self-play games won, so a win-rate-only tier check can't separate the levels on a sample small enough to run — the tier verdict uses an average *progress score* (rounds survived, +1 for a landing) with win % shown alongside; `compare` runs a fixed small setup set with a small Aviator budget (the draft's 81 setups × 100 games × 150 ms per decision would take about 20 hours); Task 4 also takes the evaluator consistency fixes the Phase 1 final review deferred.

**Goal:** Three genuinely different NPC strengths — Cadet < Navigator < Aviator — with Aviator using Monte Carlo search over the dice it can't see, measured by the benchmark and run off the server's main thread.

**Architecture:** Aviator = *determinized Monte Carlo*: shortlist the Navigator's best few moves; for each, repeatedly fill in the partner's hidden dice with random values consistent with the bot's view, apply the move, play the rest of the round with a fast rollout policy for both crews, and score the result with `evaluate`; pick the move with the best average, within a time budget. Cadet = Navigator with deliberate, bounded mistakes. The server runs Aviator in a `worker_threads` worker with a timeout fallback to Navigator so one room's thinking never stalls others.

**Tech Stack:** TypeScript (`@skyteam/shared/bot`), Node `worker_threads` (server, run through `tsx` in dev and production), Phase 1 benchmark.

**Spec:** Phases 1 and 2 plans (merged first) and the user decisions: three difficulties (Cadet / Navigator / Aviator — Aviator the strongest); no move explanations yet.

## Global Constraints

- Prerequisites merged: Phase 1 (`chooseMove`, `evaluate`, `legalMoves`, `playerIdOf`, `actorFor`, `selfPlay`, `representativeSetups`, `bench`, `mulberry32`, `Rand`, `applyIntent`, `newGame`) and Phase 2 (`scheduleNpc`, bot seats).
- Fairness: search may only sample hidden information; it starts from the bot's redacted view, never the true state.
- Aviator must answer within its time budget (default 600 ms, `NPC_THINK_MS` env) on the server; on timeout or worker error, fall back to Navigator.
- `npm test` must stay fast (the bot section is ~25 s today): search tests use tiny budgets and sample counts; strength comparisons live in `npm run bench`.
- Node only in Docker: `docker.exe compose -f docker-compose.dev.yml exec -T client sh -c "npm run typecheck && npm test"`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A view with hidden partner dice and a pending prompt** (e.g. the bot must answer a Reroll): determinization fills every hidden die, and the rollout handles prompts via `actorFor`. Test in Task 1.
- **Only one legal move**: return it immediately, no sampling. Test in Task 1.
- **Final round**: rollouts end at the outcome (landing), not "end of round" + roll. Test in Task 1.
- **Worker crash / timeout**: the bot still moves (Navigator fallback) and the room isn't stuck. Test in Task 3.
- **Strength regressions**: tuning can make a level worse; `bench compare` must show Aviator ≥ Navigator ≥ Cadet on the progress score before merging. Task 4.

---

## File Structure

- Create `packages/shared/src/bot/rollout.ts` — `determinize`, fast rollout policy, `rolloutRound`.
- Create `packages/shared/src/bot/search.ts` — `searchMove` (determinized Monte Carlo).
- Modify `packages/shared/src/bot/policy.ts` — `rankMoves`; level dispatch (Cadet noise, Aviator → search).
- Modify `packages/shared/src/bot/selfplay.ts` — pass search options through.
- Create `packages/server/src/npcWorker.ts` (worker entry) and `packages/server/src/think.ts` (worker + timeout); modify `npc.ts` to use `think`; `env.ts` (`NPC_THINK_MS`).
- Modify `scripts/bench.mjs` (`compare` mode), `scripts/test-bot.mjs`, `scripts/test-units.mjs`, `README.md`, client landing copy (drop "(soon)").

---

### Task 1: Fast rollouts and Monte Carlo search

**Files:** Create `packages/shared/src/bot/rollout.ts`, `search.ts`; modify `policy.ts` (`rankMoves`), `bot/index.ts`; Test: `scripts/test-bot.mjs` section 5.

**Interfaces:**
- Consumes: `actorFor`, `evaluate`, `legalMoves`, `playerIdOf`, `chooseMove` (Navigator), `applyIntent`, `reduce`, `GameRuleError`.
- Produces:
  - `rankMoves(view: GameState, crew: Crew, moves: GameCommand[], rand: Rand): GameCommand[]` — best first by `scoreMove`; equal scores in random order.
  - `determinize(view: GameState, rand: Rand): GameState` — a copy with every hidden die given a uniform 1..6 value.
  - `fastMove(state: GameState, crew: Crew, rand: Rand): GameCommand | null` — cheap policy for rollouts.
  - `rolloutRound(state: GameState, rand: Rand, maxSteps?: number): GameState` — play until the round number changes or the game ends.
  - `searchMove(view: GameState, crew: Crew, rand: Rand, opts: { budgetMs: number; shortlist?: number; maxSamples?: number }): GameCommand | null`.

- [ ] **Step 1: Write the failing test** (before the summary line of `scripts/test-bot.mjs`)

```js
console.log("5) Monte Carlo search (Aviator)");
{
  const { searchMove, determinize, rolloutRound, rankMoves, redactGameStateFor, createInitialGameState, scenarioForSetup, reduce, legalMoves } = await import("../packages/shared/src/index.ts");
  const fresh = (dp, dc, s = DEFAULT_SETUP) => reduce(createInitialGameState(scenarioForSetup(s), P, C), { type: "roll", pilot: dp, copilot: dc }, "").state;
  const g = fresh([1, 3, 4, 6], [2, 2, 5, 5]);
  const view = redactGameStateFor(g, P);
  const d = determinize(view, mulberry32(1));
  check("determinize fills every hidden die, keeps mine", d.dice.copilot.every((x) => x.value >= 1 && x.value <= 6 && !x.hidden) && d.dice.pilot.map((x) => x.value).join() === "1,3,4,6");
  const end = rolloutRound(d, mulberry32(2));
  check("a rollout finishes the round (or the game)", end.round === 2 || !!end.outcome);
  const moves = legalMoves(view, "pilot");
  check("rankMoves orders every legal move", rankMoves(view, "pilot", moves, mulberry32(9)).length === moves.length);
  const m = searchMove(view, "pilot", mulberry32(3), { budgetMs: 150, shortlist: 4, maxSamples: 20 });
  check("search returns a legal move", moves.some((x) => JSON.stringify(x) === JSON.stringify(m)));
  // One legal move → returned at once: the Pilot's last die, Axis done, Engine open, no Coffee.
  const lastDie = fresh([1, 1, 1, 4], [1, 1, 1, 1]);
  lastDie.dice.pilot.slice(0, 3).forEach((x) => (x.placed = true));
  lastDie.axis.pilot = 1;
  const only = legalMoves(redactGameStateFor(lastDie, P), "pilot");
  check("(setup: exactly one legal move — the Engine)", only.length === 1 && only[0].target?.kind === "engine");
  const t0 = Date.now();
  check("single legal move returned without sampling", JSON.stringify(searchMove(redactGameStateFor(lastDie, P), "pilot", mulberry32(4), { budgetMs: 5000 })) === JSON.stringify(only[0]) && Date.now() - t0 < 200);
  const t1 = Date.now();
  searchMove(view, "pilot", mulberry32(5), { budgetMs: 200 });
  check("respects its time budget", Date.now() - t1 < 600);
  // Final round: rollouts stop at the landing outcome.
  const last = { ...fresh([1, 1, 1, 1], [1, 1, 1, 1]), round: 7 };
  check("final-round rollout ends with an outcome", !!rolloutRound(determinize(redactGameStateFor(last, P), mulberry32(6)), mulberry32(7)).outcome);
  // A pending prompt for the bot: a Reroll offered to the Pilot is answered in the rollout.
  const offered = { ...g, turn: "copilot", pendingReroll: "pilot" };
  check("search answers a pending Reroll prompt", searchMove(redactGameStateFor(offered, P), "pilot", mulberry32(8), { budgetMs: 100 })?.type === "reroll");
}
```

The "one legal move" setup may admit more moves if `legalMoves` finds e.g. a Concentration space for the 4. If the setup check fails, also fill both Concentration spaces and the Pilot's Radio in `lastDie` until exactly the Engine remains — the setup check guards the test's premise.

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker.exe compose -f docker-compose.dev.yml exec -T client sh -c "npx tsx scripts/test-bot.mjs"`
Expected: FAIL — `searchMove`/`determinize` not exported.

- [ ] **Step 3: Implement**

`policy.ts`: factor the scoring loop into exported `rankMoves(view, crew, moves, rand)` — score every move with `scoreMove`, shuffle (Fisher–Yates with `rand`) before a stable sort by score, so ties are broken at random — and have Navigator's `chooseMove` return `rankMoves(...)[0]`.

`rollout.ts`:

```ts
import type { GameCommand, PlacementTarget } from "../protocol";
import { applyIntent, type Rand } from "../game/entropy";
import { GameRuleError, reduce } from "../game/reducer";
import type { Crew, DieValue } from "../game/scenario";
import type { GameState } from "../game/state";
import { actorFor } from "./actor";
import { playerIdOf } from "./moves";
import { chooseMove } from "./policy";

/** Give every hidden die a random value — one plausible world consistent with the view. */
export function determinize(view: GameState, rand: Rand): GameState {
  const s = structuredClone(view);
  for (const crew of ["pilot", "copilot"] as const) {
    for (const d of s.dice[crew]) {
      if (d.hidden) {
        d.value = (rand(6) + 1) as DieValue;
        delete d.hidden;
      }
    }
  }
  return s;
}

/** Cheap rollout policy: try a fixed priority list (lowest die first; Engine,
 *  Axis, Radio, switches, Concentration) and take the first legal one. Prompts
 *  (held extras, reroll/swap answers) and anything unusual fall back to Navigator. */
export function fastMove(s: GameState, crew: Crew, rand: Rand): GameCommand | null {
  if (s.internHeld || s.trafficHeld || s.pendingSwap || s.pendingReroll) return chooseMove(s, crew, "navigator", rand);
  const hand = s.dice[crew].filter((d) => !d.placed).sort((a, b) => a.value! - b.value!);
  const tries: GameCommand[] = [];
  for (const d of hand) {
    const at = (target: PlacementTarget) => tries.push({ type: "placeDie", dieId: d.id, target });
    at({ kind: "engine" });
    at({ kind: "axis" });
    at({ kind: "radio", slot: 0 });
    for (const slot of [0, 1, 2]) at({ kind: "landingGear", slot });
    for (const slot of [0, 1, 2, 3]) at({ kind: "flaps", slot });
    for (const slot of [0, 1, 2]) at({ kind: "brakes", slot });
    at({ kind: "concentration", slot: 0 });
    at({ kind: "concentration", slot: 1 });
    at({ kind: "radio", slot: 1 });
  }
  for (const cmd of tries) {
    try {
      reduce(s, cmd, playerIdOf(s, crew));
      return cmd;
    } catch (e) {
      if (!(e instanceof GameRuleError)) throw e;
    }
  }
  return chooseMove(s, crew, "navigator", rand); // nothing cheap fits: Navigator over all moves
}

/** Play on until the round changes or the game ends (full information, both crews). */
export function rolloutRound(state: GameState, rand: Rand, maxSteps = 40): GameState {
  let s = state;
  const round = s.round;
  const now = () => 0;
  for (let i = 0; i < maxSteps && !s.outcome && s.round === round; i++) {
    const crew = actorFor(s);
    if (!crew) break;
    const move = fastMove(s, crew, rand);
    if (!move) break;
    s = applyIntent(s, move, playerIdOf(s, crew), rand, now);
  }
  return s;
}
```

`search.ts`:

```ts
import type { GameCommand } from "../protocol";
import { applyIntent, type Rand } from "../game/entropy";
import type { Crew } from "../game/scenario";
import type { GameState } from "../game/state";
import { evaluate } from "./evaluate";
import { legalMoves, playerIdOf } from "./moves";
import { rankMoves } from "./policy";
import { determinize, rolloutRound } from "./rollout";

/**
 * Aviator: determinized Monte Carlo over the Navigator's shortlist. Samples are
 * spread round-robin across candidates until the budget or `maxSamples` per
 * candidate is reached; the best average evaluation wins.
 */
export function searchMove(
  view: GameState,
  crew: Crew,
  rand: Rand,
  { budgetMs, shortlist = 6, maxSamples = 400 }: { budgetMs: number; shortlist?: number; maxSamples?: number },
): GameCommand | null {
  const moves = legalMoves(view, crew);
  if (moves.length <= 1) return moves[0] ?? null;
  const candidates = rankMoves(view, crew, moves, rand).slice(0, shortlist);
  const totals = candidates.map(() => 0);
  const counts = candidates.map(() => 0);
  const deadline = Date.now() + budgetMs;
  const now = () => 0;
  for (let k = 0; k < maxSamples && Date.now() < deadline; k++) {
    for (let i = 0; i < candidates.length && Date.now() < deadline; i++) {
      const world = determinize(view, rand);
      const after = rolloutRound(applyIntent(world, candidates[i], playerIdOf(view, crew), rand, now), rand);
      totals[i] += evaluate(after, crew);
      counts[i] += 1;
    }
  }
  let best = 0;
  for (let i = 1; i < candidates.length; i++) {
    if (counts[i] && totals[i] / counts[i] > totals[best] / Math.max(1, counts[best])) best = i;
  }
  return candidates[best];
}
```

A rolled-out world has full information, so `evaluate(after, crew)` reads the determinized partner dice there — that's a sampled world, not the true state, so fairness holds. Export `rollout` and `search` from `bot/index.ts`. The import cycle `policy → search → rollout → policy` (Task 2 adds the first edge) is safe because every cross-module call happens at runtime inside functions — keep module top levels free of calls into the cycle.

- [ ] **Step 4: Run** `npm run typecheck && npm test` → PASS. **Step 5: Commit** — `"Add Monte Carlo search for the Aviator level"`.

---

### Task 2: Three distinct difficulties

**Files:** `packages/shared/src/bot/policy.ts`, `selfplay.ts`; Test: `scripts/test-bot.mjs` section 6.

**Interfaces:**
- Produces: `chooseMove(view, crew, level, rand, opts?: { budgetMs?: number })` — `cadet`: Navigator with bounded mistakes; `navigator`: unchanged; `aviator`: `searchMove(view, crew, rand, { budgetMs: opts?.budgetMs ?? 600 })`. `selfPlay(setup, levels, seed, maxMoves?, opts?: { budgetMs?: number })` passes `opts` to `chooseMove`.

- [ ] **Step 1: Write the failing test**

```js
console.log("6) Difficulty levels behave differently");
{
  const { chooseMove, redactGameStateFor, rankMoves, legalMoves } = await import("../packages/shared/src/index.ts");
  const g = newGame({ ...DEFAULT_SETUP, modules: ["kerosene"] }, P, C, mulberry32(21), 0);
  const view = redactGameStateFor(g, P);
  const ranked = rankMoves(view, "pilot", legalMoves(view, "pilot"), mulberry32(0)).map((m) => JSON.stringify(m));
  const cadetPicks = new Set(Array.from({ length: 60 }, (_, i) => JSON.stringify(chooseMove(view, "pilot", "cadet", mulberry32(i)))));
  check("Cadet sometimes deviates from the best move", cadetPicks.size > 1);
  check("…but only among the top few (no wild blunders)", [...cadetPicks].every((m) => ranked.slice(0, 6).includes(m)));
  check("Aviator returns a legal move quickly in tests", legalMoves(view, "pilot").some((m) => JSON.stringify(m) === JSON.stringify(chooseMove(view, "pilot", "aviator", mulberry32(1), { budgetMs: 100 }))));
}
```

(`ranked.slice(0, 6)` rather than 4: equal scores are shuffled, so the 2nd–4th best of one ranking can sit a little lower in another.)

- [ ] **Step 2: Run** → FAIL (Cadet never deviates; Aviator plays like Navigator).

- [ ] **Step 3: Implement** — `chooseMove`:

```ts
export function chooseMove(view: GameState, crew: Crew, level: BotLevel, rand: Rand, opts?: { budgetMs?: number }): GameCommand | null {
  const moves = legalMoves(view, crew);
  if (moves.length === 0) return null;
  if (level === "aviator") return searchMove(view, crew, rand, { budgetMs: opts?.budgetMs ?? 600 });
  const ranked = rankMoves(view, crew, moves, rand);
  if (level === "cadet" && rand(100) < 35) return ranked[Math.min(ranked.length - 1, 1 + rand(3))]; // 35%: 2nd–4th best
  return ranked[0];
}
```

and `selfPlay` gains `opts?: { budgetMs?: number }`, passed to `chooseMove`.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"Make Cadet, Navigator and Aviator play differently"`.

---

### Task 3: Think off the main thread on the server

**Files:** Create `packages/server/src/npcWorker.ts`, `packages/server/src/think.ts`; modify `npc.ts`, `env.ts` (`NPC_THINK_MS`, default 600); Test: `scripts/test-units.mjs` new section "think()", and the solo E2E (Phase 2's validate section) run once with `level: "aviator"`.

**Interfaces:**
- Produces: `think(view: GameState, crew: Crew, level: BotLevel, seed: number, test?: { simulateWorkerError?: boolean }): Promise<GameCommand | null>` — Aviator runs in a worker with a hard timeout of `NPC_THINK_MS + 400` ms; on timeout or error it resolves Navigator's move computed on the main thread. Cadet/Navigator run inline (they're fast).

- [ ] **Step 1: Write the failing test** (in `scripts/test-units.mjs`)

```js
console.log("6) think(): Aviator in a worker, with a fallback");
{
  const { think, stopThinking } = await import("../packages/server/src/think.ts");
  const { newGame, mulberry32, redactGameStateFor, legalMoves, DEFAULT_SETUP } = await import("../packages/shared/src/index.ts");
  const g = newGame(DEFAULT_SETUP, "P", "C", mulberry32(9), 0);
  const view = redactGameStateFor(g, "P");
  const legal = (m) => legalMoves(view, "pilot").some((x) => JSON.stringify(x) === JSON.stringify(m));
  const t0 = Date.now();
  const m = await think(view, "pilot", "aviator", 1);
  check("Aviator answers through the worker within its budget", Date.now() - t0 < 4000 && legal(m));
  check("a worker failure falls back to Navigator", legal(await think(view, "pilot", "aviator", 1, { simulateWorkerError: true })));
  await stopThinking(); // let the test process exit
}
```

(Use the next free section number. The first worker start compiles TypeScript through tsx, so the first answer can take a couple of seconds; the server warms the worker at startup.)

- [ ] **Step 2: Run** → FAIL (`think.ts` missing).

- [ ] **Step 3: Implement**

`npcWorker.ts`:

```ts
import { parentPort } from "node:worker_threads";
import { chooseMove, mulberry32 } from "@skyteam/shared";

parentPort!.on("message", ({ id, view, crew, level, seed, budgetMs }) => {
  try {
    parentPort!.postMessage({ id, move: chooseMove(view, crew, level, mulberry32(seed), { budgetMs }) });
  } catch (e) {
    parentPort!.postMessage({ id, error: String(e) });
  }
});
```

`think.ts`:

```ts
import { Worker } from "node:worker_threads";
import { chooseMove, mulberry32, type BotLevel, type Crew, type GameCommand, type GameState } from "@skyteam/shared";
import { env } from "./env";

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, (m: GameCommand | null | Error) => void>();

function getWorker(): Worker {
  if (worker) return worker;
  // The server runs TypeScript through tsx (dev and production), so the worker must too.
  worker = new Worker(new URL("./npcWorker.ts", import.meta.url), { execArgv: ["--import", "tsx"] });
  worker.on("message", ({ id, move, error }) => pending.get(id)?.(error ? new Error(error) : move));
  worker.on("error", () => {
    for (const r of pending.values()) r(new Error("worker crashed"));
    pending.clear();
    worker = null;
  });
  worker.unref(); // never keep the process alive on its own
  return worker;
}

/** Start the worker ahead of the first Aviator move (it compiles on start). */
export function warmThinking(): void {
  getWorker();
}

/** Stop the worker (tests). */
export async function stopThinking(): Promise<void> {
  await worker?.terminate();
  worker = null;
}

/** The bot's move. Aviator thinks in a worker (never blocking other rooms); any
 *  failure or timeout falls back to Navigator, so the bot always moves. */
export function think(view: GameState, crew: Crew, level: BotLevel, seed: number, test?: { simulateWorkerError?: boolean }): Promise<GameCommand | null> {
  const fallback = () => chooseMove(view, crew, "navigator", mulberry32(seed));
  if (level !== "aviator") return Promise.resolve(chooseMove(view, crew, level, mulberry32(seed)));
  if (test?.simulateWorkerError) return Promise.resolve(fallback());
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(fallback());
    }, env.NPC_THINK_MS + 400);
    pending.set(id, (m) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(m instanceof Error ? fallback() : m);
    });
    getWorker().postMessage({ id, view, crew, level, seed, budgetMs: env.NPC_THINK_MS });
  });
}
```

If the first worker answer in the test exceeds the timeout (tsx compiling on start), call `warmThinking()` at the top of the test and wait for one throwaway answer before timing. `env.ts`: `NPC_THINK_MS: Number(process.env.NPC_THINK_MS ?? 600)`. `index.ts` (server): call `warmThinking()` at startup. `npc.ts`: replace the inline `chooseMove(...)` with `await think(redactGameStateFor(room.game!, turn.botId), turn.crew, turn.level, randomInt(0, 2 ** 31))`, and make the human-pace delay `max(0, NPC_DELAY_MS - thinking time)` for the next action so Aviator doesn't feel slower: measure the time `think` took and subtract it from the next timer.

- [ ] **Step 4: Run** `npm run typecheck && npm test` → PASS; the solo E2E once with `level: "aviator"` → PASS; `docker.exe compose -f docker-compose.dev.yml logs server` shows no worker errors.
- [ ] **Step 5: Commit** — `"Run the Aviator's search in a worker thread"`.

---

### Task 4: Measure, tune, and ship the levels

**Files:** `scripts/bench.mjs` (`compare` mode), `packages/shared/src/bot/evaluate.ts`, client landing copy (`App.tsx`), `README.md`; Test: `scripts/test-bot.mjs` (evaluator fixes).

- [ ] **Step 1: Fold in the Phase 1 review's deferred evaluator fixes**, each with a failing test first in `scripts/test-bot.mjs` section 3:
  - Switch capacity: switches can still be set this round after the move and on the landing round — count `roundsLeft + 1` rounds of capacity (as the Intern term already does). Test: on the landing round with one Flaps left and a Co-Pilot die that fits it, `evaluate` doesn't charge the +300 "can't make it" penalty.
  - Turn penalty: skip it on the landing round (no movement), and before both Axis dice are down (the tilt isn't final). Test: landing round, offset −1, Turn forbids −1 → no Turn penalty (the landing-level risk already charges the tilt).
  - Double moves: `paceRisk`'s `afterMove` must also fail a 2-space advance whose flown-through space has a Turn that forbids the current tilt (`resolveEngines` checks each step). Test: a Turn on `position + 1` forbidding the offset makes a double move fatal in `paceRisk`.

- [ ] **Step 2: Add `compare`** — `npm run bench -- [games=20] compare` plays a fixed small set with the *same seeds* for each level (`cadet`, `navigator`, `aviator` with `budgetMs: 50` to keep it tractable) and prints per level: win %, average progress score (rounds survived, +1 for a landing), and the tier verdict on the progress score.

```js
// in bench.mjs, before the per-setup loop
if (process.argv.includes("compare")) {
  const SET = [
    { scenarioId: "YUL", modules: [], abilities: [] },
    { scenarioId: "green-HND", modules: [], abilities: [] },
    { scenarioId: "green-OSL", modules: ["kerosene"], abilities: [] },
    { scenarioId: "yellow-KEF", modules: ["iceBrakes"], abilities: ["adaptation"] },
    { scenarioId: "yellow-GIG", modules: ["wind"], abilities: ["anticipation"] },
    { scenarioId: "green-ATL", modules: ["intern"], abilities: [] },
  ];
  const rows = ["cadet", "navigator", "aviator"].map((lv) => {
    let w = 0, score = 0, n = 0;
    for (const s of SET) for (let i = 0; i < N; i++) {
      const r = selfPlay(s, { pilot: lv, copilot: lv }, i, 400, { budgetMs: 50 });
      if (r.outcome === "won") w++;
      score += r.rounds + (r.outcome === "won" ? 1 : 0);
      n++;
    }
    return { lv, win: (100 * w) / n, score: score / n };
  });
  rows.forEach(({ lv, win, score }) => console.log(`${lv.padEnd(10)} ${win.toFixed(1)}% won · progress ${score.toFixed(2)}`));
  const ok = rows[2].score >= rows[1].score && rows[1].score >= rows[0].score;
  console.log(ok ? "tiers OK: Aviator ≥ Navigator ≥ Cadet" : "TIERS OUT OF ORDER");
  process.exit(ok ? 0 : 1);
}
```

Check each SET entry is a valid lobby setup (`SetSetupPayload`) before relying on it; swap any that isn't for its card's printed modules/abilities.

- [ ] **Step 3: Run** `npm run bench -- 20 compare`. Expected: tiers in order. If Aviator isn't ahead of Navigator, raise its budget in `compare` first (Aviator's real budget is 600 ms; `compare` uses 50 ms for speed) to see whether it's a budget effect; then tune `evaluate.ts` weights against `npm run bench -- 10` (each change: re-run, keep only improvements, note before/after in the commit). If Cadet isn't behind Navigator, raise its deviation rate (35%) or depth (2nd–4th best).
- [ ] **Step 4:** Client: drop "(soon)" from Cadet/Aviator. README: what each level does, and the measured `compare` numbers ("Benchmark (20 games × 6 setups, same seeds): Cadet …, Navigator …, Aviator …").
- [ ] **Step 5:** Full checks: `npm test`, E2E, the 21-card UI simulation, a solo browser check at each level. **Commit** — `"Tune the bot levels"` with the measured numbers.

---

## Self-review notes

- Three distinct levels: Cadet (bounded mistakes), Navigator (one-step evaluation from Phase 1), Aviator (Monte Carlo over hidden dice, time-budgeted).
- Fairness kept: search starts from the redacted view and samples unknown dice (`determinize`), never reading the true state.
- Responsiveness: Aviator off the main thread with a Navigator fallback; human pacing preserved.
- Strength is verified, not assumed: `bench compare` gates the merge on the tier order, on a metric that separates levels even at low win rates.
- Not in scope (user: "not yet"): move explanations.
