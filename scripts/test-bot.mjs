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

console.log(failures === 0 ? "\nALL BOT TESTS PASSED ✅" : `\n${failures} BOT TEST(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
