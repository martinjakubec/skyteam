// The bot seat's turn loop when things go wrong: the bot finds no move, its
// moves keep being refused, the game moves on while it thinks, or its turn is
// cancelled. Its search is replaced by a script; Redis by an in-memory fake.
import { afterAll, beforeAll, expect, test, vi } from "vitest";

vi.mock("ioredis", () => import("./support/fakeRedis.mjs"));
vi.mock("../packages/server/src/think.ts", () => ({ think: vi.fn() }));

process.env.NPC_DELAY_MS = "5";

const http = await import("node:http");
const { attachSocket } = await import("../packages/server/src/socket.ts");
const { scheduleNpc, cancelNpc } = await import("../packages/server/src/npc.ts");
const { think } = await import("../packages/server/src/think.ts");
const { createRoom } = await import("../packages/server/src/rooms.ts");
const { getRoom, saveRoom } = await import("../packages/server/src/store.ts");
const { actorFor, newGame, settle, randDice, mulberry32 } = await import("../packages/shared/src/index.ts");

let server, io;
beforeAll(() => {
  server = http.createServer();
  io = attachSocket(server);
});
afterAll(() => io.close());

/** A solo game in progress whose bot leads round 1. */
async function botToMove() {
  const room = await createRoom("human", { crew: "copilot", level: "aviator" });
  const bot = room.seats[1].playerId;
  const r = mulberry32(9);
  room.game = settle(newGame(room.setup, bot, "human", r, Date.now()), randDice(r), Date.now);
  room.status = "in_progress";
  await saveRoom(room);
  expect(actorFor(room.game)).toBe("pilot"); // the bot's crew
  return room;
}
const statusOf = async (id) => (await getRoom(id)).status;
const until = async (pred, ms = 2000) => {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

test("no legal move: the bot gives up and the game is abandoned", async () => {
  quiet();
  think.mockReset().mockResolvedValue(null);
  const room = await botToMove();
  scheduleNpc(io, room.id, 0);
  await until(async () => (await statusOf(room.id)) === "abandoned");
  expect(think).toHaveBeenCalledTimes(1);
});

test("three refused moves in a row: the bot gives up", async () => {
  quiet();
  think.mockReset().mockResolvedValue({ type: "placeDie", dieId: 99, target: { kind: "axis", side: "pilot" } });
  const room = await botToMove();
  scheduleNpc(io, room.id, 0);
  await until(async () => (await statusOf(room.id)) === "abandoned");
  expect(think).toHaveBeenCalledTimes(3);
});

test("the game moved on while the bot thought: it thinks again on the new board", async () => {
  quiet();
  const room = await botToMove();
  think.mockReset()
    .mockImplementationOnce(async () => {
      room.game = { ...room.game }; // someone else's change replaced the game
      return null;
    })
    .mockResolvedValue(null);
  scheduleNpc(io, room.id, 0);
  await until(async () => (await statusOf(room.id)) === "abandoned");
  expect(think).toHaveBeenCalledTimes(2);
});

test("a legal move is played and the bot keeps its seat", async () => {
  const room = await botToMove();
  const crew = "pilot";
  const die = room.game.dice[crew].find((d) => !d.placed);
  think.mockReset().mockResolvedValueOnce({ type: "placeDie", dieId: die.id, target: { kind: "axis", side: crew } }).mockResolvedValue(null);
  quiet();
  scheduleNpc(io, room.id, 0);
  await until(async () => (await getRoom(room.id)).version >= 1);
  expect((await getRoom(room.id)).game.axis.pilot).toBe(die.value);
});

test("a cancelled turn never runs; scheduling twice keeps one timer", async () => {
  think.mockReset().mockResolvedValue(null);
  const room = await botToMove();
  scheduleNpc(io, room.id, 20);
  scheduleNpc(io, room.id, 20);
  cancelNpc(room.id);
  await new Promise((r) => setTimeout(r, 60));
  expect(think).not.toHaveBeenCalled();
  expect(await statusOf(room.id)).toBe("in_progress");
});
