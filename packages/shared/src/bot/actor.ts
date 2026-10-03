import type { Crew } from "../game/scenario";
import type { GameState } from "../game/state";

const other = (c: Crew): Crew => (c === "pilot" ? "copilot" : "pilot");

/** Whose input the game is waiting on right now (null once it's over). Same
 *  precedence as the tutorial sandbox's `actingCrew`. */
export function actorFor(g: GameState): Crew | null {
  if (g.outcome || g.phase !== "placement") return null;
  if (g.pendingReroll) return g.pendingReroll;
  if (g.pendingSwap) return other(g.pendingSwap.from);
  if (g.internHeld) return g.internHeld.crew;
  if (g.trafficHeld) return "copilot";
  return g.turn;
}
