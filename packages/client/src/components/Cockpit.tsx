import { Fragment, useEffect, useRef, useState } from "react";
import type { GameCommand, RoomSnapshot } from "@skyteam/shared";
import type { Crew, Target } from "../types";
import { clamp, face, label, previewModule } from "../util";
import {
  BRAKE_VAL,
  FLAP_LABEL,
  FLAP_RANGES,
  GEAR_LABEL,
  GEAR_RANGES,
} from "../constants";
import { Altitude } from "./Altitude";
import { Approach } from "./Approach";
import { BrakesGauge } from "./BrakesGauge";
import { Headset } from "./icons";
import { Kerosene } from "./Kerosene";
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

  // Advanced modules switched on for this game. `?preview=` (dev only) shows a
  // module's UI without it being in play — its spaces stay disabled then.
  const keroseneInPlay = game.scenario.modules?.includes("kerosene") ?? false;
  // Kerosene Leak replaces Kerosene (one or the other): same track and spot,
  // but no die space — the Engine dice drive the burn.
  const leakOn = (game.scenario.modules?.includes("keroseneLeak") ?? false) || previewModule("keroseneLeak");
  const keroseneOn = keroseneInPlay || previewModule("kerosene") || leakOn;

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

  // Mandatory spots: every round a crew must seat one die on its Axis and one on
  // its Engine. Those dice are reserved — when the dice still in hand are all
  // needed to fill the crew's still-open mandatory spots, no other space may be a
  // target, so the player can't strand a mandatory spot. Covers every case:
  //   2 dice left / Axis+Engine both open → only Axis & Engine are legal;
  //   1 die left / 1 mandatory spot open  → only that spot is legal;
  //   more dice than open mandatory spots → free to place anywhere.
  const openMandatory =
    myCrew === null ? 0 : (game.axis[myCrew] === null ? 1 : 0) + (game.engines[myCrew] === null ? 1 : 0);
  const diceLeft = myDice.filter((d) => !d.placed).length;
  const lockToMandatory = diceLeft <= openMandatory;
  // Axis/Engine keep using `can` (always legal when free); every non-mandatory
  // space additionally requires that we're not holding the last dice in reserve.
  const canFree = (free: boolean) => can(free) && !lockToMandatory;

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

  // --- Edge auto-scroll while dragging --------------------------------------
  // Touchpads can't scroll mid-drag, so on a short screen a die can't be carried
  // from the tray (bottom) up to the instruments (top). While a drag is active
  // and the pointer sits in the top/bottom edge zone, scroll the page toward it
  // (speed ramps with how deep into the zone it is) to bring the rest of the
  // board into reach. The dragged die is position:fixed, so it stays under the
  // pointer as the page moves beneath it.
  const autoScroll = useRef<{ raf: number | null; x: number; y: number }>({ raf: null, x: 0, y: 0 });
  const stepAutoScroll = () => {
    const a = autoScroll.current;
    const EDGE = 96; // px zone at top/bottom edge that triggers scrolling
    const MAX = 18; // px/frame at the very edge
    const h = window.innerHeight;
    let dy = 0;
    if (a.y < EDGE) dy = -Math.ceil(((EDGE - a.y) / EDGE) * MAX);
    else if (h - a.y < EDGE) dy = Math.ceil(((EDGE - (h - a.y)) / EDGE) * MAX);
    if (dy !== 0) {
      const before = window.scrollY;
      window.scrollBy(0, dy);
      // The page moved under a possibly-still pointer — re-resolve the hovered
      // slot so the drop ring keeps tracking even when no pointermove fires.
      if (window.scrollY !== before) {
        const slot = validSlotUnder(a.x, a.y);
        const r = slot?.getBoundingClientRect();
        setHoverRect(r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null);
      }
    }
    a.raf = requestAnimationFrame(stepAutoScroll);
  };
  const startAutoScroll = () => {
    if (autoScroll.current.raf === null) autoScroll.current.raf = requestAnimationFrame(stepAutoScroll);
  };
  const stopAutoScroll = () => {
    if (autoScroll.current.raf !== null) {
      cancelAnimationFrame(autoScroll.current.raf);
      autoScroll.current.raf = null;
    }
  };
  // Safety net: never leave the loop running if we unmount mid-drag.
  useEffect(() => stopAutoScroll, []);

  const onDragMove = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (!g.active && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 6) return;
    autoScroll.current.x = e.clientX;
    autoScroll.current.y = e.clientY;
    if (!g.active) {
      g.active = true;
      setDragging(true);
      startAutoScroll();
    }
    const slot = validSlotUnder(e.clientX, e.clientY);
    const r = slot?.getBoundingClientRect();
    setHoverRect(r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null);
    setDrag({ dieId: g.dieId, value: g.value, crew: g.crew, x: e.clientX, y: e.clientY });
  };
  const onDragEnd = (e: PointerEvent) => {
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    stopAutoScroll();
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
    <div className={`board${keroseneOn ? " with-kerosene" : ""}`}>
      {/* Full-width status tracks above the console: approach path + altitude */}
      <section className="tracks">
        <Approach game={game} airportIdx={airportIdx} />
        <Altitude game={game} />
      </section>

      {/* Central dial-stack. The crew rails are placed after the deck (see below)
          so they can reflow beneath the main panel on narrow screens; on wide
          screens the .board grid areas position them back beside the dial. */}
      <div className="dial-stack">
          <div className="axis-cluster">
            {/* Elbow leads: a diagonal up from each dial rim, then a horizontal
                stub into the inner edge of the (top-aligned) dice space. */}
            <span className="axis-lead h-left" aria-hidden="true" />
            <span className="axis-lead d-left" aria-hidden="true" />
            <span className="axis-lead h-right" aria-hidden="true" />
            <span className="axis-lead d-right" aria-hidden="true" />
            <Slot tone="blue" noSwitch dice mandatory target={{ kind: "axis" }} taken={game.axis.pilot !== null} label={face(game.axis.pilot)} onClick={() => place({ kind: "axis" })} enabled={can(myCrew === "pilot" && game.axis.pilot === null)} />
            <Window offset={game.axis.offset} spinAt={game.scenario.axisSpinAt} outcome={game.outcome} />
            <Slot tone="orange" noSwitch dice mandatory target={{ kind: "axis" }} taken={game.axis.copilot !== null} label={face(game.axis.copilot)} onClick={() => place({ kind: "axis" })} enabled={can(myCrew === "copilot" && game.axis.copilot === null)} />
          </div>
          <SpeedGauge blue={game.aeroBlue} orange={game.aeroOrange} speed={game.lastSpeed} />
          <div className="engines">
            <Slot tone="blue" noSwitch dice mandatory target={{ kind: "engine" }} taken={game.engines.pilot !== null} label={face(game.engines.pilot)} onClick={() => place({ kind: "engine" })} enabled={can(myCrew === "pilot" && game.engines.pilot === null)} />
            <span className="engine-plus" aria-hidden="true">+</span>
            <Slot tone="orange" noSwitch dice mandatory target={{ kind: "engine" }} taken={game.engines.copilot !== null} label={face(game.engines.copilot)} onClick={() => place({ kind: "engine" })} enabled={can(myCrew === "copilot" && game.engines.copilot === null)} />
          </div>
          <BrakesGauge deployed={game.brakesDeployed} />
          {/* Brake dice spaces — filled left-to-right (2 → 4 → 6); the arrows
              between them signal the mandatory order. Fine leads tie each space
              up to the brake gauge (left "[", middle "|", right "]"). */}
          <div className="slots-row brakes">
            <span className="brake-leads" aria-hidden="true">
              <span className="bus" />
              <span className="up" />
              <span className="drop left" />
              <span className="drop mid" />
              <span className="drop right" />
            </span>
            {game.brakeSlots.map((taken, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="slot-arrow" aria-hidden="true" />}
                <Slot tone="blue" green={i < game.brakesDeployed} target={{ kind: "brakes", slot: i }} taken={taken} label={`${BRAKE_VAL[i]}`} onClick={() => place({ kind: "brakes", slot: i })} enabled={canFree(myCrew === "pilot" && i === game.brakesDeployed) && valOk([BRAKE_VAL[i]])} />
              </Fragment>
            ))}
          </div>
        </div>

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
        {/* Center panel */}
        <div className="center-panel material riveted">
          <Module title="Concentration" tone="split">
            <div className="slots-row concentration">
              {game.concentrationSlots.map((cell, i) => {
                // A space is empty when its cell is null *or* undefined — treat both
                // identically (state can serialise an empty cell as either). Empty:
                // neutral split (blue/orange) with the ☕ hint. Filled: render exactly
                // like the Radio/Engine/Axis dice spaces (dice + taken) so the seated
                // die looks identical — blue for the Pilot, orange for the Co-Pilot.
                const filled = cell != null;
                return (
                  <Slot
                    key={i}
                    tone={filled ? (cell.crew === "pilot" ? "blue" : "orange") : "neutral"}
                    noSwitch
                    dice
                    target={{ kind: "concentration", slot: i }}
                    taken={filled}
                    label={filled ? face(cell.value) : "☕"}
                    onClick={() => place({ kind: "concentration", slot: i })}
                    enabled={canFree(!filled)}
                  />
                );
              })}
              <span className="coffee-count" title="Coffee tokens">
                {"☕".repeat(game.coffee) || "—"}
              </span>
            </div>
          </Module>
        </div>
      </section>

      {/* Crew rails. In DOM they follow the deck so they stack under the main
          panel on narrow screens; on wide screens the .board grid places the
          pilot rail left of the dial and the co-pilot rail right of it. */}
      <div className="rail rail-pilot">
        {/* Kerosene runs down the left of the Radio + Landing Gear (rail grid:
            see .with-kerosene). Either crew may use it — except with the
            Leak, where the space is blocked. */}
        {keroseneOn && (
          <Kerosene
            leak={leakOn}
            level={game.kerosene}
            seated={game.keroseneSlot}
            enabled={canFree(keroseneInPlay && game.keroseneSlot == null)}
            onClick={() => place({ kind: "kerosene" })}
          />
        )}
        <Module title="Radio" tone="blue" className="mod-radio-pilot">
          <div className="slots-row">
            <Slot tone="blue" noSwitch dice icon={<Headset />} target={{ kind: "radio", slot: 0 }} taken={game.radioPilot !== null} label={face(game.radioPilot)} onClick={() => place({ kind: "radio", slot: 0 })} enabled={canFree(myCrew === "pilot" && game.radioPilot === null)} />
          </div>
        </Module>
        <Module title="Landing Gear" tone="blue" className="mod-gear">
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
                enabled={canFree(myCrew === "pilot" && !game.gearGreen[i]) && valOk(GEAR_RANGES[i])}
              />
            ))}
          </div>
        </Module>
      </div>
      <div className="rail rail-copilot">
        <Module title="Radio" tone="orange" className="mod-radio-copilot">
          <div className="slots-col">
            {game.radioCopilot.map((val, i) => (
              <Slot key={i} tone="orange" noSwitch dice icon={<Headset />} target={{ kind: "radio", slot: i }} taken={val !== null} label={face(val)} onClick={() => place({ kind: "radio", slot: i })} enabled={canFree(myCrew === "copilot" && val === null)} />
            ))}
          </div>
        </Module>
        <Module title="Flaps" tone="orange" className="mod-flaps">
          {/* Flaps deploy top-to-bottom; the down arrows signal that order. */}
          <div className="slots-col">
            {game.flapsGreen.map((green, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="slot-arrow-v" aria-hidden="true" />}
                <Slot
                  tone="orange"
                  green={green}
                  target={{ kind: "flaps", slot: i }}
                  taken={game.flapSlots[i] !== null}
                  held={game.flapSlots[i]}
                  label={FLAP_LABEL[i]}
                  onClick={() => place({ kind: "flaps", slot: i })}
                  enabled={canFree(myCrew === "copilot" && i === nextFlap) && valOk(FLAP_RANGES[i])}
                />
              </Fragment>
            ))}
          </div>
        </Module>
      </div>

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
