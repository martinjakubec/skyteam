import { clamp } from "../util";
import { Cross } from "./icons";

// The cockpit window IS the axis indicator: the plane points straight up when
// level (offset 0) and banks with the tilt. Drawn as SVG so orientation doesn't
// depend on the system emoji font.
export function Window({
  offset,
  spinAt,
  outcome,
}: {
  offset: number;
  spinAt: number;
  outcome: { result: string } | null;
}) {
  // Each axis step banks the plane STEP degrees, so the nose lines up with the
  // matching pip on the bank scale above the dial. 7 pips: a hollow centre mark,
  // four white dots, and a red ✕ at each outer (danger) limit.
  const STEP = 24;
  // +offset means the Pilot's die was higher → tilt toward the Pilot, who sits on
  // the left of the dial, which is a counter-clockwise (negative-degree) bank.
  const bank = clamp(-offset * STEP, -90, 90);
  const danger = Math.abs(offset) >= spinAt - 1;
  const R = 100; // pip arc radius from the 88px dial centre — just outside the rim
  const pips = [-3, -2, -1, 0, 1, 2, 3];
  return (
    <div className="window-wrap">
      <div className="bank-scale" aria-hidden="true">
        {pips.map((i) => {
          const kind = i === 0 ? "center" : Math.abs(i) === 3 ? "x" : "dot";
          const rad = (i * STEP * Math.PI) / 180;
          const x = 88 + R * Math.sin(rad);
          const y = 88 - R * Math.cos(rad);
          return (
            <span key={i} className={`pip pip--${kind}`} style={{ left: `${x}px`, top: `${y}px` }}>
              {kind === "x" ? <Cross /> : null}
            </span>
          );
        })}
      </div>
      <div className={`window ${outcome ? outcome.result : ""} ${danger ? "danger" : ""}`}>
        <div className="horizon" />
        <div className="pitch-ladder" aria-hidden="true">
          {[
            { d: 22, w: 60 }, // inner rung — longer
            { d: 36, w: 40 }, // outer rung — nearer the edge, shorter
          ].flatMap(({ d, w }) =>
            [-d, d].map((s) => (
              <span key={s} className="rung" style={{ top: `${50 + s}%`, width: `${w}px` }} />
            )),
          )}
        </div>
        {/* The airplane seen from behind, banking with the Axis: its tail fin
            points where the nose of a top-down plane would, so it tracks the
            bank pips the same way. Centred on (50, 50), the pivot. */}
        <svg className="plane-svg" viewBox="0 0 100 100" style={{ transform: `rotate(${bank}deg)` }} aria-hidden="true">
          <g fill="#f6f8f3" stroke="rgba(0,0,0,0.28)" strokeWidth="1.2" strokeLinejoin="round">
            {/* tail fin, then the small tail wings at its base */}
            <path d="M47.6 43 L49 15.5 Q50 14 51 15.5 L52.4 43 Z" />
            <path d="M46 45.6 L29 42 Q28 43.6 29.4 44.4 L46 48.6 Z" />
            <path d="M54 45.6 L71 42 Q72 43.6 70.6 44.4 L54 48.6 Z" />
            {/* wings, swept slightly up to the tips (dihedral) */}
            <path d="M42 51 L6.5 45.4 Q5 46.6 6.4 47.8 L42 56.8 Z" />
            <path d="M58 51 L93.5 45.4 Q95 46.6 93.6 47.8 L58 56.8 Z" />
            {/* engines under the wings, on short pylons */}
            <path d="M26.6 51 v3.2 M73.4 51 v3.2" fill="none" />
            <circle cx="26.6" cy="58.6" r="5.2" />
            <circle cx="73.4" cy="58.6" r="5.2" />
            {/* the fuselage, tail-on */}
            <ellipse cx="50" cy="50" rx="9" ry="9.6" />
          </g>
          {/* the engines' exhausts and the tail cone */}
          <g fill="#64748b">
            <circle cx="26.6" cy="58.6" r="2.6" />
            <circle cx="73.4" cy="58.6" r="2.6" />
            <circle cx="50" cy="50.4" r="2.4" />
          </g>
        </svg>
      </div>
    </div>
  );
}
