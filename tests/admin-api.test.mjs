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
    db.results.set(forStats(STAT_QUERIES.playRate, false), [{ scenario: "YUL", games: "3", pct_of_all_games: "75.0", finished: "2", pct_of_finished_games: "100.0" }]);
    db.results.set(forStats(STAT_QUERIES.playRate, true), [{ scenario: "YUL", games: "4", pct_of_all_games: "80.0", finished: "2", pct_of_finished_games: null }]);
    db.results.set(forStats(STAT_QUERIES.unfinished, false), [{ result: "exited", rounds_reached: 2, games: "5" }]);
    const r = await s.api("GET", "/api/admin/stats", { cookie: admin.cookie });
    expect(r.body).toMatchObject({
      includeSeeded: false,
      playRate: [{ scenario: "YUL", games: 3, pct_of_all_games: 75, finished: 2, pct_of_finished_games: 100 }],
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
