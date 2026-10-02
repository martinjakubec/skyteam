import { place, start } from "./engine";
import type { Tutorial } from "./types";

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
