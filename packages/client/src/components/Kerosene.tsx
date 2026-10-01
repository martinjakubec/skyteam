import { useId } from "react";
import { KEROSENE_IDLE_BURN, KEROSENE_START } from "@skyteam/shared";
import type { Crew } from "../types";
import { face } from "../util";
import { Module } from "./Module";
import { Slot } from "./Slot";

/**
 * Kerosene module (advanced). On wide screens it runs down the left of the
 * Pilot's Radio + Landing Gear with a vertical gauge; in the stacked (mobile)
 * layout it spans the module strip with a horizontal gauge. Both gauges are
 * rendered and CSS shows the one that fits, so the breakpoint lives only in
 * styles.css.
 *
 * Either crew may place one die of any value here per round; the marker drops
 * by that value. Left empty, the round ends with a fixed burn of 6.
 */
export function Kerosene({
  level,
  seated,
  enabled,
  onClick,
}: {
  level: number;
  /** The die placed on the Kerosene space this round, if any. */
  seated: { value: number; crew: Crew } | null;
  enabled: boolean;
  onClick: () => void;
}) {
  return (
    <Module title="Kerosene" tone="split" className="mod-kerosene">
      <div className="kerosene">
        <div className="kerosene-space">
          <Slot
            tone={seated ? (seated.crew === "pilot" ? "blue" : "orange") : "neutral"}
            noSwitch
            dice
            taken={seated !== null}
            label={seated ? face(seated.value) : "⛽"}
            target={{ kind: "kerosene" }}
            onClick={onClick}
            enabled={enabled}
          />
          <span className="kerosene-hint" title={`An empty Kerosene space burns ${KEROSENE_IDLE_BURN} at round end`}>
            empty −{KEROSENE_IDLE_BURN}
          </span>
        </div>
        <KeroseneGauge level={level} orientation="vertical" />
        <KeroseneGauge level={level} orientation="horizontal" />
      </div>
    </Module>
  );
}

/**
 * Fuel tube with a tick per step (long + labelled every 5). Vertical: 20 at
 * the top, the empty (✕) space at the bottom, scale on the right. Horizontal:
 * ✕ on the left, 20 on the right, scale underneath. The fill tracks the
 * current level and is coloured by position — green when full, through yellow
 * and orange, to red near empty. A red band marks the last 6 steps (one idle
 * round's burn from empty).
 */
function KeroseneGauge({ level, orientation }: { level: number; orientation: "vertical" | "horizontal" }) {
  const vertical = orientation === "vertical";
  // Track length ~14px per step either way, so single units read clearly.
  const LEN = 290;
  const W = vertical ? 68 : LEN;
  const H = vertical ? LEN : 44;
  const tubeW = 14;
  const tubeAt = vertical ? 14 : 4; // the tube's cross-axis offset (x if vertical, y if horizontal)
  const start = vertical ? LEN - 8 : 8; // track position of 0 (✕)
  const end = vertical ? 6 : LEN - 10; // track position of KEROSENE_START

  const lvl = Math.max(0, Math.min(KEROSENE_START, level));
  const p = (v: number) => start + ((end - start) * v) / KEROSENE_START;
  const ticks = Array.from({ length: KEROSENE_START + 1 }, (_, v) => v);
  // Unique per gauge so the two gauges never share a gradient.
  const fuelGradient = `kg-fuel-${useId().replace(/:/g, "")}`;

  // A rect spanning track positions [a, b] and cross-axis [c, c + w].
  const span = (a: number, b: number, c: number, w: number) => {
    const lo = Math.min(a, b);
    const len = Math.abs(b - a);
    return vertical ? { x: c, y: lo, width: w, height: len } : { x: lo, y: c, width: len, height: w };
  };
  // A line across the track at position `at`, from cross-axis c1 to c2.
  const across = (at: number, c1: number, c2: number) =>
    vertical ? { x1: c1, x2: c2, y1: at, y2: at } : { x1: at, x2: at, y1: c1, y2: c2 };
  // The tube overhangs both ends of the track by 3px.
  const out = vertical ? 3 : -3;
  const tickFrom = tubeAt + tubeW + 2;

  return (
    <svg
      className={`kerosene-gauge ${orientation}`}
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      role="img"
      aria-label={`Kerosene ${lvl} of ${KEROSENE_START}`}
    >
      {/* Fixed to the tube (userSpaceOnUse), not the fill: each level keeps its
          colour as the fuel drains, so the end of the fill reads the state. */}
      <defs>
        <linearGradient
          id={fuelGradient}
          gradientUnits="userSpaceOnUse"
          {...(vertical
            ? { x1: 0, x2: 0, y1: p(KEROSENE_START), y2: p(0) }
            : { y1: 0, y2: 0, x1: p(KEROSENE_START), x2: p(0) })}
        >
          <stop offset="0%" stopColor="#4fc94f" />
          <stop offset="40%" stopColor="#e6d63a" />
          <stop offset="70%" stopColor="#ef8a2c" />
          <stop offset="100%" stopColor="#d6473b" />
        </linearGradient>
      </defs>
      {/* tube */}
      <rect className="kg-tube" {...span(p(0) + out, p(KEROSENE_START) - out, tubeAt, tubeW)} rx={6} />
      {/* danger band: one idle burn from empty */}
      <rect className="kg-danger" {...span(p(0), p(KEROSENE_IDLE_BURN), tubeAt + 2, tubeW - 4)} rx={3} />
      {/* fuel */}
      {lvl > 0 && (
        <rect className="kg-fuel" fill={`url(#${fuelGradient})`} {...span(p(0), p(lvl), tubeAt + 2, tubeW - 4)} rx={3} />
      )}
      {/* scale: a tick per unit, long + labelled every 5 */}
      {ticks.map((v) => {
        const major = v % 5 === 0;
        return (
          <g key={v}>
            <line className={`kg-tick${major ? " major" : ""}`} {...across(p(v), tickFrom, tickFrom + (major ? 9 : 4))} />
            {/* a faint rung across the fuel per step, so units can be counted */}
            {v > 0 && v < KEROSENE_START && <line className="kg-rung" {...across(p(v), tubeAt + 2, tubeAt + tubeW - 2)} />}
            {major &&
              (vertical ? (
                <text className="kg-label" x={W - 2} y={p(v)} textAnchor="end" dominantBaseline="central">
                  {v === 0 ? "✕" : v}
                </text>
              ) : (
                <text className="kg-label" x={p(v)} y={H - 2} textAnchor="middle">
                  {v === 0 ? "✕" : v}
                </text>
              ))}
          </g>
        );
      })}
    </svg>
  );
}
