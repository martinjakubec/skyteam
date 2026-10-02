import type { Game } from "../types";
import { useFollow } from "../useFollow";

export function Approach({ game, airportIdx }: { game: Game; airportIdx: number }) {
  // On phones the track (and its turn tabs) scrolls sideways; keep the plane's
  // space in view.
  const scroller = useFollow<HTMLDivElement>(game.position, ".appr-cell");
  const turns = game.scenario.approachTrack.map((s) => s.axisAllowed);
  return (
    <div className="approach">
      <span className="approach-tag">{game.scenario.name}</span>
      <div className="approach-scroll scroll" ref={scroller}>
        <div className="approach-track">
          {game.airplanes.map((planes, i) => (
            <div
              key={i}
              className={`appr-cell ${i === game.position ? "here" : ""} ${i === airportIdx ? "airport" : ""}`}
              title={turnTitle(turns[i])}
            >
              {i === game.position && <span className="me">✈</span>}
              {i === airportIdx && i !== game.position && <span className="rwy">🛬</span>}
              <span className="traffic">
                {Array.from({ length: planes }, (_, k) => (
                  <span key={k} className="traffic-plane">
                    ✈
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
        {/* Turns hang below the track as small tabs, one under each turn space
            (an empty slot under the others keeps the columns aligned). */}
        {turns.some(Boolean) && (
          <div className="turn-row">
            {game.airplanes.map((_, i) => (
              <div key={i} className="turn-slot">
                {turns[i] && (
                  <div className="turn-tab" title={turnTitle(turns[i])}>
                    <TurnMarks allowed={turns[i]} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Axis positions, left to right as on the dial: + banks toward the Pilot (left). */
const POSITIONS = [2, 1, 0, -1, -2];

const axisName = (o: number) => (o === 0 ? "level" : `${Math.abs(o)} toward the ${o > 0 ? "Pilot" : "Co-Pilot"}`);

function turnTitle(allowed?: number[]): string | undefined {
  if (!allowed) return undefined;
  return `Turn: to fly on from here the Axis must be ${allowed.map(axisName).join(" or ")}.`;
}

/**
 * Turns (Approach Track effect), drawn in a turn space's tab: the five Axis
 * positions on a small arc, like
 * the top of the dial. A permitted position (one the plane may be in when it
 * advances off this space) is a green ▽, filled for level (0); a forbidden one
 * is a red ✕. Each mark is tilted to face the arc's centre.
 */
const ARC_R = 52; // arc radius (viewBox units); its centre sits below the svg
const ARC_STEP = 11; // degrees between neighbouring positions
const TRIANGLE = "M-2.1 -3.3 L2.1 -3.3 L0 3.9 Z"; // a narrow ▽ (so its tilt reads clearly), centred on the origin
const CROSS = "M-2.8 -2.8 L2.8 2.8 M2.8 -2.8 L-2.8 2.8";

function TurnMarks({ allowed }: { allowed?: number[] }) {
  if (!allowed) return null;
  return (
    <svg className="turn-marks" viewBox="0 0 50 16" aria-hidden="true">
      {POSITIONS.map((o) => {
        const deg = o * ARC_STEP; // +2 sits left of centre, −2 right
        const rad = (deg * Math.PI) / 180;
        const x = 25 - ARC_R * Math.sin(rad);
        const y = 4 + ARC_R * (1 - Math.cos(rad));
        const ok = allowed.includes(o);
        return (
          <path
            key={o}
            className={ok ? (o === 0 ? "turn-ok level" : "turn-ok") : "turn-no"}
            d={ok ? TRIANGLE : CROSS}
            transform={`translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${-deg})`}
          />
        );
      })}
    </svg>
  );
}
