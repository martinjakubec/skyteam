import { type Crew } from "@skyteam/shared";
import { useEffect, useRef, useState } from "react";
import { createRoom, joinRoom, ServerUnavailableError } from "./api";
import { useGame } from "./store";
import { Cockpit } from "./components/Cockpit";
import { InviteBox } from "./components/InviteBox";
import { Lobby } from "./components/Lobby";
import { CrewChat } from "./components/FlightLog";
import { DebriefPanel } from "./components/Debrief";
import { Seats } from "./components/Seats";
import { ServerDown } from "./components/ServerDown";
import { TutorialModal } from "./components/TutorialModal";
import { AccountChip } from "./account/AccountChip";

export function App() {
  const {
    snapshot,
    connected,
    lastError,
    serverDown,
    serverIsDown,
    connect,
    setReady,
    setName,
    setSetup,
    freshDice,
    startGame,
    resetGame,
    exitGame,
    sendCommand,
    setRoundReady,
  } = useGame();
  const [room, setRoom] = useState<{ roomId: string; inviteCode: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [howToPlay, setHowToPlay] = useState(false);

  /** A request the server refused: the 500 page if its storage is down, else an alert. */
  const failed = (e: unknown) => (e instanceof ServerUnavailableError ? serverIsDown() : alert((e as Error).message));

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
      .catch(failed)
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [soloCrew, setSoloCrew] = useState<Crew>("pilot");

  const onCreate = async (solo?: { crew: Crew }) => {
    setBusy(true);
    try {
      const r = await createRoom(solo);
      setRoom(r);
      connect(r.roomId);
      // Put the room in the URL so a refresh re-enters it via the auto-join path
      // below (the per-tab token reconnects the host to their existing seat).
      window.history.replaceState(null, "", `?join=${r.inviteCode}`);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  if (serverDown) return <ServerDown />;

  if (!room) {
    return (
      <main className="center">
        <nav className="account-bar">
          <AccountChip />
        </nav>
        <h1 className="wordmark">SKY&middot;TEAM</h1>
        <p className="muted">Land the plane together. One Pilot, one Co-Pilot, no talking.</p>
        <button disabled={busy} onClick={() => onCreate()}>
          Create a room
        </button>
        <p className="muted">Open an invite link to join an existing room.</p>
        <section className="panel solo">
          <h2 className="setup-label">Play solo</h2>
          <p className="muted">The Aviator bot flies the other seat.</p>
          <fieldset className="solo-options">
            <legend className="setup-label">Your seat</legend>
            {(["pilot", "copilot"] as const).map((crew) => (
              <label key={crew}>
                <input type="radio" name="solo-crew" checked={soloCrew === crew} onChange={() => setSoloCrew(crew)} />
                {crew === "pilot" ? "Pilot" : "Co-Pilot"}
              </label>
            ))}
          </fieldset>
          <button disabled={busy} onClick={() => onCreate({ crew: soloCrew })}>
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
  const solo = !!snapshot?.seats.some((s) => s.bot);
  const inLobby = snapshot?.you.kind === "player" && (snapshot.status === "lobby" || snapshot.status === "ready");
  const chat = inLobby && !solo;

  return (
    <main className={inGame ? "stage" : chat ? "center wide" : "center"}>
      <header className="topbar">
        <h1 className="wordmark">SKY&middot;TEAM</h1>
        <div className="topbar-right">
          {/* In a room the account pages open in a new tab: the game here goes on. */}
          {!inGame && <AccountChip newTab />}
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
        <div className={chat ? "lobby-layout with-log" : "lobby-layout"}>
          <div className="lobby-col">
            {/* A solo room's other seat is the bot: nobody to invite. */}
            {!solo && <InviteBox url={inviteUrl} />}
            {snapshot?.notice && <p className="notice">{snapshot.notice}</p>}
            <Seats snapshot={snapshot} />
            {snapshot && inLobby && (
              <Lobby snapshot={snapshot} onReady={setReady} onName={setName} onSetup={setSetup} onStart={startGame} onFreshDice={freshDice} />
            )}
          </div>
          {/* The crew's chat — not in a solo room: the bot doesn't talk. */}
          {snapshot && chat && <CrewChat snapshot={snapshot} />}
        </div>
      )}

      {inGame && (
        <Cockpit
          snapshot={snapshot}
          onCommand={sendCommand}
          between={
            snapshot.debrief && (
              <div className="between">
                <DebriefPanel snapshot={snapshot} onReady={setRoundReady} />
                {/* Talk it over — the crew only, and not with the bot. */}
                {snapshot.you.kind === "player" && !solo && <CrewChat snapshot={snapshot} />}
              </div>
            )
          }
        />
      )}

      {snapshot?.status === "abandoned" && (
        <p className="error">A player left and didn't return in time — the game was abandoned.</p>
      )}
    </main>
  );
}
