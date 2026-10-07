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
    mod = { db, schema: await import("../packages/server/src/schema.ts") };
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
});
