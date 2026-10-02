import { anticipate, start } from "./engine";
import type { Tutorial } from "./types";

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
