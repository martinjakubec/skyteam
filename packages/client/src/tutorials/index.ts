import type { AbilityId, ModuleId } from "@skyteam/shared";
import { adaptation } from "./adaptation";
import { anticipation } from "./anticipation";
import { basics } from "./basics";
import { control } from "./control";
import { iceBrakes } from "./iceBrakes";
import { intern } from "./intern";
import { kerosene } from "./kerosene";
import { keroseneLeak } from "./keroseneLeak";
import { mastery } from "./mastery";
import { realTime } from "./realTime";
import { synchronisation } from "./synchronisation";
import type { Tutorial, TutorialId } from "./types";
import { wind } from "./wind";
import { workingTogether } from "./workingTogether";

/** One interactive tutorial per module and Special Ability (opened from the lobby's ℹ️). */
export const TUTORIALS: Record<ModuleId | AbilityId, Tutorial> = {
  kerosene, keroseneLeak, intern, wind, iceBrakes, realTime,
  workingTogether, synchronisation, mastery, control, anticipation, adaptation,
};

/** The full-game tutorial ("How to play"). */
export const BASICS = basics;

export const tutorialFor = (id: TutorialId): Tutorial => (id === "basics" ? basics : TUTORIALS[id]);
