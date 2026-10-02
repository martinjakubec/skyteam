import { GameRuleError, type Dice, type GameState } from "@skyteam/shared";
import { apply, scriptedDice } from "./engine";
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
  /** The current step is complete and waits to be advanced. */
  done: boolean;
  /** Why the last move was refused, if it was. */
  error: string | null;
}

/** A fresh start: the tutorial's setup, entering step 1 (with its automatic moves). */
export function initSession(tutorial: Tutorial, dice: Dice = scriptedDice(tutorial.script)): Session {
  return enter(tutorial.setup(), 0, tutorial, dice);
}

/** Play a move on the latest board; a refused one leaves it and says why. */
export function play(sess: Session, tutorial: Tutorial, move: Move, dice: Dice): Session {
  let game: GameState;
  try {
    game = apply(sess.game, move, dice);
  } catch (e) {
    return { ...sess, error: e instanceof GameRuleError ? e.message : "That move isn't allowed." };
  }
  const step = tutorial.steps[sess.stepIndex];
  const done = sess.done || (!!step && !step.info && step.done(game, sess.before));
  return { ...sess, game, done, error: null };
}

/** Start the step after a completed one (a no-op unless the current one is done). */
export function advance(sess: Session, tutorial: Tutorial, dice: Dice): Session {
  return sess.done ? enter(sess.game, sess.stepIndex + 1, tutorial, dice) : sess;
}

/**
 * Next: move on whether or not the step was done. The step's own moves are
 * played for the player when they still fit, so the next step's board makes
 * sense; otherwise the board stays as it is.
 */
export function skip(sess: Session, tutorial: Tutorial, dice: Dice): Session {
  if (sess.stepIndex >= tutorial.steps.length) return sess;
  let game = sess.game;
  if (!sess.done) {
    try {
      for (const m of tutorial.steps[sess.stepIndex].solution) game = apply(game, m, dice);
    } catch {
      game = sess.game;
    }
  }
  return enter(game, sess.stepIndex + 1, tutorial, dice);
}

/** Enter step `i` on `game`, playing its automatic moves when they fit. A
 *  step that's already complete on entry (the board satisfies it) is done. */
function enter(game: GameState, i: number, tutorial: Tutorial, dice: Dice): Session {
  let s = game;
  try {
    for (const m of tutorial.steps[i]?.auto ?? []) s = apply(s, m, dice);
  } catch {
    s = game;
  }
  const step = tutorial.steps[i];
  return { game: s, stepIndex: i, before: s, done: !!step && !step.info && step.done(s, s), error: null };
}
