import { adapt, start } from "./engine";
import type { Tutorial } from "./types";

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
    { text: "The Co-Pilot has a flip of their own — one per game each. In a real game you may also flip while your partner is placing.", info: true, solution: [], done: () => true },
  ],
};
