# Aviator per card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aviator lands every green card ≥ 60% and every yellow card ≥ 40% (at 600 ms a decision), by fixing turns / Traffic dice / clearing in the shared engine, deriving a flight plan from each board, and tuning per-card profiles where still needed.

**Architecture:** A new pure `bot/plan.ts` turns a board into a flight plan (target position per round, turn tilts, Traffic dice). The evaluator and rollout policy read it instead of assuming YUL's one-space-a-round pace and a level Axis. A new `bot/profiles.ts` merges per-card parameter overrides over the existing `POLICY_PARAMS` / `EVAL_WEIGHTS` defaults, keyed by a new `Scenario.cardId`.

**Tech Stack:** TypeScript (npm workspaces), tsx, plain `.mjs` test scripts (`check(label, cond)`), Docker `node:22-alpine` for every run.

**Spec:** `docs/superpowers/specs/2026-10-05-bot-card-profiles-design.md`

## Global Constraints

- Targets: **green ≥ 60%**, **yellow ≥ 40%**, YUL ≥ 75%, measured by `scripts/bench-cards.mjs` with `BUDGET_MS=600`, 80 seeds per setup, each card with its printed modules; ability cards over four random ability picks (`ABILITY_SEED=1`).
- Scope: the 13 green and yellow cards. Red/black untouched.
- At most **16 games at once** on this machine (`CONCURRENCY=16`); don't run tests alongside a benchmark.
- All Node runs in Docker: `docker run --rm -v "$PWD":/app -w /app node:22-alpine <cmd>` (plain `docker` works in this WSL; fall back to `docker.exe` with `wslpath -w` paths).
- The reducer stays pure and rule-only; nothing in `game/` learns about the bot except `Scenario.cardId` (data).
- Landing-count pins in `scripts/test-bot.mjs` change only with the measured new value written in the test label.

## Review Focus

1. **A scenario without `cardId`** (an old saved room, the tutorial's copy of YUL, a test's hand-built board) must still play with the defaults and its own track's plan — Task 1 tests `policyFor` on a board with no `cardId` and `flightPlan` on a hand-built track.
2. **A 2-space advance across two turn spaces with no common tilt** must be treated as fatal, not as "aim for 0" — Task 2 tests `turnTarget` returns null there and Task 4 tests the rollout won't plan that advance.
3. **The landing round** must keep aiming for a level Axis even if the airport space had a turn entry — Task 2 tests `turnTarget` returns null on the landing round.
4. **Sampled worlds clone the scenario** (`determinize` uses `structuredClone`): the plan cache must not key on object identity alone in a way that leaks or goes stale — Task 1 uses a `WeakMap` keyed by the scenario object (a clone simply recomputes; nothing stale).
5. **Benchmark results of different modes** (fixed samples vs time budget) must never mix in one results file — Task 6 tests the mode key.

---

### Task 1: `Scenario.cardId`, flight plan, profiles

**Files:**
- Modify: `packages/shared/src/game/scenario.ts` (Scenario interface; `YUL_MONTREAL`)
- Modify: `packages/shared/src/game/catalog.ts` (`SCENARIO_TEMPLATES` board)
- Create: `packages/shared/src/bot/plan.ts`
- Create: `packages/shared/src/bot/profiles.ts`
- Modify: `packages/shared/src/bot/index.ts` (exports)
- Test: `scripts/test-bot.mjs` (new section 15)

**Interfaces:**
- Produces:
  - `Scenario.cardId?: string`
  - `interface FlightPlan { airport: number; target: number[]; turn: (number[] | null)[]; trafficDice: number[] }`
  - `flightPlan(scenario: Scenario): FlightPlan` — `target[r]` for `r = 0 … rounds`, `target[0] = 0`, `target[r ≥ rounds − 1] = airport`
  - `planTarget(s: GameState): number` — `target[min(s.round, rounds − 1)]`
  - `turnTarget(s: GameState, advance: number): number | null`
  - `BOT_PROFILES: Record<string, BotProfile>`; `policyFor(s: GameState): typeof POLICY_PARAMS`; `weightsFor(s: GameState): typeof EVAL_WEIGHTS`

- [ ] **Step 1: Write the failing tests** (append before the final `console.log` in `scripts/test-bot.mjs`)

```js
console.log("15) Flight plan and card profiles");
{
  const { flightPlan, turnTarget, policyFor, weightsFor, BOT_PROFILES, POLICY_PARAMS, EVAL_WEIGHTS, SCENARIOS, scenarioForSetup } = await import("../packages/shared/src/index.ts");
  const yul = flightPlan(SCENARIOS.YUL);
  check("plan: YUL is one space a round", yul.airport === 6 && yul.target.slice(0, 8).join() === "0,1,2,3,4,5,6,6");
  const tgu = flightPlan(SCENARIOS["yellow-TGU"]);
  check("plan: a short track is front-loaded (TGU: 4 spaces over 6 moving rounds)", tgu.target.slice(0, 8).join() === "0,1,2,2,3,4,4,4");
  check("plan: turns and Traffic dice come from the track", tgu.turn[1] !== null && tgu.turn[0] === null && tgu.trafficDice[0] === 3);
  const custom = flightPlan({ ...SCENARIOS.YUL, cardId: undefined, approachTrack: [{ traffic: 0 }, { traffic: 0, axisAllowed: [1] }, { traffic: 0, airport: true }] });
  check("plan: a hand-built board without a card gets its own plan", custom.airport === 2 && custom.turn[1].join() === "1");
  check("cardId: every card's board carries it", SCENARIOS["yellow-TGU"].cardId === "yellow-TGU" && SCENARIOS.YUL.cardId === "green-YUL");
  // Profiles: no profile, or no cardId -> the defaults themselves; a profile overrides only its keys.
  const g = newGame(DEFAULT_SETUP, P, C, mulberry32(1), 0);
  check("profiles: no profile -> the defaults", policyFor(g) === POLICY_PARAMS && weightsFor(g) === EVAL_WEIGHTS);
  BOT_PROFILES["green-YUL"] = { policy: { paceWeight: 99 }, eval: { tilt: 1 } };
  const p = policyFor(g), w = weightsFor(g);
  check("profiles: a card's overrides win, the rest are defaults", p.paceWeight === 99 && p.spareSlack === POLICY_PARAMS.spareSlack && w.tilt === 1 && w.coffee === EVAL_WEIGHTS.coffee);
  const noCard = { ...g, scenario: { ...g.scenario, cardId: undefined } };
  check("profiles: a board without a cardId plays the defaults", policyFor(noCard) === POLICY_PARAMS);
  delete BOT_PROFILES["green-YUL"];
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker run --rm -v "$PWD":/app -w /app node:22-alpine sh -c "node_modules/.bin/tsx scripts/test-bot.mjs 2>&1 | sed -n '/^15)/,\$p'"`
Expected: crash/❌ — `flightPlan` is not exported.

- [ ] **Step 3: Add `cardId`**

In `scenario.ts`, in `interface Scenario` after `name: string;`:

```ts
  /** The scenario card this board is (e.g. "yellow-TGU"); the bot's per-card
   *  profile is keyed by it. Unset on hand-built boards and old saved rooms. */
  cardId?: string;
```

In `YUL_MONTREAL` after `name: "YUL Montréal-Trudeau",` add `cardId: "green-YUL",`.

In `catalog.ts` `SCENARIO_TEMPLATES`, inside the non-YUL board object after `name: …,` add `cardId: card.id,`.

- [ ] **Step 4: Create `packages/shared/src/bot/plan.ts`**

```ts
import type { Scenario } from "../game/scenario";
import { airportIndex, type GameState } from "../game/state";

/**
 * A board's flight plan, worked out from its data alone: where the plane
 * should be after each round's move, which tilts each turn allows, and where
 * Traffic dice are. The bot's pace and turn handling read it, so a card's
 * track — not YUL's one space a round — sets the pace.
 */
export interface FlightPlan {
  airport: number;
  /** target[r]: the position after round r's move (r = 0 … rounds); front-loaded. */
  target: number[];
  /** turn[i]: the tilts allowed for flying off space i, or null. */
  turn: (number[] | null)[];
  /** trafficDice[i]: Traffic dice icons on space i. */
  trafficDice: number[];
}

// Keyed by the scenario object: a sampled world (a structuredClone) simply
// works its plan out again — a handful of spaces, nothing to go stale.
const plans = new WeakMap<Scenario, FlightPlan>();

export function flightPlan(scenario: Scenario): FlightPlan {
  const known = plans.get(scenario);
  if (known) return known;
  const airport = airportIndex(scenario);
  const moving = Math.max(1, scenario.rounds - 1); // the last round lands, it doesn't move
  const target = Array.from({ length: scenario.rounds + 1 }, (_, r) => Math.min(airport, Math.ceil((airport * r) / moving)));
  const plan: FlightPlan = {
    airport,
    target,
    turn: scenario.approachTrack.map((sp) => (sp.axisAllowed?.length ? sp.axisAllowed : null)),
    trafficDice: scenario.approachTrack.map((sp) => sp.trafficDice ?? 0),
  };
  plans.set(scenario, plan);
  return plan;
}

/** Where the plan wants the plane after this round's move. */
export function planTarget(s: GameState): number {
  const plan = flightPlan(s.scenario);
  return plan.target[Math.min(s.round, s.scenario.rounds - 1)] ?? plan.airport;
}

/**
 * The tilt to aim the Axis at when the plane flies `advance` spaces this round:
 * of the tilts every turn space it leaves allows, the one nearest the current
 * tilt. Null when no turn is in the way, on the landing round (land level), or
 * when the turns have no tilt in common (that advance can't be flown).
 */
export function turnTarget(s: GameState, advance: number): number | null {
  if (advance <= 0 || s.round >= s.scenario.rounds) return null;
  const plan = flightPlan(s.scenario);
  let allowed: number[] | null = null;
  for (let step = 0; step < advance; step++) {
    const t = plan.turn[s.position + step];
    if (t) allowed = allowed ? allowed.filter((x) => t.includes(x)) : [...t];
  }
  if (!allowed || allowed.length === 0) return null;
  const off = s.axis.offset;
  return allowed.reduce((best, x) => (Math.abs(x - off) < Math.abs(best - off) ? x : best));
}

/** True when flying `advance` spaces this round can't satisfy the turns on the way. */
export function turnBlocks(s: GameState, advance: number): boolean {
  const plan = flightPlan(s.scenario);
  let any = false;
  for (let step = 0; step < advance; step++) if (plan.turn[s.position + step]) any = true;
  if (!any) return false;
  if (s.axis.pilot !== null && s.axis.copilot !== null) {
    // The tilt is final: every turn flown off must allow it.
    for (let step = 0; step < advance; step++) {
      const t = plan.turn[s.position + step];
      if (t && !t.includes(s.axis.offset)) return true;
    }
    return false;
  }
  return turnTarget(s, advance) === null; // no tilt satisfies them all
}
```

- [ ] **Step 5: Create `packages/shared/src/bot/profiles.ts`**

```ts
import type { GameState } from "../game/state";
import { EVAL_WEIGHTS } from "./evaluate";
import { POLICY_PARAMS } from "./rollout";

/** A card's overrides of the bot's defaults (only the keys that differ). */
export interface BotProfile {
  policy?: Partial<typeof POLICY_PARAMS>;
  eval?: Partial<typeof EVAL_WEIGHTS>;
}

/**
 * Per-card tuning, keyed by `Scenario.cardId`. A card with no entry — or a
 * board with no cardId (old rooms, hand-built boards) — plays the defaults.
 * Entries come from `CARD=<id> npm run tune` and are kept only once
 * bench-cards at 600 ms confirms them.
 */
export const BOT_PROFILES: Record<string, BotProfile> = {};

/** The rollout policy's settings for this game: the defaults, with the card's overrides. */
export function policyFor(s: GameState): typeof POLICY_PARAMS {
  const p = s.scenario.cardId ? BOT_PROFILES[s.scenario.cardId]?.policy : undefined;
  return p ? { ...POLICY_PARAMS, ...p } : POLICY_PARAMS;
}

/** The evaluator's weights for this game: the defaults, with the card's overrides. */
export function weightsFor(s: GameState): typeof EVAL_WEIGHTS {
  const w = s.scenario.cardId ? BOT_PROFILES[s.scenario.cardId]?.eval : undefined;
  return w ? { ...EVAL_WEIGHTS, ...w } : EVAL_WEIGHTS;
}
```

In `bot/index.ts` add `export * from "./plan";` and `export * from "./profiles";`.

- [ ] **Step 6: Run the tests** — same command as Step 2. Expected: every check in section 15 ✅. Then `npm run typecheck` in Docker: no errors.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "Bot: flight plan from the board, per-card profiles, Scenario.cardId"`

---

### Task 2: Evaluator — plan-based pace, Traffic dice, turns

**Files:**
- Modify: `packages/shared/src/bot/evaluate.ts`
- Test: `scripts/test-bot.mjs` (section 15)

**Interfaces:**
- Consumes: `flightPlan`, `planTarget`, `turnTarget`, `turnBlocks` (Task 1), `weightsFor` (Task 1).
- Produces: new `EVAL_WEIGHTS` keys `paceAhead` (10), `trafficDiceWait` (60), `turnPrep` (100); `paceBehind` replaces the hard-coded 40.

- [ ] **Step 1: Write the failing tests** (in section 15, before its closing `}`)

```js
  const { evaluate, createInitialGameState, reduce } = await import("../packages/shared/src/index.ts");
  const at = (id, dp, dc, extra = {}) => ({ ...reduce(createInitialGameState(scenarioForSetup({ scenarioId: id, modules: [], abilities: [] }), P, C), { type: "roll", pilot: dp, copilot: dc, traffic: Array(flightPlan(SCENARIOS[id]).trafficDice[0]).fill(5) }, "").state, ...extra });
  // TGU round 3, both Engines down (moved): the plan wants space 2.
  const moved = { engines: { pilot: 3, copilot: 3 }, airplanes: Array(5).fill(0) };
  check("pace: ahead of the plan costs less than behind it", evaluate(at("yellow-TGU", [1, 1, 1, 1], [1, 1, 1, 1], { ...moved, round: 3, position: 3 }), "pilot") > evaluate(at("yellow-TGU", [1, 1, 1, 1], [1, 1, 1, 1], { ...moved, round: 3, position: 1 }), "pilot"));
  check("pace: waiting on Traffic dice past the plan costs extra", evaluate(at("yellow-TGU", [1, 1, 1, 1], [1, 1, 1, 1], { ...moved, round: 2, position: 0 }), "pilot") < evaluate(at("yellow-TGU", [1, 1, 1, 1], [1, 1, 1, 1], { ...moved, round: 2, position: 1 }), "pilot") - 60);
  // TGU space 1 allows tilts [2, 1] (catalog) — a plane tilted 1 there isn't penalised like one tilted 1 on a plain space.
  const tilted = (pos) => at("yellow-TGU", [1, 1, 1, 1], [1, 1, 1, 1], { round: 2, position: pos, axis: { pilot: null, copilot: null, offset: 1 }, airplanes: Array(5).fill(0) });
  const level = (pos) => at("yellow-TGU", [1, 1, 1, 1], [1, 1, 1, 1], { round: 2, position: pos, axis: { pilot: null, copilot: null, offset: 0 }, airplanes: Array(5).fill(0) });
  check("turns: on a turn space, the tilt it needs beats level", evaluate(tilted(1), "pilot") > evaluate(level(1), "pilot"));
  check("turns: off a turn space, level still beats a tilt", evaluate(level(0), "pilot") > evaluate(tilted(0), "pilot"));
  check("turnTarget: none on the landing round", turnTarget({ ...tilted(1), round: 7 }, 1) === null);
  check("turnTarget: a 2-space advance over turns with no common tilt can't be flown", turnTarget({ ...tilted(0), scenario: { ...SCENARIOS.YUL, approachTrack: [{ traffic: 0, axisAllowed: [1] }, { traffic: 0, axisAllowed: [-1] }, { traffic: 0, airport: true }] } }, 2) === null);
```

Check `catalog.ts` for yellow-TGU's turns before running: the test assumes space 1 allows `[2, 1]` or `[1, 0]`-style lists containing 1 and not 0; adjust the tilt in `tilted` to a value in `SCENARIOS["yellow-TGU"].approachTrack[1].axisAllowed` that isn't 0 if it differs.

- [ ] **Step 2: Run to verify the new checks fail** (pace/turn ones ❌; turnTarget ones already ✅ from Task 1).

- [ ] **Step 3: Implement in `evaluate.ts`**

1. Imports: `import { flightPlan, planTarget, turnTarget } from "./plan";` and `import { weightsFor } from "./profiles";`. (`profiles.ts` imports `EVAL_WEIGHTS` from here — a cycle; both are only read at call time, so it's safe. If tsx complains, move `weightsFor` into `evaluate.ts` and re-export it from `profiles.ts`.)
2. `EVAL_WEIGHTS` gains:
```ts
  /** Per space behind / ahead of the flight plan after this round's move. */
  paceBehind: 40,
  paceAhead: 10,
  /** Per Traffic dice icon on a space the plan says the plane should have left. */
  trafficDiceWait: 60,
  /** Per pip the Axis is likely to miss the tilt a coming turn needs. */
  turnPrep: 100,
```
3. In `evaluate`, `const W = weightsFor(s);` (instead of `EVAL_WEIGHTS`), and pass `W` to `paceRisk`.
4. Replace the tilt line
```ts
  v -= Math.abs(s.axis.offset) * (Math.abs(s.axis.offset) >= s.scenario.axisSpinAt - 1 ? W.tiltDanger : W.tilt);
```
with
```ts
  // Tilt: level is the goal, except before flying off a turn, where it's the
  // tilt the turn allows. One pip from a spin is dangerous unless that's the goal.
  const tiltGoal = s.phase === "placement" && !moved ? turnTarget(s, 1) : null;
  v -= Math.abs(s.axis.offset - (tiltGoal ?? 0)) * W.tilt;
  if (Math.abs(s.axis.offset) >= s.scenario.axisSpinAt - 1 && s.axis.offset !== tiltGoal) v -= Math.abs(s.axis.offset) * (W.tiltDanger - W.tilt);
  if (tiltGoal !== null) v -= turnPrepRisk(s, crew, tiltGoal) * W.turnPrep;
```
5. Add, next to `axisRisk`:
```ts
/** Pips the Axis is expected to end off `goal` this round (0 once it's final). */
function turnPrepRisk(s: GameState, crew: Crew, goal: number): number {
  const other: Crew = crew === "pilot" ? "copilot" : "pilot";
  const mine = s.axis[crew], theirs = s.axis[other];
  if (mine !== null && theirs !== null) return 0;
  const faces = [1, 2, 3, 4, 5, 6];
  const off = (m: number, t: number) => Math.abs(tiltWith(s, crew, m, t) - goal);
  if (mine === null) {
    const values = reachableValues(s, crew);
    if (!values.length) return 0;
    return Math.min(...values.map((v) => (theirs !== null ? off(v, theirs) : faces.reduce((a, f) => a + off(v, f), 0) / 6)));
  }
  return faces.reduce((a, f) => a + off(mine, f), 0) / 6;
}
```
6. Replace `paceCost` and its uses: `paceRisk(s, crew, remaining, roundsLeft, moved, W)`:
```ts
/** Pace against the flight plan once the plane is at `pos` after this round's move. */
function paceCost(s: GameState, pos: number, roundsLeftAfter: number, W: typeof EVAL_WEIGHTS): number {
  const plan = flightPlan(s.scenario);
  const remaining = plan.airport - pos;
  const gap = planTarget(s) - pos;
  let cost = (remaining > 2 * roundsLeftAfter ? 3000 : 0) + Math.max(0, gap) * W.paceBehind + Math.max(0, -gap) * W.paceAhead;
  if (gap > 0) cost += (plan.trafficDice[pos] ?? 0) * W.trafficDiceWait;
  return cost;
}
```
In `paceRisk`: `paceCost(remaining, roundsLeft)` → `paceCost(s, s.position, roundsLeft, W)`; inside `afterMove`, `paceCost(remaining - adv, after)` → `paceCost(s, s.position + adv, after, W)`. Leave everything else in `paceRisk` (collision/overshoot/turn → 5000) as is.

- [ ] **Step 4: Run section 15 and the whole bot suite.** Expected: section 15 ✅. Earlier sections: if a pace/tilt test in sections 1–8 fails, read its comment — fix only if it encoded YUL's symmetric pace (then update the test to the plan-based meaning and say so in its label); landing-count pins in section 13 may move: re-measure and pin the new value with "(was N)" in the label.

- [ ] **Step 5: Commit** — `git commit -am "Evaluator: pace from the flight plan, Traffic dice waits, turn tilts"`

---

### Task 3: Rollout policy — turns, plan pace, clearing under pressure

**Files:**
- Modify: `packages/shared/src/bot/rollout.ts` (`POLICY_PARAMS`, `fastMove`)
- Test: `scripts/test-bot.mjs` (section 15)

**Interfaces:**
- Consumes: `planTarget`, `turnTarget`, `turnBlocks`, `flightPlan` (Task 1), `policyFor` (Task 1).
- Produces: `POLICY_PARAMS` keys `clearAheadMax` (2), `trafficPressure` (1.5).

- [ ] **Step 1: Write the failing tests** (section 15)

```js
  const { fastMove, rolloutGame, applyIntentInPlace } = await import("../packages/shared/src/index.ts");
  // Answer the partner's Axis die on a turn space: TGU space 1 needs a tilt it allows (not 0).
  const allowed1 = SCENARIOS["yellow-TGU"].approachTrack[1].axisAllowed;
  let ts = at("yellow-TGU", [1, 2, 3, 4], [3, 6, 6, 6], { round: 2, position: 1, airplanes: Array(5).fill(0), turn: "copilot" });
  ts = reduce(ts, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, C).state;
  const am = fastMove({ ...ts, coffee: 0 }, "pilot", mulberry32(4));
  const tiltAfter = am.target.kind === "axis" ? ts.axis.offset + (ts.dice.pilot[am.dieId].value - 3) : null;
  check(`rollout: on a turn space the Axis answer makes an allowed tilt (${allowed1})`, tiltAfter !== null && allowed1.includes(tiltAfter));
  // Whole rollouts on TGU: was 37 of 40 "Missed the turn".
  const tguGames = Array.from({ length: 40 }, (_, i) => rolloutGame(newGame({ scenarioId: "yellow-TGU", modules: ["kerosene"], abilities: [] }, P, C, mulberry32(i), 0), mulberry32(100000 + i)));
  const missed = tguGames.filter((g) => /^Missed the turn/.test(g.outcome?.reason ?? "")).length;
  check(`rollout: TGU rarely misses a turn (${missed} of 40; was 37)`, missed <= 8);
```

The Axis check assumes the pilot holds a die that yields an allowed tilt (dice 1–4 against the Co-Pilot's 3 give tilt −2…+1 from offset 0); if `allowed1` has no value in that range, change the Pilot's dice so one does.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement in `rollout.ts`**

1. Imports: `import { flightPlan, planTarget, turnBlocks, turnTarget } from "./plan";` and `import { policyFor } from "./profiles";` (same cycle note as Task 2).
2. `POLICY_PARAMS` gains:
```ts
  /** Spare dice clear airplanes up to this many spaces ahead… */
  clearAheadMax: 2,
  /** …or up to 5 ahead (a 6 on the Radio) while the traffic left is more than
   *  this many airplanes per round still to place dice in. */
  trafficPressure: 1.5,
```
3. In `fastMove`, `const P = policyFor(s);` instead of `POLICY_PARAMS`.
4. Replace the `want` line with:
```ts
  // Pace: the flight plan's target for this round, but never slower than the
  // rounds left allow.
  const planGap = landing ? 0 : planTarget(s) - s.position;
  const want = Math.max(0, Math.min(2, remaining, Math.max(planGap, Math.ceil(remaining / (roundsAfter + 1)))));
  // The tilt to aim for: what the turns flown off this round allow, else level.
  const tiltGoal = landing ? 0 : turnTarget(s, want) ?? 0;
```
(it must sit before `axisByValue` is computed; `axisCost` reads `tiltGoal` when called.)
5. `axisCost`: replace each `Math.abs(tiltWith(v, …))` with `Math.abs(tiltWith(v, …) - tiltGoal)`.
6. `crashes(adv)`: after the loop, before `return false`, add `if (adv > 0 && turnBlocks(s, adv)) return true;`.
7. Clearing: replace `clearAirplanes(2, 2);` with
```ts
  const ahead = s.airplanes.slice(s.position, airportIndex(s.scenario) + 1).reduce((a, n) => a + n, 0);
  clearAirplanes(2, ahead > P.trafficPressure * roundsToPlace ? 5 : P.clearAheadMax);
```

- [ ] **Step 4: Run section 15, then the whole suite** (`npm test`). Same pin policy as Task 2 Step 4.

- [ ] **Step 5: Commit** — `git commit -am "Rollouts: aim the Axis at the turn, pace from the flight plan, clear further under traffic pressure"`

---

### Task 4: Search guard for impossible turns

**Files:**
- Modify: `packages/shared/src/bot/search.ts` (nothing if Task 3's `crashes` covers it — verify)
- Test: `scripts/test-bot.mjs` (section 15)

- [ ] **Step 1: Test** — a 2-space advance across turns with no common tilt is never what the rollout policy plans:

```js
  const twoTurns = { ...SCENARIOS.YUL, cardId: undefined, approachTrack: [{ traffic: 0, axisAllowed: [1] }, { traffic: 0, axisAllowed: [-1] }, { traffic: 0 }, { traffic: 0 }, { traffic: 0, airport: true }] };
  let tt = reduce(createInitialGameState(twoTurns, P, C), { type: "roll", pilot: [6, 6, 1, 1], copilot: [6, 6, 1, 1] }, "").state;
  tt = { ...tt, axis: { pilot: 4, copilot: 3, offset: 1 }, turn: "copilot" };
  tt = reduce(tt, { type: "placeDie", dieId: 0, target: { kind: "engine" } }, C).state; // Co-Pilot's 6 on the Engine
  const em = fastMove(tt, "pilot", mulberry32(5));
  const speed = em.target.kind === "engine" ? 6 + tt.dice.pilot[em.dieId].value : null;
  check("rollout: never plans a 2-space advance over turns with no common tilt", speed === null || speed <= tt.aeroOrange);
```

- [ ] **Step 2: Run.** If ✅ (Task 3 covered it), commit the test only. If ❌, fix `crashes` so `turnBlocks(s, adv)` is consulted for every `adv`, then re-run.

- [ ] **Step 3: Commit** — `git commit -am "Test: no 2-space advance over turns without a common tilt"`

---

### Task 5: Tuner per card

**Files:**
- Modify: `scripts/tune.mjs`

- [ ] **Step 1: Implement `CARD=<id>`**

At the top, after the imports, add `SCENARIO_TEMPLATES, ABILITY_IDS, BOT_PROFILES` to the import list and:

```js
// CARD=yellow-TGU (env): tune on that card with its printed modules (ability
// cards rotate through the abilities), and print the result as its profile.
const CARD = process.env.CARD;
const card = CARD && SCENARIO_TEMPLATES.find((t) => t.id === CARD);
if (CARD && !card) throw new Error(`no card ${CARD}`);
if (card) delete BOT_PROFILES[card.id]; // tune from the defaults, not an older profile
const setupFor = (i) => card
  ? { scenarioId: card.id === "green-YUL" ? "YUL" : card.id, modules: [...card.modules], abilities: Array.from({ length: card.abilityCount }, (_, k) => ABILITY_IDS[(i + k) % ABILITY_IDS.length]) }
  : { scenarioId: "YUL", modules: [], abilities: [] };
const DEFAULTS = { ...TARGET };
```

In `landings(from)`, use `setupFor(i)` for both branches: `selfPlay(setupFor(i), i, 400, { strategy: "quick" })` and `rolloutGame(newGame(setupFor(i), "P", "C", mulberry32(i), 0), mulberry32(100000 + i))`. Add `clearAheadMax: [1, 2, 3, 5]` and `trafficPressure: [1, 1.5, 2, 3]` to `POLICY_CANDIDATES`. At the end, print:

```js
if (card) {
  const diff = Object.fromEntries(Object.entries(TARGET).filter(([k, v]) => DEFAULTS[k] !== v));
  console.log(`\nBOT_PROFILES["${card.id}"] = { ${EVAL ? "eval" : "policy"}: ${JSON.stringify(diff)} };`);
}
```

- [ ] **Step 2: Smoke run** — `docker run … -e CARD=yellow-TGU node:22-alpine node_modules/.bin/tsx scripts/tune.mjs 20 1` prints progress and a profile line. (If two ability ids collide for an ability card, `SetSetupPayload` would reject in `newGame`? — it doesn't validate; distinct ids are guaranteed since k < 6.)

- [ ] **Step 3: Commit** — `git commit -am "Tuner: CARD=<id> tunes one card and prints its profile"`

---

### Task 6: Benchmark at a time budget

**Files:**
- Modify: `scripts/bench-cards.mjs`

- [ ] **Step 1: Implement `BUDGET_MS`**

- `const BUDGET_MS = Number(env.BUDGET_MS) || undefined;` and `const MODE = BUDGET_MS ? \`${BUDGET_MS}ms\` : \`${SAMPLES}samples\`;`
- Worker gets `{ setup, seed, samples, budgetMs }` and calls `selfPlay(setup, seed, 400, { ...(budgetMs ? { budgetMs } : { samples }), onMove })`.
- Each result line gets `mode: MODE`; reading old lines, `const modeOf = (r) => r.mode ?? \`${r.samples}samples\`;` — "done" and `summary` keep only `modeOf(r) === MODE`.
- Header line prints the mode instead of "at N samples". Document `BUDGET_MS` in the header comment and the README paragraph.

- [ ] **Step 2: Smoke** — `GAMES=1 BUDGET_MS=50 CARDS=green-YUL OUT=/s/smoke2.jsonl` runs one game; then the same with `SAMPLES=5` (no budget) appends a second line with a different mode and the summary of each shows only its own.

- [ ] **Step 3: Commit** — `git commit -am "bench-cards: BUDGET_MS plays at a time budget, as live"`

---

### Task 7: Measure, tune the cards still below the mark

- [ ] **Step 1: Quick check before the long run** — rollout-only landing rates per card (the `trace.mjs` probe, 40 games each) to catch a regression in minutes, compared against the pre-change trace (YUL 5/40; TGU 0/40 with 37 missed turns).
- [ ] **Step 2: Full measurement** — `BUDGET_MS=600 OUT=sim-output/bench-cards-600.jsonl node_modules/.bin/tsx scripts/bench-cards.mjs > sim-output/bench-cards-600.log` in a detached container (`docker run -d --name bench-cards …`), 16 at once, ~2 h. Compare per card against the targets.
- [ ] **Step 3: For each card below its mark**, in order of the gap: `CARD=<id> npm run tune -- 200 2` (rollouts), then `… eval` (evaluator); put the printed entries into `BOT_PROFILES` in `profiles.ts`; re-measure that card with `CARDS=<id> BUDGET_MS=600 GAMES=80`; keep the profile only if the card's rate rises.
- [ ] **Step 4: A card still below its mark after tuning** gets a card rule (like `icePlan`): diagnose with the trace probe what its losses have in common, write the rule in `search.ts` next to `icePlan`, wired through the card's profile, with a test; re-measure.
- [ ] **Step 5: Final** — full 600 ms run over all 13 cards; README: replace the stale YUL landing-rate paragraph with the per-card table; commit; report to the user which cards meet the mark and which don't.
