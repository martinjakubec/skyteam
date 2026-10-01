// Unit tests for the non-reducer pieces: hidden-dice redaction, per-viewer
// snapshots, game-setup validation, the CORS origin check, and the client's
// uuid() fallback.
// Run via `npm test` (builds shared first; the server imports its dist).
import {
  DEFAULT_SETUP,
  SCENARIOS,
  SetSetupPayload,
  conflictingModules,
  createInitialGameState,
  reduce,
  redactGameStateFor,
  scenarioForSetup,
} from "../packages/shared/src/index.ts";
import { toSnapshot } from "../packages/server/src/snapshot.ts";
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
  check("not-yet-implemented module rejected", !ok({ scenarioId: "YUL", modules: ["intern"] }));
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
