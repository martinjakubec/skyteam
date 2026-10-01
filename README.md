# SkyTeam — realtime two-player game

An online two-player game with simultaneous, server-authoritative actions,
multiple concurrent rooms, invite-link join, ready-up/host-start lobby flow, and
reconnect-after-disconnect. TypeScript end to end.

## Architecture in one paragraph

A single Node process is the **authoritative source of truth**. Clients send
*intents* (`game:command`) over a WebSocket; the server validates each against
the shared game rules, applies it via a **pure reducer**, persists the new state
to **Redis** (so games survive restarts), and broadcasts the result to everyone
in the room. Because Node processes one event at a time, "simultaneous" inputs
are simply *serialized at the server* — there are no races. A player is modelled
as a durable **seat** in a room, independent of any particular socket, which is
what makes reconnection work: a dropped socket leaves the seat intact for a
grace period, and a fresh socket re-attaches and gets a full state snapshot.

## Layout (npm workspaces)

```
packages/
  shared/   types, zod message schemas, and the pure game reducer (used by both sides)
  server/   Express + Socket.IO, room registry, Redis persistence, identity tokens
  client/   React + Vite + Zustand UI
```

The single most important file to read is `packages/server/src/socket.ts` — it
contains the room lifecycle, command handling, and the disconnect/reconnect
grace-timer logic.

## Tests

```bash
npm test   # rules + unit suites (run inside a node:22 container; see below)
```

`scripts/validate.mjs` is an end-to-end check against a running server
(`BASE=http://server:3001` on the compose network).

## Running it

Everything runs in containers, so you don't need Node installed locally.

### Full app (production-style build)

```bash
docker compose up --build
```

- Client: <http://localhost:8080>
- Server: <http://localhost:3001>
- Redis:  localhost:6379

Open the client, click **Create a room**, copy the invite link, open it in a
second browser/incognito window, both **Ready up**, and the host can **Start**.
To test reconnect: kill the browser tab's network (or stop/restart its
connection) and bring it back within 60s — it resyncs automatically.

### Development (hot reload)

```bash
docker compose -f docker-compose.dev.yml up
```

- Client (Vite HMR): <http://localhost:5173>
- Server (tsx watch): <http://localhost:3001>

Source is bind-mounted, so edits on the host reload live. First boot is slow
(each service installs dependencies once into its own volume).

## Configuration

Copy `.env.example` to `.env` and adjust. Key knobs:

| Variable | Meaning | Default |
|---|---|---|
| `RECONNECT_GRACE_MS` | How long a dropped player's seat is held before the game is abandoned | `60000` |
| `JWT_SECRET` | Secret for signing anonymous identity tokens — **change in production** | dev placeholder |
| `CLIENT_ORIGIN` | Allowed CORS origins: a comma-separated allowlist, or `*` to reflect any origin (LAN/dev) | `http://localhost:8080` |
| `VITE_SERVER_URL` | Pins the server URL baked into the client bundle; leave unset to derive it from the page's own host | derived |
| `VITE_SERVER_PORT` | Server port used when deriving the URL | `3001` |

The reconnect window lives in one place (`RECONNECT_GRACE_MS`, defaulting to
`DEFAULT_RECONNECT_GRACE_MS` in `packages/shared/src/config.ts`) so it's trivial
to change later.

## The game

`packages/shared/src/game/` implements the **faithful SkyTeam base game** (the
YUL Montréal-Trudeau scenario): the silent two-crew cockpit where Pilot and
Co-Pilot place dice on the Axis, Engines, Radio, Landing Gear, Flaps, Brakes and
Concentration modules over seven rounds to land the plane, with all the rulebook
win/lose conditions (spin, collision, overshoot, mandatory dice, and the final
landing checks).

- **`scenario.ts`** is pure data: the approach track (length + per-space
  traffic), altitude/reroll layout, axis spin threshold and speed-gauge starts.
  A new airport is a new `Scenario` — the rules engine doesn't change. A few
  board-geometry numbers aren't printed in the rulebook text and are marked
  `CONFIRM AGAINST PHYSICAL BOARD`.
- **`reducer.ts`** is the pure `reduce(state, command) => state`. It is the only
  place the rules live, and it is **module-ready**: the advanced "Flight Log"
  modules (Kerosene, Wind, Intern, Ice Brakes, Traffic die, Turns…) slot into the
  named resolve/end-of-round steps and the `Scenario.modules` list without a
  rewrite. They are not implemented yet.
- **Game setup.** The host picks the airport (`SCENARIOS`) and modules in the
  lobby (`room:setup`); the server builds the game from `scenarioForSetup`. Only
  modules listed in `IMPLEMENTED_MODULES` can be selected — add a module's id
  there once its rules are in the reducer.
- **Dice are hidden and random.** Each player rolls behind a screen; the reducer
  stays pure, so the **server** generates dice values and threads them in, and
  `redactGameStateFor` hides the opponent's unplaced dice before state is sent.

### Tests

- `node scripts/test-rules.mjs` (run with `tsx`) — deterministic unit tests of
  the reducer: a full winning landing plus every loss/mechanic branch.
- `node scripts/validate.mjs` — end-to-end socket test against a running server
  (create/join → lobby → start → hidden-dice redaction → realtime placement →
  reconnect resync). See the header comments for how to run each in a container.

## Notes & next steps

- **Spectators** are already modelled: anyone joining a full or in-progress room
  becomes an `observer` (receives broadcasts, cannot act). The v1 UI just shows a
  watcher count; a spectator view can be built on top without backend changes.
- **Identity** is anonymous (a signed token in `localStorage`). Accounts can be
  added later by binding an account to the existing `playerId`. For production,
  move the token to an `httpOnly` cookie.
- **Scaling** is single-server today. The pieces to go multi-node later are
  already in place (Redis for shared state, rooms keyed by id): add Redis pub/sub
  for cross-node broadcast (`@socket.io/redis-adapter`) and sticky routing.
