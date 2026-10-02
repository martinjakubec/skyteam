import { GameRuleError, type Crew, type GameCommand, type GameState } from "@skyteam/shared";
import { apply, scriptedDice, type DiceCursor, type ScriptedDice } from "./engine";
import type { Move, Tutorial } from "./types";

/**
 * A tutorial in progress, as plain data: the game, the current step and where
 * it began, and whether it has just been completed (shown briefly before the
 * next step starts). Every change goes through the functions below, which
 * never throw, so the modal can't get stuck or rewind.
 */
export interface Session {
  game: GameState;
  /** The current step; `steps.length` = free play. */
  stepIndex: number;
  /** The game when the current step started (after its automatic moves). */
  before: GameState;
  /** The scripted dice used up by then, so Retry step replays the same rolls. */
  diceAt: DiceCursor;
  /** Which of the step's solution moves have been made. */
  played: number[];
  /** The current step is complete and waits to be advanced. */
  done: boolean;
  /** Why the last move was refused, if it was. */
  error: string | null;
}

/** A fresh start: the tutorial's setup, entering step 1 (with its automatic moves). */
export function initSession(tutorial: Tutorial, dice: ScriptedDice = scriptedDice(tutorial.script)): Session {
  return enter(tutorial.setup(), 0, tutorial, dice);
}

/** Play a move on the latest board; a refused one leaves it and says why. In
 *  a strict tutorial only the current step's moves are accepted. */
export function play(sess: Session, tutorial: Tutorial, move: Move, dice: ScriptedDice): Session {
  const step = tutorial.steps[sess.stepIndex];
  let game: GameState;
  let made = -1;
  try {
    const m = move(sess.game);
    made = solutionIndex(sess, step?.solution ?? [], m);
    if (tutorial.strict && step) {
      if (step.info) return { ...sess, error: `Read this first, then press Got it. ${step.text}` };
      if (made < 0) return { ...sess, error: `Not that one. ${step.text}` };
    }
    game = apply(sess.game, () => m, dice);
  } catch (e) {
    return { ...sess, error: e instanceof GameRuleError ? e.message : "That move isn't allowed." };
  }
  const done = sess.done || (!!step && !step.info && step.done(game, sess.before));
  const played = made < 0 ? sess.played : [...sess.played, made];
  return { ...sess, game, done, played, error: null };
}

/** Retry step: back to the board as the current step began. */
export function retry(sess: Session, tutorial: Tutorial): Session {
  const step = tutorial.steps[sess.stepIndex];
  const done = !!step && !step.info && step.done(sess.before, sess.before);
  return { ...sess, game: sess.before, done, played: [], error: null };
}

/** Start the step after a completed one (a no-op unless the current one is done). */
export function advance(sess: Session, tutorial: Tutorial, dice: ScriptedDice): Session {
  return sess.done ? enter(sess.game, sess.stepIndex + 1, tutorial, dice) : sess;
}

/**
 * Next: move on whether or not the step was done. The step's own moves are
 * played for the player when they still fit, so the next step's board makes
 * sense; otherwise the board stays as it is.
 */
export function skip(sess: Session, tutorial: Tutorial, dice: ScriptedDice): Session {
  if (sess.stepIndex >= tutorial.steps.length) return sess;
  let game = sess.game;
  if (!sess.done) {
    try {
      const rest = tutorial.steps[sess.stepIndex].solution.filter((_, i) => !sess.played.includes(i));
      for (const m of rest) game = apply(game, m, dice);
    } catch {
      game = sess.game;
    }
  }
  return enter(game, sess.stepIndex + 1, tutorial, dice);
}

/** Enter step `i` on `game`, playing its automatic moves when they fit. A
 *  step that's already complete on entry (the board satisfies it) is done. */
function enter(game: GameState, i: number, tutorial: Tutorial, dice: ScriptedDice): Session {
  let s = game;
  try {
    for (const m of tutorial.steps[i]?.auto ?? []) s = apply(s, m, dice);
  } catch {
    s = game;
  }
  const step = tutorial.steps[i];
  return { game: s, stepIndex: i, before: s, diceAt: dice.used(), played: [], done: !!step && !step.info && step.done(s, s), error: null };
}

/** The solution move (not yet made) that `m` is, or -1. Moves are compared by
 *  crew, die value and target, so which of two equal dice is used, or which
 *  free Radio / Concentration space, doesn't matter. */
function solutionIndex(sess: Session, solution: Move[], m: ReturnType<Move>): number {
  const key = (r: ReturnType<Move>) => (r === "timeUp" ? r : moveKey(sess.game, r.crew, r.command));
  const want = key(m);
  return solution.findIndex((sol, i) => {
    if (sess.played.includes(i)) return false;
    try {
      return key(sol(sess.game)) === want;
    } catch {
      return false; // the move no longer fits this board
    }
  });
}

function moveKey(game: GameState, crew: Crew, command: GameCommand): string {
  const value = (id: number) => game.dice[crew].find((d) => d.id === id)?.value;
  const c: Record<string, unknown> = { ...command, crew };
  if ("dieId" in command) c.dieId = value(command.dieId);
  if ("dieIds" in command) c.dieIds = command.dieIds.map(value).sort();
  if ("target" in command && (command.target.kind === "radio" || command.target.kind === "concentration")) {
    const { slot: _slot, ...rest } = command.target;
    c.target = rest;
  }
  return canonical(c);
}

/** JSON with sorted keys (the board and the scripts build targets in different key orders). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
