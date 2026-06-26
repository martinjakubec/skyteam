import type { GameCommand, RoomSnapshot } from "@skyteam/shared";

export type Crew = "pilot" | "copilot";
export type Target = Extract<GameCommand, { type: "placeDie" }>["target"];
// The game slice of a snapshot, narrowed to non-null (present once in progress).
export type Game = NonNullable<RoomSnapshot["game"]>;
