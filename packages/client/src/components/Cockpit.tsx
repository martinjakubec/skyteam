import { useEffect, useRef, useState } from "react";
import type { GameCommand, RoomSnapshot } from "@skyteam/shared";
import type { Crew, Target } from "../types";
import { clamp, face, label } from "../util";
import {
  BRAKE_VAL,
  FLAP_LABEL,
  FLAP_RANGES,
  GEAR_LABEL,
  GEAR_RANGES,
} from "../constants";
import { Altitude } from "./Altitude";
import { Approach } from "./Approach";
import { Module } from "./Module";
import { Slot } from "./Slot";
import { SpeedGauge } from "./SpeedGauge";
import { Window } from "./Window";

export function Cockpit({
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
          <div className="engines">
            <Slot tone="blue" noSwitch dice target={{ kind: "engine" }} taken={game.engines.pilot !== null} label={face(game.engines.pilot)} onClick={() => place({ kind: "engine" })} enabled={can(myCrew === "pilot" && game.engines.pilot === null)} />
            <Slot tone="orange" noSwitch dice target={{ kind: "engine" }} taken={game.engines.copilot !== null} label={face(game.engines.copilot)} onClick={() => place({ kind: "engine" })} enabled={can(myCrew === "copilot" && game.engines.copilot === null)} />
          </div>
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
