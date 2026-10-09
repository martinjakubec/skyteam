// The admin API: statistics for those with view_stats, user management for
// those with manage_users. The SQL itself runs against a real PostgreSQL in
// pg-real.test.mjs; here the fake database answers.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("ioredis", () => import("./support/fakeRedis.mjs"));
vi.mock("pg", () => import("./support/fakePg.mjs"));
Object.assign(process.env, { DATABASE_URL: "postgres://fake/skyteam", TRUST_PROXY: "1", NPC_WORKERS: "1" });

const { startServer } = await import("./support/harness.mjs");
const { Pool: FakePg } = await import("./support/fakePg.mjs");
const { STAT_QUERIES, forStats } = await import("../packages/server/src/stats.ts");

let s;
beforeAll(async () => {
  s = await startServer();
});
afterAll(() => s.close());

/** A signed-in user with this role. */
async function as(username, role) {
  const u = await s.signUp(username);
  FakePg.last.users.find((x) => x.username === username).role = role;
  return u;
}

describe("statistics", () => {
  test("the dashboard's queries are the documented ones, word for word", () => {
    const squash = (t) => t.replace(/\s+/g, " ").trim();
    const docs = squash(readFileSync(new URL("../docs/game-log-queries.sql", import.meta.url), "utf8"));
    expect(Object.keys(STAT_QUERIES)).toEqual(["playRate", "crashCauses", "failedLandings", "winRateByAirport", "winRateByAbility", "winRateByModule", "humansVsBot", "unfinished"]);
    for (const [name, sql] of Object.entries(STAT_QUERIES)) expect(docs, name).toContain(squash(sql));
  });

  test("who may see them: a guest no, a USER no, an ADMIN and a SUPERADMIN yes — as the role's rows say now", async () => {
    expect(await s.api("GET", "/api/admin/stats")).toMatchObject({ status: 401, body: { error: "Please sign in." } });
    const user = await as("ursula", "USER");
    expect(await s.api("GET", "/api/admin/stats", { cookie: user.cookie })).toMatchObject({ status: 403, body: { error: "You don't have access to this." } });
    const admin = await as("adam", "ADMIN");
    expect((await s.api("GET", "/api/admin/stats", { cookie: admin.cookie })).status).toBe(200);
    const sa = await as("sam", "SUPERADMIN");
    expect((await s.api("GET", "/api/admin/stats", { cookie: sa.cookie })).status).toBe(200);
    // Privileges live in the database: take view_stats from ADMIN, and the next request is refused.
    const grants = FakePg.last.rolePrivileges;
    FakePg.last.rolePrivileges = grants.filter((p) => !(p.role === "ADMIN" && p.privilege === "view_stats"));
    expect((await s.api("GET", "/api/admin/stats", { cookie: admin.cookie })).status).toBe(403);
    FakePg.last.rolePrivileges = grants;
  });

  test("numbers arrive as numbers; same-dice games are left out unless asked for", async () => {
    const admin = await as("ada", "ADMIN");
    const db = FakePg.last;
    db.results.set(forStats(STAT_QUERIES.playRate, false), [{ scenario: "YUL", games: "3", pct_of_all_games: "75.0", finished: "2", finish_pct: "66.7", pct_of_finished_games: "100.0" }]);
    db.results.set(forStats(STAT_QUERIES.playRate, true), [{ scenario: "YUL", games: "4", pct_of_all_games: "80.0", finished: "2", pct_of_finished_games: null }]);
    db.results.set(forStats(STAT_QUERIES.unfinished, false), [{ result: "exited", rounds_reached: 2, games: "5" }]);
    const r = await s.api("GET", "/api/admin/stats", { cookie: admin.cookie });
    expect(r.body).toMatchObject({
      includeSeeded: false,
      playRate: [{ scenario: "YUL", games: 3, pct_of_all_games: 75, finished: 2, finish_pct: 66.7, pct_of_finished_games: 100 }],
      unfinished: [{ result: "exited", rounds_reached: 2, games: 5 }],
      crashCauses: [],
      recentGames: [],
    });
    expect(r.body.generatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const all = await s.api("GET", "/api/admin/stats?includeSeeded=1", { cookie: admin.cookie });
    expect(all.body).toMatchObject({ includeSeeded: true, playRate: [{ games: 4, pct_of_finished_games: null }] });
  });

  test("forStats wraps every games table in the filter, and nothing else", () => {
    const sql = "SELECT 1 FROM games, unnest(x) WHERE a IN (SELECT 1 FROM games)";
    expect(forStats(sql, true)).toBe(sql);
    expect(forStats(sql, false)).toBe(
      "SELECT 1 FROM (SELECT * FROM games WHERE seeded_from IS NULL) games, unnest(x) WHERE a IN (SELECT 1 FROM (SELECT * FROM games WHERE seeded_from IS NULL) games)",
    );
    expect(forStats("SELECT * FROM games_extra", false)).toBe("SELECT * FROM games_extra");
  });
});

describe("user management", async () => {
  const { env } = await import("../packages/server/src/env.ts");
  const row = (name) => FakePg.last.users.find((u) => u.username === name);

  test("only manage_users: an ADMIN is refused everywhere", async () => {
    const admin = await as("alma", "ADMIN");
    const target = await s.signUp("target1");
    for (const [method, path, body] of [
      ["GET", "/api/admin/users"],
      ["GET", "/api/admin/roles"],
      ["PATCH", `/api/admin/users/${target.user.id}`, { role: "ADMIN" }],
      ["POST", `/api/admin/users/${target.user.id}/reset-link`],
      ["DELETE", `/api/admin/users/${target.user.id}`],
    ]) expect((await s.api(method, path, { cookie: admin.cookie, body })).status, `${method} ${path}`).toBe(403);
  });

  test("the list: search by name start, a page of 50 at a time, with games played", async () => {
    const sa = await as("sara", "SUPERADMIN");
    for (let i = 0; i < 55; i++) await s.signUp(`zed${String(i).padStart(2, "0")}`);
    const first = await s.api("GET", "/api/admin/users?q=zed", { cookie: sa.cookie });
    expect(first.status).toBe(200);
    expect(first.body.users).toHaveLength(50);
    expect(first.body.users[0]).toMatchObject({ username: "zed00", role: "USER", disabled: false, games: 0, createdAt: expect.stringMatching(/^\d{4}-/) });
    const rest = await s.api("GET", `/api/admin/users?q=zed&after=${first.body.next}`, { cookie: sa.cookie });
    expect(rest.body.users.map((u) => u.username)).toEqual(["zed50", "zed51", "zed52", "zed53", "zed54"]);
    expect(rest.body.next).toBe(null);
    // "_" is a letter in a name, not a wildcard.
    await s.signUp("a_b");
    await s.signUp("axb");
    expect((await s.api("GET", "/api/admin/users?q=a_", { cookie: sa.cookie })).body.users.map((u) => u.username)).toEqual(["a_b"]);
  });

  test("roles, with their privileges", async () => {
    const sa = await as("sven", "SUPERADMIN");
    expect((await s.api("GET", "/api/admin/roles", { cookie: sa.cookie })).body.roles).toEqual([
      { name: "USER", rank: 1, privileges: ["history"] },
      { name: "ADMIN", rank: 2, privileges: ["history", "view_stats"] },
      { name: "SUPERADMIN", rank: 3, privileges: ["history", "manage_users", "view_stats"] },
    ]);
  });

  test("a new role takes effect at once; the user's session goes on", async () => {
    const sa = await as("sonja", "SUPERADMIN");
    const bob = await s.signUp("bobcat");
    const r = await s.api("PATCH", `/api/admin/users/${bob.user.id}`, { cookie: sa.cookie, body: { role: "ADMIN" } });
    expect(r).toMatchObject({ status: 200, body: { user: { username: "bobcat", role: "ADMIN", disabled: false } } });
    expect((await s.api("GET", "/api/auth/me", { cookie: bob.cookie })).body.user.privileges).toEqual(["history", "view_stats"]);
    expect((await s.api("PATCH", `/api/admin/users/${bob.user.id}`, { cookie: sa.cookie, body: { role: "PILOT" } })).status).toBe(400);
    expect((await s.api("PATCH", `/api/admin/users/${bob.user.id}`, { cookie: sa.cookie, body: {} })).status).toBe(400);
  });

  test("disable: sessions end and sign-in is refused; enable: back in", async () => {
    const sa = await as("selma", "SUPERADMIN");
    const dan = await s.signUp("danny");
    await new Promise((r) => setTimeout(r, 5));
    expect((await s.api("PATCH", `/api/admin/users/${dan.user.id}`, { cookie: sa.cookie, body: { disabled: true } })).body.user.disabled).toBe(true);
    expect((await s.api("GET", "/api/auth/me", { cookie: dan.cookie })).body.user).toBe(null);
    expect((await s.api("POST", "/api/auth/login", { body: { username: "danny", password: "ten chars!" } })).status).toBe(403);
    await s.api("PATCH", `/api/admin/users/${dan.user.id}`, { cookie: sa.cookie, body: { disabled: false } });
    expect((await s.api("POST", "/api/auth/login", { body: { username: "danny", password: "ten chars!" } })).status).toBe(200);
  });

  test("a reset link: one at a time, works once", async () => {
    const sa = await as("sylvia", "SUPERADMIN");
    const eve = await s.signUp("evelyn");
    const one = await s.api("POST", `/api/admin/users/${eve.user.id}/reset-link`, { cookie: sa.cookie });
    expect(one).toMatchObject({ status: 200, body: { path: expect.stringMatching(/^\/reset\?token=[A-Za-z0-9_-]{43}$/), expiresAt: expect.any(String) } });
    const two = await s.api("POST", `/api/admin/users/${eve.user.id}/reset-link`, { cookie: sa.cookie });
    const token = (r) => new URLSearchParams(r.body.path.split("?")[1]).get("token");
    expect((await s.api("POST", "/api/auth/reset", { body: { token: token(one), newPassword: "new password!" } })).status).toBe(410);
    expect((await s.api("POST", "/api/auth/reset", { body: { token: token(two), newPassword: "new password!" } })).status).toBe(200);
    expect((await s.api("POST", `/api/admin/users/${"n".repeat(21)}/reset-link`, { cookie: sa.cookie })).status).toBe(404);
  });

  test("delete: the account and its game links go, the games stay", async () => {
    const sa = await as("stella", "SUPERADMIN");
    const fay = await s.signUp("fayola");
    FakePg.last.games.push({ id: "f".repeat(21), room_id: "r", ended_at: new Date().toISOString() });
    FakePg.last.gamePlayers.push({ game_id: "f".repeat(21), user_id: fay.user.id, crew: "pilot" });
    expect((await s.api("DELETE", `/api/admin/users/${fay.user.id}`, { cookie: sa.cookie })).status).toBe(204);
    expect(row("fayola")).toBe(undefined);
    expect(FakePg.last.gamePlayers.some((p) => p.user_id === fay.user.id)).toBe(false);
    expect(FakePg.last.games.some((g) => g.id === "f".repeat(21))).toBe(true);
    expect((await s.api("GET", "/api/auth/me", { cookie: fay.cookie })).body.user).toBe(null);
    expect((await s.api("DELETE", `/api/admin/users/${fay.user.id}`, { cookie: sa.cookie })).status).toBe(404);
  });

  test("refused: your own account, and the site owner's account", async () => {
    const sa = await as("solo", "SUPERADMIN");
    expect(await s.api("PATCH", `/api/admin/users/${sa.user.id}`, { cookie: sa.cookie, body: { role: "USER" } })).toMatchObject({
      status: 409,
      body: { error: "Use your account page for your own account." },
    });
    expect((await s.api("DELETE", `/api/admin/users/${sa.user.id}`, { cookie: sa.cookie })).status).toBe(409);
    // Another manager may be demoted.
    const other = await as("second", "SUPERADMIN");
    expect((await s.api("PATCH", `/api/admin/users/${other.user.id}`, { cookie: sa.cookie, body: { role: "ADMIN" } })).status).toBe(200);
    // The owner's account (SUPERADMIN_USERNAME) can't be demoted, disabled or deleted.
    env.SUPERADMIN_USERNAME = "solo";
    const fresh = await as("fourth", "SUPERADMIN");
    for (const body of [{ role: "USER" }, { disabled: true }])
      expect(await s.api("PATCH", `/api/admin/users/${sa.user.id}`, { cookie: fresh.cookie, body })).toMatchObject({
        status: 409,
        body: { error: "This is the site owner's account (SUPERADMIN_USERNAME)." },
      });
    expect((await s.api("DELETE", `/api/admin/users/${sa.user.id}`, { cookie: fresh.cookie })).status).toBe(409);
    // ... but its role may be confirmed as it is.
    expect((await s.api("PATCH", `/api/admin/users/${sa.user.id}`, { cookie: fresh.cookie, body: { role: "SUPERADMIN" } })).status).toBe(200);
    env.SUPERADMIN_USERNAME = undefined;
    expect((await s.api("PATCH", `/api/admin/users/${"n".repeat(21)}`, { cookie: fresh.cookie, body: { role: "USER" } })).status).toBe(404);
  });
});
