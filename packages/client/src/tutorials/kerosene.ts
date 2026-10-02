import { axis, conc, engine, place, radio, start } from "./engine";
import type { Tutorial } from "./types";

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
