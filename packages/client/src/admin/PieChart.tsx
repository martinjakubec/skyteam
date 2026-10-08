/**
 * A donut chart for parts of a whole, drawn as plain SVG (no chart library):
 * each slice is a circle's stroke, dashed to its share. Past MAX_SLICES the
 * smallest slices are grouped as "Other". Screen readers get the figures in
 * the chart's label; the legend (or a table beside it) shows them too.
 */

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

export function PieChart({ title, slices, legend = true, size = 168 }: { title: string; slices: Slice[]; legend?: boolean; size?: number }) {
  const drawn = groupSlices(slices);
  const total = drawn.reduce((n, s) => n + s.value, 0);
  if (!total) return null;
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
              stroke={s.color ?? sliceColor(i, slices.filter((x) => x.value > 0).length)}
              strokeWidth="7"
              strokeDasharray={`${len} ${100 - len}`}
              strokeDashoffset={offset}
            >
              <title>{`${s.label}: ${s.value} (${share(s.value, total)})`}</title>
            </circle>
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
              <Swatch color={s.color ?? sliceColor(i, slices.filter((x) => x.value > 0).length)} />
              <span className="adm-legend-label">{s.label}</span>
              <span className="adm-legend-value">{s.value}</span>
              <span className="adm-legend-share">{share(s.value, total)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const Swatch = ({ color }: { color: string }) => <span className="adm-swatch" style={{ background: color }} aria-hidden="true" />;
