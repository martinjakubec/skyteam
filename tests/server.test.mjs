// The game server end to end: its HTTP routes and socket events, driven over
// localhost by real clients, with Redis replaced by an in-memory fake.
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("ioredis", () => import("./support/fakeRedis.mjs"));
vi.mock("pg", () => import("./support/fakePg.mjs"));

// Read once when the server's env module loads: fast bots, short grace, 1 s Real-Time rounds.
Object.assign(process.env, {
  NPC_DELAY_MS: "5",
  NPC_THINK_MS: "60",
  NPC_WORKERS: "1",
  RECONNECT_GRACE_MS: "250",
  REAL_TIME_SECONDS: "1",
  DEBRIEF_COUNTDOWN_MS: "300", // the 3-2-1 between rounds, shortened
  DATABASE_URL: "postgres://fake/skyteam", // game logs go to the fake Postgres
  TRUST_PROXY: "1", // each test request names its own client address (rate limits are per address)
});

const http = await import("node:http");
const { io: connect } = await import("socket.io-client");
const { createApp } = await import("../packages/server/src/http.ts");
const { attachSocket } = await import("../packages/server/src/socket.ts");
const { stopThinking } = await import("../packages/server/src/think.ts");
const { issueToken } = await import("../packages/server/src/identity.ts");
const { default: FakeRedis } = await import("./support/fakeRedis.mjs");
const { Pool: FakePg } = await import("./support/fakePg.mjs");
const { initGameLogs, flushPendingGameLogs, PENDING_KEY } = await import("../packages/server/src/gameLog.ts");
const { actorFor, legalMoves, quickMove, mulberry32, newGame, reduce, replay, settleTraffic, randDice, withEntropy, LOG_FORMAT, MOVE_CODES, UNAVAILABLE, SOLO_RESTRICTED_NOTE, shuffledInternTokens } = await import("../packages/shared/src/index.ts");

let server, url;
const sockets = [];

beforeAll(async () => {
  server = http.createServer(createApp());
  attachSocket(server);
  await initGameLogs();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await stopThinking();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  FakeRedis.last.status = "ready";
  FakeRedis.last.failNext = null;
  FakePg.last.down = false;
});

/** The game-log rows written for a room, oldest first. */
const logged = (roomId) => FakePg.last.games.filter((row) => row.room_id === roomId);
/** A logged game replayed from its row. */
const replayRow = (row) =>
  replay({ format: row.format, setup: { scenarioId: row.scenario, modules: row.modules, abilities: row.abilities }, internTokens: [...row.intern_order].map(Number) }, row.moves);

// --- helpers -----------------------------------------------------------------

let nextAddress = 1;
const post = async (path, body, base = url, from = `10.0.${nextAddress >> 8}.${nextAddress++ & 255}`) => {
  const headers = { "content-type": "application/json", "x-forwarded-for": from };
  const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json() };
};

/** A connected client that keeps every room:state, game:event and chat:message,
 *  and the newest game (and its version) from either. */
async function client() {
  const sock = connect(url, { transports: ["websocket"], forceNew: true, reconnection: false });
  sockets.push(sock);
  sock.states = [];
  sock.events = [];
  sock.chat = [];
  sock.game = null;
  sock.version = -1;
  sock.on("room:state", (s) => (sock.states.push(s), (sock.game = s.game), (sock.version = s.version)));
  sock.on("game:event", (e) => (sock.events.push(e), (sock.game = e.game), (sock.version = e.version)));
  sock.on("chat:message", (m) => sock.chat.push(m));
  await new Promise((resolve, reject) => (sock.once("connect", resolve), sock.once("connect_error", reject)));
  return sock;
}

const emit = (sock, event, payload) =>
  new Promise((resolve) => (payload === undefined ? sock.emit(event, resolve) : sock.emit(event, payload, resolve)));

/** Wait until `pred` holds (polled; it may be async), or fail after `ms`. */
async function until(pred, ms = 5000, what = "condition") {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const latest = (sock) => sock.states.at(-1);

/** A host and a guest seated in a fresh room, both joined over sockets. */
async function twoPlayerRoom() {
  const host = await post("/rooms", {});
  const guest = await post(`/rooms/${host.body.inviteCode}/join`, {});
  const h = await client(), g = await client();
  expect(await emit(h, "room:join", { roomId: host.body.roomId, token: host.body.token, name: "  Ann  " })).toEqual({ ok: true });
  expect(await emit(g, "room:join", { roomId: guest.body.roomId, token: guest.body.token })).toEqual({ ok: true });
  return { h, g, roomId: host.body.roomId, invite: host.body.inviteCode, hostToken: host.body.token, guestToken: guest.body.token };
}

/** A two-player game in progress (pilot = host). */
async function startedGame(setup) {
  const r = await twoPlayerRoom();
  if (setup) expect(await emit(r.h, "room:setup", setup)).toEqual({ ok: true });
  await emit(r.h, "seat:ready", { ready: true });
  await emit(r.g, "seat:ready", { ready: true });
  expect(await emit(r.h, "game:start")).toEqual({ ok: true });
  await until(() => latest(r.h)?.status === "in_progress" && latest(r.g)?.status === "in_progress", 5000, "game start");
  return r;
}

/**
 * Play quick legal moves, each crew from its own (redacted) view, until `done()`
 * holds or the game stops. `socks` maps a crew to its socket; a crew without
 * one is the bot, which plays by itself. Between rounds nobody acts: it waits.
 */
let moveNo = 0;
async function playUntil(socks, done, rand = mulberry32(11)) {
  const all = Object.values(socks);
  for (let i = 0; i < 600 && !done(); i++) {
    if (latest(all[0]).status !== "in_progress") return;
    const crew = actorFor(all[0].game);
    const sock = crew && socks[crew];
    if (!sock) {
      await new Promise((r) => setTimeout(r, 20));
      continue;
    }
    const v = sock.version;
    expect(await emit(sock, "game:command", { commandId: `p${moveNo++}`, command: quickMove(sock.game, crew, rand) })).toEqual({ ok: true });
    await until(() => all.every((s) => s.version > v), 2000, "move broadcast");
    await new Promise((r) => setTimeout(r, 55)); // under the 20-events-a-second flood limit
  }
}

/** A two-player game played to its first debrief (a fresh game if the crew
 *  crashed in round 1). */
async function toDebrief(setup) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await startedGame(setup);
    await playUntil({ pilot: r.h, copilot: r.g }, () => !!latest(r.h).debrief);
    if (latest(r.h).debrief && latest(r.g).debrief) return r;
  }
  throw new Error("no round 1 survived");
}

/** Both crews press Ready; resolves once the next round's dice are dealt. */
async function bothReady({ h, g }) {
  expect(await emit(h, "round:ready", { ready: true })).toEqual({ ok: true });
  expect(await emit(g, "round:ready", { ready: true })).toEqual({ ok: true });
  await until(() => latest(h).debrief === null && latest(h).game.phase === "placement", 3000, "the deal");
}

/** The socket whose crew acts next, and a legal move for it. */
function nextMove({ h, g }) {
  const game = latest(h).game;
  const crew = actorFor(game);
  const sock = crew === "pilot" ? h : g;
  return { sock, crew, command: legalMoves(latest(sock).game, crew)[0] };
}

// --- HTTP ----------------------------------------------------------------------

describe("HTTP routes", () => {
  test("health reports the bot's search workers", async () => {
    const res = await fetch(url + "/health");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.botWorkers).toHaveProperty("of");
  });

  test("identity: a new token, the same one back when valid, a new one for garbage", async () => {
    const a = await post("/identity", {});
    expect(typeof a.body.token).toBe("string");
    expect(a.body.playerId).toBeTruthy();
    const b = await post("/identity", { token: a.body.token });
    expect(b.body).toEqual({ playerId: a.body.playerId, token: a.body.token });
    const c = await post("/identity", { token: "not-a-token" });
    expect(c.body.playerId).not.toBe(a.body.playerId);
  });

  test("creating a room returns its ids and keeps the caller's identity", async () => {
    const me = issueToken();
    const res = await post("/rooms", { token: me.token });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe(me.token);
    expect(res.body.roomId).toBeTruthy();
    expect(res.body.inviteCode).toHaveLength(8);
  });

  test("a solo request that doesn't parse is refused", async () => {
    const res = await post("/rooms", { solo: { crew: "navigator" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid solo game/);
  });

  test("joining: unknown code is 404, a second player gets the seat, rejoining is idempotent", async () => {
    expect((await post("/rooms/nope1234/join", {})).status).toBe(404);
    const host = await post("/rooms", {});
    const guest = await post(`/rooms/${host.body.inviteCode}/join`, {});
    expect(guest.status).toBe(200);
    expect(guest.body.roomId).toBe(host.body.roomId);
    const again = await post(`/rooms/${host.body.inviteCode}/join`, { token: guest.body.token });
    expect(again.body.token).toBe(guest.body.token);
  });

  test("past both seats, joiners watch; past 20 spectators the room is full (409)", async () => {
    const host = await post("/rooms", {});
    await post(`/rooms/${host.body.inviteCode}/join`, {});
    for (let i = 0; i < 20; i++) expect((await post(`/rooms/${host.body.inviteCode}/join`, {})).status).toBe(200);
    const full = await post(`/rooms/${host.body.inviteCode}/join`, {});
    expect(full.status).toBe(409);
    expect(full.body.error).toMatch(/full/);
  });

  test("storage down: room routes answer 500 'unavailable' at once", async () => {
    FakeRedis.last.status = "reconnecting";
    const res = await post("/rooms", {});
    expect(res.status).toBe(500);
    expect(res.body.code).toBe(UNAVAILABLE);
    expect((await post("/rooms/x/join", {})).body.code).toBe(UNAVAILABLE);
  });

  test("a failure inside a route becomes a 500, not a crash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    FakeRedis.last.failNext = new Error("connection lost");
    const res = await post("/rooms", {});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Server error." });
    FakeRedis.last.failNext = new Error("connection lost");
    expect((await post("/rooms/abcdefgh/join", {})).status).toBe(500);
    vi.mocked(console.error).mockRestore();
  });

  test("rate limits: the 21st room in a minute from one address is refused", async () => {
    // A fresh app has fresh limits.
    const own = http.createServer(createApp());
    await new Promise((r) => own.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${own.address().port}`;
    const statuses = [];
    for (let i = 0; i < 21; i++) statuses.push((await post("/rooms", {}, base, "10.9.9.9")).status);
    await new Promise((r) => own.close(r));
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  test("a room saved by an older build is upgraded as it loads", async () => {
    const me = issueToken();
    const legacy = {
      id: "legacy-room", inviteCode: "LEGACY01", hostPlayerId: me.playerId, status: "lobby",
      seats: [
        { playerId: me.playerId, role: "host", ready: false, connected: false },
        { playerId: "bot:old", role: "guest", ready: true, connected: true, bot: "cadet" },
      ],
      observers: [], version: 0, game: null, updatedAt: Date.now(),
    };
    FakeRedis.last.data.set("room:legacy-room", JSON.stringify(legacy));
    FakeRedis.last.data.set("invite:LEGACY01", "legacy-room");
    const res = await post("/rooms/LEGACY01/join", { token: me.token });
    expect(res.status).toBe(200);
    const s = await client();
    await emit(s, "room:join", { roomId: "legacy-room", token: me.token });
    await until(() => latest(s), 2000, "snapshot");
    expect(latest(s).setup).toEqual({ scenarioId: "YUL", modules: [], abilities: [] });
    expect(latest(s).hostCrew).toBe("pilot");
    expect(latest(s).seats[1].bot).toBe("aviator"); // retired levels fly as the Aviator
    expect(latest(s).chat).toEqual([]); // saved before the flight log existed

    // An airport that no longer exists falls back to the default.
    FakeRedis.last.data.set("room:gone-airport", JSON.stringify({ ...legacy, id: "gone-airport", setup: { scenarioId: "TURNS", modules: [] } }));
    await emit(s, "room:join", { roomId: "gone-airport", token: me.token });
    await until(() => latest(s).roomId === "gone-airport", 2000, "second snapshot");
    expect(latest(s).setup.scenarioId).toBe("YUL");
  });
});

// --- sockets: lobby --------------------------------------------------------------

describe("socket lobby", () => {
  test("join refusals: bad payload, bad token, unknown room, not a participant", async () => {
    const s = await client();
    expect((await emit(s, "room:join", { roomId: "" })).error).toBe("Invalid join payload.");
    expect((await emit(s, "room:join", { roomId: "x", token: "forged" })).error).toBe("Invalid identity token.");
    const me = issueToken();
    expect((await emit(s, "room:join", { roomId: "missing", token: me.token })).error).toBe("Room not found.");
    const room = await post("/rooms", {});
    expect((await emit(s, "room:join", { roomId: room.body.roomId, token: me.token })).error).toBe("You are not part of this room.");
  });

  test("before joining a room, every action is refused", async () => {
    const s = await client();
    for (const [event, payload] of [["seat:ready", { ready: true }], ["seat:name", { name: "x" }], ["chat:send", { text: "hi" }], ["round:ready", { ready: true }], ["room:setup", { scenarioId: "YUL", modules: [], abilities: [] }], ["game:start"], ["game:reset"], ["game:exit"]]) {
      expect((await emit(s, event, payload)).error, event).toBe("Not in a room.");
    }
    expect((await emit(s, "game:command", { commandId: "c", command: { type: "reroll", dieIds: [] } })).error).toBe("No active game.");
  });

  test("joining sends the joiner a snapshot (with their name) and tells the others", async () => {
    const { h, g } = await twoPlayerRoom();
    await until(() => latest(h)?.seats.length === 2 && latest(h).seats[1].connection === "connected", 2000, "guest seen");
    expect(latest(h).seats[0].name).toBe("Ann");
    expect(latest(h).you.role).toBe("host");
    expect(latest(g).you.role).toBe("guest");
  });

  test("ready: both ready makes the room ready; un-readying goes back to lobby", async () => {
    const { h, g } = await twoPlayerRoom();
    expect((await emit(h, "seat:ready", { ready: "yes" })).error).toBe("Invalid payload.");
    await emit(h, "seat:ready", { ready: true });
    await emit(g, "seat:ready", { ready: true });
    await until(() => latest(h).status === "ready", 2000, "ready");
    await emit(g, "seat:ready", { ready: false });
    await until(() => latest(h).status === "lobby", 2000, "lobby");
  });

  test("names: set and cleared in the lobby; too long is refused", async () => {
    const { h } = await twoPlayerRoom();
    expect(await emit(h, "seat:name", { name: "Captain" })).toEqual({ ok: true });
    await until(() => latest(h).seats[0].name === "Captain", 2000, "name");
    expect((await emit(h, "seat:name", { name: "x".repeat(200) })).ok).toBe(false);
    await emit(h, "seat:name", { name: "" });
    await until(() => latest(h).seats[0].name === undefined, 2000, "name cleared");
  });

  test("setup: host only, validated, and a change un-readies the guest", async () => {
    const { h, g } = await twoPlayerRoom();
    const kerosene = { scenarioId: "green-OSL", modules: ["kerosene"], abilities: [] };
    expect((await emit(g, "room:setup", kerosene)).error).toBe("Only the host can change the setup.");
    expect((await emit(h, "room:setup", { scenarioId: "nowhere", modules: [], abilities: [] })).ok).toBe(false);
    await emit(g, "seat:ready", { ready: true });
    expect(await emit(h, "room:setup", kerosene)).toEqual({ ok: true });
    await until(() => latest(g).setup.scenarioId === "green-OSL", 2000, "setup");
    expect(latest(g).seats[1].ready).toBe(false);
    // The same setup again changes nothing.
    expect(await emit(h, "room:setup", kerosene)).toEqual({ ok: true });
  });

  test("start: host only, and only once both are ready", async () => {
    const { h, g } = await twoPlayerRoom();
    expect((await emit(g, "game:start")).error).toBe("Only the host can start.");
    expect((await emit(h, "game:start")).error).toBe("Both players must be ready.");
    expect((await emit(h, "game:reset")).error).toBe("There is no game to reset.");
    expect((await emit(h, "game:exit")).error).toBe("There is no game to leave.");
  });

  test("spectators: can watch but not ready, rename, act or end the game", async () => {
    const { h, g, roomId, invite } = await startedGame();
    const watcher = await post(`/rooms/${invite}/join`, {});
    const w = await client();
    expect(await emit(w, "room:join", { roomId, token: watcher.body.token })).toEqual({ ok: true });
    await until(() => latest(w), 2000, "spectator snapshot");
    expect(latest(w).you.kind).toBe("observer");
    expect((await emit(w, "seat:ready", { ready: true })).error).toBe("The game has already started.");
    expect((await emit(w, "seat:name", { name: "Eve" })).error).toBe("Observers have no seat to name.");
    expect((await emit(w, "game:command", { commandId: "c", command: nextMove({ h, g }).command })).error).toBe("Observers cannot act.");
    expect((await emit(w, "game:exit")).error).toBe("Only the crew can end the game.");
  });
});

describe("socket lobby chat (flight log)", () => {
  test("a message reaches both players, tagged with its sender's crew", async () => {
    const { h, g } = await twoPlayerRoom();
    expect(await emit(g, "chat:send", { text: "  Shall we   try   Kerosene? " })).toEqual({ ok: true });
    await until(() => h.chat.length === 1 && g.chat.length === 1, 2000, "message");
    const m = h.chat[0];
    expect(m).toMatchObject({ text: "Shall we try Kerosene?", crew: "copilot", playerId: latest(g).you.playerId });
    expect(typeof m.id).toBe("string");
    expect(typeof m.at).toBe("number");
    expect(g.chat[0]).toEqual(m);
  });

  test("history comes with the snapshot, so a player who rejoins sees it", async () => {
    const { h, roomId, guestToken } = await twoPlayerRoom();
    await emit(h, "chat:send", { text: "first" });
    await emit(h, "chat:send", { text: "second" });
    const again = await client();
    await emit(again, "room:join", { roomId, token: guestToken });
    await until(() => latest(again), 2000, "snapshot");
    expect(latest(again).chat.map((m) => m.text)).toEqual(["first", "second"]);
    expect(latest(again).chat[0].crew).toBe("pilot");
  });

  test("only the last 50 messages are kept", async () => {
    const { h, roomId, hostToken } = await twoPlayerRoom();
    for (let i = 0; i < 53; i++) {
      expect(await emit(h, "chat:send", { text: `m${i}` })).toEqual({ ok: true });
      await new Promise((r) => setTimeout(r, 55)); // under the socket's 20 events/s
    }
    const again = await client();
    await emit(again, "room:join", { roomId, token: hostToken });
    await until(() => latest(again), 2000, "snapshot");
    const texts = latest(again).chat.map((m) => m.text);
    expect(texts).toHaveLength(50);
    expect(texts[0]).toBe("m3");
    expect(texts.at(-1)).toBe("m52");
  });

  test("empty, too long and malformed messages are refused", async () => {
    const { h } = await twoPlayerRoom();
    expect((await emit(h, "chat:send", { text: "   " })).error).toBe("Type a message first.");
    expect((await emit(h, "chat:send", { text: "x".repeat(201) })).error).toBe("A message is at most 200 characters.");
    expect((await emit(h, "chat:send", { text: 5 })).ok).toBe(false);
    expect(await emit(h, "chat:send", { text: "x".repeat(200) })).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.chat).toHaveLength(1);
  });

  test("spectators can't post, and the log closes while dice are placed", async () => {
    const { h, g, roomId, invite } = await startedGame();
    expect((await emit(h, "chat:send", { text: "mid-flight" })).error).toBe("Chat opens between rounds.");
    const watcher = await post(`/rooms/${invite}/join`, {});
    const w = await client();
    await emit(w, "room:join", { roomId, token: watcher.body.token });
    expect((await emit(w, "chat:send", { text: "hello" })).error).toBe("Spectators can't post in the flight log.");
    expect(h.chat).toHaveLength(0);
    expect(g.chat).toHaveLength(0);
  });
});

// --- sockets: a game -------------------------------------------------------------

describe("socket game", () => {
  test("mid-game: no renaming, no setup changes, no readying", async () => {
    const { h } = await startedGame();
    expect((await emit(h, "seat:name", { name: "Late" })).error).toBe("Names can only be changed in the lobby.");
    expect((await emit(h, "room:setup", { scenarioId: "YUL", modules: [], abilities: [] })).error).toBe("The game has already started.");
    expect((await emit(h, "seat:ready", { ready: false })).error).toBe("The game has already started.");
  });

  test("commands: a legal move reaches both players, redacted; bad ones are refused", async () => {
    const r = await startedGame();
    expect((await emit(r.h, "game:command", { commandId: "c0", command: { type: "teleport" } })).error).toBe("Invalid command.");
    const { sock, crew, command } = nextMove(r);
    const other = sock === r.h ? r.g : r.h;
    // The wrong crew can't play this move.
    expect((await emit(other, "game:command", { commandId: "c1", command })).ok).toBe(false);
    expect(await emit(sock, "game:command", { commandId: "c2", command })).toEqual({ ok: true });
    await until(() => r.h.events.length > 0 && r.g.events.length > 0, 2000, "game events");
    const [eh, eg] = [r.h.events.at(-1), r.g.events.at(-1)];
    expect(eh.version).toBe(1);
    expect(eh.command).toEqual(command);
    // Each sees their own unplaced dice; the other crew's are hidden.
    const otherCrew = crew === "pilot" ? "copilot" : "pilot";
    const view = sock === r.h ? eg : eh;
    expect(view.game.dice[crew].filter((d) => !d.placed).every((d) => d.hidden)).toBe(true);
    expect(view.game.dice[otherCrew].some((d) => !d.placed && !d.hidden)).toBe(true);
  });

  test("a game played to the end finishes the room", async () => {
    const r = await startedGame();
    const rand = mulberry32(7);
    // Round after round: play it, then both press Ready in the debrief.
    for (let round = 0; round < 12 && latest(r.h).status === "in_progress"; round++) {
      await playUntil({ pilot: r.h, copilot: r.g }, () => !!latest(r.h).debrief || latest(r.h).status !== "in_progress", rand);
      await until(() => !!latest(r.h).debrief || latest(r.h).status !== "in_progress", 2000, "debrief or the end");
      if (latest(r.h).debrief) await bothReady(r);
    }
    await until(() => latest(r.h).status === "finished", 2000, "finished");
    const end = latest(r.h).game;
    expect(end.outcome).toBeTruthy();
    // The game is logged once, and its moves replay to how it ended.
    await until(() => logged(r.roomId).length === 1, 2000, "the game's log row");
    const [row] = logged(r.roomId);
    expect(row).toMatchObject({
      format: LOG_FORMAT, scenario: "YUL", modules: [], abilities: [], intern_order: "", pilot: "human", copilot: "human",
      result: end.outcome.result, loss_reason: end.outcome.result === "lost" ? end.outcome.reason : null, rounds_reached: end.round,
    });
    expect(row.moves).toMatch(/^D\d{8}/);
    expect(new Date(row.ended_at) >= new Date(row.started_at)).toBe(true);
    const replayed = replayRow(row);
    expect(replayed.outcome).toEqual(end.outcome);
    expect(replayed.log).toEqual(end.log);
    // A finished game can be reset (host) or left: that logs nothing more.
    expect(await emit(r.h, "game:reset")).toEqual({ ok: true });
    await until(() => latest(r.g).status === "in_progress" && latest(r.g).version === 0, 2000, "reset");
    await new Promise((res) => setTimeout(res, 50));
    expect(logged(r.roomId)).toHaveLength(1);
  });

  test("reset: host only; exit: back to the lobby with a notice", async () => {
    const { h, g } = await startedGame();
    expect((await emit(g, "game:reset")).error).toBe("Only the host can reset the game.");
    expect(await emit(h, "game:reset")).toEqual({ ok: true });
    expect(await emit(g, "game:exit")).toEqual({ ok: true });
    await until(() => latest(h).status === "lobby", 2000, "lobby");
    expect(latest(h).notice).toBe("The Co-Pilot ended the game.");
    expect(latest(h).game).toBe(null);
    expect(latest(h).seats.every((s) => !s.ready)).toBe(true);
  });

  test("a player who drops and doesn't return in the grace period abandons the game", async () => {
    const { h, g } = await startedGame();
    g.disconnect();
    await until(() => latest(h).seats[1].connection === "disconnected", 2000, "disconnect seen");
    await until(() => latest(h).status === "abandoned", 3000, "abandoned");
  });

  test("a player who reconnects in time keeps the game going", async () => {
    const { h, g, roomId, guestToken } = await startedGame();
    g.disconnect();
    await until(() => latest(h).seats[1].connection === "disconnected", 2000, "disconnect seen");
    const back = await client();
    expect(await emit(back, "room:join", { roomId, token: guestToken })).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 400)); // past the grace period
    expect(latest(h).status).toBe("in_progress");
    expect(latest(back).game).toBeTruthy();
  });

  test("Real-Time: the clock pauses while a seat is empty, resumes, and ends the round at zero", async () => {
    const { h, g, roomId, guestToken } = await startedGame({ scenarioId: "YUL", modules: ["realTime"], abilities: [] });
    expect(latest(h).game.timerEndsAt).not.toBe(null);
    g.disconnect();
    await until(() => latest(h).game.timerRemainingMs !== null, 2000, "paused");
    const back = await client();
    await emit(back, "room:join", { roomId, token: guestToken });
    await until(() => latest(h).game.timerEndsAt !== null && latest(h).game.timerRemainingMs === null, 2000, "resumed");
    const round = latest(h).game.round;
    // 1 s rounds: time runs out and the round (or the game) ends.
    await until(() => latest(h).game?.round !== round || latest(h).status !== "in_progress", 4000, "time up");
  });
});

// --- sockets: between rounds (the debrief) ------------------------------------------

describe("socket debrief", () => {
  test("a round's end opens a debrief and holds the next dice back", async () => {
    const r = await toDebrief();
    expect(latest(r.h).debrief).toEqual({ round: 1, ready: { pilot: false, copilot: false }, countdownEndsAt: null });
    expect(latest(r.g).debrief).toEqual(latest(r.h).debrief);
    expect(r.h.game.phase).toBe("rolling");
    expect(r.h.game.round).toBe(2);
    expect(r.h.game.dice.pilot.every((d) => d.placed)).toBe(true); // the finished round stays on the board
    await new Promise((res) => setTimeout(res, 400));
    expect(r.h.game.phase).toBe("rolling"); // nothing is dealt on its own
    expect((await emit(r.h, "game:command", { commandId: "x", command: { type: "reroll", dieIds: [] } })).ok).toBe(false);
  });

  test("one Ready waits; both start the 3-2-1; the dice come when it ends", async () => {
    const r = await toDebrief();
    expect(await emit(r.h, "round:ready", { ready: "yes" })).toEqual({ ok: false, error: "Invalid payload." });
    expect(await emit(r.h, "round:ready", { ready: true })).toEqual({ ok: true });
    await until(() => latest(r.g).debrief?.ready.pilot === true, 2000, "pilot ready");
    expect(latest(r.g).debrief.countdownEndsAt).toBe(null);
    const asked = Date.now();
    expect(await emit(r.g, "round:ready", { ready: true })).toEqual({ ok: true });
    await until(() => latest(r.h).debrief?.countdownEndsAt != null, 2000, "countdown");
    const endsAt = latest(r.h).debrief.countdownEndsAt;
    expect(endsAt - asked).toBeGreaterThanOrEqual(250);
    expect(endsAt - asked).toBeLessThanOrEqual(1000);
    await until(() => latest(r.h).debrief === null, 3000, "the deal");
    expect(Date.now()).toBeGreaterThanOrEqual(endsAt - 20);
    expect(r.h.game.phase).toBe("placement");
    expect(r.h.game.dice.pilot.filter((d) => !d.placed)).toHaveLength(4);
    expect(r.g.game.dice.copilot.filter((d) => !d.placed)).toHaveLength(4);
  });

  test("Wait cancels the countdown", async () => {
    const r = await toDebrief();
    await emit(r.h, "round:ready", { ready: true });
    await emit(r.g, "round:ready", { ready: true });
    await until(() => latest(r.h).debrief?.countdownEndsAt != null, 2000, "countdown");
    expect(await emit(r.g, "round:ready", { ready: false })).toEqual({ ok: true });
    await until(() => latest(r.h).debrief?.countdownEndsAt === null, 2000, "cancelled");
    expect(latest(r.h).debrief.ready).toEqual({ pilot: true, copilot: false });
    await new Promise((res) => setTimeout(res, 500)); // past the old deadline
    expect(latest(r.h).debrief).not.toBe(null);
    expect(r.h.game.phase).toBe("rolling");
  });

  test("the flight log opens between rounds (lines tagged with the round) and closes at the deal", async () => {
    const r = await toDebrief();
    expect(await emit(r.g, "chat:send", { text: "Engines at 7 next time?" })).toEqual({ ok: true });
    await until(() => r.h.chat.length === 1, 2000, "message");
    expect(r.h.chat[0]).toMatchObject({ text: "Engines at 7 next time?", crew: "copilot", round: 1 });
    await emit(r.h, "round:ready", { ready: true });
    await emit(r.g, "round:ready", { ready: true });
    await until(() => latest(r.h).debrief?.countdownEndsAt != null, 2000, "countdown");
    expect(await emit(r.h, "chat:send", { text: "go" })).toEqual({ ok: true }); // still open during the 3-2-1
    await until(() => latest(r.h).debrief === null, 3000, "the deal");
    expect((await emit(r.h, "chat:send", { text: "too late" })).error).toBe("Chat opens between rounds.");
  });

  test("a seat that drops loses its Ready and stops the countdown; back and ready, the dice come", async () => {
    const r = await toDebrief();
    await emit(r.h, "round:ready", { ready: true });
    await emit(r.g, "round:ready", { ready: true });
    await until(() => latest(r.h).debrief?.countdownEndsAt != null, 2000, "countdown");
    r.g.disconnect();
    await until(() => latest(r.h).debrief?.countdownEndsAt === null, 2000, "countdown stopped");
    expect(latest(r.h).debrief.ready).toEqual({ pilot: true, copilot: false });
    const back = await client();
    expect(await emit(back, "room:join", { roomId: r.roomId, token: r.guestToken })).toEqual({ ok: true });
    await until(() => latest(back)?.debrief, 2000, "debrief on rejoin");
    await new Promise((res) => setTimeout(res, 400));
    expect(latest(r.h).debrief).not.toBe(null); // the pilot's Ready alone deals nothing
    await bothReady({ h: r.h, g: back });
  });

  test("spectators see the debrief but can't press Ready or chat; Ready outside a debrief is refused", async () => {
    const r = await toDebrief();
    const watcher = await post(`/rooms/${r.invite}/join`, {});
    const w = await client();
    await emit(w, "room:join", { roomId: r.roomId, token: watcher.body.token });
    await until(() => latest(w)?.debrief, 2000, "spectator sees the debrief");
    expect((await emit(w, "round:ready", { ready: true })).error).toBe("Spectators can't ready up.");
    expect((await emit(w, "chat:send", { text: "hi" })).error).toBe("Spectators can't post in the flight log.");
    await bothReady(r);
    expect((await emit(r.h, "round:ready", { ready: true })).error).toBe("Not between rounds.");
    const { h } = await twoPlayerRoom();
    expect((await emit(h, "round:ready", { ready: true })).error).toBe("Not between rounds.");
  });

  test("Reset and Exit end the debrief", async () => {
    const r = await toDebrief();
    expect(await emit(r.h, "game:reset")).toEqual({ ok: true });
    await until(() => latest(r.g).debrief === null && latest(r.g).game.round === 1, 2000, "reset");
    const r2 = await toDebrief();
    expect(await emit(r2.g, "game:exit")).toEqual({ ok: true });
    await until(() => latest(r2.h).status === "lobby", 2000, "lobby");
    expect(latest(r2.h).debrief).toBe(null);
  });

  test("Real-Time: no clock between rounds; it starts at the deal", async () => {
    // Place only the four mandatory dice and let the 1 s clock end the round:
    // the Axis dice as close as they come (no spin), the lowest on the Engines
    // (no speed into traffic).
    const r = await startedGame({ scenarioId: "YUL", modules: ["realTime"], abilities: [] });
    for (let i = 0; i < 4; i++) {
      const crew = actorFor(r.h.game);
      const sock = crew === "pilot" ? r.h : r.g;
      const kind = sock.game.axis[crew] === null ? "axis" : "engine";
      const theirs = sock.game.axis[crew === "pilot" ? "copilot" : "pilot"] ?? 3.5;
      const score = (d) => (kind === "axis" ? Math.abs(d.value - theirs) : d.value);
      const die = sock.game.dice[crew].filter((d) => !d.placed).reduce((a, b) => (score(b) < score(a) ? b : a));
      const move = { type: "placeDie", dieId: die.id, target: { kind } };
      const v = sock.version;
      expect(await emit(sock, "game:command", { commandId: `rt${i}`, command: move })).toEqual({ ok: true });
      await until(() => r.h.version > v && r.g.version > v, 2000, "move");
    }
    await until(() => !!latest(r.h).debrief, 4000, "time up");
    expect(r.h.game.timerEndsAt).toBe(null);
    await new Promise((res) => setTimeout(res, 1200)); // longer than a round: the debrief has no clock
    expect(latest(r.h).debrief).not.toBe(null);
    await bothReady(r);
    expect(r.h.game.timerEndsAt).toBeGreaterThan(Date.now());
  });

  test("solo: the bot is always ready, so the human's Ready starts the countdown", async () => {
    const room = await post("/rooms", { solo: { crew: "copilot", level: "aviator" } });
    for (let attempt = 0; attempt < 6; attempt++) {
      const s = await client();
      await emit(s, "room:join", { roomId: room.body.roomId, token: room.body.token });
      await until(() => latest(s), 2000, "snapshot");
      await emit(s, "seat:ready", { ready: true });
      await until(() => latest(s).status === "ready", 2000, "ready");
      expect(await emit(s, "game:start")).toEqual({ ok: true });
      await until(() => latest(s).status === "in_progress", 2000, "started");
      await playUntil({ copilot: s }, () => !!latest(s).debrief);
      if (!latest(s).debrief) {
        await emit(s, "game:exit");
        await until(() => latest(s).status === "lobby", 2000, "lobby");
        s.disconnect();
        continue;
      }
      expect(latest(s).debrief.ready).toEqual({ pilot: true, copilot: false });
      expect(await emit(s, "round:ready", { ready: true })).toEqual({ ok: true });
      await until(() => latest(s).debrief === null && latest(s).game.phase === "placement", 3000, "the deal");
      return;
    }
    throw new Error("no round 1 survived");
  });

  test("after a restart: a saved countdown is re-armed on rejoin; an old room stuck between rounds gets its debrief", async () => {
    // A game at the end of round 1, as a store saved it (built with the shared rules).
    const me = issueToken(), other = issueToken();
    const rand = mulberry32(21);
    const dice = randDice(rand);
    let game = newGame({ scenarioId: "YUL", modules: [], abilities: [] }, me.playerId, other.playerId, rand, Date.now());
    for (let i = 0; i < 40 && game.phase === "placement"; i++) {
      const crew = actorFor(game);
      const id = crew === "pilot" ? me.playerId : other.playerId;
      game = settleTraffic(reduce(game, withEntropy(quickMove(game, crew, rand), dice), id).state, dice);
    }
    expect(game.phase).toBe("rolling");
    const saved = (id, debrief) => ({
      id, inviteCode: `INV${id}`.slice(0, 8), hostPlayerId: me.playerId, status: "in_progress", hostCrew: "pilot",
      seats: [
        { playerId: me.playerId, role: "host", ready: true, connected: false },
        { playerId: other.playerId, role: "guest", ready: true, connected: false },
      ],
      observers: [], setup: { scenarioId: "YUL", modules: [], abilities: [] }, version: 9, game, chat: [], updatedAt: Date.now(),
      ...(debrief === undefined ? {} : { debrief }),
    });
    // The countdown's deadline passed while the server was down: the dice come on rejoin.
    FakeRedis.last.data.set("room:restart-1", JSON.stringify(saved("restart-1", { round: 1, ready: { pilot: true, copilot: true }, countdownEndsAt: Date.now() - 5 })));
    const s = await client();
    await emit(s, "room:join", { roomId: "restart-1", token: me.token });
    await until(() => latest(s)?.debrief === null && latest(s).game.phase === "placement", 3000, "dealt on rejoin");
    // Saved before debriefs existed: rejoining opens one.
    FakeRedis.last.data.set("room:restart-2", JSON.stringify(saved("restart-2")));
    await emit(s, "room:join", { roomId: "restart-2", token: me.token });
    await until(() => latest(s).roomId === "restart-2", 2000, "second room");
    expect(latest(s).debrief).toEqual({ round: 1, ready: { pilot: false, copilot: false }, countdownEndsAt: null });
  });
});

// --- game logs ------------------------------------------------------------------------

describe("game logs", () => {
  test("the code list is in the database", () => {
    expect(FakePg.last.moveCodes.map((c) => c.code)).toEqual(MOVE_CODES.map((c) => c.code));
    expect(FakePg.last.moveCodes[0].format).toBe(LOG_FORMAT);
  });

  test("Reset mid-game logs the old game as reset; Exit logs the new one as exited", async () => {
    const r = await startedGame({ scenarioId: "YUL", modules: ["intern"], abilities: [] });
    const { sock, command } = nextMove(r);
    await emit(sock, "game:command", { commandId: "lg1", command });
    expect(await emit(r.h, "game:reset")).toEqual({ ok: true });
    await until(() => logged(r.roomId).length === 1, 2000, "reset row");
    const [reset] = logged(r.roomId);
    expect(reset).toMatchObject({ result: "reset", loss_reason: null, rounds_reached: 1, modules: ["intern"] });
    expect(reset.intern_order).toMatch(/^[1-6]{6}$/);
    expect(reset.moves).toMatch(/^D\d{8}[PC]\d/); // the deal, then the move
    expect(replayRow(reset).placedThisRound).toBe(1);
    expect(await emit(r.g, "game:exit")).toEqual({ ok: true });
    await until(() => logged(r.roomId).length === 2, 2000, "exit row");
    expect(logged(r.roomId)[1]).toMatchObject({ result: "exited" });
    expect(logged(r.roomId)[1].id).not.toBe(reset.id);
  });

  test("a game left between rounds: both deals are in its log", async () => {
    const r = await toDebrief();
    await bothReady(r);
    expect(await emit(r.h, "game:exit")).toEqual({ ok: true });
    await until(() => logged(r.roomId).length === 1, 2000, "row");
    const [row] = logged(r.roomId);
    expect(row.moves.match(/D/g)).toHaveLength(2);
    expect(row.rounds_reached).toBe(2);
    expect(replayRow(row).round).toBe(2);
  });

  test("every game is seeded: the row has its seed, and the seed alone gives the logged deals and Intern order", async () => {
    const { newSeedState, seededRand } = await import("../packages/server/src/seededRand.ts");
    const r = await toDebrief({ scenarioId: "YUL", modules: ["intern"], abilities: [] });
    // While it runs, the seed is in the room record (a restarted server carries on) ...
    const stored = JSON.parse(await FakeRedis.last.get(`room:${r.roomId}`));
    expect(stored.seedState.seed).toMatch(/^[0-9a-f]{32}$/);
    await bothReady(r);
    expect(await emit(r.h, "game:exit")).toEqual({ ok: true });
    await until(() => logged(r.roomId).length === 1, 2000, "row");
    const [row] = logged(r.roomId);
    expect(row.seed).toBe(stored.seedState.seed);
    // ... and the seed regenerates what was dealt.
    const deals = row.moves.match(/D\d+/g);
    expect(deals).toHaveLength(2);
    deals.forEach((token, i) => {
      const dice = randDice(seededRand(newSeedState(row.seed), () => `d${i + 1}`));
      const expected = "D" + [...Array(8)].map(() => dice.d6()).join("") + [...Array(token.length - 9)].map(() => dice.traffic()).join("");
      expect(token).toBe(expected);
    });
    expect(row.intern_order).toBe(shuffledInternTokens(seededRand(newSeedState(row.seed), () => "i")).join(""));
    // ... but no player ever saw it.
    const seen = JSON.stringify([r.h.states, r.h.events, r.g.states, r.g.events]);
    expect(seen).not.toContain(row.seed);
  });

  test("a refused command draws nothing from the seed", async () => {
    const r = await startedGame(); // no Anticipation ability: anticipating is refused
    const before = JSON.parse(await FakeRedis.last.get(`room:${r.roomId}`)).seedState;
    const res = await emit(r.h, "game:command", { commandId: "x1", command: { type: "anticipate", dieId: 0 } });
    expect(res.ok).toBe(false);
    const { sock, command } = nextMove(r); // the next accepted command saves the room
    expect(await emit(sock, "game:command", { commandId: "x2", command })).toEqual({ ok: true });
    const after = JSON.parse(await FakeRedis.last.get(`room:${r.roomId}`)).seedState;
    expect(after.draws.p1 ?? 0).toBe(before.draws.p1 ?? 0);
  });

  test("each game gets its own seed (a reset too)", async () => {
    const r = await startedGame();
    expect(await emit(r.h, "game:reset")).toEqual({ ok: true });
    await until(() => logged(r.roomId).length === 1, 2000, "reset row");
    expect(await emit(r.g, "game:exit")).toEqual({ ok: true });
    await until(() => logged(r.roomId).length === 2, 2000, "exit row");
    const [a, b] = logged(r.roomId);
    expect(a.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(b.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(a.seed).not.toBe(b.seed);
  });

  test("a game abandoned by a player who never came back is logged as abandoned", async () => {
    const { h, g, roomId } = await startedGame();
    g.disconnect();
    await until(() => latest(h).status === "abandoned", 3000, "abandoned");
    await until(() => logged(roomId).length === 1, 2000, "row");
    expect(logged(roomId)[0].result).toBe("abandoned");
  });

  test("Postgres down: the row waits in Redis, and the retry writes it once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await startedGame();
    FakePg.last.down = true;
    expect(await emit(r.h, "game:exit")).toEqual({ ok: true });
    await until(async () => (await FakeRedis.last.llen(PENDING_KEY)) === 1, 2000, "queued");
    expect(logged(r.roomId)).toHaveLength(0);
    await flushPendingGameLogs(); // still down: it stays queued
    expect(await FakeRedis.last.llen(PENDING_KEY)).toBe(1);
    FakePg.last.down = false;
    await flushPendingGameLogs();
    await flushPendingGameLogs(); // nothing left: no duplicate
    expect(logged(r.roomId)).toHaveLength(1);
    expect(logged(r.roomId)[0].result).toBe("exited");
    expect(await FakeRedis.last.llen(PENDING_KEY)).toBe(0);
    vi.mocked(console.error).mockRestore();
  });
});

// --- sockets: the bot, abuse, outages ------------------------------------------------

describe("socket solo, limits, outages", () => {
  test("solo: the bot seat is ready, refuses red cards, and plays its own moves", async () => {
    const room = await post("/rooms", { solo: { crew: "copilot", level: "aviator" } });
    const s = await client();
    await emit(s, "room:join", { roomId: room.body.roomId, token: room.body.token });
    await until(() => latest(s), 2000, "snapshot");
    expect(latest(s).seats[1].bot).toBe("aviator");
    expect((await emit(s, "room:setup", { scenarioId: "red-HND", modules: ["kerosene", "intern"], abilities: [] })).error).toBe(SOLO_RESTRICTED_NOTE);
    await emit(s, "seat:ready", { ready: true });
    await until(() => latest(s).status === "ready", 2000, "ready");
    expect(await emit(s, "game:start")).toEqual({ ok: true });
    // The bot flies the pilot, who opens round 1.
    await until(() => s.events.some((e) => e.byPlayerId.startsWith("bot:")), 15000, "a bot move");
    // Exiting stops the bot; the bot's seat stays ready.
    expect(await emit(s, "game:exit")).toEqual({ ok: true });
    await until(() => latest(s).status === "lobby", 2000, "lobby");
    expect(latest(s).seats[1].ready).toBe(true);
    // Logged as left, with the bot in the Pilot's seat.
    await until(() => logged(room.body.roomId).length === 1, 2000, "log row");
    expect(logged(room.body.roomId)[0]).toMatchObject({ result: "exited", pilot: "bot:aviator", copilot: "human" });
  });

  test("a socket flooding events is slowed down", async () => {
    const { h } = await twoPlayerRoom();
    const acks = await Promise.all(Array.from({ length: 30 }, () => emit(h, "seat:ready", { ready: true })));
    expect(acks.filter((a) => a.error === "Too many requests — slow down.").length).toBeGreaterThan(0);
  });

  test("storage down: socket events answer 'unavailable'; a failure mid-handler answers 'server error'", async () => {
    const { h } = await twoPlayerRoom();
    FakeRedis.last.status = "end";
    expect((await emit(h, "seat:ready", { ready: true })).code).toBe(UNAVAILABLE);
    FakeRedis.last.status = "ready";
    vi.spyOn(console, "error").mockImplementation(() => {});
    FakeRedis.last.failNext = new Error("connection lost");
    expect(await emit(h, "seat:ready", { ready: true })).toEqual({ ok: false, error: "Server error." });
    vi.mocked(console.error).mockRestore();
  });

  test("a socket that never joined can disconnect quietly", async () => {
    const s = await client();
    s.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  });
});
