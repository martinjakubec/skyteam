import type { AdminStats } from "@skyteam/shared";
import { db } from "./db";
import { ensureSchema } from "./schema";

/**
 * The statistics dashboard: the queries in docs/game-log-queries.sql, word for
 * word (a test keeps the two in step), plus the most recent games.
 *
 * Games flown on an earlier game's dice ("Fly the same dice", seeded_from set)
 * are left out unless asked for: their players may have known the dice.
 */
export const STAT_QUERIES = {
  playRate: `SELECT scenario,
       count(*)                                                             AS games,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1)                    AS pct_of_all_games,
       count(*) FILTER (WHERE result IN ('won', 'lost'))                     AS finished,
       round(100.0 * count(*) FILTER (WHERE result IN ('won', 'lost'))
             / nullif(sum(count(*) FILTER (WHERE result IN ('won', 'lost'))) OVER (), 0), 1)
                                                                             AS pct_of_finished_games
FROM games
GROUP BY scenario
ORDER BY games DESC, scenario`,
  crashCauses: `WITH losses AS (
  SELECT scenario,
         CASE
           WHEN loss_reason LIKE 'Landing failed:%'  THEN 'Landing failed'
           WHEN loss_reason LIKE 'Missed the turn:%' THEN 'Missed the turn'
           ELSE rtrim(loss_reason, '.!')
         END AS cause
  FROM games
  WHERE result = 'lost'
)
SELECT scenario,
       cause,
       count(*)                                                                    AS losses,
       round(100.0 * count(*) / sum(count(*)) OVER (PARTITION BY scenario), 1)      AS pct_of_airport_losses
FROM losses
GROUP BY scenario, cause
ORDER BY scenario, losses DESC, cause`,
  failedLandings: `SELECT scenario,
       condition,
       count(*) AS failed_landings
FROM games,
     regexp_split_to_table(rtrim(substring(loss_reason FROM 'Landing failed: (.*)'), '.'), '; ') AS condition
WHERE result = 'lost' AND loss_reason LIKE 'Landing failed:%'
GROUP BY scenario, condition
ORDER BY scenario, failed_landings DESC, condition`,
  winRateByAirport: `SELECT scenario,
       count(*)                                                      AS finished,
       count(*) FILTER (WHERE result = 'won')                         AS won,
       count(*) FILTER (WHERE result = 'lost')                        AS lost,
       round(100.0 * count(*) FILTER (WHERE result = 'won') / count(*), 1) AS win_pct
FROM games
WHERE result IN ('won', 'lost')
GROUP BY scenario
ORDER BY scenario`,
  winRateByAbility: `SELECT ability,
       count(*)                                                      AS finished,
       round(100.0 * count(*) FILTER (WHERE result = 'won') / count(*), 1) AS win_pct
FROM games, unnest(abilities) AS ability
WHERE result IN ('won', 'lost')
GROUP BY ability
ORDER BY ability`,
  winRateByModule: `SELECT module,
       count(*)                                                      AS finished,
       round(100.0 * count(*) FILTER (WHERE result = 'won') / count(*), 1) AS win_pct
FROM games, unnest(modules) AS module
WHERE result IN ('won', 'lost')
GROUP BY module
ORDER BY module`,
  humansVsBot: `SELECT scenario,
       CASE WHEN pilot = 'human' AND copilot = 'human' THEN 'two humans' ELSE 'with the bot' END AS crew,
       count(*)                                                      AS finished,
       round(100.0 * count(*) FILTER (WHERE result = 'won') / count(*), 1) AS win_pct
FROM games
WHERE result IN ('won', 'lost')
GROUP BY scenario, crew
ORDER BY scenario, crew`,
  unfinished: `SELECT result,
       rounds_reached,
       count(*) AS games
FROM games
WHERE result IN ('abandoned', 'exited', 'reset')
GROUP BY result, rounds_reached
ORDER BY result, rounds_reached`,
} as const;

export type StatKey = keyof typeof STAT_QUERIES;

export const RECENT_GAMES = `SELECT id, scenario, result, loss_reason, rounds_reached, pilot, copilot, ended_at, seeded_from IS NOT NULL AS seeded
FROM games ORDER BY ended_at DESC LIMIT 20`;

export const SEEDED_COUNT = `SELECT count(*) AS n FROM games WHERE seeded_from IS NOT NULL`;

/** The query over every game, or — `includeSeeded` false — over the games not
 *  flown on an earlier game's dice. */
export function forStats(sql: string, includeSeeded: boolean): string {
  return includeSeeded ? sql : sql.replace(/\bFROM games\b/g, "FROM (SELECT * FROM games WHERE seeded_from IS NULL) games");
}

/** pg reads count() and numeric as strings: these columns become numbers. */
const NUMERIC = new Set([
  "games", "pct_of_all_games", "finished", "pct_of_finished_games", "losses", "pct_of_airport_losses",
  "failed_landings", "won", "lost", "win_pct", "rounds_reached",
]);
const numeric = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, NUMERIC.has(k) && v !== null && v !== undefined ? Number(v) : v]));

export async function loadStats({ includeSeeded = false } = {}): Promise<AdminStats> {
  await ensureSchema();
  const pool = db()!;
  const keys = Object.keys(STAT_QUERIES) as StatKey[];
  const [results, recent, seeded] = await Promise.all([
    Promise.all(keys.map((k) => pool.query(forStats(STAT_QUERIES[k], includeSeeded)))),
    pool.query(RECENT_GAMES),
    pool.query(SEEDED_COUNT),
  ]);
  const sections = Object.fromEntries(keys.map((k, i) => [k, results[i].rows.map(numeric)]));
  return {
    generatedAt: new Date().toISOString(),
    includeSeeded,
    seededGames: Number(seeded.rows[0]?.n ?? 0),
    ...(sections as Omit<AdminStats, "generatedAt" | "includeSeeded" | "seededGames" | "recentGames">),
    recentGames: recent.rows.map((r) => ({ ...numeric(r), ended_at: new Date(r.ended_at).toISOString(), seeded: !!r.seeded })) as AdminStats["recentGames"],
  };
}
