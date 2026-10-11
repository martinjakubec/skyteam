import { useRegisterSW } from "virtual:pwa-register/react";
import { useGame } from "../store";

/** How often an open app asks whether a new version is out. */
const CHECK_EVERY = 60 * 60 * 1000;

/**
 * A new version of the app is ready (its service worker is waiting): offer a
 * Reload, but never while a game is on, since reloading would cut it short.
 * Out of a game the room comes back after the reload (the ?join= in the URL).
 */
export function UpdateBar() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (registration) setInterval(() => void registration.update(), CHECK_EVERY);
    },
  });
  const inGame = useGame((s) => s.snapshot?.status === "in_progress");
  if (!needRefresh || inGame) return null;
  return (
    <div className="app-bar" role="status" aria-label="New version">
      <span>A new version of SkyTeam is ready.</span>
      <button className="primary" onClick={() => void updateServiceWorker(true)}>
        Reload
      </button>
    </div>
  );
}
