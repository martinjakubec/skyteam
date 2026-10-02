import { useEffect, useRef } from "react";
import type { AbilityId, ModuleId } from "@skyteam/shared";
import { TUTORIALS } from "../tutorials";
import { useSandbox } from "../tutorials/useSandbox";
import { Cockpit } from "./Cockpit";

/** A module's or Special Ability's rules plus its guided, playable tutorial. */
export function TutorialModal({ id, onClose }: { id: ModuleId | AbilityId; onClose: () => void }) {
  const tutorial = TUTORIALS[id];
  const sb = useSandbox(tutorial);
  const panel = useRef<HTMLDivElement>(null);

  // Escape closes; focus moves into the dialog and stays there; the page behind doesn't scroll.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !panel.current) return;
      const f = panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex]:not([tabindex='-1'])");
      if (f.length === 0) return;
      const [first, last] = [f[0], f[f.length - 1]];
      if (e.shiftKey && document.activeElement === first) {
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
  }, [onClose]);

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
        <div className="stage tutorial-stage">
          <p className="tutorial-as">
            Playing as: <b>{crew}</b>
          </p>
          <Cockpit snapshot={sb.snapshot} onCommand={sb.send} show={tutorial.show} clockOffset={0} />
        </div>
        <footer className={`tutorial-steps${sb.flash ? " done" : ""}`}>
          <span className="tutorial-count">{sb.step ? `Step ${sb.stepIndex + 1} of ${total}` : "Free play"}</span>
          <p className="tutorial-text" aria-live="polite">
            {sb.error ?? sb.step?.text ?? "Free play — try anything, or Reset."}
          </p>
          <div className="row">
            {sb.timerRunning && <button onClick={sb.skipTime}>Skip to time's up</button>}
            {sb.step && <button onClick={sb.next}>{sb.step.info ? "Got it" : "Next"}</button>}
            <button onClick={sb.reset}>Reset</button>
            <button onClick={onClose}>Close</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
