// Deterministic unit tests for the SkyTeam rules reducer (pure, no server).
// Run with `npm test` (inside a node:22 container, repo bind-mounted).
// Imported from source via tsx (the dist build uses extensionless ESM imports
// that bare `node` can't resolve).
import {
  EXCLUSIVE_MODULE_GROUPS,
  IMPLEMENTED_MODULES,
  SetSetupPayload,
  createInitialGameState,
  reduce,
} from "../packages/shared/src/index.ts";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "  ✅" : "  ❌"} ${label}`);
  if (!cond) failures++;
}
function expectThrow(label, fn) {
  try {
    fn();
    console.log(`  ❌ ${label} (expected an error)`);
    failures++;
  } catch {
    console.log(`  ✅ ${label}`);
  }
}

const P = "P";
const C = "C";

// Drive helpers -------------------------------------------------------------
const roll = (s, pilot, copilot) => reduce(s, { type: "roll", pilot, copilot }, "").state;
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

// 1) Full game to a successful landing --------------------------------------
console.log("1) Full winning game (3 rounds, deploy everything, level, brake)");
{
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
  check("after R1 on airport", s.position === 1);
  check("after R1 round advanced to 2", s.round === 2 && s.phase === "rolling");
  check("aeroBlue rose with 2 gear", s.aeroBlue === 6);

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
  check("after R2 still on airport (held)", s.position === 1);
  check("all gear green", s.gearGreen.every(Boolean));
  check("all flaps green", s.flapsGreen.every(Boolean));
  check("brake deployed", s.brakesDeployed === 1);
  check("axis level", s.axis.offset === 0);
  check("round is now final (3)", s.round === 3);

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
  check("game won", s.phase === "won" && s.outcome?.result === "won");
}

// 2) Spin loss --------------------------------------------------------------
console.log("2) Axis spin loss (difference reaches the spin threshold)");
{
  let s = init(scn());
  s = roll(s, [6, 1, 1, 1], [1, 1, 1, 1]);
  s = place(s, P, 6, { kind: "axis" });
  s = place(s, C, 1, { kind: "axis" }); // diff 5 == spinAt
  check("spin -> lost", s.phase === "lost" && /spin/i.test(s.outcome?.reason ?? ""));
}

// 3) Engine thresholds: 0 / 1 / 2 spaces ------------------------------------
console.log("3) Engine speed thresholds");
{
  const longScn = scn({ approachTrack: [{ traffic: 0 }, { traffic: 0 }, { traffic: 0 }, { traffic: 0, airport: true }], rounds: 7 });
  const advanceWith = (pe, ce) => {
    let s = init(longScn);
    s = roll(s, [pe, 1, 1, 1], [ce, 1, 1, 1]);
    s = place(s, P, pe, { kind: "engine" });
    s = place(s, C, ce, { kind: "engine" });
    return s.position;
  };
  check("sum 4 -> advance 0", advanceWith(2, 2) === 0);
  check("sum 5 -> advance 1", advanceWith(2, 3) === 1);
  check("sum 9 -> advance 2", advanceWith(4, 5) === 2);
}

// 4) Collision: leaving or flying through traffic (but NOT landing on it) -----
console.log("4) Collision: leaving/through traffic loses; landing on it is safe");
{
  // Traffic on the intermediate space (1); advancing 2 flies *through* it.
  const through = scn({ approachTrack: [{ traffic: 0 }, { traffic: 1 }, { traffic: 0 }, { traffic: 0, airport: true }], rounds: 7 });
  let s = init(through);
  s = roll(s, [5, 1, 1, 1], [4, 1, 1, 1]);
  s = place(s, P, 5, { kind: "engine" });
  s = place(s, C, 4, { kind: "engine" }); // sum 9 -> advance 2, through space 1
  check("flying through traffic -> lost", s.phase === "lost" && /collision/i.test(s.outcome?.reason ?? ""));

  // Plane starts on a traffic space (0); moving off it at all collides.
  const from = scn({ approachTrack: [{ traffic: 1 }, { traffic: 0 }, { traffic: 0, airport: true }], rounds: 7 });
  let f = init(from);
  f = roll(f, [3, 1, 1, 1], [2, 1, 1, 1]);
  f = place(f, P, 3, { kind: "engine" });
  f = place(f, C, 2, { kind: "engine" }); // sum 5 -> advance 1 off the occupied space 0
  check("leaving an occupied space -> lost", f.phase === "lost" && /collision/i.test(f.outcome?.reason ?? ""));

  // Traffic on the landing space (1); advancing 1 lands on it — this is SAFE.
  const onto = scn({ approachTrack: [{ traffic: 0 }, { traffic: 1 }, { traffic: 0, airport: true }], rounds: 7 });
  let t = init(onto);
  t = roll(t, [3, 1, 1, 1], [2, 1, 1, 1]);
  t = place(t, P, 3, { kind: "engine" });
  t = place(t, C, 2, { kind: "engine" }); // sum 5 -> advance 1 onto space 1
  check("landing on traffic -> safe", t.phase !== "lost" && t.position === 1);
}

// 5) Overshoot loss ---------------------------------------------------------
console.log("5) Overshoot: advancing while already on the airport");
{
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
  check("reached airport in R1", s.position === 1 && s.round === 2);
  // R2 (copilot leads): advancing again overshoots.
  s = roll(s, [4, 1, 1, 1], [4, 1, 1, 1]);
  s = place(s, C, 4, { kind: "engine" });
  s = place(s, P, 4, { kind: "engine" });
  check("overshoot -> lost", s.phase === "lost" && /overshot/i.test(s.outcome?.reason ?? ""));
}

// 6) Mandatory Axis/Engine reservation --------------------------------------
// The reducer refuses any placement that would strand an open Axis/Engine spot,
// so the end-of-round "mandatory missing" loss can't be reached by legal play.
console.log("6) Mandatory reservation: last dice must go on the Axis and Engine");
{
  let s = init(scn({ rounds: 7 }));
  s = roll(s, [1, 2, 1, 5], [1, 1, 2, 3]);
  s = place(s, P, 1, { kind: "axis" });
  s = place(s, C, 1, { kind: "axis" });
  s = place(s, P, 2, { kind: "landingGear", slot: 0 }); // 1/2
  s = place(s, C, 1, { kind: "flaps", slot: 0 }); // 1/2
  s = place(s, P, 1, { kind: "radio", slot: 0 });
  s = place(s, C, 2, { kind: "flaps", slot: 1 }); // 2/3
  // Pilot holds one die with the Engine still open: it must go on the Engine.
  expectThrow("non-mandatory placement that strands the Engine rejected", () =>
    place(s, P, 5, { kind: "landingGear", slot: 2 }),
  );
  s = place(s, P, 5, { kind: "engine" });
  check("engine placement still allowed", s.engines.pilot === 5);
}

// 7) Radio clears the correct space -----------------------------------------
console.log("7) Radio clears the airplane N-1 spaces ahead");
{
  const s0 = scn({ approachTrack: [{ traffic: 0 }, { traffic: 1 }, { traffic: 0, airport: true }], rounds: 7 });
  let s = init(s0);
  s = roll(s, [2, 1, 1, 1], [1, 1, 1, 1]);
  s = place(s, P, 2, { kind: "radio", slot: 0 }); // value 2 -> space 0+1 = 1
  check("airplane on space 1 cleared", s.airplanes[1] === 0);
}

// 8) Coffee modifies a die's value ------------------------------------------
console.log("8) Concentration grants Coffee; Coffee shifts a placed die's value");
{
  let s = init(scn({ rounds: 7 }));
  s = roll(s, [3, 1, 1, 1], [1, 1, 1, 1]);
  s = place(s, P, 3, { kind: "concentration", slot: 0 });
  check("gained a coffee", s.coffee === 1);
  // Co-Pilot turn now; give them a die we shift. Re-roll not needed; use C's 1
  // as flaps slot0 needs 1/2 — shift a 1 up to 2 is pointless; instead shift a
  // value 1 die into flaps via +1 is unnecessary. Test the clamp + spend:
  expectThrow("coffee cannot exceed 1-6", () => place(s, C, 1, { kind: "flaps", slot: 0 }, -1));
  const s2 = place(s, C, 1, { kind: "flaps", slot: 0 }, 1); // 1 -> 2, still valid for 1/2
  check("coffee spent", s2.coffee === 0);
}

// 9) Reroll consumes a token and changes dice -------------------------------
console.log("9) Reroll token (granted on rerollRounds) replaces dice");
{
  let s = createInitialGameState(scn({ rerollRounds: [1] }), P, C);
  s = roll(s, [1, 1, 1, 1], [6, 6, 6, 6]);
  check("token granted on round 1", s.rerollTokens === 1);
  const newVals = [3, 4];
  const ids = [0, 1];
  s = reduce(s, { type: "reroll", dieIds: ids, values: newVals }, P).state;
  check("token consumed", s.rerollTokens === 0);
  check("pilot dice rerolled", s.dice.pilot[0].value === 3 && s.dice.pilot[1].value === 4);
}

// 10) Deploy-order enforcement ----------------------------------------------
console.log("10) Flaps/Brakes must deploy in order");
{
  let s = init(scn({ rounds: 7 }));
  s = roll(s, [2, 1, 1, 1], [3, 1, 1, 1]);
  // Pilot to act first; brakes slot 1 (a 4) before slot 0 is illegal.
  expectThrow("brake out of order rejected", () => place(s, P, 4, { kind: "brakes", slot: 1 }));
  // Co-Pilot flaps slot 1 before slot 0 is illegal (after a pilot move).
  let s2 = place(s, P, 1, { kind: "axis" });
  expectThrow("flaps out of order rejected", () => place(s2, C, 3, { kind: "flaps", slot: 1 }));
}

// 11) A deployed gear/flap section can't be filled again in a later round ----
console.log("11) Re-placing on an already-deployed section is rejected (no wasted die)");
{
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
  check("gear/flaps 0 deployed; round advanced", s.gearGreen[0] && s.flapsGreen[0] && s.round === 2 && s.phase === "rolling");
  // R2 (copilot leads): the per-round flags reset, but the sections stay down.
  s = roll(s, [2, 1, 1, 1], [2, 1, 1, 1]);
  expectThrow("re-deploying flaps slot 0 rejected", () => place(s, C, 2, { kind: "flaps", slot: 0 }));
  s = place(s, C, 2, { kind: "flaps", slot: 1 }); // valid next flap -> turn passes to pilot
  expectThrow("re-deploying gear slot 0 rejected", () => place(s, P, 2, { kind: "landingGear", slot: 0 }));
}

// 12) Joint reroll: active player initiates, the other player then responds ---
console.log("12) Joint reroll: one token, initiator picks dice, the other player responds");
{
  // a/b) initiator rerolls >=1 -> token spent + pending set; responder rerolls a
  //      subset -> pending cleared, turn order untouched.
  let s = init(scn({ rerollRounds: [1], rounds: 7 }));
  s = roll(s, [2, 2, 2, 2], [3, 3, 3, 3]); // round 1: pilot is the active player, 1 token granted
  check("token granted on the reroll round", s.rerollTokens === 1);
  const pIds = s.dice.pilot.map((d) => d.id);
  s = reroll(s, P, [pIds[0], pIds[1]], [5, 6]); // pilot initiates on two of their dice
  check("initiator's chosen dice rerolled", s.dice.pilot[0].value === 5 && s.dice.pilot[1].value === 6);
  check("one token spent for the whole joint event", s.rerollTokens === 0);
  check("now awaiting the co-pilot's reroll", s.pendingReroll === "copilot");
  const cIds = s.dice.copilot.map((d) => d.id);
  s = reroll(s, C, [cIds[0]], [1]); // responder rerolls one of their own
  check("responder's chosen die rerolled", s.dice.copilot[0].value === 1);
  check("reroll fully resolved", s.pendingReroll === null);
  check("turn order unchanged by the reroll", s.turn === "pilot");

  // c) the responder may decline by rerolling zero dice.
  let s2 = init(scn({ rerollRounds: [1], rounds: 7 }));
  s2 = roll(s2, [2, 2, 2, 2], [3, 3, 3, 3]);
  s2 = reroll(s2, P, [s2.dice.pilot[0].id], [6]);
  const before = JSON.stringify(s2.dice.copilot.map((d) => d.value));
  s2 = reroll(s2, C, [], []); // decline
  check("responder declining clears the pending reroll", s2.pendingReroll === null);
  check("declining leaves the responder's dice intact", JSON.stringify(s2.dice.copilot.map((d) => d.value)) === before);

  // d) while a reroll is pending, no other command may resolve (race lock).
  let s3 = init(scn({ rerollRounds: [1], rounds: 7 }));
  s3 = roll(s3, [2, 2, 2, 2], [3, 3, 3, 3]);
  s3 = reroll(s3, P, [s3.dice.pilot[0].id], [6]); // pending = copilot
  expectThrow("placeDie rejected while a reroll is pending", () =>
    reduce(s3, { type: "placeDie", dieId: s3.dice.pilot[1].id, target: { kind: "axis" } }, P),
  );
  let lockMsg = "";
  try {
    reroll(s3, P, [s3.dice.pilot[1].id], [4]);
  } catch (e) {
    lockMsg = e.message;
  }
  check("second initiation blocked by the pending lock (not token count)", /pending|progress|waiting|finish/i.test(lockMsg));

  // e) the initiator must reroll at least one die.
  let s4 = init(scn({ rerollRounds: [1], rounds: 7 }));
  s4 = roll(s4, [2, 2, 2, 2], [3, 3, 3, 3]);
  expectThrow("initiator with zero dice rejected", () => reroll(s4, P, [], []));

  // f) only the active player may initiate a reroll.
  let s5 = init(scn({ rerollRounds: [1], rounds: 7 }));
  s5 = roll(s5, [2, 2, 2, 2], [3, 3, 3, 3]); // turn = pilot
  expectThrow("non-active player cannot initiate", () => reroll(s5, C, [s5.dice.copilot[0].id], [4]));

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
  check("setup: co-pilot active, pilot out of dice", s6.turn === "copilot" && s6.dice.pilot.every((d) => d.placed));
  const lastC = s6.dice.copilot.find((d) => !d.placed).id;
  s6 = reroll(s6, C, [lastC], [5]); // pilot (the responder) has nothing to reroll
  check("auto-completed -> nothing left pending", s6.pendingReroll === null);
  check("auto-complete still spent the token", s6.rerollTokens === 0);
}

// Shared driver for the remaining sections: play one full round with the given
// Axis/Engine values; every crew's two spare dice (6s) go on harmless spaces
// (Radio past the end of the track, Concentration).
function playRound(s, { pilot, copilot }) {
  s = roll(s, [pilot[0], pilot[1], 6, 6], [copilot[0], copilot[1], 6, 6]);
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

// 13) Landing conditions --------------------------------------------------------
console.log("13) Landing: each unmet condition fails the landing");
{
  check("baseline: all conditions met -> won", playRound(readyToLand(), level(1, 1)).phase === "won");
  check("speed above brakes -> lost", lostFor(playRound(readyToLand(), level(1, 2)), /speed too high/));
  check("no brakes deployed -> lost", lostFor(playRound(readyToLand((s) => (s.brakesDeployed = 0)), level(1, 1)), /speed too high/));
  check(
    "speed equal to max brakes (6) -> won",
    playRound(readyToLand((s) => (s.brakesDeployed = 3)), level(3, 3)).phase === "won",
  );
  check("plane tilted -> lost", lostFor(playRound(readyToLand(), { pilot: [4, 1], copilot: [3, 1] }), /not level/));
  check("airplane left on track -> lost", lostFor(playRound(readyToLand((s) => (s.airplanes[0] = 1)), level(1, 1)), /airplanes still/));
  check("not on the airport -> lost", lostFor(playRound(readyToLand((s) => (s.position = 0)), level(1, 1)), /did not reach/));
  check("gear incomplete -> lost", lostFor(playRound(readyToLand((s) => (s.gearGreen[2] = false)), level(1, 1)), /landing gear/));
  check("flaps incomplete -> lost", lostFor(playRound(readyToLand((s) => (s.flapsGreen[3] = false)), level(1, 1)), /flaps/));
  const multi = playRound(readyToLand((s) => ((s.flapsGreen[0] = false), (s.brakesDeployed = 0))), level(1, 1));
  check("multiple failures are all reported", lostFor(multi, /flaps/) && /speed too high/.test(multi.outcome.reason));
}

// 14) Reroll tokens across rounds ----------------------------------------------
console.log("14) Reroll tokens: granted on each listed round, unused tokens carry over");
{
  let s = init(scn({ rounds: 7, rerollRounds: [1, 3] }));
  s = playRound(s, level(1, 1));
  check("round 1 grants a token", s.rerollTokens === 1);
  s = playRound(s, level(1, 1));
  check("round 2 grants none", s.rerollTokens === 1);
  s = roll(s, [1, 1, 1, 1], [1, 1, 1, 1]);
  check("round 3 grants a second token (carried over)", s.round === 3 && s.rerollTokens === 2);
}

// 15) Illegal commands ----------------------------------------------------------
console.log("15) Illegal commands are rejected");
{
  const fresh = init(scn({ rounds: 7, rerollRounds: [1] }));
  expectThrow("reroll before the dice are rolled", () => reroll(fresh, P, [0], [3]));
  expectThrow("placeDie before the dice are rolled", () =>
    reduce(fresh, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, P),
  );
  const s = roll(fresh, [1, 2, 3, 4], [1, 2, 3, 4]);
  expectThrow("a second roll mid-round", () => roll(s, [1, 1, 1, 1], [1, 1, 1, 1]));
  expectThrow("a roll with the wrong dice count", () => roll(fresh, [1, 1, 1], [1, 1, 1, 1]));
  expectThrow("spending Coffee you don't have", () => place(s, P, 1, { kind: "axis" }, 1));
  expectThrow("placing out of turn", () => place(s, C, 1, { kind: "axis" }));
  expectThrow("a non-crew player placing", () =>
    reduce(s, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, "stranger"),
  );
  expectThrow("Co-Pilot deploying Landing Gear", () => place(place(s, P, 1, { kind: "axis" }), C, 1, { kind: "landingGear", slot: 0 }));
  expectThrow("Pilot deploying Flaps", () => place(s, P, 1, { kind: "flaps", slot: 0 }));
  expectThrow("rerolling a placed die", () => reroll(place(place(s, P, 1, { kind: "axis" }), C, 1, { kind: "axis" }), P, [0], [5]));
  const noTokens = roll(init(scn({ rounds: 7 })), [1, 2, 3, 4], [1, 2, 3, 4]);
  expectThrow("reroll with no tokens", () => reroll(noTokens, P, [0], [3]));
  const won = playRound(readyToLand(), level(1, 1));
  expectThrow("placing after the game is over", () =>
    reduce(won, { type: "placeDie", dieId: 0, target: { kind: "axis" } }, P),
  );
  check("reducer never mutates its input", fresh.phase === "rolling" && fresh.dice.pilot.length === 0);
}

// 16) Kerosene module -----------------------------------------------------------
console.log("16) Kerosene: either crew burns a die's value; empty space burns 6; dry tank loses");
{
  const kscn = (over) => scn({ rounds: 7, modules: ["kerosene"], ...over });
  const lostKero = (s) => lostFor(s, /kerosene/i);

  let s = roll(init(kscn()), [1, 1, 3, 6], [1, 1, 2, 6]);
  check("tank starts at 20", s.kerosene === 20 && s.keroseneSlot === null);
  s = place(s, P, 3, { kind: "kerosene" });
  check("pilot's 3 burns 3 at once", s.kerosene === 17 && s.keroseneSlot?.value === 3 && s.keroseneSlot.crew === "pilot");
  expectThrow("space holds one die per round", () => place(s, C, 2, { kind: "kerosene" }));

  // Finish the round with the space used: no idle burn on top.
  s = place(s, C, 1, { kind: "axis" });
  s = place(s, P, 1, { kind: "axis" });
  s = place(s, C, 1, { kind: "engine" });
  s = place(s, P, 1, { kind: "engine" });
  s = place(s, C, 6, { kind: "radio", slot: 0 });
  s = place(s, P, 6, { kind: "concentration", slot: 0 });
  s = place(s, C, 2, { kind: "concentration", slot: 1 });
  check("used space -> no idle burn", s.round === 2 && s.kerosene === 17);
  s = roll(s, [1, 1, 1, 1], [5, 1, 1, 1]);
  check("space is free again next round", s.keroseneSlot === null);
  const byCopilot = place(s, C, 5, { kind: "kerosene" }); // round 2: co-pilot leads
  check("co-pilot may use it too", byCopilot.kerosene === 12 && byCopilot.keroseneSlot?.crew === "copilot");

  check("empty space burns 6 at round end", playRound(init(kscn()), level(1, 1)).kerosene === 14);

  const noModule = roll(init(scn({ rounds: 7 })), [3, 1, 1, 1], [1, 1, 1, 1]);
  expectThrow("rejected when the module is not in play", () => place(noModule, P, 3, { kind: "kerosene" }));
  check("no idle burn without the module", playRound(init(scn({ rounds: 7 })), level(1, 1)).kerosene === 20);

  const nearlyDry = roll(init(kscn()), [3, 1, 1, 1], [1, 1, 1, 1]);
  nearlyDry.kerosene = 3;
  const dry = place(nearlyDry, P, 3, { kind: "kerosene" });
  check("a die that empties the tank loses immediately", lostKero(dry) && dry.kerosene === 0);

  const six = init(kscn());
  six.kerosene = 6;
  check("idle burn that empties the tank loses", lostKero(playRound(six, level(1, 1))));

  const withKero = (fuel) => (st) => ((st.scenario.modules = ["kerosene"]), (st.kerosene = fuel));
  check("final round: idle burn to empty beats a good landing", lostKero(playRound(readyToLand(withKero(6)), level(1, 1))));
  check("final round: fuel to spare -> landing still counts", playRound(readyToLand(withKero(7)), level(1, 1)).phase === "won");
}

// 17) Kerosene Leak module -------------------------------------------------------
console.log("17) Kerosene Leak: Engines burn |difference| + 1 when both are seated; no die space");
{
  const lscn = (over) => scn({ rounds: 7, modules: ["keroseneLeak"], ...over });
  const lostKero = (s) => lostFor(s, /kerosene/i);

  let s = roll(init(lscn()), [5, 1, 1, 1], [2, 1, 1, 1]);
  s = place(s, P, 5, { kind: "engine" });
  check("one Engine die alone burns nothing", s.kerosene === 20);
  s = place(s, C, 2, { kind: "engine" }); // speed 7: advance 1 onto the airport, no overshoot
  check("Engines 5 vs 2 burn 4 at once (mid-round)", s.kerosene === 16 && s.round === 1 && s.phase === "placement");
  expectThrow("Kerosene space is not usable with the Leak", () => place(s, P, 1, { kind: "kerosene" }));

  check("matching Engines still leak 1; no idle -6 at round end", playRound(init(lscn()), level(1, 1)).kerosene === 19);

  const low = roll(init(lscn()), [1, 1, 1, 1], [5, 1, 1, 1]);
  low.kerosene = 5;
  const posBefore = low.position;
  let dry = place(low, P, 1, { kind: "engine" });
  dry = place(dry, C, 5, { kind: "engine" }); // speed 6 would advance 1 — but the leak (5) empties the tank first
  check("a leak that empties the tank loses immediately", lostKero(dry) && dry.kerosene === 0);
  check("…before the plane moves", dry.position === posBefore);

  const withLeak = (fuel) => (st) => ((st.scenario.modules = ["keroseneLeak"]), (st.kerosene = fuel));
  check("final round: leak to empty beats a good landing", lostKero(playRound(readyToLand(withLeak(1)), level(1, 1))));
  check("final round: fuel to spare -> landing still counts", playRound(readyToLand(withLeak(2)), level(1, 1)).phase === "won");
}

// 18) Ice Brakes module ------------------------------------------------------------
console.log("18) Ice Brakes: steps 2→5, a same-value pair (top Pilot, bottom either) per step");
{
  const iscn = (over) => scn({ rounds: 7, modules: ["iceBrakes"], ...over });
  const ice = (slot, space) => ({ kind: "iceBrakes", slot, space });

  // Two steps completed in one round (the marker can advance more than once).
  let s = roll(init(iscn()), [2, 3, 1, 1], [2, 3, 1, 1]);
  s = place(s, P, 2, ice(0, "top"));
  check("half a pair doesn't move the marker", s.brakesDeployed === 0 && s.iceBrakeSlots[0].top === 2);
  expectThrow("next step stays shut until this one is done", () => place(s, C, 3, ice(1, "bottom")));
  s = place(s, C, 2, ice(0, "bottom"));
  check("a matching pair passes step 2", s.brakesDeployed === 1 && s.iceBrakeSlots[0].bottom?.crew === "copilot");
  s = place(s, P, 3, ice(1, "top"));
  s = place(s, C, 3, ice(1, "bottom"));
  check("…and step 3 in the same round", s.brakesDeployed === 2);
  s = place(s, P, 1, { kind: "axis" });
  s = place(s, C, 1, { kind: "axis" });
  s = place(s, P, 1, { kind: "engine" });
  s = place(s, C, 1, { kind: "engine" });
  s = roll(s, [4, 1, 1, 1], [4, 1, 1, 1]);
  check("marker keeps its place; spaces clear next round", s.brakesDeployed === 2 && s.iceBrakeSlots.every((x) => x.top === null && x.bottom === null));

  // Placement rules.
  const r = roll(init(iscn()), [2, 3, 1, 1], [2, 2, 1, 1]);
  expectThrow("wrong value rejected", () => place(r, P, 3, ice(0, "top")));
  expectThrow("a later step rejected out of order", () => place(r, P, 3, ice(1, "top")));
  expectThrow("base Brakes are replaced", () => place(r, P, 2, { kind: "brakes", slot: 0 }));
  const pBottom = place(r, P, 2, ice(0, "bottom"));
  check("the Pilot may take the bottom space (bottom first is fine)", pBottom.iceBrakeSlots[0].bottom?.crew === "pilot");
  expectThrow("the Co-Pilot may not take the top space", () => place(pBottom, C, 2, ice(0, "top")));
  expectThrow("a taken space is rejected", () => place(pBottom, C, 2, ice(0, "bottom")));
  const noIce = roll(init(scn({ rounds: 7 })), [2, 1, 1, 1], [1, 1, 1, 1]);
  expectThrow("rejected when the module is not in play", () => place(noIce, P, 2, ice(0, "top")));

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
  check("a half-filled step is cleared next round, marker unmoved", half.brakesDeployed === 0 && half.iceBrakeSlots[0].top === null);

  // Landing.
  const withIce = (steps) => (st) => ((st.scenario.modules = ["iceBrakes"]), (st.brakesDeployed = steps));
  check("all four steps, speed 5 -> landed", playRound(readyToLand(withIce(4)), level(2, 3)).phase === "won");
  check("all four steps, speed 6 -> too fast", lostFor(playRound(readyToLand(withIce(4)), level(3, 3)), /speed too high/));
  check("marker not past the 5 -> lost", lostFor(playRound(readyToLand(withIce(3)), level(1, 1)), /ice brakes not fully deployed/));
}

// 19) Ice Brakes + Kerosene Leak together ----------------------------------------
console.log("19) Ice Brakes + Kerosene Leak in one game");
{
  const both = ["iceBrakes", "keroseneLeak"];
  check("setup accepted", SetSetupPayload.safeParse({ scenarioId: "YUL", modules: both }).success);

  // One round exercising both: a pair on the 2 step, Engines 1 vs 1 leak 1.
  let s = roll(init(scn({ rounds: 7, modules: both })), [2, 1, 1, 1], [2, 1, 1, 1]);
  s = place(s, P, 2, { kind: "iceBrakes", slot: 0, space: "top" });
  s = place(s, C, 2, { kind: "iceBrakes", slot: 0, space: "bottom" });
  s = place(s, P, 1, { kind: "engine" });
  s = place(s, C, 1, { kind: "engine" });
  check("both effects apply in the same round", s.brakesDeployed === 1 && s.kerosene === 19);
  expectThrow("still no Kerosene die space", () => place(s, P, 1, { kind: "kerosene" }));

  const prep = (fuel) => (st) => ((st.scenario.modules = [...both]), (st.brakesDeployed = 4), (st.kerosene = fuel));
  const landed = playRound(readyToLand(prep(20)), level(2, 3)); // speed 5 ≤ ice 5; leak 2
  check("speed 5 lands on full Ice Brakes; the leak still burns", landed.phase === "won" && landed.kerosene === 18);
  check("a leak that empties the tank beats a valid Ice Brakes landing", lostFor(playRound(readyToLand(prep(2)), level(2, 3)), /kerosene/i));
  const short = (st) => ((st.scenario.modules = [...both]), (st.brakesDeployed = 3));
  check("Ice Brakes short of the 5 still fails with the Leak on", lostFor(playRound(readyToLand(short), level(1, 1)), /ice brakes not fully deployed/));
}

// 20) Intern module -------------------------------------------------------------------
console.log("20) Intern: train with a die ≠ next token, place the token at once, all trained to land");
{
  const nscn = scn({ rounds: 7, modules: ["intern"] });
  const initN = (tokens) => createInitialGameState(nscn, P, C, { internTokens: tokens });
  const intern = (st, who, target) => reduce(st, { type: "placeIntern", target }, who).state;
  const TOK = [3, 1, 5, 6, 2, 4];

  let s = roll(initN(TOK), [2, 3, 1, 1], [4, 1, 6, 6]);
  expectThrow("training die equal to the next token rejected", () => place(s, P, 3, { kind: "intern" }));
  s = place(s, P, 2, { kind: "intern" });
  check("Pilot takes the leftmost token and holds it", s.internTokens[0] === null && s.internHeld?.crew === "pilot" && s.internHeld.value === 3);
  check("…the training die is spent, turn stays", s.internSlots.pilot === 2 && s.placedThisRound === 1 && s.turn === "pilot");
  expectThrow("no die may be placed while the token is held", () => place(s, P, 1, { kind: "axis" }));
  expectThrow("no reroll while the token is held", () => reroll(s, P, [1], [5]));
  expectThrow("the other crew can't place it", () => intern(s, C, { kind: "axis" }));
  expectThrow("not on Concentration", () => intern(s, P, { kind: "concentration", slot: 0 }));
  expectThrow("not on the Intern board", () => intern(s, P, { kind: "intern" }));
  s = intern(s, P, { kind: "radio", slot: 0 });
  check("token placed as a 3 on the Pilot's Radio; marked as Intern-filled", s.radioPilot === 3 && s.internPlaced.includes('pilot:{"kind":"radio","slot":0}'));
  check("then the turn passes", s.internHeld === null && s.turn === "copilot");
  expectThrow("Co-Pilot's die equal to its next token (rightmost 4) rejected", () => place(s, C, 4, { kind: "intern" }));
  s = place(s, C, 6, { kind: "intern" });
  check("Co-Pilot takes the rightmost token", s.internTokens[5] === null && s.internHeld?.value === 4);
  s = intern(s, C, { kind: "axis" });
  check("a token can fill the Axis", s.axis.copilot === 4 && s.internPlaced.includes('copilot:{"kind":"axis"}'));
  expectThrow("one training per crew per round", () => place(s, P, 3, { kind: "intern" }));

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
  check("8th die trained: round waits for the token", e.round === 1 && e.phase === "placement" && e.internHeld?.value === 4);
  e = intern(e, C, { kind: "radio", slot: 1 });
  check("…placing it ends the round", e.round === 2 && e.phase === "rolling");
  e = roll(e, [1, 1, 1, 1], [1, 1, 1, 1]);
  check("next round: training spaces and Intern marks reset, trained tokens stay gone",
    e.internSlots.pilot === null && e.internSlots.copilot === null && e.internPlaced.length === 0 && e.internTokens[5] === null);

  // The token respects the Axis/Engine reservation.
  let r = roll(initN(TOK), [1, 1, 1, 1], [2, 6, 1, 1]);
  r = place(r, P, 1, { kind: "radio", slot: 0 });
  r = place(r, C, 1, { kind: "radio", slot: 0 });
  r = place(r, P, 1, { kind: "concentration", slot: 0 });
  r = place(r, C, 2, { kind: "intern" }); // Co-Pilot: 2 dice left + the token, Axis and Engine open
  const r2 = intern(r, C, { kind: "radio", slot: 1 });
  check("token may take a free space while the dice left still cover Axis + Engine", r2.radioCopilot[1] === 4);
  let r3 = roll(initN(TOK), [1, 1, 1, 1], [2, 6, 1, 1]);
  r3.turn = "copilot";
  r3.dice.copilot.slice(2).forEach((d) => (d.placed = true)); // Co-Pilot down to its 2 and 6
  r3 = place(r3, C, 2, { kind: "intern" }); // 1 die left + the token, Axis and Engine open
  expectThrow("…but not when the dice left can't", () => intern(r3, C, { kind: "radio", slot: 0 }));
  check("…then it must fill the Axis or Engine", intern(r3, C, { kind: "axis" }).axis.copilot === 4);

  // Training is refused if the token would have nowhere to go.
  const stuck = roll(initN([1, 2, 3, 4, 5, 6]), [1, 1, 1, 1], [1, 1, 1, 2]);
  stuck.turn = "copilot";
  stuck.axis.copilot = 1;
  stuck.engines.copilot = 1;
  stuck.radioCopilot = [1, 1];
  stuck.dice.copilot.slice(0, 3).forEach((d) => (d.placed = true));
  expectThrow("a 6 with no legal space (Concentration excluded) can't be trained", () => place(stuck, C, 2, { kind: "intern" }));

  expectThrow("rejected when the module is not in play", () => place(roll(init(scn({ rounds: 7 })), [2, 1, 1, 1], [1, 1, 1, 1]), P, 2, { kind: "intern" }));

  // Landing.
  const withIntern = (left) => (st) => ((st.scenario.modules = ["intern"]), (st.internTokens = [null, null, null, null, null, left]));
  check("untrained token at landing -> lost", lostFor(playRound(readyToLand(withIntern(5)), level(1, 1)), /intern not fully trained/));
  check("fully trained -> landed", playRound(readyToLand(withIntern(null)), level(1, 1)).phase === "won");
}

// 22) Control & Mastery (Special Abilities, passive) --------------------------------
console.log("22) Control & Mastery");
{
  const ab = (abilities) => scn({ rounds: 7, abilities });
  let s = roll(init(ab(["control"])), [3, 1, 1, 1], [3, 1, 1, 1]);
  s = place(s, P, 3, { kind: "axis" });
  s = place(s, C, 3, { kind: "axis" });
  check("Control: matching Axis dice give a Coffee", s.coffee === 1);
  const noCtl = place(place(roll(init(scn({ rounds: 7 })), [3, 1, 1, 1], [3, 1, 1, 1]), P, 3, { kind: "axis" }), C, 3, { kind: "axis" });
  check("…not without the card", noCtl.coffee === 0);
  const unequal = place(place(roll(init(ab(["control"])), [3, 1, 1, 1], [2, 1, 1, 1]), P, 3, { kind: "axis" }), C, 2, { kind: "axis" });
  check("…not for different values", unequal.coffee === 0);
  const full = roll(init(ab(["control"])), [3, 1, 1, 1], [3, 1, 1, 1]);
  full.coffee = 3;
  check("…capped at 3", place(place(full, P, 3, { kind: "axis" }), C, 3, { kind: "axis" }).coffee === 3);

  let m = roll(init(ab(["mastery"])), [1, 1, 1, 1], [2, 1, 1, 1]);
  m.rerollTokens = 1;
  m = reroll(m, P, [0], [1]); // spend the token → back in the supply
  m = reroll(m, C, [], []); // co-pilot declines
  check("spending a Reroll puts it back in the supply", m.rerollTokens === 0 && m.rerollSpent === 1);
  m = place(m, P, 1, { kind: "engine" });
  m = place(m, C, 1, { kind: "engine" });
  check("Mastery: matching Engine dice regain the spent Reroll", m.rerollTokens === 1 && m.rerollSpent === 0);
  let m2 = roll(init(ab(["mastery"])), [1, 1, 1, 1], [1, 1, 1, 1]);
  m2 = place(place(m2, P, 1, { kind: "engine" }), C, 1, { kind: "engine" });
  check("…but only if a token is in the supply", m2.rerollTokens === 0);
  let m3 = roll(init(scn({ rounds: 7 })), [1, 1, 1, 1], [1, 1, 1, 1]);
  m3.rerollSpent = 1;
  m3 = place(place(m3, P, 1, { kind: "engine" }), C, 1, { kind: "engine" });
  check("…and only with the card", m3.rerollTokens === 0);
}

// 23) Adaptation ------------------------------------------------------------------
console.log("23) Adaptation");
{
  const adapt = (st, who, dieId) => reduce(st, { type: "adapt", dieId }, who).state;
  const s0 = roll(init(scn({ rounds: 7, abilities: ["adaptation"] })), [1, 2, 3, 4], [6, 5, 4, 3]);
  const s1 = adapt(s0, P, 0);
  check("a 1 turns to a 6", s1.dice.pilot[0].value === 6 && s1.adaptationUsed.pilot);
  expectThrow("once per game per player", () => adapt(s1, P, 1));
  check("the other player may use theirs on the Pilot's turn", adapt(s1, C, 1).dice.copilot[1].value === 2);
  expectThrow("not on a placed die", () => adapt(place(s0, P, 1, { kind: "axis" }), P, 0));
  expectThrow("not without the card", () => adapt(roll(init(scn({ rounds: 7 })), [1, 1, 1, 1], [1, 1, 1, 1]), P, 0));
  expectThrow("not while a reroll is pending", () => {
    const r = roll(init(scn({ rounds: 7, rerollRounds: [1], abilities: ["adaptation"] })), [1, 1, 1, 1], [1, 1, 1, 1]);
    adapt(reroll(r, P, [0], [2]), C, 0);
  });
  // Jump to round 2 (handleRoll doesn't check the previous round's placements).
  const nextRound = roll(Object.assign(structuredClone(s1), { phase: "rolling", round: 2 }), [1, 1, 1, 1], [1, 1, 1, 1]);
  check("still used up in later rounds", nextRound.adaptationUsed.pilot === true);
}

// 24) Anticipation ----------------------------------------------------------------
console.log("24) Anticipation");
{
  const ant = (st, who, dieId, value) => reduce(st, { type: "anticipate", dieId, value }, who).state;
  const s0 = roll(init(scn({ rounds: 7, abilities: ["anticipation"] })), [1, 1, 1, 1], [2, 2, 2, 2]);
  const s1 = ant(s0, P, 2, 6);
  check("the First Player rerolls one die before placing", s1.dice.pilot[2].value === 6 && s1.anticipated);
  check("…and it's still their turn", s1.turn === "pilot");
  expectThrow("once per round", () => ant(s1, P, 1, 5));
  expectThrow("only the First Player", () => ant(s0, C, 0, 5));
  expectThrow("only before their first die", () => ant(place(s0, P, 1, { kind: "axis" }), P, 1, 5));
  expectThrow("not without the card", () => ant(roll(init(scn({ rounds: 7 })), [1, 1, 1, 1], [1, 1, 1, 1]), P, 0, 5));
  const r2 = roll(Object.assign(structuredClone(s1), { phase: "rolling", round: 2 }), [1, 1, 1, 1], [3, 3, 3, 3]);
  check("round 2: anticipation resets and the Co-Pilot (now leading) may use it", !r2.anticipated && ant(r2, C, 0, 6).dice.copilot[0].value === 6);
}

// 25) Working Together ------------------------------------------------------------
console.log("25) Working Together");
{
  const swap = (st, who, dieId) => reduce(st, { type: "swap", dieId }, who).state;
  const wscn = scn({ rounds: 7, rerollRounds: [1], abilities: ["workingTogether", "adaptation"] });
  const s0 = roll(init(wscn), [1, 2, 3, 4], [6, 5, 4, 3]);
  expectThrow("only the active player starts it", () => swap(s0, C, 0));
  const s1 = swap(s0, P, 0); // Pilot offers its 1
  check("the offer waits for the other player", s1.pendingSwap?.from === "pilot" && s1.dice.pilot[0].value === 1);
  expectThrow("no placements while the swap is pending", () => place(s1, P, 2, { kind: "axis" }));
  expectThrow("no reroll while the swap is pending", () => reroll(s1, P, [1], [5]));
  expectThrow("no Adaptation while the swap is pending", () => reduce(s1, { type: "adapt", dieId: 1 }, C));
  expectThrow("the offering player can't answer it", () => swap(s1, P, 1));
  const s2 = swap(s1, C, 0); // Co-Pilot answers with its 6
  check("values swap, dice return unplaced", s2.dice.pilot[0].value === 6 && s2.dice.copilot[0].value === 1 && !s2.dice.pilot[0].placed && !s2.dice.copilot[0].placed);
  check("turn is unchanged", s2.turn === "pilot" && s2.pendingSwap === null);
  expectThrow("once per round", () => swap(s2, P, 1));
  const placed = place(place(s0, P, 1, { kind: "axis" }), C, 3, { kind: "axis" }); // tilt -2, game goes on
  check("(setup: still in placement, Pilot's turn)", placed.phase === "placement" && placed.turn === "pilot");
  expectThrow("not with a placed die", () => swap(placed, P, 0));
  const empty = roll(init(wscn), [1, 1, 1, 1], [1, 1, 1, 1]);
  empty.dice.copilot.forEach((d) => (d.placed = true));
  expectThrow("refused when the other player has no dice", () => swap(empty, P, 0));
  check("…and leaves nothing pending", empty.pendingSwap == null);
  expectThrow("not without the card", () => swap(roll(init(scn({ rounds: 7 })), [1, 1, 1, 1], [1, 1, 1, 1]), P, 0));
  const r2 = roll(Object.assign(structuredClone(s2), { phase: "rolling", round: 2 }), [1, 1, 1, 1], [2, 2, 2, 2]);
  check("usable again next round", swap(r2, C, 0).pendingSwap?.from === "copilot");
}

// 26) Synchronisation (Traffic die) --------------------------------------------------
console.log("26) Synchronisation");
{
  const sync = (modules = []) => scn({ rounds: 7, abilities: ["synchronisation"], modules });
  const rollT = (st, value) => reduce(st, { type: "rollTraffic", value }, "").state;
  const placeT = (st, target, who = C) => reduce(st, { type: "placeTraffic", target }, who).state;

  let s = roll(init(sync()), [1, 1, 1, 1], [1, 1, 1, 1]);
  s = place(s, P, 1, { kind: "landingGear", slot: 0 });
  check("Gear alone doesn't trigger", !s.trafficPending);
  s = place(s, C, 1, { kind: "flaps", slot: 0 });
  check("Gear + Flaps: the Traffic die must be rolled; the turn waits", s.trafficPending && s.turn === "copilot");
  expectThrow("nothing else happens before it's rolled", () => place(s, C, 1, { kind: "axis" }));
  s = rollT(s, 4);
  check("the Co-Pilot holds it", s.trafficHeld?.value === 4 && !s.trafficPending);
  expectThrow("nothing else happens until it's placed", () => place(s, C, 1, { kind: "axis" }));
  expectThrow("the Pilot can't place it", () => placeT(s, { kind: "axis", side: "pilot" }, P));
  s = placeT(s, { kind: "axis", side: "pilot" }); // the Pilot's Axis, regardless of colour
  check("placed on the Pilot's Axis as a 4", s.axis.pilot === 4 && s.trafficPlaced.includes('pilot:{"kind":"axis"}'));
  check("an extra action: the triggering turn then passes as usual", s.turn === "pilot" && s.trafficHeld === null);
  check("once per round", !place(s, P, 1, { kind: "radio", slot: 0 }).trafficPending);
  expectThrow("a die can't name the other crew's side", () => place(s, P, 1, { kind: "radio", slot: 0, side: "copilot" }));

  // Triggered on the Pilot's turn: the Co-Pilot places, then it's the Co-Pilot's turn.
  let q = roll(init(sync()), [1, 1, 1, 1], [1, 1, 1, 1]);
  q = place(q, P, 1, { kind: "radio", slot: 0 });
  q = place(q, C, 1, { kind: "flaps", slot: 0 });
  q = place(q, P, 1, { kind: "landingGear", slot: 0 });
  check("Pilot-triggered: rolled on the Pilot's turn", q.trafficPending && q.turn === "pilot");
  q = placeT(rollT(q, 3), { kind: "radio", slot: 0, side: "copilot" });
  check("…placed by the Co-Pilot, then the turn passes to the Co-Pilot", q.radioCopilot[0] === 3 && q.turn === "copilot");
  check("the Pilot's Gear can take it too (any colour)",
    placeT(rollT((() => { let t = roll(init(sync()), [1, 1, 1, 1], [1, 1, 1, 1]); t = place(t, P, 1, { kind: "landingGear", slot: 0 }); return place(t, C, 1, { kind: "flaps", slot: 0 }); })(), 3), { kind: "landingGear", slot: 1 }).gearGreen[1]);

  // On Concentration, and on the Intern board (user rule).
  const triggered = (modules) => { let t = roll(init(sync(modules)), [1, 1, 1, 1], [1, 1, 1, 1]); t = place(t, P, 1, { kind: "landingGear", slot: 0 }); return rollT(place(t, C, 1, { kind: "flaps", slot: 0 }), 4); };
  const conc = placeT(triggered(), { kind: "concentration", slot: 0 });
  check("on Concentration: a Coffee", conc.coffee === 1 && conc.concentrationSlots[0]?.value === 4);
  const tr = placeT(triggered(["intern"]), { kind: "intern", side: "pilot" }); // tokens 1..6: Pilot's next is 1
  check("on the Pilot's Intern space: trains the Pilot's Intern", tr.internSlots.pilot === 4 && tr.internHeld?.crew === "pilot" && tr.internHeld.value === 1);
  check("…the turn waits for that token", tr.turn === "copilot");
  const tr2 = reduce(tr, { type: "placeIntern", target: { kind: "radio", slot: 0 } }, P).state;
  check("…then passes from the Co-Pilot as usual", tr2.radioPilot === 1 && tr2.turn === "pilot");

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
  check("(no flaps yet: round 1 ended normally)", e.round === 2);
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
  check("8th die triggers: the round waits", f.round === 1 && f.trafficPending);
  f = placeT(rollT(f, 2), { kind: "concentration", slot: 0 });
  check("…and ends once the Traffic die is placed", f.round === 2 && f.phase === "rolling");

  // No empty space: discarded rather than deadlocking.
  let z = roll(init(sync()), [1, 1, 1, 1], [1, 1, 1, 1]);
  z.gearSlots[0] = 1; z.flapSlots[0] = 1;
  z.trafficPending = true; z.syncDone = true;
  z.axis = { pilot: 1, copilot: 1, offset: 0 }; z.engines = { pilot: 1, copilot: 1 };
  z.radioPilot = 1; z.radioCopilot = [1, 1]; z.concentrationSlots = [{ value: 1, crew: "pilot" }, { value: 1, crew: "copilot" }];
  z.gearGreen = [true, true, true]; z.flapsGreen = [true, true, false, false]; z.brakesDeployed = 3;
  z = rollT(z, 5);
  check("no legal space: the Traffic die is discarded", z.trafficHeld === null && !z.trafficPending && z.log.at(-1).includes("nowhere"));

  const plain = roll(init(scn({ rounds: 7 })), [1, 1, 1, 1], [1, 1, 1, 1]);
  check("not without the card", !place(place(plain, P, 1, { kind: "landingGear", slot: 0 }), C, 1, { kind: "flaps", slot: 0 }).trafficPending);
  const rr = roll(Object.assign(structuredClone(s), { phase: "rolling", round: 2 }), [1, 1, 1, 1], [1, 1, 1, 1]);
  check("resets next round", !rr.syncDone && rr.trafficPlaced.length === 0);
}

// 21) Every module combination -----------------------------------------------------
// Each implemented module declares (a) how much Kerosene a quiet round burns and
// (b) how to make a landing legal. Every allowed combination must validate, play
// a quiet round with the burns adding up, and land; every combination holding an
// excluded pair must be rejected. A new module without an entry fails loudly,
// so it can't skip this matrix.
console.log("21) Every combination of implemented modules");
{
  const EXPECT = {
    kerosene: { quietBurn: 6, prep: () => {} }, // empty space: -6 per round
    keroseneLeak: { quietBurn: 1, prep: () => {} }, // level(1,1): Engines equal, leak 1
    iceBrakes: { quietBurn: 0, prep: (st) => (st.brakesDeployed = 4) }, // must be past the 5
    intern: { quietBurn: 0, prep: (st) => (st.internTokens = st.internTokens.map(() => null)) }, // all trained
  };
  const missing = IMPLEMENTED_MODULES.filter((m) => !EXPECT[m]);
  check(`every implemented module has matrix expectations${missing.length ? ` (missing: ${missing})` : ""}`, missing.length === 0);

  const combos = IMPLEMENTED_MODULES.reduce((acc, m) => [...acc, ...acc.map((c) => [...c, m])], [[]]);
  const excluded = (c) => EXCLUSIVE_MODULE_GROUPS.some((g) => g.filter((m) => c.includes(m)).length > 1);
  let allowed = 0, rejected = 0, bad = [];
  for (const combo of combos) {
    const name = combo.length ? combo.join("+") : "base";
    const valid = SetSetupPayload.safeParse({ scenarioId: "YUL", modules: combo }).success;
    if (excluded(combo)) {
      rejected++;
      if (valid) bad.push(`${name}: excluded combination was accepted`);
      continue;
    }
    allowed++;
    if (!valid) { bad.push(`${name}: allowed combination was rejected`); continue; }
    try {
      const quiet = playRound(init(scn({ rounds: 7, modules: combo })), level(1, 1));
      const burn = combo.reduce((n, m) => n + (EXPECT[m]?.quietBurn ?? 0), 0);
      if (quiet.phase !== "rolling" || quiet.round !== 2) bad.push(`${name}: quiet round didn't complete (${quiet.outcome?.reason})`);
      if (quiet.kerosene !== 20 - burn) bad.push(`${name}: kerosene ${quiet.kerosene}, expected ${20 - burn}`);
      const landing = playRound(readyToLand((st) => { st.scenario.modules = [...combo]; combo.forEach((m) => EXPECT[m]?.prep(st)); }), level(1, 1));
      if (landing.phase !== "won") bad.push(`${name}: legal landing failed (${landing.outcome?.reason})`);
    } catch (e) {
      bad.push(`${name}: threw ${e.message}`);
    }
  }
  check(`${allowed} allowed combinations play a round and land`, !bad.some((b) => !b.includes("excluded")));
  check(`${rejected} excluded combinations are rejected`, !bad.some((b) => b.includes("excluded")));
  bad.forEach((b) => console.log(`     ↳ ${b}`));
}

console.log(failures === 0 ? "\nALL RULE TESTS PASSED ✅" : `\n${failures} RULE TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
