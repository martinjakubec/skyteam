// @vitest-environment jsdom
// The client app around the cockpit: landing page, room creation and invite
// links, the lobby (name, setup, ready, start), the in-game header, and the
// socket store behind them. The server is faked: fetch for the HTTP routes,
// a scripted socket for Socket.IO.
import "../support/dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_SETUP, SOLO_RESTRICTED_NOTE, UNAVAILABLE, newGame, settle, randDice, mulberry32, type RoomSnapshot } from "@skyteam/shared";

// --- a scripted Socket.IO client -------------------------------------------------------
type Handler = (...args: unknown[]) => void;
class FakeSocket {
  handlers = new Map<string, Handler[]>();
  sent: { event: string; args: unknown[] }[] = [];
  /** How the "server" answers each emit's ack (default: ok). */
  reply: (event: string, payload: unknown) => unknown = () => ({ ok: true });
  on(event: string, h: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), h]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    const ack = args.at(-1);
    const payload = typeof args[0] === "function" ? undefined : args[0];
    this.sent.push({ event, args: typeof ack === "function" ? args.slice(0, -1) : args });
    if (typeof ack === "function") ack(this.reply(event, payload));
    return this;
  }
  /** The server sends an event. */
  serve(event: string, ...args: unknown[]) {
    act(() => this.handlers.get(event)?.forEach((h) => h(...args)));
  }
  last(event: string) {
    return [...this.sent].reverse().find((s) => s.event === event);
  }
}
const sockets: FakeSocket[] = [];
vi.mock("socket.io-client", () => ({
  io: vi.fn(() => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  }),
}));

const { App } = await import("../../packages/client/src/App");
const { useGame } = await import("../../packages/client/src/store");
const api = await import("../../packages/client/src/api");
const { ScenarioPicker } = await import("../../packages/client/src/components/ScenarioPicker");
const { InviteBox } = await import("../../packages/client/src/components/InviteBox");
const { ServerDown } = await import("../../packages/client/src/components/ServerDown");

// --- fixtures -----------------------------------------------------------------------------
const ME = "player-me", OTHER = "player-other";

function snapshot(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    roomId: "room-1",
    inviteCode: "INVITE01",
    status: "lobby",
    hostPlayerId: ME,
    seats: [{ playerId: ME, role: "host", ready: false, connection: "connected" }],
    hostCrew: "pilot",
    observerCount: 0,
    setup: structuredClone(DEFAULT_SETUP),
    version: 0,
    game: null,
    notice: null,
    you: { playerId: ME, kind: "player", role: "host" },
    serverTime: Date.now(),
    ...over,
  };
}
const guest = { playerId: OTHER, role: "guest" as const, ready: true, connection: "connected" as const };

function inGame(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  const r = mulberry32(5);
  const game = settle(newGame(DEFAULT_SETUP, ME, OTHER, r, 0), randDice(r), () => 0);
  return snapshot({ status: "in_progress", seats: [{ playerId: ME, role: "host", ready: true, connection: "connected" }, guest], game, ...over });
}

/** fetch answering the room routes. */
function serverRoutes(answer: (path: string, body: Record<string, unknown>) => { status?: number; body: unknown }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const { status = 200, body } = answer(path, JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
}
const roomReply = { roomId: "room-1", inviteCode: "INVITE01", token: "tok-1" };

beforeEach(() => {
  sockets.length = 0;
  useGame.setState({ socket: null, connected: false, snapshot: null, lastError: null, serverDown: false, clockOffset: 0 });
  window.history.replaceState(null, "", "/");
  window.name = "";
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Open the app in a room (created, connected and joined). */
async function inRoom(first: RoomSnapshot = snapshot()) {
  serverRoutes(() => ({ body: roomReply }));
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Create a room" }));
  await waitFor(() => expect(sockets).toHaveLength(1));
  const sock = sockets[0];
  sock.serve("connect");
  sock.serve("room:state", first);
  return sock;
}

// --- landing page -------------------------------------------------------------------------
describe("landing page", () => {
  test("creating a room connects, joins with the stored token, and puts the invite in the URL", async () => {
    const sock = await inRoom();
    expect(sock.last("room:join")!.args[0]).toMatchObject({ roomId: "room-1", token: "tok-1" });
    expect(window.location.search).toBe("?join=INVITE01");
    expect(screen.getByText("● linked")).toBeTruthy();
    expect(screen.getByDisplayValue(/\?join=INVITE01$/)).toBeTruthy(); // the invite box
    sock.serve("disconnect");
    expect(screen.getByText("○ reconnecting")).toBeTruthy();
  });

  test("play solo: sends the chosen seat", async () => {
    const fetch = serverRoutes(() => ({ body: roomReply }));
    render(<App />);
    fireEvent.click(screen.getByRole("radio", { name: "Co-Pilot" }));
    fireEvent.click(screen.getByRole("button", { name: "Play solo" }));
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(JSON.parse(String(fetch.mock.calls[0][1]!.body))).toMatchObject({ solo: { crew: "copilot" } });
  });

  test("an invite link joins the room once", async () => {
    window.history.replaceState(null, "", "/?join=CODE1234");
    const fetch = serverRoutes((path) => ({ body: { ...roomReply, inviteCode: path.split("/")[2] } }));
    render(<App />);
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toMatch(/\/rooms\/CODE1234\/join$/);
  });

  test("a refused request is alerted; storage down shows the 500 page", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    serverRoutes(() => ({ status: 404, body: { error: "Room not found or expired." } }));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Create a room" }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith("Room not found or expired."));
    cleanup();
    vi.restoreAllMocks();
    serverRoutes(() => ({ status: 500, body: { ok: false, error: "down", code: UNAVAILABLE } }));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Create a room" }));
    await waitFor(() => expect(screen.getByText("Lost contact with the tower")).toBeTruthy());
  });

  test("a failure without a JSON body falls back to the status text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("oops", { status: 502, statusText: "Bad Gateway" }));
    await expect(api.joinRoom("X")).rejects.toThrow("Bad Gateway");
  });

  test("How to play opens the basics tutorial", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "How to play" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByRole("dialog")).toBe(null);
  });
});

// --- lobby --------------------------------------------------------------------------------
describe("lobby", () => {
  test("seats: who flies what, who's ready, who's watching", async () => {
    const sock = await inRoom(snapshot({ seats: [{ playerId: ME, role: "host", ready: false, connection: "connected", name: "Ann" }], observerCount: 2 }));
    expect(screen.getByText(/Pilot: 👑 Ann \(you\)/)).toBeTruthy();
    expect(screen.getByText("Waiting for a second player…")).toBeTruthy();
    expect(screen.getByText("2 watching")).toBeTruthy();
    sock.serve("room:state", snapshot({ seats: [{ playerId: ME, role: "host", ready: false, connection: "connected" }, { ...guest, connection: "disconnected" }], hostCrew: "copilot" }));
    expect(screen.getByText(/Co-Pilot: 👑/)).toBeTruthy();
    expect(screen.getByText("🔴 ready")).toBeTruthy();
  });

  test("name: saved through the socket and remembered in the browser; a refusal is shown", async () => {
    const sock = await inRoom();
    const input = screen.getByLabelText("Your name");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  Maverick  " } });
    fireEvent.click(save);
    expect(sock.last("seat:name")!.args[0]).toEqual({ name: "  Maverick  " });
    expect(api.getStoredName()).toBe("Maverick");
    sock.reply = () => ({ ok: false, error: "A name is at most 24 characters." });
    fireEvent.change(input, { target: { value: "Goose" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByText("A name is at most 24 characters.")).toBeTruthy();
    expect(api.getStoredName()).toBe("Maverick");
  });

  test("ready, start, and the host's hint", async () => {
    const sock = await inRoom(snapshot({ seats: [{ playerId: ME, role: "host", ready: false, connection: "connected" }, guest] }));
    expect(screen.getByText("Both players must be ready to start.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ready up" }));
    expect(sock.last("seat:ready")!.args[0]).toEqual({ ready: true });
    sock.serve("room:state", snapshot({ status: "ready", seats: [{ playerId: ME, role: "host", ready: true, connection: "connected" }, guest] }));
    fireEvent.click(screen.getByRole("button", { name: "Unready" }));
    expect(sock.last("seat:ready")!.args[0]).toEqual({ ready: false });
    fireEvent.click(screen.getByRole("button", { name: "Start game" }));
    expect(sock.last("game:start")).toBeTruthy();
  });

  test("setup: modules toggle (one of an exclusive pair), abilities up to the card's cap", async () => {
    const sock = await inRoom(snapshot({ setup: { scenarioId: "green-PRG", modules: ["kerosene"], abilities: [] } }));
    const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
    fireEvent.click(box("Kerosene Leak"));
    expect(sock.last("room:setup")!.args[0]).toEqual({ scenarioId: "green-PRG", modules: ["keroseneLeak"], abilities: [] });
    fireEvent.click(box("Kerosene"));
    expect(sock.last("room:setup")!.args[0]).toMatchObject({ modules: [] });
    expect(screen.getByText("Choose up to 2 Special Abilities.")).toBeTruthy();
    fireEvent.click(box("Adaptation"));
    expect(sock.last("room:setup")!.args[0]).toMatchObject({ abilities: ["adaptation"] });
    sock.serve("room:state", snapshot({ setup: { scenarioId: "green-PRG", modules: ["kerosene"], abilities: ["adaptation", "anticipation"] } }));
    // At the cap, the unticked abilities lock; ticked ones can still be unticked.
    expect(box("Mastery").disabled).toBe(true);
    fireEvent.click(box("Adaptation"));
    expect(sock.last("room:setup")!.args[0]).toMatchObject({ abilities: ["anticipation"] });
  });

  test("setup: the guest sees it read-only", async () => {
    await inRoom(snapshot({ hostPlayerId: OTHER, you: { playerId: ME, kind: "player", role: "guest" }, seats: [{ ...guest, playerId: OTHER, role: "host" }, { playerId: ME, role: "guest", ready: false, connection: "connected" }] }));
    expect(screen.getByText("The host chooses the airport and modules.")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Kerosene" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Start game" })).toBe(null);
    expect(screen.getByText("This airport has no Special Abilities.")).toBeTruthy();
  });

  test("ℹ️ opens a module's tutorial; the lobby notice and solo rooms show no invite box", async () => {
    const sock = await inRoom();
    fireEvent.click(screen.getByRole("button", { name: "How Wind works" }));
    expect(within(screen.getByRole("dialog")).getByRole("heading", { level: 2 }).textContent).toMatch(/Wind/);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBe(null);
    sock.serve("room:state", snapshot({ notice: "The Co-Pilot ended the game.", seats: [{ playerId: ME, role: "host", ready: false, connection: "connected" }, { ...guest, bot: "aviator" }] }));
    expect(screen.getByText("The Co-Pilot ended the game.")).toBeTruthy();
    expect(screen.queryByDisplayValue(/\?join=/)).toBe(null);
    expect(screen.getByText(/🤖/)).toBeTruthy();
  });

  test("a refusal is shown; storage down from the socket shows the 500 page", async () => {
    const sock = await inRoom();
    sock.reply = () => ({ ok: false, error: "Only the host can start." });
    fireEvent.click(screen.getByRole("button", { name: "Ready up" }));
    expect(screen.getByText("Only the host can start.")).toBeTruthy();
    sock.reply = () => ({ ok: false, error: "down", code: UNAVAILABLE });
    fireEvent.click(screen.getByRole("button", { name: "Ready up" }));
    expect(screen.getByText("Lost contact with the tower")).toBeTruthy();
  });

  test("the room was abandoned", async () => {
    await inRoom(snapshot({ status: "abandoned" }));
    expect(screen.getByText(/the game was abandoned/)).toBeTruthy();
  });
});

// --- in game ------------------------------------------------------------------------------
describe("in game", () => {
  test("the cockpit shows; game events update it; Exit and Reset ask first", async () => {
    const sock = await inRoom(inGame());
    expect(document.querySelector(".board")).toBeTruthy();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Exit to lobby" }));
    expect(sock.last("game:exit")).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Exit to lobby" }));
    expect(sock.last("game:exit")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset game" }));
    expect(sock.last("game:reset")).toBeTruthy();
    expect(confirm).toHaveBeenCalledTimes(3);

    // A move arrives: the store takes its game and version, and the clock offset (when it moved).
    const g = useGame.getState().snapshot!.game!;
    sock.serve("game:event", { version: 4, command: { type: "reroll", dieIds: [] }, byPlayerId: OTHER, game: { ...g, round: 2 }, serverTime: Date.now() + 5000 });
    expect(useGame.getState().snapshot!.version).toBe(4);
    expect(useGame.getState().snapshot!.game!.round).toBe(2);
    expect(useGame.getState().clockOffset).toBeGreaterThan(4000);
  });

  test("placing a die sends a game command", async () => {
    const sock = await inRoom(inGame());
    const game = useGame.getState().snapshot!.game!;
    const crew = game.turn;
    if (crew !== "pilot") return; // dealt so the host (Pilot) leads round 1
    fireEvent.pointerDown(document.querySelectorAll(".hand .dice button.die")[0]);
    fireEvent.pointerUp(window);
    fireEvent.click(document.querySelector(`.slot[data-target='${JSON.stringify({ kind: "axis", side: "pilot" })}']`)!);
    expect(sock.last("game:command")!.args[0]).toMatchObject({ command: { type: "placeDie", target: { kind: "axis", side: "pilot" } } });
  });

  test("a spectator gets no Exit or Reset", async () => {
    await inRoom(inGame({ hostPlayerId: OTHER, you: { playerId: "watcher", kind: "observer" } }));
    expect(screen.queryByRole("button", { name: "Exit to lobby" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Reset game" })).toBe(null);
  });
});

// --- store edge cases ---------------------------------------------------------------------
describe("store", () => {
  test("connect is idempotent; a missing token is reported; actions without a socket do nothing", () => {
    const { connect, setReady } = useGame.getState();
    setReady(true); // no socket yet: no-op
    connect("room-x");
    connect("room-x");
    expect(sockets).toHaveLength(1);
    sockets[0].serve("connect");
    expect(useGame.getState().lastError).toBe("Missing identity token.");
  });

  test("small clock jitter keeps the old offset", () => {
    api.storeToken("t");
    useGame.getState().connect("room-y");
    const s = sockets[0];
    s.serve("room:state", snapshot({ serverTime: Date.now() + 1000 }));
    const first = useGame.getState().clockOffset;
    s.serve("room:state", snapshot({ serverTime: Date.now() + 1100 }));
    expect(useGame.getState().clockOffset).toBe(first);
    // A game event before any snapshot is ignored.
    useGame.setState({ snapshot: null });
    s.serve("game:event", { version: 1, game: null, serverTime: Date.now() });
    expect(useGame.getState().snapshot).toBe(null);
  });

  test("names: kept in localStorage; cleared; storage that throws is tolerated", () => {
    api.storeName("Iceman");
    expect(api.getStoredName()).toBe("Iceman");
    api.storeName("");
    expect(api.getStoredName()).toBe("");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(api.getStoredName()).toBe("");
    expect(() => api.storeName("x")).not.toThrow();
  });

  test("each tab keeps its own identity token", () => {
    api.storeToken("a");
    const tab = window.name;
    expect(tab).toMatch(/^skyteam-tab:/);
    expect(api.getStoredToken()).toBe("a");
    window.name = ""; // a new tab
    expect(api.getStoredToken()).toBe(null);
    expect(window.name).not.toBe(tab);
  });
});

// --- small components ---------------------------------------------------------------------
describe("scenario picker", () => {
  test("mouse: open, hover, pick; a click outside closes it", () => {
    const onChange = vi.fn();
    render(<ScenarioPicker value="YUL" disabled={false} onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /^Scenario: YUL/ });
    fireEvent.click(trigger);
    const options = screen.getAllByRole("option");
    expect(options.length).toBe(21);
    fireEvent.pointerMove(options[3]);
    expect(options[3].className).toMatch(/active/);
    fireEvent.click(options[3]);
    expect(onChange).toHaveBeenCalledWith(options[3].dataset.value);
    fireEvent.click(trigger);
    fireEvent.click(screen.getAllByRole("option")[0]); // the current card: no change
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBe(null);
    fireEvent.click(trigger);
    fireEvent.click(trigger); // toggles closed
    expect(screen.queryByRole("listbox")).toBe(null);
  });

  test("keyboard: arrows, paging, Home/End, Enter picks, Escape and Tab close", () => {
    const onChange = vi.fn();
    render(<ScenarioPicker value="YUL" disabled={false} onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /^Scenario:/ });
    fireEvent.keyDown(trigger, { key: "x" });
    expect(screen.queryByRole("listbox")).toBe(null);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const list = screen.getByRole("listbox");
    const active = () => list.getAttribute("aria-activedescendant");
    const ids = screen.getAllByRole("option").map((o) => o.id);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(active()).toBe(ids[1]);
    fireEvent.keyDown(list, { key: "PageDown" });
    expect(active()).toBe(ids[6]);
    fireEvent.keyDown(list, { key: "End" });
    expect(active()).toBe(ids[20]);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(active()).toBe(ids[20]);
    fireEvent.keyDown(list, { key: "Home" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(active()).toBe(ids[0]);
    fireEvent.keyDown(list, { key: "q" }); // ignored
    fireEvent.keyDown(list, { key: "PageDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBe(null);
    fireEvent.keyDown(trigger, { key: " " });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Tab" });
    expect(screen.queryByRole("listbox")).toBe(null);
  });

  test("solo: red and black cards can't be picked and carry the note", () => {
    const onChange = vi.fn();
    render(<ScenarioPicker value="YUL" disabled={false} onChange={onChange} allow={(id) => !/^(red|black)-/.test(id)} restrictedNote={SOLO_RESTRICTED_NOTE} />);
    fireEvent.click(screen.getByRole("button", { name: /^Scenario:/ }));
    const red = screen.getAllByRole("option").find((o) => o.dataset.value === "red-PBH")!;
    expect(red.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(red);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getAllByText(SOLO_RESTRICTED_NOTE)).toHaveLength(2);
  });
});

describe("invite box and 500 page", () => {
  test("copy puts the link on the clipboard; focusing selects it", () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<InviteBox url="http://x/?join=A" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("http://x/?join=A");
    const input = screen.getByDisplayValue("http://x/?join=A") as HTMLInputElement;
    fireEvent.focus(input);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  test("Try again reloads", () => {
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as Location);
    render(<ServerDown />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalled();
  });
});
