import { engine, place, start } from "./engine";
import type { Tutorial } from "./types";

export const mastery: Tutorial = {
  id: "mastery",
  title: "Mastery",
  description: "When both Engine dice show the same value, regain a spent Reroll token.",
  show: ["engines"],
  setup: () =>
    start({
      abilities: ["mastery"],
      pilot: [4, 3, 6, 6],
      copilot: [4, 3, 6, 6],
      tweak: (s) => {
        s.rerollTokens = 0;
        s.rerollSpent = 1;
      },
    }),
  steps: [
    { text: "Your Reroll token is spent (see the tray). Pilot: put your 4 on the Engine.", solution: [place("pilot", 4, engine("pilot"))], done: (s) => s.engines.pilot === 4 },
    { text: "Co-Pilot: put your 4 on the Engine too — matching Engine dice win the Reroll token back.", solution: [place("copilot", 4, engine("copilot"))], done: (s) => s.rerollTokens === 1 },
  ],
};
