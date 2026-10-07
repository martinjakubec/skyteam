// Converted from scripts/test-units.mjs by the Vitest codemod: each section is a test,
// each check(label, cond) a set of assertion helpers with the same verdict (see support/checks.mjs).
import { test } from "vitest";
import * as __c from "./support/checks.mjs";
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
  SetNamePayload,
  SetSetupPayload,
  conflictingModules,
  crewNames,
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

import { productionProblems } from "../packages/server/src/env.ts";

import { issueToken, verifyToken } from "../packages/server/src/identity.ts";

import { evictExpired, guard, rateLimiter } from "../packages/server/src/guard.ts";

import { singleFlight } from "../packages/server/src/singleFlight.ts";

import * as seating from "../packages/server/src/seating.ts";

import { uuid } from "../packages/client/src/uuid.ts";


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
test("1) redactGameStateFor hides only the other crew's unplaced dice", async () => {
  const s = midRound();
  const forPilot = redactGameStateFor(s, P);
  (__c.begin("pilot sees all own values"), __c.done(__c.truthy("pilot sees all own values", (forPilot.dice.pilot.every((d, i) => d.value === s.dice.pilot[i].value && !d.hidden)))));
  (__c.begin("pilot sees copilot's placed die"), __c.done(__c.cmp("pilot sees copilot's placed die", (forPilot.dice.copilot[0].value), "===", (5)) && __c.truthy("pilot sees copilot's placed die", (forPilot.dice.copilot[0].placed))));
  (__c.begin("copilot's unplaced dice hidden from pilot"), __c.done(__c.truthy("copilot's unplaced dice hidden from pilot", (forPilot.dice.copilot.slice(1).every(isHidden)))));
  (__c.begin("hidden dice keep their ids"), __c.done(__c.cmp("hidden dice keep their ids", (forPilot.dice.copilot.map((d) => d.id).join()), "===", ("0,1,2,3"))));

  const forCopilot = redactGameStateFor(s, C);
  (__c.begin("copilot sees own values"), __c.done(__c.truthy("copilot sees own values", (forCopilot.dice.copilot.every((d) => d.value !== undefined)))));
  (__c.begin("pilot's unplaced dice hidden from copilot"), __c.done(__c.truthy("pilot's unplaced dice hidden from copilot", (forCopilot.dice.pilot.slice(1).every(isHidden)))));

  const forObserver = redactGameStateFor(s, "observer");
  (__c.begin("observer sees no unplaced dice from either crew"), __c.done(__c.truthy("observer sees no unplaced dice from either crew", ([...forObserver.dice.pilot.slice(1), ...forObserver.dice.copilot.slice(1)].every(isHidden)))));
  (__c.begin("observer still sees placed dice"), __c.done(__c.cmp("observer still sees placed dice", (forObserver.dice.pilot[0].value), "===", (1))));

  (__c.begin("source state not mutated"), __c.done(__c.truthy("source state not mutated", (s.dice.copilot.every((d) => d.value !== undefined && !d.hidden)))));
  (__c.begin("no hidden value leaks through JSON"), __c.done(__c.falsy("no hidden value leaks through JSON", (JSON.stringify(forPilot.dice.copilot.slice(1)).includes('"value"')))));

  // Working Together: the offered die lies face-up on the card.
  const offer = structuredClone(s);
  offer.pendingSwap = { from: "pilot", dieId: 1 };
  const forResponder = redactGameStateFor(offer, C);
  (__c.begin("an offered Working Together die is visible to the other player"), __c.done(__c.cmp("an offered Working Together die is visible to the other player", (forResponder.dice.pilot[1].value), "===", (2)) && __c.falsy("an offered Working Together die is visible to the other player", (forResponder.dice.pilot[1].hidden))));
  (__c.begin("…but only that one"), __c.done(__c.truthy("…but only that one", (forResponder.dice.pilot.slice(2).every(isHidden)))));
  (__c.begin("…and spectators see it too"), __c.done(__c.cmp("…and spectators see it too", (redactGameStateFor(offer, "observer").dice.pilot[1].value), "===", (2))));
});

// 2) Per-viewer snapshots ----------------------------------------------------
test("2) toSnapshot tailors the game and 'you' to the recipient", async () => {
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
  (__c.begin("player sees their seat role"), __c.done(__c.cmp("player sees their seat role", (forC.you.kind), "===", ("player")) && __c.cmp("player sees their seat role", (forC.you.role), "===", ("copilot"))));
  (__c.begin("game redacted for the copilot"), __c.done(__c.truthy("game redacted for the copilot", (forC.game.dice.pilot.slice(1).every(isHidden)))));
  (__c.begin("connection state mapped"), __c.done(__c.cmp("connection state mapped", (forC.seats[1].connection), "===", ("disconnected"))));
  const forO = toSnapshot(room, "O");
  (__c.begin("observer marked as observer"), __c.done(__c.cmp("observer marked as observer", (forO.you.kind), "===", ("observer")) && __c.cmp("observer marked as observer", (forO.you.role), "===", (undefined))));
  (__c.begin("game redacted for the observer"), __c.done(__c.truthy("game redacted for the observer", (forO.game.dice.copilot.slice(1).every(isHidden)))));
  (__c.begin("lobby snapshot has no game"), __c.done(__c.cmp("lobby snapshot has no game", (toSnapshot({ ...room, game: null }, P).game), "===", (null))));
  (__c.begin("snapshot carries the room setup"), __c.done(__c.cmp("snapshot carries the room setup", (forO.setup.scenarioId), "===", ("YUL"))));
});

// 2b) Game setup ---------------------------------------------------------------
test("2b) SetSetupPayload validation and scenarioForSetup", async () => {
  const ok = (v) => SetSetupPayload.safeParse(v).success;
  (__c.begin("default setup is valid"), __c.done(__c.truthy("default setup is valid", (ok(DEFAULT_SETUP)))));
  (__c.begin("unknown airport rejected"), __c.done(__c.falsy("unknown airport rejected", (ok({ scenarioId: "XXX", modules: [] })))));
  (__c.begin("unknown module rejected"), __c.done(__c.falsy("unknown module rejected", (ok({ scenarioId: "YUL", modules: ["jetpack"] })))));
  (__c.begin("implemented module accepted"), __c.done(__c.truthy("implemented module accepted", (ok({ scenarioId: "YUL", modules: ["kerosene"] })))));
  (__c.begin("Traffic dice are board data, not a lobby module"), __c.done(__c.falsy("Traffic dice are board data, not a lobby module", (ok({ scenarioId: "YUL", modules: ["trafficDie"] })))));
  (__c.begin("Kerosene Leak accepted"), __c.done(__c.truthy("Kerosene Leak accepted", (ok({ scenarioId: "YUL", modules: ["keroseneLeak"] })))));
  (__c.begin("Ice Brakes combine with Kerosene"), __c.done(__c.truthy("Ice Brakes combine with Kerosene", (ok({ scenarioId: "YUL", modules: ["kerosene", "iceBrakes"] })))));
  (__c.begin("Kerosene + Kerosene Leak together rejected"), __c.done(__c.falsy("Kerosene + Kerosene Leak together rejected", (ok({ scenarioId: "YUL", modules: ["kerosene", "keroseneLeak"] })))));
  (__c.begin("duplicate module rejected"), __c.done(__c.falsy("duplicate module rejected", (ok({ scenarioId: "YUL", modules: ["kerosene", "kerosene"] })))));
  (__c.begin("missing modules rejected"), __c.done(__c.falsy("missing modules rejected", (ok({ scenarioId: "YUL" })))));

  const scenario = scenarioForSetup({ scenarioId: "YUL", modules: [] });
  (__c.begin("setup resolves to the airport's board"), __c.done(__c.cmp("setup resolves to the airport's board", (scenario.name), "===", (SCENARIOS.YUL.name)) && __c.cmp("setup resolves to the airport's board", (scenario.rounds), "===", (7))));
  (__c.begin("modules are copied onto the scenario"), __c.done(__c.truthy("modules are copied onto the scenario", (Array.isArray(scenario.modules))) && __c.cmp("modules are copied onto the scenario", (scenario.modules.length), "===", (0))));
  scenario.modules.push("intern");
  (__c.begin("resolving never mutates the registry"), __c.done(__c.cmp("resolving never mutates the registry", (SCENARIOS.YUL.modules), "===", (undefined))));
  (__c.begin("Kerosene and Kerosene Leak exclude each other"), __c.done(__c.cmp("Kerosene and Kerosene Leak exclude each other", (conflictingModules("kerosene").join()), "===", ("keroseneLeak")) && __c.cmp("Kerosene and Kerosene Leak exclude each other", (conflictingModules("keroseneLeak").join()), "===", ("kerosene"))));
  (__c.begin("unrelated modules conflict with nothing"), __c.done(__c.cmp("unrelated modules conflict with nothing", (conflictingModules("intern").length), "===", (0))));

  // Special Abilities (lobby selection).
  (__c.begin("YUL allows no abilities"), __c.done(__c.falsy("YUL allows no abilities", (ok({ scenarioId: "YUL", modules: [], abilities: ["control"] })))));
  // YUL refuses every ability, so these assert the specific error, not just a refusal.
  const issues = (body) => (SetSetupPayload.safeParse(body).error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ");
  (__c.begin("unknown ability rejected"), __c.done(__c.matches("unknown ability rejected", /^abilities\.0: Invalid enum value/, (issues({ scenarioId: "YUL", modules: [], abilities: ["teleport"] })))));
  (__c.begin("duplicate ability rejected"), __c.done(__c.contains("duplicate ability rejected", (issues({ scenarioId: "YUL", modules: [], abilities: ["control", "control"] })), ("Duplicate ability."))));
  (__c.begin("abilities default to none"), __c.done(__c.cmp("abilities default to none", (SetSetupPayload.parse({ scenarioId: "YUL", modules: [] }).abilities.length), "===", (0))));
  (__c.begin("abilities copied onto the scenario"), __c.done(__c.cmp("abilities copied onto the scenario", (scenarioForSetup({ scenarioId: "YUL", modules: [], abilities: ["control"] }).abilities.join()), "===", ("control"))));
  const legacy = createInitialGameState({ ...SCENARIOS.YUL }, "P", "C");
  (__c.begin("a game without abilities (old rooms) has none"), __c.done(__c.truthy("a game without abilities (old rooms) has none", (ABILITY_IDS.every((id) => !hasAbility(legacy, id))))));
});

// 2c) Games saved before newer fields existed --------------------------------
test("2c) normalizeGameState fills fields missing from older saved games", async () => {
  const fresh = midRound();
  const old = structuredClone(fresh);
  for (const k of ["pendingSwap", "adaptationUsed", "anticipated", "swappedThisRound", "rerollSpent", "syncDone",
    "trafficPending", "trafficHeld", "trafficPlaced", "internTokens", "internSlots", "internHeld", "internPlaced",
    "kerosene", "keroseneSlot", "iceBrakeSlots"]) delete old[k];
  const fixed = normalizeGameState(old);
  (__c.begin("missing fields get their defaults"), __c.done(__c.cmp("missing fields get their defaults", (fixed.pendingSwap), "===", (null)) && __c.cmp("missing fields get their defaults", (fixed.trafficHeld), "===", (null)) && __c.cmp("missing fields get their defaults", (fixed.rerollSpent), "===", (0)) && __c.cmp("missing fields get their defaults", (fixed.adaptationUsed.pilot), "===", (false)) && __c.truthy("missing fields get their defaults", (Array.isArray(fixed.trafficPlaced))) && __c.cmp("missing fields get their defaults", (fixed.kerosene), "===", (20))));
  (__c.begin("existing fields are kept"), __c.done(__c.cmp("existing fields are kept", (fixed.round), "===", (fresh.round)) && __c.cmp("existing fields are kept", (fixed.axis.pilot), "===", (fresh.axis.pilot)) && __c.cmp("existing fields are kept", (fixed.dice.pilot[1].value), "===", (2))));
  (__c.begin("an old game can still be played"), __c.done(__c.cmp("an old game can still be played", (reduce(fixed, { type: "placeDie", dieId: 1, target: { kind: "engine" } }, P).state.engines.pilot), "===", (2))));
});

// 2d) Scenario templates -----------------------------------------------------
test("2d) SCENARIO_TEMPLATES match the rulebook's 21 scenario cards", async () => {
  const T = SCENARIO_TEMPLATES;
  const count = (d) => T.filter((t) => t.difficulty === d).length;
  (__c.begin("21 cards: 6 green, 7 yellow, 5 red, 3 black"), __c.done(__c.cmp("21 cards: 6 green, 7 yellow, 5 red, 3 black", (T.length), "===", (21)) && __c.cmp("21 cards: 6 green, 7 yellow, 5 red, 3 black", (count("green")), "===", (6)) && __c.cmp("21 cards: 6 green, 7 yellow, 5 red, 3 black", (count("yellow")), "===", (7)) && __c.cmp("21 cards: 6 green, 7 yellow, 5 red, 3 black", (count("red")), "===", (5)) && __c.cmp("21 cards: 6 green, 7 yellow, 5 red, 3 black", (count("black")), "===", (3))));
  (__c.begin("difficulties are listed easiest first"), __c.done(__c.cmp("difficulties are listed easiest first", (DIFFICULTIES.map((d) => d.id).join()), "===", ("green,yellow,red,black"))));
  (__c.begin("template ids are unique"), __c.done(__c.cmp("template ids are unique", (new Set(T.map((t) => t.id)).size), "===", (T.length))));
  (__c.begin("every module is a known module id"), __c.done(__c.truthy("every module is a known module id", (T.every((t) => t.modules.every((m) => MODULE_IDS.includes(m)))))));
  (__c.begin("no template combines exclusive modules"), __c.done(__c.truthy("no template combines exclusive modules", (T.every((t) => EXCLUSIVE_MODULE_GROUPS.every((g) => t.modules.filter((m) => g.includes(m)).length <= 1))))));
  (__c.begin("ability counts are 0, 1 or 2"), __c.done(__c.truthy("ability counts are 0, 1 or 2", (T.every((t) => [0, 1, 2].includes(t.abilityCount))))));
  const get = (id) => T.find((t) => t.id === id);
  (__c.begin("green YUL: no modules, no abilities, uses the YUL board"), __c.done(__c.cmp("green YUL: no modules, no abilities, uses the YUL board", (get("green-YUL")?.modules.length), "===", (0)) && __c.cmp("green YUL: no modules, no abilities, uses the YUL board", (get("green-YUL").abilityCount), "===", (0)) && __c.cmp("green YUL: no modules, no abilities, uses the YUL board", (get("green-YUL").board), "===", (YUL_MONTREAL))));
  (__c.begin("green PRG: Kerosene, ★2"), __c.done(__c.cmp("green PRG: Kerosene, ★2", (get("green-PRG")?.modules.join()), "===", ("kerosene")) && __c.cmp("green PRG: Kerosene, ★2", (get("green-PRG").abilityCount), "===", (2))));
  (__c.begin("yellow ATL: Kerosene Leak, ★1"), __c.done(__c.cmp("yellow ATL: Kerosene Leak, ★1", (get("yellow-ATL")?.modules.join()), "===", ("keroseneLeak")) && __c.cmp("yellow ATL: Kerosene Leak, ★1", (get("yellow-ATL").abilityCount), "===", (1))));
  (__c.begin("red OSL: Kerosene Leak + Ice Brakes, ★2"), __c.done(__c.cmp("red OSL: Kerosene Leak + Ice Brakes, ★2", (get("red-OSL")?.modules.join()), "===", ("keroseneLeak,iceBrakes")) && __c.cmp("red OSL: Kerosene Leak + Ice Brakes, ★2", (get("red-OSL").abilityCount), "===", (2))));
  (__c.begin("black KEF: Wind + Ice Brakes, ★2"), __c.done(__c.cmp("black KEF: Wind + Ice Brakes, ★2", (get("black-KEF")?.modules.join()), "===", ("wind,iceBrakes")) && __c.cmp("black KEF: Wind + Ice Brakes, ★2", (get("black-KEF").abilityCount), "===", (2))));
  (__c.begin("every card has a playable board, offered in the lobby"), __c.done(__c.truthy("every card has a playable board, offered in the lobby", (T.every((t) => t.board && SCENARIOS[t.id === "green-YUL" ? "YUL" : t.id] === t.board)))));
  (__c.begin("boards use their card's strip and ★ count"), __c.done(__c.truthy("boards use their card's strip and ★ count", (T.every((t) => t.board.approachTrack.length === APPROACH_TRACKS[t.id].length && (t.board.maxAbilities ?? 0) === t.abilityCount)))));
  (__c.begin("reroll rounds follow the Altitude Track side: green/yellow 6,000 + 2,000 ft, red/black 6,000 only"), __c.done(__c.truthy("reroll rounds follow the Altitude Track side: green/yellow 6,000 + 2,000 ft, red/black 6,000 only", (T.every((t) => t.board.rerollRounds.join() === (["green", "yellow"].includes(t.difficulty) ? "1,5" : "1")))) && __c.cmp("reroll rounds follow the Altitude Track side: green/yellow 6,000 + 2,000 ft, red/black 6,000 only", (YUL_MONTREAL.rerollRounds.join()), "===", ("1,5"))));
  (__c.begin("every board has 7 rounds from 6,000 ft"), __c.done(__c.truthy("every board has 7 rounds from 6,000 ft", (T.every((t) => t.board.rounds === 7 && t.board.startAltitudeFeet === 6000)))));
  (__c.begin("a card's lobby setup is accepted with its printed modules"), __c.done(__c.truthy("a card's lobby setup is accepted with its printed modules", (T.every((t) => SetSetupPayload.safeParse({ scenarioId: t.id === "green-YUL" ? "YUL" : t.id, modules: t.modules }).success)))));
});

test("2e) APPROACH_TRACKS: one well-formed track per card, as printed on the strips", async () => {
  const ids = SCENARIO_TEMPLATES.map((t) => t.id);
  (__c.begin("a track for every card, and no others"), __c.done(__c.truthy("a track for every card, and no others", (ids.every((id) => APPROACH_TRACKS[id]))) && __c.cmp("a track for every card, and no others", (Object.keys(APPROACH_TRACKS).length), "===", (ids.length))));
  const tracks = Object.entries(APPROACH_TRACKS);
  (__c.begin("the airport is the last space, and only the last"), __c.done(__c.truthy("the airport is the last space, and only the last", (tracks.every(([, t]) => t.at(-1).airport && t.filter((s) => s.airport).length === 1)))));
  (__c.begin("traffic and dice counts are whole numbers ≥ 0"), __c.done(__c.truthy("traffic and dice counts are whole numbers ≥ 0", (tracks.every(([, t]) => t.every((s) => Number.isInteger(s.traffic) && s.traffic >= 0 && (s.trafficDice === undefined || (Number.isInteger(s.trafficDice) && s.trafficDice > 0))))))));
  (__c.begin("turns list 1–4 distinct positions within ±2, never on the airport"), __c.done(__c.truthy("turns list 1–4 distinct positions within ±2, never on the airport", (tracks.every(([, t]) => t.every((s) => !s.axisAllowed || (!s.airport && s.axisAllowed.length >= 1 && s.axisAllowed.length <= 4 && new Set(s.axisAllowed).size === s.axisAllowed.length && s.axisAllowed.every((o) => Number.isInteger(o) && Math.abs(o) <= 2))))))));
  // Strip lengths: the long strips have 8 spaces, Montréal and Galeão 7, Paro / Heathrow / Keflavík 6, Toncontín 5.
  const length = { YUL: 7, HND: 8, OSL: 8, PRG: 8, ATL: 8, KUL: 8, GIG: 7, PBH: 6, LHR: 6, KEF: 6, TGU: 5 };
  (__c.begin("track lengths match the strips"), __c.done(__c.truthy("track lengths match the strips", (SCENARIO_TEMPLATES.every((t) => APPROACH_TRACKS[t.id].length === length[t.code])))));
  (__c.begin("no board starts with more than the 12 Airplane tokens"), __c.done(__c.truthy("no board starts with more than the 12 Airplane tokens", (tracks.every(([, t]) => t.reduce((n, s) => n + s.traffic, 0) <= 12)))));
  const tr = (id) => APPROACH_TRACKS[id].map((s) => `${s.traffic}${s.trafficDice ? `d${s.trafficDice}` : ""}${s.axisAllowed ? `t${s.axisAllowed.join("/")}` : ""}`).join(" ");
  (__c.begin("spot check green YUL (no dice, no turns)"), __c.done(__c.cmp("spot check green YUL (no dice, no turns)", (tr("green-YUL")), "===", ("0 0 1 2 1 3 2"))));
  (__c.begin("spot check green HND (left turns)"), __c.done(__c.cmp("spot check green HND (left turns)", (tr("green-HND")), "===", ("0d2 1 1t1/0 2 1t2/1 0t2/1/0 2 1"))));
  (__c.begin("spot check yellow PRG (no start dice)"), __c.done(__c.cmp("spot check yellow PRG (no start dice)", (tr("yellow-PRG")), "===", ("0 0 1 3d1 0 3d1 2 3"))));
  (__c.begin("spot check black KEF"), __c.done(__c.cmp("spot check black KEF", (tr("black-KEF")), "===", ("0d2 0t2/1/0 2d1 1t0/-1/-2 1t1/0/-1 0"))));
});

test("2f) entropy: the server's dice values come from a pluggable source", async () => {
  const queue = (vals) => () => vals.shift();
  const dice = { d6: queue([1, 2, 3, 4, 5, 6, 1, 2, 6]), traffic: queue([4]) };
  const r = withEntropy({ type: "reroll", dieIds: [0, 2] }, dice);
  (__c.begin("a reroll gets one value per die"), __c.done(__c.cmp("a reroll gets one value per die", (r.type), "===", ("reroll")) && __c.cmp("a reroll gets one value per die", (r.values.join()), "===", ("1,2"))));
  const a = withEntropy({ type: "anticipate", dieId: 1 }, dice);
  (__c.begin("Anticipation gets a value"), __c.done(__c.cmp("Anticipation gets a value", (a.type), "===", ("anticipate")) && __c.cmp("Anticipation gets a value", (a.value), "===", (3))));
  const p = { type: "placeDie", dieId: 0, target: { kind: "radio", slot: 0 } };
  (__c.begin("other commands pass through unchanged"), __c.done(__c.cmp("other commands pass through unchanged", (withEntropy(p, dice)), "===", (p))));
  const game = createInitialGameState({ ...YUL_MONTREAL, approachTrack: [{ traffic: 0, trafficDice: 1 }, { traffic: 0, airport: true }] }, "P", "C");
  const roll = roundRoll(game, { d6: () => 6, traffic: () => 5 }, 42);
  (__c.begin("roundRoll: two hands, one Traffic roll per icon, the clock"), __c.done(__c.cmp("roundRoll: two hands, one Traffic roll per icon, the clock", (roll.pilot.join()), "===", ("6,6,6,6")) && __c.cmp("roundRoll: two hands, one Traffic roll per icon, the clock", (roll.copilot.length), "===", (4)) && __c.cmp("roundRoll: two hands, one Traffic roll per icon, the clock", (roll.traffic.join()), "===", ("5")) && __c.cmp("roundRoll: two hands, one Traffic roll per icon, the clock", (roll.at), "===", (42))));
  const settled = settle(game, { d6: () => 3, traffic: () => 2 }, () => 7);
  (__c.begin("settle rolls the pending round"), __c.done(__c.cmp("settle rolls the pending round", (settled.phase), "===", ("placement")) && __c.truthy("settle rolls the pending round", (settled.dice.pilot.every((d) => d.value === 3))) && __c.cmp("settle rolls the pending round", (settled.airplanes[1]), "===", (1))));
});

test("2g) tutorial engine: both crews, scripted dice, real rules", async () => {
  let s = tut.start({ pilot: [3, 4, 6, 6], copilot: [3, 4, 6, 6] });
  (__c.begin("starts in placement with the given hands"), __c.done(__c.cmp("starts in placement with the given hands", (s.phase), "===", ("placement")) && __c.cmp("starts in placement with the given hands", (s.dice.pilot.map((d) => d.value).join()), "===", ("3,4,6,6"))));
  (__c.begin("the Pilot acts first in round 1"), __c.done(__c.cmp("the Pilot acts first in round 1", (tut.actingCrew(s)), "===", ("pilot"))));
  const dice = tut.scriptedDice({ d6: [5] });
  s = tut.apply(s, tut.place("pilot", 3, tut.axis("pilot")), dice);
  (__c.begin("a move is played through the reducer"), __c.done(__c.cmp("a move is played through the reducer", (s.axis.pilot), "===", (3)) && __c.cmp("a move is played through the reducer", (tut.actingCrew(s)), "===", ("copilot"))));
  const before = s;
  let threw = false;
  try { tut.apply(s, tut.place("copilot", 3, tut.engine("pilot")), dice); } catch { threw = true; }
  (__c.begin("an illegal move throws and leaves the state alone"), __c.done(__c.truthy("an illegal move throws and leaves the state alone", (threw)) && __c.cmp("an illegal move throws and leaves the state alone", (before.engines.pilot), "===", (null))));
  (__c.begin("scripted dice hand out their values, then random 1–6"), __c.done(__c.cmp("scripted dice hand out their values, then random 1–6", (dice.d6()), "===", (5)) && __c.contains("scripted dice hand out their values, then random 1–6", ([1, 2, 3, 4, 5, 6]), (dice.d6()))));
  const sw = tut.start({ abilities: ["workingTogether"], pilot: [1, 3, 6, 6], copilot: [5, 3, 6, 6] });
  const offered = tut.apply(sw, tut.swap("pilot", 1), dice);
  (__c.begin("the other crew answers a swap"), __c.done(__c.cmp("the other crew answers a swap", (tut.actingCrew(offered)), "===", ("copilot"))));
});

test("2h) every tutorial plays out under the current rules", async () => {
  (__c.begin("a tutorial for every module and ability"), __c.done(__c.truthy("a tutorial for every module and ability", ([...MODULE_IDS, ...ABILITY_IDS].every((id) => TUTORIALS[id]?.id === id)))));
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
    (__c.begin(`${t.title}: ${t.steps.length} steps play out${failures.length ? ` — ${failures.join("; ")}` : ""}`), __c.done(__c.cmp(`${t.title}: ${t.steps.length} steps play out${failures.length ? ` — ${failures.join("; ")}` : ""}`, (failures.length), "===", (0))));
    if (t === BASICS) (__c.begin(`${t.title}: the flight ends in a landing`), __c.done(__c.cmp(`${t.title}: the flight ends in a landing`, (s.outcome?.result), "===", ("won"))));
  }
});

test("2i) tutorial session: steps, Next and Reset never block or rewind", async () => {
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
    (__c.begin(`${t.title}: Next walks every step to free play${stuck ? ` — ${stuck}` : ""}`), __c.done(__c.falsy(`${t.title}: Next walks every step to free play${stuck ? ` — ${stuck}` : ""}`, (stuck)) && __c.cmp(`${t.title}: Next walks every step to free play${stuck ? ` — ${stuck}` : ""}`, (sess.stepIndex), "===", (t.steps.length))));
  }
  // A completed step is marked done; advancing it twice (a stale timer) doesn't skip a step.
  const m = TUTORIALS.mastery;
  const dice = tut.scriptedDice(m.script);
  let sess = ses.play(ses.initSession(m), m, tut.place("pilot", 4, tut.engine("pilot")), dice);
  (__c.begin("finishing a step marks it done, still on it"), __c.done(__c.truthy("finishing a step marks it done, still on it", (sess.done)) && __c.cmp("finishing a step marks it done, still on it", (sess.stepIndex), "===", (0))));
  const once = ses.advance(sess, m, dice);
  (__c.begin("advance moves to the next step"), __c.done(__c.cmp("advance moves to the next step", (once.stepIndex), "===", (1)) && __c.falsy("advance moves to the next step", (once.done))));
  (__c.begin("advancing an already-advanced session is a no-op"), __c.done(__c.cmp("advancing an already-advanced session is a no-op", (ses.advance(once, m, dice)), "===", (once))));
  // A move in the window before the advance keeps the latest board.
  sess = ses.play(sess, m, tut.place("copilot", 4, tut.engine("copilot")), dice);
  (__c.begin("a move made before the advance is kept"), __c.done(__c.cmp("a move made before the advance is kept", (sess.game.engines.copilot), "===", (4))));
  // A refused move reports the rules' message and leaves the board alone.
  const c = TUTORIALS.control;
  const c0 = ses.initSession(c);
  const refused = ses.play(c0, c, tut.place("copilot", 3, tut.axis("copilot")), tut.scriptedDice());
  (__c.begin("a refused move keeps the board and explains why"), __c.done(__c.cmp("a refused move keeps the board and explains why", (refused.game), "===", (c0.game)) && __c.cmp("a refused move keeps the board and explains why", (typeof refused.error), "===", ("string")) && __c.cmp("a refused move keeps the board and explains why", (refused.error.length), ">", (0))));
  // Real Time: the clock waits for the first move.
  const rt = TUTORIALS.realTime;
  const r0 = ses.initSession(rt);
  (__c.begin("Real Time: the clock is paused until the first move"), __c.done(__c.cmp("Real Time: the clock is paused until the first move", (r0.game.timerEndsAt), "===", (null)) && __c.cmp("Real Time: the clock is paused until the first move", (r0.game.timerRemainingMs), ">", (0))));
  const r1 = ses.play(r0, rt, tut.place("pilot", 3, tut.axis("pilot")), tut.scriptedDice(rt.script));
  (__c.begin("…and starts with it"), __c.done(__c.cmp("…and starts with it", (r1.game.timerEndsAt), "!==", (null)) && __c.cmp("…and starts with it", (r1.game.axis.pilot), "===", (3))));
});

test("2j) tutorial session: automatic moves and already-finished steps", async () => {
  const base = { id: "kerosene", title: "Synthetic", description: "", show: [], setup: () => tut.start({ pilot: [3, 4, 6, 6], copilot: [3, 4, 6, 6] }) };
  const withAuto = { ...base, steps: [{ text: "", auto: [tut.place("pilot", 3, tut.axis("pilot"))], solution: [], done: () => false }] };
  (__c.begin("step 1's automatic moves are played at the start"), __c.done(__c.cmp("step 1's automatic moves are played at the start", (ses.initSession(withAuto).game.axis.pilot), "===", (3))));
  const already = {
    ...base,
    steps: [
      { text: "", solution: [tut.place("pilot", 3, tut.axis("pilot"))], done: (s) => s.axis.pilot === 3 },
      { text: "", solution: [], done: (s) => s.axis.pilot === 3 },
    ],
  };
  const dice = tut.scriptedDice();
  const after1 = ses.advance(ses.play(ses.initSession(already), already, tut.place("pilot", 3, tut.axis("pilot")), dice), already, dice);
  (__c.begin("a step that's already complete when it starts is marked done"), __c.done(__c.cmp("a step that's already complete when it starts is marked done", (after1.stepIndex), "===", (1)) && __c.truthy("a step that's already complete when it starts is marked done", (after1.done))));
});

test("2k) tutorial session: Retry step, strict steps, the full-game tutorial", async () => {
  const d = tut.scriptedDice({ d6: [1, 2, 3] });
  d.d6();
  (__c.begin("scripted dice report how many values they've handed out"), __c.done(__c.cmp("scripted dice report how many values they've handed out", (JSON.stringify(d.used())), "===", (JSON.stringify({ d6: 1, traffic: 0 })))));
  (__c.begin("…and can restart from there"), __c.done(__c.cmp("…and can restart from there", (tut.scriptedDice({ d6: [1, 2, 3] }, d.used()).d6()), "===", (2))));

  const base = { id: "kerosene", title: "Synthetic", description: "", show: [], setup: () => tut.start({ pilot: [3, 4, 6, 6], copilot: [3, 4, 6, 6] }) };
  const loose = { ...base, steps: [{ text: "Axis", solution: [tut.place("pilot", 3, tut.axis("pilot"))], done: (s) => s.axis.pilot === 3 && s.axis.copilot === 3 }] };
  const dice = tut.scriptedDice();
  const s0 = ses.initSession(loose, dice);
  const s1 = ses.play(s0, loose, tut.place("pilot", 3, tut.axis("pilot")), dice);
  const back = ses.retry(s1, loose);
  (__c.begin("Retry step rewinds to where the step began"), __c.done(__c.cmp("Retry step rewinds to where the step began", (back.game), "===", (s0.game)) && __c.cmp("Retry step rewinds to where the step began", (back.stepIndex), "===", (0)) && __c.falsy("Retry step rewinds to where the step began", (back.done)) && __c.cmp("Retry step rewinds to where the step began", (back.error), "===", (null))));
  (__c.begin("…and remembers the dice used by then"), __c.done(__c.cmp("…and remembers the dice used by then", (JSON.stringify(back.diceAt)), "===", (JSON.stringify(s0.diceAt)))));

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
  (__c.begin("strict: a legal move that isn't the step's is refused with the step's hint"), __c.done(__c.cmp("strict: a legal move that isn't the step's is refused with the step's hint", (wrong.game), "===", (t0.game)) && __c.truthy("strict: a legal move that isn't the step's is refused with the step's hint", (wrong.error?.includes("Pilot: 6 on Concentration")))));
  const other = ses.play(t0, strict, tut.place("pilot", 6, tut.conc(1)), dice);
  (__c.begin("strict: the same die on another free Concentration space counts"), __c.done(__c.cmp("strict: the same die on another free Concentration space counts", (other.error), "===", (null)) && __c.cmp("strict: the same die on another free Concentration space counts", (other.game.coffee), "===", (1))));
  const skipped = ses.skip(other, strict, dice);
  (__c.begin("Next plays only the step's moves not yet made"), __c.done(__c.cmp("Next plays only the step's moves not yet made", (skipped.stepIndex), "===", (1)) && __c.cmp("Next plays only the step's moves not yet made", (skipped.game.coffee), "===", (2))));
  const info = ses.play(skipped, strict, tut.place("pilot", 3, tut.axis("pilot")), dice);
  (__c.begin("strict: no moves during a note"), __c.done(__c.cmp("strict: no moves during a note", (info.game), "===", (skipped.game)) && __c.cmp("strict: no moves during a note", (typeof info.error), "===", ("string"))));

  (__c.begin("the full-game tutorial is strict, on a copy of YUL"), __c.done(__c.cmp("the full-game tutorial is strict, on a copy of YUL", (BASICS.strict), "===", (true)) && __c.cmp("the full-game tutorial is strict, on a copy of YUL", (BASICS.setup().scenario.approachTrack.length), "===", (8))));
  (__c.begin("…with a chapter on every step"), __c.done(__c.truthy("…with a chapter on every step", (BASICS.steps.every((st) => typeof st.chapter === "string" && st.chapter.length > 0)))));
});

test("2l) tutorial session: is there progress to lose on close?", async () => {
  const t = TUTORIALS.kerosene;
  const dice = tut.scriptedDice(t.script);
  const s0 = ses.initSession(t, dice);
  (__c.begin("a fresh tutorial has nothing to lose"), __c.done(__c.falsy("a fresh tutorial has nothing to lose", (ses.hasProgress(s0, t)))));
  const s1 = ses.play(s0, t, tut.place("pilot", 2, { kind: "kerosene" }), dice);
  (__c.begin("a move on step 1 is progress"), __c.done(__c.truthy("a move on step 1 is progress", (ses.hasProgress(s1, t)))));
  const s2 = ses.skip(s0, t, dice);
  (__c.begin("a later step is progress"), __c.done(__c.truthy("a later step is progress", (ses.hasProgress(s2, t)))));
  let end = s0;
  for (let i = 0; i < t.steps.length; i++) end = ses.skip(end, t, dice);
  (__c.begin("a finished tutorial has nothing to lose"), __c.done(__c.cmp("a finished tutorial has nothing to lose", (end.stepIndex), "===", (t.steps.length)) && __c.falsy("a finished tutorial has nothing to lose", (ses.hasProgress(end, t)))));
});

test("2m) tutorial session: the Real-Time clock pauses while Leave is asked", async () => {
  const rt = TUTORIALS.realTime;
  const dice = tut.scriptedDice(rt.script);
  const running = ses.play(ses.initSession(rt, dice), rt, tut.place("pilot", 3, tut.axis("pilot")), dice);
  const left = running.game.timerEndsAt - 1000;
  const paused = ses.pauseClock(running, 1000);
  (__c.begin("pausing freezes the time left"), __c.done(__c.cmp("pausing freezes the time left", (paused.game.timerEndsAt), "===", (null)) && __c.cmp("pausing freezes the time left", (paused.game.timerRemainingMs), "===", (left))));
  const resumed = ses.resumeClock(paused, 50000);
  (__c.begin("resuming restarts it with that time left"), __c.done(__c.cmp("resuming restarts it with that time left", (resumed.game.timerEndsAt), "===", (50000 + left)) && __c.cmp("resuming restarts it with that time left", (resumed.game.timerRemainingMs), "===", (null))));
  (__c.begin("the step and its start are untouched"), __c.done(__c.cmp("the step and its start are untouched", (resumed.stepIndex), "===", (running.stepIndex)) && __c.cmp("the step and its start are untouched", (resumed.before), "===", (running.before))));
  const k = ses.initSession(TUTORIALS.kerosene);
  (__c.begin("with no clock running, pausing changes nothing"), __c.done(__c.cmp("with no clock running, pausing changes nothing", (ses.pauseClock(k, 1000)), "===", (k))));
});

// 3) CORS origin check -------------------------------------------------------
test("3) originChecker: wildcard, allowlist, missing origin", async () => {
  const any = originChecker("*");
  (__c.begin("* allows any origin"), __c.done(__c.truthy("* allows any origin", (any("http://192.168.1.50:5173"))) && __c.truthy("* allows any origin", (any("https://evil.example")))));
  const list = originChecker(" http://localhost:5173 , http://localhost:8080,");
  (__c.begin("allowlisted origin allowed (whitespace trimmed)"), __c.done(__c.truthy("allowlisted origin allowed (whitespace trimmed)", (list("http://localhost:5173"))) && __c.truthy("allowlisted origin allowed (whitespace trimmed)", (list("http://localhost:8080")))));
  (__c.begin("other origin rejected"), __c.done(__c.falsy("other origin rejected", (list("http://localhost:3000")))));
  (__c.begin("port matters"), __c.done(__c.falsy("port matters", (list("http://localhost")))));
  (__c.begin("no Origin header (curl) allowed"), __c.done(__c.truthy("no Origin header (curl) allowed", (list(undefined)))));
  (__c.begin("empty spec allows nothing with an Origin"), __c.done(__c.falsy("empty spec allows nothing with an Origin", (originChecker("")("http://localhost:5173")))));
});

// 3b) Production configuration ------------------------------------------------
test("3b) productionProblems: a production server refuses unsafe settings", async () => {
  const good = { NODE_ENV: "production", JWT_SECRET: "a".repeat(64), CLIENT_ORIGIN: "https://skyteam.example" };
  (__c.begin("a sound production config passes"), __c.done(__c.cmp("a sound production config passes", (productionProblems(good).length), "===", (0))));
  (__c.begin("outside production nothing is enforced"), __c.done(__c.cmp("outside production nothing is enforced", (productionProblems({}).length), "===", (0))));
  (__c.begin("a missing secret is refused"), __c.done(__c.cmp("a missing secret is refused", (productionProblems({ ...good, JWT_SECRET: undefined }).length), "===", (1))));
  (__c.begin("the dev default secret is refused"), __c.done(__c.cmp("the dev default secret is refused", (productionProblems({ ...good, JWT_SECRET: "dev-insecure-secret-change-me" }).length), "===", (1))));
  (__c.begin(".env.example's placeholder is refused"), __c.done(__c.cmp(".env.example's placeholder is refused", (productionProblems({ ...good, JWT_SECRET: "change-me-to-a-long-random-string" }).length), "===", (1))));
  (__c.begin("a short secret is refused"), __c.done(__c.cmp("a short secret is refused", (productionProblems({ ...good, JWT_SECRET: "x".repeat(31) }).length), "===", (1))));
  (__c.begin("a missing CLIENT_ORIGIN is refused"), __c.done(__c.cmp("a missing CLIENT_ORIGIN is refused", (productionProblems({ ...good, CLIENT_ORIGIN: undefined }).length), "===", (1))));
  (__c.begin("a wildcard CLIENT_ORIGIN is refused"), __c.done(__c.cmp("a wildcard CLIENT_ORIGIN is refused", (productionProblems({ ...good, CLIENT_ORIGIN: "https://a.example,*" }).length), "===", (1))));
});

// 3c) Identity tokens -----------------------------------------------------------
test("3c) verifyToken: only our own HS256 tokens", async () => {
  const { token, playerId } = issueToken();
  (__c.begin("a token we issued verifies"), __c.done(__c.cmp("a token we issued verifies", (verifyToken(token)), "===", (playerId))));
  const [, payload] = token.split(".");
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${payload}.`;
  (__c.begin("an unsigned (alg: none) token is refused"), __c.done(__c.cmp("an unsigned (alg: none) token is refused", (verifyToken(unsigned)), "===", (null))));
  (__c.begin("a tampered token is refused"), __c.done(__c.cmp("a tampered token is refused", (verifyToken(token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA"))), "===", (null))));
});

// 3d) Abuse: rate limits, guarded socket handlers, cache expiry ------------------
test("3d) rateLimiter, guard, evictExpired: abuse can't crash or bloat the server", async () => {
  let t = 0;
  const allow = rateLimiter(3, 1000, () => t);
  (__c.begin("hits within the limit are allowed"), __c.done(__c.truthy("hits within the limit are allowed", (allow("a"))) && __c.truthy("hits within the limit are allowed", (allow("a"))) && __c.truthy("hits within the limit are allowed", (allow("a")))));
  (__c.begin("the next hit in the window is refused"), __c.done(__c.falsy("the next hit in the window is refused", (allow("a")))));
  (__c.begin("keys are counted separately"), __c.done(__c.truthy("keys are counted separately", (allow("b")))));
  t = 1000;
  (__c.begin("a new window allows again"), __c.done(__c.truthy("a new window allows again", (allow("a")))));

  const acks = [];
  const quiet = console.error;
  console.error = () => {};
  const ok = guard(async (payload, ack) => ack({ ok: true, payload }), () => true, "test");
  await ok({ x: 1 }, (r) => acks.push(r));
  (__c.begin("a payload and its ack reach the handler"), __c.done(__c.cmp("a payload and its ack reach the handler", (acks.at(-1)?.payload?.x), "===", (1))));
  await ok((r) => acks.push(r));
  (__c.begin("an ack-only event (game:start) gets no payload"), __c.done(__c.cmp("an ack-only event (game:start) gets no payload", (acks.at(-1)?.ok), "===", (true)) && __c.cmp("an ack-only event (game:start) gets no payload", (acks.at(-1)?.payload), "===", (undefined))));
  let crashed = false;
  await ok().catch(() => (crashed = true));
  await ok({ x: 1 }).catch(() => (crashed = true));
  await ok({ x: 1 }, "not a function").catch(() => (crashed = true));
  (__c.begin("an event without an ack callback doesn't throw"), __c.done(__c.falsy("an event without an ack callback doesn't throw", (crashed))));
  const boom = guard(async () => { throw new Error("redis down"); }, () => true, "test");
  await boom({}, (r) => acks.push(r)).catch(() => (crashed = true));
  (__c.begin("a handler that throws is caught and answered"), __c.done(__c.falsy("a handler that throws is caught and answered", (crashed)) && __c.cmp("a handler that throws is caught and answered", (acks.at(-1)?.ok), "===", (false))));
  const down = { ok: false, error: "storage down", code: "unavailable" };
  const boomDown = guard(async () => { throw new Error("redis down"); }, () => true, "test", () => down);
  await boomDown({}, (r) => acks.push(r));
  (__c.begin("a failure is answered with what `failure` says (storage down)"), __c.done(__c.cmp("a failure is answered with what `failure` says (storage down)", (acks.at(-1)?.code), "===", ("unavailable"))));
  let ran = false;
  const limited = guard(async () => { ran = true; }, () => false, "test");
  await limited({}, (r) => acks.push(r));
  (__c.begin("an event over the rate limit is refused without running"), __c.done(__c.falsy("an event over the rate limit is refused without running", (ran)) && __c.cmp("an event over the rate limit is refused without running", (acks.at(-1)?.ok), "===", (false))));
  console.error = quiet;

  const cache = new Map([["old", { updatedAt: 0 }], ["new", { updatedAt: 50_000 }]]);
  evictExpired(cache, 70_000, 60_000);
  (__c.begin("a room past its TTL leaves the cache; a live one stays"), __c.done(__c.falsy("a room past its TTL leaves the cache; a live one stays", (cache.has("old"))) && __c.truthy("a room past its TTL leaves the cache; a live one stays", (cache.has("new")))));
});

// 3e) Loading a room once ---------------------------------------------------------
test("3e) singleFlight: requests loading the same room at once share one copy", async () => {
  let loads = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const load = singleFlight(async (id) => {
    loads += 1;
    await gate;
    return { id };
  });
  const both = Promise.all([load("r1"), load("r1")]);
  const other = load("r2");
  release();
  const [a, b] = await both;
  (__c.begin("two loads of one room at once read it once"), __c.done(__c.cmp("two loads of one room at once read it once", (loads), "===", (2)) && __c.cmp("two loads of one room at once read it once", (a), "===", (b))));
  (__c.begin("another room loads on its own"), __c.done(__c.cmp("another room loads on its own", ((await other).id), "===", ("r2"))));
  await load("r1");
  (__c.begin("once a load has finished, the next one reads again"), __c.done(__c.cmp("once a load has finished, the next one reads again", (loads), "===", (3))));
  const failing = singleFlight(async () => { throw new Error("redis down"); });
  const errors = await Promise.allSettled([failing("x"), failing("x")]);
  (__c.begin("a failed load fails every caller sharing it"), __c.done(__c.truthy("a failed load fails every caller sharing it", (errors.every((e) => e.status === "rejected")))));
  (__c.begin("…and isn't remembered"), __c.done(__c.cmp("…and isn't remembered", ((await failing("x").catch(() => "retried"))), "===", ("retried"))));
});

// 4) uuid --------------------------------------------------------------------
test("4) uuid(): native and getRandomValues fallback", async () => {
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  (__c.begin("native path yields a v4 uuid"), __c.done(__c.truthy("native path yields a v4 uuid", (V4.test(uuid())))));

  // Simulate a non-secure context (plain-HTTP LAN), where randomUUID is absent.
  const native = crypto.randomUUID;
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
  try {
    const ids = Array.from({ length: 200 }, uuid);
    (__c.begin("fallback yields v4 uuids"), __c.done(__c.truthy("fallback yields v4 uuids", (ids.every((id) => V4.test(id))))));
    (__c.begin("fallback ids are unique"), __c.done(__c.cmp("fallback ids are unique", (new Set(ids).size), "===", (ids.length))));
  } finally {
    Object.defineProperty(crypto, "randomUUID", { value: native, configurable: true, writable: true });
  }
});

test("5) Seating: who flies which seat; bot seats", async () => {
  const { seatCrews, crewOf, botSeat, unreadyOthers } = seating;
  const base = { id: "r", inviteCode: "i", hostPlayerId: "H", status: "lobby", observers: [], setup: DEFAULT_SETUP, version: 0, game: null, updatedAt: 0 };
  const seats = [{ playerId: "H", role: "host", ready: true, connected: true }, { playerId: "G", role: "guest", ready: true, connected: true }];
  (__c.begin("default: host flies Pilot"), __c.done(__c.cmp("default: host flies Pilot", (JSON.stringify(seatCrews({ ...base, seats }))), "===", (JSON.stringify({ pilotId: "H", copilotId: "G" })))));
  (__c.begin("hostCrew copilot: host flies Co-Pilot"), __c.done(__c.cmp("hostCrew copilot: host flies Co-Pilot", (JSON.stringify(seatCrews({ ...base, seats, hostCrew: "copilot" }))), "===", (JSON.stringify({ pilotId: "G", copilotId: "H" })))));
  (__c.begin("crewOf maps a player to the crew they fly"), __c.done(__c.cmp("crewOf maps a player to the crew they fly", (crewOf({ ...base, seats, hostCrew: "copilot" }, "H")), "===", ("copilot")) && __c.cmp("crewOf maps a player to the crew they fly", (crewOf({ ...base, seats }, "X")), "===", (null))));
  const solo = { ...base, hostCrew: "copilot", seats: [seats[0], { ...seats[1], playerId: "bot:1", bot: "aviator" }] };
  {
    const { SoloRoomRequest } = await import("../packages/shared/src/index.ts");
    const level = (body) => { const r = SoloRoomRequest.safeParse(body); return r.success ? r.data.level : "refused"; };
    (__c.begin("solo request: old levels (Cadet, Navigator) and none at all play Aviator; nonsense is refused"), __c.done(__c.cmp("solo request: old levels (Cadet, Navigator) and none at all play Aviator; nonsense is refused", (level({ crew: "pilot", level: "cadet" })), "===", ("aviator")) && __c.cmp("solo request: old levels (Cadet, Navigator) and none at all play Aviator; nonsense is refused", (level({ crew: "pilot", level: "navigator" })), "===", ("aviator")) && __c.cmp("solo request: old levels (Cadet, Navigator) and none at all play Aviator; nonsense is refused", (level({ crew: "pilot" })), "===", ("aviator")) && __c.cmp("solo request: old levels (Cadet, Navigator) and none at all play Aviator; nonsense is refused", (level({ crew: "pilot", level: "ace" })), "===", ("refused"))));
  }
  (__c.begin("bot seat found"), __c.done(__c.cmp("bot seat found", (botSeat(solo)?.bot), "===", ("aviator")) && __c.cmp("bot seat found", (botSeat({ ...base, seats })), "===", (null))));
  (__c.begin("a setup change keeps the bot ready"), __c.done(__c.cmp("a setup change keeps the bot ready", (unreadyOthers(solo.seats, "H").find((s) => s.bot).ready), "===", (true))));
  (__c.begin("…and un-readies the other humans"), __c.done(__c.cmp("…and un-readies the other humans", (unreadyOthers(seats, "H").find((s) => s.playerId === "G").ready), "===", (false))));
  (__c.begin("exit to lobby (keep nobody): humans un-ready, the bot stays ready"), __c.done(__c.cmp("exit to lobby (keep nobody): humans un-ready, the bot stays ready", (JSON.stringify(unreadyOthers(solo.seats, null).map((s) => s.ready))), "===", ("[false,true]"))));

  const { npcShouldAct } = seating;
  const { newGame, mulberry32 } = await import("../packages/shared/src/index.ts");
  const g = newGame(DEFAULT_SETUP, "bot:1", "H", mulberry32(5), 0); // bot flies Pilot; the Pilot leads round 1
  const playing = { ...solo, hostCrew: "copilot", status: "in_progress", game: g };
  (__c.begin("bot acts when the game waits on its crew"), __c.done(__c.cmp("bot acts when the game waits on its crew", (npcShouldAct(playing)?.crew), "===", ("pilot"))));
  (__c.begin("…not when it waits on the human"), __c.done(__c.cmp("…not when it waits on the human", (npcShouldAct({ ...playing, game: { ...g, turn: "copilot" } })), "===", (null))));
  (__c.begin("…not outside an in-progress game"), __c.done(__c.cmp("…not outside an in-progress game", (npcShouldAct({ ...playing, status: "finished" })), "===", (null))));
  (__c.begin("…not in rooms without a bot"), __c.done(__c.cmp("…not in rooms without a bot", (npcShouldAct({ ...playing, seats })), "===", (null))));
  (__c.begin("…not while a Real-Time clock is paused (every action is refused then)"), __c.done(__c.cmp("…not while a Real-Time clock is paused (every action is refused then)", (npcShouldAct({ ...playing, game: { ...g, timerRemainingMs: 30000 } })), "===", (null))));

  // Real-Time: past the deadline the round is over — the bot doesn't try a move
  // (it would only be refused as too late); the time-up wakes it if it leads next.
  (__c.begin("…not once a Real-Time deadline has passed"), __c.done(__c.cmp("…not once a Real-Time deadline has passed", (npcShouldAct({ ...playing, game: { ...g, timerEndsAt: Date.now() - 1 } })), "===", (null))));
  const { reduce: reduceRT, settle, randDice } = await import("../packages/shared/src/index.ts");
  const rt = newGame({ ...DEFAULT_SETUP, modules: ["realTime"] }, "H", "bot:1", mulberry32(8), Date.now()); // human Pilot leads round 1
  const mandatoryDown = { ...rt, axis: { pilot: 3, copilot: 3, offset: 0 }, engines: { pilot: 3, copilot: 3 } };
  const round2 = settle(reduceRT(mandatoryDown, { type: "timeUp" }, "").state, randDice(mulberry32(9)), Date.now);
  const rtRoom = { ...solo, hostCrew: "pilot", status: "in_progress", game: round2 };
  (__c.begin("after a time-up, the bot (Co-Pilot) leads round 2 and is woken"), __c.done(__c.cmp("after a time-up, the bot (Co-Pilot) leads round 2 and is woken", (round2.round), "===", (2)) && __c.cmp("after a time-up, the bot (Co-Pilot) leads round 2 and is woken", (round2.phase), "===", ("placement")) && __c.cmp("after a time-up, the bot (Co-Pilot) leads round 2 and is woken", (npcShouldAct(rtRoom)?.crew), "===", ("copilot"))));
  const { lobbyStatus, npcGivesUp, abandonsOnDisconnect } = seating;
  const readySolo = solo.seats.map((s) => ({ ...s, ready: true }));
  (__c.begin("solo: after a setup change both seats are still ready, so the room stays ready"), __c.done(__c.cmp("solo: after a setup change both seats are still ready, so the room stays ready", (lobbyStatus(unreadyOthers(readySolo, "H"))), "===", ("ready"))));
  (__c.begin("multiplayer: after a setup change the guest must ready up again"), __c.done(__c.cmp("multiplayer: after a setup change the guest must ready up again", (lobbyStatus(unreadyOthers(seats, "H"))), "===", ("lobby"))));
  (__c.begin("a lone host is never ready to start"), __c.done(__c.cmp("a lone host is never ready to start", (lobbyStatus([seats[0]])), "===", ("lobby"))));
  (__c.begin("a rejected bot move is retried a couple of times…"), __c.done(__c.falsy("a rejected bot move is retried a couple of times…", (npcGivesUp(1))) && __c.falsy("a rejected bot move is retried a couple of times…", (npcGivesUp(2)))));
  (__c.begin("…then the bot gives up instead of retrying forever"), __c.done(__c.truthy("…then the bot gives up instead of retrying forever", (npcGivesUp(3)))));
  (__c.begin("a solo game waits for its human (nobody else is waiting)"), __c.done(__c.falsy("a solo game waits for its human (nobody else is waiting)", (abandonsOnDisconnect(solo)))));
  (__c.begin("a multiplayer game is abandoned when a player doesn't return"), __c.done(__c.truthy("a multiplayer game is abandoned when a player doesn't return", (abandonsOnDisconnect({ ...base, seats })))));
});

test("5b) Player names: lobby-only, crew-qualified when the same", async () => {
  const n = (name) => SetNamePayload.safeParse({ name });
  (__c.begin("a name is trimmed and its spaces collapsed"), __c.done(__c.cmp("a name is trimmed and its spaces collapsed", (n("  Sky   Ace ").data?.name), "===", ("Sky Ace"))));
  (__c.begin("an empty name clears it"), __c.done(__c.cmp("an empty name clears it", (n("   ").data?.name), "===", (""))));
  (__c.begin("a name over 20 characters is refused"), __c.done(__c.falsy("a name over 20 characters is refused", (n("x".repeat(21)).success)) && __c.truthy("a name over 20 characters is refused", (n("x".repeat(20)).success))));
  (__c.begin("a non-string name is refused"), __c.done(__c.falsy("a non-string name is refused", (n(42).success))));
  (__c.begin("different names show as chosen"), __c.done(__c.cmp("different names show as chosen", (JSON.stringify(crewNames({ pilot: "Ann", copilot: "Bob" }))), "===", (JSON.stringify({ pilot: "Ann", copilot: "Bob" })))));
  const same = crewNames({ pilot: "Sam", copilot: "sam " });
  (__c.begin("the same name (any case) gets (Pilot) / (Co-Pilot)"), __c.done(__c.cmp("the same name (any case) gets (Pilot) / (Co-Pilot)", (same.pilot), "===", ("Sam (Pilot)")) && __c.cmp("the same name (any case) gets (Pilot) / (Co-Pilot)", (same.copilot), "===", ("sam (Co-Pilot)"))));
  const one = crewNames({ pilot: "Sam", copilot: undefined });
  (__c.begin("a crew without a name is null"), __c.done(__c.cmp("a crew without a name is null", (one.pilot), "===", ("Sam")) && __c.cmp("a crew without a name is null", (one.copilot), "===", (null))));
  (__c.begin("two unnamed crews aren't suffixed"), __c.done(__c.cmp("two unnamed crews aren't suffixed", (JSON.stringify(crewNames({ pilot: "", copilot: undefined }))), "===", (JSON.stringify({ pilot: null, copilot: null })))));

  const { canRename } = seating;
  (__c.begin("renaming is allowed in the lobby"), __c.done(__c.truthy("renaming is allowed in the lobby", (canRename({ status: "lobby" }))) && __c.truthy("renaming is allowed in the lobby", (canRename({ status: "ready" })))));
  (__c.begin("…but not in a game"), __c.done(__c.falsy("…but not in a game", (canRename({ status: "in_progress" }))) && __c.falsy("…but not in a game", (canRename({ status: "finished" }))) && __c.falsy("…but not in a game", (canRename({ status: "abandoned" })))));

  const room = {
    id: "r", inviteCode: "i", hostPlayerId: P, status: "lobby", hostCrew: "pilot", observers: [], setup: DEFAULT_SETUP, version: 0, game: null, updatedAt: 0,
    seats: [
      { playerId: P, role: "host", ready: false, connected: true, name: "Sam" },
      { playerId: C, role: "guest", ready: false, connected: true },
    ],
  };
  const snap = toSnapshot(room, C);
  (__c.begin("the snapshot carries each seat's name"), __c.done(__c.cmp("the snapshot carries each seat's name", (snap.seats[0].name), "===", ("Sam")) && __c.falsy("the snapshot carries each seat's name", (("name" in snap.seats[1])))));
});

test("6) think(): Aviator in a worker, with a fallback", async () => {
  const { think, warmThinking, stopThinking, thinkStats, setPoolSizeForTests, searchWorkers } = await import("../packages/server/src/think.ts");
  setPoolSizeForTests(4); // the pool tests need several workers, whatever this machine's cores
  const { newGame, mulberry32, redactGameStateFor, legalMoves } = await import("../packages/shared/src/index.ts");
  const g = newGame(DEFAULT_SETUP, "P", "C", mulberry32(9), 0);
  const view = redactGameStateFor(g, "P");
  // Legal = the rules accept it (the same move can be spelled differently, e.g. a target with or without its side).
  const { applyIntent: apply } = await import("../packages/shared/src/index.ts");
  const legal = (m) => { try { return !!m && !!apply(g, m, "P", mulberry32(1), () => 0); } catch { return false; } };
  await warmThinking(); // the worker takes a few seconds to load
  (__c.begin("once warm, every search worker reports ready (for /health)"), __c.done(__c.cmp("once warm, every search worker reports ready (for /health)", (JSON.stringify(searchWorkers())), "===", (JSON.stringify({ ready: 4, of: 4 })))));
  const t0 = Date.now();
  const m = await think(view, "pilot", 1);
  (__c.begin("Aviator answers through the worker within its budget"), __c.done(__c.cmp("Aviator answers through the worker within its budget", (Date.now() - t0), "<", (2000)) && __c.truthy("Aviator answers through the worker within its budget", (legal(m))) && __c.cmp("Aviator answers through the worker within its budget", (thinkStats.worker), "===", (1)) && __c.cmp("Aviator answers through the worker within its budget", (thinkStats.fallback), "===", (0))));
  (__c.begin("a worker failure falls back to the quick strategy"), __c.done(__c.truthy("a worker failure falls back to the quick strategy", (legal(await think(view, "pilot", 1, { simulateWorkerError: true })))) && __c.cmp("a worker failure falls back to the quick strategy", (thinkStats.fallback), "===", (1))));
  // The real failure paths, through the worker:
  const { crashWorkerForTest } = await import("../packages/server/src/think.ts");
  const before = thinkStats.fallback;
  crashWorkerForTest(); // the worker handles this first, then dies with the request below pending
  const during = think(view, "pilot", 4);
  (__c.begin("a worker crash mid-request falls back to the quick strategy"), __c.done(__c.truthy("a worker crash mid-request falls back to the quick strategy", (legal(await during))) && __c.cmp("a worker crash mid-request falls back to the quick strategy", (thinkStats.fallback), "===", (before + 1))));
  await warmThinking(); // a crashed worker is replaced by a fresh one
  const w0 = thinkStats.worker;
  (__c.begin("…and the next Aviator move comes from a fresh worker"), __c.done(__c.truthy("…and the next Aviator move comes from a fresh worker", (legal(await think(view, "pilot", 5)))) && __c.cmp("…and the next Aviator move comes from a fresh worker", (thinkStats.worker), "===", (w0 + 1))));
  const f0 = thinkStats.fallback;
  (__c.begin("a timed-out request falls back to the quick strategy"), __c.done(__c.truthy("a timed-out request falls back to the quick strategy", (legal(await think(view, "pilot", 6, { timeoutMs: 1 })))) && __c.cmp("a timed-out request falls back to the quick strategy", (thinkStats.fallback), "===", (f0 + 1))));
  // Step 5: a pool — two Aviator rooms thinking at once are both answered by workers.
  await warmThinking();
  // One decision with idle workers searches on all of them at once, and merges.
  await warmThinking();
  const wP = thinkStats.worker;
  const par = await think(view, "pilot", 31);
  (__c.begin("with idle workers, one Aviator decision searches on several at once"), __c.done(__c.truthy("with idle workers, one Aviator decision searches on several at once", (legal(par))) && __c.cmp("with idle workers, one Aviator decision searches on several at once", (thinkStats.lastWorkers), ">=", (2)) && __c.cmp("with idle workers, one Aviator decision searches on several at once", (thinkStats.worker), "===", (wP + 1))));
  const w3 = thinkStats.worker, fb3 = thinkStats.fallback;
  // Generous time limits: the queued third room waits for a whole search first.
  const three = await Promise.all([21, 22, 23].map((seed) => think(view, "pilot", seed, { timeoutMs: 3000 })));
  (__c.begin("three rooms thinking at once are all answered by search workers (one worker would time out the third)"), __c.done(__c.truthy("three rooms thinking at once are all answered by search workers (one worker would time out the third)", (three.every(legal))) && __c.cmp("three rooms thinking at once are all answered by search workers (one worker would time out the third)", (thinkStats.worker), "===", (w3 + 3)) && __c.cmp("three rooms thinking at once are all answered by search workers (one worker would time out the third)", (thinkStats.fallback), "===", (fb3))));
  let crashed = false;
  const none = await think(null, "pilot", 7).catch(() => (crashed = true));
  (__c.begin("a bot that fails outright resolves null (the room gives up) instead of crashing the server"), __c.done(__c.falsy("a bot that fails outright resolves null (the room gives up) instead of crashing the server", (crashed)) && __c.cmp("a bot that fails outright resolves null (the room gives up) instead of crashing the server", (none), "===", (null))));
  await stopThinking(); // let the test process exit
});

test("Solo play: the bot flies green and yellow cards only", async () => {
  const { soloAllowed, SOLO_RESTRICTED_NOTE, SCENARIO_TEMPLATES } = await import("../packages/shared/src/index.ts");
  const ids = (d) => SCENARIO_TEMPLATES.filter((t) => t.difficulty === d).map((t) => (t.id === "green-YUL" ? "YUL" : t.id));
  (__c.begin("green and yellow cards can be flown with the bot"), __c.done(__c.truthy("green and yellow cards can be flown with the bot", ([...ids("green"), ...ids("yellow")].every(soloAllowed)))));
  (__c.begin("red and black cards can't"), __c.done(__c.truthy("red and black cards can't", ([...ids("red"), ...ids("black")].every((id) => !soloAllowed(id))))));
  (__c.begin("the restriction comes with its notice"), __c.done(__c.cmp("the restriction comes with its notice", (typeof SOLO_RESTRICTED_NOTE), "===", ("string")) && __c.cmp("the restriction comes with its notice", (SOLO_RESTRICTED_NOTE.length), ">", (40))));
});
