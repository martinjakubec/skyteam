import type { GameCommand, PlacementTarget } from "../protocol";
import { scenarioForSetup, type GameSetup } from "../game/catalog";
import { GameRuleError, reduce, type ReduceCommand } from "../game/reducer";
import type { Crew, DieValue } from "../game/scenario";
import { createInitialGameState, redactGameStateFor, type GameState } from "../game/state";
import { LOG_FORMAT } from "./codes";

/**
 * The game log's move strings (format 1, see codes.ts): every reduce command a
 * game went through, as short tokens. A game is its setup, the Intern tokens'
 * order and these commands — so the string replays it exactly (equal dice are
 * interchangeable, Real-Time wall-clock times and pauses aren't kept, and the
 * crews are named "pilot"/"copilot").
 */

/** What a move string needs beside itself to be replayed. */
export interface LogHeader {
  format: number;
  setup: GameSetup;
  /** The Intern tokens' face-up order at setup (empty without the Intern). */
  internTokens: DieValue[];
}

/** A move string (or a token in it) that can't be read or replayed. */
export class GameLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameLogError";
  }
}

const other = (crew: Crew): Crew => (crew === "pilot" ? "copilot" : "pilot");
const crewCode = (crew: Crew) => (crew === "pilot" ? "P" : "C");
const SLOTTED = new Set(["r", "g", "f", "b", "c", "i", "j"]);

// --- encoding --------------------------------------------------------------------------

function encodeTarget(t: PlacementTarget, crew: Crew): string {
  const side = "side" in t && t.side && t.side !== crew ? "'" : "";
  switch (t.kind) {
    case "axis": return `a${side}`;
    case "engine": return `e${side}`;
    case "radio": return `r${t.slot}${side}`;
    case "landingGear": return `g${t.slot}`;
    case "flaps": return `f${t.slot}`;
    case "brakes": return `b${t.slot}`;
    case "concentration": return `c${t.slot}`;
    case "kerosene": return "k";
    case "iceBrakes": return `${t.space === "top" ? "i" : "j"}${t.slot}`;
    case "intern": return `t${side}`;
  }
}

/** The token for one command applied to `before` by `crew` (null: the server's
 *  own), or "" for one the log leaves out (Real-Time pauses). */
export function encodeCommand(before: GameState, cmd: ReduceCommand, crew: Crew | null): string {
  const value = (id: number) => {
    const v = crew && before.dice[crew].find((d) => d.id === id)?.value;
    if (!v) throw new GameLogError(`No die ${id} to log for ${crew ?? "the server"}.`);
    return v;
  };
  const c = crew ? crewCode(crew) : "";
  switch (cmd.type) {
    case "roll": return `D${cmd.pilot.join("")}${cmd.copilot.join("")}${(cmd.traffic ?? []).join("")}`;
    case "rollTraffic": return `S${cmd.value}`;
    case "timeUp": return "T";
    case "pauseTimer":
    case "resumeTimer": return "";
    case "placeDie": {
      const coffee = cmd.coffeeDelta ? (cmd.coffeeDelta > 0 ? `+${cmd.coffeeDelta}` : `${cmd.coffeeDelta}`) : "";
      return `${c}${value(cmd.dieId)}${coffee}${encodeTarget(cmd.target, crew!)}`;
    }
    case "reroll":
      return `${c}!${cmd.dieIds.map(value).join("")}${cmd.dieIds.length ? `:${cmd.values.join("")}` : ""}`;
    case "anticipate": return `${c}?${value(cmd.dieId)}:${cmd.value}`;
    case "adapt": return `${c}~${value(cmd.dieId)}`;
    case "swap": return `${c}^${value(cmd.dieId)}`;
    case "placeIntern": return `${c}*${encodeTarget(cmd.target, crew!)}`;
    case "placeTraffic": return `${c}#${encodeTarget(cmd.target, crew!)}`;
  }
}

// --- decoding --------------------------------------------------------------------------

/** A move string's tokens. */
export function splitMoves(moves: string): string[] {
  if (moves === "") return [];
  if (!/^[DSTPC]/.test(moves)) throw new GameLogError(`A move string starts with one of D S T P C, not "${moves[0]}".`);
  return moves.match(/[DSTPC][^DSTPC]*/g)!;
}

const digits = (s: string) => [...s].map((d) => Number(d) as DieValue);

/** Read one token against the state it was played on: the reduce command it
 *  stands for, and the crew that acted (null for the server's own). */
export function decodeToken(state: GameState, token: string): { crew: Crew | null; command: ReduceCommand } {
  const bad = (why: string) => new GameLogError(`Token "${token}": ${why}.`);
  const head = token[0];

  if (head === "D") {
    const traffic = state.scenario.approachTrack[state.position]?.trafficDice ?? 0;
    if (!new RegExp(`^D[1-6]{${8 + traffic}}$`).test(token)) throw bad(`a deal is 8 dice and ${traffic} Traffic dice here`);
    const d = digits(token.slice(1));
    return { crew: null, command: { type: "roll", pilot: d.slice(0, 4), copilot: d.slice(4, 8), ...(traffic ? { traffic: d.slice(8) } : {}), at: 0 } };
  }
  if (head === "S") {
    if (!/^S[1-6]$/.test(token)) throw bad("a Traffic roll is S and one die");
    return { crew: null, command: { type: "rollTraffic", value: Number(token[1]) as DieValue } };
  }
  if (head === "T") {
    if (token !== "T") throw bad("time-up is T alone");
    return { crew: null, command: { type: "timeUp" } };
  }
  if (head !== "P" && head !== "C") throw bad("unknown token");

  const crew: Crew = head === "P" ? "pilot" : "copilot";
  // The crew's unplaced dice of these values (equal dice: the lowest ids first).
  const dieIds = (values: DieValue[]) => {
    const taken = new Set<number>();
    return values.map((v) => {
      const die = state.dice[crew].find((d) => !d.placed && d.value === v && !taken.has(d.id));
      if (!die) throw bad(`the ${crew === "pilot" ? "Pilot" : "Co-Pilot"} has no unplaced ${v}`);
      taken.add(die.id);
      return die.id;
    });
  };
  const target = (s: string): PlacementTarget => {
    const m = /^([aertgfbcikj])([0-3]?)(')?$/.exec(s);
    if (!m || SLOTTED.has(m[1]) !== (m[2] !== "")) throw bad(`"${s}" is not a space`);
    const slot = Number(m[2]);
    const side = m[3] ? { side: other(crew) } : {};
    switch (m[1]) {
      case "a": return { kind: "axis", ...side };
      case "e": return { kind: "engine", ...side };
      case "t": return { kind: "intern", ...side };
      case "r": return { kind: "radio", slot, ...side };
      case "g": return { kind: "landingGear", slot };
      case "f": return { kind: "flaps", slot };
      case "b": return { kind: "brakes", slot };
      case "c": return { kind: "concentration", slot };
      case "i": return { kind: "iceBrakes", slot, space: "top" };
      case "j": return { kind: "iceBrakes", slot, space: "bottom" };
      default: return { kind: "kerosene" };
    }
  };

  const rest = token.slice(1);
  let m: RegExpExecArray | null;
  if ((m = /^([1-6])([+-][1-9])?(.+)$/.exec(rest))) {
    const [dieId] = dieIds([Number(m[1]) as DieValue]);
    return { crew, command: { type: "placeDie", dieId, target: target(m[3]), ...(m[2] ? { coffeeDelta: Number(m[2]) } : {}) } };
  }
  if ((m = /^!(?:([1-6]{1,4}):([1-6]{1,4}))?$/.exec(rest))) {
    const old = m[1] ? digits(m[1]) : [];
    const values = m[2] ? digits(m[2]) : [];
    if (old.length !== values.length) throw bad("a reroll needs a new value for each die");
    return { crew, command: { type: "reroll", dieIds: dieIds(old), values } };
  }
  if ((m = /^\?([1-6]):([1-6])$/.exec(rest))) {
    return { crew, command: { type: "anticipate", dieId: dieIds([Number(m[1]) as DieValue])[0], value: Number(m[2]) as DieValue } };
  }
  if ((m = /^~([1-6])$/.exec(rest))) return { crew, command: { type: "adapt", dieId: dieIds([Number(m[1]) as DieValue])[0] } };
  if ((m = /^\^([1-6])$/.exec(rest))) return { crew, command: { type: "swap", dieId: dieIds([Number(m[1]) as DieValue])[0] } };
  if ((m = /^\*(.+)$/.exec(rest))) return { crew, command: { type: "placeIntern", target: target(m[1]) } };
  if ((m = /^#(.+)$/.exec(rest))) return { crew, command: { type: "placeTraffic", target: target(m[1]) } };
  throw bad("unknown action");
}

// --- replay ----------------------------------------------------------------------------

export interface ReplayStep {
  token: string;
  crew: Crew | null;
  command: ReduceCommand;
  /** The game after this token. */
  state: GameState;
}

/** The game before its first deal, as the header describes it. */
function startOf(header: LogHeader): GameState {
  if (header.format !== LOG_FORMAT) throw new GameLogError(`Can't read move strings of format ${header.format} (this build reads ${LOG_FORMAT}).`);
  return createInitialGameState(scenarioForSetup(header.setup), "pilot", "copilot", { internTokens: header.internTokens });
}

/** Replay a logged game token by token: each token, what it did, and the game after it. */
export function replaySteps(header: LogHeader, moves: string): ReplayStep[] {
  let state = startOf(header);
  return splitMoves(moves).map((token, i) => {
    const { crew, command } = decodeToken(state, token);
    try {
      state = reduce(state, command, crew ?? "").state;
    } catch (e) {
      if (e instanceof GameRuleError) throw new GameLogError(`Token ${i + 1} (${token}) is refused by the rules: ${e.message}`);
      throw e;
    }
    return { token, crew, command, state };
  });
}

/** The game a log ends in. */
export function replay(header: LogHeader, moves: string): GameState {
  return replaySteps(header, moves).at(-1)?.state ?? startOf(header);
}

/** One choice a crew made: what it could see (its redacted view) and the
 *  command it sent — the pairs a bot learns from. */
export interface Decision {
  crew: Crew;
  view: GameState;
  command: GameCommand;
}

/** Every crew decision in a logged game, in order. */
export function decisions(header: LogHeader, moves: string): Decision[] {
  let before = startOf(header);
  const out: Decision[] = [];
  for (const step of replaySteps(header, moves)) {
    if (step.crew) out.push({ crew: step.crew, view: redactGameStateFor(before, step.crew), command: toWire(step.command) });
    before = step.state;
  }
  return out;
}

/** A reduce command as the player sent it (the server adds reroll values). */
function toWire(cmd: ReduceCommand): GameCommand {
  if (cmd.type === "reroll") return { type: "reroll", dieIds: cmd.dieIds };
  if (cmd.type === "anticipate") return { type: "anticipate", dieId: cmd.dieId };
  return cmd as GameCommand;
}
