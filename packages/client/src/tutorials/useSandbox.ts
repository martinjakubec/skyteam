import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SETUP, type GameCommand, type GameState, type RoomSnapshot } from "@skyteam/shared";
import { COPILOT_ID, PILOT_ID, actingCrew, scriptedDice, timeUp } from "./engine";
import { advance, initSession, play, retry, skip, type Session } from "./session";
import type { Move, Tutorial } from "./types";

/** How long a completed step shows as done before the next one starts. */
const STEP_PAUSE_MS = 700;

/** A view of the sandbox game as the crew who must act now (hot-seat). */
function snapshotFor(game: GameState): RoomSnapshot {
  const crew = actingCrew(game);
  return {
    roomId: "tutorial",
    inviteCode: "",
    status: game.outcome ? "finished" : "in_progress",
    hostPlayerId: PILOT_ID,
    seats: [
      { playerId: PILOT_ID, role: "host", ready: true, connection: "connected" },
      { playerId: COPILOT_ID, role: "guest", ready: true, connection: "connected" },
    ],
    observerCount: 0,
    setup: DEFAULT_SETUP,
    version: 0,
    game,
    notice: null,
    you: { playerId: crew === "pilot" ? PILOT_ID : COPILOT_ID, kind: "player", role: crew === "pilot" ? "host" : "guest" },
    serverTime: Date.now(),
  };
}

/**
 * Runs one tutorial locally: real rules, scripted dice, both crews, step
 * tracking. The session lives in a ref as well as in state, so a move always
 * applies to the latest board (a drag that started before a time-up, say),
 * and the step-advance timer is tracked so Reset / Next / unmount cancel it.
 */
export function useSandbox(tutorial: Tutorial) {
  const dice = useRef(scriptedDice(tutorial.script));
  const [sess, setSess] = useState<Session>(() => initSession(tutorial, dice.current));
  const latest = useRef(sess);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped on Reset so the board remounts with no leftover selection. */
  const [resets, setResets] = useState(0);

  const cancelAdvance = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  // Every new session goes through here; a completed step (by a move, or
  // already complete on entry) moves on after a short pause.
  const commit = useCallback(
    (next: Session) => {
      latest.current = next;
      setSess(next);
      if (next.done && !timer.current) {
        timer.current = setTimeout(() => {
          timer.current = null;
          commit(advance(latest.current, tutorial, dice.current));
        }, STEP_PAUSE_MS);
      }
    },
    [tutorial],
  );

  const playMove = useCallback((move: Move) => commit(play(latest.current, tutorial, move, dice.current)), [tutorial, commit]);

  const send = useCallback((command: GameCommand) => playMove((s) => ({ crew: actingCrew(s), command })), [playMove]);
  const next = () => {
    cancelAdvance();
    commit(skip(latest.current, tutorial, dice.current));
  };
  const reset = () => {
    cancelAdvance();
    dice.current = scriptedDice(tutorial.script);
    commit(initSession(tutorial, dice.current));
    setResets((n) => n + 1);
  };
  const retryStep = () => {
    cancelAdvance();
    dice.current = scriptedDice(tutorial.script, latest.current.diceAt);
    commit(retry(latest.current, tutorial));
    setResets((n) => n + 1);
  };
  useEffect(() => cancelAdvance, []);

  // Real-Time: the countdown runs on this machine's clock.
  const { game } = sess;
  const timerRunning = game.timerEndsAt !== null && game.phase === "placement";
  useEffect(() => {
    if (!timerRunning) return;
    const t = setTimeout(() => playMove(timeUp), Math.max(0, game.timerEndsAt! - Date.now()));
    return () => clearTimeout(t);
  }, [timerRunning, game.timerEndsAt, playMove]);

  return {
    snapshot: snapshotFor(game),
    step: tutorial.steps[sess.stepIndex] ?? null,
    /** The board has changed since the current step began. */
    canRetry: !!tutorial.steps[sess.stepIndex] && sess.game !== sess.before,
    stepIndex: sess.stepIndex,
    error: sess.error,
    flash: sess.done,
    resets,
    send,
    next,
    reset,
    retryStep,
    skipTime: () => playMove(timeUp),
    timerRunning,
  };
}
