import { axis, engine, place, start } from "./engine";
import type { Tutorial } from "./types";

export const wind: Tutorial = {
  id: "wind",
  title: "Wind",
  description:
    "A ring of wind speeds surrounds a blue airplane. After each Axis, the airplane turns one space per pip the plane is tilted — left when tilted toward the Pilot, right toward the Co-Pilot. The wind it points at is added to the Engine total.",
  show: ["axis", "engines", "wind"],
  setup: () => start({ modules: ["wind"], pilot: [5, 4, 6, 6], copilot: [3, 4, 6, 6] }),
  steps: [
    {
      text: "Tilt the plane 2 toward the Pilot: the Pilot's 5 and the Co-Pilot's 3 on the Axis. The airplane turns 2 spaces left, to +2.",
      solution: [place("pilot", 5, axis("pilot")), place("copilot", 3, axis("copilot"))],
      done: (s) => s.windPosition === 18,
    },
    {
      text: "Now a 4 each on the Engines: the speed is 4 + 4 + 2 wind = 10.",
      solution: [place("pilot", 4, engine("pilot")), place("copilot", 4, engine("copilot"))],
      done: (s) => s.lastSpeed === 10,
    },
  ],
};
