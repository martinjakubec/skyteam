import type { Game } from "../types";

export function Altitude({ game }: { game: Game }) {
  const { rounds, startAltitudeFeet, feetPerRound, rerollRounds } = game.scenario;
  const rows = Array.from({ length: rounds }, (_, i) => i + 1);
  return (
    <div className="altitude riveted">
      <div className="alt-plane">✈</div>
      {rows.map((r) => {
        const feet = startAltitudeFeet - (r - 1) * feetPerRound;
        return (
          <div key={r} className={`alt-cell ${r === game.round ? "now" : ""} ${r === rounds ? "touchdown" : ""}`}>
            <span>{feet.toLocaleString()}</span>
            {rerollRounds.includes(r) && <span className="reroll-dot" title="Reroll token">⟳</span>}
          </div>
        );
      })}
    </div>
  );
}
