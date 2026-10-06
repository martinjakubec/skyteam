// Bot and game-driving tests (pure, no server). Run via `npm test`.
import { newGame, applyIntent, randDice, shuffledInternTokens, settle, mulberry32, DEFAULT_SETUP } from "../packages/shared/src/index.ts";

let failures = 0;
/** Two moves lead to the same game: the same space (spelled with or without the
 *  crew's own side), a die of the same value, the same Coffee spent. */
const sameGame = (view, crew, a, b) => {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type !== "placeDie") return JSON.stringify(a) === JSON.stringify(b);
  const val = (m) => view.dice[crew].find((d) => d.id === m.dieId)?.value;
  const sp = (t) => `${t.kind}:${t.slot ?? ""}:${t.space ?? ""}:${t.side ?? crew}`;
  return sp(a.target) === sp(b.target) && val(a) === val(b) && (a.coffeeDelta ?? 0) === (b.coffeeDelta ?? 0);
};
/** The rules accept this move from `who` on `state` (the same move can be spelled differently). */
const accepts = (state, who, m) => { try { return !!m && !!applyIntent(state, m, who, mulberry32(1), () => 0); } catch { return false; } };
const check = (label, cond) => { console.log(`${cond ? "  ✅" : "  ❌"} ${label}`); if (!cond) failures++; };
const P = "P", C = "C";
const clock = () => 0;

console.log("1) Dealing and driving games from a random source");
{
  const g = newGame({ ...DEFAULT_SETUP, modules: ["intern"] }, P, C, mulberry32(1), 0);
  check("a new game is dealt and rolled", g.phase === "placement" && g.dice.pilot.length === 4 && g.internTokens.length === 6);
  check("same seed, same game", JSON.stringify(newGame(DEFAULT_SETUP, P, C, mulberry32(7), 0)) === JSON.stringify(newGame(DEFAULT_SETUP, P, C, mulberry32(7), 0)));
  check("Intern tokens are 1–6 once each", shuffledInternTokens(mulberry32(2)).slice().sort().join() === "1,2,3,4,5,6");
  const d = randDice(mulberry32(3));
  const rolls = Array.from({ length: 200 }, () => d.d6());
  check("random dice cover 1–6 and nothing else", new Set(rolls).size === 6 && rolls.every((v) => v >= 1 && v <= 6));
  const traffic = newGame({ scenarioId: "red-HND", modules: [], abilities: [] }, P, C, mulberry32(4), 0);
  const printed = traffic.scenario.approachTrack.reduce((a, sp) => a + sp.traffic, 0);
  check("a round on a Traffic-dice space rolls them (red-HND starts with 3)", traffic.phase === "placement" && traffic.airplanes.reduce((a, b) => a + b, 0) === printed + 3);
  const rt = newGame({ ...DEFAULT_SETUP, modules: ["realTime"] }, P, C, mulberry32(5), 1000);
  check("a Real-Time game's clock starts at the given time", rt.timerEndsAt !== null && rt.timerEndsAt > 1000);
  const quick = newGame({ ...DEFAULT_SETUP, modules: ["realTime"] }, P, C, mulberry32(5), 1000, { realTimeSeconds: 3 });
  check("newGame can shorten the Real-Time round (for test servers)", quick.timerEndsAt === 4000);
  const placed = applyIntent(g, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, P, mulberry32(6), clock);
  check("applyIntent applies and settles", placed.axis.pilot !== null && placed.turn === "copilot");
  check("settle leaves a placement-ready game", settle(g, randDice(mulberry32(8)), clock).phase === "placement");
}

console.log("2) legalMoves from the bot's own (redacted) view");
{
  const { legalMoves, redactGameStateFor } = await import("../packages/shared/src/index.ts");
  const full = newGame({ ...DEFAULT_SETUP, modules: ["kerosene", "intern"], abilities: ["adaptation", "workingTogether"] }, P, C, mulberry32(11), 0);
  const view = redactGameStateFor(full, P);
  const moves = legalMoves(view, "pilot");
  check("there are moves on the Pilot's turn", moves.length > 0);
  check("every move is legal on the full state", moves.every((m) => { try { applyIntent(full, m, P, mulberry32(1), clock); return true; } catch { return false; } }));
  check("includes an Axis placement", moves.some((m) => m.type === "placeDie" && m.target.kind === "axis"));
  check("includes Adaptation and a Working Together offer", moves.some((m) => m.type === "adapt") && moves.some((m) => m.type === "swap"));
  check("wire commands only (no server values)", moves.every((m) => !("values" in m) && !("value" in m)));
  const nextToken = full.internTokens.find((t) => t !== null);
  const trainer = full.dice.pilot.find((d) => d.value !== nextToken);
  const holding = applyIntent(full, { type: "placeDie", dieId: trainer.id, target: { kind: "intern" } }, P, mulberry32(2), clock);
  const tokenMoves = legalMoves(redactGameStateFor(holding, P), "pilot");
  check("a held Intern token: only token placements, never Concentration", tokenMoves.length > 0 && tokenMoves.every((m) => m.type === "placeIntern" && m.target.kind !== "concentration"));
  check("off-turn: only off-turn actions (Adaptation)", legalMoves(redactGameStateFor(full, C), "copilot").every((m) => m.type === "adapt"));
}

console.log("3) actorFor, evaluate, quickMove (the one-step strategy)");
{
  const { actorFor, chooseMove, quickMove, evaluate, redactGameStateFor, createInitialGameState, reduce, scenarioForSetup } = await import("../packages/shared/src/index.ts");
  const t0 = () => fresh([2, 1, 1, 1], [1, 1, 1, 1]);
  const setup = (mods = [], abs = [], scenarioId = "YUL") => ({ scenarioId, modules: mods, abilities: abs });
  const fresh = (dp, dc, s = setup()) => reduce(createInitialGameState(scenarioForSetup(s), P, C), { type: "roll", pilot: dp, copilot: dc }, "").state;

  check("actor: turn by default", actorFor(fresh([1, 1, 1, 1], [1, 1, 1, 1])) === "pilot");
  const swap = reduce(fresh([1, 2, 3, 4], [6, 5, 4, 3], setup([], ["workingTogether"])), { type: "swap", dieId: 0 }, P).state;
  check("actor: the player who must answer a swap", actorFor(swap) === "copilot");
  check("actor: nobody once the game is over", actorFor({ ...fresh([1, 1, 1, 1], [1, 1, 1, 1]), outcome: { result: "won" }, phase: "won" }) === null);

  // Avoid a spin (YUL spins at ±3): the Co-Pilot's Axis is a 6; the Pilot holds 1, 5, 6, 6 → must not play the 1.
  let s = fresh([1, 5, 6, 6], [6, 1, 1, 1]);
  s.turn = "copilot";
  s = reduce(s, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, C).state;
  const m = quickMove(redactGameStateFor(s, P), "pilot", mulberry32(1));
  check("doesn't spin the plane", !(m.type === "placeDie" && m.target.kind === "axis" && s.dice.pilot[m.dieId].value === 1));

  // Keep the die that saves the Axis: the Co-Pilot's 6 is down, so only the
  // Pilot's 5 avoids a spin — it must not be spent on the Radio or Gear first.
  let k = fresh([5, 1, 1, 2], [6, 1, 1, 1]);
  k.turn = "copilot";
  k = reduce(k, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, C).state;
  const keep = quickMove(redactGameStateFor(k, P), "pilot", mulberry32(4));
  check("keeps the only die that avoids a spin for the Axis", !(keep.type === "placeDie" && k.dice.pilot[keep.dieId].value === 5 && keep.target.kind !== "axis"));

  // First Axis die, partner's unknown: a 1 spins on any partner 4–6, a 3 only on a 6.
  const half = (v) => redactGameStateFor(reduce(fresh([v, 2, 2, 2], [1, 1, 1, 1]), { type: "placeDie", dieId: 0, target: { kind: "axis" } }, P).state, P);
  check("a first Axis die near the middle beats an extreme one (spin risk)", evaluate(half(3), "pilot") > evaluate(half(1), "pilot"));

  // Partner's Axis die unknown: the Pilot's 3 is its safest Axis die (1s and 6s
  // spin on half the partner's faces), so it isn't spent elsewhere first.
  const r = fresh([3, 1, 6, 6], [1, 1, 1, 1]);
  const first = quickMove(redactGameStateFor(r, P), "pilot", mulberry32(5));
  check("keeps its safest Axis die rather than spending it elsewhere", !(first.type === "placeDie" && r.dice.pilot[first.dieId].value === 3 && first.target.kind !== "axis"));

  // Pace: after round 1's move, 5 moving rounds remain (2–6), not 6, so YUL's
  // 6 spaces need the plane on space 1 already.
  const paced = (position) => ({ ...fresh([1, 1, 1, 1], [1, 1, 1, 1]), engines: { pilot: 3, copilot: 3 }, position, airplanes: Array(7).fill(0) });
  check("pace counts the rounds left after this round's move", evaluate(paced(1), "pilot") > evaluate(paced(0), "pilot"));
  // Behind schedule (round 5, 3 spaces left, 1 moving round after this one): a
  // hand that can reach speed 9+ for a double move beats one that can't.
  const behind = (hand) => ({ ...fresh(hand, [1, 1, 1, 1]), round: 5, position: 3, airplanes: Array(7).fill(0) });
  check("pace: keeps the fast Engine dice it needs to catch up", evaluate(behind([6, 6, 6, 6]), "pilot") - evaluate(behind([1, 1, 1, 1]), "pilot") > 500);
  check("pace: leaving a space with an airplane on it is fatal", evaluate({ ...behind([6, 6, 6, 6]), airplanes: [0, 0, 0, 1, 0, 0, 0] }, "pilot") < evaluate(behind([6, 6, 6, 6]), "pilot") - 2000);

  // Landing round: the Axis must end level, and the speed must fit the last Brakes.
  const landing = (hand, extra = {}) => ({ ...fresh([1, 1, 1, 1], hand), round: 7, axis: { pilot: 3, copilot: null, offset: 0 }, ...extra });
  check("landing round: an Axis die that leaves the plane tilted is fatal", evaluate(landing([3, 1, 1, 1]), "copilot") - evaluate(landing([4, 4, 4, 4]), "copilot") > 2000);
  const brakes = (hand) => landing(hand, { axis: { pilot: 3, copilot: 3, offset: 0 }, engines: { pilot: 3, copilot: null }, brakesDeployed: 2 });
  check("landing round: an Engine die too fast for the Brakes is fatal", evaluate(brakes([1, 1, 1, 1]), "copilot") - evaluate(brakes([6, 6, 6, 6]), "copilot") > 2000);
  check("more Brakes are better (a normal landing speed needs them)", evaluate({ ...t0(), brakesDeployed: 2 }, "pilot") > evaluate({ ...t0(), brakesDeployed: 1 }, "pilot"));

  // The bot simulates on its redacted view: the partner's hidden dice may fit
  // a space, so they must never be judged stuck (and discarded) there.
  let h = fresh([3, 1, 4, 4], [3, 1, 6, 5]);
  h.dice.pilot.slice(0, 3).forEach((d) => (d.placed = true));
  h.dice.copilot.slice(0, 3).forEach((d) => (d.placed = true));
  h = { ...h, axis: { pilot: 3, copilot: 3, offset: 0 }, engines: { pilot: 1, copilot: 1 }, radioCopilot: [6, 6], placedThisRound: 6, turn: "pilot",
    concentrationSlots: [{ value: 4, crew: "pilot" }, { value: 6, crew: "copilot" }] };
  const sim = reduce(redactGameStateFor(h, P), { type: "placeDie", dieId: 3, target: { kind: "radio", slot: 0 } }, P).state;
  check("a hidden partner die is never discarded in the bot's simulation", sim.round === 1 && sim.dice.copilot.some((d) => !d.placed));
  // Landing round, both dice down: a tilt or a speed over the Brakes is as fatal as before placing.
  const down = (extra) => ({ ...fresh([1, 1, 1, 1], [1, 1, 1, 1]), round: 7, brakesDeployed: 2, ...extra });
  check("landing round: both Engine dice down and too fast is fatal", evaluate(down({ engines: { pilot: 3, copilot: 1 } }), "pilot") - evaluate(down({ engines: { pilot: 3, copilot: 4 } }), "pilot") > 2000);
  check("landing round: both Axis dice down and tilted is fatal", evaluate(down({ axis: { pilot: 3, copilot: 3, offset: 0 } }), "pilot") - evaluate(down({ axis: { pilot: 4, copilot: 3, offset: 1 } }), "pilot") > 2000);

  // Deferred review fixes (plan 3, Task 4):
  const land7 = (extra) => ({ ...fresh([1, 1, 1, 1], [4, 4, 4, 4]), round: 7, gearGreen: [true, true, true], ...extra });
  const oneFlapLeft = evaluate(land7({ flapsGreen: [true, true, true, false] }), "copilot");
  const allFlaps = evaluate(land7({ flapsGreen: [true, true, true, true] }), "copilot");
  check("landing round: a switch that can still be set this round isn't 'out of time'", allFlaps - oneFlapLeft < 200);
  const turnAt = (pos, allowed) => (st) => ({ ...st, scenario: { ...st.scenario, approachTrack: st.scenario.approachTrack.map((sp, i) => (i === pos ? { ...sp, axisAllowed: allowed } : sp)) } });
  const tilted7 = land7({ flapsGreen: [true, true, true, true], axis: { pilot: 4, copilot: 3, offset: -1 } });
  check("landing round: no Turn penalty (the plane doesn't move)", evaluate(turnAt(0, [0])(tilted7), "copilot") === evaluate(tilted7, "copilot"));
  const before = { ...fresh([1, 1, 1, 1], [1, 1, 1, 1]), round: 2, axis: { pilot: null, copilot: null, offset: -1 } };
  // Before the tilt is final only the aim toward the turn's tilt counts (turnPrep), never the full penalty.
  const { EVAL_WEIGHTS: EW } = await import("../packages/shared/src/index.ts");
  const aimCost = evaluate(before, "pilot") - evaluate(turnAt(0, [0])(before), "pilot");
  check("no Turn penalty before this round's Axis dice are down (only the aim toward its tilt)", aimCost >= 0 && aimCost < EW.turn);
  const double = { ...fresh([6, 6, 6, 6], [1, 1, 1, 1]), round: 3, position: 2, airplanes: Array(8).fill(0), axis: { pilot: 3, copilot: 3, offset: 0 }, engines: { pilot: null, copilot: 6 } };
  check("pace: a double move through a space whose Turn forbids the tilt is fatal", evaluate(turnAt(3, [1])(double), "pilot") < evaluate(double, "pilot") - 2000);

  // Every game: the crew's own Axis and Engine are worth filling early — the
  // search's shortlist then keeps them in view (YUL 37 → 56 of 80 landings).
  {
    const g = newGame(DEFAULT_SETUP, P, C, mulberry32(4), 0);
    const filled = { ...g, axis: { ...g.axis, pilot: 3 }, engines: { ...g.engines, pilot: 3 } };
    check("evaluate: an open Axis and Engine of the crew's own cost (plain YUL too)", evaluate(g, "pilot") < evaluate(filled, "pilot") - 1000);
  }

  // Real-Time: when the round may end soon, an open Axis or Engine loses —
  // so with little time left the bot fills its own first.
  const rtFirst = [0, 1, 2, 3, 4, 5].map((seed) => {
    const g = newGame({ ...DEFAULT_SETUP, modules: ["realTime"] }, P, C, mulberry32(seed), 0);
    const m = chooseMove(redactGameStateFor(g, P), "pilot", mulberry32(seed), { samples: 2, now: g.timerEndsAt - 10_000 });
    return m.type === "placeDie" && (m.target.kind === "axis" || m.target.kind === "engine");
  });
  check("Real-Time, 10 s left: Aviator fills its Axis and Engine first", rtFirst.every(Boolean));
  {
    const { realTimeFirst, legalMoves } = await import("../packages/shared/src/index.ts");
    const g = newGame({ ...DEFAULT_SETUP, modules: ["realTime"] }, P, C, mulberry32(3), 0);
    const all = legalMoves(redactGameStateFor(g, P), "pilot");
    check("Real-Time, a full minute left: every move stays open", realTimeFirst(redactGameStateFor(g, P), "pilot", all, g.timerEndsAt - 60_000).length === all.length);
    const paused = { ...g, timerEndsAt: null, timerRemainingMs: 5_000 };
    check("Real-Time, clock paused: every move stays open", realTimeFirst(redactGameStateFor(paused, P), "pilot", all, 0).length === all.length);
  }

  // Step 4: switch capacity per crew (each has its own two free dice a round), and
  // Flaps — in order, with set numbers — realistically about one a round.
  const sw = (gear, flaps, round) => ({ ...fresh([1, 1, 1, 1], [1, 1, 1, 1]), round, airplanes: Array(8).fill(0), position: 7 - Math.max(0, 7 - round),
    gearGreen: [0, 1, 2].map((i) => i >= gear), flapsGreen: [0, 1, 2, 3].map((i) => i >= flaps) });
  check("landing round: 2 Gear + 2 Flaps left is tight but each crew can still do it", evaluate(sw(0, 0, 7), "pilot") - evaluate(sw(2, 2, 7), "pilot") < 600);
  check("round 6: 4 Flaps left is much worse than 2 (about one Flaps a round)", evaluate(sw(0, 2, 6), "pilot") - evaluate(sw(0, 4, 6), "pilot") > 300);

  // Step 6: the evaluator's weights are tunable.
  const { EVAL_WEIGHTS } = await import("../packages/shared/src/index.ts");
  const probe = fresh([2, 1, 1, 1], [1, 1, 1, 1]);
  const base = evaluate(probe, "pilot");
  const savedW = { ...EVAL_WEIGHTS };
  EVAL_WEIGHTS.switchTodo *= 2;
  const changed = evaluate(probe, "pilot");
  Object.assign(EVAL_WEIGHTS, savedW);
  check("tunable evaluator: a weight changes the score", changed < base && evaluate(probe, "pilot") === base);

  const t = fresh([2, 1, 1, 1], [1, 1, 1, 1]);
  check("evaluate prefers fewer airplanes", evaluate({ ...t, airplanes: t.airplanes.map((a, i) => (i === 2 ? 0 : a)) }, "pilot") > evaluate(t, "pilot"));

  // Turns: on a space whose Turn forbids the current tilt the plane can't fly on.
  const turn = { ...t, scenario: { ...t.scenario, approachTrack: t.scenario.approachTrack.map((sp, i) => (i === 0 ? { ...sp, axisAllowed: [1, 0] } : sp)) } };
  check("evaluate penalises a tilt the Turn forbids", evaluate({ ...turn, axis: { ...turn.axis, offset: -1 } }, "pilot") < evaluate({ ...turn, axis: { ...turn.axis, offset: 1 } }, "pilot"));

  const n = reduce(fresh([2, 1, 1, 1], [1, 1, 1, 1], setup(["intern"])), { type: "placeDie", dieId: 0, target: { kind: "intern" } }, P).state;
  check("places a held Intern token", quickMove(redactGameStateFor(n, P), "pilot", mulberry32(2))?.type === "placeIntern");

  const over = { ...fresh([1, 1, 1, 1], [1, 1, 1, 1]), phase: "lost" };
  check("no legal move → null (Aviator and its quick strategy)", quickMove(over, "pilot", mulberry32(3)) === null && chooseMove(over, "pilot", mulberry32(3), { samples: 2 }) === null);
}

console.log("4) Self-play: every card, every module combination, every ability");
{
  const { selfPlay, representativeSetups, cardSetups, ABILITY_IDS } = await import("../packages/shared/src/index.ts");
  check("all 21 cards are covered", cardSetups().length === 21);
  const setups = representativeSetups();
  check("every ability is played", ABILITY_IDS.every((a) => setups.some((s) => s.abilities.includes(a))));
  const label = (s) => `${s.scenarioId}: ${[...s.modules, ...s.abilities].join("+") || "base"}`;
  const results = setups.map((s, i) => ({ s, r: selfPlay(s, 1000 + i, 400, { strategy: "quick" }) }));
  const stuck = results.filter(({ r }) => r.outcome === "stuck");
  check(`${setups.length} setups each play to a finished game`, stuck.length === 0);
  stuck.slice(0, 5).forEach(({ s, r }) => console.log(`     ↳ stuck: ${label(s)} — ${r.reason}`));
  const a = selfPlay(setups[0], 42, 400, { strategy: "quick" });
  const b = selfPlay(setups[0], 42, 400, { strategy: "quick" });
  check("same seed, same game", JSON.stringify(a) === JSON.stringify(b));
}

console.log("5) Monte Carlo search (Aviator)");
{
  const { searchMove, determinize, rolloutRound, rankMoves, redactGameStateFor, createInitialGameState, scenarioForSetup, reduce, legalMoves } = await import("../packages/shared/src/index.ts");
  const fresh = (dp, dc, s = DEFAULT_SETUP) => reduce(createInitialGameState(scenarioForSetup(s), P, C), { type: "roll", pilot: dp, copilot: dc }, "").state;
  const g = fresh([1, 3, 4, 6], [2, 2, 5, 5]);
  const view = redactGameStateFor(g, P);
  const d = determinize(view, mulberry32(1));
  check("determinize fills every hidden die, keeps mine", d.dice.copilot.every((x) => x.value >= 1 && x.value <= 6 && !x.hidden) && d.dice.pilot.map((x) => x.value).join() === "1,3,4,6");
  const end = rolloutRound(d, mulberry32(2));
  check("a rollout finishes the round (or the game)", end.round === 2 || !!end.outcome);
  const moves = legalMoves(view, "pilot");
  check("rankMoves orders every legal move", rankMoves(view, "pilot", moves, mulberry32(9)).length === moves.length);
  const m = searchMove(view, "pilot", mulberry32(3), { budgetMs: 150, shortlist: 4, maxSamples: 20 });
  check("search returns a legal move", accepts(g, P, m));
  // One legal move → returned at once: the Pilot's last die, Axis done, Engine open.
  const lastDie = fresh([1, 1, 1, 4], [1, 1, 1, 1]);
  lastDie.dice.pilot.slice(0, 3).forEach((x) => (x.placed = true));
  lastDie.axis.pilot = 1;
  lastDie.rerollTokens = 0; // round 1's Reroll token would make a reroll legal too
  const only = legalMoves(redactGameStateFor(lastDie, P), "pilot");
  check("(setup: exactly one legal move — the Engine)", only.length === 1 && only[0].target?.kind === "engine");
  const t0 = Date.now();
  check("single legal move returned without sampling", JSON.stringify(searchMove(redactGameStateFor(lastDie, P), "pilot", mulberry32(4), { budgetMs: 5000 })) === JSON.stringify(only[0]) && Date.now() - t0 < 200);
  const t1 = Date.now();
  searchMove(view, "pilot", mulberry32(5), { budgetMs: 200 });
  check("respects its time budget", Date.now() - t1 < 600);
  // Final round: rollouts stop at the landing outcome.
  const last = { ...fresh([1, 1, 1, 1], [1, 1, 1, 1]), round: 7 };
  check("final-round rollout ends with an outcome", !!rolloutRound(determinize(redactGameStateFor(last, P), mulberry32(6)), mulberry32(7)).outcome);
  // A pending prompt for the bot: a Reroll offered to the Pilot is answered.
  const offered = { ...g, turn: "copilot", pendingReroll: "pilot" };
  check("search answers a pending Reroll prompt", searchMove(redactGameStateFor(offered, P), "pilot", mulberry32(8), { budgetMs: 100 })?.type === "reroll");
}

console.log("6) One bot: Aviator (its one-step quick strategy is internal)");
{
  const { chooseMove, quickMove, redactGameStateFor, BOT_LEVELS } = await import("../packages/shared/src/index.ts");
  check("Aviator is the only bot level", JSON.stringify(BOT_LEVELS) === JSON.stringify(["aviator"]));
  const full = newGame({ ...DEFAULT_SETUP, modules: ["kerosene"] }, P, C, mulberry32(21), 0);
  const view = redactGameStateFor(full, P);
  const t0 = Date.now();
  const a = chooseMove(view, "pilot", mulberry32(1), { budgetMs: 150 });
  check("Aviator searches (uses its budget) and returns a legal move", Date.now() - t0 >= 100 && accepts(full, P, a));
  const t1 = Date.now();
  const q = quickMove(view, "pilot", mulberry32(2));
  check("its quick strategy answers at once with a legal move", Date.now() - t1 < 100 && accepts(full, P, q));
}

console.log("7) Measurement: landing checklist; dice independent of the bots");
{
  const { landingChecks, selfPlay } = await import("../packages/shared/src/index.ts");
  const g = newGame(DEFAULT_SETUP, P, C, mulberry32(3), 0);
  const ready = { ...g, round: 7, position: 6, airplanes: Array(7).fill(0), gearGreen: [true, true, true], flapsGreen: [true, true, true, true], brakesDeployed: 3, axis: { pilot: 3, copilot: 3, offset: 0 }, lastSpeed: 6 };
  check("landingChecks: a ready plane passes every condition", Object.values(landingChecks(ready)).every(Boolean));
  const late = landingChecks({ ...ready, position: 5, flapsGreen: [true, true, true, false], lastSpeed: 9 });
  check("…and names each one that fails", !late.airport && !late.flaps && !late.brakes && late.gear && late.level && late.clear);
  const setup = { scenarioId: "YUL", modules: [], abilities: [] };
  const a = selfPlay(setup, 77, 400, { strategy: "quick" });
  const b = selfPlay(setup, 77, 400, { samples: 1 });
  const shared = Math.min(a.rolls.length, b.rolls.length);
  check("self-play: every round's roll depends on the seed only, not on the bots' play", shared >= 2 && a.rolls.slice(0, shared).join() === b.rolls.slice(0, shared).join());
}

console.log("8) Rollouts: a plan-aware fast policy, played to the end of the game");
{
  const { fastMove, rolloutGame, rolloutValue, searchMove, legalMoves, redactGameStateFor, createInitialGameState, scenarioForSetup, reduce, WIN } = await import("../packages/shared/src/index.ts");
  const fresh = (dp, dc) => reduce(createInitialGameState(scenarioForSetup(DEFAULT_SETUP), P, C), { type: "roll", pilot: dp, copilot: dc }, "").state;
  const die = (st, crew, m) => st.dice[crew].find((d) => d.id === m.dieId)?.value;
  // Answer the partner's Axis die: the Pilot levels the plane.
  let a = fresh([1, 4, 6, 2], [4, 1, 1, 1]);
  a = reduce({ ...a, turn: "copilot" }, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, C).state;
  const ma = fastMove(a, "pilot", mulberry32(1));
  check("fast policy: answers the partner's Axis die with the levelling die", ma.target.kind === "axis" && die(a, "pilot", ma) === 4);
  // Clear the first airplane ahead (YUL space 2 holds one): a 3 on the Radio.
  const r = fresh([3, 2, 2, 5], [1, 1, 1, 1]);
  const mr = fastMove(r, "pilot", mulberry32(2));
  check("fast policy: clears the airplane in the way", mr.target.kind === "radio" && die(r, "pilot", mr) === 3);
  // Deploy the next Flaps when the value is in hand.
  const f = { ...fresh([3, 3, 3, 3], [1, 5, 5, 5]), turn: "copilot", airplanes: Array(8).fill(0) };
  const mf = fastMove(f, "copilot", mulberry32(3));
  check("fast policy: deploys the next Flaps with a fitting die", mf.target.kind === "flaps" && die(f, "copilot", mf) === 1);
  // Landing round: the Engine die must keep the speed within the Brakes.
  let l = { ...fresh([1, 6, 5, 5], [3, 1, 1, 1]), round: 7, brakesDeployed: 2, airplanes: Array(8).fill(0), axis: { pilot: 5, copilot: 5, offset: 0 } };
  l.dice.pilot[2].placed = true;
  l.dice.copilot[1].placed = true;
  l = reduce({ ...l, turn: "copilot" }, { type: "placeDie", dieId: 0, target: { kind: "engine" } }, C).state;
  const ml = fastMove(l, "pilot", mulberry32(4));
  check("fast policy: landing round — an Engine die within the Brakes (1, not 6)", ml.target.kind === "engine" && die(l, "pilot", ml) === 1);
  // On schedule (round 2, 6 spaces, 5 moving rounds left): fly one space, don't stall.
  let p = { ...fresh([3, 3, 1, 1], [3, 5, 1, 1]), round: 2, position: 1, airplanes: Array(8).fill(0), turn: "copilot" };
  p = reduce(p, { type: "placeDie", dieId: 1, target: { kind: "engine" } }, C).state; // Co-Pilot's Engine: 5
  p.turn = "pilot";
  const mp = fastMove(p, "pilot", mulberry32(5));
  check("fast policy: on schedule, sets a speed that flies on (not 0)", mp.target.kind !== "engine" || die(p, "pilot", mp) + 5 > p.aeroBlue);
  // Never fly into traffic when a slower Engine die exists.
  let c = { ...fresh([6, 1, 2, 2], [4, 1, 1, 1]), airplanes: [0, 1, 0, 0, 0, 0, 0, 0], position: 0 }; // flying through space 1 collides
  c = reduce({ ...c, turn: "copilot" }, { type: "placeDie", dieId: 0, target: { kind: "engine" } }, C).state; // Co-Pilot's Engine: 4
  const mc = fastMove(c, "pilot", mulberry32(6));
  check("fast policy: no double move through a space with an airplane", !(mc.target.kind === "engine" && die(c, "pilot", mc) + 4 > c.aeroOrange));
  // Spare dice go on free spaces; the dice kept for the Axis and Engine stay put.
  const k = { ...fresh([3, 6, 6, 6], [1, 1, 1, 1]), airplanes: [0, 0, 0, 0, 0, 1, 0, 0] }; // a 6 could clear space 5, a 3 nothing
  const mk = fastMove(k, "pilot", mulberry32(7));
  check("fast policy: free placements use spare dice, not the one kept for the Axis", !(mk.target.kind !== "axis" && mk.target.kind !== "engine" && die(k, "pilot", mk) === 3));
  // Behind on Flaps (round 5, all four still up): Flaps before a far airplane, and Coffee makes a die fit.
  const behind = { ...fresh([5, 5, 5, 5], [5, 3, 5, 5]), round: 5, turn: "copilot", coffee: 1, airplanes: [0, 0, 1, 0, 0, 0, 0, 0] }; // the 3 is spare (5s level the Axis)
  const mb = fastMove(behind, "copilot", mulberry32(8));
  check("fast policy: behind on Flaps, deploys one (a 3 −1 Coffee → 2) before clearing a far airplane", mb.target.kind === "flaps" && die(behind, "copilot", mb) + (mb.coffeeDelta ?? 0) <= 2);
  // Early and behind schedule: no Landing Gear yet (it raises the speed needed to fly on).
  const early = { ...fresh([2, 3, 3, 4], [3, 3, 3, 3]), round: 2, position: 0, airplanes: Array(8).fill(0) }; // 7 spaces, 5 moving rounds after this
  const me = fastMove(early, "pilot", mulberry32(9));
  check("fast policy: behind schedule early on, keeps the Landing Gear up", me.target.kind !== "landingGear");
  // Step 6: the policy's choices come from tunable parameters.
  const { POLICY_PARAMS } = await import("../packages/shared/src/index.ts");
  const saved = { ...POLICY_PARAMS };
  POLICY_PARAMS.gearSlack = 10; // lower the Gear whenever a die fits
  const eager = fastMove(early, "pilot", mulberry32(9));
  Object.assign(POLICY_PARAMS, saved);
  check("tunable policy: a parameter changes the choice (eager Gear)", eager.target.kind === "landingGear" && fastMove(early, "pilot", mulberry32(9)).target.kind !== "landingGear");
  // Limit 1: with peek off, a crew plans only with what it could know — its own
  // dice and the partner's dice already down — not the partner's hidden hand.
  const pk = { ...fresh([1, 4, 6, 6], [1, 1, 1, 1]), airplanes: Array(8).fill(0) }; // partner holds only 1s
  POLICY_PARAMS.peek = true;
  const peeking = fastMove(pk, "pilot", mulberry32(10));
  POLICY_PARAMS.peek = false;
  const blind = fastMove(pk, "pilot", mulberry32(10));
  check("peek off: the Pilot doesn't plan around the partner's hidden 1s", JSON.stringify(peeking) !== JSON.stringify(blind));
  // The cheap pre-check never rules out a move the rules accept.
  const { maybeLegal, legalMoves: lm } = await import("../packages/shared/src/index.ts");
  let missed = 0, checked = 0;
  for (let seed = 0; seed < 30; seed++) {
    let st = newGame(DEFAULT_SETUP, P, C, mulberry32(seed), 0);
    for (let k = 0; k < 12 && !st.outcome; k++) {
      const crew = st.turn;
      for (const m of lm(st, crew)) if (m.type === "placeDie") { checked++; if (!maybeLegal(st, crew, m)) missed++; }
      const mv = fastMove(st, crew, mulberry32(seed + k));
      st = applyIntent(st, mv, crew === "pilot" ? P : C, mulberry32(seed * 31 + k), () => 0);
    }
  }
  check(`maybeLegal keeps every legal placement (${checked} checked)`, missed === 0 && checked > 500);
  // Full-game rollouts and their value.
  const g = newGame(DEFAULT_SETUP, P, C, mulberry32(12), 0);
  const end = rolloutGame(g, mulberry32(13));
  check("a full-game rollout ends with an outcome", !!end.outcome);
  check("rollout value: a landing beats a failed landing beats a crash", rolloutValue({ ...end, outcome: { result: "won" } }, "pilot") === WIN &&
    rolloutValue({ ...end, round: 7, outcome: { result: "lost", reason: "Landing failed: plane not level." } }, "pilot") > rolloutValue({ ...end, round: 3, outcome: { result: "lost", reason: "The plane went into a spin!" } }, "pilot"));
  const v = redactGameStateFor(g, P);
  const m = searchMove(v, "pilot", mulberry32(14), { budgetMs: Infinity, maxSamples: 3 });
  check("search over full-game rollouts returns a legal move", accepts(g, P, m));
}

console.log("9) Aviator's candidates include the rollout policy's own choice");
{
  const { searchCandidates, fastMove, redactGameStateFor } = await import("../packages/shared/src/index.ts");
  let included = 0;
  for (let seed = 0; seed < 10; seed++) {
    const v = redactGameStateFor(newGame(DEFAULT_SETUP, P, C, mulberry32(seed), 0), P);
    const own = JSON.stringify(fastMove(v, "pilot", mulberry32(seed)));
    if (searchCandidates(v, "pilot", mulberry32(seed), 6).some((m) => sameGame(v, "pilot", m, JSON.parse(own)))) included++;
  }
  check("the policy's move is always among the candidates", included === 10);
  // Step 5: no two candidates lead to the same game (same value on the same space).
  const key = (v, m) => m.type === "placeDie" ? `${m.target.kind}:${m.target.slot ?? ""}:${m.target.side ?? "pilot"}=${v.dice.pilot.find((d) => d.id === m.dieId).value}/${m.coffeeDelta ?? 0}` : JSON.stringify(m);
  let dupes = 0;
  for (let seed = 0; seed < 10; seed++) {
    const v = redactGameStateFor({ ...newGame(DEFAULT_SETUP, P, C, mulberry32(seed), 0), coffee: 2 }, P);
    const keys = searchCandidates(v, "pilot", mulberry32(seed), 6).map((m) => key(v, m));
    dupes += keys.length - new Set(keys).size;
  }
  check("candidates are all different moves (no same-value, same-space duplicates)", dupes === 0);
}

console.log("10) Fast rollouts: moves applied in place; surely-legal placements");
{
  const { reduceInPlace, placementCheck, fastMove, reduce, legalMoves, actorFor, determinize, redactGameStateFor, rolloutGame } = await import("../packages/shared/src/index.ts");
  const g = newGame(DEFAULT_SETUP, P, C, mulberry32(4), 0);
  const copy = structuredClone(g);
  const viaCopy = reduce(g, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, P).state;
  const inPlace = reduceInPlace(copy, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, P).state;
  check("reduceInPlace changes the state it's given, exactly as reduce would", inPlace === copy && JSON.stringify(inPlace) === JSON.stringify(viaCopy));
  // "Surely legal" must never be wrong: check it against the rules on many real positions.
  let wrong = 0, sure = 0;
  for (let seed = 0; seed < 40; seed++) {
    let st = newGame({ ...DEFAULT_SETUP, modules: seed % 2 ? ["kerosene", "intern"] : ["iceBrakes"] }, P, C, mulberry32(seed), 0);
    for (let k = 0; k < 30 && !st.outcome; k++) {
      const crew = actorFor(st);
      if (!crew) break;
      const id = crew === "pilot" ? P : C;
      for (const m of legalMoves(st, crew)) if (m.type === "placeDie" && placementCheck(st, crew, m) === false) wrong++;
      for (const d of st.dice[crew].filter((x) => !x.placed)) {
        for (const target of [{ kind: "axis" }, { kind: "engine" }, { kind: "radio", slot: 0 }, { kind: "radio", slot: 1 }, { kind: "concentration", slot: 0 }, { kind: "landingGear", slot: 1 }, { kind: "flaps", slot: 0 }, { kind: "brakes", slot: 0 }]) {
          const m = { type: "placeDie", dieId: d.id, target };
          if (placementCheck(st, crew, m) !== true) continue;
          sure++;
          try { reduce(st, m, id); } catch { wrong++; }
        }
      }
      st = applyIntent(st, fastMove(st, crew, mulberry32(seed + k)), id, mulberry32(seed * 7 + k), () => 0);
    }
  }
  check(`placementCheck: never rules out a legal move, never calls an illegal one sure (${sure} sure)`, wrong === 0 && sure > 500);
  // …and across every representative setup (all cards, module combinations,
  // abilities), every target, both sides, every slot, every Coffee adjustment.
  const { representativeSetups } = await import("../packages/shared/src/index.ts");
  const sides = ["pilot", "copilot", undefined];
  const ALL = [
    ...sides.flatMap((side) => [{ kind: "axis", side }, { kind: "engine", side }, { kind: "radio", slot: 0, side }, { kind: "radio", slot: 1, side }]),
    ...[0, 1, 2].map((slot) => ({ kind: "landingGear", slot })), ...[0, 1, 2, 3].map((slot) => ({ kind: "flaps", slot })),
    ...[0, 1, 2].map((slot) => ({ kind: "brakes", slot })), ...[0, 1].map((slot) => ({ kind: "concentration", slot })),
  ].map((t) => (t.side === undefined ? Object.fromEntries(Object.entries(t).filter(([k]) => k !== "side")) : t));
  let wide = 0, wideWrong = 0, wideSure = 0;
  for (const [n, setup] of representativeSetups().entries()) {
    let st = newGame(setup, P, C, mulberry32(500 + n), 0);
    for (let k = 0; k < 6 && !st.outcome; k++) {
      const crew = actorFor(st);
      if (!crew) break;
      const id = crew === "pilot" ? P : C;
      for (const d of st.dice[crew].filter((x) => !x.placed)) {
        for (let c = -st.coffee; c <= st.coffee; c++) {
          for (const target of ALL) {
            const m = { type: "placeDie", dieId: d.id, target, ...(c ? { coffeeDelta: c } : {}) };
            const verdict = placementCheck(st, crew, m);
            let ok = true;
            try { reduce(st, m, id); } catch { ok = false; }
            wide++;
            if (verdict === true) wideSure++;
            if ((verdict === true && !ok) || (verdict === false && ok)) wideWrong++;
          }
        }
      }
      st = applyIntent(st, fastMove(st, crew, mulberry32(n * 13 + k)), id, mulberry32(n * 31 + k), () => 0);
    }
  }
  check(`placementCheck agrees with the rules on every setup, target, side, slot and Coffee (${wide} checked, ${wideSure} sure)`, wideWrong === 0 && wideSure > 1000);
  const v = redactGameStateFor(newGame(DEFAULT_SETUP, P, C, mulberry32(5), 0), P);
  const world = determinize(v, mulberry32(6));
  check("a sampled world carries no log (nothing to copy or write)", world.log.length === 0 && (world.log.push("x"), world.log.length === 0));
  check("rollouts on sampled worlds still end in an outcome", !!rolloutGame(world, mulberry32(7)).outcome);
  // No quick-strategy fallback for an ordinary placement: a die that fits only an
  // already-set switch is placed by the policy's own catch-all.
  const { legalMoves: lmFast } = await import("../packages/shared/src/index.ts");
  let st = { ...newGame(DEFAULT_SETUP, P, C, mulberry32(8), 0), brakesDeployed: 1, gearGreen: [true, true, true], radioPilot: 6, concentrationSlots: [{ value: 1, crew: "copilot" }, { value: 1, crew: "copilot" }] };
  st.dice.pilot = [{ id: 0, value: 2, placed: false }, { id: 1, value: 5, placed: true }, { id: 2, value: 5, placed: true }, { id: 3, value: 5, placed: true }];
  st.axis = { pilot: 5, copilot: null, offset: 0 };
  st.engines = { pilot: 5, copilot: null };
  st.placedThisRound = 3;
  const tFast = performance.now();
  const mStuck = fastMove(st, "pilot", mulberry32(9));
  const spentFast = performance.now() - tFast;
  // (The 2 fits only switches that are already set — Brakes 2, or the down 1/2 Landing Gear.)
  check("an odd last die (a 2 that fits only set switches) is placed without the quick-strategy fallback", ["brakes", "landingGear"].includes(mStuck?.target?.kind) && accepts(st, P, mStuck) && spentFast < 5);
}

console.log("11) Parallel search: per-worker stats, merged");
{
  const { searchStats, pickBest, redactGameStateFor } = await import("../packages/shared/src/index.ts");
  const g = newGame(DEFAULT_SETUP, P, C, mulberry32(31), 0);
  const v = redactGameStateFor(g, P);
  const a = searchStats(v, "pilot", mulberry32(1), { budgetMs: Infinity, maxSamples: 4, candidateSeed: 99 });
  const b = searchStats(v, "pilot", mulberry32(2), { budgetMs: Infinity, maxSamples: 4, candidateSeed: 99 });
  check("workers given the same candidate seed compare the same candidates", JSON.stringify(a.candidates) === JSON.stringify(b.candidates) && a.candidates.length > 1);
  check("…but sample different worlds", JSON.stringify(a.totals) !== JSON.stringify(b.totals));
  const merged = pickBest([a, b]);
  check("pickBest merges their samples and returns a legal move", accepts(g, P, merged));
  const lopsided = { candidates: a.candidates, totals: a.candidates.map((_, i) => (i === 0 ? 9000 : 50 * 8)), counts: a.candidates.map((_, i) => (i === 0 ? 1 : 8)) };
  check("…ignoring a candidate with too few samples to trust", JSON.stringify(pickBest([lopsided])) !== JSON.stringify(a.candidates[0]));
}

console.log("12) Search robustness (review fixes)");
{
  const { searchStats, searchCandidates, pickBest, fastMove, redactGameStateFor } = await import("../packages/shared/src/index.ts");
  const g = newGame(DEFAULT_SETUP, P, C, mulberry32(41), 0);
  const v = redactGameStateFor(g, P);
  // A sample that throws a rule error is skipped and counted, not fatal to the search.
  const good = searchStats(v, "pilot", mulberry32(1), { budgetMs: Infinity, maxSamples: 2 }).candidates;
  const bad = { type: "placeDie", dieId: 0, target: { kind: "brakes", slot: 2 } }; // out of order: the rules refuse it
  let threw = false, st = null;
  try { st = searchStats(v, "pilot", mulberry32(2), { budgetMs: Infinity, maxSamples: 2, candidates: [...good, bad] }); } catch { threw = true; }
  check("a sample the rules refuse is skipped and counted (the search goes on)", !threw && st.errors > 0 && st.counts.slice(0, good.length).every((n) => n > 0));
  // No samples at all: still a move (the best-ranked candidate), never undefined.
  const none = pickBest([{ candidates: good, totals: good.map(() => 0), counts: good.map(() => 0) }]);
  check("with no samples, pickBest returns the best-ranked candidate", JSON.stringify(none) === JSON.stringify(good[0]));
  // The policy's own move survives even when a quick-strategy move puts the same value
  // on the same space without Coffee (different games: one spends a Coffee).
  let lost = 0;
  for (let seed = 0; seed < 20; seed++) {
    const vv = redactGameStateFor({ ...newGame(DEFAULT_SETUP, P, C, mulberry32(seed), 0), coffee: 2 }, P);
    const own = JSON.stringify(fastMove(vv, "pilot", mulberry32(seed)));
    if (!searchCandidates(vv, "pilot", mulberry32(seed), 6, undefined, false).some((m) => sameGame(vv, "pilot", m, JSON.parse(own)))) lost++;
  }
  check("the policy's own move is always kept (Coffee moves aren't 'duplicates')", lost === 0);
}

console.log("13) The rollout policy plays the modules (full information, 200 games each)");
{
  const { rolloutGame, landingChecks } = await import("../packages/shared/src/index.ts");
  const play = (modules) => Array.from({ length: 200 }, (_, i) =>
    rolloutGame(newGame({ scenarioId: "YUL", modules, abilities: [] }, P, C, mulberry32(i), 0), mulberry32(100000 + i)));
  const count = (games, f) => games.filter(f).length;
  const failed = (g, check) => /^Landing failed/.test(g.outcome?.reason ?? "") && !landingChecks(g)[check];
  const yul = play([]);
  check("plain YUL is unchanged by the module play (21 of 200 land; 19 before the flight plan)", count(yul, (g) => g.outcome?.result === "won") === 21);
  const kero = play(["kerosene"]);
  // (Before the policy knew the modules: 155 dry, 141 untrained, 154 without Ice Brakes.)
  check("Kerosene: the tank seldom runs dry (≤ 40 of 200)", count(kero, (g) => g.outcome?.reason === "Ran out of kerosene!") <= 40);
  check("Kerosene: games reach the landing (≥ 50 of 200)", count(kero, (g) => /^Landing/.test(g.outcome?.reason ?? "")) >= 50);
  const leak = play(["keroseneLeak"]);
  check("Kerosene Leak: the tank seldom runs dry (≤ 40 of 200; 77 before the Engines minded the leak)", count(leak, (g) => g.outcome?.reason === "Ran out of kerosene!") <= 40);
  check("Kerosene Leak: games land (≥ 9 of 200)", count(leak, (g) => g.outcome?.result === "won") >= 9);
  const intern = play(["intern"]);
  check("Intern: rarely lands untrained (≤ 15 of 200)", count(intern, (g) => failed(g, "intern")) <= 15);
  const ice = play(["iceBrakes"]);
  check("Ice Brakes: fewer landings without them (≤ 120 of 200)", count(ice, (g) => failed(g, "iceBrakes")) <= 120);
  check("Ice Brakes: steps get deployed (≥ 200 over 200 games)", ice.reduce((a, g) => a + g.brakesDeployed, 0) >= 200);
  // A failed landing with more Ice Brakes steps (or Intern tokens) done scores higher.
  const { rolloutValue } = await import("../packages/shared/src/index.ts");
  const failedAt = (modules, patch) => {
    const g = newGame({ scenarioId: "YUL", modules, abilities: [] }, P, C, mulberry32(5), 0);
    return Object.assign(g, { outcome: { result: "lost", reason: "Landing failed: x" }, phase: "lost" }, patch);
  };
  check("rollout score: more Ice Brakes steps on a failed landing score higher",
    rolloutValue(failedAt(["iceBrakes"], { brakesDeployed: 3 }), "pilot") > rolloutValue(failedAt(["iceBrakes"], { brakesDeployed: 1 }), "pilot"));
  const someTrained = (g) => ({ internTokens: g.internTokens.map((t, i) => (i < 4 ? null : t)) });
  const base = failedAt(["intern"], {});
  check("rollout score: more Intern tokens trained on a failed landing score higher",
    rolloutValue(failedAt(["intern"], someTrained(base)), "pilot") > rolloutValue(base, "pilot"));
  // The evaluator: the round's last free die on Kerosene beats leaving the
  // space to burn idle (6) at the round's end.
  const { evaluate, reduce: red } = await import("../packages/shared/src/index.ts");
  const kg = newGame({ scenarioId: "YUL", modules: ["kerosene"], abilities: [] }, P, C, mulberry32(8), 0);
  kg.dice.copilot = kg.dice.copilot.map((d) => ({ ...d, placed: true })); // the Co-Pilot is done…
  Object.assign(kg.axis, { pilot: 3, copilot: 3 });
  Object.assign(kg.engines, { pilot: 3, copilot: 3 });
  kg.dice.pilot = kg.dice.pilot.map((d, i) => ({ ...d, value: [3, 3, 2, 6][i], placed: i !== 2 })); // …the Pilot holds one 2
  kg.turn = "pilot";
  const two = kg.dice.pilot[2].id;
  const fed = red(kg, { type: "placeDie", dieId: two, target: { kind: "kerosene" } }, P).state;
  const notFed = red(kg, { type: "placeDie", dieId: two, target: { kind: "concentration", slot: 0 } }, P).state;
  check("evaluate: the last free die on Kerosene beats Concentration (the empty space burns 6)", evaluate(fed, "pilot") > evaluate(notFed, "pilot"));
  // The search always weighs the module spaces in play: here the Pilot's 2
  // could start the first Ice Brakes step.
  const { searchCandidates, redactGameStateFor } = await import("../packages/shared/src/index.ts");
  const ig = newGame({ scenarioId: "YUL", modules: ["iceBrakes"], abilities: [] }, P, C, mulberry32(8), 0);
  ig.dice.pilot = ig.dice.pilot.map((d, i) => ({ ...d, value: [4, 5, 2, 1][i] }));
  const iview = redactGameStateFor(ig, P);
  check("search candidates include an Ice Brakes move when one is legal",
    searchCandidates(iview, "pilot", mulberry32(1), 6, undefined, false).some((m) => m.target?.kind === "iceBrakes"));
  const kgc = newGame({ scenarioId: "YUL", modules: ["kerosene"], abilities: [] }, P, C, mulberry32(8), 0);
  check("search candidates include a Kerosene move when one is legal",
    searchCandidates(redactGameStateFor(kgc, P), "pilot", mulberry32(1), 6, undefined, false).some((m) => m.target?.kind === "kerosene"));
  const yulc = searchCandidates(redactGameStateFor(newGame(DEFAULT_SETUP, P, C, mulberry32(8), 0), P), "pilot", mulberry32(1), 6, undefined, false);
  check("plain YUL keeps its shortlist (6 candidates at most)", yulc.length <= 6);
  // Aviator's Ice Brakes plan: the Pilot starts the next step while the
  // Co-Pilot can still answer, and a started step is finished.
  const { icePlan } = await import("../packages/shared/src/index.ts");
  const { legalMoves } = await import("../packages/shared/src/index.ts");
  const clearPath = structuredClone(ig);
  clearPath.airplanes = clearPath.airplanes.map(() => 0);
  const startView = redactGameStateFor(clearPath, P);
  const startMoves = icePlan(startView, "pilot", legalMoves(startView, "pilot"));
  check("Ice Brakes plan: the Pilot holding a 2 starts the first step",
    startMoves.length > 0 && startMoves.every((m) => m.target?.kind === "iceBrakes" && m.target.space === "top"));
  const started = red(ig, { type: "placeDie", dieId: ig.dice.pilot[2].id, target: { kind: "iceBrakes", slot: 0, space: "top" } }, P).state;
  started.dice.copilot = started.dice.copilot.map((d, i) => ({ ...d, value: [2, 6, 6, 6][i] }));
  const finView = redactGameStateFor(started, C);
  const finMoves = icePlan(finView, "copilot", legalMoves(finView, "copilot"));
  check("Ice Brakes plan: the Co-Pilot finishes a started step",
    finMoves.length > 0 && finMoves.every((m) => m.target?.kind === "iceBrakes" && m.target.slot === 0 && m.target.space === "bottom"));
  const busy = structuredClone(ig);
  busy.airplanes[busy.position + 1] = 1; // an airplane on the next space: the dice may be needed to clear it
  const busyView = redactGameStateFor(busy, P);
  check("Ice Brakes plan: no forced start with an airplane on this space or the next",
    icePlan(busyView, "pilot", legalMoves(busyView, "pilot")).length === legalMoves(busyView, "pilot").length);
  const plainView = redactGameStateFor(newGame(DEFAULT_SETUP, P, C, mulberry32(8), 0), P);
  check("Ice Brakes plan: no effect without the module", icePlan(plainView, "pilot", legalMoves(plainView, "pilot")).length === legalMoves(plainView, "pilot").length);
  // Kerosene: while no Brakes are set, a Pilot holding a 2 sets them (the
  // tank wants the same die, and there's no landing without Brakes).
  const { keroseneBrakes } = await import("../packages/shared/src/index.ts");
  const kb = newGame({ scenarioId: "YUL", modules: ["kerosene"], abilities: [] }, P, C, mulberry32(8), 0);
  kb.dice.pilot = kb.dice.pilot.map((d, i) => ({ ...d, value: [2, 5, 6, 6][i] }));
  const kbView = redactGameStateFor(kb, P);
  const kbMoves = keroseneBrakes(kbView, "pilot", legalMoves(kbView, "pilot"));
  check("Kerosene: with no Brakes set, the Pilot's 2 sets the first", kbMoves.length > 0 && kbMoves.every((m) => m.target?.kind === "brakes" && m.target.slot === 0));
  const kbPlain = redactGameStateFor({ ...kb, scenario: { ...kb.scenario, modules: [] } }, P);
  check("…and nothing changes without Kerosene", keroseneBrakes(kbPlain, "pilot", legalMoves(kbPlain, "pilot")).length === legalMoves(kbPlain, "pilot").length);
  // A half-filled Ice Brakes step is worth something (if the partner finishes it).
  const half = red(ig, { type: "placeDie", dieId: ig.dice.pilot[2].id, target: { kind: "iceBrakes", slot: 0, space: "top" } }, P).state;
  const elsewhere = red(ig, { type: "placeDie", dieId: ig.dice.pilot[2].id, target: { kind: "concentration", slot: 0 } }, P).state;
  check("evaluate: a started Ice Brakes step beats a Coffee", evaluate(half, "pilot") > evaluate(elsewhere, "pilot"));
  check("Intern: games land (≥ 25 of 200)", count(intern, (g) => g.outcome?.result === "won") >= 25);
}

console.log("14) Aviator searches the Special Abilities");
{
  const { searchCandidates, fastMove, redactGameStateFor, createInitialGameState, scenarioForSetup, reduce } = await import("../packages/shared/src/index.ts");
  // Round 1, the Pilot (First Player) before their first die: every Anticipation
  // die is searched, though the one-step score sees a reroll as "no change".
  const setup = (abilities) => ({ scenarioId: "green-PRG", modules: [], abilities });
  const g = newGame(setup(["anticipation", "adaptation"]), P, C, mulberry32(1), 0);
  const v = redactGameStateFor(g, P);
  const cands = searchCandidates(v, "pilot", mulberry32(2), 6);
  check("every Anticipation die is a candidate", cands.filter((m) => m.type === "anticipate").length === 4);
  check("…and an Adaptation", cands.some((m) => m.type === "adapt"));
  // Control: the Co-Pilot's 4 is down on a +1 tilt; the Pilot's 2 and 4 leave it
  // equally off (−1 / +1), but the matching 4 earns a Coffee.
  // (yellow-PRG: no turn near the start, so the tie is only the tilt's.)
  const fresh = (abilities, dp, dc) => reduce(createInitialGameState(scenarioForSetup({ scenarioId: "yellow-PRG", modules: [], abilities }), P, C), { type: "roll", pilot: dp, copilot: dc, traffic: [] }, "").state;
  const answer = (abilities) => {
    let s = fresh(abilities, [2, 4, 6, 6], [4, 1, 1, 1]);
    s = reduce({ ...s, turn: "copilot", axis: { ...s.axis, offset: 1 } }, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, C).state;
    const m = fastMove(s, "pilot", mulberry32(3));
    return m.target.kind === "axis" ? s.dice.pilot[m.dieId].value : null;
  };
  check("Control: a tie on the Axis goes to the die matching the partner's", answer(["control"]) === 4 && answer([]) === 2);
}

const { BOT_PROFILES: BOT_PROFILES_ALL } = await import("../packages/shared/src/index.ts");
console.log("15) Flight plan and card profiles");
{
  const { flightPlan, turnTarget, policyFor, weightsFor, BOT_PROFILES, POLICY_PARAMS, EVAL_WEIGHTS, SCENARIOS, scenarioForSetup } = await import("../packages/shared/src/index.ts");
  const yul = flightPlan(SCENARIOS.YUL);
  check("plan: YUL is one space a round", yul.airport === 6 && yul.target.slice(0, 8).join() === "0,1,2,3,4,5,6,6");
  const tgu = flightPlan(SCENARIOS["yellow-TGU"]);
  check("plan: a short track is front-loaded (TGU: 4 spaces over 6 moving rounds)", tgu.target.slice(0, 8).join() === "0,1,2,2,3,4,4,4");
  check("plan: turns and Traffic dice come from the track", tgu.turn[1] !== null && tgu.turn[0] === null && tgu.trafficDice[0] === 3);
  const custom = flightPlan({ ...SCENARIOS.YUL, cardId: undefined, approachTrack: [{ traffic: 0 }, { traffic: 0, axisAllowed: [1] }, { traffic: 0, airport: true }] });
  check("plan: a hand-built board without a card gets its own plan", custom.airport === 2 && custom.turn[1].join() === "1");
  check("cardId: every card's board carries it", SCENARIOS["yellow-TGU"].cardId === "yellow-TGU" && SCENARIOS.YUL.cardId === "green-YUL");
  // Profiles: no profile, or no cardId -> the defaults themselves; a profile overrides only its keys.
  const g = newGame(DEFAULT_SETUP, P, C, mulberry32(1), 0);
  check("profiles: no profile -> the defaults", policyFor(g) === POLICY_PARAMS && weightsFor(g) === EVAL_WEIGHTS);
  BOT_PROFILES["green-YUL"] = { policy: { paceWeight: 99 }, eval: { tilt: 1 } };
  const p = policyFor(g), w = weightsFor(g);
  check("profiles: a card's overrides win, the rest are defaults", p.paceWeight === 99 && p.spareSlack === POLICY_PARAMS.spareSlack && w.tilt === 1 && w.coffee === EVAL_WEIGHTS.coffee);
  const noCard = { ...g, scenario: { ...g.scenario, cardId: undefined } };
  check("profiles: a board without a cardId plays the defaults", policyFor(noCard) === POLICY_PARAMS);
  delete BOT_PROFILES["green-YUL"];

  const { evaluate, createInitialGameState, reduce } = await import("../packages/shared/src/index.ts");
  const at = (id, dp, dc, extra = {}) => ({ ...reduce(createInitialGameState(scenarioForSetup({ scenarioId: id, modules: [], abilities: [] }), P, C), { type: "roll", pilot: dp, copilot: dc, traffic: Array(flightPlan(SCENARIOS[id]).trafficDice[0]).fill(5) }, "").state, ...extra });
  // TGU round 3, both Engines down (moved): the plan wants space 2.
  const moved = { engines: { pilot: 3, copilot: 3 }, airplanes: Array(5).fill(0) };
  check("pace: ahead of the plan costs less than behind it", evaluate(at("yellow-TGU", [1, 1, 1, 1], [1, 1, 1, 1], { ...moved, round: 3, position: 3 }), "pilot") > evaluate(at("yellow-TGU", [1, 1, 1, 1], [1, 1, 1, 1], { ...moved, round: 3, position: 1 }), "pilot"));
  check("pace: waiting on Traffic dice past the plan costs extra", evaluate(at("yellow-TGU", [1, 1, 1, 1], [1, 1, 1, 1], { ...moved, round: 2, position: 0 }), "pilot") < evaluate(at("yellow-TGU", [1, 1, 1, 1], [1, 1, 1, 1], { ...moved, round: 2, position: 1 }), "pilot") - 60);
  // TGU space 1 allows tilts [2, 1]: a plane tilted 1 there isn't penalised like one tilted 1 on a plain space.
  const tilted = (pos) => at("yellow-TGU", [3, 4, 3, 4], [3, 4, 3, 4], { round: 2, position: pos, axis: { pilot: null, copilot: null, offset: 1 }, airplanes: Array(5).fill(0) });
  const level = (pos) => at("yellow-TGU", [3, 4, 3, 4], [3, 4, 3, 4], { round: 2, position: pos, axis: { pilot: null, copilot: null, offset: 0 }, airplanes: Array(5).fill(0) });
  check("turns: on a turn space, the tilt it needs beats level", evaluate(tilted(1), "pilot") > evaluate(level(1), "pilot"));
  check("turns: off a turn space, level still beats a tilt", evaluate(level(0), "pilot") > evaluate(tilted(0), "pilot"));
  check("turnTarget: none on the landing round", turnTarget({ ...tilted(1), round: 7 }, 1) === null);
  check("turnTarget: a 2-space advance over turns with no common tilt can't be flown", turnTarget({ ...tilted(0), scenario: { ...SCENARIOS.YUL, approachTrack: [{ traffic: 0, axisAllowed: [1] }, { traffic: 0, axisAllowed: [-1] }, { traffic: 0, airport: true }] } }, 2) === null);
  const { fastMove, rolloutGame } = await import("../packages/shared/src/index.ts");
  // Answer the partner's Axis die on a turn space: TGU space 1 needs a tilt it allows (2 or 1, not 0).
  const allowed1 = SCENARIOS["yellow-TGU"].approachTrack[1].axisAllowed;
  let ts = at("yellow-TGU", [1, 2, 3, 4], [3, 6, 6, 6], { round: 2, position: 1, airplanes: Array(5).fill(0), turn: "copilot" });
  ts = reduce(ts, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, C).state;
  const am = fastMove({ ...ts, coffee: 0 }, "pilot", mulberry32(4));
  const tiltAfter = am.target.kind === "axis" ? ts.axis.offset + (ts.dice.pilot[am.dieId].value - 3) : null;
  check(`rollout: on a turn space the Axis answer makes an allowed tilt (${allowed1})`, tiltAfter !== null && allowed1.includes(tiltAfter));
  // Whole rollouts on TGU with the default policy (TGU's own profile set aside): was 37 of 40 "Missed the turn".
  const tguProfile = BOT_PROFILES_ALL["yellow-TGU"];
  delete BOT_PROFILES_ALL["yellow-TGU"];
  const tguGames = Array.from({ length: 40 }, (_, i) => rolloutGame(newGame({ scenarioId: "yellow-TGU", modules: ["kerosene"], abilities: [] }, P, C, mulberry32(i), 0), mulberry32(100000 + i)));
  BOT_PROFILES_ALL["yellow-TGU"] = tguProfile;
  const missed = tguGames.filter((g) => /^Missed the turn/.test(g.outcome?.reason ?? "")).length;
  check(`rollout: TGU misses far fewer turns (${missed} of 40; was 37 before turn aiming)`, missed <= 16);
  // Two turns in a row with no tilt in common: a 2-space advance over both can't be flown.
  const twoTurns = { ...SCENARIOS.YUL, cardId: undefined, approachTrack: [{ traffic: 0, axisAllowed: [1] }, { traffic: 0, axisAllowed: [-1] }, { traffic: 0 }, { traffic: 0 }, { traffic: 0, airport: true }] };
  let tt = reduce(createInitialGameState(twoTurns, P, C), { type: "roll", pilot: [6, 6, 1, 1], copilot: [6, 6, 1, 1] }, "").state;
  // Round 5 at the start: behind, the pace wants 2 spaces — only the turns forbid it.
  tt = { ...tt, round: 5, axis: { pilot: 4, copilot: 3, offset: 1 }, turn: "copilot" };
  tt = reduce(tt, { type: "placeDie", dieId: 0, target: { kind: "engine" } }, C).state; // the Co-Pilot's 6 on the Engine
  const em = fastMove(tt, "pilot", mulberry32(5));
  const speed = em.target.kind === "engine" ? 6 + tt.dice.pilot[em.dieId].value : null;
  check("rollout: never plans a 2-space advance over turns with no common tilt", speed === null || speed <= tt.aeroOrange);
}

console.log("16) Experiment switches (off by default; measured, not adopted)");
{
  const { SEARCH_DEFAULTS, POLICY_PARAMS, searchCandidates, fastMove, redactGameStateFor, createInitialGameState, scenarioForSetup, reduce } = await import("../packages/shared/src/index.ts");
  const fresh = (dp, dc) => reduce(createInitialGameState(scenarioForSetup(DEFAULT_SETUP), P, C), { type: "roll", pilot: dp, copilot: dc }, "").state;
  const radio = (cands) => cands.some((m) => m.type === "placeDie" && m.target.kind === "radio");
  const v = redactGameStateFor(fresh([6, 6, 6, 6], [1, 1, 1, 1]), P);
  const off = radio(searchCandidates(v, "pilot", mulberry32(1), 2));
  SEARCH_DEFAULTS.radioCandidate = true;
  const on = radio(searchCandidates(v, "pilot", mulberry32(1), 2));
  SEARCH_DEFAULTS.radioCandidate = false;
  check("radioCandidate: the best Radio move joins the search's candidates", !off && on);
  // clearPlannedAny: an airplane two spaces ahead, the 3 to clear it kept for the Engine.
  // (Gear and Brakes already set, so no switch comes first.)
  const st = { ...fresh([3, 6, 6, 1], [1, 1, 1, 1]), round: 5, position: 0, airplanes: [0, 0, 1, 0, 0, 0, 0], gearGreen: [true, true, true], brakesDeployed: 3, brakeSlots: [true, true, true] };
  const kind = () => { const m = fastMove(st, "pilot", mulberry32(2)); return m.target.kind === "radio" && st.dice.pilot[m.dieId].value === 3; };
  const before = kind();
  POLICY_PARAMS.clearPlannedAny = true;
  const after = kind();
  POLICY_PARAMS.clearPlannedAny = false;
  check("clearPlannedAny: clears an airplane in the next moves' path with a kept die", !before && after);
}

console.log("17) Partial credit for switches in a failed landing (switchCredit, per-card)");
{
  const savedLHR = BOT_PROFILES_ALL["green-LHR"]; delete BOT_PROFILES_ALL["green-LHR"]; // tests below assume no profile
  const { rolloutValue, BOT_PROFILES, newGame: ng } = await import("../packages/shared/src/index.ts");
  const g = ng({ scenarioId: "green-LHR", modules: [], abilities: [] }, P, C, mulberry32(1), 0);
  const failed = (flaps) => ({ ...g, outcome: { result: "lost", reason: "Landing failed: flaps not fully deployed." }, flapsGreen: [0, 1, 2, 3].map((i) => i < flaps) });
  check("default: three Flaps of four score like none", rolloutValue(failed(3), "copilot") === rolloutValue(failed(0), "copilot"));
  BOT_PROFILES["green-LHR"] = { policy: { switchCredit: 100 } };
  check("switchCredit: each switch down counts in a failed landing", rolloutValue(failed(3), "copilot") - rolloutValue(failed(0), "copilot") === 300);
  delete BOT_PROFILES["green-LHR"];
  BOT_PROFILES_ALL["green-LHR"] = savedLHR;
}

console.log("18) Search settings per card (shortlist, radioCandidate)");
{
  const savedLHR = BOT_PROFILES_ALL["green-LHR"]; delete BOT_PROFILES_ALL["green-LHR"]; // tests below assume no profile
  const { BOT_PROFILES, searchStats, redactGameStateFor, newGame: ng } = await import("../packages/shared/src/index.ts");
  const v = redactGameStateFor(ng({ scenarioId: "green-LHR", modules: [], abilities: [] }, P, C, mulberry32(0), 0), P);
  const cands = () => searchStats(v, "pilot", mulberry32(3), { budgetMs: Infinity, maxSamples: 1 }).candidates;
  const radio = (c) => c.some((m) => m.type === "placeDie" && m.target.kind === "radio");
  const before = cands().length;
  BOT_PROFILES["green-LHR"] = { search: { shortlist: 2 } };
  const narrow = cands();
  BOT_PROFILES["green-LHR"] = { search: { shortlist: 2, radioCandidate: true } };
  const withRadio = cands();
  delete BOT_PROFILES["green-LHR"];
  check(`shortlist: a card's profile narrows the search (${before} -> ${narrow.length} candidates)`, narrow.length < before && narrow.length <= 3);
  check("radioCandidate: a card's profile adds the best Radio move", !radio(narrow) && radio(withRadio));
  BOT_PROFILES_ALL["green-LHR"] = savedLHR;
}

console.log("19) A card's scripted plan (planPolicy)");
{
  const savedLHR = BOT_PROFILES_ALL["green-LHR"]; delete BOT_PROFILES_ALL["green-LHR"]; // tests below assume no profile
  const { planMove, createInitialGameState, scenarioForSetup, reduce } = await import("../packages/shared/src/index.ts");
  const lhr = (dp, dc, extra = {}) => ({ ...reduce(createInitialGameState(scenarioForSetup({ scenarioId: "green-LHR", modules: [], abilities: [] }), P, C), { type: "roll", pilot: dp, copilot: dc, traffic: [5] }, "").state, ...extra });
  // The Pilot's single Radio: a 2 clears the next space (the plane flies off it next), not a 5 for a far one.
  const r = lhr([2, 5, 3, 3], [1, 1, 1, 1], { airplanes: [0, 1, 0, 0, 1, 0], coffee: 0 });
  const mr = planMove(r, "pilot");
  check("plan: the single Radio clears the space the plane flies next", mr?.target.kind === "radio" && r.dice.pilot[mr.dieId].value === 2);
  // Not before its own space is clear: with the Co-Pilot's Engine down, an airplane on the current space means no move.
  let e = lhr([3, 3, 1, 4], [4, 1, 1, 1], { airplanes: [1, 0, 0, 0, 0, 0], coffee: 0, turn: "copilot" });
  e = reduce(e, { type: "placeDie", dieId: 0, target: { kind: "engine" } }, C).state;
  const me = planMove(e, "pilot");
  const speed = me?.target.kind === "engine" ? 4 + e.dice.pilot[me.dieId].value : null;
  check("plan: never completes the Engines into an airplane on its own space", me?.target.kind === "radio" ? e.dice.pilot[me.dieId].value === 1 : speed === null || speed <= e.aeroBlue);
  // Modules it doesn't plan for: hands back to the general policy.
  // Landing round: the Coffee is kept for a level Axis.
  let l = lhr([5, 2, 2, 2], [3, 5, 6, 6], { round: 7, position: 5, airplanes: Array(6).fill(0), coffee: 1, axis: { pilot: null, copilot: null, offset: 0 }, flapsGreen: [true, true, true, false], turn: "copilot" });
  l = reduce(l, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, C).state; // Co-Pilot's 3
  const ml = planMove(l, "pilot");
  const tilt = ml?.target.kind === "axis" ? l.axis.offset + (l.dice.pilot[ml.dieId].value + (ml.coffeeDelta ?? 0)) - 3 : "not axis";
  check(`plan: on the landing round the Axis ends level (tilt ${tilt})`, ml?.target.kind !== "axis" || tilt === 0);
  // A card with a plan: the search always weighs the plan's move; the rollouts stay fast (unless rollouts: true).
  const { BOT_PROFILES, searchCandidates, redactGameStateFor, fastMove } = await import("../packages/shared/src/index.ts");
  const key = (m) => JSON.stringify(m);
  // (seed 0's opening: the plan and the general policy pick different dice for the Gear.)
  const g0 = newGame({ scenarioId: "green-LHR", modules: [], abilities: [] }, P, C, mulberry32(0), 0);
  const general = key(fastMove(g0, "pilot", mulberry32(2)));
  BOT_PROFILES["green-LHR"] = { plan: true };
  const v = redactGameStateFor(g0, P);
  const planned = planMove(v, "pilot");
  const inCands = key(planned) !== general && searchCandidates(v, "pilot", mulberry32(1), 1).some((m) => key(m) === key(planned));
  const policyUnchanged = key(fastMove(g0, "pilot", mulberry32(2))) === general;
  check("plan: its move is always one of the search's candidates", inCands);
  check("plan: the rollouts keep the fast policy unless asked", policyUnchanged);
  // …a Radio move too (per-crew spaces are spelled with a side in the legal-move list).
  // (seed 50's opening: the plan's Radio die is one the general policy wouldn't pick.)
  const vr = redactGameStateFor(newGame({ scenarioId: "green-LHR", modules: [], abilities: [] }, P, C, mulberry32(50), 0), P);
  const pr = planMove(vr, "pilot");
  BOT_PROFILES["green-LHR"] = { plan: true };
  check("plan: a planned Radio move is a candidate too", pr?.target.kind === "radio" && searchCandidates(vr, "pilot", mulberry32(1), 1).some((m) => key(m) === key(pr)));
  delete BOT_PROFILES["green-LHR"];
  BOT_PROFILES_ALL["green-LHR"] = savedLHR;
}

console.log("20) The plan's move breaks near-ties in the search (searchBias)");
{
  const { pickBest } = await import("../packages/shared/src/index.ts");
  const a = { type: "placeDie", dieId: 0, target: { kind: "axis" } }, b = { type: "placeDie", dieId: 1, target: { kind: "axis" } };
  const stats = { candidates: [a, b], totals: [1000, 900], counts: [10, 10] };
  check("no bias: the better average wins", pickBest([stats]) === a);
  check("a bias on the plan's move wins a near-tie", pickBest([{ ...stats, bias: [0, 20] }]) === b);
  check("…but not a clear gap", pickBest([{ ...stats, bias: [0, 5] }]) === a);
}

console.log("21) The plan feeds Kerosene");
{
  const { planMove, createInitialGameState, scenarioForSetup, reduce } = await import("../packages/shared/src/index.ts");
  const osl = (dp, dc, extra = {}) => ({ ...reduce(createInitialGameState(scenarioForSetup({ scenarioId: "green-OSL", modules: ["kerosene"], abilities: [] }), P, C), { type: "roll", pilot: dp, copilot: dc, traffic: [5, 5] }, "").state, ...extra });
  // A spare 1 burns 1 instead of the idle 6.
  const k = osl([1, 3, 4, 4], [3, 3, 4, 4], { airplanes: Array(8).fill(0), coffee: 0 });
  const mk = planMove(k, "pilot");
  check("plan: a low spare die feeds the Kerosene", mk?.target.kind === "kerosene" && k.dice.pilot[mk.dieId].value === 1);
  // Never the die that would empty the tank.
  const low = osl([4, 3, 3, 3], [3, 3, 3, 3], { airplanes: Array(8).fill(0), coffee: 0, kerosene: 4 });
  const ml = planMove(low, "pilot");
  check("plan: never burns the tank dry", !(ml?.target.kind === "kerosene" && low.dice.pilot[ml.dieId].value >= 4));
}

console.log("22) The plan counts its own Gear / Flaps this round in the Engine's speed");
{
  const { planMove, createInitialGameState, scenarioForSetup, reduce } = await import("../packages/shared/src/index.ts");
  // HND round 1: the Co-Pilot's 1 is on the Engines; the Pilot holds 4, 4, 2 and 1 (the 1/2 fit the first Gear).
  let h = reduce(createInitialGameState(scenarioForSetup({ scenarioId: "green-HND", modules: [], abilities: [] }), P, C), { type: "roll", pilot: [4, 4, 2, 1], copilot: [1, 3, 3, 3], traffic: [5, 5] }, "").state;
  h = { ...h, airplanes: Array(8).fill(0), coffee: 0, turn: "copilot" };
  h = reduce(h, { type: "placeDie", dieId: 0, target: { kind: "engine" } }, C).state;
  h = reduce(h, { type: "placeDie", dieId: 1, target: { kind: "axis" } }, P).state; // the Pilot's first 4 (keeps the order simple)
  // Now: a 4 on the Engine makes 5 > blue 4 and moves — unless a Gear goes down first (blue 5).
  const m = planMove(h, "pilot");
  check("plan: doesn't lower a Gear that stops this round's move", !(m?.target.kind === "landingGear"));
}

console.log("23) The plan prepares the tilt for the turn it's flying into");
{
  const { planMove, createInitialGameState, scenarioForSetup, reduce } = await import("../packages/shared/src/index.ts");
  // HND: space 4 lets the plane leave only tilted 2 or 1 toward the Pilot. Round 4 on space 3
  // (no turn), level; the Co-Pilot's 3 is on the Axis. Pilot 4 makes +1 (ready for space 4), 3 stays level.
  let h = reduce(createInitialGameState(scenarioForSetup({ scenarioId: "green-HND", modules: [], abilities: [] }), P, C), { type: "roll", pilot: [4, 3, 6, 6], copilot: [3, 3, 3, 3], traffic: [5, 5] }, "").state;
  h = { ...h, round: 4, position: 3, airplanes: Array(8).fill(0), coffee: 0, axis: { pilot: null, copilot: null, offset: 0 }, turn: "copilot" };
  h = reduce(h, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, C).state;
  const m = planMove(h, "pilot");
  const tilt = m?.target.kind === "axis" ? h.axis.offset + h.dice.pilot[m.dieId].value - 3 : null;
  check(`plan: tilts toward the coming turn's tilt (tilt ${tilt})`, tilt === 1);
}

console.log("24) The plan trains the Intern");
{
  const { planMove, createInitialGameState, scenarioForSetup, reduce, nextInternToken } = await import("../packages/shared/src/index.ts");
  const atl = (dp, dc, extra = {}) => ({ ...reduce(createInitialGameState(scenarioForSetup({ scenarioId: "green-ATL", modules: ["intern"], abilities: [] }), P, C), { type: "roll", pilot: dp, copilot: dc, traffic: [5, 5, 5, 5] }, "").state, ...extra });
  // Late (round 5), all six tokens untrained: training is urgent — a spare die goes to the Intern.
  const a = atl([3, 3, 4, 4], [3, 3, 4, 4], { round: 5, airplanes: Array(8).fill(0), coffee: 0 });
  const token = a.internTokens[nextInternToken(a, "pilot")];
  const m = planMove(a, "pilot");
  check(`plan: trains the Intern when it's behind (next token ${token})`, m?.target.kind === "intern" && a.dice.pilot[m.dieId].value !== token);
}

console.log("26) The plan plans the Special Abilities");
{
  const { planMove, createInitialGameState, scenarioForSetup, reduce } = await import("../packages/shared/src/index.ts");
  const prg = (abilities, dp, dc, extra = {}) => ({ ...reduce(createInitialGameState(scenarioForSetup({ scenarioId: "green-PRG", modules: [], abilities }), P, C), { type: "roll", pilot: dp, copilot: dc, traffic: [5] }, "").state, airplanes: Array(8).fill(0), coffee: 0, ...extra });
  // Adaptation: the Pilot's 6 turned to a 1 fits the first Gear and an open Radio... a hand of all 6s is poor: flip one.
  const ad = prg(["adaptation"], [6, 6, 6, 6], [3, 3, 4, 4], { round: 3 });
  const ma = planMove(ad, "pilot");
  check("Adaptation: a hand of 6s gets a die turned over", ma?.type === "adapt");
  // …but not a hand that already fits.
  const ok = prg(["adaptation"], [1, 2, 3, 4], [3, 3, 4, 4], { round: 3 });
  check("Adaptation: kept for later when the hand fits", planMove(ok, "pilot")?.type !== "adapt");
  // Anticipation: the First Player (Pilot, round 1) rerolls a die before the first one is placed when the hand is poor.
  const an = prg(["anticipation"], [6, 6, 6, 6], [3, 3, 4, 4]);
  check("Anticipation: a poor opening hand rerolls a die", planMove(an, "pilot")?.type === "anticipate");
  // Control: with the Co-Pilot's 4 on the Axis, a matching 4 (Coffee) beats an equally level 4… and the 4 levels: choose it.
  let co = prg(["control"], [4, 2, 6, 6], [4, 1, 1, 1], { turn: "copilot", round: 2 });
  co = reduce(co, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, C).state;
  const mc = planMove(co, "pilot");
  check("Control: answers the partner's Axis die with a match", mc?.target?.kind === "axis" && co.dice.pilot[mc.dieId].value === 4);
  // Synchronisation: the Co-Pilot places a held Traffic die of 2 where it does something (the first Flaps).
  const sy = prg(["synchronisation"], [3, 3, 4, 4], [3, 3, 4, 4], { round: 2, trafficHeld: { value: 2 }, turn: "copilot" });
  const ms = planMove(sy, "copilot");
  check("Synchronisation: places the Traffic die where it counts", ms?.type === "placeTraffic" && ["flaps", "radio", "landingGear", "brakes"].includes(ms.target.kind));
}

console.log("27) The plan reads the Wind after the Axis turns it");
{
  const { planMove, createInitialGameState, scenarioForSetup, reduce, WIND_RING } = await import("../packages/shared/src/index.ts");
  // GIG with Wind, ring on +3 (start). The Co-Pilot's 1 is on the Axis; the Pilot's Axis die will
  // tilt the plane and turn the ring. Whatever the plan answers, its Engine die must be judged by the
  // Wind after the turn: with the Axis die down, the Wind it scored is the reducer's.
  let g = reduce(createInitialGameState(scenarioForSetup({ scenarioId: "yellow-GIG", modules: ["wind"], abilities: [] }), P, C), { type: "roll", pilot: [3, 1, 1, 1], copilot: [1, 1, 1, 1], traffic: [5, 5] }, "").state;
  g = { ...g, airplanes: Array(7).fill(0), coffee: 0, turn: "copilot" };
  g = reduce(g, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, C).state;
  // Pilot's 3 vs Co-Pilot's 1: tilt +2, the ring turns 2 left: wind WIND_RING[(0-2+20)%20].
  const after = WIND_RING[(g.windPosition - 2 + 20) % 20];
  const { engineWindFor } = await import("../packages/shared/src/index.ts");
  check(`plan: predicts the Wind after this round's Axis (${after})`, engineWindFor(g, "pilot", 3) === after);
}

console.log("28) A card can hold one tilt through its turns (tiltHold)");
{
  const { fastMove, planMove, createInitialGameState, scenarioForSetup, reduce } = await import("../packages/shared/src/index.ts");
  // TGU round 1 on the start space (no turn there): level, the Co-Pilot's 3 on the Axis. Pilot 4 → +1, 3 → 0.
  let t = reduce(createInitialGameState(scenarioForSetup({ scenarioId: "yellow-TGU", modules: [], abilities: [] }), P, C), { type: "roll", pilot: [3, 4, 6, 6], copilot: [3, 1, 1, 1], traffic: [5, 5, 5] }, "").state;
  t = { ...t, airplanes: Array(5).fill(0), coffee: 0, turn: "copilot" };
  t = reduce(t, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, C).state;
  const saved = BOT_PROFILES_ALL["yellow-TGU"];
  BOT_PROFILES_ALL["yellow-TGU"] = { policy: { tiltHold: 1 }, plan: { tiltHold: 1 } };
  const f = fastMove(t, "pilot", mulberry32(1));
  const { planFor } = await import("../packages/shared/src/index.ts");
  const p = planMove(t, "pilot", planFor(t)); // as the search calls it: with the card's weights
  BOT_PROFILES_ALL["yellow-TGU"] = saved;
  const tilt = (m) => (m?.target?.kind === "axis" ? t.dice.pilot[m.dieId].value - 3 : null);
  check(`tiltHold: the rollouts hold +1 from the start (${tilt(f)})`, tilt(f) === 1);
  check(`tiltHold: the plan holds +1 from the start (${tilt(p)})`, tilt(p) === 1);
}

console.log("29) The plan handles the Kerosene Leak and the Ice Brakes");
{
  const { planMove, createInitialGameState, scenarioForSetup, reduce, ICE_BRAKE_VALUES } = await import("../packages/shared/src/index.ts");
  // Kerosene Leak (yellow ATL board): the Co-Pilot's 3 is on the Engines; Pilot 3 (speed 6) and 4 (speed 7) both move
  // one space — the 3 leaks 1, the 4 leaks 2: answer with the 3.
  let lk = reduce(createInitialGameState(scenarioForSetup({ scenarioId: "yellow-ATL", modules: ["keroseneLeak"], abilities: [] }), P, C), { type: "roll", pilot: [4, 3, 3, 6], copilot: [3, 3, 1, 1], traffic: [5] }, "").state;
  lk = { ...lk, airplanes: Array(8).fill(0), coffee: 0, turn: "copilot" };
  lk = reduce(lk, { type: "placeDie", dieId: 0, target: { kind: "engine" } }, C).state; // Co-Pilot's 3 on the Engines
  lk = reduce(lk, { type: "placeDie", dieId: 2, target: { kind: "axis" } }, P).state; // level Axis: 3 vs 3
  lk = reduce(lk, { type: "placeDie", dieId: 1, target: { kind: "axis" } }, C).state;
  const ml = planMove(lk, "pilot");
  check("Kerosene Leak: the Engine die that leaks less", ml?.target?.kind === "engine" && lk.dice.pilot[ml.dieId].value === 3);
  // Ice Brakes (KEF board): the Pilot holds the next step's value: it goes on the top space.
  const ib = { ...reduce(createInitialGameState(scenarioForSetup({ scenarioId: "yellow-KEF", modules: ["iceBrakes"], abilities: [] }), P, C), { type: "roll", pilot: [ICE_BRAKE_VALUES[0], 3, 4, 4], copilot: [ICE_BRAKE_VALUES[0], 3, 4, 4], traffic: [5, 5] }, "").state, airplanes: Array(6).fill(0), coffee: 0, round: 3, gearGreen: [true, true, true] }; // (all Gear down: the switch left is the Ice Brakes)
  const mi = planMove(ib, "pilot");
  check("Ice Brakes: the next step's die goes on the Ice Brakes", mi?.target?.kind === "iceBrakes");
}

console.log(failures === 0 ? "\nALL BOT TESTS PASSED ✅" : `\n${failures} BOT TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
