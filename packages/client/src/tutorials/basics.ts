import { axis, engine, free, place, reroll, start } from "./engine";
import type { Tutorial } from "./types";
import { TUTORIAL_YUL } from "./yul";

const gear = (slot: number) => ({ kind: "landingGear" as const, slot });
const flaps = (slot: number) => ({ kind: "flaps" as const, slot });
const brakes = (slot: number) => ({ kind: "brakes" as const, slot });

/**
 * The whole base game, one full flight into a copy of YUL. Rounds 1 and 2 go
 * die by die; later rounds place the routine dice automatically and stop on
 * what's new; the landing round is played by hand. Every roll is scripted, so
 * the steps always fit the board.
 */
export const basics: Tutorial = {
  id: "basics",
  title: "How to play",
  description:
    "Fly one full approach into Montréal, playing both seats: the Pilot (blue) and the Co-Pilot (orange). In a real game each of you sees only your own dice, and you don't talk.",
  show: ["tracks", "axis", "engines", "brakes", "radio", "gear", "flaps", "concentration", "reroll"],
  strict: true,
  setup: () => start({ scenario: TUTORIAL_YUL, pilot: [3, 3, 2, 4], copilot: [3, 2, 1, 3] }),
  script: {
    d6: [
      4, 2, 2, 4, 6, 5, 3, 3, // round 2: Pilot, Co-Pilot
      1, 1, 2, 1, 1, 4, 3, 4, // round 3
      6, 5, //                   round 3: the Pilot's reroll
      6, 3, 2, 4, 1, 3, 3, 5, // round 4
      2, 4, 1, 5, 2, 4, 6, 4, // round 5
      3, 6, 2, 5, 5, 3, 6, 4, // round 6
      5, 6, 6, 2, 4, 6, 6, 6, // round 7
    ],
  },
  outro: "You landed at YUL! That's the whole game. Create a room and send the invite to your Co-Pilot, or try a module's ℹ️ tutorial.",
  steps: [
    // --- Before take-off -----------------------------------------------------
    {
      chapter: "Before take-off",
      info: true,
      text: "Each round both crew roll 4 dice and take turns placing them, one die at a time. The plane descends 1,000 ft per round: you have 7 rounds to land.",
      solution: [],
      done: () => false,
    },
    {
      chapter: "Before take-off",
      info: true,
      text: "To land in round 7: reach the airport at the end of the Approach Track, with no airplanes left on it, all Landing Gear and Flaps down, the plane level, and slow enough for the Brakes.",
      solution: [],
      done: () => false,
    },

    // --- Round 1: the Pilot leads ---------------------------------------------
    {
      chapter: "Round 1 · Axis",
      text: "Every round each of you must put one die on the Axis and one on the Engines. The Pilot leads in odd rounds. Pilot: drag your 3 onto the Axis.",
      solution: [place("pilot", 3, axis("pilot"))],
      done: (s) => s.axis.pilot === 3,
    },
    {
      chapter: "Round 1 · Axis",
      text: "Co-Pilot: put your 3 on the Axis too. Equal dice keep the plane level. Otherwise it tilts toward the higher die by the difference, and a tilt of 3 spins it out.",
      solution: [place("copilot", 3, axis("copilot"))],
      done: (s) => s.axis.copilot === 3,
    },
    {
      chapter: "Round 1 · Radio",
      text: "You can't fly off a space that has an airplane on it. A Radio die clears one: a 1 hits your own space, a 2 the next, and so on. Pilot: your 3 on the Radio clears an airplane two spaces ahead.",
      solution: [free("pilot", 3, "radio")],
      done: (s) => s.airplanes[2] === 1,
    },
    {
      chapter: "Round 1 · Radio",
      text: "Co-Pilot: you have two Radio spaces. Your 2 clears the airplane on the next space.",
      solution: [free("copilot", 2, "radio")],
      done: (s) => s.airplanes[1] === 0,
    },
    {
      chapter: "Round 1 · Landing Gear",
      text: "The Pilot's Landing Gear must all be down to land. Each needs one of its two numbers, and each pushes the blue speed marker up one. Pilot: your 2 on the first Landing Gear.",
      solution: [place("pilot", 2, gear(0))],
      done: (s) => s.gearGreen[0],
    },
    {
      chapter: "Round 1 · Flaps",
      text: "The Co-Pilot's Flaps go down in order, top first, and each pushes the orange speed marker up one. Co-Pilot: your 1 on the first Flaps.",
      solution: [place("copilot", 1, flaps(0))],
      done: (s) => s.flapsGreen[0],
    },
    {
      chapter: "Round 1 · Engines",
      text: "The two Engine dice add up to your speed. At or below the blue marker you stay put, above it you fly one space, and above the orange marker two. Pilot: your 4 on the Engines.",
      solution: [place("pilot", 4, engine("pilot"))],
      done: (s) => s.engines.pilot === 4,
    },
    {
      chapter: "Round 1 · Engines",
      text: "Co-Pilot: your 3 makes speed 7, between the markers (5 and 9), so the plane flies one space. The last die ends the round.",
      solution: [place("copilot", 3, engine("copilot"))],
      done: (s) => s.round === 2,
    },

    // --- Round 2: the Co-Pilot leads -------------------------------------------
    {
      chapter: "Round 2 · Concentration",
      text: "Round 2, 5,000 ft, with new dice. The Co-Pilot leads in even rounds. A die of any value on Concentration earns a Coffee (up to 3). Co-Pilot: your 6 on Concentration.",
      solution: [free("copilot", 6, "concentration")],
      done: (s) => s.coffee === 1,
    },
    {
      chapter: "Round 2 · Axis",
      text: "Pilot: your 4 on the Axis.",
      solution: [place("pilot", 4, axis("pilot"))],
      done: (s) => s.axis.pilot === 4,
    },
    {
      chapter: "Round 2 · Axis",
      text: "Co-Pilot: your 5 on the Axis. 4 against 5 tilts the plane one notch toward you. That's allowed, but you must be level to land.",
      solution: [place("copilot", 5, axis("copilot"))],
      done: (s) => s.axis.copilot === 5,
    },
    {
      chapter: "Round 2 · Coffee",
      text: "Coffee changes a die by 1 per token as you place it. The second Landing Gear needs a 3 or 4. Pilot: tap your 2, press +1, then put it on that Landing Gear.",
      solution: [place("pilot", 2, gear(1), 1)],
      done: (s) => s.gearGreen[1],
    },
    {
      chapter: "Round 2 · Radio",
      text: "Co-Pilot: your 3 on the Radio clears the airplane two spaces ahead.",
      solution: [free("copilot", 3, "radio")],
      done: (s) => s.airplanes[3] === 0,
    },
    {
      chapter: "Round 2 · Radio",
      text: "Pilot: your 2 on the Radio clears the next space.",
      solution: [free("pilot", 2, "radio")],
      done: (s) => s.airplanes[2] === 0,
    },
    {
      chapter: "Round 2 · Engines",
      text: "Engines: Co-Pilot 3, then Pilot 4. The blue marker is at 6 now, and speed 7 still flies one space.",
      solution: [place("copilot", 3, engine("copilot")), place("pilot", 4, engine("pilot"))],
      done: (s) => s.round === 3,
    },

    // --- Round 3: a reroll and a two-space move ---------------------------------
    {
      chapter: "Round 3 · Reroll",
      text: "5 spaces to go and 4 rounds left to fly, so this round needs speed above the orange marker (9). The Pilot's dice are too low. Pilot: press Reroll, pick two of your 1s, and confirm.",
      solution: [reroll("pilot", [1, 1])],
      done: (s, b) => s.rerollTokens === b.rerollTokens - 1,
    },
    {
      chapter: "Round 3 · Reroll",
      text: "A Reroll token is shared: the Co-Pilot may now reroll any of their dice too. Co-Pilot: keep yours and press Skip.",
      solution: [reroll("copilot", [])],
      done: (s) => s.pendingReroll === null,
    },
    {
      chapter: "Round 3 · Engines",
      text: "The routine dice are placed for you. 2 against 1 levels the plane, three Radio dice clear airplanes, and a 1 earns Coffee. Engines: Pilot 6, Co-Pilot 4. Speed 10 flies two spaces.",
      auto: [
        place("pilot", 2, axis("pilot")), place("copilot", 1, axis("copilot")),
        free("pilot", 5, "radio"), free("copilot", 3, "radio"),
        free("pilot", 1, "concentration"), free("copilot", 4, "radio"),
      ],
      solution: [place("pilot", 6, engine("pilot")), place("copilot", 4, engine("copilot"))],
      done: (s) => s.round === 4 && s.position === 4,
    },

    // --- Round 4: Brakes -----------------------------------------------------------
    {
      chapter: "Round 4 · Radio",
      text: "You landed on a space with an airplane, which is allowed, but you can't fly off it until it's cleared. Co-Pilot: a 1 on the Radio clears your own space.",
      solution: [free("copilot", 1, "radio")],
      done: (s) => s.airplanes[4] === 0,
    },
    {
      chapter: "Round 4 · Landing Gear",
      text: "Pilot: your 6 lowers the last Landing Gear. The blue marker moves to 7.",
      solution: [place("pilot", 6, gear(2))],
      done: (s) => s.gearGreen[2],
    },
    {
      chapter: "Round 4 · Brakes",
      text: "The Co-Pilot lowered the second Flaps, and both Axis dice are 3s. On landing, your speed can't be higher than the last Brakes deployed. They go in order: 2, 4, 6. Pilot: your 2 on the first Brakes.",
      auto: [place("copilot", 3, flaps(1)), place("pilot", 3, axis("pilot")), place("copilot", 3, axis("copilot"))],
      solution: [place("pilot", 2, brakes(0))],
      done: (s) => s.brakesDeployed === 1,
    },
    {
      chapter: "Round 4 · Engines",
      text: "Engines: Co-Pilot 5, then Pilot 4. Speed 9 is between the markers (7 and 10): one space.",
      solution: [place("copilot", 5, engine("copilot")), place("pilot", 4, engine("pilot"))],
      done: (s) => s.round === 5,
    },

    // --- Rounds 5 and 6: fast-forward ------------------------------------------------
    {
      chapter: "Round 5 · 2,000 ft",
      text: "The Reroll icon at 2,000 ft gave you a new Reroll token. The routine dice are down: level Axis, Brakes 4, the third Flaps, and two Coffee. Engines: Pilot 5, Co-Pilot 4.",
      auto: [
        place("pilot", 2, axis("pilot")), place("copilot", 2, axis("copilot")),
        place("pilot", 4, brakes(1)), place("copilot", 4, flaps(2)),
        free("pilot", 1, "concentration"), free("copilot", 6, "concentration"),
      ],
      solution: [place("pilot", 5, engine("pilot")), place("copilot", 4, engine("copilot"))],
      done: (s) => s.round === 6,
    },
    {
      chapter: "Round 6 · 1,000 ft",
      text: "The last round with movement. The last Flaps and Brakes 6 are down; the Radio dice had nothing left to clear. Engines: Co-Pilot 4, Pilot 5. Speed 9 reaches the airport.",
      auto: [
        place("copilot", 5, flaps(3)), place("pilot", 3, axis("pilot")),
        place("copilot", 3, axis("copilot")), place("pilot", 6, brakes(2)),
        free("copilot", 6, "radio"), free("pilot", 2, "radio"),
      ],
      solution: [place("copilot", 4, engine("copilot")), place("pilot", 5, engine("pilot"))],
      done: (s) => s.round === 7 && s.position === 7,
    },

    // --- Round 7: landing ------------------------------------------------------------
    {
      chapter: "Round 7 · Landing",
      info: true,
      text: "The landing round: the plane doesn't move. To land: Axis dice equal and the plane level, and Engines adding up to 6 or less (your last Brakes). You have 3 Coffee to make the dice fit.",
      solution: [],
      done: () => false,
    },
    {
      chapter: "Round 7 · Landing",
      text: "Pilot: tap your 5, press −1, then put it on the Axis as a 4.",
      solution: [place("pilot", 5, axis("pilot"), -1)],
      done: (s) => s.axis.pilot === 4,
    },
    {
      chapter: "Round 7 · Landing",
      text: "Co-Pilot: your 4 on the Axis keeps the plane level.",
      solution: [place("copilot", 4, axis("copilot"))],
      done: (s) => s.axis.copilot === 4,
    },
    {
      chapter: "Round 7 · Landing",
      text: "The spare 6s went on the Radio and Concentration, so Coffee is back to 3. Pilot: your 2 on the Engines.",
      auto: [free("pilot", 6, "radio"), free("copilot", 6, "radio"), free("pilot", 6, "concentration"), free("copilot", 6, "radio")],
      solution: [place("pilot", 2, engine("pilot"))],
      done: (s) => s.engines.pilot === 2,
    },
    {
      chapter: "Round 7 · Landing",
      text: "Co-Pilot: your 6 would make speed 8, too fast for Brakes 6. Tap it, press −1 twice, then put it on the Engines as a 4.",
      solution: [place("copilot", 6, engine("copilot"), -2)],
      done: (s) => s.outcome?.result === "won",
    },
  ],
};
