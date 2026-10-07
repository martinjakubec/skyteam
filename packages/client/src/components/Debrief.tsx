import { useEffect, useState } from "react";
import type { Crew, RoomSnapshot } from "@skyteam/shared";
import { useGame } from "../store";
import { label } from "../util";
import { seatNames } from "./Seats";

const CREWS: Crew[] = ["pilot", "copilot"];

/**
 * Between rounds: the round that ended, who is ready, and the button to say
 * so (Ready, or Wait to take it back). When both are ready the server runs a
 * 3-2-1, shown here on its clock, then deals the next dice.
 */
export function DebriefPanel({ snapshot, onReady }: { snapshot: RoomSnapshot; onReady: (ready: boolean) => void }) {
  const debrief = snapshot.debrief!;
  const game = snapshot.game!;
  const names = seatNames(snapshot);
  const me: Crew | null = game.pilotId === snapshot.you.playerId ? "pilot" : game.copilotId === snapshot.you.playerId ? "copilot" : null;
  const left = useSecondsLeft(debrief.countdownEndsAt);
  // The reducer has already moved to the next round (its altitude, not yet dealt).
  const next = game.round;
  const landing = next >= game.scenario.rounds;

  return (
    <section className="debrief" aria-label="Between rounds">
      <h2 className="setup-label">Round {debrief.round} complete</h2>
      <p className="debrief-next">
        {landing
          ? "Final approach — the landing round is next."
          : `Descending to ${game.altitudeFeet.toLocaleString("en-US")} ft — round ${next} of ${game.scenario.rounds} next.`}
      </p>
      <ul className="debrief-crew">
        {CREWS.map((crew) => (
          <li key={crew} className={`${crew}${debrief.ready[crew] ? " is-ready" : ""}`}>
            {names[crew] ?? label(crew)} {debrief.ready[crew] ? "✓ ready" : "…"}
          </li>
        ))}
      </ul>
      {left !== null && (
        <p className="debrief-count" role="timer" aria-live="assertive">
          {left}
        </p>
      )}
      {me && (
        <button type="button" className={debrief.ready[me] ? "debrief-wait" : "debrief-ready"} onClick={() => onReady(!debrief.ready[me])}>
          {debrief.ready[me] ? "Wait" : `Ready for round ${next}`}
        </button>
      )}
    </section>
  );
}

/** Whole seconds until `endsAt` on the server's clock (3, 2, 1), or null when
 *  no countdown runs. Never below 1: the dice arrive as it would hit 0. */
function useSecondsLeft(endsAt: number | null): number | null {
  const offset = useGame((s) => s.clockOffset);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endsAt === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [endsAt]);
  if (endsAt === null) return null;
  return Math.max(1, Math.ceil((endsAt - (now + offset)) / 1000));
}
