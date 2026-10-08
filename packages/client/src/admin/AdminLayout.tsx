import { useEffect, type ReactNode } from "react";
import { useAccount } from "../account/useAccount";
import { Link, usePath } from "../router";
import "./admin.css";

/**
 * The admin pages' frame: a plain, standard dashboard look of their own (not
 * the game's cockpit style) — a top bar with the sections this account may
 * open, and the page under it.
 */
export function AdminLayout({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  const user = useAccount((s) => s.user);
  const path = usePath();
  const can = (p: string) => !!user?.privileges.includes(p);
  useNoIndex();

  const tab = (to: string, label: string) => (
    <Link to={to} className={path === to ? "adm-tab active" : "adm-tab"} aria-current={path === to ? "page" : undefined}>
      {label}
    </Link>
  );

  return (
    <div className="adm-shell">
      <header className="adm-topbar">
        <div className="adm-topbar-inner">
          <span className="adm-brand">
            SkyTeam <span>Admin</span>
          </span>
          <nav className="adm-tabs" aria-label="Admin">
            {can("view_stats") && tab("/admin", "Statistics")}
            {can("manage_users") && tab("/admin/users", "Users")}
          </nav>
          <div className="adm-user">
            {user && <span className="adm-user-name">{user.username}</span>}
            <Link to="/" className="adm-link">
              Back to the game
            </Link>
          </div>
        </div>
      </header>
      <main className="adm-main">
        <div className="adm-page-head">
          <h1>{title}</h1>
          {actions && <div className="adm-actions">{actions}</div>}
        </div>
        {children}
      </main>
    </div>
  );
}

/** A section of a page: a card with a title and, optionally, a note. */
export function AdminCard({ title, note, labelledBy, children }: { title?: string; note?: string; labelledBy?: string; children: ReactNode }) {
  return (
    <section className="adm-card" aria-labelledby={title ? labelledBy : undefined}>
      {title && (
        <header className="adm-card-head">
          <h2 id={labelledBy}>{title}</h2>
          {note && <p>{note}</p>}
        </header>
      )}
      {children}
    </section>
  );
}

/** The server's refusal, in the admin style. */
export const AdminAlert = ({ error }: { error: string | null }) =>
  error ? (
    <p role="alert" className="adm-alert">
      {error}
    </p>
  ) : null;

/** Keep the admin pages out of search engines. */
export function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}
