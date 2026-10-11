/**
 * A donut chart for parts of a whole, drawn as plain SVG (no chart library):
 * each slice is a circle's stroke, dashed to its share. Past MAX_SLICES the
 * smallest slices are grouped as "Other". Screen readers get the figures in
 * the chart's label; the legend (or a table beside it) shows them too.
 * Hovering (or tapping) a slice shows its value in a tooltip.
 */

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";

export interface Slice {
  label: string;
  value: number;
  /** A fixed colour (e.g. one per outcome, the same on every chart). */
  color?: string;
}

const PALETTE = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];
const OTHER = "#9aa3b2";
export const MAX_SLICES = 8;

/** The slices to draw: the first MAX_SLICES - 1, and the rest as "Other". */
export function groupSlices(slices: Slice[]): Slice[] {
  const positive = slices.filter((s) => s.value > 0);
  if (positive.length <= MAX_SLICES) return positive;
  const kept = positive.slice(0, MAX_SLICES - 1);
  const rest = positive.slice(MAX_SLICES - 1).reduce((n, s) => n + s.value, 0);
  return [...kept, { label: "Other", value: rest }];
}

/** The colour of the i-th of `count` slices as grouped (the last is grey when it's "Other"). */
export function sliceColor(i: number, count: number): string {
  return count > MAX_SLICES && i >= MAX_SLICES - 1 ? OTHER : PALETTE[i % PALETTE.length];
}

const share = (value: number, total: number) => `${((100 * value) / total).toFixed(1)} %`;

/** The hovered slice and the pointer, in viewport coordinates. */
interface Hover {
  i: number;
  x: number;
  y: number;
  touch: boolean;
}

/** Gap between the pointer and the tooltip, and the tooltip and the window's edge. */
const GAP = 12;

export function PieChart({ title, slices, legend = true, size = 168 }: { title: string; slices: Slice[]; legend?: boolean; size?: number }) {
  const drawn = groupSlices(slices);
  const total = drawn.reduce((n, s) => n + s.value, 0);
  const [hover, setHover] = useState<Hover | null>(null);
  const tip = useRef<HTMLDivElement>(null);

  // Fixed to the window, so the card's overflow can't clip it: right of and
  // below the pointer, flipped to the other side where it wouldn't fit.
  useLayoutEffect(() => {
    const el = tip.current;
    if (!el || !hover) return;
    const { width, height } = el.getBoundingClientRect();
    const fitsRight = hover.x + GAP + width <= window.innerWidth - GAP;
    const fitsBelow = hover.y + GAP + height <= window.innerHeight - GAP;
    el.style.left = `${Math.max(GAP, fitsRight ? hover.x + GAP : hover.x - GAP - width)}px`;
    el.style.top = `${Math.max(GAP, fitsBelow ? hover.y + GAP : hover.y - GAP - height)}px`;
  }, [hover]);

  // A tap's tooltip stays until the next tap elsewhere (a touch has no "leave").
  const pinned = hover?.touch ?? false;
  useEffect(() => {
    if (!pinned) return;
    const close = (e: globalThis.PointerEvent) => {
      if (!(e.target instanceof Element && e.target.classList.contains("adm-slice"))) setHover(null);
    };
    const hide = () => setHover(null);
    document.addEventListener("pointerdown", close);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", hide, true);
    };
  }, [pinned]);

  if (!total) return null;
  const count = slices.filter((x) => x.value > 0).length;
  const colorOf = (s: Slice, i: number) => s.color ?? sliceColor(i, count);
  const point = (i: number) => (e: PointerEvent) => setHover({ i, x: e.clientX, y: e.clientY, touch: e.pointerType !== "mouse" });
  const leave = (e: PointerEvent) => {
    if (e.pointerType === "mouse") setHover(null);
  };
  const shown = hover && drawn[hover.i];
  const r = 15.9155; // circumference 100: dash lengths are percentages
  let offset = 25; // start at 12 o'clock
  const label = `${title}: ${drawn.map((s) => `${s.label} ${s.value} (${share(s.value, total)})`).join(", ")}`;
  return (
    <div className="adm-pie">
      <svg viewBox="0 0 42 42" width={size} height={size} role="img" aria-label={label}>
        <circle cx="21" cy="21" r={r} fill="none" stroke="var(--adm-bar-track)" strokeWidth="7" />
        {drawn.map((s, i) => {
          const len = (100 * s.value) / total;
          const el = (
            <circle
              key={s.label}
              className="adm-slice"
              cx="21"
              cy="21"
              r={r}
              fill="none"
              stroke={colorOf(s, i)}
              strokeWidth="7"
              strokeDasharray={`${len} ${100 - len}`}
              strokeDashoffset={offset}
              onPointerDown={point(i)}
              onPointerMove={point(i)}
              onPointerLeave={leave}
            />
          );
          offset -= len;
          return el;
        })}
        <text x="21" y="21" textAnchor="middle" dominantBaseline="central" className="adm-pie-total">
          {total}
        </text>
      </svg>
      {legend && (
        <ul className="adm-legend">
          {drawn.map((s, i) => (
            <li key={s.label}>
              <Swatch color={colorOf(s, i)} />
              <span className="adm-legend-label">{s.label}</span>
              <span className="adm-legend-value">{s.value}</span>
              <span className="adm-legend-share">{share(s.value, total)}</span>
            </li>
          ))}
        </ul>
      )}
      {shown && (
        <div ref={tip} className="adm-tooltip" role="presentation">
          <span className="adm-tooltip-key" style={{ background: colorOf(shown, hover.i) }} />
          <strong className="adm-tooltip-label">{shown.label}</strong>
          <span className="adm-tooltip-value">
            {shown.value} · {share(shown.value, total)}
          </span>
        </div>
      )}
    </div>
  );
}

export const Swatch = ({ color }: { color: string }) => <span className="adm-swatch" style={{ background: color }} aria-hidden="true" />;
