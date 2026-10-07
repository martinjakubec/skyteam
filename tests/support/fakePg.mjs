// An in-memory stand-in for node-postgres (`pg`): just the calls the game log
// makes. Inserts into `games` keep their rows (by id, as ON CONFLICT DO NOTHING
// would); `move_codes` keeps the codes. Tests take the database "down" through
// `Pool.last.down`, or make the next query fail with `failNext`.
export class Pool {
  static last = null;

  constructor(options) {
    this.options = options;
    this.games = [];
    this.moveCodes = [];
    this.queries = [];
    this.down = false;
    this.failNext = null;
    Pool.last = this;
  }

  on() {
    return this;
  }

  async query(text, params = []) {
    this.queries.push(text);
    if (this.down) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    const err = this.failNext;
    this.failNext = null;
    if (err) throw err;
    const insert = /^\s*INSERT INTO (\w+) \(([^)]+)\)/i.exec(text);
    if (insert?.[1] === "games") {
      const cols = insert[2].split(",").map((c) => c.trim());
      const row = Object.fromEntries(cols.map((c, i) => [c, params[i]]));
      if (!this.games.some((g) => g.id === row.id)) this.games.push(row);
    } else if (insert?.[1] === "move_codes") {
      this.moveCodes = params[1].map((code, i) => ({ format: params[0], code, meaning: params[2][i] }));
    }
    return { rows: [], rowCount: 1 };
  }

  async end() {}
}

export default { Pool };
