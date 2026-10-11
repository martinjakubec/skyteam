// @vitest-environment jsdom
// The installed app (PWA): it keeps the player's seat when the phone closes it
// (the token and the room outlive the window), while a browser tab stays one
// player per tab. The server is faked: fetch for the HTTP routes, a socket
// that only records what it's sent.
import "../support/dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_SETUP, type RoomSnapshot } from "@skyteam/shared";

type Handler = (...args: unknown[]) => void;
class FakeSocket {
  handlers = new Map<string, Handler[]>();
  sent: { event: string; args: unknown[] }[] = [];
  on(event: string, h: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), h]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    const ack = args.at(-1);
    this.sent.push({ event, args: typeof ack === "function" ? args.slice(0, -1) : args });
    if (typeof ack === "function") ack({ ok: true });
    return this;
  }
  serve(event: string, ...args: unknown[]) {
    act(() => this.handlers.get(event)?.forEach((h) => h(...args)));
  }
  last(event: string) {
    return [...this.sent].reverse().find((s) => s.event === event);
  }
  disconnect() {
    return this;
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
const installed = await import("../../packages/client/src/pwa/installed");
const { Root } = await import("../../packages/client/src/Root");
const { pwa } = await import("../support/pwaRegister");

const ME = "player-me";
const snapshot = (over: Partial<RoomSnapshot> = {}): RoomSnapshot => ({
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
  chat: [],
  debrief: null,
  you: { playerId: ME, kind: "player", role: "host" },
  serverTime: Date.now(),
  ...over,
});

/** fetch answering the room routes; the join of a gone room is a 404. */
function serverRoutes(gone: string[] = []) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const code = path.split("/")[2];
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (gone.includes(code)) return new Response(JSON.stringify({ error: "No such room." }), { status: 404 });
    return new Response(JSON.stringify({ roomId: "room-1", inviteCode: path === "/rooms" ? "INVITE01" : code, token: body.token ?? "tok-1" }), { status: 200 });
  });
}

/** Runs as the installed app (display-mode: standalone) or as a browser tab. */
function displayMode(standalone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: standalone && query === "(display-mode: standalone)",
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

/** The phone closed the app: the window's name and its session storage are gone. */
function closeTheApp() {
  cleanup();
  window.name = "";
  sessionStorage.clear();
  sockets.length = 0;
  useGame.setState({ socket: null, connected: false, snapshot: null, lastError: null, serverDown: false });
}

beforeEach(() => {
  closeTheApp();
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  displayMode(true);
  pwa.needRefresh = false;
  pwa.updated = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const answer = (button: string) => fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: button }));

async function createRoom() {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Create a room" }));
  await waitFor(() => expect(sockets).toHaveLength(1));
  sockets[0].serve("connect");
  sockets[0].serve("room:state", snapshot());
}

/** Launches the app the way the phone does: at the manifest's start_url. */
function launch() {
  window.history.replaceState(null, "", "/");
  installed.resumeRoom();
  render(<App />);
}

describe("the installed app", () => {
  test("knows it is installed; a tab knows it isn't", () => {
    expect(installed.isInstalled()).toBe(true);
    displayMode(false);
    expect(installed.isInstalled()).toBe(false);
  });

  test("closed in a room and launched again: back in the same room, as the same player", async () => {
    serverRoutes();
    await createRoom();
    closeTheApp();
    launch();
    expect(window.location.search).toBe("?join=INVITE01");
    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].serve("connect");
    expect(sockets[0].last("room:join")!.args[0]).toMatchObject({ roomId: "room-1", token: "tok-1" });
  });

  test("an invite link it was opened with wins over the remembered room, and is remembered instead", async () => {
    const fetch = serverRoutes();
    await createRoom();
    closeTheApp();
    window.history.replaceState(null, "", "/?join=OTHER123");
    installed.resumeRoom();
    render(<App />);
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(String(fetch.mock.calls.at(-1)![0])).toMatch(/\/rooms\/OTHER123\/join$/);
    closeTheApp();
    launch();
    expect(window.location.search).toBe("?join=OTHER123");
  });

  test("after Leave room, the next launch is the start page", async () => {
    serverRoutes();
    await createRoom();
    fireEvent.click(screen.getByRole("button", { name: "Leave room" }));
    answer("Leave room");
    await waitFor(() => expect(screen.getByRole("button", { name: "Create a room" })).toBeTruthy());
    closeTheApp();
    launch();
    expect(window.location.search).toBe("");
    expect(sockets).toHaveLength(0);
  });

  test("a room that has gone is tried once, then forgotten", async () => {
    vi.spyOn(window, "alert").mockImplementation(() => {});
    serverRoutes();
    await createRoom();
    vi.restoreAllMocks();
    vi.spyOn(window, "alert").mockImplementation(() => {});
    const fetch = serverRoutes(["INVITE01"]);
    closeTheApp();
    launch();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.alert).toHaveBeenCalled());
    closeTheApp();
    launch();
    expect(window.location.search).toBe("");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("with storage blocked it works like a tab, and nothing throws", async () => {
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked);
    expect(() => installed.rememberRoom("INVITE01")).not.toThrow();
    expect(() => installed.resumeRoom()).not.toThrow();
    expect(window.location.search).toBe("");
  });
});

describe("a browser tab", () => {
  test("stays one player per tab: nothing is remembered across windows", async () => {
    displayMode(false);
    serverRoutes();
    await createRoom();
    expect(api.getStoredToken()).toBe("tok-1");
    closeTheApp();
    expect(api.getStoredToken()).toBe(null);
    launch();
    expect(window.location.search).toBe("");
  });
});

describe("a new version", () => {
  /** The start page, signed out. */
  function home() {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ user: null }), { status: 200 }));
    render(<Root />);
  }
  const bar = () => screen.queryByRole("status", { name: "New version" });

  test("is offered out of a game; Reload switches to it", async () => {
    pwa.needRefresh = true;
    home();
    expect(bar()!.textContent).toMatch(/A new version of SkyTeam is ready/);
    fireEvent.click(within(bar()!).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(pwa.updated).toBe(1));
  });

  test("waits while a game is on, and is offered once it's over", () => {
    pwa.needRefresh = true;
    useGame.setState({ snapshot: snapshot({ status: "in_progress" }) });
    home();
    expect(bar()).toBe(null);
    act(() => useGame.setState({ snapshot: snapshot({ status: "finished" }) }));
    expect(bar()).toBeTruthy();
  });

  test("isn't mentioned when there's none", () => {
    home();
    expect(bar()).toBe(null);
  });
});

describe("offline", () => {
  const notice = () => screen.queryByRole("status", { name: "Offline" });
  function setOnline(online: boolean) {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);
    act(() => void window.dispatchEvent(new Event(online ? "online" : "offline")));
  }

  test("says the game needs a connection, until it's back", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ user: null }), { status: 200 }));
    render(<Root />);
    expect(notice()).toBe(null);
    setOnline(false);
    expect(notice()!.textContent).toBe("You're offline. SkyTeam needs a connection to play.");
    setOnline(true);
    expect(notice()).toBe(null);
  });
});
