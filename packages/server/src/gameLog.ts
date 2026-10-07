import pg from "pg";
import { nanoid } from "nanoid";
import { LOG_FORMAT, MOVE_CODES, encodeCommand, type Crew, type DieValue, type Recorder } from "@skyteam/shared";
import { env } from "./env";
import { redis } from "./store";
import type { Room } from "./types";

/**
 * Game logs: every live game ends as one row in PostgreSQL — its setup, who
 * flew each seat, how it ended, and its move string (see shared log/codec.ts),
 * which replays it exactly.
 *
 * While a game runs its moves grow in `room.gameLog`, saved with the room in
 * Redis on every move, so a restart loses nothing. When it ends, the row is
 * inserted; if Postgres can't take it, the row waits on a Redis list and a
 * timer retries it (inserts are idempotent by id, so a retry never duplicates).
 * Without DATABASE_URL logging is off.
 */

/** How a logged game ended. */
export type GameResult = "won" | "lost" | "abandoned" | "exited" | "reset";

/** Rows Postgres couldn't take yet (JSON, one per game). */
export const PENDING_KEY = "gamelog:pending";
const RETRY_MS = 30_000;

/** The `games` columns, in insert order. */
const COLUMNS = [
  "id", "room_id", "format", "build", "scenario", "modules", "abilities", "intern_order",
  "pilot", "copilot", "result", "loss_reason", "rounds_reached", "moves", "started_at", "ended_at",
] as const;
type Row = Record<(typeof COLUMNS)[number], unknown>;

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
CREATE TABLE IF NOT EXISTS move_codes (
  format  smallint NOT NULL,
  code    text NOT NULL,
  meaning text NOT NULL,
  PRIMARY KEY (format, code)
);`;

const INSERT = `INSERT INTO games (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT (id) DO NOTHING`;

let pool: pg.Pool | null = null;
/** The tables exist and the code list is current (checked again until it works). */
let schemaReady = false;

/** Connect, create the tables and the code list, and start retrying queued rows. */
export async function initGameLogs(): Promise<void> {
  if (!env.DATABASE_URL) {
    console.warn("[gamelog] DATABASE_URL is not set: games are not logged.");
    return;
  }
  pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });
  pool.on("error", (e) => console.error("[gamelog] postgres:", e.message));
  await flushPendingGameLogs();
  setInterval(() => void flushPendingGameLogs(), RETRY_MS).unref();
}

async function ensureSchema(db: pg.Pool): Promise<void> {
  if (schemaReady) return;
  await db.query(SCHEMA);
  await db.query(
    `INSERT INTO move_codes (format, code, meaning) SELECT $1, unnest($2::text[]), unnest($3::text[])
     ON CONFLICT (format, code) DO UPDATE SET meaning = EXCLUDED.meaning`,
    [LOG_FORMAT, MOVE_CODES.map((c) => c.code), MOVE_CODES.map((c) => c.meaning)],
  );
  schemaReady = true;
}

/** Begin a new game's log (call before dealing it, so the first deal is recorded). */
export function startGameLog(room: Room): void {
  room.gameLog = { id: nanoid(), startedAt: Date.now(), setup: structuredClone(room.setup), internTokens: [], moves: "" };
}

/** Records the room's game into its log (pass to newGame / settle, and call for each command). */
export function recorder(room: Room): Recorder {
  return (before, command, crew) => {
    if (!room.gameLog) return;
    // The Intern tokens' order, as dealt (before the first deal, nothing is trained).
    if (room.gameLog.moves === "") room.gameLog.internTokens = before.internTokens.filter((v): v is DieValue => v !== null);
    room.gameLog.moves += encodeCommand(before, command, crew);
  };
}

/** The game ended (or was left): write its row, once. */
export function endGameLog(room: Room, result: GameResult): void {
  const log = room.gameLog;
  const game = room.game;
  room.gameLog = null;
  if (!log || !game || !pool) return;
  const seat = (crew: Crew) => {
    const s = room.seats.find((x) => x.playerId === (crew === "pilot" ? game.pilotId : game.copilotId));
    return s?.bot ? `bot:${s.bot}` : "human";
  };
  const row: Row = {
    id: log.id,
    room_id: room.id,
    format: LOG_FORMAT,
    build: env.BUILD,
    scenario: log.setup.scenarioId,
    modules: log.setup.modules,
    abilities: log.setup.abilities,
    intern_order: log.internTokens.join(""),
    pilot: seat("pilot"),
    copilot: seat("copilot"),
    result,
    loss_reason: game.outcome?.result === "lost" ? game.outcome.reason : null,
    // Between rounds the game already counts the next round: the debrief belongs to the one just ended.
    rounds_reached: game.phase === "rolling" ? game.round - 1 : game.round,
    moves: log.moves,
    started_at: new Date(log.startedAt).toISOString(),
    ended_at: new Date().toISOString(),
  };
  void write(row);
}

async function write(row: Row): Promise<void> {
  try {
    await insert(row);
  } catch (e) {
    console.error(`[gamelog] game ${row.id} queued for retry:`, (e as Error).message);
    await redis.rpush(PENDING_KEY, JSON.stringify(row)).catch((err: Error) => console.error(`[gamelog] game ${row.id} lost:`, err.message));
  }
}

async function insert(row: Row): Promise<void> {
  await ensureSchema(pool!);
  await pool!.query(INSERT, COLUMNS.map((c) => row[c]));
}

/** Write the rows that waited for Postgres; stops at the first that still fails. */
export async function flushPendingGameLogs(): Promise<void> {
  if (!pool) return;
  try {
    await ensureSchema(pool);
    for (let raw = await redis.lpop(PENDING_KEY); raw !== null; raw = await redis.lpop(PENDING_KEY)) {
      try {
        await insert(JSON.parse(raw) as Row);
      } catch (e) {
        await redis.rpush(PENDING_KEY, raw); // back in the queue for the next try
        throw e;
      }
    }
  } catch (e) {
    console.error("[gamelog] retry failed:", (e as Error).message);
  }
}
