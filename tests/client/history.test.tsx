// @vitest-environment jsdom
// History in the client: my games, a game's page with its step-by-step replay,
// and the "Watch the replay" link when a game ends. The server is faked (fetch);
// the replayed game is a real one, played and encoded here.
import "../support/dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  DEFAULT_SETUP,
  actorFor,
  encodeCommand,
  mulberry32,
  newGame,
  quickMove,
  randDice,
  reduce,
  settle,
  withEntropy,
  type GameRecord,
  type GameState,
  type GameSummary,
  type PublicUser,
  type RoomSnapshot,
} from "@skyteam/shared";

vi.mock("socket.io-client", () => ({ io: vi.fn() }));

const { Root } = await import("../../packages/client/src/Root");
const { useAccount } = await import("../../packages/client/src/account/useAccount");
const { Cockpit } = await import("../../packages/client/src/components/Cockpit");

const ALICE: PublicUser = { id: "u1", username: "alice", role: "USER", privileges: ["history"] };

/** A whole game, played by quick moves, as the server would log it. */
function playedGame(seed = 4): { moves: string; end: GameState } {
  const rand = mulberry32(seed);
  const dice = randDice(rand);
  let moves = "";
  const record = (before: GameState, cmd: Parameters<typeof encodeCommand>[1], crew: "pilot" | "copilot" | null) => (moves += encodeCommand(before, cmd, crew));
  let game = newGame(DEFAULT_SETUP, "pilot", "copilot", rand, 0, { record });
  for (let i = 0; i < 500 && !game.outcome; i++) {
    const crew = actorFor(game)!;
    const cmd = withEntropy(quickMove(game, crew, rand), dice);
    const before = game;
    game = reduce(game, cmd, crew).state;
    record(before, cmd, crew);
    game = settle(game, dice, () => 0, record);
  }
  return { moves, end: game };
}
const PLAYED = playedGame();
const GAME_ID = "g".repeat(21);
const RECORD: GameRecord = {
  id: GAME_ID, format: 1, setup: { scenarioId: "YUL", modules: [], abilities: [] }, internTokens: [], moves: PLAYED.moves,
  result: PLAYED.end.outcome!.result, lossReason: PLAYED.end.outcome!.result === "lost" ? PLAYED.end.outcome!.reason : null,
  roundsReached: PLAYED.end.round, crews: { pilot: "alice", copilot: "Bot (aviator)" },
  startedAt: "2026-10-08T10:00:00.000Z", endedAt: "2026-10-08T10:20:00.000Z", sameDiceAvailable: true, seededFrom: null,
};
const summary = (n: number): GameSummary => ({
  id: `game${n}`.padEnd(21, "x"), scenario: "YUL", modules: [], abilities: [], result: n % 2 ? "won" : "lost", lossReason: n % 2 ? null : "Crashed.",
  roundsReached: 7, crew: "pilot", partner: n === 1 ? "Bot (aviator)" : "Guest", endedAt: `2026-10-0${n}T10:00:00.000Z`, seeded: n === 2,
});

type Handler = (url: URL) => { status?: number; body?: unknown };
let routes: Record<string, Handler>;
beforeEach(() => {
  routes = { "GET /api/auth/me": () => ({ body: { user: ALICE } }) };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const handler = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith("*") && key.startsWith(k.slice(0, -1)))?.[1];
    const { status = 200, body = {} } = handler ? handler(url) : { status: 404, body: { error: "No route" } };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  useAccount.setState({ user: undefined, available: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const open = async (path: string) => {
  window.history.replaceState(null, "", path);
  render(<Root />);
  await waitFor(() => expect(useAccount.getState().user).not.toBe(undefined));
};

describe("my games", () => {
  test("lists my games, newest first, and loads more", async () => {
    routes["GET /api/me/games"] = (url) =>
      url.searchParams.get("before") ? { body: { games: [summary(1)], next: null } } : { body: { games: [summary(3), summary(2)], next: "cursor-1" } };
    await open("/history");
    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(3); // the header and two games
    expect(within(rows[1]).getByText(/YUL/)).toBeTruthy();
    expect(within(rows[1]).getByText("Won")).toBeTruthy();
    expect(within(rows[2]).getByText("same dice")).toBeTruthy();
    expect(within(rows[1]).getByRole("link", { name: "Replay" }).getAttribute("href")).toBe(`/games/${summary(3).id}`);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(4));
    expect(screen.getByText("Bot (aviator)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBe(null);
  });

  test("no games yet says so", async () => {
    routes["GET /api/me/games"] = () => ({ body: { games: [], next: null } });
    await open("/history");
    expect(await screen.findByText(/No games yet/)).toBeTruthy();
  });

  test("a guest is sent to sign in", async () => {
    routes["GET /api/auth/me"] = () => ({ body: { user: null } });
    await open("/history");
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe("/signin?next=%2Fhistory"));
  });
});

describe("a game's page and its replay", () => {
  beforeEach(() => {
    routes[`GET /api/games/${GAME_ID}`] = () => ({ body: RECORD });
  });

  test("the header, and the cockpit at the first deal", async () => {
    await open(`/games/${GAME_ID}`);
    expect(await screen.findByText(/alice/)).toBeTruthy();
    expect(screen.getByText(/Bot \(aviator\)/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /YUL/ })).toBeTruthy();
    expect(screen.getByText(/^Round 1 · move 1 of \d+$/)).toBeTruthy();
    expect(document.querySelector(".board")).toBeTruthy(); // the cockpit
  });

  test("step forward and back, jump by round, and to the end", async () => {
    await open(`/games/${GAME_ID}`);
    await screen.findByText(/^Round 1 · move 1 of/);
    fireEvent.click(screen.getByRole("button", { name: "Next move" }));
    expect(screen.getByText(/^Round 1 · move 2 of/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous move" }));
    expect(screen.getByText(/^Round 1 · move 1 of/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next round" }));
    expect(screen.getByText(/^Round 2 · move \d+ of/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Last move" }));
    const n = PLAYED.moves.match(/[DSTPC]/g)!.length;
    expect(screen.getByText(new RegExp(`move ${n} of ${n}$`))).toBeTruthy();
    expect(document.querySelector(".callout")!.textContent).toBe(
      RECORD.result === "won" ? "Smooth landing — the passengers applaud." : RECORD.lossReason,
    );
    fireEvent.click(screen.getByRole("button", { name: "First move" }));
    expect(screen.getByText(/^Round 1 · move 1 of/)).toBeTruthy();
    // The keyboard: → a move, Shift+→ a round.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText(/^Round 1 · move 2 of/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    expect(screen.getByText(/^Round 2 · move/)).toBeTruthy();
  });

  test("play steps on by itself until paused", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await open(`/games/${GAME_ID}`);
    await screen.findByText(/^Round 1 · move 1 of/);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    vi.advanceTimersByTime(1500);
    await waitFor(() => expect(screen.getByText(/^Round 1 · move 3 of/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    vi.advanceTimersByTime(3000);
    expect(screen.getByText(/^Round 1 · move 3 of/)).toBeTruthy();
    vi.useRealTimers();
  });

  test("an unknown game says so", async () => {
    await open(`/games/${"z".repeat(21)}`);
    expect(await screen.findByText("No game with that id.")).toBeTruthy();
  });

  test("a move string this version can't read: a message and the raw moves", async () => {
    routes[`GET /api/games/${GAME_ID}`] = () => ({ body: { ...RECORD, moves: "D1111222P9z" } });
    await open(`/games/${GAME_ID}`);
    expect(await screen.findByText("This game can't be replayed by this version.")).toBeTruthy();
    expect(screen.getByText("D1111222P9z")).toBeTruthy();
  });
});

test("when a game ends, the cockpit links to its replay", () => {
  const end = PLAYED.end;
  const snapshot: RoomSnapshot = {
    roomId: "r", inviteCode: "I", status: "finished", hostPlayerId: "pilot",
    seats: [{ playerId: "pilot", role: "host", ready: true, connection: "connected" }, { playerId: "copilot", role: "guest", ready: true, connection: "connected" }],
    hostCrew: "pilot", observerCount: 0, setup: DEFAULT_SETUP, version: 9, game: end, notice: null, chat: [], debrief: null,
    you: { playerId: "pilot", kind: "player", role: "host" }, serverTime: Date.now(), lastGameId: GAME_ID,
  };
  render(<Cockpit snapshot={snapshot} onCommand={() => {}} />);
  const link = screen.getByRole("link", { name: "Watch the replay" });
  expect(link.getAttribute("href")).toBe(`/games/${GAME_ID}`);
  expect(link.getAttribute("target")).toBe("_blank");
});
