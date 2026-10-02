import { AERO_BLUE_START, AERO_ORANGE_START, type Scenario } from "@skyteam/shared";

/**
 * The full-game tutorial's board: a copy of the YUL Montréal card, kept here so
 * that later changes to the real card can't break the tutorial's script (which
 * clears these exact airplanes and lands in exactly these rounds).
 */
export const TUTORIAL_YUL: Scenario = {
  name: "Tutorial: YUL Montréal-Trudeau",
  approachTrack: [
    { traffic: 0 },
    { traffic: 1 },
    { traffic: 2 },
    { traffic: 1 },
    { traffic: 2 },
    { traffic: 1 },
    { traffic: 1 },
    { traffic: 0, airport: true },
  ],
  rounds: 7,
  startAltitudeFeet: 6000,
  feetPerRound: 1000,
  rerollRounds: [1, 5],
  axisSpinAt: 3,
  aeroBlueStart: AERO_BLUE_START,
  aeroOrangeStart: AERO_ORANGE_START,
  maxAbilities: 0,
};
