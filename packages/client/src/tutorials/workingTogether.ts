import { start, swap } from "./engine";
import type { Tutorial } from "./types";

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
