// @vitest-environment jsdom
// The cockpit, driven the way a player drives it: every tutorial is played to
// its end by tapping dice, Coffee and panel spaces (not by sending commands),
// on the trimmed tutorial board and on the full board. Each step's solution
// must come out of the UI as a command the rules (and the strict tutorials) accept.
import "../support/dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import {
  DEFAULT_SETUP,
  SCENARIO_TEMPLATES,
  mulberry32,
  newGame,
  quickMove,
  actorFor,
  applyIntent,
  settle,
  randDice,
  type Crew,
  type GameCommand,
  type GameState,
  type RoomSnapshot,
} from "@skyteam/shared";
import { Cockpit } from "../../packages/client/src/components/Cockpit";
import { BASICS, TUTORIALS } from "../../packages/client/src/tutorials/index";
import { COPILOT_ID, PILOT_ID, scriptedDice } from "../../packages/client/src/tutorials/engine";
import { advance, initSession, play, skip } from "../../packages/client/src/tutorials/session";
import type { Tutorial } from "../../packages/client/src/tutorials/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The room as one crew (or a spectator) sees it. */
export function snapshotOf(game: GameState, as: Crew | "spectator", extra: Partial<RoomSnapshot> = {}): RoomSnapshot {
  const you = as === "pilot" ? PILOT_ID : as === "copilot" ? COPILOT_ID : "someone-else";
  return {
    roomId: "r",
    inviteCode: "",
    status: game.outcome ? "finished" : "in_progress",
    hostPlayerId: PILOT_ID,
    seats: [
      { playerId: PILOT_ID, role: "host", ready: true, connection: "connected" },
      { playerId: COPILOT_ID, role: "guest", ready: true, connection: "connected" },
    ],
    hostCrew: "pilot",
    observerCount: 0,
    setup: DEFAULT_SETUP,
    version: 0,
    game,
    notice: null,
    chat: [],
    debrief: null,
    you: as === "spectator" ? { playerId: you, kind: "observer" } : { playerId: you, kind: "player", role: as === "pilot" ? "host" : "guest" },
    serverTime: Date.now(),
    ...extra,
  };
}

/** Same placement target, the way the board and the scripts may spell it. */
function sameTarget(a: Record<string, unknown>, b: Record<string, unknown>, crew: Crew): boolean {
  return a.kind === b.kind && (a.side ?? crew) === (b.side ?? crew) && (a.slot ?? 0) === (b.slot ?? 0) && a.space === b.space;
}

/**
 * Play `command` as `crew` through the cockpit's controls; returns what the
 * cockpit sent. Fails if a control the move needs is missing or disabled.
 */
function playThroughUI(game: GameState, crew: Crew, command: GameCommand, show?: Tutorial["show"]): GameCommand {
  const sent: GameCommand[] = [];
  const { container } = render(<Cockpit snapshot={snapshotOf(game, crew)} onCommand={(c) => sent.push(c)} show={show} clockOffset={0} />);
  const ui = within(container);
  const dice = () => [...container.querySelectorAll<HTMLButtonElement>(`.hand .dice button.die.${crew}`)];
  const die = (id: number) => {
    const el = dice()[game.dice[crew].findIndex((d) => d.id === id)];
    expect(el, `die ${id}`).toBeTruthy();
    return el;
  };
  const tap = (el: Element) => {
    fireEvent.pointerDown(el, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
  };
  const click = (el: Element) => {
    expect((el as HTMLButtonElement).disabled, (el as HTMLElement).textContent ?? "").toBe(false);
    fireEvent.click(el);
  };
  const slot = (target: Record<string, unknown>) => {
    const el = [...container.querySelectorAll<HTMLButtonElement>(".slot[data-target]")].find((s) =>
      sameTarget(JSON.parse(s.dataset.target!), target, crew),
    );
    expect(el, `space ${JSON.stringify(target)}`).toBeTruthy();
    return el!;
  };

  switch (command.type) {
    case "placeDie": {
      tap(die(command.dieId));
      const d = command.coffeeDelta ?? 0;
      for (let i = 0; i < Math.abs(d); i++) click(ui.getByRole("button", { name: d > 0 ? "+1" : "−1" }));
      click(slot(command.target));
      break;
    }
    case "placeIntern":
    case "placeTraffic":
      click(slot(command.target)); // the held token is selected already
      break;
    case "reroll":
      if (game.pendingReroll !== crew) click(ui.getByRole("button", { name: /^Reroll ×/ }));
      for (const id of command.dieIds) click(die(id));
      click(ui.getByRole("button", { name: /^(Reroll \d+|Skip)$/ }));
      break;
    case "adapt":
      click(ui.getByRole("button", { name: "Flip a die" }));
      click(die(command.dieId));
      break;
    case "anticipate":
      click(ui.getByRole("button", { name: "Reroll a die" }));
      click(die(command.dieId));
      break;
    case "swap":
      if (!game.pendingSwap) click(ui.getByRole("button", { name: "Swap a die" }));
      click(die(command.dieId));
      break;
    default:
      throw new Error(`no UI for ${command.type}`);
  }
  cleanup();
  expect(sent).toHaveLength(1);
  return sent[0];
}

/** Walk a tutorial step by step, playing each solution through the cockpit. */
function walk(tutorial: Tutorial, show: Tutorial["show"] | undefined) {
  const dice = scriptedDice(tutorial.script);
  let sess = initSession(tutorial, dice);
  let moves = 0;
  for (let i = 0; i < tutorial.steps.length; i++) {
    const step = tutorial.steps[i];
    expect(sess.stepIndex).toBe(i);
    if (step.info) {
      sess = skip(sess, tutorial, dice);
      continue;
    }
    for (const solution of step.solution) {
      const m = solution(sess.game);
      if (m === "timeUp") {
        sess = play(sess, tutorial, () => "timeUp", dice);
      } else {
        const sent = playThroughUI(sess.game, m.crew, m.command, show);
        sess = play(sess, tutorial, () => ({ crew: m.crew, command: sent }), dice);
        moves++;
      }
      expect(sess.error, `${tutorial.id} step ${i + 1}: ${step.text}`).toBe(null);
    }
    expect(sess.done, `${tutorial.id} step ${i + 1} done`).toBe(true);
    sess = advance(sess, tutorial, dice);
  }
  expect(sess.stepIndex).toBe(tutorial.steps.length);
  return moves;
}

const ALL = [BASICS, ...Object.values(TUTORIALS)];

describe("every tutorial can be played to the end through the cockpit", () => {
  for (const t of ALL) {
    test(`${t.id} (tutorial board)`, () => {
      expect(walk(t, t.show)).toBeGreaterThan(0);
    });
    test(`${t.id} (full board)`, () => {
      expect(walk(t, undefined)).toBeGreaterThan(0);
    });
  }
});

// --- views and controls the tutorials don't reach ------------------------------------

/** A game dealt from `setup` (round 1 rolled). */
function dealt(modules: string[] = [], abilities: string[] = [], seed = 1): GameState {
  const r = mulberry32(seed);
  const g = newGame({ scenarioId: "YUL", modules, abilities } as never, PILOT_ID, COPILOT_ID, r, 0);
  return settle(g, randDice(r), () => 0);
}

/** Play `n` quick moves (both crews). */
function advanceGame(g: GameState, n: number, seed = 3): GameState {
  const rand = mulberry32(seed);
  const r = rand;
  for (let i = 0; i < n && !g.outcome; i++) {
    const crew = actorFor(g)!;
    const move = quickMove(g, crew, rand);
    if (!move) break;
    g = applyIntent(g, move, crew === "pilot" ? PILOT_ID : COPILOT_ID, r, () => 0);
  }
  return g;
}

describe("cockpit views", () => {
  test("a spectator sees the board, no dice tray", () => {
    const { container, getByText } = render(<Cockpit snapshot={snapshotOf(dealt(), "spectator")} onCommand={() => {}} />);
    expect(getByText("Spectating the approach.")).toBeTruthy();
    expect(container.querySelector(".hand")).toBe(null);
  });

  test("off-turn: dice locked, the callout names who's flying (by name when set)", () => {
    const g = dealt();
    const waiting = g.turn === "pilot" ? "copilot" : "pilot";
    const snap = snapshotOf(g, waiting);
    snap.seats = snap.seats.map((s) => (s.playerId === (g.turn === "pilot" ? PILOT_ID : COPILOT_ID) ? { ...s, name: "Maverick" } : s));
    const { container, getByText } = render(<Cockpit snapshot={snap} onCommand={() => {}} />);
    expect(getByText("Silence. Waiting for Maverick…")).toBeTruthy();
    expect([...container.querySelectorAll<HTMLButtonElement>(".hand .dice button.die")].every((b) => b.disabled)).toBe(true);
  });

  test("a finished game says how it ended", () => {
    let g = dealt();
    g = advanceGame(g, 500);
    expect(g.outcome).toBeTruthy();
    const { container } = render(<Cockpit snapshot={snapshotOf(g, "pilot")} onCommand={() => {}} />);
    const callout = container.querySelector(".callout")!;
    expect(callout.className).toMatch(g.outcome!.result === "won" ? /good/ : /bad/);
    expect(callout.textContent).toBe(g.outcome!.result === "won" ? "Smooth landing — the passengers applaud." : g.outcome!.reason);
  });

  test("Coffee: +1/−1 change the value a die places as, within 1–6 and the Coffee held", () => {
    let g = dealt();
    g = { ...g, coffee: 2 };
    const crew = g.turn;
    const sent: GameCommand[] = [];
    const { container, getByRole, getByText } = render(<Cockpit snapshot={snapshotOf(g, crew)} onCommand={(c) => sent.push(c)} />);
    const die = container.querySelectorAll<HTMLButtonElement>(`.hand .dice button.die.${crew}`)[0];
    const value = g.dice[crew][0].value!;
    fireEvent.pointerDown(die, { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window);
    const plus = getByRole("button", { name: "+1" }) as HTMLButtonElement;
    const minus = getByRole("button", { name: "−1" }) as HTMLButtonElement;
    if (value < 6) {
      fireEvent.click(plus);
      expect(getByText(new RegExp(`placing as ${value + 1}`))).toBeTruthy();
      fireEvent.click(minus);
    }
    if (value > 1) {
      fireEvent.click(minus);
      expect(getByText(new RegExp(`placing as ${value - 1}`))).toBeTruthy();
    }
    // The Axis takes any value: place there.
    fireEvent.click(container.querySelector(`.slot[data-target='${JSON.stringify({ kind: "axis", side: crew })}']`)!);
    expect(sent[0]).toMatchObject({ type: "placeDie", dieId: g.dice[crew][0].id, target: { kind: "axis", side: crew } });
  });

  test("reroll: start, pick, cancel; the other crew waits", () => {
    const g = { ...dealt(), rerollTokens: 1 };
    const crew = g.turn;
    const { getByRole, getByText, queryByRole } = render(<Cockpit snapshot={snapshotOf(g, crew)} onCommand={() => {}} />);
    fireEvent.click(getByRole("button", { name: /^Reroll ×1/ }));
    expect(getByText("Reroll — pick the dice to reroll, then Confirm.")).toBeTruthy();
    expect((getByRole("button", { name: "Reroll 0" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(queryByRole("button", { name: "Cancel" })).toBe(null);
    cleanup();
    const other = crew === "pilot" ? "copilot" : "pilot";
    const pending = { ...g, pendingReroll: other as Crew };
    const { getAllByText } = render(<Cockpit snapshot={snapshotOf(pending, crew)} onCommand={() => {}} />);
    expect(getAllByText(/waiting for the (Co-)?Pilot to (pick dice|reroll)/i).length).toBeGreaterThan(0);
  });

  test("drag and drop: a die dropped on an open space is placed; dropped elsewhere it returns", () => {
    const g = dealt();
    const crew = g.turn;
    const sent: GameCommand[] = [];
    const { container } = render(<Cockpit snapshot={snapshotOf(g, crew)} onCommand={(c) => sent.push(c)} />);
    vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const axis = container.querySelector<HTMLElement>(`.slot[data-target='${JSON.stringify({ kind: "axis", side: crew })}']`)!;
    const die = () => container.querySelectorAll<HTMLButtonElement>(`.hand .dice button.die.${crew}`)[0];

    // Dropped nowhere: nothing is sent.
    document.elementFromPoint = () => document.body;
    fireEvent.pointerDown(die(), { clientX: 300, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 340, clientY: 340 });
    expect(document.querySelector(".drag-die")).toBeTruthy();
    fireEvent.pointerUp(window, { clientX: 340, clientY: 340 });
    expect(sent).toHaveLength(0);

    // Over the open Axis space (near the top edge: the page scrolls toward it).
    document.elementFromPoint = () => axis;
    fireEvent.pointerDown(die(), { clientX: 300, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 30 }); // the drag begins: open spaces light up
    fireEvent.pointerMove(window, { clientX: 300, clientY: 20 });
    expect(document.querySelector(".drop-ring")).toBeTruthy();
    fireEvent.pointerUp(window, { clientX: 300, clientY: 20 });
    expect(sent).toEqual([{ type: "placeDie", dieId: g.dice[crew][0].id, target: { kind: "axis", side: crew }, coffeeDelta: undefined }]);
  });

  test("every card's board renders, turn limits marked on its approach track", () => {
    let marked = 0;
    for (const t of SCENARIO_TEMPLATES) {
      const id = t.id === "green-YUL" ? "YUL" : t.id;
      const r = mulberry32(2);
      const g = settle(newGame({ scenarioId: id, modules: [], abilities: [] }, PILOT_ID, COPILOT_ID, r, 0), randDice(r), () => 0);
      const { container } = render(<Cockpit snapshot={snapshotOf(g, g.turn)} onCommand={() => {}} />);
      expect(container.querySelector(".board"), id).toBeTruthy();
      marked += container.querySelectorAll(".turn-marks").length;
      cleanup();
    }
    expect(marked).toBeGreaterThan(0);
  });

  test("every module's panel renders on the full board (and Real-Time shows its clock)", () => {
    for (const modules of [["kerosene"], ["keroseneLeak"], ["iceBrakes"], ["intern"], ["wind"], ["realTime"]]) {
      const g = dealt(modules);
      const { container } = render(<Cockpit snapshot={snapshotOf(g, g.turn)} onCommand={() => {}} />);
      expect(container.querySelector(".board"), modules[0]).toBeTruthy();
      cleanup();
    }
  });

  test("Real-Time: a disconnected seat shows who the paused clock waits for", () => {
    let g = dealt(["realTime"]);
    g = { ...g, timerEndsAt: null, timerRemainingMs: 30_000 };
    const snap = snapshotOf(g, "pilot");
    snap.seats = snap.seats.map((s) => (s.playerId === COPILOT_ID ? { ...s, connection: "disconnected" } : s));
    const { container } = render(<Cockpit snapshot={snap} onCommand={() => {}} />);
    expect(container.textContent).toMatch(/waiting for the Co-Pilot to reconnect/);
  });
});
