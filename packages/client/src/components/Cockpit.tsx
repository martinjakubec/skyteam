import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ICE_BRAKE_VALUES, REAL_TIME_SECONDS, firstPlayerForRound, placementKey, type GameCommand, type RoomSnapshot } from "@skyteam/shared";
import type { Crew, Target } from "../types";
import { clamp, face, label, previewModule } from "../util";
import {
  BRAKE_VAL,
  FLAP_LABEL,
  FLAP_RANGES,
  GEAR_LABEL,
  GEAR_RANGES,
} from "../constants";
import { Abilities } from "./Abilities";
import { Altitude } from "./Altitude";
import { Approach } from "./Approach";
import { BrakesGauge } from "./BrakesGauge";
import { Headset } from "./icons";
import { IceBrakes } from "./IceBrakes";
import { Intern } from "./Intern";
import { Kerosene } from "./Kerosene";
import { Wind } from "./Wind";
import { RealTime } from "./RealTime";
import { useGame } from "../store";
import { Module } from "./Module";
import { ExtraDieContext, Slot } from "./Slot";
import { SpeedGauge } from "./SpeedGauge";
import { Window } from "./Window";
import type { CockpitSection } from "./cockpitSections";
import { seatNames } from "./Seats";
import { Coffee, Dice } from "./icons";

/** Selection/drag ids for held extras (crew dice are 0..3): the Intern token
 *  and Synchronisation's Traffic die. */
const INTERN_TOKEN = -1;
const TRAFFIC_DIE = -2;

export function Cockpit({
  snapshot,
  onCommand,
  show,
  clockOffset: clockOffsetOverride,
  between,
}: {
  snapshot: RoomSnapshot;
  onCommand: (command: GameCommand) => void;
  /** Tutorials: draw only these sections (the dice tray always shows). Unset = everything. */
  show?: CockpitSection[];
  /** Tutorials run on the local clock: pass 0 instead of the server offset. */
  clockOffset?: number;
  /** Between rounds (snapshot.debrief): shown in the dice tray's place. */
  between?: ReactNode;
}) {
  const vis = (section: CockpitSection) => !show || show.includes(section);
  const game = snapshot.game!;
  const myCrew: Crew | null =
    game.pilotId === snapshot.you.playerId
      ? "pilot"
      : game.copilotId === snapshot.you.playerId
        ? "copilot"
        : null;
  // What to call each crew: its player's name, else "the Pilot"/"the Co-Pilot".
  const names = seatNames(snapshot);
  const who = (crew: Crew) => names[crew] ?? `the ${label(crew)}`;
  const myTurn = myCrew !== null && game.turn === myCrew && game.phase === "placement";
  // Intern: a crew that has just trained holds a token it must place before
  // anything else. While it's mine, it's the only thing I can place.
  const internHeld = game.internHeld ?? null;
  const internHeldMine = internHeld !== null && internHeld.crew === myCrew;
  // Synchronisation: the rolled Traffic die is the Co-Pilot's to place, on any
  // empty space of either colour; everything else waits for it.
  const trafficHeld = game.trafficHeld ?? null;
  const trafficHeldMine = trafficHeld !== null && myCrew === "copilot";
  // Holding an extra (Intern token / Traffic die) lets me act off-turn.
  const extraHeldMine = internHeldMine || trafficHeldMine;

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
  // The held Intern token is selected via the INTERN_TOKEN sentinel id; it
  // places at face value (no Coffee).
  const selValue =
    selected === INTERN_TOKEN
      ? internHeldMine
        ? internHeld.value
        : null
      : selected === TRAFFIC_DIE
        ? trafficHeldMine
          ? trafficHeld.value
          : null
      : selDie?.value !== undefined
        ? clamp(selDie.value + coffeeDelta, 1, 6)
        : null;

  // The token is auto-selected the moment it's trained, so its legal spaces
  // light up straight away; drop the selection once it's placed.
  useEffect(() => {
    if (internHeldMine) {
      setSelected(INTERN_TOKEN);
      setCoffeeDelta(0);
    } else {
      setSelected((s) => (s === INTERN_TOKEN ? null : s));
    }
  }, [internHeldMine]);
  useEffect(() => {
    if (trafficHeldMine) {
      setSelected(TRAFFIC_DIE);
      setCoffeeDelta(0);
    } else {
      setSelected((s) => (s === TRAFFIC_DIE ? null : s));
    }
  }, [trafficHeldMine]);

  // The server prompts the *other* crew via pendingReroll. iMustRespond = it's my
  // turn to reroll-or-decline; waitingForReroll = I initiated and am waiting.
  const iMustRespond = myCrew !== null && game.pendingReroll === myCrew;
  const waitingForReroll = game.pendingReroll !== null && game.pendingReroll !== myCrew;
  // The dice tray is in pick-toggle mode when I'm choosing dice for a reroll.
  const rerollActive = (rerollMode && myTurn) || iMustRespond;

  // Single-die Special Abilities share a pick mode: press the card's button,
  // then tap one of my dice. Adaptation (turn a die over, once per game) works
  // on either player's turn, so in pick mode the dice are tappable regardless
  // of whose turn it is. Anticipation (First Player rerolls one die before
  // their first placement, once per round).
  const has = (id: "adaptation" | "anticipation" | "workingTogether") => game.scenario.abilities?.includes(id) ?? false;
  const noPendingAction =
    game.phase === "placement" && game.pendingReroll === null && !internHeld && game.pendingSwap === null && !trafficHeld;
  const canAdapt =
    myCrew !== null && has("adaptation") && !game.adaptationUsed[myCrew] && noPendingAction && myDice.some((d) => !d.placed);
  const canAnticipate =
    myCrew !== null &&
    has("anticipation") &&
    !game.anticipated &&
    myCrew === firstPlayerForRound(game.round) &&
    myDice.length > 0 &&
    myDice.every((d) => !d.placed) &&
    noPendingAction;
  // Working Together: the active player offers a die (once per round); the
  // other player must then answer with one of theirs — their tray switches to
  // pick mode on its own.
  const canOfferSwap =
    myTurn && has("workingTogether") && !game.swappedThisRound && noPendingAction && myDice.some((d) => !d.placed);
  const mustAnswerSwap = game.pendingSwap !== null && myCrew !== null && game.pendingSwap.from !== myCrew;
  const waitingForSwap = game.pendingSwap !== null && game.pendingSwap.from === myCrew;
  const [pickMode, setPickMode] = useState<"adapt" | "anticipate" | "swap" | null>(null);
  const pickActive = mustAnswerSwap
    ? "swap"
    : !rerollActive &&
        ((pickMode === "adapt" && canAdapt) || (pickMode === "anticipate" && canAnticipate) || (pickMode === "swap" && canOfferSwap))
      ? pickMode
      : null;
  useEffect(() => {
    if (pickMode && !pickActive) setPickMode(null);
  }, [pickMode, pickActive]);
  const pickDie = (dieId: number) => {
    onCommand(
      pickActive === "adapt"
        ? { type: "adapt", dieId }
        : pickActive === "anticipate"
          ? { type: "anticipate", dieId }
          : { type: "swap", dieId },
    );
    setPickMode(null);
    setSelected(null);
    setCoffeeDelta(0);
  };
  // The card's button: start picking, or cancel while picking.
  const pickButton = (mode: "adapt" | "anticipate" | "swap", label: string, enabled: boolean, hint: string) =>
    pickActive === mode ? (
      <button onClick={() => setPickMode(null)} title={hint}>
        Tap a die · Cancel
      </button>
    ) : (
      <button disabled={!enabled} onClick={() => setPickMode(mode)} title={hint}>
        {label}
      </button>
    );

  // Drop any local reroll UI when the reroll context changes server-side
  // (initiated, resolved, or a new round dealt) so stale picks never linger.
  useEffect(() => {
    setRerollMode(false);
    setRerollPick([]);
  }, [game.pendingReroll, game.round]);

  const place = (target: Target) => {
    if (selected === null) return;
    if (selected === INTERN_TOKEN) onCommand({ type: "placeIntern", target });
    else if (selected === TRAFFIC_DIE) onCommand({ type: "placeTraffic", target });
    else onCommand({ type: "placeDie", dieId: selected, target, coffeeDelta: coffeeDelta || undefined });
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
  // Real-Time: the round's countdown runs under the Altitude track. Dev
  // `?preview=realTime` shows a sample countdown from 60s.
  const realTimeInPlay = game.scenario.modules?.includes("realTime") ?? false;
  const realTimeOn = realTimeInPlay || previewModule("realTime");
  const [previewEndsAt] = useState(() => Date.now() + REAL_TIME_SECONDS * 1000);
  const serverOffset = useGame((s) => s.clockOffset);
  const clockOffset = clockOffsetOverride ?? serverOffset;
  // Who the paused clock is waiting for (the host flies as Pilot).
  const awaited = snapshot.seats.find((s) => s.connection === "disconnected");
  const pausedNote = awaited ? `waiting for ${who(awaited.playerId === game.pilotId ? "pilot" : "copilot")} to reconnect` : undefined;
  // Wind sits right of the Co-Pilot's Radio. Dev `?preview=wind` shows the ring.
  const windOn = (game.scenario.modules?.includes("wind") ?? false) || previewModule("wind");
  // Intern sits under Concentration. Dev `?preview=intern` (module not in play)
  // shows sample tokens with the training spaces disabled.
  const internInPlay = game.scenario.modules?.includes("intern") ?? false;
  const internOn = internInPlay || previewModule("intern");
  const internTokens = internInPlay ? game.internTokens : [3, 1, 5, 6, 2, 4];
  // A crew's next token: the Pilot trains from the left, the Co-Pilot from the right.
  const nextTokenFor = (crew: Crew) =>
    crew === "copilot" ? [...internTokens].reverse().find((v) => v !== null) : internTokens.find((v) => v !== null);
  // Training: once per round per space, with a die that differs from that
  // side's next token — my own space, or either while I hold the Traffic die.
  // Exempt from the mandatory reservation (the token can fill the Axis/Engine
  // itself). Never while a token is in hand.
  const canTrain = (crew: Crew) =>
    mine(crew) &&
    !internHeld &&
    !holdingToken &&
    can(internInPlay && game.internSlots[crew] === null && nextTokenFor(crew) != null) &&
    activeValue !== nextTokenFor(crew);
  // Spaces filled by an Intern token or the Traffic die this round are drawn in
  // that extra's colours.
  const internPlaced = new Set(internInPlay ? game.internPlaced : []);
  const trafficPlaced = new Set(game.trafficPlaced ?? []);
  const filledByExtra = (crew: Crew, target: Target) => {
    const key = placementKey(crew, target);
    return internPlaced.has(key) ? "intern" : trafficPlaced.has(key) ? "traffic" : null;
  };

  // Ice Brakes replaces the Brakes row (dev `?preview=` shows it disabled).
  const iceInPlay = game.scenario.modules?.includes("iceBrakes") ?? false;
  const iceOn = iceInPlay || previewModule("iceBrakes");
  // The brake column shows either Ice Brakes or the normal Brakes.
  const brakesVis = iceOn ? vis("iceBrakes") : vis("brakes");
  // Only the next step (the marker's position) is open; its top space is the
  // Pilot's, the bottom either crew's, and both need the step's value.
  const iceOpen = (i: number, space: "top" | "bottom") =>
    canFree(
      iceInPlay &&
        i <= game.brakesDeployed && // the next step, or one already passed (no effect)
        game.iceBrakeSlots[i]?.[space] == null &&
        (space === "bottom" || mine("pilot")),
    ) && valOk([ICE_BRAKE_VALUES[i]]);

  // The status line under the dial: the most pressing thing for this viewer.
  const calloutText = (): string => {
    if (game.outcome) return game.outcome.result === "won" ? "Smooth landing — the passengers applaud." : game.outcome.reason;
    if (snapshot.debrief) {
      if (!myCrew) return "Between rounds.";
      return snapshot.seats.some((s) => s.bot) ? "Between rounds — press Ready when you are." : "Between rounds — talk it over, then press Ready.";
    }
    if (mustAnswerSwap) {
      // The offered die lies face-up on the card, so its value is visible.
      const offer = game.pendingSwap!;
      const value = game.dice[offer.from].find((d) => d.id === offer.dieId)?.value;
      return `Working Together — ${who(offer.from)} offers a ${value ?? "die"}; tap one of your dice to swap.`;
    }
    if (waitingForSwap) return `Working Together — waiting for ${who(myCrew === "pilot" ? "copilot" : "pilot")} to pick a die…`;
    if (trafficHeld) {
      return trafficHeldMine
        ? `Synchronisation — place the Traffic die (${trafficHeld.value}) on any empty space, any colour.`
        : "Synchronisation — waiting for the Co-Pilot to place the Traffic die…";
    }
    if (internHeld) {
      return internHeldMine
        ? `Intern trained — place the ${internHeld.value} token on a panel space.`
        : `Waiting for ${who(internHeld.crew)} to place the Intern token…`;
    }
    if (waitingForReroll) return `Reroll — waiting for ${who(game.pendingReroll!)} to pick dice…`;
    if (iMustRespond) return "Reroll offered — pick any of your dice to reroll, or Skip.";
    if (!myCrew) return "Spectating the approach.";
    if (!myTurn) return `Silence. Waiting for ${who(game.turn)}…`;
    return rerollMode ? "Reroll — pick the dice to reroll, then Confirm." : "Your turn — drag a die onto a panel space.";
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
    (myTurn || extraHeldMine) &&
    (selected !== null || dragging) &&
    free &&
    game.pendingReroll === null &&
    game.pendingSwap === null &&
    !rerollMode;
  // Holding (selected or dragging) the Intern token / Traffic die rather than a die.
  const holdingToken = selected === INTERN_TOKEN || drag?.dieId === INTERN_TOKEN;
  const holdingTraffic = selected === TRAFFIC_DIE || drag?.dieId === TRAFFIC_DIE;
  // Whether a crew-coloured space is mine to fill: my own colour, or any colour
  // while I hold the Traffic die.
  const mine = (spaceCrew: Crew) => myCrew === spaceCrew || holdingTraffic;

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
  // A die in hand counts itself among `diceLeft`; the Intern token doesn't, so
  // it may go on a free space as long as the dice left can still cover them.
  // The Traffic die is an extra for any space: no reservation applies to it.
  const lockToMandatory = holdingTraffic ? false : holdingToken ? diceLeft < openMandatory : diceLeft <= openMandatory;
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
  const boardRef = useRef<HTMLDivElement>(null);
  const stepAutoScroll = () => {
    const a = autoScroll.current;
    const EDGE = 96; // px zone at top/bottom edge that triggers scrolling
    const MAX = 18; // px/frame at the very edge
    // Inside a tutorial the dialog's board box scrolls, not the page: its edges
    // are the zones.
    const box = boardRef.current?.closest("[data-drag-scroll]");
    const r = box?.getBoundingClientRect();
    const top = r ? r.top : 0;
    const bottom = r ? r.bottom : window.innerHeight;
    let dy = 0;
    if (a.y - top < EDGE) dy = -Math.ceil(((EDGE - Math.max(0, a.y - top)) / EDGE) * MAX);
    else if (bottom - a.y < EDGE) dy = Math.ceil(((EDGE - Math.max(0, bottom - a.y)) / EDGE) * MAX);
    if (dy !== 0) {
      const scrolled = () => (box ? box.scrollTop : window.scrollY);
      const before = scrolled();
      if (box) box.scrollBy(0, dy);
      else window.scrollBy(0, dy);
      // The page moved under a possibly-still pointer — re-resolve the hovered
      // slot so the drop ring keeps tracking even when no pointermove fires.
      if (scrolled() !== before) {
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
      if (g.dieId === INTERN_TOKEN) onCommand({ type: "placeIntern", target });
      else if (g.dieId === TRAFFIC_DIE) onCommand({ type: "placeTraffic", target });
      else onCommand({ type: "placeDie", dieId: g.dieId, target, coffeeDelta: g.coffee || undefined });
      setSelected(null);
      setCoffeeDelta(0);
    } else {
      // Dropped nowhere valid: a die returns to the tray unselected; the Intern
      // token stays selected, since it must be placed next anyway.
      setSelected(g.dieId === INTERN_TOKEN || g.dieId === TRAFFIC_DIE ? g.dieId : null);
    }
  };
  const startDrag = (e: React.PointerEvent, die: { id: number; value?: number; placed?: boolean }) => {
    // While an extra (Intern token / Traffic die) is in hand, only that extra
    // can be dragged — even off-turn.
    const isExtra = die.id === INTERN_TOKEN || die.id === TRAFFIC_DIE;
    if (die.placed || !myCrew || !(myTurn || extraHeldMine) || game.pendingReroll !== null || rerollMode || extraHeldMine !== isExtra) return;
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
    <ExtraDieContext.Provider value={filledByExtra}>
      <div ref={boardRef} className={`board${keroseneOn ? " with-kerosene" : ""}${windOn ? " with-wind" : ""}${show ? " tutorial" : ""}`}>
        {/* Full-width status tracks above the console: approach path + altitude */}
        {(vis("tracks") || (realTimeOn && vis("realTime"))) && (
        <section className="tracks">
          {vis("tracks") && <Approach game={game} airportIdx={airportIdx} />}
          {vis("tracks") && <Altitude game={game} />}
          {realTimeOn && vis("realTime") && (
            <RealTime
              endsAt={realTimeInPlay ? game.timerEndsAt : previewEndsAt}
              remainingMs={realTimeInPlay ? game.timerRemainingMs : null}
              clockOffset={realTimeInPlay ? clockOffset : 0}
              pausedNote={pausedNote}
              seconds={game.scenario.realTimeSeconds ?? REAL_TIME_SECONDS}
            />
          )}
        </section>
        )}

        {/* Central dial-stack. The crew rails are placed after the deck (see below)
            so they can reflow beneath the main panel on narrow screens; on wide
            screens the .board grid areas position them back beside the dial. */}
        <div className="dial-stack">
            {vis("axis") && (
            <div className="axis-cluster">
              {/* Elbow leads: a diagonal up from each dial rim, then a horizontal
                  stub into the inner edge of the (top-aligned) dice space. */}
              <span className="axis-lead h-left" aria-hidden="true" />
              <span className="axis-lead d-left" aria-hidden="true" />
              <span className="axis-lead h-right" aria-hidden="true" />
              <span className="axis-lead d-right" aria-hidden="true" />
              <Slot tone="blue" noSwitch dice mandatory target={{ kind: "axis", side: "pilot" }} taken={game.axis.pilot !== null} label={face(game.axis.pilot)} onClick={() => place({ kind: "axis", side: "pilot" })} enabled={can(mine("pilot") && game.axis.pilot === null)} />
              <Window offset={game.axis.offset} spinAt={game.scenario.axisSpinAt} outcome={game.outcome} />
              <Slot tone="orange" noSwitch dice mandatory target={{ kind: "axis", side: "copilot" }} taken={game.axis.copilot !== null} label={face(game.axis.copilot)} onClick={() => place({ kind: "axis", side: "copilot" })} enabled={can(mine("copilot") && game.axis.copilot === null)} />
            </div>
            )}
            {vis("engines") && (
            <>
            <SpeedGauge blue={game.aeroBlue} orange={game.aeroOrange} speed={game.lastSpeed} />
            <div className="engines">
              <Slot tone="blue" noSwitch dice mandatory target={{ kind: "engine", side: "pilot" }} taken={game.engines.pilot !== null} label={face(game.engines.pilot)} onClick={() => place({ kind: "engine", side: "pilot" })} enabled={can(mine("pilot") && game.engines.pilot === null)} />
              <span className="engine-plus" aria-hidden="true">+</span>
              <Slot tone="orange" noSwitch dice mandatory target={{ kind: "engine", side: "copilot" }} taken={game.engines.copilot !== null} label={face(game.engines.copilot)} onClick={() => place({ kind: "engine", side: "copilot" })} enabled={can(mine("copilot") && game.engines.copilot === null)} />
            </div>
            </>
            )}
            {brakesVis && <BrakesGauge deployed={game.brakesDeployed} values={iceOn ? ICE_BRAKE_VALUES : undefined} />}
            {/* Brake dice spaces — filled left-to-right (2 → 4 → 6); the arrows
                between them signal the mandatory order. Fine leads tie each space
                up to the brake gauge (left "[", middle "|", right "]"). The Ice
                Brakes module swaps in its own 2 → 5 pair-of-spaces track. */}
            {!brakesVis ? null : iceOn ? (
              <IceBrakes
                steps={game.iceBrakeSlots}
                deployed={game.brakesDeployed}
                canTop={(i) => iceOpen(i, "top")}
                canBottom={(i) => iceOpen(i, "bottom")}
                onTop={(i) => place({ kind: "iceBrakes", slot: i, space: "top" })}
                onBottom={(i) => place({ kind: "iceBrakes", slot: i, space: "bottom" })}
              />
            ) : (
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
                    <Slot tone="blue" green={i < game.brakesDeployed} target={{ kind: "brakes", slot: i }} taken={taken} label={`${BRAKE_VAL[i]}`} onClick={() => place({ kind: "brakes", slot: i })} enabled={canFree(mine("pilot") && i <= game.brakesDeployed && !taken) && valOk([BRAKE_VAL[i]])} />
                  </Fragment>
                ))}
              </div>
            )}
          </div>

        <p className={`callout ${game.outcome ? (game.outcome.result === "won" ? "good" : "bad") : ""}`}>
          {calloutText()}
          {game.outcome && snapshot.lastGameId && (
            <a className="replay-link" href={`/games/${snapshot.lastGameId}`} target="_blank" rel="noopener">
              Watch the replay
            </a>
          )}
        </p>

        {/* Main deck: shared modules, styled like the crew-rail modules (one
            panel each). Intern (module) sits under Concentration. */}
        {(vis("concentration") || (internOn && vis("intern"))) && (
        <section className="deck">
          {vis("concentration") && (
          <Module title="Concentration" tone="split" className="mod-concentration">
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
                    label={filled ? face(cell.value) : ""}
                    icon={<Coffee />}
                    onClick={() => place({ kind: "concentration", slot: i })}
                    enabled={canFree(!filled) && !holdingToken}
                  />
                );
              })}
              <span className="coffee-count" title="Coffee tokens">
                {game.coffee ? Array.from({ length: game.coffee }, (_, i) => <Coffee key={i} />) : "—"}
              </span>
            </div>
          </Module>
          )}
          {internOn && vis("intern") && (
            <Intern
              tokens={internTokens}
              trainers={game.internSlots}
              canTrain={canTrain}
              onTrain={(crew) => place({ kind: "intern", side: crew })}
            />
          )}
        </section>
        )}

        {/* Crew rails. In DOM they follow the deck so they stack under the main
            panel on narrow screens; on wide screens the .board grid places the
            pilot rail left of the dial and the co-pilot rail right of it. */}
        {((keroseneOn && vis("kerosene")) || vis("radio") || vis("gear")) && (
        <div className="rail rail-pilot">
          {/* Kerosene runs down the left of the Radio + Landing Gear (rail grid:
              see .with-kerosene). Either crew may use it — except with the
              Leak, where the space is blocked. */}
          {keroseneOn && vis("kerosene") && (
            <Kerosene
              leak={leakOn}
              level={game.kerosene}
              seated={game.keroseneSlot}
              enabled={canFree(keroseneInPlay && game.keroseneSlot == null)}
              onClick={() => place({ kind: "kerosene" })}
            />
          )}
          {vis("radio") && (
          <Module title="Radio" tone="blue" className="mod-radio-pilot">
            <div className="slots-row">
              <Slot tone="blue" noSwitch dice icon={<Headset />} target={{ kind: "radio", slot: 0, side: "pilot" }} taken={game.radioPilot !== null} label={face(game.radioPilot)} onClick={() => place({ kind: "radio", slot: 0, side: "pilot" })} enabled={canFree(mine("pilot") && game.radioPilot === null)} />
            </div>
          </Module>
          )}
          {vis("gear") && (
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
                  enabled={canFree(mine("pilot") && game.gearSlots[i] === null) && valOk(GEAR_RANGES[i])}
                />
              ))}
            </div>
          </Module>
          )}
        </div>
        )}
        {((windOn && vis("wind")) || vis("radio") || vis("flaps")) && (
        <div className="rail rail-copilot">
          {/* Wind sits right of the Co-Pilot's Radio (rail grid: see .with-wind). */}
          {windOn && vis("wind") && <Wind position={game.windPosition ?? 0} />}
          {vis("radio") && (
          <Module title="Radio" tone="orange" className="mod-radio-copilot">
            <div className="slots-col">
              {game.radioCopilot.map((val, i) => (
                <Slot key={i} tone="orange" noSwitch dice icon={<Headset />} target={{ kind: "radio", slot: i, side: "copilot" }} taken={val !== null} label={face(val)} onClick={() => place({ kind: "radio", slot: i, side: "copilot" })} enabled={canFree(mine("copilot") && val === null)} />
              ))}
            </div>
          </Module>
          )}
          {vis("flaps") && (
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
                    enabled={canFree(mine("copilot") && (i === nextFlap || green) && game.flapSlots[i] === null) && valOk(FLAP_RANGES[i])}
                  />
                </Fragment>
              ))}
            </div>
          </Module>
          )}
        </div>
        )}

        {/* Dice tray + log */}
        <section className="tray">
          {snapshot.debrief && between}
          {myCrew && !snapshot.debrief && (
            <div className="hand">
              <label>
                Your dice ({label(myCrew)}){selValue !== null && ` — placing as ${selValue}`}
              </label>
              <div className="dice">
                {/* A freshly trained Intern token must be placed before any die:
                    it leads the tray, in the Intern's colours, a size down. */}
                {trafficHeldMine && (
                  <button
                    className={`die traffic-die ${selected === TRAFFIC_DIE ? "sel" : ""} ${drag?.dieId === TRAFFIC_DIE ? "lifted" : ""}`}
                    title="Traffic die (Synchronisation) — place it on any empty space, any colour"
                    onPointerDown={(e) => startDrag(e, { id: TRAFFIC_DIE, value: trafficHeld.value })}
                  >
                    {trafficHeld.value}
                  </button>
                )}
                {internHeldMine && (
                  <button
                    className={`die intern-die ${selected === INTERN_TOKEN ? "sel" : ""} ${drag?.dieId === INTERN_TOKEN ? "lifted" : ""}`}
                    title="Intern token — place it now (not on Concentration; no Coffee)"
                    onPointerDown={(e) => startDrag(e, { id: INTERN_TOKEN, value: internHeld.value })}
                  >
                    {internHeld.value}
                  </button>
                )}
                {myDice.map((d) => {
                  const picked = rerollActive && rerollPick.includes(d.id);
                  return (
                    <button
                      key={d.id}
                      className={`die ${myCrew} ${selected === d.id ? "sel" : ""} ${d.placed ? "spent" : ""} ${drag?.dieId === d.id ? "lifted" : ""} ${picked ? "picked" : ""}`}
                      disabled={
                        rerollActive || pickActive
                          ? d.placed
                          : d.placed || !myTurn || game.pendingReroll !== null || game.pendingSwap !== null || internHeldMine || trafficHeld !== null || internHeld !== null
                      }
                      title={
                        pickActive === "adapt" && d.value !== undefined
                          ? `Turn over → ${7 - d.value}`
                          : pickActive === "anticipate"
                            ? "Reroll this die"
                            : pickActive === "swap"
                              ? "Swap this die's value"
                              : undefined
                      }
                      onPointerDown={rerollActive || pickActive ? undefined : (e) => startDrag(e, d)}
                      onClick={rerollActive ? () => toggleRerollDie(d.id) : pickActive ? () => pickDie(d.id) : undefined}
                    >
                      {d.placed ? "" : selected === d.id && selValue !== null ? selValue : (d.value ?? "")}
                    </button>
                  );
                })}
                <span className="opp">
                  {names[myCrew === "pilot" ? "copilot" : "pilot"] ?? label(myCrew === "pilot" ? "copilot" : "pilot")}:
                  <span className="opp-dice">
                    {oppDice.map((d) => (
                      <span key={d.id} className={`die mini facedown ${d.placed ? "spent" : ""}`} />
                    ))}
                  </span>
                </span>
              </div>
              {vis("abilities") && <Abilities
                abilities={game.scenario.abilities ?? []}
                actions={{
                  adaptation:
                    myCrew && !game.adaptationUsed[myCrew] ? (
                      pickButton("adapt", "Flip a die", canAdapt, "Tap one of your dice to turn it over")
                    ) : (
                      <span className="ability-used">used</span>
                    ),
                  workingTogether: waitingForSwap ? (
                    <span className="ability-used">waiting…</span>
                  ) : mustAnswerSwap ? (
                    <span className="ability-used">tap a die</span>
                  ) : game.swappedThisRound ? (
                    <span className="ability-used">used this round</span>
                  ) : myTurn ? (
                    pickButton("swap", "Swap a die", canOfferSwap, "Offer one of your dice; the other player must swap one back")
                  ) : undefined,
                  anticipation:
                    myCrew === firstPlayerForRound(game.round)
                      ? game.anticipated
                        ? <span className="ability-used">used this round</span>
                        : pickButton("anticipate", "Reroll a die", canAnticipate, "Before your first die: tap one of your dice to reroll it")
                      : undefined,
                }}
              />}
              <div className="controls">
                {rerollActive ? (
                  <span className="reroll-pick">
                    <span className="muted">
                      {iMustRespond ? "Reroll offered — pick yours" : "Pick dice to reroll"}
                    </span>
                    {iMustRespond ? (
                      <button className="reroll" onClick={confirmReroll}>
                        {rerollPick.length ? <>Reroll {rerollPick.length} <Dice /></> : "Skip"}
                      </button>
                    ) : (
                      <>
                        <button className="reroll" disabled={rerollPick.length === 0} onClick={confirmReroll}>
                          Reroll {rerollPick.length} <Dice />
                        </button>
                        <button onClick={cancelReroll}>Cancel</button>
                      </>
                    )}
                  </span>
                ) : waitingForReroll ? (
                  <span className="muted">Waiting for {who(game.pendingReroll!)} to reroll…</span>
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
                    {vis("reroll") && (
                      <button className="reroll" disabled={game.rerollTokens <= 0 || !myTurn || myDice.every((d) => d.placed)} onClick={startReroll}>
                        Reroll <Dice /> ×{game.rerollTokens}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {!show && (
            <ul className="log">
              {game.log.slice(-7).map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </section>

        {/* Pointer-positioned overlays live on <body>, outside the board: on
            phones the stage is CSS-zoomed, and fixed positions inside a zoomed
            subtree would be scaled away from the pointer's coordinates. */}
        {createPortal(
          <>
            {hoverRect && (
              <div
                className="drop-ring"
                style={{ left: hoverRect.x, top: hoverRect.y, width: hoverRect.w, height: hoverRect.h }}
                aria-hidden="true"
              />
            )}
            {drag && (
              <div className={`drag-die ${drag.dieId === INTERN_TOKEN ? "intern" : drag.dieId === TRAFFIC_DIE ? "traffic" : drag.crew}`} style={{ left: drag.x, top: drag.y }} aria-hidden="true">
                {drag.value}
              </div>
            )}
          </>,
          document.body,
        )}
      </div>
    </ExtraDieContext.Provider>
  );
}
