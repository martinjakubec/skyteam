import { actorFor, MAX_PLAYERS, type BotLevel, type Crew, type PlayerId, type RoomStatus } from "@skyteam/shared";
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

/** Whether the game is waiting on the room's bot right now, and as which crew.
 *  Never while a Real-Time clock is paused (every player action is refused
 *  then), nor once its deadline has passed (the round is over; the time-up
 *  wakes the bot if it leads the next one). */
export function npcShouldAct(room: Room): { botId: PlayerId; crew: Crew; level: BotLevel } | null {
  const bot = botSeat(room);
  if (!bot || room.status !== "in_progress" || !room.game || room.game.timerRemainingMs !== null) return null;
  if (room.game.timerEndsAt !== null && Date.now() >= room.game.timerEndsAt) return null;
  const crew = crewOf(room, bot.playerId);
  return crew && actorFor(room.game) === crew ? { botId: bot.playerId, crew, level: bot.bot } : null;
}

/** A lobby is ready to start once both seats are filled and ready (a bot seat always is). */
export function lobbyStatus(seats: Seat[]): RoomStatus {
  return seats.length === MAX_PLAYERS && seats.every((s) => s.ready) ? "ready" : "lobby";
}

/** Rejected bot moves in a row before the bot gives up (a legality bug, never a rule). */
export const NPC_MAX_REJECTIONS = 3;
export const npcGivesUp = (rejections: number) => rejections >= NPC_MAX_REJECTIONS;

/** Whether a player who doesn't come back within the grace period ends the
 *  game. Not in a solo room: nobody else is waiting, so the game just waits. */
export function abandonsOnDisconnect(room: Room): boolean {
  return botSeat(room) === null;
}

/** Whether players may rename themselves: in the lobby, never mid-game. */
export function canRename(room: Room): boolean {
  return room.status === "lobby" || room.status === "ready";
}
