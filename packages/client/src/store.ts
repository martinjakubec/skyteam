import { io, type Socket } from "socket.io-client";
import { create } from "zustand";
import type {
  ClientToServerEvents,
  GameCommand,
  RoomSnapshot,
  ServerToClientEvents,
} from "@skyteam/shared";
import { SERVER_URL } from "./config";
import { getStoredToken } from "./api";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface GameStore {
  socket: TypedSocket | null;
  connected: boolean;
  snapshot: RoomSnapshot | null;
  lastError: string | null;

  connect: (roomId: string) => void;
  setReady: (ready: boolean) => void;
  startGame: () => void;
  resetGame: () => void;
  sendCommand: (command: GameCommand) => void;
}

export const useGame = create<GameStore>((set, get) => ({
  socket: null,
  connected: false,
  snapshot: null,
  lastError: null,

  connect: (roomId) => {
    if (get().socket) return; // guard against React StrictMode double-invoke

    const socket: TypedSocket = io(SERVER_URL, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelayMax: 5000,
    });

    // Re-join on EVERY (re)connect. Socket.IO auto-reconnects after an internet
    // drop, fires "connect" again, and we re-send room:join — the server then
    // cancels the grace timer and replies with a full state snapshot.
    const join = () => {
      const token = getStoredToken();
      if (!token) {
        set({ lastError: "Missing identity token." });
        return;
      }
      socket.emit("room:join", { roomId, token, lastVersion: get().snapshot?.version }, (res) => {
        if (!res.ok) set({ lastError: res.error });
      });
    };

    socket.on("connect", () => {
      set({ connected: true, lastError: null });
      join();
    });
    socket.on("disconnect", () => set({ connected: false }));
    socket.on("room:state", (snapshot) => set({ snapshot }));
    socket.on("game:event", (msg) => {
      const snap = get().snapshot;
      if (snap) set({ snapshot: { ...snap, game: msg.game, version: msg.version } });
    });

    set({ socket });
  },

  setReady: (ready) =>
    get().socket?.emit("seat:ready", { ready }, (res) => {
      if (!res.ok) set({ lastError: res.error });
    }),

  startGame: () =>
    get().socket?.emit("game:start", (res) => {
      if (!res.ok) set({ lastError: res.error });
    }),

  resetGame: () =>
    get().socket?.emit("game:reset", (res) => {
      if (!res.ok) set({ lastError: res.error });
    }),

  sendCommand: (command) =>
    get().socket?.emit("game:command", { commandId: crypto.randomUUID(), command }, (res) => {
      if (!res.ok) set({ lastError: res.error });
    }),
}));
