# Game logs

Date: 2026-10-07. Branch: `game-logs`.

## Goal

Log every live game compactly, so that:

- statistics are a SQL query away: play rate and win rate per airport, crash
  causes, abilities and modules;
- bots can be trained on real games: an export to JSONL of decisions (state →
  action);
- any game can be replayed step by step, exactly.

## Decisions (agreed with the user)

| Question | Decision |
|---|---|
| Storage | PostgreSQL: a new container in both compose files. |
| Scope | Every live game, including solo. Self-play and benchmarks don't write to the database. |
| Unfinished games | Logged and flagged: `abandoned`, `exited` (Exit to lobby) or `reset`, with the round reached. |
| "Pairing table" | The code list: what each code in a move string means, versioned. It lives in `@skyteam/shared` and is mirrored in a `move_codes` table. No player ids are stored; each seat is `human` or `bot:<level>`. |
| Chat | Not logged. |

## Why it can be replayed

The rules are one pure function, `reduce(state, command)`. All chance is
passed in as command data: each round's dice, rerolls, Anticipation, the
Synchronisation Traffic die, and the Intern tokens' order at setup. A game is
therefore fully determined by its **setup + Intern order + the ordered list of
reduce commands**. The log is exactly that, encoded compactly.

Replay is exact, with three intended exceptions:

- **Which of two equal dice.** A move names a die by its value; two unplaced
  dice of the same value are interchangeable, so replay uses the lowest id.
- **Real-Time clock values.** Wall-clock times (`timerEndsAt`) and pauses are
  not logged. When time ran out is logged, and that is all the rules use.
- **Player ids.** The replay names its crews `pilot` and `copilot`.

The round-trip test compares the final states under exactly these exceptions.

## Move string, format 1

The string is a sequence of tokens with no separators. Every token starts with
one of the capitals `D S T P C`, and no capital appears anywhere else, so the
string splits with `/[DSTPC][^DSTPC]*/g`.

### System tokens

| Token | Meaning |
|---|---|
| `D` + 4 digits + 4 digits + *n* digits | A round's deal: the pilot's four dice, the co-pilot's four, then one digit per Traffic die the approach space rolls. It also marks the start of every round. |
| `S` + digit | Synchronisation: the server rolled the Traffic die. |
| `T` | Real-Time: the round's time ran out. |

### Crew tokens: `P` (pilot) or `C` (co-pilot), then the action

| Action | Meaning | Example |
|---|---|---|
| *v* [`+`*n* / `-`*n*] *target* | Place a die of value *v*, with optional Coffee | `P4a`, `C2+1c0` |
| `!` *values* [`:` *new values*] | Reroll the dice of those values; they become the new values. A bare `!` declines a reroll. | `P!35:62`, `C!` |
| `?` *v* `:` *w* | Anticipation: the die *v* was rerolled to *w* | `P?3:5` |
| `~` *v* | Adaptation: the die *v* was turned over | `C~2` |
| `^` *v* | Working Together: offer, or answer with, the die *v* | `P^6` |
| `*` *target* | Place the Intern token (its value is known from the board) | `C*f1` |
| `#` *target* | Place the Traffic die (Synchronisation) | `C#a'` |

### Targets

| Code | Space |
|---|---|
| `a` | Axis |
| `e` | Engine |
| `r0` `r1` | Radio |
| `g0`–`g2` | Landing Gear |
| `f0`–`f3` | Flaps |
| `b0`–`b2` | Brakes |
| `c0` `c1` | Concentration |
| `k` | Kerosene |
| `i0`–`i3` | Ice Brakes, top space |
| `j0`–`j3` | Ice Brakes, bottom space |
| `t` | Intern training |
| suffix `'` | The other crew's side, for Axis, Engine, Radio or Intern (only the Traffic die does this) |

Example of a round: `D3561224 4P4aC2eP6b2C2+1c0…`, read as: deal; the pilot
plays 4 on Axis; the co-pilot 2 on Engines; the pilot 6 on Brakes 3; the
co-pilot 2 with +1 Coffee on Concentration 1.

A game is about 7 rounds × (9 + 8 × ~3.5 characters) ≈ 300 characters.

### Code

`packages/shared/src/log/`:

- `codes.ts`: `LOG_FORMAT = 1` and `MOVE_CODES`, a list of `{ code, meaning }`.
  This is the pairing table.
- `codec.ts`:
  - `encodeCommand(before, cmd, crew)` returns a token, or `""` for commands
    that aren't logged (Real-Time pause and resume).
  - `decodeToken(state, token)` returns the reduce command and the crew acting.
  - `replaySteps(header, moves)` returns, for each token, the token, the
    command and the state after it.
  - `replay(header, moves)` returns the final state.
  - `decisions(header, moves)` returns every player decision: the deciding
    crew's redacted view and the wire `GameCommand`, for training.
- A `Recorder` callback `(before, cmd, crew)` is accepted by `newGame`,
  `settle` and `settleTraffic`. It is optional, and their behaviour doesn't
  change.

## Server

- **The game's log.** `Room.gameLog: { startedAt, internTokens, moves } | null`
  is created with each new game (Start, Reset). It is saved with the room in
  Redis on every move, so it survives restarts. Every reduce command the server
  applies appends its token:
  - player and bot commands;
  - deals, including the one at the end of a debrief;
  - Traffic rolls;
  - time-ups.
- **When a game ends, one row is written**, and `gameLog` is cleared so it is
  never written twice:

  | Result | When |
  |---|---|
  | `won` / `lost` | The game ends. `loss_reason` holds the rules' text. |
  | `abandoned` | The disconnect grace period ran out, or the bot gave up. |
  | `exited` | Exit to lobby during a game. |
  | `reset` | Reset during a game. A new log then starts. |

- **Writing** (`packages/server/src/gameLog.ts`, using `pg`): `INSERT … ON
  CONFLICT (id) DO NOTHING`.
  - If the insert fails, the row goes on a Redis list, `gamelog:pending`. A
    timer, every 30 s and at startup, retries the list. Because the insert is
    idempotent, a retry never duplicates a game.
- **Disabled** when `DATABASE_URL` is unset, with a warning at startup. Nothing
  is queued in that case.
- **Startup** creates the tables if missing and upserts `move_codes` for the
  current format.

### Schema

```sql
CREATE TABLE IF NOT EXISTS games (
  id             text PRIMARY KEY,
  room_id        text NOT NULL,
  format         smallint NOT NULL,          -- move-string format (LOG_FORMAT)
  build          text NOT NULL,              -- server build (GIT_SHA, else "dev")
  scenario       text NOT NULL,              -- e.g. YUL, green-PRG
  modules        text[] NOT NULL,
  abilities      text[] NOT NULL,
  intern_order   text NOT NULL,              -- e.g. "352614"; "" without the Intern
  pilot          text NOT NULL,              -- "human" or "bot:aviator"
  copilot        text NOT NULL,
  result         text NOT NULL CHECK (result IN ('won','lost','abandoned','exited','reset')),
  loss_reason    text,
  rounds_reached smallint NOT NULL,          -- the round in play (a debrief counts as the round just ended)
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
);
```

## Queries (`docs/game-log-queries.sql`)

- **Play rate per airport.** Each map's share of all logged games, and of games
  that were finished (won or lost).
- **Crash causes per airport.** For every map, each `loss_reason` with its count
  and its share of that map's crashes.
- **Win rate per airport.** Among finished games.
- **Win rate per Special Ability and per module.** Using `unnest`.
- **Human crews against crews with a bot.**
- **Where unfinished games stop.** Results by `rounds_reached`.

## Tools

`scripts/game-logs.mjs` (npm `logs:export`, `logs:replay`):

- `export [--decisions] > file.jsonl`: one line per game (header plus decoded
  commands), or one line per decision for training.
- `replay <game-id>`: prints the game step by step: each token, what it did,
  and the rules' log lines.

## Compose

- A `postgres:17-alpine` service with a volume.
  - Dev: a fixed password.
  - Production: `POSTGRES_PASSWORD` from `.env`, which is required.
- The server gets `DATABASE_URL`.

## Tests (Vitest)

- **Codec (shared):**
  - A round trip over self-play games on every card, every module combination
    and every ability. The moves are random legal moves, so rerolls, swaps,
    Anticipation, Adaptation, the Intern and the Traffic die all occur. Each game
    is encoded, decoded and replayed, and the result must equal the real final
    state under the exceptions above.
  - Fixed examples for every token kind.
  - Bad strings are refused with a clear error.
  - `decisions` yields one pair per player token.
- **Server** (Postgres faked as `pg`, as Redis is faked):
  - a won or lost game writes one row with the right fields;
  - Exit, Reset and abandon write `exited`, `reset` and `abandoned`;
  - Exit after a finished game writes nothing more;
  - the stored moves replay to the game's final state;
  - with Postgres failing, the row is queued in Redis and written by the retry;
  - with no `DATABASE_URL`, nothing is written.
