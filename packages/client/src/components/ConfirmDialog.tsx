import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  /** The confirming button's label ("OK" if left out). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** The confirming button in red: the action destroys something. */
  danger?: boolean;
  /** The confirming button stays disabled until exactly this is typed (e.g. a username). */
  typeToConfirm?: string;
}

/**
 * The app's own "Are you sure?" (in place of window.confirm / window.prompt).
 * Escape, Cancel or a click outside it says no; focus starts on Cancel (or the
 * text box), stays inside while it's open and goes back where it was after.
 */
export function ConfirmDialog({ options, onAnswer }: { options: ConfirmOptions; onAnswer: (yes: boolean) => void }) {
  const { title, message, confirmLabel = "OK", cancelLabel = "Cancel", danger, typeToConfirm } = options;
  const box = useRef<HTMLFormElement>(null);
  const [typed, setTyped] = useState("");
  const ready = typeToConfirm === undefined || typed === typeToConfirm;
  // Read while rendering: by the time effects run, autoFocus has moved focus in.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [opener]);

  // Handled here, and kept from the page's own key handlers behind.
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") return onAnswer(false);
    if (e.key !== "Tab" || !box.current) return;
    const f = box.current.querySelectorAll<HTMLElement>("button:not(:disabled), input");
    const [first, last] = [f[0], f[f.length - 1]];
    if (e.shiftKey && document.activeElement === first) {
      last.focus();
      e.preventDefault();
    } else if (!e.shiftKey && document.activeElement === last) {
      first.focus();
      e.preventDefault();
    }
  };

  return createPortal(
    <div className="confirm-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onAnswer(false)}>
      <form
        ref={box}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={message ? "confirm-text" : undefined}
        onKeyDown={onKey}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) onAnswer(true);
        }}
      >
        <h3 id="confirm-title">{title}</h3>
        {message && <p id="confirm-text">{message}</p>}
        {typeToConfirm !== undefined && (
          <label className="confirm-type">
            Type <b>{typeToConfirm}</b> to confirm
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
        )}
        <div className="row">
          <button type="button" autoFocus={typeToConfirm === undefined} onClick={() => onAnswer(false)}>
            {cancelLabel}
          </button>
          <button type="submit" className={danger ? "confirm-danger" : undefined} disabled={!ready}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/**
 * `const [confirm, dialog] = useConfirm()`: render `dialog`, then
 * `if (await confirm({ title: "…" })) …` — true only for the confirming button.
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<{ options: ConfirmOptions; resolve: (yes: boolean) => void } | null>(null);
  const confirm = useCallback(
    // A new question answers an open one "no".
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) =>
        setPending((open) => {
          open?.resolve(false);
          return { options, resolve };
        }),
      ),
    [],
  );
  const dialog = pending && (
    <ConfirmDialog
      options={pending.options}
      onAnswer={(yes) => {
        setPending(null);
        pending.resolve(yes);
      }}
    />
  );
  return [confirm, dialog];
}
