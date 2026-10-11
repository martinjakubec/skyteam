// @vitest-environment jsdom
// The app's "Are you sure?" dialog (in place of window.confirm / prompt): its
// answers, keyboard and focus, and the type-the-name variant.
import "../support/dom";
import { afterEach, describe, expect, test } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useConfirm, type ConfirmOptions } from "../../packages/client/src/components/ConfirmDialog";

afterEach(cleanup);

/** A button that asks; the answers land in `answers`. */
function Asker({ options, answers }: { options: ConfirmOptions; answers: boolean[] }) {
  const [confirm, dialog] = useConfirm();
  return (
    <>
      <button onClick={async () => answers.push(await confirm(options))}>Ask</button>
      {dialog}
    </>
  );
}

const ask = (options: ConfirmOptions = { title: "Sure?", message: "It can't be undone.", confirmLabel: "Do it" }) => {
  const answers: boolean[] = [];
  render(<Asker options={options} answers={answers} />);
  const opener = screen.getByRole("button", { name: "Ask" });
  opener.focus();
  fireEvent.click(opener);
  return { answers, opener, dialog: () => screen.getByRole("alertdialog") };
};
const closed = () => waitFor(() => expect(screen.queryByRole("alertdialog")).toBe(null));

describe("ConfirmDialog", () => {
  test("names itself; focus starts on Cancel and goes back to the opener after", async () => {
    const { answers, opener, dialog } = ask();
    expect(screen.getByRole("alertdialog", { name: "Sure?" })).toBeTruthy();
    expect(within(dialog()).getByText("It can't be undone.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Do it" }));
    await closed();
    expect(answers).toEqual([true]);
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("");
  });

  test("Cancel, Escape and a click outside all say no; a click inside doesn't", async () => {
    const { answers, opener, dialog } = ask();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await closed();
    fireEvent.click(opener);
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await closed();
    fireEvent.click(opener);
    fireEvent.pointerDown(dialog());
    expect(dialog()).toBeTruthy();
    fireEvent.pointerDown(document.querySelector(".confirm-backdrop")!);
    await closed();
    expect(answers).toEqual([false, false, false]);
  });

  test("Tab keeps focus inside, both ways", () => {
    const { dialog } = ask();
    const [cancel, ok] = within(dialog()).getAllByRole("button");
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(ok);
    fireEvent.keyDown(ok, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
  });

  test("type to confirm: the button waits for the exact text; Enter then confirms", async () => {
    const { answers, dialog } = ask({ title: "Delete alice?", confirmLabel: "Delete", danger: true, typeToConfirm: "alice" });
    const box = within(dialog()).getByRole("textbox");
    const del = within(dialog()).getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect(document.activeElement).toBe(box);
    expect(del.className).toBe("confirm-danger");
    expect(del.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "alic" } });
    fireEvent.submit(dialog());
    expect(dialog()).toBeTruthy();
    fireEvent.change(box, { target: { value: "alice" } });
    expect(del.disabled).toBe(false);
    fireEvent.submit(dialog());
    await closed();
    expect(answers).toEqual([true]);
  });

  test("a new question answers the open one no", async () => {
    const answers: boolean[] = [];
    let confirm!: (o: ConfirmOptions) => Promise<boolean>;
    function Host() {
      const [c, dialog] = useConfirm();
      confirm = c;
      return <>{dialog}</>;
    }
    render(<Host />);
    await act(async () => void confirm({ title: "First?" }).then((a) => answers.push(a)));
    await act(async () => void confirm({ title: "Second?" }).then((a) => answers.push(a)));
    expect(answers).toEqual([false]);
    expect(screen.getByRole("alertdialog", { name: "Second?" })).toBeTruthy();
  });
});
