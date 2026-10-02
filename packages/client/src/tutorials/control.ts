import { axis, engine, place, start } from "./engine";
import type { Tutorial } from "./types";

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
