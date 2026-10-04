import { randomInt } from "node:crypto";
import { redactGameStateFor } from "@skyteam/shared";
import { env } from "./env";
import { npcGivesUp, npcShouldAct } from "./seating";
import { applyCommand, broadcastState, logFailure, TOO_LATE, type IOServer } from "./socket";
import { getRoom, saveRoom } from "./store";
import { think } from "./think";

const timers = new Map<string, NodeJS.Timeout>();
/** Rejected bot moves in a row, per room. */
const rejections = new Map<string, number>();

/**
 * Let the room's bot act if the game is waiting on it. Idempotent: at most one
 * pending timer per room, and the condition is re-checked when it fires (the
 * state may have moved on). Call after every state change and on (re)join.
 */
export function scheduleNpc(io: IOServer, roomId: string, delayMs = env.NPC_DELAY_MS): void {
  if (timers.has(roomId)) return;
  timers.set(
    roomId,
    setTimeout(() => void npcTurn(io, roomId).catch(logFailure(`bot move in ${roomId}`)), delayMs),
  );
}

/** The bot's turn, when its timer fires: think, then play (or think again). */
async function npcTurn(io: IOServer, roomId: string): Promise<void> {
  timers.delete(roomId);
  const room = await getRoom(roomId);
  const turn = room && npcShouldAct(room);
  if (!room || !turn) return;
  const started = Date.now();
  const game = room.game!;
  const move = await think(redactGameStateFor(game, turn.botId), turn.crew, randomInt(0, 2 ** 31));
  // Thinking took time already: count it toward the pause before the bot's next move.
  const thought = Date.now() - started;
  // The game moved on while the bot was thinking (every change replaces
  // room.game): that move was for an old position — think again.
  if (room.game !== game || room.status !== "in_progress") return scheduleNpc(io, roomId, 0);
  // Should never happen: a die that fits nowhere is discarded by the rules.
  if (!move) return giveUp(io, roomId, `no legal move for the ${turn.crew} bot`);
  const error = await applyCommand(io, room, turn.botId, move);
  // Too late: the deadline passed while the bot thought. Not a rejection —
  // the time-up ended the round and woke the bot if it leads the next one.
  if (error === TOO_LATE) return;
  if (error) {
    console.error(`[npc] ${roomId}: move rejected (${error}) — ${JSON.stringify(move)}`);
    const n = (rejections.get(roomId) ?? 0) + 1;
    rejections.set(roomId, n);
    if (npcGivesUp(n)) return giveUp(io, roomId, `${n} bot moves rejected in a row`);
  } else {
    rejections.delete(roomId);
  }
  // applyCommand already scheduled the next move at the usual pace; shorten
  // that pause by the time spent thinking. (It may still be the bot's action.)
  cancelNpc(roomId);
  scheduleNpc(io, roomId, Math.max(0, env.NPC_DELAY_MS - thought));
}

/** The bot can't go on (a legality bug): end the game rather than hang or loop. */
async function giveUp(io: IOServer, roomId: string, why: string): Promise<void> {
  console.error(`[npc] ${roomId}: ${why} — abandoning`);
  rejections.delete(roomId);
  const room = await getRoom(roomId);
  if (!room) return;
  room.status = "abandoned";
  await saveRoom(room);
  broadcastState(io, room);
}

/** Drop a pending bot action (the game was exited or reset). */
export function cancelNpc(roomId: string): void {
  const t = timers.get(roomId);
  if (t) clearTimeout(t);
  timers.delete(roomId);
}
