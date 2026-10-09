-- Statistics over the game logs (PostgreSQL; see docs/game-logs.md).
-- Each query stands alone: paste it into psql or any SQL tool.
--
-- results: won | lost (a crash or a failed landing) | abandoned | exited | reset.
-- "Finished" games are won or lost; the others were left before the end.
--
-- Games flown on an earlier game's dice ("Fly the same dice") have seeded_from
-- set; their crews may have known the dice. The dashboard (/admin) leaves them
-- out unless asked: to do the same here, read every "FROM games" below as
-- "FROM (SELECT * FROM games WHERE seeded_from IS NULL) games".

-- 1. Play rate: each airport's share of all logged games; how many of its games
--    were finished (finish_pct); and its share of all finished games.
SELECT scenario,
       count(*)                                                             AS games,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1)                    AS pct_of_all_games,
       count(*) FILTER (WHERE result IN ('won', 'lost'))                     AS finished,
       round(100.0 * count(*) FILTER (WHERE result IN ('won', 'lost')) / count(*), 1)
                                                                             AS finish_pct,
       round(100.0 * count(*) FILTER (WHERE result IN ('won', 'lost'))
             / nullif(sum(count(*) FILTER (WHERE result IN ('won', 'lost'))) OVER (), 0), 1)
                                                                             AS pct_of_finished_games
FROM games
GROUP BY scenario
ORDER BY games DESC, scenario;

-- 2. Crash causes for every airport: each cause's count and its share of that
--    airport's losses. "Missed the turn" and "Landing failed" carry details in
--    their text; they're grouped by their cause here (see query 3 for landings).
WITH losses AS (
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
ORDER BY scenario, losses DESC, cause;

-- 3. Failed landings for every airport: which landing conditions were missed
--    (one failed landing can miss several), and how often.
SELECT scenario,
       condition,
       count(*) AS failed_landings
FROM games,
     regexp_split_to_table(rtrim(substring(loss_reason FROM 'Landing failed: (.*)'), '.'), '; ') AS condition
WHERE result = 'lost' AND loss_reason LIKE 'Landing failed:%'
GROUP BY scenario, condition
ORDER BY scenario, failed_landings DESC, condition;

-- 4. Win rate per airport, among finished games.
SELECT scenario,
       count(*)                                                      AS finished,
       count(*) FILTER (WHERE result = 'won')                         AS won,
       count(*) FILTER (WHERE result = 'lost')                        AS lost,
       round(100.0 * count(*) FILTER (WHERE result = 'won') / count(*), 1) AS win_pct
FROM games
WHERE result IN ('won', 'lost')
GROUP BY scenario
ORDER BY scenario;

-- 5a. Win rate with each Special Ability (finished games that chose it).
SELECT ability,
       count(*)                                                      AS finished,
       round(100.0 * count(*) FILTER (WHERE result = 'won') / count(*), 1) AS win_pct
FROM games, unnest(abilities) AS ability
WHERE result IN ('won', 'lost')
GROUP BY ability
ORDER BY ability;

-- 5b. Win rate with each module.
SELECT module,
       count(*)                                                      AS finished,
       round(100.0 * count(*) FILTER (WHERE result = 'won') / count(*), 1) AS win_pct
FROM games, unnest(modules) AS module
WHERE result IN ('won', 'lost')
GROUP BY module
ORDER BY module;

-- 6. Human crews against crews with the bot, per airport.
SELECT scenario,
       CASE WHEN pilot = 'human' AND copilot = 'human' THEN 'two humans' ELSE 'with the bot' END AS crew,
       count(*)                                                      AS finished,
       round(100.0 * count(*) FILTER (WHERE result = 'won') / count(*), 1) AS win_pct
FROM games
WHERE result IN ('won', 'lost')
GROUP BY scenario, crew
ORDER BY scenario, crew;

-- 7. Where games are left unfinished: by how they ended and the round reached.
SELECT result,
       rounds_reached,
       count(*) AS games
FROM games
WHERE result IN ('abandoned', 'exited', 'reset')
GROUP BY result, rounds_reached
ORDER BY result, rounds_reached;

-- 8. A game's moves, to replay (npm run logs:replay -- <id>), with the code list.
-- SELECT id, scenario, result, moves FROM games ORDER BY ended_at DESC LIMIT 10;
-- SELECT code, meaning FROM move_codes WHERE format = 1 ORDER BY code;
