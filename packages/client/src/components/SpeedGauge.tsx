import { clamp } from "../util";

// Horizontal speed gauge, bent into a smile (∪): slow on the left, fast on the
// right, with both ends raised and the middle dipped. The bar is a circular arc
// (the dial's circle, enlarged); markers and the needle sit on that same circle.
export function SpeedGauge({ blue, orange, speed }: { blue: number; orange: number; speed: number | null }) {
  const MIN = 2;
  const MAX = 12;
  // The bar is a circular arc — like the dial's circle enlarged and viewed from the
  // bottom. R sets the curvature (larger than the dial = "enlarged"); SPAN is how
  // much of the circle the bar covers. Low speed sits at the left, high at the right.
  const R = 120;
  const SPAN = 85; // degrees, each side of the bottom — wider sweep = rounder, more dial-like
  const cx = 150;
  const cy = 78 - R; // circle centre, above the gauge (lowest point of the arc at y=78)
  const at = (v: number) => {
    const t = clamp((v - MIN) / (MAX - MIN), 0, 1);
    const phi = ((t - 0.5) * 2 * SPAN * Math.PI) / 180;
    return { x: cx + R * Math.sin(phi), y: cy + R * Math.cos(phi) };
  };
  const left = at(MIN);
  const right = at(MAX);
  const sp = speed !== null ? at(speed) : null;
  // Pilot/copilot marker: a tall (radial) rectangle whose right long edge is
  // pulled into a triangular tip pointing toward the fast end (progress). Built
  // in arc-local coords so it stays upright on the bar wherever it sits.
  const marker = (v: number) => {
    const t = clamp((v - MIN) / (MAX - MIN), 0, 1);
    const phi = ((t - 0.5) * 2 * SPAN * Math.PI) / 180;
    const rx = Math.sin(phi); // radial — the marker's long (vertical) axis
    const ry = Math.cos(phi);
    const tx = Math.cos(phi); // tangent toward higher speed — where the tip points
    const ty = -Math.sin(phi);
    const c = at(v);
    const off = -2.5; // recenter: shift left by half the tip's protrusion (5/2)
    const P = (rad: number, tan: number) =>
      `${c.x + rx * rad + tx * (tan + off)},${c.y + ry * rad + ty * (tan + off)}`;
    // top-left → top-right shoulder → right tip → bottom-right shoulder → bottom-left
    return [P(7, -3), P(7, 3), P(0, 8), P(-7, 3), P(-7, -3)].join(" ");
  };
  // Needle: a triangle sitting on the inside (concave side) of the arc at the
  // current speed, pointing radially outward toward that number.
  let needlePoints = "";
  if (sp !== null) {
    const phi = ((clamp((speed! - MIN) / (MAX - MIN), 0, 1) - 0.5) * 2 * SPAN * Math.PI) / 180;
    const ux = Math.sin(phi); // radial outward
    const uy = Math.cos(phi);
    const wx = Math.cos(phi); // tangent (triangle width)
    const wy = -Math.sin(phi);
    const tx = sp.x - 6 * ux; // tip just inside the bar, pointing out
    const ty = sp.y - 6 * uy;
    const bx = sp.x - 20 * ux; // base, deeper inside the arc
    const by = sp.y - 20 * uy;
    needlePoints = `${tx},${ty} ${bx + 9 * wx},${by + 9 * wy} ${bx - 9 * wx},${by - 9 * wy}`;
  }
  return (
    <div className="gauge">
      <svg className="gauge-svg" viewBox="0 0 300 112" aria-hidden="true">
        <path className="gauge-track" d={`M ${left.x} ${left.y} A ${R} ${R} 0 0 0 ${right.x} ${right.y}`} />
        {[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => {
          const p = at(n);
          const t = (n - MIN) / (MAX - MIN);
          const phi = ((t - 0.5) * 2 * SPAN * Math.PI) / 180;
          const rot = -(t - 0.5) * 2 * SPAN; // tangent angle — rotates the number parallel to the arc
          const D = 30; // push the number just outside the (now thicker) arc, along the radius
          const nx = p.x + D * Math.sin(phi);
          const ny = p.y + D * Math.cos(phi);
          return (
            <g key={n}>
              <circle className="gauge-tick" cx={p.x} cy={p.y} r="3" />
              <text className="gauge-num" x={nx} y={ny} transform={`rotate(${rot} ${nx} ${ny})`}>
                {n}
              </text>
            </g>
          );
        })}
        <polygon className="aero-dot blue" points={marker(blue + 0.5)} />
        <polygon className="aero-dot orange" points={marker(orange + 0.5)} />
        {sp && <polygon className="gauge-needle" points={needlePoints} />}
      </svg>
    </div>
  );
}
