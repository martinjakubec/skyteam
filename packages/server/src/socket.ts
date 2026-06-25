import type http from "node:http";
import { randomInt } from "node:crypto";
import { Server, type DefaultEventsMap, type Socket } from "socket.io";
import {
  DEFAULT_SCENARIO,
  DICE_PER_PLAYER,
  GameCommandPayload,
  GameRuleError,
  JoinRoomPayload,
  MAX_PLAYERS,
  SetReadyPayload,
  createInitialGameState,
  redactGameStateFor,
  reduce,
  type ClientToServerEvents,
  type DieValue,
  type GameCommand,
  type ReduceCommand,
  type ServerToClientEvents,
  type SocketData,
} from "@skyteam/shared";
import { env } from "./env";
import { getRoom, saveRoom } from "./store";
import { toSnapshot } from "./snapshot";
import { verifyToken } from "./identity";
import type { Room } from "./types";

// No server-to-server events in a single-server deployment (default map).
type IOServer = Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;
type IOSocket = Socket<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;

/**
 * Pending disconnect grace timers, keyed by `${roomId}:${playerId}`.
 *
 * When a socket drops we mark the seat disconnected and start a timer. If the
 * player reconnects in time we cancel it; otherwise the game is abandoned.
 * Held in memory (single-server deployment); on a server restart timers are
 * lost but room state itself survives in Redis.
 */
const graceTimers = new Map<string, NodeJS.Timeout>();
const timerKey = (roomId: string, playerId: string) => `${roomId}:${playerId}`;

export function attachSocket(server: http.Server): IOServer {
  const io: IOServer = new Server(server, {
    cors: { origin: env.CLIENT_ORIGIN, credentials: true },
  });

  io.on("connection", (socket) => {
    socket.on("room:join", (payload, ack) => void onJoin(io, socket, payload, ack));
    socket.on("seat:ready", (payload, ack) => void onReady(io, socket, payload, ack));
    socket.on("game:start", (ack) => void onStart(io, socket, ack));
    socket.on("game:reset", (ack) => void onReset(io, socket, ack));
    socket.on("game:command", (payload, ack) => void onCommand(io, socket, payload, ack));
    socket.on("disconnect", () => void onDisconnect(io, socket));
  });

  return io;
}

// --- handlers ---------------------------------------------------------------

type Ack = (res: { ok: true } | { ok: false; error: string }) => void;

async function onJoin(io: IOServer, socket: IOSocket, payload: unknown, ack: Ack) {
  const parsed = JoinRoomPayload.safeParse(payload);
  if (!parsed.success) return ack({ ok: false, error: "Invalid join payload." });

  const playerId = verifyToken(parsed.data.token);
  if (!playerId) return ack({ ok: false, error: "Invalid identity token." });

  const room = await getRoom(parsed.data.roomId);
  if (!room) return ack({ ok: false, error: "Room not found." });

  const isParticipant =
    room.seats.some((s) => s.playerId === playerId) || room.observers.includes(playerId);
  if (!isParticipant) return ack({ ok: false, error: "You are not part of this room." });

  // Bind this socket to the player/room and cancel any pending grace timer.
  socket.data.playerId = playerId;
  socket.data.roomId = room.id;
  socket.join(room.id);
  clearGrace(room.id, playerId);

  const seat = room.seats.find((s) => s.playerId === playerId);
  if (seat) seat.connected = true;
  await saveRoom(room);

  ack({ ok: true });
  // Full resync to the (re)joining client; lobby update to everyone else.
  socket.emit("room:state", toSnapshot(room, playerId));
  broadcastState(io, room, socket.id);
}

async function onReady(io: IOServer, socket: IOSocket, payload: unknown, ack: Ack) {
  const parsed = SetReadyPayload.safeParse(payload);
  if (!parsed.success) return ack({ ok: false, error: "Invalid payload." });

  const { room, playerId } = await context(socket);
  if (!room) return ack({ ok: false, error: "Not in a room." });
  if (room.status !== "lobby" && room.status !== "ready")
    return ack({ ok: false, error: "The game has already started." });

  const seat = room.seats.find((s) => s.playerId === playerId);
  if (!seat) return ack({ ok: false, error: "Observers cannot ready up." });

  seat.ready = parsed.data.ready;
  const allReady = room.seats.length === MAX_PLAYERS && room.seats.every((s) => s.ready);
  room.status = allReady ? "ready" : "lobby";
  await saveRoom(room);

  ack({ ok: true });
  broadcastState(io, room);
}

async function onStart(io: IOServer, socket: IOSocket, ack: Ack) {
  const { room, playerId } = await context(socket);
  if (!room) return ack({ ok: false, error: "Not in a room." });
  if (room.hostPlayerId !== playerId) return ack({ ok: false, error: "Only the host can start." });
  if (room.status !== "ready") return ack({ ok: false, error: "Both players must be ready." });

  // The Pilot (blue) is the host; the Co-Pilot (orange) is the guest.
  const pilotId = room.seats.find((s) => s.role === "host")!.playerId;
  const copilotId = room.seats.find((s) => s.role === "guest")!.playerId;

  room.status = "in_progress";
  // Create the game, then roll round 1's dice. Randomness lives on the server,
  // never in the pure reducer — we thread rolled values in via a `roll` command.
  let game = createInitialGameState(DEFAULT_SCENARIO, pilotId, copilotId);
  game = reduce(game, { type: "roll", pilot: rollHand(), copilot: rollHand() }, "").state;
  room.game = game;
  room.version = 0;
  await saveRoom(room);

  ack({ ok: true });
  broadcastState(io, room);
}

/** Restart an in-progress or finished game from a fresh round 1 (same crew). */
async function onReset(io: IOServer, socket: IOSocket, ack: Ack) {
  const { room, playerId } = await context(socket);
  if (!room) return ack({ ok: false, error: "Not in a room." });
  if (room.hostPlayerId !== playerId)
    return ack({ ok: false, error: "Only the host can reset the game." });
  if (room.status !== "in_progress" && room.status !== "finished")
    return ack({ ok: false, error: "There is no game to reset." });

  const pilotId = room.seats.find((s) => s.role === "host")!.playerId;
  const copilotId = room.seats.find((s) => s.role === "guest")!.playerId;

  room.status = "in_progress";
  let game = createInitialGameState(DEFAULT_SCENARIO, pilotId, copilotId);
  game = reduce(game, { type: "roll", pilot: rollHand(), copilot: rollHand() }, "").state;
  room.game = game;
  room.version = 0;
  await saveRoom(room);

  ack({ ok: true });
  broadcastState(io, room);
}

/** Roll a fresh hand of dice (server-owned entropy). */
function rollHand(): DieValue[] {
  return Array.from({ length: DICE_PER_PLAYER }, () => randomInt(1, 7) as DieValue);
}

async function onCommand(io: IOServer, socket: IOSocket, payload: unknown, ack: Ack) {
  const parsed = GameCommandPayload.safeParse(payload);
  if (!parsed.success) return ack({ ok: false, error: "Invalid command." });

  const { room, playerId } = await context(socket);
  if (!room || !room.game) return ack({ ok: false, error: "No active game." });
  if (room.status !== "in_progress") return ack({ ok: false, error: "Game is not in progress." });
  if (!room.seats.some((s) => s.playerId === playerId))
    return ack({ ok: false, error: "Observers cannot act." });

  const command = parsed.data.command;
  // A reroll is an intent: the server supplies the new (secret) dice values.
  const rcmd: ReduceCommand =
    command.type === "reroll"
      ? { type: "reroll", dieIds: command.dieIds, values: command.dieIds.map(() => randomInt(1, 7) as DieValue) }
      : command;

  try {
    // Node processes one event at a time, so commands for a room are naturally
    // serialized here — "simultaneous" inputs are simply ordered by arrival.
    let game = reduce(room.game, rcmd, playerId).state;
    // Ending a round leaves the game "rolling"; deal the next round's dice.
    while (game.phase === "rolling" && !game.outcome) {
      game = reduce(game, { type: "roll", pilot: rollHand(), copilot: rollHand() }, "").state;
    }
    room.game = game;
    room.version += 1;
    if (game.outcome) room.status = "finished";
    await saveRoom(room);

    ack({ ok: true });
    emitGameEvent(io, room, command, playerId);
    // On game end, also push a fresh room:state so the lobby/status UI updates.
    if (room.status === "finished") broadcastState(io, room);
  } catch (e) {
    ack({ ok: false, error: e instanceof GameRuleError ? e.message : "Command rejected." });
  }
}

/** Emit a game event to each participant with the game state redacted for them
 *  (each player only sees their own unplaced dice). */
function emitGameEvent(io: IOServer, room: Room, command: GameCommand, byPlayerId: string) {
  if (!room.game) return;
  for (const sock of io.sockets.sockets.values()) {
    if (sock.data.roomId !== room.id || !sock.data.playerId) continue;
    sock.emit("game:event", {
      version: room.version,
      command,
      byPlayerId,
      game: redactGameStateFor(room.game, sock.data.playerId),
    });
  }
}

async function onDisconnect(io: IOServer, socket: IOSocket) {
  const { playerId, roomId } = socket.data;
  if (!playerId || !roomId) return;

  const room = await getRoom(roomId);
  if (!room) return;

  const seat = room.seats.find((s) => s.playerId === playerId);
  if (seat) seat.connected = false;
  await saveRoom(room);
  broadcastState(io, room);

  // Hold the seat for a grace period, then abandon if still gone.
  clearGrace(roomId, playerId);
  const timer = setTimeout(() => void abandonIfStillGone(io, roomId, playerId), env.RECONNECT_GRACE_MS);
  graceTimers.set(timerKey(roomId, playerId), timer);
}

async function abandonIfStillGone(io: IOServer, roomId: string, playerId: string) {
  graceTimers.delete(timerKey(roomId, playerId));
  const room = await getRoom(roomId);
  if (!room || room.status === "finished" || room.status === "abandoned") return;

  const seat = room.seats.find((s) => s.playerId === playerId);
  if (seat && !seat.connected) {
    room.status = "abandoned";
    await saveRoom(room);
    broadcastState(io, room);
  }
}

// --- helpers ----------------------------------------------------------------

function clearGrace(roomId: string, playerId: string) {
  const key = timerKey(roomId, playerId);
  const t = graceTimers.get(key);
  if (t) {
    clearTimeout(t);
    graceTimers.delete(key);
  }
}

async function context(socket: IOSocket): Promise<{ room: Room | null; playerId: string }> {
  const playerId = socket.data.playerId ?? "";
  const room = socket.data.roomId ? await getRoom(socket.data.roomId) : null;
  return { room, playerId };
}

/** Send each participant a snapshot tailored with their own "you" identity. */
function broadcastState(io: IOServer, room: Room, exceptSocketId?: string) {
  for (const sock of io.sockets.sockets.values()) {
    if (sock.data.roomId !== room.id || !sock.data.playerId) continue;
    if (exceptSocketId && sock.id === exceptSocketId) continue;
    sock.emit("room:state", toSnapshot(room, sock.data.playerId));
  }
}
