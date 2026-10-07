// Two bot decisions no other test pins down (found by planting bugs that the
// whole suite let through): which tilt the plan steers to through a turn, and
// how the rollout policy answers a partner's reroll offer.
import { describe, expect, test } from "vitest";
import {
  COPILOT_ID, PILOT_ID, SCENARIO_TEMPLATES, flightPlan, fastMove, mulberry32, newGame, randDice, settle, turnTarget,
} from "../packages/shared/src/index.ts";

const dealt = (id) => {
  const r = mulberry32(4);
  return settle(newGame({ scenarioId: id, modules: [], abilities: [] }, PILOT_ID, COPILOT_ID, r, 0), randDice(r), () => 0);
};

describe("turnTarget: through a turn, aim at the allowed tilt nearest the current one", () => {
  // Every turn space on every card that allows more than one tilt.
  const cases = SCENARIO_TEMPLATES.flatMap((t) => {
    const g = dealt(t.id === "green-YUL" ? "YUL" : t.id);
    return flightPlan(g.scenario).turn.flatMap((allowed, position) => (allowed && allowed.length > 1 ? [{ id: t.id, g, position, allowed }] : []));
  });

  test("cards with such turns exist", () => expect(cases.length).toBeGreaterThan(0));

  test("from each end of the allowed range, it keeps that end (no needless swing)", () => {
    for (const { id, g, position, allowed } of cases) {
      for (const offset of [Math.min(...allowed), Math.max(...allowed)]) {
        const s = { ...g, round: 1, position, axis: { ...g.axis, offset } };
        expect(turnTarget(s, 1), `${id} space ${position} from ${offset}`).toBe(offset);
      }
    }
  });

  test("no move, or the landing round: no target", () => {
    const { g, position } = cases[0];
    expect(turnTarget({ ...g, position }, 0)).toBe(null);
    expect(turnTarget({ ...g, position, round: g.scenario.rounds }, 1)).toBe(null);
  });
});

test("rollouts: offered a reroll, the policy keeps its own dice", () => {
  const g = dealt("YUL");
  const offered = { ...g, pendingReroll: "copilot" };
  expect(fastMove(offered, "copilot", mulberry32(1))).toEqual({ type: "reroll", dieIds: [] });
});
