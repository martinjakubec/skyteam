// Game history: a signed-in player's seat remembers their account, and a game
// that ends links to the accounts that flew it (game_players). Guests' games
// are logged as before, tied to no one. Then the history and game-record API.
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("ioredis", () => import("./support/fakeRedis.mjs"));
vi.mock("pg", () => import("./support/fakePg.mjs"));
Object.assign(process.env, {
  NPC_DELAY_MS: "5",
  NPC_THINK_MS: "60",
  NPC_WORKERS: "1",
  DEBRIEF_COUNTDOWN_MS: "50",
  DATABASE_URL: "postgres://fake/skyteam",
  TRUST_PROXY: "1",
});

const { startServer, emit, until, latest } = await import("./support/harness.mjs");
const { Pool: FakePg } = await import("./support/fakePg.mjs");
const { default: FakeRedis } = await import("./support/fakeRedis.mjs");
const { flushPendingGameLogs, PENDING_KEY } = await import("../packages/server/src/gameLog.ts");

let s;
beforeAll(async () => {
  s = await startServer();
});
afterAll(() => s.close());

const rowsOf = (roomId) => FakePg.last.games.filter((g) => g.room_id === roomId);
const linksOf = (gameId) => FakePg.last.gamePlayers.filter((p) => p.game_id === gameId).sort((a, b) => a.crew.localeCompare(b.crew));

/** Start, then leave at once: a logged ("exited") game, quickly. */
async function quickGame(r) {
  await s.start(r);
  expect(await emit(r.h, "game:exit")).toEqual({ ok: true });
  await until(() => rowsOf(r.roomId).length > 0, 2000, "the row");
  return rowsOf(r.roomId).at(-1);
}

describe("seats and accounts", () => {
  test("a signed-in host and a guest: the game links to the host's account, as pilot", async () => {
    const alice = await s.signUp("alice");
    const r = await s.room({ hostCookie: alice.cookie });
    await s.start(r);
    await s.playToEnd(r);
    await until(() => rowsOf(r.roomId).length === 1, 2000, "the row");
    const [row] = rowsOf(r.roomId);
    expect(linksOf(row.id)).toEqual([{ game_id: row.id, user_id: alice.user.id, crew: "pilot" }]);
  });

  test("a signed-in player's seat shows their username until they choose a name", async () => {
    const bob = await s.signUp("bobby");
    const r = await s.room({ guestCookie: bob.cookie });
    await until(() => latest(r.h).seats.length === 2, 2000, "the guest's seat");
    const seat = latest(r.h).seats.find((x) => x.role === "guest");
    expect(seat.name).toBe("bobby");
  });

  test("two signed-in players: both links", async () => {
    const a = await s.signUp("carla");
    const b = await s.signUp("dario");
    const row = await quickGame(await s.room({ hostCookie: a.cookie, guestCookie: b.cookie }));
    expect(linksOf(row.id).map((l) => [l.crew, l.user_id])).toEqual([["copilot", b.user.id], ["pilot", a.user.id]]);
  });

  test("the same account in both seats (two tabs): two links", async () => {
    const a = await s.signUp("erika");
    const row = await quickGame(await s.room({ hostCookie: a.cookie, guestCookie: a.cookie }));
    expect(linksOf(row.id).map((l) => l.crew)).toEqual(["copilot", "pilot"]);
  });

  test("solo with the bot: only the human's link", async () => {
    const a = await s.signUp("fabio");
    const row = await quickGame(await s.room({ hostCookie: a.cookie, solo: { crew: "copilot" } }));
    expect(linksOf(row.id)).toEqual([{ game_id: row.id, user_id: a.user.id, crew: "copilot" }]);
  });

  test("guests: the game is logged, linked to no one", async () => {
    const row = await quickGame(await s.room());
    expect(row).toBeTruthy();
    expect(linksOf(row.id)).toEqual([]);
  });

  test("signed out and back in the room: the seat stays, the account link goes", async () => {
    const a = await s.signUp("gerda");
    const r = await s.room({ hostCookie: a.cookie });
    r.h.disconnect();
    const h2 = await s.client(); // no cookie now
    expect(await emit(h2, "room:join", { roomId: r.roomId, token: r.hostToken })).toEqual({ ok: true });
    r.h = h2;
    const row = await quickGame(r);
    expect(linksOf(row.id)).toEqual([]);
  });

  test("a disabled account is a guest when it rejoins", async () => {
    const a = await s.signUp("hanna");
    FakePg.last.users.find((u) => u.username === "hanna").disabled_at = new Date();
    const row = await quickGame(await s.room({ hostCookie: a.cookie }));
    expect(linksOf(row.id)).toEqual([]);
  });

  test("Postgres down when the game ends: the row and its links wait, and are written later", async () => {
    const a = await s.signUp("ines");
    const r = await s.room({ hostCookie: a.cookie });
    await s.start(r);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    FakePg.last.down = true;
    expect(await emit(r.h, "game:exit")).toEqual({ ok: true });
    await until(async () => (await FakeRedis.last.llen(PENDING_KEY)) === 1, 2000, "queued");
    FakePg.last.down = false;
    await flushPendingGameLogs();
    error.mockRestore();
    const [row] = rowsOf(r.roomId);
    expect(linksOf(row.id)).toEqual([{ game_id: row.id, user_id: a.user.id, crew: "pilot" }]);
  });

  test("an account deleted before its queued game is written: the game is written, unlinked", async () => {
    const a = await s.signUp("jonas");
    const r = await s.room({ hostCookie: a.cookie });
    await s.start(r);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    FakePg.last.down = true;
    await emit(r.h, "game:exit");
    await until(async () => (await FakeRedis.last.llen(PENDING_KEY)) === 1, 2000, "queued");
    FakePg.last.down = false;
    expect((await s.api("DELETE", "/api/account", { cookie: a.cookie, body: { password: "ten chars!" } })).status).toBe(204);
    await flushPendingGameLogs();
    error.mockRestore();
    const [row] = rowsOf(r.roomId);
    expect(row).toBeTruthy();
    expect(linksOf(row.id)).toEqual([]);
  });
});

describe("the history and game-record API", async () => {
  const { replay } = await import("../packages/shared/src/index.ts");

  /** A logged game row, written straight into the fake (with links). */
  function fakeGame({ id, endedAt, pilot = "human", copilot = "human", links = [], seed = "ab".repeat(16), seededFrom = null }) {
    FakePg.last.games.push({
      id, room_id: "r-" + id, format: 1, build: "dev", scenario: "YUL", modules: [], abilities: [], intern_order: "",
      pilot, copilot, result: "exited", loss_reason: null, rounds_reached: 1, moves: "D11112222", started_at: endedAt, ended_at: endedAt,
      seed, seeded_from: seededFrom,
    });
    for (const [crew, user_id] of links) FakePg.last.gamePlayers.push({ game_id: id, user_id, crew });
  }

  test("my games: newest first, with my seat, my partner and how it ended", async () => {
    const kim = await s.signUp("kimiko");
    const leo = await s.signUp("leonardo");
    fakeGame({ id: "k1".padEnd(21, "x"), endedAt: "2026-10-01T10:00:00.000Z", links: [["pilot", kim.user.id]] });
    fakeGame({ id: "k2".padEnd(21, "x"), endedAt: "2026-10-02T10:00:00.000Z", copilot: "bot:aviator", links: [["pilot", kim.user.id]] });
    fakeGame({ id: "k3".padEnd(21, "x"), endedAt: "2026-10-03T10:00:00.000Z", links: [["copilot", kim.user.id], ["pilot", leo.user.id]], seededFrom: "k1".padEnd(21, "x") });
    const r = await s.api("GET", "/api/me/games", { cookie: kim.cookie });
    expect(r.status).toBe(200);
    expect(r.body.next).toBe(null);
    expect(r.body.games.map((g) => [g.id.slice(0, 2), g.crew, g.partner, g.seeded])).toEqual([
      ["k3", "copilot", "leonardo", true],
      ["k2", "pilot", "Bot (aviator)", false],
      ["k1", "pilot", "Guest", false],
    ]);
    expect(r.body.games[0]).toMatchObject({ scenario: "YUL", modules: [], abilities: [], result: "exited", lossReason: null, roundsReached: 1, endedAt: "2026-10-03T10:00:00.000Z" });
    // Leo sees only his own game.
    expect((await s.api("GET", "/api/me/games", { cookie: leo.cookie })).body.games.map((g) => g.id.slice(0, 2))).toEqual(["k3"]);
  });

  test("my games: 20 a page, then the next page from the cursor", async () => {
    const m = await s.signUp("marta");
    for (let i = 0; i < 45; i++) fakeGame({ id: `m${String(i).padStart(2, "0")}`.padEnd(21, "x"), endedAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(), links: [["pilot", m.user.id]] });
    const ids = [];
    let next = "";
    for (let page = 0; page < 5 && next !== null; page++) {
      const r = await s.api("GET", `/api/me/games${next ? `?before=${encodeURIComponent(next)}` : ""}`, { cookie: m.cookie });
      expect(r.status).toBe(200);
      ids.push(r.body.games.length);
      next = r.body.next;
    }
    expect(ids).toEqual([20, 20, 5]);
    expect((await s.api("GET", "/api/me/games?before=garbage", { cookie: m.cookie })).status).toBe(400);
  });

  test("a guest has no history", async () => {
    expect(await s.api("GET", "/api/me/games")).toMatchObject({ status: 401, body: { error: "Please sign in." } });
  });

  test("a game's record: anyone with the link; it replays to its result; no seed, no room", async () => {
    const nora = await s.signUp("nora");
    const r = await s.room({ hostCookie: nora.cookie, solo: { crew: "pilot" } });
    await s.start(r);
    await s.playToEnd(r);
    await until(() => rowsOf(r.roomId).length === 1, 2000, "the row");
    const [row] = rowsOf(r.roomId);
    const res = await s.api("GET", `/api/games/${row.id}`);
    expect(res.status).toBe(200);
    const rec = res.body;
    expect(rec).toMatchObject({
      id: row.id, format: 1, setup: { scenarioId: "YUL", modules: [], abilities: [] }, moves: row.moves,
      result: row.result, roundsReached: row.rounds_reached, crews: { pilot: "nora", copilot: "Bot (aviator)" },
      sameDiceAvailable: true, seededFrom: null,
    });
    const text = JSON.stringify(rec);
    expect(text).not.toContain(row.seed);
    expect(text).not.toContain(r.roomId);
    expect(text).not.toMatch(/[0-9a-f]{32}/);
    const end = replay({ format: rec.format, setup: rec.setup, internTokens: rec.internTokens }, rec.moves);
    expect(end.outcome.result).toBe(row.result);
  });

  test("an unknown or malformed id: 404; a game logged before seeds can't be flown again", async () => {
    expect(await s.api("GET", `/api/games/${"z".repeat(21)}`)).toMatchObject({ status: 404, body: { error: "No game with that id." } });
    expect((await s.api("GET", "/api/games/..%2F..%2Fetc")).status).toBe(404);
    fakeGame({ id: "old".padEnd(21, "x"), endedAt: "2026-09-01T00:00:00.000Z", seed: null });
    expect((await s.api("GET", `/api/games/${"old".padEnd(21, "x")}`)).body).toMatchObject({ sameDiceAvailable: false, crews: { pilot: "Guest", copilot: "Guest" } });
  });
});
