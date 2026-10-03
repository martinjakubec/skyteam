// Unit tests for the non-reducer pieces: hidden-dice redaction, per-viewer
// snapshots, game-setup validation, the CORS origin check, and the client's
// uuid() fallback.
// Run via `npm test` (builds shared first; the server imports its dist).
import {
  ABILITY_IDS,
  APPROACH_TRACKS,
  DEFAULT_SETUP,
  DIFFICULTIES,
  EXCLUSIVE_MODULE_GROUPS,
  MODULE_IDS,
  SCENARIOS,
  SCENARIO_TEMPLATES,
  YUL_MONTREAL,
  SetSetupPayload,
  conflictingModules,
  createInitialGameState,
  hasAbility,
  normalizeGameState,
  reduce,
  redactGameStateFor,
  roundRoll,
  scenarioForSetup,
  settle,
  withEntropy,
} from "../packages/shared/src/index.ts";
import { toSnapshot } from "../packages/server/src/snapshot.ts";
import * as tut from "../packages/client/src/tutorials/engine.ts";
import { BASICS, TUTORIALS } from "../packages/client/src/tutorials/index.ts";
import * as ses from "../packages/client/src/tutorials/session.ts";
import { originChecker } from "../packages/server/src/cors.ts";
import * as seating from "../packages/server/src/seating.ts";
import { uuid } from "../packages/client/src/uuid.ts";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "  ✅" : "  ❌"} ${label}`);
  if (!cond) failures++;
}

const P = "P";
const C = "C";

// A round in progress: each crew has placed its Axis die (public), the rest hidden.
function midRound() {
  let s = createInitialGameState(
    {
      name: "TEST",
      approachTrack: [{ traffic: 0 }, { traffic: 0, airport: true }],
      rounds: 3,
      startAltitudeFeet: 8000,
      feetPerRound: 1000,
      rerollRounds: [],
      axisSpinAt: 5,
      aeroBlueStart: 4,
      aeroOrangeStart: 8,
    },
    P,
    C,
  );
  s = reduce(s, { type: "roll", pilot: [1, 2, 3, 4], copilot: [5, 6, 5, 6] }, "").state;
  s = reduce(s, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, P).state;
  s = reduce(s, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, C).state;
  return s;
}
const isHidden = (d) => d.hidden === true && d.value === undefined && !d.placed;

// 1) Redaction ---------------------------------------------------------------
console.log("1) redactGameStateFor hides only the other crew's unplaced dice");
{
  const s = midRound();
  const forPilot = redactGameStateFor(s, P);
  check("pilot sees all own values", forPilot.dice.pilot.every((d, i) => d.value === s.dice.pilot[i].value && !d.hidden));
  check("pilot sees copilot's placed die", forPilot.dice.copilot[0].value === 5 && forPilot.dice.copilot[0].placed);
  check("copilot's unplaced dice hidden from pilot", forPilot.dice.copilot.slice(1).every(isHidden));
  check("hidden dice keep their ids", forPilot.dice.copilot.map((d) => d.id).join() === "0,1,2,3");

  const forCopilot = redactGameStateFor(s, C);
  check("copilot sees own values", forCopilot.dice.copilot.every((d) => d.value !== undefined));
  check("pilot's unplaced dice hidden from copilot", forCopilot.dice.pilot.slice(1).every(isHidden));

  const forObserver = redactGameStateFor(s, "observer");
  check(
    "observer sees no unplaced dice from either crew",
    [...forObserver.dice.pilot.slice(1), ...forObserver.dice.copilot.slice(1)].every(isHidden),
  );
  check("observer still sees placed dice", forObserver.dice.pilot[0].value === 1);

  check("source state not mutated", s.dice.copilot.every((d) => d.value !== undefined && !d.hidden));
  check("no hidden value leaks through JSON", !JSON.stringify(forPilot.dice.copilot.slice(1)).includes('"value"'));

  // Working Together: the offered die lies face-up on the card.
  const offer = structuredClone(s);
  offer.pendingSwap = { from: "pilot", dieId: 1 };
  const forResponder = redactGameStateFor(offer, C);
  check("an offered Working Together die is visible to the other player", forResponder.dice.pilot[1].value === 2 && !forResponder.dice.pilot[1].hidden);
  check("…but only that one", forResponder.dice.pilot.slice(2).every(isHidden));
  check("…and spectators see it too", redactGameStateFor(offer, "observer").dice.pilot[1].value === 2);
}

// 2) Per-viewer snapshots ----------------------------------------------------
console.log("2) toSnapshot tailors the game and 'you' to the recipient");
{
  const room = {
    id: "r1",
    inviteCode: "inv",
    hostPlayerId: P,
    status: "playing",
    seats: [
      { playerId: P, role: "pilot", ready: true, connected: true },
      { playerId: C, role: "copilot", ready: true, connected: false },
    ],
    observers: ["O"],
    setup: DEFAULT_SETUP,
    version: 7,
    game: midRound(),
    updatedAt: 0,
  };
  const forC = toSnapshot(room, C);
  check("player sees their seat role", forC.you.kind === "player" && forC.you.role === "copilot");
  check("game redacted for the copilot", forC.game.dice.pilot.slice(1).every(isHidden));
  check("connection state mapped", forC.seats[1].connection === "disconnected");
  const forO = toSnapshot(room, "O");
  check("observer marked as observer", forO.you.kind === "observer" && forO.you.role === undefined);
  check("game redacted for the observer", forO.game.dice.copilot.slice(1).every(isHidden));
  check("lobby snapshot has no game", toSnapshot({ ...room, game: null }, P).game === null);
  check("snapshot carries the room setup", forO.setup.scenarioId === "YUL");
}

// 2b) Game setup ---------------------------------------------------------------
console.log("2b) SetSetupPayload validation and scenarioForSetup");
{
  const ok = (v) => SetSetupPayload.safeParse(v).success;
  check("default setup is valid", ok(DEFAULT_SETUP));
  check("unknown airport rejected", !ok({ scenarioId: "XXX", modules: [] }));
  check("unknown module rejected", !ok({ scenarioId: "YUL", modules: ["jetpack"] }));
  check("implemented module accepted", ok({ scenarioId: "YUL", modules: ["kerosene"] }));
  check("Traffic dice are board data, not a lobby module", !ok({ scenarioId: "YUL", modules: ["trafficDie"] }));
  check("Kerosene Leak accepted", ok({ scenarioId: "YUL", modules: ["keroseneLeak"] }));
  check("Ice Brakes combine with Kerosene", ok({ scenarioId: "YUL", modules: ["kerosene", "iceBrakes"] }));
  check("Kerosene + Kerosene Leak together rejected", !ok({ scenarioId: "YUL", modules: ["kerosene", "keroseneLeak"] }));
  check("duplicate module rejected", !ok({ scenarioId: "YUL", modules: ["kerosene", "kerosene"] }));
  check("missing modules rejected", !ok({ scenarioId: "YUL" }));

  const scenario = scenarioForSetup({ scenarioId: "YUL", modules: [] });
  check("setup resolves to the airport's board", scenario.name === SCENARIOS.YUL.name && scenario.rounds === 7);
  check("modules are copied onto the scenario", Array.isArray(scenario.modules) && scenario.modules.length === 0);
  scenario.modules.push("intern");
  check("resolving never mutates the registry", SCENARIOS.YUL.modules === undefined);
  check("Kerosene and Kerosene Leak exclude each other",
    conflictingModules("kerosene").join() === "keroseneLeak" && conflictingModules("keroseneLeak").join() === "kerosene");
  check("unrelated modules conflict with nothing", conflictingModules("intern").length === 0);

  // Special Abilities (lobby selection).
  check("YUL allows no abilities", !ok({ scenarioId: "YUL", modules: [], abilities: ["control"] }));
  // YUL refuses every ability, so these assert the specific error, not just a refusal.
  const issues = (body) => (SetSetupPayload.safeParse(body).error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ");
  check("unknown ability rejected", /^abilities\.0: Invalid enum value/.test(issues({ scenarioId: "YUL", modules: [], abilities: ["teleport"] })));
  check("duplicate ability rejected", issues({ scenarioId: "YUL", modules: [], abilities: ["control", "control"] }).includes("Duplicate ability."));
  check("abilities default to none", SetSetupPayload.parse({ scenarioId: "YUL", modules: [] }).abilities.length === 0);
  check("abilities copied onto the scenario", scenarioForSetup({ scenarioId: "YUL", modules: [], abilities: ["control"] }).abilities.join() === "control");
  const legacy = createInitialGameState({ ...SCENARIOS.YUL }, "P", "C");
  check("a game without abilities (old rooms) has none", ABILITY_IDS.every((id) => !hasAbility(legacy, id)));
}

// 2c) Games saved before newer fields existed --------------------------------
console.log("2c) normalizeGameState fills fields missing from older saved games");
{
  const fresh = midRound();
  const old = structuredClone(fresh);
  for (const k of ["pendingSwap", "adaptationUsed", "anticipated", "swappedThisRound", "rerollSpent", "syncDone",
    "trafficPending", "trafficHeld", "trafficPlaced", "internTokens", "internSlots", "internHeld", "internPlaced",
    "kerosene", "keroseneSlot", "iceBrakeSlots"]) delete old[k];
  const fixed = normalizeGameState(old);
  check("missing fields get their defaults", fixed.pendingSwap === null && fixed.trafficHeld === null && fixed.rerollSpent === 0 &&
    fixed.adaptationUsed.pilot === false && Array.isArray(fixed.trafficPlaced) && fixed.kerosene === 20);
  check("existing fields are kept", fixed.round === fresh.round && fixed.axis.pilot === fresh.axis.pilot && fixed.dice.pilot[1].value === 2);
  check("an old game can still be played", reduce(fixed, { type: "placeDie", dieId: 1, target: { kind: "engine" } }, P).state.engines.pilot === 2);
}

// 2d) Scenario templates -----------------------------------------------------
console.log("2d) SCENARIO_TEMPLATES match the rulebook's 21 scenario cards");
{
  const T = SCENARIO_TEMPLATES;
  const count = (d) => T.filter((t) => t.difficulty === d).length;
  check("21 cards: 6 green, 7 yellow, 5 red, 3 black", T.length === 21 && count("green") === 6 && count("yellow") === 7 && count("red") === 5 && count("black") === 3);
  check("difficulties are listed easiest first", DIFFICULTIES.map((d) => d.id).join() === "green,yellow,red,black");
  check("template ids are unique", new Set(T.map((t) => t.id)).size === T.length);
  check("every module is a known module id", T.every((t) => t.modules.every((m) => MODULE_IDS.includes(m))));
  check(
    "no template combines exclusive modules",
    T.every((t) => EXCLUSIVE_MODULE_GROUPS.every((g) => t.modules.filter((m) => g.includes(m)).length <= 1)),
  );
  check("ability counts are 0, 1 or 2", T.every((t) => [0, 1, 2].includes(t.abilityCount)));
  const get = (id) => T.find((t) => t.id === id);
  check("green YUL: no modules, no abilities, uses the YUL board", get("green-YUL")?.modules.length === 0 && get("green-YUL").abilityCount === 0 && get("green-YUL").board === YUL_MONTREAL);
  check("green PRG: Kerosene, ★2", get("green-PRG")?.modules.join() === "kerosene" && get("green-PRG").abilityCount === 2);
  check("yellow ATL: Kerosene Leak, ★1", get("yellow-ATL")?.modules.join() === "keroseneLeak" && get("yellow-ATL").abilityCount === 1);
  check("red OSL: Kerosene Leak + Ice Brakes, ★2", get("red-OSL")?.modules.join() === "keroseneLeak,iceBrakes" && get("red-OSL").abilityCount === 2);
  check("black KEF: Wind + Ice Brakes, ★2", get("black-KEF")?.modules.join() === "wind,iceBrakes" && get("black-KEF").abilityCount === 2);
  check("every card has a playable board, offered in the lobby", T.every((t) => t.board && SCENARIOS[t.id === "green-YUL" ? "YUL" : t.id] === t.board));
  check("boards use their card's strip and ★ count", T.every((t) => t.board.approachTrack.length === APPROACH_TRACKS[t.id].length && (t.board.maxAbilities ?? 0) === t.abilityCount));
  check(
    "reroll rounds follow the Altitude Track side: green/yellow 6,000 + 2,000 ft, red/black 6,000 only",
    T.every((t) => t.board.rerollRounds.join() === (["green", "yellow"].includes(t.difficulty) ? "1,5" : "1")) && YUL_MONTREAL.rerollRounds.join() === "1,5",
  );
  check("every board has 7 rounds from 6,000 ft", T.every((t) => t.board.rounds === 7 && t.board.startAltitudeFeet === 6000));
  check("a card's lobby setup is accepted with its printed modules", T.every((t) => SetSetupPayload.safeParse({ scenarioId: t.id === "green-YUL" ? "YUL" : t.id, modules: t.modules }).success));
}

console.log("2e) APPROACH_TRACKS: one well-formed track per card, as printed on the strips");
{
  const ids = SCENARIO_TEMPLATES.map((t) => t.id);
  check("a track for every card, and no others", ids.every((id) => APPROACH_TRACKS[id]) && Object.keys(APPROACH_TRACKS).length === ids.length);
  const tracks = Object.entries(APPROACH_TRACKS);
  check("the airport is the last space, and only the last", tracks.every(([, t]) => t.at(-1).airport && t.filter((s) => s.airport).length === 1));
  check("traffic and dice counts are whole numbers ≥ 0", tracks.every(([, t]) => t.every((s) => Number.isInteger(s.traffic) && s.traffic >= 0 && (s.trafficDice === undefined || (Number.isInteger(s.trafficDice) && s.trafficDice > 0)))));
  check(
    "turns list 1–4 distinct positions within ±2, never on the airport",
    tracks.every(([, t]) => t.every((s) => !s.axisAllowed || (!s.airport && s.axisAllowed.length >= 1 && s.axisAllowed.length <= 4 && new Set(s.axisAllowed).size === s.axisAllowed.length && s.axisAllowed.every((o) => Number.isInteger(o) && Math.abs(o) <= 2)))),
  );
  // Strip lengths: the long strips have 8 spaces, Galeão 7, Paro / Heathrow / Keflavík 6, Toncontín 5.
  const length = { YUL: 8, HND: 8, OSL: 8, PRG: 8, ATL: 8, KUL: 8, GIG: 7, PBH: 6, LHR: 6, KEF: 6, TGU: 5 };
  check("track lengths match the strips", SCENARIO_TEMPLATES.every((t) => APPROACH_TRACKS[t.id].length === length[t.code]));
  check("no board starts with more than the 12 Airplane tokens", tracks.every(([, t]) => t.reduce((n, s) => n + s.traffic, 0) <= 12));
  const tr = (id) => APPROACH_TRACKS[id].map((s) => `${s.traffic}${s.trafficDice ? `d${s.trafficDice}` : ""}${s.axisAllowed ? `t${s.axisAllowed.join("/")}` : ""}`).join(" ");
  check("spot check green HND (left turns)", tr("green-HND") === "0d2 1 1t1/0 2 1t2/1 0t2/1/0 2 1");
  check("spot check yellow PRG (no start dice)", tr("yellow-PRG") === "0 0 1 3d1 0 3d1 2 3");
  check("spot check black KEF", tr("black-KEF") === "0d2 0t2/1/0 2d1 1t0/-1/-2 1t1/0/-1 0");
}

console.log("2f) entropy: the server's dice values come from a pluggable source");
{
  const queue = (vals) => () => vals.shift();
  const dice = { d6: queue([1, 2, 3, 4, 5, 6, 1, 2, 6]), traffic: queue([4]) };
  const r = withEntropy({ type: "reroll", dieIds: [0, 2] }, dice);
  check("a reroll gets one value per die", r.type === "reroll" && r.values.join() === "1,2");
  const a = withEntropy({ type: "anticipate", dieId: 1 }, dice);
  check("Anticipation gets a value", a.type === "anticipate" && a.value === 3);
  const p = { type: "placeDie", dieId: 0, target: { kind: "radio", slot: 0 } };
  check("other commands pass through unchanged", withEntropy(p, dice) === p);
  const game = createInitialGameState({ ...YUL_MONTREAL, approachTrack: [{ traffic: 0, trafficDice: 1 }, { traffic: 0, airport: true }] }, "P", "C");
  const roll = roundRoll(game, { d6: () => 6, traffic: () => 5 }, 42);
  check("roundRoll: two hands, one Traffic roll per icon, the clock", roll.pilot.join() === "6,6,6,6" && roll.copilot.length === 4 && roll.traffic.join() === "5" && roll.at === 42);
  const settled = settle(game, { d6: () => 3, traffic: () => 2 }, () => 7);
  check("settle rolls the pending round", settled.phase === "placement" && settled.dice.pilot.every((d) => d.value === 3) && settled.airplanes[1] === 1);
}

console.log("2g) tutorial engine: both crews, scripted dice, real rules");
{
  let s = tut.start({ pilot: [3, 4, 6, 6], copilot: [3, 4, 6, 6] });
  check("starts in placement with the given hands", s.phase === "placement" && s.dice.pilot.map((d) => d.value).join() === "3,4,6,6");
  check("the Pilot acts first in round 1", tut.actingCrew(s) === "pilot");
  const dice = tut.scriptedDice({ d6: [5] });
  s = tut.apply(s, tut.place("pilot", 3, tut.axis("pilot")), dice);
  check("a move is played through the reducer", s.axis.pilot === 3 && tut.actingCrew(s) === "copilot");
  const before = s;
  let threw = false;
  try { tut.apply(s, tut.place("copilot", 3, tut.engine("pilot")), dice); } catch { threw = true; }
  check("an illegal move throws and leaves the state alone", threw && before.engines.pilot === null);
  check("scripted dice hand out their values, then random 1–6", dice.d6() === 5 && [1, 2, 3, 4, 5, 6].includes(dice.d6()));
  const sw = tut.start({ abilities: ["workingTogether"], pilot: [1, 3, 6, 6], copilot: [5, 3, 6, 6] });
  const offered = tut.apply(sw, tut.swap("pilot", 1), dice);
  check("the other crew answers a swap", tut.actingCrew(offered) === "copilot");
}

console.log("2h) every tutorial plays out under the current rules");
{
  check("a tutorial for every module and ability", [...MODULE_IDS, ...ABILITY_IDS].every((id) => TUTORIALS[id]?.id === id));
  for (const t of [...Object.values(TUTORIALS), BASICS]) {
    let s = t.setup();
    const dice = tut.scriptedDice(t.script);
    const failures = [];
    for (const [i, step] of t.steps.entries()) {
      try {
        for (const m of step.auto ?? []) s = tut.apply(s, m, dice);
        const before = s;
        if (step.info) continue;
        if (step.done(s, before)) failures.push(`step ${i + 1} done before its moves`);
        for (const m of step.solution) s = tut.apply(s, m, dice);
        if (!step.done(s, before)) failures.push(`step ${i + 1} not done after its moves`);
      } catch (e) {
        failures.push(`step ${i + 1}: ${e.message}`);
        break;
      }
    }
    check(`${t.title}: ${t.steps.length} steps play out${failures.length ? ` — ${failures.join("; ")}` : ""}`, failures.length === 0);
    if (t === BASICS) check(`${t.title}: the flight ends in a landing`, s.outcome?.result === "won");
  }
}

console.log("2i) tutorial session: steps, Next and Reset never block or rewind");
{
  // Next on any step — even one whose automatic moves need a later round — moves on.
  for (const t of [...Object.values(TUTORIALS), BASICS]) {
    let sess = ses.initSession(t);
    const dice = tut.scriptedDice(t.script);
    let stuck = null;
    for (let i = 0; i < t.steps.length; i++) {
      try {
        const next = ses.skip(sess, t, dice);
        if (next.stepIndex !== sess.stepIndex + 1) stuck = `Next from step ${i + 1} stayed on step ${next.stepIndex + 1}`;
        sess = next;
      } catch (e) {
        stuck = `Next from step ${i + 1} threw: ${e.message}`;
      }
      if (stuck) break;
    }
    check(`${t.title}: Next walks every step to free play${stuck ? ` — ${stuck}` : ""}`, !stuck && sess.stepIndex === t.steps.length);
  }
  // A completed step is marked done; advancing it twice (a stale timer) doesn't skip a step.
  const m = TUTORIALS.mastery;
  const dice = tut.scriptedDice(m.script);
  let sess = ses.play(ses.initSession(m), m, tut.place("pilot", 4, tut.engine("pilot")), dice);
  check("finishing a step marks it done, still on it", sess.done && sess.stepIndex === 0);
  const once = ses.advance(sess, m, dice);
  check("advance moves to the next step", once.stepIndex === 1 && !once.done);
  check("advancing an already-advanced session is a no-op", ses.advance(once, m, dice) === once);
  // A move in the window before the advance keeps the latest board.
  sess = ses.play(sess, m, tut.place("copilot", 4, tut.engine("copilot")), dice);
  check("a move made before the advance is kept", sess.game.engines.copilot === 4);
  // A refused move reports the rules' message and leaves the board alone.
  const c = TUTORIALS.control;
  const c0 = ses.initSession(c);
  const refused = ses.play(c0, c, tut.place("copilot", 3, tut.axis("copilot")), tut.scriptedDice());
  check("a refused move keeps the board and explains why", refused.game === c0.game && typeof refused.error === "string" && refused.error.length > 0);
  // Real Time: the clock waits for the first move.
  const rt = TUTORIALS.realTime;
  const r0 = ses.initSession(rt);
  check("Real Time: the clock is paused until the first move", r0.game.timerEndsAt === null && r0.game.timerRemainingMs > 0);
  const r1 = ses.play(r0, rt, tut.place("pilot", 3, tut.axis("pilot")), tut.scriptedDice(rt.script));
  check("…and starts with it", r1.game.timerEndsAt !== null && r1.game.axis.pilot === 3);
}

console.log("2j) tutorial session: automatic moves and already-finished steps");
{
  const base = { id: "kerosene", title: "Synthetic", description: "", show: [], setup: () => tut.start({ pilot: [3, 4, 6, 6], copilot: [3, 4, 6, 6] }) };
  const withAuto = { ...base, steps: [{ text: "", auto: [tut.place("pilot", 3, tut.axis("pilot"))], solution: [], done: () => false }] };
  check("step 1's automatic moves are played at the start", ses.initSession(withAuto).game.axis.pilot === 3);
  const already = {
    ...base,
    steps: [
      { text: "", solution: [tut.place("pilot", 3, tut.axis("pilot"))], done: (s) => s.axis.pilot === 3 },
      { text: "", solution: [], done: (s) => s.axis.pilot === 3 },
    ],
  };
  const dice = tut.scriptedDice();
  const after1 = ses.advance(ses.play(ses.initSession(already), already, tut.place("pilot", 3, tut.axis("pilot")), dice), already, dice);
  check("a step that's already complete when it starts is marked done", after1.stepIndex === 1 && after1.done);
}

console.log("2k) tutorial session: Retry step, strict steps, the full-game tutorial");
{
  const d = tut.scriptedDice({ d6: [1, 2, 3] });
  d.d6();
  check("scripted dice report how many values they've handed out", JSON.stringify(d.used()) === JSON.stringify({ d6: 1, traffic: 0 }));
  check("…and can restart from there", tut.scriptedDice({ d6: [1, 2, 3] }, d.used()).d6() === 2);

  const base = { id: "kerosene", title: "Synthetic", description: "", show: [], setup: () => tut.start({ pilot: [3, 4, 6, 6], copilot: [3, 4, 6, 6] }) };
  const loose = { ...base, steps: [{ text: "Axis", solution: [tut.place("pilot", 3, tut.axis("pilot"))], done: (s) => s.axis.pilot === 3 && s.axis.copilot === 3 }] };
  const dice = tut.scriptedDice();
  const s0 = ses.initSession(loose, dice);
  const s1 = ses.play(s0, loose, tut.place("pilot", 3, tut.axis("pilot")), dice);
  const back = ses.retry(s1, loose);
  check("Retry step rewinds to where the step began", back.game === s0.game && back.stepIndex === 0 && !back.done && back.error === null);
  check("…and remembers the dice used by then", JSON.stringify(back.diceAt) === JSON.stringify(s0.diceAt));

  const strict = {
    ...base,
    strict: true,
    steps: [
      { text: "Pilot: 6 on Concentration, then the Co-Pilot's 6 too.", solution: [tut.free("pilot", 6, "concentration"), tut.free("copilot", 6, "concentration")], done: (s) => s.coffee === 2 },
      { text: "Read this.", info: true, solution: [], done: () => false },
    ],
  };
  const t0 = ses.initSession(strict, dice);
  const wrong = ses.play(t0, strict, tut.place("pilot", 3, tut.axis("pilot")), dice);
  check("strict: a legal move that isn't the step's is refused with the step's hint", wrong.game === t0.game && wrong.error?.includes("Pilot: 6 on Concentration"));
  const other = ses.play(t0, strict, tut.place("pilot", 6, tut.conc(1)), dice);
  check("strict: the same die on another free Concentration space counts", other.error === null && other.game.coffee === 1);
  const skipped = ses.skip(other, strict, dice);
  check("Next plays only the step's moves not yet made", skipped.stepIndex === 1 && skipped.game.coffee === 2);
  const info = ses.play(skipped, strict, tut.place("pilot", 3, tut.axis("pilot")), dice);
  check("strict: no moves during a note", info.game === skipped.game && typeof info.error === "string");

  check("the full-game tutorial is strict, on a copy of YUL", BASICS.strict === true && BASICS.setup().scenario.approachTrack.length === 8);
  check("…with a chapter on every step", BASICS.steps.every((st) => typeof st.chapter === "string" && st.chapter.length > 0));
}

console.log("2l) tutorial session: is there progress to lose on close?");
{
  const t = TUTORIALS.kerosene;
  const dice = tut.scriptedDice(t.script);
  const s0 = ses.initSession(t, dice);
  check("a fresh tutorial has nothing to lose", !ses.hasProgress(s0, t));
  const s1 = ses.play(s0, t, tut.place("pilot", 2, { kind: "kerosene" }), dice);
  check("a move on step 1 is progress", ses.hasProgress(s1, t));
  const s2 = ses.skip(s0, t, dice);
  check("a later step is progress", ses.hasProgress(s2, t));
  let end = s0;
  for (let i = 0; i < t.steps.length; i++) end = ses.skip(end, t, dice);
  check("a finished tutorial has nothing to lose", end.stepIndex === t.steps.length && !ses.hasProgress(end, t));
}

console.log("2m) tutorial session: the Real-Time clock pauses while Leave is asked");
{
  const rt = TUTORIALS.realTime;
  const dice = tut.scriptedDice(rt.script);
  const running = ses.play(ses.initSession(rt, dice), rt, tut.place("pilot", 3, tut.axis("pilot")), dice);
  const left = running.game.timerEndsAt - 1000;
  const paused = ses.pauseClock(running, 1000);
  check("pausing freezes the time left", paused.game.timerEndsAt === null && paused.game.timerRemainingMs === left);
  const resumed = ses.resumeClock(paused, 50000);
  check("resuming restarts it with that time left", resumed.game.timerEndsAt === 50000 + left && resumed.game.timerRemainingMs === null);
  check("the step and its start are untouched", resumed.stepIndex === running.stepIndex && resumed.before === running.before);
  const k = ses.initSession(TUTORIALS.kerosene);
  check("with no clock running, pausing changes nothing", ses.pauseClock(k, 1000) === k);
}

// 3) CORS origin check -------------------------------------------------------
console.log("3) originChecker: wildcard, allowlist, missing origin");
{
  const any = originChecker("*");
  check("* allows any origin", any("http://192.168.1.50:5173") && any("https://evil.example"));
  const list = originChecker(" http://localhost:5173 , http://localhost:8080,");
  check("allowlisted origin allowed (whitespace trimmed)", list("http://localhost:5173") && list("http://localhost:8080"));
  check("other origin rejected", !list("http://localhost:3000"));
  check("port matters", !list("http://localhost"));
  check("no Origin header (curl) allowed", list(undefined));
  check("empty spec allows nothing with an Origin", !originChecker("")("http://localhost:5173"));
}

// 4) uuid --------------------------------------------------------------------
console.log("4) uuid(): native and getRandomValues fallback");
{
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  check("native path yields a v4 uuid", V4.test(uuid()));

  // Simulate a non-secure context (plain-HTTP LAN), where randomUUID is absent.
  const native = crypto.randomUUID;
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
  try {
    const ids = Array.from({ length: 200 }, uuid);
    check("fallback yields v4 uuids", ids.every((id) => V4.test(id)));
    check("fallback ids are unique", new Set(ids).size === ids.length);
  } finally {
    Object.defineProperty(crypto, "randomUUID", { value: native, configurable: true, writable: true });
  }
}

console.log("5) Seating: who flies which seat; bot seats");
{
  const { seatCrews, crewOf, botSeat, unreadyOthers } = seating;
  const base = { id: "r", inviteCode: "i", hostPlayerId: "H", status: "lobby", observers: [], setup: DEFAULT_SETUP, version: 0, game: null, updatedAt: 0 };
  const seats = [{ playerId: "H", role: "host", ready: true, connected: true }, { playerId: "G", role: "guest", ready: true, connected: true }];
  check("default: host flies Pilot", JSON.stringify(seatCrews({ ...base, seats })) === JSON.stringify({ pilotId: "H", copilotId: "G" }));
  check("hostCrew copilot: host flies Co-Pilot", JSON.stringify(seatCrews({ ...base, seats, hostCrew: "copilot" })) === JSON.stringify({ pilotId: "G", copilotId: "H" }));
  check("crewOf maps a player to the crew they fly", crewOf({ ...base, seats, hostCrew: "copilot" }, "H") === "copilot" && crewOf({ ...base, seats }, "X") === null);
  const solo = { ...base, hostCrew: "copilot", seats: [seats[0], { ...seats[1], playerId: "bot:1", bot: "cadet" }] };
  check("bot seat found", botSeat(solo)?.bot === "cadet" && botSeat({ ...base, seats }) === null);
  check("a setup change keeps the bot ready", unreadyOthers(solo.seats, "H").find((s) => s.bot).ready === true);
  check("…and un-readies the other humans", unreadyOthers(seats, "H").find((s) => s.playerId === "G").ready === false);
  check("exit to lobby (keep nobody): humans un-ready, the bot stays ready", JSON.stringify(unreadyOthers(solo.seats, null).map((s) => s.ready)) === "[false,true]");

  const { npcShouldAct } = seating;
  const { newGame, mulberry32 } = await import("../packages/shared/src/index.ts");
  const g = newGame(DEFAULT_SETUP, "bot:1", "H", mulberry32(5), 0); // bot flies Pilot; the Pilot leads round 1
  const playing = { ...solo, hostCrew: "copilot", status: "in_progress", game: g };
  check("bot acts when the game waits on its crew", npcShouldAct(playing)?.crew === "pilot");
  check("…not when it waits on the human", npcShouldAct({ ...playing, game: { ...g, turn: "copilot" } }) === null);
  check("…not outside an in-progress game", npcShouldAct({ ...playing, status: "finished" }) === null);
  check("…not in rooms without a bot", npcShouldAct({ ...playing, seats }) === null);
  check("…not while a Real-Time clock is paused (every action is refused then)", npcShouldAct({ ...playing, game: { ...g, timerRemainingMs: 30000 } }) === null);

  // Real-Time: past the deadline the round is over — the bot doesn't try a move
  // (it would only be refused as too late); the time-up wakes it if it leads next.
  check("…not once a Real-Time deadline has passed", npcShouldAct({ ...playing, game: { ...g, timerEndsAt: Date.now() - 1 } }) === null);
  const { reduce: reduceRT, settle, randDice } = await import("../packages/shared/src/index.ts");
  const rt = newGame({ ...DEFAULT_SETUP, modules: ["realTime"] }, "H", "bot:1", mulberry32(8), Date.now()); // human Pilot leads round 1
  const mandatoryDown = { ...rt, axis: { pilot: 3, copilot: 3, offset: 0 }, engines: { pilot: 3, copilot: 3 } };
  const round2 = settle(reduceRT(mandatoryDown, { type: "timeUp" }, "").state, randDice(mulberry32(9)), Date.now);
  const rtRoom = { ...solo, hostCrew: "pilot", status: "in_progress", game: round2 };
  check("after a time-up, the bot (Co-Pilot) leads round 2 and is woken", round2.round === 2 && round2.phase === "placement" && npcShouldAct(rtRoom)?.crew === "copilot");
  const { lobbyStatus, npcGivesUp, abandonsOnDisconnect } = seating;
  const readySolo = solo.seats.map((s) => ({ ...s, ready: true }));
  check("solo: after a setup change both seats are still ready, so the room stays ready", lobbyStatus(unreadyOthers(readySolo, "H")) === "ready");
  check("multiplayer: after a setup change the guest must ready up again", lobbyStatus(unreadyOthers(seats, "H")) === "lobby");
  check("a lone host is never ready to start", lobbyStatus([seats[0]]) === "lobby");
  check("a rejected bot move is retried a couple of times…", !npcGivesUp(1) && !npcGivesUp(2));
  check("…then the bot gives up instead of retrying forever", npcGivesUp(3));
  check("a solo game waits for its human (nobody else is waiting)", !abandonsOnDisconnect(solo));
  check("a multiplayer game is abandoned when a player doesn't return", abandonsOnDisconnect({ ...base, seats }));
}

console.log("6) think(): Aviator in a worker, with a fallback");
{
  const { think, warmThinking, stopThinking, thinkStats } = await import("../packages/server/src/think.ts");
  const { newGame, mulberry32, redactGameStateFor, legalMoves } = await import("../packages/shared/src/index.ts");
  const g = newGame(DEFAULT_SETUP, "P", "C", mulberry32(9), 0);
  const view = redactGameStateFor(g, "P");
  const legal = (m) => legalMoves(view, "pilot").some((x) => JSON.stringify(x) === JSON.stringify(m));
  await warmThinking(); // the worker takes a few seconds to load
  const t0 = Date.now();
  const m = await think(view, "pilot", "aviator", 1);
  check("Aviator answers through the worker within its budget", Date.now() - t0 < 2000 && legal(m) && thinkStats.worker === 1 && thinkStats.fallback === 0);
  check("a worker failure falls back to Navigator", legal(await think(view, "pilot", "aviator", 1, { simulateWorkerError: true })) && thinkStats.fallback === 1);
  check("Cadet and Navigator answer inline", legal(await think(view, "pilot", "cadet", 2)) && legal(await think(view, "pilot", "navigator", 3)));
  // The real failure paths, through the worker:
  const { crashWorkerForTest } = await import("../packages/server/src/think.ts");
  const before = thinkStats.fallback;
  crashWorkerForTest(); // the worker handles this first, then dies with the request below pending
  const during = think(view, "pilot", "aviator", 4);
  check("a worker crash mid-request falls back to Navigator", legal(await during) && thinkStats.fallback === before + 1);
  await warmThinking(); // a crashed worker is replaced by a fresh one
  const w0 = thinkStats.worker;
  check("…and the next Aviator move comes from a fresh worker", legal(await think(view, "pilot", "aviator", 5)) && thinkStats.worker === w0 + 1);
  const f0 = thinkStats.fallback;
  check("a timed-out request falls back to Navigator", legal(await think(view, "pilot", "aviator", 6, { timeoutMs: 1 })) && thinkStats.fallback === f0 + 1);
  let crashed = false;
  const none = await think(null, "pilot", "navigator", 7).catch(() => (crashed = true));
  check("a bot that fails outright resolves null (the room gives up) instead of crashing the server", !crashed && none === null);
  await stopThinking(); // let the test process exit
}

console.log(failures === 0 ? "\nALL UNIT TESTS PASSED ✅" : `\n${failures} UNIT TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
