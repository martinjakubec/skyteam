# Accounts, history and the admin pages

Playing never needs an account: guests play exactly as before. An account adds a
**game history** with replays. Accounts with the right privileges also get the
**statistics dashboard** (`/admin`) and the **users page** (`/admin/users`).

Accounts need the database (`DATABASE_URL`). Without one, every `/api` route
answers 503 and the site hides "Sign in".

## Registering and passwords

- **Registering** asks for a username (3–24 of `a-z 0-9 . _ -`, stored lowercase)
  and a password of at least 10 characters. Nobody can register the names
  `admin`, `administrator`, `superadmin`, `root`, `system`, `bot`, `guest`,
  `skyteam` or `moderator`, nor the owner's (`SUPERADMIN_USERNAME`).
- **Passwords** are hashed with scrypt.
- **The recovery code.** Registering shows a one-time recovery code
  (`XXXXX-XXXXX-XXXXX-XXXXX`) once. The server keeps only its hash.
  - **Forgot password** (`/forgot`): the username, the code and a new password.
    The code is used up and a new one is shown.
  - **On the account page**, a new code replaces the old one (the password is
    needed).
- **Lost the code too?** A user with `manage_users` makes a **reset link** on
  the users page (valid 24 hours, works once, replaces any earlier link) and
  hands it over. Opening it sets a new password and signs the user in.

## Sessions

- **The cookie.** Signing in sets the `skyteam_session` cookie: `HttpOnly`,
  `SameSite=Strict`, `Secure` in production, valid for 30 days. It's signed
  with `SESSION_SECRET`, which must differ from `JWT_SECRET` (the players'
  anonymous identity tokens), so neither can pass as the other.
- **Checked on every request.** Each request loads the account, so these end
  every open session at once:
  - a password change (the device that made it stays signed in);
  - recovering a password;
  - "Sign out everywhere";
  - an account being disabled or deleted.
- **CSRF.** Every `/api` request other than `GET` must be JSON (otherwise 415).
  With the SameSite cookie, that keeps other sites from acting for a signed-in
  user.
- **Rate limits** (per client address unless noted):

  | What | Limit |
  |---|---|
  | Register | 5 an hour |
  | Sign in | 10 a minute; also 10 failures per username in 15 minutes |
  | Recover | 10 a minute; also 5 failures per username in 15 minutes |
  | Reset | 10 a minute |
  | Account settings | 10 a minute |

## Roles and privileges

Roles and the privileges they grant are rows in the database (`roles`,
`role_privileges`). Routes ask for a **privilege**, never a role:

| Role | Privileges |
|---|---|
| `USER` | `history` |
| `ADMIN` | `history`, `view_stats` |
| `SUPERADMIN` | `history`, `view_stats`, `manage_users` |

A new database starts with these. A role's privileges are added only when the
role itself is created, so changes made in the database stay. A change takes
effect on the user's next request, with no new sign-in. To add a role, for
example one that only sees statistics:

```sql
INSERT INTO roles (name, rank) VALUES ('ANALYST', 4);  -- ranks are unique: pick a free one
INSERT INTO role_privileges VALUES ('ANALYST', 'history'), ('ANALYST', 'view_stats');
```

**The owner.** `SUPERADMIN_USERNAME` and `SUPERADMIN_INITIAL_PASSWORD` set up
the site owner's account:
- At startup the server creates the account as SUPERADMIN if it doesn't exist,
  or makes it SUPERADMIN again if it does; its password is then left alone.
- In production the initial password needs at least 10 characters. Locally,
  `.env` uses admin / admin.
- **Sign in and change it at once.**

**What the users page refuses:**
- your own account (that's the account page);
- demoting, disabling or deleting the owner;
- leaving nobody who can manage users.

## History and replays

- **Linking.** A signed-in player's seat is linked to their account when they
  join a room. When a game ends, `game_players` records which accounts flew it.
  Guests' games are logged as before, tied to no one.
- **My games** (`/history`) lists them newest first, 20 a page.
- **A game's page** (`/games/<id>`) is open to anyone with the link:
  - the setup, the crews (a username, "Guest" or "Bot (…)") and the result;
  - the game replayed move by move in the cockpit (← → a move, Shift a round,
    Space to play);
  - never the seed or the room.
- **When a game is won or lost**, the cockpit links to its replay.

**Deleting an account** removes its links to games. The game rows stay: they
are anonymous and feed the statistics.

## Seeds and "Fly the same dice"

- **Every live game has a secret 128-bit seed.** The dice come from separate
  streams of it: one for the Intern order, one for each round's deal, and one
  for everything else rolled in that round. The same seed therefore deals the
  same dice every round, whatever the players did.
- **Kept secret.** The seed never reaches a client during a game. It is written
  to `games.seed` when the game ends.
- **Flying the same dice.** "Fly the same dice" on a game's page creates a room
  on that game's seed and setup, with a friend or solo. The setup stays locked
  until the host picks "Use fresh dice".
  - Every game in that room is logged with `seeded_from` = the original's id.
  - Its players may know the dice, so the dashboard leaves such games out
    unless asked.
  - In SQL: `WHERE seeded_from IS NULL`.
- **Older games** (logged before seeds) can be replayed but not flown again.

## The statistics dashboard

`/admin` (`view_stats`) shows:
- totals;
- every query in [game-log-queries.sql](game-log-queries.sql): play rate, win
  rate per airport, crash causes, failed-landing conditions, win rate per
  ability and module, humans vs the bot, unfinished games;
- the 20 latest games.

The queries live in `packages/server/src/stats.ts`, and a test keeps them word
for word in step with the `.sql` file.

## API

Everything is JSON under `/api`.

**Signing in, and your own account:**

| Route | Who |
|---|---|
| `GET /api/auth/me` | anyone (`{user: null}` for a guest) |
| `POST /api/auth/register`, `/login`, `/logout`, `/recover`, `/reset` | anyone |
| `POST /api/account/password`, `/recovery-code`, `/sign-out-everywhere`; `DELETE /api/account` | signed in |

**History and game pages:**

| Route | Who |
|---|---|
| `GET /api/me/games?before=<cursor>` | `history` |
| `GET /api/games/:id` | anyone with the link |

**The admin pages:**

| Route | Who |
|---|---|
| `GET /api/admin/stats?includeSeeded=1` | `view_stats` |
| `GET /api/admin/users?q=&after=`, `GET /api/admin/roles`, `PATCH /api/admin/users/:id`, `POST /api/admin/users/:id/reset-link`, `DELETE /api/admin/users/:id` | `manage_users` |
