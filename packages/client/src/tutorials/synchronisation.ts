import { engine, place, placeTraffic, start } from "./engine";
import type { Tutorial } from "./types";

export const synchronisation: Tutorial = {
  id: "synchronisation",
  title: "Synchronisation",
  description:
    "As soon as a die is on the Landing Gear and one on the Flaps in the same round, the Traffic die (2–5) is rolled. The Co-Pilot places it on any empty space — either colour — as an extra action.",
  show: ["gear", "flaps", "axis", "engines", "abilities"],
  setup: () => start({ abilities: ["synchronisation"], pilot: [1, 3, 4, 6], copilot: [1, 3, 4, 6] }),
  script: { traffic: [4] },
  steps: [
    { text: "Pilot: put your 1 on the first Landing Gear space.", solution: [place("pilot", 1, { kind: "landingGear", slot: 0 })], done: (s) => s.gearSlots[0] === 1 },
    {
      text: "Co-Pilot: put your 1 on the first Flaps space — Gear and Flaps both have a die, so the Traffic die is rolled: a 4.",
      solution: [place("copilot", 1, { kind: "flaps", slot: 0 })],
      done: (s) => s.trafficHeld?.value === 4,
    },
    {
      text: "Co-Pilot: place the Traffic die on any empty space, even a Pilot's — drop it on the Pilot's Engine.",
      solution: [placeTraffic(engine("pilot"))],
      done: (s) => s.trafficHeld === null && s.engines.pilot === 4,
    },
  ],
};
