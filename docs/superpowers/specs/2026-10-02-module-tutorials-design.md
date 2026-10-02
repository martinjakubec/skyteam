# Module & Special Ability tutorials — design

**Date:** 2026-10-02 · **Status:** approved in conversation, awaiting spec review

## Goal

In the lobby, every module and Special Ability gets an ⓘ button that opens a
modal explaining it: a short rules description plus an **interactive, guided
tutorial** on the real cockpit, trimmed to the parts that matter. Example: the
Kerosene Leak tutorial shows only the Engines and the Kerosene Leak track; the
player drags a 5 and a 3 onto the Engines and watches the leak burn 3.

Success: a player who has never used a module can open its ⓘ, follow 2–3 steps
by dragging dice, and see the rule happen exactly as it will in a real game.

### Decisions (from the conversation)

- **Guided steps**, then free play with Reset.
- **Entry point:** an ⓘ next to each lobby checkbox; ticking stays a plain toggle.
- **Lobby only** — not reachable in-game. Host and guest can both open them
  (purely local; nothing is sent to the server or the other player).
- **Approach A:** the real `Cockpit`, trimmed, driven by a local sandbox that
  runs the real reducer.

### Non-goals

- Tutorials for the base game (Axis, Engines, Radio…). Only the 6 modules and
  6 Special Abilities.
- In-game access, persistence of "seen" tutorials, translations.

## Architecture

### 1. Shared entropy (refactor) — `packages/shared/src/game/entropy.ts`

The server currently turns a player's `GameCommand` into a `ReduceCommand`
(adding reroll values, Anticipation's value) and `settle()`s the state (Traffic
die for Synchronisation, the next round's roll incl. Traffic dice) inside
`packages/server/src/socket.ts`, using `node:crypto`. Move that logic to shared,
parameterised by a random source:

```ts
export interface Dice {
  /** A d6 value. */ d6(): DieValue;
  /** A Traffic die face. */ traffic(): DieValue;
}
export function withEntropy(command: GameCommand, dice: Dice): ReduceCommand;
export function roundRoll(game: GameState, dice: Dice, at: number): ReduceCommand;
export function settle(game: GameState, dice: Dice, now: () => number): GameState;
```

The server passes a `crypto.randomInt`-backed `Dice`; the sandbox passes a
scripted one. Behaviour of the server is unchanged.

### 2. Tutorial definitions — `packages/client/src/tutorials/`

One file per item (`kerosene.ts`, `keroseneLeak.ts`, …, `adaptation.ts`) plus
`index.ts` exporting `TUTORIALS: Record<ModuleId | AbilityId, Tutorial>`.

```ts
interface Tutorial {
  id: ModuleId | AbilityId;
  title: string;
  /** Rules description, 2–4 short sentences. */
  description: string;
  /** Cockpit sections drawn (the dice tray is always drawn). */
  show: CockpitSection[];
  /** The starting position: a GameState built with createInitialGameState
   *  plus a fixed roll, then adjusted (e.g. dice not needed for the lesson
   *  marked placed, so a round ends after one or two drags). */
  setup(): GameState;
  /** Values the sandbox's scripted Dice hand out, in order (next rounds,
   *  rerolls, Anticipation, Traffic die). Falls back to random when exhausted. */
  script?: { d6?: DieValue[]; traffic?: DieValue[] };
  steps: Step[];
}
interface Step {
  /** What to do / what just happened, e.g. "Drag the Pilot's 5 onto the Engine." */
  text: string;
  /** True once the step is complete. */
  done(state: GameState, start: GameState): boolean;
  /** The commands that complete it — used by tests (and nothing else). */
  solution: { crew: Crew; command: GameCommand }[];
}
```

`CockpitSection` = `"tracks" | "axis" | "engines" | "brakes" | "radio" | "gear" |
"flaps" | "concentration" | "kerosene" | "wind" | "intern" | "iceBrakes" |
"realTime" | "abilities"`.

### 3. Sandbox — `packages/client/src/tutorials/useSandbox.ts`

Holds a `GameState`. `send(command)` → `withEntropy` (scripted `Dice`) →
`reduce` → `settle` → new state. Rule errors surface as the step bar's message
(same text the server would send). Plays **both crews**: it builds a
`RoomSnapshot` whose `you` is whoever must act now (the responder of a pending
reroll / swap, the holder of an Intern token or Traffic die, else
`game.turn`). Real-Time: the sandbox runs the countdown with a timer and
issues `timeUp` itself; the modal also offers "Skip to time's up".

### 4. Cockpit — optional `show` prop

`Cockpit({ snapshot, onCommand, show? })`. When `show` is given, sections not
listed are not rendered (conditional rendering, not CSS). Real games pass
nothing — unchanged behaviour. The topbar, log and reroll/round controls not
relevant to a tutorial are hidden in tutorial mode.

### 5. UI — `TutorialModal.tsx`, Lobby ⓘ buttons

- Lobby: a round ⓘ button beside each module/ability label,
  `aria-label="How <Name> works"`.
- Modal (`role="dialog"`, `aria-modal`, labelled by its title): description at
  top; the trimmed cockpit (scaled like the game stage on phones); "Playing as:
  Pilot/Co-Pilot" above the tray; a step bar — "Step n of m", step text, **Next**
  (skip), **Reset**, **Close**. A completed step flashes green, then advances.
  After the last: "Free play — try anything, or Reset."
- Escape / ✕ / backdrop click close; focus is trapped inside and returns to the
  ⓘ; the page behind doesn't scroll.
- A loss inside a tutorial shows the cockpit's normal result banner; the step
  bar offers Reset.

## Tutorial content

All dice values are fixed; the player controls both crews.

| Tutorial | Shows | Steps |
|---|---|---|
| Kerosene | Engines, Kerosene | Put a 2 on the Kerosene space → burns 2 (20→18). Fill the Engines → round ends. Next round leave Kerosene empty → burns 6. |
| Kerosene Leak | Engines, Kerosene (leak) | Pilot 5 on Engine; Co-Pilot 3 → leak burns \|5−3\|+1 = 3. Next round equal 4s → burns 1. |
| Intern | Intern board, Radio, Engines | Train with a die unlike the next token → take the token; place it like a die. Note: untrained tokens at landing lose. |
| Wind | Axis, Engines, Wind ring | Tilt the Axis 2 toward the Pilot → ring turns 2 left; place the Engines → the wind value is added to the speed. |
| Ice Brakes | Ice Brakes | 2 on the Pilot-only top space; 2 on the bottom space → marker passes 2, 3 opens. Note: all four needed to land. |
| Real Time | Clock, Axis, Engines | Set Axis + Engines in time; "Skip to time's up" → round ends with dice left; next round time out before Axis/Engines → loss. Mentions the pause on disconnect. |
| Working Together | Ability card, tray | Active player puts a die on the card; the other must add one; values swap, dice return. |
| Synchronisation | Gear, Flaps, open spaces | Die on Gear; die on Flaps → Traffic die rolled (scripted 4); Co-Pilot places it on any empty space. |
| Mastery | Engines, reroll tokens | Token starts spent; two equal Engine dice → token regained. |
| Control | Axis, Coffee | Two equal Axis dice → +1 Coffee; spend it to shift a die by 1. |
| Anticipation | Ability card, tray | First player rerolls one die before their first placement (scripted 1→5). Note: once per round. |
| Adaptation | Ability card, tray | Turn a 1 to its opposite face, 6. Note: once per game, per player. |

## Error handling

- A rejected command (illegal by the reducer) shows its message in the step bar;
  state is unchanged.
- **Next** skips a step without requiring it; steps never block.
- A scripted `Dice` that runs out falls back to `Math.random` so free play
  never stalls.

## Testing

- **Content** (`scripts/test-units.mjs`): for every tutorial, `setup()`, then
  for each step apply its `solution` through the real reducer (with the
  tutorial's scripted dice) and assert `done()` becomes true in order — catches
  tutorials going stale when rules change. Also: every module and ability has a
  tutorial.
- **Entropy refactor:** existing rule/unit tests, `validate.mjs`, and the
  `CARDS=1` simulation still pass.
- **Browser:** Playwright opens each ⓘ, plays every script by dragging, and
  screenshots desktop and phone.
