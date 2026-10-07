# Between-rounds debrief (in-game chat + Ready countdown)

Date: 2026-10-07. Branch: `round-debrief` (from `lobby-chat`, which adds the
lobby flight log this builds on).

## Goal

The crew may talk between rounds and never while dice are being placed, as in
the board game. When a round ends and the game goes on, the next dice are held
back. The room enters a **debrief**: chat opens, and each player presses
**Ready**. When both are ready, a 3 · 2 · 1 countdown runs, the server deals the
next round's dice, and chat closes.

## Decisions (agreed with the user)

| Question | Decision |
|---|---|
| Solo games (bot seat) | Pause too. The bot is always ready, and there is no chat in solo games. |
| Which log | One flight log: the lobby conversation carries on, with the same 50-line cap. |
| Log during dice placement | Hidden: there is no log and no bubble until the next debrief. |
| Backing out of the countdown | Allowed: Unready ("Wait") cancels it. A seat disconnecting cancels it too. |

## Scope

- A debrief follows every round that ends without ending the game: all dice
  placed, or a Real-Time time-up.
- No debrief before round 1, which the lobby chat covers.
- No debrief after the final round, or after any loss or win (the game is over).
- The shared rules (reducer) do not change. At a round's end they already stop
  in phase `rolling` with the finished round's board intact; the server simply
  waits before issuing the roll.
- Self-play, the bot's search, tutorials and benchmarks keep using `settle`,
  which deals at once. Only the live server pauses.

## Server

### State

`Room.debrief: Debrief | null`, saved with the room and sent in every
`RoomSnapshot` as `debrief`:

```ts
interface Debrief {
  /** The round that just ended. */
  round: number;
  ready: Record<Crew, boolean>;
  /** When the 3-2-1 ends (server epoch ms), while it runs; else null. */
  countdownEndsAt: number | null;
}
```

- A room has a debrief exactly when `status === "in_progress"`, `game.phase ===
  "rolling"` and the game has no outcome.
- A bot seat's crew is always `ready: true`.
- `DEBRIEF_COUNTDOWN_MS = 3000` (shared). The countdown can be shortened for test
  servers through an env var, as Real-Time rounds are.

### Flow

- **Round ends** (`applyCommand` or `onTimeUp`). The server supplies Traffic
  dice as before, but holds back the round's roll when the game is in `rolling`.
  It opens `debrief = { round: game.round - 1, ready: <bot seat ready>,
  countdownEndsAt: null }` and broadcasts `room:state`.
- **`round:ready { ready: boolean }`**:
  - Only seated players may send it, and only during a debrief.
  - It sets the sender's crew.
  - Both ready and no countdown running: start it (`countdownEndsAt = now +
    DEBRIEF_COUNTDOWN_MS`) and arm a timer.
  - Either unready: clear the countdown and its timer.
  - Every change is broadcast.
- **Countdown ends.** The handler checks the countdown is still current (the same
  `countdownEndsAt`, still in a debrief). It then deals: `settle` with the
  server's dice and clock, `version += 1`, `debrief = null`. It broadcasts,
  syncs the Real-Time clock (which starts at the deal) and schedules the bot.
- **Disconnect during a debrief.** The seat's ready flag is cleared and any
  countdown is cancelled. When the player is back and both are ready again, a new
  countdown starts.
- **Server restart.** Timers are lost, but the debrief is saved. On (re)join, a
  saved `countdownEndsAt` is re-armed for the time left; if it has already
  passed, the deal happens at once. This mirrors `syncClock`.
- **Exit / Reset** clear the debrief and its timer.
- **Loading an older room.** A room saved mid-`rolling` without a debrief (which
  cannot happen today, because the deal was immediate) gets one when it loads,
  so it is never stuck.

### Chat

- `chat:send` is accepted in the lobby (`lobby`/`ready`) and during a debrief,
  including during the countdown, until the deal.
- Otherwise it is refused with "Chat opens between rounds."
- Spectators are still refused.
- `ChatMessage.round?: number` is set to the debrief's `round` for messages sent
  in a debrief. Lobby messages have none.

## Client

- **Debrief panel.** It takes the place of the dice tray's hand (all dice are
  spent) and shows:
  - "Round N complete — descending to X ft";
  - both crew with a ✓ when ready;
  - the button: **Ready for round N+1** / **Wait** (to unready);
  - a large **3 · 2 · 1** during the countdown, from `countdownEndsAt` with the
    clock offset.

  Spectators see the panel without the button.
- **Callout.** "Between rounds — talk it over, then press Ready."
  - Solo: "Between rounds — press Ready when you are."
  - Spectators: "Between rounds."
- **Flight log in the game.** Only during a debrief, and never in a solo game:
  - **Desktop** (>760px): beside the debrief panel in the tray, so the board
    doesn't move.
  - **Phone** (≤760px): the 💬 bubble with its unread dot, opening the
    full-screen log, exactly as in the lobby.
  - **Dividers**: the log shows "— after round N —" before the first line of each
    debrief's messages.
- **Unread** works as in the lobby: lines from the other player that haven't been
  on screen. History doesn't count as unread when the page loads.

## Tests (Vitest only)

Server (`tests/server.test.mjs` and a new `tests/server-debrief.test.mjs` if
it grows large):

- The round's end opens a debrief and does not deal.
- One Ready doesn't start the countdown; two do; the deal follows it.
- Unready cancels the countdown.
- Chat is open during the debrief (messages tagged with the round) and refused
  during play.
- A disconnect clears the seat's ready flag and cancels the countdown.
- In solo games the bot seat is ready, so the human's Ready starts the countdown.
- Real-Time: no clock during the debrief; the clock starts at the deal.
- Exit and Reset clear the debrief.
- A countdown saved before a restart is re-armed on rejoin.
- Spectators can't ready or chat.

Client (`tests/client/app.test.tsx` or a new `tests/client/debrief.test.tsx`):

- The debrief panel, the Ready / Wait toggle and both ready marks.
- The countdown digits.
- The flight log appears only during a debrief, with dividers.
- On phones, the bubble and its dot appear only during a debrief.
- No log in solo games.
- Spectators get no button.

Existing tests that play through rounds on a live server gain a "both ready"
step.

## Out of scope

- Chat after the game ends.
- Changing the bot (it never needs to ready; its seat is always ready).
- A configurable countdown length in the UI.
