import { LOG_FORMAT, MOVE_CODES } from "@skyteam/shared";
import { db } from "./db";

/**
 * The database's tables: game logs (games, move_codes), accounts (users, roles,
 * role_privileges, password_resets) and who played which game (game_players).
 * Everything is CREATE … IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, so it runs on
 * every start and upgrades an older database in place.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id             text PRIMARY KEY,
  room_id        text NOT NULL,
  format         smallint NOT NULL,
  build          text NOT NULL,
  scenario       text NOT NULL,
  modules        text[] NOT NULL,
  abilities      text[] NOT NULL,
  intern_order   text NOT NULL,
  pilot          text NOT NULL,
  copilot        text NOT NULL,
  result         text NOT NULL CHECK (result IN ('won', 'lost', 'abandoned', 'exited', 'reset')),
  loss_reason    text,
  rounds_reached smallint NOT NULL,
  moves          text NOT NULL,
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS games_scenario_result ON games (scenario, result);
ALTER TABLE games ADD COLUMN IF NOT EXISTS seed text;
ALTER TABLE games ADD COLUMN IF NOT EXISTS seeded_from text;
CREATE INDEX IF NOT EXISTS games_ended_at ON games (ended_at DESC);
CREATE TABLE IF NOT EXISTS move_codes (
  format  smallint NOT NULL,
  code    text NOT NULL,
  meaning text NOT NULL,
  PRIMARY KEY (format, code)
);
CREATE TABLE IF NOT EXISTS roles (
  name text PRIMARY KEY,
  rank smallint NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS role_privileges (
  role      text NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
  privilege text NOT NULL,
  PRIMARY KEY (role, privilege)
);
CREATE TABLE IF NOT EXISTS users (
  id             text PRIMARY KEY,
  username       text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_.-]{3,24}$'),
  password_hash  text NOT NULL,
  recovery_hash  text NOT NULL,
  role           text NOT NULL DEFAULT 'USER' REFERENCES roles(name),
  disabled_at    timestamptz,
  sessions_after timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE TABLE IF NOT EXISTS game_players (
  game_id text NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  crew    text NOT NULL CHECK (crew IN ('pilot', 'copilot')),
  PRIMARY KEY (game_id, crew)
);
CREATE INDEX IF NOT EXISTS game_players_user ON game_players (user_id, game_id);`;

/** The roles a new database starts with. A role's privileges are added only
 *  when the role itself is new, so privileges edited in the database stay. */
export const DEFAULT_ROLES = [
  { name: "USER", rank: 1, privileges: ["history"] },
  { name: "ADMIN", rank: 2, privileges: ["history", "view_stats"] },
  { name: "SUPERADMIN", rank: 3, privileges: ["history", "view_stats", "manage_users"] },
] as const;

export const SQL_INSERT_ROLES = `/* roles.insert */ INSERT INTO roles (name, rank) SELECT unnest($1::text[]), unnest($2::smallint[]) ON CONFLICT DO NOTHING RETURNING name`;
export const SQL_INSERT_PRIVILEGES = `/* privileges.insert */ INSERT INTO role_privileges (role, privilege) SELECT unnest($1::text[]), unnest($2::text[]) ON CONFLICT DO NOTHING`;
export const SQL_MOVE_CODES = `INSERT INTO move_codes (format, code, meaning) SELECT $1, unnest($2::text[]), unnest($3::text[])
     ON CONFLICT (format, code) DO UPDATE SET meaning = EXCLUDED.meaning`;

/** The tables exist and are current (checked again until that works once). */
let ready = false;

export async function ensureSchema(): Promise<void> {
  if (ready) return;
  const pool = db()!;
  await pool.query(SCHEMA);
  await pool.query(SQL_MOVE_CODES, [LOG_FORMAT, MOVE_CODES.map((c) => c.code), MOVE_CODES.map((c) => c.meaning)]);
  const added = new Set(
    (await pool.query(SQL_INSERT_ROLES, [DEFAULT_ROLES.map((r) => r.name), DEFAULT_ROLES.map((r) => r.rank)])).rows.map((r) => r.name as string),
  );
  const grants = DEFAULT_ROLES.filter((r) => added.has(r.name)).flatMap((r) => r.privileges.map((p) => [r.name, p]));
  if (grants.length) await pool.query(SQL_INSERT_PRIVILEGES, [grants.map((g) => g[0]), grants.map((g) => g[1])]);
  ready = true;
}

/** Tests: run the schema again, as a restarted server would. */
export function resetSchemaCache(): void {
  ready = false;
}
