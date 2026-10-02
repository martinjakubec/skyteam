# Bot Phase 2 — NPC Seat (Solo Play) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revised 2026-10-03** against the code after Phase 1 merged. Changes from the 2026-10-01 draft: Phase 1's final signatures (`newGame(setup, pilotId, copilotId, rand, at)`, `applyIntent(game, command, playerId, rand, now)`); "Exit to lobby" (`onExit`) and the setup change both un-ready seats — the bot must stay ready in both; Real-Time exists: a time-up ends rounds without any command (the bot must be woken after it), and a paused clock (a human seat disconnected) refuses every player action (the bot must wait); three labels still assume "host = Pilot" and must use the crew instead; a stuck die can no longer freeze a game (Phase 1's discard rule), so "no legal move" is now a should-never-happen guard.

**Goal:** A player can play alone: they pick Pilot or Co-Pilot and a difficulty, and a server-side bot takes the other seat and plays at a human pace.

**Architecture:** A room may contain one bot seat (`Seat.bot: BotLevel`), always connected and ready. Which crew each seat flies is explicit (`room.hostCrew`) instead of "host = Pilot". After every state change the server checks whether the game waits on the bot (`actorFor`, Phase 1) and, after a short delay, applies the bot's `chooseMove` through the same command path humans use — so every rule, broadcast and persistence step is shared.

**Tech Stack:** Express + Socket.IO server (`packages/server`), React lobby (`packages/client`), shared bot from Phase 1.

**Spec:** `docs/superpowers/plans/2026-10-01-bot-1-core-and-benchmark.md` (merged) and the user decisions: the player chooses Pilot or Co-Pilot, the bot takes the other seat; difficulties Cadet / Navigator / Aviator; no move explanations yet.

## Global Constraints

- Phase 1 is merged: `chooseMove`, `actorFor`, `BotLevel`, `BOT_LEVELS`, `BOT_LEVEL_LABELS`, `newGame`, `applyIntent`, `Rand`, `mulberry32` exist in `@skyteam/shared`.
- The bot decides from `redactGameStateFor(game, botId)` only.
- Bot moves go through the same server path as human commands (validation, Real-Time "too late" check, reduce, persist, per-recipient redaction, broadcast).
- Bot pacing: wait `NPC_DELAY_MS` (default 900 ms, env-overridable) before each bot action so a human can follow.
- Node only in Docker. With the dev stack up: `docker.exe compose -f docker-compose.dev.yml exec -T client sh -c "npm run typecheck && npm test"`; E2E: `docker.exe compose -f docker-compose.dev.yml exec -T client sh -c "BASE=http://server:3001 node scripts/validate.mjs"` (the server restarts itself when shared code is rebuilt — run E2E after the test run's build, not during it).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push with `"/mnt/c/Program Files/Git/cmd/git.exe" push origin main`.

## Review Focus

- **Server restart mid-solo-game:** in-memory timers are lost; when the human reconnects (`room:join`), the bot must resume if the game waits on it. Covered: `onJoin` calls `scheduleNpc` (Task 2); E2E rejoin check in Task 3.
- **Real-Time solo game:** the clock pauses while the human is disconnected (`timerRemainingMs` set) and every player action is refused then — the bot must not act (or log errors) while paused; a time-up starts the next round with no command, so the bot must be scheduled after it. Unit tests in Task 2.
- **Host changes setup, or someone exits to the lobby, in a solo room:** only human seats are un-readied; the bot stays ready. Unit test in Task 1.
- **Someone opens the invite link of a solo room:** they become an observer (both seats taken), and the bot never treats them as its partner. E2E in Task 3.
- **Double scheduling:** two state changes in quick succession must not make the bot act twice for one prompt (one pending timer per room; `actorFor` re-checked when it fires); Exit/Reset cancel a pending bot action. Unit test on `npcShouldAct` in Task 2; the scheduler re-checks by construction.

---

## File Structure

- Create `packages/server/src/seating.ts` — pure helpers (no Redis/socket import, so unit-testable): `seatCrews`, `crewOf`, `botSeat`, `unreadyOthers`, `npcShouldAct`.
- Create `packages/server/src/npc.ts` — the scheduler (`scheduleNpc`, `cancelNpc`).
- Modify `packages/server/src/types.ts` (`Seat.bot`, `Room.hostCrew`), `rooms.ts` (`createSoloRoom`, `hostCrew` default), `store.ts` (default for old rooms), `socket.ts` (extract `applyCommand`, use `seatCrews`/`unreadyOthers`, call the scheduler), `env.ts` (`NPC_DELAY_MS`), `http.ts` (`POST /rooms` with `solo`), `snapshot.ts` (`SeatView.bot`, `hostCrew`).
- Modify `packages/shared/src/protocol.ts` (`SeatView.bot?`, `RoomSnapshot.hostCrew`, `SoloRoomRequest`).
- Modify client: `api.ts` (`createRoom(solo?)`), `App.tsx` (landing "Play solo"; no invite box with a bot), `components/Seats.tsx` (crew + 🤖 label), `components/Cockpit.tsx` (reconnect note by crew), `styles.css`.
- Tests: `scripts/test-units.mjs` (seating, scheduler decisions), `scripts/validate.mjs` (solo E2E).

---

### Task 1: Seats know their crew; rooms can hold a bot

**Files:** `packages/server/src/types.ts`, `seating.ts` (create), `rooms.ts`, `store.ts`, `socket.ts` (`onStart`, `onReset`, `onSetup`, `onExit`), `snapshot.ts`, `packages/shared/src/protocol.ts`, `packages/client/src/components/Seats.tsx`, `Cockpit.tsx`; Test: `scripts/test-units.mjs` new section "5) Seating".

**Interfaces:**
- Produces:
  - `Seat.bot?: BotLevel` (absent for humans); `Room.hostCrew: Crew` (default `"pilot"`).
  - `seatCrews(room: Room): { pilotId: PlayerId; copilotId: PlayerId }`.
  - `crewOf(room: Room, playerId: PlayerId): Crew | null`.
  - `botSeat(room: Room): (Seat & { bot: BotLevel }) | null`.
  - `unreadyOthers(seats: Seat[], keepId: PlayerId | null): Seat[]` — every human seat but `keepId` un-readied; bot seats stay ready.
  - `createSoloRoom(hostPlayerId: PlayerId, crew: Crew, level: BotLevel): Promise<Room>`.
  - `SeatView.bot?: BotLevel`; `RoomSnapshot.hostCrew: Crew`.

- [ ] **Step 1: Write the failing test** — in `scripts/test-units.mjs` add `import { seatCrews, crewOf, botSeat, unreadyOthers } from "../packages/server/src/seating.ts";` and, before the summary line:

```js
console.log("5) Seating: who flies which seat; bot seats");
{
  const base = { id: "r", inviteCode: "i", hostPlayerId: "H", status: "lobby", observers: [], setup: DEFAULT_SETUP, version: 0, game: null, updatedAt: 0 };
  const seats = [{ playerId: "H", role: "host", ready: true, connected: true }, { playerId: "G", role: "guest", ready: true, connected: true }];
  check("default: host flies Pilot", JSON.stringify(seatCrews({ ...base, seats })) === JSON.stringify({ pilotId: "H", copilotId: "G" }));
  check("hostCrew copilot: host flies Co-Pilot", JSON.stringify(seatCrews({ ...base, seats, hostCrew: "copilot" })) === JSON.stringify({ pilotId: "G", copilotId: "H" }));
  check("crewOf maps a player to the crew they fly", crewOf({ ...base, seats, hostCrew: "copilot" }, "H") === "copilot" && crewOf({ ...base, seats }, "X") === null);
  const solo = { ...base, hostCrew: "copilot", seats: [seats[0], { ...seats[1], playerId: "bot:1", bot: "cadet" }] };
  check("bot seat found", botSeat(solo)?.bot === "cadet" && botSeat({ ...base, seats }) === null);
  check("a setup change keeps the bot ready", unreadyOthers(solo.seats, "H").find((s) => s.bot).ready === true);
  check("…and un-readies the other humans", unreadyOthers(seats, "H").find((s) => s.playerId === "G").ready === false);
  check("exit to lobby (keep nobody): humans un-ready, the bot stays ready", JSON.stringify(unreadyOthers(solo.seats, null).map((s) => s.ready)) === "[false,true]");
}
```

Check `scripts/test-units.mjs` for an existing `DEFAULT_SETUP` import and its section numbering; use the next free number if 5 is taken.

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker.exe compose -f docker-compose.dev.yml exec -T client sh -c "npx tsx scripts/test-units.mjs"`
Expected: FAIL — cannot find module `seating.ts`.

- [ ] **Step 3: Implement**

`types.ts`: `Seat` gets `bot?: BotLevel; // an NPC seat: always connected and ready`; `Room` gets `hostCrew: Crew; // which crew the host flies (the guest flies the other)`.

`seating.ts`:

```ts
import type { BotLevel, Crew, PlayerId } from "@skyteam/shared";
import type { Room, Seat } from "./types";

/** Which player flies which seat. The host flies `hostCrew` (default Pilot). */
export function seatCrews(room: Room): { pilotId: PlayerId; copilotId: PlayerId } {
  const host = room.seats.find((s) => s.role === "host")!.playerId;
  const guest = room.seats.find((s) => s.role === "guest")!.playerId;
  return (room.hostCrew ?? "pilot") === "pilot" ? { pilotId: host, copilotId: guest } : { pilotId: guest, copilotId: host };
}

/** The crew a seated player flies (null for observers or an unfilled seat). */
export function crewOf(room: Room, playerId: PlayerId): Crew | null {
  if (room.seats.length < 2 || !room.seats.some((s) => s.playerId === playerId)) return null;
  return seatCrews(room).pilotId === playerId ? "pilot" : "copilot";
}

/** The room's NPC seat, if any. */
export function botSeat(room: Room): (Seat & { bot: BotLevel }) | null {
  return (room.seats.find((s) => s.bot) as (Seat & { bot: BotLevel }) | undefined) ?? null;
}

/** Every *human* seat but `keepId` must ready up again (after a setup change,
 *  or everyone after Exit to lobby); a bot seat is always ready. */
export function unreadyOthers(seats: Seat[], keepId: PlayerId | null): Seat[] {
  return seats.map((s) => (s.playerId === keepId || s.bot ? s : { ...s, ready: false }));
}
```

`rooms.ts`: `createRoom` sets `hostCrew: "pilot"` in the new room; add

```ts
/** A solo room: the caller (host) flies `crew`; a bot at `level` flies the
 *  other seat and is always connected and ready. */
export async function createSoloRoom(hostPlayerId: string, crew: Crew, level: BotLevel): Promise<Room> {
  const room = await createRoom(hostPlayerId);
  room.hostCrew = crew;
  room.seats.push({ playerId: `bot:${nanoid()}`, role: "guest", ready: true, connected: true, bot: level });
  await saveRoom(room);
  return room;
}
```

`store.ts` `getRoom`: add `room.hostCrew ??= "pilot"; // rooms saved before seats chose crews`.

`socket.ts`:
- `onStart` and `onReset`: replace the two `room.seats.find(...)` lines with `const { pilotId, copilotId } = seatCrews(room);` (delete the "Pilot is the host" comment).
- `onSetup`: replace the `for (const seat …) seat.ready = false` loop with `room.seats = unreadyOthers(room.seats, playerId);`.
- `onExit`: replace `for (const s of room.seats) s.ready = false;` with `room.seats = unreadyOthers(room.seats, null);`, and the notice's `seat.role === "host" ? "Pilot" : "Co-Pilot"` with `crewOf(room, playerId) === "pilot" ? "Pilot" : "Co-Pilot"` (computed before the game is cleared).

`snapshot.ts`: seats map adds `...(s.bot ? { bot: s.bot } : {})`; the snapshot adds `hostCrew: room.hostCrew ?? "pilot"`.

`protocol.ts` (shared): `SeatView` gets `bot?: BotLevel;`, `RoomSnapshot` gets `hostCrew: Crew;` (import the types). The client tutorial sandbox's `snapshotFor` (`packages/client/src/tutorials/useSandbox.ts`) builds a `RoomSnapshot` — add `hostCrew: "pilot"` there.

Client:
- `Seats.tsx`: label each seat with the crew it flies — `const crew = (s.role === "host") === (snapshot.hostCrew === "pilot") ? "Pilot" : "Co-Pilot";` — rendered as `{crew}: ` before the name; a bot seat shows `🤖 {BOT_LEVEL_LABELS[s.bot]}` instead of the id slice.
- `Cockpit.tsx:228`: the reconnect note names the crew from the game, not the role: `awaited.playerId === game.pilotId ? "Pilot" : "Co-Pilot"`.

- [ ] **Step 4: Run** `docker.exe compose -f docker-compose.dev.yml exec -T client sh -c "npm run typecheck && npm test"` → PASS; restart the server container and run the E2E → `ALL CHECKS PASSED` (multiplayer unchanged).
- [ ] **Step 5: Commit** — `"Make seat crews explicit and allow a bot seat"`.

---

### Task 2: The NPC scheduler

**Files:** `packages/server/src/seating.ts` (`npcShouldAct`), `npc.ts` (create), `socket.ts` (extract `applyCommand`; call the scheduler), `env.ts`; Test: `scripts/test-units.mjs` section 5.

**Interfaces:**
- Consumes: `actorFor`, `chooseMove`, `redactGameStateFor`, `seatCrews`, `botSeat`, `Rand`.
- Produces:
  - `npcShouldAct(room: Room): { botId: PlayerId; crew: Crew; level: BotLevel } | null`.
  - `applyCommand(io: IOServer, room: Room, playerId: PlayerId, command: GameCommand): Promise<string | null>` — today's `onCommand` body after parsing and the seat check; resolves to an error message, or null on success.
  - `scheduleNpc(io: IOServer, roomId: string): void` — idempotent per room; `cancelNpc(roomId: string): void`.
  - `broadcastState` and `type IOServer` exported from `socket.ts`.

- [ ] **Step 1: Write the failing test** (append inside section 5; add `npcShouldAct` to the seating import)

```js
  const { newGame, mulberry32 } = await import("../packages/shared/src/index.ts");
  const g = newGame(DEFAULT_SETUP, "bot:1", "H", mulberry32(5), 0); // bot flies Pilot; the Pilot leads round 1
  const playing = { ...solo, hostCrew: "copilot", status: "in_progress", game: g };
  check("bot acts when the game waits on its crew", npcShouldAct(playing)?.crew === "pilot");
  check("…not when it waits on the human", npcShouldAct({ ...playing, game: { ...g, turn: "copilot" } }) === null);
  check("…not outside an in-progress game", npcShouldAct({ ...playing, status: "finished" }) === null);
  check("…not in rooms without a bot", npcShouldAct({ ...playing, seats }) === null);
  check("…not while a Real-Time clock is paused (every action is refused then)", npcShouldAct({ ...playing, game: { ...g, timerRemainingMs: 30000 } }) === null);
```

- [ ] **Step 2: Run** → FAIL (`npcShouldAct` not exported).

- [ ] **Step 3: Implement**

`seating.ts` (add `actorFor` to the shared import):

```ts
/** Whether the game is waiting on the room's bot right now, and as which crew.
 *  Never while a Real-Time clock is paused: every player action is refused then. */
export function npcShouldAct(room: Room): { botId: PlayerId; crew: Crew; level: BotLevel } | null {
  const bot = botSeat(room);
  if (!bot || room.status !== "in_progress" || !room.game || room.game.timerRemainingMs !== null) return null;
  const crew = crewOf(room, bot.playerId);
  return crew && actorFor(room.game) === crew ? { botId: bot.playerId, crew, level: bot.bot } : null;
}
```

`env.ts`: `NPC_DELAY_MS: Number(process.env.NPC_DELAY_MS ?? 900),`.

`npc.ts`:

```ts
import { randomInt } from "node:crypto";
import { chooseMove, redactGameStateFor, type Rand } from "@skyteam/shared";
import { env } from "./env";
import { npcShouldAct } from "./seating";
import { applyCommand, broadcastState, type IOServer } from "./socket";
import { getRoom, saveRoom } from "./store";

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
        // Should never happen: a die that fits nowhere is discarded by the rules.
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

/** Drop a pending bot action (the game was exited or reset). */
export function cancelNpc(roomId: string): void {
  const t = timers.get(roomId);
  if (t) clearTimeout(t);
  timers.delete(roomId);
}
```

`socket.ts`:
- Export `type IOServer` and `broadcastState`.
- Extract `applyCommand(io, room, playerId, command)`: everything in `onCommand` from `const rcmd = withEntropy(command, serverDice);` to the end, unchanged in order (the Real-Time "too late" check stays between `withEntropy` and `reduce`), returning `"Time's up."` / the `GameRuleError` message / `"Command rejected."` instead of acking, and `null` on success. `onCommand` keeps parsing, the room/status/seat checks, then `const error = await applyCommand(io, room, playerId, parsed.data.command); ack(error ? { ok: false, error } : { ok: true });`.
- Call `scheduleNpc(io, room.id)` at the end of `applyCommand` (success), `onStart`, `onReset`, `onJoin` (covers a server restart) and `onTimeUp` (a time-up starts the next round with no command). Call `cancelNpc(room.id)` in `onExit` and at the start of `onReset`.
- `npc.ts` and `socket.ts` import each other; that's safe in ESM because each only calls the other's functions at runtime, never during module initialisation — keep it that way (no top-level calls across the pair).

- [ ] **Step 4: Run** `npm run typecheck && npm test` → PASS; E2E → `ALL CHECKS PASSED` (multiplayer unchanged).
- [ ] **Step 5: Commit** — `"Add the NPC scheduler"`.

---

### Task 3: Solo rooms over HTTP, and the landing page

**Files:** `packages/shared/src/protocol.ts` (`SoloRoomRequest`), `packages/server/src/http.ts`, `packages/client/src/api.ts`, `App.tsx`, `styles.css`, `README.md`; Test: `scripts/validate.mjs` new section "9) Solo game vs the bot".

**Interfaces:**
- Consumes: `createSoloRoom`, `BOT_LEVELS`, `BOT_LEVEL_LABELS`.
- Produces: `SoloRoomRequest` (zod, in shared — the server has no direct `zod` dependency); `POST /rooms` accepts `{ token?, solo?: { crew: "pilot" | "copilot"; level: BotLevel } }`; client `createRoom(solo?: { crew: Crew; level: BotLevel })`.

- [ ] **Step 1: Write the failing E2E** — append to `scripts/validate.mjs` before its summary, using its existing helpers (`post`, `connect`, `waitFor`, `emit`, `check`; check their exact names and signatures in the file first):

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
  const ackS = await emit(h, "game:command", { commandId: "s1", command: { type: "placeDie", dieId: myDie.id, target: { kind: "axis" } } });
  check("we can answer", ackS.ok === true);
  check("…and the bot replies", !!(await waitFor(h, "game:event", (m) => m.game.turn === "copilot" && m.byPlayerId.startsWith("bot:"), 8000)));
  // Rejoin (as after a server restart): the bot keeps going when it's its turn.
  h.close();
  const h2 = connect();
  await waitFor(h2, "connect");
  await emit(h2, "room:join", { roomId: soloRoom.roomId, token: soloRoom.token });
  const back = await waitFor(h2, "room:state");
  check("rejoining a solo game resyncs it", back.status === "in_progress" && back.game?.copilotId === back.you.playerId);
  const spectator = await post(`/rooms/${soloRoom.inviteCode}/join`);
  const sp = connect();
  await waitFor(sp, "connect");
  await emit(sp, "room:join", { roomId: spectator.roomId, token: spectator.token });
  check("an invite link to a solo room makes an observer", (await waitFor(sp, "room:state")).you.kind === "observer");
  h2.close(); sp.close();
```

- [ ] **Step 2: Run** the E2E → FAIL (`solo` ignored: no bot seat).

- [ ] **Step 3: Implement**

`protocol.ts` (shared):

```ts
/** Body of a solo-room request: the seat the player flies and the bot's level. */
export const SoloRoomRequest = z.object({ crew: z.enum(["pilot", "copilot"]), level: z.enum(BOT_LEVELS) });
```

`http.ts`:

```ts
  // Create a room; the caller becomes the host. With `solo`, a bot takes the other seat.
  app.post("/rooms", async (req, res) => {
    const me = resolveIdentity(req.body?.token);
    const solo = SoloRoomRequest.safeParse(req.body?.solo);
    const room = solo.success ? await createSoloRoom(me.playerId, solo.data.crew, solo.data.level) : await createRoom(me.playerId);
    res.json({ roomId: room.id, inviteCode: room.inviteCode, token: me.token });
  });
```

Client:
- `api.ts`: `createRoom(solo?: { crew: Crew; level: BotLevel })` posts `{ token, ...(solo ? { solo } : {}) }`.
- `App.tsx` landing, between "Create a room" and "How to play": a "Play solo" panel — seat choice (Pilot / Co-Pilot), difficulty choice (Cadet — "learning the ropes"; Navigator — "steady and sensible"; Aviator — "plans every die"), and a "Play solo" button that calls `createRoom({ crew, level })` and then follows the same flow as `onCreate`. Until Phase 3, Cadet and Aviator play like Navigator: show "(soon)" after their descriptions. Use real radio inputs with labels, styled like the lobby's module checkboxes.
- `App.tsx`: don't render the invite box when a seat is a bot (`snapshot.seats.some((s) => s.bot)`).

- [ ] **Step 4: Run** the E2E → PASS. Browser check (Playwright against the dev stack, as the earlier tutorial checks did): start a solo game as Pilot and as Co-Pilot at 1280 and 390 px; the bot moves after ~1 s; its dice stay face-down; a Reroll offered to it and a Working Together offer are answered on their own; Exit to lobby leaves the bot ready.
- [ ] **Step 5:** README "Running it": solo play. **Commit** — `"Add solo play against an NPC"`.

---

## Self-review notes

- The player-picks-seat requirement → `hostCrew` (Task 1) + landing UI (Task 3). The bot takes the other seat by construction.
- Difficulty names come from Phase 1 (`BOT_LEVEL_LABELS`); real differences arrive in Phase 3.
- Fairness: the scheduler passes `redactGameStateFor(game, botId)`; the E2E checks the bot's dice stay hidden from the human.
- Prompts the bot must answer (reroll, swap, Intern token, Traffic die) are all covered by `actorFor`, so the scheduler needs no special cases. Real-Time time-ups and a paused clock are handled explicitly (Task 2).
