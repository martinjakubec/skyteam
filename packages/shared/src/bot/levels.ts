/** NPC difficulty, easiest → strongest. Names are aviation ranks, deliberately
 *  not "Pilot"/"Co-Pilot" (those are the seats). */
export const BOT_LEVELS = ["cadet", "navigator", "aviator"] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];
export const BOT_LEVEL_LABELS: Record<BotLevel, string> = { cadet: "Cadet", navigator: "Navigator", aviator: "Aviator" };
