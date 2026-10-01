import { clamp } from "../util";

// Brakes gauge — a compact sibling of the SpeedGauge that shares its smile-bent
// arc so the two read as a matched pair. The scale shows the brake values with
// the in-between numbers, and a single red marker tracks how far the Brake
// marker has advanced.
//
// `values` are the brake steps in deploy order: the base game's 2, 4, 6, or
// Ice Brakes' 2, 3, 4, 5. The marker has one stop per step plus a start, driven
// by `deployed` (0..values.length); it sits just past the highest value reached.
// Base game:
//   0 -> before the 2   (no brake set)
//   1 -> between 2 and 3 (a 2 set)
//   2 -> between 4 and 5 (a 4 set)
//   3 -> after the 6     (a 6 set)
export function BrakesGauge({
  deployed,
  values = [2, 4, 6],
}: {
  deployed: number;
  values?: readonly number[];
}) {
  // The arc runs one past each end of the labelled range — the unlabelled
  // margin is the room the marker needs to sit "before" the first and "after"
  // the last value.
  const first = values[0];
  const last = values[values.length - 1];
  const MIN = first - 1;
  const MAX = last + 1;
  // Same geometry as the SpeedGauge (see SpeedGauge.tsx for the derivation), but
  // sweeping only a short arc. This gauge's SVG renders ~0.7x the speed gauge's
  // scale, so the pip radius (below), font-size and stroke-width (both in CSS)
  // are bumped ~1.43x to read at the same visual size as the speed gauge.
  const R = 210;
  const SPAN = 40;
  const cx = 150;
  const cy = 78 - R;
  const at = (v: number) => {
    const t = clamp((v - MIN) / (MAX - MIN), 0, 1);
    const phi = ((t - 0.5) * 2 * SPAN * Math.PI) / 180;
    return { x: cx + R * Math.sin(phi), y: cy + R * Math.cos(phi) };
  };
  const left = at(MIN);
  const right = at(MAX);

  // Discrete marker positions, indexed by `deployed`. Half-steps so the marker
  // sits in the gap *after* the value it has reached.
  const stops = [first - 0.5, ...values.map((v) => v + 0.5)];
  const markerValue = stops[clamp(deployed, 0, stops.length - 1)];

  // A tall radial bar pulled to a triangular tip pointing toward the high end —
  // identical in build to the SpeedGauge's aero markers, just painted red.
  const phi = ((clamp((markerValue - MIN) / (MAX - MIN), 0, 1) - 0.5) * 2 * SPAN * Math.PI) / 180;
  const rx = Math.sin(phi); // radial — the marker's long axis
  const ry = Math.cos(phi);
  const tx = Math.cos(phi); // tangent toward higher values — where the tip points
  const ty = -Math.sin(phi);
  const c = at(markerValue);
  const off = -4; // recenter by half the tip's protrusion
  const P = (rad: number, tan: number) =>
    `${c.x + rx * rad + tx * (tan + off)},${c.y + ry * rad + ty * (tan + off)}`;
  const markerPoints = [P(10, -4), P(10, 4), P(0, 12), P(-10, 4), P(-10, -4)].join(" ");

  return (
    <div className="gauge brakes-gauge">
      <svg className="gauge-svg brakes-gauge-svg" viewBox="0 0 300 112" aria-hidden="true">
        <path className="gauge-track" d={`M ${left.x} ${left.y} A ${R} ${R} 0 0 0 ${right.x} ${right.y}`} />
        {Array.from({ length: last - first + 1 }, (_, i) => first + i).map((n) => {
          const p = at(n);
          const t = (n - MIN) / (MAX - MIN);
          const ph = ((t - 0.5) * 2 * SPAN * Math.PI) / 180;
          const rot = -(t - 0.5) * 2 * SPAN; // rotate the number parallel to the arc
          const D = 40; // push the number clear of the (now thicker) arc, along the radius
          const nx = p.x + D * Math.sin(ph);
          const ny = p.y + D * Math.cos(ph);
          return (
            <g key={n}>
              <circle className="gauge-tick" cx={p.x} cy={p.y} r="4.3" />
              <text className="gauge-num" x={nx} y={ny} transform={`rotate(${rot} ${nx} ${ny})`}>
                {n}
              </text>
            </g>
          );
        })}
        <polygon className="brake-marker" points={markerPoints} />
      </svg>
    </div>
  );
}
