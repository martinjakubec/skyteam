import type { AbilityId, Crew, DieValue, GameCommand, GameState, ModuleId } from "@skyteam/shared";
import type { CockpitSection } from "../components/cockpitSections";

export type { CockpitSection };

/** One player action in a tutorial, resolved against the state it's played on
 *  (dice are named by value, so the die's id is looked up then). "timeUp" ends
 *  a Real-Time round as if the clock ran out. */
export type Move = (s: GameState) => { crew: Crew; command: GameCommand } | "timeUp";

export interface Step {
  /** What to do, or what just happened. */
  text: string;
  /** A note with nothing to do: shown until the player presses Next. */
  info?: boolean;
  /** Moves the sandbox plays itself when the step starts (dice the lesson doesn't need). */
  auto?: Move[];
  /** True once the step is complete; `before` is the state when it started (after `auto`). */
  done(state: GameState, before: GameState): boolean;
  /** The moves that complete it — used by the tests. */
  solution: Move[];
}

export interface Tutorial {
  id: ModuleId | AbilityId;
  title: string;
  description: string;
  show: CockpitSection[];
  setup(): GameState;
  /** Values the scripted dice hand out, in order; random once used up. */
  script?: { d6?: DieValue[]; traffic?: DieValue[] };
  steps: Step[];
}
