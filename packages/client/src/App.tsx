import { useEffect, useRef, useState, type ReactNode } from "react";
import type { GameCommand, RoomSnapshot } from "@skyteam/shared";
import { createRoom, joinRoom } from "./api";
import { useGame } from "./store";

export function App() {
  const { snapshot, connected, lastError, connect, setReady, startGame, sendCommand } = useGame();
  const [room, setRoom] = useState<{ roomId: string; inviteCode: string } | null>(null);
  const [busy, setBusy] = useState(false);

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

  const onCreate = async () => {
    setBusy(true);
    try {
      const r = await createRoom();
      setRoom(r);
      connect(r.roomId);
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
        <button disabled={busy} onClick={onCreate}>
          Create a room
        </button>
        <p className="muted">Open an invite link to join an existing room.</p>
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
        <span className={`conn ${connected ? "on" : "off"}`}>
          {connected ? "● linked" : "○ reconnecting"}
        </span>
      </header>
      {lastError && <p className="error">{lastError}</p>}

      {!inGame && (
        <>
          <InviteBox url={inviteUrl} />
          <Seats snapshot={snapshot} />
          {snapshot &&
            snapshot.you.kind === "player" &&
            (snapshot.status === "lobby" || snapshot.status === "ready") && (
              <Lobby snapshot={snapshot} onReady={setReady} onStart={startGame} />
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

function InviteBox({ url }: { url: string }) {
  return (
    <div className="panel">
      <label>Invite link</label>
      <div className="row">
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <button onClick={() => navigator.clipboard?.writeText(url)}>Copy</button>
      </div>
    </div>
  );
}

function Seats({ snapshot }: { snapshot: RoomSnapshot | null }) {
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

function Lobby({
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

// --- Cockpit ----------------------------------------------------------------

type Crew = "pilot" | "copilot";
type Target = Extract<GameCommand, { type: "placeDie" }>["target"];

function Cockpit({
  snapshot,
  onCommand,
}: {
  snapshot: RoomSnapshot;
  onCommand: (command: GameCommand) => void;
}) {
  const game = snapshot.game!;
  const myCrew: Crew | null =
    game.pilotId === snapshot.you.playerId
      ? "pilot"
      : game.copilotId === snapshot.you.playerId
        ? "copilot"
        : null;
  const myTurn = myCrew !== null && game.turn === myCrew && game.phase === "placement";

  const [selected, setSelected] = useState<number | null>(null);
  const [coffeeDelta, setCoffeeDelta] = useState(0);

  const myDice = myCrew ? game.dice[myCrew] : [];
  const oppDice = myCrew ? game.dice[myCrew === "pilot" ? "copilot" : "pilot"] : [];
  const selDie = myDice.find((d) => d.id === selected && !d.placed);
  const selValue = selDie?.value !== undefined ? clamp(selDie.value + coffeeDelta, 1, 6) : null;

  const place = (target: Target) => {
    if (selected === null) return;
    onCommand({ type: "placeDie", dieId: selected, target, coffeeDelta: coffeeDelta || undefined });
    setSelected(null);
    setCoffeeDelta(0);
  };
  const reroll = () => {
    const ids = myDice.filter((d) => !d.placed).map((d) => d.id);
    if (ids.length) onCommand({ type: "reroll", dieIds: ids });
  };

  const airportIdx = game.scenario.approachTrack.findIndex((s) => s.airport);
  const can = (free: boolean) => myTurn && selected !== null && free;

  return (
    <div className="board">
      {/* Top instruments: altitude strip · cockpit window · axis dial */}
      <section className="instruments">
        <Altitude game={game} />
        <div className="axis-cluster">
          <Slot tone="blue" noSwitch taken={game.axis.pilot !== null} label={face(game.axis.pilot)} onClick={() => place({ kind: "axis" })} enabled={can(myCrew === "pilot" && game.axis.pilot === null)} />
          <Window offset={game.axis.offset} spinAt={game.scenario.axisSpinAt} outcome={game.outcome} />
          <Slot tone="orange" noSwitch taken={game.axis.copilot !== null} label={face(game.axis.copilot)} onClick={() => place({ kind: "axis" })} enabled={can(myCrew === "copilot" && game.axis.copilot === null)} />
        </div>
        <div className="instr-spacer" aria-hidden="true" />
      </section>

      <p className={`callout ${game.outcome ? (game.outcome.result === "won" ? "good" : "bad") : ""}`}>
        {game.outcome
          ? game.outcome.result === "won"
            ? "Smooth landing — the passengers applaud."
            : game.outcome.reason
          : myCrew
            ? myTurn
              ? "Your turn — choose a die, then a panel space."
              : `Silence. Waiting for the ${label(game.turn)}…`
            : "Spectating the approach."}
      </p>

      {/* Main deck */}
      <section className="deck">
        {/* Left rail: speed gauge + landing gear (blue, Pilot) */}
        <div className="rail">
          <SpeedGauge blue={game.aeroBlue} orange={game.aeroOrange} speed={game.lastSpeed} />
          <Module title="Landing Gear" tone="blue">
            <div className="slots-col">
              {game.gearGreen.map((green, i) => (
                <Slot
                  key={i}
                  tone="blue"
                  green={green}
                  taken={game.gearSlots[i]}
                  label={GEAR_LABEL[i]}
                  onClick={() => place({ kind: "landingGear", slot: i })}
                  enabled={can(myCrew === "pilot" && !game.gearSlots[i])}
                />
              ))}
            </div>
          </Module>
        </div>

        {/* Center panel */}
        <div className="center-panel material riveted">
          <Approach game={game} airportIdx={airportIdx} />

          <div className="mandatory-row">
            <Module title="Engines" mandatory tone="split">
              <div className="slots-row">
                <Slot tone="blue" noSwitch taken={game.engines.pilot !== null} label={face(game.engines.pilot)} onClick={() => place({ kind: "engine" })} enabled={can(myCrew === "pilot" && game.engines.pilot === null)} />
                <Slot tone="orange" noSwitch taken={game.engines.copilot !== null} label={face(game.engines.copilot)} onClick={() => place({ kind: "engine" })} enabled={can(myCrew === "copilot" && game.engines.copilot === null)} />
              </div>
            </Module>
          </div>

          <Module title="Radio" tone="split">
            <div className="slots-row">
              <Slot tone="blue" taken={game.radioPilotUsed} label="P" onClick={() => place({ kind: "radio", slot: 0 })} enabled={can(myCrew === "pilot" && !game.radioPilotUsed)} />
              {game.radioCopilotUsed.map((used, i) => (
                <Slot key={i} tone="orange" taken={used} label="C" onClick={() => place({ kind: "radio", slot: i })} enabled={can(myCrew === "copilot" && !used)} />
              ))}
            </div>
          </Module>

          <Module title="Brakes" tone="blue">
            <div className="slots-row brakes">
              {game.brakeSlots.map((taken, i) => (
                <Slot key={i} tone="blue" green={i < game.brakesDeployed} taken={taken} label={`${BRAKE_VAL[i]}`} onClick={() => place({ kind: "brakes", slot: i })} enabled={can(myCrew === "pilot" && !taken)} />
              ))}
            </div>
          </Module>

          <Module title="Concentration" tone="split">
            <div className="slots-row concentration">
              {game.concentrationSlots.map((taken, i) => (
                <Slot key={i} tone="neutral" taken={taken} label="☕" onClick={() => place({ kind: "concentration", slot: i })} enabled={can(!taken)} />
              ))}
              <span className="coffee-count" title="Coffee tokens">
                {"☕".repeat(game.coffee) || "—"}
              </span>
            </div>
          </Module>
        </div>

        {/* Right rail: flaps (orange, Co-Pilot) */}
        <div className="rail">
          <Module title="Flaps" tone="orange">
            <div className="slots-col">
              {game.flapsGreen.map((green, i) => (
                <Slot
                  key={i}
                  tone="orange"
                  green={green}
                  taken={game.flapSlots[i]}
                  label={FLAP_LABEL[i]}
                  onClick={() => place({ kind: "flaps", slot: i })}
                  enabled={can(myCrew === "copilot" && !game.flapSlots[i])}
                />
              ))}
            </div>
          </Module>
        </div>
      </section>

      {/* Dice tray + log */}
      <section className="tray">
        {myCrew && (
          <div className="hand">
            <label>
              Your dice ({label(myCrew)}){selValue !== null && ` — placing as ${selValue}`}
            </label>
            <div className="dice">
              {myDice.map((d) => (
                <button
                  key={d.id}
                  className={`die ${myCrew} ${selected === d.id ? "sel" : ""} ${d.placed ? "spent" : ""}`}
                  disabled={d.placed || !myTurn}
                  onClick={() => {
                    setSelected(d.id);
                    setCoffeeDelta(0);
                  }}
                >
                  {d.placed ? "" : (d.value ?? "")}
                </button>
              ))}
              <span className="opp">
                {label(myCrew === "pilot" ? "copilot" : "pilot")}:
                <span className="opp-dice">
                  {oppDice.map((d) => (
                    <span key={d.id} className={`die mini facedown ${d.placed ? "spent" : ""}`} />
                  ))}
                </span>
              </span>
            </div>
            <div className="controls">
              {game.coffee > 0 && selDie && (
                <span className="coffee-ctl">
                  <span className="muted">Coffee</span>
                  <button disabled={!selValue || selValue <= 1 || Math.abs(coffeeDelta - 1) > game.coffee} onClick={() => setCoffeeDelta((d) => d - 1)}>−1</button>
                  <b>{coffeeDelta > 0 ? `+${coffeeDelta}` : coffeeDelta}</b>
                  <button disabled={!selValue || selValue >= 6 || Math.abs(coffeeDelta + 1) > game.coffee} onClick={() => setCoffeeDelta((d) => d + 1)}>+1</button>
                </span>
              )}
              <button className="reroll" disabled={game.rerollTokens <= 0 || myDice.every((d) => d.placed)} onClick={reroll}>
                Reroll 🎲 ×{game.rerollTokens}
              </button>
            </div>
          </div>
        )}

        <ul className="log">
          {game.log.slice(-7).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// --- Regions ----------------------------------------------------------------

function Altitude({ game }: { game: NonNullable<RoomSnapshot["game"]> }) {
  const { rounds, startAltitudeFeet, feetPerRound, rerollRounds } = game.scenario;
  const rows = Array.from({ length: rounds }, (_, i) => i + 1);
  return (
    <div className="altitude riveted">
      <div className="alt-plane">✈</div>
      {rows.map((r) => {
        const feet = startAltitudeFeet - (r - 1) * feetPerRound;
        return (
          <div key={r} className={`alt-cell ${r === game.round ? "now" : ""} ${r === rounds ? "touchdown" : ""}`}>
            <span>{feet.toLocaleString()}</span>
            {rerollRounds.includes(r) && <span className="reroll-dot" title="Reroll token">⟳</span>}
          </div>
        );
      })}
    </div>
  );
}

// The cockpit window IS the axis indicator: the plane points straight up when
// level (offset 0) and banks with the tilt. Drawn as SVG so orientation doesn't
// depend on the system emoji font.
function Window({
  offset,
  spinAt,
  outcome,
}: {
  offset: number;
  spinAt: number;
  outcome: { result: string } | null;
}) {
  // Each axis step banks the plane STEP degrees, so the nose lines up with the
  // matching pip on the bank scale above the dial. 7 pips: a hollow centre mark,
  // four white dots, and a red ✕ at each outer (danger) limit.
  const STEP = 24;
  const bank = clamp(offset * STEP, -90, 90);
  const danger = Math.abs(offset) >= spinAt - 1;
  const R = 100; // pip arc radius from the 88px dial centre — just outside the rim
  const pips = [-3, -2, -1, 0, 1, 2, 3];
  return (
    <div className="window-wrap">
      <div className="bank-scale" aria-hidden="true">
        {pips.map((i) => {
          const kind = i === 0 ? "center" : Math.abs(i) === 3 ? "x" : "dot";
          const rad = (i * STEP * Math.PI) / 180;
          const x = 88 + R * Math.sin(rad);
          const y = 88 - R * Math.cos(rad);
          return (
            <span key={i} className={`pip pip--${kind}`} style={{ left: `${x}px`, top: `${y}px` }}>
              {kind === "x" ? "✕" : null}
            </span>
          );
        })}
      </div>
      <div className={`window ${outcome ? outcome.result : ""} ${danger ? "danger" : ""}`}>
        <div className="horizon" />
        <div className="pitch-ladder" aria-hidden="true">
          {[
            { d: 22, w: 60 }, // inner rung — longer
            { d: 36, w: 40 }, // outer rung — nearer the edge, shorter
          ].flatMap(({ d, w }) =>
            [-d, d].map((s) => (
              <span key={s} className="rung" style={{ top: `${50 + s}%`, width: `${w}px` }} />
            )),
          )}
        </div>
        <svg className="plane-svg" viewBox="0 0 100 100" style={{ transform: `rotate(${bank}deg)` }} aria-hidden="true">
          <path
            d="M50 5 L56 38 L94 60 L94 69 L56 56 L54 85 L68 93 L68 98 L50 91 L32 98 L32 93 L46 85 L44 56 L6 69 L6 60 L44 38 Z"
            fill="#f6f8f3"
            stroke="rgba(0,0,0,0.25)"
            strokeWidth="1.5"
          />
        </svg>
      </div>
    </div>
  );
}

function SpeedGauge({ blue, orange, speed }: { blue: number; orange: number; speed: number | null }) {
  const MIN = 2;
  const MAX = 13;
  const pct = (v: number) => `${((MAX - v) / (MAX - MIN)) * 100}%`;
  return (
    <div className="gauge">
      <span className="gauge-cap">Speed</span>
      <div className="gauge-body">
        <div className="gauge-scale">
          {[12, 10, 8, 6, 4, 2].map((n) => (
            <span key={n} style={{ top: pct(n) }}>
              {n}
            </span>
          ))}
        </div>
        <div className="gauge-bar">
          <div className="aero blue" style={{ top: pct(blue + 0.5) }} title={`Pilot marker (≤${blue} → 0)`}>
            <span className="aero-tag">P</span>
          </div>
          <div className="aero orange" style={{ top: pct(orange + 0.5) }} title={`Co-Pilot marker (>${orange} → 2)`}>
            <span className="aero-tag">C</span>
          </div>
          {speed !== null && <div className="needle" style={{ top: pct(speed) }} title={`Speed ${speed}`} />}
        </div>
      </div>
      <span className="gauge-foot">Speed {speed ?? "—"}</span>
    </div>
  );
}

function Approach({ game, airportIdx }: { game: NonNullable<RoomSnapshot["game"]>; airportIdx: number }) {
  return (
    <div className="approach">
      <span className="approach-tag">{game.scenario.name}</span>
      <div className="approach-track">
        {game.airplanes.map((planes, i) => (
          <div key={i} className={`appr-cell ${i === game.position ? "here" : ""} ${i === airportIdx ? "airport" : ""}`}>
            {i === game.position && <span className="me">✈</span>}
            {i === airportIdx && i !== game.position && <span className="rwy">🛬</span>}
            <span className="traffic">
              {Array.from({ length: planes }, (_, k) => (
                <span key={k} className="traffic-plane">
                  ✈
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Module({
  title,
  children,
  tone = "neutral",
  mandatory,
}: {
  title: string;
  children: ReactNode;
  tone?: "blue" | "orange" | "split" | "neutral";
  mandatory?: boolean;
}) {
  return (
    <div className={`module tone-${tone}`}>
      <span className="module-title">
        {title}
        {mandatory && <span className="req" title="Mandatory each round">⚠</span>}
      </span>
      {children}
    </div>
  );
}

function Slot({
  taken,
  green,
  tone,
  label,
  onClick,
  enabled,
  noSwitch,
}: {
  taken: boolean;
  green?: boolean;
  tone: "blue" | "orange" | "neutral";
  label: string;
  onClick: () => void;
  enabled: boolean;
  noSwitch?: boolean;
}) {
  return (
    <button
      className={`slot ${tone} ${green ? "green" : ""} ${taken ? "taken" : ""} ${enabled ? "open" : ""} ${noSwitch ? "dice" : ""}`}
      disabled={!enabled}
      onClick={onClick}
    >
      <span className="slot-face">{green ? "" : label}</span>
      {!noSwitch && <span className="switch" />}
    </button>
  );
}

const GEAR_LABEL = ["1/2", "3/4", "5/6"];
const FLAP_LABEL = ["1/2", "2/3", "3/4", "4/5"];
const BRAKE_VAL = [2, 4, 6];

function label(crew: Crew): string {
  return crew === "pilot" ? "Pilot" : "Co-Pilot";
}
function face(v: number | null): string {
  return v === null ? "" : String(v);
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
