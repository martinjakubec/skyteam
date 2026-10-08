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
        <svg className="plane-svg" viewBox="0 0 100 100" style={{ transform: `rotate(${bank}deg)` }} aria-hidden="true">
          <path
            d="M50 5 L56 38 L94 60 L94 69 L56 56 L54 85 L68 93 L68 98 L50 91 L32 98 L32 93 L46 85 L44 56 L6 69 L6 60 L44 38 Z"
            fill="#f6f8f3"
            stroke="rgba(0,0,0,0.25)"
            strokeWidth="1.5"
          />
        </svg>
      </div>
    </div>
  );
}
