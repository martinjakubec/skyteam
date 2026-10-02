import { useEffect, useRef, useState } from "react";
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
  // Leaving mid-tutorial asks first ("Leave the tutorial?"); nothing to lose, no question.
  const [confirming, setConfirming] = useState(false);
  const confirmBox = useRef<HTMLDivElement>(null);
  // A Real-Time clock stands still while the question is open.
  const pausedForQuestion = useRef(false);
  const requestClose = () => {
    if (!sb.hasProgress) return onClose();
    pausedForQuestion.current = sb.pause();
    setConfirming(true);
  };
  const keepPlaying = () => {
    if (pausedForQuestion.current) sb.resume();
    pausedForQuestion.current = false;
    setConfirming(false);
    panel.current?.focus();
  };
  // The latest of each for the key handler, which is set up once.
  const keys = useRef({ requestClose, keepPlaying, confirming });
  keys.current = { requestClose, keepPlaying, confirming };

  // Escape closes (or, with the question open, keeps playing); focus moves into
  // the dialog and stays there (in the question while it's open); the page
  // behind doesn't scroll.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") (keys.current.confirming ? keys.current.keepPlaying : keys.current.requestClose)();
      const box = keys.current.confirming ? confirmBox.current : panel.current;
      if (e.key !== "Tab" || !box) return;
      const f = box.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex]:not([tabindex='-1'])");
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
    <div className="tutorial-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !confirming && requestClose()}>
      <div ref={panel} className="tutorial-panel" role="dialog" aria-modal="true" aria-labelledby="tutorial-title" tabIndex={-1}>
        <header className="tutorial-head">
          <h2 id="tutorial-title">{tutorial.title}</h2>
          <button className="tutorial-close" aria-label="Close" onClick={requestClose}>
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
            <button onClick={requestClose}>Close</button>
          </div>
        </footer>
        {confirming && (
          <div className="tutorial-confirm-backdrop" onPointerDown={(e) => e.target === e.currentTarget && keepPlaying()}>
            <div ref={confirmBox} className="tutorial-confirm" role="alertdialog" aria-modal="true" aria-labelledby="tutorial-confirm-title" aria-describedby="tutorial-confirm-text">
              <h3 id="tutorial-confirm-title">Leave the tutorial?</h3>
              <p id="tutorial-confirm-text">Your progress won't be saved.</p>
              <div className="row">
                <button autoFocus onClick={keepPlaying}>
                  Keep playing
                </button>
                <button onClick={onClose}>Leave</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
