import { useEffect, useRef, useState } from "react";
import { Link } from "../router";
import { useAccount } from "./useAccount";

/**
 * Sign in / Register for a guest; for a signed-in user, their name opening a
 * menu (My games, Account, and Statistics / Users when their role grants it).
 * In a room the links open a new tab, so the game in this one goes on.
 */
export function AccountChip({ newTab = false }: { newTab?: boolean }) {
  const { user, available, signOut, has } = useAccount();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // A click anywhere else closes the menu.
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current?.contains(e.target as Node) || setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!available || user === undefined) return null;
  if (!user) {
    return (
      <div className="account-chip">
        <Link to="/signin" newTab={newTab}>Sign in</Link>
        <Link to="/register" newTab={newTab}>Register</Link>
      </div>
    );
  }
  return (
    <div className="account-chip" ref={ref}>
      <button className="chip-name" aria-expanded={open} onClick={() => setOpen(!open)}>
        {user.username}
      </button>
      {open && (
        <nav className="account-menu" onClick={() => setOpen(false)}>
          <Link to="/history" newTab={newTab}>My games</Link>
          <Link to="/account" newTab={newTab}>Account</Link>
          {has("view_stats") && <Link to="/admin" newTab={newTab}>Statistics</Link>}
          {has("manage_users") && <Link to="/admin/users" newTab={newTab}>Users</Link>}
          <button onClick={() => void signOut()}>Sign out</button>
        </nav>
      )}
    </div>
  );
}
