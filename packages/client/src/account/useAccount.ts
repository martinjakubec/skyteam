import { create } from "zustand";
import type { Privilege, PublicUser } from "@skyteam/shared";
import { useGame } from "../store";
import { authApi } from "./authApi";

interface AccountState {
  /** The signed-in user; null for a guest; undefined until the server answered. */
  user: PublicUser | null | undefined;
  /** False when the server has no accounts (no database) or can't be reached:
   *  the sign-in links hide, and people play as guests. */
  available: boolean;
  /** Ask the server who's signed in (on start, and when the tab gets focus). */
  load: () => Promise<void>;
  setUser: (user: PublicUser | null) => void;
  signOut: () => Promise<void>;
  has: (privilege: Privilege) => boolean;
}

export const useAccount = create<AccountState>((set, get) => {
  /** A different account than before (signed in or out, maybe in another tab):
   *  a room's socket reconnects, so the server links the seat to the account
   *  as it is now. */
  const apply = (user: PublicUser | null) => {
    const before = get().user;
    set({ user });
    if (before !== undefined && (before?.id ?? null) !== (user?.id ?? null)) {
      const socket = useGame.getState().socket;
      if (socket) {
        socket.disconnect();
        socket.connect();
      }
    }
  };
  return {
    user: undefined,
    available: true,
    load: async () => {
      const r = await authApi.me();
      if (r.ok) {
        set({ available: true });
        apply(r.user);
      } else {
        set({ available: false });
        apply(null);
      }
    },
    setUser: apply,
    signOut: async () => {
      await authApi.logout();
      apply(null);
    },
    has: (privilege) => !!get().user?.privileges.includes(privilege),
  };
});
