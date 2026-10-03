import { useEffect, useState } from "react";
import { REAL_TIME_SECONDS } from "@skyteam/shared";

/**
 * Real-Time module (advanced): the round's countdown, as a track under the
 * Altitude. The server owns the clock; `endsAt` is in server time, so
 * `clockOffset` (server − local) maps it onto this device's clock.
 *
 * Running: the bar drains, amber under 20s, red and pulsing under 10s.
 * Paused (a seat disconnected): frozen at `remainingMs`. Idle (between rounds
 * or after the game): full and dimmed.
 */
export function RealTime({
  endsAt,
  remainingMs,
  clockOffset = 0,
  pausedNote,
  seconds = REAL_TIME_SECONDS,
}: {
  endsAt: number | null;
  remainingMs: number | null;
  clockOffset?: number;
  pausedNote?: string;
  /** The round's length (the game's scenario may shorten it). */
  seconds?: number;
}) {
  const TOTAL_MS = seconds * 1000;
  const running = endsAt !== null;
  const [now, setNow] = useState(() => Date.now());
  // Redraw every frame while running so the bar drains smoothly.
  useEffect(() => {
    if (!running) return;
    let id = 0;
    const tick = () => {
      setNow(Date.now());
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [running]);

  const left = running
    ? Math.max(0, endsAt - (now + clockOffset))
    : remainingMs ?? TOTAL_MS;
  const paused = !running && remainingMs !== null;
  const idle = !running && !paused;
  const secs = Math.ceil(left / 1000);
  const level = idle ? "idle" : paused ? "paused" : secs <= 10 ? "critical" : secs <= 20 ? "low" : "ok";

  return (
    <div className={`approach realtime ${level}`}>
      <span className="approach-tag rt-tag">Real-Time ⏱</span>
      <div className="approach-track rt-track" role="timer" aria-label={`${secs} seconds left`}>
        <div className="rt-bar" style={{ width: `${(100 * left) / TOTAL_MS}%` }} />
        <span className="rt-text">
          {paused ? `Paused · ${secs}s${pausedNote ? ` — ${pausedNote}` : ""}` : `${secs}s`}
        </span>
      </div>
    </div>
  );
}
