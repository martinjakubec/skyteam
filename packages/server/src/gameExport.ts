import { replaySteps, type DieValue, type GameSetup } from "@skyteam/shared";
import { db } from "./db";
import { ensureSchema } from "./schema";

/**
 * Game export (manage_users): chosen games as JSON — each one's setup, seed,
 * who flew it, how it ended, and its moves both as the log string and decoded
 * command by command (as `npm run logs:export` writes them). Never the room it
 * was played in, nor anyone's account id.
 */

/** The most games one export may take. */
export const EXPORT_MAX = 200;

export const SQL_EXPORT = `/* games.export */ SELECT g.id, g.format, g.build, g.scenario, g.modules, g.abilities, g.intern_order,
    g.pilot, g.copilot, g.result, g.loss_reason, g.rounds_reached, g.moves, g.started_at, g.ended_at, g.seed, g.seeded_from,
    (SELECT u.username FROM game_players p JOIN users u ON u.id = p.user_id WHERE p.game_id = g.id AND p.crew = 'pilot') AS pilot_name,
    (SELECT u.username FROM game_players p JOIN users u ON u.id = p.user_id WHERE p.game_id = g.id AND p.crew = 'copilot') AS copilot_name
  FROM games g WHERE g.id = ANY($1::text[]) ORDER BY g.ended_at, g.id`;

/** One seat of an exported game: the account that flew it (null: none), and
 *  "human" or "bot:<level>". */
export interface ExportedSeat {
  username: string | null;
  seat: string;
}

export interface ExportedGame {
  id: string;
  /** The move string's format (shared log/codes.ts). */
  format: number;
  build: string;
  setup: GameSetup;
  internTokens: number[];
  /** The dice's seed (null: logged before seeds). */
  seed: string | null;
  seededFrom: string | null;
  crews: { pilot: ExportedSeat; copilot: ExportedSeat };
  result: string;
  lossReason: string | null;
  roundsReached: number;
  startedAt: string;
  endedAt: string;
  moves: string;
  /** The moves decoded, in order — null when this build can't replay them (see stepsError). */
  steps: { token: string; crew: string | null; command: unknown }[] | null;
  stepsError?: string;
}

export interface GameExport {
  exportedAt: string;
  games: ExportedGame[];
  /** Ids asked for that no game has. */
  missing: string[];
}

const iso = (d: Date | string) => new Date(d).toISOString();

/** The decoded moves, or why they can't be. */
function stepsOf(r: Record<string, unknown>, setup: GameSetup, internTokens: DieValue[]): Pick<ExportedGame, "steps" | "stepsError"> {
  try {
    const steps = replaySteps({ format: Number(r.format), setup, internTokens }, r.moves as string);
    return { steps: steps.map(({ token, crew, command }) => ({ token, crew, command })) };
  } catch (e) {
    // An older format, or a setup this build no longer has: the move string still goes out.
    return { steps: null, stepsError: e instanceof Error ? e.message : String(e) };
  }
}

/** The games with these ids, oldest first. */
export async function exportGames(ids: string[]): Promise<GameExport> {
  await ensureSchema();
  const rows = (await db()!.query(SQL_EXPORT, [ids])).rows;
  const games = rows.map((r): ExportedGame => {
    const setup = { scenarioId: r.scenario, modules: r.modules, abilities: r.abilities } as GameSetup;
    const internTokens = [...(r.intern_order as string)].map(Number) as DieValue[];
    return {
      id: r.id,
      format: Number(r.format),
      build: r.build,
      setup,
      internTokens,
      seed: r.seed ?? null,
      seededFrom: r.seeded_from ?? null,
      crews: {
        pilot: { username: r.pilot_name ?? null, seat: r.pilot },
        copilot: { username: r.copilot_name ?? null, seat: r.copilot },
      },
      result: r.result,
      lossReason: r.loss_reason ?? null,
      roundsReached: Number(r.rounds_reached),
      startedAt: iso(r.started_at),
      endedAt: iso(r.ended_at),
      moves: r.moves,
      ...stepsOf(r, setup, internTokens),
    };
  });
  const found = new Set(games.map((g) => g.id));
  return { exportedAt: new Date().toISOString(), games, missing: ids.filter((id) => !found.has(id)) };
}
