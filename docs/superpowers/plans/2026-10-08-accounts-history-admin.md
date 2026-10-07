# Accounts, Game History, Same-Dice Replays and the Admin Dashboard: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Players can register with a username and password.
- They see the history of their games and replay any of them step by step.
- Anyone with a game's link can fly a new game on the same dice. Such a game is marked as seeded, so the statistics can leave it out.
- Roles held in the database grant privileges:
  - `USER`: play and keep a history;
  - `ADMIN`: also sees the statistics dashboard;
  - `SUPERADMIN`: also manages users.

**Architecture:**
- **Accounts** live in Postgres: `users`, `roles` and `role_privileges`, in the same database as the game logs.
- **Sessions:** a signed session sits in an `HttpOnly; SameSite=Strict` cookie. Every request loads the account and its privileges from the database. A route is guarded by a privilege, never by a role name.
- **A secret seed for every live game.** Each live game gets a 128-bit seed. The dice come from HMAC-SHA256(seed, "round:draw"), so the same seed gives the same Intern order and the same k-th roll in every round, whatever the players do.
  - The seed never leaves the server.
  - It is written to `games.seed` when the game ends.
  - A "same dice" game copies the seed and the setup from the original, and is written with `seeded_from = <original id>`.
- **Linking games to accounts:** the socket's cookie links a seat to an account. When the game ends, `game_players` records which accounts flew it.
- **Replays run in the browser:** the client replays a game with the shared `replaySteps`, and draws it in the existing `Cockpit` as an onlooker, so the view is read-only.
- **Guests play exactly as today.** Their games are logged for the statistics, but tied to no one.

**Tech Stack:** Express 4, Socket.IO, pg, `node:crypto` (scrypt, HMAC, randomBytes), jsonwebtoken (already a dependency), zod (shared), React (no router library: a small path switch), Vitest (fake pg for routes, a real Postgres for SQL).

**Spec:** This plan's *Decisions* section. It replaces the earlier admin-only draft. The user's answers on 2026-10-08:
- recovery codes;
- guests may still play;
- anyone with a game's link may fly the same dice;
- the first SUPERADMIN comes from env variables.

## Decisions

| # | Decision |
|---|---|
| D1 | **Registration:** username (3–24 characters, `[a-z0-9_.-]`, stored lowercase, unique) and password (10–200 characters). No email is asked for. These names are reserved: `admin`, `superadmin`, `root`, `system`, `bot`, `guest`, `skyteam`, unless the name equals `SUPERADMIN_USERNAME`. |
| D2 | **Recovery code:** registering shows a one-time code once (`XXXXX-XXXXX-XXXXX-XXXXX`, 100 bits, Crockford base32). The server keeps only its SHA-256.<br>• **Forgot password:** enter the username, the code and a new password. The code is then used up and a new one is shown.<br>• **From the account page:** a signed-in user can make a new code, after entering their password.<br>• **If the code is lost too:** a SUPERADMIN creates a one-time reset link (valid for 24 h, stored as SHA-256) and passes it on outside the site. |
| D3 | **Passwords:** scrypt (N=2^15, r=8, p=1, 16-byte salt), stored as `scrypt$N$r$p$salt$hash`. A wrong username still runs scrypt against a dummy hash, so the response time doesn't reveal which usernames exist. |
| D4 | **Session:** a JWT `{sub: userId, aud: "skyteam-session"}`, signed HS256 with a new secret `SESSION_SECRET` (which must differ from `JWT_SECRET`), valid for 30 days.<br>• **Cookie:** `skyteam_session; HttpOnly; SameSite=Strict; Path=/; Secure` in production.<br>• **Ending sessions:** a token issued before the user's `sessions_after` is refused. Changing the password, recovering, "sign out everywhere", disabling or deleting the account all bump `sessions_after`. |
| D5 | **Roles and privileges are rows in the database:**<br>• `roles(name, rank)`<br>• `role_privileges(role, privilege)`<br>On startup the defaults are added with `ON CONFLICT DO NOTHING`, so edits made in the database stick:<br>• `USER` → `history`<br>• `ADMIN` → `history`, `view_stats`<br>• `SUPERADMIN` → `history`, `view_stats`, `manage_users`<br>Routes ask `requirePrivilege("view_stats")`, never for a role. |
| D6 | **The first SUPERADMIN** needs no terminal:<br>• `SUPERADMIN_USERNAME` is a GitHub variable.<br>• `SUPERADMIN_INITIAL_PASSWORD` is a GitHub secret.<br>At startup, if that user doesn't exist, the server creates it as SUPERADMIN with that password. If it exists, the server only makes sure its role is SUPERADMIN; the password is left alone. Nobody can register that name before the owner, because the server creates it first. **Change the password after the first sign-in.** |
| D7 | **Guests** play as today. A signed-in player's seat records `accountId` when they join. When a game ends, `game_players(game_id, user_id, crew)` gets one row for each seat that was signed in. The game rows stay when an account is deleted (they feed the statistics); the links go. |
| D8 | **Seeds:**<br>• **The seed:** every live game gets `seed = randomBytes(16).toString("hex")`.<br>• **A draw:** the k-th draw of round r (round 0 is the Intern order) is the first unbiased 32-bit word of `HMAC-SHA256(seed, "r:k")`, taken by rejection.<br>• **Restarts:** the room record keeps `{seed, round, draws}`, so a restart continues the stream.<br>• **Secrecy:** the seed is never sent to a client, so dice can't be predicted during a game. |
| D9 | **"Fly the same dice":** the game page offers it for any game whose row has a seed. `POST /rooms {sameDiceAs: gameId}` (optionally with `solo`) creates a room with that game's setup, locked in the lobby, and its seed.<br>• **What's logged:** every game started in that room is written with `seeded_from = gameId` and the same seed. Reset deals the same dice again.<br>• **Leaving it:** the lobby has "Use fresh dice", which drops the seed and unlocks the setup.<br>• **Old games:** games logged before this change have no seed, so they get no button. |
| D10 | **Who can open a game page:** anyone with its link (`/games/<id>`; ids are 21-character nanoids). The page shows the setup, the result, the crews and a step-by-step replay.<br>• **Crew names:** a username for a signed-in player who has an account, "Guest" for a guest, "Bot (<level>)" for the bot.<br>• **Not shown:** the seed and the room id.<br>• **Finding the link:** the end-of-game panel shows "Watch the replay" to everyone in the room, and the history lists each game. |
| D11 | **Statistics:**<br>• Queries 1–7 are kept as they are, plus totals and the 20 most recent games.<br>• **Seeded games are left out by default.** A "Include same-dice games" switch puts them back. It does so by swapping `FROM games` for `FROM (SELECT * FROM games WHERE seeded_from IS NULL) games` in the query text.<br>• **The SQL file:** `stats.ts` holds the queries, and a test keeps `docs/game-log-queries.sql` word for word in step with them. |
| D12 | **SUPERADMIN user management:**<br>• **What it can do:** list and search users; change a role; disable or enable an account; create a reset link; delete an account.<br>• **Refused:** acting on your own account, removing the last SUPERADMIN, and demoting the `SUPERADMIN_USERNAME` account. |
| D13 | **Account page:** change password; new recovery code; sign out everywhere; delete my account (needs the password; removes the account and its history links, keeps the anonymous game rows). |
| D14 | **CSRF:** every non-GET `/api` request must be `application/json` (otherwise 415). Together with the SameSite=Strict cookie, another site can't act as a signed-in user. |
| D15 | **Rate limits per address:**<br>• register: 5 per hour;<br>• login: 10 per minute, plus 10 failures per 15 min per username;<br>• recover: 10 per minute, plus 5 failures per 15 min per username;<br>• reset: 10 per minute.<br>The text follows the existing "Too many requests — try again in a minute." |
| D16 | **Without `DATABASE_URL`:**<br>• every `/api` route answers 503 `{error: "Accounts need the database."}`;<br>• the client hides Sign in, and guests play as today.<br>That is the dev and test default. |
| D17 | **API layout:** everything new is under `/api/…`, so the client's nginx forwards one prefix and the SPA keeps its own paths: `/signin`, `/register`, `/forgot`, `/reset`, `/account`, `/history`, `/games/:id`, `/admin`, `/admin/users`. The game page and the admin pages are lazy chunks, so players don't download them. |

## Global Constraints

- **Dependencies:** no new runtime dependencies (`node:crypto`; jsonwebtoken and zod are present).
- **Tests:**
  - Vitest only (`tests/**/*.test.{mjs,tsx}`); never add to `scripts/test-*.mjs`.
  - TDD: write the test, watch it fail, implement, then run the full suite.
- **Running things:** there's no local node. Use
  `docker.exe run --rm -v 'C:\Users\RYZEN\Desktop\programko\skyteam':/app -w /app node:22-alpine sh -c "npm test"`.
  - One file: `sh -c "npm run build:shared && npx vitest run tests/<file>"`.
  - Env vars from WSL don't reach `docker.exe`; pass them with `-e`.
- **SQL tests** run against the dev Postgres (`docker.exe compose -f docker-compose.dev.yml up -d`), with
  `-e TEST_DATABASE_URL=postgres://skyteam:skyteam-dev@host.docker.internal:5433/skyteam`.
  Each test file uses its own throwaway schema. Without the variable these tests are skipped.
- **Secrets:**
  - Generate `SESSION_SECRET` and `SUPERADMIN_INITIAL_PASSWORD` into the git-ignored `.env` without printing them.
  - List them, and the `SUPERADMIN_USERNAME` variable, in `docs/production-variables.md`.
  - Never commit `.env` or a secret value.
- **Commits** end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01UXuFMUD5vHhJ7xSEjqhL2A`.
- **Branches:** one per phase (`accounts`, `seeds`, `history`, `same-dice`, `admin-stats`, `admin-users`), each off `main` once the previous phase is merged. Merge and push only when the user asks.
- **Texts:** error messages are user-facing sentences in the existing style.

## Review Focus

1. **A player's identity token used as a session cookie** (and a session used as an identity token) is refused: different secrets, pinned audience. *Phase A, Task A3.*
2. **Same seed, same dice, whatever the players do.** Two games on one seed with different reroll choices get identical round-r deals. A server restart mid-round continues the stream exactly. *Phase B, Task B1/B2.*
3. **The seed never reaches a client:** not in a snapshot, not on the game page, not in the room record sent to the bot worker. *Phase B, Task B2; Phase C, Task C3.*
4. **A disabled, deleted or password-changed account loses its open sessions**, including a socket that rejoins: the seat stays, the account link is dropped. *Phase A, Task A3; Phase C, Task C1.*
5. **Statistics on an empty database, and with every game seeded:** empty sections, never a 500 or a NaN. pg's bigint and numeric strings arrive as numbers. *Phase E.*

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `packages/server/src/db.ts` | new | The one `pg.Pool`; `initDb()`, `db()`, `tx(fn)` |
| `packages/server/src/schema.ts` | new | All `CREATE … IF NOT EXISTS` / `ALTER … ADD COLUMN IF NOT EXISTS`; default roles and privileges; `ensureSchema()` (moved from `gameLog.ts`) |
| `packages/server/src/passwords.ts` | new | scrypt `hashPassword` / `verifyPassword`, `DUMMY_HASH`, `newRecoveryCode`, `sha256` |
| `packages/server/src/accounts.ts` | new | Users: register, login, recover, reset links, password change, roles, disable, delete; `bootstrapSuperadmin()` |
| `packages/server/src/sessions.ts` | new | `issueSession`, `sessionUser(token)`, cookie helpers, `currentUser` / `requirePrivilege` middleware |
| `packages/server/src/api.ts` | new | `apiRouter()`: `/api/auth/*`, `/api/account/*`, `/api/me/games`, `/api/games/:id`, `/api/admin/*`; JSON-only and 503 guards |
| `packages/server/src/stats.ts` | new | `STAT_QUERIES`, `RECENT_GAMES`, `loadStats({includeSeeded})` |
| `packages/server/src/seededRand.ts` | new | `newSeed()`, `SeedState`, `seededRand(state)`, a `Rand` that advances the state |
| `packages/server/src/gameLog.ts` | modify | Rows gain `seed`, `seeded_from`, `players`; writes them in one transaction |
| `packages/server/src/socket.ts` | modify | Seeded `rand` per room; `accountId` on seats; `lastGameId`; locked setup for same-dice rooms; `room:freshDice` |
| `packages/server/src/http.ts` | modify | Mount `apiRouter`; `POST /rooms` accepts `sameDiceAs` |
| `packages/server/src/rooms.ts` | modify | `createRoom(…, sameDice?)` |
| `packages/server/src/types.ts` | modify | `Seat.accountId?`, `Seat.username?`, `Room.seedState?`, `Room.sameDice?`, `Room.lastGameId?` |
| `packages/server/src/env.ts` | modify | `SESSION_SECRET`, `SUPERADMIN_USERNAME`, `SUPERADMIN_INITIAL_PASSWORD`; `productionProblems` |
| `packages/shared/src/accounts.ts` | new | zod payloads (`Credentials`, `RecoverPayload`, …), `Privilege`, `Role`, `PublicUser`, `AdminStats`, `GameSummary`, `GameRecord` |
| `packages/shared/src/protocol.ts` | modify | `RoomSnapshot.lastGameId?`, `RoomSnapshot.sameDice?`, `room:freshDice` event |
| `packages/client/src/main.tsx` | modify | The path switch |
| `packages/client/src/router.ts` | new | `usePath()`, `navigate(path)` (pushState + popstate) |
| `packages/client/src/account/*` | new | `authApi.ts`, `useAccount.ts` (zustand slice), `SignIn.tsx`, `Register.tsx`, `Forgot.tsx`, `Reset.tsx`, `Account.tsx`, `RecoveryCode.tsx`, `AccountChip.tsx` |
| `packages/client/src/history/*` | new | `History.tsx`, `GamePage.tsx` (lazy), `ReplayControls.tsx` |
| `packages/client/src/admin/*` | new | `AdminStats.tsx`, `AdminUsers.tsx` (lazy), `admin.css` |
| `packages/client/src/App.tsx`, `components/Lobby.tsx`, `components/Cockpit.tsx` | modify | `AccountChip` on the landing page; same-dice banner and "Use fresh dice" in the lobby; "Watch the replay" when a game has ended |
| `packages/client/src/store.ts` | modify | Socket `withCredentials: true`; reconnect after sign-in or sign-out |
| `tests/support/fakePg.mjs` | modify | `users`, `roles`, `role_privileges`, `password_resets`, `game_players`; `BEGIN`/`COMMIT`/`ROLLBACK`; `results` map for canned SQL |
| `tests/accounts.test.mjs`, `tests/api-auth.test.mjs`, `tests/seeds.test.mjs`, `tests/history.test.mjs`, `tests/same-dice.test.mjs`, `tests/admin-api.test.mjs`, `tests/pg-real.test.mjs` | new | See each task |
| `tests/client/account.test.tsx`, `tests/client/history.test.tsx`, `tests/client/admin.test.tsx` | new | See each task |
| `docker-compose.yml`, `.env.example`, `.env` (local), `docs/production-variables.md`, `docs/accounts.md`, `docs/game-logs.md`, `docs/game-log-queries.sql`, `README.md`, `packages/client/nginx.conf` | modify/new | Phase G |

---

## Phase A: Accounts and roles (branch `accounts`)

### Task A1: The shared pool and schema

**Files:** Create `db.ts`, `schema.ts`. Modify `gameLog.ts` (move `SCHEMA`/`ensureSchema` out, use `db()`), `index.ts`. Test: existing `tests/server*.test.mjs` and `tests/game-log.test.mjs` stay green; new `tests/pg-real.test.mjs` (schema part).

**Interfaces (produces):**
- `initDb(): void`
- `db(): pg.Pool | null`
- `tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T>`
- `ensureSchema(): Promise<void>` (idempotent, cached once it succeeds)

`db.ts`:

```ts
import pg from "pg";
import { env } from "./env";

let pool: pg.Pool | null = null;

export function initDb(): void {
  if (pool || !env.DATABASE_URL) return;
  pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 6 });
  pool.on("error", (e) => console.error("[db] postgres:", e.message));
}

export const db = () => pool;

/** Run `fn` in one transaction. */
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
```

`schema.ts`, the SQL added after the existing `games` and `move_codes` DDL:

```sql
ALTER TABLE games ADD COLUMN IF NOT EXISTS seed text;
ALTER TABLE games ADD COLUMN IF NOT EXISTS seeded_from text;
CREATE INDEX IF NOT EXISTS games_ended_at ON games (ended_at DESC);
CREATE TABLE IF NOT EXISTS roles (name text PRIMARY KEY, rank smallint NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS role_privileges (
  role text NOT NULL REFERENCES roles(name) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS game_players_user ON game_players (user_id, game_id);
```

Then the default roles, inserted with `ON CONFLICT DO NOTHING` from a constant in `schema.ts`:

```ts
const DEFAULT_ROLES = [
  { name: "USER", rank: 1, privileges: ["history"] },
  { name: "ADMIN", rank: 2, privileges: ["history", "view_stats"] },
  { name: "SUPERADMIN", rank: 3, privileges: ["history", "view_stats", "manage_users"] },
];
```

- [ ] **Step 1:** Write `tests/pg-real.test.mjs` with
  `describe.skipIf(!process.env.TEST_DATABASE_URL)`, using its own schema: `options=-csearch_path=t_<nanoid>` on the URL, and `CREATE SCHEMA` first.
  - **Test:** `ensureSchema()` twice gives all six tables, plus three roles with 1/2/3 privileges.
  - **Test:** when the `ADMIN` row in `role_privileges` is deleted and `ensureSchema()` runs with a fresh cache, `view_stats` is NOT re-added for ADMIN. Only missing *roles* get their defaults: privileges are inserted only together with a role inserted in the same run (`INSERT … RETURNING name`, then privileges for the returned names). This keeps DB edits.
- [ ] **Step 2:** Run it with `TEST_DATABASE_URL`. Expected: FAIL (no `schema.ts`).
- [ ] **Step 3:** Implement; `gameLog.ts` uses `db()` and `ensureSchema()`; `index.ts` calls `initDb()` first.
- [ ] **Step 4:** Run `npx vitest run tests/pg-real.test.mjs tests/server.test.mjs tests/server-gamelog-off.test.mjs tests/game-log.test.mjs` (pg-real with the variable). Expected: PASS. The `[gamelog] DATABASE_URL is not set` warning is unchanged.
- [ ] **Step 5:** Commit `Server: shared Postgres pool and schema (users, roles, privileges, history links)`.

### Task A2: Passwords and recovery codes

**Files:** Create `passwords.ts`. Test: `tests/accounts.test.mjs`.

**Interfaces (produces):**
- `hashPassword(pw): Promise<string>`
- `verifyPassword(pw, stored): Promise<boolean>`
- `DUMMY_HASH`
- `newRecoveryCode(): string`, in the form `XXXXX-XXXXX-XXXXX-XXXXX` over the alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`
- `normalizeCode(input): string` (upper case; `O`→`0`, `I`/`L`→`1`; strips spaces and dashes; regroups)
- `sha256(s): string` (hex)
- `MIN_PASSWORD = 10`, `MAX_PASSWORD = 200`

- [ ] **Step 1: Failing tests**
  1. A hash verifies only its own password.
  2. Two hashes of one password differ (salt).
  3. The format matches `/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/`.
  4. Malformed stored strings (`""`, `"plain"`, `"scrypt$1$2$3$x$y"`, out-of-range N) give `false` without throwing.
  5. `DUMMY_HASH` verifies nothing.
  6. `newRecoveryCode()` matches `/^([0-9A-HJKMNP-TV-Z]{5}-){3}[0-9A-HJKMNP-TV-Z]{5}$/`, and 1000 codes are all different.
  7. `normalizeCode("abcde fghjk-mnpqr-stvwo")` gives `"ABCDE-FGHJK-MNPQR-STVW0"`.
- [ ] **Step 2:** Run. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the hashing with the promisified `scrypt`, the parameter bounds check (`16384 ≤ N ≤ 2^20`, a power of two; `1 ≤ r ≤ 32`; `1 ≤ p ≤ 4`) and `timingSafeEqual`:

```ts
const N = 32768, R = 8, P = 1, KEYLEN = 32;
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newRecoveryCode(): string {
  const bytes = randomBytes(20); // 20 symbols × 5 bits, one byte each (low 5 bits)
  const s = [...bytes].map((b) => CROCKFORD[b & 31]).join("");
  return s.match(/.{5}/g)!.join("-");
}
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
```

- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `Accounts: scrypt passwords and recovery codes`.

### Task A3: Accounts and sessions

**Files:** Create `accounts.ts`, `sessions.ts`. Modify `env.ts`, `tests/support/fakePg.mjs`, `tests/units.test.mjs` (its `productionProblems` "good" config gains `SESSION_SECRET`). Test: `tests/accounts.test.mjs`, plus the account flows in `tests/pg-real.test.mjs`.

**Interfaces (produces):**

```ts
// shared/src/accounts.ts
export type Role = "USER" | "ADMIN" | "SUPERADMIN";            // the defaults; the DB may hold others
export type Privilege = "history" | "view_stats" | "manage_users";
export interface PublicUser { id: string; username: string; role: string; privileges: string[] }
export const Username = z.string().trim().toLowerCase().regex(/^[a-z0-9_.-]{3,24}$/, "Use 3–24 letters, digits, dots, dashes or underscores.");
export const Password = z.string().min(10, "Use at least 10 characters.").max(200);
export const Credentials = z.object({ username: Username, password: Password });
export const LoginPayload = z.object({ username: z.string().trim().toLowerCase().max(24), password: z.string().min(1).max(200) });
export const RecoverPayload = z.object({ username: z.string().trim().toLowerCase().max(24), recoveryCode: z.string().max(40), newPassword: Password });
export const ResetPayload = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), newPassword: Password });
```

```ts
// accounts.ts
export class AccountError extends Error { constructor(msg: string, readonly code: "taken" | "reserved" | "invalid" | "disabled" | "not_found" | "forbidden" | "no_db") }
register(username, password): Promise<{ user: PublicUser; recoveryCode: string }>
login(username, password): Promise<PublicUser | null>              // null: wrong; throws "disabled"
recover(username, code, newPassword): Promise<{ user: PublicUser; recoveryCode: string } | null>
createResetLink(byUserId, userId): Promise<{ token: string; expiresAt: Date }>
resetWithToken(token, newPassword): Promise<{ user: PublicUser; recoveryCode: string } | null>
changePassword(userId, current, next): Promise<boolean>
newRecoveryCodeFor(userId, password): Promise<string | null>
endSessions(userId): Promise<void>
deleteOwnAccount(userId, password): Promise<boolean>
userById(id): Promise<(PublicUser & { disabled: boolean; sessionsAfter: Date }) | null>   // one query, privileges via array_agg
bootstrapSuperadmin(): Promise<"created" | "promoted" | "unchanged" | "off">
// sessions.ts
issueSession(userId): string
sessionUser(token: string | undefined): Promise<PublicUser | null>
sessionCookie(token), clearedCookie(), readCookie(header: string | undefined, name)
currentUser: RequestHandler                     // res.locals.user = PublicUser | null
requirePrivilege(p: Privilege): RequestHandler  // 401 "Please sign in." / 403 "You don't have access to this."
```

**`sessionUser`:**
1. Verify with `SESSION_SECRET`, `algorithms: ["HS256"]`, `audience: "skyteam-session"`.
2. Load `userById(sub)`.
3. Refuse when the user is missing, has `disabled`, or when `iat * 1000 < floor(sessionsAfter / 1000) * 1000`.

**`bootstrapSuperadmin`:**
- Without `SUPERADMIN_USERNAME`, it returns `"off"`.
- If that user doesn't exist, it creates the user as `SUPERADMIN` with `SUPERADMIN_INITIAL_PASSWORD`. A missing password, or one shorter than 10 characters, logs an error and returns `"off"`.
- If the user exists but isn't SUPERADMIN, it sets the role.

**`register`:**
- Refuses reserved names, except `SUPERADMIN_USERNAME` (which bootstrap has already created, so it ends up "taken").
- Inserts with `ON CONFLICT (username) DO NOTHING`; `rowCount 0` means `taken` ("That username is taken.").

**`env.ts`:**
- add `SESSION_SECRET` (dev default `"dev-insecure-session-secret-change-me"`, added to `KNOWN_SECRETS`);
- add `SUPERADMIN_USERNAME` and `SUPERADMIN_INITIAL_PASSWORD`;
- `productionProblems` gets the same check for `SESSION_SECRET` as for `JWT_SECRET`, plus "SESSION_SECRET must differ from JWT_SECRET."

**fakePg:** an in-memory model for the exact SQL these modules send.
- Keep the SQL strings as exported constants in `accounts.ts`, so the fake matches them by identity: `if (text === SQL.insertUser)`, and so on. The fake imports them.
- Add `BEGIN`/`COMMIT`/`ROLLBACK` as no-ops, and `connect()` returning `{query, release}`.
- Add `results: Map<string, rows>` for canned answers.

The real SQL is proven in `pg-real.test.mjs`. The fake only has to make the HTTP layer testable.

- [ ] **Step 1: Failing tests** (`tests/accounts.test.mjs`, fake pg):
  1. `register("alice", "ten chars!")` gives a user with role `USER` and privileges `["history"]`, plus a recovery code. The stored row holds neither the password nor the code in plain text.
  2. Registering `"alice"` again throws `taken`. `"admin"` throws `reserved`. `"Al ice"` is refused by `Credentials` at the API layer (tested in A4).
  3. `login`:
     - the right password gives the user;
     - a wrong password gives `null`;
     - an unknown user gives `null`, and `verifyPassword` was still called once (spy on the module);
     - a disabled user throws `disabled`.
  4. `recover`:
     - the right code gives a new code, the old code no longer works, and the new password works;
     - a wrong code gives `null`.
  5. A reset link works once and expires (move `Date.now` past 24 h with `vi.setSystemTime`). Its token is stored only hashed.
  6. **Sessions:**
     - `sessionUser(issueSession(id))` gives the user.
     - A player identity token (`issueToken().token`) gives `null`. *(Review Focus 1)*
     - The reverse: `verifyToken(issueSession(id))` gives `null`. *(Review Focus 1)*
     - After `endSessions`, a session issued earlier gives `null`.
     - After `changePassword`, a session issued earlier gives `null`.
     - After disabling the account, a session gives `null`.
     - After deleting the account, a session gives `null`. *(Review Focus 4)* Use `vi.setSystemTime` to step past the 1 s `iat` resolution.
  7. **`bootstrapSuperadmin` (with env vars set through `vi.stubEnv` before importing env):**
     - the first run gives `"created"`, and the user is SUPERADMIN with all three privileges;
     - the second run gives `"unchanged"`;
     - after the role is set to USER, a run gives `"promoted"`;
     - without the password, it gives `"off"`.
  8. `productionProblems` flags a missing `SESSION_SECRET`, one shorter than 32 characters, and one equal to `JWT_SECRET`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Add the same flows to `pg-real.test.mjs` (register, login, recover, reset, delete) against the real SQL.
- [ ] **Step 4:** Run `npx vitest run tests/accounts.test.mjs tests/units.test.mjs`, and `pg-real` with the variable. Expected: PASS.
- [ ] **Step 5:** Commit `Accounts: users, roles from the database, sessions, recovery`.

### Task A4: The auth and account API

**Files:** Create `api.ts`. Modify `http.ts` (`app.use("/api", apiRouter())` before `onError`; export `route()` for both), `index.ts` (`void bootstrapSuperadmin().then(r => console.log(...))`). Test: `tests/api-auth.test.mjs`.

**Interfaces (produces, HTTP; all JSON; `Cache-Control: no-store`):**

| Route | Success | Failures |
|---|---|---|
| `POST /api/auth/register {username, password}` | 201 `{user, recoveryCode}` + cookie | 400 (first zod message), 409 taken / reserved, 429 |
| `POST /api/auth/login {username, password}` | 200 `{user}` + cookie | 401 "Wrong username or password.", 403 "This account is disabled.", 429 |
| `POST /api/auth/logout` | 204, cookie cleared | — |
| `GET /api/auth/me` | 200 `{user: PublicUser \| null}` | (never 401: guests get null) |
| `POST /api/auth/recover {username, recoveryCode, newPassword}` | 200 `{user, recoveryCode}` + cookie | 401 "That recovery code doesn't match.", 429 |
| `POST /api/auth/reset {token, newPassword}` | 200 `{user, recoveryCode}` + cookie | 410 "This reset link has expired or was already used." |
| `POST /api/account/password {currentPassword, newPassword}` | 200 + a new cookie (other sessions end) | 401 |
| `POST /api/account/recovery-code {password}` | 200 `{recoveryCode}` | 401 |
| `POST /api/account/sign-out-everywhere` | 204, cookie cleared | 401 |
| `DELETE /api/account {password}` | 204, cookie cleared | 401 |

Router-wide:
- 503 `{error: "Accounts need the database."}` without a database (D16);
- 415 for a non-GET request that isn't JSON (D14);
- the rate limits of D15, using the existing `rateLimiter`.

- [ ] **Step 1: Failing tests.** Set up like `server.test.mjs`: fake Redis and pg, `TRUST_PROXY=1`, a fresh `X-Forwarded-For` per request.
  - **Helper:** `api(method, path, {body, cookie, from, type})` returns `{status, body, cookie}`, where `cookie` is the `skyteam_session=…` value from Set-Cookie.
  - **Cases:**
    1. Register, then `me` with the cookie gives the user. `me` without a cookie gives `{user: null}`.
    2. The Set-Cookie matches `/^skyteam_session=[^;]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/`.
    3. Register with a bad username gives 400 with the Username message. A taken name gives 409 "That username is taken.".
    4. A login with the wrong password gives 401. An unknown user gives the same 401, with the same body.
    5. Recover with the code: the old password fails afterwards, and the new password plus the new code work.
    6. Changing the password: the old cookie gets `{user: null}` from `me`, and the new cookie works.
    7. Sign out everywhere: the cookie is dead.
    8. Delete the account with the wrong password gives 401. With the right one, 204; then login gives 401.
    9. A `text/plain` login gives 415. *(D14)*
    10. The 6th registration from one address within an hour gives 429. The 11th failed login for one name, each from a new address, gives 429.
    11. In `tests/server-gamelog-off.test.mjs` (no database): `/api/auth/me` gives 503, and `/health` still gives 200.
- [ ] **Step 2:** Run. Expected: FAIL (404).
- [ ] **Step 3:** Implement `apiRouter()`. The auth routes are thin: parse with zod, call `accounts.ts`, set the cookie, and map each `AccountError` code to a status in one table.
- [ ] **Step 4:** Run `npx vitest run tests/api-auth.test.mjs tests/server-gamelog-off.test.mjs tests/server.test.mjs`. Expected: PASS.
- [ ] **Step 5:** Commit `Accounts: auth and account API`.

### Task A5: The account pages in the client

**Files:** Create `router.ts`, `account/authApi.ts`, `account/useAccount.ts`, `account/SignIn.tsx`, `Register.tsx`, `Forgot.tsx`, `Reset.tsx`, `Account.tsx`, `RecoveryCode.tsx`, `AccountChip.tsx`. Modify `main.tsx`, `App.tsx` (the chip on the landing page and the lobby header), `store.ts` (socket `withCredentials: true`; `useAccount` subscribers reconnect the room socket when the signed-in user changes). Test: `tests/client/account.test.tsx`.

**Interfaces (produces):**
- `navigate(path: string)` and `usePath(): string` in `router.ts`.
- `useAccount`, a zustand store holding:
  - `user: PublicUser | null | undefined` (undefined = not loaded);
  - `available: boolean` (false after a 503);
  - `load()`, `signIn(u, p)`, `register(u, p)`, `signOut()`, `has(privilege)`.
- `authApi` functions: each is a `fetch(SERVER_URL + "/api/…", {credentials: "include", headers: {"content-type": "application/json"}})`, returning `{ok: true, …} | {ok: false, error, status}`.

**`main.tsx`:**
```tsx
const routes: Record<string, () => JSX.Element> = { "/signin": SignIn, "/register": Register, "/forgot": Forgot, "/reset": Reset, "/account": Account, "/history": History };
// "/games/<id>" → lazy GamePage; "/admin" → lazy AdminStats; "/admin/users" → lazy AdminUsers; anything else → App
```

**UI:**
- **`AccountChip`:**
  - **Guest:** "Sign in" and "Register" links.
  - **Signed in:** the username, opening a menu with History and Account, plus Statistics with `view_stats` and Users with `manage_users`, and Sign out.
  - **Without a database (`available` false):** nothing.
- **`RecoveryCode`:**
  - shows the code in large monospace with a "Copy" button, and the sentence "Save this code. It's the only way to reset your password yourself. We can't show it again.";
  - its "I've saved it" button continues.
  - Register, Forgot, Reset and Account ("New recovery code") all lead to it.
- **Forms:**
  - each field has a label and `autocomplete` (`username`, `new-password`, `current-password`);
  - the server's error shows in a `role="alert"`;
  - the button is disabled while the form is sending.
- **After sign-in:** go to `?next=` if it is a same-site path starting with `/`, otherwise `/`.
- **Reset page:** reads `?token=`, then calls `history.replaceState` to drop the token from the address bar.

- [ ] **Step 1: Failing tests** (jsdom; `fetch` stubbed by a small route table):
  1. A guest sees "Sign in" and "Register".
  2. With a `503` from `me`, the chip doesn't render, and the landing page still offers "Create a room".
  3. Register: entering the username and password shows the recovery-code screen with the code. "I've saved it" leads to `/`, and the chip shows "alice".
  4. A 409 from register shows "That username is taken." in the alert.
  5. Sign in with a 401 shows the error and clears the password field.
  6. Forgot: username, code and new password show the new code.
  7. Reset with `?token=abc…` posts the token, and afterwards the address no longer contains it.
  8. The Account page:
     - "Change password" posts the current and new passwords;
     - "Sign out everywhere" leads to `/signin`;
     - "Delete my account" asks for the password and confirmation, then leads to `/`.
  9. The menu shows "Statistics" only with `view_stats`, and "Users" only with `manage_users`.
  10. Every fetch has `credentials: "include"`.
  11. After sign-in while a room socket exists, the store disconnected and reconnected it (FakeSocket counts).
- [ ] **Step 2:** Run `npx vitest run tests/client/account.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement. Styles go in `styles.css` under a `/* accounts */` block, using the existing tokens.
- [ ] **Step 4:** Run, then `npm test` and `npm run typecheck`. Expected: green.
- [ ] **Step 5:** Commit `Client: sign in, register, recovery and account pages`.

---

## Phase B: Seeded dice (branch `seeds`)

### Task B1: A seeded, restart-safe source of dice

**Files:** Create `packages/server/src/seededRand.ts`. Test: `tests/seeds.test.mjs`.

**Interfaces (produces):**
```ts
export interface SeedState { seed: string; round: number; draws: number }   // stored in the room record
export function newSeed(): string;                                          // 32 hex chars
export function seededRand(state: SeedState, round: () => number): Rand;    // advances state.draws; resets draws when round() changes
```

```ts
import { createHmac, randomBytes } from "node:crypto";
import type { Rand } from "@skyteam/shared";

export const newSeed = () => randomBytes(16).toString("hex");

/** The k-th draw of round r is HMAC-SHA256(seed, "r:k"), read as 32-bit words
 *  (rejection keeps it unbiased). The same seed gives the same draws, round by
 *  round, however many draws earlier rounds took. */
export function seededRand(state: SeedState, round: () => number): Rand {
  return (n) => {
    const r = round();
    if (r !== state.round) { state.round = r; state.draws = 0; }
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    for (let attempt = 0; ; attempt++) {
      const mac = createHmac("sha256", Buffer.from(state.seed, "hex")).update(`${r}:${state.draws}:${attempt}`).digest();
      for (let i = 0; i < 32; i += 4) {
        const x = mac.readUInt32BE(i);
        if (x < limit) { state.draws++; return x % n; }
      }
    }
  };
}
```

**Rounds:**
- the Intern shuffle runs before round 1's deal, as round `0`;
- every draw afterwards uses `game.round`;
- when the game is in `rolling`, the server has already advanced `game.round` to the round being dealt.

- [ ] **Step 1: Failing tests**
  1. **Determinism:** the same seed and the same `(round, draw)` sequence give the same values; different seeds give different sequences in 1000 draws.
  2. **Uniformity smoke test:** 60 000 draws of `n=6` land within ±3 % of 10 000 each.
  3. **Round independence:** with seed S, round 2's first 8 draws are identical whether round 1 took 8 draws or 20. *(Review Focus 2)*
  4. **Restart safety:** after 5 draws, `JSON.parse(JSON.stringify(state))` and a new `seededRand` on it continue with the same 6th draw as the original would.
  5. `newSeed()` matches `/^[0-9a-f]{32}$/`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `Server: seeded, restart-safe dice (HMAC-SHA256 per round)`.

### Task B2: Every live game is seeded and logged with its seed

**Files:** Modify `types.ts` (`Room.seedState?: SeedState | null`), `socket.ts` (`onStart` and `onReset` set `room.seedState = {seed: newSeed(), round: 0, draws: 0}`; every place that passes the module-level `rand` passes `gameRand(room)` instead), `gameLog.ts` (`Row` gains `seed`), `snapshot.ts` (no change, but test it). Test: `tests/seeds.test.mjs`, `tests/server.test.mjs` (additions).

**Interfaces:**
- Produces `gameRand(room: Room): Rand`:

  ```ts
  seededRand(room.seedState!, () => (room.game ? room.game.round : 0))
  ```

  The bot's `think` keeps its own `randomInt`; it chooses moves and draws no dice.
- Consumes `newSeed` and `seededRand` from B1.

- [ ] **Step 1: Failing tests** (`tests/server.test.mjs`, real sockets):
  1. **Seed in the row:** a finished game's row has `seed` matching `/^[0-9a-f]{32}$/`. Two games have different seeds.
  2. **Same seed, same deals:**
     - Start game A and read its deal.
     - Set `room.seedState` of game B to A's seed by editing the room in FakeRedis (the test helper).
     - Reset, so B starts on that seed. Round 1's deal and the Intern order are identical.
     - In round 1, A rerolls and B doesn't. Round 2's deal is still identical. *(Review Focus 2)*
  3. **The seed stays on the server:** no `room:state` or `game:event` payload received by any client in the whole test file contains the seed string. Collect every payload and `JSON.stringify` them. *(Review Focus 3)*
  4. **Restart mid-round:** save the room, rebuild the server's in-memory state (`getRoom` from Redis), and apply the next reroll. Its value equals the value a never-restarted twin room produced for the same seed and draws.
- [ ] **Step 2:** Run. Expected: FAIL (no `seed` column in the row).
- [ ] **Step 3:** Implement. `gameLog.ts`'s `COLUMNS` gains `seed`, and the pending rows queued in Redis by older builds insert `null` for it.
- [ ] **Step 4:** Run `npx vitest run tests/seeds.test.mjs tests/server.test.mjs tests/server-npc.test.mjs`, then `npm test`. Expected: green.
- [ ] **Step 5:** Commit `Server: every live game is seeded; the seed is logged when it ends`.

---

## Phase C: History and replays (branch `history`)

### Task C1: Seats remember their account; `game_players` is written

**Files:** Modify `types.ts` (`Seat.accountId?`, `Seat.username?`), `socket.ts` (`onJoin`), `gameLog.ts` (row `players` and the transaction), `snapshot.ts` (`seat.username` is shown as the default name). Test: `tests/history.test.mjs`.

**`onJoin`:**
1. `const user = await sessionUser(readCookie(socket.handshake.headers.cookie, "skyteam_session"))`.
2. When this socket's player has a seat (not a bot), set `seat.accountId = user?.id`, and `seat.username = user?.username`. With no user, both are deleted, so signing out and rejoining unlinks the seat.
3. A seat without a chosen `name` shows `username`.

**`endGameLog`:**
- **What it adds:** `players` = `[{crew, user_id}]` for each seat that has an `accountId`.
- **The insert:** inside `tx`, insert the game row, then `INSERT INTO game_players … ON CONFLICT DO NOTHING`.
- **A deleted account:** inserting a link to a user who has been deleted in the meantime fails the whole transaction. So insert links with
  `INSERT … SELECT $1, id, $3 FROM users WHERE id = $2 ON CONFLICT DO NOTHING`.
- **The pending queue:** queued rows carry `players` too.

- [ ] **Step 1: Failing tests** (real sockets, fake pg):
  1. Alice signs in and hosts. A guest joins and they finish a game. `game_players` holds exactly `{game_id, user_id: alice.id, crew: alice's crew}`.
  2. Alice with two signed-in tabs in both seats gives two rows.
  3. A solo game with the bot: only Alice's row.
  4. Alice signs out and rejoins (a new socket without the cookie): the seat stays, `accountId` is gone, and the next game logs no row for her. *(Review Focus 4)*
  5. Alice's account is disabled while she's in a lobby: on rejoin she is a guest in her seat.
  6. Postgres is down at game end. The row and its `players` wait in `gamelog:pending`, and both are written after recovery.
  7. Alice's account is deleted before the pending row is flushed. The game row is written, with no link and no error.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. The client passes the cookie on the WebSocket handshake automatically (same site); `store.ts` already sets `withCredentials` (A5).
- [ ] **Step 4:** Run `npx vitest run tests/history.test.mjs tests/server.test.mjs`. Expected: PASS.
- [ ] **Step 5:** Commit `History: seats remember their account; games link to their players`.

### Task C2: History and game-page API

**Files:** Modify `api.ts`, and `shared/src/accounts.ts` (types). Test: `tests/history.test.mjs` (HTTP part), plus the queries in `tests/pg-real.test.mjs`.

**Interfaces (produces):**
```ts
export interface GameSummary { id: string; scenario: string; modules: string[]; abilities: string[]; result: string; lossReason: string | null; roundsReached: number; crew: "pilot" | "copilot"; partner: string; endedAt: string; seeded: boolean }
export interface GameRecord { id: string; format: number; setup: GameSetup; internTokens: DieValue[]; moves: string; result: string; lossReason: string | null; roundsReached: number; crews: { pilot: string; copilot: string }; startedAt: string; endedAt: string; sameDiceAvailable: boolean; seededFrom: string | null }
```

**`GET /api/me/games?before=<endedAt>|<id>`**
- Needs the `history` privilege; 401 for a guest.
- Returns `{games: GameSummary[20], next: string | null}`, newest first, with a keyset cursor on `(ended_at, id)`.
- **`partner`** is the other seat's username when it is linked, "Bot (aviator)" for the bot, "Guest" otherwise. It is computed in SQL: LEFT JOIN `game_players` and `users` for the other crew, then CASE on `games.pilot` / `games.copilot` for `bot:`.

**`GET /api/games/:id`**
- Public: anyone with the link (D10).
- Returns a `GameRecord`, or 404 "No game with that id.".
- `sameDiceAvailable = seed IS NOT NULL`.
- Never includes the seed or the room id. *(Review Focus 3)*
- The id must match `/^[A-Za-z0-9_-]{21}$/`, else 404.

- [ ] **Step 1: Failing tests**
  1. Alice's history after three games is newest first. Each has `crew`, `partner` ("Guest" / "Bot (aviator)" / "bob"), `result` and `seeded: false`.
  2. Paging over 45 games gives 20, 20 and 5, and `next` is null on the last page.
  3. A guest gets 401 from `/api/me/games`.
  4. Bob doesn't see Alice's solo games.
  5. `GET /api/games/<id>` works without a cookie. Its JSON has no `seed`, no `room_id` and no 32-hex substring. Replaying it with the shared `replay(header, moves)` reaches the logged result.
  6. An unknown id gives 404, and `/api/games/../../etc` gives 404.
  7. A row from before this change (`seed` null) gives `sameDiceAvailable: false`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Add the two SQL queries to `pg-real.test.mjs` (history ordering, partner names, paging).
- [ ] **Step 4:** Run, plus `pg-real` with the variable. Expected: PASS.
- [ ] **Step 5:** Commit `History: my games and public game records`.

### Task C3: The history page and the replay viewer

**Files:** Create `history/History.tsx`, `history/GamePage.tsx` (lazy), `history/ReplayControls.tsx`. Modify `main.tsx` (routes), `shared/src/protocol.ts` (`RoomSnapshot.lastGameId?: string`), `socket.ts` / `snapshot.ts` (when a game ends won or lost, `room.lastGameId = log.id`; cleared on the next start), `components/Cockpit.tsx` (when the game has an outcome and the snapshot has `lastGameId`, the callout gains a "Watch the replay" link to `/games/<id>`, opening in a new tab). Test: `tests/client/history.test.tsx`.

**The replay viewer:**
1. `GamePage` fetches the `GameRecord` and runs `replaySteps({format, setup, internTokens}, moves)` once, in a `useMemo`.
2. Step `i` is drawn with `<Cockpit snapshot={replaySnapshot(record, steps[i].state)} onCommand={() => {}} />`. `replaySnapshot` builds a `RoomSnapshot` in which `you.playerId` is `"replay-viewer"`, an onlooker, so nothing can be played. The crews are named `pilot` / `copilot`, the ids the replay uses, with `seats` named after `record.crews`.
3. **`ReplayControls`:**
   - Start, −round, −1, Play/Pause (one step every 700 ms), +1, +round and End buttons;
   - a range slider over the steps;
   - "Round r · move k of n";
   - keyboard: ← → for a step, Shift+← → for a round, Space to play.

   The current step's text from the rules' log sits under the cockpit (the `game.log` entries added at that step).
4. **The header** shows the airport, modules and abilities, the result and loss reason, the crews and the date.
5. **The "Fly the same dice" button** appears when `sameDiceAvailable`. It leads to Phase D's flow; until Phase D lands, it is hidden behind `false`.
6. **A failed replay** (a `GameLogError`) shows "This game can't be replayed by this version." and the raw move string in a `<details>`.

**`History`:**
- a table with date, airport, result, seat, partner and a "Replay" link;
- "Load more" fetches `next`;
- seeded games carry a "same dice" tag.

- [ ] **Step 1: Failing tests** (jsdom, fixture games produced with `newGame` / `applyIntent` and `mulberry32` in the test, encoded with the real recorder):
  1. The history page lists the fixture's three games, and "Load more" appends the next page.
  2. A guest on `/history` is sent to `/signin?next=/history`.
  3. The game page shows the header, and the cockpit at step 0 (the first deal).
  4. "+1" leads to step 1, and the die appears on its space. "End" shows the outcome callout. "−round" goes back to the deal.
  5. Nothing is clickable as a move: clicking a die sends no command (`onCommand` is a spy that is never called).
  6. 404 shows "No game with that id.".
  7. A corrupt `moves` string shows the can't-replay message and the raw string.
  8. In the existing `cockpit.test.tsx` setup, a finished game with `lastGameId` shows a "Watch the replay" link to `/games/<id>`.
- [ ] **Step 2:** Run `npx vitest run tests/client/history.test.tsx tests/client/cockpit.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them, then `npm test` and `npm run typecheck`. Expected: green.
- [ ] **Step 5:** Commit `History: my games page and step-by-step replay viewer`.

---

## Phase D: Same-dice games (branch `same-dice`)

### Task D1: Server: creating, locking and leaving a same-dice room

**Files:** Modify `types.ts` (`Room.sameDice?: { gameId: string; seed: string } | null`), `rooms.ts` (`createRoom(playerId, solo?, sameDice?)`), `http.ts` (`POST /rooms {sameDiceAs?}`), `socket.ts` (`onSetup` refuses while `sameDice` is set: "This room flies the same dice as an earlier game — use fresh dice to change the setup."; `onStart`/`onReset` seed from `room.sameDice.seed`; new `room:freshDice`, host only, lobby only, clears `sameDice`), `gameLog.ts` (`seeded_from`), `shared/protocol.ts` (`RoomSnapshot.sameDice?: { gameId: string } | null` without the seed; `room:freshDice` event), `stats` remains Phase E. Test: `tests/same-dice.test.mjs`.

**`POST /rooms` with `sameDiceAs`:**
1. Look up `SELECT seed, scenario, modules, abilities FROM games WHERE id = $1`.
   - Unknown id, or `seed IS NULL`: 404 "That game can't be flown again."
   - No database: 503.
2. Otherwise, the room's setup is `{scenarioId: scenario, modules, abilities}`, and `room.sameDice = {gameId, seed}`.
3. Combined with `solo`, it is a solo room with the bot.
4. No account is needed (D9: anyone with the link).

- [ ] **Step 1: Failing tests** (real sockets, fake pg with a finished game row inserted by playing one):
  1. **Same dice:** a room created with `sameDiceAs: <id>` starts on the original setup. Round 1's deal and the Intern order equal the original's (read from the original row's move string: its first `D` token and `intern_order`).
  2. **The new row:** `seeded_from = <id>`, and its `seed` equals the original's.
  3. **Setup locked:** `room:setup` is refused with the message. After `room:freshDice`, `room:setup` works, the next game has a new seed, and its row has `seeded_from: null`.
  4. **Reset:** reset in a same-dice room deals the same round 1 again, and both rows are seeded.
  5. **Bad links:** an unknown id gives 404. A pre-seed game (seed null) gives 404.
  6. **No seed in snapshots:** every snapshot has `sameDice: {gameId}`, and no payload contains the seed. *(Review Focus 3)*
  7. **Solo:** `{sameDiceAs, solo: {crew: "pilot", bot: "aviator"}}` creates a solo same-dice room.
  8. **Host only:** a guest sending `room:freshDice` gets "Only the host can change the setup.".
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run tests/same-dice.test.mjs tests/server.test.mjs`, then `npm test`. Expected: green.
- [ ] **Step 5:** Commit `Same dice: rooms that fly an earlier game's seed, marked in the log`.

### Task D2: Client: "Fly the same dice"

**Files:** Modify `history/GamePage.tsx` (enable the button: a choice of "With a friend", which creates the room and goes to the lobby with an invite link, or "Solo with the bot", with the seat and level pickers reused from the landing page's solo flow), `api.ts` (`createRoom({sameDiceAs, solo?})`), `components/Lobby.tsx` (a banner when `snapshot.sameDice`: "Same dice as an earlier game. Results are marked and kept out of the statistics." with a link to `/games/<id>`; the setup picker is shown read-only; the host gets "Use fresh dice"). Test: `tests/client/history.test.tsx`, `tests/client/app.test.tsx`.

- [ ] **Step 1: Failing tests**
  1. On the game page, "Fly the same dice", then "With a friend", posts `/rooms {sameDiceAs: id}` and shows the lobby with the banner.
  2. "Solo with the bot" posts `{sameDiceAs, solo}`.
  3. In a lobby with `sameDice`, the scenario picker is disabled, and the host sees "Use fresh dice", which emits `room:freshDice`. The guest doesn't see it.
  4. Without `sameDiceAvailable`, there is no button.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, then `npm test` and `npm run typecheck`. Expected: green.
- [ ] **Step 5:** Commit `Client: fly an earlier game's dice again`.

---

## Phase E: The ADMIN statistics dashboard (branch `admin-stats`)

### Task E1: The statistics endpoint

**Files:** Create `stats.ts`. Modify `api.ts` (`GET /api/admin/stats?includeSeeded=1`, behind `requirePrivilege("view_stats")`), `shared/src/accounts.ts` (`AdminStats`), `docs/game-log-queries.sql` (header comment: how to leave out same-dice games). Test: `tests/admin-api.test.mjs`, `tests/pg-real.test.mjs`.

**Interfaces (produces):**
```ts
export interface AdminStats {
  generatedAt: string; includeSeeded: boolean; seededGames: number;
  playRate: { scenario: string; games: number; pct_of_all_games: number; finished: number; pct_of_finished_games: number | null }[];
  crashCauses: { scenario: string; cause: string; losses: number; pct_of_airport_losses: number }[];
  failedLandings: { scenario: string; condition: string; failed_landings: number }[];
  winRateByAirport: { scenario: string; finished: number; won: number; lost: number; win_pct: number }[];
  winRateByAbility: { ability: string; finished: number; win_pct: number }[];
  winRateByModule: { module: string; finished: number; win_pct: number }[];
  humansVsBot: { scenario: string; crew: string; finished: number; win_pct: number }[];
  unfinished: { result: string; rounds_reached: number; games: number }[];
  recentGames: { id: string; scenario: string; result: string; loss_reason: string | null; rounds_reached: number; pilot: string; copilot: string; ended_at: string; seeded: boolean }[];
}
```

**How it works:**
- **The queries:** `STAT_QUERIES` holds queries 1–7 from `docs/game-log-queries.sql`, verbatim, without the trailing `;`.
- **Recent games:**

  ```sql
  SELECT id, scenario, result, loss_reason, rounds_reached, pilot, copilot, ended_at, seeded_from IS NOT NULL AS seeded FROM games ORDER BY ended_at DESC LIMIT 20
  ```

  This list always includes seeded games, with their tag.
- **Leaving out seeded games:** `forStats(sql, includeSeeded)` replaces every `FROM games` with `FROM (SELECT * FROM games WHERE seeded_from IS NULL) games` when `includeSeeded` is false. `seededGames` comes from `SELECT count(*) FROM games WHERE seeded_from IS NOT NULL`.
- **Numbers:** the rows go through `numeric()`, over the column set `games, pct_of_all_games, finished, pct_of_finished_games, losses, pct_of_airport_losses, failed_landings, won, lost, win_pct, rounds_reached`.

- [ ] **Step 1: Failing tests**
  1. **SQL file in sync:** each `STAT_QUERIES` value, with whitespace collapsed, appears in `docs/game-log-queries.sql`, also collapsed. (D11)
  2. **Guards:**
     - a guest gets 401;
     - a USER gets 403 "You don't have access to this.";
     - an ADMIN gets 200;
     - a SUPERADMIN gets 200;
     - an ADMIN whose `view_stats` row is deleted from `role_privileges` gets 403 on the next request. Privileges come from the DB (D5).
  3. **Shape and numbers (fake, `results` map):** `playRate` strings `"3"`/`"75.0"` arrive as numbers 3/75. Unknown queries give `[]`. *(Review Focus 5)*
  4. **`includeSeeded`:** with the flag off, the fake receives the wrapped SQL; with `?includeSeeded=1`, the original.
  5. **Real Postgres** (`pg-real.test.mjs`):
     - an empty database gives every section `[]` and `seededGames: 0`;
     - six games covering every result, two scenarios, a bot pilot and one seeded copy give the exact numbers (YUL 4 games at 66.7 %; the grouped "Landing failed"; the two split conditions; `win_pct` 50; both crew kinds; three unfinished rows);
     - with `includeSeeded` off, the seeded game isn't counted; with it on, it is;
     - a database where every game is seeded gives empty sections, not an error. *(Review Focus 5)*
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, plus `pg-real` with the variable. Expected: PASS.
- [ ] **Step 5:** Commit `Admin: statistics endpoint (view_stats), same-dice games left out by default`.

### Task E2: The dashboard page

**Files:** Create `admin/AdminStats.tsx`, `admin/admin.css`. Modify `main.tsx` (the `/admin` route, lazy). Test: `tests/client/admin.test.tsx`.

**Page:**
- **Access:** a guest goes to `/signin?next=/admin`; a user without `view_stats` sees "You don't have access to this.".
- **Header:** "SkyTeam statistics", "Updated <time>", a Refresh button, and a toggle "Include same-dice games (N)".
- **Totals:** games, finished, wins, win rate ("—" when nothing has finished).
- **Sections,** each with an `<h2>` and a table; percentages show as a number plus a CSS bar (`--pct`):
  1. play rate;
  2. win rate per airport;
  3. crash causes, grouped per airport;
  4. failed-landing conditions;
  5. abilities and modules, side by side on desktop;
  6. humans vs the bot;
  7. unfinished games;
  8. recent games, linking to `/games/<id>`, with a "same dice" tag.
- **An empty section** shows "No games yet.".
- **On a phone,** tables scroll inside their section, with a 16px gutter. The page adds `<meta name="robots" content="noindex">`.

- [ ] **Step 1: Failing tests:**
  1. A guest is sent to sign in.
  2. A USER sees the no-access text, and no stats fetch is made.
  3. An ADMIN sees the totals from the fixture ("4 games", "3 finished", "1 won", "33.3 %"), every section heading, the "YUL … 66.7 %" row, and "No games yet." in an empty section.
  4. The toggle refetches with `includeSeeded=1`.
  5. A recent game links to `/games/<id>`.
  6. A 401 during a refresh goes to sign in.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, then `npm test` and `npm run typecheck`. Expected: green.
- [ ] **Step 5:** Commit `Admin: statistics dashboard`.

---

## Phase F: SUPERADMIN user management (branch `admin-users`)

### Task F1: The user-management API

**Files:** Modify `accounts.ts`, `api.ts`. Test: `tests/admin-api.test.mjs`, `tests/pg-real.test.mjs`.

**Interfaces (produces; all behind `requirePrivilege("manage_users")`):**

| Route | Answer |
|---|---|
| `GET /api/admin/users?q=&before=` | `{users: {id, username, role, disabled, createdAt, games}[50], next}`, filtered by username prefix |
| `GET /api/admin/roles` | `{roles: {name, rank, privileges}[]}` |
| `PATCH /api/admin/users/:id {role?, disabled?}` | 200 `{user}` |
| `POST /api/admin/users/:id/reset-link` | 200 `{url: CLIENT_ORIGIN + "/reset?token=…", expiresAt}` |
| `DELETE /api/admin/users/:id` | 204 |

The URL uses the first `CLIENT_ORIGIN` entry; in dev the client builds the URL from the token instead.

**Refused, all with 409:**
- acting on yourself: "Use your account page for your own account.";
- demoting or disabling the last enabled SUPERADMIN: "There must always be a SUPERADMIN.";
- changing the `SUPERADMIN_USERNAME` account: "This account is the site owner's (SUPERADMIN_USERNAME).".

**Side effects:**
- a role that doesn't exist gives 400;
- disabling, changing the role and deleting all bump `sessions_after`;
- a reset link replaces any unused link for that user.

- [ ] **Step 1: Failing tests:**
  1. **Who can call:** an ADMIN gets 403 on every route; a SUPERADMIN gets 200.
  2. **Search:** `?q=al` finds alice, not bob. Paging works over 120 users.
  3. **Roles:** promoting bob to ADMIN gives him `view_stats` at once. Bob's old session still works, but `me` shows the new privileges. Then demote him.
  4. **Disable:** bob's session dies; login gives 403; enabling him again lets him sign in.
  5. **Reset link:** works once at `/api/auth/reset`; a second link replaces the first; a link older than 24 h gives 410.
  6. **Delete:** bob's `game_players` rows go, his games stay in `games`, and his session dies.
  7. **Refusals:**
     - acting on yourself gives 409;
     - removing the last SUPERADMIN gives 409;
     - the owner account gives 409;
     - an unknown role gives 400;
     - an unknown user gives 404.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Add the search and last-superadmin queries to `pg-real.test.mjs`.
- [ ] **Step 4:** Run, plus `pg-real` with the variable. Expected: PASS.
- [ ] **Step 5:** Commit `Admin: user management API (manage_users)`.

### Task F2: The users page

**Files:** Create `admin/AdminUsers.tsx`. Modify `main.tsx` (the `/admin/users` route, lazy). Test: `tests/client/admin.test.tsx`.

**Page:**
- a search box (debounced 300 ms) and a table: username, role (a `<select>` of the roles from `/api/admin/roles`), status, joined, games;
- per row: "Disable"/"Enable", "Reset link", and "Delete" (asks for the username to be typed, to confirm);
- "Reset link" shows the URL with a Copy button and the expiry;
- server refusals show in a `role="alert"`;
- your own row has no actions, only "Use your account page for your own account.";
- users without `manage_users` see the no-access text.

- [ ] **Step 1: Failing tests:**
  1. The list renders, and searching sends `?q=`.
  2. Changing the role sends a PATCH and updates the row.
  3. "Disable" sends a PATCH with `{disabled: true}`.
  4. "Reset link" shows the URL and Copy.
  5. Delete needs the typed username, then sends DELETE and removes the row.
  6. A 409 shows its message.
  7. Your own row has no actions.
  8. An ADMIN without `manage_users` sees no-access.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run, then `npm test` and `npm run typecheck`. Expected: green.
- [ ] **Step 5:** Commit `Admin: users page`.

---

## Phase G: Production wiring, docs and checks in a real browser

Done on the branch of whichever phase merges last; each earlier phase updates its own docs rows when it lands.

- [ ] **G1. Compose and environment.** The server's environment in `docker-compose.yml` gains:
  - `SESSION_SECRET: ${SESSION_SECRET:?Set SESSION_SECRET in .env, e.g. openssl rand -hex 32}`
  - `SUPERADMIN_USERNAME: ${SUPERADMIN_USERNAME:-}`
  - `SUPERADMIN_INITIAL_PASSWORD: ${SUPERADMIN_INITIAL_PASSWORD:-}`

  `.env.example` gets a block for each, explaining what it does.
- [ ] **G2. Secrets into the local `.env`,** without printing them:

  ```sh
  grep -q '^SESSION_SECRET=' .env || printf 'SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
  grep -q '^SUPERADMIN_INITIAL_PASSWORD=' .env || printf 'SUPERADMIN_INITIAL_PASSWORD=%s\n' "$(openssl rand -base64 24 | tr -d '/+=')" >> .env
  ```

  Verify with `grep -c`, and never `cat`. Ask the user for the `SUPERADMIN_USERNAME` they want.
- [ ] **G3. `docs/production-variables.md`.** New rows:
  - `SESSION_SECRET` (secret);
  - `SUPERADMIN_USERNAME` (variable);
  - `SUPERADMIN_INITIAL_PASSWORD` (secret, "change it after the first sign-in").

  Plus a "First sign-in" section.
- [ ] **G4. `docs/accounts.md`:**
  - roles and privileges, and how to add one in SQL;
  - recovery codes and reset links;
  - sessions;
  - the rate limits;
  - same-dice games and how to leave them out of SQL (`WHERE seeded_from IS NULL`);
  - the privacy note: game rows are anonymous; the account links go when an account is deleted.

  Also update `docs/game-logs.md` (the `seed` and `seeded_from` columns, `game_players`, the dashboard) and the README links.
- [ ] **G5. nginx.**
  - If `packages/client/nginx.conf` has the VPS plan's forwarding block, change its regex to `^/(rooms|identity|health|api)(/|$)`.
  - If not, add that line to the VPS plan's Task 2.

  The CSP needs no change (same-origin `connect-src`).
- [ ] **G6. Check by hand in a real browser** (dev stack with `SUPERADMIN_USERNAME=owner` and a password passed through `-e`; Playwright against `http://192.168.100.12:5173`, desktop and iPhone contexts). The checks:
  1. **Register:** register `alice`, and the recovery code shows. Then sign out and back in.
  2. **Play:** alice plays a solo game to the end, and "Watch the replay" appears.
  3. **Replay:** the replay steps through to the same outcome.
  4. **History:** the game is listed.
  5. **Same dice:** "Fly the same dice", Solo, shows the lobby banner, and round 1 deals the same dice as the original.
  6. **Recovery:** forgot password with the code works.
  7. **SUPERADMIN:**
     - `owner` signs in with the initial password;
     - `/admin` shows the statistics, with the seeded game left out until the toggle is on;
     - `/admin/users` makes alice ADMIN, and alice's `/admin` works without signing in again;
     - a reset link opened in a fresh context works.
  8. **Sessions:** after sign-out, `fetch('/api/admin/stats', {credentials: 'include'})` gives 401.
  9. **Phone:** no horizontal page scroll on any new page.
  10. **Screenshots:** register and recovery code, history, replay, same-dice lobby, dashboard (desktop and phone), users page. Send them to the user.
- [ ] **G7.** Run `npm test` (full suite) and `pg-real` with the variable. Expected: all green. Commit `Accounts: production wiring and docs`.

---

## Order, size and what each phase delivers

| Phase | Ships on its own | Depends on |
|---|---|---|
| A: Accounts and roles | Register, sign in, recover, account page; roles in the DB; first SUPERADMIN | — |
| B: Seeded dice | Every game seeded and its seed logged (invisible to players) | — (parallel to A) |
| C: History and replays | My games, the public game page, step-by-step replay, "Watch the replay" | A, B |
| D: Same-dice games | "Fly the same dice", marked rows, "Use fresh dice" | B, C |
| E: Statistics dashboard | `/admin` for `view_stats` | A (and D's `seeded_from`, already in A1's schema) |
| F: User management | `/admin/users` for `manage_users` | A |
| G: Wiring and docs | Production variables, docs, browser checks | all |

**Follow-ups, not in this plan:** date filters on the dashboard; CSV export; email as an optional recovery route; an admin view of open rooms.
