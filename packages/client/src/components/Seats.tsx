import { BOT_LEVEL_LABELS, crewNames, type Crew, type RoomSnapshot, type SeatView } from "@skyteam/shared";

/** The crew a seat flies: the host flies `hostCrew`, the guest the other. */
export function seatCrew(snapshot: RoomSnapshot, seat: SeatView): Crew {
  return (seat.role === "host") === (snapshot.hostCrew === "pilot") ? "pilot" : "copilot";
}

/** Each crew's on-screen name (null where its player chose none). A bot is
 *  called by its level, so a human named the same is told apart by seat too. */
export function seatNames(snapshot: RoomSnapshot): Record<Crew, string | null> {
  const nameOf = (crew: Crew) => {
    const seat = snapshot.seats.find((s) => seatCrew(snapshot, s) === crew);
    return seat?.bot ? `🤖 ${BOT_LEVEL_LABELS[seat.bot]}` : seat?.name;
  };
  return crewNames({ pilot: nameOf("pilot"), copilot: nameOf("copilot") });
}

export function Seats({ snapshot }: { snapshot: RoomSnapshot | null }) {
  if (!snapshot) return null;
  const names = seatNames(snapshot);
  return (
    <div className="panel">
      <label>Crew</label>
      <ul className="seats">
        {snapshot.seats.map((s) => {
          const crew = seatCrew(snapshot, s);
          return (
            <li key={s.playerId}>
              <span>
                {crew === "pilot" ? "Pilot" : "Co-Pilot"}: {s.role === "host" ? "👑 " : ""}
                {names[crew] ?? s.playerId.slice(0, 6)}
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
