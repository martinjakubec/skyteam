import { io, type Socket } from "socket.io-client";
import { create } from "zustand";
import {
  MAX_CHAT_HISTORY,
  UNAVAILABLE,
  type Ack,
  type ChatMessage,
  type ClientToServerEvents,
  type GameCommand,
  type GameSetup,
  type RoomSnapshot,
  type ServerToClientEvents,
} from "@skyteam/shared";
import { SERVER_URL } from "./config";
import { getStoredName, getStoredToken, storeName } from "./api";
import { uuid } from "./uuid";

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface GameStore {
  socket: TypedSocket | null;
  connected: boolean;
  snapshot: RoomSnapshot | null;
  lastError: string | null;
  /** The server can't reach its storage: the app shows its 500 page. */
  serverDown: boolean;
  /** Server clock − this device's clock (ms), from the latest message: maps a
   *  Real-Time deadline onto local time. */
  clockOffset: number;
  /** The newest flight log line this player has seen (its server `at`); later
   *  lines from the other player are unread. Null until the first snapshot,
   *  which counts as read — history isn't news. */
  chatReadAt: number | null;

  connect: (roomId: string) => void;
  setReady: (ready: boolean) => void;
  /** Rename yourself (lobby only); remembered in this browser for later rooms. */
  setName: (name: string) => void;
  setSetup: (setup: GameSetup) => void;
  /** Host, lobby: stop flying an earlier game's dice. */
  freshDice: () => void;
  /** Post to the flight log; `onSent` runs once the server took it. */
  sendChat: (text: string, onSent?: () => void) => void;
  /** Everything in the flight log has been seen. */
  markChatRead: () => void;
  /** Between rounds: ready (or not) for the next round's dice. */
  setRoundReady: (ready: boolean) => void;
  startGame: () => void;
  resetGame: () => void;
  exitGame: () => void;
  sendCommand: (command: GameCommand) => void;
  serverIsDown: () => void;
}

export const useGame = create<GameStore>((set, get) => {
  /** A refused request: "unavailable" means the 500 page, anything else is shown as an error. */
  const refused = (res: Ack) => {
    if (res.ok) return;
    set(res.code === UNAVAILABLE ? { serverDown: true } : { lastError: res.error });
  };

  return {
    socket: null,
    connected: false,
    snapshot: null,
    lastError: null,
    serverDown: false,
    clockOffset: 0,
    chatReadAt: null,

    connect: (roomId) => {
      if (get().socket) return; // guard against React StrictMode double-invoke

      const socket: TypedSocket = io(SERVER_URL, {
        transports: ["websocket"],
        // Send the sign-in cookie: the server links a signed-in player's seat to their account.
        withCredentials: true,
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
        socket.emit("room:join", { roomId, token, lastVersion: get().snapshot?.version, name: getStoredName() || undefined }, refused);
      };

      socket.on("connect", () => {
        set({ connected: true, lastError: null });
        join();
      });
      socket.on("disconnect", () => set({ connected: false }));
      // Each message re-measures the server clock offset, but network delay makes
      // it jitter by a few ms — adopt a new value only when it really moved, so
      // the Real-Time bar doesn't twitch on every move.
      const offset = (serverTime: number) => {
        const fresh = serverTime - Date.now();
        return Math.abs(fresh - get().clockOffset) > 250 ? fresh : get().clockOffset;
      };
      socket.on("room:state", (snapshot) =>
        set({ snapshot, clockOffset: offset(snapshot.serverTime), chatReadAt: get().chatReadAt ?? lastAt(snapshot.chat) }),
      );
      socket.on("chat:message", (msg) => {
        const snap = get().snapshot;
        if (snap && !snap.chat.some((m) => m.id === msg.id))
          set({ snapshot: { ...snap, chat: [...snap.chat, msg].slice(-MAX_CHAT_HISTORY) } });
      });
      socket.on("game:event", (msg) => {
        const snap = get().snapshot;
        if (snap) set({ snapshot: { ...snap, game: msg.game, version: msg.version }, clockOffset: offset(msg.serverTime) });
      });

      set({ socket });
    },

    setReady: (ready) =>
      get().socket?.emit("seat:ready", { ready }, refused),

    setName: (name) =>
      get().socket?.emit("seat:name", { name }, (res) => {
        if (res.ok) storeName(name.trim().replace(/\s+/g, " "));
        else refused(res);
      }),

    setSetup: (setup) =>
      get().socket?.emit("room:setup", setup, refused),

    freshDice: () => get().socket?.emit("room:freshDice", refused),

    sendChat: (text, onSent) =>
      get().socket?.emit("chat:send", { text }, (res) => {
        if (res.ok) onSent?.();
        else refused(res);
      }),

    markChatRead: () => set({ chatReadAt: lastAt(get().snapshot?.chat ?? []) }),

    setRoundReady: (ready) =>
      get().socket?.emit("round:ready", { ready }, refused),

    startGame: () =>
      get().socket?.emit("game:start", refused),

    resetGame: () =>
      get().socket?.emit("game:reset", refused),

    exitGame: () =>
      get().socket?.emit("game:exit", refused),

    sendCommand: (command) =>
      get().socket?.emit("game:command", { commandId: uuid(), command }, refused),

    serverIsDown: () => set({ serverDown: true }),
  };
});

/** When the newest line of a log was posted (0 for an empty log). */
const lastAt = (chat: ChatMessage[]) => chat.at(-1)?.at ?? 0;

/** Flight log lines from the other player that this one hasn't seen. */
export function unreadChat(chat: ChatMessage[], me: string, readAt: number | null): number {
  return chat.filter((m) => m.playerId !== me && m.at > (readAt ?? Infinity)).length;
}
