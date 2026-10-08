import { useCallback, useEffect, useMemo, useState } from "react";
import { replaySteps, type DieValue, type GameRecord, type GameSetup, type GameState, type ReplayStep, type RoomSnapshot } from "@skyteam/shared";
import { call } from "../account/authApi";
import { Cockpit } from "../components/Cockpit";
import { Link } from "../router";
import { RESULT_LABELS, airportName, extrasOf, when } from "./format";

/**
 * A logged game's page — anyone with the link may open it: what was flown, by
 * whom, how it ended, and the game replayed move by move in the cockpit (as an
 * onlooker sees it, so nothing can be played).
 */
export default function GamePage({ id }: { id: string }) {
  const [record, setRecord] = useState<GameRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void call<GameRecord>("GET", `/games/${encodeURIComponent(id)}`).then((r) => {
      if (!live) return;
      if (r.ok) setRecord(r);
      else setError(r.status === 404 ? "No game with that id." : r.error);
    });
    return () => {
      live = false;
    };
  }, [id]);

  return (
    <main className="stage replay-page">
      <header className="topbar">
        <Link to="/" className="wordmark home-link">
          SKY&middot;TEAM
        </Link>
        <nav className="page-links">
          <Link to="/history">My games</Link>
        </nav>
      </header>
      {error && <p className="notice">{error}</p>}
      {record && <Replay record={record} />}
    </main>
  );
}

function Replay({ record }: { record: GameRecord }) {
  const steps = useMemo((): ReplayStep[] | Error => {
    try {
      const header = { format: record.format, setup: record.setup as GameSetup, internTokens: record.internTokens as DieValue[] };
      const out = replaySteps(header, record.moves);
      return out.length ? out : new Error("empty");
    } catch (e) {
      return e as Error;
    }
  }, [record]);

  return (
    <>
      <section className="panel replay-head">
        <h2 className="setup-label">
          {airportName(record.setup.scenarioId, record.setup.modules, record.setup.abilities)}
        </h2>
        {extrasOf(record.setup.modules, record.setup.abilities) && <p className="muted">{extrasOf(record.setup.modules, record.setup.abilities)}</p>}
        <p>
          <strong>Pilot:</strong> {record.crews.pilot} · <strong>Co-Pilot:</strong> {record.crews.copilot}
        </p>
        <p>
          {RESULT_LABELS[record.result] ?? record.result}
          {record.lossReason ? ` — ${record.lossReason}` : ""} · {when(record.endedAt)}
          {record.seededFrom && (
            <>
              {" "}
              · <span className="tag">same dice</span> as <Link to={`/games/${record.seededFrom}`}>an earlier game</Link>
            </>
          )}
        </p>
      </section>
      {steps instanceof Error ? (
        <section className="panel">
          <p>This game can't be replayed by this version.</p>
          <details>
            <summary>The moves</summary>
            <code className="raw-moves">{record.moves}</code>
          </details>
        </section>
      ) : (
        <Stepper record={record} steps={steps} />
      )}
    </>
  );
}

/** The cockpit at one step, with the controls to move through the game. */
function Stepper({ record, steps }: { record: GameRecord; steps: ReplayStep[] }) {
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const last = steps.length - 1;

  // The round each step belongs to: a deal (D) starts the next one.
  const rounds = useMemo(() => {
    let r = 0;
    return steps.map((s) => (s.token.startsWith("D") ? ++r : r));
  }, [steps]);
  const deals = useMemo(() => steps.flatMap((s, i) => (s.token.startsWith("D") ? [i] : [])), [steps]);

  const go = useCallback((i: number) => setAt(Math.max(0, Math.min(last, i))), [last]);
  const nextRound = useCallback(() => setAt((i) => deals.find((d) => d > i) ?? last), [deals, last]);
  const prevRound = useCallback(() => setAt((i) => [...deals].reverse().find((d) => d < i) ?? 0), [deals]);

  // Play: a move every 700 ms, until the end or Pause.
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setAt((i) => (i >= last ? i : i + 1)), 700);
    return () => clearInterval(t);
  }, [playing, last]);
  useEffect(() => {
    if (at >= last) setPlaying(false);
  }, [at, last]);

  // Keys: ← → a move, with Shift a round; Space plays or pauses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (e.key === "ArrowRight") e.shiftKey ? nextRound() : setAt((i) => Math.min(last, i + 1));
      else if (e.key === "ArrowLeft") e.shiftKey ? prevRound() : setAt((i) => Math.max(0, i - 1));
      else if (e.key === " ") setPlaying((p) => !p);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [last, nextRound, prevRound]);

  const snapshot = replaySnapshot(record, steps[at].state, at);
  return (
    <>
      <div className="panel replay-controls" role="toolbar" aria-label="Replay">
        <div className="row">
          <button aria-label="First move" onClick={() => go(0)} disabled={at === 0}>⏮</button>
          <button aria-label="Previous round" onClick={prevRound} disabled={at === 0}>⏪</button>
          <button aria-label="Previous move" onClick={() => go(at - 1)} disabled={at === 0}>◀</button>
          <button aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying(!playing)} disabled={!playing && at === last}>
            {playing ? "⏸" : "▶"}
          </button>
          <button aria-label="Next move" onClick={() => go(at + 1)} disabled={at === last}>▶|</button>
          <button aria-label="Next round" onClick={nextRound} disabled={at === last}>⏩</button>
          <button aria-label="Last move" onClick={() => go(last)} disabled={at === last}>⏭</button>
        </div>
        <input
          type="range"
          aria-label="Move"
          min={0}
          max={last}
          value={at}
          onChange={(e) => go(Number(e.target.value))}
        />
        <p className="replay-pos">{`Round ${rounds[at]} · move ${at + 1} of ${steps.length}`}</p>
      </div>
      <Cockpit snapshot={snapshot} onCommand={() => {}} />
    </>
  );
}

/** The room as an onlooker would have seen it at this step: the crews named,
 *  every die showing, no clock running. */
function replaySnapshot(record: GameRecord, game: GameState, version: number): RoomSnapshot {
  const seat = (crew: "pilot" | "copilot", role: "host" | "guest") => ({
    playerId: crew,
    role,
    ready: true,
    connection: "connected" as const,
    name: record.crews[crew],
  });
  return {
    roomId: "replay",
    inviteCode: "",
    status: game.outcome ? "finished" : "in_progress",
    hostPlayerId: "pilot",
    seats: [seat("pilot", "host"), seat("copilot", "guest")],
    hostCrew: "pilot",
    observerCount: 0,
    setup: record.setup as GameSetup,
    version,
    game: { ...game, timerEndsAt: null, timerRemainingMs: null },
    notice: null,
    chat: [],
    debrief: null,
    you: { playerId: "replay-viewer", kind: "observer" },
    serverTime: Date.now(),
  };
}
