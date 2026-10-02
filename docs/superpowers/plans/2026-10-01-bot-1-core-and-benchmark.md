# Bot Phase 1 — Core and Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revised 2026-10-02** against the current code. What changed since the 2026-10-01 draft: the server's dice code already moved to `packages/shared/src/game/entropy.ts` (`Dice`, `withEntropy`, `roundRoll`, `settle`), so Task 1 builds on it instead of creating a parallel `engine.ts`. Rounds can now need Traffic dice (printed on scenario spaces) and Real-Time rolls need a clock time, which `roundRoll` already handles. The lobby offers 21 scenario cards with Turns, Traffic dice and prescribed modules, so self-play and the benchmark cover every card, not just YUL, and the evaluator knows about Turns. The Traffic Die module is gone; `placeTraffic` now only comes from Synchronisation.

**Goal:** A headless Sky Team bot that plays either seat through the real rules engine, plus a self-play benchmark that measures its win rate on every allowed setup.

**Architecture:** The bot lives in `packages/shared/src/bot/` so the server (Phase 2 NPC), the scripts and the tests share it. It never re-implements rules: it lists legal moves by trying candidate commands on the pure reducer, and ranks the resulting states with a heuristic evaluator. It only ever sees its own redacted view (`redactGameStateFor`), so it has exactly a human's information. Whole games are dealt and driven through `entropy.ts` with a seeded random source, so self-play is reproducible.

**Tech Stack:** TypeScript (`@skyteam/shared`), tests as `.mjs` scripts run with `tsx` (see `scripts/test-units.mjs`), Docker for all Node execution.

**Spec:** this plan plus the follow-on plans `2026-10-01-bot-2-npc-seat.md` and `2026-10-01-bot-3-search-and-difficulties.md`. User decisions (2026-10-01): the player chooses Pilot or Co-Pilot and the bot takes the other seat; three difficulty levels (names below); no move explanations yet.

## Global Constraints

- Node runs only in Docker. With the dev stack up: `docker.exe compose -f docker-compose.dev.yml exec -T client sh -c "npm run typecheck && npm test"`.
- The reducer (`packages/shared/src/game/reducer.ts`) stays pure and is the only source of rules; bot code must not duplicate legality checks.
- The bot decides from `redactGameStateFor(state, botPlayerId)` only — never from the full state. The partner's unplaced dice are unknown to it (`hidden: true`, no `value`).
- Difficulty ids/labels (shared, used by all phases): `"cadet"` → **Cadet** (easiest), `"navigator"` → **Navigator** (middle), `"aviator"` → **Aviator** (strongest). Phase 1 implements Navigator; Cadet and Aviator alias it until Phase 3.
- Every allowed setup stays covered (user rule: test all combinations unless excluded): every scenario card, every allowed module combination, every Special Ability.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push with `"/mnt/c/Program Files/Git/cmd/git.exe" push origin main`.

## Review Focus

- **A bot asked to act when it has no legal move**: `chooseMove` returns `null` (never throws into the server loop); self-play records a "stuck" game. Test in Task 3.
- **Prompts that aren't a normal placement** (answer a Reroll, answer Working Together, place a held Intern token or Synchronisation Traffic die): `actorFor` + `chooseMove` handle each, or self-play stalls. Tests in Tasks 3 and 4.
- **Reroll/Anticipation need server values**: `legalMoves` uses placeholder values only to test legality and emits the *wire* command (no `values`/`value`). Test in Task 2.
- **Redacted partner dice**: no bot path reads them; every move found from a redacted view is legal on the full state. Test in Task 2.
- **Turns and Traffic dice on the cards**: a bot that ignores a Turn loses at once ("Missed the turn"); rounds on spaces with Traffic dice must roll them. Self-play over all 21 cards finishes every game (Task 4), and the evaluator penalises a tilt the current space's Turn forbids (Task 3).

---

## File Structure

- Modify `packages/shared/src/game/entropy.ts` — add `Rand`, `randDice`, `shuffledInternTokens`, `newGame`, `applyIntent` next to the existing `Dice`, `withEntropy`, `roundRoll`, `settle`.
- Modify `packages/server/src/socket.ts` — use `newGame` and `randDice` instead of its private `shuffledInternTokens`, `serverDice` literal and duplicated start/reset code.
- Create `packages/shared/src/bot/rng.ts` — seeded PRNG (`mulberry32`) → `Rand`.
- Create `packages/shared/src/bot/levels.ts` — `BotLevel`, labels.
- Create `packages/shared/src/bot/moves.ts` — `legalMoves`, `playerIdOf`.
- Create `packages/shared/src/bot/actor.ts` — `actorFor`: whose input the game is waiting on.
- Create `packages/shared/src/bot/evaluate.ts` — heuristic state score.
- Create `packages/shared/src/bot/policy.ts` — `chooseMove` (Navigator).
- Create `packages/shared/src/bot/setups.ts` — the setups self-play and the benchmark cover (cards, module combinations, abilities).
- Create `packages/shared/src/bot/selfplay.ts` — `selfPlay`: one full game.
- Create `packages/shared/src/bot/index.ts`; export it from `packages/shared/src/index.ts`.
- Create `scripts/test-bot.mjs`, `scripts/bench.mjs`; modify root `package.json` (`test`, new `bench`); README "Tests".

---

### Task 1: Deal and drive whole games from a random source

**Files:**
- Modify: `packages/shared/src/game/entropy.ts`, `packages/server/src/socket.ts`
- Create: `packages/shared/src/bot/rng.ts`, `packages/shared/src/bot/index.ts`; modify `packages/shared/src/index.ts`
- Test: `scripts/test-bot.mjs` (new), root `package.json` `test` script

**Interfaces:**
- Consumes (exists): `Dice { d6(): DieValue; traffic(): DieValue }`, `withEntropy(command, dice)`, `roundRoll(game, dice, at)`, `settle(game, dice, now: () => number)`.
- Produces:
  - `type Rand = (n: number) => number` — a uniform integer in `[0, n)`.
  - `randDice(rand: Rand): Dice`.
  - `shuffledInternTokens(rand: Rand): DieValue[]` — 1..6 in a random order.
  - `newGame(setup: GameSetup, pilotId: PlayerId, copilotId: PlayerId, rand: Rand, at: number): GameState` — scenario from the setup, shuffled Intern tokens, round 1 rolled (with its Traffic dice; stamped `at` for Real-Time).
  - `applyIntent(game: GameState, command: GameCommand, playerId: PlayerId, rand: Rand, now: () => number): GameState` — one player action end to end, as the server performs it.
  - `mulberry32(seed: number): Rand`.

- [ ] **Step 1: Write the failing test** — create `scripts/test-bot.mjs`:

```js
// Bot and game-driving tests (pure, no server). Run via `npm test`.
import { newGame, applyIntent, randDice, shuffledInternTokens, settle, mulberry32, DEFAULT_SETUP } from "../packages/shared/src/index.ts";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "  ✅" : "  ❌"} ${label}`); if (!cond) failures++; };
const P = "P", C = "C";
const clock = () => 0;

console.log("1) Dealing and driving games from a random source");
{
  const g = newGame({ ...DEFAULT_SETUP, modules: ["intern"] }, P, C, mulberry32(1), 0);
  check("a new game is dealt and rolled", g.phase === "placement" && g.dice.pilot.length === 4 && g.internTokens.length === 6);
  check("same seed, same game", JSON.stringify(newGame(DEFAULT_SETUP, P, C, mulberry32(7), 0)) === JSON.stringify(newGame(DEFAULT_SETUP, P, C, mulberry32(7), 0)));
  check("Intern tokens are 1–6 once each", shuffledInternTokens(mulberry32(2)).slice().sort().join() === "1,2,3,4,5,6");
  const d = randDice(mulberry32(3));
  const rolls = Array.from({ length: 200 }, () => d.d6());
  check("random dice cover 1–6 and nothing else", new Set(rolls).size === 6 && rolls.every((v) => v >= 1 && v <= 6));
  const traffic = newGame({ scenarioId: "red-HND", modules: [], abilities: [] }, P, C, mulberry32(4), 0);
  const printed = traffic.scenario.approachTrack.reduce((a, sp) => a + sp.traffic, 0);
  check("a round on a Traffic-dice space rolls them (red-HND starts with 3)", traffic.phase === "placement" && traffic.airplanes.reduce((a, b) => a + b, 0) === printed + 3);
  const rt = newGame({ ...DEFAULT_SETUP, modules: ["realTime"] }, P, C, mulberry32(5), 1000);
  check("a Real-Time game's clock starts at the given time", rt.timerEndsAt !== null && rt.timerEndsAt > 1000);
  const placed = applyIntent(g, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, P, mulberry32(6), clock);
  check("applyIntent applies and settles", placed.axis.pilot !== null && placed.turn === "copilot");
  check("settle leaves a placement-ready game", settle(g, randDice(mulberry32(8)), clock).phase === "placement");
}

console.log(failures === 0 ? "\nALL BOT TESTS PASSED ✅" : `\n${failures} BOT TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
```

In root `package.json`, `test` becomes:
`"npm run build:shared && tsx scripts/test-rules.mjs && tsx scripts/test-units.mjs && tsx scripts/test-bot.mjs"`.

This relies on `red-HND`'s first space having `trafficDice: 3` in `APPROACH_TRACKS` (`packages/shared/src/game/catalog.ts`) and the 12-token supply not running out (red-HND prints 8 airplanes, so 3 more fit: 11 of 12).

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker.exe compose -f docker-compose.dev.yml exec -T client sh -c "npm test"`
Expected: FAIL — `does not provide an export named 'newGame'`.

- [ ] **Step 3: Implement.** Append to `packages/shared/src/game/entropy.ts` (add the imports it needs: `PlayerId` from `../protocol`, `INTERN_TOKEN_COUNT` from `./scenario`, `TRAFFIC_DIE_FACES` from `./abilities`, `scenarioForSetup`/`GameSetup` from `./catalog`, `createInitialGameState` from `./state`):

```ts
/** A source of randomness: a uniform integer in [0, n). The server passes
 *  crypto's randomInt; self-play and tests pass a seeded PRNG. */
export type Rand = (n: number) => number;

/** Dice whose values come from `rand`. */
export function randDice(rand: Rand): Dice {
  return {
    d6: () => (rand(6) + 1) as DieValue,
    traffic: () => TRAFFIC_DIE_FACES[rand(TRAFFIC_DIE_FACES.length)],
  };
}

/** The Intern tokens 1..6 in a random face-up order (Fisher–Yates). */
export function shuffledInternTokens(rand: Rand): DieValue[] {
  const t = Array.from({ length: INTERN_TOKEN_COUNT }, (_, i) => (i + 1) as DieValue);
  for (let i = t.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [t[i], t[j]] = [t[j], t[i]];
  }
  return t;
}

/** Deal a game for a lobby setup and roll round 1 (`at` stamps a Real-Time clock). */
export function newGame(setup: GameSetup, pilotId: PlayerId, copilotId: PlayerId, rand: Rand, at: number): GameState {
  const game = createInitialGameState(scenarioForSetup(setup), pilotId, copilotId, { internTokens: shuffledInternTokens(rand) });
  return reduce(game, roundRoll(game, randDice(rand), at), "").state;
}

/** One player action end to end, as the server performs it: add server values
 *  (rerolls), apply, then supply what the reducer asks for (Traffic dice, the
 *  next round's roll). Throws GameRuleError if the action is illegal. */
export function applyIntent(game: GameState, command: GameCommand, playerId: PlayerId, rand: Rand, now: () => number): GameState {
  const dice = randDice(rand);
  return settle(reduce(game, withEntropy(command, dice), playerId).state, dice, now);
}
```

If importing `./catalog` into `entropy.ts` creates a cycle the build rejects, move `newGame` into a new `packages/shared/src/game/deal.ts` that imports both, and export it from `index.ts`.

Create `packages/shared/src/bot/rng.ts`:

```ts
import type { Rand } from "../game/entropy";

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

Create `packages/shared/src/bot/index.ts` with `export * from "./rng";` and add `export * from "./bot";` to `packages/shared/src/index.ts`.

In `packages/server/src/socket.ts`:
- Replace the `serverDice` literal with `const rand: Rand = (n) => randomInt(0, n);` and `const serverDice = randDice(rand);`.
- In `onStart` and `onReset`, replace the two `createInitialGameState(...)` + `reduce(game, roundRoll(...))` lines with `room.game = newGame(room.setup, pilotId, copilotId, rand, Date.now());`.
- Delete the private `shuffledInternTokens`; drop the now-unused imports (`INTERN_TOKEN_COUNT`, `TRAFFIC_DIE_FACES`, `createInitialGameState`, `roundRoll`, `scenarioForSetup`, `DieValue`, `Dice` — keep any still used).
- Leave `onCommand` as it is: it must compute `withEntropy` *before* the Real-Time "too late" check, so it can't use `applyIntent`.

- [ ] **Step 4: Run tests and the end-to-end check**

Run: `docker.exe compose -f docker-compose.dev.yml exec -T client sh -c "npm run typecheck && npm test"` → `ALL BOT TESTS PASSED ✅`.
Then restart the server container (`docker.exe compose -f docker-compose.dev.yml restart server`) and run `scripts/validate.mjs` as its header describes → `ALL CHECKS PASSED`.

- [ ] **Step 5: Commit** — `"Deal and drive whole games from a random source (shared, seeded in tests)"`.

---

### Task 2: Legal moves

**Files:** Create `packages/shared/src/bot/moves.ts`, `packages/shared/src/bot/levels.ts`; modify `packages/shared/src/bot/index.ts`; Test: `scripts/test-bot.mjs` section 2.

**Interfaces:**
- Consumes: `reduce`, `GameRuleError`, `ReduceCommand` (reducer), `redactGameStateFor`, `GameCommand`, `PlacementTarget`, `newGame`, `applyIntent`, `mulberry32`.
- Produces: `legalMoves(view: GameState, crew: Crew): GameCommand[]` (wire commands, ready to send); `type BotLevel = "cadet" | "navigator" | "aviator"`; `BOT_LEVELS`, `BOT_LEVEL_LABELS`; `playerIdOf(view: GameState, crew: Crew): PlayerId`.

- [ ] **Step 1: Write the failing test** (insert before the summary line of `scripts/test-bot.mjs`)

```js
console.log("2) legalMoves from the bot's own (redacted) view");
{
  const { legalMoves, redactGameStateFor } = await import("../packages/shared/src/index.ts");
  const full = newGame({ ...DEFAULT_SETUP, modules: ["kerosene", "intern"], abilities: ["adaptation", "workingTogether"] }, P, C, mulberry32(11), 0);
  const view = redactGameStateFor(full, P);
  const moves = legalMoves(view, "pilot");
  check("there are moves on the Pilot's turn", moves.length > 0);
  check("every move is legal on the full state", moves.every((m) => { try { applyIntent(full, m, P, mulberry32(1), clock); return true; } catch { return false; } }));
  check("includes an Axis placement", moves.some((m) => m.type === "placeDie" && m.target.kind === "axis"));
  check("includes Adaptation and a Working Together offer", moves.some((m) => m.type === "adapt") && moves.some((m) => m.type === "swap"));
  check("wire commands only (no server values)", moves.every((m) => !("values" in m) && !("value" in m)));
  const nextToken = full.internTokens.find((t) => t !== null);
  const trainer = full.dice.pilot.find((d) => d.value !== nextToken);
  const holding = applyIntent(full, { type: "placeDie", dieId: trainer.id, target: { kind: "intern" } }, P, mulberry32(2), clock);
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

  for (const target of TARGETS) add({ type: "placeTraffic", target }); // Synchronisation: any colour
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

**Performance budget.** Each candidate is one `reduce` (a `structuredClone` of the state, ~10–30 µs). Own-side filtering keeps it to ~4 dice × ~25 spaces × (1 + 2·Coffee) ≈ 100–700 tries per decision → a few ms; a game is ~60 decisions ≈ 0.2–0.5 s. If it's too slow, add a cheap pre-filter for value-restricted spaces (Gear/Flaps/Brakes/Ice Brakes values, filled spaces) before calling `reduce` — the reducer still has the final say.

Add `export * from "./levels"; export * from "./moves";` to `bot/index.ts`.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"Add bot legal-move generation"`.

---

### Task 3: Actor, evaluator and the Navigator policy

**Files:** Create `packages/shared/src/bot/actor.ts`, `evaluate.ts`, `policy.ts`; modify `bot/index.ts`; Test: `scripts/test-bot.mjs` section 3.

**Interfaces:**
- Consumes: `legalMoves`, `playerIdOf`, `BotLevel`, `Rand`, `reduce`, `airportIndex`, `ICE_BRAKE_VALUES`.
- Produces:
  - `actorFor(game: GameState): Crew | null` — whose input the game waits on (`null` when over).
  - `evaluate(state: GameState, crew: Crew): number` — higher is better (co-operative: same for both seats; `crew` kept for later asymmetric terms). `WIN = 10_000`.
  - `chooseMove(view: GameState, crew: Crew, level: BotLevel, rand: Rand): GameCommand | null`.

- [ ] **Step 1: Write the failing test**

```js
console.log("3) actorFor, evaluate, chooseMove (Navigator)");
{
  const { actorFor, chooseMove, evaluate, redactGameStateFor, createInitialGameState, reduce, scenarioForSetup } = await import("../packages/shared/src/index.ts");
  const setup = (mods = [], abs = [], scenarioId = "YUL") => ({ scenarioId, modules: mods, abilities: abs });
  const fresh = (dp, dc, s = setup()) => reduce(createInitialGameState(scenarioForSetup(s), P, C), { type: "roll", pilot: dp, copilot: dc }, "").state;

  check("actor: turn by default", actorFor(fresh([1, 1, 1, 1], [1, 1, 1, 1])) === "pilot");
  const swap = reduce(fresh([1, 2, 3, 4], [6, 5, 4, 3], setup([], ["workingTogether"])), { type: "swap", dieId: 0 }, P).state;
  check("actor: the player who must answer a swap", actorFor(swap) === "copilot");
  check("actor: nobody once the game is over", actorFor({ ...fresh([1, 1, 1, 1], [1, 1, 1, 1]), outcome: { result: "won" }, phase: "won" }) === null);

  // Avoid a spin (YUL spins at ±3): the Co-Pilot's Axis is a 6; the Pilot holds 1, 5, 6, 6 → must not play the 1.
  let s = fresh([1, 5, 6, 6], [6, 1, 1, 1]);
  s.turn = "copilot";
  s = reduce(s, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, C).state;
  const m = chooseMove(redactGameStateFor(s, P), "pilot", "navigator", mulberry32(1));
  check("doesn't spin the plane", !(m.type === "placeDie" && m.target.kind === "axis" && s.dice.pilot[m.dieId].value === 1));

  const t = fresh([2, 1, 1, 1], [1, 1, 1, 1]);
  check("evaluate prefers fewer airplanes", evaluate({ ...t, airplanes: t.airplanes.map((a, i) => (i === 1 ? 0 : a)) }, "pilot") > evaluate(t, "pilot"));

  // Turns: on a space whose Turn forbids the current tilt the plane can't fly on.
  const turn = { ...t, scenario: { ...t.scenario, approachTrack: t.scenario.approachTrack.map((sp, i) => (i === 0 ? { ...sp, axisAllowed: [1, 0] } : sp)) } };
  check("evaluate penalises a tilt the Turn forbids", evaluate({ ...turn, axis: { ...turn.axis, offset: -1 } }, "pilot") < evaluate({ ...turn, axis: { ...turn.axis, offset: 1 } }, "pilot"));

  const n = reduce(fresh([2, 1, 1, 1], [1, 1, 1, 1], setup(["intern"])), { type: "placeDie", dieId: 0, target: { kind: "intern" } }, P).state;
  check("places a held Intern token", chooseMove(redactGameStateFor(n, P), "pilot", "navigator", mulberry32(2))?.type === "placeIntern");

  const over = { ...fresh([1, 1, 1, 1], [1, 1, 1, 1]), phase: "lost" };
  check("no legal move → null", chooseMove(over, "pilot", "navigator", mulberry32(3)) === null);
}
```

The Intern test trains with a 2: without options `createInitialGameState` lays the tokens out 1..6, so the next token is the 1.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

`actor.ts`:

```ts
import type { Crew } from "../game/scenario";
import type { GameState } from "../game/state";

const other = (c: Crew): Crew => (c === "pilot" ? "copilot" : "pilot");

/** Whose input the game is waiting on right now (null once it's over). Same
 *  precedence as the tutorial sandbox's `actingCrew`. */
export function actorFor(g: GameState): Crew | null {
  if (g.outcome || g.phase !== "placement") return null;
  if (g.pendingReroll) return g.pendingReroll;
  if (g.pendingSwap) return other(g.pendingSwap.from);
  if (g.internHeld) return g.internHeld.crew;
  if (g.trafficHeld) return "copilot";
  return g.turn;
}
```

`evaluate.ts` (weights are starting points; Phase 3 tunes them with the benchmark):

```ts
import { airportIndex, type GameState } from "../game/state";
import { ICE_BRAKE_VALUES, type Crew } from "../game/scenario";

export const WIN = 10_000;

/**
 * Heuristic value of a state for the crew (co-operative, so the same for both
 * seats). Terms: outcome; approach progress vs rounds left; traffic in the way;
 * tilt, and a tilt the current space's Turn forbids; switches still to deploy
 * vs rounds left; brakes; Kerosene and Intern pressure; small credit for
 * Coffee and Reroll tokens.
 */
export function evaluate(s: GameState, _crew: Crew): number {
  if (s.outcome) return s.outcome.result === "won" ? WIN : -WIN;
  const roundsLeft = s.scenario.rounds - s.round; // rounds still able to move (the final round can't)
  const remaining = airportIndex(s.scenario) - s.position;
  let v = 0;
  // Must cover `remaining` spaces in `roundsLeft` rounds, ≤2 per round.
  if (remaining > 2 * roundsLeft) v -= 3000;
  v -= Math.abs(remaining - roundsLeft) * 40;
  // Airplanes still on the path (each must be cleared before the plane leaves its space).
  s.airplanes.forEach((n, i) => { if (i >= s.position) v -= n * (i - s.position <= 2 ? 120 : 60); });
  // Tilt: 0 is level; ±spinAt is fatal (already an outcome); landing needs 0.
  v -= Math.abs(s.axis.offset) * (Math.abs(s.axis.offset) >= s.scenario.axisSpinAt - 1 ? 400 : 80);
  // Turns: flying off this space with a tilt it doesn't allow loses.
  const allowed = s.scenario.approachTrack[s.position]?.axisAllowed;
  if (allowed && !allowed.includes(s.axis.offset)) v -= 600;
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
import type { Rand } from "../game/entropy";
import { evaluate } from "./evaluate";
import type { BotLevel } from "./levels";
import { legalMoves, playerIdOf } from "./moves";

/** Score a move by the state it leads to. Random outcomes (rerolls) are scored
 *  with the dice unchanged — neutral, so Navigator never rerolls on purpose
 *  (Phase 3's search values them properly). */
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

Add `export * from "./actor"; export * from "./evaluate"; export * from "./policy";` to `bot/index.ts`.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `"Add the Navigator bot policy"`.

---

### Task 4: Self-play and the benchmark over every setup

**Files:** Create `packages/shared/src/bot/setups.ts`, `packages/shared/src/bot/selfplay.ts`, `scripts/bench.mjs`; modify `bot/index.ts`, root `package.json` (`"bench": "npm run build:shared && tsx scripts/bench.mjs"`), README "Tests"; Test: `scripts/test-bot.mjs` section 4.

**Interfaces:**
- Consumes: `newGame`, `applyIntent`, `actorFor`, `chooseMove`, `redactGameStateFor`, `mulberry32`, `SetSetupPayload`, `SCENARIO_TEMPLATES`, `IMPLEMENTED_MODULES`, `ABILITY_IDS`, `DEFAULT_MAX_ABILITIES`, `SCENARIOS`.
- Produces:
  - `cardSetups(): GameSetup[]` — each of the 21 cards with its printed modules (the implemented ones) and as many Special Abilities as its ★ allows, rotating through `ABILITY_IDS` card by card.
  - `representativeSetups(): GameSetup[]` — `cardSetups()` + every allowed YUL module combination + each ability alone and alongside the largest module combination.
  - `allSetups(): GameSetup[]` — every allowed YUL module combination × every allowed ability set, plus `cardSetups()`.
  - `selfPlay(setup: GameSetup, levels: Record<Crew, BotLevel>, seed: number, maxMoves?: number): { outcome: "won" | "lost" | "stuck"; reason: string; rounds: number; moves: number }`.

- [ ] **Step 1: Write the failing test**

```js
console.log("4) Self-play: every card, every module combination, every ability");
{
  const { selfPlay, representativeSetups, cardSetups, ABILITY_IDS } = await import("../packages/shared/src/index.ts");
  check("all 21 cards are covered", cardSetups().length === 21);
  const setups = representativeSetups();
  check("every ability is played", ABILITY_IDS.every((a) => setups.some((s) => s.abilities.includes(a))));
  const label = (s) => `${s.scenarioId}: ${[...s.modules, ...s.abilities].join("+") || "base"}`;
  const results = setups.map((s, i) => ({ s, r: selfPlay(s, { pilot: "navigator", copilot: "navigator" }, 1000 + i) }));
  const stuck = results.filter(({ r }) => r.outcome === "stuck");
  check(`${setups.length} setups each play to a finished game`, stuck.length === 0);
  stuck.slice(0, 5).forEach(({ s, r }) => console.log(`     ↳ stuck: ${label(s)} — ${r.reason}`));
  const a = selfPlay(setups[0], { pilot: "navigator", copilot: "navigator" }, 42);
  const b = selfPlay(setups[0], { pilot: "navigator", copilot: "navigator" }, 42);
  check("same seed, same game", JSON.stringify(a) === JSON.stringify(b));
}
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

`setups.ts`:

```ts
import { ABILITY_IDS, DEFAULT_MAX_ABILITIES } from "../game/abilities";
import { SCENARIOS, SCENARIO_TEMPLATES, type GameSetup } from "../game/catalog";
import { IMPLEMENTED_MODULES, type ModuleId } from "../game/scenario";
import { SetSetupPayload } from "../protocol";

const subsets = <T>(xs: readonly T[]): T[][] => xs.reduce<T[][]>((acc, x) => [...acc, ...acc.map((c) => [...c, x])], [[]]);
const valid = (s: GameSetup) => SetSetupPayload.safeParse(s).success;
/** YUL allows no Special Abilities, so ability setups fly a card that allows two (green-PRG). */
const ABILITY_BOARD = SCENARIO_TEMPLATES.find((t) => t.abilityCount === 2)!.id;

/** Every module combination the lobby accepts (exclusive groups respected). */
const moduleSets = (): ModuleId[][] => subsets(IMPLEMENTED_MODULES).filter((modules) => valid({ scenarioId: "YUL", modules, abilities: [] }));

/** Each card as printed: its implemented modules, and as many Special Abilities
 *  as its ★ allows, rotating through them card by card. */
export function cardSetups(): GameSetup[] {
  let next = 0;
  return SCENARIO_TEMPLATES.map((t) => {
    const abilities = Array.from({ length: t.abilityCount }, () => ABILITY_IDS[next++ % ABILITY_IDS.length]);
    return { scenarioId: t.id === "green-YUL" ? "YUL" : t.id, modules: t.modules.filter((m) => IMPLEMENTED_MODULES.includes(m)), abilities };
  });
}

/** Fast coverage: every card, every module combination, each ability alone and
 *  with the largest module combination. */
export function representativeSetups(): GameSetup[] {
  const sets = moduleSets();
  const richest = sets.reduce((m, c) => (c.length > m.length ? c : m), [] as ModuleId[]);
  return [
    ...cardSetups(),
    ...sets.map((modules) => ({ scenarioId: "YUL", modules, abilities: [] })),
    ...ABILITY_IDS.flatMap((a) => [
      { scenarioId: ABILITY_BOARD, modules: [], abilities: [a] },
      { scenarioId: ABILITY_BOARD, modules: richest, abilities: [a] },
    ]),
  ].filter(valid);
}

/** Every module combination × every ability set the lobby accepts, plus every
 *  card. Module-only setups fly YUL; ability setups fly ABILITY_BOARD. */
export function allSetups(): GameSetup[] {
  const max = SCENARIOS[ABILITY_BOARD].maxAbilities ?? DEFAULT_MAX_ABILITIES;
  const abilitySets = subsets(ABILITY_IDS).filter((a) => a.length > 0 && a.length <= max);
  return [
    ...cardSetups(),
    ...moduleSets().flatMap((modules) => [
      { scenarioId: "YUL", modules, abilities: [] },
      ...abilitySets.map((abilities) => ({ scenarioId: ABILITY_BOARD, modules, abilities })),
    ]),
  ].filter(valid);
}
```

`selfplay.ts`:

```ts
import type { GameSetup } from "../game/catalog";
import { applyIntent, newGame } from "../game/entropy";
import type { Crew } from "../game/scenario";
import { redactGameStateFor } from "../game/state";
import { actorFor } from "./actor";
import type { BotLevel } from "./levels";
import { chooseMove } from "./policy";
import { mulberry32 } from "./rng";

export interface SelfPlayResult { outcome: "won" | "lost" | "stuck"; reason: string; rounds: number; moves: number }

/** One full bot-vs-bot game: each seat decides from its own redacted view; the
 *  seeded random source supplies every roll exactly as the server would. The
 *  clock stands still, so Real-Time never runs out (the bot acts instantly). */
export function selfPlay(setup: GameSetup, levels: Record<Crew, BotLevel>, seed: number, maxMoves = 400): SelfPlayResult {
  const rand = mulberry32(seed);
  const now = () => 0;
  let g = newGame(setup, "P", "C", rand, now());
  let moves = 0;
  for (; moves < maxMoves; moves++) {
    const crew = actorFor(g);
    if (!crew) break;
    const id = crew === "pilot" ? "P" : "C";
    const move = chooseMove(redactGameStateFor(g, id), crew, levels[crew], rand);
    if (!move) return { outcome: "stuck", reason: `no legal move for the ${crew} (round ${g.round})`, rounds: g.round, moves };
    g = applyIntent(g, move, id, rand, now);
  }
  if (!g.outcome) return { outcome: "stuck", reason: `no outcome after ${moves} moves`, rounds: g.round, moves };
  return { outcome: g.outcome.result, reason: g.outcome.result === "lost" ? g.outcome.reason : "", rounds: g.round, moves };
}
```

(If Task 1 put `newGame` in `game/deal.ts`, import it from there.)

Add `export * from "./setups"; export * from "./selfplay";` to `bot/index.ts`.

`scripts/bench.mjs` — usage `npm run bench -- [games=30] [level=navigator] [ALL]`. Default: `representativeSetups()`; `ALL`: `allSetups()` (hundreds of setups — use a small game count). `ONLY="intern,kerosene"` (env) keeps setups containing all those ids (scenario id, module or ability). Prints one line per setup: win % · average round reached · top 3 loss reasons; then the overall win %.

```js
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
```

- [ ] **Step 4: Run** `npm test` → PASS (the self-play section should take well under a minute; if not, apply Task 2's pre-filter). Then `npm run bench -- 30` → a table. Record the overall win % in the commit message as the Phase-1 baseline.

- [ ] **Step 5:** README "Tests": document `npm run bench` (arguments, `ALL`, `ONLY`). **Commit** — `"Add bot self-play and win-rate benchmark (baseline: N%)"`.

---

## Self-review notes

- Covers: driving whole games from a seeded source on top of the existing `entropy.ts` (no second copy of the dice code), legal moves via the reducer (no duplicated rules), fair information (redacted view only), evaluator with Turns, policy, prompts (actor), deterministic self-play, a benchmark over every card, module combination and ability.
- Known Phase-1 limits, left to Phase 3 on purpose: Navigator never rerolls on purpose (rerolls score neutral), and self-play has no Real-Time time pressure.
- Names used by later phases: `BotLevel`/`BOT_LEVELS`/`BOT_LEVEL_LABELS`, `actorFor`, `chooseMove(view, crew, level, rand)`, `applyIntent(game, command, playerId, rand, now)`, `newGame(setup, pilotId, copilotId, rand, at)`, `Rand`, `randDice`, `mulberry32`, `selfPlay`, `evaluate`, `legalMoves`, `playerIdOf`, `representativeSetups`, `allSetups`, `cardSetups`. Plans 2 and 3 were written against the 2026-10-01 signatures (`newGame(..., rand)` and `applyIntent(..., rand)` without the clock arguments) and need the same update before they're executed.
