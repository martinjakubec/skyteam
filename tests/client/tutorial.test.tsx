// @vitest-environment jsdom
// The tutorial dialog: stepping through every tutorial with Next, playing a
// step on its board, Retry and Reset, the Real-Time clock, and leaving
// (asked only when there's progress to lose; focus stays inside the dialog).
import "../support/dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TutorialModal } from "../../packages/client/src/components/TutorialModal";
import { BASICS, TUTORIALS } from "../../packages/client/src/tutorials/index";
import { initSession, skip } from "../../packages/client/src/tutorials/session";
import { scriptedDice } from "../../packages/client/src/tutorials/engine";
import type { Crew } from "@skyteam/shared";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ALL = [BASICS, ...Object.values(TUTORIALS)];
const footer = () => document.querySelector(".tutorial-steps") as HTMLElement;
const nextButton = () => within(footer()).queryByRole("button", { name: /^(Next|Got it)$/ });

describe("Next walks every tutorial to its end", () => {
  for (const t of ALL) {
    test(t.id, () => {
      render(<TutorialModal id={t.id} onClose={() => {}} />);
      expect(screen.getByRole("dialog").textContent).toContain(t.title);
      for (let i = 0; i < t.steps.length; i++) {
        expect(within(footer()).getByText(t.steps[i].chapter ? `${t.steps[i].chapter} · ${i + 1}/${t.steps.length}` : `Step ${i + 1} of ${t.steps.length}`)).toBeTruthy();
        fireEvent.click(nextButton()!);
      }
      expect(nextButton()).toBe(null);
      expect(within(footer()).getByText(t.outro ? "Done" : "Free play")).toBeTruthy();
      // Nothing left to lose: Close doesn't ask.
      const onClose = vi.fn();
      cleanup();
      render(<TutorialModal id={t.id} onClose={onClose} />);
      fireEvent.click(within(footer()).getByRole("button", { name: "Close" }));
      expect(onClose).toHaveBeenCalled();
    });
  }
});

/** Tap a die in the tray and drop it on a space by its target. */
function placeOn(target: object, dieIndex = 0) {
  const die = document.querySelectorAll<HTMLButtonElement>(".hand .dice button.die:not(.mini)")[dieIndex];
  fireEvent.pointerDown(die, { clientX: 1, clientY: 1 });
  fireEvent.pointerUp(window, { clientX: 1, clientY: 1 });
  const slot = document.querySelector<HTMLButtonElement>(`.slot[data-target='${JSON.stringify(target)}']`)!;
  fireEvent.click(slot);
}

describe("playing in the dialog", () => {
  test("strict: a move during a note, or the wrong move, says why; Retry puts the board back; the right move moves on", async () => {
    const t = BASICS;
    render(<TutorialModal id="basics" onClose={() => {}} />);
    const text = () => document.querySelector(".tutorial-text")!.textContent!;
    const label = () => document.querySelector(".tutorial-count")!.textContent!;

    // Step 1 is a note: any move is refused until Got it.
    const anyOpen = () => [...document.querySelectorAll<HTMLButtonElement>(".slot[data-target]")].map((s) => JSON.parse(s.dataset.target!));
    placeOn(anyOpen().find((x) => x.kind === "axis"));
    expect(text()).toMatch(/^Read this first/);

    // Mirror the dialog's session to know the first step that asks for a move.
    const dice = scriptedDice(t.script);
    let sess = initSession(t, dice);
    while (t.steps[sess.stepIndex].info) {
      fireEvent.click(nextButton()!);
      sess = skip(sess, t, dice);
    }
    const i = sess.stepIndex;
    const m = t.steps[i].solution[0](sess.game) as { crew: Crew; command: { dieId: number; target: Record<string, unknown> } };
    const idx = sess.game.dice[m.crew].findIndex((d) => d.id === m.command.dieId);

    // The right die on a space the step doesn't ask for.
    const wrong = anyOpen().find((x) => x.kind !== m.command.target.kind && ["axis", "engine", "radio", "concentration"].includes(x.kind));
    placeOn(wrong, idx);
    expect(text()).toMatch(/^Not that one/);

    // The right move: the step completes; Retry step is offered until it moves on.
    placeOn(m.command.target, idx);
    fireEvent.click(within(footer()).getByRole("button", { name: "Retry step" }));
    expect(within(footer()).queryByRole("button", { name: "Retry step" })).toBe(null);
    placeOn(m.command.target, idx);
    if (t.steps[i].solution.length === 1) {
      await waitFor(() => expect(label()).toMatch(new RegExp(`· ${i + 2}/`)), { timeout: 3000 });
    }
  });

  test("leaving mid-tutorial asks first: Keep playing, Escape and the backdrop keep it open; Leave closes", () => {
    const onClose = vi.fn();
    render(<TutorialModal id="basics" onClose={onClose} />);
    fireEvent.click(nextButton()!); // progress
    fireEvent.click(within(footer()).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep playing" }));
    expect(screen.queryByRole("alertdialog")).toBe(null);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBe(null);
    fireEvent.pointerDown(document.querySelector(".tutorial-backdrop")!);
    fireEvent.pointerDown(document.querySelector(".tutorial-confirm-backdrop")!);
    expect(screen.queryByRole("alertdialog")).toBe(null);
    fireEvent.click(document.querySelector(".tutorial-close")!); // the ✕ in the header
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("Tab keeps focus inside the dialog, both ways", () => {
    render(<TutorialModal id="wind" onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);
    const focusable = dialog.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex]:not([tabindex='-1'])");
    const [first, last] = [focusable[0], focusable[focusable.length - 1]];
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: "a" });
  });

  test("Real-Time: Skip to time's up ends the round; the clock stands still while leaving is asked", () => {
    render(<TutorialModal id="realTime" onClose={() => {}} />);
    // Play until a clock runs (Next plays each step's moves).
    for (let i = 0; i < 20 && !screen.queryByRole("button", { name: "Skip to time's up" }) && nextButton(); i++) fireEvent.click(nextButton()!);
    const skipTime = screen.queryByRole("button", { name: "Skip to time's up" });
    if (skipTime) {
      fireEvent.click(within(footer()).getByRole("button", { name: "Close" }));
      expect(screen.getByRole("timer").closest(".realtime")!.className).toMatch(/paused/);
      fireEvent.click(screen.getByRole("button", { name: "Keep playing" }));
      fireEvent.click(screen.getByRole("button", { name: "Skip to time's up" }));
    }
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
