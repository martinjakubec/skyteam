# Game logs

Every live game, including solo games, is logged to PostgreSQL as **one row**
when it ends. The row holds the setup, who flew each seat, how the game ended,
and a compact **move string** that replays the game exactly. Games left before
the end are logged too, flagged `abandoned`, `exited` or `reset`.

| `result` | Meaning |
|---|---|
| `won` | Landed. |
| `lost` | A crash or a failed landing. `loss_reason` holds the rules' text. |
| `abandoned` | A player didn't come back in time, or the bot gave up. |
| `exited` | Exit to lobby during a game. |
| `reset` | The host restarted the game. |

Each row also has a `seed` (the game's secret seed, written when it ends) and a
`seeded_from` (the game whose dice it was flown on, or null). `game_players`
links a game to the accounts that flew it. See [accounts.md](accounts.md).

The design and the full format are in
[the spec](superpowers/specs/2026-10-07-game-logs-design.md). The code list
(the pairing table) is `MOVE_CODES` in `packages/shared/src/log/codes.ts`, and
the database has a copy in `move_codes`.

## Reading a move string

`D35612244P4aC2eP6b2C2+1c0…`

| Token | Meaning |
|---|---|
| `D35612244` | Deal: the Pilot's dice 3 5 6 1, the Co-Pilot's 2 2 4 4. Every round starts with a `D`. |
| `P4a` | The Pilot puts a 4 on the Axis. |
| `C2e` | The Co-Pilot puts a 2 on the Engines. |
| `P6b2` | The Pilot puts a 6 on Brakes slot 2 (slots count from 0). |
| `C2+1c0` | The Co-Pilot puts a 2, raised by 1 Coffee, on Concentration slot 0. |

Other tokens:

- `P!36:62` is a reroll: the dice 3 and 6 became 6 and 2. A bare `C!` declines.
- `P?3:5` is Anticipation, `C~2` Adaptation, `P^6` Working Together.
- `C*f1` places the Intern token on Flaps slot 1. `C#a'` places the Traffic die on
  the other crew's Axis.
- `S4` is the Traffic die the server rolled. `T` means Real-Time ran out.

A full game is about 300 characters.

## Where it runs

- **Dev** (`docker compose -f docker-compose.dev.yml up`): the database is on
  `127.0.0.1:5433`, user `skyteam`, password `skyteam-dev`, database `skyteam`.
- **Production** (`docker-compose.yml`): set `POSTGRES_PASSWORD` in `.env`
  (required). The database listens on `127.0.0.1:5432` of the server only;
  reach it through an SSH tunnel. Set `GIT_SHA` to stamp rows with the build.
- With no `DATABASE_URL` the server logs nothing, and says so at startup. If
  Postgres is down when a game ends, the row waits in Redis
  (`gamelog:pending`) and is written within 30 s of Postgres coming back.

## Statistics

[`game-log-queries.sql`](game-log-queries.sql) contains these queries:

1. **Play rate per airport**: each map's share of all games and of finished games.
2. **Crash causes per airport**: every map, every cause, its share of that map's losses.
3. **Failed landings per airport**: which landing conditions were missed.
4. **Win rate per airport.**
5. **Win rate per Special Ability and per module.**
6. **Two humans against crews with the bot.**
7. **Where unfinished games stop.**

They're also on the statistics dashboard (`/admin`, for accounts with the
`view_stats` privilege). There, games flown on an earlier game's dice are left out
unless asked for. `packages/server/src/stats.ts` holds the queries, and a test
keeps them in step with the `.sql` file.

To run them all against the dev database:

```sh
docker compose -f docker-compose.dev.yml exec -T postgres psql -U skyteam -d skyteam < docs/game-log-queries.sql
```

## Replay and export

These need `DATABASE_URL`, e.g. `postgres://skyteam:skyteam-dev@localhost:5433/skyteam`.

```sh
npm run logs:replay -- <game id>                    # step by step, with the rules' own log lines
npm run logs:export > games.jsonl                   # one line per game: the row + decoded commands
npm run logs:export -- --decisions > train.jsonl    # one line per crew decision: its view → its command
npm run logs:export -- --where "scenario = 'YUL'"   # any SQL condition
```

In code, `replaySteps(header, moves)`, `replay` and `decisions` from
`@skyteam/shared` do the same. A test replays 204 self-play games, covering
every card, module and ability, step by step to the identical game.
