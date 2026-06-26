import type { RoomSnapshot } from "@skyteam/shared";

export function Seats({ snapshot }: { snapshot: RoomSnapshot | null }) {
  if (!snapshot) return null;
  return (
    <div className="panel">
      <label>Crew</label>
      <ul className="seats">
        {snapshot.seats.map((s) => (
          <li key={s.playerId}>
            <span>
              {s.role === "host" ? "👑 " : ""}
              {s.playerId.slice(0, 6)}
              {s.playerId === snapshot.you.playerId ? " (you)" : ""}
            </span>
            <span>
              {s.connection === "connected" ? "🟢" : "🔴"} {s.ready ? "ready" : "…"}
            </span>
          </li>
        ))}
        {snapshot.seats.length < 2 && <li className="muted">Waiting for a second player…</li>}
      </ul>
      {snapshot.observerCount > 0 && <p className="muted">{snapshot.observerCount} watching</p>}
    </div>
  );
}
