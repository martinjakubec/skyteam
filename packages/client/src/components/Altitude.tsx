import type { Game } from "../types";
import { useFollow } from "../useFollow";
import { Plane } from "./icons";

export function Altitude({ game }: { game: Game }) {
  const { rounds, startAltitudeFeet, feetPerRound, rerollRounds } = game.scenario;
  const rows = Array.from({ length: rounds }, (_, i) => i + 1);
  // On phones the track scrolls sideways; keep the current round in view.
  const track = useFollow<HTMLDivElement>(game.round - 1);
  // Same horizontal track layout as the Approach panel, in the blue altimeter
  // palette: a tag above a left-to-right row of per-round altitude cells.
  return (
    <div className="approach altitude">
      <span className="approach-tag alt-tag">Altitude <Plane /></span>
      <div className="approach-track scroll" ref={track}>
        {rows.map((r) => {
          const feet = startAltitudeFeet - (r - 1) * feetPerRound;
          return (
            <div
              key={r}
              className={`appr-cell alt-cell ${r === game.round ? "now" : ""} ${r === rounds ? "touchdown" : ""}`}
            >
              <span className="alt-feet">{feet.toLocaleString()}</span>
              {rerollRounds.includes(r) && (
                <span className="reroll-dot" title="Reroll token" role="img" aria-label="Reroll token">
                  {/* An icon, not the ⟳ character: fonts draw that glyph with
                      uneven side bearings, so it never sits evenly in the corner. */}
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M13.2 8.6A5.3 5.3 0 1 1 11.6 4" />
                    <path d="M12.3 1.4v3.2H9.1" />
                  </svg>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
