import { useRef } from "react";
import { WIND_RING } from "@skyteam/shared";
import { Module } from "./Module";

const SIZE = 200;
const C = SIZE / 2;
const R_OUT = 98;
const R_IN = 75; // the spaces: a thin band round the edge
const R_DISC = 65; // the blue disc, with a clear gap inside the band
const STEP = 360 / WIND_RING.length; // 18° per space

/** Point at `r` from the centre, `deg` clockwise from straight up. */
const at = (r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const;
};

/** One ring space: an annular wedge centred on `deg`, a little inset from its neighbours. */
function wedge(deg: number) {
  const a0 = deg - STEP / 2 + 0.9;
  const a1 = deg + STEP / 2 - 0.9;
  const [x0, y0] = at(R_OUT, a0);
  const [x1, y1] = at(R_OUT, a1);
  const [x2, y2] = at(R_IN, a1);
  const [x3, y3] = at(R_IN, a0);
  return `M${x0} ${y0} A${R_OUT} ${R_OUT} 0 0 1 ${x1} ${y1} L${x2} ${y2} A${R_IN} ${R_IN} 0 0 0 ${x3} ${y3} Z`;
}

// A real minus sign (U+2212), the same width as the plus.
const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `\u2212${-v}` : "0");

/**
 * Wind module (advanced). The Wind Ring's 20 spaces carry the wind speed
 * (+3 at the top down to −3 at the bottom); the blue Airplane token in the
 * middle points at the current one, which is added to the Engine total. After
 * each Axis phase the airplane turns one space per pip the plane is tilted.
 *
 * Sits right of the Co-Pilot's Radio on wide screens; in the stacked (mobile)
 * layout it gets its own row with the readout beside the ring (styles.css).
 */
export function Wind({ position }: { position: number }) {
  const n = WIND_RING.length;
  const pos = ((position % n) + n) % n;
  const speed = WIND_RING[pos];

  // Rotate by the shortest way round, accumulating, so 19 → 1 animates +36°
  // rather than spinning back through the whole ring.
  const angle = useRef(pos * STEP);
  const target = pos * STEP;
  const delta = ((((target - angle.current) % 360) + 540) % 360) - 180;
  angle.current += delta;

  return (
    <Module title="Wind" tone="split" className="mod-wind">
      <div className="wind">
        <svg className="wind-ring" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`Wind ${signed(speed)}`}>
          {WIND_RING.map((v, i) => {
            const deg = i * STEP;
            // Labels are turned with their space, the bottom of each facing the centre.
            const [tx, ty] = at((R_OUT + R_IN) / 2, deg);
            const cls = `wind-space${i === 0 ? " start" : ""}${i === pos ? " current" : ""}${v > 0 ? " tail" : v < 0 ? " head" : ""}`;
            return (
              <g key={i} className={cls}>
                <path d={wedge(deg)} />
                <text x={tx} y={ty} transform={`rotate(${deg} ${tx} ${ty})`} textAnchor="middle" dominantBaseline="central">
                  {signed(v)}
                </text>
              </g>
            );
          })}
          <circle className="wind-disc" cx={C} cy={C} r={R_DISC} />
          <g className="wind-plane" style={{ transform: `rotate(${angle.current}deg)` }}>
            {/* Top-down airliner, nose up toward the space it points at. */}
            <path
              transform="translate(100 100) scale(1.05) translate(-100 -96)"
              d="M100 50 C104 50 105 58 105 64 L105 88 L138 104 L138 111 L105 102 L104 128 L115 136 L115 141 L100 137 L85 141 L85 136 L96 128 L95 102 L62 111 L62 104 L95 88 L95 64 C95 58 96 50 100 50 Z"
            />
          </g>
        </svg>
        <div className="wind-readout">
          <span className={`wind-speed${speed > 0 ? " tail" : speed < 0 ? " head" : ""}`}>{signed(speed)}</span>
          <span className="wind-hint">added to engines</span>
        </div>
      </div>
    </Module>
  );
}
