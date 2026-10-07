// Converted from scripts/test-rules.mjs by the Vitest codemod: each section is a test,
// each check(label, cond) a set of assertion helpers with the same verdict (see support/checks.mjs).
import { expect, test } from "vitest";
import * as __c from "./support/checks.mjs";
// Deterministic unit tests for the SkyTeam rules reducer (pure, no server).
// Run with `npm test` (inside a node:22 container, repo bind-mounted).
// Imported from source via tsx (the dist build uses extensionless ESM imports
// that bare `node` can't resolve).
import {
  ABILITY_IDS,
  DEFAULT_MAX_ABILITIES,
  EXCLUSIVE_MODULE_GROUPS,
  IMPLEMENTED_MODULES,
  APPROACH_TRACKS,
  SCENARIOS,
  REAL_TIME_SECONDS,
  SetSetupPayload,
  WIND_RING,
  createInitialGameState,
  reduce,
} from "../packages/shared/src/index.ts";


const P = "P";

const C = "C";


// Drive helpers -------------------------------------------------------------
// Every roll carries the server's clock (Real-Time starts its countdown from it).
const ROLL_AT = 1_000_000;

// `traffic`: the Traffic die results the round needs (one per icon on the Current Position).
const roll = (s, pilot, copilot, traffic) => reduce(s, { type: "roll", pilot, copilot, at: ROLL_AT, ...(traffic && { traffic }) }, "").state;

function place(s, who, value, target, coffeeDelta) {
  const crew = who === P ? "pilot" : "copilot";
  const die = s.dice[crew].find((d) => !d.placed && d.value === value);
  if (!die) throw new Error(`no unplaced ${value} for ${crew} [${s.dice[crew].map((d) => d.value)}]`);
  return reduce(s, { type: "placeDie", dieId: die.id, target, coffeeDelta }, who).state;
}

const reroll = (s, who, dieIds, values) => reduce(s, { type: "reroll", dieIds, values }, who).state;

// Fresh game in the "rolling" phase; each test rolls its own controlled dice.
const init = (scenario) => createInitialGameState(scenario, P, C);


const scn = (over) => ({
  name: "TEST",
  approachTrack: [{ traffic: 0 }, { traffic: 0, airport: true }],
  rounds: 3,
  startAltitudeFeet: 8000,
  feetPerRound: 1000,
  rerollRounds: [],
  axisSpinAt: 5,
  aeroBlueStart: 4,
  aeroOrangeStart: 8,
  ...over,
});


// Shared driver for the remaining sections: play one full round with the given
// Axis/Engine values; every crew's two spare dice (6s) go on harmless spaces
// (Radio past the end of the track, Concentration).
function playRound(s, { pilot, copilot, traffic }) {
  s = roll(s, [pilot[0], pilot[1], 6, 6], [copilot[0], copilot[1], 6, 6], traffic);
  const moves = {
    [P]: [[pilot[0], { kind: "axis" }], [pilot[1], { kind: "engine" }], [6, { kind: "radio", slot: 0 }], [6, { kind: "concentration", slot: 0 }]],
    [C]: [[copilot[0], { kind: "axis" }], [copilot[1], { kind: "engine" }], [6, { kind: "radio", slot: 0 }], [6, { kind: "radio", slot: 1 }]],
  };
  let who = s.turn === "pilot" ? P : C;
  for (let i = 0; i < 8 && s.phase === "placement"; i++) {
    const [value, target] = moves[who].shift();
    s = place(s, who, value, target);
    who = who === P ? C : P;
  }
  return s;
}


// A one-round game already on the airport with every switch deployed and the
// first brake (2) set, so each landing test can break exactly one condition.
function readyToLand(mutate = () => {}) {
  const s = init(scn({ rounds: 1, approachTrack: [{ traffic: 0 }, { traffic: 0, airport: true }] }));
  s.position = 1;
  s.gearGreen = s.gearGreen.map(() => true);
  s.flapsGreen = s.flapsGreen.map(() => true);
  s.brakesDeployed = 1;
  mutate(s);
  return s;
}

const level = (speedP, speedC) => ({ pilot: [3, speedP], copilot: [3, speedC] });

const lostFor = (s, re) => s.phase === "lost" && re.test(s.outcome?.reason ?? "");

// 1) Full game to a successful landing --------------------------------------
test("1) Full winning game (3 rounds, deploy everything, level, brake)", async () => {
  let s = createInitialGameState(scn(), P, C);
  // Round 1 (pilot leads): advance onto airport, deploy gear0/1 + flaps0/1.
  s = roll(s, [2, 4, 1, 3], [2, 4, 1, 2]);
  s = place(s, P, 1, { kind: "landingGear", slot: 0 });
  s = place(s, C, 1, { kind: "flaps", slot: 0 });
  s = place(s, P, 2, { kind: "axis" });
  s = place(s, C, 2, { kind: "axis" });
  s = place(s, P, 4, { kind: "engine" });
  s = place(s, C, 4, { kind: "engine" }); // sum 8 -> +1 -> airport
  s = place(s, P, 3, { kind: "landingGear", slot: 1 });
  s = place(s, C, 2, { kind: "flaps", slot: 1 });
  (__c.begin("after R1 on airport"), __c.done(__c.cmp("after R1 on airport", (s.position), "===", (1))));
  (__c.begin("after R1 round advanced to 2"), __c.done(__c.cmp("after R1 round advanced to 2", (s.round), "===", (2)) && __c.cmp("after R1 round advanced to 2", (s.phase), "===", ("rolling"))));
  (__c.begin("aeroBlue rose with 2 gear"), __c.done(__c.cmp("aeroBlue rose with 2 gear", (s.aeroBlue), "===", (6))));

  // Round 2 (copilot leads): hold (advance 0), deploy gear2 + brake, flaps2/3.
  s = roll(s, [3, 1, 5, 2], [3, 1, 3, 4]);
  s = place(s, C, 3, { kind: "flaps", slot: 2 });
  s = place(s, P, 5, { kind: "landingGear", slot: 2 });
  s = place(s, C, 3, { kind: "axis" });
  s = place(s, P, 3, { kind: "axis" });
  s = place(s, C, 1, { kind: "engine" });
  s = place(s, P, 1, { kind: "engine" }); // sum 2 -> hold
  s = place(s, C, 4, { kind: "flaps", slot: 3 });
  s = place(s, P, 2, { kind: "brakes", slot: 0 });
  (__c.begin("after R2 still on airport (held)"), __c.done(__c.cmp("after R2 still on airport (held)", (s.position), "===", (1))));
  (__c.begin("all gear green"), __c.done(__c.truthy("all gear green", (s.gearGreen.every(Boolean)))));
  (__c.begin("all flaps green"), __c.done(__c.truthy("all flaps green", (s.flapsGreen.every(Boolean)))));
  (__c.begin("brake deployed"), __c.done(__c.cmp("brake deployed", (s.brakesDeployed), "===", (1))));
  (__c.begin("axis level"), __c.done(__c.cmp("axis level", (s.axis.offset), "===", (0))));
  (__c.begin("round is now final (3)"), __c.done(__c.cmp("round is now final (3)", (s.round), "===", (3))));

  // Round 3 (final, pilot leads): level axis, speed 2 <= brake 2, dump extras.
  s = roll(s, [5, 1, 6, 6], [5, 1, 6, 6]);
  s = place(s, P, 5, { kind: "axis" });
  s = place(s, C, 5, { kind: "axis" });
  s = place(s, P, 1, { kind: "engine" });
  s = place(s, C, 1, { kind: "engine" }); // final speed 2, no move
  s = place(s, P, 6, { kind: "radio", slot: 0 });
  s = place(s, C, 6, { kind: "radio", slot: 0 });
  s = place(s, P, 6, { kind: "concentration", slot: 0 });
  s = place(s, C, 6, { kind: "concentration", slot: 1 });
  (__c.begin("game won"), __c.done(__c.cmp("game won", (s.phase), "===", ("won")) && __c.cmp("game won", (s.outcome?.result), "===", ("won"))));
});

// 2) Spin loss --------------------------------------------------------------
test("2) Axis spin loss (difference reaches the spin threshold)", async () => {
  let s = init(scn());
  s = roll(s, [6, 1, 1, 1], [1, 1, 1, 1]);
  s = place(s, P, 6, { kind: "axis" });
  s = place(s, C, 1, { kind: "axis" }); // diff 5 == spinAt
  (__c.begin("spin -> lost"), __c.done(__c.cmp("spin -> lost", (s.phase), "===", ("lost")) && __c.matches("spin -> lost", /spin/i, (s.outcome?.reason ?? ""))));
});

// 3) Engine thresholds: 0 / 1 / 2 spaces ------------------------------------
test("3) Engine speed thresholds", async () => {
  const longScn = scn({ approachTrack: [{ traffic: 0 }, { traffic: 0 }, { traffic: 0 }, { traffic: 0, airport: true }], rounds: 7 });
  const advanceWith = (pe, ce) => {
    let s = init(longScn);
    s = roll(s, [pe, 1, 1, 1], [ce, 1, 1, 1]);
    s = place(s, P, pe, { kind: "engine" });
    s = place(s, C, ce, { kind: "engine" });
    return s.position;
  };
  (__c.begin("sum 4 -> advance 0"), __c.done(__c.cmp("sum 4 -> advance 0", (advanceWith(2, 2)), "===", (0))));
  (__c.begin("sum 5 -> advance 1"), __c.done(__c.cmp("sum 5 -> advance 1", (advanceWith(2, 3)), "===", (1))));
  (__c.begin("sum 9 -> advance 2"), __c.done(__c.cmp("sum 9 -> advance 2", (advanceWith(4, 5)), "===", (2))));
});

// 4) Collision: leaving or flying through traffic (but NOT landing on it) -----
test("4) Collision: leaving/through traffic loses; landing on it is safe", async () => {
  // Traffic on the intermediate space (1); advancing 2 flies *through* it.
  const through = scn({ approachTrack: [{ traffic: 0 }, { traffic: 1 }, { traffic: 0 }, { traffic: 0, airport: true }], rounds: 7 });
  let s = init(through);
  s = roll(s, [5, 1, 1, 1], [4, 1, 1, 1]);
  s = place(s, P, 5, { kind: "engine" });
  s = place(s, C, 4, { kind: "engine" }); // sum 9 -> advance 2, through space 1
  (__c.begin("flying through traffic -> lost"), __c.done(__c.cmp("flying through traffic -> lost", (s.phase), "===", ("lost")) && __c.matches("flying through traffic -> lost", /collision/i, (s.outcome?.reason ?? ""))));

  // Plane starts on a traffic space (0); moving off it at all collides.
  const from = scn({ approachTrack: [{ traffic: 1 }, { traffic: 0 }, { traffic: 0, airport: true }], rounds: 7 });
  let f = init(from);
  f = roll(f, [3, 1, 1, 1], [2, 1, 1, 1]);
  f = place(f, P, 3, { kind: "engine" });
  f = place(f, C, 2, { kind: "engine" }); // sum 5 -> advance 1 off the occupied space 0
  (__c.begin("leaving an occupied space -> lost"), __c.done(__c.cmp("leaving an occupied space -> lost", (f.phase), "===", ("lost")) && __c.matches("leaving an occupied space -> lost", /collision/i, (f.outcome?.reason ?? ""))));

  // Traffic on the landing space (1); advancing 1 lands on it — this is SAFE.
  const onto = scn({ approachTrack: [{ traffic: 0 }, { traffic: 1 }, { traffic: 0, airport: true }], rounds: 7 });
  let t = init(onto);
  t = roll(t, [3, 1, 1, 1], [2, 1, 1, 1]);
  t = place(t, P, 3, { kind: "engine" });
  t = place(t, C, 2, { kind: "engine" }); // sum 5 -> advance 1 onto space 1
  (__c.begin("landing on traffic -> safe"), __c.done(__c.cmp("landing on traffic -> safe", (t.phase), "!==", ("lost")) && __c.cmp("landing on traffic -> safe", (t.position), "===", (1))));
});

// 5) Overshoot loss ---------------------------------------------------------
test("5) Overshoot: advancing while already on the airport", async () => {
  let s = init(scn({ rounds: 7 }));
  // R1: reach airport (+1) and fill the round legally.
  s = roll(s, [4, 2, 1, 1], [4, 2, 1, 1]);
  s = place(s, P, 4, { kind: "engine" });
  s = place(s, C, 4, { kind: "engine" }); // +1 -> airport
  s = place(s, P, 2, { kind: "axis" });
  s = place(s, C, 2, { kind: "axis" });
  s = place(s, P, 1, { kind: "radio", slot: 0 });
  s = place(s, C, 1, { kind: "radio", slot: 0 });
  s = place(s, P, 1, { kind: "concentration", slot: 0 });
  s = place(s, C, 1, { kind: "concentration", slot: 1 });
  (__c.begin("reached airport in R1"), __c.done(__c.cmp("reached airport in R1", (s.position), "===", (1)) && __c.cmp("reached airport in R1", (s.round), "===", (2))));
  // R2 (copilot leads): advancing again overshoots.
  s = roll(s, [4, 1, 1, 1], [4, 1, 1, 1]);
  s = place(s, C, 4, { kind: "engine" });
  s = place(s, P, 4, { kind: "engine" });
  (__c.begin("overshoot -> lost"), __c.done(__c.cmp("overshoot -> lost", (s.phase), "===", ("lost")) && __c.matches("overshoot -> lost", /overshot/i, (s.outcome?.reason ?? ""))));
});

// 6) Mandatory Axis/Engine reservation --------------------------------------
// The reducer refuses any placement that would strand an open Axis/Engine spot,
// so the end-of-round "mandatory missing" loss can't be reached by legal play.
test("6) Mandatory reservation: last dice must go on the Axis and Engine", async () => {
  let s = init(scn({ rounds: 7 }));
  s = roll(s, [1, 2, 1, 5], [1, 1, 2, 3]);
  s = place(s, P, 1, { kind: "axis" });
  s = place(s, C, 1, { kind: "axis" });
  s = place(s, P, 2, { kind: "landingGear", slot: 0 }); // 1/2
  s = place(s, C, 1, { kind: "flaps", slot: 0 }); // 1/2
  s = place(s, P, 1, { kind: "radio", slot: 0 });
  s = place(s, C, 2, { kind: "flaps", slot: 1 }); // 2/3
  // Pilot holds one die with the Engine still open: it must go on the Engine.
  __c.throws("non-mandatory placement that strands the Engine rejected", () =>
    place(s, P, 5, { kind: "landingGear", slot: 2 }));
  s = place(s, P, 5, { kind: "engine" });
  (__c.begin("engine placement still allowed"), __c.done(__c.cmp("engine placement still allowed", (s.engines.pilot), "===", (5))));
});

// 7) Radio clears the correct space -----------------------------------------
test("7) Radio clears the airplane N-1 spaces ahead", async () => {
  const s0 = scn({ approachTrack: [{ traffic: 0 }, { traffic: 1 }, { traffic: 0, airport: true }], rounds: 7 });
  let s = init(s0);
  s = roll(s, [2, 1, 1, 1], [1, 1, 1, 1]);
  s = place(s, P, 2, { kind: "radio", slot: 0 }); // value 2 -> space 0+1 = 1
  (__c.begin("airplane on space 1 cleared"), __c.done(__c.cmp("airplane on space 1 cleared", (s.airplanes[1]), "===", (0))));
});

// 8) Coffee modifies a die's value ------------------------------------------
test("8) Concentration grants Coffee; Coffee shifts a placed die's value", async () => {
  let s = init(scn({ rounds: 7 }));
  s = roll(s, [3, 1, 1, 1], [1, 1, 1, 1]);
  s = place(s, P, 3, { kind: "concentration", slot: 0 });
  (__c.begin("gained a coffee"), __c.done(__c.cmp("gained a coffee", (s.coffee), "===", (1))));
  // Co-Pilot turn now; give them a die we shift. Re-roll not needed; use C's 1
  // as flaps slot0 needs 1/2 — shift a 1 up to 2 is pointless; instead shift a
  // value 1 die into flaps via +1 is unnecessary. Test the clamp + spend:
  __c.throws("coffee cannot exceed 1-6", () => place(s, C, 1, { kind: "flaps", slot: 0 }, -1));
  const s2 = place(s, C, 1, { kind: "flaps", slot: 0 }, 1); // 1 -> 2, still valid for 1/2
  (__c.begin("coffee spent"), __c.done(__c.cmp("coffee spent", (s2.coffee), "===", (0))));
});

// 9) Reroll consumes a token and changes dice -------------------------------
test("9) Reroll token (granted on rerollRounds) replaces dice", async () => {
  let s = createInitialGameState(scn({ rerollRounds: [1] }), P, C);
  s = roll(s, [1, 1, 1, 1], [6, 6, 6, 6]);
  (__c.begin("token granted on round 1"), __c.done(__c.cmp("token granted on round 1", (s.rerollTokens), "===", (1))));
  const newVals = [3, 4];
  const ids = [0, 1];
  s = reduce(s, { type: "reroll", dieIds: ids, values: newVals }, P).state;
  (__c.begin("token consumed"), __c.done(__c.cmp("token consumed", (s.rerollTokens), "===", (0))));
  (__c.begin("pilot dice rerolled"), __c.done(__c.cmp("pilot dice rerolled", (s.dice.pilot[0].value), "===", (3)) && __c.cmp("pilot dice rerolled", (s.dice.pilot[1].value), "===", (4))));
});

// 10) Deploy-order enforcement ----------------------------------------------
test("10) Flaps/Brakes must deploy in order", async () => {
  let s = init(scn({ rounds: 7 }));
  s = roll(s, [2, 1, 1, 1], [3, 1, 1, 1]);
  // Pilot to act first; brakes slot 1 (a 4) before slot 0 is illegal.
  __c.throws("brake out of order rejected", () => place(s, P, 4, { kind: "brakes", slot: 1 }));
  // Co-Pilot flaps slot 1 before slot 0 is illegal (after a pilot move).
  let s2 = place(s, P, 1, { kind: "axis" });
  __c.throws("flaps out of order rejected", () => place(s2, C, 3, { kind: "flaps", slot: 1 }));
});

// 11) A switch that's already on takes a matching die later, with no effect ----
test("11) An already-on switch takes a matching die (no effect); the numbers still apply", async () => {
  let s = init(scn({ rounds: 7 }));
  // R1 (pilot leads): deploy gear0 + flaps0, fill the rest legally to end the round.
  s = roll(s, [1, 4, 1, 4], [1, 4, 1, 4]);
  s = place(s, P, 1, { kind: "landingGear", slot: 0 }); // 1/2
  s = place(s, C, 1, { kind: "flaps", slot: 0 }); // 1/2
  s = place(s, P, 4, { kind: "axis" });
  s = place(s, C, 4, { kind: "axis" });
  s = place(s, P, 1, { kind: "engine" });
  s = place(s, C, 1, { kind: "engine" }); // sum 2 -> hold
  s = place(s, P, 4, { kind: "radio", slot: 0 });
  s = place(s, C, 4, { kind: "concentration", slot: 0 }); // 8th die -> round ends
  (__c.begin("gear/flaps 0 deployed; round advanced"), __c.done(__c.truthy("gear/flaps 0 deployed; round advanced", (s.gearGreen[0])) && __c.truthy("gear/flaps 0 deployed; round advanced", (s.flapsGreen[0])) && __c.cmp("gear/flaps 0 deployed; round advanced", (s.round), "===", (2)) && __c.cmp("gear/flaps 0 deployed; round advanced", (s.phase), "===", ("rolling"))));
  // R2 (copilot leads): the per-round spaces are free again; the switches stay on.
  s = roll(s, [3, 2, 1, 1], [2, 1, 1, 1]);
  const orange = s.aeroOrange;
  s = place(s, C, 2, { kind: "flaps", slot: 0 }); // already on: allowed, no effect
  (__c.begin("an already-on Flaps takes a matching die, with no effect"), __c.done(__c.cmp("an already-on Flaps takes a matching die, with no effect", (s.flapSlots[0]), "===", (2)) && __c.cmp("an already-on Flaps takes a matching die, with no effect", (s.aeroOrange), "===", (orange)) && __c.cmp("an already-on Flaps takes a matching die, with no effect", (s.flapsGreen.filter(Boolean).length), "===", (1))));
  (__c.begin("…and says so in the log"), __c.done(__c.matches("…and says so in the log", /no effect/i, (s.log.at(-1)))));
  __c.throws("an already-on Landing Gear still needs its numbers (1/2, not 3)", () => place(s, P, 3, { kind: "landingGear", slot: 0 }));
  const blue = s.aeroBlue;
  s = place(s, P, 2, { kind: "landingGear", slot: 0 });
  (__c.begin("an already-on Landing Gear takes a matching die, with no effect"), __c.done(__c.cmp("an already-on Landing Gear takes a matching die, with no effect", (s.gearSlots[0]), "===", (2)) && __c.cmp("an already-on Landing Gear takes a matching die, with no effect", (s.aeroBlue), "===", (blue))));
  __c.throws("one die per switch per round", () => place(s, C, 1, { kind: "flaps", slot: 0 }));
  // Brakes: one that's on takes its value again; the next ones stay in order.
  let b = roll(init(scn({ rounds: 7 })), [2, 4, 1, 1], [1, 1, 1, 1]);
  b.brakesDeployed = 1;
  b = place(b, P, 2, { kind: "brakes", slot: 0 });
  (__c.begin("an already-on Brakes takes its value, with no effect"), __c.done(__c.truthy("an already-on Brakes takes its value, with no effect", (b.brakeSlots[0])) && __c.cmp("an already-on Brakes takes its value, with no effect", (b.brakesDeployed), "===", (1))));
  b = place(b, C, 1, { kind: "axis" });
  __c.throws("Brakes past the next one are still out of order", () => place(b, P, 4, { kind: "brakes", slot: 2 }));
});

// 12) Joint reroll: active player initiates, the other player then responds ---
test("12) Joint reroll: one token, initiator picks dice, the other player responds", async () => {
  // a/b) initiator rerolls >=1 -> token spent + pending set; responder rerolls a
  //      subset -> pending cleared, turn order untouched.
  let s = init(scn({ rerollRounds: [1], rounds: 7 }));
  s = roll(s, [2, 2, 2, 2], [3, 3, 3, 3]); // round 1: pilot is the active player, 1 token granted
  (__c.begin("token granted on the reroll round"), __c.done(__c.cmp("token granted on the reroll round", (s.rerollTokens), "===", (1))));
  const pIds = s.dice.pilot.map((d) => d.id);
  s = reroll(s, P, [pIds[0], pIds[1]], [5, 6]); // pilot initiates on two of their dice
  (__c.begin("initiator's chosen dice rerolled"), __c.done(__c.cmp("initiator's chosen dice rerolled", (s.dice.pilot[0].value), "===", (5)) && __c.cmp("initiator's chosen dice rerolled", (s.dice.pilot[1].value), "===", (6))));
  (__c.begin("one token spent for the whole joint event"), __c.done(__c.cmp("one token spent for the whole joint event", (s.rerollTokens), "===", (0))));
  (__c.begin("now awaiting the co-pilot's reroll"), __c.done(__c.cmp("now awaiting the co-pilot's reroll", (s.pendingReroll), "===", ("copilot"))));
  const cIds = s.dice.copilot.map((d) => d.id);
  s = reroll(s, C, [cIds[0]], [1]); // responder rerolls one of their own
  (__c.begin("responder's chosen die rerolled"), __c.done(__c.cmp("responder's chosen die rerolled", (s.dice.copilot[0].value), "===", (1))));
  (__c.begin("reroll fully resolved"), __c.done(__c.cmp("reroll fully resolved", (s.pendingReroll), "===", (null))));
  (__c.begin("turn order unchanged by the reroll"), __c.done(__c.cmp("turn order unchanged by the reroll", (s.turn), "===", ("pilot"))));

  // c) the responder may decline by rerolling zero dice.
  let s2 = init(scn({ rerollRounds: [1], rounds: 7 }));
  s2 = roll(s2, [2, 2, 2, 2], [3, 3, 3, 3]);
  s2 = reroll(s2, P, [s2.dice.pilot[0].id], [6]);
  const before = JSON.stringify(s2.dice.copilot.map((d) => d.value));
  s2 = reroll(s2, C, [], []); // decline
  (__c.begin("responder declining clears the pending reroll"), __c.done(__c.cmp("responder declining clears the pending reroll", (s2.pendingReroll), "===", (null))));
  (__c.begin("declining leaves the responder's dice intact"), __c.done(__c.cmp("declining leaves the responder's dice intact", (JSON.stringify(s2.dice.copilot.map((d) => d.value))), "===", (before))));

  // d) while a reroll is pending, no other command may resolve (race lock).
  let s3 = init(scn({ rerollRounds: [1], rounds: 7 }));
  s3 = roll(s3, [2, 2, 2, 2], [3, 3, 3, 3]);
  s3 = reroll(s3, P, [s3.dice.pilot[0].id], [6]); // pending = copilot
  __c.throws("placeDie rejected while a reroll is pending", () =>
    reduce(s3, { type: "placeDie", dieId: s3.dice.pilot[1].id, target: { kind: "axis" } }, P));
  let lockMsg = "";
  try {
    reroll(s3, P, [s3.dice.pilot[1].id], [4]);
  } catch (e) {
    lockMsg = e.message;
  }
  (__c.begin("second initiation blocked by the pending lock (not token count)"), __c.done(__c.matches("second initiation blocked by the pending lock (not token count)", /pending|progress|waiting|finish/i, (lockMsg))));

  // e) the initiator must reroll at least one die.
  let s4 = init(scn({ rerollRounds: [1], rounds: 7 }));
  s4 = roll(s4, [2, 2, 2, 2], [3, 3, 3, 3]);
  __c.throws("initiator with zero dice rejected", () => reroll(s4, P, [], []));

  // f) only the active player may initiate a reroll.
  let s5 = init(scn({ rerollRounds: [1], rounds: 7 }));
  s5 = roll(s5, [2, 2, 2, 2], [3, 3, 3, 3]); // turn = pilot
  __c.throws("non-active player cannot initiate", () => reroll(s5, C, [s5.dice.copilot[0].id], [4]));

  // g) auto-complete: if the responder has no unplaced dice, no prompt is left open.
  let s6 = init(scn({ rerollRounds: [1], rounds: 7 }));
  s6 = roll(s6, [1, 3, 2, 1], [1, 2, 3, 4]); // round 1, pilot leads
  s6 = place(s6, P, 1, { kind: "landingGear", slot: 0 }); // 1/2
  s6 = place(s6, C, 1, { kind: "flaps", slot: 0 }); // 1/2
  s6 = place(s6, P, 3, { kind: "landingGear", slot: 1 }); // 3/4
  s6 = place(s6, C, 2, { kind: "axis" });
  s6 = place(s6, P, 2, { kind: "axis" }); // axis 2 vs 2 -> level
  s6 = place(s6, C, 3, { kind: "engine" });
  s6 = place(s6, P, 1, { kind: "engine" }); // sum 4 -> advance 0; pilot now has 0 unplaced dice
  (__c.begin("setup: co-pilot active, pilot out of dice"), __c.done(__c.cmp("setup: co-pilot active, pilot out of dice", (s6.turn), "===", ("copilot")) && __c.truthy("setup: co-pilot active, pilot out of dice", (s6.dice.pilot.every((d) => d.placed)))));
  const lastC = s6.dice.copilot.find((d) => !d.placed).id;
  s6 = reroll(s6, C, [lastC], [5]); // pilot (the responder) has nothing to reroll
  (__c.begin("auto-completed -> nothing left pending"), __c.done(__c.cmp("auto-completed -> nothing left pending", (s6.pendingReroll), "===", (null))));
  (__c.begin("auto-complete still spent the token"), __c.done(__c.cmp("auto-complete still spent the token", (s6.rerollTokens), "===", (0))));
});

// 13) Landing conditions --------------------------------------------------------
test("13) Landing: each unmet condition fails the landing", async () => {
  (__c.begin("baseline: all conditions met -> won"), __c.done(__c.cmp("baseline: all conditions met -> won", (playRound(readyToLand(), level(1, 1)).phase), "===", ("won"))));
  (__c.begin("speed above brakes -> lost"), __c.done(__c.truthy("speed above brakes -> lost", (lostFor(playRound(readyToLand(), level(1, 2)), /speed too high/)))));
  (__c.begin("no brakes deployed -> lost"), __c.done(__c.truthy("no brakes deployed -> lost", (lostFor(playRound(readyToLand((s) => (s.brakesDeployed = 0)), level(1, 1)), /speed too high/)))));
  (__c.begin("speed equal to max brakes (6) -> won"), __c.done(__c.cmp("speed equal to max brakes (6) -> won", (playRound(readyToLand((s) => (s.brakesDeployed = 3)), level(3, 3)).phase), "===", ("won"))));
  (__c.begin("plane tilted -> lost"), __c.done(__c.truthy("plane tilted -> lost", (lostFor(playRound(readyToLand(), { pilot: [4, 1], copilot: [3, 1] }), /not level/)))));
  (__c.begin("airplane left on track -> lost"), __c.done(__c.truthy("airplane left on track -> lost", (lostFor(playRound(readyToLand((s) => (s.airplanes[0] = 1)), level(1, 1)), /airplanes still/)))));
  (__c.begin("not on the airport -> lost"), __c.done(__c.truthy("not on the airport -> lost", (lostFor(playRound(readyToLand((s) => (s.position = 0)), level(1, 1)), /did not reach/)))));
  (__c.begin("gear incomplete -> lost"), __c.done(__c.truthy("gear incomplete -> lost", (lostFor(playRound(readyToLand((s) => (s.gearGreen[2] = false)), level(1, 1)), /landing gear/)))));
  (__c.begin("flaps incomplete -> lost"), __c.done(__c.truthy("flaps incomplete -> lost", (lostFor(playRound(readyToLand((s) => (s.flapsGreen[3] = false)), level(1, 1)), /flaps/)))));
  const multi = playRound(readyToLand((s) => ((s.flapsGreen[0] = false), (s.brakesDeployed = 0))), level(1, 1));
  (__c.begin("multiple failures are all reported"), __c.done(__c.truthy("multiple failures are all reported", (lostFor(multi, /flaps/))) && __c.matches("multiple failures are all reported", /speed too high/, (multi.outcome.reason))));
});

// 14) Reroll tokens across rounds ----------------------------------------------
test("14) Reroll tokens: granted on each listed round, unused tokens carry over", async () => {
  let s = init(scn({ rounds: 7, rerollRounds: [1, 3] }));
  s = playRound(s, level(1, 1));
  (__c.begin("round 1 grants a token"), __c.done(__c.cmp("round 1 grants a token", (s.rerollTokens), "===", (1))));
  s = playRound(s, level(1, 1));
  (__c.begin("round 2 grants none"), __c.done(__c.cmp("round 2 grants none", (s.rerollTokens), "===", (1))));
  s = roll(s, [1, 1, 1, 1], [1, 1, 1, 1]);
  (__c.begin("round 3 grants a second token (carried over)"), __c.done(__c.cmp("round 3 grants a second token (carried over)", (s.round), "===", (3)) && __c.cmp("round 3 grants a second token (carried over)", (s.rerollTokens), "===", (2))));
});

// 15) Illegal commands ----------------------------------------------------------
test("15) Illegal commands are rejected", async () => {
  const fresh = init(scn({ rounds: 7, rerollRounds: [1] }));
  __c.throws("reroll before the dice are rolled", () => reroll(fresh, P, [0], [3]));
  __c.throws("placeDie before the dice are rolled", () =>
    reduce(fresh, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, P));
  const s = roll(fresh, [1, 2, 3, 4], [1, 2, 3, 4]);
  __c.throws("a second roll mid-round", () => roll(s, [1, 1, 1, 1], [1, 1, 1, 1]));
  __c.throws("a roll with the wrong dice count", () => roll(fresh, [1, 1, 1], [1, 1, 1, 1]));
  __c.throws("spending Coffee you don't have", () => place(s, P, 1, { kind: "axis" }, 1));
  __c.throws("placing out of turn", () => place(s, C, 1, { kind: "axis" }));
  __c.throws("a non-crew player placing", () =>
    reduce(s, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, "stranger"));
  __c.throws("Co-Pilot deploying Landing Gear", () => place(place(s, P, 1, { kind: "axis" }), C, 1, { kind: "landingGear", slot: 0 }));
  __c.throws("Pilot deploying Flaps", () => place(s, P, 1, { kind: "flaps", slot: 0 }));
  __c.throws("rerolling a placed die", () => reroll(place(place(s, P, 1, { kind: "axis" }), C, 1, { kind: "axis" }), P, [0], [5]));
  const noTokens = roll(init(scn({ rounds: 7 })), [1, 2, 3, 4], [1, 2, 3, 4]);
  __c.throws("reroll with no tokens", () => reroll(noTokens, P, [0], [3]));
  const won = playRound(readyToLand(), level(1, 1));
  __c.throws("placing after the game is over", () =>
    reduce(won, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, P));
  (__c.begin("reducer never mutates its input"), __c.done(__c.cmp("reducer never mutates its input", (fresh.phase), "===", ("rolling")) && __c.cmp("reducer never mutates its input", (fresh.dice.pilot.length), "===", (0))));
});

// 16) Kerosene module -----------------------------------------------------------
test("16) Kerosene: either crew burns a die's value; empty space burns 6; dry tank loses", async () => {
  const kscn = (over) => scn({ rounds: 7, modules: ["kerosene"], ...over });
  const lostKero = (s) => lostFor(s, /kerosene/i);

  let s = roll(init(kscn()), [1, 1, 3, 6], [1, 1, 2, 6]);
  (__c.begin("tank starts at 20"), __c.done(__c.cmp("tank starts at 20", (s.kerosene), "===", (20)) && __c.cmp("tank starts at 20", (s.keroseneSlot), "===", (null))));
  s = place(s, P, 3, { kind: "kerosene" });
  (__c.begin("pilot's 3 burns 3 at once"), __c.done(__c.cmp("pilot's 3 burns 3 at once", (s.kerosene), "===", (17)) && __c.cmp("pilot's 3 burns 3 at once", (s.keroseneSlot?.value), "===", (3)) && __c.cmp("pilot's 3 burns 3 at once", (s.keroseneSlot.crew), "===", ("pilot"))));
  __c.throws("space holds one die per round", () => place(s, C, 2, { kind: "kerosene" }));

  // Finish the round with the space used: no idle burn on top.
  s = place(s, C, 1, { kind: "axis" });
  s = place(s, P, 1, { kind: "axis" });
  s = place(s, C, 1, { kind: "engine" });
  s = place(s, P, 1, { kind: "engine" });
  s = place(s, C, 6, { kind: "radio", slot: 0 });
  s = place(s, P, 6, { kind: "concentration", slot: 0 });
  s = place(s, C, 2, { kind: "concentration", slot: 1 });
  (__c.begin("used space -> no idle burn"), __c.done(__c.cmp("used space -> no idle burn", (s.round), "===", (2)) && __c.cmp("used space -> no idle burn", (s.kerosene), "===", (17))));
  s = roll(s, [1, 1, 1, 1], [5, 1, 1, 1]);
  (__c.begin("space is free again next round"), __c.done(__c.cmp("space is free again next round", (s.keroseneSlot), "===", (null))));
  const byCopilot = place(s, C, 5, { kind: "kerosene" }); // round 2: co-pilot leads
  (__c.begin("co-pilot may use it too"), __c.done(__c.cmp("co-pilot may use it too", (byCopilot.kerosene), "===", (12)) && __c.cmp("co-pilot may use it too", (byCopilot.keroseneSlot?.crew), "===", ("copilot"))));

  (__c.begin("empty space burns 6 at round end"), __c.done(__c.cmp("empty space burns 6 at round end", (playRound(init(kscn()), level(1, 1)).kerosene), "===", (14))));

  const noModule = roll(init(scn({ rounds: 7 })), [3, 1, 1, 1], [1, 1, 1, 1]);
  __c.throws("rejected when the module is not in play", () => place(noModule, P, 3, { kind: "kerosene" }));
  (__c.begin("no idle burn without the module"), __c.done(__c.cmp("no idle burn without the module", (playRound(init(scn({ rounds: 7 })), level(1, 1)).kerosene), "===", (20))));

  const nearlyDry = roll(init(kscn()), [3, 1, 1, 1], [1, 1, 1, 1]);
  nearlyDry.kerosene = 3;
  const dry = place(nearlyDry, P, 3, { kind: "kerosene" });
  (__c.begin("a die that empties the tank loses immediately"), __c.done(__c.truthy("a die that empties the tank loses immediately", (lostKero(dry))) && __c.cmp("a die that empties the tank loses immediately", (dry.kerosene), "===", (0))));

  const six = init(kscn());
  six.kerosene = 6;
  (__c.begin("idle burn that empties the tank loses"), __c.done(__c.truthy("idle burn that empties the tank loses", (lostKero(playRound(six, level(1, 1)))))));

  const withKero = (fuel) => (st) => ((st.scenario.modules = ["kerosene"]), (st.kerosene = fuel));
  (__c.begin("final round: idle burn to empty beats a good landing"), __c.done(__c.truthy("final round: idle burn to empty beats a good landing", (lostKero(playRound(readyToLand(withKero(6)), level(1, 1)))))));
  (__c.begin("final round: fuel to spare -> landing still counts"), __c.done(__c.cmp("final round: fuel to spare -> landing still counts", (playRound(readyToLand(withKero(7)), level(1, 1)).phase), "===", ("won"))));
});

// 17) Kerosene Leak module -------------------------------------------------------
test("17) Kerosene Leak: Engines burn |difference| + 1 when both are seated; no die space", async () => {
  const lscn = (over) => scn({ rounds: 7, modules: ["keroseneLeak"], ...over });
  const lostKero = (s) => lostFor(s, /kerosene/i);

  let s = roll(init(lscn()), [5, 1, 1, 1], [2, 1, 1, 1]);
  s = place(s, P, 5, { kind: "engine" });
  (__c.begin("one Engine die alone burns nothing"), __c.done(__c.cmp("one Engine die alone burns nothing", (s.kerosene), "===", (20))));
  s = place(s, C, 2, { kind: "engine" }); // speed 7: advance 1 onto the airport, no overshoot
  (__c.begin("Engines 5 vs 2 burn 4 at once (mid-round)"), __c.done(__c.cmp("Engines 5 vs 2 burn 4 at once (mid-round)", (s.kerosene), "===", (16)) && __c.cmp("Engines 5 vs 2 burn 4 at once (mid-round)", (s.round), "===", (1)) && __c.cmp("Engines 5 vs 2 burn 4 at once (mid-round)", (s.phase), "===", ("placement"))));
  __c.throws("Kerosene space is not usable with the Leak", () => place(s, P, 1, { kind: "kerosene" }));

  (__c.begin("matching Engines still leak 1; no idle -6 at round end"), __c.done(__c.cmp("matching Engines still leak 1; no idle -6 at round end", (playRound(init(lscn()), level(1, 1)).kerosene), "===", (19))));

  const low = roll(init(lscn()), [1, 1, 1, 1], [5, 1, 1, 1]);
  low.kerosene = 5;
  const posBefore = low.position;
  let dry = place(low, P, 1, { kind: "engine" });
  dry = place(dry, C, 5, { kind: "engine" }); // speed 6 would advance 1 — but the leak (5) empties the tank first
  (__c.begin("a leak that empties the tank loses immediately"), __c.done(__c.truthy("a leak that empties the tank loses immediately", (lostKero(dry))) && __c.cmp("a leak that empties the tank loses immediately", (dry.kerosene), "===", (0))));
  (__c.begin("…before the plane moves"), __c.done(__c.cmp("…before the plane moves", (dry.position), "===", (posBefore))));

  const withLeak = (fuel) => (st) => ((st.scenario.modules = ["keroseneLeak"]), (st.kerosene = fuel));
  (__c.begin("final round: leak to empty beats a good landing"), __c.done(__c.truthy("final round: leak to empty beats a good landing", (lostKero(playRound(readyToLand(withLeak(1)), level(1, 1)))))));
  (__c.begin("final round: fuel to spare -> landing still counts"), __c.done(__c.cmp("final round: fuel to spare -> landing still counts", (playRound(readyToLand(withLeak(2)), level(1, 1)).phase), "===", ("won"))));
});

// 18) Ice Brakes module ------------------------------------------------------------
test("18) Ice Brakes: steps 2→5, a same-value pair (top Pilot, bottom either) per step", async () => {
  const iscn = (over) => scn({ rounds: 7, modules: ["iceBrakes"], ...over });
  const ice = (slot, space) => ({ kind: "iceBrakes", slot, space });

  // Two steps completed in one round (the marker can advance more than once).
  let s = roll(init(iscn()), [2, 3, 1, 1], [2, 3, 1, 1]);
  s = place(s, P, 2, ice(0, "top"));
  (__c.begin("half a pair doesn't move the marker"), __c.done(__c.cmp("half a pair doesn't move the marker", (s.brakesDeployed), "===", (0)) && __c.cmp("half a pair doesn't move the marker", (s.iceBrakeSlots[0].top), "===", (2))));
  __c.throws("next step stays shut until this one is done", () => place(s, C, 3, ice(1, "bottom")));
  s = place(s, C, 2, ice(0, "bottom"));
  (__c.begin("a matching pair passes step 2"), __c.done(__c.cmp("a matching pair passes step 2", (s.brakesDeployed), "===", (1)) && __c.cmp("a matching pair passes step 2", (s.iceBrakeSlots[0].bottom?.crew), "===", ("copilot"))));
  s = place(s, P, 3, ice(1, "top"));
  s = place(s, C, 3, ice(1, "bottom"));
  (__c.begin("…and step 3 in the same round"), __c.done(__c.cmp("…and step 3 in the same round", (s.brakesDeployed), "===", (2))));
  s = place(s, P, 1, { kind: "axis" });
  s = place(s, C, 1, { kind: "axis" });
  s = place(s, P, 1, { kind: "engine" });
  s = place(s, C, 1, { kind: "engine" });
  s = roll(s, [4, 1, 1, 1], [4, 1, 1, 1]);
  (__c.begin("marker keeps its place; spaces clear next round"), __c.done(__c.cmp("marker keeps its place; spaces clear next round", (s.brakesDeployed), "===", (2)) && __c.truthy("marker keeps its place; spaces clear next round", (s.iceBrakeSlots.every((x) => x.top === null && x.bottom === null)))));

  // Placement rules.
  const r = roll(init(iscn()), [2, 3, 1, 1], [2, 2, 1, 1]);
  __c.throws("wrong value rejected", () => place(r, P, 3, ice(0, "top")));
  __c.throws("a later step rejected out of order", () => place(r, P, 3, ice(1, "top")));
  __c.throws("base Brakes are replaced", () => place(r, P, 2, { kind: "brakes", slot: 0 }));
  const pBottom = place(r, P, 2, ice(0, "bottom"));
  (__c.begin("the Pilot may take the bottom space (bottom first is fine)"), __c.done(__c.cmp("the Pilot may take the bottom space (bottom first is fine)", (pBottom.iceBrakeSlots[0].bottom?.crew), "===", ("pilot"))));
  __c.throws("the Co-Pilot may not take the top space", () => place(pBottom, C, 2, ice(0, "top")));
  __c.throws("a taken space is rejected", () => place(pBottom, C, 2, ice(0, "bottom")));
  const noIce = roll(init(scn({ rounds: 7 })), [2, 1, 1, 1], [1, 1, 1, 1]);
  __c.throws("rejected when the module is not in play", () => place(noIce, P, 2, ice(0, "top")));

  // A step the marker has passed takes a matching die again, with no effect.
  let passed = roll(init(iscn()), [2, 2, 3, 1], [2, 1, 1, 1]);
  passed.brakesDeployed = 1; // step 2 passed earlier
  passed = place(passed, P, 2, ice(0, "top"));
  (__c.begin("a passed Ice Brakes step takes a matching die, with no effect"), __c.done(__c.cmp("a passed Ice Brakes step takes a matching die, with no effect", (passed.iceBrakeSlots[0].top), "===", (2)) && __c.cmp("a passed Ice Brakes step takes a matching die, with no effect", (passed.brakesDeployed), "===", (1)) && __c.matches("a passed Ice Brakes step takes a matching die, with no effect", /no effect/, (passed.log.at(-1)))));
  __c.throws("…still only its own value", () => place(passed, C, 1, ice(0, "bottom")));
  passed = place(passed, C, 2, ice(0, "bottom"));
  (__c.begin("…and a full pair on it still has no effect"), __c.done(__c.cmp("…and a full pair on it still has no effect", (passed.brakesDeployed), "===", (1))));
  __c.throws("steps past the next one stay shut", () => place(passed, P, 3, ice(2, "top")));

  // A lone die is cleared at round end without advancing.
  let half = roll(init(iscn()), [2, 1, 1, 6], [1, 1, 6, 6]);
  half = place(half, P, 2, ice(0, "top"));
  half = place(half, C, 1, { kind: "axis" });
  half = place(half, P, 1, { kind: "axis" });
  half = place(half, C, 1, { kind: "engine" });
  half = place(half, P, 1, { kind: "engine" });
  half = place(half, C, 6, { kind: "radio", slot: 0 });
  half = place(half, P, 6, { kind: "concentration", slot: 0 });
  half = place(half, C, 6, { kind: "radio", slot: 1 });
  half = roll(half, [1, 1, 1, 1], [1, 1, 1, 1]);
  (__c.begin("a half-filled step is cleared next round, marker unmoved"), __c.done(__c.cmp("a half-filled step is cleared next round, marker unmoved", (half.brakesDeployed), "===", (0)) && __c.cmp("a half-filled step is cleared next round, marker unmoved", (half.iceBrakeSlots[0].top), "===", (null))));

  // Landing.
  const withIce = (steps) => (st) => ((st.scenario.modules = ["iceBrakes"]), (st.brakesDeployed = steps));
  (__c.begin("all four steps, speed 5 -> landed"), __c.done(__c.cmp("all four steps, speed 5 -> landed", (playRound(readyToLand(withIce(4)), level(2, 3)).phase), "===", ("won"))));
  (__c.begin("all four steps, speed 6 -> too fast"), __c.done(__c.truthy("all four steps, speed 6 -> too fast", (lostFor(playRound(readyToLand(withIce(4)), level(3, 3)), /speed too high/)))));
  (__c.begin("marker not past the 5 -> lost"), __c.done(__c.truthy("marker not past the 5 -> lost", (lostFor(playRound(readyToLand(withIce(3)), level(1, 1)), /ice brakes not fully deployed/)))));
});

// 19) Ice Brakes + Kerosene Leak together ----------------------------------------
test("19) Ice Brakes + Kerosene Leak in one game", async () => {
  const both = ["iceBrakes", "keroseneLeak"];
  (__c.begin("setup accepted"), __c.done(__c.truthy("setup accepted", (SetSetupPayload.safeParse({ scenarioId: "YUL", modules: both }).success))));

  // One round exercising both: a pair on the 2 step, Engines 1 vs 1 leak 1.
  let s = roll(init(scn({ rounds: 7, modules: both })), [2, 1, 1, 1], [2, 1, 1, 1]);
  s = place(s, P, 2, { kind: "iceBrakes", slot: 0, space: "top" });
  s = place(s, C, 2, { kind: "iceBrakes", slot: 0, space: "bottom" });
  s = place(s, P, 1, { kind: "engine" });
  s = place(s, C, 1, { kind: "engine" });
  (__c.begin("both effects apply in the same round"), __c.done(__c.cmp("both effects apply in the same round", (s.brakesDeployed), "===", (1)) && __c.cmp("both effects apply in the same round", (s.kerosene), "===", (19))));
  __c.throws("still no Kerosene die space", () => place(s, P, 1, { kind: "kerosene" }));

  const prep = (fuel) => (st) => ((st.scenario.modules = [...both]), (st.brakesDeployed = 4), (st.kerosene = fuel));
  const landed = playRound(readyToLand(prep(20)), level(2, 3)); // speed 5 ≤ ice 5; leak 2
  (__c.begin("speed 5 lands on full Ice Brakes; the leak still burns"), __c.done(__c.cmp("speed 5 lands on full Ice Brakes; the leak still burns", (landed.phase), "===", ("won")) && __c.cmp("speed 5 lands on full Ice Brakes; the leak still burns", (landed.kerosene), "===", (18))));
  (__c.begin("a leak that empties the tank beats a valid Ice Brakes landing"), __c.done(__c.truthy("a leak that empties the tank beats a valid Ice Brakes landing", (lostFor(playRound(readyToLand(prep(2)), level(2, 3)), /kerosene/i)))));
  const short = (st) => ((st.scenario.modules = [...both]), (st.brakesDeployed = 3));
  (__c.begin("Ice Brakes short of the 5 still fails with the Leak on"), __c.done(__c.truthy("Ice Brakes short of the 5 still fails with the Leak on", (lostFor(playRound(readyToLand(short), level(1, 1)), /ice brakes not fully deployed/)))));
});

// 20) Intern module -------------------------------------------------------------------
test("20) Intern: train with a die ≠ next token, place the token at once, all trained to land", async () => {
  const nscn = scn({ rounds: 7, modules: ["intern"] });
  const initN = (tokens) => createInitialGameState(nscn, P, C, { internTokens: tokens });
  const intern = (st, who, target) => reduce(st, { type: "placeIntern", target }, who).state;
  const TOK = [3, 1, 5, 6, 2, 4];

  let s = roll(initN(TOK), [2, 3, 1, 1], [4, 1, 6, 6]);
  __c.throws("training die equal to the next token rejected", () => place(s, P, 3, { kind: "intern" }));
  s = place(s, P, 2, { kind: "intern" });
  (__c.begin("Pilot takes the leftmost token and holds it"), __c.done(__c.cmp("Pilot takes the leftmost token and holds it", (s.internTokens[0]), "===", (null)) && __c.cmp("Pilot takes the leftmost token and holds it", (s.internHeld?.crew), "===", ("pilot")) && __c.cmp("Pilot takes the leftmost token and holds it", (s.internHeld.value), "===", (3))));
  (__c.begin("…the training die is spent, turn stays"), __c.done(__c.cmp("…the training die is spent, turn stays", (s.internSlots.pilot), "===", (2)) && __c.cmp("…the training die is spent, turn stays", (s.placedThisRound), "===", (1)) && __c.cmp("…the training die is spent, turn stays", (s.turn), "===", ("pilot"))));
  __c.throws("no die may be placed while the token is held", () => place(s, P, 1, { kind: "axis" }));
  __c.throws("no reroll while the token is held", () => reroll(s, P, [1], [5]));
  __c.throws("the other crew can't place it", () => intern(s, C, { kind: "axis" }));
  __c.throws("not on Concentration", () => intern(s, P, { kind: "concentration", slot: 0 }));
  __c.throws("not on the Intern board", () => intern(s, P, { kind: "intern" }));
  s = intern(s, P, { kind: "radio", slot: 0 });
  (__c.begin("token placed as a 3 on the Pilot's Radio; marked as Intern-filled"), __c.done(__c.cmp("token placed as a 3 on the Pilot's Radio; marked as Intern-filled", (s.radioPilot), "===", (3)) && __c.contains("token placed as a 3 on the Pilot's Radio; marked as Intern-filled", (s.internPlaced), ('pilot:{"kind":"radio","slot":0}'))));
  (__c.begin("then the turn passes"), __c.done(__c.cmp("then the turn passes", (s.internHeld), "===", (null)) && __c.cmp("then the turn passes", (s.turn), "===", ("copilot"))));
  __c.throws("Co-Pilot's die equal to its next token (rightmost 4) rejected", () => place(s, C, 4, { kind: "intern" }));
  s = place(s, C, 6, { kind: "intern" });
  (__c.begin("Co-Pilot takes the rightmost token"), __c.done(__c.cmp("Co-Pilot takes the rightmost token", (s.internTokens[5]), "===", (null)) && __c.cmp("Co-Pilot takes the rightmost token", (s.internHeld?.value), "===", (4))));
  s = intern(s, C, { kind: "axis" });
  (__c.begin("a token can fill the Axis"), __c.done(__c.cmp("a token can fill the Axis", (s.axis.copilot), "===", (4)) && __c.contains("a token can fill the Axis", (s.internPlaced), ('copilot:{"kind":"axis"}'))));
  __c.throws("one training per crew per round", () => place(s, P, 3, { kind: "intern" }));

  // The 8th die trains: the round only ends once the token is placed.
  let e = roll(initN(TOK), [1, 1, 6, 6], [1, 1, 6, 6]);
  e = place(e, P, 1, { kind: "axis" });
  e = place(e, C, 1, { kind: "axis" });
  e = place(e, P, 1, { kind: "engine" });
  e = place(e, C, 1, { kind: "engine" });
  e = place(e, P, 6, { kind: "radio", slot: 0 });
  e = place(e, C, 6, { kind: "radio", slot: 0 });
  e = place(e, P, 6, { kind: "concentration", slot: 0 });
  e = place(e, C, 6, { kind: "intern" }); // 8th die; takes the 4
  (__c.begin("8th die trained: round waits for the token"), __c.done(__c.cmp("8th die trained: round waits for the token", (e.round), "===", (1)) && __c.cmp("8th die trained: round waits for the token", (e.phase), "===", ("placement")) && __c.cmp("8th die trained: round waits for the token", (e.internHeld?.value), "===", (4))));
  e = intern(e, C, { kind: "radio", slot: 1 });
  (__c.begin("…placing it ends the round"), __c.done(__c.cmp("…placing it ends the round", (e.round), "===", (2)) && __c.cmp("…placing it ends the round", (e.phase), "===", ("rolling"))));
  e = roll(e, [1, 1, 1, 1], [1, 1, 1, 1]);
  (__c.begin("next round: training spaces and Intern marks reset, trained tokens stay gone"), __c.done(__c.cmp("next round: training spaces and Intern marks reset, trained tokens stay gone", (e.internSlots.pilot), "===", (null)) && __c.cmp("next round: training spaces and Intern marks reset, trained tokens stay gone", (e.internSlots.copilot), "===", (null)) && __c.cmp("next round: training spaces and Intern marks reset, trained tokens stay gone", (e.internPlaced.length), "===", (0)) && __c.cmp("next round: training spaces and Intern marks reset, trained tokens stay gone", (e.internTokens[5]), "===", (null))));

  // The token respects the Axis/Engine reservation.
  let r = roll(initN(TOK), [1, 1, 1, 1], [2, 6, 1, 1]);
  r = place(r, P, 1, { kind: "radio", slot: 0 });
  r = place(r, C, 1, { kind: "radio", slot: 0 });
  r = place(r, P, 1, { kind: "concentration", slot: 0 });
  r = place(r, C, 2, { kind: "intern" }); // Co-Pilot: 2 dice left + the token, Axis and Engine open
  const r2 = intern(r, C, { kind: "radio", slot: 1 });
  (__c.begin("token may take a free space while the dice left still cover Axis + Engine"), __c.done(__c.cmp("token may take a free space while the dice left still cover Axis + Engine", (r2.radioCopilot[1]), "===", (4))));
  let r3 = roll(initN(TOK), [1, 1, 1, 1], [2, 6, 1, 1]);
  r3.turn = "copilot";
  r3.dice.copilot.slice(2).forEach((d) => (d.placed = true)); // Co-Pilot down to its 2 and 6
  r3 = place(r3, C, 2, { kind: "intern" }); // 1 die left + the token, Axis and Engine open
  __c.throws("…but not when the dice left can't", () => intern(r3, C, { kind: "radio", slot: 0 }));
  (__c.begin("…then it must fill the Axis or Engine"), __c.done(__c.cmp("…then it must fill the Axis or Engine", (intern(r3, C, { kind: "axis" }).axis.copilot), "===", (4))));

  // Training is refused if the token would have nowhere to go.
  const stuck = roll(initN([1, 2, 3, 4, 5, 6]), [1, 1, 1, 1], [1, 1, 1, 2]);
  stuck.turn = "copilot";
  stuck.axis.copilot = 1;
  stuck.engines.copilot = 1;
  stuck.radioCopilot = [1, 1];
  stuck.dice.copilot.slice(0, 3).forEach((d) => (d.placed = true));
  __c.throws("a 6 with no legal space (Concentration excluded) can't be trained", () => place(stuck, C, 2, { kind: "intern" }));

  __c.throws("rejected when the module is not in play", () => place(roll(init(scn({ rounds: 7 })), [2, 1, 1, 1], [1, 1, 1, 1]), P, 2, { kind: "intern" }));

  // Landing.
  const withIntern = (left) => (st) => ((st.scenario.modules = ["intern"]), (st.internTokens = [null, null, null, null, null, left]));
  (__c.begin("untrained token at landing -> lost"), __c.done(__c.truthy("untrained token at landing -> lost", (lostFor(playRound(readyToLand(withIntern(5)), level(1, 1)), /intern not fully trained/)))));
  (__c.begin("fully trained -> landed"), __c.done(__c.cmp("fully trained -> landed", (playRound(readyToLand(withIntern(null)), level(1, 1)).phase), "===", ("won"))));
});

// 22) Control & Mastery (Special Abilities, passive) --------------------------------
test("22) Control & Mastery", async () => {
  const ab = (abilities) => scn({ rounds: 7, abilities });
  let s = roll(init(ab(["control"])), [3, 1, 1, 1], [3, 1, 1, 1]);
  s = place(s, P, 3, { kind: "axis" });
  s = place(s, C, 3, { kind: "axis" });
  (__c.begin("Control: matching Axis dice give a Coffee"), __c.done(__c.cmp("Control: matching Axis dice give a Coffee", (s.coffee), "===", (1))));
  const noCtl = place(place(roll(init(scn({ rounds: 7 })), [3, 1, 1, 1], [3, 1, 1, 1]), P, 3, { kind: "axis" }), C, 3, { kind: "axis" });
  (__c.begin("…not without the card"), __c.done(__c.cmp("…not without the card", (noCtl.coffee), "===", (0))));
  const unequal = place(place(roll(init(ab(["control"])), [3, 1, 1, 1], [2, 1, 1, 1]), P, 3, { kind: "axis" }), C, 2, { kind: "axis" });
  (__c.begin("…not for different values"), __c.done(__c.cmp("…not for different values", (unequal.coffee), "===", (0))));
  const full = roll(init(ab(["control"])), [3, 1, 1, 1], [3, 1, 1, 1]);
  full.coffee = 3;
  (__c.begin("…capped at 3"), __c.done(__c.cmp("…capped at 3", (place(place(full, P, 3, { kind: "axis" }), C, 3, { kind: "axis" }).coffee), "===", (3))));

  let m = roll(init(ab(["mastery"])), [1, 1, 1, 1], [2, 1, 1, 1]);
  m.rerollTokens = 1;
  m = reroll(m, P, [0], [1]); // spend the token → back in the supply
  m = reroll(m, C, [], []); // co-pilot declines
  (__c.begin("spending a Reroll puts it back in the supply"), __c.done(__c.cmp("spending a Reroll puts it back in the supply", (m.rerollTokens), "===", (0)) && __c.cmp("spending a Reroll puts it back in the supply", (m.rerollSpent), "===", (1))));
  m = place(m, P, 1, { kind: "engine" });
  m = place(m, C, 1, { kind: "engine" });
  (__c.begin("Mastery: matching Engine dice regain the spent Reroll"), __c.done(__c.cmp("Mastery: matching Engine dice regain the spent Reroll", (m.rerollTokens), "===", (1)) && __c.cmp("Mastery: matching Engine dice regain the spent Reroll", (m.rerollSpent), "===", (0))));
  let m2 = roll(init(ab(["mastery"])), [1, 1, 1, 1], [1, 1, 1, 1]);
  m2 = place(place(m2, P, 1, { kind: "engine" }), C, 1, { kind: "engine" });
  (__c.begin("…but only if a token is in the supply"), __c.done(__c.cmp("…but only if a token is in the supply", (m2.rerollTokens), "===", (0))));
  let m3 = roll(init(scn({ rounds: 7 })), [1, 1, 1, 1], [1, 1, 1, 1]);
  m3.rerollSpent = 1;
  m3 = place(place(m3, P, 1, { kind: "engine" }), C, 1, { kind: "engine" });
  (__c.begin("…and only with the card"), __c.done(__c.cmp("…and only with the card", (m3.rerollTokens), "===", (0))));
});

// 23) Adaptation ------------------------------------------------------------------
test("23) Adaptation", async () => {
  const adapt = (st, who, dieId) => reduce(st, { type: "adapt", dieId }, who).state;
  const s0 = roll(init(scn({ rounds: 7, abilities: ["adaptation"] })), [1, 2, 3, 4], [6, 5, 4, 3]);
  const s1 = adapt(s0, P, 0);
  (__c.begin("a 1 turns to a 6"), __c.done(__c.cmp("a 1 turns to a 6", (s1.dice.pilot[0].value), "===", (6)) && __c.truthy("a 1 turns to a 6", (s1.adaptationUsed.pilot))));
  __c.throws("once per game per player", () => adapt(s1, P, 1));
  (__c.begin("the other player may use theirs on the Pilot's turn"), __c.done(__c.cmp("the other player may use theirs on the Pilot's turn", (adapt(s1, C, 1).dice.copilot[1].value), "===", (2))));
  __c.throws("not on a placed die", () => adapt(place(s0, P, 1, { kind: "axis" }), P, 0));
  __c.throws("not without the card", () => adapt(roll(init(scn({ rounds: 7 })), [1, 1, 1, 1], [1, 1, 1, 1]), P, 0));
  __c.throws("not while a reroll is pending", () => {
    const r = roll(init(scn({ rounds: 7, rerollRounds: [1], abilities: ["adaptation"] })), [1, 1, 1, 1], [1, 1, 1, 1]);
    adapt(reroll(r, P, [0], [2]), C, 0);
  });
  // Jump to round 2 (handleRoll doesn't check the previous round's placements).
  const nextRound = roll(Object.assign(structuredClone(s1), { phase: "rolling", round: 2 }), [1, 1, 1, 1], [1, 1, 1, 1]);
  (__c.begin("still used up in later rounds"), __c.done(__c.cmp("still used up in later rounds", (nextRound.adaptationUsed.pilot), "===", (true))));
});

// 24) Anticipation ----------------------------------------------------------------
test("24) Anticipation", async () => {
  const ant = (st, who, dieId, value) => reduce(st, { type: "anticipate", dieId, value }, who).state;
  const s0 = roll(init(scn({ rounds: 7, abilities: ["anticipation"] })), [1, 1, 1, 1], [2, 2, 2, 2]);
  const s1 = ant(s0, P, 2, 6);
  (__c.begin("the First Player rerolls one die before placing"), __c.done(__c.cmp("the First Player rerolls one die before placing", (s1.dice.pilot[2].value), "===", (6)) && __c.truthy("the First Player rerolls one die before placing", (s1.anticipated))));
  (__c.begin("…and it's still their turn"), __c.done(__c.cmp("…and it's still their turn", (s1.turn), "===", ("pilot"))));
  __c.throws("once per round", () => ant(s1, P, 1, 5));
  __c.throws("only the First Player", () => ant(s0, C, 0, 5));
  __c.throws("only before their first die", () => ant(place(s0, P, 1, { kind: "axis" }), P, 1, 5));
  __c.throws("not without the card", () => ant(roll(init(scn({ rounds: 7 })), [1, 1, 1, 1], [1, 1, 1, 1]), P, 0, 5));
  const r2 = roll(Object.assign(structuredClone(s1), { phase: "rolling", round: 2 }), [1, 1, 1, 1], [3, 3, 3, 3]);
  (__c.begin("round 2: anticipation resets and the Co-Pilot (now leading) may use it"), __c.done(__c.falsy("round 2: anticipation resets and the Co-Pilot (now leading) may use it", (r2.anticipated)) && __c.cmp("round 2: anticipation resets and the Co-Pilot (now leading) may use it", (ant(r2, C, 0, 6).dice.copilot[0].value), "===", (6))));
});

// 25) Working Together ------------------------------------------------------------
test("25) Working Together", async () => {
  const swap = (st, who, dieId) => reduce(st, { type: "swap", dieId }, who).state;
  const wscn = scn({ rounds: 7, rerollRounds: [1], abilities: ["workingTogether", "adaptation"] });
  const s0 = roll(init(wscn), [1, 2, 3, 4], [6, 5, 4, 3]);
  __c.throws("only the active player starts it", () => swap(s0, C, 0));
  const s1 = swap(s0, P, 0); // Pilot offers its 1
  (__c.begin("the offer waits for the other player"), __c.done(__c.cmp("the offer waits for the other player", (s1.pendingSwap?.from), "===", ("pilot")) && __c.cmp("the offer waits for the other player", (s1.dice.pilot[0].value), "===", (1))));
  __c.throws("no placements while the swap is pending", () => place(s1, P, 2, { kind: "axis" }));
  __c.throws("no reroll while the swap is pending", () => reroll(s1, P, [1], [5]));
  __c.throws("no Adaptation while the swap is pending", () => reduce(s1, { type: "adapt", dieId: 1 }, C));
  __c.throws("the offering player can't answer it", () => swap(s1, P, 1));
  const s2 = swap(s1, C, 0); // Co-Pilot answers with its 6
  (__c.begin("values swap, dice return unplaced"), __c.done(__c.cmp("values swap, dice return unplaced", (s2.dice.pilot[0].value), "===", (6)) && __c.cmp("values swap, dice return unplaced", (s2.dice.copilot[0].value), "===", (1)) && __c.falsy("values swap, dice return unplaced", (s2.dice.pilot[0].placed)) && __c.falsy("values swap, dice return unplaced", (s2.dice.copilot[0].placed))));
  (__c.begin("turn is unchanged"), __c.done(__c.cmp("turn is unchanged", (s2.turn), "===", ("pilot")) && __c.cmp("turn is unchanged", (s2.pendingSwap), "===", (null))));
  __c.throws("once per round", () => swap(s2, P, 1));
  const placed = place(place(s0, P, 1, { kind: "axis" }), C, 3, { kind: "axis" }); // tilt -2, game goes on
  (__c.begin("(setup: still in placement, Pilot's turn)"), __c.done(__c.cmp("(setup: still in placement, Pilot's turn)", (placed.phase), "===", ("placement")) && __c.cmp("(setup: still in placement, Pilot's turn)", (placed.turn), "===", ("pilot"))));
  __c.throws("not with a placed die", () => swap(placed, P, 0));
  const empty = roll(init(wscn), [1, 1, 1, 1], [1, 1, 1, 1]);
  empty.dice.copilot.forEach((d) => (d.placed = true));
  __c.throws("refused when the other player has no dice", () => swap(empty, P, 0));
  (__c.begin("…and leaves nothing pending"), __c.done(__c.cmp("…and leaves nothing pending", (empty.pendingSwap), "==", (null))));
  __c.throws("not without the card", () => swap(roll(init(scn({ rounds: 7 })), [1, 1, 1, 1], [1, 1, 1, 1]), P, 0));
  const r2 = roll(Object.assign(structuredClone(s2), { phase: "rolling", round: 2 }), [1, 1, 1, 1], [2, 2, 2, 2]);
  (__c.begin("usable again next round"), __c.done(__c.cmp("usable again next round", (swap(r2, C, 0).pendingSwap?.from), "===", ("copilot"))));
});

// 26) Synchronisation (Traffic die) --------------------------------------------------
test("26) Synchronisation", async () => {
  const sync = (modules = []) => scn({ rounds: 7, abilities: ["synchronisation"], modules });
  const rollT = (st, value) => reduce(st, { type: "rollTraffic", value }, "").state;
  const placeT = (st, target, who = C) => reduce(st, { type: "placeTraffic", target }, who).state;

  let s = roll(init(sync()), [1, 1, 1, 1], [1, 1, 1, 1]);
  s = place(s, P, 1, { kind: "landingGear", slot: 0 });
  (__c.begin("Gear alone doesn't trigger"), __c.done(__c.falsy("Gear alone doesn't trigger", (s.trafficPending))));
  s = place(s, C, 1, { kind: "flaps", slot: 0 });
  (__c.begin("Gear + Flaps: the Traffic die must be rolled; the turn waits"), __c.done(__c.truthy("Gear + Flaps: the Traffic die must be rolled; the turn waits", (s.trafficPending)) && __c.cmp("Gear + Flaps: the Traffic die must be rolled; the turn waits", (s.turn), "===", ("copilot"))));
  __c.throws("nothing else happens before it's rolled", () => place(s, C, 1, { kind: "axis" }));
  s = rollT(s, 4);
  (__c.begin("the Co-Pilot holds it"), __c.done(__c.cmp("the Co-Pilot holds it", (s.trafficHeld?.value), "===", (4)) && __c.falsy("the Co-Pilot holds it", (s.trafficPending))));
  __c.throws("nothing else happens until it's placed", () => place(s, C, 1, { kind: "axis" }));
  __c.throws("the Pilot can't place it", () => placeT(s, { kind: "axis", side: "pilot" }, P));
  s = placeT(s, { kind: "axis", side: "pilot" }); // the Pilot's Axis, regardless of colour
  (__c.begin("placed on the Pilot's Axis as a 4"), __c.done(__c.cmp("placed on the Pilot's Axis as a 4", (s.axis.pilot), "===", (4)) && __c.contains("placed on the Pilot's Axis as a 4", (s.trafficPlaced), ('pilot:{"kind":"axis"}'))));
  (__c.begin("an extra action: the triggering turn then passes as usual"), __c.done(__c.cmp("an extra action: the triggering turn then passes as usual", (s.turn), "===", ("pilot")) && __c.cmp("an extra action: the triggering turn then passes as usual", (s.trafficHeld), "===", (null))));
  (__c.begin("once per round"), __c.done(__c.falsy("once per round", (place(s, P, 1, { kind: "radio", slot: 0 }).trafficPending))));
  __c.throws("a die can't name the other crew's side", () => place(s, P, 1, { kind: "radio", slot: 0, side: "copilot" }));

  // Triggered on the Pilot's turn: the Co-Pilot places, then it's the Co-Pilot's turn.
  let q = roll(init(sync()), [1, 1, 1, 1], [1, 1, 1, 1]);
  q = place(q, P, 1, { kind: "radio", slot: 0 });
  q = place(q, C, 1, { kind: "flaps", slot: 0 });
  q = place(q, P, 1, { kind: "landingGear", slot: 0 });
  (__c.begin("Pilot-triggered: rolled on the Pilot's turn"), __c.done(__c.truthy("Pilot-triggered: rolled on the Pilot's turn", (q.trafficPending)) && __c.cmp("Pilot-triggered: rolled on the Pilot's turn", (q.turn), "===", ("pilot"))));
  q = placeT(rollT(q, 3), { kind: "radio", slot: 0, side: "copilot" });
  (__c.begin("…placed by the Co-Pilot, then the turn passes to the Co-Pilot"), __c.done(__c.cmp("…placed by the Co-Pilot, then the turn passes to the Co-Pilot", (q.radioCopilot[0]), "===", (3)) && __c.cmp("…placed by the Co-Pilot, then the turn passes to the Co-Pilot", (q.turn), "===", ("copilot"))));
  (__c.begin("the Pilot's Gear can take it too (any colour)"), __c.done(__c.truthy("the Pilot's Gear can take it too (any colour)", (placeT(rollT((() => { let t = roll(init(sync()), [1, 1, 1, 1], [1, 1, 1, 1]); t = place(t, P, 1, { kind: "landingGear", slot: 0 }); return place(t, C, 1, { kind: "flaps", slot: 0 }); })(), 3), { kind: "landingGear", slot: 1 }).gearGreen[1]))));

  // On Concentration, and on the Intern board (user rule).
  const triggered = (modules) => { let t = roll(init(sync(modules)), [1, 1, 1, 1], [1, 1, 1, 1]); t = place(t, P, 1, { kind: "landingGear", slot: 0 }); return rollT(place(t, C, 1, { kind: "flaps", slot: 0 }), 4); };
  const conc = placeT(triggered(), { kind: "concentration", slot: 0 });
  (__c.begin("on Concentration: a Coffee"), __c.done(__c.cmp("on Concentration: a Coffee", (conc.coffee), "===", (1)) && __c.cmp("on Concentration: a Coffee", (conc.concentrationSlots[0]?.value), "===", (4))));
  const tr = placeT(triggered(["intern"]), { kind: "intern", side: "pilot" }); // tokens 1..6: Pilot's next is 1
  (__c.begin("on the Pilot's Intern space: trains the Pilot's Intern"), __c.done(__c.cmp("on the Pilot's Intern space: trains the Pilot's Intern", (tr.internSlots.pilot), "===", (4)) && __c.cmp("on the Pilot's Intern space: trains the Pilot's Intern", (tr.internHeld?.crew), "===", ("pilot")) && __c.cmp("on the Pilot's Intern space: trains the Pilot's Intern", (tr.internHeld.value), "===", (1))));
  (__c.begin("…the turn waits for that token"), __c.done(__c.cmp("…the turn waits for that token", (tr.turn), "===", ("copilot"))));
  const tr2 = reduce(tr, { type: "placeIntern", target: { kind: "radio", slot: 0 } }, P).state;
  (__c.begin("…then passes from the Co-Pilot as usual"), __c.done(__c.cmp("…then passes from the Co-Pilot as usual", (tr2.radioPilot), "===", (1)) && __c.cmp("…then passes from the Co-Pilot as usual", (tr2.turn), "===", ("pilot"))));

  // The round's 8th die triggers it: the round ends only after the Traffic die.
  let e = roll(init(sync()), [1, 1, 1, 6], [1, 1, 6, 6]);
  e = place(e, P, 1, { kind: "axis" });
  e = place(e, C, 1, { kind: "axis" });
  e = place(e, P, 1, { kind: "engine" });
  e = place(e, C, 1, { kind: "engine" });
  e = place(e, P, 1, { kind: "landingGear", slot: 0 });
  e = place(e, C, 6, { kind: "radio", slot: 0 });
  e = place(e, P, 6, { kind: "radio", slot: 0 });
  e = place(e, C, 6, { kind: "radio", slot: 1 });
  (__c.begin("(no flaps yet: round 1 ended normally)"), __c.done(__c.cmp("(no flaps yet: round 1 ended normally)", (e.round), "===", (2))));
  let f = roll(init(sync()), [1, 1, 1, 6], [1, 1, 6, 6]);
  f = place(f, P, 1, { kind: "axis" });
  f = place(f, C, 1, { kind: "axis" });
  f = place(f, P, 1, { kind: "engine" });
  f = place(f, C, 1, { kind: "engine" });
  f = place(f, P, 1, { kind: "landingGear", slot: 0 });
  f = place(f, C, 6, { kind: "radio", slot: 0 });
  f = place(f, P, 6, { kind: "radio", slot: 0 });
  f.flapSlots[0] = 1; // as if a Flaps die were down: the 8th die completes the condition
  f = place(f, C, 6, { kind: "radio", slot: 1 });
  (__c.begin("8th die triggers: the round waits"), __c.done(__c.cmp("8th die triggers: the round waits", (f.round), "===", (1)) && __c.truthy("8th die triggers: the round waits", (f.trafficPending))));
  f = placeT(rollT(f, 2), { kind: "concentration", slot: 0 });
  (__c.begin("…and ends once the Traffic die is placed"), __c.done(__c.cmp("…and ends once the Traffic die is placed", (f.round), "===", (2)) && __c.cmp("…and ends once the Traffic die is placed", (f.phase), "===", ("rolling"))));

  // No empty space: discarded rather than deadlocking.
  let z = roll(init(sync()), [1, 1, 1, 1], [1, 1, 1, 1]);
  z.gearSlots[0] = 1; z.flapSlots[0] = 1;
  z.gearSlots[2] = 6; // an already-down switch takes a matching die, so fill the 5's one
  z.trafficPending = true; z.syncDone = true;
  z.axis = { pilot: 1, copilot: 1, offset: 0 }; z.engines = { pilot: 1, copilot: 1 };
  z.radioPilot = 1; z.radioCopilot = [1, 1]; z.concentrationSlots = [{ value: 1, crew: "pilot" }, { value: 1, crew: "copilot" }];
  z.gearGreen = [true, true, true]; z.flapsGreen = [true, true, false, false]; z.brakesDeployed = 3;
  z = rollT(z, 5);
  // (Every space is full here, so the hands' dice are then discarded too and the round ends.)
  (__c.begin("no legal space: the Traffic die is discarded"), __c.done(__c.cmp("no legal space: the Traffic die is discarded", (z.trafficHeld), "===", (null)) && __c.falsy("no legal space: the Traffic die is discarded", (z.trafficPending)) && __c.truthy("no legal space: the Traffic die is discarded", (z.log.some((l) => l.includes("Traffic die (5) has nowhere to go"))))));

  const plain = roll(init(scn({ rounds: 7 })), [1, 1, 1, 1], [1, 1, 1, 1]);
  (__c.begin("not without the card"), __c.done(__c.falsy("not without the card", (place(place(plain, P, 1, { kind: "landingGear", slot: 0 }), C, 1, { kind: "flaps", slot: 0 }).trafficPending))));
  const rr = roll(Object.assign(structuredClone(s), { phase: "rolling", round: 2 }), [1, 1, 1, 1], [1, 1, 1, 1]);
  (__c.begin("resets next round"), __c.done(__c.falsy("resets next round", (rr.syncDone)) && __c.cmp("resets next round", (rr.trafficPlaced.length), "===", (0))));
});

// 27) Every combination of modules and Special Abilities ---------------------------
// Each implemented module declares (a) how much Kerosene a quiet round burns and
// (b) how to make a landing legal; each ability declares how many Coffee it adds
// to a quiet round. Every allowed module combination × every allowed ability set
// (up to the cap) must validate, play a quiet round with the effects adding up,
// and land; every module combination holding an excluded pair, and every ability
// set over the cap, must be rejected. A new module or ability without an entry
// fails loudly, so it can't skip this matrix.
test("27) Every combination of modules and Special Abilities", async () => {
  const EXPECT = {
    kerosene: { quietBurn: 6, prep: () => {} }, // empty space: -6 per round
    keroseneLeak: { quietBurn: 1, prep: () => {} }, // level(1,1): Engines equal, leak 1
    iceBrakes: { quietBurn: 0, prep: (st) => (st.brakesDeployed = 4) }, // must be past the 5
    intern: { quietBurn: 0, prep: (st) => (st.internTokens = st.internTokens.map(() => null)) }, // all trained
    wind: { quietBurn: 0, prep: (st) => (st.windPosition = WIND_RING.indexOf(0)) }, // a calm space: the dice alone
    realTime: { quietBurn: 0, prep: () => {} }, // every die placed in time: the clock never runs out
  };
  // A quiet round (level(1,1)) plays Axis 3 vs 3 and Engines 1 vs 1 plus one
  // Concentration die, and touches no Gear/Flaps and no Reroll tokens.
  const ABILITY_EXPECT = {
    control: { quietCoffee: 1 }, // matching Axis dice
    mastery: { quietCoffee: 0 }, // matching Engines, but no spent Reroll to regain
    adaptation: { quietCoffee: 0 },
    anticipation: { quietCoffee: 0 },
    workingTogether: { quietCoffee: 0 },
    synchronisation: { quietCoffee: 0 }, // no Gear/Flaps → never triggers
  };
  const missing = [...IMPLEMENTED_MODULES.filter((m) => !EXPECT[m]), ...ABILITY_IDS.filter((a) => !ABILITY_EXPECT[a])];
  (__c.begin(`every module and ability has matrix expectations${missing.length ? ` (missing: ${missing})` : ""}`), __c.done(__c.cmp(`every module and ability has matrix expectations${missing.length ? ` (missing: ${missing})` : ""}`, (missing.length), "===", (0))));

  const subsets = (items) => items.reduce((acc, m) => [...acc, ...acc.map((c) => [...c, m])], [[]]);
  const moduleCombos = subsets(IMPLEMENTED_MODULES);
  const abilitySets = subsets(ABILITY_IDS);
  const excluded = (c) => EXCLUSIVE_MODULE_GROUPS.some((g) => g.filter((m) => c.includes(m)).length > 1);
  let allowed = 0, rejected = 0;
  const bad = [];
  for (const modules of moduleCombos) {
    for (const abilities of abilitySets) {
      const name = [...modules, ...abilities].join("+") || "base";
      // The lobby check uses YUL's own cap (no abilities); the rules are
      // exercised for every ability set a scenario card could allow.
      const valid = SetSetupPayload.safeParse({ scenarioId: "YUL", modules, abilities }).success;
      const yulAllows = !excluded(modules) && abilities.length <= (SCENARIOS.YUL.maxAbilities ?? DEFAULT_MAX_ABILITIES);
      if (valid !== yulAllows) bad.push(`${name}: excluded setup was ${valid ? "accepted" : "rejected"} by the YUL lobby check`);
      if (excluded(modules) || abilities.length > DEFAULT_MAX_ABILITIES) {
        rejected++;
        continue;
      }
      allowed++;
      try {
        const quiet = playRound(init(scn({ rounds: 7, modules, abilities })), level(1, 1));
        const burn = modules.reduce((n, m) => n + EXPECT[m].quietBurn, 0);
        const coffee = 1 + abilities.reduce((n, a) => n + ABILITY_EXPECT[a].quietCoffee, 0);
        if (quiet.phase !== "rolling" || quiet.round !== 2) bad.push(`${name}: quiet round didn't complete (${quiet.outcome?.reason})`);
        if (quiet.kerosene !== 20 - burn) bad.push(`${name}: kerosene ${quiet.kerosene}, expected ${20 - burn}`);
        if (quiet.coffee !== coffee) bad.push(`${name}: coffee ${quiet.coffee}, expected ${coffee}`);
        // Turns on the start space: a level quiet round passes a turn that allows
        // level; a hard-bank-only turn stops exactly the setups that advance
        // (Wind's +3 tail wind takes the quiet round's speed over the blue line).
        const turnTrack = (allowed) => [{ traffic: 0, axisAllowed: allowed }, { traffic: 0, airport: true }];
        const okTurn = playRound(init(scn({ rounds: 7, modules, abilities, approachTrack: turnTrack([0]) })), level(1, 1));
        if (okTurn.outcome) bad.push(`${name}: a turn allowing level stopped a level round (${okTurn.outcome.reason})`);
        const hardTurn = playRound(init(scn({ rounds: 7, modules, abilities, approachTrack: turnTrack([2]) })), level(1, 1));
        const advances = modules.includes("wind");
        if (lostFor(hardTurn, /turn/i) !== advances) bad.push(`${name}: hard turn ${advances ? "not enforced" : "enforced without advancing"}`);
        // Real-Time: the clock runs out once the Axis and Engines are set → the round ends cleanly.
        if (modules.includes("realTime")) {
          let t = roll(init(scn({ rounds: 7, modules, abilities })), [3, 1, 6, 6], [3, 1, 6, 6]);
          for (const [who, v, tg] of [[P, 3, { kind: "axis" }], [C, 3, { kind: "axis" }], [P, 1, { kind: "engine" }], [C, 1, { kind: "engine" }]]) t = place(t, who, v, tg);
          t = reduce(t, { type: "timeUp" }, "").state;
          if (t.phase !== "rolling" || t.round !== 2) bad.push(`${name}: time's up didn't end the round (${t.phase}, ${t.outcome?.reason})`);
        }
        const landing = playRound(
          readyToLand((st) => {
            st.scenario.modules = [...modules];
            st.scenario.abilities = [...abilities];
            modules.forEach((m) => EXPECT[m].prep(st));
          }),
          level(1, 1),
        );
        if (landing.phase !== "won") bad.push(`${name}: legal landing failed (${landing.outcome?.reason})`);
      } catch (e) {
        bad.push(`${name}: threw ${e.message}`);
      }
    }
  }
  (__c.begin(`${allowed} allowed setups play a round and land`), __c.done(__c.falsy(`${allowed} allowed setups play a round and land`, (bad.some((b) => !b.includes("excluded"))))));
  (__c.begin(`${rejected} excluded setups are rejected`), __c.done(__c.falsy(`${rejected} excluded setups are rejected`, (bad.some((b) => b.includes("excluded"))))));
  bad.slice(0, 12).forEach((b) => console.log(`     ↳ ${b}`));
  if (bad.length > 12) console.log(`     ↳ … and ${bad.length - 12} more`);
});

// 28) Wind --------------------------------------------------------------------
test("28) Wind: the ring turns with the Axis and adds to the Engines", async () => {
  const wind = (over = {}) => init(scn({ rounds: 7, modules: ["wind"], ...over }));
  const at = (s, pos) => ((s.windPosition = pos), s);
  const idx = (v) => WIND_RING.indexOf(v); // first space with that wind

  (__c.begin("the ring starts at the white +3"), __c.done(__c.cmp("the ring starts at the white +3", (wind().windPosition), "===", (0)) && __c.cmp("the ring starts at the white +3", (WIND_RING[0]), "===", (3))));

  // level(1,1): Axis 3 vs 3, Engines 1 + 1 = 2 → +3 wind = 5 > blue 4 → advance 1.
  let s = playRound(wind(), level(1, 1));
  (__c.begin("Engines add the wind: 1 + 1 + 3 = 5"), __c.done(__c.cmp("Engines add the wind: 1 + 1 + 3 = 5", (s.lastSpeed), "===", (5))));
  (__c.begin("…and the wind makes the plane advance"), __c.done(__c.cmp("…and the wind makes the plane advance", (s.position), "===", (1))));
  s = playRound(init(scn({ rounds: 7 })), level(1, 1));
  (__c.begin("without the module the wind is ignored"), __c.done(__c.cmp("without the module the wind is ignored", (s.lastSpeed), "===", (2)) && __c.cmp("without the module the wind is ignored", (s.position), "===", (0))));

  s = playRound(at(wind(), idx(-3)), level(1, 1));
  (__c.begin("a head wind can take the speed below the dice total (2 − 3 = −1)"), __c.done(__c.cmp("a head wind can take the speed below the dice total (2 − 3 = −1)", (s.lastSpeed), "===", (-1)) && __c.cmp("a head wind can take the speed below the dice total (2 − 3 = −1)", (s.position), "===", (0))));

  // Axis 4 vs 3 tilts +1 toward the Pilot → the airplane turns 1 space left.
  s = playRound(wind(), { pilot: [4, 1], copilot: [3, 1] });
  (__c.begin("tilt toward the Pilot turns the airplane left (anticlockwise)"), __c.done(__c.cmp("tilt toward the Pilot turns the airplane left (anticlockwise)", (s.axis.offset), "===", (1)) && __c.cmp("tilt toward the Pilot turns the airplane left (anticlockwise)", (s.windPosition), "===", (WIND_RING.length - 1))));
  s = playRound(wind(), { pilot: [3, 1], copilot: [5, 1] });
  (__c.begin("tilt toward the Co-Pilot turns it right by the offset (−2 → 2 spaces)"), __c.done(__c.cmp("tilt toward the Co-Pilot turns it right by the offset (−2 → 2 spaces)", (s.axis.offset), "===", (-2)) && __c.cmp("tilt toward the Co-Pilot turns it right by the offset (−2 → 2 spaces)", (s.windPosition), "===", (2))));

  s = wind();
  s.axis.offset = 2;
  s = playRound(s, level(1, 1));
  (__c.begin("it turns by the current tilt even when the Axis didn't move"), __c.done(__c.cmp("it turns by the current tilt even when the Axis didn't move", (s.axis.offset), "===", (2)) && __c.cmp("it turns by the current tilt even when the Axis didn't move", (s.windPosition), "===", (WIND_RING.length - 2))));
  (__c.begin("level and unmoved: no turn"), __c.done(__c.cmp("level and unmoved: no turn", (playRound(wind(), level(1, 1)).windPosition), "===", (0))));
  s = init(scn({ rounds: 7 }));
  s.axis.offset = 2;
  (__c.begin("without the module the ring never turns"), __c.done(__c.cmp("without the module the ring never turns", (playRound(s, level(1, 1)).windPosition), "===", (0))));

  // Engines resolved before the Axis use the wind from before the turn.
  s = roll(wind(), [1, 4, 6, 6], [1, 3, 6, 6]);
  s = place(s, P, 1, { kind: "engine" });
  s = place(s, C, 1, { kind: "engine" });
  const before = s.lastSpeed;
  s = place(s, P, 4, { kind: "axis" });
  s = place(s, C, 3, { kind: "axis" });
  (__c.begin("Engines resolved first use the wind before the turn"), __c.done(__c.cmp("Engines resolved first use the wind before the turn", (before), "===", (5)) && __c.cmp("Engines resolved first use the wind before the turn", (s.windPosition), "===", (WIND_RING.length - 1))));

  // The landing round: the wind counts toward the speed the Brakes must hold.
  const land = (pos, lvl) => playRound(readyToLand((st) => { st.scenario.modules = ["wind"]; st.windPosition = pos; }), lvl);
  (__c.begin("landing: 1 + 1 + 1 wind = 3 beats Brakes 2 → lost"), __c.done(__c.truthy("landing: 1 + 1 + 1 wind = 3 beats Brakes 2 → lost", (lostFor(land(idx(1), level(1, 1)), /speed too high/)))));
  (__c.begin("landing: 2 + 1 − 1 wind = 2 held by Brakes 2 → won"), __c.done(__c.cmp("landing: 2 + 1 − 1 wind = 2 held by Brakes 2 → won", (land(idx(-1), level(2, 1)).phase), "===", ("won"))));

  (__c.begin("Wind is selectable in the lobby"), __c.done(__c.truthy("Wind is selectable in the lobby", (SetSetupPayload.safeParse({ scenarioId: "YUL", modules: ["wind"] }).success))));
});

// 29) Real-Time ----------------------------------------------------------------
test("29) Real-Time: a 60-second round, time's up, pause and resume", async () => {
  const RT = REAL_TIME_SECONDS * 1000;
  const rt = (over = {}) => init(scn({ rounds: 7, modules: ["realTime"], ...over }));
  const timeUp = (s) => reduce(s, { type: "timeUp" }, "").state;
  const pause = (s, at) => reduce(s, { type: "pauseTimer", at }, "").state;
  const resume = (s, at) => reduce(s, { type: "resumeTimer", at }, "").state;
  const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

  let s = roll(rt(), [3, 1, 6, 6], [3, 1, 6, 6]);
  (__c.begin("the roll starts a 60s countdown from the server's clock"), __c.done(__c.cmp("the roll starts a 60s countdown from the server's clock", (s.timerEndsAt), "===", (ROLL_AT + RT)) && __c.cmp("the roll starts a 60s countdown from the server's clock", (s.timerRemainingMs), "===", (null))));
  const short = roll(rt({ realTimeSeconds: 3 }), [3, 1, 6, 6], [3, 1, 6, 6]);
  (__c.begin("a scenario may shorten the round (test servers do)"), __c.done(__c.cmp("a scenario may shorten the round (test servers do)", (short.timerEndsAt), "===", (ROLL_AT + 3000))));
  (__c.begin("without the module there's no countdown"), __c.done(__c.cmp("without the module there's no countdown", (roll(init(scn({ rounds: 7 })), [3, 1, 6, 6], [3, 1, 6, 6]).timerEndsAt), "===", (null))));
  (__c.begin("a Real-Time roll without the clock is refused"), __c.done(__c.truthy("a Real-Time roll without the clock is refused", (throws(() => reduce(rt(), { type: "roll", pilot: [1, 1, 1, 1], copilot: [1, 1, 1, 1] }, ""), /clock/i)))));

  // Axis + Engines down, Radio dice still in hand: time's up ends the round.
  s = place(s, P, 3, { kind: "axis" });
  s = place(s, C, 3, { kind: "axis" });
  s = place(s, P, 1, { kind: "engine" });
  s = place(s, C, 1, { kind: "engine" });
  s = timeUp(s);
  (__c.begin("time's up with Axis and Engines set: the round ends, unplaced dice ignored"), __c.done(__c.cmp("time's up with Axis and Engines set: the round ends, unplaced dice ignored", (s.phase), "===", ("rolling")) && __c.cmp("time's up with Axis and Engines set: the round ends, unplaced dice ignored", (s.round), "===", (2)) && __c.falsy("time's up with Axis and Engines set: the round ends, unplaced dice ignored", (s.outcome))));
  (__c.begin("…and the countdown is cleared until the next roll"), __c.done(__c.cmp("…and the countdown is cleared until the next roll", (s.timerEndsAt), "===", (null)) && __c.cmp("…and the countdown is cleared until the next roll", (s.timerRemainingMs), "===", (null))));

  s = roll(rt(), [3, 1, 6, 6], [3, 1, 6, 6]);
  s = place(s, P, 3, { kind: "axis" });
  s = place(s, C, 3, { kind: "axis" });
  s = place(s, P, 1, { kind: "engine" });
  s = timeUp(s);
  (__c.begin("time's up with an Engine space empty loses"), __c.done(__c.truthy("time's up with an Engine space empty loses", (lostFor(s, /time ran out/i))) && __c.cmp("time's up with an Engine space empty loses", (s.phase), "===", ("lost"))));
  (__c.begin("time's up before any die loses"), __c.done(__c.truthy("time's up before any die loses", (lostFor(timeUp(roll(rt(), [1, 1, 1, 1], [1, 1, 1, 1])), /time ran out/i)))));

  s = roll(rt({ modules: ["realTime", "kerosene"] }), [3, 1, 6, 6], [3, 1, 6, 6]);
  for (const [who, v, t] of [[P, 3, { kind: "axis" }], [C, 3, { kind: "axis" }], [P, 1, { kind: "engine" }], [C, 1, { kind: "engine" }]]) s = place(s, who, v, t);
  s = timeUp(s);
  (__c.begin("the end of round still runs: an empty Kerosene space burns 6"), __c.done(__c.cmp("the end of round still runs: an empty Kerosene space burns 6", (s.kerosene), "===", (14)) && __c.cmp("the end of round still runs: an empty Kerosene space burns 6", (s.round), "===", (2))));

  s = roll(rt(), [3, 1, 6, 6], [3, 1, 6, 6]);
  s.internHeld = { crew: "pilot", value: 4 };
  s.pendingSwap = { from: "pilot", dieId: 2 };
  s.pendingReroll = "copilot";
  s = timeUp(s);
  (__c.begin("time's up drops anything pending (Intern token, swap, reroll)"), __c.done(__c.cmp("time's up drops anything pending (Intern token, swap, reroll)", (s.internHeld), "===", (null)) && __c.cmp("time's up drops anything pending (Intern token, swap, reroll)", (s.pendingSwap), "===", (null)) && __c.cmp("time's up drops anything pending (Intern token, swap, reroll)", (s.pendingReroll), "===", (null))));

  s = playRound(readyToLand((st) => (st.scenario.modules = ["realTime"])), { pilot: [3, 1], copilot: [3, 1] });
  (__c.begin("all dice placed in time: the round ends normally and the clock stops"), __c.done(__c.cmp("all dice placed in time: the round ends normally and the clock stops", (s.phase), "===", ("won")) && __c.cmp("all dice placed in time: the round ends normally and the clock stops", (s.timerEndsAt), "===", (null))));
  s = roll(readyToLand((st) => (st.scenario.modules = ["realTime"])), [3, 1, 6, 6], [3, 1, 6, 6]);
  for (const [who, v, t] of [[P, 3, { kind: "axis" }], [C, 3, { kind: "axis" }], [P, 1, { kind: "engine" }], [C, 1, { kind: "engine" }]]) s = place(s, who, v, t);
  (__c.begin("time's up in the landing round still checks the landing"), __c.done(__c.cmp("time's up in the landing round still checks the landing", (timeUp(s).phase), "===", ("won"))));

  s = roll(rt(), [1, 1, 6, 6], [6, 1, 6, 6]); // Axis 1 vs 6 → spin
  s = place(s, P, 1, { kind: "axis" });
  s = place(s, C, 6, { kind: "axis" });
  (__c.begin("a mid-round loss stops the clock"), __c.done(__c.cmp("a mid-round loss stops the clock", (s.phase), "===", ("lost")) && __c.cmp("a mid-round loss stops the clock", (s.timerEndsAt), "===", (null))));

  s = roll(rt(), [3, 1, 6, 6], [3, 1, 6, 6]);
  s = pause(s, ROLL_AT + 20_000);
  (__c.begin("pause freezes the time left (40s)"), __c.done(__c.cmp("pause freezes the time left (40s)", (s.timerEndsAt), "===", (null)) && __c.cmp("pause freezes the time left (40s)", (s.timerRemainingMs), "===", (40_000))));
  (__c.begin("no dice can be placed while paused"), __c.done(__c.truthy("no dice can be placed while paused", (throws(() => place(s, P, 3, { kind: "axis" }), /paused/i)))));
  (__c.begin("time's up can't fire while paused"), __c.done(__c.truthy("time's up can't fire while paused", (throws(() => timeUp(s), /not running/i)))));
  s = resume(s, ROLL_AT + 90_000);
  (__c.begin("resume restarts the countdown from the time left"), __c.done(__c.cmp("resume restarts the countdown from the time left", (s.timerEndsAt), "===", (ROLL_AT + 130_000)) && __c.cmp("resume restarts the countdown from the time left", (s.timerRemainingMs), "===", (null))));
  (__c.begin("…and play goes on"), __c.done(__c.cmp("…and play goes on", (place(s, P, 3, { kind: "axis" }).axis.pilot), "===", (3))));
  (__c.begin("pause past the deadline leaves 0s"), __c.done(__c.cmp("pause past the deadline leaves 0s", (pause(roll(rt(), [1, 1, 1, 1], [1, 1, 1, 1]), ROLL_AT + RT + 5_000).timerRemainingMs), "===", (0))));

  (__c.begin("time's up needs the module"), __c.done(__c.truthy("time's up needs the module", (throws(() => timeUp(roll(init(scn({ rounds: 7 })), [1, 1, 1, 1], [1, 1, 1, 1])), /real-time/i)))));
  (__c.begin("time's up needs a round in play"), __c.done(__c.truthy("time's up needs a round in play", (throws(() => timeUp(rt()), /not running/i)))));
  (__c.begin("Real-Time is selectable in the lobby"), __c.done(__c.truthy("Real-Time is selectable in the lobby", (SetSetupPayload.safeParse({ scenarioId: "YUL", modules: ["realTime"] }).success))));
});

// 30) Turns (Approach Track effect) ---------------------------------------------
test("30) Turns: advancing needs the Axis in a permitted position", async () => {
  // Space 0: a right turn (−1/−2, banked toward the Co-Pilot), space 2: left (+1/+2, toward the Pilot).
  const track = [{ traffic: 0, axisAllowed: [-2, -1] }, { traffic: 0 }, { traffic: 0, axisAllowed: [1, 2] }, { traffic: 0 }, { traffic: 0, airport: true }];
  const turns = (over = {}) => init(scn({ rounds: 7, approachTrack: track, axisSpinAt: 3, ...over }));
  // Axis pilot vs copilot sets the tilt (+ toward the Pilot); Engines set the speed.
  const go = (s, axis, engines) => playRound(s, { pilot: [axis[0], engines[0]], copilot: [axis[1], engines[1]] });

  let s = go(turns(), [3, 4], [2, 3]); // tilt −1, speed 5 → advance 1
  (__c.begin("banked as the turn allows: the plane advances"), __c.done(__c.cmp("banked as the turn allows: the plane advances", (s.position), "===", (1)) && __c.falsy("banked as the turn allows: the plane advances", (s.outcome))));
  s = go(turns(), [3, 3], [2, 3]); // level, speed 5
  (__c.begin("level through a right turn: lost"), __c.done(__c.truthy("level through a right turn: lost", (lostFor(s, /turn/i))) && __c.cmp("level through a right turn: lost", (s.position), "===", (0))));
  s = go(turns(), [4, 3], [2, 3]); // tilt +1
  (__c.begin("banked the wrong way: lost"), __c.done(__c.truthy("banked the wrong way: lost", (lostFor(s, /turn/i)))));
  s = turns();
  s.axis.offset = -2;
  s = go(s, [3, 3], [2, 3]);
  (__c.begin("an existing tilt counts even if the Axis didn't move"), __c.done(__c.cmp("an existing tilt counts even if the Axis didn't move", (s.position), "===", (1)) && __c.falsy("an existing tilt counts even if the Axis didn't move", (s.outcome))));
  s = go(turns(), [3, 3], [1, 1]); // speed 2 → no advance
  (__c.begin("no advance: no constraint"), __c.done(__c.cmp("no advance: no constraint", (s.position), "===", (0)) && __c.falsy("no advance: no constraint", (s.outcome)) && __c.cmp("no advance: no constraint", (s.round), "===", (2))));

  // Two spaces: both spaces flown through must allow the tilt.
  s = turns();
  s.position = 1;
  s = go(s, [3, 4], [4, 5]); // tilt −1, speed 9 → advance 2 through spaces 1 and 2
  (__c.begin("advance 2: a turn on the second space flown through still counts"), __c.done(__c.truthy("advance 2: a turn on the second space flown through still counts", (lostFor(s, /turn/i)))));
  s = turns();
  s.axis.offset = -1;
  s = go(s, [3, 3], [4, 5]); // tilt −1 kept, advance 2 through 0 (right turn ✓) and 1 (free)
  (__c.begin("advance 2 through a turn and a free space"), __c.done(__c.cmp("advance 2 through a turn and a free space", (s.position), "===", (2)) && __c.falsy("advance 2 through a turn and a free space", (s.outcome))));
  // Two turns back to back: satisfying only the first still loses on the second.
  const twoTurns = (allowed2, offset) => {
    const t = init(scn({ rounds: 7, axisSpinAt: 3, approachTrack: [{ traffic: 0, axisAllowed: [-2, -1] }, { traffic: 0, axisAllowed: allowed2 }, { traffic: 0 }, { traffic: 0 }, { traffic: 0, airport: true }] }));
    t.axis.offset = offset;
    return go(t, [3, 3], [4, 5]); // tilt kept, speed 9 → advance 2
  };
  s = twoTurns([1, 2], -1); // first turn (right) ✓, second (left) ✗
  (__c.begin("advance 2: only the first turn satisfied → lost on the second"), __c.done(__c.truthy("advance 2: only the first turn satisfied → lost on the second", (lostFor(s, /turn/i))) && __c.cmp("advance 2: only the first turn satisfied → lost on the second", (s.position), "===", (1))));
  s = twoTurns([-1, 0], -1); // both allow −1
  (__c.begin("advance 2: both turns satisfied → flies through both"), __c.done(__c.cmp("advance 2: both turns satisfied → flies through both", (s.position), "===", (2)) && __c.falsy("advance 2: both turns satisfied → flies through both", (s.outcome))));
  s = turns();
  s.position = 1;
  s.axis.offset = 1;
  s = go(s, [3, 3], [2, 3]); // tilt +1, advance 1 from the free space onto the left turn
  (__c.begin("arriving on a turn space doesn't need the tilt yet"), __c.done(__c.cmp("arriving on a turn space doesn't need the tilt yet", (s.position), "===", (2)) && __c.falsy("arriving on a turn space doesn't need the tilt yet", (s.outcome))));

  // The check uses the tilt when the Engines resolve.
  s = roll(turns(), [3, 2, 6, 6], [4, 3, 6, 6]);
  s = place(s, P, 2, { kind: "engine" });
  s = place(s, C, 3, { kind: "engine" });
  (__c.begin("Engines resolved before the Axis use the tilt at that moment"), __c.done(__c.truthy("Engines resolved before the Axis use the tilt at that moment", (lostFor(s, /turn/i)))));

  s = playRound(readyToLand((st) => (st.scenario.approachTrack[1].axisAllowed = [2])), level(1, 1));
  (__c.begin("the landing round doesn't move: a turn on the airport space is ignored"), __c.done(__c.cmp("the landing round doesn't move: a turn on the airport space is ignored", (s.phase), "===", ("won"))));

  (__c.begin("Turns are board data, not a lobby module"), __c.done(__c.falsy("Turns are board data, not a lobby module", (SetSetupPayload.safeParse({ scenarioId: "YUL", modules: ["turns"] }).success))));
  const hnd = SCENARIOS["green-HND"];
  (__c.begin("a board with turns (green Haneda) is playable from the lobby"), __c.done(__c.falsy("a board with turns (green Haneda) is playable from the lobby", (!hnd)) && __c.truthy("a board with turns (green Haneda) is playable from the lobby", (hnd.approachTrack.some((sp) => sp.axisAllowed))) && __c.truthy("a board with turns (green Haneda) is playable from the lobby", (SetSetupPayload.safeParse({ scenarioId: "green-HND", modules: [] }).success))));
});

test("31) Traffic dice: rolled at the start of a round on a space showing them", async () => {
  // Space 0 shows 2 Traffic dice, space 3 one. Five spaces, so the Radio's 6s reach nothing.
  const track = [{ traffic: 0, trafficDice: 2 }, { traffic: 0 }, { traffic: 0 }, { traffic: 0, trafficDice: 1 }, { traffic: 0, airport: true }];
  const dice = (over = {}) => init(scn({ rounds: 7, approachTrack: track, ...over }));
  const hand = [3, 3, 6, 6];

  __c.throws("a round on a Traffic space needs its rolls", () => roll(dice(), hand, hand));
  __c.throws("…exactly one per icon", () => roll(dice(), hand, hand, [3]));
  __c.throws("…and only Traffic die faces (2–5)", () => roll(dice(), hand, hand, [3, 6]));
  __c.throws("no Traffic rolls on a space without icons", () => roll(init(scn({ rounds: 7 })), hand, hand, [3]));

  let s = roll(dice(), hand, hand, [3, 2]);
  (__c.begin("a 3 lands on the third space, counting the Current Position as the first"), __c.done(__c.cmp("a 3 lands on the third space, counting the Current Position as the first", (s.airplanes[2]), "===", (1))));
  (__c.begin("a 2 lands on the space right ahead"), __c.done(__c.cmp("a 2 lands on the space right ahead", (s.airplanes[1]), "===", (1)) && __c.cmp("a 2 lands on the space right ahead", (s.airplanes.join()), "===", ("0,1,1,0,0"))));
  (__c.begin("the rolls are logged"), __c.done(__c.truthy("the rolls are logged", (s.log.some((l) => /Traffic die/i.test(l) && /3/.test(l))))));

  s = roll(dice(), hand, hand, [5, 5]);
  (__c.begin("a result reaching the airport puts the token on it"), __c.done(__c.cmp("a result reaching the airport puts the token on it", (s.airplanes[4]), "===", (2))));
  s = init(scn({ rounds: 7, approachTrack: [{ traffic: 0, trafficDice: 1 }, { traffic: 0 }, { traffic: 0, airport: true }] }));
  s = roll(s, hand, hand, [5]);
  (__c.begin("a result past the airport puts the token on the airport"), __c.done(__c.cmp("a result past the airport puts the token on the airport", (s.airplanes.join()), "===", ("0,0,1"))));

  // Staying put: the space's dice are rolled again next round.
  s = playRound(dice(), { ...level(1, 1), traffic: [4, 4] }); // speed 2 → no advance
  (__c.begin("(setup: the plane stayed on space 0)"), __c.done(__c.cmp("(setup: the plane stayed on space 0)", (s.position), "===", (0)) && __c.cmp("(setup: the plane stayed on space 0)", (s.phase), "===", ("rolling"))));
  __c.throws("staying on a Traffic space rolls again next round", () => roll(s, hand, hand));
  s = roll(s, hand, hand, [4, 4]);
  (__c.begin("…and adds the new tokens"), __c.done(__c.cmp("…and adds the new tokens", (s.airplanes[3]), "===", (4))));

  // Flying through a Traffic space on a 2-space advance doesn't roll it.
  s = init(scn({ rounds: 7, approachTrack: [{ traffic: 0 }, { traffic: 0, trafficDice: 1 }, { traffic: 0 }, { traffic: 0 }, { traffic: 0, airport: true }] }));
  s = playRound(s, level(4, 5)); // speed 9 → advance 2, through space 1 to space 2
  (__c.begin("(setup: advanced 2 to space 2)"), __c.done(__c.cmp("(setup: advanced 2 to space 2)", (s.position), "===", (2)) && __c.cmp("(setup: advanced 2 to space 2)", (s.phase), "===", ("rolling"))));
  s = roll(s, hand, hand);
  (__c.begin("passing through a Traffic space: no roll"), __c.done(__c.cmp("passing through a Traffic space: no roll", (s.phase), "===", ("placement")) && __c.truthy("passing through a Traffic space: no roll", (s.airplanes.every((n) => n === 0)))));

  // Arriving on one does roll, at the start of the next round.
  s = init(scn({ rounds: 7, approachTrack: track }));
  s.position = 2;
  s = playRound(s, level(2, 3)); // speed 5 → advance 1 onto space 3
  (__c.begin("(setup: on space 3)"), __c.done(__c.cmp("(setup: on space 3)", (s.position), "===", (3))));
  s = roll(s, hand, hand, [2]);
  (__c.begin("arriving on a Traffic space rolls next round"), __c.done(__c.cmp("arriving on a Traffic space rolls next round", (s.airplanes[4]), "===", (1))));

  // Supply: 12 Airplane tokens; cleared ones go back to it.
  s = init(scn({ rounds: 7, approachTrack: [{ traffic: 0, trafficDice: 2 }, { traffic: 11 }, { traffic: 0 }, { traffic: 0, airport: true }] }));
  s = roll(s, hand, hand, [3, 3]);
  (__c.begin("only the tokens left in the supply are placed"), __c.done(__c.cmp("only the tokens left in the supply are placed", (s.airplanes.join()), "===", ("0,11,1,0"))));

  const hnd = init(scn({ rounds: 7, approachTrack: APPROACH_TRACKS["red-HND"] }));
  (__c.begin("a real board: red Haneda rolls 3 dice in round 1"), __c.done(__c.cmp("a real board: red Haneda rolls 3 dice in round 1", (roll(hnd, hand, hand, [2, 3, 4]).airplanes.slice(0, 4).join()), "===", ("1,1,2,2"))));
});

// 32) A die with nowhere to go is discarded, so the game can't freeze ---------
test("32) A die that fits no space is discarded (the game never freezes)", async () => {
  let s = roll(init(scn({ rounds: 7 })), [3, 1, 4, 5], [3, 1, 6, 6]);
  // Set up round 1 just before the Pilot's last die: everything the Co-Pilot's
  // last die (a 6) could use is full — Axis, Engines, both Radios and both
  // Concentration spaces; no Flaps space takes a 6 and there's no Coffee.
  const mark = (crew, n) => s.dice[crew].slice(0, n).forEach((d) => (d.placed = true));
  mark("pilot", 3);
  mark("copilot", 3);
  s.axis = { pilot: 3, copilot: 3, offset: 0 };
  s.engines = { pilot: 1, copilot: 1 };
  s.radioCopilot = [1, 1];
  s.concentrationSlots = [{ value: 4, crew: "pilot" }, { value: 6, crew: "copilot" }];
  s.placedThisRound = 6;
  s.turn = "pilot";
  s = place(s, P, 5, { kind: "radio", slot: 0 });
  (__c.begin("the stuck die is discarded and the round ends"), __c.done(__c.cmp("the stuck die is discarded and the round ends", (s.round), "===", (2)) && __c.cmp("the stuck die is discarded and the round ends", (s.phase), "===", ("rolling"))));
  (__c.begin("…with a log line saying why"), __c.done(__c.truthy("…with a log line saying why", (s.log.some((l) => /Co-Pilot's 6 has nowhere to go/.test(l))))));

  // Changing a die without passing the turn (Adaptation) can strand it too.
  let a = roll(init(scn({ rounds: 7, abilities: ["adaptation"] })), [3, 1, 4, 4], [3, 1, 6, 5]);
  a.dice.pilot.forEach((d) => (d.placed = true));
  a.dice.copilot.slice(0, 3).forEach((d) => (d.placed = true));
  a.axis = { pilot: 3, copilot: 3, offset: 0 };
  a.engines = { pilot: 1, copilot: 1 };
  a.radioPilot = 4;
  a.radioCopilot = [6, 6];
  a.concentrationSlots = [{ value: 4, crew: "pilot" }, { value: 6, crew: "copilot" }];
  a.flapsGreen = [true, true, true, false];
  a.flapSlots = [1, 2, 3, null]; // the 5 fits the last Flaps (4/5); a 2 fits nothing free
  a.placedThisRound = 7;
  a.turn = "copilot";
  a = reduce(a, { type: "adapt", dieId: 3 }, C).state; // 5 → 2
  (__c.begin("a die stranded by Adaptation is discarded too"), __c.done(__c.cmp("a die stranded by Adaptation is discarded too", (a.round), "===", (2)) && __c.truthy("a die stranded by Adaptation is discarded too", (a.log.some((l) => /Co-Pilot's 2 has nowhere to go/.test(l))))));
});

test("33) Log wording: an airplane joining at the airport; one die, several dice", () => {
  const short = [{ traffic: 0, trafficDice: 1 }, { traffic: 0 }, { traffic: 0, airport: true }];
  const t = roll(init(scn({ rounds: 7, approachTrack: short })), [3, 3, 6, 6], [3, 3, 6, 6], [5]);
  expect(t.log).toContain("Traffic die: 5 — an airplane joins the approach at the airport.");

  let s = roll(createInitialGameState(scn({ rerollRounds: [1] }), P, C), [1, 1, 1, 1], [6, 6, 6, 6]);
  s = reduce(s, { type: "reroll", dieIds: [0], values: [3] }, P).state;
  expect(s.log).toContain("Pilot spent a Reroll token (1 die).");
  s = reduce(s, { type: "reroll", dieIds: [0, 1], values: [2, 2] }, C).state;
  expect(s.log).toContain("Co-Pilot rerolled 2 dice.");
});
