// Deterministic unit tests for the SkyTeam rules reducer (pure, no server).
// Run with `npm test` (inside a node:22 container, repo bind-mounted).
// Imported from source via tsx (the dist build uses extensionless ESM imports
// that bare `node` can't resolve).
import { createInitialGameState, reduce } from "../packages/shared/src/index.ts";

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

console.log(failures === 0 ? "\nALL RULE TESTS PASSED ✅" : `\n${failures} RULE TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
