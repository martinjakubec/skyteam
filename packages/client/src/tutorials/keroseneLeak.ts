import { axis, conc, engine, place, radio, start } from "./engine";
import type { Tutorial } from "./types";

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
