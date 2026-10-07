// An in-memory stand-in for ioredis: just the calls the server makes.
// Tests reach the instance through `FakeRedis.last` to take storage "down"
// (`status`) or make the next command fail (`failNext`).
export default class FakeRedis {
  static last = null;

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.status = "ready";
    this.data = new Map();
    this.handlers = {};
    this.failNext = null;
    FakeRedis.last = this;
  }

  on(event, handler) {
    this.handlers[event] = handler;
    return this;
  }

  /** Throws the planted failure once (a dropped connection mid-request). */
  check() {
    const err = this.failNext;
    this.failNext = null;
    if (err) throw err;
  }

  async get(key) {
    this.check();
    return this.data.get(key) ?? null;
  }

  // Lists (the game log's retry queue).
  async rpush(key, value) {
    this.check();
    const list = this.data.get(key) ?? [];
    list.push(value);
    this.data.set(key, list);
    return list.length;
  }

  async lpop(key) {
    this.check();
    const list = this.data.get(key) ?? [];
    return list.length ? list.shift() : null;
  }

  async llen(key) {
    return (this.data.get(key) ?? []).length;
  }

  multi() {
    const ops = [];
    const chain = {
      set: (key, value) => (ops.push([key, value]), chain),
      exec: async () => {
        this.check();
        for (const [k, v] of ops) this.data.set(k, v);
        return ops.map(() => [null, "OK"]);
      },
    };
    return chain;
  }
}
