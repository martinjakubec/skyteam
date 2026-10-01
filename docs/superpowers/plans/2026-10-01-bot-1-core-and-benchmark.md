# Bot Phase 1 — Core and Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A headless Sky Team bot that plays either seat through the real rules engine, plus a self-play benchmark that measures its win rate on every allowed setup.

**Architecture:** The bot lives in `packages/shared/src/bot/` so the server (Phase 2 NPC), the scripts and the tests share it. It never re-implements rules: it lists legal moves by trying candidate commands on the pure reducer, and ranks resulting states with a heuristic evaluator. It only ever sees its own redacted view (`redactGameStateFor`), so it has exactly a human's information. The server's randomness plumbing is extracted into a shared `engine.ts` so self-play can drive whole games with a seeded RNG.

**Tech Stack:** TypeScript (`@skyteam/shared`), tests as `.mjs` scripts run with `tsx` (see `scripts/test-rules.mjs`), Docker for all Node execution.

**Spec:** this plan plus the follow-on plans `2026-10-01-bot-2-npc-seat.md` and `2026-10-01-bot-3-search-and-difficulties.md`. User decisions (2026-10-01): the player chooses Pilot or Co-Pilot and the bot takes the other seat; three difficulty levels (names proposed below); no move explanations yet.

## Global Constraints

- Node runs only in Docker: `docker run --rm -v "$PWD":/app -v skyteam_check_nm:/app/node_modules -w /app node:22-alpine sh -c "npm run typecheck && npm test"`.
- The reducer (`packages/shared/src/game/reducer.ts`) stays pure and is the only source of rules; bot code must not duplicate legality checks.
- The bot decides from `redactGameStateFor(state, botPlayerId)` only — never from the full state. Partner's unplaced dice are unknown to it.
- Difficulty ids/labels (shared, used by all phases): `"cadet"` → **Cadet** (easiest), `"navigator"` → **Navigator** (middle), `"aviator"` → **Aviator** (strongest). Phase 1 implements Navigator; Cadet and Aviator alias it until Phase 3.
- New modules/abilities must stay covered: self-play runs over every allowed module × ability setup (user rule: test all combinations unless excluded).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push with `"/mnt/c/Program Files/Git/cmd/git.exe" push origin main`.

## Review Focus

- **A bot asked to act when it has no legal move** (e.g. every die blocked): `chooseMove` must not throw into the server loop — it returns `null`, and self-play records a "stuck" game. Test in Task 3.
- **Pending prompts that aren't a placement** (answer a Reroll, answer Working Together, place a held Intern token / Traffic die, train only with an allowed value): `actorFor` + `chooseMove` must handle each, or self-play stalls. Test in Task 3 and Task 4.
- **Reroll/Anticipation legality needs server values**: `legalMoves` must use placeholder values only to test legality and emit the *wire* command (no `values`). Test in Task 2.
- **Redacted partner dice** (`hidden: true`, no `value`): no bot path may read them. Test in Task 2 (moves from a redacted view are all legal on the full state).
- **Determinism**: same seed ⇒ same game, so benchmark regressions are reproducible. Test in Task 4.

---

## File Structure

- Create `packages/shared/src/game/engine.ts` — server-side entropy as pure helpers taking a `Rand`: dealing a new game, turning intents into reduce commands, settling pending rolls.
- Create `packages/shared/src/bot/rng.ts` — seeded PRNG (`mulberry32`) → `Rand`.
- Create `packages/shared/src/bot/levels.ts` — `BotLevel`, labels.
- Create `packages/shared/src/bot/moves.ts` — `legalMoves`.
- Create `packages/shared/src/bot/actor.ts` — `actorFor`: whose action the game is waiting on.
- Create `packages/shared/src/bot/evaluate.ts` — heuristic state score.
- Create `packages/shared/src/bot/policy.ts` — `chooseMove` (Navigator).
- Create `packages/shared/src/bot/selfplay.ts` — `selfPlay` one full game.
- Create `packages/shared/src/bot/index.ts`; export from `packages/shared/src/index.ts`.
- Modify `packages/server/src/socket.ts` — use `engine.ts` instead of its private helpers.
- Create `scripts/test-bot.mjs`; modify root `package.json` (`test`, new `bench`); create `scripts/bench.mjs`.

---

### Task 1: Shared game engine (server entropy as pure helpers)

**Files:**
- Create: `packages/shared/src/game/engine.ts`
- Modify: `packages/shared/src/index.ts`, `packages/server/src/socket.ts` (remove `rollHand`, `shuffledInternTokens`, the inline `rcmd` mapping and the two `while` loops in `onCommand`/`onStart`/`onReset`)
- Test: `scripts/test-bot.mjs` (new), root `package.json` `test` script

**Interfaces:**
- Produces:
  - `type Rand = (n: number) => number` — uniform integer in `[0, n)`.
  - `newGame(setup: GameSetup, pilotId: PlayerId, copilotId: PlayerId, rand: Rand): GameState` — scenario from setup, shuffled Intern tokens, round 1 rolled.
  - `resolveIntent(command: GameCommand, rand: Rand): ReduceCommand` — adds server values to `reroll` and `anticipate`; others unchanged.
  - `settle(game: GameState, rand: Rand): GameState` — answers `trafficPending` with `rollTraffic`, then rolls new rounds while `phase === "rolling"`.
  - `applyIntent(game: GameState, command: GameCommand, playerId: PlayerId, rand: Rand): GameState` — `settle(reduce(game, resolveIntent(command, rand), playerId).state, rand)`.

- [ ] **Step 1: Write the failing test** — create `scripts/test-bot.mjs`:

```js
// Bot and engine tests (pure, no server). Run via `npm test`.
import { newGame, applyIntent, resolveIntent, settle, mulberry32, DEFAULT_SETUP } from "../packages/shared/src/index.ts";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "  ✅" : "  ❌"} ${label}`); if (!cond) failures++; };
const P = "P", C = "C";

console.log("1) Engine: server entropy as pure helpers");
{
  const g = newGame({ ...DEFAULT_SETUP, modules: ["intern"] }, P, C, mulberry32(1));
  check("a new game is dealt and rolled", g.phase === "placement" && g.dice.pilot.length === 4 && g.internTokens.length === 6);
  check("same seed, same game", JSON.stringify(newGame(DEFAULT_SETUP, P, C, mulberry32(7))) === JSON.stringify(newGame(DEFAULT_SETUP, P, C, mulberry32(7))));
  const r = resolveIntent({ type: "reroll", dieIds: [0, 2] }, mulberry32(3));
  check("reroll intents get server values", r.values.length === 2 && r.values.every((v) => v >= 1 && v <= 6));
  check("other intents pass through", resolveIntent({ type: "adapt", dieId: 1 }, mulberry32(3)).type === "adapt");
  const placed = applyIntent(g, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, P, mulberry32(4));
  check("applyIntent applies and settles", placed.axis.pilot !== null && placed.turn === "copilot");
  check("settle leaves a placement-ready game", settle(g, mulberry32(5)).phase === "placement");
}

console.log(failures === 0 ? "\nALL BOT TESTS PASSED ✅" : `\n${failures} BOT TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
```

Root `package.json` `test` becomes `npm run build:shared && tsx scripts/test-rules.mjs && tsx scripts/test-units.mjs && tsx scripts/test-bot.mjs`.

- [ ] **Step 2: Run** `npm test` → FAIL: `does not provide an export named 'newGame'`.

- [ ] **Step 3: Implement** `packages/shared/src/game/engine.ts`:

```ts
import type { GameCommand, PlayerId } from "../protocol";
import { TRAFFIC_DIE_FACES } from "./abilities";
import { reduce, type ReduceCommand } from "./reducer";
import { DICE_PER_PLAYER, INTERN_TOKEN_COUNT, scenarioForSetup, type DieValue, type GameSetup } from "./scenario";
import { createInitialGameState, type GameState } from "./state";

/** A source of randomness: a uniform integer in [0, n). The server passes
 *  crypto.randomInt; tests and self-play pass a seeded PRNG. */
export type Rand = (n: number) => number;

const die = (rand: Rand) => (rand(6) + 1) as DieValue;
const hand = (rand: Rand) => Array.from({ length: DICE_PER_PLAYER }, () => die(rand));

function shuffledTokens(rand: Rand): DieValue[] {
  const t = Array.from({ length: INTERN_TOKEN_COUNT }, (_, i) => (i + 1) as DieValue);
  for (let i = t.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [t[i], t[j]] = [t[j], t[i]];
  }
  return t;
}

/** Deal a new game for a lobby setup and roll round 1. */
export function newGame(setup: GameSetup, pilotId: PlayerId, copilotId: PlayerId, rand: Rand): GameState {
  const game = createInitialGameState(scenarioForSetup(setup), pilotId, copilotId, { internTokens: shuffledTokens(rand) });
  return settle(game, rand);
}

/** Turn a client intent into a reduce command, adding server-owned values. */
export function resolveIntent(command: GameCommand, rand: Rand): ReduceCommand {
  if (command.type === "reroll") return { type: "reroll", dieIds: command.dieIds, values: command.dieIds.map(() => die(rand)) };
  if (command.type === "anticipate") return { type: "anticipate", dieId: command.dieId, value: die(rand) };
  return command;
}

/** Answer everything the reducer left waiting on randomness. */
export function settle(game: GameState, rand: Rand): GameState {
  let g = game;
  while (g.trafficPending && !g.outcome) {
    g = reduce(g, { type: "rollTraffic", value: TRAFFIC_DIE_FACES[rand(TRAFFIC_DIE_FACES.length)] }, "").state;
  }
  while (g.phase === "rolling" && !g.outcome) {
    g = reduce(g, { type: "roll", pilot: hand(rand), copilot: hand(rand) }, "").state;
  }
  return g;
}

/** One player action, end to end, as the server performs it. */
export function applyIntent(game: GameState, command: GameCommand, playerId: PlayerId, rand: Rand): GameState {
  return settle(reduce(game, resolveIntent(command, rand), playerId).state, rand);
}
```

Create `packages/shared/src/bot/rng.ts`:

```ts
import type { Rand } from "../game/engine";

/** Small, fast, seedable PRNG (mulberry32) as a Rand — reproducible self-play. */
export function mulberry32(seed: number): Rand {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}
```

Export both from `packages/shared/src/index.ts` (`export * from "./game/engine"; export * from "./bot/rng";`). In `socket.ts`: `const rand: Rand = (n) => randomInt(0, n);`; `onStart`/`onReset` use `newGame(room.setup, pilotId, copilotId, rand)`; `onCommand` uses `applyIntent(room.game, command, playerId, rand)`; delete `rollHand`, `shuffledInternTokens`, the `rcmd` mapping and both loops.

- [ ] **Step 4: Run** `npm test` → PASS; then restart the dev stack and run `scripts/validate.mjs` (compose network) → `ALL CHECKS PASSED`.
- [ ] **Step 5: Commit** — `"Extract server entropy into a shared engine"`.

---

### Task 2: Legal moves

**Files:** Create `packages/shared/src/bot/moves.ts`, `packages/shared/src/bot/levels.ts`, `packages/shared/src/bot/index.ts`; Test: `scripts/test-bot.mjs` section 2.

**Interfaces:**
- Consumes: `reduce`, `GameRuleError`, `redactGameStateFor`, `GameCommand`, `PlacementTarget`.
- Produces: `legalMoves(view: GameState, crew: Crew): GameCommand[]` (wire commands, ready to send); `type BotLevel = "cadet" | "navigator" | "aviator"`; `BOT_LEVELS`, `BOT_LEVEL_LABELS`; `playerIdOf(view: GameState, crew: Crew): PlayerId`.

- [ ] **Step 1: Failing tests** (append before the summary line)

```js
console.log("2) legalMoves from the bot's own (redacted) view");
{
  const { legalMoves, redactGameStateFor, reduce } = await import("../packages/shared/src/index.ts");
  const full = newGame({ ...DEFAULT_SETUP, modules: ["kerosene", "intern"], abilities: ["adaptation", "workingTogether"] }, P, C, mulberry32(11));
  const view = redactGameStateFor(full, P);
  const moves = legalMoves(view, "pilot");
  check("there are moves on the Pilot's turn", moves.length > 0);
  check("every move is legal on the full state", moves.every((m) => { try { applyIntent(full, m, P, mulberry32(1)); return true; } catch { return false; } }));
  check("includes an Axis placement", moves.some((m) => m.type === "placeDie" && m.target.kind === "axis"));
  check("includes Adaptation and a Working Together offer", moves.some((m) => m.type === "adapt") && moves.some((m) => m.type === "swap"));
  check("wire commands only (no server values)", moves.every((m) => !("values" in m) && !("value" in m)));
  const nextToken = full.internTokens.find((t) => t !== null);
  const trainer = full.dice.pilot.find((d) => d.value !== nextToken);
  const holding = applyIntent(full, { type: "placeDie", dieId: trainer.id, target: { kind: "intern" } }, P, mulberry32(2));
  const tokenMoves = legalMoves(redactGameStateFor(holding, P), "pilot");
  check("a held Intern token: only token placements, never Concentration", tokenMoves.length > 0 && tokenMoves.every((m) => m.type === "placeIntern" && m.target.kind !== "concentration"));
  check("off-turn: only off-turn actions (Adaptation)", legalMoves(redactGameStateFor(full, C), "copilot").every((m) => m.type === "adapt"));
}
```

- [ ] **Step 2: Run** → FAIL (`legalMoves` not exported).
- [ ] **Step 3: Implement**

`levels.ts`:

```ts
/** NPC difficulty, easiest → strongest. Names are aviation ranks, deliberately
 *  not "Pilot"/"Co-Pilot" (those are the seats). */
export const BOT_LEVELS = ["cadet", "navigator", "aviator"] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];
export const BOT_LEVEL_LABELS: Record<BotLevel, string> = { cadet: "Cadet", navigator: "Navigator", aviator: "Aviator" };
```

`moves.ts`:

```ts
import type { GameCommand, PlacementTarget, PlayerId } from "../protocol";
import { GameRuleError, reduce, type ReduceCommand } from "../game/reducer";
import type { Crew, DieValue } from "../game/scenario";
import type { GameState } from "../game/state";

export const playerIdOf = (view: GameState, crew: Crew): PlayerId => (crew === "pilot" ? view.pilotId : view.copilotId);

/** Every space, both sides, for trying candidates on the reducer. */
function allTargets(): PlacementTarget[] {
  const sides = ["pilot", "copilot"] as const;
  return [
    ...sides.flatMap((side) => [
      { kind: "axis" as const, side },
      { kind: "engine" as const, side },
      ...[0, 1].map((slot) => ({ kind: "radio" as const, slot, side })),
      { kind: "intern" as const, side },
    ]),
    ...[0, 1, 2].map((slot) => ({ kind: "landingGear" as const, slot })),
    ...[0, 1, 2, 3].map((slot) => ({ kind: "flaps" as const, slot })),
    ...[0, 1, 2].map((slot) => ({ kind: "brakes" as const, slot })),
    ...[0, 1].map((slot) => ({ kind: "concentration" as const, slot })),
    { kind: "kerosene" as const },
    ...[0, 1, 2, 3].flatMap((slot) => (["top", "bottom"] as const).map((space) => ({ kind: "iceBrakes" as const, slot, space }))),
  ];
}
const TARGETS = allTargets();

/** The reduce form of a wire command, with placeholder values where the server
 *  would add randomness (legality never depends on them). */
function asReduce(cmd: GameCommand): ReduceCommand {
  if (cmd.type === "reroll") return { ...cmd, values: cmd.dieIds.map(() => 1 as DieValue) };
  if (cmd.type === "anticipate") return { ...cmd, value: 1 };
  return cmd;
}

const legal = (view: GameState, crew: Crew, cmd: GameCommand): boolean => {
  try {
    reduce(view, asReduce(cmd), playerIdOf(view, crew));
    return true;
  } catch (e) {
    if (e instanceof GameRuleError) return false;
    throw e;
  }
};

/**
 * Every command `crew` may send now, found by trying candidates on the pure
 * reducer against the bot's own redacted view (rules live only there). Coffee
 * variants and reroll subsets are included; a Reroll response is any subset of
 * the crew's unplaced dice (including none).
 */
export function legalMoves(view: GameState, crew: Crew): GameCommand[] {
  const out: GameCommand[] = [];
  const hand = view.dice[crew].filter((d) => !d.placed);
  const add = (cmd: GameCommand) => legal(view, crew, cmd) && out.push(cmd);

  for (const target of TARGETS) add({ type: "placeTraffic", target }); // any colour
  for (const target of TARGETS) if (!("side" in target) || target.side === crew) add({ type: "placeIntern", target });
  // A crew's own dice and tokens only ever go on its own side of per-crew spaces.
  const own = TARGETS.filter((t) => !("side" in t) || t.side === crew);
  for (const d of hand) {
    for (let coffee = -view.coffee; coffee <= view.coffee; coffee++) {
      for (const target of own) add({ type: "placeDie", dieId: d.id, target, ...(coffee ? { coffeeDelta: coffee } : {}) });
    }
    add({ type: "adapt", dieId: d.id });
    add({ type: "anticipate", dieId: d.id });
    add({ type: "swap", dieId: d.id });
  }
  // Rerolls: every subset of the unplaced dice (initiation needs ≥1; a response may be empty).
  for (let mask = 0; mask < 1 << hand.length; mask++) {
    add({ type: "reroll", dieIds: hand.filter((_, i) => mask & (1 << i)).map((d) => d.id) });
  }
  return out;
}
```

**Performance budget.** Each candidate is one `reduce` (a `structuredClone` of the state, ~10–30 µs). Own-side filtering keeps it to ~4 dice × ~25 spaces × (1 + 2·Coffee) ≈ 100–700 tries per decision → a few ms; a game is ~60 decisions ≈ 0.2–0.5 s. Budget the tests and benchmark accordingly (Task 4). If it's too slow, add a cheap pre-filter on value-restricted spaces (Gear/Flaps/Brakes/Ice Brakes values, already-filled spaces) before calling `reduce` — the reducer still has the final say.

`bot/index.ts` re-exports `levels`, `moves`, `rng` (and later files); `packages/shared/src/index.ts` adds `export * from "./bot";`.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"Add bot legal-move generation"`.

---

### Task 3: Actor, evaluator and the Navigator policy

**Files:** Create `packages/shared/src/bot/actor.ts`, `evaluate.ts`, `policy.ts`; Test: `scripts/test-bot.mjs` section 3.

**Interfaces:**
- Produces:
  - `actorFor(game: GameState): Crew | null` — whose input the game waits on: `internHeld.crew`; `"copilot"` if `trafficHeld`; the answering crew if `pendingSwap` / `pendingReroll`; else `turn` while `phase === "placement"`; `null` when over.
  - `evaluate(state: GameState, crew: Crew): number` — higher is better for the crew (shared fate: both crews get the same score; `crew` is kept for future asymmetric terms).
  - `chooseMove(view: GameState, crew: Crew, level: BotLevel, rand: Rand): GameCommand | null`.

- [ ] **Step 1: Failing tests**

```js
console.log("3) actorFor, evaluate, chooseMove (Navigator)");
{
  const { actorFor, chooseMove, evaluate, redactGameStateFor, createInitialGameState, reduce, scenarioForSetup } = await import("../packages/shared/src/index.ts");
  const setup = (mods = [], abs = []) => ({ ...DEFAULT_SETUP, modules: mods, abilities: abs });
  const fresh = (dp, dc, s = setup()) => reduce(createInitialGameState(scenarioForSetup(s), P, C), { type: "roll", pilot: dp, copilot: dc }, "").state;

  check("actor: turn by default", actorFor(fresh([1, 1, 1, 1], [1, 1, 1, 1])) === "pilot");
  const swap = reduce(fresh([1, 2, 3, 4], [6, 5, 4, 3], setup([], ["workingTogether"])), { type: "swap", dieId: 0 }, P).state;
  check("actor: the player who must answer a swap", actorFor(swap) === "copilot");

  // Avoid a spin (YUL spins at ±3): the Co-Pilot's Axis is a 6; the Pilot holds 1, 5, 6, 6 → must not play the 1.
  let s = fresh([1, 5, 6, 6], [6, 1, 1, 1]);
  s.turn = "copilot";
  s = reduce(s, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, C).state;
  const m = chooseMove(redactGameStateFor(s, P), "pilot", "navigator", mulberry32(1));
  check("doesn't spin the plane", !(m.type === "placeDie" && m.target.kind === "axis" && s.dice.pilot[m.dieId].value === 1));

  // Clear traffic: a 2 on the Radio clears the airplane right ahead.
  const t = fresh([2, 1, 1, 1], [1, 1, 1, 1]);
  check("evaluate prefers fewer airplanes", evaluate({ ...t, airplanes: t.airplanes.map((a, i) => (i === 1 ? 0 : a)) }, "pilot") > evaluate(t, "pilot"));

  // Answers prompts: a held Intern token gets placed.
  const n = reduce(fresh([2, 1, 1, 1], [1, 1, 1, 1], setup(["intern"])), { type: "placeDie", dieId: 0, target: { kind: "intern" } }, P).state;
  check("places a held Intern token", chooseMove(redactGameStateFor(n, P), "pilot", "navigator", mulberry32(2))?.type === "placeIntern");

  // No legal move → null, never a throw.
  const over = { ...fresh([1, 1, 1, 1], [1, 1, 1, 1]), phase: "lost" };
  check("no legal move → null", chooseMove(over, "pilot", "navigator", mulberry32(3)) === null);
}
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

`actor.ts`:

```ts
import type { Crew } from "../game/scenario";
import type { GameState } from "../game/state";

const other = (c: Crew): Crew => (c === "pilot" ? "copilot" : "pilot");

/** Whose input the game is waiting on right now (null once it's over). */
export function actorFor(g: GameState): Crew | null {
  if (g.outcome || g.phase !== "placement") return null;
  if (g.internHeld) return g.internHeld.crew;
  if (g.trafficHeld) return "copilot";
  if (g.pendingSwap) return other(g.pendingSwap.from);
  if (g.pendingReroll) return g.pendingReroll;
  return g.turn;
}
```

`evaluate.ts` (weights are starting points; Phase 3 tunes them with the benchmark):

```ts
import { airportIndex, type GameState } from "../game/state";
import { ICE_BRAKE_VALUES, type Crew } from "../game/scenario";

export const WIN = 10_000;

/**
 * Heuristic value of a state for the crew (the game is co-operative, so it's
 * the same for both seats). Terms: outcome; approach progress vs rounds left;
 * traffic in the way; tilt; switches still to deploy vs rounds left; brakes;
 * Kerosene and Intern pressure; small credit for Coffee / Reroll tokens.
 */
export function evaluate(s: GameState, _crew: Crew): number {
  if (s.outcome) return s.outcome.result === "won" ? WIN : -WIN;
  const roundsLeft = s.scenario.rounds - s.round; // rounds still able to move (final round can't)
  const remaining = airportIndex(s.scenario) - s.position;
  let v = 0;
  // Must cover `remaining` spaces in `roundsLeft` rounds, ≤2 per round.
  if (remaining > 2 * roundsLeft) v -= 3000;
  v -= Math.abs(remaining - roundsLeft) * 40;
  // Airplanes still on the path (each must be cleared before the plane leaves its space).
  s.airplanes.forEach((n, i) => { if (i >= s.position) v -= n * (i - s.position <= 2 ? 120 : 60); });
  // Tilt: 0 is level; ±spinAt is fatal (already an outcome); landing needs 0.
  v -= Math.abs(s.axis.offset) * (Math.abs(s.axis.offset) >= s.scenario.axisSpinAt - 1 ? 400 : 80);
  // Switches to deploy before landing.
  const todo = s.gearGreen.filter((g) => !g).length + s.flapsGreen.filter((g) => !g).length;
  v -= todo * 60 + Math.max(0, todo - 2 * roundsLeft) * 300;
  const iceOn = s.scenario.modules?.includes("iceBrakes");
  const brakeGoal = iceOn ? ICE_BRAKE_VALUES.length : 1;
  v -= Math.max(0, brakeGoal - s.brakesDeployed) * (iceOn ? 150 : 100);
  if (s.scenario.modules?.some((m) => m === "kerosene" || m === "keroseneLeak")) {
    v -= Math.max(0, roundsLeft * 4 - s.kerosene) * 50;
  }
  if (s.scenario.modules?.includes("intern")) {
    const untrained = s.internTokens.filter((t) => t !== null).length;
    v -= untrained * 40 + Math.max(0, untrained - 2 * (roundsLeft + 1)) * 400;
  }
  v += s.coffee * 15 + s.rerollTokens * 25;
  return v;
}
```

`policy.ts`:

```ts
import type { GameCommand } from "../protocol";
import { reduce, type ReduceCommand } from "../game/reducer";
import type { Crew, DieValue } from "../game/scenario";
import type { GameState } from "../game/state";
import type { Rand } from "../game/engine";
import { evaluate } from "./evaluate";
import type { BotLevel } from "./levels";
import { legalMoves, playerIdOf } from "./moves";

/** Score a move by the state it leads to. Random outcomes (rerolls) are
 *  scored at their expectation's stand-in: the current value (neutral). */
function scoreMove(view: GameState, crew: Crew, move: GameCommand): number {
  const cmd: ReduceCommand =
    move.type === "reroll" ? { ...move, values: move.dieIds.map((id) => view.dice[crew].find((d) => d.id === id)!.value as DieValue) }
    : move.type === "anticipate" ? { ...move, value: view.dice[crew].find((d) => d.id === move.dieId)!.value as DieValue }
    : move;
  const next = reduce(view, cmd, playerIdOf(view, crew)).state;
  return evaluate(next, crew) + reserveBonus(view, crew, move);
}

/** Keep the dice the crew will need: the lowest for an open Engine and the most
 *  level-friendly for an open Axis (spending them elsewhere is penalised). */
function reserveBonus(view: GameState, crew: Crew, move: GameCommand): number {
  if (move.type !== "placeDie" || move.target.kind === "axis" || move.target.kind === "engine") return 0;
  const hand = view.dice[crew].filter((d) => !d.placed);
  const die = hand.find((d) => d.id === move.dieId)!;
  let penalty = 0;
  if (view.engines[crew] === null && die === hand.reduce((m, d) => (d.value! < m.value! ? d : m))) penalty += 60;
  const ideal = crew === "pilot" ? 3.5 - view.axis.offset : 3.5 + view.axis.offset;
  if (view.axis[crew] === null && die === hand.reduce((m, d) => (Math.abs(d.value! - ideal) < Math.abs(m.value! - ideal) ? d : m))) penalty += 40;
  return -penalty;
}

/**
 * Pick the bot's next command from its own view. Navigator: best one-step
 * score (ties broken at random). Cadet/Aviator alias Navigator until Phase 3.
 * Returns null when nothing is legal.
 */
export function chooseMove(view: GameState, crew: Crew, _level: BotLevel, rand: Rand): GameCommand | null {
  const moves = legalMoves(view, crew);
  if (moves.length === 0) return null;
  let best: GameCommand[] = [];
  let bestScore = -Infinity;
  for (const m of moves) {
    const s = scoreMove(view, crew, m);
    if (s > bestScore + 1e-9) { best = [m]; bestScore = s; }
    else if (Math.abs(s - bestScore) <= 1e-9) best.push(m);
  }
  return best[rand(best.length)];
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"Add the Navigator bot policy"`.

---

### Task 4: Self-play and the benchmark

**Files:** Create `packages/shared/src/bot/selfplay.ts`, `scripts/bench.mjs`; modify root `package.json` (`"bench": "npm run build:shared && tsx scripts/bench.mjs"`); Test: `scripts/test-bot.mjs` section 4; README "Tests" section.

**Interfaces:**
- Consumes: `newGame`, `applyIntent`, `actorFor`, `chooseMove`, `redactGameStateFor`.
- Produces: `selfPlay(setup: GameSetup, levels: Record<Crew, BotLevel>, seed: number, maxMoves?: number): { outcome: "won" | "lost" | "stuck"; reason: string; rounds: number; moves: number }`.

- [ ] **Step 1: Failing tests**

```js
console.log("4) Self-play: every module combination, and every ability");
{
  // Every allowed module combination (no abilities) + each ability alone and
  // with all compatible modules — the full module × ability matrix runs in
  // `npm run bench -- ALL` (too slow for npm test at ~0.3 s per game).
  const { selfPlay, SetSetupPayload, IMPLEMENTED_MODULES, ABILITY_IDS } = await import("../packages/shared/src/index.ts");
  const subsets = (xs) => xs.reduce((acc, x) => [...acc, ...acc.map((c) => [...c, x])], [[]]);
  const valid = (s) => SetSetupPayload.safeParse(s).success;
  const moduleSets = subsets([...IMPLEMENTED_MODULES]).filter((modules) => valid({ scenarioId: "YUL", modules, abilities: [] }));
  const richest = moduleSets.reduce((m, c) => (c.length > m.length ? c : m), []);
  const setups = [
    ...moduleSets.map((modules) => ({ scenarioId: "YUL", modules, abilities: [] })),
    ...ABILITY_IDS.flatMap((a) => [{ scenarioId: "YUL", modules: [], abilities: [a] }, { scenarioId: "YUL", modules: richest, abilities: [a] }]),
  ];
  const results = setups.map((s, i) => ({ s, r: selfPlay(s, { pilot: "navigator", copilot: "navigator" }, 1000 + i) }));
  const stuck = results.filter(({ r }) => r.outcome === "stuck");
  check(`${setups.length} setups each play to a finished game`, stuck.length === 0);
  stuck.slice(0, 5).forEach(({ s, r }) => console.log(`     ↳ stuck: ${[...s.modules, ...s.abilities].join("+") || "base"} — ${r.reason}`));
  const a = selfPlay(setups[0], { pilot: "navigator", copilot: "navigator" }, 42);
  const b = selfPlay(setups[0], { pilot: "navigator", copilot: "navigator" }, 42);
  check("same seed, same game", JSON.stringify(a) === JSON.stringify(b));
}
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `selfplay.ts`:

```ts
import { applyIntent, newGame } from "../game/engine";
import type { Crew, GameSetup } from "../game/scenario";
import { redactGameStateFor } from "../game/state";
import { actorFor } from "./actor";
import type { BotLevel } from "./levels";
import { chooseMove } from "./policy";
import { mulberry32 } from "./rng";

export interface SelfPlayResult { outcome: "won" | "lost" | "stuck"; reason: string; rounds: number; moves: number }

/** One full bot-vs-bot game: each seat decides from its own redacted view; the
 *  engine supplies seeded randomness exactly as the server would. */
export function selfPlay(setup: GameSetup, levels: Record<Crew, BotLevel>, seed: number, maxMoves = 400): SelfPlayResult {
  const rand = mulberry32(seed);
  let g = newGame(setup, "P", "C", rand);
  let moves = 0;
  for (; moves < maxMoves; moves++) {
    const crew = actorFor(g);
    if (!crew) break;
    const id = crew === "pilot" ? "P" : "C";
    const move = chooseMove(redactGameStateFor(g, id), crew, levels[crew], rand);
    if (!move) return { outcome: "stuck", reason: `no legal move for the ${crew} (round ${g.round})`, rounds: g.round, moves };
    g = applyIntent(g, move, id, rand);
  }
  if (!g.outcome) return { outcome: "stuck", reason: `no outcome after ${moves} moves`, rounds: g.round, moves };
  return { outcome: g.outcome.result, reason: g.outcome.result === "lost" ? g.outcome.reason : "", rounds: g.round, moves };
}
```

`scripts/bench.mjs` — usage `npm run bench -- [games=30] [level=navigator] [ALL]`. By default it plays the representative setups from the self-play test (every module combination + each ability alone and with all compatible modules, ~24 setups); `ALL` plays every allowed module × ability setup (264; minutes per game count). `ONLY="intern,kerosene"` (env) keeps setups containing all those ids. Prints one line per setup: win % · average round reached · top 3 loss reasons; then the overall win %.

```js
import { selfPlay, SetSetupPayload, IMPLEMENTED_MODULES, ABILITY_IDS, DEFAULT_MAX_ABILITIES } from "../packages/shared/src/index.ts";
const N = Number(process.argv[2] ?? 30);
const level = process.argv[3] ?? "navigator";
const all = process.argv.includes("ALL");
const ONLY = process.env.ONLY?.split(",");
const subsets = (xs) => xs.reduce((acc, x) => [...acc, ...acc.map((c) => [...c, x])], [[]]);
const valid = (s) => SetSetupPayload.safeParse(s).success;
const moduleSets = subsets([...IMPLEMENTED_MODULES]).filter((modules) => valid({ scenarioId: "YUL", modules, abilities: [] }));
const richest = moduleSets.reduce((m, c) => (c.length > m.length ? c : m), []);
const candidates = all
  ? moduleSets.flatMap((modules) => subsets([...ABILITY_IDS]).filter((a) => a.length <= DEFAULT_MAX_ABILITIES).map((abilities) => ({ scenarioId: "YUL", modules, abilities })))
  : [
      ...moduleSets.map((modules) => ({ scenarioId: "YUL", modules, abilities: [] })),
      ...ABILITY_IDS.flatMap((a) => [{ scenarioId: "YUL", modules: [], abilities: [a] }, { scenarioId: "YUL", modules: richest, abilities: [a] }]),
    ];
const setups = candidates.filter((s) => valid(s) && (!ONLY || ONLY.every((x) => [...s.modules, ...s.abilities].includes(x))));
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
  console.log(`${([...s.modules, ...s.abilities].join("+") || "base").padEnd(48)} ${((100 * w) / N).toFixed(1).padStart(5)}%  avg round ${(rounds / N).toFixed(1)}  ${top}`);
}
console.log(`\nOverall: ${((100 * wins) / games).toFixed(1)}% won over ${games} games (${level})`);
```

- [ ] **Step 4: Run** `npm test` → PASS (self-play section should take well under a minute); `npm run bench -- 30` → a table. Record the overall win % in the commit message as the Phase-1 baseline.
- [ ] **Step 5:** README "Tests": document `npm run bench`. **Commit** — `"Add bot self-play and win-rate benchmark (baseline: N%)"`.

---

## Self-review notes

- Covers: legal-move generation via the reducer (no duplicated rules), fair information (redacted view only), evaluator, policy, prompts (actor), deterministic self-play, benchmark over every allowed setup.
- Names used by later phases: `BotLevel`/`BOT_LEVELS`/`BOT_LEVEL_LABELS`, `actorFor`, `chooseMove(view, crew, level, rand)`, `applyIntent`, `newGame`, `Rand`, `mulberry32`, `selfPlay`, `evaluate`, `legalMoves`, `playerIdOf`.
