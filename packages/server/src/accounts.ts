import { nanoid } from "nanoid";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { MIN_PASSWORD_LENGTH, Username, type AccountWithCode, type PublicUser } from "@skyteam/shared";
import { db } from "./db";
import { env } from "./env";
import { ensureSchema } from "./schema";
import { DUMMY_HASH, hashPassword, newRecoveryCode, normalizeCode, sha256, verifyPassword } from "./passwords";

/**
 * Accounts: registering, signing in, recovering a forgotten password (with the
 * recovery code, or a reset link a SUPERADMIN made) and the account's own
 * settings. Passwords are scrypt-hashed; recovery codes and reset tokens, which
 * have plenty of entropy, are stored as SHA-256.
 *
 * Every query starts with a tag comment (/* users.insert *\/): Postgres ignores
 * it, and the tests' fake database recognises the query by it.
 *
 * Times are the server's (passed as parameters, not the database's now()), so
 * a session's issue time and the account's `sessions_after` share one clock.
 */

export type AccountErrorCode = "taken" | "reserved" | "disabled" | "not_found" | "forbidden" | "invalid" | "no_db";

export class AccountError extends Error {
  constructor(message: string, readonly code: AccountErrorCode) {
    super(message);
    this.name = "AccountError";
  }
}

/** Names nobody may register: they'd pass for the site's own. The owner's
 *  (SUPERADMIN_USERNAME) is created by the server, never registered. */
const RESERVED = new Set(["admin", "administrator", "superadmin", "root", "system", "bot", "guest", "skyteam", "moderator"]);

const RESET_LINK_HOURS = 24;

export const SQL = {
  insertUser: `/* users.insert */ INSERT INTO users (id, username, password_hash, recovery_hash, role, sessions_after, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $6) ON CONFLICT (username) DO NOTHING`,
  userByName: `/* users.byName */ SELECT id, username, password_hash, recovery_hash, role, disabled_at FROM users WHERE username = $1`,
  userById: `/* users.byId */ SELECT u.id, u.username, u.role, u.password_hash, u.disabled_at, u.sessions_after,
      coalesce(array_agg(p.privilege ORDER BY p.privilege) FILTER (WHERE p.privilege IS NOT NULL), '{}') AS privileges
    FROM users u LEFT JOIN role_privileges p ON p.role = u.role
    WHERE u.id = $1 GROUP BY u.id`,
  setCredentials: `/* users.setCredentials */ UPDATE users SET password_hash = $2, recovery_hash = $3, sessions_after = $4 WHERE id = $1`,
  setPassword: `/* users.setPassword */ UPDATE users SET password_hash = $2, sessions_after = $3 WHERE id = $1`,
  setRecovery: `/* users.setRecovery */ UPDATE users SET recovery_hash = $2 WHERE id = $1`,
  endSessions: `/* users.endSessions */ UPDATE users SET sessions_after = $2 WHERE id = $1`,
  setRole: `/* users.setRole */ UPDATE users SET role = $2 WHERE id = $1`,
  deleteUser: `/* users.delete */ DELETE FROM users WHERE id = $1`,
  dropResets: `/* resets.dropUnused */ DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL`,
  insertReset: `/* resets.insert */ INSERT INTO password_resets (token_hash, user_id, created_by, expires_at) VALUES ($1, $2, $3, $4)`,
  takeReset: `/* resets.take */ UPDATE password_resets SET used_at = $2
    WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING user_id`,
} as const;

interface UserRow {
  id: string;
  username: string;
  role: string;
  password_hash: string;
  disabled_at: Date | null;
  sessions_after: Date;
  privileges: string[];
}

/** The pool, with the tables in place; refuses while there's no database. */
async function pool() {
  const p = db();
  if (!p) throw new AccountError("Accounts need the database.", "no_db");
  await ensureSchema();
  return p;
}

const toPublic = (u: Pick<UserRow, "id" | "username" | "role" | "privileges">): PublicUser => ({
  id: u.id,
  username: u.username,
  role: u.role,
  privileges: [...u.privileges].sort(),
});

/** An account with its privileges (from its role's rows), or null. */
export async function userById(id: string): Promise<(PublicUser & { disabled: boolean; sessionsAfter: Date; passwordHash: string }) | null> {
  const row = (await (await pool()).query<UserRow>(SQL.userById, [id])).rows[0];
  if (!row) return null;
  return { ...toPublic(row), disabled: row.disabled_at !== null, sessionsAfter: new Date(row.sessions_after), passwordHash: row.password_hash };
}

/** Create an account. Throws "taken" or "reserved"; the name is checked again
 *  here, whatever the caller already did. */
export async function register(username: string, password: string): Promise<AccountWithCode> {
  const name = Username.safeParse(username);
  if (!name.success) throw new AccountError(name.error.issues[0].message, "invalid");
  if (RESERVED.has(name.data) || name.data === env.SUPERADMIN_USERNAME) throw new AccountError("That username is reserved.", "reserved");
  if (password.length < MIN_PASSWORD_LENGTH) throw new AccountError(`Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`, "invalid");
  return createUser(name.data, password, "USER");
}

async function createUser(username: string, password: string, role: string): Promise<AccountWithCode> {
  const p = await pool();
  const id = nanoid();
  const recoveryCode = newRecoveryCode();
  const inserted = await p.query(SQL.insertUser, [id, username, await hashPassword(password), sha256(recoveryCode), role, new Date()]);
  if (inserted.rowCount === 0) throw new AccountError("That username is taken.", "taken");
  return { user: toPublic((await userById(id))!), recoveryCode };
}

/** The account these credentials open, or null (a wrong password and an unknown
 *  name look alike, timing included). Throws "disabled" for a disabled account
 *  with the right password. */
export async function login(username: string, password: string): Promise<PublicUser | null> {
  const row = (await (await pool()).query(SQL.userByName, [username])).rows[0] as { id: string; password_hash: string; disabled_at: Date | null } | undefined;
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!ok || !row) return null;
  if (row.disabled_at) throw new AccountError("This account is disabled.", "disabled");
  return toPublic((await userById(row.id))!);
}

/** A new password and recovery code; every earlier session ends. */
async function setCredentials(userId: string, password: string): Promise<AccountWithCode> {
  const recoveryCode = newRecoveryCode();
  await (await pool()).query(SQL.setCredentials, [userId, await hashPassword(password), sha256(recoveryCode), new Date()]);
  return { user: toPublic((await userById(userId))!), recoveryCode };
}

/** Forgot password: the recovery code sets a new password, and is used up (a
 *  new one comes back). Null for a wrong name or code. */
export async function recover(username: string, code: string, newPassword: string): Promise<AccountWithCode | null> {
  const row = (await (await pool()).query(SQL.userByName, [username])).rows[0] as { id: string; recovery_hash: string; disabled_at: Date | null } | undefined;
  const given = Buffer.from(sha256(normalizeCode(code)));
  const want = Buffer.from(row?.recovery_hash ?? sha256("no such user"));
  if (!row || !timingSafeEqual(given, want)) return null;
  if (row.disabled_at) throw new AccountError("This account is disabled.", "disabled");
  return setCredentials(row.id, newPassword);
}

/** A one-time link to set a new password (a SUPERADMIN hands it over). It
 *  replaces any unused link for that user. */
export async function createResetLink(byUserId: string, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const p = await pool();
  if (!(await userById(userId))) throw new AccountError("No such user.", "not_found");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_LINK_HOURS * 3600_000);
  await p.query(SQL.dropResets, [userId]);
  await p.query(SQL.insertReset, [sha256(token), userId, byUserId, expiresAt]);
  return { token, expiresAt };
}

/** Use a reset link: null when it is unknown, used or expired. */
export async function resetWithToken(token: string, newPassword: string): Promise<AccountWithCode | null> {
  const taken = (await (await pool()).query(SQL.takeReset, [sha256(token), new Date()])).rows[0] as { user_id: string } | undefined;
  if (!taken) return null;
  return setCredentials(taken.user_id, newPassword);
}

/** Change the password, knowing the current one; every session ends (the
 *  caller issues a fresh one). */
export async function changePassword(userId: string, current: string, next: string): Promise<boolean> {
  const user = await userById(userId);
  if (!user || !(await verifyPassword(current, user.passwordHash))) return false;
  await (await pool()).query(SQL.setPassword, [userId, await hashPassword(next), new Date()]);
  return true;
}

/** A new recovery code (the old one stops working), knowing the password. */
export async function newRecoveryCodeFor(userId: string, password: string): Promise<string | null> {
  const user = await userById(userId);
  if (!user || !(await verifyPassword(password, user.passwordHash))) return null;
  const code = newRecoveryCode();
  await (await pool()).query(SQL.setRecovery, [userId, sha256(code)]);
  return code;
}

/** Sign out everywhere: every session issued until now ends. */
export async function endSessions(userId: string): Promise<void> {
  await (await pool()).query(SQL.endSessions, [userId, new Date()]);
}

/** Delete your own account, knowing the password. Its game rows stay (they're
 *  anonymous); the links to them go with it. */
export async function deleteOwnAccount(userId: string, password: string): Promise<boolean> {
  const user = await userById(userId);
  if (!user || !(await verifyPassword(password, user.passwordHash))) return false;
  await (await pool()).query(SQL.deleteUser, [userId]);
  return true;
}

/**
 * The site owner's account (SUPERADMIN_USERNAME): created as SUPERADMIN with
 * SUPERADMIN_INITIAL_PASSWORD when it doesn't exist, kept SUPERADMIN when it
 * does (its password is then left alone). Nobody can register the name first:
 * registration refuses it.
 */
export async function bootstrapSuperadmin(): Promise<"created" | "promoted" | "unchanged" | "off"> {
  const name = env.SUPERADMIN_USERNAME;
  if (!name || !db()) return "off";
  if (!/^[a-z0-9_.-]{3,24}$/.test(name)) {
    console.error(`[accounts] SUPERADMIN_USERNAME "${name}" is not a valid username (3–24 of a-z 0-9 . _ -).`);
    return "off";
  }
  const p = await pool();
  const row = (await p.query(SQL.userByName, [name])).rows[0] as { id: string; role: string } | undefined;
  if (row) {
    if (row.role === "SUPERADMIN") return "unchanged";
    await p.query(SQL.setRole, [row.id, "SUPERADMIN"]);
    return "promoted";
  }
  const password = env.SUPERADMIN_INITIAL_PASSWORD;
  // Production wants a real password; locally anything goes (e.g. admin/admin).
  const minimum = process.env.NODE_ENV === "production" ? MIN_PASSWORD_LENGTH : 1;
  if (!password || password.length < minimum) {
    console.error(`[accounts] SUPERADMIN_INITIAL_PASSWORD must be set (at least ${minimum} characters) to create "${name}".`);
    return "off";
  }
  try {
    await createUser(name, password, "SUPERADMIN");
  } catch (e) {
    if (e instanceof AccountError && e.code === "taken") return "unchanged"; // another server instance won the race
    throw e;
  }
  return "created";
}
