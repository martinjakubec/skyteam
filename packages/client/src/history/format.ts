import { ABILITY_LABELS, MODULE_LABELS, scenarioForSetup, type AbilityId, type GameSetup, type ModuleId, type ScenarioId } from "@skyteam/shared";

/** How a logged game ended, for people. */
export const RESULT_LABELS: Record<string, string> = {
  won: "Won",
  lost: "Lost",
  abandoned: "Abandoned",
  exited: "Left",
  reset: "Restarted",
};

/** "YUL Montréal" for a setup's airport (its code, if this build doesn't know it). */
export function airportName(scenarioId: string, modules: string[] = [], abilities: string[] = []): string {
  try {
    return scenarioForSetup({ scenarioId: scenarioId as ScenarioId, modules: modules as ModuleId[], abilities: abilities as AbilityId[] } as GameSetup).name;
  } catch {
    return scenarioId;
  }
}

/** The modules and abilities, in words ("" for none). */
export function extrasOf(modules: string[], abilities: string[]): string {
  return [
    ...modules.map((m) => MODULE_LABELS[m as ModuleId] ?? m),
    ...abilities.map((a) => ABILITY_LABELS[a as AbilityId] ?? a),
  ].join(", ");
}

export const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
