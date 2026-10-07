// Accounts: password hashing, recovery codes, users, sessions and the first
// SUPERADMIN. The database is the in-memory fake (tests/support/fakePg.mjs);
// the same SQL runs against a real PostgreSQL in pg-real.test.mjs.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { hashPassword, verifyPassword, DUMMY_HASH, newRecoveryCode, normalizeCode, sha256 } = await import("../packages/server/src/passwords.ts");

// --- passwords and recovery codes ---------------------------------------------------

test("a password verifies against its own hash, and nothing else does", async () => {
  const h = await hashPassword("correct horse battery");
  expect(h).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  expect(await verifyPassword("correct horse battery", h)).toBe(true);
  expect(await verifyPassword("correct horse batterY", h)).toBe(false);
  expect(await hashPassword("correct horse battery")).not.toBe(h); // salted
});

test("a malformed stored hash verifies nothing, and doesn't throw", async () => {
  const bad = ["", "plain", "scrypt$1$2$3$x$y", "scrypt$1024$8$1$AAAA$AAAA", "scrypt$33000$8$1$AAAA$AAAA", "bcrypt$2b$10$abc"];
  for (const stored of bad) expect(await verifyPassword("whatever123456", stored)).toBe(false);
  expect(await verifyPassword("whatever123456", DUMMY_HASH)).toBe(false);
  expect(await verifyPassword("", DUMMY_HASH)).toBe(false);
});

test("recovery codes: 4 groups of 5 Crockford letters, never the same twice", () => {
  const codes = new Set(Array.from({ length: 1000 }, newRecoveryCode));
  expect(codes.size).toBe(1000);
  for (const c of codes) expect(c).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){3}[0-9A-HJKMNP-TV-Z]{5}$/);
});

test("a recovery code typed loosely still reads as the code", () => {
  expect(normalizeCode("abcde fghjk-mnpqr-stvwo")).toBe("ABCDE-FGHJK-MNPQR-STVW0");
  expect(normalizeCode(" 1i2l3-45678 9abcd efghj ")).toBe("11213-45678-9ABCD-EFGHJ");
  expect(normalizeCode("short")).toBe("SH0RT");
  expect(sha256("x")).toMatch(/^[0-9a-f]{64}$/);
});

// --- accounts and sessions (fake database) -------------------------------------------

describe("accounts", async () => {
  vi.mock("pg", () => import("./support/fakePg.mjs"));
  vi.mock("ioredis", () => import("./support/fakeRedis.mjs"));
  process.env.DATABASE_URL = "postgres://fake/skyteam";
  const { Pool: FakePg } = await import("./support/fakePg.mjs");
  const { initDb } = await import("../packages/server/src/db.ts");
  const { env } = await import("../packages/server/src/env.ts");
  const acc = await import("../packages/server/src/accounts.ts");
  const { issueSession, sessionUser, readCookie } = await import("../packages/server/src/sessions.ts");
  const { issueToken, verifyToken } = await import("../packages/server/src/identity.ts");
  initDb();
  const row = (name) => FakePg.last.users.find((u) => u.username === name);
  let clock = Date.parse("2026-10-08T12:00:00Z");
  const tick = (ms = 5) => vi.setSystemTime((clock += ms));
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    tick();
  });
  afterEach(() => vi.useRealTimers());

  test("register: a USER with the history privilege and a recovery code; nothing stored in plain text", async () => {
    const { user, recoveryCode } = await acc.register("alice", "ten chars!");
    expect(user).toEqual({ id: expect.any(String), username: "alice", role: "USER", privileges: ["history"] });
    expect(recoveryCode).toMatch(/^([0-9A-Z]{5}-){3}[0-9A-Z]{5}$/);
    const stored = JSON.stringify(row("alice"));
    expect(stored).not.toContain("ten chars!");
    expect(stored).not.toContain(recoveryCode);
  });

  test("register: a taken, reserved or malformed name, or a short password, is refused", async () => {
    await acc.register("bob", "ten chars!");
    await expect(acc.register("bob", "another one!")).rejects.toMatchObject({ code: "taken", message: "That username is taken." });
    await expect(acc.register("admin", "ten chars!")).rejects.toMatchObject({ code: "reserved" });
    env.SUPERADMIN_USERNAME = "owner";
    await expect(acc.register("owner", "ten chars!")).rejects.toMatchObject({ code: "reserved" });
    env.SUPERADMIN_USERNAME = undefined;
    await expect(acc.register("Bo b", "ten chars!")).rejects.toMatchObject({ code: "invalid" });
    await expect(acc.register("carl", "short")).rejects.toMatchObject({ code: "invalid" });
  });

  test("login: the right password, a wrong one, an unknown name (still hashed), a disabled account", async () => {
    await acc.register("dora", "ten chars!");
    expect(await acc.login("dora", "ten chars!")).toMatchObject({ username: "dora" });
    expect(await acc.login("dora", "ten chars?")).toBe(null);
    expect(await acc.login("nobody", "ten chars!")).toBe(null);
    row("dora").disabled_at = new Date();
    await expect(acc.login("dora", "ten chars!")).rejects.toMatchObject({ code: "disabled", message: "This account is disabled." });
  });

  test("recover: the code sets a new password once, and a new code comes back", async () => {
    const { recoveryCode } = await acc.register("emma", "ten chars!");
    expect(await acc.recover("emma", "AAAAA-AAAAA-AAAAA-AAAAA", "new password!")).toBe(null);
    expect(await acc.recover("nobody", recoveryCode, "new password!")).toBe(null);
    tick();
    const out = await acc.recover("emma", recoveryCode.toLowerCase().replace(/-/g, " "), "new password!");
    expect(out.recoveryCode).not.toBe(recoveryCode);
    expect(await acc.login("emma", "ten chars!")).toBe(null);
    expect(await acc.login("emma", "new password!")).toMatchObject({ username: "emma" });
    expect(await acc.recover("emma", recoveryCode, "third password")).toBe(null); // used up
    expect(await acc.recover("emma", out.recoveryCode, "third password")).not.toBe(null);
  });

  test("reset links: work once, replace older ones, expire after 24 hours, stored only hashed", async () => {
    const { user } = await acc.register("finn", "ten chars!");
    const first = await acc.createResetLink(user.id, user.id);
    const second = await acc.createResetLink(user.id, user.id);
    expect(JSON.stringify(FakePg.last.resets)).not.toContain(second.token);
    expect(await acc.resetWithToken(first.token, "new password!")).toBe(null); // replaced
    expect(await acc.resetWithToken(second.token, "new password!")).toMatchObject({ user: { username: "finn" } });
    expect(await acc.resetWithToken(second.token, "again password")).toBe(null); // used
    const third = await acc.createResetLink(user.id, user.id);
    tick(24 * 3600_000 + 1);
    expect(await acc.resetWithToken(third.token, "new password!")).toBe(null); // expired
    await expect(acc.createResetLink(user.id, "no-such-id")).rejects.toMatchObject({ code: "not_found" });
  });

  test("a session names its user; a player's identity token is not a session, nor the reverse", async () => {
    const { user } = await acc.register("gina", "ten chars!");
    const session = issueSession(user.id);
    expect(await sessionUser(session)).toEqual(user);
    expect(await sessionUser(issueToken().token)).toBe(null);
    expect(verifyToken(session)).toBe(null);
    expect(await sessionUser("garbage")).toBe(null);
    expect(await sessionUser(undefined)).toBe(null);
  });

  test("ending sessions: sign out everywhere, a password change, disabling, deleting", async () => {
    const { user } = await acc.register("hugo", "ten chars!");
    let s = issueSession(user.id);
    tick();
    await acc.endSessions(user.id);
    expect(await sessionUser(s)).toBe(null);
    tick();
    s = issueSession(user.id);
    expect(await sessionUser(s)).not.toBe(null);
    tick();
    expect(await acc.changePassword(user.id, "wrong one!!", "new password!")).toBe(false);
    expect(await sessionUser(s)).not.toBe(null);
    expect(await acc.changePassword(user.id, "ten chars!", "new password!")).toBe(true);
    expect(await sessionUser(s)).toBe(null);
    tick();
    s = issueSession(user.id);
    row("hugo").disabled_at = new Date();
    expect(await sessionUser(s)).toBe(null);
    row("hugo").disabled_at = null;
    expect(await sessionUser(s)).not.toBe(null);
    expect(await acc.deleteOwnAccount(user.id, "ten chars!")).toBe(false);
    expect(await acc.deleteOwnAccount(user.id, "new password!")).toBe(true);
    expect(await sessionUser(s)).toBe(null);
  });

  test("a new recovery code needs the password and retires the old one", async () => {
    const { user, recoveryCode } = await acc.register("ivan", "ten chars!");
    expect(await acc.newRecoveryCodeFor(user.id, "wrong one!!")).toBe(null);
    const code = await acc.newRecoveryCodeFor(user.id, "ten chars!");
    expect(await acc.recover("ivan", recoveryCode, "new password!")).toBe(null);
    expect(await acc.recover("ivan", code, "new password!")).not.toBe(null);
  });

  test("privileges follow the role's rows in the database", async () => {
    const { user } = await acc.register("jane", "ten chars!");
    const s = issueSession(user.id);
    row("jane").role = "ADMIN";
    expect((await sessionUser(s)).privileges).toEqual(["history", "view_stats"]);
    FakePg.last.rolePrivileges = FakePg.last.rolePrivileges.filter((p) => !(p.role === "ADMIN" && p.privilege === "view_stats"));
    expect((await sessionUser(s)).privileges).toEqual(["history"]);
  });

  test("the first SUPERADMIN: created from the env, kept SUPERADMIN, off without a password", async () => {
    env.SUPERADMIN_USERNAME = "admin";
    env.SUPERADMIN_INITIAL_PASSWORD = undefined;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await acc.bootstrapSuperadmin()).toBe("off");
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/SUPERADMIN_INITIAL_PASSWORD/));
    env.SUPERADMIN_INITIAL_PASSWORD = "admin"; // short is fine outside production
    expect(await acc.bootstrapSuperadmin()).toBe("created");
    const owner = await acc.login("admin", "admin");
    expect(owner).toMatchObject({ role: "SUPERADMIN", privileges: ["history", "manage_users", "view_stats"] });
    expect(await acc.bootstrapSuperadmin()).toBe("unchanged");
    row("admin").role = "USER";
    expect(await acc.bootstrapSuperadmin()).toBe("promoted");
    expect(row("admin").role).toBe("SUPERADMIN");
    env.SUPERADMIN_USERNAME = "Not Valid";
    expect(await acc.bootstrapSuperadmin()).toBe("off");
    env.SUPERADMIN_USERNAME = undefined;
    expect(await acc.bootstrapSuperadmin()).toBe("off");
    error.mockRestore();
  });

  test("readCookie finds one cookie among several", () => {
    expect(readCookie("a=1; skyteam_session=abc.def=; b=2", "skyteam_session")).toBe("abc.def=");
    expect(readCookie(undefined, "skyteam_session")).toBe(undefined);
    expect(readCookie("other=1", "skyteam_session")).toBe(undefined);
  });
});

test("production needs its own session secret", async () => {
  const { productionProblems } = await import("../packages/server/src/env.ts");
  const good = { NODE_ENV: "production", JWT_SECRET: "a".repeat(64), SESSION_SECRET: "b".repeat(64), CLIENT_ORIGIN: "https://x.example" };
  expect(productionProblems(good)).toEqual([]);
  expect(productionProblems({ ...good, SESSION_SECRET: undefined }).join()).toMatch(/SESSION_SECRET/);
  expect(productionProblems({ ...good, SESSION_SECRET: "short" }).join()).toMatch(/SESSION_SECRET/);
  expect(productionProblems({ ...good, SESSION_SECRET: "dev-insecure-session-secret-change-me" }).join()).toMatch(/SESSION_SECRET/);
  expect(productionProblems({ ...good, SESSION_SECRET: good.JWT_SECRET }).join()).toMatch(/differ/);
});
