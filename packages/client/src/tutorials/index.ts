import type { AbilityId, ModuleId } from "@skyteam/shared";
import { adaptation } from "./adaptation";
import { anticipation } from "./anticipation";
import { control } from "./control";
import { iceBrakes } from "./iceBrakes";
import { intern } from "./intern";
import { kerosene } from "./kerosene";
import { keroseneLeak } from "./keroseneLeak";
import { mastery } from "./mastery";
import { realTime } from "./realTime";
import { synchronisation } from "./synchronisation";
import type { Tutorial } from "./types";
import { wind } from "./wind";
import { workingTogether } from "./workingTogether";

/** One interactive tutorial per module and Special Ability (opened from the lobby's ⓘ). */
export const TUTORIALS: Record<ModuleId | AbilityId, Tutorial> = {
  kerosene, keroseneLeak, intern, wind, iceBrakes, realTime,
  workingTogether, synchronisation, mastery, control, anticipation, adaptation,
};
