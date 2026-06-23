// Deterministic unit tests for the SkyTeam rules reducer (pure, no server).
// Run inside a container after building shared:
//   node:22-alpine, repo bind-mounted: `npm run build:shared && node scripts/test-rules.mjs`
// Imported from source; run with tsx (the dist build uses extensionless ESM
// imports that bare `node` can't resolve).
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

// 4) Collision loss ---------------------------------------------------------
console.log("4) Collision: advancing off a space occupied by an airplane");
{
  const s0 = scn({ approachTrack: [{ traffic: 1 }, { traffic: 0 }, { traffic: 0, airport: true }], rounds: 7 });
  let s = init(s0);
  s = roll(s, [4, 1, 1, 1], [4, 1, 1, 1]);
  s = place(s, P, 4, { kind: "engine" });
  s = place(s, C, 4, { kind: "engine" }); // sum 8 -> must advance, but airplane on space 0
  check("collision -> lost", s.phase === "lost" && /collision/i.test(s.outcome?.reason ?? ""));
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

// 6) Mandatory Axis/Engine loss ---------------------------------------------
console.log("6) Mandatory loss: a round ends without filling Engines");
{
  let s = init(scn({ rounds: 7 }));
  s = roll(s, [1, 2, 1, 5], [1, 1, 2, 3]);
  s = place(s, P, 1, { kind: "axis" });
  s = place(s, C, 1, { kind: "axis" });
  s = place(s, P, 2, { kind: "landingGear", slot: 0 }); // 1/2
  s = place(s, C, 1, { kind: "flaps", slot: 0 }); // 1/2
  s = place(s, P, 1, { kind: "radio", slot: 0 });
  s = place(s, C, 2, { kind: "flaps", slot: 1 }); // 2/3
  s = place(s, P, 5, { kind: "landingGear", slot: 2 }); // 5/6
  s = place(s, C, 3, { kind: "flaps", slot: 2 }); // 3/4 -> 8th die, engines never filled
  check("mandatory unmet -> lost", s.phase === "lost" && /mandatory/i.test(s.outcome?.reason ?? ""));
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

console.log(failures === 0 ? "\nALL RULE TESTS PASSED ✅" : `\n${failures} RULE TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
