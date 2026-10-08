import { AccountError, SQL, createResetLink } from "./accounts";
import { db } from "./db";
import { env } from "./env";
import { ensureSchema } from "./schema";

/**
 * User management (manage_users): the list of accounts, their roles, and what a
 * manager may change — a role, disabled or not, a reset link, deletion. Never
 * their own account (that's the account page), never the site owner's
 * (SUPERADMIN_USERNAME), and never so that nobody is left who can manage users.
 */

export const USERS_PAGE = 50;

export interface ManagedUser {
  id: string;
  username: string;
  role: string;
  disabled: boolean;
  createdAt: string;
  /** Games linked to the account. */
  games: number;
}

export interface RoleInfo {
  name: string;
  rank: number;
  privileges: string[];
}

export const ADMIN_SQL = {
  list: `/* users.list */ SELECT u.id, u.username, u.role, u.disabled_at, u.created_at,
      (SELECT count(*) FROM game_players p WHERE p.user_id = u.id) AS games
    FROM users u WHERE u.username LIKE $1 ESCAPE '!' AND u.username > $2
    ORDER BY u.username LIMIT ${USERS_PAGE + 1}`,
  one: `/* users.one */ SELECT u.id, u.username, u.role, u.disabled_at, u.created_at,
      (SELECT count(*) FROM game_players p WHERE p.user_id = u.id) AS games
    FROM users u WHERE u.id = $1`,
  roles: `/* roles.list */ SELECT r.name, r.rank,
      coalesce(array_agg(p.privilege ORDER BY p.privilege) FILTER (WHERE p.privilege IS NOT NULL), '{}') AS privileges
    FROM roles r LEFT JOIN role_privileges p ON p.role = r.name GROUP BY r.name, r.rank ORDER BY r.rank`,
  otherManagers: `/* users.otherManagers */ SELECT count(*) AS n FROM users u
    JOIN role_privileges p ON p.role = u.role AND p.privilege = 'manage_users'
    WHERE u.disabled_at IS NULL AND u.id <> $1`,
  setDisabled: `/* users.setDisabled */ UPDATE users SET disabled_at = $2, sessions_after = coalesce($3, sessions_after) WHERE id = $1`,
} as const;

async function pool() {
  const p = db();
  if (!p) throw new AccountError("Accounts need the database.", "no_db");
  await ensureSchema();
  return p;
}

const toManaged = (r: Record<string, unknown>): ManagedUser => ({
  id: r.id as string,
  username: r.username as string,
  role: r.role as string,
  disabled: r.disabled_at !== null && r.disabled_at !== undefined,
  createdAt: new Date(r.created_at as string).toISOString(),
  games: Number(r.games ?? 0),
});

/** Accounts whose names start with `q`, 50 a page, after `after` (a username). */
export async function listUsers(q: string, after = ""): Promise<{ users: ManagedUser[]; next: string | null }> {
  const prefix = q.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{0,24}$/.test(prefix)) return { users: [], next: null };
  const pattern = `${prefix.replace(/[!%_]/g, (c) => `!${c}`)}%`;
  const rows = (await (await pool()).query(ADMIN_SQL.list, [pattern, after])).rows;
  const users = rows.slice(0, USERS_PAGE).map(toManaged);
  return { users, next: rows.length > USERS_PAGE ? users.at(-1)!.username : null };
}

export async function listRoles(): Promise<RoleInfo[]> {
  return (await (await pool()).query(ADMIN_SQL.roles)).rows.map((r) => ({ name: r.name, rank: Number(r.rank), privileges: r.privileges }));
}

async function managed(id: string): Promise<ManagedUser> {
  const r = (await (await pool()).query(ADMIN_SQL.one, [id])).rows[0];
  if (!r) throw new AccountError("No such user.", "not_found");
  return toManaged(r);
}

/** Refuse a change to `target` that a manager (`byId`) may not make. `losesManage`:
 *  the change takes the target's manage_users away (or the whole account). */
async function mayChange(byId: string, target: ManagedUser, losesManage: boolean): Promise<void> {
  if (target.id === byId) throw new AccountError("Use your account page for your own account.", "forbidden");
  if (!losesManage) return;
  if (target.username === env.SUPERADMIN_USERNAME) throw new AccountError("This is the site owner's account (SUPERADMIN_USERNAME).", "forbidden");
  // A backstop for two managers acting at once: someone must be left who can manage users.
  const roles = await listRoles();
  const manages = (role: string) => !!roles.find((r) => r.name === role)?.privileges.includes("manage_users");
  if (manages(target.role) && !target.disabled) {
    const others = Number((await (await pool()).query(ADMIN_SQL.otherManagers, [target.id])).rows[0]?.n ?? 0);
    if (others === 0) throw new AccountError("Someone must be left who can manage users.", "forbidden");
  }
}

/** Change an account's role and/or whether it's disabled. Disabling ends its
 *  sessions; a new role applies at once (privileges are read per request). */
export async function updateUser(byId: string, id: string, change: { role?: string; disabled?: boolean }): Promise<ManagedUser> {
  const target = await managed(id);
  if (change.role !== undefined) {
    const roles = await listRoles();
    const role = roles.find((r) => r.name === change.role);
    if (!role) throw new AccountError("There's no such role.", "invalid");
    const losesManage = !role.privileges.includes("manage_users") || target.username === env.SUPERADMIN_USERNAME;
    await mayChange(byId, target, losesManage && change.role !== target.role);
    await (await pool()).query(SQL.setRole, [id, change.role]);
  }
  if (change.disabled !== undefined && change.disabled !== target.disabled) {
    await mayChange(byId, target, change.disabled);
    const now = new Date();
    await (await pool()).query(ADMIN_SQL.setDisabled, [id, change.disabled ? now : null, change.disabled ? now : null]);
  }
  return managed(id);
}

/** A one-time link (path) to set a new password, for a manager to hand over. */
export async function resetLinkFor(byId: string, id: string): Promise<{ path: string; expiresAt: string }> {
  const target = await managed(id);
  await mayChange(byId, target, false);
  const { token, expiresAt } = await createResetLink(byId, id);
  return { path: `/reset?token=${token}`, expiresAt: expiresAt.toISOString() };
}

/** Delete an account: its sessions end, its links to games go; the games stay. */
export async function deleteUser(byId: string, id: string): Promise<void> {
  const target = await managed(id);
  await mayChange(byId, target, true);
  await (await pool()).query(SQL.deleteUser, [id]);
}
