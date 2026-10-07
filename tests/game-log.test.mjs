// The game log's move strings: every game encodes to tokens that decode and
// replay to the same game, step by step. Self-play on every card, module and
// ability (random legal moves, so every token kind occurs), fixed examples of
// each token, bad strings, and the decisions export for training.
import { describe, expect, test } from "vitest";
import {
  LOG_FORMAT,
  MOVE_CODES,
  actorFor,
  createInitialGameState,
  decisions,
  decodeToken,
  encodeCommand,
  hasModule,
  legalMoves,
  mulberry32,
  newGame,
  quickMove,
  randDice,
  reduce,
  replay,
  replaySteps,
  representativeSetups,
  cardSetups,
  scenarioForSetup,
  settle,
  splitMoves,
  withEntropy,
  DEFAULT_SETUP,
} from "../packages/shared/src/index.ts";

/**
 * A game as the server plays it, with every reduce command recorded: random
 * legal moves (a third of them the quick policy's, so games last a while), and
 * now and then the Real-Time clock running out. Returns the log and the state
 * after every token.
 */
function playRecorded(setup, seed) {
  const r = mulberry32(seed);
  const dice = randDice(r);
  const tokens = [], states = [];
  const record = (before, cmd, crew) => {
    const t = encodeCommand(before, cmd, crew);
    if (t) {
      tokens.push(t);
      states.push(reduce(before, cmd, crew ? (crew === "pilot" ? before.pilotId : before.copilotId) : "").state);
    }
  };
  let g = newGame(setup, "P", "C", r, 0, { record });
  const internTokens = [...g.internTokens];
  for (let i = 0; i < 300; i++) {
    const crew = actorFor(g);
    if (!crew) break;
    if (hasModule(g, "realTime") && r(25) === 0) {
      const before = g;
      g = reduce(g, { type: "timeUp" }, "").state;
      record(before, { type: "timeUp" }, null);
    } else {
      const moves = legalMoves(g, crew);
      const move = r(3) === 0 ? quickMove(g, crew, r) : moves[r(moves.length)];
      const before = g;
      const cmd = withEntropy(move, dice);
      g = reduce(g, cmd, crew === "pilot" ? "P" : "C").state;
      record(before, cmd, crew);
    }
    g = settle(g, dice, () => 0, record);
  }
  return { header: { format: LOG_FORMAT, setup, internTokens }, moves: tokens.join(""), tokens, states, final: g };
}

/** A state as replay must reproduce it: crews named by seat, the Real-Time
 *  clock's wall times dropped, and equal dice interchangeable. */
function canon(g) {
  const c = structuredClone(g);
  c.pilotId = "pilot";
  c.copilotId = "copilot";
  c.timerEndsAt = c.timerEndsAt === null ? null : "running";
  c.timerRemainingMs = null;
  const valueOf = (crew, id) => g.dice[crew].find((d) => d.id === id)?.value;
  if (c.pendingSwap) c.pendingSwap = { from: c.pendingSwap.from, value: valueOf(c.pendingSwap.from, c.pendingSwap.dieId) };
  for (const crew of ["pilot", "copilot"]) c.dice[crew] = c.dice[crew].map((d) => `${d.value}${d.placed ? "x" : ""}`).sort();
  return c;
}

describe("round trip: every game replays to itself, step by step", () => {
  const setups = [...representativeSetups(), ...cardSetups()];
  test(`${setups.length} setups × 2 games`, async () => {
    const kinds = new Set();
    let games = 0;
    for (const [i, setup] of setups.entries()) {
      for (let k = 0; k < 2; k++) {
        const game = playRecorded(setup, 7000 + i * 3 + k);
        // Self-delimiting: the string splits back into exactly its tokens.
        expect(splitMoves(game.moves)).toEqual(game.tokens);
        const steps = replaySteps(game.header, game.moves);
        expect(steps).toHaveLength(game.tokens.length);
        steps.forEach((s, j) => {
          if (JSON.stringify(canon(s.state)) !== JSON.stringify(canon(game.states[j]))) {
            throw new Error(`${setup.scenarioId} ${[...setup.modules, ...setup.abilities].join("+")} seed ${7000 + i * 3 + k}: step ${j} (${s.token}) differs`);
          }
        });
        expect(canon(replay(game.header, game.moves))).toEqual(canon(game.final));
        for (const t of game.tokens) kinds.add(t[0] === "P" || t[0] === "C" ? t[0] + (/^\d/.test(t[1]) ? "0" : t[1]) : t[0]);
        games++;
      }
      await new Promise((r) => setImmediate(r)); // keep the worker responsive
    }
    expect(games).toBe(setups.length * 2);
    // Every kind of token came up somewhere.
    for (const k of ["D", "S", "T", "P0", "C0", "P!", "C!", "P?", "C?", "P~", "C~", "P^", "C^", "P*", "C*", "C#"]) expect(kinds, k).toContain(k);
  }, 600_000);
});

describe("tokens", () => {
  // A known deal to write commands against.
  const base = () => {
    const g = createInitialGameState(scenarioForSetup(DEFAULT_SETUP), "P", "C");
    return reduce(g, { type: "roll", pilot: [4, 6, 3, 3], copilot: [2, 5, 2, 1] }, "").state;
  };

  test("a deal: the pilot's dice, the co-pilot's, then Traffic dice", () => {
    const g = createInitialGameState(scenarioForSetup(DEFAULT_SETUP), "P", "C");
    expect(encodeCommand(g, { type: "roll", pilot: [3, 5, 6, 1], copilot: [2, 2, 4, 4], at: 99 }, null)).toBe("D35612244");
    expect(encodeCommand(g, { type: "roll", pilot: [3, 5, 6, 1], copilot: [2, 2, 4, 4], traffic: [4, 2] }, null)).toBe("D3561224442");
  });

  test("placing dice: value, Coffee, space, slot, the other side", () => {
    const g = base();
    const enc = (crew, cmd) => encodeCommand(g, cmd, crew);
    expect(enc("pilot", { type: "placeDie", dieId: 0, target: { kind: "axis" } })).toBe("P4a");
    expect(enc("pilot", { type: "placeDie", dieId: 0, target: { kind: "axis", side: "pilot" } })).toBe("P4a");
    expect(enc("copilot", { type: "placeDie", dieId: 0, target: { kind: "engine" } })).toBe("C2e");
    expect(enc("pilot", { type: "placeDie", dieId: 1, target: { kind: "brakes", slot: 2 } })).toBe("P6b2");
    expect(enc("copilot", { type: "placeDie", dieId: 2, target: { kind: "concentration", slot: 0 }, coffeeDelta: 1 })).toBe("C2+1c0");
    expect(enc("copilot", { type: "placeDie", dieId: 1, target: { kind: "flaps", slot: 3 }, coffeeDelta: -1 })).toBe("C5-1f3");
    expect(enc("copilot", { type: "placeDie", dieId: 1, target: { kind: "radio", slot: 1 } })).toBe("C5r1");
    expect(enc("pilot", { type: "placeDie", dieId: 2, target: { kind: "landingGear", slot: 1 } })).toBe("P3g1");
    expect(enc("pilot", { type: "placeDie", dieId: 2, target: { kind: "iceBrakes", slot: 1, space: "top" } })).toBe("P3i1");
    expect(enc("copilot", { type: "placeDie", dieId: 2, target: { kind: "iceBrakes", slot: 0, space: "bottom" } })).toBe("C2j0");
    expect(enc("pilot", { type: "placeDie", dieId: 1, target: { kind: "kerosene" } })).toBe("P6k");
    expect(enc("pilot", { type: "placeDie", dieId: 0, target: { kind: "intern" } })).toBe("P4t");
    expect(enc("copilot", { type: "placeTraffic", target: { kind: "axis", side: "pilot" } })).toBe("C#a'");
    expect(enc("copilot", { type: "placeTraffic", target: { kind: "radio", slot: 0, side: "pilot" } })).toBe("C#r0'");
    expect(enc("pilot", { type: "placeIntern", target: { kind: "flaps", slot: 1 } })).toBe("P*f1");
  });

  test("rerolls, abilities and the clock", () => {
    const g = base();
    expect(encodeCommand(g, { type: "reroll", dieIds: [2, 1], values: [6, 2] }, "pilot")).toBe("P!36:62");
    expect(encodeCommand(g, { type: "reroll", dieIds: [], values: [] }, "copilot")).toBe("C!");
    expect(encodeCommand(g, { type: "anticipate", dieId: 2, value: 5 }, "pilot")).toBe("P?3:5");
    expect(encodeCommand(g, { type: "adapt", dieId: 3 }, "copilot")).toBe("C~1");
    expect(encodeCommand(g, { type: "swap", dieId: 1 }, "pilot")).toBe("P^6");
    expect(encodeCommand(g, { type: "rollTraffic", value: 4 }, null)).toBe("S4");
    expect(encodeCommand(g, { type: "timeUp" }, null)).toBe("T");
    // Pauses don't change the game's course: not logged.
    expect(encodeCommand(g, { type: "pauseTimer", at: 1 }, null)).toBe("");
    expect(encodeCommand(g, { type: "resumeTimer", at: 2 }, null)).toBe("");
  });

  test("decoding picks the die by value (the lowest of equal dice) and the space", () => {
    const g = base();
    expect(decodeToken(g, "P3a")).toEqual({ crew: "pilot", command: { type: "placeDie", dieId: 2, target: { kind: "axis" } } });
    expect(decodeToken(g, "C2+1c0")).toEqual({ crew: "copilot", command: { type: "placeDie", dieId: 0, target: { kind: "concentration", slot: 0 }, coffeeDelta: 1 } });
    expect(decodeToken(g, "C#r0'")).toEqual({ crew: "copilot", command: { type: "placeTraffic", target: { kind: "radio", slot: 0, side: "pilot" } } });
    expect(decodeToken(g, "P!33:16")).toEqual({ crew: "pilot", command: { type: "reroll", dieIds: [2, 3], values: [1, 6] } });
    expect(decodeToken(g, "C!")).toEqual({ crew: "copilot", command: { type: "reroll", dieIds: [], values: [] } });
    expect(decodeToken(g, "S5")).toEqual({ crew: null, command: { type: "rollTraffic", value: 5 } });
  });

  test("bad strings are refused, saying which token", () => {
    const g = base();
    expect(() => decodeToken(g, "P5a")).toThrow(/P5a.*no unplaced 5/);
    expect(() => decodeToken(g, "P9a")).toThrow(/P9a.*unknown action/);
    expect(() => decodeToken(g, "Pzz")).toThrow(/Pzz/);
    expect(() => decodeToken(g, "D123")).toThrow(/D123/);
    expect(() => splitMoves("xP4a")).toThrow(/starts/);
    const header = { format: LOG_FORMAT, setup: DEFAULT_SETUP, internTokens: [] };
    expect(() => replay({ ...header, format: 99 }, "")).toThrow(/format 99/);
    // A token the rules refuse is reported with its position.
    expect(() => replay(header, "D46332521C2a")).toThrow(/Token 2 \(C2a\) is refused by the rules/);
  });

  test("the code list explains every code the format uses", () => {
    const codes = MOVE_CODES.map((c) => c.code);
    for (const c of ["D", "S", "T", "P", "C", "!", "?", "~", "^", "*", "#", "+", "-", ":", "'", "a", "e", "r", "g", "f", "b", "c", "k", "i", "j", "t"]) expect(codes).toContain(c);
    expect(new Set(codes).size).toBe(codes.length);
    expect(MOVE_CODES.every((c) => c.meaning.length > 3)).toBe(true);
  });
});

test("decisions: one per crew token, from the deciding crew's view, as the wire command", () => {
  const game = playRecorded({ scenarioId: "green-PRG", modules: [], abilities: ["anticipation", "workingTogether"] }, 31);
  const ds = decisions(game.header, game.moves);
  expect(ds).toHaveLength(game.tokens.filter((t) => t[0] === "P" || t[0] === "C").length);
  for (const d of ds) {
    const other = d.crew === "pilot" ? "copilot" : "pilot";
    expect(d.view.dice[other].filter((x) => !x.placed).every((x) => x.hidden)).toBe(true);
    if (d.command.type === "reroll") expect(d.command).not.toHaveProperty("values");
    if (d.command.type === "anticipate") expect(d.command).not.toHaveProperty("value");
  }
});
