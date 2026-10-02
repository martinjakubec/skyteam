# Module & Special Ability Tutorials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the lobby, an ⓘ next to every module and Special Ability opens a modal with a rules description and a guided, interactive tutorial played on the real (trimmed) cockpit.

**Architecture:** The server's dice-value code moves to a shared `entropy.ts` parameterised by a random source. A client-side sandbox applies real `GameCommand`s through the shared reducer with scripted dice and plays both crews. Tutorials are data files (setup, steps, solutions); the real `Cockpit` gains an optional `show` prop that renders only the listed sections.

**Tech Stack:** TypeScript, React 18, zustand, Vite; shared pure reducer (`@skyteam/shared`); tests are plain `tsx` scripts (`scripts/test-units.mjs`, `scripts/test-rules.mjs`) with a `check()` helper; browser checks with Playwright in Docker.

**Spec:** `docs/superpowers/specs/2026-10-02-module-tutorials-design.md`

## Global Constraints

- No local Node: run everything in the dev client container from the repo root:
  `docker.exe compose -f docker-compose.dev.yml exec -T client sh -c "cd /app && <cmd>"`
  (`npm test` = build shared + `test-rules.mjs` + `test-units.mjs`; `npm run typecheck`).
- Real games must behave exactly as before: `Cockpit` without `show` renders everything; the server's command handling is unchanged apart from calling shared helpers.
- Tutorials are purely local: nothing is emitted on the socket.
- Tutorial seat ids are `"tutorial-pilot"` / `"tutorial-copilot"`.
- Copy: player-facing text uses "Pilot", "Co-Pilot", "Engine(s)", "Axis", "Coffee", "Reroll token", "Traffic die" as in the rest of the UI.
- Match the surrounding code: comment density, naming, 2-space indent, double quotes.

## Review Focus

1. **A rejected move inside a tutorial** (e.g. dropping on a space the reducer refuses) — expect the step bar to show the reducer's message and the state unchanged, never a crash. Pinned in Task 2 (`apply` throws `GameRuleError`, state untouched) and Task 5 (hook catches).
2. **Closing and reopening a tutorial mid-step, or pressing Reset** — expect a fresh start (step 1, initial state, scripted dice from the beginning, Real-Time timer cleared). Pinned in Task 5 (Reset rebuilds everything from `tutorial`; the Real-Time effect clears its timeout on unmount).
3. **Real-Time timer firing after the modal closed** — expect nothing to happen. Pinned in Task 5 (effect cleanup).
4. **Dragging a die while the modal is open** — the drag overlay (`.drag-die`, z-index 1000) must render above the modal (z-index 900). Pinned in Task 5 CSS and Task 7 browser check.
5. **Lobby re-renders while the modal is open** (the other player changes the setup) — the open tutorial must not reset. Pinned in Task 6 (modal state keyed only by the tutorial id, which the lobby holds in `useState`).

---

### Task 1: Shared entropy (move the server's dice-value code to shared)

**Files:**
- Create: `packages/shared/src/game/entropy.ts`
- Modify: `packages/shared/src/index.ts` (export it)
- Modify: `packages/server/src/socket.ts` (use it; delete `rollHand`, `roundRoll`, `settle` bodies there)
- Test: `scripts/test-units.mjs`

**Interfaces:**
- Produces:
  - `interface Dice { d6(): DieValue; traffic(): DieValue }`
  - `withEntropy(command: GameCommand, dice: Dice): ReduceCommand`
  - `roundRoll(game: GameState, dice: Dice, at: number): ReduceCommand`
  - `settle(game: GameState, dice: Dice, now: () => number): GameState`

- [ ] **Step 1: Write the failing test** — in `scripts/test-units.mjs`, add `roundRoll, settle, withEntropy` to the import from `../packages/shared/src/index.ts`, then add before `// 3) CORS origin check`:

```js
console.log("2f) entropy: the server's dice values come from a pluggable source");
{
  const queue = (vals) => () => vals.shift();
  const dice = { d6: queue([1, 2, 3, 4, 5, 6, 1, 2, 6]), traffic: queue([4]) };
  const r = withEntropy({ type: "reroll", dieIds: [0, 2] }, dice);
  check("a reroll gets one value per die", r.type === "reroll" && r.values.join() === "1,2");
  const a = withEntropy({ type: "anticipate", dieId: 1 }, dice);
  check("Anticipation gets a value", a.type === "anticipate" && a.value === 3);
  const p = { type: "placeDie", dieId: 0, target: { kind: "radio", slot: 0 } };
  check("other commands pass through unchanged", withEntropy(p, dice) === p);
  const game = createInitialGameState({ ...YUL_MONTREAL, approachTrack: [{ traffic: 0, trafficDice: 1 }, { traffic: 0, airport: true }] }, "P", "C");
  const roll = roundRoll(game, { d6: () => 6, traffic: () => 5 }, 42);
  check("roundRoll: two hands, one Traffic roll per icon, the clock", roll.pilot.join() === "6,6,6,6" && roll.copilot.length === 4 && roll.traffic.join() === "5" && roll.at === 42);
  const settled = settle(game, { d6: () => 3, traffic: () => 2 }, () => 7);
  check("settle rolls the pending round", settled.phase === "placement" && settled.dice.pilot.every((d) => d.value === 3) && settled.airplanes[1] === 1);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `docker.exe compose -f docker-compose.dev.yml exec -T client sh -c "cd /app && npm test 2>&1 | tail -5"`
Expected: FAIL — `withEntropy` is not exported (SyntaxError / undefined import).

- [ ] **Step 3: Implement** — create `packages/shared/src/game/entropy.ts`:

```ts
import type { GameCommand } from "../protocol";
import { reduce, type ReduceCommand } from "./reducer";
import { DICE_PER_PLAYER, type DieValue } from "./scenario";
import type { GameState } from "./state";

/**
 * Where dice values come from. The reducer is pure, so whoever drives it — the
 * server (secure random numbers) or a tutorial (scripted values) — supplies
 * every roll through one of these.
 */
export interface Dice {
  /** A six-sided die. */
  d6(): DieValue;
  /** A Traffic die face (2, 3, 3, 4, 4, 5). */
  traffic(): DieValue;
}

/** A player's command as the reducer takes it: a reroll and Anticipation are
 *  intents, so their new values are added here. */
export function withEntropy(command: GameCommand, dice: Dice): ReduceCommand {
  if (command.type === "reroll") return { type: "reroll", dieIds: command.dieIds, values: command.dieIds.map(() => dice.d6()) };
  if (command.type === "anticipate") return { type: "anticipate", dieId: command.dieId, value: dice.d6() };
  return command;
}

/** A round's roll: both hands, plus one Traffic die roll per Traffic icon on
 *  the Current Position — stamped with the clock for Real-Time. */
export function roundRoll(game: GameState, dice: Dice, at: number): ReduceCommand {
  const hand = () => Array.from({ length: DICE_PER_PLAYER }, () => dice.d6());
  const trafficDice = game.scenario.approachTrack[game.position]?.trafficDice ?? 0;
  return { type: "roll", pilot: hand(), copilot: hand(), traffic: Array.from({ length: trafficDice }, () => dice.traffic()), at };
}

/**
 * Supply what the reducer asked for after a command: Traffic die rolls
 * (Synchronisation) and, once a round has ended, the next round's dice.
 */
export function settle(game: GameState, dice: Dice, now: () => number): GameState {
  while (game.trafficPending && !game.outcome) game = reduce(game, { type: "rollTraffic", value: dice.traffic() }, "").state;
  while (game.phase === "rolling" && !game.outcome) game = reduce(game, roundRoll(game, dice, now()), "").state;
  return game;
}
```

Add to `packages/shared/src/index.ts` next to the other `./game/*` exports:

```ts
export * from "./game/entropy";
```

In `packages/server/src/socket.ts`:
1. Add `roundRoll, settle, withEntropy, type Dice` to the `@skyteam/shared` import; remove `DICE_PER_PLAYER` from it if now unused.
2. Replace the `rollHand` and `roundRoll` functions with:

```ts
/** Server-owned entropy for every roll. */
const serverDice: Dice = {
  d6: () => randomInt(1, 7) as DieValue,
  traffic: () => TRAFFIC_DIE_FACES[randomInt(0, TRAFFIC_DIE_FACES.length)],
};
```
3. Replace every `roundRoll(game)` call (game start, reset) with `roundRoll(game, serverDice, Date.now())`.
4. In `onCommand`, replace the `rcmd` ternary with `const rcmd = withEntropy(command, serverDice);` (keep the comment above it).
5. Replace the local `settle(game)` function with a one-line wrapper so call sites stay unchanged:

```ts
/** Supply what the reducer asked the server for (see shared `settle`). */
function settleNow(game: GameState): GameState {
  return settle(game, serverDice, Date.now);
}
```
and rename the call sites `settle(` → `settleNow(` (in `onCommand` and `onTimeUp`).

- [ ] **Step 4: Run tests and typecheck**

Run: `docker.exe compose -f docker-compose.dev.yml exec -T client sh -c "cd /app && npm run typecheck && npm test 2>&1 | grep -E '2f\)|❌|PASSED|FAILED'"`
Expected: typecheck clean; `2f)` checks ✅; `ALL RULE TESTS PASSED`, `ALL UNIT TESTS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/game/entropy.ts packages/shared/src/index.ts packages/server/src/socket.ts scripts/test-units.mjs
git commit -m "Move the server's dice-value code to shared entropy helpers"
```

---

### Task 2: Tutorial engine (types, moves, sandbox core)

**Files:**
- Create: `packages/client/src/tutorials/types.ts`
- Create: `packages/client/src/tutorials/engine.ts`
- Test: `scripts/test-units.mjs`

**Interfaces:**
- Consumes: `Dice`, `withEntropy`, `settle` (Task 1).
- Produces (all from `engine.ts` unless noted):
  - `types.ts`: `CockpitSection`, `Move`, `Step`, `Tutorial` (below).
  - `PILOT_ID = "tutorial-pilot"`, `COPILOT_ID = "tutorial-copilot"`
  - `scriptedDice(script?: Tutorial["script"]): Dice`
  - `actingCrew(s: GameState): Crew`
  - `apply(s: GameState, move: Move, dice: Dice, now?: () => number): GameState` — throws `GameRuleError` on an illegal move
  - `start(o: StartOptions): GameState`
  - move builders `place`, `placeIntern`, `placeTraffic`, `swap`, `adapt`, `anticipate`, `timeUp`; targets `axis`, `engine`, `radio`, `conc`

- [ ] **Step 1: Write `types.ts`** (types only, nothing to test):

```ts
import type { AbilityId, Crew, DieValue, GameCommand, GameState, ModuleId } from "@skyteam/shared";

/** Cockpit sections a tutorial can show (the dice tray is always shown). */
export type CockpitSection =
  | "tracks" | "axis" | "engines" | "brakes" | "radio" | "gear" | "flaps" | "concentration"
  | "kerosene" | "wind" | "intern" | "iceBrakes" | "realTime" | "abilities";

/** One player action in a tutorial, resolved against the state it's played on
 *  (dice are named by value, so the die's id is looked up then). "timeUp" ends
 *  a Real-Time round as if the clock ran out. */
export type Move = (s: GameState) => { crew: Crew; command: GameCommand } | "timeUp";

export interface Step {
  /** What to do, or what just happened. */
  text: string;
  /** A note with nothing to do: shown until the player presses Next. */
  info?: boolean;
  /** Moves the sandbox plays itself when the step starts (dice the lesson doesn't need). */
  auto?: Move[];
  /** True once the step is complete; `before` is the state when it started (after `auto`). */
  done(state: GameState, before: GameState): boolean;
  /** The moves that complete it — used by the tests. */
  solution: Move[];
}

export interface Tutorial {
  id: ModuleId | AbilityId;
  title: string;
  description: string;
  show: CockpitSection[];
  setup(): GameState;
  /** Values the scripted dice hand out, in order; random once used up. */
  script?: { d6?: DieValue[]; traffic?: DieValue[] };
  steps: Step[];
}
```

- [ ] **Step 2: Write the failing test** — in `scripts/test-units.mjs` add the import
`import * as tut from "../packages/client/src/tutorials/engine.ts";` and before `// 3) CORS origin check`:

```js
console.log("2g) tutorial engine: both crews, scripted dice, real rules");
{
  let s = tut.start({ pilot: [3, 4, 6, 6], copilot: [3, 4, 6, 6] });
  check("starts in placement with the given hands", s.phase === "placement" && s.dice.pilot.map((d) => d.value).join() === "3,4,6,6");
  check("the Pilot acts first in round 1", tut.actingCrew(s) === "pilot");
  const dice = tut.scriptedDice({ d6: [5] });
  s = tut.apply(s, tut.place("pilot", 3, tut.axis("pilot")), dice);
  check("a move is played through the reducer", s.axis.pilot === 3 && tut.actingCrew(s) === "copilot");
  const before = s;
  let threw = false;
  try { tut.apply(s, tut.place("copilot", 3, tut.engine("pilot")), dice); } catch { threw = true; }
  check("an illegal move throws and leaves the state alone", threw && before.engines.pilot === null);
  check("scripted dice hand out their values, then random 1–6", dice.d6() === 5 && [1, 2, 3, 4, 5, 6].includes(dice.d6()));
  const sw = tut.start({ abilities: ["workingTogether"], pilot: [1, 3, 6, 6], copilot: [5, 3, 6, 6] });
  const offered = tut.apply(sw, tut.swap("pilot", 1), dice);
  check("the other crew answers a swap", tut.actingCrew(offered) === "copilot");
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `docker.exe compose -f docker-compose.dev.yml exec -T client sh -c "cd /app && npm test 2>&1 | tail -5"`
Expected: FAIL — cannot find module `tutorials/engine.ts`.

- [ ] **Step 4: Implement `engine.ts`**:

```ts
import {
  TRAFFIC_DIE_FACES,
  YUL_MONTREAL,
  createInitialGameState,
  reduce,
  settle,
  withEntropy,
  type AbilityId,
  type Crew,
  type Dice,
  type DieValue,
  type GameState,
  type ModuleId,
  type PlacementTarget,
} from "@skyteam/shared";
import type { Move, Tutorial } from "./types";

export const PILOT_ID = "tutorial-pilot";
export const COPILOT_ID = "tutorial-copilot";
const idOf = (crew: Crew) => (crew === "pilot" ? PILOT_ID : COPILOT_ID);

/** Dice that hand out a tutorial's scripted values in order, then random ones. */
export function scriptedDice(script: Tutorial["script"] = {}): Dice {
  const d6 = [...(script.d6 ?? [])];
  const traffic = [...(script.traffic ?? [])];
  return {
    d6: () => d6.shift() ?? ((1 + Math.floor(Math.random() * 6)) as DieValue),
    traffic: () => traffic.shift() ?? TRAFFIC_DIE_FACES[Math.floor(Math.random() * TRAFFIC_DIE_FACES.length)],
  };
}

/** Who must act now — the tutorial player plays both crews, as this one. */
export function actingCrew(s: GameState): Crew {
  if (s.pendingReroll) return s.pendingReroll;
  if (s.pendingSwap) return s.pendingSwap.from === "pilot" ? "copilot" : "pilot";
  if (s.internHeld) return s.internHeld.crew;
  if (s.trafficHeld) return "copilot";
  return s.turn;
}

/** Play one move through the real rules (throws GameRuleError if illegal). */
export function apply(s: GameState, move: Move, dice: Dice, now: () => number = Date.now): GameState {
  const m = move(s);
  if (m === "timeUp") return settle(reduce(s, { type: "timeUp" }, "").state, dice, now);
  return settle(reduce(s, withEntropy(m.command, dice), idOf(m.crew)).state, dice, now);
}

/** A short, traffic-free track so tutorial moves never collide or overshoot. */
const TRACK = [{ traffic: 0 }, { traffic: 0 }, { traffic: 0 }, { traffic: 0 }, { traffic: 0, airport: true }];

export interface StartOptions {
  modules?: ModuleId[];
  abilities?: AbilityId[];
  /** Round 1's hands. */
  pilot: DieValue[];
  copilot: DieValue[];
  /** Moves played before the tutorial starts (dice the lesson doesn't need). */
  moves?: Move[];
  /** Last adjustments, e.g. a spent Reroll token. */
  tweak?: (s: GameState) => void;
}

/** A tutorial's starting position: round 1 rolled with fixed hands. */
export function start(o: StartOptions): GameState {
  const scenario = { ...YUL_MONTREAL, name: "Tutorial", approachTrack: TRACK, modules: o.modules ?? [], abilities: o.abilities ?? [], maxAbilities: 2 };
  let s = createInitialGameState(scenario, PILOT_ID, COPILOT_ID, { internTokens: [3, 1, 5, 6, 2, 4] });
  s = reduce(s, { type: "roll", pilot: o.pilot, copilot: o.copilot, at: Date.now() }, "").state;
  const dice = scriptedDice();
  for (const m of o.moves ?? []) s = apply(s, m, dice);
  o.tweak?.(s);
  return s;
}

// --- Move builders -----------------------------------------------------------

function dieOf(s: GameState, crew: Crew, value: number): number {
  const die = s.dice[crew].find((d) => !d.placed && d.value === value);
  if (!die) throw new Error(`Tutorial script: no unplaced ${value} for the ${crew}.`);
  return die.id;
}

export const place = (crew: Crew, value: number, target: PlacementTarget, coffeeDelta?: number): Move => (s) => ({
  crew,
  command: { type: "placeDie", dieId: dieOf(s, crew, value), target, ...(coffeeDelta ? { coffeeDelta } : {}) },
});
export const placeIntern = (crew: Crew, target: PlacementTarget): Move => () => ({ crew, command: { type: "placeIntern", target } });
export const placeTraffic = (target: PlacementTarget): Move => () => ({ crew: "copilot", command: { type: "placeTraffic", target } });
export const swap = (crew: Crew, value: number): Move => (s) => ({ crew, command: { type: "swap", dieId: dieOf(s, crew, value) } });
export const adapt = (crew: Crew, value: number): Move => (s) => ({ crew, command: { type: "adapt", dieId: dieOf(s, crew, value) } });
export const anticipate = (crew: Crew, value: number): Move => (s) => ({ crew, command: { type: "anticipate", dieId: dieOf(s, crew, value) } });
export const timeUp: Move = () => "timeUp";

export const axis = (side: Crew): PlacementTarget => ({ kind: "axis", side });
export const engine = (side: Crew): PlacementTarget => ({ kind: "engine", side });
export const radio = (side: Crew, slot = 0): PlacementTarget => ({ kind: "radio", slot, side });
export const conc = (slot: number): PlacementTarget => ({ kind: "concentration", slot });
```

If `PlacementTarget` isn't exported from `@skyteam/shared`'s index, import it from where `protocol.ts` exports it (it is: `export * from "./protocol"`).

- [ ] **Step 5: Run tests and typecheck**

Run: `docker.exe compose -f docker-compose.dev.yml exec -T client sh -c "cd /app && npm run typecheck && npm test 2>&1 | grep -E '2g\)|❌|PASSED|FAILED'"`
Expected: `2g)` checks ✅, both suites PASSED.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/tutorials/types.ts packages/client/src/tutorials/engine.ts scripts/test-units.mjs
git commit -m "Add the tutorial sandbox engine: both crews, scripted dice, real rules"
```

---

### Task 3: Tutorial content (12 tutorials) + content tests

**Files:**
- Create: `packages/client/src/tutorials/{kerosene,keroseneLeak,intern,wind,iceBrakes,realTime,workingTogether,synchronisation,mastery,control,anticipation,adaptation}.ts`
- Create: `packages/client/src/tutorials/index.ts`
- Test: `scripts/test-units.mjs`

All dice sequences below were validated against the reducer while writing this plan.

**Interfaces:**
- Consumes: Task 2 exports.
- Produces: `TUTORIALS: Record<ModuleId | AbilityId, Tutorial>` from `tutorials/index.ts`.

- [ ] **Step 1: Write the failing test** — add `import { TUTORIALS } from "../packages/client/src/tutorials/index.ts";` and, before `// 3) CORS origin check`:

```js
console.log("2h) every tutorial plays out under the current rules");
{
  check("a tutorial for every module and ability", [...MODULE_IDS, ...ABILITY_IDS].every((id) => TUTORIALS[id]?.id === id));
  for (const t of Object.values(TUTORIALS)) {
    let s = t.setup();
    const dice = tut.scriptedDice(t.script);
    const failures = [];
    for (const [i, step] of t.steps.entries()) {
      try {
        for (const m of step.auto ?? []) s = tut.apply(s, m, dice);
        const before = s;
        if (step.info) continue;
        if (step.done(s, before)) failures.push(`step ${i + 1} done before its moves`);
        for (const m of step.solution) s = tut.apply(s, m, dice);
        if (!step.done(s, before)) failures.push(`step ${i + 1} not done after its moves`);
      } catch (e) {
        failures.push(`step ${i + 1}: ${e.message}`);
        break;
      }
    }
    check(`${t.title}: ${t.steps.length} steps play out${failures.length ? ` — ${failures.join("; ")}` : ""}`, failures.length === 0);
  }
}
```

- [ ] **Step 2: Run it to verify it fails** — `npm test` → FAIL: cannot find `tutorials/index.ts`.

- [ ] **Step 3: Write the tutorials.** Each file has this header (adjust the imported builders to those used):

```ts
import { axis, conc, engine, place, radio, start } from "./engine";
import type { Tutorial } from "./types";
```

`kerosene.ts`:
```ts
export const kerosene: Tutorial = {
  id: "kerosene",
  title: "Kerosene",
  description:
    "The plane starts with 20 Kerosene. A die placed on the Kerosene space burns its value straight away. A round that ends with the space empty burns 6. Reaching 0 loses the game.",
  show: ["axis", "engines", "radio", "concentration", "kerosene"],
  setup: () =>
    start({
      modules: ["kerosene"],
      pilot: [3, 2, 5, 6],
      copilot: [3, 4, 6, 6],
      moves: [place("pilot", 3, axis("pilot")), place("copilot", 3, axis("copilot")), place("pilot", 6, radio("pilot")), place("copilot", 6, radio("copilot", 0))],
    }),
  script: { d6: [3, 2, 6, 6, 3, 2, 6, 6] },
  steps: [
    {
      text: "Pilot: drag your 2 onto the Kerosene space — it burns 2 right away.",
      solution: [place("pilot", 2, { kind: "kerosene" })],
      done: (s, b) => s.kerosene === b.kerosene - 2,
    },
    {
      text: "Finish the round: the Co-Pilot's 4 and the Pilot's 5 on the Engines, then the Co-Pilot's 6 on a Radio space.",
      solution: [place("copilot", 4, engine("copilot")), place("pilot", 5, engine("pilot")), place("copilot", 6, radio("copilot", 1))],
      done: (s) => s.round === 2,
    },
    {
      text: "Round 2 — the other dice are already down. Leave the Kerosene space empty and set the Engines (Co-Pilot 2, then Pilot 2): the round ends and burns 6.",
      auto: [
        place("copilot", 3, axis("copilot")), place("pilot", 3, axis("pilot")),
        place("copilot", 6, radio("copilot", 0)), place("pilot", 6, radio("pilot")),
        place("copilot", 6, radio("copilot", 1)), place("pilot", 6, conc(0)),
      ],
      solution: [place("copilot", 2, engine("copilot")), place("pilot", 2, engine("pilot"))],
      done: (s, b) => s.round === 3 && s.kerosene === b.kerosene - 6,
    },
  ],
};
```

`keroseneLeak.ts`:
```ts
export const keroseneLeak: Tutorial = {
  id: "keroseneLeak",
  title: "Kerosene Leak",
  description:
    "Replaces Kerosene: there is no Kerosene space. The moment both Engine dice are down, the tank leaks their difference + 1 — every round. Reaching 0 loses the game.",
  show: ["engines", "kerosene"],
  setup: () =>
    start({
      modules: ["keroseneLeak"],
      pilot: [3, 5, 6, 6],
      copilot: [3, 3, 6, 6],
      moves: [
        place("pilot", 3, axis("pilot")), place("copilot", 3, axis("copilot")),
        place("pilot", 6, radio("pilot")), place("copilot", 6, radio("copilot", 0)),
        place("pilot", 6, conc(0)), place("copilot", 6, radio("copilot", 1)),
      ],
    }),
  script: { d6: [3, 4, 6, 6, 3, 4, 6, 6] },
  steps: [
    { text: "Pilot: put your 5 on the Engine.", solution: [place("pilot", 5, engine("pilot"))], done: (s) => s.engines.pilot === 5 },
    {
      text: "Co-Pilot: put your 3 on the Engine. The leak burns |5 − 3| + 1 = 3.",
      solution: [place("copilot", 3, engine("copilot"))],
      done: (s, b) => s.kerosene === b.kerosene - 3,
    },
    {
      text: "Round 2: matching Engine dice leak the least. Put both 4s on the Engines (Co-Pilot first) — it burns only 1.",
      auto: [
        place("copilot", 3, axis("copilot")), place("pilot", 3, axis("pilot")),
        place("copilot", 6, radio("copilot", 0)), place("pilot", 6, radio("pilot")),
        place("copilot", 6, radio("copilot", 1)), place("pilot", 6, conc(0)),
      ],
      solution: [place("copilot", 4, engine("copilot")), place("pilot", 4, engine("pilot"))],
      done: (s, b) => s.kerosene === b.kerosene - 1,
    },
  ],
};
```

`intern.ts` (imports `axis, place, placeIntern, start`):
```ts
export const intern: Tutorial = {
  id: "intern",
  title: "Intern",
  description:
    "Six Intern tokens lie face up. Once per round each crew may train: put a die whose value differs from your next token (the Pilot takes from the left, the Co-Pilot from the right) on your training space, take that token and place it at once like a die of its number — not on Concentration, and without Coffee. Any token left at landing loses the game.",
  show: ["intern", "axis", "engines", "radio"],
  setup: () => start({ modules: ["intern"], pilot: [2, 4, 5, 6], copilot: [3, 4, 6, 6] }),
  steps: [
    {
      text: "Pilot: your next token is the 3. Drag your 2 onto the Pilot's training space to take it.",
      solution: [place("pilot", 2, { kind: "intern", side: "pilot" })],
      done: (s) => s.internHeld?.crew === "pilot",
    },
    {
      text: "Place the 3 token at once — drop it on the Pilot's Axis space.",
      solution: [placeIntern("pilot", axis("pilot"))],
      done: (s) => s.internHeld === null && s.axis.pilot === 3,
    },
    { text: "Every token must be trained before landing, or the game is lost.", info: true, solution: [], done: () => true },
  ],
};
```

`wind.ts` (imports `axis, engine, place, start`):
```ts
export const wind: Tutorial = {
  id: "wind",
  title: "Wind",
  description:
    "A ring of wind speeds surrounds a blue airplane. After each Axis, the airplane turns one space per pip the plane is tilted — left when tilted toward the Pilot, right toward the Co-Pilot. The wind it points at is added to the Engine total.",
  show: ["axis", "engines", "wind"],
  setup: () => start({ modules: ["wind"], pilot: [5, 4, 6, 6], copilot: [3, 4, 6, 6] }),
  steps: [
    {
      text: "Tilt the plane 2 toward the Pilot: the Pilot's 5 and the Co-Pilot's 3 on the Axis. The airplane turns 2 spaces left, to +2.",
      solution: [place("pilot", 5, axis("pilot")), place("copilot", 3, axis("copilot"))],
      done: (s) => s.windPosition === 18,
    },
    {
      text: "Now a 4 each on the Engines: the speed is 4 + 4 + 2 wind = 10.",
      solution: [place("pilot", 4, engine("pilot")), place("copilot", 4, engine("copilot"))],
      done: (s) => s.lastSpeed === 10,
    },
  ],
};
```

`iceBrakes.ts` (imports `place, start`):
```ts
export const iceBrakes: Tutorial = {
  id: "iceBrakes",
  title: "Ice Brakes",
  description:
    "Replaces the Brakes with four steps — 2, 3, 4, 5 — in order. Each step has a Pilot-only top space and a bottom space for either crew; when both hold the step's value in the same round, the marker passes it. All four must be passed to land.",
  show: ["iceBrakes"],
  setup: () => start({ modules: ["iceBrakes"], pilot: [2, 3, 6, 6], copilot: [2, 3, 6, 6] }),
  steps: [
    {
      text: "Pilot: put your 2 on step 2's top space (Pilot only).",
      solution: [place("pilot", 2, { kind: "iceBrakes", slot: 0, space: "top" })],
      done: (s) => s.iceBrakeSlots[0].top === 2,
    },
    {
      text: "Co-Pilot: put your 2 on step 2's bottom space. Both are set, so the marker passes 2 and step 3 opens.",
      solution: [place("copilot", 2, { kind: "iceBrakes", slot: 0, space: "bottom" })],
      done: (s) => s.brakesDeployed === 1,
    },
    { text: "You can only land once the marker has passed all four steps.", info: true, solution: [], done: () => true },
  ],
};
```

`realTime.ts` (imports `axis, engine, place, start, timeUp`):
```ts
export const realTime: Tutorial = {
  id: "realTime",
  title: "Real Time",
  description:
    "Each round has 60 seconds from the roll. When time runs out the round ends with whatever is placed — if the Axis or an Engine is still empty, the game is lost. The clock pauses while a player is disconnected.",
  show: ["realTime", "axis", "engines"],
  setup: () => start({ modules: ["realTime"], pilot: [3, 4, 6, 6], copilot: [3, 4, 6, 6] }),
  script: { d6: [3, 4, 6, 6, 3, 4, 6, 6] },
  steps: [
    {
      text: "The clock is running: put the 3s on the Axis and the 4s on the Engines.",
      solution: [place("pilot", 3, axis("pilot")), place("copilot", 3, axis("copilot")), place("pilot", 4, engine("pilot")), place("copilot", 4, engine("copilot"))],
      done: (s) => s.engines.pilot !== null && s.engines.copilot !== null,
    },
    { text: "Press “Skip to time's up”: the round ends with the 6s still in hand.", solution: [timeUp], done: (s) => s.round === 2 },
    {
      text: "Round 2: press “Skip to time's up” again before the Axis and Engines are set — the game is lost.",
      solution: [timeUp],
      done: (s) => s.phase === "lost",
    },
  ],
};
```

`workingTogether.ts` (imports `start, swap`):
```ts
export const workingTogether: Tutorial = {
  id: "workingTogether",
  title: "Working Together",
  description:
    "Once per round, the active player may put a die on this card; the other player must answer with one of theirs. The two dice swap values and go back to their owners' hands.",
  show: ["abilities", "axis", "engines"],
  setup: () => start({ abilities: ["workingTogether"], pilot: [1, 3, 6, 6], copilot: [5, 3, 6, 6] }),
  steps: [
    { text: "Pilot (your turn): press “Swap a die” on Working Together, then tap your 1.", solution: [swap("pilot", 1)], done: (s) => s.pendingSwap !== null },
    {
      text: "Co-Pilot: tap your 5 to answer. The values swap — the Pilot now holds a 5, the Co-Pilot a 1.",
      solution: [swap("copilot", 5)],
      done: (s) => s.pendingSwap === null && s.dice.pilot.some((d) => d.value === 5) && s.dice.copilot.some((d) => d.value === 1),
    },
  ],
};
```

`synchronisation.ts` (imports `engine, place, placeTraffic, start`):
```ts
export const synchronisation: Tutorial = {
  id: "synchronisation",
  title: "Synchronisation",
  description:
    "As soon as a die is on the Landing Gear and one on the Flaps in the same round, the Traffic die (2–5) is rolled. The Co-Pilot places it on any empty space — either colour — as an extra action.",
  show: ["gear", "flaps", "axis", "engines", "abilities"],
  setup: () => start({ abilities: ["synchronisation"], pilot: [1, 3, 4, 6], copilot: [1, 3, 4, 6] }),
  script: { traffic: [4] },
  steps: [
    { text: "Pilot: put your 1 on the first Landing Gear space.", solution: [place("pilot", 1, { kind: "landingGear", slot: 0 })], done: (s) => s.gearSlots[0] === 1 },
    {
      text: "Co-Pilot: put your 1 on the first Flaps space — Gear and Flaps both have a die, so the Traffic die is rolled: a 4.",
      solution: [place("copilot", 1, { kind: "flaps", slot: 0 })],
      done: (s) => s.trafficHeld?.value === 4,
    },
    {
      text: "Co-Pilot: place the Traffic die on any empty space, even a Pilot's — drop it on the Pilot's Engine.",
      solution: [placeTraffic(engine("pilot"))],
      done: (s) => s.trafficHeld === null && s.engines.pilot === 4,
    },
  ],
};
```

`mastery.ts` (imports `engine, place, start`):
```ts
export const mastery: Tutorial = {
  id: "mastery",
  title: "Mastery",
  description: "When both Engine dice show the same value, regain a spent Reroll token.",
  show: ["engines"],
  setup: () =>
    start({ abilities: ["mastery"], pilot: [4, 3, 6, 6], copilot: [4, 3, 6, 6], tweak: (s) => { s.rerollTokens = 0; s.rerollSpent = 1; } }),
  steps: [
    { text: "Your Reroll token is spent (see the tray). Pilot: put your 4 on the Engine.", solution: [place("pilot", 4, engine("pilot"))], done: (s) => s.engines.pilot === 4 },
    { text: "Co-Pilot: put your 4 on the Engine too — matching Engine dice win the Reroll token back.", solution: [place("copilot", 4, engine("copilot"))], done: (s) => s.rerollTokens === 1 },
  ],
};
```

`control.ts` (imports `axis, engine, place, start`):
```ts
export const control: Tutorial = {
  id: "control",
  title: "Control",
  description:
    "When both Axis dice show the same value, gain a Coffee token (up to 3). Each Coffee shifts a die's value by 1 when you place it.",
  show: ["axis", "engines", "concentration"],
  setup: () => start({ abilities: ["control"], pilot: [3, 2, 6, 6], copilot: [3, 4, 6, 6] }),
  steps: [
    { text: "Pilot: put your 3 on the Axis.", solution: [place("pilot", 3, axis("pilot"))], done: (s) => s.axis.pilot === 3 },
    { text: "Co-Pilot: put your 3 on the Axis — matching Axis dice earn a Coffee.", solution: [place("copilot", 3, axis("copilot"))], done: (s) => s.coffee === 1 },
    {
      text: "Pilot: spend it — tap your 2, press +1, then drag it onto the Engine as a 3.",
      solution: [place("pilot", 2, engine("pilot"), 1)],
      done: (s) => s.engines.pilot === 3 && s.coffee === 0,
    },
  ],
};
```

`anticipation.ts` (imports `anticipate, start`):
```ts
export const anticipation: Tutorial = {
  id: "anticipation",
  title: "Anticipation",
  description: "Each round, before placing their first die, the First Player may reroll one of their dice.",
  show: ["abilities", "axis", "engines"],
  setup: () => start({ abilities: ["anticipation"], pilot: [1, 3, 6, 6], copilot: [3, 4, 6, 6] }),
  script: { d6: [5] },
  steps: [
    {
      text: "Pilot (first player this round): press “Reroll a die” on Anticipation, then tap your 1 — it comes up a 5.",
      solution: [anticipate("pilot", 1)],
      done: (s) => s.anticipated && s.dice.pilot.some((d) => d.value === 5),
    },
    { text: "Only before the First Player's first die, once per round.", info: true, solution: [], done: () => true },
  ],
};
```

`adaptation.ts` (imports `adapt, start`):
```ts
export const adaptation: Tutorial = {
  id: "adaptation",
  title: "Adaptation",
  description: "Once per game, each player may turn one unplaced die to its opposite face (1↔6, 2↔5, 3↔4) — on either player's turn.",
  show: ["abilities", "axis", "engines"],
  setup: () => start({ abilities: ["adaptation"], pilot: [1, 3, 6, 6], copilot: [3, 4, 6, 6] }),
  steps: [
    {
      text: "Pilot: press “Flip a die” on Adaptation, then tap your 1 — it turns over to a 6.",
      solution: [adapt("pilot", 1)],
      done: (s) => s.adaptationUsed.pilot && s.dice.pilot.filter((d) => d.value === 6).length === 3,
    },
    { text: "The Co-Pilot has a flip of their own — once per game each, usable on either player's turn.", info: true, solution: [], done: () => true },
  ],
};
```

`index.ts`:
```ts
import type { AbilityId, ModuleId } from "@skyteam/shared";
import { adaptation } from "./adaptation";
import { anticipation } from "./anticipation";
import { control } from "./control";
import { iceBrakes } from "./iceBrakes";
import { intern } from "./intern";
import { kerosene } from "./kerosene";
import { keroseneLeak } from "./keroseneLeak";
import { mastery } from "./mastery";
import { realTime } from "./realTime";
import { synchronisation } from "./synchronisation";
import type { Tutorial } from "./types";
import { wind } from "./wind";
import { workingTogether } from "./workingTogether";

/** One interactive tutorial per module and Special Ability (opened from the lobby's ⓘ). */
export const TUTORIALS: Record<ModuleId | AbilityId, Tutorial> = {
  kerosene, keroseneLeak, intern, wind, iceBrakes, realTime,
  workingTogether, synchronisation, mastery, control, anticipation, adaptation,
};
```

- [ ] **Step 4: Run tests and typecheck** — expected: 13 `2h)` checks ✅ (coverage + 12 tutorials), both suites PASSED, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/tutorials scripts/test-units.mjs
git commit -m "Add the 12 module and Special Ability tutorial scripts"
```

---

### Task 4: Cockpit `show` and `clockOffset` props

**Files:**
- Modify: `packages/client/src/components/Cockpit.tsx`

**Interfaces:**
- Consumes: `CockpitSection` (Task 2).
- Produces: `Cockpit({ snapshot, onCommand, show?: CockpitSection[], clockOffset?: number })`.

- [ ] **Step 1: Add the props.** Change the signature:

```tsx
export function Cockpit({
  snapshot,
  onCommand,
  show,
  clockOffset: clockOffsetOverride,
}: {
  snapshot: RoomSnapshot;
  onCommand: (command: GameCommand) => void;
  /** Tutorials: draw only these sections (the dice tray always shows). Unset = everything. */
  show?: CockpitSection[];
  /** Tutorials run on the local clock: pass 0 instead of the server offset. */
  clockOffset?: number;
}) {
  const vis = (section: CockpitSection) => !show || show.includes(section);
```
Import `import type { CockpitSection } from "../tutorials/types";`.
Replace `const clockOffset = useGame((s) => s.clockOffset);` with
`const serverOffset = useGame((s) => s.clockOffset);` and `const clockOffset = clockOffsetOverride ?? serverOffset;`.

- [ ] **Step 2: Gate each section** (wrap existing JSX; don't change it otherwise):
  - `<section className="tracks">` → render when `vis("tracks") || (realTimeOn && vis("realTime"))`; inside, `{vis("tracks") && <Approach … />}`, `{vis("tracks") && <Altitude … />}`, `{realTimeOn && vis("realTime") && <RealTime … />}`.
  - `.axis-cluster` → `{vis("axis") && (…)}`.
  - `<SpeedGauge … />` and `.engines` → `{vis("engines") && (<>…</>)}`.
  - `<BrakesGauge …/>` → `{(iceOn ? vis("iceBrakes") : vis("brakes")) && …}`; the `iceOn ? <IceBrakes …/> : <div className="slots-row brakes">…` block → same condition.
  - Concentration `<Module …>` → `{vis("concentration") && …}`; `{internOn && <Intern …/>}` → `{internOn && vis("intern") && …}`; the `<section className="deck">` only when either is shown.
  - Pilot rail: `{keroseneOn && vis("kerosene") && <Kerosene …/>}`, Radio module `vis("radio")`, Landing Gear `vis("gear")`; Co-Pilot rail: `{windOn && vis("wind") && <Wind …/>}`, Radio `vis("radio")`, Flaps `vis("flaps")`. Render each rail `<div>` only if any of its children shows.
  - `<Abilities …/>` → `{vis("abilities") && …}`.
  - `<ul className="log">` → `{!show && …}`.
  - Add a class when trimmed: `className={`board${…existing…}${show ? " tutorial" : ""}`}`.

- [ ] **Step 3: Verify real games are untouched** — `npm run typecheck`, `npm test` (both PASSED), then start a game in the browser (http://localhost:5173, two tabs) and confirm the full cockpit still renders.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/Cockpit.tsx
git commit -m "Cockpit: optional show and clockOffset props for trimmed tutorial boards"
```

---

### Task 5: Sandbox hook + Tutorial modal

**Files:**
- Create: `packages/client/src/tutorials/useSandbox.ts`
- Create: `packages/client/src/components/TutorialModal.tsx`
- Modify: `packages/client/src/styles.css`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: `useSandbox(tutorial)` → `{ snapshot, step, stepIndex, error, flash, send, next, reset, skipTime, timerRunning }`; `TutorialModal({ id, onClose })`.

- [ ] **Step 1: `useSandbox.ts`**:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SETUP, GameRuleError, type GameCommand, type GameState, type RoomSnapshot } from "@skyteam/shared";
import { COPILOT_ID, PILOT_ID, actingCrew, apply, scriptedDice, timeUp } from "./engine";
import type { Move, Tutorial } from "./types";

/** A view of the sandbox game as the crew who must act now (hot-seat). */
function snapshotFor(game: GameState): RoomSnapshot {
  const crew = actingCrew(game);
  return {
    roomId: "tutorial", inviteCode: "", status: game.outcome ? "finished" : "in_progress", hostPlayerId: PILOT_ID,
    seats: [
      { playerId: PILOT_ID, role: "host", ready: true, connection: "connected" },
      { playerId: COPILOT_ID, role: "guest", ready: true, connection: "connected" },
    ],
    observerCount: 0, setup: DEFAULT_SETUP, version: 0, game, notice: null,
    you: { playerId: crew === "pilot" ? PILOT_ID : COPILOT_ID, kind: "player", role: crew === "pilot" ? "host" : "guest" },
    serverTime: Date.now(),
  };
}

/** Runs one tutorial locally: real rules, scripted dice, both crews, step tracking. */
export function useSandbox(tutorial: Tutorial) {
  const dice = useRef(scriptedDice(tutorial.script));
  const [game, setGame] = useState(() => tutorial.setup());
  const [stepIndex, setStepIndex] = useState(0);
  const [before, setBefore] = useState<GameState>(game);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const step = tutorial.steps[stepIndex] ?? null;

  /** Start step `i` on `state`: play its automatic moves, remember where it began. */
  const enterStep = useCallback((i: number, state: GameState) => {
    let s = state;
    for (const m of tutorial.steps[i]?.auto ?? []) s = apply(s, m, dice.current);
    setGame(s);
    setBefore(s);
    setStepIndex(i);
  }, [tutorial]);

  const play = useCallback((move: Move) => {
    setError(null);
    try {
      const s = apply(game, move, dice.current);
      setGame(s);
      if (step && !step.info && step.done(s, before)) {
        setFlash(true);
        setTimeout(() => { setFlash(false); enterStep(stepIndex + 1, s); }, 700);
      }
    } catch (e) {
      setError(e instanceof GameRuleError ? e.message : "That move isn't allowed.");
    }
  }, [game, step, before, stepIndex, enterStep]);

  const send = useCallback((command: GameCommand) => play(() => ({ crew: actingCrew(game), command })), [play, game]);
  const next = () => enterStep(stepIndex + 1, game);
  const reset = () => {
    dice.current = scriptedDice(tutorial.script);
    setError(null);
    enterStep(0, tutorial.setup());
  };

  // Real-Time: the countdown runs on this machine's clock.
  const timerRunning = game.timerEndsAt !== null && game.phase === "placement";
  useEffect(() => {
    if (!timerRunning) return;
    const t = setTimeout(() => play(timeUp), Math.max(0, game.timerEndsAt! - Date.now()));
    return () => clearTimeout(t);
  }, [timerRunning, game.timerEndsAt, play]);

  return { snapshot: snapshotFor(game), step, stepIndex, error, flash, send, next, reset, skipTime: () => play(timeUp), timerRunning };
}
```

- [ ] **Step 2: `TutorialModal.tsx`**:

```tsx
import { useEffect, useRef } from "react";
import type { AbilityId, ModuleId } from "@skyteam/shared";
import { TUTORIALS } from "../tutorials";
import { useSandbox } from "../tutorials/useSandbox";
import { Cockpit } from "./Cockpit";

/** A module's or Special Ability's rules plus its guided, playable tutorial. */
export function TutorialModal({ id, onClose }: { id: ModuleId | AbilityId; onClose: () => void }) {
  const tutorial = TUTORIALS[id];
  const sb = useSandbox(tutorial);
  const panel = useRef<HTMLDivElement>(null);

  // Escape closes; focus moves into the dialog and stays there; the page behind doesn't scroll.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !panel.current) return;
      const f = panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex]:not([tabindex='-1'])");
      if (f.length === 0) return;
      const [first, last] = [f[0], f[f.length - 1]];
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [onClose]);

  const total = tutorial.steps.length;
  const crew = sb.snapshot.you.role === "host" ? "Pilot" : "Co-Pilot";
  return (
    <div className="tutorial-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className="tutorial-panel" role="dialog" aria-modal="true" aria-labelledby="tutorial-title" tabIndex={-1}>
        <header className="tutorial-head">
          <h2 id="tutorial-title">{tutorial.title}</h2>
          <button className="tutorial-close" aria-label="Close" onClick={onClose}>✕</button>
        </header>
        <p className="tutorial-desc">{tutorial.description}</p>
        <div className="stage tutorial-stage">
          <p className="tutorial-as">Playing as: <b>{crew}</b></p>
          <Cockpit snapshot={sb.snapshot} onCommand={sb.send} show={tutorial.show} clockOffset={0} />
        </div>
        <footer className={`tutorial-steps${sb.flash ? " done" : ""}`}>
          <span className="tutorial-count">{sb.step ? `Step ${sb.stepIndex + 1} of ${total}` : "Free play"}</span>
          <p className="tutorial-text" aria-live="polite">
            {sb.error ?? sb.step?.text ?? "Free play — try anything, or Reset."}
          </p>
          <div className="row">
            {sb.timerRunning && <button onClick={sb.skipTime}>Skip to time's up</button>}
            {sb.step && <button onClick={sb.next}>{sb.step.info ? "Got it" : "Next"}</button>}
            <button onClick={sb.reset}>Reset</button>
            <button onClick={onClose}>Close</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: CSS** — append to `styles.css` (before the phones `@media` blocks):

```css
/* Tutorials: a dialog over the lobby with a trimmed, playable cockpit. Above
   the page (900), below the drag overlays (.drop-ring 999, .drag-die 1000). */
.tutorial-backdrop {
  position: fixed;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  overflow-y: auto;
  padding: 2rem 1rem;
  background: rgba(8, 11, 16, 0.72);
}
.tutorial-panel {
  width: min(1000px, 100%);
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 1rem;
  border-radius: 12px;
  background: linear-gradient(180deg, var(--panel), var(--panel-2));
  border: 1px solid var(--panel-edge);
  color: var(--ink);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
  outline: none;
}
.tutorial-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.tutorial-head h2 {
  margin: 0;
  font-family: var(--font-display);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.tutorial-close {
  padding: 0.2rem 0.6rem;
}
.tutorial-desc {
  margin: 0;
}
.tutorial-stage {
  padding: 0;
  max-width: none;
}
.tutorial-as {
  margin: 0 0 0.4rem;
  font-size: 0.85rem;
}
.tutorial-steps {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  background: var(--recess);
  color: var(--paper);
  transition: background 0.2s;
}
.tutorial-steps.done {
  background: #1f4a2a;
}
.tutorial-count {
  font-family: var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.75rem;
  opacity: 0.75;
}
.tutorial-text {
  margin: 0;
}
```

- [ ] **Step 4: Typecheck** — `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/tutorials/useSandbox.ts packages/client/src/components/TutorialModal.tsx packages/client/src/styles.css
git commit -m "Add the tutorial sandbox hook and modal"
```

---

### Task 6: Lobby ⓘ buttons

**Files:**
- Modify: `packages/client/src/components/Lobby.tsx`
- Modify: `packages/client/src/styles.css`

**Interfaces:**
- Consumes: `TutorialModal` (Task 5).

- [ ] **Step 1: Add the buttons and modal state** in `SetupPicker`:

```tsx
import { TutorialModal } from "./TutorialModal";
// …
const [tutorial, setTutorial] = useState<ModuleId | AbilityId | null>(null);
const info = (id: ModuleId | AbilityId, name: string) => (
  <button type="button" className="info-btn" aria-label={`How ${name} works`} title={`How ${name} works`} onClick={() => setTutorial(id)}>
    ⓘ
  </button>
);
```
(`useState` from "react".) In the module list, after `{MODULE_LABELS[id]}…` inside each `<label>`, the ⓘ must be **outside** the label so clicking it doesn't toggle the checkbox — wrap each item:

```tsx
<span key={id} className="setup-item">
  <label className={available ? "" : "muted"}>…unchanged…</label>
  {info(id, MODULE_LABELS[id])}
</span>
```
Same for abilities (`ABILITY_LABELS[id]`). At the end of `SetupPicker`'s returned JSX:

```tsx
{tutorial && <TutorialModal id={tutorial} onClose={() => setTutorial(null)} />}
```
The ⓘ buttons are enabled for host and guest alike (not tied to `editable`).

Also update `scripts/simulate.mjs`'s `setTicks` and module discovery selectors from `.setup-modules label` to keep working: they read `label` elements, which are unchanged — verify by running Task 7's simulation.

- [ ] **Step 2: CSS** —

```css
.setup-item {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}
.info-btn {
  flex: none;
  width: 1.4rem;
  height: 1.4rem;
  padding: 0;
  border-radius: 50%;
  font-family: var(--font-body);
  text-transform: none;
  font-size: 0.85rem;
  line-height: 1;
}
```

- [ ] **Step 3: Typecheck + tests** — both clean / PASSED.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/Lobby.tsx packages/client/src/styles.css
git commit -m "Lobby: an ⓘ beside each module and ability opens its tutorial"
```

---

### Task 7: Browser verification

**Files:**
- Create (scratch, not committed): a Playwright script in the session scratchpad.

- [ ] **Step 1: Play every tutorial through the UI.** With the dev stack up (`docker.exe compose -f docker-compose.dev.yml up -d`), write a Playwright script (image `mcr.microsoft.com/playwright:v1.49.0-noble`, `BASE=http://<LAN IP>:5173`) that creates a room, and for each ⓘ: opens it, plays the tutorial's steps by dragging the named dice onto the named spaces (pointer down on `.hand .die` with that value → move → up over the target `.slot`), presses the ability buttons / “Skip to time's up” where the step says so, presses **Got it** on info steps, and asserts the footer reaches "Free play". Screenshot each modal at 1280×900 and 390×844.

- [ ] **Step 2: Check the Review Focus items by hand in the screenshots / script:** a refused drop shows the reducer's message; Reset returns to step 1; closing during Real Time and waiting 60 s logs nothing; the dragged die is drawn above the modal; a setup change by the other tab doesn't reset an open tutorial.

- [ ] **Step 3: Regression** — `npm test` PASSED; `CARDS=1` simulation (see `scripts/simulate.sh`) 21/21 clean.

- [ ] **Step 4: Fix anything found** (each fix: failing check first, then the change, then rerun), and commit:

```bash
git commit -am "Tutorials: fixes from the browser check"
```
