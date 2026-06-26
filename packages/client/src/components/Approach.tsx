import type { Game } from "../types";

export function Approach({ game, airportIdx }: { game: Game; airportIdx: number }) {
  return (
    <div className="approach">
      <span className="approach-tag">{game.scenario.name}</span>
      <div className="approach-track">
        {game.airplanes.map((planes, i) => (
          <div key={i} className={`appr-cell ${i === game.position ? "here" : ""} ${i === airportIdx ? "airport" : ""}`}>
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
    </div>
  );
}
