import { useCallback, useEffect, useState } from "react";
import { useSignedIn } from "../account/Account";
import { call } from "../account/authApi";
import { useAccount } from "../account/useAccount";
import { when } from "../history/format";
import { navigate } from "../router";
import { AdminAlert, AdminCard, AdminLayout } from "./AdminLayout";

/**
 * User management (manage_users): find an account, change its role, disable
 * it, make a reset link to hand over, or delete it. Your own account is
 * managed on the account page, not here.
 */

interface ManagedUser {
  id: string;
  username: string;
  role: string;
  disabled: boolean;
  createdAt: string;
  games: number;
}
interface RoleInfo {
  name: string;
  rank: number;
  privileges: string[];
}

export default function AdminUsers() {
  const me = useSignedIn("/admin/users");
  const allowed = useAccount((s) => !!s.user?.privileges.includes("manage_users"));
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ username: string; url: string; expiresAt: string } | null>(null);

  /** A refused request: signed out goes to sign in; anything else is shown. */
  const refused = useCallback((r: { status: number; error: string }) => {
    if (r.status === 401) {
      useAccount.getState().setUser(null);
      navigate(`/signin?next=${encodeURIComponent("/admin/users")}`);
    } else setError(r.error);
  }, []);

  const load = useCallback(
    async (query: string, after?: string) => {
      const params = new URLSearchParams({ q: query, ...(after ? { after } : {}) });
      const r = await call<{ users: ManagedUser[]; next: string | null }>("GET", `/admin/users?${params}`);
      if (!r.ok) return refused(r);
      setUsers((u) => [...(after ? (u ?? []) : []), ...r.users]);
      setNext(r.next);
    },
    [refused],
  );

  useEffect(() => {
    if (!me || !allowed) return;
    void call<{ roles: RoleInfo[] }>("GET", "/admin/roles").then((r) => (r.ok ? setRoles(r.roles) : refused(r)));
  }, [me?.id, allowed, refused]); // eslint-disable-line react-hooks/exhaustive-deps

  // The search, a moment after the typing stops.
  useEffect(() => {
    if (!me || !allowed) return;
    const t = setTimeout(() => void load(q), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, me?.id, allowed, load]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!me) return null;
  if (!allowed) {
    return (
      <AdminLayout title="Users">
        <p className="adm-empty">You don't have access to this.</p>
      </AdminLayout>
    );
  }

  const replace = (u: ManagedUser) => setUsers((list) => list?.map((x) => (x.id === u.id ? u : x)) ?? null);
  const change = async (u: ManagedUser, body: { role?: string; disabled?: boolean }) => {
    setError(null);
    const r = await call<{ user: ManagedUser }>("PATCH", `/admin/users/${u.id}`, body);
    if (r.ok) replace(r.user);
    else refused(r);
  };
  const resetLink = async (u: ManagedUser) => {
    setError(null);
    const r = await call<{ path: string; expiresAt: string }>("POST", `/admin/users/${u.id}/reset-link`);
    if (r.ok) setLink({ username: u.username, url: `${window.location.origin}${r.path}`, expiresAt: r.expiresAt });
    else refused(r);
  };
  const remove = async (u: ManagedUser) => {
    if (window.prompt(`Type ${u.username} to delete this account. Its game history goes with it.`) !== u.username) return;
    setError(null);
    const r = await call("DELETE", `/admin/users/${u.id}`);
    if (r.ok) setUsers((list) => list?.filter((x) => x.id !== u.id) ?? null);
    else refused(r);
  };

  return (
    <AdminLayout title="Users">
      <label className="adm-search">
        Search by name
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Username starts with…" />
      </label>
      <AdminAlert error={error} />
      {link && (
        <section className="adm-card adm-reset">
          <label>
            {`Reset link for ${link.username}`}
            <input type="text" readOnly value={link.url} onFocus={(e) => e.target.select()} />
          </label>
          <div className="adm-reset-row">
            <button className="adm-primary" onClick={() => void navigator.clipboard?.writeText(link.url)}>
              Copy
            </button>
            <span>Works once, until {when(link.expiresAt)}. Hand it over yourself — it signs them in.</span>
          </div>
        </section>
      )}
      {users && users.length === 0 && <p className="adm-empty">No users match.</p>}
      {users && users.length > 0 && (
        <AdminCard>
          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Joined</th>
                  <th className="num">Games</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const mine = u.id === me.id;
                  return (
                    <tr key={u.id}>
                      <td>{u.username}</td>
                      <td>
                        {mine ? (
                          u.role
                        ) : (
                          <select aria-label={`Role of ${u.username}`} value={u.role} onChange={(e) => void change(u, { role: e.target.value })}>
                            {(roles.some((r) => r.name === u.role) ? roles : [...roles, { name: u.role, rank: 0, privileges: [] }]).map((r) => (
                              <option key={r.name} value={r.name}>
                                {r.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td>
                        <span className={u.disabled ? "adm-status off" : "adm-status"}>{u.disabled ? "disabled" : "active"}</span>
                      </td>
                      <td>{when(u.createdAt)}</td>
                      <td className="num">{u.games}</td>
                      <td className="adm-row-actions">
                        {mine ? (
                          <span className="adm-you">you</span>
                        ) : (
                          <>
                            <button onClick={() => void change(u, { disabled: !u.disabled })}>{u.disabled ? "Enable" : "Disable"}</button>
                            <button onClick={() => void resetLink(u)}>Reset link</button>
                            <button className="adm-danger" onClick={() => void remove(u)}>
                              Delete
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </AdminCard>
      )}
      {next && (
        <button className="adm-more" onClick={() => void load(q, next)}>
          Load more
        </button>
      )}
    </AdminLayout>
  );
}
