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
import { originChecker } from "../packages/server/src/cors.ts";
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

console.log(failures === 0 ? "\nALL UNIT TESTS PASSED ✅" : `\n${failures} UNIT TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
