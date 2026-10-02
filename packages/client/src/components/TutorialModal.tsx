import { useEffect, useRef } from "react";
import { tutorialFor } from "../tutorials";
import type { TutorialId } from "../tutorials/types";
import { useSandbox } from "../tutorials/useSandbox";
import { Cockpit } from "./Cockpit";

/** The full game's, a module's or a Special Ability's rules plus its guided, playable tutorial. */
export function TutorialModal({ id, onClose }: { id: TutorialId; onClose: () => void }) {
  const tutorial = tutorialFor(id);
  const sb = useSandbox(tutorial);
  const panel = useRef<HTMLDivElement>(null);
  // The lobby passes a new onClose on every render; keep the latest without
  // re-running the focus setup (which would pull focus off the footer).
  const close = useRef(onClose);
  close.current = onClose;

  // Escape closes; focus moves into the dialog and stays there; the page behind doesn't scroll.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
      if (e.key !== "Tab" || !panel.current) return;
      const f = panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex]:not([tabindex='-1'])");
      if (f.length === 0) return;
      const [first, last] = [f[0], f[f.length - 1]];
      // The dialog itself (focused on open) counts as the start of the cycle.
      const atStart = document.activeElement === first || document.activeElement === panel.current;
      if (e.shiftKey && atStart) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, []);

  const total = tutorial.steps.length;
  const crew = sb.snapshot.you.role === "host" ? "Pilot" : "Co-Pilot";
  return (
    <div className="tutorial-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className="tutorial-panel" role="dialog" aria-modal="true" aria-labelledby="tutorial-title" tabIndex={-1}>
        <header className="tutorial-head">
          <h2 id="tutorial-title">{tutorial.title}</h2>
          <button className="tutorial-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <p className="tutorial-desc">{tutorial.description}</p>
        {/* Only the board scrolls (the step below stays in view); a drag near
            its top or bottom edge scrolls it (see Cockpit). */}
        <div className="tutorial-scroll" data-drag-scroll>
          <div className="stage tutorial-stage">
            <p className="tutorial-as">
              Playing as: <b>{crew}</b>
            </p>
            {/* Remounted on Reset and whenever the other crew takes over, so no
                selected die or Coffee carries across. */}
            <Cockpit key={`${sb.resets}:${sb.snapshot.you.playerId}`} snapshot={sb.snapshot} onCommand={sb.send} show={tutorial.show} clockOffset={0} />
          </div>
        </div>
        <footer className={`tutorial-steps${sb.flash ? " done" : ""}`}>
          <span className="tutorial-count">
            {!sb.step
              ? tutorial.outro ? "Done" : "Free play"
              : sb.step.chapter
                ? `${sb.step.chapter} · ${sb.stepIndex + 1}/${total}`
                : `Step ${sb.stepIndex + 1} of ${total}`}
          </span>
          <p className="tutorial-text" aria-live="polite">
            {sb.error ?? sb.step?.text ?? tutorial.outro ?? "Free play — try anything, or Reset."}
          </p>
          <div className="row">
            {sb.timerRunning && <button onClick={sb.skipTime}>Skip to time's up</button>}
            {sb.step && <button onClick={sb.next}>{sb.step.info ? "Got it" : "Next"}</button>}
            {sb.canRetry && <button onClick={sb.retryStep}>Retry step</button>}
            <button onClick={sb.reset}>Reset</button>
            <button onClick={onClose}>Close</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
