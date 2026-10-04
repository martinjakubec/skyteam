import type { Crew } from "./game/scenario";

/**
 * How each crew is called on screen, given the names their players chose
 * (empty = none). Two players with the same name are told apart by their seat:
 * "Sam (Pilot)" and "Sam (Co-Pilot)". A crew without a name is null — the
 * caller falls back to its own label.
 */
export function crewNames(names: Record<Crew, string | undefined>): Record<Crew, string | null> {
  const pilot = names.pilot?.trim() || null;
  const copilot = names.copilot?.trim() || null;
  if (pilot && copilot && pilot.toLowerCase() === copilot.toLowerCase()) {
    return { pilot: `${pilot} (Pilot)`, copilot: `${copilot} (Co-Pilot)` };
  }
  return { pilot, copilot };
}
