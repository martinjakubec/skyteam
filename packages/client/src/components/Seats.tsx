import { BOT_LEVEL_LABELS, type RoomSnapshot } from "@skyteam/shared";

export function Seats({ snapshot }: { snapshot: RoomSnapshot | null }) {
  if (!snapshot) return null;
  return (
    <div className="panel">
      <label>Crew</label>
      <ul className="seats">
        {snapshot.seats.map((s) => {
          // The host flies `hostCrew`; the guest flies the other seat.
          const crew = (s.role === "host") === (snapshot.hostCrew === "pilot") ? "Pilot" : "Co-Pilot";
          return (
            <li key={s.playerId}>
              <span>
                {crew}: {s.role === "host" ? "👑 " : ""}
                {s.bot ? `🤖 ${BOT_LEVEL_LABELS[s.bot]}` : s.playerId.slice(0, 6)}
                {s.playerId === snapshot.you.playerId ? " (you)" : ""}
              </span>
              <span>
                {s.connection === "connected" ? "🟢" : "🔴"} {s.ready ? "ready" : "…"}
              </span>
            </li>
          );
        })}
        {snapshot.seats.length < 2 && <li className="muted">Waiting for a second player…</li>}
      </ul>
      {snapshot.observerCount > 0 && <p className="muted">{snapshot.observerCount} watching</p>}
    </div>
  );
}
