/** The NPC's level. There is one — Aviator; the type and the request field
 *  stay so stored rooms and older clients keep working (normalizeBotLevel). */
export const BOT_LEVELS = ["aviator"] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];
export const BOT_LEVEL_LABELS: Record<BotLevel, string> = { aviator: "Aviator" };

/** Levels that no longer exist (Cadet, Navigator) play as Aviator. */
export function normalizeBotLevel(_level: unknown): BotLevel {
  return "aviator";
}
