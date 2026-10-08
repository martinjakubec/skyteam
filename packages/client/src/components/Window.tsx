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
        {/* The airplane seen from behind, as on the board game's dial: a flat
            white silhouette — long straight wings tapering to round tips, a
            small round fuselage, a short fin and tailplane. It banks with the
            Axis around its centre (50, 50); the fin tracks the bank pips. */}
        <svg className="plane-svg" viewBox="0 0 100 100" style={{ transform: `rotate(${bank}deg)` }} aria-hidden="true">
          <g fill="#f6f8f3">
            {/* wings: thick at the root, tapering to rounded tips */}
            <path d="M50 46.6 L92.6 49.1 A1.6 1.6 0 0 1 92.6 52.3 L50 55 L7.4 52.3 A1.6 1.6 0 0 1 7.4 49.1 Z" />
            {/* tailplane across the top of the fuselage */}
            <path d="M50 41 L67.6 42.3 A1.15 1.15 0 0 1 67.6 44.6 L50 45.4 L32.4 44.6 A1.15 1.15 0 0 1 32.4 42.3 Z" />
            {/* the fin: short and thin, rising from the fuselage */}
            <path d="M48.8 44 L49.45 30.8 A0.6 0.6 0 0 1 50.55 30.8 L51.2 44 Z" />
            {/* the fuselage, tail-on */}
            <ellipse cx="50" cy="50.6" rx="8" ry="7.6" />
            {/* the bank pointer: just inside the glass's top edge (above the
                pitch ladder, past the drawing's box — the window clips it),
                turning with the plane, so the tilt reads at a glance */}
            <path d="M50 -4 L53.8 2.4 Q54.2 3.2 53.3 3.2 L46.7 3.2 Q45.8 3.2 46.2 2.4 Z" />
          </g>
        </svg>
      </div>
    </div>
  );
}
