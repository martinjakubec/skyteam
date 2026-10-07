import type http from "node:http";
import { randomInt } from "node:crypto";
import { Server, type DefaultEventsMap, type Socket } from "socket.io";
import { nanoid } from "nanoid";
import {
  ChatSendPayload,
  GameCommandPayload,
  GameRuleError,
  JoinRoomPayload,
  MAX_CHAT_HISTORY,
  PlayerName,
  SetNamePayload,
  SetReadyPayload,
  SetSetupPayload,
  SOLO_RESTRICTED_NOTE,
  soloAllowed,
  hasModule,
  newGame,
  randDice,
  redactGameStateFor,
  reduce,
  settle,
  settleTraffic,
  withEntropy,
  type ChatMessage,
  type ClientToServerEvents,
  type Crew,
  type Dice,
  type GameCommand,
  type GameState,
  type PublicUser,
  type Rand,
  type ServerToClientEvents,
  type SocketData,
} from "@skyteam/shared";
import { env } from "./env";
import { corsOptions } from "./cors";
import { getRoom, saveRoom, storageUp, UNAVAILABLE_ERROR } from "./store";
import { toSnapshot } from "./snapshot";
import { verifyToken } from "./identity";
import { cancelNpc, scheduleNpc } from "./npc";
import { abandonsOnDisconnect, botSeat, canRename, crewOf, lobbyStatus, seatCrews, unreadyOthers } from "./seating";
import { guard, rateLimiter, SERVER_ERROR, type Ack } from "./guard";
import type { Room } from "./types";
import { endGameLog, recorder, startGameLog } from "./gameLog";
import { newSeedState, seededRand } from "./seededRand";
import { readCookie, SESSION_COOKIE, sessionUser } from "./sessions";

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

/**
 * Between rounds: each room's running 3-2-1, keyed by room id. The deadline
 * lives in the room (`debrief.countdownEndsAt`); this is the timeout that deals
 * at it. `syncDebrief` re-arms it on (re)join, which also covers a restart.
 */
const debriefTimers = new Map<string, NodeJS.Timeout>();

/** Events one socket may send per second. A player sends a few at most; past
 *  this, events are refused (each costs a Redis write and a broadcast). */
const SOCKET_EVENTS_PER_SECOND = 20;
/** Largest message a client may send. Real ones are well under 1 KB. */
const MAX_MESSAGE_BYTES = 16_000;

/** Log a failure in work nobody awaits (a timer, a disconnect) instead of
 *  letting the rejection end the process. */
export const logFailure = (what: string) => (e: unknown) => console.error(`[server] ${what} failed:`, e);

export function attachSocket(server: http.Server): IOServer {
  const io: IOServer = new Server(server, {
    cors: corsOptions,
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
  });

  io.on("connection", (socket) => {
    // Every handler is guarded: a missing ack, a throw or a flood can't crash the
    // server. While Redis is down nothing could be saved: refuse up front, and
    // answer a failure as "unavailable" so the client shows its 500 page.
    const allow = rateLimiter(SOCKET_EVENTS_PER_SECOND, 1000);
    const on = (event: keyof ClientToServerEvents, handle: (payload: unknown, ack: Ack) => Promise<void>) =>
      socket.on(
        event,
        guard(
          (payload, ack) => (storageUp() ? handle(payload, ack) : Promise.resolve(ack(UNAVAILABLE_ERROR))),
          () => allow(socket.id),
          event,
          () => (storageUp() ? SERVER_ERROR : UNAVAILABLE_ERROR),
        ),
      );
    on("room:join", (payload, ack) => onJoin(io, socket, payload, ack));
    on("seat:ready", (payload, ack) => onReady(io, socket, payload, ack));
    on("seat:name", (payload, ack) => onName(io, socket, payload, ack));
    on("room:setup", (payload, ack) => onSetup(io, socket, payload, ack));
    on("chat:send", (payload, ack) => onChat(io, socket, payload, ack));
    on("round:ready", (payload, ack) => onRoundReady(io, socket, payload, ack));
    on("game:start", (_payload, ack) => onStart(io, socket, ack));
    on("game:reset", (_payload, ack) => onReset(io, socket, ack));
    on("game:exit", (_payload, ack) => onExit(io, socket, ack));
    on("game:command", (payload, ack) => onCommand(io, socket, payload, ack));
    socket.on("disconnect", () => void onDisconnect(io, socket).catch(logFailure("disconnect")));
  });

  return io;
}

// --- handlers ---------------------------------------------------------------

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
  if (seat) {
    seat.connected = true;
    // Signed in (the cookie on this socket), the seat is linked to the account
    // as it is now; signed out, it's a guest's again.
    const account = await accountOf(socket);
    if (account) Object.assign(seat, { accountId: account.id, username: account.username });
    else {
      delete seat.accountId;
      delete seat.username;
    }
    // The name the player kept from earlier rooms; a bad one is just ignored.
    const name = PlayerName.safeParse(parsed.data.name);
    if (name.success && name.data && canRename(room)) seat.name = name.data;
  }
  openDebrief(room); // a room saved between rounds by an older build
  await saveRoom(room);

  ack({ ok: true });
  // Full resync to the (re)joining client; lobby update to everyone else.
  socket.emit("room:state", toSnapshot(room, playerId));
  broadcastState(io, room, socket.id);
  await syncClock(io, room); // Real-Time: resume once both seats are back
  await syncDebrief(io, room); // after a server restart, the 3-2-1 picks up where it was
  scheduleNpc(io, room.id); // after a server restart, the bot picks up where it was
}

/** The account this socket is signed in with (its handshake's cookie), or null.
 *  A database hiccup makes a guest, not a failed join. */
async function accountOf(socket: IOSocket): Promise<PublicUser | null> {
  try {
    return await sessionUser(readCookie(socket.handshake.headers.cookie, SESSION_COOKIE));
  } catch (e) {
    console.error("[accounts] reading a socket's session failed:", (e as Error).message);
    return null;
  }
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

/** A seated player renames themselves — in the lobby only, never mid-game. */
async function onName(io: IOServer, socket: IOSocket, payload: unknown, ack: Ack) {
  const parsed = SetNamePayload.safeParse(payload);
  if (!parsed.success) return ack({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid name." });

  const { room, playerId } = await context(socket);
  if (!room) return ack({ ok: false, error: "Not in a room." });
  const seat = room.seats.find((s) => s.playerId === playerId);
  if (!seat) return ack({ ok: false, error: "Observers have no seat to name." });
  if (!canRename(room)) return ack({ ok: false, error: "Names can only be changed in the lobby." });

  seat.name = parsed.data.name || undefined;
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
  // The bot flies green and yellow cards only: red and black are for human crews.
  if (room.seats.some((s) => s.bot) && !soloAllowed(parsed.data.scenarioId))
    return ack({ ok: false, error: SOLO_RESTRICTED_NOTE });

  if (JSON.stringify(parsed.data) !== JSON.stringify(room.setup)) {
    room.setup = parsed.data;
    room.seats = unreadyOthers(room.seats, playerId);
    room.status = lobbyStatus(room.seats); // a solo room (host + bot) stays ready
    await saveRoom(room);
  }

  ack({ ok: true });
  broadcastState(io, room);
}

/** A seated player posts to the lobby's flight log; everyone in the room gets it. */
async function onChat(io: IOServer, socket: IOSocket, payload: unknown, ack: Ack) {
  const parsed = ChatSendPayload.safeParse(payload);
  if (!parsed.success) return ack({ ok: false, error: parsed.error.issues[0]?.message ?? "Invalid message." });

  const { room, playerId } = await context(socket);
  if (!room) return ack({ ok: false, error: "Not in a room." });
  const seat = room.seats.find((s) => s.playerId === playerId);
  if (!seat) return ack({ ok: false, error: "Spectators can't post in the flight log." });
  if (room.status !== "lobby" && room.status !== "ready" && !room.debrief)
    return ack({ ok: false, error: "Chat opens between rounds." });

  const hostCrew = room.hostCrew ?? "pilot";
  const msg: ChatMessage = {
    id: nanoid(),
    playerId,
    crew: seat.role === "host" ? hostCrew : hostCrew === "pilot" ? "copilot" : "pilot",
    text: parsed.data.text,
    at: Date.now(),
    ...(room.debrief ? { round: room.debrief.round } : {}),
  };
  room.chat = [...(room.chat ?? []), msg].slice(-MAX_CHAT_HISTORY);
  await saveRoom(room);

  ack({ ok: true });
  for (const sock of io.sockets.sockets.values()) {
    if (sock.data.roomId === room.id && sock.data.playerId) sock.emit("chat:message", msg);
  }
}

/** Between rounds, a seated player is ready for the next dice (or takes it
 *  back). Both ready starts the 3-2-1; taking it back stops it. */
async function onRoundReady(io: IOServer, socket: IOSocket, payload: unknown, ack: Ack) {
  const parsed = SetReadyPayload.safeParse(payload);
  if (!parsed.success) return ack({ ok: false, error: "Invalid payload." });

  const { room, playerId } = await context(socket);
  if (!room) return ack({ ok: false, error: "Not in a room." });
  const crew = room.game ? crewOfGame(room, playerId) : null;
  if (!room.seats.some((s) => s.playerId === playerId)) return ack({ ok: false, error: "Spectators can't ready up." });
  if (!room.debrief || !crew) return ack({ ok: false, error: "Not between rounds." });

  const debrief = room.debrief;
  debrief.ready = { ...debrief.ready, [crew]: parsed.data.ready };
  const both = debrief.ready.pilot && debrief.ready.copilot;
  if (both && debrief.countdownEndsAt === null) debrief.countdownEndsAt = Date.now() + env.DEBRIEF_COUNTDOWN_MS;
  if (!both) debrief.countdownEndsAt = null;
  await saveRoom(room);

  ack({ ok: true });
  broadcastState(io, room);
  await syncDebrief(io, room);
}

async function onStart(io: IOServer, socket: IOSocket, ack: Ack) {
  const { room, playerId } = await context(socket);
  if (!room) return ack({ ok: false, error: "Not in a room." });
  if (room.hostPlayerId !== playerId) return ack({ ok: false, error: "Only the host can start." });
  if (room.status !== "ready") return ack({ ok: false, error: "Both players must be ready." });

  const { pilotId, copilotId } = seatCrews(room);

  room.status = "in_progress";
  room.notice = null;
  room.debrief = null;
  // Deal the game and roll round 1. Randomness lives on the server, never in
  // the pure reducer — rolled values are threaded in via a `roll` command.
  dealNewGame(room, pilotId, copilotId);
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
  clearDebrief(room.id);
  if (room.status === "in_progress") endGameLog(room, "reset"); // a finished game is logged already
  room.debrief = null;
  room.status = "in_progress";
  dealNewGame(room, pilotId, copilotId);
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
  clearDebrief(room.id);
  if (room.status === "in_progress") endGameLog(room, "exited"); // a finished game is logged already
  room.debrief = null;
  room.status = "lobby";
  room.game = null;
  room.version = 0;
  room.seats = unreadyOthers(room.seats, null); // a bot seat stays ready
  room.notice = `The ${crewOf(room, playerId) === "pilot" ? "Pilot" : "Co-Pilot"} ended the game.`;
  await saveRoom(room);

  ack({ ok: true });
  broadcastState(io, room);
}

/** Unseeded entropy: a game an older build began (it has no seed) rolls from it. */
const rand: Rand = (n) => randomInt(0, n);
const serverDice = randDice(rand);

/**
 * The room's dice. Every game is seeded (seededRand.ts): each round's deal
 * draws from its own stream, and so does everything else rolled in a round
 * (rerolls, Traffic dice) — so the same seed deals the same dice every round,
 * whatever the crews did.
 */
function gameDice(room: Room): { deal: Dice; play: Dice } {
  const s = room.seedState;
  if (!s) return { deal: serverDice, play: serverDice };
  const round = () => room.game?.round ?? 1;
  return { deal: randDice(seededRand(s, () => `d${round()}`)), play: randDice(seededRand(s, () => `p${round()}`)) };
}

/** A new game in the room, on a new seed: its log begins, the Intern tokens
 *  are shuffled and round 1 is dealt. */
function dealNewGame(room: Room, pilotId: string, copilotId: string): void {
  const s = (room.seedState = newSeedState());
  startGameLog(room);
  room.game = newGame(room.setup, pilotId, copilotId, seededRand(s, () => "d1"), Date.now(), {
    realTimeSeconds: env.REAL_TIME_SECONDS,
    record: recorder(room),
    internRand: seededRand(s, () => "i"),
  });
}

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
  const dice = gameDice(room);
  // A refused command takes back what it drew, so the seed's streams follow
  // only the commands the game kept (the log replays those).
  const drawn = room.seedState ? { ...room.seedState.draws } : null;
  const undraw = () => {
    if (room.seedState && drawn) room.seedState.draws = drawn;
  };
  const rcmd = withEntropy(command, dice.play);

  // Real-Time: a command that arrives after the deadline (before the timeout
  // got to run) is too late — the round ends now instead.
  const endsAt = room.game.timerEndsAt;
  if (endsAt !== null && Date.now() >= endsAt) {
    undraw();
    await onTimeUp(io, room.id, endsAt);
    return TOO_LATE;
  }

  let game: GameState;
  const record = recorder(room);
  try {
    // Node processes one event at a time, so commands for a room are naturally
    // serialized here — "simultaneous" inputs are simply ordered by arrival.
    const before = room.game;
    game = reduce(before, rcmd, playerId).state;
    record(before, rcmd, crewOfGame(room, playerId));
    game = settleTraffic(game, dice.play, record);
  } catch (e) {
    undraw();
    return e instanceof GameRuleError ? e.message : "Command rejected.";
  }
  room.game = game;
  room.version += 1;
  if (game.outcome) {
    room.status = "finished";
    endGameLog(room, game.outcome.result);
  }
  openDebrief(room);
  await saveRoom(room);

  onApplied?.();
  emitGameEvent(io, room, command, playerId);
  // On game end or a round's end, also push a fresh room:state so the
  // status UI (or the debrief) updates.
  if (room.status === "finished" || room.debrief) broadcastState(io, room);
  await syncClock(io, room);
  scheduleNpc(io, room.id);
  return null;
}

/** The crew a seated player flies in the room's game. */
function crewOfGame(room: Room, playerId: string): Crew | null {
  if (room.game?.pilotId === playerId) return "pilot";
  if (room.game?.copilotId === playerId) return "copilot";
  return null;
}

/**
 * A round ended and the game goes on: open the debrief. The board stays as the
 * round left it, the crew may chat, and the next dice wait for both crews'
 * Ready (a bot seat is always ready). Does nothing if one is already open.
 */
function openDebrief(room: Room): void {
  const game = room.game;
  if (room.debrief || room.status !== "in_progress" || !game || game.phase !== "rolling" || game.outcome) return;
  const bot = botSeat(room);
  const botCrew = bot ? crewOfGame(room, bot.playerId) : null;
  room.debrief = {
    round: game.round - 1,
    ready: { pilot: botCrew === "pilot", copilot: botCrew === "copilot" },
    countdownEndsAt: null,
  };
}

/** Arm the room's 3-2-1 if one runs (a deadline already past deals at once). */
async function syncDebrief(io: IOServer, room: Room): Promise<void> {
  clearDebrief(room.id);
  const endsAt = room.debrief?.countdownEndsAt;
  if (endsAt == null) return;
  debriefTimers.set(room.id, setTimeout(() => void deal(io, room.id, endsAt).catch(logFailure("deal")), Math.max(0, endsAt - Date.now())));
}

function clearDebrief(roomId: string) {
  const t = debriefTimers.get(roomId);
  if (t) {
    clearTimeout(t);
    debriefTimers.delete(roomId);
  }
}

/** The 3-2-1 that ends at `endsAt` ran out: deal the next round's dice. */
async function deal(io: IOServer, roomId: string, endsAt: number): Promise<void> {
  debriefTimers.delete(roomId);
  const room = await getRoom(roomId);
  // Stale: cancelled, restarted, or the game moved on.
  if (!room?.game || room.status !== "in_progress" || room.debrief?.countdownEndsAt !== endsAt) return;

  const dice = gameDice(room);
  const record = recorder(room);
  room.game = settle(settleTraffic(room.game, dice.play, record), dice.deal, Date.now, record);
  room.debrief = null;
  room.version += 1;
  await saveRoom(room);
  broadcastState(io, room);
  await syncClock(io, room); // Real-Time: the clock starts with the dice
  scheduleNpc(io, room.id); // the bot may lead the new round
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
    clockTimers.set(room.id, setTimeout(() => void onTimeUp(io, room.id, endsAt).catch(logFailure("time-up")), Math.max(0, endsAt - now)));
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

  const record = recorder(room);
  const before = room.game;
  room.game = reduce(before, { type: "timeUp" }, "").state;
  record(before, { type: "timeUp" }, null);
  room.game = settleTraffic(room.game, gameDice(room).play, record);
  room.version += 1;
  if (room.game.outcome) {
    room.status = "finished";
    endGameLog(room, room.game.outcome.result);
  }
  openDebrief(room);
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
  // Between rounds: whoever left isn't ready any more, and the 3-2-1 stops.
  const crew = crewOfGame(room, playerId);
  if (room.debrief && crew) {
    room.debrief.ready = { ...room.debrief.ready, [crew]: false };
    room.debrief.countdownEndsAt = null;
    clearDebrief(room.id);
  }
  await saveRoom(room);
  broadcastState(io, room);
  await syncClock(io, room); // Real-Time: pause while the seat is empty

  // Hold the seat for a grace period, then abandon if still gone.
  clearGrace(roomId, playerId);
  const timer = setTimeout(() => void abandonIfStillGone(io, roomId, playerId).catch(logFailure("grace timeout")), env.RECONNECT_GRACE_MS);
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
    clearDebrief(roomId);
    endGameLog(room, "abandoned");
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
