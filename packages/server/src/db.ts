import pg from "pg";
import { env } from "./env";

/** The PostgreSQL pool shared by the game logs and the accounts (null: no DATABASE_URL). */
let pool: pg.Pool | null = null;

/** Connect when DATABASE_URL is set (safe to call more than once). */
export function initDb(): void {
  if (pool || !env.DATABASE_URL) return;
  pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 6 });
  pool.on("error", (e) => console.error("[db] postgres:", e.message));
}

export const db = (): pg.Pool | null => pool;

/** Run `fn` in one transaction: all of it is written, or none. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool!.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
