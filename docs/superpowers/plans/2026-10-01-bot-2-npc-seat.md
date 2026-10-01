# Bot Phase 2 — NPC Seat (Solo Play) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A player can play alone: they pick Pilot or Co-Pilot and a difficulty, and a server-side bot takes the other seat and plays at a human pace.

**Architecture:** A room may contain one bot seat (`Seat.bot: BotLevel`), always connected and ready. Which crew each seat flies is now explicit (`room.hostCrew`) instead of "host = Pilot". After every state change the server checks whether the game waits on the bot (`actorFor`, Phase 1) and, after a short delay, applies the bot's `chooseMove` through the same command path humans use — so every rule, broadcast and persistence step is shared.

**Tech Stack:** Express + Socket.IO server (`packages/server`), React lobby (`packages/client`), shared bot from Phase 1.

**Spec:** `docs/superpowers/plans/2026-10-01-bot-1-core-and-benchmark.md` (prerequisite — must be merged first) and the user decisions: the player chooses Pilot or Co-Pilot, the bot takes the other seat; difficulties Cadet / Navigator / Aviator; no move explanations yet.

## Global Constraints

- Prerequisite: Phase 1 merged (`chooseMove`, `actorFor`, `BotLevel`, `BOT_LEVEL_LABELS`, `newGame`, `applyIntent` exist in `@skyteam/shared`).
- The bot decides from `redactGameStateFor(game, botId)` only.
- Bot moves go through the same server path as human commands (validation, reduce, persist, per-recipient redaction, broadcast).
- Bot pacing: wait `NPC_DELAY_MS` (default 900 ms, env-overridable, 0 in tests) before each bot action so a human can follow.
- Node only in Docker; tests via `npm test`; E2E via `scripts/validate.mjs` on the compose network.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Server restart mid-solo-game:** in-memory timers are lost; when the human reconnects (`room:join`), the bot must resume if the game waits on it. Test in Task 2 (E2E: rejoin triggers scheduling).
- **Bot has no legal move** (`chooseMove` returns null): log it and mark the room `abandoned` with a clear reason — never loop or crash. Test in Task 2 (unit on the decision helper).
- **Host changes setup in a solo lobby:** changing modules must not un-ready the bot (only humans are un-readied). Test in Task 1.
- **Someone opens the invite link of a solo room:** they become an observer (both seats taken), and the bot never treats them as its partner. Test in Task 3 (E2E).
- **Double scheduling:** two state changes in quick succession must not make the bot act twice for one prompt (one pending timer per room; re-check `actorFor` when it fires). Test in Task 2.

---

## File Structure

- Create `packages/server/src/seating.ts` — pure helpers (no Redis import, so unit-testable): `seatCrews(room)`, `botSeat(room)`, `npcShouldAct(room)`.
- Create `packages/server/src/npc.ts` — the scheduler (timers, delay, apply).
- Modify `packages/server/src/types.ts` (`Seat.bot`, `Room.hostCrew`), `rooms.ts` (`createSoloRoom`), `store.ts` (defaults), `socket.ts` (extract `applyCommand`, use `seatCrews`, call the scheduler), `http.ts` (`POST /rooms` with `solo`), `snapshot.ts` (`SeatView.bot`).
- Modify `packages/shared/src/protocol.ts` (`SeatView.bot?: BotLevel`, `RoomSnapshot.hostCrew`).
- Modify client: `api.ts` (`createRoom(solo?)`), `App.tsx` (landing "Play solo"), `components/Seats.tsx` (🤖 label), `components/Lobby.tsx` (no invite box for solo), `styles.css`.
- Tests: `scripts/test-units.mjs` (seating), `scripts/validate.mjs` (solo E2E).

---

### Task 1: Seats know their crew; rooms can hold a bot

**Files:** `packages/server/src/types.ts`, `seating.ts` (create), `rooms.ts`, `store.ts`, `socket.ts` (`onStart`, `onReset`, `onSetup`), `packages/shared/src/protocol.ts`, `packages/server/src/snapshot.ts`; Test: `scripts/test-units.mjs` new section "2d) Seating".

**Interfaces:**
- Produces:
  - `Seat.bot?: BotLevel` (absent for humans); `Room.hostCrew: Crew` (default `"pilot"`).
  - `seatCrews(room: Room): { pilotId: PlayerId; copilotId: PlayerId }`.
  - `botSeat(room: Room): (Seat & { bot: BotLevel }) | null`.
  - `createSoloRoom(humanId: PlayerId, crew: Crew, level: BotLevel): Promise<Room>`.
  - `SeatView.bot?: BotLevel`; `RoomSnapshot.hostCrew: Crew`.

- [ ] **Step 1: Failing unit tests** (add `import { seatCrews, botSeat, npcShouldAct } from "../packages/server/src/seating.ts";`)

```js
console.log("2d) Seating: who flies which seat; bot seats");
{
  const base = { id: "r", inviteCode: "i", hostPlayerId: "H", status: "lobby", observers: [], setup: DEFAULT_SETUP, version: 0, game: null, updatedAt: 0 };
  const seats = [{ playerId: "H", role: "host", ready: true, connected: true }, { playerId: "G", role: "guest", ready: true, connected: true }];
  check("default: host flies Pilot", JSON.stringify(seatCrews({ ...base, seats })) === JSON.stringify({ pilotId: "H", copilotId: "G" }));
  check("hostCrew copilot: host flies Co-Pilot", JSON.stringify(seatCrews({ ...base, seats, hostCrew: "copilot" })) === JSON.stringify({ pilotId: "G", copilotId: "H" }));
  const solo = { ...base, hostCrew: "copilot", seats: [seats[0], { ...seats[1], playerId: "bot:1", bot: "cadet" }] };
  check("bot seat found", botSeat(solo)?.bot === "cadet" && botSeat({ ...base, seats }) === null);
}
```

- [ ] **Step 2: Run** → FAIL (module missing).
- [ ] **Step 3: Implement**

`types.ts`: `Seat` gets `bot?: BotLevel; // set on an NPC seat (always connected + ready)`; `Room` gets `hostCrew: Crew; // which crew the host flies (guest flies the other)`.

`seating.ts`:

```ts
import type { BotLevel, PlayerId } from "@skyteam/shared";
import type { Room, Seat } from "./types";

/** Which player flies which seat. The host flies `hostCrew` (default Pilot). */
export function seatCrews(room: Room): { pilotId: PlayerId; copilotId: PlayerId } {
  const host = room.seats.find((s) => s.role === "host")!.playerId;
  const guest = room.seats.find((s) => s.role === "guest")!.playerId;
  return (room.hostCrew ?? "pilot") === "pilot" ? { pilotId: host, copilotId: guest } : { pilotId: guest, copilotId: host };
}

/** The room's NPC seat, if any. */
export function botSeat(room: Room): (Seat & { bot: BotLevel }) | null {
  return (room.seats.find((s) => s.bot) as (Seat & { bot: BotLevel }) | undefined) ?? null;
}
```

`rooms.ts`:

```ts
/** A solo room: the caller (host) flies `crew`; a bot at `level` flies the
 *  other seat and is always connected and ready. */
export async function createSoloRoom(hostPlayerId: string, crew: Crew, level: BotLevel): Promise<Room> {
  const room = await createRoom(hostPlayerId); // saved once; re-saved below
  room.hostCrew = crew;
  room.seats.push({ playerId: `bot:${nanoid()}`, role: "guest", ready: true, connected: true, bot: level });
  await saveRoom(room);
  return room;
}
```

`createRoom` sets `hostCrew: "pilot"`. `store.getRoom`: `room.hostCrew ??= "pilot";`. `socket.ts` `onStart`/`onReset`: replace the two `seats.find(...)` lines with `const { pilotId, copilotId } = seatCrews(room);`. `onSetup`: un-ready only human seats: `if (seat.playerId !== playerId && !seat.bot) seat.ready = false;`. `onReady`: `allReady` unchanged (bot is ready). `snapshot.ts`: `seats: room.seats.map((s) => ({ …, ...(s.bot ? { bot: s.bot } : {}) }))`, plus `hostCrew: room.hostCrew`. `protocol.ts`: `SeatView.bot?: BotLevel`, `RoomSnapshot.hostCrew: Crew`.

Setup-change test (append to 2d):

```js
  // onSetup's un-ready rule, as a pure function of the seats.
  const { unreadyOthers } = await import("../packages/server/src/seating.ts");
  const after = unreadyOthers(solo.seats, "H");
  check("changing setup keeps the bot ready", after.find((s) => s.bot).ready === true);
```

and add to `seating.ts` (used by `onSetup`):

```ts
/** After the host changes the setup, every *human* seat but the host's must re-confirm. */
export function unreadyOthers(seats: Seat[], changerId: PlayerId): Seat[] {
  return seats.map((s) => (s.playerId === changerId || s.bot ? s : { ...s, ready: false }));
}
```

- [ ] **Step 4: Run** `npm test` → PASS; E2E `validate.mjs` → still passes (multiplayer unchanged).
- [ ] **Step 5: Commit** — `"Make seat crews explicit and allow a bot seat"`.

---

### Task 2: The NPC scheduler

**Files:** `packages/server/src/socket.ts` (extract `applyCommand`), `npc.ts` (create), `seating.ts` (`npcShouldAct`), `env.ts` (`NPC_DELAY_MS`); Test: `scripts/test-units.mjs` (2d), `scripts/validate.mjs` (Task 3 covers the live path).

**Interfaces:**
- Consumes: `actorFor`, `chooseMove`, `redactGameStateFor`, `seatCrews`, `botSeat`.
- Produces:
  - `applyCommand(io: IOServer, room: Room, playerId: PlayerId, command: GameCommand): Promise<string | null>` — the body of today's `onCommand` after parsing (reduce via `applyIntent`, persist, emit); resolves to an error message or null.
  - `npcShouldAct(room: Room): { botId: PlayerId; crew: Crew; level: BotLevel } | null`.
  - `scheduleNpc(io: IOServer, roomId: string): void` — idempotent per room.

- [ ] **Step 1: Failing unit tests** (append to 2d)

```js
  const { newGame, mulberry32 } = await import("../packages/shared/src/index.ts");
  const g = newGame(DEFAULT_SETUP, "bot:1", "H", mulberry32(5)); // bot flies Pilot; Pilot leads round 1
  const playing = { ...solo, hostCrew: "copilot", status: "in_progress", game: g };
  check("bot acts when the game waits on its crew", npcShouldAct(playing)?.crew === "pilot");
  check("…not when it waits on the human", npcShouldAct({ ...playing, game: { ...g, turn: "copilot" } }) === null);
  check("…not outside an in-progress game", npcShouldAct({ ...playing, status: "finished" }) === null);
  check("…not in rooms without a bot", npcShouldAct({ ...playing, seats }) === null);
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**

`seating.ts`:

```ts
import { actorFor, type Crew } from "@skyteam/shared";

/** Whether the game is waiting on the room's bot right now, and as which crew. */
export function npcShouldAct(room: Room): { botId: PlayerId; crew: Crew; level: BotLevel } | null {
  const bot = botSeat(room);
  if (!bot || room.status !== "in_progress" || !room.game) return null;
  const { pilotId } = seatCrews(room);
  const crew: Crew = bot.playerId === pilotId ? "pilot" : "copilot";
  return actorFor(room.game) === crew ? { botId: bot.playerId, crew, level: bot.bot } : null;
}
```

`npc.ts`:

```ts
import { randomInt } from "node:crypto";
import { chooseMove, redactGameStateFor, type Rand } from "@skyteam/shared";
import { env } from "./env";
import { getRoom, saveRoom } from "./store";
import { npcShouldAct } from "./seating";
import { applyCommand, broadcastState, type IOServer } from "./socket";

const timers = new Map<string, NodeJS.Timeout>();
const rand: Rand = (n) => randomInt(0, n);

/**
 * Let the room's bot act if the game is waiting on it. Idempotent: at most one
 * pending timer per room, and the condition is re-checked when it fires (the
 * state may have moved on). Call after every state change and on (re)join.
 */
export function scheduleNpc(io: IOServer, roomId: string): void {
  if (timers.has(roomId)) return;
  timers.set(
    roomId,
    setTimeout(async () => {
      timers.delete(roomId);
      const room = await getRoom(roomId);
      const turn = room && npcShouldAct(room);
      if (!room || !turn) return;
      const move = chooseMove(redactGameStateFor(room.game!, turn.botId), turn.crew, turn.level, rand);
      if (!move) {
        console.error(`[npc] ${roomId}: no legal move for the ${turn.crew} bot — abandoning`);
        room.status = "abandoned";
        await saveRoom(room);
        broadcastState(io, room);
        return;
      }
      const error = await applyCommand(io, room, turn.botId, move);
      if (error) console.error(`[npc] ${roomId}: move rejected (${error}) — ${JSON.stringify(move)}`);
      scheduleNpc(io, roomId); // it may still be the bot's action (e.g. after training the Intern)
    }, env.NPC_DELAY_MS),
  );
}
```

`env.ts`: `NPC_DELAY_MS: Number(process.env.NPC_DELAY_MS ?? 900)`. `socket.ts`: move `onCommand`'s post-parse body into exported `applyCommand(io, room, playerId, command)` (returning `null` on success, the `GameRuleError` message on failure; persistence and `emitGameEvent`/`broadcastState` stay inside it) and have `onCommand` call it; export `broadcastState` and `type IOServer`. Call `scheduleNpc(io, room.id)` at the end of `applyCommand` (success), `onStart`, `onReset` and `onJoin` (covers server restarts). `npc.ts` and `socket.ts` import each other; that's safe in ESM because each only calls the other's functions at runtime, never during module initialisation — keep it that way (no top-level calls across the pair). Note: the bot's `applyCommand` must skip the "seat must be connected" assumptions — bots have `connected: true` permanently.

- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** — `"Add the NPC scheduler"`.

---

### Task 3: Solo rooms over HTTP, and the lobby

**Files:** `packages/server/src/http.ts`, `packages/client/src/api.ts`, `App.tsx`, `components/Seats.tsx`, `components/Lobby.tsx`, `styles.css`; Test: `scripts/validate.mjs` new section "9) Solo game vs the bot", `README.md`.

**Interfaces:**
- Consumes: `createSoloRoom`, `BOT_LEVELS`, `BOT_LEVEL_LABELS`.
- Produces: `SoloRoomRequest` (zod, in `packages/shared/src/protocol.ts` — the server package has no direct `zod` dependency, so schemas live in shared); `POST /rooms` accepts `{ token?, solo?: { crew: "pilot" | "copilot"; level: BotLevel } }`; client `createRoom(solo?: { crew: Crew; level: BotLevel })`.

- [ ] **Step 1: Failing E2E** (append to `validate.mjs` before the summary; the compose server must run with `NPC_DELAY_MS=0`, set in `docker-compose.dev.yml` for the E2E run or via `docker compose run -e`)

```js
  console.log("9) Solo game vs the bot");
  const soloRoom = await post("/rooms", { solo: { crew: "copilot", level: "navigator" } });
  const h = connect();
  await waitFor(h, "connect");
  await emit(h, "room:join", { roomId: soloRoom.roomId, token: soloRoom.token });
  const lobbyS = await waitFor(h, "room:state", (s) => s.seats.length === 2);
  check("solo room: a bot fills the other seat, ready", lobbyS.seats.some((s) => s.bot === "navigator" && s.ready));
  check("solo room: the human flies Co-Pilot", lobbyS.hostCrew === "copilot");
  await emit(h, "seat:ready", { ready: true });
  await waitFor(h, "room:state", (s) => s.status === "ready");
  await emit(h, "game:start");
  // Round 1 is led by the Pilot — the bot — so it must move without us.
  const botMoved = await waitFor(h, "game:event", (m) => m.game.turn === "copilot", 8000);
  check("the bot (Pilot) leads round 1 on its own", botMoved.game.dice.pilot.some((d) => d.placed));
  check("the bot's unplaced dice stay hidden from us", botMoved.game.dice.pilot.filter((d) => !d.placed).every((d) => d.hidden));
  const myDie = botMoved.game.dice.copilot.find((d) => !d.placed);
  const ackS = await emit(h, "game:command", { commandId: "s1", command: { type: "placeDie", dieId: myDie.id, target: { kind: "axis", side: "copilot" } } });
  check("we can answer", ackS.ok === true);
  check("…and the bot replies", !!(await waitFor(h, "game:event", (m) => m.game.turn === "copilot", 8000)));
  const spectator = await post(`/rooms/${soloRoom.inviteCode}/join`);
  const sp = connect(); await waitFor(sp, "connect");
  await emit(sp, "room:join", { roomId: spectator.roomId, token: spectator.token });
  check("an invite link to a solo room makes an observer", (await waitFor(sp, "room:state")).you.kind === "observer");
  h.close(); sp.close();
```

- [ ] **Step 2: Run** the E2E → FAIL (`solo` ignored; no bot seat).
- [ ] **Step 3: Implement**

`protocol.ts` (shared):

```ts
/** Body of a solo-room request: the seat the player flies and the bot's level. */
export const SoloRoomRequest = z.object({ crew: z.enum(["pilot", "copilot"]), level: z.enum(BOT_LEVELS) });
```

`http.ts`:

```ts
  app.post("/rooms", async (req, res) => {
    const me = resolveIdentity(req.body?.token);
    const solo = SoloRoomRequest.safeParse(req.body?.solo);
    const room = solo.success ? await createSoloRoom(me.playerId, solo.data.crew, solo.data.level) : await createRoom(me.playerId);
    res.json({ roomId: room.id, inviteCode: room.inviteCode, token: me.token });
  });
```

Client `api.ts`: `createRoom(solo?: { crew: Crew; level: BotLevel })` posts `{ token, solo }`. `App.tsx` landing: under "Create a room", a "Play solo" panel — seat radio (Pilot / Co-Pilot), difficulty radio (Cadet — "learning the ropes"; Navigator — "steady and sensible"; Aviator — "plans every die"), and a "Play solo" button calling `createRoom({ crew, level })` then the same flow as `onCreate`. `Seats.tsx`: a bot seat renders as `🤖 {BOT_LEVEL_LABELS[seat.bot]}` with the crew it flies. `Lobby.tsx`/`App.tsx`: hide the invite box when a seat is a bot. Until Phase 3, Cadet and Aviator play like Navigator — show "(soon)" next to their descriptions.

- [ ] **Step 4: Run** E2E → PASS; browser check: start a solo game as Pilot and as Co-Pilot at 1280 and 390 px; the bot moves after ~1 s, its dice stay face-down, reroll/swap prompts addressed to it resolve on their own.
- [ ] **Step 5:** README "Running it": solo play. **Commit** — `"Add solo play against an NPC"`.

---

## Self-review notes

- The player-picks-seat requirement → `hostCrew` (Task 1) + landing UI (Task 3). Bot takes the other seat by construction.
- Difficulty names come from Phase 1 (`BOT_LEVEL_LABELS`); real differences arrive in Phase 3.
- Fairness: the scheduler passes `redactGameStateFor(game, botId)`; the E2E checks the bot's dice stay hidden from the human.
- Prompts the bot must answer (reroll, swap, Intern token, Traffic die) are all covered by `actorFor`, so the scheduler needs no special cases.
