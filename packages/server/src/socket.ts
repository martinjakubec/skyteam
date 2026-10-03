import type http from "node:http";
import { randomInt } from "node:crypto";
import { Server, type DefaultEventsMap, type Socket } from "socket.io";
import {
  GameCommandPayload,
  GameRuleError,
  JoinRoomPayload,
  SetReadyPayload,
  SetSetupPayload,
  hasModule,
  newGame,
  randDice,
  redactGameStateFor,
  reduce,
  settle,
  withEntropy,
  type ClientToServerEvents,
  type GameCommand,
  type GameState,
  type Rand,
  type ServerToClientEvents,
  type SocketData,
} from "@skyteam/shared";
import { env } from "./env";
import { corsOptions } from "./cors";
import { getRoom, saveRoom } from "./store";
import { toSnapshot } from "./snapshot";
import { verifyToken } from "./identity";
import { cancelNpc, scheduleNpc } from "./npc";
import { abandonsOnDisconnect, crewOf, lobbyStatus, seatCrews, unreadyOthers } from "./seating";
import type { Room } from "./types";

// No server-to-server events in a single-server deployment (default map).
export type IOServer = Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;
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

/**
 * Real-Time module: each room's running countdown, keyed by room id. The
 * deadline itself lives in the game state (`timerEndsAt`); this is just the
 * timeout that fires `timeUp` at it. `syncClock` re-arms it after every change
 * — and on reconnect, which also covers a server restart (timers are lost,
 * the deadline in Redis is not).
 */
const clockTimers = new Map<string, NodeJS.Timeout>();

export function attachSocket(server: http.Server): IOServer {
  const io: IOServer = new Server(server, {
    cors: corsOptions,
  });

  io.on("connection", (socket) => {
    socket.on("room:join", (payload, ack) => void onJoin(io, socket, payload, ack));
    socket.on("seat:ready", (payload, ack) => void onReady(io, socket, payload, ack));
    socket.on("room:setup", (payload, ack) => void onSetup(io, socket, payload, ack));
    socket.on("game:start", (ack) => void onStart(io, socket, ack));
    socket.on("game:reset", (ack) => void onReset(io, socket, ack));
    socket.on("game:exit", (ack) => void onExit(io, socket, ack));
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
  await syncClock(io, room); // Real-Time: resume once both seats are back
  scheduleNpc(io, room.id); // after a server restart, the bot picks up where it was
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
  room.status = lobbyStatus(room.seats);
  await saveRoom(room);

  ack({ ok: true });
  broadcastState(io, room);
}

/** Host picks the airport/modules. Changing them un-readies the other seats so
 *  nobody starts a game they didn't agree to. */
async function onSetup(io: IOServer, socket: IOSocket, payload: unknown, ack: Ack) {
  const parsed = SetSetupPayload.safeParse(payload);
  if (!parsed.success) return ack({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid setup." });

  const { room, playerId } = await context(socket);
  if (!room) return ack({ ok: false, error: "Not in a room." });
  if (room.hostPlayerId !== playerId) return ack({ ok: false, error: "Only the host can change the setup." });
  if (room.status !== "lobby" && room.status !== "ready")
    return ack({ ok: false, error: "The game has already started." });

  if (JSON.stringify(parsed.data) !== JSON.stringify(room.setup)) {
    room.setup = parsed.data;
    room.seats = unreadyOthers(room.seats, playerId);
    room.status = lobbyStatus(room.seats); // a solo room (host + bot) stays ready
    await saveRoom(room);
  }

  ack({ ok: true });
  broadcastState(io, room);
}

async function onStart(io: IOServer, socket: IOSocket, ack: Ack) {
  const { room, playerId } = await context(socket);
  if (!room) return ack({ ok: false, error: "Not in a room." });
  if (room.hostPlayerId !== playerId) return ack({ ok: false, error: "Only the host can start." });
  if (room.status !== "ready") return ack({ ok: false, error: "Both players must be ready." });

  const { pilotId, copilotId } = seatCrews(room);

  room.status = "in_progress";
  room.notice = null;
  // Deal the game and roll round 1. Randomness lives on the server, never in
  // the pure reducer — rolled values are threaded in via a `roll` command.
  room.game = newGame(room.setup, pilotId, copilotId, rand, Date.now(), { realTimeSeconds: env.REAL_TIME_SECONDS });
  room.version = 0;
  await saveRoom(room);

  ack({ ok: true });
  broadcastState(io, room);
  await syncClock(io, room);
  scheduleNpc(io, room.id); // the bot may lead round 1
}

/** Restart an in-progress or finished game from a fresh round 1 (same crew). */
async function onReset(io: IOServer, socket: IOSocket, ack: Ack) {
  const { room, playerId } = await context(socket);
  if (!room) return ack({ ok: false, error: "Not in a room." });
  if (room.hostPlayerId !== playerId)
    return ack({ ok: false, error: "Only the host can reset the game." });
  if (room.status !== "in_progress" && room.status !== "finished")
    return ack({ ok: false, error: "There is no game to reset." });

  const { pilotId, copilotId } = seatCrews(room);

  cancelNpc(room.id); // a bot action for the old game must not land on the new one
  room.status = "in_progress";
  room.game = newGame(room.setup, pilotId, copilotId, rand, Date.now(), { realTimeSeconds: env.REAL_TIME_SECONDS });
  room.version = 0;
  await saveRoom(room);

  ack({ ok: true });
  broadcastState(io, room);
  await syncClock(io, room);
  scheduleNpc(io, room.id);
}

/**
 * Either player ends the current (or finished) game: both return to the
 * room's lobby with the same setup, un-readied, and the lobby says who left.
 */
async function onExit(io: IOServer, socket: IOSocket, ack: Ack) {
  const { room, playerId } = await context(socket);
  if (!room) return ack({ ok: false, error: "Not in a room." });
  const seat = room.seats.find((s) => s.playerId === playerId);
  if (!seat) return ack({ ok: false, error: "Only the crew can end the game." });
  if (room.status !== "in_progress" && room.status !== "finished")
    return ack({ ok: false, error: "There is no game to leave." });

  clearClock(room.id);
  cancelNpc(room.id);
  room.status = "lobby";
  room.game = null;
  room.version = 0;
  room.seats = unreadyOthers(room.seats, null); // a bot seat stays ready
  room.notice = `The ${crewOf(room, playerId) === "pilot" ? "Pilot" : "Co-Pilot"} ended the game.`;
  await saveRoom(room);

  ack({ ok: true });
  broadcastState(io, room);
}

/** Server-owned entropy for every roll and shuffle. */
const rand: Rand = (n) => randomInt(0, n);
const serverDice = randDice(rand);

async function onCommand(io: IOServer, socket: IOSocket, payload: unknown, ack: Ack) {
  const parsed = GameCommandPayload.safeParse(payload);
  if (!parsed.success) return ack({ ok: false, error: "Invalid command." });

  const { room, playerId } = await context(socket);
  if (!room || !room.game) return ack({ ok: false, error: "No active game." });
  if (room.status !== "in_progress") return ack({ ok: false, error: "Game is not in progress." });
  if (!room.seats.some((s) => s.playerId === playerId))
    return ack({ ok: false, error: "Observers cannot act." });

  const error = await applyCommand(io, room, playerId, parsed.data.command, () => ack({ ok: true }));
  if (error) ack({ ok: false, error });
}

/** A Real-Time command that arrived after the deadline. */
export const TOO_LATE = "Time's up.";

/**
 * Apply one player's command — a human's, or the bot's — the way every
 * command is applied: server values, the Real-Time deadline, the rules,
 * persistence, per-recipient broadcast, the clock, and the bot's next turn.
 * Resolves to the refusal message, or null once applied (`onApplied` runs
 * just before the broadcast, so a human's ack arrives first).
 */
export async function applyCommand(
  io: IOServer,
  room: Room,
  playerId: string,
  command: GameCommand,
  onApplied?: () => void,
): Promise<string | null> {
  if (!room.game) return "No active game.";
  // A reroll is an intent: the server supplies the new (secret) dice values.
  // Same for Anticipation's single-die reroll.
  const rcmd = withEntropy(command, serverDice);

  // Real-Time: a command that arrives after the deadline (before the timeout
  // got to run) is too late — the round ends now instead.
  const endsAt = room.game.timerEndsAt;
  if (endsAt !== null && Date.now() >= endsAt) {
    await onTimeUp(io, room.id, endsAt);
    return TOO_LATE;
  }

  let game: GameState;
  try {
    // Node processes one event at a time, so commands for a room are naturally
    // serialized here — "simultaneous" inputs are simply ordered by arrival.
    game = settleNow(reduce(room.game, rcmd, playerId).state);
  } catch (e) {
    return e instanceof GameRuleError ? e.message : "Command rejected.";
  }
  room.game = game;
  room.version += 1;
  if (game.outcome) room.status = "finished";
  await saveRoom(room);

  onApplied?.();
  emitGameEvent(io, room, command, playerId);
  // On game end, also push a fresh room:state so the lobby/status UI updates.
  if (room.status === "finished") broadcastState(io, room);
  await syncClock(io, room);
  scheduleNpc(io, room.id);
  return null;
}

/** Supply what the reducer asked the server for (see shared `settle`): Traffic
 *  die rolls and the next round's dice, stamped with the clock for Real-Time. */
function settleNow(game: GameState): GameState {
  return settle(game, serverDice, Date.now);
}

/**
 * Real-Time: bring a room's countdown in line with its seats, then (re)arm the
 * timeout. The clock pauses while either seat is disconnected and resumes when
 * both are back; a pause/resume is a state change everyone is sent.
 */
async function syncClock(io: IOServer, room: Room): Promise<void> {
  clearClock(room.id);
  const game = room.game;
  if (!game || room.status !== "in_progress" || game.phase !== "placement" || !hasModule(game, "realTime")) return;

  const away = room.seats.some((s) => !s.connected);
  const now = Date.now();
  const change =
    away && game.timerEndsAt !== null ? ({ type: "pauseTimer", at: now } as const)
    : !away && game.timerRemainingMs !== null ? ({ type: "resumeTimer", at: now } as const)
    : null;
  if (change) {
    room.game = reduce(game, change, "").state;
    room.version += 1;
    await saveRoom(room);
    broadcastState(io, room);
  }

  const endsAt = room.game!.timerEndsAt;
  if (endsAt !== null) {
    clockTimers.set(room.id, setTimeout(() => void onTimeUp(io, room.id, endsAt), Math.max(0, endsAt - now)));
  }
}

function clearClock(roomId: string) {
  const t = clockTimers.get(roomId);
  if (t) {
    clearTimeout(t);
    clockTimers.delete(roomId);
  }
}

/** The countdown that ended at `endsAt` ran out: end the round (or the game). */
async function onTimeUp(io: IOServer, roomId: string, endsAt: number): Promise<void> {
  clockTimers.delete(roomId);
  const room = await getRoom(roomId);
  // Stale: the round already ended, the clock was paused, or a newer one runs.
  if (!room?.game || room.status !== "in_progress" || room.game.timerEndsAt !== endsAt) return;

  room.game = settleNow(reduce(room.game, { type: "timeUp" }, "").state);
  room.version += 1;
  if (room.game.outcome) room.status = "finished";
  await saveRoom(room);
  broadcastState(io, room);
  await syncClock(io, room);
  scheduleNpc(io, room.id); // the next round may open with the bot's turn
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
      serverTime: Date.now(),
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
  await syncClock(io, room); // Real-Time: pause while the seat is empty

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
  if (seat && !seat.connected && abandonsOnDisconnect(room)) {
    room.status = "abandoned";
    clearClock(roomId);
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
export function broadcastState(io: IOServer, room: Room, exceptSocketId?: string) {
  for (const sock of io.sockets.sockets.values()) {
    if (sock.data.roomId !== room.id || !sock.data.playerId) continue;
    if (exceptSocketId && sock.id === exceptSocketId) continue;
    sock.emit("room:state", toSnapshot(room, sock.data.playerId));
  }
}
