import { useEffect, useState } from "react";

/** The game is played on the server: say so when the connection is gone. */
export function OfflineBar() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  if (online) return null;
  return (
    <div className="app-bar offline" role="status" aria-label="Offline">
      You're offline. SkyTeam needs a connection to play.
    </div>
  );
}
