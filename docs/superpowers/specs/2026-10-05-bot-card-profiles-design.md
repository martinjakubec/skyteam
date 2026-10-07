# Aviator per card: flight plan, engine fixes, card profiles

**Date:** 2026-10-05 · **Status:** approved in conversation, implementing

## Why

Aviator was built and tuned on one board, YUL, which has no turns and no
Traffic dice, and where one space a round is exactly the right pace. On YUL it
lands about 80% of games; on every other green and yellow card it lands 0–33%.

Baseline (`sim-output/bench-cards-baseline.jsonl`, 120 samples per
candidate, each card with its printed modules, ability cards over four random
ability picks):

| Card | Landed | Card | Landed |
|---|---|---|---|
| green-YUL | 78.8% | yellow-LHR | 9.6% |
| green-OSL | 32.7% | yellow-GIG | 7.7% |
| green-LHR | 23.1% | yellow-PRG | 3.9% |
| green-ATL | 15.4% | yellow-KEF | 2.9% |
| green-PRG | 13.0% | yellow-TGU | 0.0% |
| green-HND | 0.0% | yellow-KUL | 0.0% |
| | | yellow-ATL | 0.0% |

About 90% of the losses on the weak cards are failed landings: the plane never
reaches the airport, with traffic still on the approach. The bot doesn't crash;
it stalls. Three causes, from a trace of the rollout policy:

1. **Turns.** The rollouts aim for a level Axis (`axisCost = |tilt|`), so they
   never set up the tilt a turn needs: 37 of 40 rollouts on yellow-TGU end with
   "Missed the turn". In the search every line that flies past a turn then
   looks fatal, so Aviator keeps the plane where it is (TGU: average position
   0.3 of 4).
2. **Traffic dice.** Every round on a space with Traffic dice icons adds
   airplanes ahead. The pace term `|remaining − roundsLeft| × 40` punishes
   being ahead of schedule as much as being behind, so on a short track the bot
   waits — on the Traffic dice — and the traffic piles up.
3. **Heavy traffic.** The rollouts clear airplanes only 0–2 spaces ahead, and
   only with spare dice. With 10–12 airplanes (yellow-ATL, yellow-PRG) the
   Radios fall behind and never catch up.

## Goal

Each green and yellow card, with its printed modules, lands at least:

- **green: 60%**, **yellow: 40%** of games,

measured by `scripts/bench-cards.mjs` at the live budget (`BUDGET_MS=600`),
80 seeds per setup; an ability card's rate is over its four ability picks.
YUL must not fall below 75%.

Red and black cards are out of scope for now; they get the same machinery in
a follow-up.

## Approach

One shared engine, specialised per card through data, not code:

1. Fix the missing concepts in the shared engine (turns, Traffic dice,
   clearing), since every card with them needs them.
2. Derive a **flight plan** from each board, so pace comes from the track.
3. Give each card a **profile** of parameter overrides, tuned per card, and
   card-specific plan rules only where a card still misses its mark.

Order: engine fixes and flight plan first, measure, then tune only the cards
still below their mark. A card that passes gets no profile.

## Design

### Flight plan (`packages/shared/src/bot/plan.ts`, new)

`flightPlan(scenario)` is a pure function of the board, cached per scenario
(keyed by `cardId` + track length, since sampled worlds clone the scenario).
It returns:

- `target[r]`: the position the plane should have reached by the end of round
  `r`'s move, for the moving rounds `1 … rounds − 1`:
  `target[r] = min(airport, ceil(airport × r / (rounds − 1)))`. Front-loaded,
  so slack is at the end; on YUL (6 spaces, 6 moving rounds) it's one a round,
  as today.
- `turn[i]`: the allowed tilts for leaving space `i` (from `axisAllowed`), or
  null.
- `trafficDice[i]`: Traffic dice icons on space `i`.

Helpers on top of it:

- `turnTarget(s)`: if the plane is expected to fly off a space with a turn this
  round (the current space, or the next one on a 2-space advance), the allowed
  tilt closest to the current offset that both spaces accept; else null.
- `paceGap(s, positionAfter, round)`: spaces behind the plan's target (> 0)
  or ahead of it (< 0).

### Engine fixes

**Turns.**
- Rollouts (`fastMove`): the Axis cost aims at `turnTarget(s)` instead of 0
  when the plane will advance this round (`want > 0`). The speed cost treats
  advancing off a turn space as fatal (like a collision) once both Axis dice
  are down and the tilt isn't allowed. On the landing round the target stays
  level.
- Evaluator: the tilt term measures the distance from `turnTarget(s)` (when
  set) instead of from level, so the tilt a turn needs isn't penalised; a new
  `turnPrep` weight scores how far the crew's best reachable Axis die leaves
  the tilt from the target while the Axis isn't final. The existing `turn`
  penalty (final tilt not allowed) stays.

**Pace and Traffic dice.**
- Evaluator: `paceCost` becomes plan-based:
  behind the plan `× paceBehind` (40, today's weight), ahead of it
  `× paceAhead` (default 10), plus the existing infeasibility cost
  (more spaces left than two a round can cover). Waiting on a space with
  Traffic dice costs `trafficDiceWait` (default 60) per icon, per round the
  plan says the plane should already have left it.
- Rollouts: `want` = the larger of the plan's gap (`target[round] − position`)
  and today's feasibility pace, capped at 2 and at the spaces left.

**Clearing.**
- Rollouts: `clearAheadMax` (default 2) bounds how far ahead spare dice clear
  airplanes. When the traffic left on the track is more than the Radios can
  clear in the rounds left (`trafficPressure`: airplanes ahead > 1.5 × rounds
  to place), the bound rises to 5 (a 6 on the Radio).

All new knobs live in `POLICY_PARAMS` / `EVAL_WEIGHTS`, so they're tunable.

### Card profiles (`packages/shared/src/bot/profiles.ts`, new)

```ts
interface BotProfile {
  policy?: Partial<typeof POLICY_PARAMS>;
  eval?: Partial<typeof EVAL_WEIGHTS>;
}
export const BOT_PROFILES: Record<string, BotProfile> = {};
export function policyFor(s: GameState): typeof POLICY_PARAMS;
export function weightsFor(s: GameState): typeof EVAL_WEIGHTS;
```

- `Scenario` gains an optional `cardId` (set for every card in `catalog.ts`;
  YUL's is `green-YUL`). Old saved rooms have none and get the defaults.
- `fastMove` and `evaluate` read their settings through `policyFor` /
  `weightsFor` (defaults merged with the card's overrides) instead of the
  module globals directly. The globals stay the defaults, and benchmarks /
  the tuner keep overriding them as today.
- Card-specific plan rules (like `icePlan`) are added only for a card that
  misses its mark after tuning, and live next to the profile.

### Tuning per card

`scripts/tune.mjs` gains `CARD=<id>`: it tunes on that card with its printed
modules (and, for ability cards, its ability picks in rotation) and prints the
winning values as a `BOT_PROFILES` entry. Rollout-only gains have lowered
Aviator's real landings before, so every profile is checked with
`bench-cards.mjs` at `BUDGET_MS=600` before it's kept.

### Benchmark

`scripts/bench-cards.mjs` gains `BUDGET_MS`: Aviator searches with a time
budget per decision (as live) instead of a fixed sample count. Results are
keyed by budget or samples, so the two never mix in a results file.

## Testing

- Unit tests: `flightPlan` targets on YUL (one a round), TGU (front-loaded)
  and a 7-space card; `turnTarget` on and off a turn space and on a 2-space
  advance; profile merging and the fallback without a `cardId`.
- Rollout policy: from a turn space that needs a tilt of +1, its Axis answer
  makes +1, not 0; a rollout pin on yellow-TGU (today 37 of 40 rollouts end in
  "Missed the turn"; after: a handful at most).
- The existing rule, unit and bot tests keep passing. Landing-count pins move
  only with a measured reason.
- Measurement: `bench-cards.mjs` at `BUDGET_MS=600` after the engine fixes,
  and after tuning, against the goal above.
