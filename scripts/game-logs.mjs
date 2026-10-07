// Game logs from PostgreSQL (see docs/game-logs.md):
//
//   npm run logs:export                 one JSON line per game: its row + decoded commands
//   npm run logs:export -- --decisions  one JSON line per crew decision (view → command), for training
//   npm run logs:replay -- <game id>    the game step by step
//
// Reads DATABASE_URL (e.g. postgres://skyteam:skyteam-dev@localhost:5433/skyteam
// against the dev stack). Optional --where "<SQL condition>" narrows the export.
import pg from "pg";
import { decisions, replaySteps } from "../packages/shared/src/index.ts";

// Piped into head or a pager that quits early: stop quietly.
process.stdout.on("error", (e) => (e.code === "EPIPE" ? process.exit(0) : Promise.reject(e)));

const [command, ...args] = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL, e.g. postgres://skyteam:skyteam-dev@localhost:5433/skyteam");
  process.exit(1);
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

/** A row's header for the codec. */
const headerOf = (row) => ({
  format: row.format,
  setup: { scenarioId: row.scenario, modules: row.modules, abilities: row.abilities },
  internTokens: [...row.intern_order].map(Number),
});

try {
  if (command === "export") {
    const where = option("--where");
    const { rows } = await db.query(`SELECT * FROM games ${where ? `WHERE ${where}` : ""} ORDER BY ended_at`);
    for (const row of rows) {
      if (flag("--decisions")) {
        for (const d of decisions(headerOf(row), row.moves)) {
          process.stdout.write(JSON.stringify({ game: row.id, scenario: row.scenario, result: row.result, ...d }) + "\n");
        }
      } else {
        const steps = replaySteps(headerOf(row), row.moves).map(({ token, crew, command }) => ({ token, crew, command }));
        process.stdout.write(JSON.stringify({ ...row, steps }) + "\n");
      }
    }
    console.error(`${rows.length} games exported.`);
  } else if (command === "replay") {
    const id = args[0];
    const { rows: [row] } = await db.query("SELECT * FROM games WHERE id = $1", [id]);
    if (!row) throw new Error(`No game ${id}.`);
    const crews = `pilot ${row.pilot}, co-pilot ${row.copilot}`;
    const extras = [...row.modules, ...row.abilities].join(", ") || "base game";
    console.log(`Game ${row.id} · ${row.scenario} (${extras}) · ${crews}`);
    console.log(`${row.result}${row.loss_reason ? ` — ${row.loss_reason}` : ""} · round ${row.rounds_reached} · ${row.started_at.toISOString()}\n`);
    let lines = 1; // the opening log line comes with the empty board
    for (const [i, step] of replaySteps(headerOf(row), row.moves).entries()) {
      const who = step.crew === "pilot" ? "Pilot" : step.crew === "copilot" ? "Co-Pilot" : "—";
      console.log(`${String(i + 1).padStart(4)}  ${step.token.padEnd(14)} ${who}`);
      // What the rules said about it (the game's own log lines).
      for (const line of step.state.log.slice(lines)) console.log(`${" ".repeat(26)}${line}`);
      lines = step.state.log.length;
    }
  } else {
    console.error("Usage: game-logs.mjs export [--decisions] [--where <condition>] | replay <game id>");
    process.exitCode = 1;
  }
} finally {
  await db.end();
}
