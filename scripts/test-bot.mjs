// Bot and game-driving tests (pure, no server). Run via `npm test`.
import { newGame, applyIntent, randDice, shuffledInternTokens, settle, mulberry32, DEFAULT_SETUP } from "../packages/shared/src/index.ts";

let failures = 0;
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
  check("search returns a legal move", moves.some((x) => JSON.stringify(x) === JSON.stringify(m)));
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
  for (let seed = 21; seed < 60 && !view; seed++) {
    const v = redactGameStateFor(newGame({ ...DEFAULT_SETUP, modules: ["kerosene"] }, P, C, mulberry32(seed), 0), P);
    if (picks(v, "navigator").size === 1) view = v;
  }
  check("(setup: a position with a unique best move)", !!view);
  const ranked = rankMoves(view, "pilot", legalMoves(view, "pilot"), mulberry32(0)).map((m) => JSON.stringify(m));
  const cadet = picks(view, "cadet", 60);
  check("Cadet sometimes plays other than the unique best move", cadet.size > 1);
  check("…but only among the top few (no wild blunders)", [...cadet].every((m) => ranked.slice(0, 6).includes(m)));
  const t0 = Date.now();
  const a = chooseMove(view, "pilot", "aviator", mulberry32(1), { budgetMs: 150 });
  const spent = Date.now() - t0;
  check("Aviator searches (uses its budget) and returns a legal move", spent >= 100 && legalMoves(view, "pilot").some((m) => JSON.stringify(m) === JSON.stringify(a)));
}

console.log(failures === 0 ? "\nALL BOT TESTS PASSED ✅" : `\n${failures} BOT TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
