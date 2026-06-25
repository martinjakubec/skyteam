import { useEffect, useRef, useState, type ReactNode } from "react";
import type { GameCommand, RoomSnapshot } from "@skyteam/shared";
import { createRoom, joinRoom } from "./api";
import { useGame } from "./store";

export function App() {
  const { snapshot, connected, lastError, connect, setReady, startGame, resetGame, sendCommand } =
    useGame();
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
        <div className="topbar-right">
          <span className={`conn ${connected ? "on" : "off"}`}>
            {connected ? "● linked" : "○ reconnecting"}
          </span>
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
  // Reroll is a two-step handshake. `rerollMode` = I (the active player) clicked
  // Reroll and am choosing which of my dice to reroll. `rerollPick` holds the ids
  // I've toggled. The other player's prompt is driven by `game.pendingReroll`.
  const [rerollMode, setRerollMode] = useState(false);
  const [rerollPick, setRerollPick] = useState<number[]>([]);

  const myDice = myCrew ? game.dice[myCrew] : [];
  const oppDice = myCrew ? game.dice[myCrew === "pilot" ? "copilot" : "pilot"] : [];
  const selDie = myDice.find((d) => d.id === selected && !d.placed);
  const selValue = selDie?.value !== undefined ? clamp(selDie.value + coffeeDelta, 1, 6) : null;

  // The server prompts the *other* crew via pendingReroll. iMustRespond = it's my
  // turn to reroll-or-decline; waitingForReroll = I initiated and am waiting.
  const iMustRespond = myCrew !== null && game.pendingReroll === myCrew;
  const waitingForReroll = game.pendingReroll !== null && game.pendingReroll !== myCrew;
  // The dice tray is in pick-toggle mode when I'm choosing dice for a reroll.
  const rerollActive = (rerollMode && myTurn) || iMustRespond;

  // Drop any local reroll UI when the reroll context changes server-side
  // (initiated, resolved, or a new round dealt) so stale picks never linger.
  useEffect(() => {
    setRerollMode(false);
    setRerollPick([]);
  }, [game.pendingReroll, game.round]);

  const place = (target: Target) => {
    if (selected === null) return;
    onCommand({ type: "placeDie", dieId: selected, target, coffeeDelta: coffeeDelta || undefined });
    setSelected(null);
    setCoffeeDelta(0);
  };
  const startReroll = () => {
    setSelected(null);
    setCoffeeDelta(0);
    setRerollPick([]);
    setRerollMode(true);
  };
  const toggleRerollDie = (id: number) =>
    setRerollPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const confirmReroll = () => {
    onCommand({ type: "reroll", dieIds: rerollPick });
    setRerollMode(false);
    setRerollPick([]);
  };
  const cancelReroll = () => {
    setRerollMode(false);
    setRerollPick([]);
  };

  const airportIdx = game.scenario.approachTrack.findIndex((s) => s.airport);
  // Flaps deploy strictly in order: only the first undeployed section is legal.
  const nextFlap = game.flapsGreen.findIndex((g) => !g);

  // --- Drag-and-drop: grab a die, drop it onto a space, snap back otherwise ---
  const [dragging, setDragging] = useState(false);
  const [drag, setDrag] = useState<{ dieId: number; value: number; crew: Crew; x: number; y: number } | null>(null);

  // A panel space is a live drop/click target when it's my turn, the space is
  // free, and I'm either holding a selected die or mid-drag.
  const can = (free: boolean) =>
    myTurn && (selected !== null || dragging) && free && game.pendingReroll === null && !rerollMode;

  // The value of the die currently in hand (dragged or selected, Coffee applied).
  // Spaces with a number requirement only light up when this value fits them.
  const activeValue = drag ? drag.value : selValue;
  const valOk = (allowed: number[]) => activeValue === null || allowed.includes(activeValue);

  const gesture = useRef<null | {
    dieId: number;
    crew: Crew;
    startX: number;
    startY: number;
    active: boolean;
    value: number;
    coffee: number;
  }>(null);
  // A glowing ring rendered over whichever valid space the die is hovering, so
  // it reads as "about to click in here". Rect-based and React-controlled.
  const [hoverRect, setHoverRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  const validSlotUnder = (x: number, y: number): HTMLElement | null => {
    const slot = (document.elementFromPoint(x, y) as Element | null)?.closest(".slot") as HTMLElement | null;
    return slot?.dataset.open === "1" ? slot : null;
  };

  const onDragMove = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (!g.active && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 6) return;
    if (!g.active) {
      g.active = true;
      setDragging(true);
    }
    const slot = validSlotUnder(e.clientX, e.clientY);
    const r = slot?.getBoundingClientRect();
    setHoverRect(r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null);
    setDrag({ dieId: g.dieId, value: g.value, crew: g.crew, x: e.clientX, y: e.clientY });
  };
  const onDragEnd = (e: PointerEvent) => {
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    const g = gesture.current;
    gesture.current = null;
    setHoverRect(null);
    setDrag(null);
    setDragging(false);
    if (!g) return;
    if (!g.active) {
      // No real drag — treat as a tap: select the die (reveals Coffee controls).
      setSelected(g.dieId);
      setCoffeeDelta(0);
      return;
    }
    const slot = validSlotUnder(e.clientX, e.clientY);
    if (slot?.dataset.target) {
      const target = JSON.parse(slot.dataset.target) as Target;
      onCommand({ type: "placeDie", dieId: g.dieId, target, coffeeDelta: g.coffee || undefined });
      setSelected(null);
      setCoffeeDelta(0);
    } else {
      setSelected(null); // dropped nowhere valid — the die stays put in the tray
    }
  };
  const startDrag = (e: React.PointerEvent, die: { id: number; value?: number; placed?: boolean }) => {
    if (die.placed || !myTurn || !myCrew || game.pendingReroll !== null || rerollMode) return;
    e.preventDefault();
    const base = die.value ?? 1;
    const coffee = selected === die.id ? coffeeDelta : 0;
    gesture.current = {
      dieId: die.id,
      crew: myCrew,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      value: clamp(base + coffee, 1, 6),
      coffee,
    };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
  };

  return (
    <div className="board">
      {/* Top instruments: altitude strip · cockpit window · axis dial */}
      <section className="instruments">
        <Altitude game={game} />
        <div className="dial-stack">
          <div className="axis-cluster">
            <Slot tone="blue" noSwitch dice target={{ kind: "axis" }} taken={game.axis.pilot !== null} label={face(game.axis.pilot)} onClick={() => place({ kind: "axis" })} enabled={can(myCrew === "pilot" && game.axis.pilot === null)} />
            <Window offset={game.axis.offset} spinAt={game.scenario.axisSpinAt} outcome={game.outcome} />
            <Slot tone="orange" noSwitch dice target={{ kind: "axis" }} taken={game.axis.copilot !== null} label={face(game.axis.copilot)} onClick={() => place({ kind: "axis" })} enabled={can(myCrew === "copilot" && game.axis.copilot === null)} />
          </div>
          <SpeedGauge blue={game.aeroBlue} orange={game.aeroOrange} speed={game.lastSpeed} />
        </div>
        <div className="instr-spacer" aria-hidden="true" />
      </section>

      <p className={`callout ${game.outcome ? (game.outcome.result === "won" ? "good" : "bad") : ""}`}>
        {game.outcome
          ? game.outcome.result === "won"
            ? "Smooth landing — the passengers applaud."
            : game.outcome.reason
          : waitingForReroll
            ? `Reroll — waiting for the ${label(game.pendingReroll!)} to pick dice…`
            : iMustRespond
              ? "Reroll offered — pick any of your dice to reroll, or Skip."
              : myCrew
                ? myTurn
                  ? rerollMode
                    ? "Reroll — pick the dice to reroll, then Confirm."
                    : "Your turn — drag a die onto a panel space."
                  : `Silence. Waiting for the ${label(game.turn)}…`
                : "Spectating the approach."}
      </p>

      {/* Main deck */}
      <section className="deck">
        {/* Left rail: landing gear (blue, Pilot) */}
        <div className="rail">
          <Module title="Landing Gear" tone="blue">
            <div className="slots-col">
              {game.gearGreen.map((green, i) => (
                <Slot
                  key={i}
                  tone="blue"
                  green={green}
                  target={{ kind: "landingGear", slot: i }}
                  taken={game.gearSlots[i] !== null}
                  held={game.gearSlots[i]}
                  label={GEAR_LABEL[i]}
                  onClick={() => place({ kind: "landingGear", slot: i })}
                  enabled={can(myCrew === "pilot" && !game.gearGreen[i]) && valOk(GEAR_RANGES[i])}
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
                <Slot tone="blue" noSwitch dice target={{ kind: "engine" }} taken={game.engines.pilot !== null} label={face(game.engines.pilot)} onClick={() => place({ kind: "engine" })} enabled={can(myCrew === "pilot" && game.engines.pilot === null)} />
                <Slot tone="orange" noSwitch dice target={{ kind: "engine" }} taken={game.engines.copilot !== null} label={face(game.engines.copilot)} onClick={() => place({ kind: "engine" })} enabled={can(myCrew === "copilot" && game.engines.copilot === null)} />
              </div>
            </Module>
          </div>

          <Module title="Radio" tone="split">
            <div className="slots-row">
              <Slot tone="blue" noSwitch dice target={{ kind: "radio", slot: 0 }} taken={game.radioPilot !== null} label={face(game.radioPilot)} onClick={() => place({ kind: "radio", slot: 0 })} enabled={can(myCrew === "pilot" && game.radioPilot === null)} />
              {game.radioCopilot.map((val, i) => (
                <Slot key={i} tone="orange" noSwitch dice target={{ kind: "radio", slot: i }} taken={val !== null} label={face(val)} onClick={() => place({ kind: "radio", slot: i })} enabled={can(myCrew === "copilot" && val === null)} />
              ))}
            </div>
          </Module>

          <Module title="Brakes" tone="blue">
            <div className="slots-row brakes">
              {game.brakeSlots.map((taken, i) => (
                <Slot key={i} tone="blue" green={i < game.brakesDeployed} target={{ kind: "brakes", slot: i }} taken={taken} label={`${BRAKE_VAL[i]}`} onClick={() => place({ kind: "brakes", slot: i })} enabled={can(myCrew === "pilot" && i === game.brakesDeployed) && valOk([BRAKE_VAL[i]])} />
              ))}
            </div>
          </Module>

          <Module title="Concentration" tone="split">
            <div className="slots-row concentration">
              {game.concentrationSlots.map((taken, i) => (
                <Slot key={i} tone="neutral" noSwitch target={{ kind: "concentration", slot: i }} taken={taken} label="☕" onClick={() => place({ kind: "concentration", slot: i })} enabled={can(!taken)} />
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
                  target={{ kind: "flaps", slot: i }}
                  taken={game.flapSlots[i] !== null}
                  held={game.flapSlots[i]}
                  label={FLAP_LABEL[i]}
                  onClick={() => place({ kind: "flaps", slot: i })}
                  enabled={can(myCrew === "copilot" && i === nextFlap) && valOk(FLAP_RANGES[i])}
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
              {myDice.map((d) => {
                const picked = rerollActive && rerollPick.includes(d.id);
                return (
                  <button
                    key={d.id}
                    className={`die ${myCrew} ${selected === d.id ? "sel" : ""} ${d.placed ? "spent" : ""} ${drag?.dieId === d.id ? "lifted" : ""} ${picked ? "picked" : ""}`}
                    disabled={rerollActive ? d.placed : d.placed || !myTurn || game.pendingReroll !== null}
                    onPointerDown={rerollActive ? undefined : (e) => startDrag(e, d)}
                    onClick={rerollActive ? () => toggleRerollDie(d.id) : undefined}
                  >
                    {d.placed ? "" : selected === d.id && selValue !== null ? selValue : (d.value ?? "")}
                  </button>
                );
              })}
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
              {rerollActive ? (
                <span className="reroll-pick">
                  <span className="muted">
                    {iMustRespond ? "Reroll offered — pick yours" : "Pick dice to reroll"}
                  </span>
                  {iMustRespond ? (
                    <button className="reroll" onClick={confirmReroll}>
                      {rerollPick.length ? `Reroll ${rerollPick.length} 🎲` : "Skip"}
                    </button>
                  ) : (
                    <>
                      <button className="reroll" disabled={rerollPick.length === 0} onClick={confirmReroll}>
                        Reroll {rerollPick.length} 🎲
                      </button>
                      <button onClick={cancelReroll}>Cancel</button>
                    </>
                  )}
                </span>
              ) : waitingForReroll ? (
                <span className="muted">Waiting for the {label(game.pendingReroll!)} to reroll…</span>
              ) : (
                <>
                  {game.coffee > 0 && selDie && (
                    <span className="coffee-ctl">
                      <span className="muted">Coffee</span>
                      <button disabled={!selValue || selValue <= 1 || Math.abs(coffeeDelta - 1) > game.coffee} onClick={() => setCoffeeDelta((d) => d - 1)}>−1</button>
                      <b>{coffeeDelta > 0 ? `+${coffeeDelta}` : coffeeDelta}</b>
                      <button disabled={!selValue || selValue >= 6 || Math.abs(coffeeDelta + 1) > game.coffee} onClick={() => setCoffeeDelta((d) => d + 1)}>+1</button>
                    </span>
                  )}
                  <button className="reroll" disabled={game.rerollTokens <= 0 || !myTurn || myDice.every((d) => d.placed)} onClick={startReroll}>
                    Reroll 🎲 ×{game.rerollTokens}
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        <ul className="log">
          {game.log.slice(-7).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </section>

      {hoverRect && (
        <div
          className="drop-ring"
          style={{ left: hoverRect.x, top: hoverRect.y, width: hoverRect.w, height: hoverRect.h }}
          aria-hidden="true"
        />
      )}
      {drag && (
        <div className={`drag-die ${drag.crew}`} style={{ left: drag.x, top: drag.y }} aria-hidden="true">
          {drag.value}
        </div>
      )}
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
  // +offset means the Pilot's die was higher → tilt toward the Pilot, who sits on
  // the left of the dial, which is a counter-clockwise (negative-degree) bank.
  const bank = clamp(-offset * STEP, -90, 90);
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

// Horizontal speed gauge, bent into a smile (∪): slow on the left, fast on the
// right, with both ends raised and the middle dipped. The bar is a circular arc
// (the dial's circle, enlarged); markers and the needle sit on that same circle.
function SpeedGauge({ blue, orange, speed }: { blue: number; orange: number; speed: number | null }) {
  const MIN = 2;
  const MAX = 12;
  // The bar is a circular arc — like the dial's circle enlarged and viewed from the
  // bottom. R sets the curvature (larger than the dial = "enlarged"); SPAN is how
  // much of the circle the bar covers. Low speed sits at the left, high at the right.
  const R = 120;
  const SPAN = 64; // degrees, each side of the bottom — wider sweep = rounder, more dial-like
  const cx = 150;
  const cy = 78 - R; // circle centre, above the gauge (lowest point of the arc at y=78)
  const at = (v: number) => {
    const t = clamp((v - MIN) / (MAX - MIN), 0, 1);
    const phi = ((t - 0.5) * 2 * SPAN * Math.PI) / 180;
    return { x: cx + R * Math.sin(phi), y: cy + R * Math.cos(phi) };
  };
  const left = at(MIN);
  const right = at(MAX);
  const bp = at(blue + 0.5);
  const cp = at(orange + 0.5);
  const sp = speed !== null ? at(speed) : null;
  // Pilot/copilot marker: a tall (radial) rectangle whose right long edge is
  // pulled into a triangular tip pointing toward the fast end (progress). Built
  // in arc-local coords so it stays upright on the bar wherever it sits.
  const marker = (v: number) => {
    const t = clamp((v - MIN) / (MAX - MIN), 0, 1);
    const phi = ((t - 0.5) * 2 * SPAN * Math.PI) / 180;
    const rx = Math.sin(phi); // radial — the marker's long (vertical) axis
    const ry = Math.cos(phi);
    const tx = Math.cos(phi); // tangent toward higher speed — where the tip points
    const ty = -Math.sin(phi);
    const c = at(v);
    const off = -2.5; // recenter: shift left by half the tip's protrusion (5/2)
    const P = (rad: number, tan: number) =>
      `${c.x + rx * rad + tx * (tan + off)},${c.y + ry * rad + ty * (tan + off)}`;
    // top-left → top-right shoulder → right tip → bottom-right shoulder → bottom-left
    return [P(7, -3), P(7, 3), P(0, 8), P(-7, 3), P(-7, -3)].join(" ");
  };
  // Needle: a triangle sitting on the inside (concave side) of the arc at the
  // current speed, pointing radially outward toward that number.
  let needlePoints = "";
  if (sp !== null) {
    const phi = ((clamp((speed! - MIN) / (MAX - MIN), 0, 1) - 0.5) * 2 * SPAN * Math.PI) / 180;
    const ux = Math.sin(phi); // radial outward
    const uy = Math.cos(phi);
    const wx = Math.cos(phi); // tangent (triangle width)
    const wy = -Math.sin(phi);
    const tx = sp.x - 6 * ux; // tip just inside the bar, pointing out
    const ty = sp.y - 6 * uy;
    const bx = sp.x - 20 * ux; // base, deeper inside the arc
    const by = sp.y - 20 * uy;
    needlePoints = `${tx},${ty} ${bx + 9 * wx},${by + 9 * wy} ${bx - 9 * wx},${by - 9 * wy}`;
  }
  return (
    <div className="gauge">
      <svg className="gauge-svg" viewBox="0 0 300 112" aria-hidden="true">
        <path className="gauge-track" d={`M ${left.x} ${left.y} A ${R} ${R} 0 0 0 ${right.x} ${right.y}`} />
        {[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => {
          const p = at(n);
          const t = (n - MIN) / (MAX - MIN);
          const phi = ((t - 0.5) * 2 * SPAN * Math.PI) / 180;
          const rot = -(t - 0.5) * 2 * SPAN; // tangent angle — rotates the number parallel to the arc
          const D = 30; // push the number just outside the (now thicker) arc, along the radius
          const nx = p.x + D * Math.sin(phi);
          const ny = p.y + D * Math.cos(phi);
          return (
            <g key={n}>
              <circle className="gauge-tick" cx={p.x} cy={p.y} r="3" />
              <text className="gauge-num" x={nx} y={ny} transform={`rotate(${rot} ${nx} ${ny})`}>
                {n}
              </text>
            </g>
          );
        })}
        <polygon className="aero-dot blue" points={marker(blue + 0.5)} />
        <polygon className="aero-dot orange" points={marker(orange + 0.5)} />
        {sp && <polygon className="gauge-needle" points={needlePoints} />}
      </svg>
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
  dice,
  held,
  target,
}: {
  taken: boolean;
  green?: boolean;
  tone: "blue" | "orange" | "neutral";
  label: string;
  onClick: () => void;
  enabled: boolean;
  noSwitch?: boolean;
  dice?: boolean;
  held?: number | null;
  target?: Target;
}) {
  // `held` is the die value placed on this space this round (Gear/Flaps): show it
  // until the round resets so it's clear where the dice went. Otherwise show the
  // requirement label, or nothing once the section is deployed (green).
  const faceText = held != null ? held : green ? "" : label;
  const button = (
    <button
      className={`slot ${tone} ${green ? "green" : ""} ${taken ? "taken" : ""} ${enabled ? "open" : ""} ${dice ? "dice" : ""} ${held != null ? "held" : ""}`}
      disabled={!enabled}
      onClick={onClick}
      data-open={enabled ? "1" : "0"}
      data-target={target ? JSON.stringify(target) : undefined}
    >
      <span className="slot-face">{faceText}</span>
    </button>
  );
  // Switch modules (Gear/Flaps/Brakes) carry their deploy switch *under* the slot.
  if (noSwitch) return button;
  return (
    <div className="slot-stack">
      {button}
      <span className={`switch ${green ? "on" : ""}`} aria-hidden="true" />
    </div>
  );
}

const GEAR_LABEL = ["1/2", "3/4", "5/6"];
const FLAP_LABEL = ["1/2", "2/3", "3/4", "4/5"];
const BRAKE_VAL = [2, 4, 6];
// Die values each numbered space accepts (mirrors the reducer's legality rules).
const GEAR_RANGES = [[1, 2], [3, 4], [5, 6]];
const FLAP_RANGES = [[1, 2], [2, 3], [3, 4], [4, 5]];

function label(crew: Crew): string {
  return crew === "pilot" ? "Pilot" : "Co-Pilot";
}
function face(v: number | null): string {
  return v === null ? "" : String(v);
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
