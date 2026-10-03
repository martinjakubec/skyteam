import { randomInt } from "node:crypto";
import { chooseMove, redactGameStateFor, type Rand } from "@skyteam/shared";
import { env } from "./env";
import { npcShouldAct } from "./seating";
import { applyCommand, broadcastState, type IOServer } from "./socket";
import { getRoom, saveRoom } from "./store";

const timers = new Map<string, NodeJS.Timeout>();
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
      if (!move) {
        // Should never happen: a die that fits nowhere is discarded by the rules.
        console.error(`[npc] ${roomId}: no legal move for the ${turn.crew} bot — abandoning`);
        room.status = "abandoned";
        await saveRoom(room);
        broadcastState(io, room);
        return;
      }
      const error = await applyCommand(io, room, turn.botId, move);
      if (error) console.error(`[npc] ${roomId}: move rejected (${error}) — ${JSON.stringify(move)}`);
      scheduleNpc(io, roomId); // it may still be the bot's action (e.g. after training the Intern)
    }, env.NPC_DELAY_MS),
  );
}

/** Drop a pending bot action (the game was exited or reset). */
export function cancelNpc(roomId: string): void {
  const t = timers.get(roomId);
  if (t) clearTimeout(t);
  timers.delete(roomId);
}
