// Bot and game-driving tests (pure, no server). Run via `npm test`.
import { newGame, applyIntent, randDice, shuffledInternTokens, settle, mulberry32, DEFAULT_SETUP } from "../packages/shared/src/index.ts";

let failures = 0;
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

console.log("3) actorFor, evaluate, chooseMove (Navigator)");
{
  const { actorFor, chooseMove, evaluate, redactGameStateFor, createInitialGameState, reduce, scenarioForSetup } = await import("../packages/shared/src/index.ts");
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
  const m = chooseMove(redactGameStateFor(s, P), "pilot", "navigator", mulberry32(1));
  check("doesn't spin the plane", !(m.type === "placeDie" && m.target.kind === "axis" && s.dice.pilot[m.dieId].value === 1));

  // Keep the die that saves the Axis: the Co-Pilot's 6 is down, so only the
  // Pilot's 5 avoids a spin — it must not be spent on the Radio or Gear first.
  let k = fresh([5, 1, 1, 2], [6, 1, 1, 1]);
  k.turn = "copilot";
  k = reduce(k, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, C).state;
  const keep = chooseMove(redactGameStateFor(k, P), "pilot", "navigator", mulberry32(4));
  check("keeps the only die that avoids a spin for the Axis", !(keep.type === "placeDie" && k.dice.pilot[keep.dieId].value === 5 && keep.target.kind !== "axis"));

  // First Axis die, partner's unknown: a 1 spins on any partner 4–6, a 3 only on a 6.
  const half = (v) => redactGameStateFor(reduce(fresh([v, 2, 2, 2], [1, 1, 1, 1]), { type: "placeDie", dieId: 0, target: { kind: "axis" } }, P).state, P);
  check("a first Axis die near the middle beats an extreme one (spin risk)", evaluate(half(3), "pilot") > evaluate(half(1), "pilot"));

  // Partner's Axis die unknown: the Pilot's 3 is its safest Axis die (1s and 6s
  // spin on half the partner's faces), so it isn't spent elsewhere first.
  const r = fresh([3, 1, 6, 6], [1, 1, 1, 1]);
  const first = chooseMove(redactGameStateFor(r, P), "pilot", "navigator", mulberry32(5));
  check("keeps its safest Axis die rather than spending it elsewhere", !(first.type === "placeDie" && r.dice.pilot[first.dieId].value === 3 && first.target.kind !== "axis"));

  // Pace: after round 1's move, 5 moving rounds remain (2–6), not 6.
  const paced = (position) => ({ ...fresh([1, 1, 1, 1], [1, 1, 1, 1]), engines: { pilot: 3, copilot: 3 }, position, airplanes: Array(8).fill(0) });
  check("pace counts the rounds left after this round's move", evaluate(paced(2), "pilot") > evaluate(paced(1), "pilot"));
  // Behind schedule (round 5, 3 spaces left, 1 moving round after this one): a
  // hand that can reach speed 9+ for a double move beats one that can't.
  const behind = (hand) => ({ ...fresh(hand, [1, 1, 1, 1]), round: 5, position: 4, airplanes: Array(8).fill(0) });
  check("pace: keeps the fast Engine dice it needs to catch up", evaluate(behind([6, 6, 6, 6]), "pilot") - evaluate(behind([1, 1, 1, 1]), "pilot") > 500);
  check("pace: leaving a space with an airplane on it is fatal", evaluate({ ...behind([6, 6, 6, 6]), airplanes: [0, 0, 0, 0, 1, 0, 0, 0] }, "pilot") < evaluate(behind([6, 6, 6, 6]), "pilot") - 2000);

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
  check("no Turn penalty before this round's Axis dice are down (the tilt isn't final)", evaluate(turnAt(0, [0])(before), "pilot") === evaluate(before, "pilot"));
  const double = { ...fresh([6, 6, 6, 6], [1, 1, 1, 1]), round: 3, position: 2, airplanes: Array(8).fill(0), axis: { pilot: 3, copilot: 3, offset: 0 }, engines: { pilot: null, copilot: 6 } };
  check("pace: a double move through a space whose Turn forbids the tilt is fatal", evaluate(turnAt(3, [1])(double), "pilot") < evaluate(double, "pilot") - 2000);

  // Real-Time: the round can end any second, and an open Axis or Engine then
  // loses — so the bot fills its own first.
  const rtFirst = [0, 1, 2, 3, 4, 5].map((seed) => {
    const g = newGame({ ...DEFAULT_SETUP, modules: ["realTime"] }, P, C, mulberry32(seed), Date.now());
    const m = chooseMove(redactGameStateFor(g, P), "pilot", "navigator", mulberry32(seed));
    return m.type === "placeDie" && (m.target.kind === "axis" || m.target.kind === "engine");
  });
  check("Real-Time: the bot fills its Axis and Engine before anything else", rtFirst.every(Boolean));

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
  check("evaluate prefers fewer airplanes", evaluate({ ...t, airplanes: t.airplanes.map((a, i) => (i === 1 ? 0 : a)) }, "pilot") > evaluate(t, "pilot"));

  // Turns: on a space whose Turn forbids the current tilt the plane can't fly on.
  const turn = { ...t, scenario: { ...t.scenario, approachTrack: t.scenario.approachTrack.map((sp, i) => (i === 0 ? { ...sp, axisAllowed: [1, 0] } : sp)) } };
  check("evaluate penalises a tilt the Turn forbids", evaluate({ ...turn, axis: { ...turn.axis, offset: -1 } }, "pilot") < evaluate({ ...turn, axis: { ...turn.axis, offset: 1 } }, "pilot"));

  const n = reduce(fresh([2, 1, 1, 1], [1, 1, 1, 1], setup(["intern"])), { type: "placeDie", dieId: 0, target: { kind: "intern" } }, P).state;
  check("places a held Intern token", chooseMove(redactGameStateFor(n, P), "pilot", "navigator", mulberry32(2))?.type === "placeIntern");

  const over = { ...fresh([1, 1, 1, 1], [1, 1, 1, 1]), phase: "lost" };
  check("no legal move → null", chooseMove(over, "pilot", "navigator", mulberry32(3)) === null);
}

console.log("4) Self-play: every card, every module combination, every ability");
{
  const { selfPlay, representativeSetups, cardSetups, ABILITY_IDS } = await import("../packages/shared/src/index.ts");
  check("all 21 cards are covered", cardSetups().length === 21);
  const setups = representativeSetups();
  check("every ability is played", ABILITY_IDS.every((a) => setups.some((s) => s.abilities.includes(a))));
  const label = (s) => `${s.scenarioId}: ${[...s.modules, ...s.abilities].join("+") || "base"}`;
  const results = setups.map((s, i) => ({ s, r: selfPlay(s, { pilot: "navigator", copilot: "navigator" }, 1000 + i) }));
  const stuck = results.filter(({ r }) => r.outcome === "stuck");
  check(`${setups.length} setups each play to a finished game`, stuck.length === 0);
  stuck.slice(0, 5).forEach(({ s, r }) => console.log(`     ↳ stuck: ${label(s)} — ${r.reason}`));
  const a = selfPlay(setups[0], { pilot: "navigator", copilot: "navigator" }, 42);
  const b = selfPlay(setups[0], { pilot: "navigator", copilot: "navigator" }, 42);
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

console.log("6) Difficulty levels behave differently");
{
  const { chooseMove, redactGameStateFor, rankMoves, legalMoves } = await import("../packages/shared/src/index.ts");
  const picks = (view, level, n = 30) => new Set(Array.from({ length: n }, (_, i) => JSON.stringify(chooseMove(view, "pilot", level, mulberry32(i)))));
  // A position where the Navigator's best move is unique (the same across seeds).
  let view = null;
  let full = null;
  for (let seed = 21; seed < 60 && !view; seed++) {
    const gs = newGame({ ...DEFAULT_SETUP, modules: ["kerosene"] }, P, C, mulberry32(seed), 0);
    const v = redactGameStateFor(gs, P);
    if (picks(v, "navigator").size === 1) [view, full] = [v, gs];
  }
  check("(setup: a position with a unique best move)", !!view);
  const ranked = rankMoves(view, "pilot", legalMoves(view, "pilot"), mulberry32(0)).map((m) => JSON.stringify(m));
  const cadet = picks(view, "cadet", 60);
  check("Cadet sometimes plays other than the unique best move", cadet.size > 1);
  check("…but only among the top few (no wild blunders)", [...cadet].every((m) => ranked.slice(0, 6).includes(m)));
  const t0 = Date.now();
  const a = chooseMove(view, "pilot", "aviator", mulberry32(1), { budgetMs: 150 });
  const spent = Date.now() - t0;
  check("Aviator searches (uses its budget) and returns a legal move", spent >= 100 && accepts(full, P, a));
}

console.log("7) Measurement: landing checklist; dice independent of the bots");
{
  const { landingChecks, selfPlay } = await import("../packages/shared/src/index.ts");
  const g = newGame(DEFAULT_SETUP, P, C, mulberry32(3), 0);
  const ready = { ...g, round: 7, position: 7, airplanes: Array(8).fill(0), gearGreen: [true, true, true], flapsGreen: [true, true, true, true], brakesDeployed: 3, axis: { pilot: 3, copilot: 3, offset: 0 }, lastSpeed: 6 };
  check("landingChecks: a ready plane passes every condition", Object.values(landingChecks(ready)).every(Boolean));
  const late = landingChecks({ ...ready, position: 6, flapsGreen: [true, true, true, false], lastSpeed: 9 });
  check("…and names each one that fails", !late.airport && !late.flaps && !late.brakes && late.gear && late.level && late.clear);
  const setup = { scenarioId: "YUL", modules: [], abilities: [] };
  const a = selfPlay(setup, { pilot: "navigator", copilot: "navigator" }, 77);
  const b = selfPlay(setup, { pilot: "cadet", copilot: "cadet" }, 77);
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
  // Clear the airplane right ahead (YUL space 1 holds one): a 2 on the Radio.
  const r = fresh([2, 3, 3, 5], [1, 1, 1, 1]);
  const mr = fastMove(r, "pilot", mulberry32(2));
  check("fast policy: clears the airplane in the way", mr.target.kind === "radio" && die(r, "pilot", mr) === 2);
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
    if (searchCandidates(v, "pilot", mulberry32(seed), 6).some((m) => JSON.stringify(m) === own)) included++;
  }
  check("the policy's move is always among the candidates", included === 10);
  // Step 5: no two candidates lead to the same game (same value on the same space).
  const key = (v, m) => m.type === "placeDie" ? `${JSON.stringify(m.target)}=${v.dice.pilot.find((d) => d.id === m.dieId).value + (m.coffeeDelta ?? 0)}` : JSON.stringify(m);
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
  const v = redactGameStateFor(newGame(DEFAULT_SETUP, P, C, mulberry32(5), 0), P);
  const world = determinize(v, mulberry32(6));
  check("a sampled world carries no log (nothing to copy or write)", world.log.length === 0 && (world.log.push("x"), world.log.length === 0));
  check("rollouts on sampled worlds still end in an outcome", !!rolloutGame(world, mulberry32(7)).outcome);
  // No Navigator fallback for an ordinary placement: a die that fits only an
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
  check("an odd last die (a 2 that fits only set switches) is placed without the Navigator fallback", ["brakes", "landingGear"].includes(mStuck?.target?.kind) && accepts(st, P, mStuck) && spentFast < 5);
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

console.log(failures === 0 ? "\nALL BOT TESTS PASSED ✅" : `\n${failures} BOT TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
