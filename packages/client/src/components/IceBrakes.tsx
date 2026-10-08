import { ICE_BRAKE_VALUES } from "@skyteam/shared";
import type { Crew } from "../types";
import { face } from "../util";
import { Slot } from "./Slot";
import { Snowflake } from "./icons";

/** One Ice Brakes step this round: the Pilot's top die and the bottom die (either crew). */
export interface IceBrakeStep {
  top: number | null;
  bottom: { value: number; crew: Crew } | null;
}

/**
 * Ice Brakes module (advanced) — replaces the Brakes row under the Brakes gauge.
 * Four steps (2 → 3 → 4 → 5) deployed left to right; each needs the step's
 * value on BOTH its spaces in the same round: the blue top space (Pilot only)
 * and the split bottom space (either crew). Then the marker moves past it. A
 * lone die comes back at the end of the round without moving the marker. No
 * switches, unlike the base Brakes.
 */
export function IceBrakes({
  steps,
  deployed,
  canTop,
  canBottom,
  onTop,
  onBottom,
}: {
  steps: IceBrakeStep[];
  /** Steps completed so far (the Brake marker's position, 0..4). */
  deployed: number;
  canTop: (i: number) => boolean;
  canBottom: (i: number) => boolean;
  onTop: (i: number) => void;
  onBottom: (i: number) => void;
}) {
  return (
    <div className="ice-brakes" title="Ice Brakes: both spaces of a step need its value in the same round">
      {/* Leads up to the brake gauge: a bus over the four columns, brackets
          down into the end columns and a stem up from its centre. */}
      <span className="brake-leads ice" aria-hidden="true">
        <span className="bus" />
        <span className="up" />
        <span className="drop left" />
        <span className="drop right" />
      </span>
      <div className="ice-brakes-row">
        {ICE_BRAKE_VALUES.map((v, i) => {
          const step = steps[i] ?? { top: null, bottom: null };
          const done = i < deployed;
          return (
            <div key={v} className="ice-step-wrap">
              {i > 0 && <span className="slot-arrow" aria-hidden="true" />}
              <div className={`ice-step${done ? " done" : ""}`}>
                <Slot
                  tone="blue"
                  noSwitch
                  dice={step.top !== null}
                  green={done && step.top === null}
                  taken={step.top !== null}
                  target={{ kind: "iceBrakes", slot: i, space: "top" }}
                  label={step.top !== null ? face(step.top) : done ? "" : String(v)}
                  onClick={() => onTop(i)}
                  enabled={canTop(i)}
                />
                <Slot
                  tone={step.bottom ? (step.bottom.crew === "pilot" ? "blue" : "orange") : "neutral"}
                  noSwitch
                  dice={step.bottom !== null}
                  green={done && step.bottom === null}
                  taken={step.bottom !== null}
                  target={{ kind: "iceBrakes", slot: i, space: "bottom" }}
                  label={step.bottom ? face(step.bottom.value) : done ? "" : String(v)}
                  onClick={() => onBottom(i)}
                  enabled={canBottom(i)}
                />
              </div>
            </div>
          );
        })}
      </div>
      <span className="ice-caption"><Snowflake /> Ice Brakes — pairs of the same value</span>
    </div>
  );
}
