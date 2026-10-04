import { BOT_LEVELS, BOT_LEVEL_LABELS, type BotLevel, type Crew } from "@skyteam/shared";
import { useEffect, useRef, useState } from "react";
import { createRoom, joinRoom } from "./api";
import { useGame } from "./store";
import { Cockpit } from "./components/Cockpit";
import { InviteBox } from "./components/InviteBox";
import { Lobby } from "./components/Lobby";
import { Seats } from "./components/Seats";
import { TutorialModal } from "./components/TutorialModal";

/** What each bot level plays like. */
const BOT_LEVEL_BLURBS: Record<BotLevel, string> = {
  cadet: "learning the ropes",
  navigator: "steady and sensible",
  aviator: "plans every die",
};

export function App() {
  const { snapshot, connected, lastError, connect, setReady, setName, setSetup, startGame, resetGame, exitGame, sendCommand } =
    useGame();
  const [room, setRoom] = useState<{ roomId: string; inviteCode: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [howToPlay, setHowToPlay] = useState(false);

  // Auto-join when opened via an invite link: /?join=<inviteCode>
  // The ref guard makes this run exactly once: React StrictMode double-invokes
  // effects in dev, and two concurrent joinRoom() calls (each with no token yet)
  // would mint two identities — the second arriving to a full room as an
  // observer. Setting the flag synchronously, before the await, prevents that.
  const joinStarted = useRef(false);
  useEffect(() => {
    if (joinStarted.current) return;
    const code = new URLSearchParams(window.location.search).get("join");
    if (!code) return;
    joinStarted.current = true;
    setBusy(true);
    joinRoom(code)
      .then((r) => {
        setRoom(r);
        connect(r.roomId);
      })
      .catch((e: Error) => alert(e.message))
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [soloCrew, setSoloCrew] = useState<Crew>("pilot");
  const [soloLevel, setSoloLevel] = useState<BotLevel>("navigator");

  const onCreate = async (solo?: { crew: Crew; level: BotLevel }) => {
    setBusy(true);
    try {
      const r = await createRoom(solo);
      setRoom(r);
      connect(r.roomId);
      // Put the room in the URL so a refresh re-enters it via the auto-join path
      // below (the per-tab token reconnects the host to their existing seat).
      window.history.replaceState(null, "", `?join=${r.inviteCode}`);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!room) {
    return (
      <main className="center">
        <h1 className="wordmark">SKY&middot;TEAM</h1>
        <p className="muted">Land the plane together. One Pilot, one Co-Pilot, no talking.</p>
        <button disabled={busy} onClick={() => onCreate()}>
          Create a room
        </button>
        <p className="muted">Open an invite link to join an existing room.</p>
        <section className="panel solo">
          <h2 className="setup-label">Play solo</h2>
          <p className="muted">A bot flies the other seat.</p>
          <fieldset className="solo-options">
            <legend className="setup-label">Your seat</legend>
            {(["pilot", "copilot"] as const).map((crew) => (
              <label key={crew}>
                <input type="radio" name="solo-crew" checked={soloCrew === crew} onChange={() => setSoloCrew(crew)} />
                {crew === "pilot" ? "Pilot" : "Co-Pilot"}
              </label>
            ))}
          </fieldset>
          <fieldset className="solo-options">
            <legend className="setup-label">The bot</legend>
            {BOT_LEVELS.map((level) => (
              <label key={level}>
                <input type="radio" name="solo-level" checked={soloLevel === level} onChange={() => setSoloLevel(level)} />
                <span>
                  {BOT_LEVEL_LABELS[level]} <span className="muted">— {BOT_LEVEL_BLURBS[level]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <button disabled={busy} onClick={() => onCreate({ crew: soloCrew, level: soloLevel })}>
            Play solo
          </button>
        </section>
        <button className="how-to-play" onClick={() => setHowToPlay(true)}>
          How to play
        </button>
        {howToPlay && <TutorialModal id="basics" onClose={() => setHowToPlay(false)} />}
      </main>
    );
  }

  const inGame =
    (snapshot?.status === "in_progress" || snapshot?.status === "finished") && snapshot.game;
  const inviteUrl = `${window.location.origin}/?join=${room.inviteCode}`;

  return (
    <main className={inGame ? "stage" : "center"}>
      <header className="topbar">
        <h1 className="wordmark">SKY&middot;TEAM</h1>
        <div className="topbar-right">
          <span className={`conn ${connected ? "on" : "off"}`}>
            {connected ? "● linked" : "○ reconnecting"}
          </span>
          {inGame && snapshot?.you.kind === "player" && (
            <button
              className="reset-btn exit-btn"
              onClick={() => {
                if (window.confirm("End the game and return both players to the lobby? All progress will be lost."))
                  exitGame();
              }}
            >
              Exit to lobby
            </button>
          )}
          {inGame && snapshot?.hostPlayerId === snapshot?.you.playerId && (
            <button
              className="reset-btn"
              onClick={() => {
                if (window.confirm("Reset the game back to the start? All progress will be lost."))
                  resetGame();
              }}
            >
              Reset game
            </button>
          )}
        </div>
      </header>
      {lastError && <p className="error">{lastError}</p>}

      {!inGame && (
        <>
          {/* A solo room's other seat is the bot: nobody to invite. */}
          {!snapshot?.seats.some((s) => s.bot) && <InviteBox url={inviteUrl} />}
          {snapshot?.notice && <p className="notice">{snapshot.notice}</p>}
          <Seats snapshot={snapshot} />
          {snapshot &&
            snapshot.you.kind === "player" &&
            (snapshot.status === "lobby" || snapshot.status === "ready") && (
              <Lobby snapshot={snapshot} onReady={setReady} onName={setName} onSetup={setSetup} onStart={startGame} />
            )}
        </>
      )}

      {inGame && <Cockpit snapshot={snapshot} onCommand={sendCommand} />}

      {snapshot?.status === "abandoned" && (
        <p className="error">A player left and didn't return in time — the game was abandoned.</p>
      )}
    </main>
  );
}
