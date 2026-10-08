import type { GameRecord, GameSummary } from "@skyteam/shared";
import { db } from "./db";
import { ensureSchema } from "./schema";

/**
 * Game history: a signed-in player's games (newest first, 20 a page), and one
 * game's record for its page — public to anyone with the link, so it never
 * carries the seed or the room.
 */

export const PAGE_SIZE = 20;

/** Who flew a seat, as a page shows it. */
const crewName = (username: string | null, seat: string) =>
  username ?? (seat.startsWith("bot:") ? `Bot (${seat.slice(4)})` : "Guest");

export const SQL_MY_GAMES = `/* history.mine */ SELECT g.id, g.scenario, g.modules, g.abilities, g.result, g.loss_reason, g.rounds_reached,
    g.ended_at, mine.crew, g.seeded_from IS NOT NULL AS seeded,
    ou.username AS partner_name, CASE WHEN mine.crew = 'pilot' THEN g.copilot ELSE g.pilot END AS partner_seat
  FROM game_players mine
  JOIN games g ON g.id = mine.game_id
  LEFT JOIN game_players other ON other.game_id = g.id AND other.crew <> mine.crew
  LEFT JOIN users ou ON ou.id = other.user_id
  WHERE mine.user_id = $1 AND ($2::timestamptz IS NULL OR (g.ended_at, g.id) < ($2::timestamptz, $3::text))
  ORDER BY g.ended_at DESC, g.id DESC, mine.crew
  LIMIT ${PAGE_SIZE + 1}`;

export const SQL_GAME = `/* games.byId */ SELECT g.id, g.format, g.scenario, g.modules, g.abilities, g.intern_order, g.moves, g.result,
    g.loss_reason, g.rounds_reached, g.pilot, g.copilot, g.started_at, g.ended_at, g.seed IS NOT NULL AS has_seed, g.seeded_from,
    (SELECT u.username FROM game_players p JOIN users u ON u.id = p.user_id WHERE p.game_id = g.id AND p.crew = 'pilot') AS pilot_name,
    (SELECT u.username FROM game_players p JOIN users u ON u.id = p.user_id WHERE p.game_id = g.id AND p.crew = 'copilot') AS copilot_name
  FROM games g WHERE g.id = $1`;

const iso = (d: Date | string) => new Date(d).toISOString();

/** A page of a user's games, and the cursor for the next (null: the last page).
 *  `before` is a cursor from an earlier page ("<ended_at>|<id>"). */
export async function myGames(userId: string, before?: { endedAt: string; id: string }): Promise<{ games: GameSummary[]; next: string | null }> {
  await ensureSchema();
  const rows = (await db()!.query(SQL_MY_GAMES, [userId, before?.endedAt ?? null, before?.id ?? null])).rows;
  const page = rows.slice(0, PAGE_SIZE);
  const games = page.map((r): GameSummary => ({
    id: r.id,
    scenario: r.scenario,
    modules: r.modules,
    abilities: r.abilities,
    result: r.result,
    lossReason: r.loss_reason,
    roundsReached: Number(r.rounds_reached),
    crew: r.crew,
    partner: crewName(r.partner_name, r.partner_seat),
    endedAt: iso(r.ended_at),
    seeded: !!r.seeded,
  }));
  const last = games.at(-1);
  return { games, next: rows.length > PAGE_SIZE && last ? `${last.endedAt}|${last.id}` : null };
}

/** Read a cursor back; null when it isn't one. */
export function parseCursor(raw: unknown): { endedAt: string; id: string } | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)\|([A-Za-z0-9_-]{1,64})$/.exec(raw);
  return m && !Number.isNaN(Date.parse(m[1])) ? { endedAt: m[1], id: m[2] } : null;
}

export const GAME_ID = /^[A-Za-z0-9_-]{21}$/;

/** One game's record, or null. */
export async function gameRecord(id: string): Promise<GameRecord | null> {
  if (!GAME_ID.test(id)) return null;
  await ensureSchema();
  const r = (await db()!.query(SQL_GAME, [id])).rows[0];
  if (!r) return null;
  return {
    id: r.id,
    format: Number(r.format),
    setup: { scenarioId: r.scenario, modules: r.modules, abilities: r.abilities },
    internTokens: [...(r.intern_order as string)].map(Number),
    moves: r.moves,
    result: r.result,
    lossReason: r.loss_reason,
    roundsReached: Number(r.rounds_reached),
    crews: { pilot: crewName(r.pilot_name, r.pilot), copilot: crewName(r.copilot_name, r.copilot) },
    startedAt: iso(r.started_at),
    endedAt: iso(r.ended_at),
    sameDiceAvailable: !!r.has_seed,
    seededFrom: r.seeded_from ?? null,
  };
}
