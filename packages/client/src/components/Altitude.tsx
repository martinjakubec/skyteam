import type { Game } from "../types";

export function Altitude({ game }: { game: Game }) {
  const { rounds, startAltitudeFeet, feetPerRound, rerollRounds } = game.scenario;
  const rows = Array.from({ length: rounds }, (_, i) => i + 1);
  // Same horizontal track layout as the Approach panel, in the blue altimeter
  // palette: a tag above a left-to-right row of per-round altitude cells.
  return (
    <div className="approach altitude">
      <span className="approach-tag alt-tag">Altitude ✈</span>
      <div className="approach-track">
        {rows.map((r) => {
          const feet = startAltitudeFeet - (r - 1) * feetPerRound;
          return (
            <div
              key={r}
              className={`appr-cell alt-cell ${r === game.round ? "now" : ""} ${r === rounds ? "touchdown" : ""}`}
            >
              <span className="alt-feet">{feet.toLocaleString()}</span>
              {rerollRounds.includes(r) && (
                <span className="reroll-dot" title="Reroll token">
                  ⟳
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
