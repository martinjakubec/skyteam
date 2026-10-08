// "Fly the same dice": a room made from an earlier game's link plays that game's
// setup on its seed — the same Intern order, the same deal every round — and its
// games are logged as seeded from it (seeded_from), so statistics can leave them
// out. The host can drop the seed ("Use fresh dice") in the lobby.
import { afterAll, beforeAll, expect, test, vi } from "vitest";

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

let s;
beforeAll(async () => {
  s = await startServer();
});
afterAll(() => s.close());

const rowsOf = (roomId) => FakePg.last.games.filter((g) => g.room_id === roomId);
const firstDeal = (row) => /^D\d+/.exec(row.moves)[0];
const INTERN = { scenarioId: "YUL", modules: ["intern"], abilities: [] };

/** Start a game in the room and leave it at once; its row. */
async function playAndLeave(r) {
  const before = rowsOf(r.roomId).length;
  await s.start(r);
  expect(await emit(r.h, "game:exit")).toEqual({ ok: true });
  await until(() => rowsOf(r.roomId).length > before, 2000, "the row");
  return rowsOf(r.roomId).at(-1);
}

/** An earlier game (with the Intern, so its token order counts too). */
async function original() {
  const r = await s.room();
  expect(await emit(r.h, "room:setup", INTERN)).toEqual({ ok: true });
  return playAndLeave(r);
}

test("the same dice: the original's setup, Intern order and first deal; logged as seeded from it", async () => {
  const orig = await original();
  const r = await s.room({ sameDiceAs: orig.id });
  expect(latest(r.h).setup).toEqual(INTERN);
  expect(latest(r.h).sameDice).toEqual({ gameId: orig.id });
  const copy = await playAndLeave(r);
  expect(firstDeal(copy)).toBe(firstDeal(orig));
  expect(copy.intern_order).toBe(orig.intern_order);
  expect(copy).toMatchObject({ seeded_from: orig.id, seed: orig.seed });
  // Reset deals the same dice again (and that game is seeded too).
  await s.start(r);
  expect(await emit(r.h, "game:reset")).toEqual({ ok: true });
  await until(() => rowsOf(r.roomId).length === 2, 2000, "the reset row");
  expect(await emit(r.h, "game:exit")).toEqual({ ok: true });
  await until(() => rowsOf(r.roomId).length === 3, 2000, "the exit row");
  for (const row of rowsOf(r.roomId)) expect([firstDeal(row), row.seeded_from]).toEqual([firstDeal(orig), orig.id]);
});

test("the setup is locked until the host chooses fresh dice; then games are ordinary again", async () => {
  const orig = await original();
  const r = await s.room({ sameDiceAs: orig.id });
  expect(await emit(r.h, "room:setup", { scenarioId: "YUL", modules: [], abilities: [] })).toEqual({
    ok: false,
    error: "This room flies the same dice as an earlier game — use fresh dice to change the setup.",
  });
  expect(await emit(r.g, "room:freshDice")).toEqual({ ok: false, error: "Only the host can change the setup." });
  expect(await emit(r.h, "room:freshDice")).toEqual({ ok: true });
  await until(() => latest(r.g).sameDice === null, 2000, "fresh dice for the guest");
  expect(await emit(r.h, "room:setup", { scenarioId: "YUL", modules: [], abilities: [] })).toEqual({ ok: true });
  const row = await playAndLeave(r);
  expect(row.seeded_from).toBe(null);
  expect(row.seed).not.toBe(orig.seed);
});

test("fresh dice only in the lobby", async () => {
  const orig = await original();
  const r = await s.room({ sameDiceAs: orig.id });
  await s.start(r);
  expect(await emit(r.h, "room:freshDice")).toEqual({ ok: false, error: "The game has already started." });
});

test("solo on the same dice", async () => {
  const orig = await original();
  const r = await s.room({ sameDiceAs: orig.id, solo: { crew: "copilot" } });
  expect(latest(r.h).seats.some((x) => x.bot)).toBe(true);
  const copy = await playAndLeave(r);
  expect(firstDeal(copy)).toBe(firstDeal(orig));
  expect(copy.seeded_from).toBe(orig.id);
});

test("a game that can't be flown again: unknown, or logged before seeds", async () => {
  const unknown = await s.api("POST", "/rooms", { body: { sameDiceAs: "z".repeat(21) } });
  expect(unknown).toMatchObject({ status: 404, body: { error: "That game can't be flown again." } });
  const orig = await original();
  FakePg.last.games.find((g) => g.id === orig.id).seed = null;
  expect((await s.api("POST", "/rooms", { body: { sameDiceAs: orig.id } })).status).toBe(404);
  expect((await s.api("POST", "/rooms", { body: { sameDiceAs: 42 } })).status).toBe(400);
});

test("a red or black card can't be flown solo again", async () => {
  const r = await s.room();
  expect(await emit(r.h, "room:setup", { scenarioId: "red-TGU", modules: ["kerosene", "wind"], abilities: [] })).toMatchObject({ ok: true });
  const orig = await playAndLeave(r);
  const solo = await s.api("POST", "/rooms", { body: { sameDiceAs: orig.id, solo: { crew: "pilot" } } });
  expect(solo.status).toBe(400);
});

test("the seed never reaches a client", async () => {
  const orig = await original();
  const r = await s.room({ sameDiceAs: orig.id });
  await s.start(r);
  const seen = JSON.stringify([r.h.states, r.h.events, r.g.states, r.g.events]);
  expect(seen).not.toContain(orig.seed);
});
