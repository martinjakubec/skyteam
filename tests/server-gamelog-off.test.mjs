// Game logs with no database configured (no DATABASE_URL): the server says so
// once at startup, and games end without writing or queueing anything.
import { expect, test, vi } from "vitest";

vi.mock("ioredis", () => import("./support/fakeRedis.mjs"));
vi.mock("pg", () => import("./support/fakePg.mjs"));
delete process.env.DATABASE_URL;

const { default: FakeRedis } = await import("./support/fakeRedis.mjs");
const { Pool: FakePg } = await import("./support/fakePg.mjs");
const { initGameLogs, startGameLog, endGameLog, flushPendingGameLogs, PENDING_KEY } = await import("../packages/server/src/gameLog.ts");
const { createRoom } = await import("../packages/server/src/rooms.ts");
const { newGame, mulberry32 } = await import("../packages/shared/src/index.ts");

test("without DATABASE_URL: a warning at startup, and nothing written or queued", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await initGameLogs();
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/DATABASE_URL/));
  expect(FakePg.last).toBe(null);

  const room = await createRoom("human");
  startGameLog(room);
  room.game = newGame(room.setup, "human", "guest", mulberry32(1), Date.now());
  room.status = "in_progress";
  endGameLog(room, "exited");
  expect(room.gameLog).toBe(null);
  await flushPendingGameLogs();
  expect(await FakeRedis.last.llen(PENDING_KEY)).toBe(0);
});
