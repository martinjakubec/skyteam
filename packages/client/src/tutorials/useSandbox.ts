import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SETUP, GameRuleError, type GameCommand, type GameState, type RoomSnapshot } from "@skyteam/shared";
import { COPILOT_ID, PILOT_ID, actingCrew, apply, scriptedDice, timeUp } from "./engine";
import type { Move, Tutorial } from "./types";

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

/** Runs one tutorial locally: real rules, scripted dice, both crews, step tracking. */
export function useSandbox(tutorial: Tutorial) {
  const dice = useRef(scriptedDice(tutorial.script));
  const [game, setGame] = useState(() => tutorial.setup());
  const [stepIndex, setStepIndex] = useState(0);
  const [before, setBefore] = useState<GameState>(game);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const step = tutorial.steps[stepIndex] ?? null;

  /** Start step `i` on `state`: play its automatic moves, remember where it began. */
  const enterStep = useCallback(
    (i: number, state: GameState) => {
      let s = state;
      for (const m of tutorial.steps[i]?.auto ?? []) s = apply(s, m, dice.current);
      setGame(s);
      setBefore(s);
      setStepIndex(i);
    },
    [tutorial],
  );

  const play = useCallback(
    (move: Move) => {
      setError(null);
      try {
        const s = apply(game, move, dice.current);
        setGame(s);
        if (step && !step.info && step.done(s, before)) {
          setFlash(true);
          setTimeout(() => {
            setFlash(false);
            enterStep(stepIndex + 1, s);
          }, 700);
        }
      } catch (e) {
        setError(e instanceof GameRuleError ? e.message : "That move isn't allowed.");
      }
    },
    [game, step, before, stepIndex, enterStep],
  );

  const send = useCallback((command: GameCommand) => play(() => ({ crew: actingCrew(game), command })), [play, game]);
  const next = () => enterStep(stepIndex + 1, game);
  const reset = () => {
    dice.current = scriptedDice(tutorial.script);
    setError(null);
    enterStep(0, tutorial.setup());
  };

  // Real-Time: the countdown runs on this machine's clock.
  const timerRunning = game.timerEndsAt !== null && game.phase === "placement";
  useEffect(() => {
    if (!timerRunning) return;
    const t = setTimeout(() => play(timeUp), Math.max(0, game.timerEndsAt! - Date.now()));
    return () => clearTimeout(t);
  }, [timerRunning, game.timerEndsAt, play]);

  return { snapshot: snapshotFor(game), step, stepIndex, error, flash, send, next, reset, skipTime: () => play(timeUp), timerRunning };
}
