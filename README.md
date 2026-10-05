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
npm test    # rules + unit + bot suites (run inside a node:22 container; see below)
npm run bench -- [games=30] [quick|samples] [ALL]   # bot win rate
npm run bench -- [games=40] landing [samples=20|600ms]   # YUL landings (MODULES="kerosene,intern" adds modules)
```

`npm run bench` plays the bot against itself and prints, per setup, the win
rate, the average round reached and the top loss reasons, then the overall win
rate. By default it covers every scenario card, every module combination and
each Special Ability; `ALL` plays every module combination × every ability set
(slow — use a small game count). `ONLY="intern,kerosene"` keeps only setups
containing all those ids (scenario id, module or ability). Games are seeded, so
a run is reproducible.

`scripts/bench-cards.mjs` measures Aviator on the scenario cards as printed:
each card with its own modules, and a card with ★ Special Abilities with
four random picks of as many abilities. Games run in a pool of child
processes (`CONCURRENCY=16` at once), at a fixed `SAMPLES=120` per candidate
so results don't depend on the machine's load (`BUDGET_MS=600` plays at
the live time budget instead). Each finished game is a line
in `OUT` (default `sim-output/bench-cards.jsonl`); a rerun skips games
already there, so a stopped run resumes. `DIFFICULTY=green,yellow` (default),
`CARDS=…`, `GAMES=80`, `ONLY=…`; `SUMMARY=1` prints the table from `OUT`.

```bash
docker run --rm -v "$PWD":/app -w /app node:22-alpine node_modules/.bin/tsx scripts/bench-cards.mjs
```

`scripts/validate.mjs` is an end-to-end check against a running server
(`BASE=http://server:3001` on the compose network).

`npm run validate:realtime-bot` (in the dev stack's client container) starts its
own server with Real-Time rounds shortened to 3 s (`REAL_TIME_SECONDS`, a
testing-only setting) and checks that a time-up wakes the solo bot when it
leads the next round.

`scripts/simulate.sh` plays real games in two browsers (Pilot on desktop,
Co-Pilot on a phone-sized window) against the running dev stack — one per
combination of the modules the lobby offers, skipping exclusive pairs — and
fails on any move the UI offers but the server rejects, a stalled game,
mismatched screens, or page errors. `REPEAT=3 ONLY="Intern,Kerosene+Intern"`
narrows it; failure screenshots go to `sim-output/`.

`scripts/realtime.sh` checks the Real-Time clock the same way, in real time
(~2.5 min): time's up with and without the Axis/Engines set, and a disconnect
pausing the clock until the player is back.

## Running it

Everything runs in containers, so you don't need Node installed locally.

### Full app (production-style build)

```bash
cp .env.example .env    # then set JWT_SECRET: openssl rand -hex 32
docker compose up --build
```

The server image runs with `NODE_ENV=production`, and a production server
refuses to start without a real `JWT_SECRET` (32+ characters, not a
placeholder) and an explicit `CLIENT_ORIGIN` that isn't `*`.

- Client: <http://localhost:8080>
- Server: <http://localhost:3001>
- Redis:  localhost:6379

Open the client, click **Create a room**, copy the invite link, open it in a
second browser/incognito window, both **Ready up**, and the host can **Start**.
To test reconnect: kill the browser tab's network (or stop/restart its
connection) and bring it back within 60s — it resyncs automatically.

To play alone, use **Play solo** on the landing page: pick your seat (Pilot or
Co-Pilot) and the bot's level. A server-side bot flies the other seat at a
human pace (`NPC_DELAY_MS` between its moves), sees only what a player in its
seat would see, and answers Reroll and Working Together offers on its own.
Opening a solo room's invite link makes you an observer.

The bot is **Aviator**. It searches: for its best few moves it repeatedly
fills in the dice it can't see, plays the game out with a fast rollout
policy, and keeps the move that lands most often, within `NPC_THINK_MS`. It
thinks in worker threads, so it never blocks other rooms. Its **quick
strategy** — every legal move scored one step ahead (approach pace, traffic,
tilt, switches, the landing) — is what it falls back to if a search fails,
and what the rollouts use when nothing cheap fits. Rooms and clients from
before the levels were retired (Cadet, Navigator) get Aviator.

It plays every module. The rollouts feed Kerosene, mind the Kerosene Leak
when pairing Engine dice, train the Intern and place its tokens, and work
the Ice Brakes. A few plans steer the search where sampling alone can't:
Ice Brakes steps are started by the Pilot and always finished; with
Kerosene, the Pilot's 2 sets the first Brakes; in Real-Time, once under
20 s are left, the crew's own Axis and Engine come first.

Measured per scenario card with `scripts/bench-cards.mjs` at the live
600 ms budget (80 seeds per setup; each card with its printed modules; a
card with ★ abilities over four random ability picks), the share of games
that land:

| Card | Landed | | Card | Landed |
|---|---|---|---|---|
| green YUL | 76% | | yellow LHR | 10% |
| green LHR | 40% | | yellow TGU | 5% |
| green OSL | 26% | | yellow GIG | 4% |
| green PRG | 20% | | yellow KUL | 3% |
| green ATL | 16% | | yellow KEF | 2% |
| green HND | 14% | | yellow PRG | 2% |
| | | | yellow ATL | 1% |

Off YUL, most lost games end short of the airport with traffic still on
the approach: the bot can't clear airplanes fast enough to keep its pace.
Per-card tuning (`CARD=… npm run tune`, `SCORE=graded`) and two clearing
experiments (`SEARCH_DEFAULTS.radioCandidate`, `POLICY_PARAMS.clearPlannedAny`,
off by default) were measured and didn't help, so `BOT_PROFILES` is empty.
Runs at a time budget vary with the machine's load (about ±15 landings in
300 games); compare experiments at a fixed `SAMPLES` first.

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
| `NPC_DELAY_MS` | Pause before each move of a solo game's bot, so a human can follow | `900` |
| `NPC_THINK_MS` | How long the Aviator bot may search for a move | `600` |
| `NPC_WORKERS` | Search worker threads for the bot (a decision fans out to the idle ones). Set it to the CPUs the container may really use | a spare core each, at most 4 |
| `JWT_SECRET` | Secret for signing anonymous identity tokens. **Required in production** (32+ characters, not a placeholder) | dev placeholder |
| `CLIENT_ORIGIN` | Allowed CORS origins: a comma-separated allowlist, or `*` to reflect any origin (LAN/dev). **Required in production**, and `*` is refused there | `http://localhost:8080` |
| `TRUST_PROXY` | Reverse proxies in front of the server, so the per-client rate limits see the real address in `X-Forwarded-For` (2 behind Caddy + the client's nginx) | `0` |
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
  A new airport is a new `Scenario` — the rules engine doesn't change. The
  approach tracks aren't in the rulebook text; every card's track was read
  off the physical strips.
- **`reducer.ts`** is the pure `reduce(state, command) => state`. It is the only
  place the rules live, and it is **module-ready**: the advanced "Flight Log"
  modules (Kerosene, Wind, Intern, Ice Brakes, Traffic die, Turns…) slot into the
  named resolve/end-of-round steps and the `Scenario.modules` list without a
  rewrite. Implemented so far: **Kerosene** (either crew burns a die's value;
  an empty space burns 6 at round end; an empty tank loses) and **Kerosene
  Leak** (played instead of Kerosene: no die space; the Engine dice burn their
  difference + 1 as soon as both are placed), and **Ice Brakes** (replace the
  Brakes: steps 2 → 5, each needing a same-value pair — Pilot on top, either
  crew below — in one round; the marker must be past the 5 to land), and
  **Intern** (train with a die ≠ your next token to take it — Pilot from the
  left, Co-Pilot from the right — then place it at once like a die of its
  number, not on Concentration, no Coffee; all 6 trained to land), and
  **Wind** (the Wind Ring's airplane starts on +3; after each Axis phase it
  turns one space per pip the plane is tilted — left when tilted toward the
  Pilot — and the wind it points at is added to the Engine total every round,
  the landing round included), and **Real-Time** (each round has 60 seconds
  from the roll; when time's up no more dice can be placed — unplaced dice
  and anything pending are dropped — and an empty Axis or Engine space loses.
  The reducer stays clock-free: the server stamps each roll with its clock,
  runs the timeout and issues `timeUp`; it pauses the clock while a seat is
  disconnected, and placing is refused until it resumes. Messages carry
  `serverTime` so each device maps the deadline onto its own clock).
- **Game setup.** The host picks the airport (`SCENARIOS`), modules and Special
  Abilities in the lobby (`room:setup`); the server builds the game from
  `scenarioForSetup`. Only modules listed in `IMPLEMENTED_MODULES` can be
  selected — add a module's id there once its rules are in the reducer.
- **Turns** (an Approach Track effect: board data, not a lobby module). A space
  with `axisAllowed` only lets the plane advance off it — from it, or through
  it on a 2-space advance — with the Axis in one of those positions; any other
  tilt loses ("Missed the turn"). Not advancing needs no particular tilt. The
  track draws the permitted positions as green ▼ on a small arc. The rules
  check a turn when the Engines resolve, against the tilt at that moment.
- **Scenario cards** (`game/catalog.ts`). `SCENARIO_TEMPLATES` lists the
  rulebook's 21 cards by difficulty (green Routine Landing, yellow Exceptional
  Conditions, red Elite Pilots Only, black Heroic Landing) with each card's
  modules and ★ ability count. Each card's `board` takes its approach track
  (traffic, turns, Traffic dice, length) from `APPROACH_TRACKS` and the rest
  (rounds, Axis spin limit, speed gauges) from YUL; the reroll rounds depend
  on the card's difficulty.
- **Special Abilities** (`game/abilities.ts`), up to the scenario's limit
  (`maxAbilities`; YUL has none, so they're unavailable until a ★ card is
  playable):
  - **Working Together** — once per round the active player offers a die; the
    other must answer with one of theirs; the values swap.
  - **Synchronisation** — once there's a die on Landing Gear and on Flaps, the
    server rolls the Traffic die (2,3,3,4,4,5) and the Co-Pilot places it on any
    empty space of either colour (Concentration and the Intern board included).
  - **Mastery** — matching Engine dice regain a spent Reroll token.
  - **Control** — matching Axis dice gain a Coffee.
  - **Anticipation** — each round, before their first die, the First Player may
    reroll one die.
  - **Adaptation** — once per game per player, turn a die to its opposite face
    (on either player's turn).
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
- **Identity** is anonymous: a signed token (HS256, 30 days) kept in
  `sessionStorage` under a per-tab key, so every browser tab is its own player.
  Accounts can be added later by binding an account to the existing `playerId`.
  An `httpOnly` cookie would keep the token away from page scripts, but a cookie
  is shared by every tab, so two tabs would become one player; keeping
  injected scripts out (no raw HTML anywhere, a Content-Security-Policy) is
  what protects the token instead.
- **Abuse limits.** Per client address and minute: 20 new rooms, 60 joins, 60
  identities; per socket, 20 events a second; messages up to 16 KB; at most 20
  spectators a room. Socket handlers, routes and timers catch their own
  errors, so a malformed or hostile message can't take the server down.
- **Redis outages.** While Redis is unreachable the server refuses requests at
  once (a 500 with `code: "unavailable"`) instead of queueing them, and the
  client shows a "Lost contact with the tower" page; Try again reloads into
  the room once Redis is back.
- **Scaling** is single-server today. The pieces to go multi-node later are
  already in place (Redis for shared state, rooms keyed by id): add Redis pub/sub
  for cross-node broadcast (`@socket.io/redis-adapter`) and sticky routing.
