import type { Game } from "../types";
import { useFollow } from "../useFollow";

export function Approach({ game, airportIdx }: { game: Game; airportIdx: number }) {
  // On phones the track scrolls sideways; keep the plane's space in view.
  const track = useFollow<HTMLDivElement>(game.position);
  return (
    <div className="approach">
      <span className="approach-tag">{game.scenario.name}</span>
      <div className="approach-track scroll" ref={track}>
        {game.airplanes.map((planes, i) => (
          <div
            key={i}
            className={`appr-cell ${i === game.position ? "here" : ""} ${i === airportIdx ? "airport" : ""}`}
            title={turnTitle(game.scenario.approachTrack[i]?.axisAllowed)}
          >
            {i === game.position && <span className="me">✈</span>}
            {i === airportIdx && i !== game.position && <span className="rwy">🛬</span>}
            <TurnMarks allowed={game.scenario.approachTrack[i]?.axisAllowed} />
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
 * Turns (Approach Track effect): the five Axis positions on a small arc, like
 * the top of the dial — a green ▼ where the plane may be when it advances off
 * this space, a dim dot elsewhere.
 */
function TurnMarks({ allowed }: { allowed?: number[] }) {
  if (!allowed) return null;
  return (
    <svg className="turn-marks" viewBox="0 0 50 16" aria-hidden="true">
      {POSITIONS.map((o, k) => {
        const x = 5 + k * 10;
        const y = 4 + Math.abs(o) * 2.5; // a shallow arc: the ends sit lower
        return allowed.includes(o) ? (
          <path key={o} className="turn-ok" d={`M${x - 4} ${y - 3} L${x + 4} ${y - 3} L${x} ${y + 3.5} Z`} />
        ) : (
          <circle key={o} className="turn-no" cx={x} cy={y} r={1.6} />
        );
      })}
    </svg>
  );
}
