// The SQL itself, against a real PostgreSQL: the schema, the account queries,
// history and statistics. The fake pg the other tests use can't run SQL, so
// these are what prove it. Skipped unless TEST_DATABASE_URL is set, e.g. the
// dev database: postgres://skyteam:skyteam-dev@host.docker.internal:5433/skyteam
// Each run works in a throwaway schema, dropped at the end.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import pg from "pg";
import { nanoid } from "nanoid";

const base = process.env.TEST_DATABASE_URL;
const schema = `t_${nanoid(10).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;

describe.skipIf(!base)("against a real PostgreSQL", () => {
  let admin;
  let mod;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    process.env.DATABASE_URL = `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    const db = await import("../packages/server/src/db.ts");
    db.initDb();
    mod = {
      db,
      schema: await import("../packages/server/src/schema.ts"),
      acc: await import("../packages/server/src/accounts.ts"),
      sessions: await import("../packages/server/src/sessions.ts"),
      env: (await import("../packages/server/src/env.ts")).env,
      history: await import("../packages/server/src/history.ts"),
      gameLog: await import("../packages/server/src/gameLog.ts"),
    };
  });

  afterAll(async () => {
    await mod?.db.db()?.end();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  const q = async (text, params) => (await mod.db.db().query(text, params)).rows;

  describe("schema", () => {
    test("creates every table once, and the default roles with their privileges", async () => {
      await mod.schema.ensureSchema();
      mod.schema.resetSchemaCache();
      await mod.schema.ensureSchema(); // twice: idempotent
      const tables = (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`, [schema])).map((r) => r.table_name);
      expect(tables).toEqual(["game_players", "games", "move_codes", "password_resets", "role_privileges", "roles", "users"]);
      const roles = await q(`SELECT r.name, r.rank, array_agg(p.privilege ORDER BY p.privilege) AS privileges
                             FROM roles r JOIN role_privileges p ON p.role = r.name GROUP BY r.name, r.rank ORDER BY r.rank`);
      expect(roles).toEqual([
        { name: "USER", rank: 1, privileges: ["history"] },
        { name: "ADMIN", rank: 2, privileges: ["history", "view_stats"] },
        { name: "SUPERADMIN", rank: 3, privileges: ["history", "manage_users", "view_stats"] },
      ]);
      const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'games'`, [schema])).map((r) => r.column_name);
      expect(cols).toEqual(expect.arrayContaining(["seed", "seeded_from"]));
    });

    test("privileges edited in the database stay edited after a restart", async () => {
      await q(`DELETE FROM role_privileges WHERE role = 'ADMIN' AND privilege = 'view_stats'`);
      mod.schema.resetSchemaCache();
      await mod.schema.ensureSchema();
      expect(await q(`SELECT privilege FROM role_privileges WHERE role = 'ADMIN'`)).toEqual([{ privilege: "history" }]);
      await q(`INSERT INTO role_privileges VALUES ('ADMIN', 'view_stats')`);
    });
  });

  describe("accounts", () => {
    test("register, sign in, privileges from the role, a taken name", async () => {
      const { user, recoveryCode } = await mod.acc.register("alice", "ten chars!");
      expect(user).toEqual({ id: user.id, username: "alice", role: "USER", privileges: ["history"] });
      expect(recoveryCode).toMatch(/^([0-9A-Z]{5}-){3}[0-9A-Z]{5}$/);
      expect(await mod.acc.login("alice", "ten chars!")).toEqual(user);
      expect(await mod.acc.login("alice", "wrong one!")).toBe(null);
      await expect(mod.acc.register("alice", "ten chars!")).rejects.toMatchObject({ code: "taken" });
      await q(`UPDATE users SET role = 'SUPERADMIN' WHERE id = $1`, [user.id]);
      expect((await mod.acc.userById(user.id)).privileges).toEqual(["history", "manage_users", "view_stats"]);
      await q(`UPDATE users SET role = 'USER' WHERE id = $1`, [user.id]);
    });

    test("recovery code, reset link (once, and not after expiry), sessions ending, deleting", async () => {
      const { user, recoveryCode } = await mod.acc.register("bruno", "ten chars!");
      const session = mod.sessions.issueSession(user.id);
      expect(await mod.sessions.sessionUser(session)).toEqual(user);
      await new Promise((r) => setTimeout(r, 5));
      const recovered = await mod.acc.recover("bruno", recoveryCode, "new password!");
      expect(recovered.recoveryCode).not.toBe(recoveryCode);
      expect(await mod.sessions.sessionUser(session)).toBe(null);
      expect(await mod.acc.recover("bruno", recoveryCode, "x".repeat(12))).toBe(null);

      const link = await mod.acc.createResetLink(user.id, user.id);
      expect(await mod.acc.resetWithToken(link.token, "third password")).not.toBe(null);
      expect(await mod.acc.resetWithToken(link.token, "fourth password")).toBe(null);
      const old = await mod.acc.createResetLink(user.id, user.id);
      await q(`UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL`);
      expect(await mod.acc.resetWithToken(old.token, "fourth password")).toBe(null);

      expect(await mod.acc.deleteOwnAccount(user.id, "third password")).toBe(true);
      expect(await q(`SELECT * FROM password_resets WHERE user_id = $1`, [user.id])).toEqual([]);
      expect(await mod.acc.userById(user.id)).toBe(null);
    });

    test("the first SUPERADMIN is created once, then kept SUPERADMIN", async () => {
      mod.env.SUPERADMIN_USERNAME = "admin";
      mod.env.SUPERADMIN_INITIAL_PASSWORD = "admin";
      expect(await mod.acc.bootstrapSuperadmin()).toBe("created");
      expect(await mod.acc.bootstrapSuperadmin()).toBe("unchanged");
      await q(`UPDATE users SET role = 'USER' WHERE username = 'admin'`);
      expect(await mod.acc.bootstrapSuperadmin()).toBe("promoted");
      expect(await mod.acc.login("admin", "admin")).toMatchObject({ role: "SUPERADMIN" });
      mod.env.SUPERADMIN_USERNAME = undefined;
    });
  });

  describe("history", () => {
    /** A games row (the columns the log writes), straight in. */
    const insertGame = (id, endedAt, extra = {}) => {
      const row = { id, room_id: "r", format: 1, build: "dev", scenario: "YUL", modules: [], abilities: [], intern_order: "", pilot: "human", copilot: "human",
        result: "won", loss_reason: null, rounds_reached: 7, moves: "D11112222", started_at: endedAt, ended_at: endedAt, seed: "ab".repeat(16), seeded_from: null, ...extra };
      const cols = Object.keys(row);
      return q(`INSERT INTO games (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
    };
    const link = (gameId, userId, crew) => q(mod.gameLog.SQL_LINK_PLAYER, [gameId, userId, crew]);
    const gid = (s) => s.padEnd(21, "x");

    test("my games: newest first, partners named, and 20 a page", async () => {
      const { user: kim } = await mod.acc.register("kimiko", "ten chars!");
      const { user: leo } = await mod.acc.register("leonardo", "ten chars!");
      await insertGame(gid("k1"), "2026-10-01T10:00:00Z");
      await link(gid("k1"), kim.id, "pilot");
      await insertGame(gid("k2"), "2026-10-02T10:00:00Z", { copilot: "bot:aviator" });
      await link(gid("k2"), kim.id, "pilot");
      await insertGame(gid("k3"), "2026-10-03T10:00:00Z", { seeded_from: gid("k1") });
      await link(gid("k3"), kim.id, "copilot");
      await link(gid("k3"), leo.id, "pilot");
      await link(gid("k3"), "no-such-user", "pilot"); // a deleted account: skipped, no error
      const { games, next } = await mod.history.myGames(kim.id);
      expect(next).toBe(null);
      expect(games.map((g) => [g.id.slice(0, 2), g.crew, g.partner, g.seeded])).toEqual([
        ["k3", "copilot", "leonardo", true],
        ["k2", "pilot", "Bot (aviator)", false],
        ["k1", "pilot", "Guest", false],
      ]);
      expect(games[0].endedAt).toBe("2026-10-03T10:00:00.000Z");

      const { user: m } = await mod.acc.register("marta", "ten chars!");
      for (let i = 0; i < 45; i++) {
        await insertGame(gid(`m${i}`), new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString());
        await link(gid(`m${i}`), m.id, "pilot");
      }
      const sizes = [];
      let before;
      for (let page = 0; page < 4; page++) {
        const r = await mod.history.myGames(m.id, before);
        sizes.push(r.games.length);
        if (!r.next) break;
        before = mod.history.parseCursor(r.next);
      }
      expect(sizes).toEqual([20, 20, 5]);
    });

    test("the same dice: a game's seed and setup, or nothing for a game logged before seeds", async () => {
      await insertGame(gid("s1"), "2026-10-05T10:00:00Z", { modules: ["intern"], seed: "cd".repeat(16) });
      expect(await mod.history.sameDiceSource(gid("s1"))).toEqual({ seed: "cd".repeat(16), setup: { scenarioId: "YUL", modules: ["intern"], abilities: [] } });
      await insertGame(gid("s2"), "2026-10-05T11:00:00Z", { seed: null });
      expect(await mod.history.sameDiceSource(gid("s2"))).toBe(null);
      expect(await mod.history.sameDiceSource(gid("nope"))).toBe(null);
    });

    test("a game's record names its crews and never shows the seed", async () => {
      const { user } = await mod.acc.register("nora", "ten chars!");
      await insertGame(gid("n1"), "2026-10-04T10:00:00Z", { copilot: "bot:aviator", intern_order: "123456" });
      await link(gid("n1"), user.id, "pilot");
      const rec = await mod.history.gameRecord(gid("n1"));
      expect(rec).toMatchObject({ crews: { pilot: "nora", copilot: "Bot (aviator)" }, internTokens: [1, 2, 3, 4, 5, 6], sameDiceAvailable: true, seededFrom: null, roundsReached: 7 });
      expect(JSON.stringify(rec)).not.toContain("ab".repeat(16));
      await insertGame(gid("n2"), "2026-10-04T11:00:00Z", { seed: null });
      expect(await mod.history.gameRecord(gid("n2"))).toMatchObject({ sameDiceAvailable: false, crews: { pilot: "Guest", copilot: "Guest" } });
      expect(await mod.history.gameRecord(gid("nope"))).toBe(null);
      // Deleting the account removes the link, keeps the game.
      expect(await mod.acc.deleteOwnAccount(user.id, "ten chars!")).toBe(true);
      expect((await mod.history.gameRecord(gid("n1"))).crews.pilot).toBe("Guest");
    });
  });
});
