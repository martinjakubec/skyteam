import { axis, engine, place, start, timeUp } from "./engine";
import type { Tutorial } from "./types";

export const realTime: Tutorial = {
  id: "realTime",
  title: "Real Time",
  description:
    "Each round has 60 seconds from the roll. When time runs out the round ends with whatever is placed — if the Axis or an Engine is still empty, the game is lost. The clock pauses while a player is disconnected.",
  show: ["realTime", "axis", "engines"],
  setup: () => start({ modules: ["realTime"], pilot: [3, 4, 6, 6], copilot: [3, 4, 6, 6] }),
  script: { d6: [3, 4, 6, 6, 3, 4, 6, 6] },
  steps: [
    {
      text: "The 60-second clock starts with your first die: put the 3s on the Axis and the 4s on the Engines.",
      solution: [place("pilot", 3, axis("pilot")), place("copilot", 3, axis("copilot")), place("pilot", 4, engine("pilot")), place("copilot", 4, engine("copilot"))],
      done: (s) => s.engines.pilot !== null && s.engines.copilot !== null,
    },
    { text: "Press “Skip to time's up”: the round ends with the 6s still in hand.", solution: [timeUp], done: (s) => s.round === 2 },
    {
      text: "Round 2: press “Skip to time's up” again before the Axis and Engines are set — the game is lost.",
      solution: [timeUp],
      done: (s) => s.phase === "lost",
    },
  ],
};
