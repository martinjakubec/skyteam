# Bot Phase 3 — Search and the Three Difficulties Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three genuinely different NPC strengths — Cadet < Navigator < Aviator — with Aviator using Monte Carlo search over the dice it can't see, measured by the benchmark and run off the server's main thread.

**Architecture:** Aviator = *determinized Monte Carlo*: shortlist the Navigator's best few moves; for each, repeatedly fill in the partner's hidden dice with random values consistent with the bot's view, apply the move, play the rest of the round with a fast rollout policy for both crews, and score the result with `evaluate`; pick the move with the best average, within a time budget. Cadet = Navigator with deliberate, bounded mistakes. The server runs Aviator in a `worker_threads` worker with a timeout fallback to Navigator so one room's thinking never stalls others.

**Tech Stack:** TypeScript (`@skyteam/shared/bot`), Node `worker_threads` (server), Phase 1 benchmark.

**Spec:** Phases 1 and 2 plans (prerequisites, merged first) and the user decisions: three difficulties (names Cadet / Navigator / Aviator — Aviator the strongest); no move explanations yet.

## Global Constraints

- Prerequisites merged: Phase 1 (`chooseMove`, `evaluate`, `legalMoves`, `selfPlay`, `bench`, `mulberry32`, `Rand`, `applyIntent`, `resolveIntent`, `settle`) and Phase 2 (`scheduleNpc`, bot seats).
- Fairness: search may only sample hidden information; it starts from the bot's redacted view, never the true state.
- Aviator must answer within its time budget (default 600 ms, `NPC_THINK_MS` env) on the server; on timeout or worker error, fall back to Navigator.
- `npm test` must stay fast: search tests use tiny budgets / sample counts; strength comparisons live in `npm run bench`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A view with hidden partner dice and a pending prompt** (e.g. the bot must answer a Reroll): determinization must fill every hidden die, and the rollout must handle prompts via `actorFor`. Test in Task 1.
- **Only one legal move**: return it immediately, no sampling. Test in Task 1.
- **Final round**: rollouts end at the outcome (landing), not "end of round" + roll. Test in Task 1.
- **Worker crash / timeout**: the bot still moves (Navigator fallback) and the room isn't stuck. Test in Task 3.
- **Strength regressions**: tuning evaluator weights can make a level worse; the tier check in the benchmark must show Aviator ≥ Navigator ≥ Cadet before merging. Task 4.

---

## File Structure

- Create `packages/shared/src/bot/rollout.ts` — fast rollout policy + `rolloutRound`.
- Create `packages/shared/src/bot/search.ts` — `searchMove` (determinized Monte Carlo).
- Modify `packages/shared/src/bot/policy.ts` — level dispatch (Cadet noise, Aviator → search).
- Create `packages/server/src/npcWorker.ts` (worker entry) and `packages/server/src/think.ts` (pool + timeout); modify `npc.ts` to use `think`.
- Modify `scripts/bench.mjs` (`compare` mode), `scripts/test-bot.mjs`, `README.md`, client landing copy (drop "(soon)").

---

### Task 1: Fast rollouts and Monte Carlo search

**Files:** Create `packages/shared/src/bot/rollout.ts`, `search.ts`; export from `bot/index.ts`; Test: `scripts/test-bot.mjs` section 5.

**Interfaces:**
- Consumes: `actorFor`, `evaluate`, `legalMoves`, `chooseMove` (Navigator), `resolveIntent`, `settle`, `reduce`, `playerIdOf`.
- Produces:
  - `determinize(view: GameState, viewer: Crew, rand: Rand): GameState` — copy with every hidden die given a uniform 1..6 value.
  - `fastMove(state: GameState, crew: Crew, rand: Rand): GameCommand | null` — cheap policy for rollouts.
  - `rolloutRound(state: GameState, rand: Rand, maxSteps?: number): GameState` — play until the round number changes or the game ends.
  - `searchMove(view: GameState, crew: Crew, rand: Rand, opts: { budgetMs: number; shortlist?: number; maxSamples?: number }): GameCommand | null`.

- [ ] **Step 1: Failing tests**

```js
console.log("5) Monte Carlo search (Aviator)");
{
  const { searchMove, determinize, rolloutRound, redactGameStateFor, createInitialGameState, scenarioForSetup, reduce, legalMoves } = await import("../packages/shared/src/index.ts");
  const fresh = (dp, dc, s = DEFAULT_SETUP) => reduce(createInitialGameState(scenarioForSetup(s), P, C), { type: "roll", pilot: dp, copilot: dc }, "").state;
  const g = fresh([1, 3, 4, 6], [2, 2, 5, 5]);
  const view = redactGameStateFor(g, P);
  const d = determinize(view, "pilot", mulberry32(1));
  check("determinize fills every hidden die, keeps mine", d.dice.copilot.every((x) => x.value >= 1 && x.value <= 6 && !x.hidden) && d.dice.pilot.map((x) => x.value).join() === "1,3,4,6");
  const end = rolloutRound(d, mulberry32(2));
  check("a rollout finishes the round (or the game)", end.round === 2 || !!end.outcome);
  const m = searchMove(view, "pilot", mulberry32(3), { budgetMs: 150, shortlist: 4, maxSamples: 20 });
  check("search returns a legal move", legalMoves(view, "pilot").some((x) => JSON.stringify(x) === JSON.stringify(m)));
  // One legal move → returned at once: the Pilot's last die, Axis done, Engine open, no Coffee.
  const lastDie = fresh([1, 1, 1, 4], [1, 1, 1, 1]);
  lastDie.dice.pilot.slice(0, 3).forEach((x) => (x.placed = true));
  lastDie.axis.pilot = 1;
  const only = legalMoves(redactGameStateFor(lastDie, P), "pilot");
  check("(setup: exactly one legal move — the Engine)", only.length === 1 && only[0].target?.kind === "engine");
  const t0 = Date.now();
  check("single legal move returned without sampling", JSON.stringify(searchMove(redactGameStateFor(lastDie, P), "pilot", mulberry32(4), { budgetMs: 5000 })) === JSON.stringify(only[0]) && Date.now() - t0 < 200);
  // Respects the budget.
  const t1 = Date.now();
  searchMove(view, "pilot", mulberry32(5), { budgetMs: 200 });
  check("respects its time budget", Date.now() - t1 < 600);
  // Final round: rollouts stop at the landing outcome.
  const last = { ...fresh([1, 1, 1, 1], [1, 1, 1, 1]), round: 7 };
  check("final-round rollout ends with an outcome", !!rolloutRound(determinize(redactGameStateFor(last, P), "pilot", mulberry32(6)), mulberry32(7)).outcome);
}
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**

`rollout.ts`:

```ts
import type { GameCommand } from "../protocol";
import { applyIntent, type Rand } from "../game/engine";
import { reduce, GameRuleError } from "../game/reducer";
import type { Crew } from "../game/scenario";
import type { GameState } from "../game/state";
import { actorFor } from "./actor";
import { chooseMove } from "./policy";
import { playerIdOf } from "./moves";

/** Give every hidden die a random value — one plausible world consistent with the view. */
export function determinize(view: GameState, _viewer: Crew, rand: Rand): GameState {
  const s = structuredClone(view);
  for (const crew of ["pilot", "copilot"] as const) {
    for (const d of s.dice[crew]) if (d.hidden) { d.value = (rand(6) + 1) as never; d.hidden = undefined; }
  }
  return s;
}

/** Cheap rollout policy: Navigator on a small slice of moves would still call
 *  legalMoves; instead try a fixed priority list and take the first legal one.
 *  Prompts (held extras, reroll/swap answers) fall back to Navigator. */
export function fastMove(s: GameState, crew: Crew, rand: Rand): GameCommand | null {
  if (s.internHeld || s.trafficHeld || s.pendingSwap || s.pendingReroll) return chooseMove(s, crew, "navigator", rand);
  const hand = s.dice[crew].filter((d) => !d.placed).sort((a, b) => a.value! - b.value!);
  const side = crew;
  const tries: GameCommand[] = [];
  for (const d of hand) {
    tries.push({ type: "placeDie", dieId: d.id, target: { kind: "engine", side } });
    tries.push({ type: "placeDie", dieId: d.id, target: { kind: "axis", side } });
    tries.push({ type: "placeDie", dieId: d.id, target: { kind: "radio", slot: 0, side } });
    for (const slot of [0, 1, 2]) tries.push({ type: "placeDie", dieId: d.id, target: { kind: "landingGear", slot } });
    for (const slot of [0, 1, 2, 3]) tries.push({ type: "placeDie", dieId: d.id, target: { kind: "flaps", slot } });
    tries.push({ type: "placeDie", dieId: d.id, target: { kind: "concentration", slot: 0 } }, { type: "placeDie", dieId: d.id, target: { kind: "concentration", slot: 1 } });
    tries.push({ type: "placeDie", dieId: d.id, target: { kind: "radio", slot: 1, side } });
  }
  for (const cmd of tries) {
    try { reduce(s, cmd as never, playerIdOf(s, crew)); return cmd; } catch (e) { if (!(e instanceof GameRuleError)) throw e; }
  }
  return chooseMove(s, crew, "navigator", rand); // nothing cheap fits: let Navigator search all moves
}

/** Play on until the round changes or the game ends (full information, both crews). */
export function rolloutRound(state: GameState, rand: Rand, maxSteps = 40): GameState {
  let s = state;
  const round = s.round;
  for (let i = 0; i < maxSteps && !s.outcome && s.round === round; i++) {
    const crew = actorFor(s);
    if (!crew) break;
    const move = fastMove(s, crew, rand);
    if (!move) break;
    s = applyIntent(s, move, playerIdOf(s, crew), rand);
  }
  return s;
}
```

`search.ts`:

```ts
import type { GameCommand } from "../protocol";
import { applyIntent, type Rand } from "../game/engine";
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
  const candidates = rankMoves(view, crew, moves).slice(0, shortlist);
  const totals = candidates.map(() => 0);
  const counts = candidates.map(() => 0);
  const deadline = Date.now() + budgetMs;
  for (let k = 0; k < maxSamples && Date.now() < deadline; k++) {
    for (let i = 0; i < candidates.length && Date.now() < deadline; i++) {
      const world = determinize(view, crew, rand);
      const after = rolloutRound(applyIntent(world, candidates[i], playerIdOf(view, crew), rand), rand);
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

In `policy.ts`, factor the scoring loop into an exported `rankMoves(view, crew, moves): GameCommand[]` (sorted best-first by `scoreMove`), used by Navigator and by `searchMove`. Note the import cycle `policy → search → rollout → policy` (Task 2 adds the first edge): it's safe because every cross-module call happens at runtime inside functions — keep module top levels free of calls into the cycle.

- [ ] **Step 4: Run** `npm test` → PASS. **Step 5: Commit** — `"Add Monte Carlo search for the Aviator level"`.

---

### Task 2: Three distinct difficulties

**Files:** `packages/shared/src/bot/policy.ts`; Test: `scripts/test-bot.mjs` section 6.

**Interfaces:**
- Produces: `chooseMove(view, crew, level, rand, opts?: { budgetMs?: number })` — `cadet`: noisy Navigator; `navigator`: unchanged; `aviator`: `searchMove(view, crew, rand, { budgetMs: opts?.budgetMs ?? 600 })`.

- [ ] **Step 1: Failing tests**

```js
console.log("6) Difficulty levels behave differently");
{
  const { chooseMove, redactGameStateFor, rankMoves, legalMoves } = await import("../packages/shared/src/index.ts");
  const g = newGame({ ...DEFAULT_SETUP, modules: ["kerosene"] }, P, C, mulberry32(21));
  const view = redactGameStateFor(g, P);
  const ranked = rankMoves(view, "pilot", legalMoves(view, "pilot")).map((m) => JSON.stringify(m));
  const cadetPicks = new Set(Array.from({ length: 60 }, (_, i) => JSON.stringify(chooseMove(view, "pilot", "cadet", mulberry32(i)))));
  check("Cadet sometimes deviates from the best move", cadetPicks.size > 1);
  check("…but only among the top few (no wild blunders)", [...cadetPicks].every((m) => ranked.slice(0, 4).includes(m)));
  check("Navigator is consistent", new Set(Array.from({ length: 10 }, (_, i) => JSON.stringify(chooseMove(view, "pilot", "navigator", mulberry32(i))))).size <= 2);
  check("Aviator returns a legal move quickly in tests", legalMoves(view, "pilot").some((m) => JSON.stringify(m) === JSON.stringify(chooseMove(view, "pilot", "aviator", mulberry32(1), { budgetMs: 100 }))));
}
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** in `chooseMove`:

```ts
  if (level === "aviator") return searchMove(view, crew, rand, { budgetMs: opts?.budgetMs ?? 600 });
  const ranked = rankMoves(view, crew, moves);
  if (level === "cadet" && rand(100) < 35) return ranked[Math.min(ranked.length - 1, 1 + rand(3))]; // 35%: 2nd–4th best
  return ranked[0];
```

(keeping Navigator's random tie-break inside `rankMoves` by shuffling equal scores with `rand`).

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"Make Cadet, Navigator and Aviator play differently"`.

---

### Task 3: Think off the main thread on the server

**Files:** Create `packages/server/src/npcWorker.ts`, `packages/server/src/think.ts`; modify `npc.ts`, `env.ts` (`NPC_THINK_MS`, default 600); Test: `scripts/test-units.mjs` section "2e) think()" and the solo E2E from Phase 2 run with `level: "aviator"`.

**Interfaces:**
- Produces: `think(view: GameState, crew: Crew, level: BotLevel, seed: number): Promise<GameCommand | null>` — Aviator runs in a worker with a hard timeout of `NPC_THINK_MS + 400` ms; on timeout or error resolves Navigator's move computed on the main thread. Cadet/Navigator run inline (they're fast).

- [ ] **Step 1: Failing tests**

```js
console.log("2e) think(): Aviator in a worker, with a fallback");
{
  const { think } = await import("../packages/server/src/think.ts");
  const { newGame, mulberry32, redactGameStateFor, legalMoves, DEFAULT_SETUP } = await import("../packages/shared/src/index.ts");
  const g = newGame(DEFAULT_SETUP, "P", "C", mulberry32(9));
  const view = redactGameStateFor(g, "P");
  const t0 = Date.now();
  const m = await think(view, "pilot", "aviator", 1);
  check("Aviator answers through the worker within its budget", Date.now() - t0 < 2000 && legalMoves(view, "pilot").some((x) => JSON.stringify(x) === JSON.stringify(m)));
  const fallback = await think(view, "pilot", "aviator", 1, { simulateWorkerError: true });
  check("a worker failure falls back to Navigator", legalMoves(view, "pilot").some((x) => JSON.stringify(x) === JSON.stringify(fallback)));
}
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**

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
  // The server runs TypeScript through tsx (dev and prod), so the worker must too.
  worker = new Worker(new URL("./npcWorker.ts", import.meta.url), { execArgv: ["--import", "tsx"] });
  worker.on("message", ({ id, move, error }) => pending.get(id)?.(error ? new Error(error) : move));
  worker.on("error", () => { for (const r of pending.values()) r(new Error("worker crashed")); pending.clear(); worker = null; });
  return worker;
}

/** The bot's move. Aviator thinks in a worker (never blocking other rooms); any
 *  failure or timeout falls back to Navigator, so the bot always moves. */
export function think(view: GameState, crew: Crew, level: BotLevel, seed: number, test?: { simulateWorkerError?: boolean }): Promise<GameCommand | null> {
  const fallback = () => chooseMove(view, crew, "navigator", mulberry32(seed));
  if (level !== "aviator") return Promise.resolve(chooseMove(view, crew, level, mulberry32(seed)));
  if (test?.simulateWorkerError) return Promise.resolve(fallback());
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); resolve(fallback()); }, env.NPC_THINK_MS + 400);
    pending.set(id, (m) => { clearTimeout(timer); pending.delete(id); resolve(m instanceof Error ? fallback() : m); });
    getWorker().postMessage({ id, view, crew, level, seed, budgetMs: env.NPC_THINK_MS });
  });
}
```

`npc.ts`: replace the inline `chooseMove(...)` with `await think(redactGameStateFor(room.game!, turn.botId), turn.crew, turn.level, randomInt(0, 2 ** 31))`; the human-pace delay becomes `max(0, NPC_DELAY_MS - thinking time)` so Aviator doesn't feel slower than the others.

- [ ] **Step 4: Run** `npm test` → PASS; E2E solo section with `level: "aviator"` → PASS; check `docker compose logs server` shows no worker errors.
- [ ] **Step 5: Commit** — `"Run the Aviator's search in a worker thread"`.

---

### Task 4: Measure, tune, and ship the levels

**Files:** `scripts/bench.mjs` (`compare` mode), `packages/shared/src/bot/evaluate.ts` (weights), client landing copy, `README.md`.

- [ ] **Step 1: Add `compare`** — `npm run bench -- 100 compare` plays the representative setups with the *same seeds* for each level (`cadet`, `navigator`, `aviator` with `budgetMs: 150` to keep it tractable) and prints per-level win %, average round reached, and the tier verdict:

```js
// in bench.mjs
if (process.argv.includes("compare")) {
  const levels = ["cadet", "navigator", "aviator"];
  const rows = levels.map((lv) => {
    let w = 0, r = 0, n = 0;
    for (const s of setups) for (let i = 0; i < N; i++) { const res = selfPlay(s, { pilot: lv, copilot: lv }, i); if (res.outcome === "won") w++; r += res.rounds; n++; }
    return { lv, win: (100 * w) / n, round: r / n };
  });
  rows.forEach(({ lv, win, round }) => console.log(`${lv.padEnd(10)} ${win.toFixed(1)}% won · avg round ${round.toFixed(2)}`));
  const [c, nv, av] = rows;
  console.log(av.win >= nv.win && nv.win >= c.win ? "tiers OK: Aviator ≥ Navigator ≥ Cadet" : "TIERS OUT OF ORDER");
  process.exit(av.win >= nv.win && nv.win >= c.win ? 0 : 1);
}
```

`selfPlay` needs to pass `{ budgetMs }` through to `chooseMove` (add an optional `opts` parameter).

- [ ] **Step 2: Run** `npm run bench -- 100 compare`. Expected: tiers in order. If Aviator isn't ahead of Navigator by a visible margin (≥ 3 points), tune `evaluate.ts` weights against `npm run bench -- 100 navigator` first (each change: re-run, keep only improvements, note before/after in the commit), then re-check tiers. If Cadet is too strong or too weak, adjust its deviation rate (35%) or depth (2nd–4th best).
- [ ] **Step 3:** Client: drop "(soon)" from Cadet/Aviator; README: what each level does. Record the final per-level win rates in README ("Benchmark (100 games per setup): Cadet x%, Navigator y%, Aviator z%").
- [ ] **Step 4:** Full checks: `npm test`, E2E, `scripts/simulate.sh` (unaffected — it drives the UI), solo browser check at each level.
- [ ] **Step 5: Commit** — `"Tune the bot levels (Cadet x% / Navigator y% / Aviator z%)"`.

---

## Self-review notes

- Three distinct levels: Cadet (bounded mistakes), Navigator (one-step evaluation from Phase 1), Aviator (Monte Carlo over hidden dice, time-budgeted).
- Fairness kept: search starts from the redacted view and samples unknown dice (`determinize`), never reading the true state.
- Responsiveness: Aviator off the main thread with a Navigator fallback; human pacing preserved.
- Strength is verified, not assumed: `bench compare` gates the merge on the tier order.
- Not in scope (user: "not yet"): move explanations.
