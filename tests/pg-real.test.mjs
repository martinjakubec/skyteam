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
});
