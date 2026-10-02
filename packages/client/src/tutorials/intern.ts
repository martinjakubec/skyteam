import { axis, place, placeIntern, start } from "./engine";
import type { Tutorial } from "./types";

export const intern: Tutorial = {
  id: "intern",
  title: "Intern",
  description:
    "Six Intern tokens lie face up. Once per round each crew may train: put a die whose value differs from your next token (the Pilot takes from the left, the Co-Pilot from the right) on your training space, take that token and place it at once like a die of its number — not on Concentration, and without Coffee. Any token left at landing loses the game.",
  show: ["intern", "axis", "engines", "radio"],
  setup: () => start({ modules: ["intern"], pilot: [2, 4, 5, 6], copilot: [3, 4, 6, 6] }),
  steps: [
    {
      text: "Pilot: your next token is the 3. Drag your 2 onto the Pilot's training space to take it.",
      solution: [place("pilot", 2, { kind: "intern", side: "pilot" })],
      done: (s) => s.internHeld?.crew === "pilot",
    },
    {
      text: "Place the 3 token at once — drop it on the Pilot's Axis space.",
      solution: [placeIntern("pilot", axis("pilot"))],
      done: (s) => s.internHeld === null && s.axis.pilot === 3,
    },
    { text: "Every token must be trained before landing, or the game is lost.", info: true, solution: [], done: () => true },
  ],
};
