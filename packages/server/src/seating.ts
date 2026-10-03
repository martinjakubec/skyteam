import type { BotLevel, Crew, PlayerId } from "@skyteam/shared";
import type { Room, Seat } from "./types";

/** Which player flies which seat. The host flies `hostCrew` (default Pilot). */
export function seatCrews(room: Room): { pilotId: PlayerId; copilotId: PlayerId } {
  const host = room.seats.find((s) => s.role === "host")!.playerId;
  const guest = room.seats.find((s) => s.role === "guest")!.playerId;
  return (room.hostCrew ?? "pilot") === "pilot" ? { pilotId: host, copilotId: guest } : { pilotId: guest, copilotId: host };
}

/** The crew a seated player flies (null for observers or an unfilled seat). */
export function crewOf(room: Room, playerId: PlayerId): Crew | null {
  if (room.seats.length < 2 || !room.seats.some((s) => s.playerId === playerId)) return null;
  return seatCrews(room).pilotId === playerId ? "pilot" : "copilot";
}

/** The room's NPC seat, if any. */
export function botSeat(room: Room): (Seat & { bot: BotLevel }) | null {
  return (room.seats.find((s) => s.bot) as (Seat & { bot: BotLevel }) | undefined) ?? null;
}

/** Every *human* seat but `keepId` must ready up again (after a setup change,
 *  or everyone after Exit to lobby); a bot seat is always ready. */
export function unreadyOthers(seats: Seat[], keepId: PlayerId | null): Seat[] {
  return seats.map((s) => (s.playerId === keepId || s.bot ? s : { ...s, ready: false }));
}
