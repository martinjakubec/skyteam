import { randomInt } from "node:crypto";
import { chooseMove, redactGameStateFor, type Rand } from "@skyteam/shared";
import { env } from "./env";
import { npcGivesUp, npcShouldAct } from "./seating";
import { applyCommand, broadcastState, type IOServer } from "./socket";
import { getRoom, saveRoom } from "./store";

const timers = new Map<string, NodeJS.Timeout>();
/** Rejected bot moves in a row, per room. */
const rejections = new Map<string, number>();
const rand: Rand = (n) => randomInt(0, n);

/**
 * Let the room's bot act if the game is waiting on it. Idempotent: at most one
 * pending timer per room, and the condition is re-checked when it fires (the
 * state may have moved on). Call after every state change and on (re)join.
 */
export function scheduleNpc(io: IOServer, roomId: string): void {
  if (timers.has(roomId)) return;
  timers.set(
    roomId,
    setTimeout(async () => {
      timers.delete(roomId);
      const room = await getRoom(roomId);
      const turn = room && npcShouldAct(room);
      if (!room || !turn) return;
      const move = chooseMove(redactGameStateFor(room.game!, turn.botId), turn.crew, turn.level, rand);
      // Should never happen: a die that fits nowhere is discarded by the rules.
      if (!move) return giveUp(io, roomId, `no legal move for the ${turn.crew} bot`);
      const error = await applyCommand(io, room, turn.botId, move);
      if (error) {
        console.error(`[npc] ${roomId}: move rejected (${error}) — ${JSON.stringify(move)}`);
        const n = (rejections.get(roomId) ?? 0) + 1;
        rejections.set(roomId, n);
        if (npcGivesUp(n)) return giveUp(io, roomId, `${n} bot moves rejected in a row`);
      } else {
        rejections.delete(roomId);
      }
      scheduleNpc(io, roomId); // it may still be the bot's action (e.g. after training the Intern)
    }, env.NPC_DELAY_MS),
  );
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
