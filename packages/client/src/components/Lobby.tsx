import type { RoomSnapshot } from "@skyteam/shared";

export function Lobby({
  snapshot,
  onReady,
  onStart,
}: {
  snapshot: RoomSnapshot;
  onReady: (ready: boolean) => void;
  onStart: () => void;
}) {
  const me = snapshot.seats.find((s) => s.playerId === snapshot.you.playerId);
  const isHost = snapshot.hostPlayerId === snapshot.you.playerId;
  const canStart = isHost && snapshot.status === "ready";
  return (
    <div className="panel">
      <button onClick={() => onReady(!me?.ready)}>{me?.ready ? "Unready" : "Ready up"}</button>
      {isHost && (
        <button disabled={!canStart} onClick={onStart}>
          Start game
        </button>
      )}
      {isHost && !canStart && <p className="muted">Both players must be ready to start.</p>}
    </div>
  );
}
