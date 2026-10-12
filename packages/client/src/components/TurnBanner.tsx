import type { RoomSnapshot } from "@skyteam/shared";
import { label } from "../util";

/**
 * A line stuck to the top of the screen while dice are being placed: whose
 * turn it is, in that crew's colour (Pilot blue, Co-Pilot orange) — "Your
 * turn" when it's mine. Nothing between rounds or once the game is over.
 */
export function TurnBanner({ snapshot }: { snapshot: RoomSnapshot }) {
  const game = snapshot.game;
  if (!game || game.phase !== "placement" || game.outcome) return null;
  const me = snapshot.you.playerId;
  const myCrew = game.pilotId === me ? "pilot" : game.copilotId === me ? "copilot" : null;
  const mine = game.turn === myCrew;
  return (
    <div className={`turn-banner ${game.turn}${mine ? " mine" : ""}`} role="status" aria-live="polite">
      {mine ? "Your turn" : `${label(game.turn)}'s turn`}
    </div>
  );
}
