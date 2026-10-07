// An in-memory stand-in for node-postgres (`pg`): just the calls the server
// makes. The SQL itself is proven against a real PostgreSQL in pg-real.test.mjs;
// this fake only has to make the code around it testable.
//
// - Inserts into `games` keep their rows (by id, as ON CONFLICT DO NOTHING
//   would); `move_codes` keeps the codes.
// - Account queries are recognised by their tag comment (/* users.insert */ …)
//   and played against arrays: users, roles, rolePrivileges, resets, gamePlayers.
// - `results.set(sql, rows)` answers that exact SQL with canned rows.
// - Tests take the database "down" through `Pool.last.down`, or make the next
//   query fail with `failNext`.
export class Pool {
  static last = null;

  constructor(options) {
    this.options = options;
    this.games = [];
    this.moveCodes = [];
    this.roles = [];
    this.rolePrivileges = [];
    this.users = [];
    this.resets = [];
    this.gamePlayers = [];
    this.results = new Map();
    this.queries = [];
    this.down = false;
    this.failNext = null;
    Pool.last = this;
  }

  on() {
    return this;
  }

  async connect() {
    return { query: (text, params) => this.query(text, params), release() {} };
  }

  async query(text, params = []) {
    this.queries.push(text);
    if (this.down) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    const err = this.failNext;
    this.failNext = null;
    if (err) throw err;
    if (this.results.has(text)) return rows(this.results.get(text));
    const tag = /^\s*\/\* ([\w.]+) \*\//.exec(text)?.[1];
    if (tag) {
      const handler = this.tags[tag];
      if (!handler) throw new Error(`fakePg: no handler for /* ${tag} */`);
      return handler.call(this, ...params);
    }
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

  user(id) {
    return this.users.find((u) => u.id === id);
  }

  async end() {}
}

const rows = (list) => ({ rows: list, rowCount: list.length });
const changed = (n) => ({ rows: [], rowCount: n });

Pool.prototype.tags = {
  "roles.insert"(names, ranks) {
    const added = names.filter((n) => !this.roles.some((r) => r.name === n));
    for (const name of added) this.roles.push({ name, rank: ranks[names.indexOf(name)] });
    return rows(added.map((name) => ({ name })));
  },
  "privileges.insert"(roles, privileges) {
    roles.forEach((role, i) => {
      if (!this.rolePrivileges.some((p) => p.role === role && p.privilege === privileges[i])) this.rolePrivileges.push({ role, privilege: privileges[i] });
    });
    return changed(roles.length);
  },
  "users.insert"(id, username, password_hash, recovery_hash, role, at) {
    if (this.users.some((u) => u.username === username)) return changed(0);
    this.users.push({ id, username, password_hash, recovery_hash, role, disabled_at: null, sessions_after: at, created_at: at });
    return changed(1);
  },
  "users.byName"(username) {
    return rows(this.users.filter((u) => u.username === username).map((u) => ({ ...u })));
  },
  "users.byId"(id) {
    const u = this.user(id);
    if (!u) return rows([]);
    const privileges = this.rolePrivileges.filter((p) => p.role === u.role).map((p) => p.privilege).sort();
    return rows([{ ...u, privileges }]);
  },
  "users.setCredentials"(id, password_hash, recovery_hash, at) {
    return update(this.user(id), { password_hash, recovery_hash, sessions_after: at });
  },
  "users.setPassword"(id, password_hash, at) {
    return update(this.user(id), { password_hash, sessions_after: at });
  },
  "users.setRecovery"(id, recovery_hash) {
    return update(this.user(id), { recovery_hash });
  },
  "users.endSessions"(id, at) {
    return update(this.user(id), { sessions_after: at });
  },
  "users.setRole"(id, role) {
    return update(this.user(id), { role });
  },
  "users.delete"(id) {
    const before = this.users.length;
    this.users = this.users.filter((u) => u.id !== id);
    this.resets = this.resets.filter((r) => r.user_id !== id);
    this.gamePlayers = this.gamePlayers.filter((p) => p.user_id !== id);
    return changed(before - this.users.length);
  },
  "gamePlayers.insert"(game_id, user_id, crew) {
    if (!this.user(user_id) || this.gamePlayers.some((p) => p.game_id === game_id && p.crew === crew)) return changed(0);
    this.gamePlayers.push({ game_id, user_id, crew });
    return changed(1);
  },
  "resets.dropUnused"(userId) {
    this.resets = this.resets.filter((r) => r.user_id !== userId || r.used_at);
    return changed(1);
  },
  "resets.insert"(token_hash, user_id, created_by, expires_at) {
    this.resets.push({ token_hash, user_id, created_by, expires_at, used_at: null });
    return changed(1);
  },
  "resets.take"(tokenHash, now) {
    const r = this.resets.find((x) => x.token_hash === tokenHash && !x.used_at && x.expires_at > now);
    if (!r) return rows([]);
    r.used_at = now;
    return rows([{ user_id: r.user_id }]);
  },
};

function update(row, fields) {
  if (!row) return changed(0);
  Object.assign(row, fields);
  return changed(1);
}

export default { Pool };
